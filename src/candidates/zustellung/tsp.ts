import { pack, unpack, decodeEnvelope } from '@openvtc/vti-tsp-js'
import { multibase } from '@openvtc/vti-didcomm-js'
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import type { Endpoint, Observation, Party, Wire } from '../../lab/zustellung'

// Draht TSP (Trust Spanning Protocol, Rev 3, vti-tsp-js 0.3.0): der versiegelte
// lib-Umschlag ist die Nutzlast einer direkten TSP-Nachricht. Je Beziehung ein
// eigener VID (did:key aus Ed25519, X25519 daraus abgeleitet) je Seite, wie die
// Wire-Bindung in trust-protocol/binding. Adresse = Empfänger-VID; der Träger
// liest Sender- und Empfänger-VID im Klartext-Umschlag.

const enc = new TextEncoder()

function identity(seed: Uint8Array, info: string) {
  const edSecret = hkdf(sha256, seed, undefined, enc.encode(info), 32)
  const edPublic = ed25519.getPublicKey(edSecret)
  const xSecret = ed25519.utils.toMontgomerySecret(edSecret)
  const xPublic = x25519.getPublicKey(xSecret)
  const vid = `did:key:${multibase.encodeMultikey(multibase.MULTICODEC.ED25519_PUB, edPublic)}`
  return { vid, edSecret, edPublic, xSecret, xPublic }
}

export function tspWire(): Wire {
  return {
    id: 'tsp',
    title: 'TSP Rev 3 direkt (vti-tsp-js 0.3.0): ein VID je Beziehung und Seite, HPKE, Außensignatur',
    async bind(a, b) {
      const ia = identity(a.seed, `tsp:${b.rkid}`)
      const ib = identity(b.seed, `tsp:${a.rkid}`)
      const endpoint = (self: typeof ia, peer: typeof ib, who: Party): Endpoint => ({
        address: self.vid,
        async pack(payload) {
          // Der Partner packt an mich: sendet er, ist er `peer`.
          const m = await pack(payload, peer.vid, self.vid, { senderSigningKey: peer.edSecret, receiverEncryptionKey: self.xPublic })
          return m.bytes
        },
        async unpack(frame) {
          const m = await unpack(frame, { receiverDecryptionKey: self.xSecret, senderSigningKey: peer.edPublic })
          return new Uint8Array(m.payload)
        },
        async forge(payload, sender) {
          // Fremder Absender mit eigenem VID, an denselben Empfängerschlüssel (self.xPublic) und dieselbe Adresse.
          const im = identity(sender.seed, `tsp:${who.rkid}`)
          const m = await pack(payload, im.vid, self.vid, { senderSigningKey: im.edSecret, receiverEncryptionKey: self.xPublic })
          return m.bytes
        },
        observe(frame): Observation {
          const e = decodeEnvelope(frame)
          return { absender: e.envelope.sender === peer.vid ? `VID(${who.name === 'alice' ? 'bob' : 'alice'})` : e.envelope.sender, empfaenger: `VID(${who.name})`, revision: String(e.revision), groesse: frame.length }
        },
      })
      return { a: endpoint(ia, ib, a), b: endpoint(ib, ia, b) }
    },
  }
}
