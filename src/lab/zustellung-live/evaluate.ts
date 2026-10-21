// Evaluation (draft 3 §4.4, §6; review 3 C1, H1): the sender state on the
// positive ack path, row predicates, aggregations and the probe outcome.
// Bounds are inclusive (`≤` is inside). The row uses the first successful
// receipt; all receipt events are kept separately.

import { diVerify, type Received } from '@real-life/trust-protocol'
import { ACK_TYPE } from '../zustellung'
import { CONTROL_CLASSES, DIRECT_CLASSES, type FrameClass, type Verdict } from './classifier'
import type { SendRecord } from './register'

// ── Sender state ─────────────────────────────────────────────────────────────

export const ACK_REASONS = ['ok', 'not-unique', 'wrong-type', 'proof-invalid', 'ref-unknown', 'thread-mismatch', 'no-ack'] as const
export type AckReason = (typeof ACK_REASONS)[number]

export interface AckCheck {
  /** Doc row the ack's `ref` names (undefined if it names none). */
  rowId?: string
  /** Cryptographic and content validity: type, proof under the partner's anchor, `ref`, `threadId`. */
  valid: boolean
  /** Within the ack deadline (doc receipt + timeout, inclusive). Only meaningful when valid. */
  inTime: boolean
  reason: AckReason
  /** Receipt: entry into the handler, before decryption, receive() and the proof check. */
  t: number
  /** End of verification (decryption, receive(), type, proof, ref, thread); set by the probe (review 1 C4). */
  tVerified?: number
}

interface Submission {
  rowId: string
  digest: string
  threadId: string
  state: 'accepted' | 'delivered'
  /** Start of the ack deadline: when the receiver got the document. */
  docReceivedAt?: number
}

/** One sender toward one partner. Only a signed, valid, timely ack closes `accepted → delivered`. */
export class SenderLedger {
  private readonly subs = new Map<string, Submission>()
  constructor(
    private readonly partnerAnchor: string,
    private readonly timeoutMs: number,
  ) {}
  submit(rowId: string, digest: string, threadId: string) {
    this.subs.set(digest, { rowId, digest, threadId, state: 'accepted' })
  }
  docReceived(digest: string, t: number) {
    const s = this.subs.get(digest)
    if (s && s.docReceivedAt === undefined) s.docReceivedAt = t
  }
  state(rowId: string): 'accepted' | 'delivered' | undefined {
    for (const s of this.subs.values()) if (s.rowId === rowId) return s.state
    return undefined
  }
  /** Check an ack built by `receive()`. Transitions only when valid and in time; `observeOnly` never transitions. */
  async checkAck(v: Received, t: number, observeOnly = false): Promise<AckCheck> {
    if (v.disposition !== 'unique' || !v.document) return { valid: false, inTime: false, reason: 'not-unique', t }
    const doc = v.document as { type?: unknown; threadId?: unknown; payload?: { ref?: unknown } }
    if (doc.type !== ACK_TYPE) return { valid: false, inTime: false, reason: 'wrong-type', t }
    if (!(await diVerify(doc, this.partnerAnchor))) return { valid: false, inTime: false, reason: 'proof-invalid', t }
    const ref = doc.payload?.ref
    const s = typeof ref === 'string' ? this.subs.get(ref) : undefined
    if (!s) return { valid: false, inTime: false, reason: 'ref-unknown', t }
    if (doc.threadId !== s.threadId) return { rowId: s.rowId, valid: false, inTime: false, reason: 'thread-mismatch', t }
    const inTime = s.docReceivedAt !== undefined && t - s.docReceivedAt <= this.timeoutMs
    if (inTime && !observeOnly) s.state = 'delivered'
    return { rowId: s.rowId, valid: true, inTime, reason: 'ok', t }
  }
}

// ── Rows ─────────────────────────────────────────────────────────────────────

export interface RecvEvent {
  recordId?: string
  socket: string
  size: number
  cls: FrameClass
  t: number
  verdict?: Verdict
  layer?: 'inner' | 'outer' | 'payload'
  hopsLength?: number
  fresh: boolean
}

