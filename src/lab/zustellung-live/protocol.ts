// Protocol writer (draft 3 §8–§10, review 3 C5/C6). Every value leaves only
// through a schema: unknown keys are dropped, every leaf is checked against its
// kind (number, boolean, 8-hex prefix, local label, shortened DID, host,
// version label, fragment, enum with `other`). Env values are released one by
// one; the output path is never exported.

import { FRAME_CLASSES, VERDICTS } from './classifier'
import { ERROR_CLASSES, STAGES } from './errors'
import { ACK_REASONS, OUTCOMES, PREDICATES } from './evaluate'
import { FORM_IDS, type FormId } from './forms'
import { METHOD_TYPES, PRIME_NOTES, SERVICE_TYPES } from './mediator'
import { DIDCOMM_TYPES, FRAME_ERROR_STAGES, PROBLEM_CODES } from './session'

// ── Schema ───────────────────────────────────────────────────────────────────

export type Schema =
  | { k: 'int' }
  | { k: 'bool' }
  | { k: 'hex8' }
  | { k: 'label' }
  | { k: 'did' }
  | { k: 'host' }
  | { k: 'version' }
  | { k: 'frag' }
  | { k: 'iso' }
  | { k: 'enum'; values: readonly string[] }
  | { k: 'nullable'; of: Schema }
  | { k: 'array'; of: Schema }
  | { k: 'object'; fields: Record<string, Schema> }
  | { k: 'record'; keys: readonly string[]; of: Schema }

const LABEL = /^[A-Za-z0-9][A-Za-z0-9.'/:-]{0,79}$/
const HEX8 = /^[0-9a-f]{8}$/
const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]{1,512}$/
const HOST = /^[a-z0-9.-]{1,253}$|^did-url$|^invalid$/
const VERSION = /^\d{1,6}-[1-9A-HJ-NP-Za-km-z]{8}$|^invalid$/
const FRAG = /^(key-\d{1,3}|keys-\d{1,3}|service|tsp|auth|files|whois|[ms]\d{1,3}|peer)$/
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/

/** Shortened DID: first 16, last 6 characters. */
export function shortDid(d: string): string {
  return d.length <= 24 ? d : `${d.slice(0, 16)}…${d.slice(-6)}`
}

export function serialize(s: Schema, v: unknown): unknown {
  switch (s.k) {
    case 'int':
      return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null
    case 'bool':
      return typeof v === 'boolean' ? v : null
    case 'hex8':
      return typeof v === 'string' && HEX8.test(v) ? v : 'invalid'
    case 'label':
      return typeof v === 'string' && LABEL.test(v) ? v : 'invalid'
    case 'did':
      return typeof v === 'string' && DID.test(v) ? shortDid(v) : 'invalid'
    case 'host':
      return typeof v === 'string' && HOST.test(v) ? v : 'invalid'
    case 'version':
      return typeof v === 'string' && VERSION.test(v) ? v : 'invalid'
    case 'frag':
      return typeof v === 'string' && FRAG.test(v) ? v : 'invalid'
    case 'iso':
      return typeof v === 'string' && ISO.test(v) ? v : 'invalid'
    case 'enum':
      return typeof v === 'string' && s.values.includes(v) ? v : 'other'
    case 'nullable':
      return v === null || v === undefined ? null : serialize(s.of, v)
    case 'array':
      return Array.isArray(v) ? v.map((x) => serialize(s.of, x)) : []
    case 'object': {
      const out: Record<string, unknown> = {}
      const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
      for (const [key, fs] of Object.entries(s.fields)) out[key] = serialize(fs, o[key])
      return out
    }
    case 'record': {
      const out: Record<string, unknown> = {}
      const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
      for (const key of s.keys) if (Object.hasOwn(o, key)) out[key] = serialize(s.of, o[key])
      return out
    }
  }
}

const int: Schema = { k: 'int' }
const bool: Schema = { k: 'bool' }
const hex8: Schema = { k: 'hex8' }
const label: Schema = { k: 'label' }
const did: Schema = { k: 'did' }
const host: Schema = { k: 'host' }
const version: Schema = { k: 'version' }
const frag: Schema = { k: 'frag' }
const e = (values: readonly string[]): Schema => ({ k: 'enum', values })
const n = (of: Schema): Schema => ({ k: 'nullable', of })
const arr = (of: Schema): Schema => ({ k: 'array', of })
const obj = (fields: Record<string, Schema>): Schema => ({ k: 'object', fields })
const rec = (keys: readonly string[], of: Schema): Schema => ({ k: 'record', keys, of })

