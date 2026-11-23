// A model for one question: how does a relationship's key change when a
// person has several devices that the counterpart must not see?
//
// Not the library. A small model of the rules under discussion, so that
// each rule can be switched and its effect measured:
//   - an identifier with a log, in the shape of did:vh (each entry carries
//     the whole state and commits to the keys that may write the next one);
//   - between two peers the first continuation a party accepted stands, a
//     second one is refused and kept as evidence (did:vh, "Applying
//     Peer-to-Peer Updates");
//   - every document carries the head of the sender's own log and the head
//     it holds of the receiver's log (`heads`);
//   - a carrier with one mailbox per address that deletes what was fetched.
//
// Signatures are real (Ed25519). Encryption is modelled as possession: a
// device opens a document sealed to a receive key if it holds that key.
import { createHash, generateKeyPairSync, sign, verify, randomBytes, type KeyObject } from 'node:crypto'

const h = (s: string): string => createHash('sha256').update(s).digest('base64url').slice(0, 22)
type Pair = { pub: string, priv: KeyObject }
const pair = (): Pair => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'), priv: privateKey }
}
const pubKey = (pub: string): Parameters<typeof verify>[2] => ({ key: Buffer.from(pub, 'base64url'), format: 'der', type: 'spki' })

export type State = { sig: string, enc: string, addr: string }
export type Entry = { n: number, prev: string | null, update: string, next: string, state: State, proof: string, id: string }
const body = (e: Omit<Entry, 'proof' | 'id'>): string => JSON.stringify([e.n, e.prev, e.update, e.next, e.state])

/** Checks one entry against its predecessor: the right position, written by
 *  a key the predecessor committed to. */
export function follows (prev: Entry | null, e: Entry): boolean {
  if (e.id !== h(body(e) + e.proof)) return false
  if (!verify(null, Buffer.from(body(e)), pubKey(e.update), Buffer.from(e.proof, 'base64url'))) return false
  if (prev === null) return e.n === 0 && e.prev === null
  return e.n === prev.n + 1 && e.prev === prev.id && h(e.update) === prev.next
}

/** What a device holds of the person's own side of one relationship. */
export type Own = {
  log: Entry[]
  sig: Map<string, KeyObject>     // everyday signing keys, by public key
  enc: Set<string>                // receive keys it can open
  addr: Set<string>               // addresses it can fetch from
  update: Map<string, KeyObject>  // update keys it holds, by public key
  owed: Entry[]                   // entries the counterpart has not acknowledged
}
/** What a device holds of the counterpart's side. */
export type Peer = { log: Entry[], evidence: Entry[] }
export type Doc = { from: string, kind: string, text?: string, sigKey: string, sig: string, entries: Entry[], heads?: { mine: string, yours: string }, sealedTo: string, to: string, ref?: string }
export type Device = { name: string, own: Own, peer: Peer, notices: string[], inbox: string[], lost?: boolean }

export type Rules = {
  heads: boolean            // documents carry both log heads
  replyToSender: boolean    // a refusal is answered to the address in the refused entry, not to the held one
  keepOldUntilAck: boolean  // after a change a device keeps the old receive key and address until the counterpart acknowledged
  deterministic: boolean    // the next state is derived from a secret the update holders share
  graceAfterAck: boolean    // the old receive key and address stay open for a while after the acknowledgement
}
export const RULES: Rules = { heads: true, replyToSender: true, keepOldUntilAck: true, deterministic: false, graceAfterAck: false }

/** One mailbox per address; what was fetched is gone. */
export class Carrier {
  private boxes = new Map<string, Doc[]>()
  put (d: Doc): void { this.boxes.set(d.to, [...(this.boxes.get(d.to) ?? []), d]) }
  fetch (dev: Device): Doc[] {
    const out: Doc[] = []
    for (const a of dev.own.addr) { out.push(...(this.boxes.get(a) ?? [])); this.boxes.delete(a) }
    return out
  }
  waiting (addr: string): number { return (this.boxes.get(addr) ?? []).length }
}

const head = (log: Entry[]): Entry => log[log.length - 1] as Entry
const newState = (): { st: State, sigPair: Pair } => { const sigPair = pair(); return { st: { sig: sigPair.pub, enc: 'enc-' + randomBytes(6).toString('hex'), addr: 'addr-' + randomBytes(6).toString('hex') }, sigPair } }

/** A relationship's first entry, written on `dev`; the next update key is
 *  made at once and handed to `holders` (the devices that may change keys). */
