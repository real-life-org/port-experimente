// The service (Relying Party): its own did:webvh, a signed Request Object per
// login, and the answer checked by the stateful verifier of kennung-log.
//
// The lifecycle of one login follows src/lab/anmeldung/webapp.ts (rebuilt
// here, that module stays as it is):
// 1. started: each start is a fresh attempt with its own id, request, nonce
//    and state; it lives REQUEST_LIFETIME_MS;
// 2. answered: an answer that reaches the verifier's step for the attempt's
//    nonce ends the attempt in that same step, and a good one is handed out
//    there (cross-device: to the waiting browser; same-device: a one-time
//    response_code in the redirect_uri of the HTTP answer); `user_cancelled`
//    ends it too, in one step with spending the nonce; nothing else does;
// 3. collected or redeemed exactly once: a session is issued in one store
//    step with a fresh look at the identifier (contested: no session).
// Transport-free; http.ts puts it behind HTTP.

import { b64uOf, edFromSeed, hkdf, rand, type KeyPair } from 'rltp-lib'
import { create, deactivate, fromJsonl, loginKeys, rotate, toJsonl, verify, type Entry, type Profile, type Version } from '../kennung-log/log'
import { vh, webvh } from '../kennung-log/profiles'
import { MemoryStore, Verifier, type Held, type LoginResult, type Store } from '../kennung-log/verifier'
import { subjectSyntaxOf, CLIENT_ID_PREFIX, DID_LOG_FIELD, ID_TOKEN_TYPE, outerLink, REQUEST_LIFETIME_S, SIOP_AUD, signRequestObject, type RequestClaims } from './profile'

export const REQUEST_LIFETIME_MS = REQUEST_LIFETIME_S * 1000
export const PICKUP_LIFETIME_MS = 5 * 60_000
export const CODE_LIFETIME_MS = 60_000
export const SESSION_LIFETIME_MS = 60 * 60_000
export const RESPONSE_PATH = '/anmeldung-log/antwort'
export const REQUEST_PATH = '/anmeldung-log/anfrage/'
export const RETURN_PATH = '/anmeldung-log/fertig'

/** The HKDF info of the service's key n of one role (a lab rule for fixed vectors; a service may hold its keys any way). */
export const serviceKeyInfo = (role: 'update' | 'auth', n: number): string => `x-anmeldung-log-service/1/${role}/${n}`

/** The service's keys, one sequence from a seed: update key n and authentication key n. */
export class ServiceKeys {
  constructor (private readonly seed: Uint8Array) {}
  static random (): ServiceKeys { return new ServiceKeys(rand(32)) }
  update (n: number): Promise<KeyPair> { return this.key('update', n) }
  auth (n: number): Promise<KeyPair> { return this.key('auth', n) }
  private async key (role: 'update' | 'auth', n: number): Promise<KeyPair> { return edFromSeed(await hkdf(this.seed, serviceKeyInfo(role, n))) }
}

/** The first entry of a service's did:webvh log, with update key 0, committed to update key 1, and auth key 0. */
export async function serviceLog (host: string, keys: ServiceKeys, time: string): Promise<Entry[]> {
  const [u0, u1, a0] = await Promise.all([keys.update(0), keys.update(1), keys.auth(0)])
  return create({ profile: webvh(host), updateKey: u0, next: [u1.pubRaw], authKey: a0.pubRaw, time })
}

export type Mode = 'cross-device' | 'same-device'
export type Login = { user: string }
/** One login attempt: one request, one nonce, bound to the browser that started it. */
interface Attempt { id: string, nonce: string, state: string, requestId: string, created: number, mode: Mode, jwt: string, code?: string }
/** How an attempt ended, for the waiting browser (cross-device). */
type Outcome = { at: number, login: Login } | { at: number, error: 'user_cancelled' | 'refused' }
interface Code { attempt: string, login: Login, created: number }

