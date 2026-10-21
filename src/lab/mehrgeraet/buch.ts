// E15 K2 step 2b.0: the outcome ledger ("Außenwirkungsbuch", design 2b draft 2 §5.1, draft 3 §7.1, §8). It lives outside
// every holder and survives every restore: what it holds was observed when it happened and is never handed back to a
// device. It is pure observation, never an input to any holder decision (Astra design review 1 (c)).
//
// Three books:
// - commit protocol per device and incarnation: every successful store commit and the journal batches it made durable
//   that this device wrote (ops: `introduce`, `ticket-accept` 8640.14 with act id and `own`, `allocate`, `withdraw`, `age`,
//   `connect`, `produce`, …; ticket intents with their digest and frame hashes);
// - carrier book: every frame the carrier took, joined by frame hash with the plaintext its producing device built
//   (revisions: listing, tombstones, signer; tickets: act id, signer, named anchor, frame hash, time; receipts, kept apart);
// - delivery protocol per device: every document delivered to a device that its parser admitted (MV-24), with time.
//
// Besides, per device the union duties of its last committed image (the counter follows the committed state, so a duty
// ended by `depart` as `moot` is not open; Tor-Review 42 B2), and every exception an observer hook threw (the seam catches
// it, the device and the carrier go on unchanged; Tor-Review 42 (a)).
// Per issuance and frame address, the receiver context of P-Commit: the committed image of the device that allocated the
// stock key at that address, at the issuance commit (Tor-Review 43; P-Commit applies the holder's own ticket predicate
// there). The keyring: the ledger's copy of every device's resolver, as the holder hands it to `receive`, so the ledger
// opens every frame exactly as the holder does (Tor-Review 44, 47). Bench material: the dump carries it, nothing hands
// it back to a device.
//
// The dump is the complete ledger (Tor-Review 42 S1): `Buch.load(dump)` rebuilds a ledger every checker judges exactly as
// the live one, the production mapping included.
//
// Frames are identified by hash; their content comes from the producer's own plaintext (`HolderObserver.produced`) or
// from the receiving parser's admitted values (`HolderObserver.admitted`). On purpose, for tickets (Tor-Review 44, 47): the
// bytes of every deposit and of every frame of an issuance batch are kept and opened by P-Commit as the devices at their
// address would, so a ticket is what a receiver reads, not what its producer reports or its intent is called.
//
// Checkers over the ledger: P-Einmal, P-Commit, P-Produktion, P-Paar per act, and a counter (not an assertion) of tuples
// per person pair and open union duties (draft 3 §7.1, §12 D1).

import { diVerify, mkOfX, receive } from '@real-life/trust-protocol'
import { createPrivateKey, createPublicKey, KeyObject } from 'node:crypto'
import { frameHash, ticketAcceptance, TYPES, type DeviceState, type HolderDevice, type HolderObserver, type MultiDeviceCandidate, type TicketPayload, type TicketReceiver } from './holder'
import * as M from './model'
import { Welt15, type Welt15Options } from './welt'
import type { Frame } from '../zustellung'

/** Bench constants of P-Produktion (draft 2 §5.2 no. 7): k rounds of the M device being up, the delivery reserve. */
export const PRODUCTION = { rounds: 3, reserveMs: M.PARAM.consentReserveMs } as const

export interface CommitIntent {
  digest: string
  kind: string
  expected: string
  address: string
  replyTo: string
  /** Hashes of the primary frame and of every copy (the bytes the store holds). */
  frames: string[]
  /** The address of each copy (`frames[1..]`; the primary frame goes to `address`). */
  copies: string[]
  /** Intents of issuance batches (any kind): the committed bytes of `frames`, base64, which P-Commit opens one by one. */
  sealed?: string[]
}
/**
 * The committed image of the device that allocated the stock key at a frame address of an issuance batch (`by`), as the
 * ledger saw it last before the issuance commit: the receiver context of the ticket predicate (Tor-Review 43). The keys
 * the ledger opens with are not here but in `Buch.keyring` (every device's whole resolver, Tor-Review 47).
 */
export interface ReceiverImage {
  seq: number
  act: string
  address: string
  /** The stock key at the address in the allocator's image (anchor, key agreement). */
  key: string
  keyAgreement: string
  device: string
  person: string
  sets: boolean
  state: M.HolderState
}
/** One journal batch this device wrote, at the store commit that made it durable. */
export interface CommitEntry {
  seq: number
  at: string
  device: string
  person: string
  writer: string
  n: number
  ops: M.Op[]
  intents: CommitIntent[]
  /** Issuance batches: per act side, the committing device's own anchors on that relationship (the ticket's signer). */
  mediator?: Array<{ rel: string; own: string[] }>
}
/** Every successful store commit of a device (also without a new own batch). */
export interface CommitMark {
  seq: number
  at: string
  device: string
}
export interface Production {
  seq: number
  at: string
  device: string
  person: string
  digest: string
  type: string
  issuer: string
  recipient: string
  payload: Record<string, unknown>
  frames: string[]
}
export interface CarrierTicket {
  seq: number
  at: string
  frame: string
  address: string
  device: string
  digest: string
  act: string
  signer: string
  named: string
}
/**
 * Every frame the carrier took (Tor-Review 47): its bytes, as the receivers get them. P-Commit opens each with the full
 * resolver of every observed device that holds the key at its address (`keyring`), as that device would.
 */
export interface CarrierDeposit {
  seq: number
  at: string
  frame: string
  address: string
  bytes: string
}
/**
 * The ledger's copy of one entry of a device's resolver (key id → private key agreement, PKCS#8 base64), taken at the
 * first commit or deposit after the device held it (Tor-Review 47: the same resolver the holder hands `receive`).
 */
export interface KeyCopy {
  seq: number
  device: string
  rkid: string
  xPriv: string
}
/** A `stock-revision@2` at the carrier (K2 step 2b.1): listing with `for` per key, `inc`, `withdraw`, `bury`, `burn`, class. */
export interface CarrierRevision {
  seq: number
  at: string
  frame: string
  address: string
  device: string
  person: string
  signer: string
  digest: string
  writer: string
  inc: string
  rev: number
  keys: string[]
  for: Record<string, string>
  withdraw: string[]
  bury: string[]
  burn: string[]
  classOff: boolean
}
/**
 * K2 step 2b.1: the allocator's balance per store commit (core draft 4 §2.1), computed here from the committed image, not
 * by the device: per relationship with own stock keys or the class on, `belegt` (own acceptances in the 8510 window
 * without the 8515-confirmed), `reserviert` (own keys active or aging with now ≤ expiresAt), the members of M's set as the
 * image knows them and per member the own usable (8470) active keys assigned to it.
 */
export interface BalanceRow {
  seq: number
  at: string
  device: string
  person: string
  rel: string
  classOn: boolean
  belegt: number
  reserviert: number
  supply: Record<string, number>
}
export interface CarrierReceipt {
  seq: number
  at: string
  frame: string
  address: string
  device: string
  signer: string
  ref: string
}
export interface Delivery {
  seq: number
  at: string
  device: string
  person: string
  type: string
  issuer: string
  digest: string
  address: string
  payload: Record<string, unknown>
}
/** What the bench did (generator, fixed sequences): rounds with who was up, introductions with their outcome, crashes. */
export interface BenchEvent {
  seq: number
  at: string
  kind: 'round' | 'introduce' | 'consent' | 'crashed' | 'reload' | 'advance' | 'fault' | 'restore'
  device?: string
  detail?: Record<string, unknown>
}

/** An exception an observer hook threw; the seam caught it (holder, carrier) and went on. */
export interface ObserverError {
  seq: number
  at: string
  hook: string
  device: string | null
  message: string
}
/** A device's union duties (6845) as its last successful store commit holds them. */
export interface DutyImage {
  seq: number
  device: string
  person: string
  duties: Array<{ pair: [string, string]; state: M.PairDuty['state'] }>
}

