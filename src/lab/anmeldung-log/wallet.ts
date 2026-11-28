// The demo wallet as a module (not the app): fetch and check a signed
// request, resolve the service's did:webvh, derive the person's keys toward
// this service from the verified SCID, keep one identifier with a log per
// service, answer, cancel, and change its own key.
//
// Order of checks before anything is shown or sent:
// 1. the outer link gives `client_id` (decentralized_identifier:did:webvh:...) and `request_uri`; other parameters are ignored;
// 2. the DID gives the origin and the log URL (did:webvh 1.0, The DID to HTTPS Transformation);
//    the request_uri must be on that origin (profile rule: no fetch from anyone but the service);
// 3. the log is fetched and verified as the log of exactly that DID; a known service's new log must continue the one held;
//    a deactivated head is refused, and kept as the service's head;
// 4. the Request Object is fetched and checked against the head's key (`kid`), and its claims (profile.ts),
//    with the time taken after the fetch;
// 5. the redirect_uri must be exactly on the DID's HTTPS origin, host and port.
//
// What passed is kept inside the wallet. The caller gets a frozen view
// (`Shown`) to show the person and to hand back; only a view this wallet
// made can be answered or cancelled. Answering and cancelling check again,
// at that moment, in one step with storing (`commit`): the request is still
// in its window, and the service head it was checked under is the held one
// or continues it. Otherwise nothing is sent.

import { edFromSeed, hkdf, type KeyPair } from 'rltp-lib'
import { create, fromJsonl, rotate, toJsonl, verify, type Entry, type Profile, type Version } from '../kennung-log/log'
import { vh, webvh } from '../kennung-log/profiles'
import { kidOf, signToken } from '../kennung-log/verifier'
import { checkRequestObject, checkWindow, didOfClientId, DID_LOG_FIELD, keyContext, locate, parseOuter, REQUEST_MEDIA_TYPE, subjectMethodOf, subjectSyntaxOf, type KeyFor, type RequestClaims } from './profile'
import { httpsTransport, LIMITS, type Transport } from './transport'

export { LIMITS }
export const TOKEN_LIFETIME_S = 300

/** What the wallet keeps: per service (by verified SCID) the service's log, and the person's identifier toward it. */
export interface WalletState {
  services: Record<string, { did: string, log: Entry[], deactivated?: true }>
  identities: Record<string, { log: Entry[], index: number }>
}
export interface WalletStorage { load (): WalletState | null, save (s: WalletState): void }
export class MemoryStorage implements WalletStorage {
  private s: WalletState | null = null
  constructor (initial?: WalletState) { if (initial) this.s = structuredClone(initial) }
  load () { return this.s && structuredClone(this.s) }
  save (s: WalletState) { this.s = structuredClone(s) }
}

/** What the person sees of a request that passed every check, and what the caller hands back. Frozen; a copy. */
export interface Shown {
  readonly clientId: string
  readonly did: string
  /** from the verified log, never from the text of the request */
  readonly scid: string
  readonly origin: string
  readonly host: string
  readonly name?: string
  readonly claims: Readonly<RequestClaims>
  /** what the person sees first: the checked host, then the name as the service's own statement */
  readonly text: string
}
export type Opened = { ok: true, request: Shown } | { ok: false, reason: string }
export type Sent = { status: number, body: Record<string, unknown>, redirect_uri?: string } | { error: string }

/** The checked state of one request; never leaves the wallet. */
interface Checked { clientId: string, did: string, scid: string, origin: string, claims: RequestClaims, serviceLog: Entry[], serviceHead: Version }

/** The keys of the person's identifier toward one service: update key n and authentication key n. */
export async function deriveKey (secret: Uint8Array, k: KeyFor, role: 'update' | 'auth', index: number): Promise<KeyPair> {
  return edFromSeed(await hkdf(secret, keyContext(k, role, index)))
}

const SERVICE_METHOD = 'did:webvh'
const isoSeconds = (ms: number): string => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.000Z$/, 'Z')

type Relation = 'same' | 'extends' | 'behind' | 'diverges'
/** How a log relates to the one held (each versionId covers the entries before it). */
function relate (held: Entry[], copy: Entry[]): Relation {
  const k = Math.min(held.length, copy.length) - 1
  if (held[k]?.versionId !== copy[k]?.versionId) return 'diverges'
  return copy.length === held.length ? 'same' : copy.length > held.length ? 'extends' : 'behind'
}
const goesOn = (r: Relation): boolean => r === 'same' || r === 'extends'