export const PREDICATES = ['received', 'opened', 'type', 'payload-match', 'doc-verdict', 'ack-valid', 'ack-in-time'] as const
export type Predicate = (typeof PREDICATES)[number]
export type RowOutcome = 'positive' | 'late' | 'not-shown'

export interface RowResult {
  id: string
  form: string
  stage: 0 | 1
  rel: string
  dir: string
  run: number
  kind: 'probe' | 'doc'
  received: 'in-window' | 'late' | 'no'
  receivedSocket: string | null
  tRecvMs: number | null
  opened: boolean | null
  openClass: FrameClass | null
  type: 'direct' | FrameClass | null
  payloadMatch: boolean | null
  docVerdict: Verdict | null
  ackValid: boolean | null
  ackInTime: boolean | null
  ackReason: AckReason | null
  /** Document send → ack received at the sender (handler entry). */
  tAckReceivedMs: number | null
  /** Document send → ack verified at the sender (review 1 C4). */
  tAckVerifiedMs: number | null
  innerBytesEqual: boolean
  outerBytesEqual: boolean
  hopsLength: number | null
  observedMs: number
  firstFailed: Predicate | null
  outcome: RowOutcome
  events: number
}

const UNOPENED: ReadonlySet<FrameClass> = new Set(['unopenable/undecodable', 'unopenable/unlisted', 'unopenable/unpack-failed', 'wrong-revision', 'mismatch'])

function successful(e: RecvEvent, kind: 'probe' | 'doc'): boolean {
  return kind === 'probe' ? e.cls === 'probe' : e.cls === 'doc' && e.verdict === 'unique'
}

/**
 * Row predicates in order of precedence. The pick is the first successful receipt
 * (a later duplicate never replaces an earlier `unique`), else the first event.
 * Events from the fresh delete-to-ack session never count (`first-in-fresh` does not change the row),
 * nor does any receipt or ack after `closedAt`.
 */
export function evaluateRow(record: SendRecord, allEvents: RecvEvent[], ack: AckCheck | undefined, opts: { timeoutMs: number; closedAt: number }): RowResult {
  if (record.kind === 'ack') throw new Error('e11b: ack records have no row')
  const kind = record.kind
  // Only receipts up to the end of observation count (review 1 C1); `closedAt` itself is inside.
  const events = allEvents.filter((e) => e.recordId === record.id && !e.fresh && e.t <= opts.closedAt).sort((a, b) => a.t - b.t)
  if (ack && ack.t > opts.closedAt) ack = undefined
  const pick = events.find((e) => successful(e, kind)) ?? events[0]
  const base: RowResult = {
    id: record.id,
    form: record.form,
    stage: record.stage,
    rel: record.rel,
    dir: record.dir,
    run: record.run,
    kind,
    received: 'no',
    receivedSocket: null,
    tRecvMs: null,
    opened: null,
    openClass: null,
    type: null,
    payloadMatch: null,
    docVerdict: null,
    ackValid: null,
    ackInTime: null,
    ackReason: null,
    tAckReceivedMs: null,
    tAckVerifiedMs: null,
    innerBytesEqual: events.some((e) => e.layer === 'inner'),
    outerBytesEqual: events.some((e) => e.layer === 'outer'),
    hopsLength: events.find((e) => e.hopsLength !== undefined)?.hopsLength ?? null,
    observedMs: Math.max(0, opts.closedAt - record.tSend),
    firstFailed: 'received',
    outcome: 'not-shown',
    events: events.length,
  }
  if (!pick) return base
  const dt = pick.t - record.tSend
  base.received = dt <= opts.timeoutMs ? 'in-window' : 'late'
  base.receivedSocket = pick.socket
  base.tRecvMs = dt
  base.opened = !UNOPENED.has(pick.cls)
  base.openClass = pick.cls
  if (!base.opened) return { ...base, firstFailed: 'opened' }
  const isDirect = DIRECT_CLASSES.has(pick.cls)
  base.type = isDirect ? 'direct' : pick.cls
  if (!isDirect) return { ...base, firstFailed: 'type' }
  if (kind === 'probe') {
    base.payloadMatch = pick.cls === 'probe'
    if (!base.payloadMatch) return { ...base, firstFailed: 'payload-match' }
    return { ...base, firstFailed: null, outcome: base.received === 'in-window' ? 'positive' : 'late' }
  }
  base.docVerdict = pick.verdict ?? 'other'
  if (!(pick.cls === 'doc' && pick.verdict === 'unique')) return { ...base, firstFailed: 'doc-verdict' }
  base.ackValid = ack?.valid ?? false
  base.ackInTime = ack?.valid ? ack.inTime : false
  base.ackReason = ack ? ack.reason : 'no-ack'
  base.tAckReceivedMs = ack ? ack.t - record.tSend : null
  base.tAckVerifiedMs = ack?.tVerified !== undefined ? ack.tVerified - record.tSend : null
  if (!base.ackValid) return { ...base, firstFailed: 'ack-valid' }
  if (base.received === 'in-window' && base.ackInTime) return { ...base, firstFailed: null, outcome: 'positive' }
  return { ...base, firstFailed: null, outcome: 'late' }
}

