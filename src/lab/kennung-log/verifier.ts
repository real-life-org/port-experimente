// The verifier of a service that holds state: one verifier, one copy of each
// identifier's log. It applies what did:vh calls "Applying Peer-to-Peer
// Updates" to the log that comes with each login, and checks the login
// token against the head of the log it then holds.
//
// The token is a compact JWS (EdDSA, Ed25519) shaped like the ID token of
// src/lab/anmeldung/siop.ts. Its `kid` is a DID URL with the DID Core
// parameter `versionId`: `<did>?versionId=<versionId>#<fragment>`, the head
// under which it was signed and the key it was signed with.
//
// A login runs in two parts. The checks that need no state (the log, the
// token's signature, audience, nonce claim and time) run first, on a
// private copy of the input. Then one step per DID, against what is held
// at that moment: compare the heads, keep evidence, admit or refuse, and
// spend the nonce only with an admitted login. That step is
// `Store.transact`; the memory store runs it without a pause, a database
// would run it as one transaction.
//
// Two things happen in that step and are kept apart: keeping the log state
// (a verified continuation, a fork, a deactivation is kept whatever the
// login), and admitting the login, which spends the nonce. A refused
// answer leaves the nonce open, so an invalid or misdirected answer cannot
// use up a request.

import { b64uOf, fromB64u, platformSubtle, rand, type KeyPair } from 'rltp-lib'
import { loginKeys, verify, type Entry, type Profile, type Version } from './log'

export interface TokenClaims {
  iss: string
  sub: string
  aud: string
  nonce: string
  iat: number
  exp: number
}

const te = new TextEncoder(), td = new TextDecoder()
const b64uJson = (o: unknown): string => b64uOf(te.encode(JSON.stringify(o)))

/** The key id a token names: the DID URL of a key under one version. */
export const kidOf = (did: string, versionId: string, fragment = 'key-1'): string => `${did}?versionId=${versionId}#${fragment}`

export async function signToken (key: KeyPair, kid: string, claims: TokenClaims): Promise<string> {
  const input = `${b64uJson({ alg: 'EdDSA', typ: 'JWT', kid })}.${b64uJson(claims)}`
  const sig = new Uint8Array(await platformSubtle().sign('Ed25519', key.priv, te.encode(input)))
  return `${input}.${b64uOf(sig)}`
}

/** What the service holds of one identifier. `evidence` holds the branches
 *  of a fork, in the order they arrived. `contested` is set by a second
 *  valid continuation and never cleared here: settling it is not modelled. */
export interface Held {
  log: Entry[]
  head: Version
  evidence: Entry[][]
  contested: boolean
}

export type LoginResult =
  | { kind: 'ok', did: string, versionId: string, step: 'first contact' | 'same head' | 'continued' }
  | { kind: 'stale', did: string, held: string }
  | { kind: 'contested', did: string, held: string }
  | { kind: 'invalid', reason: string }
  /** did:vh `featureNotSupported`: a well-formed log this verifier cannot process. */
  | { kind: 'unsupported', reason: string }

/** Admitted logins: a login that passed every check of the verifier. */
export type Admitted = Extract<LoginResult, { kind: 'ok' }>

/**
 * Hooks into the step of one login, both synchronous, both inside the step:
 * - `before`: why this answer is not considered at all (nothing kept,
 *   nonce untouched), or null;
 * - `admit`: for a login the verifier would admit, why the caller refuses it
 *   (nonce untouched, the log state still kept), or null; a null admits
 *   it, and the nonce is spent in the same step. What `admit` changes on
 *   the caller's side belongs to the step: it runs once per try of the step.
 */
export interface LoginHooks {
  before?: (now: number) => string | null
  admit?: (r: Admitted, now: number) => string | null
}

export interface LoginInput {
  log: unknown
  token: string
  /** The nonce of the request this answer is for, as the verifier issued it. */
  nonce: string
}

/** A nonce at the moment of the step: issued and open, spent, expired, or never issued. */
export type NonceState = 'open' | 'spent' | 'expired' | 'unknown'

/** What one step decides: the state to keep for the DID, the result, and whether the nonce is spent. */
export type Decision<T> = { held?: Held, result: T, spend?: boolean }

