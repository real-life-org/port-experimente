// Classifier for every incoming TSP frame (draft 3 §5, review 2 B1, review 3
// C3/C5). Parser rule (#95, MV-24): only what the library parsers built is
// processed; the message type is checked after `unpack`; a frame falls into
// exactly one class of a fixed list; control frames never reach `receive()`.

import { decodeEnvelope, unpack, type UnpackedMessage } from '@openvtc/vti-tsp-js'
import { receive, type Received } from '@real-life/trust-protocol'
import { ACK_TYPE, DOC_TYPE } from '../zustellung'
import type { Layer, SendRegistry, XrfiRegistry } from './register'
import { dec, sha256hex } from './util'

export const FRAME_CLASSES = [
  'unopenable/undecodable',
  'unopenable/unlisted',
  'unopenable/unpack-failed',
  'wrong-revision',
  'mismatch',
  'wrong-type/direct',
  'wrong-type/control',
  'wrong-type/routed',
  'wrong-type/nested',
  'wrong-type/padding',
  'wrong-type/other',
  'empty-direct',
  'probe',
  'payload-not-json',
  'doc',
  'ack',
  'doc-unknown',
  'control/invite',
  'control/accept',
  'control/cancel',
  'control-opaque',
] as const
export type FrameClass = (typeof FRAME_CLASSES)[number]

/** Classes of an opened `direct` frame. */
export const DIRECT_CLASSES: ReadonlySet<FrameClass> = new Set(['empty-direct', 'probe', 'payload-not-json', 'doc', 'ack', 'doc-unknown'])
export const CONTROL_CLASSES: ReadonlySet<FrameClass> = new Set(['control/invite', 'control/accept', 'control/cancel', 'control-opaque'])

export const VERDICTS = ['unique', 'duplicate-known', 'failed(oversize)', 'failed(malformed)', 'failed(decryption-failed)', 'proof-invalid', 'other'] as const
export type Verdict = (typeof VERDICTS)[number]

export type Allowed = 'direct' | 'control'

/** One positive-list entry: a (sender VID, own receiver DID) pair, its signing key(s), the own X25519 and the allowed types. */
export interface ListEntry {
  sender: string
  receiver: string
  signing: Array<{ ref: string; pub: Uint8Array }>
  receiverSecret: Uint8Array
  allowed: ReadonlySet<Allowed>
}

export class PositiveList {
  private readonly map = new Map<string, ListEntry>()
  constructor(entries: ListEntry[]) {
    for (const e of entries) {
      const k = `${e.sender}\u0000${e.receiver}`
      if (this.map.has(k)) throw new Error('e11b: positive list pair not unique')
      this.map.set(k, e)
    }
  }
  find(sender: string, receiver: string) {
    return this.map.get(`${sender}\u0000${receiver}`)
  }
}

export interface ClassifyContext {
  list: PositiveList
  registry: SendRegistry
  xrfi: XrfiRegistry
  socket: string
  /** Receiver's rkid resolver and completed-effect set, for `receive()` (read only here). */
  resolve: Parameters<typeof receive>[1]
  completed: Set<string>
}

export interface Classified {
  cls: FrameClass
  size: number
  frameDigest: string
  /** Register match: by frame digest (inner/outer layer) or by payload digest after opening. */
  recordId?: string
  layer?: Layer | 'payload'
  innerBytesEqual: boolean
  outerBytesEqual: boolean
  sender?: string
  signatureMethod?: string
  hopsLength?: number
  payloadDigest?: string
  verdict?: Verdict
  /** In-memory only: the `receive()` result for doc/ack/doc-unknown. Never serialized. */
  received?: Received
  controlType?: 'invite' | 'accept' | 'cancel' | 'control-opaque'
  correlation?: 'own-xrfi' | 'unknown' | 'none'
}

function wrongType(t: string): FrameClass {
  switch (t) {
    case 'direct':
    case 'control':
    case 'routed':
    case 'nested':
    case 'padding':
      return `wrong-type/${t}`
    default:
      return 'wrong-type/other'
  }
}

function verdictOf(d: string): Verdict {
  return (VERDICTS as readonly string[]).includes(d) ? (d as Verdict) : 'other'
}

export async function classifyFrame(frame: Uint8Array, ctx: ClassifyContext): Promise<Classified> {
  const frameDigest = sha256hex(frame)
  const out: Classified = { cls: 'unopenable/undecodable', size: frame.length, frameDigest, innerBytesEqual: false, outerBytesEqual: false }
  // 1. register match by frame digest
  const hit = ctx.registry.frame(frameDigest)
  if (hit) {
    out.recordId = hit.record.id
    out.layer = hit.layer
    if (hit.layer === 'inner') out.innerBytesEqual = true
    else out.outerBytesEqual = true
  }
  // 2. envelope
  let sender: string
  let receiver: string
  try {
    const e = decodeEnvelope(frame)
    sender = e.envelope.sender
    receiver = e.envelope.receiver
  } catch {
    return out
  }
  // 3. positive list
  const entry = ctx.list.find(sender, receiver)
  if (!entry) {
    out.cls = 'unopenable/unlisted'
    return out
  }
  // 4. unpack with the entry's keys, candidates in order
  let m: UnpackedMessage | undefined
  for (const k of entry.signing) {
    try {
      m = await unpack(frame, { receiverDecryptionKey: entry.receiverSecret, senderSigningKey: k.pub })
      out.signatureMethod = k.ref
      break
    } catch {
      /* next candidate */
    }
  }
  if (!m) {
    out.cls = 'unopenable/unpack-failed'
    return out
  }
  out.sender = m.sender
  // 5. revision and pair
  if (m.revision !== 'rev3') {
    out.cls = 'wrong-revision'
    return out
  }
  if (m.sender !== entry.sender || m.receiver !== entry.receiver) {
    out.cls = 'mismatch'
    return out
  }
  // 6. type allowed?
  const t = m.messageType as string
  if (!(entry.allowed as ReadonlySet<string>).has(t)) {
    out.cls = wrongType(t)
    if (t === 'routed') out.hopsLength = m.hops.length
    return out
  }
  // 8. control: never to receive()
  if (t === 'control') {
    if (!m.control) {
      out.cls = 'control-opaque'
      out.controlType = 'control-opaque'
      out.correlation = 'none'
      return out
    }
    const ct = m.control.controlType
    out.controlType = ct
    out.cls = `control/${ct}`
    out.correlation = ctx.xrfi.correlate(ctx.socket, m.control.inReplyTo)
    return out
  }
  // 7. direct
  const payload = new Uint8Array(m.payload)
  if (payload.length === 0) {
    out.cls = 'empty-direct'
    return out
  }
  out.payloadDigest = sha256hex(payload)
  const byPayload = ctx.registry.payload(out.payloadDigest)
  if (byPayload && !out.recordId) {
    out.recordId = byPayload.id
    out.layer = 'payload'
  }
  if (byPayload?.kind === 'probe') {
    out.cls = 'probe'
    return out
  }
  let env: unknown
  try {
    env = JSON.parse(dec.decode(payload))
  } catch {
    out.cls = 'payload-not-json'
    return out
  }
  const v = await receive(env, ctx.resolve, ctx.completed)
  out.received = v
  out.verdict = verdictOf(v.disposition)
  const type = (v.document as { type?: unknown } | undefined)?.type
  out.cls = type === DOC_TYPE ? 'doc' : type === ACK_TYPE ? 'ack' : 'doc-unknown'
  return out
}
