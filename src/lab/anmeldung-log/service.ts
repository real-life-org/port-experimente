// The service (Relying Party): its own did:webvh, a signed Request Object per
// login, and the answer checked by the stateful verifier of kennung-log.
//
// The lifecycle of one login follows src/lab/anmeldung/webapp.ts (rebuilt
// here, that module stays as it is):
// 1. started: each start is a fresh attempt with its own id, request, nonce
//    and state, one window (profile.ts `windowFrom`: request iat/exp and the
//    nonce's expiry from one moment, half-open at exp); a link is returned
//    only if, in a store step, that window holds and the nonce is open;
// 2. answered: only an admitted login ends the attempt, in the verifier's
//    step that spends the attempt's nonce, and it is handed out there
//    (cross-device: to the waiting browser; same-device: a one-time
//    response_code in the redirect_uri of the HTTP answer). A refused or
//    misdirected answer, and `user_cancelled`, leave attempt and nonce open
//    (the waiting browser is told, as a notice);
// 3. collected or redeemed exactly once, within its window: a session is issued
//    in one store step with a fresh look at the identifier (contested: no
//    session); the window is read in that step, with its time;
// 4. closed for good without a login: by the browser that started it
//    (`forget`, which spends the nonce in one store step) or by running out.
// Transport-free; http.ts puts it behind HTTP.
//
// The service's maps change in a store step only inside that step
// (`Journal`), and are put back if the step fails or is tried again.