const FORM = e(FORM_IDS)
const REL = e(['AB', 'AC'])
const DIR = e(['x2y', 'y2x'])
const CLASS = e(FRAME_CLASSES)
const ROW_OUTCOME = e(['positive', 'late', 'not-shown'])
const AGG = obj({ outcome: e(['carries', 'partial', 'not-shown']), rows: int, positive: int, late: int, notShown: int, breakdown: arr(obj({ rel: REL, dir: DIR, run: int, outcome: ROW_OUTCOME })) })
const DIRBYTES = obj({ socket: int, tspSocket: int, tspLogical: int, rest: int })
const COUNTERS = obj({
  scope: label,
  logins: obj({ attempted: int, ok: int, failed: int }),
  sockets: obj({ opened: int, maxConcurrent: int }),
  bytes: obj({ out: DIRBYTES, in: DIRBYTES }),
  frameErrors: rec(FRAME_ERROR_STAGES, obj({ acked: int, notAcked: int })),
  didcomm: rec(DIDCOMM_TYPES, int),
  problemCodes: rec(PROBLEM_CODES, int),
  consumerFailures: int,
})
const VARIANT = obj({ firstHopVid: did, methodRef: frag, x25519Fingerprint: hex8, sourceDocVersion: version })
const LAYERS = obj({ payload: int, inner: int, outer: n(int), wire: int })

export const ROW_SCHEMA = obj({
  id: label,
  form: FORM,
  stage: int,
  rel: REL,
  dir: DIR,
  run: int,
  kind: e(['probe', 'doc']),
  digests: obj({ payload: hex8, inner: hex8, outer: n(hex8) }),
  bytes: obj({ payload: int, inner: int, outer: n(int), wire: int, received: n(int) }),
  received: e(['in-window', 'late', 'no']),
  receivedSocket: n(label),
  tRecvMs: n(int),
  opened: n(bool),
  openClass: n(CLASS),
  type: n(e(['direct', ...FRAME_CLASSES])),
  payloadMatch: n(bool),
  docVerdict: n(e(VERDICTS)),
  ackValid: n(bool),
  ackInTime: n(bool),
  ackReason: n(e(ACK_REASONS)),
  tAckMs: n(int),
  innerBytesEqual: bool,
  outerBytesEqual: bool,
  hopsLength: n(int),
  observedMs: int,
  firstFailed: n(e(PREDICATES)),
  outcome: ROW_OUTCOME,
  events: int,
})

export const NOTE_KINDS = ['key-binding-unclear', 'form-aborted', 'form-skipped', 'baseline-deviation', 'stage1-run', 'stage1-not-needed', 'consumer-failure', 'prime-not-measured'] as const

export const PROTOCOL_SCHEMA = obj({
  schema: e(['e11b-live/1']),
  head: obj({
    date: { k: 'iso' },
    mediatorDid: did,
    versionId: version,
    wsHost: host,
    services: arr(obj({ ref: frag, type: e(SERVICE_TYPES), hosts: arr(host) })),
    methods: arr(obj({ ref: frag, type: e(METHOD_TYPES), keyKind: e(['ed25519', 'x25519', 'other']), fingerprint: hex8, keyAgreement: bool, authentication: bool, assertionMethod: bool })),
    routing: obj({ default: n(VARIANT), prime: n(VARIANT), primeNote: e(PRIME_NOTES) }),
    versions: obj({ tsp: label, didcomm: label, trustProtocol: label, node: label }),
    env: obj({ liveMediator: bool, mediatorDidSet: bool, allowInsecure: bool, wireDebug: bool, forms: arr(FORM), runs: int, timeoutMs: int, protocolOutSet: bool }),
    observeMs: int,
    keyBinding: e(['confirmed', 'unclear', 'not-applicable']),
  }),
  groups: arr(
    obj({
      id: label,
      form: FORM,
      stage: int,
      identities: arr(obj({ label, did })),
      roles: arr(obj({ side: label, login: arr(label), socket: label, outerSender: n(label), innerSender: label })),
      equalities: obj({ innerIsSocket: bool, outerIsSocket: n(bool), innerIsConnection: bool }),
      linkableAcrossRelationships: bool,
      peerSees: arr(obj({ side: label, dids: arr(label), includesConnection: bool })),
      sessionsPerRelationship: obj({ sender: int, receiver: int }),
    }),
  ),
  rows: arr(ROW_SCHEMA),
  acks: arr(obj({ id: label, docRow: label, form: FORM, stage: int, digests: obj({ payload: hex8, inner: hex8, outer: n(hex8) }), bytes: LAYERS, tSendMs: int, received: bool, receivedClass: n(CLASS), tRecvMs: n(int), check: n(e(ACK_REASONS)), inTime: n(bool) })),
  controls: arr(obj({ group: label, socket: label, controlType: e(['invite', 'accept', 'cancel', 'control-opaque', 'other']), correlation: e(['own-xrfi', 'unknown', 'none']), signatureMethod: n(frag), tMs: int })),
  xrfi: arr(obj({ group: label, socket: label, threadDigest: hex8, tSendMs: int })),
  events: obj({
    unassigned: arr(obj({ group: label, socket: label, size: int, cls: CLASS, tMs: int })),
    fresh: arr(obj({ group: label, socket: label, recordId: n(label), cls: CLASS, kind: e(['redelivered', 'first-in-fresh', 'unassigned']), tMs: int })),
  }),
  counters: obj({ classes: rec(FRAME_CLASSES, int), perScope: arr(COUNTERS), total: COUNTERS }),
  costs: arr(
    obj({
      form: FORM,
      stage: int,
      sizes: obj({ probe: n(LAYERS), doc: n(LAYERS), ack: n(LAYERS) }),
      oneWayMs: obj({ median: n(int), max: n(int), n: int }),
      roundTripMs: obj({ median: n(int), max: n(int), n: int }),
    }),
  ),
  result: obj({
    table: arr(obj({ form: FORM, stage: int, transport: AGG, contract: AGG })),
    outcome: e(OUTCOMES),
    error: n(obj({ stage: e(STAGES), cls: e(ERROR_CLASSES) })),
    notes: arr(obj({ kind: e(NOTE_KINDS), form: n(FORM), cls: n(e([...ERROR_CLASSES, ...PRIME_NOTES])) })),
    baseline: arr(obj({ form: FORM, expected: e(['carries', 'not-shown']), observed: e(['carries', 'partial', 'not-shown']) })),
    valid: bool,
  }),
})