// ── Aggregation ──────────────────────────────────────────────────────────────

export type AggOutcome = 'carries' | 'partial' | 'not-shown'

export interface Aggregation {
  outcome: AggOutcome
  rows: number
  positive: number
  late: number
  notShown: number
  breakdown: Array<{ rel: string; dir: string; run: number; outcome: RowOutcome }>
}

/** carries: all rows positive (never for an empty set); partial: at least one positive or late; else not shown. */
export function aggregate(rows: RowResult[]): Aggregation {
  const positive = rows.filter((r) => r.outcome === 'positive').length
  const late = rows.filter((r) => r.outcome === 'late').length
  const notShown = rows.length - positive - late
  const outcome: AggOutcome = rows.length > 0 && positive === rows.length ? 'carries' : positive + late > 0 ? 'partial' : 'not-shown'
  return { outcome, rows: rows.length, positive, late, notShown, breakdown: rows.map((r) => ({ rel: r.rel, dir: r.dir, run: r.run, outcome: r.outcome })) }
}

export interface TableRow {
  form: string
  stage: 0 | 1
  transport: Aggregation
  contract: Aggregation
}

export function resultTable(rows: RowResult[], cells: Array<{ form: string; stage: 0 | 1 }>): TableRow[] {
  return cells.map(({ form, stage }) => {
    const mine = rows.filter((r) => r.form === form && r.stage === stage)
    return { form, stage, transport: aggregate(mine.filter((r) => r.kind === 'probe')), contract: aggregate(mine.filter((r) => r.kind === 'doc')) }
  })
}

// ── Probe outcome ────────────────────────────────────────────────────────────

export const OUTCOMES = ['precondition-failed', 'incomplete', 'threshold-reached', 'stage1-only', 'threshold-not-reached'] as const
export type ProbeOutcome = (typeof OUTCOMES)[number]

export const MANDATORY_FORMS = ['D-es', 'D-c', 'D-e', 'R-cc'] as const
export const THRESHOLD_FORMS = ['R-c', "R-c'", 'R-es'] as const

export interface OutcomeInput {
  preconditionFailed: boolean
  forms: readonly string[]
  table: TableRow[]
}

/** Exactly one outcome: the first branch in the fixed order that applies; the last is the remainder (review 3 C1). */
export function probeOutcome(i: OutcomeInput): ProbeOutcome {
  if (i.preconditionFailed) return 'precondition-failed'
  if (MANDATORY_FORMS.some((f) => !i.forms.includes(f))) return 'incomplete'
  const reached = (stage: 0 | 1) => i.table.some((r) => r.stage === stage && (THRESHOLD_FORMS as readonly string[]).includes(r.form) && r.transport.outcome === 'carries' && r.contract.outcome === 'carries')
  if (reached(0)) return 'threshold-reached'
  if (reached(1)) return 'stage1-only'
  return 'threshold-not-reached'
}

/** Stage 1 trigger (draft 3 §4.2, H1): no routed form carries in the stage-0 transport aggregation. */
export function stage1Needed(table: TableRow[]): boolean {
  return !table.some((r) => r.stage === 0 && r.form.startsWith('R-') && r.transport.outcome === 'carries')
}

export function isControl(c: FrameClass) {
  return CONTROL_CLASSES.has(c)
}
