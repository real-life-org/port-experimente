// Shared pieces of a SIOPv2-shaped login: the request a web app shows, the
// ID token a wallet returns, and compact JWS with EdDSA over a did:key.
//
// The shape follows Self-Issued OpenID Provider v2 (OpenID Foundation draft):
// response_type id_token, response_mode direct_post, subject syntax did:key,
// iss = sub = the DID that signs. Only what this prototype needs is here; it is
// not a full SIOPv2 implementation (no request objects by reference, no signed
// requests, no client metadata discovery).

import { anchorOfEd, b64uOf, edRawOfAnchor, fromB64u, platformSubtle, type KeyPair } from 'rltp-lib'

/** What a web app asks for. Field names as in SIOPv2. */
export interface LoginRequest {
  response_type: 'id_token'
  response_mode: 'direct_post'
  scope: 'openid'
  id_token_type: 'subject_signed'
  client_id: string          // the web app, as a URL (client_id scheme redirect_uri)
  response_uri: string       // where the wallet posts the answer; same origin as client_id
  nonce: string
  state: string
  client_name?: string       // self-asserted by the web app; the wallet shows the origin, not this
}

/** The claims of the self-issued ID token. */
export interface IdTokenClaims {
  iss: string                // the DID
  sub: string                // the same DID
  aud: string                // the web app's client_id
  nonce: string
  iat: number                // seconds
  exp: number                // seconds
  name?: string              // only if the person chose to share it
}

const SCHEME = 'openid://'

/** The request as the URL a QR code or a link carries (request by value). */
export function requestUrl (r: LoginRequest): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(r)) if (v !== undefined) q.set(k, v)
  return `${SCHEME}?${q.toString()}`
}

/** Read a request URL. Returns null for anything that is not a complete request. */
export function parseRequestUrl (url: string): LoginRequest | null {
  if (typeof url !== 'string' || !url.startsWith(SCHEME)) return null
  const q = new URLSearchParams(url.slice(url.indexOf('?') + 1))
  const get = (k: string): string | null => q.get(k)
  const fixed = { response_type: 'id_token', response_mode: 'direct_post', scope: 'openid', id_token_type: 'subject_signed' } as const
  for (const [k, v] of Object.entries(fixed)) if (get(k) !== v) return null
  const client_id = get('client_id'), response_uri = get('response_uri'), nonce = get('nonce'), state = get('state')
  if (!client_id || !response_uri || !nonce || !state) return null
  const name = get('client_name')
  return { ...fixed, client_id, response_uri, nonce, state, ...(name ? { client_name: name } : {}) }
}

/** The origin of a URL, or null. */
export function originOf (url: string): string | null {
  try { const u = new URL(url); return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null } catch { return null }
}

const enc = new TextEncoder(), dec = new TextDecoder()
const b64uJson = (o: unknown): string => b64uOf(enc.encode(JSON.stringify(o)))

/** The key id of a did:key: the DID with its own multibase value as fragment. */
export const kidOf = (did: string): string => `${did}#${did.slice('did:key:'.length)}`

/** Sign claims as a compact JWS (EdDSA, Ed25519) with the key of `key`. */
export async function signIdToken (key: KeyPair, claims: IdTokenClaims, subtle: SubtleCrypto = platformSubtle()): Promise<string> {
  const did = anchorOfEd(key.pubRaw)
  const input = `${b64uJson({ alg: 'EdDSA', typ: 'JWT', kid: kidOf(did) })}.${b64uJson(claims)}`
  const sig = new Uint8Array(await subtle.sign('Ed25519', key.priv, enc.encode(input)))
  return `${input}.${b64uOf(sig)}`
}

export type TokenCheck =
  | { ok: true, claims: IdTokenClaims }
  | { ok: false, reason: string }

/**
 * Check the form and signature of an ID token. Says nothing about audience,
 * nonce or time; that is the web app's part (webapp.ts).
 */
export async function verifyIdTokenSignature (token: string, subtle: SubtleCrypto = platformSubtle()): Promise<TokenCheck> {
  const parts = typeof token === 'string' ? token.split('.') : []
  if (parts.length !== 3) return { ok: false, reason: 'kein JWS' }
  const [h, p, s] = parts as [string, string, string]
  let header: any, claims: any
  try { header = JSON.parse(dec.decode(fromB64u(h))); claims = JSON.parse(dec.decode(fromB64u(p))) } catch { return { ok: false, reason: 'nicht lesbar' } }
  if (header?.alg !== 'EdDSA') return { ok: false, reason: 'falsches Verfahren' }
  if (typeof claims?.iss !== 'string' || claims.iss !== claims.sub) return { ok: false, reason: 'nicht selbst ausgestellt' }
  if (header.kid !== kidOf(claims.iss)) return { ok: false, reason: 'Schlüssel passt nicht zur DID' }
  const raw = edRawOfAnchor(claims.iss)
  if (raw === null) return { ok: false, reason: 'keine did:key' }
  let good = false
  try {
    const pub = await subtle.importKey('raw', raw as BufferSource, { name: 'Ed25519' }, false, ['verify'])
    good = await subtle.verify('Ed25519', pub, fromB64u(s) as BufferSource, enc.encode(`${h}.${p}`))
  } catch { good = false }
  if (!good) return { ok: false, reason: 'Unterschrift ungültig' }
  return { ok: true, claims: claims as IdTokenClaims }
}
