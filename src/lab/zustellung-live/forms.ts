// The forms of the E11b live probe (draft 3 §4.1). Direct forms: one TSP
// layer sender → receiver connection DID. Routed forms: inner layer sender →
// receiver connection DID, outer layer (`packRouted`, route = [receiver]) to
// the mediator's routing target (review 3 C2: the variant tuple).

import { pack, packRouted, type PackedMessage } from '@openvtc/vti-tsp-js'
import type { Side, WireIdentity } from './identities'
import type { RoutingVariant } from './mediator'

export const FORM_IDS = ['D-c', 'D-es', 'D-e', 'R-cc', 'R-c', "R-c'", 'R-es', 'R-ce'] as const
export type FormId = (typeof FORM_IDS)[number]

export interface FormSpec {
  id: FormId
  routed: boolean
  inner: 'conn' | 'egress'
  outer: 'conn' | 'egress' | null
  socket: 'conn' | 'egress'
  /** Sessions a relationship needs on the sending side (receiving side: one). */
  senderSessions: 1 | 2
  /** R-c' routes to the TSPTransport target instead of the default variant. */
  prime: boolean
}

export const FORMS: Record<FormId, FormSpec> = {
  'D-c': { id: 'D-c', routed: false, inner: 'conn', outer: null, socket: 'conn', senderSessions: 1, prime: false },
  'D-es': { id: 'D-es', routed: false, inner: 'egress', outer: null, socket: 'egress', senderSessions: 2, prime: false },
  'D-e': { id: 'D-e', routed: false, inner: 'egress', outer: null, socket: 'conn', senderSessions: 1, prime: false },
  'R-cc': { id: 'R-cc', routed: true, inner: 'conn', outer: 'conn', socket: 'conn', senderSessions: 1, prime: false },
  'R-c': { id: 'R-c', routed: true, inner: 'egress', outer: 'conn', socket: 'conn', senderSessions: 1, prime: false },
  "R-c'": { id: "R-c'", routed: true, inner: 'egress', outer: 'conn', socket: 'conn', senderSessions: 1, prime: true },
  'R-es': { id: 'R-es', routed: true, inner: 'egress', outer: 'egress', socket: 'egress', senderSessions: 2, prime: false },
  'R-ce': { id: 'R-ce', routed: true, inner: 'egress', outer: 'egress', socket: 'conn', senderSessions: 1, prime: false },
}

/** Forms with delete-to-ack observation (draft 3 §4.3). */
export const DELETE_TO_ACK_FORMS: readonly FormId[] = ['D-c', 'R-c', 'R-es']
/** Forms repeated in stage 1 (draft 3 §4.2). */
export const STAGE1_FORMS: readonly FormId[] = ['R-c', 'R-cc']
/** Expected transport outcome of the controls, from the binding measurement of 17 October. */
export const BASELINE: Partial<Record<FormId, 'carries' | 'not-shown'>> = { 'D-es': 'carries', 'D-c': 'carries', 'D-e': 'not-shown' }

export const id = (s: Side, which: 'conn' | 'egress'): WireIdentity => (which === 'conn' ? s.conn : s.egress)

export interface Packed {
  inner: PackedMessage
  outer: PackedMessage | null
  wire: Uint8Array
}

export async function packForm(spec: FormSpec, variant: RoutingVariant, sender: Side, receiver: Side, payload: Uint8Array): Promise<Packed> {
  const innerSender = id(sender, spec.inner)
  const inner = await pack(payload, innerSender.did, receiver.conn.did, { senderSigningKey: innerSender.edSecret, receiverEncryptionKey: receiver.conn.xPublic })
  if (!spec.routed || !spec.outer) return { inner, outer: null, wire: inner.bytes }
  const outerSender = id(sender, spec.outer)
  const outer = await packRouted(inner.bytes, [receiver.conn.did], outerSender.did, variant.firstHopVid, { senderSigningKey: outerSender.edSecret, receiverEncryptionKey: variant.x25519 })
  return { inner, outer, wire: outer.bytes }
}

/** Identity roles per relationship side (RT6, review 3 C5). */
export function roles(spec: FormSpec, s: Side) {
  const label = (w: 'conn' | 'egress') => `${s.label}.${w}`
  return {
    login: spec.socket === 'egress' ? [label('conn'), label('egress')] : [label('conn')],
    socket: label(spec.socket),
    outerSender: spec.outer ? label(spec.outer) : null,
    innerSender: label(spec.inner),
  }
}
