// The service (Relying Party): its own did:webvh, a signed Request Object per
// login, and the answer checked by the stateful verifier of kennung-log.
//
// The lifecycle of one login follows src/lab/anmeldung/webapp.ts (rebuilt
// here, that module stays as it is):
// 1. started: a browser session asks; the request lives REQUEST_LIFETIME_MS;
// 2. answered: exactly one answer per request, claimed before the first await;
//    a good answer starts the pickup window (cross-device: the waiting page
//    collects; same-device: a one-time response_code in the redirect_uri of
//    the HTTP answer, redeemable only by the browser session that started it);
// 3. collected: exactly once.
// Transport-free; http.ts puts it behind HTTP.

import { b64uOf, edFromSeed, hkdf, rand, type KeyPair } from 'rltp-lib'
import { create, fromJsonl, loginKeys, rotate, toJsonl, verify, type Entry, type Profile, type Version } from '../kennung-log/log'
import { vh, webvh } from '../kennung-log/profiles'
import { MemoryStore, Verifier, type LoginResult, type Store } from '../kennung-log/verifier'
import { subjectSyntaxOf, CLIENT_ID_PREFIX, DID_LOG_FIELD, ID_TOKEN_TYPE, outerLink, REQUEST_LIFETIME_S, SIOP_AUD, signRequestObject, type RequestClaims } from './profile'

export const REQUEST_LIFETIME_MS = REQUEST_LIFETIME_S * 1000
export const PICKUP_LIFETIME_MS = 5 * 60_000
export const CODE_LIFETIME_MS = 60_000
export const RESPONSE_PATH = '/anmeldung-log/antwort'
export const REQUEST_PATH = '/anmeldung-log/anfrage/'
export const RETURN_PATH = '/anmeldung-log/fertig'

/** The service's keys, one sequence from a seed: update key n and authentication key n. */
export class ServiceKeys {
  constructor (private readonly seed: Uint8Array) {}
  static random (): ServiceKeys { return new ServiceKeys(rand(32)) }
  update (n: number): Promise<KeyPair> { return this.key('update', n) }
  auth (n: number): Promise<KeyPair> { return this.key('auth', n) }
  private async key (role: string, n: number): Promise<KeyPair> { return edFromSeed(await hkdf(this.seed, `x-anmeldung-log-service/1/${role}/${n}`)) }
}

/** The first entry of a service's did:webvh log, with update key 0, committed to update key 1, and auth key 0. */
export async function serviceLog (host: string, keys: ServiceKeys, time: string): Promise<Entry[]> {
  const [u0, u1, a0] = await Promise.all([keys.update(0), keys.update(1), keys.auth(0)])
  return create({ profile: webvh(host), updateKey: u0, next: [u1.pubRaw], authKey: a0.pubRaw, time })
}

export type Mode = 'cross-device' | 'same-device'
export type Login = { user: string }
interface Pending { session: string, nonce: string, created: number, mode: Mode, jwt: string, requestId: string, checking: boolean }
interface Code { session: string, login: Login, created: number }

/** What the answer endpoint returns: HTTP status and JSON body. */
export type Reply = { status: number, body: Record<string, unknown> }

export interface ServiceOptions {
  /** The host part of the DID after the SCID, e.g. `dienst.example%3A8443` (did:webvh syntax, port encoded). */
  host: string
  keys: ServiceKeys
  now: () => number
  /** The name shown as text beside the host (client_metadata.client_name). */
  name?: string
  /** The method of the persons' identifiers (default did:vh, kennung-log/profiles.ts). */
  identityProfile?: Profile
  /** The verifier's store (default in memory). */
  store?: Store
  /** A log written earlier (fixed vectors); otherwise one is created at `now`. */
  log?: Entry[]
  /** Fixed values for the vector; random otherwise. */
  fixed?: { nonce: string, state: string, requestId: string }
}

const isoSeconds = (ms: number): string => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.000Z$/, 'Z')

export class Service {
  private log!: Entry[]
  private head!: Version
  private keyIndex = 0
  readonly did: string
  readonly clientId: string
  readonly origin: string
  readonly redirectUri: string
  readonly returnUri: string
  private readonly verifier: Verifier
  private readonly store: Store
  private readonly pending = new Map<string, Pending>()        // state -> request
  private readonly byRequestId = new Map<string, string>()     // request id -> state
  private readonly loggedIn = new Map<string, { login: Login, at: number }>()
  private readonly cancelled = new Map<string, number>()       // session -> when the person cancelled
  private readonly codes = new Map<string, Code>()