/** What the service keeps. `transact` is the one step per DID. */
export interface Store {
  /** Keeps a nonce until `expires`; nonces that have expired by `now` may be dropped. */
  issue (nonce: string, expires: number, now: number): Promise<void>
  /** What is held of a DID (a copy). */
  read (did: string): Promise<Held | undefined>
  /**
   * One step for one DID: take the time (`clock`, inside the step: the time
   * of the decision), read what is held and the nonce's state at that time,
   * call `decide` (synchronous, no I/O), write the `held` it returns, and spend
   * the nonce if `decide` says so (`spend`) and it was open; written together
   * or not at all. Nothing else touches the DID or the nonce in between. A
   * store that retries a step calls `decide` again; only the last call counts.
   */
  transact<T> (did: string, nonce: string, clock: () => number, decide: (held: Held | undefined, nonce: NonceState, now: number) => Decision<T>): Promise<T>
}

export class MemoryStore implements Store {
  protected readonly held = new Map<string, Held>()
  protected readonly nonces = new Map<string, { expires: number, spent: boolean }>()

  /** How many nonces are kept (open, or spent and not yet expired). */
  get nonceCount (): number { return this.nonces.size }

  async issue (nonce: string, expires: number, now: number): Promise<void> {
    // expired nonces, spent or not, are dropped; a spent one stays until its expiry so a replay still sees `spent`
    for (const [k, n] of this.nonces) if (n.expires <= now) this.nonces.delete(k)
    this.nonces.set(nonce, { expires, spent: false })
  }
  async read (did: string): Promise<Held | undefined> { const h = this.held.get(did); return h && structuredClone(h) }

  /** A nonce's state at `now`. */
  protected nonceState (nonce: string, now: number): NonceState {
    const n = this.nonces.get(nonce)
    return !n ? 'unknown' : n.spent ? 'spent' : now >= n.expires ? 'expired' : 'open'
  }

  async transact<T> (did: string, nonce: string, clock: () => number, decide: (held: Held | undefined, nonce: NonceState, now: number) => Decision<T>): Promise<T> {
    // No await from here to the end: in one process this is a single step.
    const now = clock()
    const state = this.nonceState(nonce, now)
    const h = this.held.get(did)
    const out = decide(h && structuredClone(h), state, now)
    if (out.held) this.held.set(did, structuredClone(out.held))
    if (out.spend && state === 'open') (this.nonces.get(nonce) as { spent: boolean }).spent = true
    return out.result
  }
}

type Relation = 'same' | 'extends' | 'behind' | 'diverges'
/** How a verified copy relates to the held one ("Comparing Copies of a DID
 *  Log"): one `versionId` decides, because each entry hash covers the one
 *  before it. */
function relate (held: Entry[], copy: Entry[]): Relation {
  const k = Math.min(held.length, copy.length) - 1
  if (held[k]?.versionId !== copy[k]?.versionId) return 'diverges'
  return copy.length === held.length ? 'same' : copy.length > held.length ? 'extends' : 'behind'
}
const headId = (log: Entry[]): string | undefined => log[log.length - 1]?.versionId

export class Verifier {
  private readonly store: Store

  constructor (private readonly o: { profile: Profile, audience: string, now: () => Date, toleranceSec?: number, nonceTtlSec?: number, store?: Store }) {
    this.store = o.store ?? new MemoryStore()
  }

  /** What the service holds of a DID (a copy). */
  holding (did: string): Promise<Held | undefined> { return this.store.read(did) }

  /** A nonce for one login request; it can be spent once, until it expires. */
  async issueNonce (): Promise<string> {
    const nonce = b64uOf(rand(16))
    const now = this.o.now().getTime()
    await this.store.issue(nonce, now + (this.o.nonceTtlSec ?? 300) * 1000, now)
    return nonce
  }

