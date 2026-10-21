// Identities of the E11b live probe (draft 3 §3.2). The wire identities are
// derived like `trust-protocol` `binding/vti-wire.mjs` (the lib's HKDF with the
// connection/egress prefixes, raw seeds for TSP) and gated against
// `carrierScopedIdentity` of the lib: a mismatch aborts. Everything stays in
// memory; nothing here is ever serialized except the public DIDs (shortened).

import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { didKey, multibase } from '@openvtc/vti-didcomm-js'
import { CONNECTION_INFO_PREFIX, EGRESS_INFO_PREFIX, anchorOfEd, carrierScopedIdentity, digestBytes, edFromSeed, hkdf, mkOfX, xFromSeed } from '@real-life/trust-protocol'
import type { Party } from '../zustellung'
import { E11bError } from './errors'
import { enc, type Rand } from './util'

export type Scope = 'connection' | 'egress'

export interface WireIdentity {
  did: string
  kid: string
  scope: Scope
  edSecret: Uint8Array
  edPublic: Uint8Array
  xSecret: Uint8Array
  xPublic: Uint8Array
}

function agreementKid(did: string): string {
  const doc = didKey.resolve(did).didDocument as { keyAgreement?: Array<string | { id: string }> }
  const ka = doc.keyAgreement?.[0]
  if (ka === undefined) throw new E11bError('gate', 'other')
  return typeof ka === 'string' ? ka : ka.id
}

/** The same derivation as the lib (prefix + digest of the carrier + digest of the nonce), yielding raw keys. */
export async function deriveWireIdentity(rootIkm: Uint8Array, carrier: string, nonce: Uint8Array, scope: Scope): Promise<WireIdentity> {
  const prefix = scope === 'connection' ? CONNECTION_INFO_PREFIX : EGRESS_INFO_PREFIX
  const info = prefix + (await digestBytes(enc.encode(carrier))) + (await digestBytes(nonce))
  const edSecret = await hkdf(rootIkm, info)
  const edPublic = ed25519.getPublicKey(edSecret)
  const xSecret = ed25519.utils.toMontgomerySecret(edSecret)
  const xPublic = x25519.getPublicKey(xSecret)
  const did = `did:key:${multibase.encodeMultikey(multibase.MULTICODEC.ED25519_PUB, edPublic)}`
  return { did, kid: agreementKid(did), scope, edSecret, edPublic, xSecret, xPublic }
}

/** Derive and gate: the DID must equal the lib's `carrierScopedIdentity(...).did`, else abort. */
export async function gatedWireIdentity(rootIkm: Uint8Array, carrier: string, nonce: Uint8Array, scope: Scope): Promise<WireIdentity> {
  const w = await deriveWireIdentity(rootIkm, carrier, nonce, scope)
  const lib = await carrierScopedIdentity(rootIkm, carrier, nonce, scope)
  if (lib.did !== w.did) throw new E11bError('gate', 'other')
  return w
}

/** Public TSP keys of a did:key, resolved offline. */
export function didKeyKeys(did: string): { signPub: Uint8Array; encPub: Uint8Array } {
  const doc = didKey.resolve(did).didDocument as { keyAgreement?: Array<string | { id: string }>; verificationMethod?: Array<{ id: string; publicKeyMultibase: string }> }
  const kaRef = doc.keyAgreement?.[0]
  const kaId = typeof kaRef === 'string' ? kaRef : kaRef?.id
  const methods = doc.verificationMethod ?? []
  const agreement = methods.find((vm) => vm.id === kaId)
  const signing = methods.find((vm) => vm.id !== kaId)
  if (!agreement || !signing) throw new E11bError('gate', 'other')
  return { signPub: multibase.decodeMultikey(signing.publicKeyMultibase).key, encPub: multibase.decodeMultikey(agreement.publicKeyMultibase).key }
}

/** A principal: signing anchor (Ed25519, signs acks) and rkid (X25519, seal target). */
export async function makeParty(name: string, rand: Rand): Promise<Party> {
  const ed = await edFromSeed(rand(32))
  const x = await xFromSeed(rand(32))
  return { name, anchor: anchorOfEd(ed.pubRaw), ed, x, rkid: mkOfX(x.pubRaw), seed: new Uint8Array(0) }
}

export type RelId = 'AB' | 'AC'

/** One side of a relationship: its principal and the two carrier-scoped identities. */
export interface Side {
  /** Local label, e.g. `A.AB`. */
  label: string
  party: Party
  conn: WireIdentity
  egress: WireIdentity
}

export interface Rel {
  id: RelId
  x: Side
  y: Side
}

/** Fresh identities of one form pass (one form on one stage). */
export interface IdentityGroup {
  id: string
  rels: Rel[]
}

async function side(label: string, party: Party, carrier: string, rand: Rand): Promise<Side> {
  // Root and nonce of this relationship side: used for the derivation and dropped.
  const rootIkm = rand(32)
  const nonce = rand(32)
  return { label, party, conn: await gatedWireIdentity(rootIkm, carrier, nonce, 'connection'), egress: await gatedWireIdentity(rootIkm, carrier, nonce, 'egress') }
}

/** Alice, Bob, Carol; relationships A–B and A–C; per relationship and side its own root and nonce. */
export async function makeIdentityGroup(id: string, carrier: string, rand: Rand): Promise<IdentityGroup> {
  const A = await makeParty('A', rand)
  const B = await makeParty('B', rand)
  const C = await makeParty('C', rand)
  return {
    id,
    rels: [
      { id: 'AB', x: await side('A.AB', A, carrier, rand), y: await side('B.AB', B, carrier, rand) },
      { id: 'AC', x: await side('A.AC', A, carrier, rand), y: await side('C.AC', C, carrier, rand) },
    ],
  }
}