function freeze<T> (o: T): T {
  if (o && typeof o === 'object') { for (const v of Object.values(o)) freeze(v); Object.freeze(o) }
  return o
}

export class Wallet {
  private readonly storage: WalletStorage
  private readonly transport: Transport
  private readonly checked = new WeakMap<Shown, Checked>()
  readonly profile: Profile

  constructor (private readonly secret: Uint8Array, private readonly o: { now: () => number, profile?: Profile, storage?: WalletStorage, transport?: Transport }) {
    this.storage = o.storage ?? new MemoryStorage()
    this.profile = o.profile ?? vh
    this.transport = o.transport ?? httpsTransport()
  }

  /** A copy of what the wallet holds (a second device with the same state starts from it). */
  state (): WalletState { return this.storage.load() ?? { services: {}, identities: {} } }

  /** The person's identifier toward a service, if one exists. */
  identity (scid: string): { did: string, log: Entry[], index: number } | undefined {
    const id = this.state().identities[scid]
    return id && { did: (id.log[0] as Entry).state.id as string, ...id }
  }

  private keyFor (scid: string): KeyFor { return { method: SERVICE_METHOD, scid, subjectMethod: subjectMethodOf(this.profile) } }

  /**
   * The one place that writes the wallet's state: read, change, check, store,
   * with no await in between (in one process a single step). `change` gets a
   * copy and the time of the step. Whatever it returns, the stored result
   * must keep every service log and every identifier log that was held, or
   * continue it; a deactivated service stays deactivated. Otherwise nothing
   * is stored.
   */
  private commit<T> (change: (s: WalletState, nowMs: number) => { state: WalletState, value: T } | { refused: string }): { value: T, nowMs: number } | { refused: string } {
    const before = this.state()
    const nowMs = this.o.now()
    const out = change(structuredClone(before), nowMs)
    if ('refused' in out) return out
    for (const [scid, s] of Object.entries(before.services)) {
      const n = out.state.services[scid]
      if (!n || !goesOn(relate(s.log, n.log)) || (s.deactivated && !n.deactivated)) return { refused: 'a held service log would go back' }
    }
    for (const [scid, id] of Object.entries(before.identities)) {
      const n = out.state.identities[scid]
      if (!n || !goesOn(relate(id.log, n.log)) || n.index < id.index) return { refused: 'a held identifier would go back' }
    }
    this.storage.save(out.state)
    return { value: out.value, nowMs }
  }

  /** Steps 1 to 5, fetching through the transport. Nothing is sent. */
  open (link: string): Promise<Opened> {
    return this.evaluate(link, async (url, kind) => {
      const r = await this.transport.fetch(url, { maxBytes: kind === 'log' ? LIMITS.logBytes : LIMITS.requestBytes, ...(kind === 'request' ? { accept: REQUEST_MEDIA_TYPE } : {}) })
      if ('error' in r) return r
      return r.status === 200 ? { text: r.text } : { error: `HTTP ${r.status}` }
    })
  }

