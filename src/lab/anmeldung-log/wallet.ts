// The demo wallet as a module (not the app): fetch and check a signed
// request, resolve the service's did:webvh, derive the person's keys toward
// this service from the verified SCID, keep one identifier with a log per
// service, answer, cancel, and change its own key.
//
// Order of checks before anything is shown or sent:
// 1. the outer link holds `client_id` (decentralized_identifier:did:webvh:...) and `request_uri`, nothing else is used;
// 2. the DID gives the origin and the log URL (did:webvh 1.0, The DID to HTTPS Transformation);
//    the request_uri must be on that origin (profile rule: no fetch from anyone but the service);
// 3. the log is fetched and verified as the log of exactly that DID; a known service's new log must continue the one held;
// 4. the Request Object is fetched and checked against the head's key (`kid`), and its claims (profile.ts);
// 5. the redirect_uri must be exactly on the DID's HTTPS origin, host and port.
// Only a request that passed all of this can be answered or cancelled; an
// error goes only to the redirect_uri checked in 5.

import { edFromSeed, hkdf, type KeyPair } from 'rltp-lib'
import { create, fromJsonl, rotate, toJsonl, verify, type Entry, type Profile, type Version } from '../kennung-log/log'
import { vh, webvh } from '../kennung-log/profiles'
import { kidOf, signToken } from '../kennung-log/verifier'
import { checkRequestObject, didOfClientId, DID_LOG_FIELD, keyContext, locate, parseOuter, REQUEST_MEDIA_TYPE, subjectSyntaxOf, type RequestClaims } from './profile'

export const TOKEN_LIFETIME_S = 300
export const LIMITS = { requestBytes: 16 * 1024, logBytes: 256 * 1024, replyBytes: 16 * 1024, timeoutMs: 5000 }

export interface FetchOptions {
  /** Tests only: an https URL whose host is `localhost` or ends in `.localhost` is fetched over
   *  plain http from 127.0.0.1 at the same port. Without it, only https, and no loopback or IP host. */
  loopbackForTests?: boolean
}

/** Why a fetch is refused, or the URL it goes to. */
function target (url: string, o: FetchOptions): string | { error: string } {
  let u: URL
  try { u = new URL(url) } catch { return { error: 'not a URL' } }
  if (u.protocol !== 'https:') return { error: 'not https' }
  if (u.username || u.password) return { error: 'credentials in the URL' }
  const host = u.hostname.toLowerCase()
  const local = host === 'localhost' || host.endsWith('.localhost')
  if (local && o.loopbackForTests) return `http://127.0.0.1${u.port ? ':' + u.port : ''}${u.pathname}${u.search}`
  // no fetch into the local network by literal address or name (a name that resolves there is not checked)
  if (local || /^\[|^[0-9.]+$|^0x/i.test(host) || host.endsWith('.local') || host.endsWith('.internal')) return { error: 'a local address' }
  return u.href
}

/** GET or POST with a size cap, a time limit and no redirects followed (SIOPv2: MUST NOT follow redirects). */
export async function limitedFetch (url: string, o: FetchOptions & { method?: 'GET' | 'POST', body?: string, maxBytes: number, accept?: string }): Promise<{ status: number, type: string, text: string } | { error: string }> {
  const to = target(url, o)
  if (typeof to !== 'string') return to
  let r: Response
  try {
    r = await fetch(to, {
      method: o.method ?? 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(LIMITS.timeoutMs),
      headers: { ...(o.body !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(o.accept ? { Accept: o.accept } : {}) },
      ...(o.body !== undefined ? { body: o.body } : {}),
    })
  } catch { return { error: 'unreachable' } }
  if (r.status >= 300 && r.status < 400) return { error: 'a redirect (not followed)' }
  const reader = r.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  if (reader) {
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>
      try { next = await reader.read() } catch { return { error: 'unreachable' } }
      if (next.done) break
      size += next.value.length
      if (size > o.maxBytes) { await reader.cancel().catch(() => {}); return { error: 'too large' } }
      chunks.push(next.value)
    }
  }
  const bytes = new Uint8Array(size); let at = 0
  for (const c of chunks) { bytes.set(c, at); at += c.length }
  return { status: r.status, type: r.headers.get('content-type') ?? '', text: new TextDecoder('utf-8', { fatal: false }).decode(bytes) }
}

/** What the wallet keeps: per service (by verified SCID) the service's log, and the person's identifier toward it. */
export interface WalletState {
  services: Record<string, { did: string, log: Entry[] }>
  identities: Record<string, { log: Entry[], index: number }>
}
export interface WalletStorage { load (): WalletState | null, save (s: WalletState): void }
export class MemoryStorage implements WalletStorage {
  private s: WalletState | null = null
  constructor (initial?: WalletState) { if (initial) this.s = structuredClone(initial) }
  load () { return this.s && structuredClone(this.s) }
  save (s: WalletState) { this.s = structuredClone(s) }
}

/** A request that passed every check. Only this can be answered or cancelled. */
export interface Checked {
  clientId: string
  did: string
  /** from the verified log, never from the text of the request */
  scid: string
  origin: string
  host: string
  name?: string
  claims: RequestClaims
  serviceLog: Entry[]
  serviceHead: Version
  /** what the person sees first: the checked host, then the name as the service's own statement */
  text: string
}
export type Opened = { ok: true, request: Checked } | { ok: false, reason: string }

export type Sent = { status: number, body: Record<string, unknown>, redirect_uri?: string } | { error: string }

/** The keys of the person's identifier toward one service: update key n and authentication key n. */
export async function deriveKey (secret: Uint8Array, service: { method: string, scid: string }, role: 'update' | 'auth', index: number): Promise<KeyPair> {
  return edFromSeed(await hkdf(secret, keyContext(service.method, service.scid, role, index)))
}

const SERVICE_METHOD = 'did:webvh'
const isoSeconds = (ms: number): string => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.000Z$/, 'Z')

