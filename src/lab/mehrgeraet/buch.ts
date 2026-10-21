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
// Per issuance and named key, the receiver context of P-Commit: the allocator's committed image at the issuance commit
// (Tor-Review 43; P-Commit applies the holder's own ticket predicate there).
//
// The dump is the complete ledger (Tor-Review 42 S1): `Buch.load(dump)` rebuilds a ledger every checker judges exactly as
// the live one, the production mapping included.
//
// The ledger never parses wire bytes: frames are identified by hash, their content comes from the producer's own plaintext
// (`HolderObserver.produced`) or from the receiving parser's admitted values (`HolderObserver.admitted`).
//
// Checkers over the ledger: P-Einmal, P-Commit, P-Produktion, P-Paar per act, and a counter (not an assertion) of tuples
// per person pair and open union duties (draft 3 §7.1, §12 D1).

import { frameHash, ticketAcceptance, TYPES, type DeviceState, type HolderDevice, type HolderObserver, type MultiDeviceCandidate, type TicketReceiver } from './holder'
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
  /** Hashes of the primary frame and of every copy (the bytes the store holds). */
  frames: string[]
  /** The address of each copy (`frames[1..]`; the primary frame goes to `address`). */
  copies: string[]
}
/**
 * The committed image of the device that holds a named stock key (its allocator, `by`), as the ledger saw it last before
 * the issuance commit that names the key: the receiver context of the ticket predicate (Tor-Review 43).
 */
export interface ReceiverImage {
  seq: number
  act: string
  key: string
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
export interface CarrierRevision {
  seq: number
  at: string
  frame: string
  address: string
  device: string
  person: string
  signer: string
  revision: number
  keys: string[]
  tombstones: string[]
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
/** Union duty states that end the duty (6845.3 `united`, 6845.7 `moot`): not open. */
const TERMINAL: ReadonlySet<M.PairDuty['state']> = new Set(['united', 'moot'])

export class Buch implements HolderObserver {
  readonly commits: CommitEntry[] = []
  readonly marks: CommitMark[] = []
  readonly carrier = { revisions: [] as CarrierRevision[], tickets: [] as CarrierTicket[], receipts: [] as CarrierReceipt[], other: 0, unknown: 0 }
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
  /** Productions by frame hash (a frame names its document) and by document digest (the first production of each). */
  private readonly byFrame = new Map<string, Production>()
  private readonly byDigest = new Map<string, Production>()
  private readonly batches = new Set<string>()
  private seq = 0
  private now: () => string = () => new Date(0).toISOString()

