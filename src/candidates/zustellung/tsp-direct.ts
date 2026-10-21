import { pack, unpack, decodeEnvelope } from '@openvtc/vti-tsp-js'
import { sha256 } from '@noble/hashes/sha2.js'
import type { Endpoint, Observation, Party, Wire } from '../../lab/zustellung'
import { gatedWireIdentity, type WireIdentity } from '../../lab/zustellung-live/identities'

// E11b step 2: the direct send forms of the plan (§2) as wires. Per relationship and side a connection DID (the
// account at the carrier: its session, its address) and an egress identity, both carrier-scoped like the binding
// (`carrierScopedIdentity` of the lib, root + carrier + nonce; derivation and gate from step 1, imported). Frames are TSP
// Rev 3 direct (vti-tsp-js 0.3.0) to the partner's connection DID. The forms differ only in the sender:
//   (b) `connection`: the sender is the connection DID; one session per side.
//   (a) `egress-session`: the sender is the egress identity, which holds a session of its own; two per side.
//   spec form (control, not a registered wire): sender egress identity without a session of its own (adapter spec
//   §5a.10); `SessionCarrier` (src/lab/zustellung-sessions.ts) drops it silently, reproducing the outcome of D-e live.

/** The carrier DID the bench identities are scoped to (the bench has one carrier; Z2's second carrier keeps them, as the binding keeps its identities across sockets). */
export const BENCH_CARRIER = 'did:example:e11b-bench-carrier'

const enc = new TextEncoder()

export interface SideIdentities {
  conn: WireIdentity
  egress: WireIdentity
}

/**
 * The two identities of `self` in its relationship with `peer`: root = the party's wire seed, nonce = SHA-256 of the
 * peer's relationship key (one root per person, one nonce per relationship, as the lib's derivation intends).
 */
export async function relationshipIdentities(self: Party, peer: Party): Promise<SideIdentities> {
  const nonce = sha256(enc.encode(`e11b-rel:${peer.rkid}`)) // 32 bytes (Trust 7a.3)
  return { conn: await gatedWireIdentity(self.seed, BENCH_CARRIER, nonce, 'connection'), egress: await gatedWireIdentity(self.seed, BENCH_CARRIER, nonce, 'egress') }
}

export type DirectForm = 'connection' | 'egress-session' | 'egress-spec'

/** An endpoint of a direct form: besides the address, which identities its side holds sessions for and what it sends as. */
export interface SessionEndpoint extends Endpoint {
  /** The account at the carrier: the connection DID of this side (= the address). */
  readonly account: string
  /** The sender identity this side puts in the frames it sends. */
  readonly sender: string
  /** Identities this side opens a session for at the carrier, the address first. */
  readonly sessions: readonly string[]
}

export interface SessionWire extends Wire {
  bind(a: Party, b: Party): Promise<{ a: SessionEndpoint; b: SessionEndpoint }>
}

const senderOf = (form: DirectForm, s: SideIdentities) => (form === 'connection' ? s.conn : s.egress)
const sessionsOf = (form: DirectForm, s: SideIdentities) => (form === 'egress-session' ? [s.conn.did, s.egress.did] : [s.conn.did])

/** Rejected at the wire: the frame is not a Rev 3 `direct` with a payload from the expected pair (parser rule, #95, MV-24). */
class WireReject extends Error {}

/** What the wire reads from an unpacked message. */
export interface UnpackedDirect {
  revision: string
  sender: string
  receiver: string
  messageType: string
  payload: Uint8Array
}

/**
 * The parser rule (#95, MV-24) on the message the library constructed: revision, sender, receiver, type `direct`, a
 * payload; the payload is returned only if all hold. The revision check is our own guard: vti-tsp-js 0.3.0 already
 * refuses a frame declaring Rev 2 when no `senderEncryptionKey` is passed (as here), so through `unpack` it cannot
 * trigger today; it stays so that a library change (Rev 2 opened, a new revision) cannot reach `receive()` unnoticed.
 */
export function admitDirect(m: UnpackedDirect, sender: string, receiver: string): Uint8Array {
  if (m.revision !== 'rev3') throw new WireReject(`tsp: revision ${m.revision}`)
  if (m.sender !== sender || m.receiver !== receiver) throw new WireReject('tsp: sender or receiver mismatch')
  if (m.messageType !== 'direct') throw new WireReject(`tsp: type ${m.messageType}`)
  if (m.payload.length === 0) throw new WireReject('tsp: empty direct')
  return new Uint8Array(m.payload)
}

export function tspDirectWire(form: DirectForm, id: string, title: string): SessionWire {
  return {
    id,
    title,
    async bind(a, b) {
      const ia = await relationshipIdentities(a, b)
      const ib = await relationshipIdentities(b, a)
      const endpoint = (self: SideIdentities, peer: SideIdentities, who: Party, peerName: string): SessionEndpoint => {
        // The partner packs to me: when it sends, it sends as `senderOf(form, peer)`.
        const from = senderOf(form, peer)
        return {
          address: self.conn.did,
          account: self.conn.did,
          sender: senderOf(form, self).did,
          sessions: sessionsOf(form, self),
          async pack(payload) {
            const m = await pack(payload, from.did, self.conn.did, { senderSigningKey: from.edSecret, receiverEncryptionKey: self.conn.xPublic })
            return m.bytes
          },
          async unpack(frame) {
            // Opened only with the expected pair's keys; then the constructed message is checked before anything is
            // passed on: revision, sender, receiver, type `direct`, a payload. Everything else is rejected and counted
            // by the device as a wire rejection, never reinterpreted as a payload.
            const m = await unpack(frame, { receiverDecryptionKey: self.conn.xSecret, senderSigningKey: from.edPublic })
            return admitDirect(m, from.did, self.conn.did)
          },
          async forge(payload, sender) {
            // A third party with its own identities for a relationship with me, to my unchanged key and address.
            const im = senderOf(form, await relationshipIdentities(sender, who))
            const m = await pack(payload, im.did, self.conn.did, { senderSigningKey: im.edSecret, receiverEncryptionKey: self.conn.xPublic })
            return m.bytes
          },
          observe(frame): Observation {
            const e = decodeEnvelope(frame)
            const s = e.envelope.sender
            const r = e.envelope.receiver
            const label = (did: string, side: SideIdentities, name: string) => (did === side.conn.did ? `Konto(${name})` : did === side.egress.did ? `Egress(${name})` : did)
            // Is the sender's account (its connection DID) anywhere in the frame the partner opens?
            const konto = s === peer.conn.did || r === peer.conn.did || new TextDecoder().decode(frame).includes(peer.conn.did)
            return { absender: label(s, peer, peerName), empfaenger: label(r, self, who.name), konto: konto ? 'sichtbar' : 'verdeckt', revision: String(e.revision), groesse: frame.length }
          },
        }
      }
      return { a: endpoint(ia, ib, a, b.name), b: endpoint(ib, ia, b, a.name) }
    },
  }
}