export function open (dev: Device, holders: Device[]): void {
  const up = pair(), nextUp = pair(), { st, sigPair } = newState()
  const b = { n: 0, prev: null, update: up.pub, next: h(nextUp.pub), state: st }
  const proof = sign(null, Buffer.from(body(b)), up.priv).toString('base64url')
  const e: Entry = { ...b, proof, id: h(body(b) + proof) }
  dev.own.log = [e]; dev.own.sig.set(st.sig, sigPair.priv); dev.own.enc.add(st.enc); dev.own.addr.add(st.addr); dev.own.owed = [e]
  for (const x of holders) x.own.update.set(nextUp.pub, nextUp.priv)
}
/** A sibling device gets what `from` holds of the relationship (the
 *  personal group's doing); update keys only if it is a holder. */
export function share (from: Device, to: Device, holder: boolean): void {
  const stale = to.own.log.length > 0 && from.own.log.length > 0 && !from.own.log.some((e) => e.id === head(to.own.log).id)
  if (to.own.log.length === 0 || from.own.log.length >= to.own.log.length || stale) { to.own.log = [...from.own.log]; to.own.owed = [...from.own.owed] }
  for (const [k, v] of from.own.sig) to.own.sig.set(k, v)
  for (const x of from.own.enc) to.own.enc.add(x)
  for (const x of from.own.addr) to.own.addr.add(x)
  if (holder) for (const [k, v] of from.own.update) to.own.update.set(k, v)
  if (to.peer.log.length < from.peer.log.length) to.peer.log = [...from.peer.log]
  for (const e of from.peer.evidence) if (!to.peer.evidence.some((x) => x.id === e.id)) to.peer.evidence.push(e)
}

/** `dev` writes the next entry of its own log: new everyday key, new
 *  receive key, new address, a new commitment. Returns false if it holds
 *  no key the head committed to. `seed` makes two devices write the same
 *  entry (rule `deterministic`); the model then reuses one prepared entry. */
const prepared = new Map<string, { e: Entry, sigPair: Pair, nextUp: Pair }>()
export function change (dev: Device, rules: Rules, holders: Device[]): boolean {
  const hd = head(dev.own.log)
  const up = [...dev.own.update].find(([pub]) => h(pub) === hd.next)
  if (!up) return false
  let made = rules.deterministic ? prepared.get(hd.id) : undefined
  if (!made) {
    const nextUp = pair(), { st, sigPair } = newState()
    const b = { n: hd.n + 1, prev: hd.id, update: up[0], next: h(nextUp.pub), state: st }
    const proof = sign(null, Buffer.from(body(b)), up[1]).toString('base64url')
    made = { e: { ...b, proof, id: h(body(b) + proof) }, sigPair, nextUp }
    if (rules.deterministic) prepared.set(hd.id, made)
  }
  const old = hd.state
  dev.own.log.push(made.e); dev.own.owed.push(made.e)
  dev.own.sig.set(made.e.state.sig, made.sigPair.priv); dev.own.enc.add(made.e.state.enc); dev.own.addr.add(made.e.state.addr)
  if (!rules.keepOldUntilAck) { dev.own.enc.delete(old.enc); dev.own.addr.delete(old.addr) }
  for (const x of holders) if (!x.lost) x.own.update.set(made.nextUp.pub, made.nextUp.priv)
  return true
}

/** `dev` sends a document to the counterpart, as it knows it. */
export function send (dev: Device, c: Carrier, rules: Rules, kind: string, text?: string, extra: Partial<Doc> = {}): void {
  const mine = head(dev.own.log), yours = head(dev.peer.log)
  const key = dev.own.sig.get(mine.state.sig)
  if (!key) { dev.notices.push('cannot sign under the head of its own log'); return }
  const payload = JSON.stringify([kind, text ?? '', mine.id])
  c.put({ from: dev.name, kind, text, sigKey: mine.state.sig, sig: sign(null, Buffer.from(payload), key).toString('base64url'), entries: [...dev.own.owed], heads: rules.heads ? { mine: mine.id, yours: yours.id } : undefined, sealedTo: yours.state.enc, to: yours.state.addr, ...extra })
}

