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
//   - a carrier with one mailbox per address that deletes what was fetched;
//   - a device holds key material and uses receive paths, and the two are
//     kept apart: which paths it uses follows from its log, from what the
//     counterpart acknowledged and from the rules (`paths`).
//
// Signatures are real (Ed25519). Encryption is modelled as possession: a
// device opens a document sealed to a receive key if it holds that key.
import { createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, randomBytes, type KeyObject } from 'node:crypto'

const h = (s: string): string => createHash('sha256').update(s).digest('base64url').slice(0, 22)
type Pair = { pub: string, priv: KeyObject }
const pair = (): Pair => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'), priv: privateKey }
}
/** A key pair from 32 bytes, so that two devices that derive the same bytes hold the same key. */
const pairFrom = (seed: Buffer): Pair => {
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' })
  return { pub: createPublicKey(priv).export({ type: 'spki', format: 'der' }).toString('base64url'), priv }
}
const kdf = (w: Buffer, rel: string, n: number, label: string): Buffer => createHmac('sha256', w).update(JSON.stringify([rel, n, label])).digest()
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
  enc: Set<string>                // receive keys it holds (material; what it may use is `paths`)
  addr: Set<string>               // addresses it holds the access to
  acked: number                   // the newest entry of its own log the counterpart acknowledged
  rel: string                     // a name of the relationship that goes into every derivation
  secrets: Buffer[]               // the change secrets it holds, oldest first (rule `deterministic`)
  stock: Array<{ rel: string, next: string }>   // bindings the main device prepared for contexts this device opens without a secret
  removed: Set<string>            // names of own devices that were removed (the personal group's knowledge)
  update: Map<string, KeyObject>  // update keys it holds, by public key
  owed: Entry[]                   // entries the counterpart has not acknowledged
}
/** What a device holds of the counterpart's side. */
/** `contested`: a second valid continuation was seen and the person has not
 *  settled it yet. `settled`: the positions the person settled in a meeting. */
export type Peer = { log: Entry[], evidence: Entry[], contested: boolean, settled: Set<number> }
export type Doc = { from: string, kind: string, text?: string, sigKey: string, sig: string, entries: Entry[], heads?: { mine: string, yours: string }, sealedTo: string, to: string, ref?: string }
export type Device = { name: string, own: Own, peer: Peer, notices: string[], inbox: string[], lost?: boolean }

export type Rules = {
  heads: boolean            // documents carry both log heads
  replyToSender: boolean    // a refusal is answered to the address in the refused entry, not to the held one
  keepOldUntilAck: boolean  // after a change a device keeps the old receive key and address until the counterpart acknowledged
  deterministic: boolean    // the next state is derived from a change secret the holders share, not drawn
  graceAfterAck: boolean    // the old receive key and address stay open for a while after the acknowledgement
  stateFromSecret: boolean  // with a change secret: the everyday keys are derived from it too (else only who may write next)
  selfBind: boolean         // a device without a secret binds a new relationship to a key it draws itself, to hand over later
}
export const RULES: Rules = { heads: true, replyToSender: true, keepOldUntilAck: true, deterministic: false, graceAfterAck: false, stateFromSecret: true, selfBind: false }

/** One mailbox per address; what was fetched is gone. */
export class Carrier {
  private boxes = new Map<string, Doc[]>()
  put (d: Doc): void { this.boxes.set(d.to, [...(this.boxes.get(d.to) ?? []), d]) }
  fetch (addrs: string[]): Doc[] {
    const out: Doc[] = []
    for (const a of addrs) { out.push(...(this.boxes.get(a) ?? [])); this.boxes.delete(a) }
    return out
  }
  waiting (addr: string): number { return (this.boxes.get(addr) ?? []).length }
}

const head = (log: Entry[]): Entry => log[log.length - 1] as Entry
/** The receive paths a device uses. What it holds is material; what it may
 *  use follows from its log, from what the counterpart acknowledged and
 *  from the rules: the head's path always; older ones down to the
 *  acknowledged entry while the change is not acknowledged
 *  (`keepOldUntilAck`); one more below that for a while (`graceAfterAck`).
 *  Two devices with the same log and the same acknowledgement use the same
 *  paths, whatever material each still holds. A lost device follows no rule. */