  private constructor (readonly o: ServiceOptions & { log: Entry[], head: Version, did: string, origin: string }) {
    this.log = o.log; this.head = o.head
    this.did = o.did
    this.clientId = CLIENT_ID_PREFIX + o.did
    this.origin = o.origin
    this.redirectUri = this.origin + RESPONSE_PATH
    this.returnUri = this.origin + RETURN_PATH
    this.store = o.store ?? new MemoryStore()
    this.verifier = new Verifier({ profile: o.identityProfile ?? vh, audience: this.clientId, now: () => new Date(o.now()), store: this.store, nonceTtlSec: REQUEST_LIFETIME_S })
  }

  /** A service with its own did:webvh: a log is created at `now` unless one is given. */
  static async create (o: ServiceOptions): Promise<Service> {
    const log = o.log ?? await serviceLog(o.host, o.keys, isoSeconds(o.now()))
    const check = await verify(log, { profile: webvh(o.host), now: new Date(o.now()) })
    if (!check.ok) throw new Error(`service log: ${check.reason}`)
    const m = /^(.*?)(?:%3[Aa]([0-9]{1,5}))?(?::|$)/.exec(o.host) as RegExpExecArray
    const origin = new URL(`https://${m[1]}${m[2] ? ':' + m[2] : ''}`).origin
    return new Service({ ...o, log: check.log, head: check.head, did: check.did, origin })
  }

  /** The log as served at the did:webvh location (JSON Lines). */
  didLog (): string { return toJsonl(this.log) }
  get scid (): string { return (this.log[0] as Entry).parameters.scid as string }
  get headVersion (): string { return this.head.versionId }
  /** The `kid` of the request signing key: `<did>#<fragment>` of the head's document. */
  get kid (): string { return (loginKeys(this.head.doc)[0] as { id: string }).id }

  /** The service changes its key: the committed update key signs, the document gets the next authentication key. */
  async rotateKey (): Promise<void> {
    const n = this.keyIndex + 1
    const [signer, next, auth] = await Promise.all([this.o.keys.update(n), this.o.keys.update(n + 1), this.o.keys.auth(n)])
    const prev = Date.parse(this.head.versionTime)
    const t = Math.max(Math.floor(this.o.now() / 1000) * 1000, prev + 1000)
    const log = await rotate(this.log, { signer, next: [next.pubRaw], authKey: auth.pubRaw, time: isoSeconds(t) })
    const check = await verify(log, { profile: webvh(this.o.host), now: new Date(Math.max(this.o.now(), t)), did: this.did })
    if (!check.ok) throw new Error(`service log: ${check.reason}`)
    this.log = check.log; this.head = check.head; this.keyIndex = n
  }

  /** A browser session asks to log in: a signed Request Object behind a request_uri, and the outer link. */
  async start (session: string, mode: Mode = 'cross-device'): Promise<{ link: string, requestUri: string, state: string }> {
    const now = this.o.now()
    this.forget(session)
    const nonce = this.o.fixed?.nonce ?? await this.verifier.issueNonce()
    if (this.o.fixed) await this.issueFixedNonce(nonce)
    const state = this.o.fixed?.state ?? b64uOf(rand(16))
    const requestId = this.o.fixed?.requestId ?? b64uOf(rand(16))
    const iat = Math.floor(now / 1000)
    const claims: RequestClaims = {
      iss: this.clientId,
      aud: SIOP_AUD,
      client_id: this.clientId,
      response_type: 'id_token',
      response_mode: 'direct_post',
      scope: 'openid',
      id_token_type: ID_TOKEN_TYPE,
      redirect_uri: this.redirectUri,
      nonce,
      state,
      client_metadata: { subject_syntax_types_supported: [subjectSyntaxOf(this.o.identityProfile ?? vh)], ...(this.o.name ? { client_name: this.o.name } : {}) },
      iat,
      nbf: iat,
      exp: iat + REQUEST_LIFETIME_S,
    }
    const jwt = await signRequestObject(await this.o.keys.auth(this.keyIndex), this.kid, claims)
    this.pending.set(state, { session, nonce, created: now, mode, jwt, requestId, checking: false })
    this.byRequestId.set(requestId, state)
    const requestUri = this.origin + REQUEST_PATH + requestId
    return { link: outerLink(this.clientId, requestUri), requestUri, state }
  }