  async login (raw: LoginInput, hooks: LoginHooks = {}): Promise<LoginResult> {
    // A private copy before anything else: nothing the caller changes later reaches what is checked or kept.
    let input: { log: unknown, token: unknown, nonce: unknown }
    try { input = JSON.parse(JSON.stringify({ log: raw?.log, token: raw?.token, nonce: raw?.nonce })) } catch { return { kind: 'invalid', reason: 'input is not JSON data' } }
    const now = this.o.now()
    const check = await verify(input.log, { profile: this.o.profile, now, toleranceSec: this.o.toleranceSec })
    if (!check.ok) return { kind: check.kind, reason: `log: ${check.reason} (entry ${check.at + 1})` }
    const { did, log, head } = check
    const nonce = typeof input.nonce === 'string' ? input.nonce : ''
    // The token against the head of the presented log; it is admitted only
    // where that head is the one held after the step (same or continued).
    const token = await checkToken(input.token, did, head, this.o.audience, nonce)

    // The time of the nonce's expiry and of the token's `iat` and `exp` is the
    // time of the decision: taken in the step, not before the checks above.
    return this.store.transact(did, nonce, () => this.o.now().getTime(), (held, nonceState, nowMs): Decision<LoginResult> => {
      const skip = hooks.before?.(nowMs) ?? null
      if (skip !== null) return { result: { kind: 'invalid', reason: skip } }
      // the nonce is spent only here, with a login that is admitted
      const admit = (next: Held, step: 'first contact' | 'same head' | 'continued', write: boolean): Decision<LoginResult> => {
        const keep = write ? { held: next } : {}
        if (next.head.deactivated) return { ...keep, result: { kind: 'invalid', reason: 'the DID is deactivated' } }
        if (typeof token === 'string') return { ...keep, result: { kind: 'invalid', reason: `token: ${token}` } }
        const t = Math.floor(nowMs / 1000)
        if (token.iat > t + 60 || token.exp <= t) return { ...keep, result: { kind: 'invalid', reason: 'token: outside its time' } }
        if (nonceState !== 'open') return { ...keep, result: { kind: 'invalid', reason: `nonce: ${nonceState === 'spent' ? 'already used' : nonceState === 'expired' ? 'expired' : 'not issued here'}` } }
        const ok: Admitted = { kind: 'ok', did, versionId: next.head.versionId, step }
        const refused = hooks.admit?.(ok, nowMs) ?? null
        if (refused !== null) return { ...keep, result: { kind: 'invalid', reason: refused } }
        return { ...keep, result: ok, spend: true }
      }

      if (!held) {
        // First contact: the log is kept only with a login that holds, or
        // when it is deactivated (signed by the update keys, no login needed).
        const next: Held = { log, head, evidence: [], contested: false }
        const r = admit(next, 'first contact', true)
        return r.result.kind === 'ok' || head.deactivated ? r : { result: r.result }
      }
      const rel = relate(held.log, log)
      if (rel === 'diverges') {
        // A second valid continuation: both branches are kept as evidence of
        // duplicity; from now on no login for this DID is accepted.
        const evidence = held.evidence.length > 0 ? held.evidence : [held.log]
        if (!evidence.some((e) => headId(e) === headId(log))) evidence.push(log)
        return { held: { ...held, evidence, contested: true }, result: { kind: 'contested', did, held: held.head.versionId } }
      }
      if (held.contested) return { result: { kind: 'contested', did, held: held.head.versionId } }
      if (rel === 'behind') return { result: { kind: 'stale', did, held: held.head.versionId } }
      if (rel === 'same') return admit(held, 'same head', false)
      // A verified continuation replaces the held log ("replace the held DID
      // Log"), whether or not the login that brought it holds.
      return admit({ ...held, log, head }, 'continued', true)
    })
  }
}

/** Checks a token against one head. Returns why not, or its `iat` and `exp`
 *  when everything but the time holds. The nonce is compared with the
 *  request's here; whether the verifier issued it and it is still open, and
 *  whether the token is within its time, is decided in the step. */
async function checkToken (token: unknown, did: string, head: Version, audience: string, nonce: string): Promise<string | { iat: number, exp: number }> {
  const parts = typeof token === 'string' ? token.split('.') : []
  if (parts.length !== 3) return 'not a compact JWS'
  const [h, p, s] = parts as [string, string, string]
  let header: any, claims: any
  try { header = JSON.parse(td.decode(fromB64u(h))); claims = JSON.parse(td.decode(fromB64u(p))) } catch { return 'not readable' }
  if (header?.alg !== 'EdDSA') return 'not EdDSA'
  // RFC 7515 4.1.11: a listed extension that is not understood makes the JWS invalid; this verifier understands none
  if ('crit' in header) return 'crit names a header parameter this verifier does not support'
  if (claims?.iss !== did || claims?.sub !== did) return 'iss and sub are not the DID'
  const kid = typeof header.kid === 'string' ? header.kid : ''
  const m = /^([^?#]+)\?versionId=([^&#]+)#([^?#]+)$/.exec(kid)
  if (!m || m[1] !== did) return 'kid is not a key of this DID'
  if (m[2] !== head.versionId) return 'signed under another version than the head'
  const raw = loginKeys(head.doc).find((k) => k.fragment === m[3])?.raw
  if (!raw) return 'kid is not an authentication key of the head'
  let good = false
  try {
    const pub = await platformSubtle().importKey('raw', raw as BufferSource, { name: 'Ed25519' }, false, ['verify'])
    good = await platformSubtle().verify('Ed25519', pub, fromB64u(s) as BufferSource, te.encode(`${h}.${p}`))
  } catch { good = false }
  if (!good) return 'signature does not verify'
  if (claims.aud !== audience) return 'another audience'
  if (claims.nonce !== nonce) return 'another nonce'
  if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)) return 'outside its time'
  return { iat: claims.iat, exp: claims.exp }
}