  /** Steps 1 to 5 with a given way to get the log and the Request Object (the vector passes them in). */
  async evaluate (link: string, get: (url: string, kind: 'log' | 'request') => Promise<{ text: string } | { error: string }>): Promise<Opened> {
    const no = (reason: string): Opened => ({ ok: false, reason })
    const outer = parseOuter(link)
    if ('error' in outer) return no(outer.error)
    const did = didOfClientId(outer.client_id)
    if (did === null) return no('client_id has no decentralized_identifier prefix')
    if (!did.startsWith('did:webvh:')) return no('the service DID is not a did:webvh')
    const where = locate(did)
    if ('error' in where) return no(where.error)
    let ru: URL
    try { ru = new URL(outer.request_uri) } catch { return no('request_uri is not a URL') }
    if (ru.protocol !== 'https:' || ru.origin !== where.origin) return no('request_uri is not on the origin of the service DID')

    const fetched = await get(where.logUrl, 'log')
    if ('error' in fetched) return no(`service log: ${fetched.error}`)
    const raw = fromJsonl(fetched.text)
    if (raw === null) return no('service log: not JSON Lines')
    const check = await verify(raw, { profile: webvh(where.rest), now: new Date(this.o.now()), did })
    if (!check.ok) return no(`service log: ${check.reason}`)
    const known = this.state().services[check.scid]
    if (known && !goesOn(relate(known.log, check.log))) return no('service log: does not continue the log held for this service')
    if (check.head.deactivated) {
      // kept, so that no older head of this service is taken later
      this.commit((s) => {
        const held = s.services[check.scid]
        if (held && !goesOn(relate(held.log, check.log))) return { refused: 'changed meanwhile' }
        s.services[check.scid] = { did, log: check.log, deactivated: true }
        return { state: s, value: null }
      })
      return no('service log: the service DID is deactivated')
    }

    const ro = await get(outer.request_uri, 'request')
    if ('error' in ro) return no(`request: ${ro.error}`)
    // the window is checked at the time after the fetch
    const rc = await checkRequestObject(ro.text.trim(), { clientId: outer.client_id, did, head: check.head, nowS: Math.floor(this.o.now() / 1000) })
    if (!rc.ok) return no(`request: ${rc.reason}`)
    let redirect: URL
    try { redirect = new URL(rc.claims.redirect_uri) } catch { return no('redirect_uri is not a URL') }
    if (redirect.protocol !== 'https:' || redirect.origin !== where.origin || redirect.username || redirect.password) return no('redirect_uri is not on the HTTPS origin of the service DID')

    const c: Checked = { clientId: outer.client_id, did, scid: check.scid, origin: where.origin, claims: structuredClone(rc.claims), serviceLog: check.log, serviceHead: check.head }
    const host = new URL(where.origin).host
    const name = rc.claims.client_metadata.client_name
    const shown: Shown = freeze({
      clientId: c.clientId, did, scid: c.scid, origin: c.origin, host, claims: structuredClone(rc.claims),
      ...(name ? { name } : {}),
      text: `${host} möchte dich anmelden.${name ? ` Der Dienst nennt sich „${name}“.` : ''} Er sieht nur einen Namen für dich, der nur dort gilt.`,
    })
    const supported = rc.claims.client_metadata.subject_syntax_types_supported
    if (!supported.includes(subjectSyntaxOf(this.profile)) && !supported.includes('did')) {
      await this.sendError(c, 'subject_syntax_types_not_supported')
      return no('the service supports none of the wallet\'s DID methods')
    }
    this.checked.set(shown, c)
    return { ok: true, request: shown }
  }

  /** At the moment of answering: the request still in its window, and the service head it was checked under the held one or its continuation. */
  private stillGood (c: Checked, s: WalletState, nowMs: number): string | null {
    const late = checkWindow(c.claims, Math.floor(nowMs / 1000))
    if (late) return `the request: ${late}`
    const held = s.services[c.scid]
    if (held?.deactivated) return 'the service DID is deactivated'
    if (held && !goesOn(relate(held.log, c.serviceLog))) return 'a newer head of the service is held'
    return null
  }

  /** The person confirmed: the answer, posted to the checked redirect_uri. */
  async confirm (shown: Shown): Promise<Sent> {
    const a = await this.answer(shown)
    if ('error' in a) return a
    return this.post(a.c, a.form)
  }

  /** The answer `confirm` would send, without sending it (the vector). */
  async prepare (shown: Shown): Promise<{ url: string, form: Record<string, string> } | { error: string }> {
    const a = await this.answer(shown)
    return 'error' in a ? a : { url: a.url, form: a.form }
  }

