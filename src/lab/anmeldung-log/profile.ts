// The fixed values and shared pieces of the login profile (SIOPv2 draft 13
// with named rules taken from OpenID4VP 1.0 and RFC 9101; NOTES.md has the
// table of where each rule comes from):
// - the outer link (QR code or app link): only `client_id` and `request_uri`;
// - the signed Request Object (JWS, EdDSA, `typ` oauth-authz-req+jwt);
// - where a did:webvh log lives (did:webvh 1.0, The DID to HTTPS Transformation);
// - the derivation context for the person's keys toward one service.

import { b64uOf, fromB64u, jcs, platformSubtle, type KeyPair } from 'rltp-lib'
import { loginKeys, type Profile, type Version } from '../kennung-log/log'
import { webvhSyntax } from '../kennung-log/profiles'

/** The name of this profile; it is part of the derivation context. */
export const PROFILE = 'x-anmeldung-log/1'
/** OpenID4VP 1.0, Client Identifier Prefixes. */
export const CLIENT_ID_PREFIX = 'decentralized_identifier:'
/** SIOPv2, `aud` of a Request Object, static discovery. */
export const SIOP_AUD = 'https://self-issued.me/v2'
/** RFC 9101 9.4.1; OpenID4VP 1.0: Wallets MUST NOT process Request Objects with another `typ`. */
export const REQUEST_TYP = 'oauth-authz-req+jwt'
export const REQUEST_MEDIA_TYPE = 'application/oauth-authz-req+jwt'
/** SIOPv2, `id_token_type`. */
export const ID_TOKEN_TYPE = 'subject_signed_id_token'
/** Profile rule: the form field of the answer that carries the person's DID log, as JSON Lines (did.jsonl). */
export const DID_LOG_FIELD = 'did_log'
/** The Web of Trust app's link; the outer parameters follow in the fragment. */
export const APP_LINK = 'https://web-of-trust.de/a'

/** Profile rules for the Request Object's time window, in seconds. */
export const REQUEST_LIFETIME_S = 300
export const CLOCK_SKEW_S = 60

/** The claims of the Request Object this profile writes and reads. */
export interface RequestClaims {
  iss?: string
  aud: string
  client_id: string
  response_type: 'id_token'
  response_mode: 'direct_post'
  scope: 'openid'
  id_token_type: string
  redirect_uri: string
  nonce: string
  state: string
  client_metadata: { subject_syntax_types_supported: string[], client_name?: string }
  iat: number
  nbf?: number
  exp: number
  [k: string]: unknown
}

const te = new TextEncoder(), td = new TextDecoder()
const b64uJson = (o: unknown): string => b64uOf(te.encode(JSON.stringify(o)))

/** The outer request: what QR code and link carry (RFC 9101 5.2.2; SIOPv2 Z. 455-459). */
export function outerLink (clientId: string, requestUri: string): string {
  const q = new URLSearchParams({ client_id: clientId, request_uri: requestUri })
  return `${APP_LINK}#${q.toString()}`
}

export type Outer = { client_id: string, request_uri: string }
/** Read the outer link. Anything else than a link with both parameters is refused:
 *  in particular a request by value (no `request_uri`) never leads to an unsigned mode. */
export function parseOuter (link: string): Outer | { error: string } {
  if (typeof link !== 'string' || !link.startsWith(APP_LINK + '#')) return { error: 'not a login link' }
  const q = new URLSearchParams(link.slice(APP_LINK.length + 1))
  const clientId = q.get('client_id'), requestUri = q.get('request_uri')
  if (q.has('request')) return { error: 'a request by value is not accepted' }
  if (!requestUri) return { error: 'no request_uri: an unsigned request is not accepted' }
  if (!clientId) return { error: 'no client_id' }
  if (q.getAll('client_id').length !== 1 || q.getAll('request_uri').length !== 1) return { error: 'a parameter is given twice' }
  return { client_id: clientId, request_uri: requestUri }
}

/** The DID of a client_id with the decentralized_identifier prefix, or null. */
export function didOfClientId (clientId: string): string | null {
  return clientId.startsWith(CLIENT_ID_PREFIX) ? clientId.slice(CLIENT_ID_PREFIX.length) : null
}

export type Location = { origin: string, logUrl: string, rest: string, scidText: string }
/**
 * did:webvh 1.0, The DID to HTTPS Transformation: the HTTPS URL of the log and
 * the origin it lives on. `rest` is the method-specific id after the SCID (the
 * host part of the profile in kennung-log/profiles.ts). The SCID returned here
 * is text of the DID, never a verified value: verification gives the SCID.
 * IDNA is not done (such a domain is refused, as in profiles.ts).
 */
export function locate (did: string): Location | { error: string } {
  if (did.includes('/') || did.includes('?') || did.includes('#')) return { error: 'not a bare DID' }
  const bad = webvhSyntax(did)
  if (bad) return { error: `not a did:webvh this code resolves: ${bad.reason}` }
  const [scidText, domain, ...segments] = did.slice('did:webvh:'.length).split(':') as [string, string, ...string[]]
  const m = /^(.*?)(?:%3[Aa]([0-9]{1,5}))?$/.exec(domain) as RegExpExecArray
  const host = decodeURIComponent(m[1] as string).toLowerCase()
  const port = m[2] !== undefined ? `:${Number(m[2])}` : ''
  const path = segments.map((s) => encodeURIComponent(decodeURIComponent(s))).join('/')
  const base = `https://${host}${port}`
  const logUrl = path ? `${base}/${path}/did.jsonl` : `${base}/.well-known/did.jsonl`
  return { origin: new URL(base).origin, logUrl, rest: did.slice('did:webvh:'.length + scidText.length + 1), scidText }
}