/** The protocol as JSON text: only through the schema. */
export function protocolJson(p: unknown): string {
  return JSON.stringify(serialize(PROTOCOL_SCHEMA, p), null, 1) + '\n'
}

/** One debug line for stderr (`RLTP_WIRE_DEBUG`), through the same schema rules. */
export function debugLine(kind: 'row' | 'error', v: unknown): string {
  if (kind === 'row') return `[e11b] row ${JSON.stringify(serialize(ROW_SCHEMA, v))}`
  return `[e11b] error ${JSON.stringify(serialize(obj({ stage: e(STAGES), cls: e(ERROR_CLASSES) }), v))}`
}

// ── Env (draft 3 §10, review 3 C6): each value released on its own ───────────

export const DEFAULT_MEDIATOR_DID = 'did:webvh:QmR5xGk8pkd3ymu7xpfkjr7XZmwDALA5ZJmgG7qcrD2mKA:webvh.storm.ws:mediator'
export const OBSERVE_MS = 30000

export interface LiveConfig {
  live: boolean
  mediatorDid: string
  mediatorDidSet: boolean
  allowInsecure: boolean
  debug: boolean
  forms: FormId[]
  runs: number
  timeoutMs: number
  /** Kept local; only `protocolOutSet` is exported. */
  protocolOut: string | null
}

function posInt(raw: string | undefined, dflt: number, name: string): number {
  if (raw === undefined || raw === '') return dflt
  if (!/^\d{1,9}$/.test(raw)) throw new Error(`e11b config: ${name} must be a positive integer`)
  const v = Number(raw)
  if (v < 1) throw new Error(`e11b config: ${name} must be at least 1`)
  return v
}

/** Parse and validate the env. Errors name the variable, never its value. */
export function parseEnv(env: Record<string, string | undefined>): LiveConfig {
  const didRaw = env.MEDIATOR_DID
  if (didRaw !== undefined && didRaw !== '' && !DID.test(didRaw)) throw new Error('e11b config: MEDIATOR_DID is not a DID')
  let forms: FormId[] = [...FORM_IDS]
  if (env.E11B_FORMS !== undefined && env.E11B_FORMS !== '') {
    const list = env.E11B_FORMS.split(',').map((s) => s.trim())
    for (const f of list) if (!(FORM_IDS as readonly string[]).includes(f)) throw new Error('e11b config: E11B_FORMS names an unknown form')
    forms = FORM_IDS.filter((f) => list.includes(f))
  }
  return {
    live: env.RLTP_LIVE_MEDIATOR === '1',
    mediatorDid: didRaw || DEFAULT_MEDIATOR_DID,
    mediatorDidSet: Boolean(didRaw),
    allowInsecure: Boolean(env.MEDIATOR_ALLOW_INSECURE),
    debug: Boolean(env.RLTP_WIRE_DEBUG),
    forms,
    runs: posInt(env.E11B_RUNS, 3, 'E11B_RUNS'),
    timeoutMs: posInt(env.E11B_TIMEOUT_MS, 20000, 'E11B_TIMEOUT_MS'),
    protocolOut: env.E11B_PROTOCOL_OUT || null,
  }
}

export function envSummary(c: LiveConfig) {
  return { liveMediator: c.live, mediatorDidSet: c.mediatorDidSet, allowInsecure: c.allowInsecure, wireDebug: c.debug, forms: c.forms, runs: c.runs, timeoutMs: c.timeoutMs, protocolOutSet: c.protocolOut !== null }
}
