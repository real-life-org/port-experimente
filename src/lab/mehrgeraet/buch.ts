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
// The ledger never parses wire bytes: frames are identified by hash, their content comes from the producer's own plaintext
// (`HolderObserver.produced`) or from the receiving parser's admitted values (`HolderObserver.admitted`).
//
// Checkers over the ledger: P-Einmal, P-Commit, P-Produktion, P-Paar per act, and a counter (not an assertion) of tuples
// per person pair and open union duties (draft 3 §7.1, §12 D1).

import { frameHash, TYPES, type DeviceState, type HolderDevice, type HolderObserver, type MultiDeviceCandidate } from './holder'
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

const b64hash = (b64: string) => frameHash(Buffer.from(b64, 'base64'))

export class Buch implements HolderObserver {
  readonly commits: CommitEntry[] = []
  readonly marks: CommitMark[] = []
  readonly carrier = { revisions: [] as CarrierRevision[], tickets: [] as CarrierTicket[], receipts: [] as CarrierReceipt[], other: 0, unknown: 0 }
  readonly deliveries: Delivery[] = []
  readonly events: BenchEvent[] = []
  readonly errors: ObserverError[] = []
  /** Productions by frame hash (a frame names its document) and by document digest. */
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
    const batches = (image.candidate as { batches?: Array<{ writer: string; n: number; ops: M.Op[]; intents: Array<{ digest: string; kind: string; expected: string; address: string; bytes: string; copies?: Array<{ bytes: string }> }> }> } | null)?.batches ?? []
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
        intents: b.intents.map((i) => ({ digest: i.digest, kind: i.kind, expected: i.expected, address: i.address, frames: [b64hash(i.bytes), ...(i.copies ?? []).map((c) => b64hash(c.bytes))] })),
      })
    }
  }
  produced(d: HolderDevice, p: Parameters<HolderObserver['produced']>[1]): void {
    const rec: Production = { ...this.next(), device: d.name, person: d.person, digest: p.digest, type: p.type, issuer: p.issuer, recipient: p.recipient, payload: structuredClone(p.payload) as Record<string, unknown>, frames: p.frames.map(frameHash) }
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
  /** The whole ledger, canonical (test: a restore changes nothing in it). */
  dump(): string {
    return M.canonical({ commits: this.commits, marks: this.marks, carrier: this.carrier, deliveries: this.deliveries, events: this.events })
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
 * P-Commit (draft 2 §5.2 no. 5, D6): (1) every ticket at the carrier has an earlier successful store commit of the same
 * device holding the same bytes and, in that batch, the consumption of both keys (`introduce`, MV-30); (2) every issuance
 * batch holds exactly two complete ticket intents bound to its act, one per named key (existence, not only "if, then").
 */
export function pCommit(b: Buch): Check {
  const v: string[] = []
  for (const t of b.carrier.tickets) {
    const ok = b.commits.some((c) => c.device === t.device && c.seq < t.seq && c.intents.some((i) => i.frames.includes(t.frame)) && c.ops.some((op) => op.kind === 'introduce' && op.act.id === t.act && (op.act.a.key === t.named || op.act.b.key === t.named)))
    if (!ok) v.push(`ticket ${t.act.slice(0, 8)} → ${t.named.slice(-8)} at the carrier (seq ${t.seq}) without an earlier commit of ${t.device} holding its bytes and both consumptions`)
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
      if (tickets.length !== 2 || M.canonical(named) !== M.canonical(want) || !complete) v.push(`issuance ${op.act.id.slice(0, 8)} (${c.writer}#${c.n}): ${tickets.length} ticket intents in the batch, named ${named.map((x) => x.slice(-8)).join(', ') || 'none'} (want both of ${want.map((x) => x.slice(-8)).join(', ')})`)
    }
  }
  return check('P-Commit', v, { tickets: b.carrier.tickets.length, issuances })
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
 * the device is up. An introduction that crashed before its commit is no issuance (a valid run). A refusal while the
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
    const named = new Set(b.carrier.tickets.filter((t) => t.act === act && t.device === e.device && t.seq < deadline).map((t) => t.named))
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
 * behind its peer anchor) and open union duties per person (last committed state of each duty not `united`).
 */
export function pairCounter(b: Buch): { tuples: Record<string, number>; openDuties: Record<string, number> } {
  const ownAnchor = new Map<string, string>() // anchor → person (from that person's own commits)
  const tuples = new Map<string, Map<string, string>>() // person → tuple id → peer anchor
  const duties = new Map<string, Map<string, string>>()
  for (const c of b.commits)
    for (const op of c.ops) {
      const tuple = op.kind === 'open-tuple' || op.kind === 'connect' ? op.tuple : null
      if (tuple) {
        ownAnchor.set(tuple.own, c.person)
        if (!tuples.has(c.person)) tuples.set(c.person, new Map())
        tuples.get(c.person)!.set(tuple.id, tuple.peer)
      }
      if (op.kind === 'produce') ownAnchor.set(op.card.anchor, c.person)
      if (op.kind === 'duty') {
        if (!duties.has(c.person)) duties.set(c.person, new Map())
        duties.get(c.person)!.set(op.pair.join('+'), op.state)
      }
    }
  const out: Record<string, number> = {}
  for (const [person, ts] of tuples)
    for (const peer of ts.values()) {
      const key = `${person}→${ownAnchor.get(peer) ?? '?'}`
      out[key] = (out[key] ?? 0) + 1
    }
  const open: Record<string, number> = {}
  for (const [person, ds] of duties) open[person] = [...ds.values()].filter((s) => s !== 'united').length
  return { tuples: out, openDuties: open }
}
