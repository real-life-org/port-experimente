// Tests only: the login after the profile played in many orders.
//
// A planner holds every place where service, verifier, wallet or transport
// wait: each store step, each fetch and POST, each key derivation of wallet
// and service. Each event of a run is an actor (an async script); its pauses
// are tagged with the actor through AsyncLocalStorage. When every actor is
// either finished or waiting at a pause, the planner chooses one actor and
// lets all its waiting pauses go on (pauses an actor waits on together, as in
// a Promise.all, are one step). The clock is moved only by events of their
// own (one step each), in whole seconds.
//
// `every` walks all orders of one set of events (replay from the start with
// a prefix of choices, as a depth-first odometer); `drawn` runs a fixed
// number of random orders from a seeded generator. After every step and at
// the end of a run the properties E1 to E12 are checked; a run that breaks
// one stops and reports the property, the order (actor per step) and, for a
// drawn run, its seed.
//
// Everything runs in one process against the service object (no HTTP); the
// wallet's transport hands the requests to the service.

import { AsyncLocalStorage } from 'node:async_hooks'
import { fromB64u, platformSubtle } from 'rltp-lib'
import { fromJsonl, loginKeys, type Entry } from '../src/lab/kennung-log/log'
import type { Held, NonceState, Decision } from '../src/lab/kennung-log/verifier'
import { checkWindow, type RequestClaims } from '../src/lab/anmeldung-log/profile'
import { CODE_LIFETIME_MS, MemoryLoginStore, PICKUP_LIFETIME_MS, REQUEST_LIFETIME_MS, REQUEST_PATH, Service, ServiceKeys, serviceLog, type Collected, type Mode } from '../src/lab/anmeldung-log/service'
import type { Transport } from '../src/lab/anmeldung-log/transport'
import { deriveKey, MemoryStorage, Wallet, type Shown, type WalletState } from '../src/lab/anmeldung-log/wallet'

const td = new TextDecoder(), te = new TextEncoder()
const jwtPart = (jwt: string, i: 0 | 1): any => JSON.parse(td.decode(fromB64u(jwt.split('.')[i] as string)))
const headOf = (log: Entry[]): string => (log[log.length - 1] as Entry).versionId
const goesOn = (held: string[], now: string[]): boolean => now.length >= held.length && held.every((v, i) => now[i] === v)
async function verifies (jwt: string, raw: Uint8Array): Promise<boolean> {
  const [h, p, s] = jwt.split('.') as [string, string, string]
  try {
    const pub = await platformSubtle().importKey('raw', raw as BufferSource, { name: 'Ed25519' }, false, ['verify'])
    return await platformSubtle().verify('Ed25519', pub, fromB64u(s) as BufferSource, te.encode(`${h}.${p}`))
  } catch { return false }
}

// ---- the planner

type Pause = { actor: number, label: string, go: () => void }
export class Planner {
  free = true
  readonly waiting: Pause[] = []
  readonly als = new AsyncLocalStorage<number>()
  /** A place where the code waits. In free mode it goes on at once (the prelude). */
  pause (label: string): Promise<void> {
    if (this.free) return Promise.resolve()
    const actor = this.als.getStore()
    if (actor === undefined) throw new Error(`a pause outside any actor: ${label}`)
    return new Promise((go) => { this.waiting.push({ actor, label, go }) })
  }
  /** Let every waiting pause of one actor go on; what they were. */
  release (actor: number): string[] {
    const mine = this.waiting.filter((p) => p.actor === actor)
    for (const p of mine) this.waiting.splice(this.waiting.indexOf(p), 1)
    for (const p of mine) p.go()
    return [...new Set(mine.map((p) => p.label))]
  }
}

// ---- the parts with their pauses

class PausedKeys extends ServiceKeys {
  constructor (seed: Uint8Array, private readonly p: Planner) { super(seed) }
  override update (n: number) { return this.p.pause('service key').then(() => super.update(n)) }
  override auth (n: number) { return this.p.pause('service key').then(() => super.auth(n)) }
}

/** What the store saw inside its steps. */
interface StoreLog {
  admitted (nonce: string, did: string, now: number): void
  closed (nonce: string, now: number): void
  session (did: string, now: number, held: Held | undefined): void
}