const b64hash = (b64: string) => frameHash(Buffer.from(b64, 'base64'))
/** The own anchors of the relationship `rel` (its tuples) in a holder state; empty if the state holds no such relationship. */
function ownAnchors(state: M.HolderState, rel: string): string[] {
  try {
    return M.rel(state, rel).tuples.map((t) => t.own)
  } catch {
    return []
  }
}
/** Is the ledger's copy `xPriv` (PKCS#8, base64) the private part of the key agreement `address`? */
function materialAt(xPriv: string, address: string): boolean {
  try {
    const x = createPublicKey(createPrivateKey({ key: Buffer.from(xPriv, 'base64'), format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }).x
    return typeof x === 'string' && mkOfX(Buffer.from(x, 'base64url')) === address
  } catch {
    return false
  }
}
/** The ledger's copy of a private key agreement (PKCS#8, base64), only if its public part is `address`. */
function material(priv: CryptoKey | undefined, address: string): string | undefined {
  if (!priv) return undefined
  try {
    const ko = KeyObject.from(priv)
    const x = createPublicKey(ko).export({ format: 'jwk' }).x
    if (typeof x !== 'string' || mkOfX(Buffer.from(x, 'base64url')) !== address) return undefined
    return ko.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  } catch {
    return undefined
  }
}
/** Union duty states that end the duty (6845.3 `united`, 6845.7 `moot`): not open. */
const TERMINAL: ReadonlySet<M.PairDuty['state']> = new Set(['united', 'moot'])

export class Buch implements HolderObserver {
  readonly commits: CommitEntry[] = []
  readonly marks: CommitMark[] = []
  readonly carrier = { revisions: [] as CarrierRevision[], tickets: [] as CarrierTicket[], receipts: [] as CarrierReceipt[], other: 0, unknown: 0, deposits: [] as CarrierDeposit[] }
  readonly deliveries: Delivery[] = []
  readonly events: BenchEvent[] = []
  /** Every document an observed device produced, in order. */
  readonly productions: Production[] = []
  /** Per device the union duties of its last committed image. */
  readonly duties = new Map<string, DutyImage>()
  readonly errors: ObserverError[] = []
  /** Per issuance and named key the receiver's committed image at the issuance commit (P-Commit's reference context). */
  readonly receivers: ReceiverImage[] = []
  /** Per device its last committed holder state and whether it runs device sets (live only: feeds `receivers`). */
  private readonly lastImage = new Map<string, { person: string; sets: boolean; state: M.HolderState }>()
  /** K2 step 2b.1: the allocator's balance per commit (`BalanceRow`). */
  readonly balances: BalanceRow[] = []
  /** The ledger's copy of every device resolver (Tor-Review 47), in the dump. */
  readonly keyring: KeyCopy[] = []
  private readonly copied = new Set<string>()
  private world: Welt15 | null = null
  /** Every device that committed (live only: the receiver material at an issuance commit is read from it). */
  private readonly devices = new Map<string, HolderDevice>()
  /** Productions by frame hash (a frame names its document) and by document digest (the first production of each). */
  private readonly byFrame = new Map<string, Production>()
  private readonly byDigest = new Map<string, Production>()
  private readonly batches = new Set<string>()
  private seq = 0
  private now: () => string = () => new Date(0).toISOString()

  /** Carrier and clock of the world (the devices reach the ledger through `Welt15Options.observer`). */
  attach(w: Welt15): void {
    this.world = w
    this.now = () => w.clock.now()
    w.carrier.observe = (f) => this.deposited(f)
    w.carrier.observeFailed = (_f, e) => this.failed(null, 'carrier', e)
  }
  /** An observer hook threw (holder or carrier caught it): recorded, nothing else happens. */
  failed(d: HolderDevice | null, hook: string, error: unknown): void {
    this.errors.push({ ...this.next(), hook, device: d?.name ?? null, message: error instanceof Error ? error.message : String(error) })
  }
  private next() {
    return { seq: ++this.seq, at: this.now() }
  }

  committed(d: HolderDevice, image: DeviceState): void {
    const t = this.next()
    this.devices.set(d.name, d)
    this.copyKeys(t.seq)
    this.marks.push({ ...t, device: d.name })
    this.duties.set(d.name, { seq: t.seq, device: d.name, person: d.person, duties: image.holder.duties.map((x) => ({ pair: [x.pair[0], x.pair[1]], state: x.state })) })
    this.balance(t, d, image.holder)
    const batches = (image.candidate as { batches?: Array<{ writer: string; n: number; ops: M.Op[]; intents: Array<{ digest: string; kind: string; expected: string; address: string; replyTo: string; bytes: string; copies?: Array<{ address: string; bytes: string }> }> }> } | null)?.batches ?? []
    for (const b of batches) {
      if (b.writer.split('@')[0] !== d.name) continue // a sibling's batch folded here is the sibling's commit, not this one
      const key = `${b.writer}#${b.n}`
      if (this.batches.has(key)) continue
      this.batches.add(key)
      const intro = b.ops.filter((op): op is M.Op & { kind: 'introduce' } => op.kind === 'introduce')
      this.commits.push({
        ...t,
        device: d.name,
        person: d.person,
        writer: b.writer,
        n: b.n,
        ops: structuredClone(b.ops),
        intents: b.intents.map((i) => ({
          digest: i.digest,
          kind: i.kind,
          expected: i.expected,
          address: i.address,
          replyTo: i.replyTo,
          frames: [b64hash(i.bytes), ...(i.copies ?? []).map((c) => b64hash(c.bytes))],
          copies: (i.copies ?? []).map((c) => c.address),
          // Tor-Review 45/47: kind decides nothing; in an issuance batch every intent keeps the bytes of every frame.
          ...(intro.length ? { sealed: [i.bytes, ...(i.copies ?? []).map((c) => c.bytes)] } : {}),
        })),
        // The mediator context of an issuance: per act side, the committing device's own anchors on that relationship.
        ...(intro.length ? { mediator: intro.flatMap((op) => [op.act.a, op.act.b]).map((side) => ({ rel: side.rel, own: ownAnchors(image.holder, side.rel) })) } : {}),
      })
      if (intro.length) for (const i of b.intents) for (const a of [i.address, ...(i.copies ?? []).map((c) => c.address)]) this.receiverAt(t.seq, intro[0]!.act.id, a)
    }
    this.lastImage.set(d.name, { person: d.person, sets: !!d.cand.deviceSets, state: image.holder })
  }
  /** Copy every resolver entry of every device not copied yet (the world's devices; live only). */
  private copyKeys(seq: number): void {
    const devices = this.world ? this.world.devices : [...this.devices.values()]
    for (const d of devices)
      for (const [rkid, key] of d.receiverKeys()) {
        const id = `${d.name}|${rkid}`
        if (this.copied.has(id)) continue
        this.copied.add(id)
        const xPriv = material(key, rkid)
        if (xPriv) this.keyring.push({ seq, device: d.name, rkid, xPriv })
      }
  }
  /** The device that allocated the stock key whose key agreement is `address`, in the last committed images. */
  private allocatorAt(address: string): string | undefined {
    for (const [name, img] of this.lastImage)
      for (const r of img.state.relationships) {
        const k = r.stock.find((x) => x.keyAgreement === address)
        if (k) return k.by ?? name
      }
    return undefined
  }
  /**
   * The receiver context of a frame at `address` in an issuance batch: the last committed image of the device that
   * allocated the stock key whose key agreement the address is (K2 `by`; without it the image holding the key).
   */
  private receiverAt(seq: number, act: string, address: string): void {
    if (this.receivers.some((x) => x.seq === seq && x.address === address)) return
    const device = this.allocatorAt(address)
    const img = device ? this.lastImage.get(device) : undefined
    const k = img?.state.relationships.flatMap((r) => r.stock).find((x) => x.keyAgreement === address)
    if (!device || !img || !k) return
    this.receivers.push({ seq, act, address, key: k.anchor, keyAgreement: k.keyAgreement, device, person: img.person, sets: img.sets, state: M.cloneState(img.state) })
  }
  /** The balance rows of one commit (`BalanceRow`), from the image only. */
  private balance(t: { seq: number; at: string }, d: HolderDevice, s: M.HolderState): void {
    const now = Date.parse(t.at)
    for (const r of s.relationships) {
      const own = r.stock.filter((k) => k.by === d.name)
      // Tor-Review 46 B2: a relationship with the class on gets a row also with an empty own stock (a missing first supply).
      if (r.departed || (!own.length && !r.classOn)) continue
      const mine = new Set(own.map((k) => k.anchor))
      const acts = new Map(s.acts.map((a) => [a.id, a.own]))
      const belegt = r.accepted.filter((e) => mine.has(acts.get(e.act) ?? '') && !r.confirmed.includes(e.act) && Date.parse(e.at) > now - M.PARAM.budgetWindowMs).length
      const reserviert = own.filter((k) => (k.state === 'active' || k.state === 'aging') && now <= Date.parse(k.expiresAt)).length
      const h = M.head(r)
      const set = M.own(s.sets, h.peer)
      const members = set ? M.setView(set).members.map((m) => m.anchor) : [h.peer]
      const supply = Object.fromEntries(members.map((m) => [m, own.filter((k) => k.for === m && k.state === 'active' && M.usable(k.expiresAt, t.at)).length]))
      this.balances.push({ ...t, device: d.name, person: d.person, rel: r.id, classOn: r.classOn, belegt, reserviert, supply })
    }
  }
  produced(d: HolderDevice, p: Parameters<HolderObserver['produced']>[1]): void {
    const rec: Production = { ...this.next(), device: d.name, person: d.person, digest: p.digest, type: p.type, issuer: p.issuer, recipient: p.recipient, payload: structuredClone(p.payload) as Record<string, unknown>, frames: p.frames.map(frameHash) }
    this.productions.push(rec)
    if (!this.byDigest.has(p.digest)) this.byDigest.set(p.digest, rec)
    for (const h of rec.frames) if (!this.byFrame.has(h)) this.byFrame.set(h, rec)
  }
  admitted(d: HolderDevice, a: Parameters<HolderObserver['admitted']>[1]): void {
    this.deliveries.push({ ...this.next(), device: d.name, person: d.person, type: a.type, issuer: a.issuer, digest: a.digest, address: a.address, payload: structuredClone(a.payload) })
  }
  private deposited(f: Frame): void {
    const t = this.next()
    const h = frameHash(f.bytes)
    const p = this.byFrame.get(h)
    // Tor-Review 47: every deposit is kept with its bytes, and every resolver as it stands now; the content decides.
    this.copyKeys(t.seq)
    this.carrier.deposits.push({ ...t, frame: h, address: f.address, bytes: Buffer.from(f.bytes).toString('base64') })
    if (!p) {
      this.carrier.unknown++ // not produced by an observed device
      return
    }
    const base = { ...t, frame: h, address: f.address, device: p.device }
    const pl = p.payload
    if (p.type === TYPES.ticket) this.carrier.tickets.push({ ...base, digest: p.digest, act: String(pl.act), signer: p.issuer, named: String(pl.own) })
    else if (p.type === TYPES.stockRevision) {
      const r = pl as unknown as M.StockRevision
      this.carrier.revisions.push({ ...base, person: p.person, signer: p.issuer, digest: p.digest, writer: r.writer, inc: r.inc, rev: r.rev, keys: r.keys.map((k) => k.anchor), for: Object.fromEntries(r.keys.map((k) => [k.anchor, k.for])), withdraw: [...r.withdraw], bury: [...r.bury], burn: [...r.burn], classOff: r.classOff === true })
    } else if (p.type === TYPES.ack) this.carrier.receipts.push({ ...base, signer: p.issuer, ref: String(pl.ref) })
    else this.carrier.other++
  }

  /** A bench event (generator or fixed sequence). */
  note(kind: BenchEvent['kind'], device?: string, detail?: Record<string, unknown>): BenchEvent {
    const e: BenchEvent = { ...this.next(), kind, ...(device ? { device } : {}), ...(detail ? { detail } : {}) }
    this.events.push(e)
    return e
  }
  production(digest: string): Production | undefined {
    return this.byDigest.get(digest)
  }
  /**
   * The whole ledger, canonical (test: a restore changes nothing in it), complete: `Buch.load` rebuilds from it a ledger the
   * checkers judge identically (Tor-Review 42 S1). The two production mappings go as indices into `productions`.
   */
  dump(): string {
    const index = new Map(this.productions.map((p, i) => [p, i]))
    return M.canonical({
      seq: this.seq,
      commits: this.commits,
      marks: this.marks,
      carrier: this.carrier,
      deliveries: this.deliveries,
      events: this.events,
      productions: this.productions,
      byDigest: [...this.byDigest].map(([d, p]) => [d, index.get(p)]),
      byFrame: [...this.byFrame].map(([h, p]) => [h, index.get(p)]),
      duties: [...this.duties.values()],
      errors: this.errors,
      receivers: this.receivers,
      balances: this.balances,
      keyring: this.keyring,
    })
  }
  /** A ledger from a dump (not attached to a world): for re-checking a run later. */
  static load(dump: string): Buch {
    const o = JSON.parse(dump) as {
      seq: number
      commits: CommitEntry[]
      marks: CommitMark[]
      carrier: Buch['carrier']
      deliveries: Delivery[]
      events: BenchEvent[]
      productions: Production[]
      byDigest: Array<[string, number]>
      byFrame: Array<[string, number]>
      duties: DutyImage[]
      errors: ObserverError[]
      receivers: ReceiverImage[]
      balances?: BalanceRow[]
      keyring: KeyCopy[]
    }
    const b = new Buch()
    b.seq = o.seq
    b.commits.push(...o.commits)
    for (const c of o.commits) b.batches.add(`${c.writer}#${c.n}`)
    b.marks.push(...o.marks)
    Object.assign(b.carrier, o.carrier)
    b.deliveries.push(...o.deliveries)
    b.events.push(...o.events)
    b.productions.push(...o.productions)
    for (const [d, i] of o.byDigest) b.byDigest.set(d, b.productions[i]!)
    for (const [h, i] of o.byFrame) b.byFrame.set(h, b.productions[i]!)
    for (const x of o.duties) b.duties.set(x.device, x)
    b.errors.push(...o.errors)
    b.receivers.push(...o.receivers.map((x) => ({ ...x, state: M.fromJson(x.state) })))
    b.balances.push(...(o.balances ?? []))
    b.keyring.push(...o.keyring)
    for (const k of o.keyring) b.copied.add(`${k.device}|${k.rkid}`)
    return b
  }
  /** Every act id accepted on a stock key (8640.14 at a successful receiver commit), over the whole history. */
  acceptedOn(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>()
    for (const c of this.commits)
      for (const op of c.ops)
        if (op.kind === 'ticket-accept') {
          if (!out.has(op.act.own)) out.set(op.act.own, new Set())
          out.get(op.act.own)!.add(op.act.id)
        }
    return out
  }
}

/** A world whose devices report to a fresh ledger from their first commit on. */
export function ledgerWorld(candidate: MultiDeviceCandidate, opts: Omit<Welt15Options, 'observer'> = {}): { w: Welt15; buch: Buch } {
  const buch = new Buch()
  const w = new Welt15(candidate, { ...opts, observer: buch })
  buch.attach(w)
  return { w, buch }
}

// ── Checkers ──

export interface Check {
  property: 'P-Gueltig' | 'P-Einmal' | 'P-Commit' | 'P-Produktion' | 'P-Paar' | 'P-Bilanz' | 'P-Recht' | 'P-Aufhebung' | 'P-Versorgung'
  ok: boolean
  violations: string[]
  counts: Record<string, number>
  /** Issue #83: the observation is incomplete (observer errors), so the property is not judged; never green. */
  invalid?: true
}
/**
 * A property result. On a ledger with observer errors the run is invalid (issue #83): the result is never green, marked
 * `invalid`, its first violation names the errors (the ledger is not a complete observation, whatever it holds).
 */
const check = (b: Buch, property: Check['property'], violations: string[], counts: Record<string, number>): Check =>
  b.errors.length ? { property, ok: false, invalid: true, violations: [`run invalid: ${b.errors.length} observer error(s), first ${b.errors[0]!.hook} on ${b.errors[0]!.device ?? 'carrier'}: ${b.errors[0]!.message}`, ...violations], counts } : { property, ok: violations.length === 0, violations, counts }

/**
 * P-Gueltig (issue #83): the measurement is valid only if every observation reached the ledger. An exception in an
 * observer hook (holder or carrier; the seam swallows it so the device goes on unchanged) is a lost observation: each is a
 * violation, and the property checkers mark the run invalid.
 */
export function pGueltig(b: Buch): Check {
  return { property: 'P-Gueltig', ok: b.errors.length === 0, violations: b.errors.map((e) => `observer error at seq ${e.seq}: ${e.hook} on ${e.device ?? 'carrier'}: ${e.message}`), counts: { errors: b.errors.length } }
}

/**
 * P-Einmal (draft 2 §5.2 no. 4): per stock key at most one accepted act id over the whole history, across every restore.
 * Distinct act ids count; the same bytes delivered again and repeated receipts are not a second acceptance.
 */
export function pEinmal(b: Buch): Check {
  const acc = b.acceptedOn()
  const v = [...acc].filter(([, acts]) => acts.size > 1).map(([key, acts]) => `key ${key.slice(-8)}: ${acts.size} accepted acts (${[...acts].map((a) => a.slice(0, 8)).join(', ')})`)
  return check(b, 'P-Einmal', v, { keys: acc.size, accepts: [...acc.values()].reduce((n, s) => n + s.size, 0) })
}

/** The address frame `j` of an intent goes to (the primary frame to `address`, a copy to its own). */
const frameAddress = (i: CommitIntent, j: number) => (j === 0 ? i.address : i.copies[j - 1]!)


// ── Opening every frame as the holder does (Tor-Review 44, 47) ──

/** A ticket document as the receiver reads it after opening and the proof check. */
export interface OpenedTicket {
  type: string
  issuer: string
  recipient: string
  replyTo: string
  payload: TicketPayload
  [field: string]: unknown
}
/**
 * One frame opened at its routing address as the devices there would: the plaintext with the key id its envelope names
 * (`rkid`, the sealing target) and the device that read it, or why none of them can.
 */
export type Opening = { ok: true; address: string; rkid: string; reader: string; digest: string; doc: OpenedTicket } | { ok: false; address: string; reason: string }

/** The receiver image of an issuance commit for a frame address. */
const receiverOf = (b: Buch, seq: number, address: string) => b.receivers.find((x) => x.seq === seq && x.address === address)

/**
 * The opener of one check (Tor-Review 47: the ledger is an exact mirror of the holder). A frame at `address` reaches the
 * devices that hold the key of that address (they listen there); each opens it as `HolderDevice.handle` does: `receive`
 * with its whole resolver (the ledger's copy, `Buch.keyring`), then the issuer's proof. Copies whose public part is not
 * their key id are dropped (never used).
 */
class Opener {
  private readonly resolvers = new Map<string, Promise<Map<string, CryptoKey>>>()
  constructor(private readonly b: Buch) {}
  private resolver(device: string): Promise<Map<string, CryptoKey>> {
    let r = this.resolvers.get(device)
    if (!r) {
      r = (async () => {
        const out = new Map<string, CryptoKey>()
        for (const k of this.b.keyring) if (k.device === device && !out.has(k.rkid) && materialAt(k.xPriv, k.rkid)) out.set(k.rkid, await globalThis.crypto.subtle.importKey('pkcs8', Buffer.from(k.xPriv, 'base64'), { name: 'X25519' }, false, ['deriveBits']))
        return out
      })()
      this.resolvers.set(device, r)
    }
    return r
  }
  async open(b64: string | undefined, address: string): Promise<Opening> {
    const a = address.slice(-8)
    if (b64 === undefined) return { ok: false, address, reason: `no committed bytes for address ${a}` }
    const readers = [...new Set(this.b.keyring.filter((k) => k.rkid === address).map((k) => k.device))].sort()
    if (!readers.length) return { ok: false, address, reason: `no observed device holds the key at address ${a}` }
    let env: unknown
    try {
      env = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
    } catch {
      return { ok: false, address, reason: `sealed-to-other-key: the bytes at address ${a} are no envelope` }
    }
    const named = String((env as { rkid?: unknown } | null)?.rkid ?? '?')
    let last = 'failed(malformed)'
    for (const reader of readers) {
      const keys = await this.resolver(reader)
      let v: Awaited<ReturnType<typeof receive>>
      try {
        v = await receive(env, (rkid) => keys.get(rkid))
      } catch (e) {
        last = e instanceof Error ? e.message : String(e)
        continue
      }
      if (v.disposition !== 'unique') {
        last = v.disposition
        continue
      }
      const doc = v.document as unknown as OpenedTicket
      if (doc?.type === TYPES.ticket) {
        let proof = false
        try {
          proof = await diVerify(doc, doc.issuer)
        } catch {
          proof = false
        }
        if (!proof) return { ok: false, address, reason: `proof-invalid: the ticket opened at address ${a} carries no valid proof of its issuer` }
      }
      return { ok: true, address, rkid: named, reader, digest: v.digest!, doc }
    }
    return { ok: false, address, reason: `sealed-to-other-key: no device at address ${a} opens it (${last}, the envelope names ${named.slice(-8)})` }
  }
}

/**
 * Every frame of every intent of every issuance batch (any kind, primary and every copy, each on its own), opened at its
 * address (`Opener`), keyed `${commit seq}|${intent digest}|${frame index}` (0 = the primary frame).
 */
export async function openTickets(b: Buch, opener = new Opener(b)): Promise<Map<string, Opening>> {
  const out = new Map<string, Opening>()
  for (const c of b.commits)
    for (const i of c.intents) {
      if (!i.sealed) continue
      for (let j = 0; j < i.frames.length; j++) out.set(`${c.seq}|${i.digest}|${j}`, await opener.open(i.sealed[j], frameAddress(i, j)))
    }
  return out
}
const isTicket = (o: Opening | undefined): o is Extract<Opening, { ok: true }> => !!o?.ok && o.doc.type === TYPES.ticket

/** A deposit that opens at its address to a ticket: the one kind of ticket at the carrier P-Commit knows. */
export interface TicketDeposit {
  deposit: CarrierDeposit
  opened: Extract<Opening, { ok: true }>
  /** The issuance commit it is the committed submission of (none: see `reasons`). */
  commit: CommitEntry | undefined
  reasons: Array<'ticket-without-commit' | 'ticket-without-introduce' | 'sealed-to-other-address'>
}
/**
 * The single path for every ticket at the carrier (Tor-Review 45, 47): every deposit, reported by a producer or not, is
 * opened at its address as the devices there would; if the content is a ticket, it needs an earlier commit that holds these
 * bytes for this address (`ticket-without-commit`) whose batch holds the `introduce` of this ticket's act consuming the key
 * it names (`ticket-without-introduce`), and its envelope must name the address it was routed to
 * (`sealed-to-other-address`, also where the holder accepts). That commit's issuance check judges the same bytes by the
 * receiver predicate and the binding table.
 */
export async function ticketDeposits(b: Buch, opener = new Opener(b)): Promise<TicketDeposit[]> {
  const out: TicketDeposit[] = []
  for (const d of b.carrier.deposits) {
    const o = await opener.open(d.bytes, d.address)
    if (!isTicket(o)) continue
    const p = o.doc.payload
    const holders = b.commits.filter((c) => c.seq < d.seq && c.intents.some((i) => i.frames.some((h, j) => h === d.frame && frameAddress(i, j) === d.address)))
    const commit = holders.find((c) => c.ops.some((op) => op.kind === 'introduce' && op.act.id === p?.act && (op.act.a.key === p.own || op.act.b.key === p.own)))
    const reasons: TicketDeposit['reasons'] = []
    if (!commit) reasons.push(holders.length ? 'ticket-without-introduce' : 'ticket-without-commit')
    if (o.rkid !== d.address) reasons.push('sealed-to-other-address')
    out.push({ deposit: d, opened: o, commit, reasons })
  }
  return out
}

/** What one row of the binding table reads: the committed act and intent, the receiver, the opened ticket. */
export interface BindingInput {
  act: M.MediatorAct
  side: M.MediatorAct['a']
  other: M.MediatorAct['a']
  intent: CommitIntent
  rx: ReceiverImage
  opened: Extract<Opening, { ok: true }>
  /** Which frame of the intent this is (0 = primary) and the address it is routed to. */
  index: number
  address: string
  /** The openings of every frame of the intent, primary first. */
  frames: Array<Opening | undefined>
  /** The committing device's own anchors on `side.rel` at the issuance commit. */
  mediator: string[]
  /**
   * The key agreements the receiver holds for its counterpart on the relationship behind the address (its committed
   * image): each tuple's `peerKeyAgreement` and, under device sets, the members of the counterpart's set.
   */
  counterpart: string[]
  production: Production | undefined
}
/**
 * One binding of a ticket: what the receiver derives (`derived`, paths of the opened ticket or the receiver context) must
 * equal what was committed (`committed`, paths of the act side, the act, the commit intent).
 */
export interface TicketBinding {
  field: string
  derived: readonly string[]
  committed: readonly string[]
  got(x: BindingInput): unknown
  want(x: BindingInput): unknown
}
const pl = (x: BindingInput) => x.opened.doc.payload
/**
 * The binding table (Tor-Review 44): the single list of what binds a committed ticket to its committed act side. Applied to
 * each of the two tickets of an issuance (`side` = the side it goes to, `other` = the other side), after the frame opened
 * with the key its address names and next to the receiver predicate. `bindingGaps` checks it covers every field.
 */
export const TICKET_BINDINGS: readonly TicketBinding[] = [
  // Tor-Review 47: the sealing target (the key id the envelope names) is the address the frame is routed to, even where
  // the holder, which resolves over all its keys, would read it anyway.
  { field: 'sealed-to-other-address', derived: ['envelope.rkid'], committed: ['intent.address', 'intent.copies'], got: (x) => x.opened.rkid, want: (x) => x.address },
  { field: 'own', derived: ['doc.payload.own'], committed: ['side.key'], got: (x) => pl(x).own, want: (x) => x.side.key },
  { field: 'own.anchor', derived: ['receiver.key'], committed: ['side.key'], got: (x) => x.rx.key, want: (x) => x.side.key },
  { field: 'own.keyAgreement', derived: ['receiver.keyAgreement'], committed: ['side.keyAgreement'], got: (x) => x.rx.keyAgreement, want: (x) => x.side.keyAgreement },
  { field: 'voucher.anchor', derived: ['doc.payload.voucher.anchor'], committed: ['other.key'], got: (x) => pl(x).voucher?.anchor, want: (x) => x.other.key },
  { field: 'voucher.keyAgreement', derived: ['doc.payload.voucher.keyAgreement'], committed: ['other.keyAgreement'], got: (x) => pl(x).voucher?.keyAgreement, want: (x) => x.other.keyAgreement },
  { field: 'act', derived: ['doc.payload.act'], committed: ['act.id'], got: (x) => pl(x).act, want: (x) => x.act.id },
  { field: 'issuedAt', derived: ['doc.payload.issuedAt'], committed: ['act.issuedAt'], got: (x) => pl(x).issuedAt, want: (x) => x.act.issuedAt },
  { field: 'expiresAt', derived: ['doc.payload.expiresAt'], committed: ['act.expiresAt'], got: (x) => pl(x).expiresAt, want: (x) => x.act.expiresAt },
  // The mediator relationship: the ticket is signed by the committing device's own anchor on the side's relationship.
  { field: 'mediator', derived: ['doc.issuer'], committed: ['side.rel'], got: (x) => x.opened.doc.issuer, want: (x) => (x.mediator.includes(x.opened.doc.issuer) ? x.opened.doc.issuer : `an own anchor of the mediator on ${x.side.rel.slice(0, 8)}`) },
  // The receipt signer: the receiver signs its receipt with the key at the address the ticket opened at.
  { field: 'expected', derived: ['receiver.key'], committed: ['intent.expected'], got: (x) => x.rx.key, want: (x) => x.intent.expected },
  { field: 'recipient', derived: ['doc.recipient'], committed: ['side.key'], got: (x) => x.opened.doc.recipient, want: (x) => x.side.key },
  { field: 'replyTo', derived: ['doc.replyTo'], committed: ['intent.replyTo'], got: (x) => x.opened.doc.replyTo, want: (x) => x.intent.replyTo },
  // The receipt goes to the mediator on this relationship: a key agreement the receiver's committed image holds for its
  // counterpart there (the committed mediator state holds only the context name of its own key, not the key agreement).
  { field: 'replyTo.counterpart', derived: ['doc.replyTo'], committed: ['receiver.counterpart'], got: (x) => x.opened.doc.replyTo, want: (x) => (x.counterpart.includes(x.opened.doc.replyTo) ? x.opened.doc.replyTo : `a key agreement of the counterpart on the receiver's relationship`) },
  { field: 'digest', derived: ['opened.digest'], committed: ['intent.digest'], got: (x) => x.opened.digest, want: (x) => x.intent.digest },
  { field: 'kind', derived: ['doc.type'], committed: ['intent.kind'], got: (x) => x.opened.doc.type, want: (x) => x.intent.kind },
  // The second condition next to the opening: the committed bytes are the committed frames, and those are the frames
  // the producer sealed for this document.
  { field: 'frames', derived: ['opened.bytes'], committed: ['intent.frames', 'intent.sealed'], got: (x) => (x.intent.sealed ?? []).map(b64hash), want: (x) => x.intent.frames },
  { field: 'production', derived: ['production.frames'], committed: ['intent.frames'], got: (x) => (x.production ? [...x.production.frames].sort() : null), want: (x) => [...x.intent.frames].sort() },
  // Every frame of the intent (primary and copies) carries this same document, each at its own address.
  { field: 'copies', derived: ['frames.opened'], committed: ['intent.copies'], got: (x) => x.frames.filter((o): o is Extract<Opening, { ok: true }> => !!o?.ok && o.digest === x.opened.digest).map((o) => o.address), want: (x) => [x.intent.address, ...x.intent.copies] },
]
/** Fields deliberately not bound by a row, with the reason (`bindingGaps` accepts them and everything under them). */
export const UNBOUND: Readonly<Record<string, string>> = {
  'doc.id': 'a fresh document id; the digest row binds the bytes',
  'doc.issuedAt': 'the signing time; the receiver checks the act times (8640.3), not this',
  'doc.proof': "checked before the table: the issuer's Data Integrity proof (the receiver's proof check)",
  'doc.payload.voucher.name': 'the display name the mediator gives the other side; not part of the committed act',
}
/**
 * The fields of a committed act (`act.*` without its sides), of each committed act side (`side.*`), of a commit intent
 * (`intent.*`) and of an opened ticket (`doc.*`, nested objects as paths) that no row of `TICKET_BINDINGS` names and
 * `UNBOUND` does not list: a field added without a row is a gap.
 */
export function bindingGaps(o: { act: object; sides: object[]; intent: object; doc: object }): string[] {
  const named = new Set(TICKET_BINDINGS.flatMap((r) => [...r.derived, ...r.committed]))
  const leaves = (x: unknown, at: string): string[] => (x !== null && typeof x === 'object' && !Array.isArray(x) ? Object.entries(x).flatMap(([k, y]) => leaves(y, `${at}.${k}`)) : [at])
  const paths = [
    ...Object.keys(o.act).filter((k) => k !== 'a' && k !== 'b').map((k) => `act.${k}`),
    ...o.sides.flatMap((s) => Object.keys(s).map((k) => `side.${k}`)),
    ...Object.keys(o.intent).map((k) => `intent.${k}`),
    ...leaves(o.doc, 'doc'),
  ]
  const unbound = (p: string) => Object.keys(UNBOUND).some((u) => p === u || p.startsWith(`${u}.`))
  return [...new Set(paths.filter((p) => !named.has(p) && !unbound(p)))].sort()
}
/** A value in a violation: keys and digests by their last eight characters, anything else in full (at most 80). */
const shown = (x: unknown) => {
  if (typeof x === 'string' && x.length > 24 && !x.includes(' ')) return `…${x.slice(-8)}`
  const s = typeof x === 'string' ? x : (JSON.stringify(x) ?? 'undefined')
  return s.length > 80 ? `${s.slice(0, 77)}…` : s
}

/**
 * P-Commit (draft 2 §5.2 no. 5, D6; Tor-Review 43: the receiver predicate; 44: the ledger opens the frames; 45, 47: one
 * path, the ledger an exact mirror of the holder):
 * (1) every deposit that opens at its address (as the devices there would) to a ticket is the committed submission of an
 *     issuance of its own act, sealed to the address it was routed to (`ticketDeposits`);
 * (2) every frame of every intent of an issuance batch, primary and each copy on its own, is opened at its address and
 *     judged by its content (never by the intent's kind): a ticket of an act the batch does not introduce is
 *     `ticket-without-introduce`; a frame no device at its address opens is `sealed-to-other-key`;
 * (3) of the ticket frames of the act, exactly one names each side's key (existence: two complete tickets);
 * (4) every ticket frame of the act passes the holder's own predicate (`ticketAcceptance`, 8640.2–8640.8, without the
 *     state steps) at its address, in the receiver context of the stock key's allocator at the issuance commit;
 * (5) every ticket frame of the act is bound by every row of `TICKET_BINDINGS` to the committed act side, act and intent.
 * K2 specialization: the receiver context of a candidate without device sets has no stock address, so its tickets fail (4).
 */
export async function pCommit(b: Buch): Promise<Check> {
  const v: string[] = []
  const opener = new Opener(b)
  // (1) Every ticket at the carrier, one path.
  const deposits = await ticketDeposits(b, opener)
  for (const d of deposits) {
    if (!d.reasons.length) continue
    const p = d.opened.doc.payload
    const why = d.reasons.map((r) => (r === 'ticket-without-commit' ? `${r} (at the carrier without an earlier commit holding these bytes for this address)` : r === 'ticket-without-introduce' ? `${r} (its bytes are committed, but no batch holding them introduces its act on the key it names)` : `${r} (sealed to ${d.opened.rkid.slice(-8)}, routed to ${d.deposit.address.slice(-8)})`))
    v.push(`ticket ${String(p?.act).slice(0, 8)} → ${String(p?.own).slice(-8)} at the carrier (seq ${d.deposit.seq}) at address ${d.deposit.address.slice(-8)}: ${why.join('; ')}`)
  }
  const opened = await openTickets(b, opener)
  let issuances = 0
  for (const c of b.commits) {
    const intro = c.ops.filter((op): op is M.Op & { kind: 'introduce' } => op.kind === 'introduce')
    if (!intro.length) continue
    // (2) Every frame on its own, by content.
    const frames = c.intents.flatMap((i) => i.frames.map((_, j) => ({ i, j, address: frameAddress(i, j), o: opened.get(`${c.seq}|${i.digest}|${j}`) })))
    const tickets = frames.filter((f) => isTicket(f.o)) as Array<{ i: CommitIntent; j: number; address: string; o: Extract<Opening, { ok: true }> }>
    const acts = new Set(intro.map((op) => op.act.id))
    const stray: string[] = []
    for (const f of tickets) {
      if (acts.has(String(f.o.doc.payload?.act))) continue
      const rx = receiverOf(b, c.seq, f.address)
      const verdict = rx ? acceptsTicket(rx, f.o.doc, f.address, c.at) : undefined
      stray.push(`ticket ${String(f.o.doc.payload?.act).slice(0, 8)} → ${String(f.o.doc.payload?.own).slice(-8)} at address ${f.address.slice(-8)}: ticket-without-introduce${verdict && !verdict.ok ? ` (receiver ${rx!.device} refuses: ${verdict.step}: ${verdict.reason})` : ''}`)
    }
    for (const [n, op] of intro.entries()) {
      issuances++
      const what = `issuance ${op.act.id.slice(0, 8)} (${c.writer}#${c.n})`
      const wrong: string[] = n === 0 ? [...stray] : []
      if (intro.length === 1) for (const f of frames) if (f.o && !f.o.ok) wrong.push(`ticket intent ${f.i.digest.slice(0, 8)}${f.j ? ` copy ${f.j}` : ''} at address ${f.address.slice(-8)}: ${f.o.reason}`)
      const mine = tickets.filter((f) => f.o.doc.payload?.act === op.act.id)
      for (const f of mine) if (f.o.doc.payload.own !== op.act.a.key && f.o.doc.payload.own !== op.act.b.key) wrong.push(`ticket at address ${f.address.slice(-8)} names ${String(f.o.doc.payload.own).slice(-8)}, no side of the act`)
      for (const [side, other] of [[op.act.a, op.act.b], [op.act.b, op.act.a]] as const) {
        const to = `ticket → ${side.key.slice(-8)}`
        const xs = mine.filter((f) => f.o.doc.payload.own === side.key)
        if (xs.length !== 1) wrong.push(`${to}: ${xs.length} opened tickets of the act name it (want 1)`)
        // (4), (5) for every ticket frame naming this side, not only the first.
        for (const f of xs) {
          const at = xs.length > 1 ? `${to} (${f.j ? `copy ${f.j} of ` : ''}intent ${f.i.digest.slice(0, 8)})` : to
          const rx = receiverOf(b, c.seq, f.address)
          if (!rx) {
            wrong.push(`${at}: no receiver image at address ${f.address.slice(-8)}`)
            continue
          }
          const verdict = acceptsTicket(rx, f.o.doc, f.address, c.at)
          if (!verdict.ok) wrong.push(`${at}: receiver ${rx.device} refuses at address ${f.address.slice(-8)} (${verdict.step}: ${verdict.reason})`)
          const x: BindingInput = {
            act: op.act,
            side,
            other,
            intent: f.i,
            rx,
            opened: f.o,
            index: f.j,
            address: f.address,
            frames: f.i.frames.map((_, j) => opened.get(`${c.seq}|${f.i.digest}|${j}`)),
            mediator: c.mediator?.find((m) => m.rel === side.rel)?.own ?? [],
            counterpart: counterpartAgreements(rx, f.address),
            production: b.production(f.i.digest),
          }
          for (const row of TICKET_BINDINGS) {
            const got = row.got(x)
            const want = row.want(x)
            if (M.canonical(got ?? null) !== M.canonical(want ?? null)) wrong.push(`${at}: ${row.field} ${shown(got)} (committed ${shown(want)})`)
          }
        }
      }
      if (wrong.length) v.push(`${what}: ${wrong.join('; ')}`)
    }
  }
  // Tickets at the carrier: every deposit whose content is a ticket, and every deposit a producer reported as one.
  return check(b, 'P-Commit', v, { tickets: new Set([...deposits.map((d) => d.deposit.seq), ...b.carrier.tickets.map((t) => t.seq)]).size, issuances })
}

/** The key agreements a receiver image holds for its counterpart on the live relationship whose stock key is `address`. */
function counterpartAgreements(rx: ReceiverImage, address: string): string[] {
  const r = rx.state.relationships.find((x) => !x.departed && x.stock.some((k) => k.keyAgreement === address))
  if (!r) return []
  return r.tuples.flatMap((t) => [t.peerKeyAgreement, ...(rx.sets ? M.setView(M.own(rx.state.sets, t.peer)).members.map((m) => m.keyAgreement) : [])])
}
/** The holder's ticket predicate in the receiver context of a `ReceiverImage` at ledger time `now` (no state steps). */
function acceptsTicket(rx: ReceiverImage, doc: { issuer: string; payload: unknown }, address: string, now: string): ReturnType<typeof ticketAcceptance> {
  const ctx: TicketReceiver = {
    state: rx.state,
    sets: rx.sets,
    now,
    // The channel as the holder resolves it under device sets (`tupleOfStock`): the head of the live relationship whose
    // stock key has this key agreement (the allocator listens there). Without device sets the image holds no address.
    tupleAt: (a) => {
      if (!rx.sets) return undefined
      const r = rx.state.relationships.find((x) => !x.departed && x.stock.some((k) => k.keyAgreement === a))
      return r ? M.head(r) : undefined
    },
  }
  try {
    return ticketAcceptance(doc, address, ctx)
  } catch (e) {
    return { ok: false, step: '8640.2', reason: `malformed ticket (${e instanceof Error ? e.message : String(e)})` }
  }
}

/** The `stock-revision@2` deliveries to the devices `who` before ledger time `seq` (durable ones only, if `durableFor`). */
function revisionsBefore(b: Buch, who: (d: Delivery) => boolean, address: (a: string) => boolean, seq: number, durableFor?: string): M.StockRevision[] {
  let durable = (_: number) => true
  if (durableFor) {
    const crashes = b.events.filter((e) => e.kind === 'crashed' && e.device === durableFor).map((e) => e.seq)
    const marks = b.marks.filter((m) => m.device === durableFor).map((m) => m.seq)
    durable = (s: number) => marks.some((m) => m > s && m < seq && !crashes.some((c) => c > s && c < m))
  }
  return b.deliveries.filter((d) => who(d) && d.type === TYPES.stockRevision && d.seq < seq && address(d.address) && durable(d.seq)).map((d) => d.payload as unknown as M.StockRevision)
}

/**
 * The reference model of P-Produktion (draft 2 §5.1; K2 step 2b.1 with the `for` filter): which stock keys of a relationship
 * the M device was allowed to name at ledger time `seq`, from the delivery protocol only (never `usableView`). Listings: per
 * (writer, inc) the highest revision admitted at this device and made durable by a later commit without a crash in between
 * (a crashed round is re-delivered), keys with `for` among `mine` (the device's anchors). Restrictions (from every device of
 * the person `person`, so a withdrawal that reached the device through the journal first never makes a false alarm):
 * withdrawals by the listing writer, `bury`, the class off in a writer's highest revision; minus the keys the person's own
 * committed issuances consumed; usable by 8470 at `now`. The honest bench has no equivocation and no conflict, so the model
 * has neither rule; a conflict in a generated run shows up as a refusal the model does not explain (a violation).
 */
export function allowedKeys(b: Buch, device: string, address: (a: string) => boolean, seq: number, now: string, mine?: ReadonlySet<string>): string[] {
  const person = b.deliveries.find((d) => d.device === device)?.person ?? b.marks.length.toString()
  const listings = revisionsBefore(b, (d) => d.device === device, address, seq, device)
  const all = revisionsBefore(b, (d) => d.person === person, address, seq)
  const highest = new Map<string, M.StockRevision>()
  for (const r of listings) {
    const k = `${r.writer}|${r.inc}`
    if (!highest.has(k) || r.rev > highest.get(k)!.rev) highest.set(k, r)
  }
  const latest = new Map<string, M.StockRevision>()
  for (const r of all) {
    const k = `${r.writer}|${r.inc}`
    if (!latest.has(k) || r.rev > latest.get(k)!.rev) latest.set(k, r)
  }
  if ([...latest.values()].some((r) => r.classOff)) return []
  const lister = new Map<string, string>()
  for (const r of all) for (const k of r.keys) lister.set(k.anchor, r.writer)
  const gone = new Set<string>()
  for (const r of all) {
    for (const a of r.withdraw) if (lister.get(a) === r.writer) gone.add(a)
    for (const a of r.bury) gone.add(a)
  }
  const consumed = new Set<string>()
  for (const c of b.commits) if (c.person === person && c.seq < seq) for (const op of c.ops) if (op.kind === 'introduce') consumed.add(op.act.a.key), consumed.add(op.act.b.key)
  const horizon = Date.parse(now) + M.PARAM.actLifetimeMs + M.PARAM.actSkewMs // 8470
  const out = new Set<string>()
  for (const r of highest.values()) for (const k of r.keys) if ((!mine || mine.has(k.for)) && !gone.has(k.anchor) && !consumed.has(k.anchor) && Date.parse(k.expiresAt) >= horizon) out.add(k.anchor)
  return [...out].sort()
}

/**
 * P-Produktion (draft 2 §5.2 no. 7): if the M device had admissible keys for both sides (reference model), was up and
 * online and the act's remaining time exceeds the delivery reserve, both tickets reach the carrier within k rounds in which
 * the device is up, as committed submissions (frame and address as committed, Tor-Review 43 B2) that open with the key
 * their address names (Tor-Review 44 B1). An introduction that crashed before its commit is no issuance (a valid run). A refusal while the
 * reference model admits keys for both sides is a violation (silent refusal).
 */
export async function pProduktion(b: Buch, opts: { rounds?: number; reserveMs?: number } = {}): Promise<Check> {
  const deposits = await ticketDeposits(b)
  const k = opts.rounds ?? PRODUCTION.rounds
  const reserve = opts.reserveMs ?? PRODUCTION.reserveMs
  const v: string[] = []
  const counts = { introductions: 0, obliged: 0, kept: 0, noKeys: 0, crashedBeforeCommit: 0, down: 0, open: 0 }
  for (const e of b.events) {
    if (e.kind !== 'introduce' || !e.device) continue
    counts.introductions++
    const d = e.detail as { addrA: string[]; addrB: string[]; mineA?: string[]; mineB?: string[]; result: { act?: string; refused?: string }; armed: string | null; up: boolean }
    if (!d.up) {
      counts.down++
      continue
    }
    if (d.result.refused === 'crashed' && d.armed === 'before-commit') {
      counts.crashedBeforeCommit++
      continue
    }
    const ka = allowedKeys(b, e.device, (a) => d.addrA.includes(a), e.seq, e.at, d.mineA ? new Set(d.mineA) : undefined)
    const kb = allowedKeys(b, e.device, (a) => d.addrB.includes(a), e.seq, e.at, d.mineB ? new Set(d.mineB) : undefined)
    if (!ka.length || !kb.length) {
      counts.noKeys++
      continue
    }
    counts.obliged++
    const next = b.events.find((x) => x.seq > e.seq)?.seq ?? Infinity
    const act = d.result.act ?? b.commits.find((c) => c.device === e.device && c.seq > e.seq && c.seq < next && c.ops.some((op) => op.kind === 'introduce'))?.ops.find((op): op is M.Op & { kind: 'introduce' } => op.kind === 'introduce')?.act.id
    if (!act) {
      v.push(`introduce at seq ${e.seq} on ${e.device}: refused (${d.result.refused ?? '?'}) although the reference admits ${ka.length} and ${kb.length} keys`)
      continue
    }
    const issued = b.commits.flatMap((c) => c.ops).find((op): op is M.Op & { kind: 'introduce' } => op.kind === 'introduce' && op.act.id === act)
    if (issued && Date.parse(issued.act.expiresAt) - Date.parse(e.at) <= reserve) {
      counts.obliged--
      continue
    }
    const upRounds = b.events.filter((x) => x.kind === 'round' && x.seq > e.seq && ((x.detail?.up as string[] | undefined) ?? []).includes(e.device!))
    const deadline = upRounds[k - 1]?.seq
    if (deadline === undefined) {
      counts.open++
      continue
    }
    // Tor-Review 43 B2: only committed submissions count (a ticket deposited at another address does not keep the duty);
    // Tor-Review 44 B1: and only if its committed frame opens with the key its address names (the side named is the one
    // the opened ticket names).
    // Tor-Review 45: the same single path as P-Commit (`ticketDeposits`): a deposit counts if its content is a ticket of
    // this act, it opens with the key its address names, and it is the committed submission of this device's issuance.
    const named = new Set<string>()
    for (const d of deposits) if (!d.reasons.length && d.deposit.seq < deadline && d.commit!.device === e.device && d.opened.doc.payload?.act === act) named.add(String(d.opened.doc.payload.own))
    if (named.size === 2) counts.kept++
    else v.push(`issuance ${act.slice(0, 8)} on ${e.device}: ${named.size} of 2 tickets at the carrier within ${k} rounds`)
  }
  return check(b, 'P-Produktion', v, counts)
}

/**
 * P-Paar per act (draft 3 §7.1 no. 6): if both sides hold act X as `connected`, they hold the same pair context (the card
 * keys of both sides; compared in the ledger: each side's `connect` tuple against the other side's). Across acts nothing is
 * asserted; `pairCounter` counts.
 */
export function pPaar(b: Buch): Check {
  const v: string[] = []
  const ctx = new Map<string, Map<string, Set<string>>>() // act → person → pair contexts
  const cardKa = new Map<string, string>() // own card anchor → key agreement (produce / consent ops)
  for (const c of b.commits)
    for (const op of c.ops) {
      if (op.kind === 'produce') cardKa.set(op.card.anchor, op.card.keyAgreement)
      if (op.kind === 'consent' && op.card) cardKa.set(op.card.anchor, op.card.keyAgreement)
    }
  for (const c of b.commits)
    for (const op of c.ops) {
      if (op.kind !== 'connect') continue
      if (!ctx.has(op.act)) ctx.set(op.act, new Map())
      const per = ctx.get(op.act)!
      if (!per.has(c.person)) per.set(c.person, new Set())
      per.get(c.person)!.add(M.canonical({ own: op.tuple.own, peer: op.tuple.peer, peerKeyAgreement: op.tuple.peerKeyAgreement }))
    }
  let both = 0
  for (const [act, per] of ctx) {
    const sides = [...per]
    for (const [person, set] of sides) if (set.size > 1) v.push(`act ${act.slice(0, 8)}: ${person} holds ${set.size} pair contexts`)
    if (sides.length > 2) v.push(`act ${act.slice(0, 8)}: ${sides.length} persons connected (${sides.map(([p]) => p).join(', ')})`)
    if (sides.length !== 2) continue
    both++
    const [[p, sp], [q, sq]] = sides as [[string, Set<string>], [string, Set<string>]]
    for (const x of sp)
      for (const y of sq) {
        const a = JSON.parse(x) as { own: string; peer: string; peerKeyAgreement: string }
        const o = JSON.parse(y) as typeof a
        const same = a.own === o.peer && a.peer === o.own && (cardKa.get(o.own) ?? a.peerKeyAgreement) === a.peerKeyAgreement && (cardKa.get(a.own) ?? o.peerKeyAgreement) === o.peerKeyAgreement
        if (!same) v.push(`act ${act.slice(0, 8)}: ${p} and ${q} connected with different pair contexts`)
      }
  }
  return check(b, 'P-Paar', v, { connectedActs: ctx.size, bothSides: both })
}

/**
 * Counter, not an assertion (draft 3 §7.1, §12 D1): tuples per person pair (every tuple a person ever opened, by the person
 * behind its peer anchor) and open union duties per person. Duties follow the committed holder state, not the `duty` ops
 * (Tor-Review 42 B2: `depart` ends duties as `moot` without a `duty` op): per device its last committed image; a pair is
 * open for the person if one of the person's devices holds it in a non-terminal state and none holds it ended (`united`,
 * `moot`; a sibling that has not folded the end yet does not reopen it).
 */
export function pairCounter(b: Buch): { tuples: Record<string, number>; openDuties: Record<string, number> } {
  const ownAnchor = new Map<string, string>() // anchor → person (from that person's own commits)
  const tuples = new Map<string, Map<string, string>>() // person → tuple id → peer anchor
  for (const c of b.commits)
    for (const op of c.ops) {
      const tuple = op.kind === 'open-tuple' || op.kind === 'connect' ? op.tuple : null
      if (tuple) {
        ownAnchor.set(tuple.own, c.person)
        if (!tuples.has(c.person)) tuples.set(c.person, new Map())
        tuples.get(c.person)!.set(tuple.id, tuple.peer)
      }
      if (op.kind === 'produce') ownAnchor.set(op.card.anchor, c.person)
    }
  const out: Record<string, number> = {}
  for (const [person, ts] of tuples)
    for (const peer of ts.values()) {
      const key = `${person}→${ownAnchor.get(peer) ?? '?'}`
      out[key] = (out[key] ?? 0) + 1
    }
  const duties = new Map<string, Map<string, { ended: boolean; open: boolean }>>() // person → pair → over the person's devices
  for (const img of b.duties.values()) {
    if (!duties.has(img.person)) duties.set(img.person, new Map())
    const per = duties.get(img.person)!
    for (const d of img.duties) {
      const key = d.pair.join('+')
      const x = per.get(key) ?? { ended: false, open: false }
      if (TERMINAL.has(d.state)) x.ended = true
      else x.open = true
      per.set(key, x)
    }
  }
  const open: Record<string, number> = {}
  for (const [person, ds] of duties) open[person] = [...ds.values()].filter((x) => x.open && !x.ended).length
  return { tuples: out, openDuties: open }
}

// ── K2 step 2b.1: checkers of the allocation (core draft 4 §2, §3; draft 2 §5.2 no. 2, 3, 9) ──

/**
 * P-Bilanz (core draft 4 §2.1, Q3, Q8): at every store commit of an allocating device, per mediator relationship,
 * `belegt + reserviert ≤ share`. `share` is the static share of the acceptance budget per device (MV-9), given by the run.
 */
export function pBilanz(b: Buch, share: number): Check {
  const v = b.balances.filter((r) => r.belegt + r.reserviert > share).map((r) => `${r.device} on ${r.rel.slice(0, 12)} at seq ${r.seq}: belegt ${r.belegt} + reserviert ${r.reserviert} > share ${share}`)
  return check(b, 'P-Bilanz', v, { rows: b.balances.length, max: Math.max(0, ...b.balances.map((r) => r.belegt + r.reserviert)) })
}

/**
 * P-Recht (draft 2 §5.2 no. 3): no acceptance of a ticket whose signer is not the `for` of the named anchor after its first
 * binding in the ledger (the first revision at the carrier that listed it). An acceptance without a ticket or a binding in
 * the ledger is counted, not judged.
 */
export function pRecht(b: Buch): Check {
  const v: string[] = []
  const bound = new Map<string, string>()
  for (const r of [...b.carrier.revisions].sort((x, y) => x.seq - y.seq)) for (const [a, f] of Object.entries(r.for)) if (!bound.has(a)) bound.set(a, f)
  let judged = 0
  let unjudged = 0
  for (const c of b.commits)
    for (const op of c.ops) {
      if (op.kind !== 'ticket-accept') continue
      const t = b.carrier.tickets.find((x) => x.act === op.act.id && x.named === op.act.own)
      const f = bound.get(op.act.own)
      if (!t || !f) {
        unjudged++
        continue
      }
      judged++
      if (t.signer !== f) v.push(`act ${op.act.id.slice(0, 8)} accepted by ${c.device} on ${op.act.own.slice(-8)}: ticket signed by ${t.signer.slice(-8)}, assigned to ${f.slice(-8)}`)
    }
  return check(b, 'P-Recht', v, { judged, unjudged })
}

/**
 * P-Aufhebung (draft 2 §5.2 no. 2, draft 3 §4): withdrawal, burial and class off hit exactly their anchors. (A) No device
 * accepts on a key after its own commit that withdrew it. (M) No M device names a key at its issuance commit if a revision
 * it had admitted and made durable before withdrew it (by the listing writer), buried it, or carried the class off as the
 * highest revision of its (writer, inc). Future anchors are not locked: that the reference admits fresh anchors after the
 * class is on again is P-Produktion's side.
 */
export function pAufhebung(b: Buch): Check {
  const v: string[] = []
  let accepts = 0
  let issuances = 0
  for (const c of b.commits)
    for (const op of c.ops) {
      if (op.kind === 'ticket-accept') {
        accepts++
        const earlier = b.commits.some((x) => x.device === c.device && x.seq < c.seq && x.ops.some((o) => o.kind === 'withdraw' && o.anchors.includes(op.act.own)))
        if (earlier) v.push(`${c.device} accepted act ${op.act.id.slice(0, 8)} on ${op.act.own.slice(-8)} after withdrawing it`)
      }
      if (op.kind === 'introduce') {
        issuances++
        const crashes = b.events.filter((e) => e.kind === 'crashed' && e.device === c.device).map((e) => e.seq)
        const marks = b.marks.filter((m) => m.device === c.device).map((m) => m.seq)
        const durable = (s: number) => marks.some((m) => m > s && m < c.seq && !crashes.some((x) => x > s && x < m))
        const seen = b.deliveries.filter((d) => d.device === c.device && d.type === TYPES.stockRevision && d.seq < c.seq && durable(d.seq))
        for (const side of [op.act.a, op.act.b]) {
          // The revisions of the person behind the named key (by the producing device of each admitted revision).
          const owner = seen.find((d) => (d.payload as unknown as M.StockRevision).keys.some((k) => k.anchor === side.key))
          const person = owner ? b.production(owner.digest)?.person : undefined
          if (!person) continue
          const revs = seen.filter((d) => b.production(d.digest)?.person === person).map((d) => d.payload as unknown as M.StockRevision)
          // Tor-Review 46 B3: the model's own set function decides (no second copy of the rules): withdrawal by the bound
          // writer, burial with the revocation exception ("currently lists", B6), class off of a non-revoked writer. The
          // revocations are those any device of M had admitted before (a superset of the namer's knowledge: it can only make
          // a burial count less, never a false alarm).
          const al = M.allocation(revs, { revoked: revokedAt(b, c.person, c.seq), members: new Set(revs.flatMap((r) => r.keys.map((k) => k.for))) })
          const lifted = al.fold.withdrawn.has(side.key) || al.buried(side.key)
          const off = al.classOff
          if (lifted || off) v.push(`${c.device} named ${side.key.slice(-8)} in act ${op.act.id.slice(0, 8)} after ${lifted ? 'a withdrawal or burial' : 'the class off'} it had admitted`)
        }
      }
    }
  return check(b, 'P-Aufhebung', v, { accepts, issuances })
}

/** The writers (signer ids) revoked in any counterpart set the devices of `person` admitted before ledger time `seq`. */
function revokedAt(b: Buch, person: string, seq: number): Set<string> {
  const sets = new Map<string, M.DeviceSet>()
  for (const d of b.deliveries) {
    if (d.person !== person || d.type !== TYPES.deviceSet || d.seq >= seq) continue
    const p = d.payload as unknown as { root: string; rootKeyAgreement: string; entries: M.SetCert[] }
    if (!sets.has(p.root)) sets.set(p.root, { root: p.root, rootKeyAgreement: p.rootKeyAgreement, certs: M.table(), revs: M.table(), seen: [] })
    for (const c of p.entries) M.put(sets.get(p.root)!.certs, M.certKey(c), c)
  }
  const out = new Set<string>()
  for (const set of sets.values()) for (const a of M.setView(set).revoked) out.add(M.signerId(a))
  return out
}

/**
 * P-Versorgung (core draft 4 §2.3, draft 2 §5.2 no. 9): at the end of a run, per allocating device and relationship with the
 * class on, from its last commit: if `frei_zuteilbar ≥ 1`, every member of M's set it knows holds a usable key from it
 * (supply only from free rights, empty devices first); members without a key while nothing is free are counted
 * (`unsupplied`, the named price of decision 9.1 (a)), not a violation.
 */
export function pVersorgung(b: Buch, share: number): Check {
  const v: string[] = []
  const last = new Map<string, BalanceRow>()
  for (const r of b.balances) last.set(`${r.device}|${r.rel}`, r)
  let unsupplied = 0
  let rows = 0
  for (const r of last.values()) {
    if (!r.classOn) continue
    rows++
    const free = Math.max(0, share - r.belegt - r.reserviert)
    const empty = Object.entries(r.supply).filter(([, n]) => n === 0).map(([m]) => m)
    if (!empty.length) continue
    if (free >= 1) v.push(`${r.device} on ${r.rel.slice(0, 12)}: ${free} free right(s), ${empty.length} member(s) without a key (${empty.map((m) => m.slice(-8)).join(', ')})`)
    else unsupplied += empty.length
  }
  return check(b, 'P-Versorgung', v, { rows, unsupplied })
}