export function paths (dev: Device, rules: Rules): State[] {
  if (dev.lost) return dev.own.log.map((e) => e.state).filter((st) => dev.own.addr.has(st.addr))
  const from = rules.keepOldUntilAck ? dev.own.acked : dev.own.log.length - 1
  return dev.own.log.slice(Math.max(0, from - (rules.graceAfterAck ? 1 : 0))).map((e) => e.state).filter((st) => dev.own.addr.has(st.addr) && dev.own.enc.has(st.enc))
}
const newState = (): { st: State, sigPair: Pair } => { const sigPair = pair(); return { st: { sig: sigPair.pub, enc: 'enc-' + randomBytes(6).toString('hex'), addr: 'addr-' + randomBytes(6).toString('hex') }, sigPair } }

/** A relationship's first entry, written on `dev`. The key that may write
 *  the next entry is drawn and handed to `holders`, or, with a change
 *  secret, derived from the newest one `dev` holds. */
export function open (dev: Device, holders: Device[], rules: Rules = RULES): 'bound' | 'from stock' | 'self-bound' | 'unbound' {
  const w = dev.own.secrets[dev.own.secrets.length - 1]
  const derived = rules.deterministic && w !== undefined
  // without a secret under the rule of a change secret: a binding the main device prepared, or none
  const item = rules.deterministic && !derived ? dev.own.stock.shift() : undefined
  const self = rules.deterministic && !derived && !item && rules.selfBind
  const unbound = rules.deterministic && !derived && !item && !self
  const rel = item?.rel ?? 'rel-' + randomBytes(6).toString('hex')
  const up = pair(), nextUp = derived ? pairFrom(kdf(w, rel, 1, 'update')) : pair(), { st, sigPair } = newState()
  const b = { n: 0, prev: null, update: up.pub, next: unbound ? 'none' : item?.next ?? h(nextUp.pub), state: st }
  const proof = sign(null, Buffer.from(body(b)), up.priv).toString('base64url')
  const e: Entry = { ...b, proof, id: h(body(b) + proof) }
  dev.own.log = [e]; dev.own.sig.set(st.sig, sigPair.priv); dev.own.enc.add(st.enc); dev.own.addr.add(st.addr); dev.own.owed = [e]; dev.own.acked = 0; dev.own.rel = rel
  if (!rules.deterministic) for (const x of holders) x.own.update.set(nextUp.pub, nextUp.priv)
  if (self) dev.own.update.set(nextUp.pub, nextUp.priv)                       // held by this device alone until it hands it over
  return unbound ? 'unbound' : self ? 'self-bound' : item ? 'from stock' : 'bound'
}
/** The main device prepares bindings for a device that holds no secret:
 *  each names a relationship label and commits to the key the main device
 *  will derive for it. */
export function stockUp (main: Device, to: Device, count: number): void {
  const w = main.own.secrets[main.own.secrets.length - 1]
  if (!w) return
  for (let i = 0; i < count; i++) { const rel = 'rel-' + randomBytes(6).toString('hex'); to.own.stock.push({ rel, next: h(pairFrom(kdf(w, rel, 1, 'update')).pub) }) }
}
/** A fresh change secret for these devices: at the start, and again when a device is removed. */
export function renew (devs: Device[]): void { const w = randomBytes(32); for (const d of devs) d.own.secrets.push(w) }
const extendsLog = (longer: Entry[], shorter: Entry[]): boolean => shorter.length === 0 || (longer.length > shorter.length && longer.some((e) => e.id === head(shorter).id))
/** A sibling device gets what `from` holds of the relationship (the
 *  personal group's doing); update keys only if it is a holder. The own
 *  log only ever grows by this: `to` takes `from`'s log if that continues
 *  its own. A shorter log changes nothing, and neither does a fork (two
 *  logs of which neither continues the other): see `takeOver`. */