  /**
   * The answer, without sending it: the identifier toward this service
   * (created at the first login) and the service head stored in one step with
   * the checks at this moment; then the ID token.
   */
  private async answer (shown: Shown): Promise<{ url: string, form: Record<string, string>, c: Checked } | { error: string }> {
    const c = this.checked.get(shown)
    if (!c) return { error: 'not a request this wallet opened' }
    const k = this.keyFor(c.scid)
    // the first entry is written before the step (it needs await); the step takes it only if there is still none
    let first: { log: Entry[], index: number } | null = null
    if (!this.state().identities[c.scid]) {
      const [u0, u1, a0] = await Promise.all([deriveKey(this.secret, k, 'update', 0), deriveKey(this.secret, k, 'update', 1), deriveKey(this.secret, k, 'auth', 0)])
      first = { log: await create({ profile: this.profile, updateKey: u0, next: [u1.pubRaw], authKey: a0.pubRaw, time: isoSeconds(this.o.now()) }), index: 0 }
    }
    const step = this.commit<{ log: Entry[], index: number }>((s, nowMs) => {
      const bad = this.stillGood(c, s, nowMs)
      if (bad) return { refused: bad }
      const id = s.identities[c.scid] ?? first
      if (!id) return { refused: 'the identifier changed meanwhile' }
      const held = s.services[c.scid]
      s.identities[c.scid] = id
      s.services[c.scid] = { did: c.did, log: held && relate(held.log, c.serviceLog) === 'same' ? held.log : c.serviceLog }
      return { state: s, value: id }
    })
    if ('refused' in step) return { error: step.refused }
    const id = step.value
    const head = id.log[id.log.length - 1] as Entry
    const did = (id.log[0] as Entry).state.id as string
    const iat = Math.floor(step.nowMs / 1000)
    const token = await signToken(await deriveKey(this.secret, k, 'auth', id.index), kidOf(did, head.versionId), {
      iss: did, sub: did, aud: c.clientId, nonce: c.claims.nonce, iat, exp: iat + TOKEN_LIFETIME_S,
    })
    return { url: c.claims.redirect_uri, form: { id_token: token, state: c.claims.state, [DID_LOG_FIELD]: toJsonl(id.log) }, c }
  }

  /** The person said no: `user_cancelled` to the checked redirect_uri (SIOPv2, Error Response), under the same checks as an answer. */
  cancel (shown: Shown): Promise<Sent> {
    const c = this.checked.get(shown)
    if (!c) return Promise.resolve({ error: 'not a request this wallet opened' })
    return this.sendError(c, 'user_cancelled')
  }

  private async sendError (c: Checked, error: string): Promise<Sent> {
    const step = this.commit((s, nowMs) => {
      const bad = this.stillGood(c, s, nowMs)
      if (bad) return { refused: bad }
      // a known service's head moves on; a service the person did not take is not added
      const held = s.services[c.scid]
      if (held && relate(held.log, c.serviceLog) === 'extends') s.services[c.scid] = { did: c.did, log: c.serviceLog }
      return { state: s, value: null }
    })
    if ('refused' in step) return { error: step.refused }
    return this.post(c, { error, state: c.claims.state })
  }

  private async post (c: Checked, form: Record<string, string>): Promise<Sent> {
    const res = await this.transport.fetch(c.claims.redirect_uri, { method: 'POST', body: new URLSearchParams(form).toString(), maxBytes: LIMITS.replyBytes })
    if ('error' in res) return res
    let body: Record<string, unknown> = {}
    try { const b = JSON.parse(res.text); if (b && typeof b === 'object' && !Array.isArray(b)) body = b } catch { /* not JSON */ }
    // the same-device return: opened only on the service's own origin
    const back = typeof body.redirect_uri === 'string' && onOrigin(c.origin, body.redirect_uri) ? { redirect_uri: body.redirect_uri } : {}
    return { status: res.status, body, ...back }
  }

  /** Change the key of the identifier toward one service: the committed update key signs, a new authentication key. */
  async rotate (scid: string): Promise<void> {
    const from = this.state().identities[scid]
    if (!from) throw new Error('no identifier for this service')
    const k = this.keyFor(scid)
    const n = from.index + 1
    const [signer, next, auth] = await Promise.all([deriveKey(this.secret, k, 'update', n), deriveKey(this.secret, k, 'update', n + 1), deriveKey(this.secret, k, 'auth', n)])
    const now = this.o.now()
    const prev = Date.parse((from.log[from.log.length - 1] as Entry).versionTime)
    if (Math.floor(now / 1000) * 1000 <= prev) throw new Error('rotate: the clock is not later than the last entry')
    const log = await rotate(from.log, { signer, next: [next.pubRaw], authKey: auth.pubRaw, time: isoSeconds(now) })
    const step = this.commit((s) => {
      const id = s.identities[scid]
      if (!id || relate(id.log, from.log) !== 'same') return { refused: 'the identifier changed meanwhile' }
      s.identities[scid] = { log, index: n }
      return { state: s, value: null }
    })
    if ('refused' in step) throw new Error(`rotate: ${step.refused}`)
  }
}

/** A return address the wallet may open: only on the service's own origin. */
function onOrigin (origin: string, uri: string): boolean {
  try { const u = new URL(uri); return u.protocol === 'https:' && u.origin === origin } catch { return false }
}