  /** The vector uses a fixed nonce; the verifier admits only nonces in its store, so it is put there. */
  private async issueFixedNonce (nonce: string): Promise<void> {
    const now = this.o.now()
    await this.store.issue(nonce, now + REQUEST_LIFETIME_MS, now)
  }

  /** GET request_uri: the Request Object while its request is open. */
  requestObject (requestId: string): string | null {
    const state = this.byRequestId.get(requestId)
    const p = state ? this.pending.get(state) : undefined
    if (!p || p.checking || this.o.now() - p.created > REQUEST_LIFETIME_MS) return null
    return p.jwt
  }

  /**
   * The answer at the redirect_uri (direct_post, form-encoded): `id_token`,
   * `state` and the person's log in `did_log`; or `error` and `state`.
   * Exactly one answer per request.
   */
  async receive (form: URLSearchParams): Promise<Reply> {
    const fail = (status: number, error: string, description: string, extra: Record<string, unknown> = {}): Reply => ({ status, body: { error, error_description: description, ...extra } })
    const state = form.get('state') ?? ''
    const p = this.pending.get(state)
    if (!p) return fail(400, 'invalid_request', 'unknown request')
    if (this.o.now() - p.created > REQUEST_LIFETIME_MS) return fail(400, 'invalid_request', 'request expired')
    if (p.checking) return fail(400, 'invalid_request', 'request is being answered')
    p.checking = true                                       // claimed before the first await
    const done = (): void => { this.pending.delete(state); this.byRequestId.delete(p.requestId) }
    const error = form.get('error')
    if (error !== null) {
      done()
      if (error === 'user_cancelled') this.cancelled.set(p.session, this.o.now())
      return { status: 200, body: {} }                      // OpenID4VP 1.0: an error response processed, 200 with JSON
    }
    const logText = form.get(DID_LOG_FIELD)
    const log = typeof logText === 'string' ? fromJsonl(logText) : null
    const token = form.get('id_token') ?? ''
    const r: LoginResult = log === null
      ? { kind: 'invalid', reason: `${DID_LOG_FIELD} is not a DID log in JSON Lines` }
      : await this.verifier.login({ log, token, nonce: p.nonce })
    // the nonce is spent in the verifier's step whatever the result: the request ends with its one answer
    done()
    if (r.kind !== 'ok') {
      const extra = r.kind === 'stale' ? { held_version_id: r.held } : {}
      return fail(400, 'invalid_request', 'reason' in r ? r.reason : r.kind, { did_log_result: r.kind, ...extra })
    }
    const login: Login = { user: r.did }
    if (p.mode === 'same-device') {
      const code = this.o.fixed ? 'response-code' : b64uOf(rand(16))
      this.codes.set(code, { session: p.session, login, created: this.o.now() })
      const u = new URL(this.returnUri); u.searchParams.set('response_code', code)
      return { status: 200, body: { redirect_uri: u.href } }
    }
    this.loggedIn.set(p.session, { login, at: this.o.now() })
    return { status: 200, body: {} }
  }

  /** Cross-device: hand a confirmed login over exactly once, within its pickup window. */
  take (session: string): Login | { cancelled: true } | null {
    const l = this.loggedIn.get(session)
    this.loggedIn.delete(session)
    if (l && this.o.now() - l.at <= PICKUP_LIFETIME_MS) return l.login
    const c = this.cancelled.get(session)
    if (c !== undefined) { this.cancelled.delete(session); if (this.o.now() - c <= PICKUP_LIFETIME_MS) return { cancelled: true } }
    return null
  }

  /** Same-device: the code is used up by the first attempt, right or wrong, and counts only for its browser session. */
  redeem (session: string, code: string): Login | null {
    const c = this.codes.get(code)
    this.codes.delete(code)
    if (!c || this.o.now() - c.created > CODE_LIFETIME_MS || c.session !== session) return null
    return c.login
  }

  /** The browser session starts anew: what it held is dropped (a request being answered ends and stores nothing for it). */
  forget (session: string): void {
    for (const [k, p] of this.pending) if (p.session === session && !p.checking) { this.pending.delete(k); this.byRequestId.delete(p.requestId) }
    this.loggedIn.delete(session)
    this.cancelled.delete(session)
    for (const [k, c] of this.codes) if (c.session === session) this.codes.delete(k)
  }

  /** What the service holds of a person's identifier (the verifier's copy). */
  holding (did: string) { return this.verifier.holding(did) }

  held (): { pending: number, loggedIn: number, codes: number } {
    return { pending: this.pending.size, loggedIn: this.loggedIn.size, codes: this.codes.size }
  }
}