export function share (from: Device, to: Device, holder: boolean, settle = false): void {
  // two devices of one person hold two continuations of the counterpart's log
  const pf = from.peer.log, pt = to.peer.log
  const peerFork = pf.length > 0 && pt.length > 0 && !pf.some((e) => e.id === head(pt).id) && !pt.some((e) => e.id === head(pf).id)
  if (peerFork) {
    for (const [a, b] of [[from, to], [to, from]] as const) for (const e of a.peer.log) if (!b.peer.log.some((x) => x.id === e.id) && !b.peer.evidence.some((x) => x.id === e.id)) b.peer.evidence.push(e)
    for (const d of [from, to]) { d.peer.contested = true; if (!d.notices.includes('the own devices hold two continuations of the counterpart\'s log')) d.notices.push('the own devices hold two continuations of the counterpart\'s log') }
    if (settle) {
      // one rule every device applies alike: at the first position where they differ, the lower id
      const i = pf.findIndex((e, k) => e.id !== pt[k]?.id), a = pf[i], b = pt[i]
      if (a && b) { const win = a.id < b.id ? pf : pt; from.peer.log = [...win]; to.peer.log = [...win] }
    }
  }
  const fork = to.own.log.length > 0 && from.own.log.length > 0 && !from.own.log.some((e) => e.id === head(to.own.log).id) && !to.own.log.some((e) => e.id === head(from.own.log).id)
  if (extendsLog(from.own.log, to.own.log)) { to.own.log = [...from.own.log]; to.own.owed = [...from.own.owed] }
  // what the counterpart acknowledged is never forgotten: an older sibling cannot reopen a closed path
  if (!fork) to.own.acked = Math.max(to.own.acked, Math.min(from.own.acked, to.own.log.length - 1))
  for (const [k, v] of from.own.sig) to.own.sig.set(k, v)
  for (const x of from.own.enc) to.own.enc.add(x)
  for (const x of from.own.addr) to.own.addr.add(x)
  if (holder) for (const [k, v] of from.own.update) to.own.update.set(k, v)
  to.own.rel ||= from.own.rel
  for (const x of from.own.removed) to.own.removed.add(x)
  // what the person settled in a meeting holds for all its devices
  for (const n of from.peer.settled) if (!to.peer.settled.has(n)) { to.peer.settled.add(n); to.peer.log = [...from.peer.log]; to.peer.contested = from.peer.contested }
  if (from.peer.contested && !to.peer.settled.size) to.peer.contested = true
  if (extendsLog(from.peer.log, to.peer.log)) to.peer.log = [...from.peer.log]
  for (const e of from.peer.evidence) if (!to.peer.evidence.some((x) => x.id === e.id)) to.peer.evidence.push(e)
}
/** The deliberate step after a fork: `to` gives up its own continuation
 *  and takes `from`'s, the one the counterpart accepted. */
export function takeOver (from: Device, to: Device, holder: boolean): void {
  to.own.log = [...from.own.log]; to.own.owed = [...from.own.owed]; to.own.acked = from.own.acked
  share(from, to, holder)
}

/** `dev` writes the next entry of its own log: new everyday key, new
 *  receive key, new address, a new commitment. Returns false if it holds
 *  no key the head committed to.
 *
 *  Drawn: all of it is random, the next update key goes to `holders`.
 *  Derived: the key that writes is derived from the secret the head
 *  committed under; the new state and the next commitment are derived from
 *  the newest secret the device holds. Two devices that hold the same
 *  secrets write the same entry, byte for byte. */
export function change (dev: Device, rules: Rules, holders: Device[], keepState = false): boolean {
  const hd = head(dev.own.log), n = hd.n + 1
  let e: Entry, sigPair: Pair | undefined
  if (rules.deterministic) {
    const rel = dev.own.rel
    // the key the head committed to: derived from a secret, or one a linked device drew and handed over
    const handed = [...dev.own.update].find(([pub]) => h(pub) === hd.next)
    const up = dev.own.secrets.map((w) => pairFrom(kdf(w, rel, n, 'update'))).find((p) => h(p.pub) === hd.next) ?? (handed ? { pub: handed[0], priv: handed[1] } : undefined)
    const w = dev.own.secrets[dev.own.secrets.length - 1]
    if (!up) return false
    if (!w) {
      // no secret: a device can only write over a key it holds itself, and binds to another it draws
      if (!handed) return false
      const nextUp = pair(), made = newState()
      const b = { n, prev: hd.id, update: up.pub, next: h(nextUp.pub), state: made.st }
      const proof = sign(null, Buffer.from(body(b)), up.priv).toString('base64url')
      e = { ...b, proof, id: h(body(b) + proof) }
      dev.own.update.set(nextUp.pub, nextUp.priv)
      dev.own.log.push(e); dev.own.owed.push(e)
      dev.own.sig.set(e.state.sig, made.sigPair.priv); dev.own.enc.add(e.state.enc); dev.own.addr.add(e.state.addr)
      return true
    }
    let st: State
    if (keepState) st = hd.state                                             // only the binding changes
    else if (rules.stateFromSecret) {
      sigPair = pairFrom(kdf(w, rel, n, 'sig'))
      st = { sig: sigPair.pub, enc: 'enc-' + h(kdf(w, rel, n, 'enc').toString('hex')), addr: 'addr-' + h(kdf(w, rel, n, 'addr').toString('hex')) }
    } else { const made = newState(); sigPair = made.sigPair; st = made.st }   // the secret says who may write next, nothing else
    const b = { n, prev: hd.id, update: up.pub, next: h(pairFrom(kdf(w, rel, n + 1, 'update')).pub), state: st }
    const proof = sign(null, Buffer.from(body(b)), up.priv).toString('base64url')
    e = { ...b, proof, id: h(body(b) + proof) }
  } else {
    const up = [...dev.own.update].find(([pub]) => h(pub) === hd.next)
    if (!up) return false
    const nextUp = pair(), made = newState()
    sigPair = made.sigPair
    const b = { n, prev: hd.id, update: up[0], next: h(nextUp.pub), state: made.st }
    const proof = sign(null, Buffer.from(body(b)), up[1]).toString('base64url')
    e = { ...b, proof, id: h(body(b) + proof) }
    for (const x of holders) if (!x.lost) x.own.update.set(nextUp.pub, nextUp.priv)
  }
  dev.own.log.push(e); dev.own.owed.push(e)
  if (sigPair) { dev.own.sig.set(e.state.sig, sigPair.priv); dev.own.enc.add(e.state.enc); dev.own.addr.add(e.state.addr) }
  return true
}
/** A linked device hands the key it bound a relationship to over to the
 *  main device, which writes an entry that changes only the binding: from
 *  then on the next writer comes from the main device's secret. An honest
 *  linked device forgets the key. */