/** `dev` fetches and handles what waits for it. */
export function receive (dev: Device, c: Carrier, rules: Rules): void {
  for (const d of c.fetch(dev)) {
    if (!dev.own.enc.has(d.sealedTo)) { dev.notices.push(`fetched a ${d.kind} it cannot open`); continue }
    // the counterpart's entries that came along
    let refused: Entry | undefined
    for (const e of d.entries) {
      const held = dev.peer.log[e.n]
      if (held) { if (held.id !== e.id && !dev.peer.evidence.some((x) => x.id === e.id)) { dev.peer.evidence.push(e); dev.notices.push('a second continuation of the counterpart\'s log was refused'); refused = e } else if (held.id !== e.id) refused = e; continue }
      if (follows(dev.peer.log.length ? head(dev.peer.log) : null, e)) dev.peer.log.push(e)
    }
    if (refused) {
      // tell the sender which head stands here; where the answer goes is a rule
      const back = rules.replyToSender ? refused.state : head(dev.peer.log).state
      c.put({ from: dev.name, kind: 'refused', sigKey: '', sig: '', entries: [], heads: rules.heads ? { mine: head(dev.own.log).id, yours: head(dev.peer.log).id } : undefined, sealedTo: back.enc, to: back.addr })
      continue
    }
    // what the sender holds of this device's own log
    if (d.heads) {
      const known = dev.own.log.findIndex((e) => e.id === d.heads?.yours)
      if (known === -1) dev.notices.push('the counterpart holds a continuation of the own log that this device does not know')
      else { dev.own.owed = dev.own.owed.filter((e) => e.n > known); if (rules.keepOldUntilAck && !rules.graceAfterAck && known === dev.own.log.length - 1) for (const e of dev.own.log.slice(0, -1)) { dev.own.enc.delete(e.state.enc); dev.own.addr.delete(e.state.addr) } }
    }
    if (d.kind === 'refused') { dev.notices.push('the counterpart refused this device\'s continuation'); continue }
    if (d.kind === 'stale') { dev.notices.push('the counterpart says this device\'s state is stale'); continue }
    if (d.kind === 'need-log') { send(dev, c, rules, 'log', undefined, { entries: [...dev.own.log] }); continue }
    // the document itself: signed under the head this device holds of the counterpart?
    const cur = head(dev.peer.log)
    if (d.sigKey !== cur.state.sig) {
      if (d.heads && d.heads.mine !== cur.id && !dev.peer.log.some((e) => e.id === d.heads?.mine)) { send(dev, c, rules, 'need-log'); dev.notices.push('behind on the counterpart\'s log, asked for it'); continue }
      // signed under an older state of the counterpart's log: tell that device, at the address of that state
      const older = d.heads ? dev.peer.log.find((e) => e.id === d.heads?.mine) : undefined
      if (older) c.put({ from: dev.name, kind: 'stale', sigKey: '', sig: '', entries: [], heads: { mine: head(dev.own.log).id, yours: cur.id }, sealedTo: older.state.enc, to: older.state.addr })
      dev.notices.push(`refused a ${d.kind}: not signed under the counterpart's current key`)
      continue
    }
    if (!verify(null, Buffer.from(JSON.stringify([d.kind, d.text ?? '', d.heads?.mine ?? cur.id])), pubKey(d.sigKey), Buffer.from(d.sig, 'base64url')) && d.heads) { dev.notices.push(`refused a ${d.kind}: bad signature`); continue }
    if (d.kind === 'log') continue
    if (d.text) dev.inbox.push(d.text)
    if (d.kind !== 'ack') send(dev, c, rules, 'ack', undefined, { ref: d.kind })
  }
}

export const device = (name: string): Device => ({ name, own: { log: [], sig: new Map(), enc: new Set(), addr: new Set(), update: new Map(), owed: [] }, peer: { log: [], evidence: [] }, notices: [], inbox: [] })
/** Two persons who met: A's devices and B's devices each know the other's first entry. */
export function met (as: Device[], bs: Device[], holdersA: Device[], holdersB: Device[]): void {
  open(as[0] as Device, holdersA); open(bs[0] as Device, holdersB)
  ;(as[0] as Device).peer.log = [...(bs[0] as Device).own.log]; (bs[0] as Device).peer.log = [...(as[0] as Device).own.log]
  ;(as[0] as Device).own.owed = []; (bs[0] as Device).own.owed = []
  for (const x of as.slice(1)) share(as[0] as Device, x, holdersA.includes(x))
  for (const x of bs.slice(1)) share(bs[0] as Device, x, holdersB.includes(x))
}
export const headId = (log: Entry[]): string => head(log).id
