// The same question for a group: can a person's devices stay hidden from
// the other members, and a lost device still be removed?
//
// Candidate: in each group the person has one key that all its devices
// hold; removing a device is a change of that key, written into the
// group's log. Members and the storage see one writer per person.
//
// A model like model.ts, not the library. The group's log is a set of
// signed entries with parents. Everyone who holds the same entries
// computes the same state: entries are folded in causal order, ties by id.
import { createHash, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'

const h = (s: string): string => createHash('sha256').update(s).digest('base64url').slice(0, 22)
type Pair = { pub: string, priv: KeyObject }
const pair = (): Pair => { const { publicKey, privateKey } = generateKeyPairSync('ed25519'); return { pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'), priv: privateKey } }
const ok = (pub: string, msg: string, sig: string): boolean => verify(null, Buffer.from(msg), { key: Buffer.from(pub, 'base64url'), format: 'der', type: 'spki' }, Buffer.from(sig, 'base64url'))

type Op =
  | { kind: 'genesis', members: Array<{ id: string, key: string, enc: string, next: string }> }
  | { kind: 'rekey', member: string, from: string, key: string, enc: string, next: string }
  | { kind: 'content', text: string, epoch: string }
export type Entry = { id: string, parents: string[], writer: string, op: Op, sig: string }
type Member = { key: string, enc: string, next: string, replacedBy: Map<string, string> }   // old key → id of the change that replaced it
type GState = { members: Map<string, Member>, epoch: string, sealedTo: Map<string, Set<string>> }

export type GRules = {
  authorizedBy: 'current-key' | 'update-key'   // who may write a change: the key every device holds, or one the change before committed to
  sealsWhatItSaw: boolean                      // an entry under a replaced key counts only if the change that replaced it has it in its past
  derived: boolean                             // the next key is derived from a secret the holders share, not drawn
}
export const GRULES: GRules = { authorizedBy: 'update-key', sealsWhatItSaw: true, derived: false }

export type GDevice = { name: string, log: Map<string, Entry>, sig: Map<string, KeyObject>, enc: Set<string>, update: Map<string, KeyObject>, member: string }
export const gdevice = (name: string, member: string): GDevice => ({ name, log: new Map(), sig: new Map(), enc: new Set(), update: new Map(), member })

const past = (log: Map<string, Entry>, e: Entry, acc = new Set<string>()): Set<string> => { for (const p of e.parents) if (!acc.has(p)) { acc.add(p); const x = log.get(p); if (x) past(log, x, acc) } return acc }
const depth = (log: Map<string, Entry>, e: Entry, memo: Map<string, number>): number => { const m = memo.get(e.id); if (m !== undefined) return m; const d = 1 + Math.max(-1, ...e.parents.map((p) => { const x = log.get(p); return x ? depth(log, x, memo) : -1 })); memo.set(e.id, d); return d }
const ordered = (log: Map<string, Entry>, ids?: Set<string>): Entry[] => { const memo = new Map<string, number>(); return [...log.values()].filter((e) => !ids || ids.has(e.id)).sort((a, b) => depth(log, a, memo) - depth(log, b, memo) || (a.id < b.id ? -1 : 1)) }
const signedOk = (e: Entry): boolean => e.id === h(JSON.stringify([e.parents, e.writer, e.op]) + e.sig) && ok(e.writer, JSON.stringify([e.parents, e.op]), e.sig)

/** The authority state of a set of entries (all of a log, or one entry's past). */
export function state (log: Map<string, Entry>, rules: GRules, ids?: Set<string>): GState {
  const s: GState = { members: new Map(), epoch: '', sealedTo: new Map() }
  for (const e of ordered(log, ids)) {
    if (!signedOk(e)) continue
    if (e.op.kind === 'genesis') {
      for (const m of e.op.members) s.members.set(m.id, { key: m.key, enc: m.enc, next: m.next, replacedBy: new Map() })
      s.epoch = 'ep-' + e.id; s.sealedTo.set(s.epoch, new Set(e.op.members.map((m) => m.enc)))
    } else if (e.op.kind === 'rekey') {
      const m = s.members.get(e.op.member)
      if (!m || e.op.from !== m.key) continue                                   // a second change of the same key loses
      if (rules.authorizedBy === 'current-key' ? e.writer !== m.key : h(e.writer) !== m.next) continue
      m.replacedBy.set(m.key, e.id); m.key = e.op.key; m.enc = e.op.enc; m.next = e.op.next
      s.epoch = 'ep-' + e.id; s.sealedTo.set(s.epoch, new Set([...s.members.values()].map((x) => x.enc)))
    }
  }
  return s
}
/** Does a content entry count, for someone who holds `log`? */
export function counts (log: Map<string, Entry>, e: Entry, rules: GRules): boolean {
  if (e.op.kind !== 'content' || !signedOk(e)) return false
  const at = state(log, rules, past(log, e)), now = state(log, rules)
  const who = [...at.members].find(([, m]) => m.key === e.writer)
  if (!who) return false                                                         // not a member's key at its place
  if (!rules.sealsWhatItSaw) return true
  const m = now.members.get(who[0]) as Member
  if (m.key === e.writer) return true
  const change = log.get(m.replacedBy.get(e.writer) ?? '')
  return !!change && past(log, change).has(e.id)
}
const heads = (log: Map<string, Entry>): string[] => { const used = new Set([...log.values()].flatMap((e) => e.parents)); return [...log.keys()].filter((id) => !used.has(id)).sort() }
function write (d: GDevice, writerPub: string, key: KeyObject, op: Op): Entry {
  const parents = heads(d.log)
  const sig = sign(null, Buffer.from(JSON.stringify([parents, op])), key).toString('base64url')
  const e: Entry = { id: h(JSON.stringify([parents, writerPub, op]) + sig), parents, writer: writerPub, op, sig }
  d.log.set(e.id, e)
  return e
}

/** A group of the given persons; each person's devices get its keys, the holders its update key. */
export function found (persons: Array<{ id: string, devices: GDevice[], holders: GDevice[] }>): void {
  const made = persons.map((p) => ({ p, k: pair(), up: pair(), enc: 'genc-' + h(p.id + Math.random()) }))
  const founder = made[0] as (typeof made)[number]
  const d0 = founder.p.devices[0] as GDevice
  const g = write(d0, founder.k.pub, founder.k.priv, { kind: 'genesis', members: made.map((m) => ({ id: m.p.id, key: m.k.pub, enc: m.enc, next: h(m.up.pub) })) })
  for (const m of made) {
    for (const d of m.p.devices) { d.log.set(g.id, g); d.sig.set(m.k.pub, m.k.priv); d.enc.add(m.enc) }
    for (const d of m.p.holders) d.update.set(m.up.pub, m.up.priv)
  }
}
const prepared = new Map<string, { key: Pair, up: Pair, enc: string }>()
/** `d` changes its person's key in the group and hands the new keys to `to`. */
export function rekey (d: GDevice, rules: GRules, to: GDevice[]): boolean {
  const m = state(d.log, rules).members.get(d.member) as Member
  const cur = d.sig.get(m.key)
  const auth = rules.authorizedBy === 'current-key' ? (cur ? [m.key, cur] as const : undefined) : [...d.update].find(([pub]) => h(pub) === m.next)
  if (!auth) return false
  let n = rules.derived ? prepared.get(m.key) : undefined
  if (!n) { n = { key: pair(), up: pair(), enc: 'genc-' + h(m.key + Math.random()) }; if (rules.derived) prepared.set(m.key, n) }
  write(d, auth[0], auth[1], { kind: 'rekey', member: d.member, from: m.key, key: n.key.pub, enc: n.enc, next: h(n.up.pub) })
  for (const x of [d, ...to]) { x.sig.set(n.key.pub, n.key.priv); x.enc.add(n.enc); x.update.set(n.up.pub, n.up.priv) }
  return true
}
/** `d` writes content under the newest key of its person that it holds a secret for, as its own log says. */
export function say (d: GDevice, rules: GRules, text: string, as?: string): Entry | undefined {
  const s = state(d.log, rules), m = s.members.get(d.member) as Member
  const pub = as ?? m.key, key = d.sig.get(pub)
  if (!key) return undefined
  return write(d, pub, key, { kind: 'content', text, epoch: s.epoch })
}
export const sync = (a: GDevice, b: GDevice): void => { for (const [k, v] of a.log) b.log.set(k, v); for (const [k, v] of b.log) a.log.set(k, v) }
/** What `d` reads: content that counts and whose epoch was sealed to a receive key it holds. */
export function reads (d: GDevice, rules: GRules): string[] {
  const s = state(d.log, rules)
  return ordered(d.log).filter((e) => e.op.kind === 'content' && counts(d.log, e, rules) && [...(s.sealedTo.get((e.op as { epoch: string }).epoch) ?? [])].some((x) => d.enc.has(x))).map((e) => (e.op as { text: string }).text)
}
/** The distinct writers a member sees for a person: what it could count as devices. */
export const writersSeen = (d: GDevice, rules: GRules): number => new Set([...d.log.values()].filter((e) => e.op.kind === 'content' && counts(d.log, e, rules)).map((e) => e.writer)).size
export const keyOf = (d: GDevice, rules: GRules, member: string): string => (state(d.log, rules).members.get(member) as Member).key