export function handOver (linked: Device, main: Device, rules: Rules): boolean {
  share(linked, main, true)
  const ok = change(main, rules, [], true)
  if (ok && !linked.lost) linked.own.update.clear()
  return ok
}

const signed = (d: Pick<Doc, 'kind' | 'text' | 'heads' | 'ref'>): Buffer => Buffer.from(JSON.stringify([d.kind, d.text ?? '', d.heads?.mine ?? '', d.heads?.yours ?? '', d.ref ?? '']))
/** `dev` sends a document to the counterpart, as it knows it; `at` names
 *  another state of the counterpart's log to send to (a reply to a device
 *  that is not at the head). Every document is signed under the head of
 *  the sender's own log, with or without log heads. */
export const WEIGHTY = new Set(['trust', 'vouch', 'invite', 'credential'])
export function send (dev: Device, c: Carrier, rules: Rules, kind: string, text?: string, extra: Partial<Doc> = {}, at?: State): void {
  if (dev.peer.contested && WEIGHTY.has(kind)) { dev.notices.push(`held a ${kind}: the relationship is contested`); return }
  const mine = head(dev.own.log), yours = head(dev.peer.log), to = at ?? yours.state
  const key = dev.own.sig.get(mine.state.sig)
  if (!key) { dev.notices.push('cannot sign under the head of its own log'); return }
  const d = { from: dev.name, kind, text, entries: [...dev.own.owed], heads: rules.heads ? { mine: mine.id, yours: yours.id } : undefined, ...extra }
  c.put({ ...d, sigKey: mine.state.sig, sig: sign(null, signed(d), key).toString('base64url'), sealedTo: to.enc, to: to.addr })
}

/** `dev` fetches and handles what waits for it. Entries of the
 *  counterpart's log prove themselves; everything else a document says
 *  counts only after its signature was checked under the head this device
 *  holds of the counterpart's log. */