/** What the answer endpoint returns: HTTP status and JSON body. */
export type Reply = { status: number, body: Record<string, unknown> }
/** What collecting or redeeming gives: a fresh signed-in session, or why not. */
export type Collected = { session: string, login: Login } | { error: 'user_cancelled' | 'refused' } | null

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
/** A nonce that is never issued (issued ones are 16 random bytes): a store step that touches no nonce. */
const NO_NONCE = ''

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
  private readonly attempts = new Map<string, Attempt>()       // state -> attempt
  private readonly byRequestId = new Map<string, string>()     // request id -> state
  private readonly byNonce = new Map<string, string>()         // nonce -> state
  private readonly byAttempt = new Map<string, string>()       // attempt id -> state
  private readonly outcomes = new Map<string, Outcome>()       // attempt id -> how it ended (cross-device)
  private readonly codes = new Map<string, Code>()
  private readonly sessions = new Map<string, { login: Login, at: number }>()

  private constructor (readonly o: ServiceOptions & { log: Entry[], head: Version, did: string, origin: string }) {
    this.log = o.log; this.head = o.head
    this.did = o.did
    this.clientId = CLIENT_ID_PREFIX + o.did
    this.origin = o.origin
    this.redirectUri = this.origin + RESPONSE_PATH
    this.returnUri = this.origin + RETURN_PATH
    this.store = o.store ?? new MemoryStore()
    // the verifier's one step per DID also ends the attempt and hands out the login (see `step`)
    const inner = this.store
    const stepped: Store = {
      issue: (n, e, t) => inner.issue(n, e, t),
      read: (d) => inner.read(d),
      transact: (did, nonce, clock, decide) => inner.transact(did, nonce, clock, (held, ns, now) => this.step(nonce, now, () => decide(held, ns, now))),
    }
    this.verifier = new Verifier({ profile: o.identityProfile ?? vh, audience: this.clientId, now: () => new Date(o.now()), store: stepped, nonceTtlSec: REQUEST_LIFETIME_S })
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
    await this.publish(await rotate(this.log, { signer, next: [next.pubRaw], authKey: auth.pubRaw, time: this.nextTime() }))
    this.keyIndex = n
  }

  /** The service ends its DID (did:webvh 1.0, Deactivate). */
  async deactivate (): Promise<void> {
    await this.publish(await deactivate(this.log, { signer: await this.o.keys.update(this.keyIndex + 1), time: this.nextTime() }))
  }

  private nextTime (): string { return isoSeconds(Math.max(Math.floor(this.o.now() / 1000) * 1000, Date.parse(this.head.versionTime) + 1000)) }
  private async publish (log: Entry[]): Promise<void> {
    const check = await verify(log, { profile: webvh(this.o.host), now: new Date(Math.max(this.o.now(), Date.parse((log[log.length - 1] as Entry).versionTime))), did: this.did })
    if (!check.ok) throw new Error(`service log: ${check.reason}`)
    this.log = check.log; this.head = check.head
  }

  /** A browser asks to log in: a fresh attempt with a signed Request Object behind a request_uri, and the outer link. */
  async start (mode: Mode = 'cross-device'): Promise<{ attempt: string, link: string, requestUri: string, state: string }> {
    const now = this.o.now()
    const nonce = this.o.fixed?.nonce ?? await this.verifier.issueNonce()
    if (this.o.fixed) await this.issueFixedNonce(nonce)
    const state = this.o.fixed?.state ?? b64uOf(rand(16))
    const requestId = this.o.fixed?.requestId ?? b64uOf(rand(16))
    const id = b64uOf(rand(16))
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
    this.attempts.set(state, { id, nonce, state, requestId, created: now, mode, jwt })
    this.byRequestId.set(requestId, state); this.byNonce.set(nonce, state); this.byAttempt.set(id, state)
    const requestUri = this.origin + REQUEST_PATH + requestId
    return { attempt: id, link: outerLink(this.clientId, requestUri), requestUri, state }
  }

  /** The vector uses a fixed nonce; the verifier admits only nonces in its store, so it is put there. */
  private async issueFixedNonce (nonce: string): Promise<void> {
    const now = this.o.now()
    await this.store.issue(nonce, now + REQUEST_LIFETIME_MS, now)
  }

  private open (a: Attempt | undefined, now: number): a is Attempt {
    return a !== undefined && this.attempts.get(a.state) === a && now - a.created <= REQUEST_LIFETIME_MS
  }
  private end (a: Attempt): void {
    this.attempts.delete(a.state); this.byRequestId.delete(a.requestId); this.byNonce.delete(a.nonce); this.byAttempt.delete(a.id)
  }

  /** GET request_uri: the Request Object while its attempt is open. */
  requestObject (requestId: string): string | null {
    const a = this.attempts.get(this.byRequestId.get(requestId) ?? '')
    return this.open(a, this.o.now()) ? a.jwt : null
  }

  /**
   * Inside the verifier's step for the nonce of one attempt (no await): the
   * attempt must still be open, or nothing is decided and nothing kept (a
   * forgotten or expired attempt). Then the verifier decides, the attempt ends
   * (the store spends the nonce in the same step), and a good login is handed
   * out: to the waiting browser, or as a one-time code for the same device.
   */
  private step<T> (nonce: string, now: number, decide: () => { held?: Held, result: T }): { held?: Held, result: T } {
    const a = this.attempts.get(this.byNonce.get(nonce) ?? '')
    if (!this.open(a, now)) return { result: { kind: 'invalid', reason: 'the request is no longer open' } as T }
    const out = decide()
    this.end(a)
    const r = out.result as LoginResult
    if (r.kind === 'ok') {
      if (a.mode === 'same-device') {
        a.code = this.o.fixed ? 'response-code' : b64uOf(rand(16))
        this.codes.set(a.code, { attempt: a.id, login: { user: r.did }, created: now })
      } else this.outcomes.set(a.id, { at: now, login: { user: r.did } })
    } else if (a.mode === 'cross-device') this.outcomes.set(a.id, { at: now, error: 'refused' })
    return out
  }

  /**
   * The answer at the redirect_uri (direct_post, form-encoded): `id_token`,
   * `state` and the person's log in `did_log`; or `error` and `state`.
   * What ends an attempt: an answer that reaches the verifier's step, and
   * `user_cancelled`; both end the attempt and spend its nonce in one step.
   * Anything else (no log, an unreadable log, no token, another error) is
   * answered and leaves the attempt open.
   */
  async receive (form: URLSearchParams): Promise<Reply> {
    const fail = (status: number, error: string, description: string, extra: Record<string, unknown> = {}): Reply => ({ status, body: { error, error_description: description, ...extra } })
    const a = this.attempts.get(form.get('state') ?? '')
    if (!a) return fail(400, 'invalid_request', 'unknown request')
    if (!this.open(a, this.o.now())) return fail(400, 'invalid_request', 'request expired')
    const error = form.get('error')
    if (error !== null) {
      if (error === 'user_cancelled') {
        await this.store.transact(NO_NONCE, a.nonce, () => this.o.now(), (_h, _n, now) => {
          if (this.open(a, now)) { this.end(a); if (a.mode === 'cross-device') this.outcomes.set(a.id, { at: now, error: 'user_cancelled' }) }
          return { result: null }
        })
      }
      return { status: 200, body: {} }                      // OpenID4VP 1.0: an error response processed, 200 with JSON
    }
    const logText = form.get(DID_LOG_FIELD)
    const log = typeof logText === 'string' ? fromJsonl(logText) : null
    if (log === null) return fail(400, 'invalid_request', `${DID_LOG_FIELD} is not a DID log in JSON Lines`, { did_log_result: 'invalid' })
    const token = form.get('id_token')
    if (!token) return fail(400, 'invalid_request', 'id_token is missing')
    const r = await this.verifier.login({ log, token, nonce: a.nonce })
    if (r.kind !== 'ok') {
      const extra = r.kind === 'stale' ? { held_version_id: r.held } : {}
      return fail(400, 'invalid_request', 'reason' in r ? r.reason : r.kind, { did_log_result: r.kind, ...extra })
    }
    if (a.code !== undefined) {
      const u = new URL(this.returnUri); u.searchParams.set('response_code', a.code)
      return { status: 200, body: { redirect_uri: u.href } }
    }
    return { status: 200, body: {} }
  }

  /**
   * A login handed out becomes a session in one step with a fresh look at the
   * identifier: contested or deactivated by now, there is no session.
   */
  private async issue (login: Login): Promise<Collected> {
    return this.store.transact<Collected>(login.user, NO_NONCE, () => this.o.now(), (held, _n, now) => {
      if (!held || held.contested || held.head.deactivated) return { result: { error: 'refused' } }
      const session = b64uOf(rand(16))
      this.sessions.set(session, { login, at: now })
      return { result: { session, login } }
    })
  }

  /** Cross-device: what became of an attempt, exactly once, within its pickup window. */
  async collect (attempt: string): Promise<Collected> {
    const o = this.outcomes.get(attempt)
    this.outcomes.delete(attempt)
    if (!o || this.o.now() - o.at > PICKUP_LIFETIME_MS) return null
    if ('error' in o) return { error: o.error }
    return this.issue(o.login)
  }

  /** Same-device: the code is used up by the first attempt, right or wrong, and counts only for its attempt. */
  async redeem (attempt: string, code: string): Promise<Collected> {
    const c = this.codes.get(code)
    this.codes.delete(code)
    if (!c || this.o.now() - c.created > CODE_LIFETIME_MS || c.attempt !== attempt) return null
    return this.issue(c.login)
  }

  /** The signed-in account of a session, within its lifetime. */
  session (id: string): Login | null {
    const s = this.sessions.get(id)
    return s && this.o.now() - s.at <= SESSION_LIFETIME_MS ? s.login : null
  }

  /** The browser gives an attempt up: it ends, and an answer being checked for it decides and keeps nothing. */
  forget (attempt: string): void {
    const a = this.attempts.get(this.byAttempt.get(attempt) ?? '')
    if (a) this.end(a)
    this.outcomes.delete(attempt)
    for (const [k, c] of this.codes) if (c.attempt === attempt) this.codes.delete(k)
  }

  /** Drop what has run out: attempts past their lifetime, outcomes nobody collected, codes, sessions. */
  sweep (): void {
    const now = this.o.now()
    for (const a of this.attempts.values()) if (!this.open(a, now)) this.end(a)
    for (const [k, o] of this.outcomes) if (now - o.at > PICKUP_LIFETIME_MS) this.outcomes.delete(k)
    for (const [k, c] of this.codes) if (now - c.created > CODE_LIFETIME_MS) this.codes.delete(k)
    for (const [k, s] of this.sessions) if (now - s.at > SESSION_LIFETIME_MS) this.sessions.delete(k)
  }

  /** What the service holds of a person's identifier (the verifier's copy). */
  holding (did: string) { return this.verifier.holding(did) }

  held (): { attempts: number, outcomes: number, codes: number, sessions: number } {
    return { attempts: this.attempts.size, outcomes: this.outcomes.size, codes: this.codes.size, sessions: this.sessions.size }
  }
}