/** A Request Object: compact JWS, EdDSA, `typ` oauth-authz-req+jwt, `kid` a key of the service's DID document. */
export async function signRequestObject (key: KeyPair, kid: string, claims: RequestClaims): Promise<string> {
  const input = `${b64uJson({ alg: 'EdDSA', typ: REQUEST_TYP, kid })}.${b64uJson(claims)}`
  const sig = new Uint8Array(await platformSubtle().sign('Ed25519', key.priv, te.encode(input)))
  return `${input}.${b64uOf(sig)}`
}

export type RequestCheck =
  | { ok: true, header: Record<string, unknown>, claims: RequestClaims }
  | { ok: false, reason: string }

/**
 * Check a Request Object against the head of the service's verified log.
 * Every parameter the wallet acts on comes from the signed claims; what the
 * outer link says is used only to compare `client_id` (RFC 9101 6.3).
 */
export async function checkRequestObject (jwt: unknown, o: { clientId: string, did: string, head: Version, nowS: number }): Promise<RequestCheck> {
  const no = (reason: string): RequestCheck => ({ ok: false, reason })
  const parts = typeof jwt === 'string' ? jwt.split('.') : []
  if (parts.length !== 3) return no('not a compact JWS')
  const [h, p, s] = parts as [string, string, string]
  let header: any, claims: any
  try { header = JSON.parse(td.decode(fromB64u(h))); claims = JSON.parse(td.decode(fromB64u(p))) } catch { return no('not readable') }
  if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object' || Array.isArray(claims)) return no('not readable')
  if (header.alg !== 'EdDSA') return no('not signed with EdDSA')
  if (header.typ !== REQUEST_TYP) return no(`typ is not ${REQUEST_TYP}`)
  if ('crit' in header) return no('crit names a header parameter this wallet does not support')
  // OpenID4VP 1.0: the key is identified by `kid` among the verificationMethod of the DID document
  const kid = typeof header.kid === 'string' ? header.kid : ''
  const key = loginKeys(o.head.doc).find((k) => k.id === kid)
  if (!kid.startsWith(o.did + '#') || !key) return no('kid is not a key of the service DID at its current head')
  let good = false
  try {
    const pub = await platformSubtle().importKey('raw', key.raw as BufferSource, { name: 'Ed25519' }, false, ['verify'])
    good = await platformSubtle().verify('Ed25519', pub, fromB64u(s) as BufferSource, te.encode(`${h}.${p}`))
  } catch { good = false }
  if (!good) return no('signature does not verify')
  const c = claims as Record<string, unknown>
  if (c.client_id !== o.clientId) return no('client_id outside and inside differ')
  if (c.aud !== SIOP_AUD) return no(`aud is not ${SIOP_AUD}`)
  if ('request' in c || 'request_uri' in c) return no('a Request Object must not hold request or request_uri')
  if ('response_uri' in c) return no('response_uri is not part of this profile (redirect_uri with direct_post)')
  if (c.response_type !== 'id_token') return no('response_type is not id_token')
  if (c.response_mode !== 'direct_post') return no('response_mode is not direct_post')
  if (c.scope !== 'openid') return no('scope is not openid')
  if (typeof c.id_token_type !== 'string' || !c.id_token_type.split(' ').includes(ID_TOKEN_TYPE)) return no(`id_token_type does not ask for ${ID_TOKEN_TYPE}`)
  for (const k of ['redirect_uri', 'nonce', 'state'] as const) if (typeof c[k] !== 'string' || c[k] === '') return no(`${k} is missing`)
  const md = c.client_metadata as Record<string, unknown> | undefined
  if (!md || typeof md !== 'object' || !Array.isArray(md.subject_syntax_types_supported) || !md.subject_syntax_types_supported.every((x) => typeof x === 'string')) return no('client_metadata.subject_syntax_types_supported is missing')
  if ('client_name' in md && typeof md.client_name !== 'string') return no('client_metadata.client_name is not text')
  if (!Number.isInteger(c.iat) || !Number.isInteger(c.exp)) return no('iat or exp is missing')
  const iat = c.iat as number, exp = c.exp as number
  if (iat > o.nowS + CLOCK_SKEW_S || ('nbf' in c && !(Number.isInteger(c.nbf) && (c.nbf as number) <= o.nowS + CLOCK_SKEW_S))) return no('not yet valid')
  if (exp <= o.nowS) return no('expired')
  if (exp - iat > REQUEST_LIFETIME_S) return no('valid for longer than this profile allows')
  return { ok: true, header, claims: c as RequestClaims }
}

/**
 * The derivation context for one key of the person's identifier toward one
 * service, as the HKDF info string: the JCS of a fixed set of members, so
 * every value is delimited and no two contexts share an encoding. `scid` must
 * come from a verified log of the service DID.
 */
export function keyContext (serviceMethod: string, verifiedScid: string, role: 'update' | 'auth', index: number): string {
  return jcs({ index, method: serviceMethod, profile: PROFILE, purpose: 'login identifier', role, scid: verifiedScid })
}

/** SIOPv2, subject_syntax_types_supported: `did:` followed by the method name, without a `:` suffix. */
export function subjectSyntaxOf (p: Profile): string {
  return p.did.split(':').slice(0, 2).join(':')
}