export function receive (dev: Device, c: Carrier, rules: Rules): void {
  const open = paths(dev, rules)
  for (const d of c.fetch(open.map((st) => st.addr))) {
    if (!(dev.lost ? dev.own.enc.has(d.sealedTo) : open.some((st) => st.enc === d.sealedTo))) { dev.notices.push(`fetched a ${d.kind} it cannot open`); continue }
    // the counterpart's entries that came along
    let refused: Entry | undefined
    for (const e of d.entries) {
      const held = dev.peer.log[e.n]
      if (held) {
        if (held.id === e.id) continue
        // only a second VALID continuation of the same predecessor is evidence; anything else is ignored
        if (!follows(e.n > 0 ? (dev.peer.log[e.n - 1] ?? null) : null, e)) { dev.notices.push('ignored an entry that does not continue the counterpart\'s log'); continue }
        refused = e
        if (dev.peer.settled.has(e.n)) { refused = undefined; continue }          // settled in a meeting: nothing more to say about this position
        const first = !dev.peer.evidence.some((x) => x.n === e.n)
        if (!dev.peer.evidence.some((x) => x.id === e.id)) dev.peer.evidence.push(e)
        if (first) { dev.peer.contested = true; dev.notices.push('a second continuation of the counterpart\'s log was refused') }   // one warning per position
        continue
      }
      if (follows(dev.peer.log.length ? head(dev.peer.log) : null, e)) dev.peer.log.push(e)
    }
    if (refused) {
      // tell the sender which head stands here; where the answer goes is a rule
      send(dev, c, rules, 'refused', undefined, { entries: [] }, rules.replyToSender ? refused.state : undefined)
      continue
    }
    // is the document signed under the head this device holds of the counterpart?
    const cur = head(dev.peer.log)
    if (d.sigKey !== cur.state.sig) {
      const older = d.heads ? dev.peer.log.find((e) => e.id === d.heads?.mine) : undefined
      if (d.heads && !older) { send(dev, c, rules, 'need-log'); dev.notices.push('behind on the counterpart\'s log, asked for it'); continue }
      // signed under an older state of the counterpart's log: tell that device, at the address of that state
      if (older) send(dev, c, rules, 'stale', undefined, { entries: [] }, older.state)
      dev.notices.push(`refused a ${d.kind}: not signed under the counterpart's current key`)
      continue
    }
    if (!verify(null, signed(d), pubKey(d.sigKey), Buffer.from(d.sig, 'base64url'))) { dev.notices.push(`refused a ${d.kind}: bad signature`); continue }
    // authentic from here on: what the sender holds of this device's own log
    if (d.heads) {
      const known = dev.own.log.findIndex((e) => e.id === d.heads?.yours)
      if (known === -1) dev.notices.push('the counterpart holds a continuation of the own log that this device does not know')
      else { dev.own.owed = dev.own.owed.filter((e) => e.n > known); dev.own.acked = Math.max(dev.own.acked, known) }
    }
    if (d.kind === 'refused') { dev.notices.push('the counterpart refused this device\'s continuation'); continue }
    if (d.kind === 'stale') { dev.notices.push('the counterpart says this device\'s state is stale'); continue }
    if (d.kind === 'need-log') { send(dev, c, rules, 'log', undefined, { entries: [...dev.own.log] }); continue }
    if (d.kind === 'log') continue
    if (d.text) dev.inbox.push(d.text)
    if (d.kind !== 'ack') send(dev, c, rules, 'ack', undefined, { ref: d.kind })
  }
}

/** A meeting: the counterpart shows its log in person and `dev` takes it,
 *  whichever continuation it followed before. The other one stays as
 *  evidence; the positions are settled for good. */
export function settleInPerson (dev: Device, shown: Entry[]): boolean {
  for (let i = 0; i < shown.length; i++) if (!follows(i ? (shown[i - 1] as Entry) : null, shown[i] as Entry)) return false
  if (shown[0]?.id !== dev.peer.log[0]?.id) return false                       // another identifier
  for (const e of dev.peer.log) if (!shown.some((x) => x.id === e.id) && !dev.peer.evidence.some((x) => x.id === e.id)) dev.peer.evidence.push(e)
  dev.peer.log = [...shown]; dev.peer.contested = false
  for (const e of dev.peer.evidence) dev.peer.settled.add(e.n)
  return true
}
/** The main device removes an own device; the knowledge travels with every sync. */
export function removeDevice (by: Device, name: string): void { by.own.removed.add(name) }
/** First sync, then act: before it changes keys a device takes what the own
 *  devices it can reach know. If it learns that it was removed, an honest
 *  app drops its secrets and does nothing. */
export function changeAfterSync (dev: Device, rules: Rules, reachable: Device[]): 'changed' | 'no key' | 'was removed' {
  for (const r of reachable) for (const x of r.own.removed) dev.own.removed.add(x)
  if (dev.own.removed.has(dev.name)) { dev.own.secrets = []; dev.own.update.clear(); return 'was removed' }
  return change(dev, rules, []) ? 'changed' : 'no key'
}

export const device = (name: string): Device => ({ name, own: { log: [], sig: new Map(), enc: new Set(), addr: new Set(), update: new Map(), owed: [], acked: 0, rel: '', secrets: [], stock: [], removed: new Set() }, peer: { log: [], evidence: [], contested: false, settled: new Set() }, notices: [], inbox: [] })
/** Two persons who met: A's devices and B's devices each know the other's first entry. */
export function met (as: Device[], bs: Device[], holdersA: Device[], holdersB: Device[], rules: Rules = RULES): void {
  if (rules.deterministic) { renew(holdersA); renew(holdersB) }
  open(as[0] as Device, holdersA, rules); open(bs[0] as Device, holdersB, rules)
  ;(as[0] as Device).peer.log = [...(bs[0] as Device).own.log]; (bs[0] as Device).peer.log = [...(as[0] as Device).own.log]
  ;(as[0] as Device).own.owed = []; (bs[0] as Device).own.owed = []
  for (const x of as.slice(1)) share(as[0] as Device, x, holdersA.includes(x))
  for (const x of bs.slice(1)) share(bs[0] as Device, x, holdersB.includes(x))
}
export const headId = (log: Entry[]): string => head(log).id