  /** Carrier and clock of the world (the devices reach the ledger through `Welt15Options.observer`). */
  attach(w: Welt15): void {
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
    this.marks.push({ ...t, device: d.name })
    this.duties.set(d.name, { seq: t.seq, device: d.name, person: d.person, duties: image.holder.duties.map((x) => ({ pair: [x.pair[0], x.pair[1]], state: x.state })) })
    const batches = (image.candidate as { batches?: Array<{ writer: string; n: number; ops: M.Op[]; intents: Array<{ digest: string; kind: string; expected: string; address: string; bytes: string; copies?: Array<{ address: string; bytes: string }> }> }> } | null)?.batches ?? []
    for (const b of batches) {
      if (b.writer.split('@')[0] !== d.name) continue // a sibling's batch folded here is the sibling's commit, not this one
      const key = `${b.writer}#${b.n}`
      if (this.batches.has(key)) continue
      this.batches.add(key)
      this.commits.push({
        ...t,
        device: d.name,
        person: d.person,
        writer: b.writer,
        n: b.n,
        ops: structuredClone(b.ops),
        intents: b.intents.map((i) => ({ digest: i.digest, kind: i.kind, expected: i.expected, address: i.address, frames: [b64hash(i.bytes), ...(i.copies ?? []).map((c) => b64hash(c.bytes))], copies: (i.copies ?? []).map((c) => c.address) })),
      })
      for (const op of b.ops) if (op.kind === 'introduce') for (const side of [op.act.a, op.act.b]) this.receiverAt(t.seq, op.act.id, side.key)
    }
    this.lastImage.set(d.name, { person: d.person, sets: !!d.cand.deviceSets, state: image.holder })
  }
  /** The receiver of the ticket for `key`: the allocator's last committed image (K2 `by`; without it the image holding the key). */
  private receiverAt(seq: number, act: string, key: string): void {
    let device: string | undefined
    for (const [name, img] of this.lastImage)
      for (const r of img.state.relationships) {
        const k = r.stock.find((x) => x.anchor === key)
        if (k && !device) device = k.by ?? name
      }
    const img = device ? this.lastImage.get(device) : undefined
    if (device && img) this.receivers.push({ seq, act, key, device, person: img.person, sets: img.sets, state: M.cloneState(img.state) })
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
    if (!p) {
      this.carrier.unknown++ // not produced by an observed device
      return
    }
    const base = { ...t, frame: h, address: f.address, device: p.device }
    const pl = p.payload
    if (p.type === TYPES.ticket) this.carrier.tickets.push({ ...base, digest: p.digest, act: String(pl.act), signer: p.issuer, named: String(pl.own) })
    else if (p.type === TYPES.revision) {
      const keys = Array.isArray(pl.keys) ? (pl.keys as Array<{ anchor: string }>).map((k) => k.anchor) : []
      const tombstones = Array.isArray(pl.tombstones) ? (pl.tombstones as string[]) : []
      this.carrier.revisions.push({ ...base, person: p.person, signer: p.issuer, revision: Number(pl.revision), keys, tombstones })
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
  property: 'P-Einmal' | 'P-Commit' | 'P-Produktion' | 'P-Paar'
  ok: boolean
  violations: string[]
  counts: Record<string, number>
}
const check = (property: Check['property'], violations: string[], counts: Record<string, number>): Check => ({ property, ok: violations.length === 0, violations, counts })

/**
 * P-Einmal (draft 2 §5.2 no. 4): per stock key at most one accepted act id over the whole history, across every restore.
 * Distinct act ids count; the same bytes delivered again and repeated receipts are not a second acceptance.
 */
export function pEinmal(b: Buch): Check {
  const acc = b.acceptedOn()
  const v = [...acc].filter(([, acts]) => acts.size > 1).map(([key, acts]) => `key ${key.slice(-8)}: ${acts.size} accepted acts (${[...acts].map((a) => a.slice(0, 8)).join(', ')})`)
  return check('P-Einmal', v, { keys: acc.size, accepts: [...acc.values()].reduce((n, s) => n + s.size, 0) })
}

/**
 * The commit a carrier ticket is the committed submission of: an earlier successful store commit of the same device whose
 * batch holds this frame for this address (primary frame at the intent's address, a copy at the copy's address) and, in
 * that batch, the `introduce` of the ticket's act consuming the named key (MV-30). Undefined: not the committed submission.
 */
export function committedSubmission(b: Buch, t: CarrierTicket): CommitEntry | undefined {
  return b.commits.find((c) => c.device === t.device && c.seq < t.seq && c.intents.some((i) => i.frames.some((h, j) => h === t.frame && (j === 0 ? i.address : i.copies[j - 1]) === t.address)) && c.ops.some((op) => op.kind === 'introduce' && op.act.id === t.act && (op.act.a.key === t.named || op.act.b.key === t.named)))
}

/**
 * P-Commit (draft 2 §5.2 no. 5, D6; Tor-Review 43: the receiver predicate instead of a field list):
 * (1) every ticket at the carrier is a committed submission (`committedSubmission`: frame and address as committed, after
 *     the commit that consumes both keys);
 * (2) every issuance batch holds exactly two complete ticket intents of its act, one per named key (existence);
 * (3) each of them is a ticket the honest receiver accepts for this act: the holder's own predicate (`ticketAcceptance`,
 *     8640.2–8640.8, without the state steps) applied to the committed plaintext at the committed address, in the receiver
 *     context of the named key's allocator at the issuance commit (`ReceiverImage`); the act it yields is the committed act
 *     side (own = X's key, voucher = the other side's key and key agreement, the act's times); the receipt is expected
 *     from the key the ticket is sealed to (intent and document recipient); the committed bytes are the frames sealed for it.
 * K2 specialization: the receiver context of a candidate without device sets has no stock address, so its tickets fail (3).
 */
export function pCommit(b: Buch): Check {
  const v: string[] = []
  for (const t of b.carrier.tickets) {
    if (committedSubmission(b, t)) continue
    const held = b.commits.find((c) => c.device === t.device && c.seq < t.seq && c.intents.some((i) => i.frames.includes(t.frame)))
    const i = held?.intents.find((x) => x.frames.includes(t.frame))
    const at = i ? (i.frames.indexOf(t.frame) === 0 ? i.address : i.copies[i.frames.indexOf(t.frame) - 1]) : undefined
    if (held && at !== undefined && at !== t.address) v.push(`ticket ${t.act.slice(0, 8)} → ${t.named.slice(-8)} at the carrier (seq ${t.seq}) at address ${t.address.slice(-8)}: not the committed submission (${held.writer}#${held.n} holds these bytes for address ${at.slice(-8)})`)
    else v.push(`ticket ${t.act.slice(0, 8)} → ${t.named.slice(-8)} at the carrier (seq ${t.seq}) without an earlier commit of ${t.device} holding its bytes and both consumptions`)
  }
  let issuances = 0
  for (const c of b.commits) {
    for (const op of c.ops) {
      if (op.kind !== 'introduce') continue
      issuances++
      const tickets = c.intents.filter((i) => i.kind === TYPES.ticket && b.production(i.digest)?.payload.act === op.act.id)
      const named = tickets.map((i) => String(b.production(i.digest)!.payload.own)).sort()
      const want = [op.act.a.key, op.act.b.key].sort()
      const complete = tickets.every((i) => i.frames.length > 0)
      const what = `issuance ${op.act.id.slice(0, 8)} (${c.writer}#${c.n})`
      if (tickets.length !== 2 || M.canonical(named) !== M.canonical(want) || !complete) {
        v.push(`${what}: ${tickets.length} ticket intents in the batch, named ${named.map((x) => x.slice(-8)).join(', ') || 'none'} (want both of ${want.map((x) => x.slice(-8)).join(', ')})`)
        continue
      }
      const wrong: string[] = []
      for (const [side, other] of [[op.act.a, op.act.b], [op.act.b, op.act.a]] as const) {
        const i = tickets.find((x) => b.production(x.digest)!.payload.own === side.key)!
        const p = b.production(i.digest)!
        const to = `ticket → ${side.key.slice(-8)}`
        const rx = b.receivers.find((x) => x.seq === c.seq && x.act === op.act.id && x.key === side.key)
        if (!rx) {
          wrong.push(`${to}: no observed device holds the named key`)
          continue
        }
        const verdict = acceptsTicket(rx, p, i.address, c.at)
        if (!verdict.ok) {
          wrong.push(`${to}: receiver ${rx.device} refuses at address ${i.address.slice(-8)} (${verdict.step}: ${verdict.reason})`)
          continue
        }
        if (verdict.repeated) continue // not reached: the reference passes no state steps
        const pl = verdict.p
        if (pl.voucher.anchor !== other.key || pl.voucher.keyAgreement !== other.keyAgreement) wrong.push(`${to}: voucher ${String(pl.voucher.anchor).slice(-8)} (want the other side's ${other.key.slice(-8)})`)
        if (pl.issuedAt !== op.act.issuedAt || pl.expiresAt !== op.act.expiresAt) wrong.push(`${to}: act times differ from the issuance`)
        if (i.expected !== verdict.own.anchor || p.recipient !== verdict.own.anchor) wrong.push(`${to}: expected receipt signer ${i.expected.slice(-8)} (want ${verdict.own.anchor.slice(-8)}, the key it is sealed to)`)
        if (M.canonical([...i.frames].sort()) !== M.canonical([...p.frames].sort())) wrong.push(`${to}: committed frames are not the sealed frames of its document`)
      }
      if (wrong.length) v.push(`${what}: ${wrong.join('; ')}`)
    }
  }
  return check('P-Commit', v, { tickets: b.carrier.tickets.length, issuances })
}

/** The holder's ticket predicate in the receiver context of a `ReceiverImage` at ledger time `now` (no state steps). */
function acceptsTicket(rx: ReceiverImage, p: Production, address: string, now: string): ReturnType<typeof ticketAcceptance> {
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
    return ticketAcceptance({ issuer: p.issuer, payload: p.payload }, address, ctx)
  } catch (e) {
    return { ok: false, step: '8640.2', reason: `malformed ticket (${e instanceof Error ? e.message : String(e)})` }
  }
}

/**
 * The reference model of P-Produktion (draft 2 §5.1): which stock keys of a relationship the M device was allowed to name
 * at ledger time `seq`, from its delivery protocol only (never `usableView`): per signer the highest admitted revision's
 * keys, minus admitted tombstones, minus keys the device's own committed issuances consumed, usable by 8470 at `now`. An
 * admission counts once a later store commit of the device made it durable without a crash in between (a crashed round
 * is re-delivered). Step 2a has no `for` (M is a single-writer fixture and names every key; 2b.1 adds it).
 */
export function allowedKeys(b: Buch, device: string, address: (a: string) => boolean, seq: number, now: string): string[] {
  const crashes = b.events.filter((e) => e.kind === 'crashed' && e.device === device).map((e) => e.seq)
  const marks = b.marks.filter((m) => m.device === device).map((m) => m.seq)
  const durable = (s: number) => marks.some((m) => m > s && m < seq && !crashes.some((c) => c > s && c < m))
  const bySigner = new Map<string, { revision: number; keys: Array<{ anchor: string; expiresAt: string }> }>()
  const buried = new Set<string>()
  for (const d of b.deliveries) {
    if (d.device !== device || d.type !== TYPES.revision || d.seq >= seq || !address(d.address) || !durable(d.seq)) continue
    const p = d.payload as { revision: number; keys: Array<{ anchor: string; expiresAt: string }>; tombstones?: string[] }
    for (const t of p.tombstones ?? []) buried.add(t)
    const held = bySigner.get(d.issuer)
    if (!held || p.revision > held.revision) bySigner.set(d.issuer, { revision: p.revision, keys: p.keys })
  }
  const consumed = new Set<string>()
  for (const c of b.commits) if (c.device === device && c.seq < seq) for (const op of c.ops) if (op.kind === 'introduce') consumed.add(op.act.a.key), consumed.add(op.act.b.key)
  const horizon = Date.parse(now) + M.PARAM.actLifetimeMs + M.PARAM.actSkewMs // 8470
  const out = new Set<string>()
  for (const { keys } of bySigner.values()) for (const k of keys) if (!buried.has(k.anchor) && !consumed.has(k.anchor) && Date.parse(k.expiresAt) >= horizon) out.add(k.anchor)
  return [...out].sort()
}

/**
 * P-Produktion (draft 2 §5.2 no. 7): if the M device had admissible keys for both sides (reference model), was up and
 * online and the act's remaining time exceeds the delivery reserve, both tickets reach the carrier within k rounds in which
 * the device is up, as committed submissions (frame and address as committed, Tor-Review 43 B2). An introduction that crashed before its commit is no issuance (a valid run). A refusal while the
 * reference model admits keys for both sides is a violation (silent refusal).
 */
export function pProduktion(b: Buch, opts: { rounds?: number; reserveMs?: number } = {}): Check {
  const k = opts.rounds ?? PRODUCTION.rounds
  const reserve = opts.reserveMs ?? PRODUCTION.reserveMs
  const v: string[] = []
  const counts = { introductions: 0, obliged: 0, kept: 0, noKeys: 0, crashedBeforeCommit: 0, down: 0, open: 0 }
  for (const e of b.events) {
    if (e.kind !== 'introduce' || !e.device) continue
    counts.introductions++
    const d = e.detail as { addrA: string[]; addrB: string[]; result: { act?: string; refused?: string }; armed: string | null; up: boolean }
    if (!d.up) {
      counts.down++
      continue
    }
    if (d.result.refused === 'crashed' && d.armed === 'before-commit') {
      counts.crashedBeforeCommit++
      continue
    }
    const ka = allowedKeys(b, e.device, (a) => d.addrA.includes(a), e.seq, e.at)
    const kb = allowedKeys(b, e.device, (a) => d.addrB.includes(a), e.seq, e.at)
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
    // Tor-Review 43 B2: only committed submissions count (a ticket deposited at another address does not keep the duty).
    const named = new Set(b.carrier.tickets.filter((t) => t.act === act && t.device === e.device && t.seq < deadline && committedSubmission(b, t)).map((t) => t.named))
    if (named.size === 2) counts.kept++
    else v.push(`issuance ${act.slice(0, 8)} on ${e.device}: ${named.size} of 2 tickets at the carrier within ${k} rounds`)
  }
  return check('P-Produktion', v, counts)
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
  return check('P-Paar', v, { connectedActs: ctx.size, bothSides: both })
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