import { b64uOf, edFromSeed, hkdf, rand, type KeyPair } from 'rltp-lib'
import { create, deactivate, fromJsonl, keyHash, loginKeys, multikey, rotate, toJsonl, verify, type Entry, type Profile, type Version } from '../kennung-log/log'
import { vh, webvh } from '../kennung-log/profiles'
import { MemoryStore, Verifier, type Held, type NonceState, type Store } from '../kennung-log/verifier'
import { subjectSyntaxOf, CLIENT_ID_PREFIX, DID_LOG_FIELD, ID_TOKEN_TYPE, outerLink, REQUEST_LIFETIME_S, SIOP_AUD, signRequestObject, windowFrom, windowHolds, type RequestClaims } from './profile'

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
  readonly #seed: Uint8Array
  /** The seed is copied: changing the array handed in changes no key. */
  constructor (seed: Uint8Array) { this.#seed = new Uint8Array(seed) }
  static random (): ServiceKeys { return new ServiceKeys(rand(32)) }
  update (n: number): Promise<KeyPair> { return this.#key('update', n) }
  auth (n: number): Promise<KeyPair> { return this.#key('auth', n) }
  async #key (role: 'update' | 'auth', n: number): Promise<KeyPair> { return edFromSeed(await hkdf(this.#seed, serviceKeyInfo(role, n))) }
}

/** The first entry of a service's did:webvh log, with update key 0, committed to update key 1, and auth key 0. */
export async function serviceLog (host: string, keys: ServiceKeys, time: string): Promise<Entry[]> {
  const [u0, u1, a0] = await Promise.all([keys.update(0), keys.update(1), keys.auth(0)])
  return create({ profile: webvh(host), updateKey: u0, next: [u1.pubRaw], authKey: a0.pubRaw, time })
}

/**
 * The verifier's store with the two further steps the service needs. Each
 * runs its callback synchronously inside the step; a store that retries a
 * step calls it again; a step that fails rejects.
 */
export interface LoginStore extends Store {
  /** An attempt ends for good without a login: its nonce is spent (no answer can be admitted under it any more), and `apply` runs in the same step. */
  closeAttempt (nonce: string, clock: () => number, apply: (now: number) => void): Promise<void>
  /** A session is issued: one step that reads what is held of `did` and runs `decide`; it writes nothing to the store. */
  issueSession<T> (did: string, clock: () => number, decide: (held: Held | undefined, now: number) => T): Promise<T>
  /** One step that reads the nonce's state at the time of the step and runs `decide`; it writes nothing. */
  inspectNonce<T> (nonce: string, clock: () => number, decide: (state: NonceState, now: number) => T): Promise<T>
}

export class MemoryLoginStore extends MemoryStore implements LoginStore {
  async closeAttempt (nonce: string, clock: () => number, apply: (now: number) => void): Promise<void> {
    // no await: one step
    const now = clock()
    apply(now)
    const n = this.nonces.get(nonce)
    if (n) n.spent = true
  }
  async issueSession<T> (did: string, clock: () => number, decide: (held: Held | undefined, now: number) => T): Promise<T> {
    const now = clock()
    const h = this.held.get(did)
    return decide(h && structuredClone(h), now)
  }
  async inspectNonce<T> (nonce: string, clock: () => number, decide: (state: NonceState, now: number) => T): Promise<T> {
    const now = clock()
    return decide(this.nonceState(nonce, now), now)
  }
  /** What a nonce is at `now` (tests). */
  peek (nonce: string, now: number): NonceState { return this.nonceState(nonce, now) }
}

/** Changes to the service's maps inside one store step, so they can be put back. */
class Journal {
  private undo: (() => void)[] = []
  set<K, V> (m: Map<K, V>, k: K, v: V): void {
    const had = m.has(k), old = m.get(k)
    this.undo.push(() => { if (had) m.set(k, old as V); else m.delete(k) })
    m.set(k, v)
  }
  delete<K, V> (m: Map<K, V>, k: K): void {
    if (!m.has(k)) return
    const old = m.get(k) as V
    this.undo.push(() => { m.set(k, old) })
    m.delete(k)
  }
  /** Put back what this journal changed (before a retry of the step, or when it failed). */
  rollback (): void { while (this.undo.length > 0) (this.undo.pop() as () => void)() }
  /** Run a store step whose callbacks write through this journal; a failed step is put back. */
  async run<T> (step: Promise<T>): Promise<T> {
    try { return await step } catch (e) { this.rollback(); throw e }
  }
}

export type Mode = 'cross-device' | 'same-device'
export type Login = { user: string }
/**
 * One login attempt: one request, one nonce, bound to the browser that
 * started it. `closed` is set once `forget` has spent its nonce; it is never
 * put back, so a store step that fails afterwards and restores the maps
 * cannot open the attempt again. `givenUp` is set by `forget` before any
 * pause: from then on nothing is admitted, collected or redeemed for it.
 */
interface Attempt { id: string, nonce: string, state: string, requestId: string, window: { iat: number, nbf: number, exp: number }, mode: Mode, jwt: string, closed?: true, givenUp?: true }
/**
 * An admitted login handed out (cross-device: the outcome for the waiting
 * browser; same-device: the code). It carries its attempt, so `forget` finds
 * the nonce also while the attempt is out of the maps. `ready` is set once
 * the store step that admitted it has been written; before that nothing
 * takes it.
 */
type Outcome = { at: number, login: Login, attempt: Attempt, ready: boolean }
/** What the waiting browser is told while its attempt stays open: the person cancelled, or an answer was refused. */
export type Notice = 'user_cancelled' | 'refused'
interface Code { attempt: Attempt, login: Login, created: number, ready: boolean }

/** What the answer endpoint returns: HTTP status and JSON body. */
export type Reply = { status: number, body: Record<string, unknown> }
/**
 * What collecting or redeeming gives: a fresh signed-in session; a final
 * refusal (the identifier is contested or deactivated by now); a notice
 * while the attempt stays open; or nothing.
 */
export type Collected = { session: string, login: Login } | { error: 'refused' } | { notice: Notice } | null

export interface ServiceOptions {
  /** The host part of the DID after the SCID, e.g. `dienst.example%3A8443` (did:webvh syntax, port encoded). */
  host: string
  keys: ServiceKeys
  now: () => number
  /** The name shown as text beside the host (client_metadata.client_name). */
  name?: string
  /** The method of the persons' identifiers (default did:vh, kennung-log/profiles.ts). */
  identityProfile?: Profile
  /** The store (default in memory). */
  store?: LoginStore
  /** A log written earlier (fixed vectors); otherwise one is created at `now`. */
  log?: Entry[]
  /** Fixed values for the vector; random otherwise. */
  fixed?: { nonce: string, state: string, requestId: string }
}

/** The `kid` of the request signing key under one head: `<did>#<fragment>` of its document. */
const kidOfHead = (head: Version): string => (loginKeys(head.doc)[0] as { id: string }).id

const isoSeconds = (ms: number): string => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.000Z$/, 'Z')

/**
 * The key state of the service in a log that exists: the index n whose
 * derived authentication key is the one `loginKeys(head)` returns, with the
 * head's update key and its pre-rotation commitment being update keys n and
 * n + 1 of the same keys. Throws when the head is deactivated or the keys do
 * not match, so the service never signs with a key the head does not name.
 */
async function keyIndexOf (keys: ServiceKeys, head: Version, entries: number): Promise<number> {
  if (head.deactivated) throw new Error('service log: the DID is deactivated, the service cannot be opened on it')
  const login = loginKeys(head.doc)
  if (login.length !== 1) throw new Error('service log: the head must name exactly one login key')
  const want = multikey((login[0] as { raw: Uint8Array }).raw)
  for (let n = 0; n <= entries; n++) {
    if (multikey((await keys.auth(n)).pubRaw) !== want) continue
    const [u, next] = await Promise.all([keys.update(n), keys.update(n + 1)])
    const nextHash = await keyHash(multikey(next.pubRaw))
    if (head.updateKeys.length === 1 && head.updateKeys[0] === multikey(u.pubRaw) && head.nextKeyHashes.length === 1 && head.nextKeyHashes[0] === nextHash) return n
    throw new Error('service log: the update key and the pre-rotation commitment of the head do not match the service keys')
  }
  throw new Error('service log: none of the service keys is the login key of the head')
}

/**
 * What the service signs with: its log, the head, and the index of the
 * service keys the head names. One value, replaced as a whole and only by
 * `publish`; whoever signs or changes it reads it once, before any pause.
 */
interface KeyState { readonly log: Entry[], readonly head: Version, readonly index: number }

/** What the service keeps of its options: a copy, without the log (the log lives only in the key state). */
type Options = Omit<ServiceOptions, 'log'>

/** Why no request is signed and no change is made from this key state, or null: a deactivated DID ends both. */
const ended = (k: KeyState): string | null => k.head.deactivated ? 'service log: the service DID is deactivated; no login is started and no change is made' : null

/**
 * Every field is a JavaScript private field (`#`): the key state, the maps
 * and the store are out of reach of any caller. What goes out is a copy
 * (the log as text, a login as a new object).
 */
export class Service {
  #keyState: KeyState
  readonly #o: Options
  readonly #did: string
  readonly #origin: string
  readonly #verifier: Verifier
  readonly #store: LoginStore
  readonly #attempts = new Map<string, Attempt>()       // state -> attempt
  readonly #byRequestId = new Map<string, string>()     // request id -> state
  readonly #byNonce = new Map<string, string>()         // nonce -> state
  readonly #byAttempt = new Map<string, string>()       // attempt id -> state
  readonly #outcomes = new Map<string, Outcome>()       // attempt id -> the admitted login (cross-device)
  readonly #notices = new Map<string, Notice>()         // attempt id -> what the waiting browser is told while it stays open
  readonly #codes = new Map<string, Code>()
  readonly #sessions = new Map<string, { login: Login, at: number }>()
  /**
   * Every attempt this service issued, by id, until its windows have run
   * out. `forget` finds its attempt here and nowhere else, so an id the
   * service never issued leaves nothing behind, and an attempt that a
   * pending store step has taken out of the other maps is still found. That
   * it was given up is written on the attempt itself (`givenUp`).
   */
  readonly #issued = new Map<string, Attempt>()

  private constructor (o: ServiceOptions, k: { log: Entry[], head: Version, did: string, origin: string, keyIndex: number }) {
    const { log: _given, ...rest } = o
    this.#o = { ...rest, ...(o.fixed ? { fixed: { ...o.fixed } } : {}) }
    this.#keyState = { log: k.log, head: k.head, index: k.keyIndex }
    this.#did = k.did
    this.#origin = k.origin
    this.#store = o.store ?? new MemoryLoginStore()
    const now = o.now
    this.#verifier = new Verifier({ profile: o.identityProfile ?? vh, audience: this.clientId, now: () => new Date(now()), store: this.#store })
  }

  /** A service with its own did:webvh: a log is created at `now` unless one is given. */
  static async create (o: ServiceOptions): Promise<Service> {
    const m = /^(.*?)(?:%3[Aa]([0-9]{1,5}))?(?::|$)/.exec(o.host)
    if (!m) throw new Error('service host: not the host part of a did:webvh')
    const log = o.log ?? await serviceLog(o.host, o.keys, isoSeconds(o.now()))
    const check = await verify(log, { profile: webvh(o.host), now: new Date(o.now()) })
    if (!check.ok) throw new Error(`service log: ${check.reason}`)
    const origin = new URL(`https://${m[1]}${m[2] ? ':' + m[2] : ''}`).origin
    const keyIndex = await keyIndexOf(o.keys, check.head, check.log.length)
    return new Service(o, { log: check.log, head: check.head, did: check.did, origin, keyIndex })
  }

  get did (): string { return this.#did }
  get clientId (): string { return CLIENT_ID_PREFIX + this.#did }
  get origin (): string { return this.#origin }
  get redirectUri (): string { return this.#origin + RESPONSE_PATH }
  get returnUri (): string { return this.#origin + RETURN_PATH }
  /** The host part of the DID after the SCID, as given. */
  get host (): string { return this.#o.host }

  /** The log as served at the did:webvh location (JSON Lines). */
  didLog (): string { return toJsonl(this.#keyState.log) }
  get scid (): string { return (this.#keyState.log[0] as Entry).parameters.scid as string }
  get headVersion (): string { return this.#keyState.head.versionId }
  /** The `kid` of the request signing key: `<did>#<fragment>` of the head's document. */
  get kid (): string { return kidOfHead(this.#keyState.head) }

  /** The service changes its key: the committed update key signs, the document gets the next authentication key. */
  async rotateKey (): Promise<void> {
    const from = this.#keyState, n = from.index + 1
    const no = ended(from)
    if (no) throw new Error(no)
    const [signer, next, auth] = await Promise.all([this.#o.keys.update(n), this.#o.keys.update(n + 1), this.#o.keys.auth(n)])
    await this.#publish(from, await rotate(from.log, { signer, next: [next.pubRaw], authKey: auth.pubRaw, time: this.#nextTime(from) }), n)
  }

  /** The service ends its DID (did:webvh 1.0, Deactivate). */
  async deactivate (): Promise<void> {
    const from = this.#keyState
    const no = ended(from)
    if (no) throw new Error(no)
    await this.#publish(from, await deactivate(from.log, { signer: await this.#o.keys.update(from.index + 1), time: this.#nextTime(from) }), from.index)
  }

  #nextTime (from: KeyState): string { return isoSeconds(Math.max(Math.floor(this.#o.now() / 1000) * 1000, Date.parse(from.head.versionTime) + 1000)) }
  /**
   * A change made from the key state `from` is taken only if that is still
   * the key state: no change is built on a state that has moved meanwhile.
   * The new log is verified against the service's clock as it stands, with
   * the tolerance of kennung-log/log.ts (the one a wallet on the same clock
   * uses): an entry that clock takes as in the future is not published, and
   * the caller tries again later.
   */
  async #publish (from: KeyState, log: Entry[], index: number): Promise<void> {
    const check = await verify(log, { profile: webvh(this.#o.host), now: new Date(this.#o.now()), did: this.#did })
    if (!check.ok) throw new Error(`service log: ${check.reason}`)
    // no await from the comparison to the write
    if (this.#keyState !== from) throw new Error('service log: changed meanwhile by another change; this one is not published')
    this.#keyState = { log: check.log, head: check.head, index }
  }

  /** A browser asks to log in: a fresh attempt with a signed Request Object behind a request_uri, and the outer link. */
  async start (mode: Mode = 'cross-device'): Promise<{ attempt: string, link: string, requestUri: string, state: string }> {
    const o = this.#o
    const state = o.fixed?.state ?? b64uOf(rand(16))
    const requestId = o.fixed?.requestId ?? b64uOf(rand(16))
    const id = b64uOf(rand(16))
    // One window per try, from one moment: the request's iat/nbf/exp and the nonce's expiry. The key state
    // (log, head, key index) and the moment are read together, before any pause; a deactivated head ends the
    // start there. The link is returned only if, in a store step, the window still holds (profile.ts, one rule)
    // and the nonce is open, and the key state is still the one signed under; otherwise the nonce of that try is
    // spent and the next try reads the key state anew (deactivated by then: no link) and gets a new window and a
    // new nonce. So a link that is returned is one a wallet can take at that moment.
    let made: { jwt: string, nonce: string, window: Attempt['window'] } | null = null
    for (let i = 0; i < 3 && made === null; i++) {
      const k = this.#keyState, at = o.now()
      const no = ended(k)
      if (no) throw new Error(no)
      const window = windowFrom(at)
      const nonce = o.fixed?.nonce ?? b64uOf(rand(16))
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
        client_metadata: { subject_syntax_types_supported: [subjectSyntaxOf(o.identityProfile ?? vh)], ...(o.name ? { client_name: o.name } : {}) },
        ...window,
      }
      const jwt = await signRequestObject(await o.keys.auth(k.index), kidOfHead(k.head), claims)
      // the nonce expires with the window, whenever this step runs (the vector uses a fixed nonce)
      await this.#store.issue(nonce, window.exp * 1000, o.now())
      const usable = await this.#store.inspectNonce(nonce, () => o.now(), (ns, now) => ns === 'open' && windowHolds(window, now))
      // The step decided at the time it read; the answer reaches this line later. From here to the registration
      // below there is no await, so the window and the key state are checked again at this moment.
      if (usable && windowHolds(window, o.now()) && this.#keyState === k) made = { jwt, nonce, window }
      // a try that failed spends its nonce (a fixed nonce is issued again by the next try)
      else if (!o.fixed) await this.#store.closeAttempt(nonce, () => o.now(), () => {})
    }
    if (made === null) throw new Error('the service key or the clock kept moving while a request was signed')
    // no await from the last check (the line above the loop's end) to the return: the attempt is registered and the link given at that moment
    const { jwt, nonce, window } = made
    const attempt: Attempt = { id, nonce, state, requestId, window, mode, jwt }
    this.#attempts.set(state, attempt); this.#issued.set(id, attempt)
    this.#byRequestId.set(requestId, state); this.#byNonce.set(nonce, state); this.#byAttempt.set(id, state)
    const requestUri = this.#origin + REQUEST_PATH + requestId
    return { attempt: id, link: outerLink(this.clientId, requestUri), requestUri, state }
  }

  #open (a: Attempt | undefined, now: number): a is Attempt {
    return a !== undefined && !a.closed && !a.givenUp && this.#attempts.get(a.state) === a && windowHolds(a.window, now)
  }
  #end (a: Attempt, j: Journal): void {
    j.delete(this.#attempts, a.state); j.delete(this.#byRequestId, a.requestId); j.delete(this.#byNonce, a.nonce); j.delete(this.#byAttempt, a.id)
    j.delete(this.#notices, a.id)
  }

  /** GET request_uri: the Request Object while its attempt is open. */
  requestObject (requestId: string): string | null {
    const a = this.#attempts.get(this.#byRequestId.get(requestId) ?? '')
    return this.#open(a, this.#o.now()) ? a.jwt : null
  }

  /**
   * The answer at the redirect_uri (direct_post, form-encoded): `id_token`,
   * `state` and the person's log in `did_log`; or `error` and `state`.
   *
   * What ends an attempt: only a login the verifier admits for this
   * attempt's nonce (signature, `iss`/`sub`, audience, time, the nonce of
   * this open attempt, and the account check), in the verifier's step that
   * spends the nonce; the login is handed out in that same step, and can be
   * taken once that step has been written. Everything else leaves the
   * attempt and its nonce open: a refused answer (the verifier may still keep
   * a verified continuation, a fork, a deactivation), an answer for another
   * attempt, an unreadable one, and `user_cancelled`, which is acknowledged
   * and shown to the waiting browser.
   */
  async receive (form: URLSearchParams): Promise<Reply> {
    const fail = (status: number, error: string, description: string, extra: Record<string, unknown> = {}): Reply => ({ status, body: { error, error_description: description, ...extra } })
    const a = this.#attempts.get(form.get('state') ?? '')
    if (!a) return fail(400, 'invalid_request', 'unknown request')
    if (!this.#open(a, this.#o.now())) return fail(400, 'invalid_request', 'the request is no longer open')
    const error = form.get('error')
    if (error !== null) {
      if (error === 'user_cancelled' && a.mode === 'cross-device') this.#notices.set(a.id, 'user_cancelled')
      return { status: 200, body: {} }                      // OpenID4VP 1.0: an error response processed, 200 with JSON
    }
    const logText = form.get(DID_LOG_FIELD)
    const log = typeof logText === 'string' ? fromJsonl(logText) : null
    if (log === null) return fail(400, 'invalid_request', `${DID_LOG_FIELD} is not a DID log in JSON Lines`, { did_log_result: 'invalid' })
    const token = form.get('id_token')
    if (!token) return fail(400, 'invalid_request', 'id_token is missing')
    const j = new Journal()
    let code: string | undefined
    let handed: Outcome | Code | undefined
    let reached = false
    const r = await j.run(this.#verifier.login({ log, token, nonce: a.nonce }, {
      // a forgotten or expired attempt: nothing is decided, nothing kept
      before: (now) => { j.rollback(); code = undefined; handed = undefined; reached = true; return this.#open(a, now) ? null : 'the request is no longer open' },
      // admitted: the attempt ends and the login is handed out, in the step that spends the nonce
      admit: (ok, now) => {
        this.#end(a, j)
        if (a.mode === 'same-device') {
          code = this.#o.fixed ? 'response-code' : b64uOf(rand(16))
          handed = { attempt: a, login: { user: ok.did }, created: now, ready: false }
          j.set(this.#codes, code, handed)
        } else {
          handed = { at: now, login: { user: ok.did }, attempt: a, ready: false }
          j.set(this.#outcomes, a.id, handed)
        }
        return null
      },
    }))
    // the step is written: what it handed out can be taken from now on (no await since the step returned)
    if (r.kind === 'ok' && handed) handed.ready = true
    if (r.kind !== 'ok') {
      // the waiting browser is told of an answer that reached the step and was refused; its attempt stays open
      if (reached && a.mode === 'cross-device' && this.#open(a, this.#o.now())) this.#notices.set(a.id, 'refused')
      const extra = r.kind === 'stale' ? { held_version_id: r.held } : {}
      return fail(400, 'invalid_request', 'reason' in r ? r.reason : r.kind, { did_log_result: r.kind, ...extra })
    }
    if (code !== undefined) {
      const u = new URL(this.returnUri); u.searchParams.set('response_code', code)
      return { status: 200, body: { redirect_uri: u.href } }
    }
    return { status: 200, body: {} }
  }

  /**
   * A login handed out becomes a session in one store step with a fresh look
   * at the identifier: contested or deactivated by now, there is no session.
   * `take` removes what was handed out (the outcome or the code), in the same
   * step, and says whether it was there and still within its window. It
   * reads the window against `now`, the time the store gives the step: the
   * only place the window is decided. The caller gets its own copy of the login.
   */
  async #issue (login: Login, take: (j: Journal, now: number) => boolean): Promise<Collected> {
    const j = new Journal()
    return j.run(this.#store.issueSession<Collected>(login.user, () => this.#o.now(), (held, now) => {
      j.rollback()
      if (!take(j, now)) return null
      if (!held || held.contested || held.head.deactivated) return { error: 'refused' }
      const session = b64uOf(rand(16))
      j.set(this.#sessions, session, { login: { user: login.user }, at: now })
      return { session, login: { user: login.user } }
    }))
  }

  /** Cross-device: an admitted login, exactly once, within its pickup window; otherwise a notice while the attempt is open. */
  async collect (attempt: string): Promise<Collected> {
    const o = this.#outcomes.get(attempt)
    if (o?.ready) {
      // present or not, within its window or not: decided in the store step, with its time
      const done = await this.#issue(o.login, (j, now) => {
        if (this.#outcomes.get(attempt) !== o || !o.ready) return false
        j.delete(this.#outcomes, attempt)
        return !o.attempt.givenUp && now - o.at <= PICKUP_LIFETIME_MS
      })
      if (done) return done
    }
    const n = this.#notices.get(attempt)
    const a = this.#attempts.get(this.#byAttempt.get(attempt) ?? '')
    return n && this.#open(a, this.#o.now()) ? { notice: n } : null
  }

  /** Same-device: the code is used up by the first attempt, right or wrong, and counts only for its attempt. */
  async redeem (attempt: string, code: string): Promise<Collected> {
    const c = this.#codes.get(code)
    if (!c?.ready) return null
    // used up by the first attempt, right or wrong; the window is read in the step
    return this.#issue(c.login, (j, now) => {
      if (this.#codes.get(code) !== c) return false
      j.delete(this.#codes, code)
      return !c.attempt.givenUp && now - c.created <= CODE_LIFETIME_MS && c.attempt.id === attempt
    })
  }

  /** The signed-in account of a session, within its lifetime (a copy). */
  session (id: string): Login | null {
    const s = this.#sessions.get(id)
    return s && this.#o.now() - s.at <= SESSION_LIFETIME_MS ? { user: s.login.user } : null
  }

  /**
   * The browser that started an attempt gives it up: it ends for good, its
   * nonce is spent in the same store step, and an answer being checked for it
   * decides and keeps nothing. The nonce is spent whenever the attempt is
   * known: from the maps, or, while the step of an admitted answer for it is
   * not yet written (the attempt is out of the maps then), from what that
   * answer handed out. Should that step still fail and put the attempt back,
   * the attempt stays closed and its nonce spent.
   */
  async forget (attempt: string): Promise<void> {
    // only an attempt this service issued (an unknown id leaves nothing behind); marked first, before any pause:
    // from here on nothing is admitted, collected or redeemed for it, whatever a pending store step holds or puts back
    const a = this.#issued.get(attempt)
    if (!a) return
    a.givenUp = true
    const j = new Journal()
    const clear = (): void => {
      j.delete(this.#outcomes, attempt); j.delete(this.#notices, attempt)
      for (const [k, c] of this.#codes) if (c.attempt.id === attempt) j.delete(this.#codes, k)
    }
    await j.run(this.#store.closeAttempt(a.nonce, () => this.#o.now(), () => { j.rollback(); if (this.#attempts.get(a.state) === a) this.#end(a, j); clear() }))
    // the step is written (no await since it returned): closed for good, also against a step that puts the maps back later
    a.closed = true
  }

  /** Drop what has run out: attempts past their lifetime (their nonces have expired with them) or closed, outcomes nobody collected, codes, sessions. */
  sweep (): void {
    const now = this.#o.now()
    const j = new Journal()
    for (const a of this.#attempts.values()) if (!this.#open(a, now)) this.#end(a, j)
    for (const [k, o] of this.#outcomes) if (now - o.at > PICKUP_LIFETIME_MS) this.#outcomes.delete(k)
    for (const k of this.#notices.keys()) if (!this.#byAttempt.has(k)) this.#notices.delete(k)
    for (const [k, c] of this.#codes) if (now - c.created > CODE_LIFETIME_MS) this.#codes.delete(k)
    for (const [k, s] of this.#sessions) if (now - s.at > SESSION_LIFETIME_MS) this.#sessions.delete(k)
    // an attempt is known until everything it can still have has run out: an answer within its request window, then a pickup within its own
    for (const [k, a] of this.#issued) if (now > a.window.exp * 1000 + PICKUP_LIFETIME_MS) this.#issued.delete(k)
  }

  /** What the service holds of a person's identifier (the verifier's copy). */
  holding (did: string) { return this.#verifier.holding(did) }

  /** How many issued attempts the service still knows (tests). */
  known (): number { return this.#issued.size }

  held (): { attempts: number, outcomes: number, notices: number, codes: number, sessions: number } {
    return { attempts: this.#attempts.size, outcomes: this.#outcomes.size, notices: this.#notices.size, codes: this.#codes.size, sessions: this.#sessions.size }
  }
}
