import { pack, packAnoncrypt, unpack, multibase, jwk, didKey } from '@openvtc/vti-didcomm-js'
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import type { Endpoint, Observation, Party, Wire } from '../../lab/zustellung'

// Draht DIDComm v2 (vti-didcomm-js 0.12.0): der versiegelte lib-Umschlag reist
// als Body einer DIDComm-Nachricht in einem JWE. `authcrypt` (ECDH-1PU) trägt
// den Absenderschlüssel (`skid`) im geschützten Header, `anoncrypt` (ECDH-ES)
// nicht. Je Beziehung und Seite ein did:key; Adresse = Empfänger-kid.

const enc = new TextEncoder()
const dec = new TextDecoder()
const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url')
const unb64u = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'))

function identity(seed: Uint8Array, info: string) {
  const edSecret = hkdf(sha256, seed, undefined, enc.encode(info), 32)
  const edPublic = ed25519.getPublicKey(edSecret)
  const xSecret = ed25519.utils.toMontgomerySecret(edSecret)
  const xPublic = x25519.getPublicKey(xSecret)
  const did = `did:key:${multibase.encodeMultikey(multibase.MULTICODEC.ED25519_PUB, edPublic)}`
  const doc = didKey.resolve(did).didDocument as { keyAgreement?: Array<string | { id: string }> }
  const ka = doc.keyAgreement?.[0]
  const kid = typeof ka === 'string' ? ka : ka!.id
  return { did, kid, xSecret, xPublic, privateJwk: jwk.privateJwk('X25519', xSecret, xPublic, kid), publicJwk: jwk.publicJwk('X25519', xPublic, kid) }
}

export function didcommWire(mode: 'authcrypt' | 'anoncrypt' = 'authcrypt'): Wire {
  return {
    id: `didcomm-${mode}`,
    title: `DIDComm v2 ${mode} (vti-didcomm-js 0.12.0): ein did:key je Beziehung und Seite, JWE`,
    async bind(a, b) {
      const ia = identity(a.seed, `didcomm:${b.rkid}`)
      const ib = identity(b.seed, `didcomm:${a.rkid}`)
      const endpoint = (self: typeof ia, peer: typeof ib, who: Party): Endpoint => ({
        address: self.kid,
        async pack(payload) {
          const message = { id: crypto.randomUUID(), type: 'https://real-life.org/rltp/sealed-envelope', from: peer.did, to: [self.did], body: { env: b64u(payload) } }
          const jwe = mode === 'authcrypt' ? await pack({ message, sender: { kid: peer.kid, privateJwk: peer.privateJwk }, recipient: { kid: self.kid, publicJwk: self.publicJwk } }) : await packAnoncrypt({ message, recipient: { kid: self.kid, publicJwk: self.publicJwk } })
          return enc.encode(jwe)
        },
        async unpack(frame) {
          const r = await unpack(dec.decode(frame), { kid: self.kid, privateJwk: self.privateJwk }, mode === 'authcrypt' ? { publicJwk: peer.publicJwk } : undefined)
          const body = (r.message as { body?: { env?: string } }).body
          if (typeof body?.env !== 'string') throw new Error('kein Umschlag im Body')
          return unb64u(body.env)
        },
        observe(frame): Observation {
          const j = JSON.parse(dec.decode(frame)) as { protected?: string; recipients?: Array<{ header?: { kid?: string } }> }
          const header = j.protected ? (JSON.parse(dec.decode(unb64u(j.protected))) as Record<string, unknown>) : {}
          const skid = header.skid as string | undefined
          const kid = j.recipients?.[0]?.header?.kid
          return { absender: skid ? (skid === peer.kid ? `kid(${who.name === 'alice' ? 'bob' : 'alice'})` : skid) : 'keiner', empfaenger: kid === self.kid ? `kid(${who.name})` : (kid ?? '?'), alg: String(header.alg ?? '?'), groesse: frame.length }
        },
      })
      return { a: endpoint(ia, ib, a), b: endpoint(ib, ia, b) }
    },
  }
}