class PausedStore extends MemoryLoginStore {
  constructor (private readonly p: Planner, private readonly log: StoreLog) { super() }
  override async issue (nonce: string, expires: number, now: number) { await this.p.pause('store: nonce'); return super.issue(nonce, expires, now) }
  override async transact<T> (did: string, nonce: string, clock: () => number, decide: (held: Held | undefined, n: NonceState, now: number) => Decision<T>): Promise<T> {
    await this.p.pause('store: login step')
    return super.transact(did, nonce, clock, (held, n, now) => {
      const out = decide(held, n, now)
      if (out.spend) this.log.admitted(nonce, did, now)   // the step admits: counted whatever the store then does with the nonce
      return out
    })
  }
  override async closeAttempt (nonce: string, clock: () => number, apply: (now: number) => void) {
    await this.p.pause('store: close')
    return super.closeAttempt(nonce, clock, (now) => { apply(now); this.log.closed(nonce, now) })
  }
  override async issueSession<T> (did: string, clock: () => number, decide: (held: Held | undefined, now: number) => T): Promise<T> {
    await this.p.pause('store: session step')
    return super.issueSession(did, clock, (held, now) => {
      const r = decide(held, now)
      if (r && typeof r === 'object' && 'session' in r) this.log.session(did, now, held)
      return r
    })
  }
  seed (held: [string, Held][]): void { for (const [d, h] of held) this.held.set(d, structuredClone(h)) }
  heldDids (): string[] { return [...this.held.keys()] }
  heldOf (did: string): Held | undefined { return this.held.get(did) }
}

// ---- fixed inputs