export class Wallet {
  private readonly storage: WalletStorage
  readonly profile: Profile

  constructor (private readonly secret: Uint8Array, private readonly o: { now: () => number, profile?: Profile, storage?: WalletStorage, fetch?: FetchOptions } ) {
    this.storage = o.storage ?? new MemoryStorage()
    this.profile = o.profile ?? vh
  }

  /** A copy of what the wallet holds (a second device with the same state starts from it). */
  state (): WalletState { return this.storage.load() ?? { services: {}, identities: {} } }

  /** The person's identifier toward a service, if one exists. */
  identity (scid: string): { did: string, log: Entry[], index: number } | undefined {
    const id = this.state().identities[scid]
    return id && { did: (id.log[0] as Entry).state.id as string, ...id }
  }

  /** Steps 1 to 5, fetching over HTTPS. Nothing is sent. */
  open (link: string): Promise<Opened> {
    return this.evaluate(link, async (url, kind) => {
      const r = await limitedFetch(url, { ...this.o.fetch, maxBytes: kind === 'log' ? LIMITS.logBytes : LIMITS.requestBytes, ...(kind === 'request' ? { accept: REQUEST_MEDIA_TYPE } : {}) })
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
    const now = this.o.now()
    const check = await verify(raw, { profile: webvh(where.rest), now: new Date(now), did })
    if (!check.ok) return no(`service log: ${check.reason}`)
    if (check.head.deactivated) return no('service log: the service DID is deactivated')
    const known = this.state().services[check.scid]
    if (known) {
      const k = known.log.length - 1
      if (check.log.length < known.log.length || check.log[k]?.versionId !== known.log[k]?.versionId) return no('service log: does not continue the log held for this service')
    }

    const ro = await get(outer.request_uri, 'request')
    if ('error' in ro) return no(`request: ${ro.error}`)
    const rc = await checkRequestObject(ro.text.trim(), { clientId: outer.client_id, did, head: check.head, nowS: Math.floor(now / 1000) })
    if (!rc.ok) return no(`request: ${rc.reason}`)
    let redirect: URL
    try { redirect = new URL(rc.claims.redirect_uri) } catch { return no('redirect_uri is not a URL') }
    if (redirect.protocol !== 'https:' || redirect.origin !== where.origin || redirect.username || redirect.password) return no('redirect_uri is not on the HTTPS origin of the service DID')

    const host = new URL(where.origin).host
    const name = rc.claims.client_metadata.client_name
    const request: Checked = {
      clientId: outer.client_id, did, scid: check.scid, origin: where.origin, host, claims: rc.claims,
      serviceLog: check.log, serviceHead: check.head,
      ...(name ? { name } : {}),
      text: `${host} möchte dich anmelden.${name ? ` Der Dienst nennt sich „${name}“.` : ''} Er sieht nur einen Namen für dich, der nur dort gilt.`,
    }
    const supported = rc.claims.client_metadata.subject_syntax_types_supported
    if (!supported.includes(subjectSyntaxOf(this.profile)) && !supported.includes('did')) {
      await this.sendError(request, 'subject_syntax_types_not_supported')
      return no('the service supports none of the wallet\'s DID methods')
    }
    return { ok: true, request }
  }

  /** The person confirmed: prepare the answer and post it to the checked redirect_uri. */
  async confirm (r: Checked): Promise<Sent> {
    const a = await this.prepare(r)
    return this.send(r, a.form)
  }

  /** The answer: the identifier toward this service (created at the first login and stored before anything is sent) and the ID token. */
  async prepare (r: Checked): Promise<{ url: string, form: Record<string, string> }> {
    const now = this.o.now()
    const state = this.state()
    const service = { method: SERVICE_METHOD, scid: r.scid }
    let id = state.identities[r.scid]
    if (!id) {
      const [u0, u1, a0] = await Promise.all([deriveKey(this.secret, service, 'update', 0), deriveKey(this.secret, service, 'update', 1), deriveKey(this.secret, service, 'auth', 0)])
      id = { log: await create({ profile: this.profile, updateKey: u0, next: [u1.pubRaw], authKey: a0.pubRaw, time: isoSeconds(now) }), index: 0 }
    }
    state.identities[r.scid] = id
    state.services[r.scid] = { did: r.did, log: r.serviceLog }
    this.storage.save(state)                                 // stored before anything is sent
    const head = id.log[id.log.length - 1] as Entry
    const did = (id.log[0] as Entry).state.id as string
    const iat = Math.floor(now / 1000)
    const token = await signToken(await deriveKey(this.secret, service, 'auth', id.index), kidOf(did, head.versionId), {
      iss: did, sub: did, aud: r.clientId, nonce: r.claims.nonce, iat, exp: iat + TOKEN_LIFETIME_S,
    })
    return { url: r.claims.redirect_uri, form: { id_token: token, state: r.claims.state, [DID_LOG_FIELD]: toJsonl(id.log) } }
  }

  /** The person said no: `user_cancelled` to the checked redirect_uri (SIOPv2, Error Response). */
  cancel (r: Checked): Promise<Sent> { return this.sendError(r, 'user_cancelled') }

  private sendError (r: Checked, error: string): Promise<Sent> {
    return this.send(r, { error, state: r.claims.state })
  }

  private async send (r: Checked, form: Record<string, string>): Promise<Sent> {
    const res = await limitedFetch(r.claims.redirect_uri, { ...this.o.fetch, method: 'POST', body: new URLSearchParams(form).toString(), maxBytes: LIMITS.replyBytes })
    if ('error' in res) return res
    let body: Record<string, unknown> = {}
    try { const b = JSON.parse(res.text); if (b && typeof b === 'object' && !Array.isArray(b)) body = b } catch { /* not JSON */ }
    // the same-device return: opened only on the service's own origin
    const back = typeof body.redirect_uri === 'string' && mayOpen(r, body.redirect_uri) ? { redirect_uri: body.redirect_uri } : {}
    return { status: res.status, body, ...back }
  }

  /** Change the key of the identifier toward one service: the committed update key signs, a new authentication key. */
  async rotate (scid: string): Promise<void> {
    const state = this.state()
    const id = state.identities[scid]
    if (!id) throw new Error('no identifier for this service')
    const service = { method: SERVICE_METHOD, scid }
    const n = id.index + 1
    const [signer, next, auth] = await Promise.all([deriveKey(this.secret, service, 'update', n), deriveKey(this.secret, service, 'update', n + 1), deriveKey(this.secret, service, 'auth', n)])
    const now = this.o.now()
    const prev = Date.parse((id.log[id.log.length - 1] as Entry).versionTime)
    if (Math.floor(now / 1000) * 1000 <= prev) throw new Error('rotate: the clock is not later than the last entry')
    state.identities[scid] = { log: await rotate(id.log, { signer, next: [next.pubRaw], authKey: auth.pubRaw, time: isoSeconds(now) }), index: n }
    this.storage.save(state)
  }
}

/** A return address the wallet may open: only on the service's own origin. */
export function mayOpen (r: Checked, uri: string): boolean {
  try { const u = new URL(uri); return u.protocol === 'https:' && u.origin === r.origin } catch { return false }
}
