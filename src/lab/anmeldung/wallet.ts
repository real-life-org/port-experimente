// The mini wallet: what the Web of Trust app would do with a login request.
//
// One key per web app, derived from the person's root key material, so that
// every device holding the same root (multi-device stage 1, E27) answers with
// the same identifier, and two web apps cannot link the person.
//
// DEVIATION: the library only derives keys for the closed label registry of
// Identity §6.1 (pair/, group/, persona/, device/, recovery). A context "a web
// app I log into" does not exist there. This prototype derives the key outside
// the library under an experimental info string. Whether such a label belongs
// in the registry is an open question for the Identity layer.

import { anchorOfEd, b64uOf, edFromSeed, hkdf, platformSubtle, sha, type KeyPair } from 'rltp-lib'
import { originOf, signIdToken, type IdTokenClaims, type LoginRequest } from './siop'

const EXPERIMENTAL_INFO = 'x-anmeldung/0.1/'
const TOKEN_LIFETIME_S = 300

/** The key a person uses toward one web app (by its origin). */
export async function loginKey (rootIkm: Uint8Array, clientId: string, subtle: SubtleCrypto = platformSubtle()): Promise<KeyPair> {
  const origin = originOf(clientId)
  if (origin === null) throw new Error('client_id ist keine Web-Adresse')
  const tag = b64uOf(await sha(new TextEncoder().encode(origin), subtle))
  return edFromSeed(await hkdf(rootIkm, EXPERIMENTAL_INFO + tag, 32, subtle), subtle)
}

export type Review =
  | { ok: true, origin: string, host: string, text: string }
  | { ok: false, reason: string }

/**
 * What the wallet shows before the person decides. The name shown is the
 * host of the web app's address, never the self-asserted client_name. The
 * answer must go back to the same origin the request names; otherwise the
 * wallet refuses (client_id scheme redirect_uri).
 */
export function review (r: LoginRequest): Review {
  const origin = originOf(r.client_id)
  if (origin === null) return { ok: false, reason: 'Web-App ohne gültige Adresse' }
  if (originOf(r.response_uri) !== origin) return { ok: false, reason: 'Antwort ginge an eine andere Adresse als die Web-App' }
  const host = new URL(origin).host
  return { ok: true, origin, host, text: `${host} möchte dich anmelden. Es sieht nur einen Namen für dich, der nur dort gilt.` }
}

/**
 * Same-device: after the answer the web app names a redirect_uri, which the
 * wallet opens in the browser. Only an address on the web app's own origin is
 * opened; anything else could hand the response_code to someone else.
 */
export function mayOpen (r: LoginRequest, redirectUri: string): boolean {
  const origin = originOf(r.client_id)
  return origin !== null && originOf(redirectUri) === origin
}

export interface Answer {
  response_uri: string
  body: { id_token: string, state: string }
  did: string
}

/** The person confirmed: build and sign the answer. */
export async function confirm (
  r: LoginRequest, rootIkm: Uint8Array, nowMs: number,
  opts: { name?: string, picture?: string, subtle?: SubtleCrypto } = {},
): Promise<Answer> {
  const checked = review(r)
  if (!checked.ok) throw new Error(checked.reason)
  const subtle = opts.subtle ?? platformSubtle()
  const key = await loginKey(rootIkm, r.client_id, subtle)
  const did = anchorOfEd(key.pubRaw)
  const iat = Math.floor(nowMs / 1000)
  const claims: IdTokenClaims = { iss: did, sub: did, aud: r.client_id, nonce: r.nonce, iat, exp: iat + TOKEN_LIFETIME_S, ...(opts.name ? { name: opts.name } : {}), ...(opts.picture ? { picture: opts.picture } : {}) }
  return { response_uri: r.response_uri, body: { id_token: await signIdToken(key, claims, subtle), state: r.state }, did }
}