const HOST = 'dienst.example'
const T0 = Date.parse('2026-11-28T10:00:00Z')
const SERVICE_SEED = new Uint8Array(32).fill(7)
const SECRET = { p1: new Uint8Array(32).fill(1), p2: new Uint8Array(32).fill(2) }
let serviceLogOnce: Promise<Entry[]> | null = null
const fixedServiceLog = (): Promise<Entry[]> => (serviceLogOnce ??= serviceLog(HOST, new ServiceKeys(SERVICE_SEED), new Date(T0 - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')))

// ---- one run

/** `returning`: both persons logged in before; `first`: nobody has; `answered`: returning, and person 1 has answered A and C; `rotated`: returning, A opened before a key change of the service, B after. */
export type Setup = 'returning' | 'first' | 'answered' | 'rotated'
type Base = { w1: WalletState, w2: WalletState, d2: WalletState, d3: WalletState, held: [string, Held][], t: number }
let returningBase: Promise<Base> | null = null
type Attempt = { id: string, state: string, nonce: string, requestId: string, link: string, claims: RequestClaims, created: number, mode: Mode, forgetStarted: boolean, forgetDone: boolean }
type WalletRec = { name: string, wallet: Wallet, storage: MemoryStorage, swapTo?: string }
type SessionRec = { attempt: string, did: string, now: number, held: Held | undefined }
export type Problem = { property: string, detail: string }

export class World {
  readonly p = new Planner()
  t = T0
  svc!: Service
  store!: PausedStore
  readonly attempts = new Map<string, Attempt>()      // attempt id -> attempt
  readonly byState = new Map<string, Attempt>()
  readonly byNonce = new Map<string, Attempt>()
  readonly admissions: { nonce: string, did: string, now: number }[] = []
  readonly sessions: SessionRec[] = []
  readonly wallets = new Map<string, WalletRec>()
  readonly views = new Map<string, Shown>()
  readonly problems: Problem[] = []
  readonly pending: Promise<void>[] = []
  readonly errors: string[] = []
  readonly lastSession = new Map<number, { did: string, now: number, held: Held | undefined }>()
  code: { attempt: string, code: string } | null = null
  // what was seen before, for "nothing goes back"
  private seenService: string[] = []
  private readonly seenHeld = new Map<string, string[]>()
  private readonly seenWallet = new Map<MemoryStorage, WalletState>()
  private readonly storageDid = new Map<MemoryStorage, Map<string, string>>()
  private readonly contestedSeen = new Set<string>()

  constructor (readonly setup: Setup) {}

  fail (property: string, detail: string): void { this.problems.push({ property, detail }) }
  now = (): number => this.t

  async build (needs: Set<string>, attempts: string[] = []): Promise<void> {
    const p = this.p
    this.store = new PausedStore(p, {
      admitted: (nonce, did, now) => {
        this.admissions.push({ nonce, did, now })
        const a = this.byNonce.get(nonce)
        if (this.admissions.filter((x) => x.nonce === nonce).length > 1) this.fail('E1', `a second admitted login for the nonce of attempt ${a?.id}`)
        if (a && now - a.created > REQUEST_LIFETIME_MS) this.fail('E3', `a login admitted ${(now - a.created) / 1000} s after its request was issued`)
        if (a?.forgetDone) this.fail('E11', `a login admitted for attempt ${a.id} after it was given up`)
      },
      closed: () => {},
      session: (did, now, held) => { this.lastSession.set(this.p.als.getStore() ?? -1, { did, now, held }) },
    })
    this.svc = await Service.create({ host: HOST, keys: new PausedKeys(SERVICE_SEED, p), now: this.now, store: this.store, log: await fixedServiceLog(), name: 'Beispieldienst' })
    const wallet = (name: string, secret: Uint8Array, storage: MemoryStorage, o: { swapTo?: () => string, ahead?: number } = {}): WalletRec => {
      const rec: WalletRec = { name, wallet: undefined as unknown as Wallet, storage }
      const now = o.ahead ? () => this.t + (o.ahead as number) : this.now
      rec.wallet = new Wallet(secret, { now, storage, transport: this.transportFor(rec, o.swapTo), derive: (s, k, role, i) => p.pause('wallet key').then(() => deriveKey(s, k, role, i)) })
      this.wallets.set(name, rec)
      return rec
    }
    if (this.setup !== 'first') {
      // the logins of the prelude are the same in every run: made once, then copied
      const base = await (returningBase ??= World.returningBase())
      this.store.seed(base.held)
      this.t = base.t
      wallet('W1', SECRET.p1, new MemoryStorage(base.w1))
      wallet('W2', SECRET.p2, new MemoryStorage(base.w2))
      wallet('D2', SECRET.p1, new MemoryStorage(base.d2))
      wallet('D3', SECRET.p1, new MemoryStorage(base.d3))
    } else {
      const w1 = wallet('W1', SECRET.p1, new MemoryStorage())
      wallet('W2', SECRET.p2, new MemoryStorage())
      wallet('W1b', SECRET.p1, w1.storage, { ahead: 1000 })            // a second device of person 1 on the same storage, its clock a second ahead
    }
    const w1 = this.wallets.get('W1') as WalletRec
    wallet('W1s', SECRET.p1, w1.storage, { swapTo: () => (this.attempts.get(this.named.B) as Attempt).state })   // person 1's wallet on a line that swaps A's state for B's
    // attempts A (cross-device), B (a second one of the same browser), C (same-device), F (another browser's), as needed
    const wanted = new Set(['A', ...[...needs].map((v) => v.split(':')[1] as string), ...(needs.has('W1s:A') ? ['B'] : []), ...attempts])
    const startOne = async (k: 'A' | 'B' | 'C' | 'F'): Promise<void> => { if (wanted.has(k)) this.named[k] = (await this.start(k === 'C' ? 'same-device' : 'cross-device')).id }
    const openViews = async (which: (v: string) => boolean): Promise<void> => {
      for (const v of needs) {
        if (!which(v)) continue
        const [w, at] = v.split(':') as [string, 'A' | 'B' | 'C']
        const o = await (this.wallets.get(w) as WalletRec).wallet.open((this.attempts.get(this.named[at]) as Attempt).link)
        if (!o.ok) throw new Error(`prelude: ${v}: ${o.reason}`)
        this.views.set(v, o.request)
      }
    }
    if (this.setup === 'rotated') {
      // the views of A are opened under the service's first head; then the service changes its key; B is started and opened after
      for (const k of ['A', 'C', 'F'] as const) await startOne(k)
      await openViews((v) => !v.endsWith(':B'))
      await this.svc.rotateKey()
      this.t += 1000
      await startOne('B')
      await openViews((v) => v.endsWith(':B'))
    } else {
      for (const k of ['A', 'B', 'C', 'F'] as const) await startOne(k)
      await openViews(() => true)
    }
    if (this.setup === 'answered') {
      // person 1 has answered A (cross-device) and C (same-device); nothing is collected yet
      for (const v of ['W1:A', 'W1:C']) {
        const sent = await w1.wallet.confirm(this.views.get(v) as Shown)
        if ('error' in sent || sent.status !== 200) throw new Error(`prelude: ${v} not admitted`)
        if (sent.redirect_uri) this.code = { attempt: this.named.C, code: new URL(sent.redirect_uri).searchParams.get('response_code') as string }
      }
    }
    this.observe()
  }

  named: Record<'A' | 'B' | 'C' | 'F', string> = { A: '', B: '', C: '', F: '' }

  /**
   * The prelude of the returning case: persons 1 and 2 log in once; a second
   * device of person 1 takes the state of then; person 1 changes the key,
   * which neither that device nor the service knows yet.
   */
  static async returningBase (): Promise<Base> {
    const w = new World('first')
    await w.build(new Set())
    const w1 = w.wallets.get('W1') as WalletRec, w2 = w.wallets.get('W2') as WalletRec
    await w.loginNow(w1)
    await w.loginNow(w2)
    w.t += 1000
    const d2 = w1.wallet.state()
    await w1.wallet.rotate(w.svc.scid)
    w.t += 1000
    // a third device with the state of then changes the key on its own, a second later: a second valid continuation
    const d3 = new Wallet(SECRET.p1, { now: w.now, storage: new MemoryStorage(d2) })   // it only rotates here, nothing is sent
    await d3.rotate(w.svc.scid)
    w.t += 1000
    return { w1: w1.wallet.state(), w2: w2.wallet.state(), d2, d3: d3.state(), held: w.store.heldDids().map((d) => [d, structuredClone(w.store.heldOf(d) as Held)]), t: w.t }
  }

  private async loginNow (w: WalletRec): Promise<void> {
    const s = await this.start('cross-device')
    const o = await w.wallet.open(s.link)
    if (!o.ok) throw new Error(o.reason)
    const sent = await w.wallet.confirm(o.request)
    if ('error' in sent) throw new Error(sent.error)
    const got = await this.collect(s.id)
    if (!got || !('session' in got)) throw new Error('prelude: no session')
  }

  /** The browser starts an attempt; the issued request is checked against the head of this moment (E8). */
  async start (mode: Mode): Promise<Attempt> {
    const s = await this.svc.start(mode)
    // synchronously after start returned: the head of the moment of issue
    const served = this.svc.requestObject(s.requestUri.slice((this.svc.origin + REQUEST_PATH).length))
    if (served === null) { this.fail('E8', 'a request is out of its window at the moment it is issued'); throw new Error('E8') }
    const jwt = served
    const head = (fromJsonl(this.svc.didLog()) as Entry[]).at(-1) as Entry
    const keys = loginKeys(head.state)
    const header = jwtPart(jwt, 0), claims = jwtPart(jwt, 1) as RequestClaims
    if (keys.length !== 1 || header.kid !== (keys[0] as { id: string }).id) this.fail('E8', `the request's kid ${header.kid} is not the head's key`)
    else this.pending.push(verifies(jwt, (keys[0] as { raw: Uint8Array }).raw).then((ok) => { if (!ok) this.fail('E8', `a request issued under head ${head.versionId} is not signed by that head's key`) }))
    const a: Attempt = { id: s.attempt, state: s.state, nonce: claims.nonce, requestId: s.requestUri.slice((this.svc.origin + REQUEST_PATH).length), link: s.link, claims, created: claims.iat * 1000, mode, forgetStarted: false, forgetDone: false }
    this.attempts.set(a.id, a); this.byState.set(a.state, a); this.byNonce.set(a.nonce, a)
    return a
  }

  /** The browser that holds attempt `id` collects it (cross-device). */
  async collect (id: string): Promise<Collected> {
    const r = await this.svc.collect(id)
    this.sessionGot(id, r)
    return r
  }
  async redeem (id: string, code: string): Promise<Collected> {
    const r = await this.svc.redeem(id, code)
    this.sessionGot(id, r)
    return r
  }
  async forget (id: string): Promise<void> {
    const a = this.attempts.get(id)
    if (a) a.forgetStarted = true
    await this.svc.forget(id)
    if (a) a.forgetDone = true
  }

  private sessionGot (attempt: string, r: Collected): void {
    if (!r || !('session' in r)) return
    const step = this.lastSession.get(this.p.als.getStore() ?? -1)
    if (!step) { this.fail('E1', 'a session without a session step'); return }
    const s: SessionRec = { attempt, did: r.login.user, now: step.now, held: step.held }
    const a = this.attempts.get(attempt)
    // E1: one session per attempt
    if (this.sessions.some((x) => x.attempt === attempt)) this.fail('E1', `a second session for attempt ${attempt}`)
    // E2: only the browser holding the attempt whose login was admitted, and for that login
    const adm = a && this.admissions.find((x) => x.nonce === a.nonce)
    if (!a || !adm || adm.did !== s.did) this.fail('E2', `a session for ${s.did.slice(0, 24)}… went to the holder of attempt ${attempt}, whose answer ${adm ? `logged in ${adm.did.slice(0, 24)}…` : 'was never admitted'}`)
    // E3: within the window, read at the session step
    if (a && adm) {
      const win = a.mode === 'same-device' ? CODE_LIFETIME_MS : PICKUP_LIFETIME_MS
      if (s.now - adm.now > win) this.fail('E3', `a session ${(s.now - adm.now) / 1000} s after the login was admitted (window ${win / 1000} s)`)
    }
    // E5: not for a contested or deactivated identifier
    if (!s.held || s.held.contested || s.held.head.deactivated || this.contestedSeen.has(s.did)) this.fail('E5', `a session for an identifier that is ${s.held?.head.deactivated ? 'deactivated' : 'contested'}`)
    // E11: not after the attempt was given up
    if (a?.forgetDone) this.fail('E11', `a session for attempt ${attempt} after it was given up`)
    this.sessions.push(s)
  }

  /** The wallet's line to the service: GET and POST, each a pause; every POST is looked at the moment it is called. */
  private transportFor (w: WalletRec, swapTo?: () => string): Transport {
    return {
      get: async (url) => {
        await this.p.pause('GET')
        const svc = this.svc
        if (url === svc.origin + '/.well-known/did.jsonl') return { status: 200, type: 'text/jsonl', text: svc.didLog() }
        if (url.startsWith(svc.origin + REQUEST_PATH)) {
          const jwt = svc.requestObject(url.slice((svc.origin + REQUEST_PATH).length))
          return jwt ? { status: 200, type: 'application/oauth-authz-req+jwt', text: jwt } : { status: 404, type: '', text: '' }
        }
        return { error: 'unreachable' }
      },
      post: (url, body) => {
        this.atPost(w, url, body)
        return (async () => {
          await this.p.pause('POST')
          if (url !== this.svc.redirectUri) return { error: 'unreachable' }
          const form = new URLSearchParams(body)
          if (swapTo) form.set('state', swapTo())
          const r = await this.svc.receive(form)
          return { status: r.status, type: 'application/json', text: JSON.stringify(r.body) }
        })()
      },
    }
  }

  /** At the moment of a POST, synchronously: E3, E6, E7, E10. */
  private atPost (w: WalletRec, url: string, body: string): void {
    const form = new URLSearchParams(body)
    const a = this.byState.get(form.get('state') ?? '')
    const nowS = Math.floor(this.t / 1000)
    const s = w.storage.load() ?? { services: {}, identities: {} }
    const scid = this.svc.scid
    // E6: only to the origin of the checked service DID, and only while the gate's conditions hold
    if (new URL(url).origin !== this.svc.origin) this.fail('E6', `${w.name} posts to ${new URL(url).origin}`)
    if (!a) this.fail('E6', `${w.name} posts for a state no request carried`)
    else if (checkWindow(a.claims, nowS)) this.fail(form.has('id_token') || form.has('did_log') ? 'E3' : 'E6', `${w.name} posts ${form.has('id_token') ? 'an answer' : form.get('error')} ${nowS - a.claims.exp} s after the request ran out`)
    if (s.services[scid]?.deactivated) this.fail('E6', `${w.name} posts although it holds the service as deactivated`)
    const token = form.get('id_token')
    if (token === null) return
    // E7: the token names the head held at this moment, and is signed by its key
    const id = s.identities[scid]
    if (!id) { this.fail('E7', `${w.name} posts a token without a stored identifier`); return }
    const did = (id.log[0] as Entry).state.id as string
    const kid = jwtPart(token, 0).kid as string
    const held = headOf(id.log)
    if (!kid.includes(`?versionId=${held}#`)) this.fail('E7', `${w.name} posts a token signed under ${kid.split('versionId=')[1]?.slice(0, 8)}…, the held head is ${held.slice(0, 8)}…`)
    else {
      const raw = (loginKeys((id.log.at(-1) as Entry).state)[0] as { raw: Uint8Array }).raw
      this.pending.push(verifies(token, raw).then((ok) => { if (!ok) this.fail('E7', `${w.name} posts a token not signed by the key of the held head`) }))
    }
    // E10: every token from one storage names the one identifier stored there
    if (jwtPart(token, 1).iss !== did) this.fail('E10', `${w.name} posts a token for another identifier than the one stored`)
  }

  /** After every step: E4, E9, E10, E12, and what is contested. */
  observe (): void {
    // E12: the service's own log never goes back
    const own = (fromJsonl(this.svc.didLog()) as Entry[]).map((e) => e.versionId)
    if (!goesOn(this.seenService, own)) this.fail('E12', 'the service\'s own log went back or forked')
    this.seenService = own
    // E4: what the service holds of each identifier
    for (const did of this.store.heldDids()) {
      const h = this.store.heldOf(did) as Held
      const ids = h.log.map((e) => e.versionId)
      const before = this.seenHeld.get(did)
      if (before && !goesOn(before, ids)) this.fail('E4', `the service's head for ${did.slice(0, 24)}… went back`)
      this.seenHeld.set(did, ids)
      if (h.contested) this.contestedSeen.add(did)
    }
    // E4, E10: what each wallet storage holds
    for (const w of new Set([...this.wallets.values()].map((x) => x.storage))) {
      const s = w.load()
      if (!s) continue
      const before = this.seenWallet.get(w)
      for (const [scid, b] of Object.entries(before?.services ?? {})) {
        const n = s.services[scid]
        if (!n || !goesOn(b.log.map((e) => e.versionId), n.log.map((e) => e.versionId)) || (b.deactivated && !n.deactivated)) this.fail('E4', 'a wallet\'s held service head went back')
      }
      for (const [scid, b] of Object.entries(before?.identities ?? {})) {
        const n = s.identities[scid]
        if (!n || !goesOn(b.log.map((e) => e.versionId), n.log.map((e) => e.versionId)) || n.index < b.index) this.fail('E4', 'a wallet\'s own log went back')
      }
      this.seenWallet.set(w, s)
      const dids = this.storageDid.get(w) ?? new Map<string, string>()
      for (const [scid, id] of Object.entries(s.identities)) {
        const did = (id.log[0] as Entry).state.id as string
        if (dids.has(scid) && dids.get(scid) !== did) this.fail('E10', 'a second identifier was stored in the same storage')
        dids.set(scid, did)
      }
      this.storageDid.set(w, dids)
    }
    // E9: a nonce is spent, an attempt closed, only by an admitted login, `forget`, or running out
    for (const a of this.attempts.values()) {
      const admitted = this.admissions.some((x) => x.nonce === a.nonce)
      if (this.store.peek(a.nonce, this.t) === 'spent' && !admitted && !a.forgetStarted) this.fail('E9', `the nonce of attempt ${a.id} was spent without a login or forget`)
      const closed = this.svc.requestObject(a.requestId) === null
      if (closed && this.t - a.created <= REQUEST_LIFETIME_MS && !admitted && !a.forgetStarted) this.fail('E9', `attempt ${a.id} ended without a login, forget or running out`)
    }
  }
}

// ---- events

export type EventName =
  | 'confirm' | 'confirm2' | 'cancel' | 'other' | 'second' | 'same' | 'swapped' | 'device2' | 'fork' | 'device1st'
  | 'rotate' | 'rotateService' | 'open' | 'start' | 'collect' | 'redeem' | 'foreign' | 'forget' | 'tick' | 'late61' | 'late301'

type Ev = { views?: string[], attempts?: string[], setups?: Setup[], run: (w: World) => Promise<unknown> }
const OLD: Setup[] = ['returning', 'answered', 'rotated']
const confirmIn = (wallet: string, view: string) => async (w: World) => {
  const sent = await (w.wallets.get(wallet) as WalletRec).wallet.confirm(w.views.get(view) as Shown)
  if (view.endsWith(':C') && 'redirect_uri' in sent && sent.redirect_uri) w.code = { attempt: w.named.C, code: new URL(sent.redirect_uri).searchParams.get('response_code') as string }
}
export const EVENTS: Record<EventName, Ev> = {
  /** the person confirms (wallet W1, attempt A) */
  confirm: { views: ['W1:A'], run: confirmIn('W1', 'W1:A') },
  /** the same wallet confirms the same request a second time */
  confirm2: { views: ['W1:A'], run: confirmIn('W1', 'W1:A') },
  /** the person cancels */
  cancel: { views: ['W1:A'], run: (w) => (w.wallets.get('W1') as WalletRec).wallet.cancel(w.views.get('W1:A') as Shown) },
  /** another person's wallet answers the same request */
  other: { views: ['W2:A'], run: confirmIn('W2', 'W2:A') },
  /** a second request of the same browser (attempt B), confirmed */
  second: { views: ['W1:B'], run: confirmIn('W1', 'W1:B') },
  /** the same-device way (attempt C): confirmed, the code kept for the browser */
  same: { views: ['W1:C'], run: confirmIn('W1', 'W1:C') },
  /** person 1's answer to A arrives under B's state */
  swapped: { views: ['W1s:A'], run: confirmIn('W1s', 'W1s:A') },
  /** a second device of person 1 with the old state answers B (an answer to an attempt no longer open keeps nothing) */
  device2: { views: ['D2:B'], setups: OLD, run: confirmIn('D2', 'D2:B') },
  /** a third device of person 1, which changed the key on its own (a second valid continuation), answers B (an answer to an attempt no longer open keeps nothing) */
  fork: { views: ['D3:B'], setups: OLD, run: confirmIn('D3', 'D3:B') },
  /** a second device of person 1 on the same storage, first login, answers A */
  device1st: { views: ['W1b:A'], setups: ['first'], run: confirmIn('W1b', 'W1b:A') },
  /** person 1 changes the key */
  rotate: { run: (w) => (w.wallets.get('W1') as WalletRec).wallet.rotate(w.svc.scid) },
  /** the service changes its key */
  rotateService: { run: (w) => w.svc.rotateKey() },
  /** the wallet opens A anew and confirms that view */
  open: { run: async (w) => { const x = (w.wallets.get('W1') as WalletRec).wallet; const o = await x.open((w.attempts.get(w.named.A) as Attempt).link); if (o.ok) await x.confirm(o.request) } },
  /** the browser starts a further attempt (E8 at the moment of issue) */
  start: { run: (w) => w.start('cross-device') },
  /** the browser that started A collects */
  collect: { run: (w) => w.collect(w.named.A) },
  /** the browser that started C redeems the code */
  redeem: { attempts: ['C'], run: async (w) => { if (w.code) await w.redeem(w.named.C, w.code.code) } },
  /** another browser (its own attempt F) collects, and redeems C's code */
  foreign: { attempts: ['F', 'C'], run: async (w) => { await w.collect(w.named.F); if (w.code) await w.redeem(w.named.F, w.code.code) } },
  /** the browser that started A gives it up */
  forget: { run: (w) => w.forget(w.named.A) },
  tick: { run: async (w) => { w.t += 1000 } },
  /** past the code's life (60 s) */
  late61: { run: async (w) => { w.t += 61_000 } },
  /** past the request's and token's life and the pickup window (300 s) */
  late301: { run: async (w) => { w.t += 301_000 } },
}

/** Errors an event may end with; anything else is a problem. */
const EXPECTED_ERRORS = [/^service log: changed meanwhile by another change/, /^rotate: the clock is not later than the last entry/, /^rotate: the identifier changed meanwhile/, /^no identifier for this service/]

export type RunResult = { problems: Problem[], order: string[] }

/** One run of a set of events, with `choose` picking among the actors ready at each step. */
export async function run (setup: Setup, events: EventName[], choose: (ready: number[]) => number): Promise<RunResult> {
  const w = new World(setup)
  const needs = new Set([...events.flatMap((e) => EVENTS[e].views ?? []), ...(setup === 'answered' ? ['W1:A', 'W1:C'] : [])])
  await w.build(needs, [...events.flatMap((e) => EVENTS[e].attempts ?? []), ...(setup === 'answered' ? ['C'] : [])])
  await Promise.all(w.pending.splice(0))
  if (w.problems.length) return { problems: w.problems, order: ['prelude'] }
  w.p.free = false
  const done = events.map(() => false)
  events.forEach((e, i) => {
    void w.p.als.run(i, async () => {
      try {
        // every event begins when the planner says: what it reads first is read then
        await w.p.pause('begin')
        await EVENTS[e].run(w)
      } catch (err) {
        const m = (err as Error).message
        if (!EXPECTED_ERRORS.some((r) => r.test(m))) w.fail('error', `${e}: ${m}`)
      } finally { done[i] = true }
    })
  })
  const order: string[] = []
  for (;;) {
    // until every actor is finished or waits at a pause
    for (let k = 0; ; k++) {
      if (done.every((d, i) => d || w.p.waiting.some((x) => x.actor === i))) break
      if (k > 200_000) throw new Error(`an actor neither finishes nor pauses: ${order.join(' ')}`)
      await new Promise((r) => setImmediate(r))
    }
    w.observe()
    if (w.problems.length) break
    const ready = [...new Set(w.p.waiting.map((x) => x.actor))].sort((a, b) => a - b)
    if (ready.length === 0) break
    const pick = ready[choose(ready)] as number
    const labels = w.p.release(pick)
    order.push(`${events[pick]}(${labels.join('+')})`)
  }
  await Promise.all(w.pending.splice(0))
  return { problems: w.problems, order }
}

export type Outcome = { orders: number, failure: (RunResult & { index: number, seed?: number }) | null }

/** Every order of one set of events. */
export async function every (setup: Setup, events: EventName[], limit = 100_000): Promise<Outcome> {
  let prefix: number[] = []
  for (let index = 1; index <= limit; index++) {
    const taken: number[] = [], widths: number[] = []
    const r = await run(setup, events, ({ length: n }) => {
      const i = taken.length
      const c = i < prefix.length ? (prefix[i] as number) : 0
      taken.push(c); widths.push(n)
      return c
    })
    if (r.problems.length) return { orders: index, failure: { ...r, index } }
    let j = taken.length - 1
    while (j >= 0 && (taken[j] as number) + 1 >= (widths[j] as number)) j--
    if (j < 0) return { orders: index, failure: null }
    prefix = [...taken.slice(0, j), (taken[j] as number) + 1]
  }
  throw new Error(`more than ${limit} orders`)
}

/** One given order: `picks` names the actor (index into `events`) that goes on at each step; when it is not ready, or the picks run out, the first ready one. */
export function replay (setup: Setup, events: EventName[], picks: number[]): Promise<RunResult> {
  let i = 0
  return run(setup, events, (ready) => Math.max(0, ready.indexOf(picks[i++] as number)))
}

/** A small seeded generator (mulberry32). */
export function rng (seed: number): () => number {
  let a = seed >>> 0
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/** `n` random orders of a set of events, each from its own seed. */
export async function drawn (setup: Setup, events: EventName[], seeds: number[]): Promise<Outcome> {
  let orders = 0
  for (const seed of seeds) {
    const r0 = rng(seed)
    const r = await run(setup, events, (ready) => Math.floor(r0() * ready.length))
    orders++
    if (r.problems.length) return { orders, failure: { ...r, index: orders, seed } }
  }
  return { orders, failure: null }
}

/** A random set of events for a seed (several events may repeat). */
export function eventsFor (seed: number, size: number, setup: Setup): EventName[] {
  const r = rng(seed ^ 0x5eed)
  const pool = (Object.keys(EVENTS) as EventName[]).filter((e) => !EVENTS[e].setups || EVENTS[e].setups.includes(setup))
  return Array.from({ length: size }, () => pool[Math.floor(r() * pool.length)] as EventName)
}

