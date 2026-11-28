import { afterAll, expect, test } from 'vitest'
import type { Server } from 'node:http'
import { createServer } from 'node:net'
import { fromJsonl, multikey, rotate, type Entry } from '../src/lab/kennung-log/log'
import { scidVh } from '../src/lab/kennung-log/profiles'
import { serve } from '../src/lab/anmeldung-log/http'
import { readFileSync } from 'node:fs'
import { fromB64u } from 'rltp-lib'
import { MemoryLoginStore, Service, ServiceKeys } from '../src/lab/anmeldung-log/service'
import { commitState, deriveKey, MemoryStorage, Wallet, type Shown, type WalletState } from '../src/lab/anmeldung-log/wallet'
import { limited, type Transport } from '../src/lab/anmeldung-log/transport'
import { holding, loopbackSend, loopbackTransport } from './anmeldung-log-loopback'
import { DID_LOG_FIELD } from '../src/lab/anmeldung-log/profile'
import { kidOf, signToken } from '../src/lab/kennung-log/verifier'

// The flows over real HTTP on 127.0.0.1: the service speaks of itself as
// https://dienst.localhost:<port> (the origin in its DID); the wallet reaches
// it there through the test transport (anmeldung-log-loopback.ts). One clock for service and wallet,
// moved by hand, so that log entries are seconds apart.

let t = Date.parse('2026-11-28T10:00:00Z')
const clock = () => t
const later = (s = 2) => { t += s * 1000 }
const servers: Server[] = []
afterAll(async () => { await Promise.all(servers.map((s) => new Promise<void>((ok) => s.close(() => ok())))) })

async function service (o: { keys?: ServiceKeys, hostName?: string, store?: MemoryLoginStore, log?: Entry[], port?: number } = {}) {
  const s = await serve({ now: clock, name: 'Beispieldienst', ...o })
  servers.push(s.server)
  return s
}
const secretOf = (n: number) => new Uint8Array(32).fill(n)
const wallet = (secret: Uint8Array, storage = new MemoryStorage()) => new Wallet(secret, { now: clock, storage, transport: loopbackTransport() })

/** one browser: its cookies */
function browser (local: string) {
  const jar = new Map<string, string>()
  const call = async (path: string, method = 'GET') => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
    const r = await fetch(local + path, { method, headers: cookie ? { cookie } : {}, redirect: 'manual' })
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const [k, v] = kv!.split('='); if (/Max-Age=0/.test(c) || !v) jar.delete(k!); else jar.set(k!, v) }
    const body = r.headers.get('content-type')?.includes('json') ? await r.json() as any : await r.text()
    return { status: r.status, body }
  }
  return { call, jar }
}

async function opened (w: Wallet, link: string): Promise<Shown> {
  const o = await w.open(link)
  if (!o.ok) throw new Error(o.reason)
  return o.request
}

/** cross-device: the browser starts, the wallet answers, the browser collects */
async function loginQr (s: { local: string }, w: Wallet) {
  const b = browser(s.local)
  const { vorgang, link } = (await b.call('/anmeldung-log/start')).body
  const sent = await w.confirm(await opened(w, link))
  const collected = (await b.call('/anmeldung-log/status?vorgang=' + vorgang)).body
  return { sent, collected, b }
}

test('first login, laptop plus phone: the request is fetched and checked, the answer logs in exactly the starting browser', async () => {
  const s = await service()
  const w = wallet(secretOf(1))
  const b = browser(s.local)
  const start = await b.call('/anmeldung-log/start')
  const { vorgang, link } = start.body
  // the outer link carries only client_id and request_uri
  const q = new URLSearchParams(new URL(link).hash.slice(1))
  expect([...q.keys()]).toEqual(['client_id', 'request_uri'])
  expect(q.get('client_id')).toBe('decentralized_identifier:' + s.service.did)
  const r = await opened(w, link)
  expect(r.host).toBe(new URL(s.origin).host)
  expect(r.text.startsWith(`${r.host} möchte dich anmelden.`)).toBe(true)
  expect(r.scid).toBe(s.service.scid)
  expect((await b.call('/anmeldung-log/status?vorgang=' + vorgang)).body).toEqual({})
  const sent = await w.confirm(r)
  expect(sent).toMatchObject({ status: 200, body: {} })
  const id = w.identity(r.scid)!
  expect(id.did.startsWith('did:vh:')).toBe(true)
  expect((await b.call('/anmeldung-log/status?vorgang=' + vorgang)).body).toEqual({ user: id.did })
  expect((await b.call('/anmeldung-log/status')).body).toEqual({ user: id.did })               // signed in
  expect((await b.call('/anmeldung-log/status?vorgang=' + vorgang)).body).toEqual({ user: id.did })   // the session, not a second collect
  expect((await browser(s.local).call('/anmeldung-log/status?vorgang=' + vorgang)).body).toEqual({})   // another browser gets nothing
  expect((await s.service.holding(id.did))?.head.versionId).toBe(id.log[0]!.versionId)
})

test('first login on the same device: the answer returns a redirect_uri with a one-time code for the starting browser', async () => {
  const s = await service()
  const w = wallet(secretOf(2))
  const b = browser(s.local)
  const { link } = (await b.call('/anmeldung-log/start?geraet=gleich')).body
  expect(b.jar.has('anmeldung')).toBe(true)
  const sent = await w.confirm(await opened(w, link))
  if ('error' in sent) throw new Error(sent.error)
  expect(sent.redirect_uri!.startsWith(s.origin + '/anmeldung-log/fertig?response_code=')).toBe(true)
  const back = new URL(sent.redirect_uri!)
  const other = browser(s.local)
  expect((await other.call(back.pathname + back.search)).status).toBe(400)                 // a stranger's browser: nothing, and the code is used up
  expect((await b.call(back.pathname + back.search)).status).toBe(400)
  // again, opened in the starting browser first
  const { link: link2 } = (await b.call('/anmeldung-log/start?geraet=gleich')).body
  const sent2 = await w.confirm(await opened(w, link2))
  if ('error' in sent2) throw new Error(sent2.error)
  const back2 = new URL(sent2.redirect_uri!)
  expect((await b.call(back2.pathname + back2.search)).status).toBe(303)
  expect(b.jar.has('anmeldung')).toBe(false)
  expect((await b.call('/anmeldung-log/status')).body).toEqual({ user: w.identity(s.service.scid)!.did })
})

test('return: the same identifier, the same head; the log is stored and a new wallet on the same storage continues it', async () => {
  const s = await service()
  const storage = new MemoryStorage()
  const w = wallet(secretOf(3), storage)
  const first = await loginQr(s, w)
  later()
  const again = await loginQr(s, w)
  expect(again.collected).toEqual(first.collected)
  later()
  const reopened = wallet(secretOf(3), storage)
  expect((await loginQr(s, reopened)).collected).toEqual(first.collected)
  expect(reopened.identity(s.service.scid)!.log).toHaveLength(1)
})

test('key change of the person: the committed key signs, the new authentication key logs in to the same account', async () => {
  const s = await service()
  const w = wallet(secretOf(4))
  const first = await loginQr(s, w)
  later()
  await w.rotate(s.service.scid)
  const id = w.identity(s.service.scid)!
  expect(id.log).toHaveLength(2)
  const after = await loginQr(s, w)
  expect(after.collected).toEqual(first.collected)
  expect((await s.service.holding(id.did))?.head.versionId).toBe(id.log[1]!.versionId)
})

test('a second wallet with the old state is stale and is told the head; two continuations contest the identifier, then nobody logs in', async () => {
  const s = await service()
  const w1 = wallet(secretOf(5))
  await loginQr(s, w1)
  const w2 = wallet(secretOf(5), new MemoryStorage(w1.state()))   // a second device, synced before the change
  later()
  await w1.rotate(s.service.scid)
  expect((await loginQr(s, w1)).sent).toMatchObject({ status: 200 })
  later()
  const stale = await loginQr(s, w2)
  expect(stale.sent).toMatchObject({ status: 400, body: { did_log_result: 'stale', held_version_id: w1.identity(s.service.scid)!.log[1]!.versionId } })
  expect(stale.collected).toEqual({ error: 'refused' })     // the waiting browser learns that the answer was refused
  // the second device changes the key from the old head: a second continuation
  later()
  await w2.rotate(s.service.scid)
  expect((await loginQr(s, w2)).sent).toMatchObject({ status: 400, body: { did_log_result: 'contested' } })
  later()
  const owner = await loginQr(s, w1)
  expect(owner.sent).toMatchObject({ status: 400, body: { did_log_result: 'contested' } })
  expect(owner.collected).toEqual({ error: 'refused' })
  const held = await s.service.holding(w1.identity(s.service.scid)!.did)
  expect(held?.contested).toBe(true)
  expect(held?.evidence).toHaveLength(2)
})

test('key change of the service: the wallet follows the continued log, the person keeps the same identifier', async () => {
  const s = await service()
  const w = wallet(secretOf(6))
  const first = await loginQr(s, w)
  const kidBefore = s.service.kid
  later()
  await s.service.rotateKey()
  expect(s.service.kid).toBe(kidBefore)                     // the same verification method, a new key in it
  const after = await loginQr(s, w)
  expect(after.collected).toEqual(first.collected)
  expect(w.state().services[s.service.scid]!.log).toHaveLength(2)
})

test('a known service whose log does not continue the held one is refused', async () => {
  const keys = new ServiceKeys(new Uint8Array(32).fill(40))
  const s = await service({ keys })
  const storage = new MemoryStorage()
  const w = wallet(secretOf(7), storage)
  await loginQr(s, w)
  later()
  // the wallet holds a continuation the service never published (a fork of the same head)
  const state = w.state()
  const held = state.services[s.service.scid]!
  const [u1, u2, a1] = await Promise.all([keys.update(1), keys.update(2), keys.auth(1)])
  held.log = await rotate(held.log, { signer: u1, next: [u2.pubRaw], authKey: a1.pubRaw, time: new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z') })
  storage.save(state)
  later()
  await s.service.rotateKey()
  const b = browser(s.local)
  const { link } = (await b.call('/anmeldung-log/start')).body
  expect(await w.open(link)).toEqual({ ok: false, reason: 'service log: does not continue the log held for this service' })
})

test('another service, another identifier and other keys', async () => {
  const a = await service(), b = await service({ hostName: 'anderer.localhost' })
  const w = wallet(secretOf(8))
  const ua = (await loginQr(a, w)).collected.user
  const ub = (await loginQr(b, w)).collected.user
  expect(ua).not.toBe(ub)
  const ka = await deriveKey(secretOf(8), { method: 'did:webvh', scid: a.service.scid, subjectMethod: 'did:vh' }, 'auth', 0)
  const kb = await deriveKey(secretOf(8), { method: 'did:webvh', scid: b.service.scid, subjectMethod: 'did:vh' }, 'auth', 0)
  expect(multikey(ka.pubRaw)).not.toBe(multikey(kb.pubRaw))
})

test('two wallets with the same secret and the same service DID derive the same keys; their first entries, at other times, give two identifiers', async () => {
  const s = await service()
  const w1 = wallet(secretOf(9)), w2 = wallet(secretOf(9))
  await loginQr(s, w1)
  later()
  await loginQr(s, w2)
  const l1 = w1.identity(s.service.scid)!.log[0]!, l2 = w2.identity(s.service.scid)!.log[0]!
  expect(l2.parameters.updateKeys).toEqual(l1.parameters.updateKeys)
  expect(l2.parameters.nextKeyHashes).toEqual(l1.parameters.nextKeyHashes)
  expect((l2.state.verificationMethod as any)[0].publicKeyMultibase).toBe((l1.state.verificationMethod as any)[0].publicKeyMultibase)
  expect(l2.state.id).not.toBe(l1.state.id)                 // did:vh asks for the current time in the first entry (profile section 11)
})

test('the person cancels: user_cancelled reaches the checked redirect_uri and the waiting browser learns it; attempt and nonce stay open until that browser gives it up', async () => {
  const store = new MemoryLoginStore()
  const s = await service({ store })
  const w = wallet(secretOf(10))
  const b = browser(s.local)
  const { vorgang, link } = (await b.call('/anmeldung-log/start')).body
  const r = await opened(w, link)
  expect(await w.cancel(r)).toMatchObject({ status: 200, body: {} })
  expect((await b.call('/anmeldung-log/status?vorgang=' + vorgang)).body).toEqual({ error: 'user_cancelled' })
  expect((await b.call('/anmeldung-log/status?vorgang=' + vorgang)).body).toEqual({ error: 'user_cancelled' })   // a notice, the binding stays
  expect(store.peek(r.claims.nonce, t)).toBe('open')
  expect(s.service.held().attempts).toBe(1)
  // only the starting browser gives it up for good: then the nonce is spent and the request is gone
  expect((await browser(s.local).call('/anmeldung-log/abbrechen?vorgang=' + vorgang, 'POST')).status).toBe(403)
  expect((await b.call('/anmeldung-log/abbrechen?vorgang=' + vorgang, 'POST')).status).toBe(200)
  expect(store.peek(r.claims.nonce, t)).toBe('spent')
  expect(s.service.held()).toMatchObject({ attempts: 0, notices: 0 })
  expect(await w.confirm(r)).toMatchObject({ status: 400, body: { error_description: 'unknown request' } })
  expect(w.identity(r.scid)?.log).toHaveLength(1)           // created on confirm, but no login
  expect((await b.call('/anmeldung-log/status')).body).toEqual({})
  expect((await b.call('/anmeldung-log/status?vorgang=' + vorgang)).body).toEqual({})
})

test('after a cancel the same person can still confirm: the attempt was not ended', async () => {
  const s = await service()
  const w = wallet(secretOf(15))
  const b = browser(s.local)
  const { vorgang, link } = (await b.call('/anmeldung-log/start')).body
  const r = await opened(w, link)
  expect(await w.cancel(r)).toMatchObject({ status: 200 })
  expect(await w.confirm(r)).toMatchObject({ status: 200 })
  expect((await b.call('/anmeldung-log/status?vorgang=' + vorgang)).body).toEqual({ user: w.identity(r.scid)!.did })
})

test('the same answer twice: the second is refused', async () => {
  const s = await service()
  const w = wallet(secretOf(11))
  const b = browser(s.local)
  const { link } = (await b.call('/anmeldung-log/start')).body
  const r = await opened(w, link)
  expect(await w.confirm(r)).toMatchObject({ status: 200 })
  expect(await w.confirm(r)).toMatchObject({ status: 400, body: { error_description: 'unknown request' } })
})

/** a raw POST to the redirect_uri */
async function post (s: { local: string }, form: Record<string, string>) {
  const res = await fetch(s.local + '/anmeldung-log/antwort', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() })
  return { status: res.status, body: await res.json() as any }
}

/** an answer signed by hand with the wallet's derived key, to change one claim */
async function handAnswer (s: { service: Service, local: string }, w: Wallet, secret: Uint8Array, r: Shown, claims: Record<string, unknown>) {
  const id = w.identity(r.scid)!
  const head = id.log[id.log.length - 1] as Entry
  const key = await deriveKey(secret, { method: 'did:webvh', scid: r.scid, subjectMethod: 'did:vh' }, 'auth', id.index)
  const iat = Math.floor(t / 1000)
  const token = await signToken(key, kidOf(id.did, head.versionId), { iss: id.did, sub: id.did, aud: r.clientId, nonce: r.claims.nonce, iat, exp: iat + 300, ...claims } as any)
  const res = await fetch(s.local + '/anmeldung-log/antwort', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id_token: token, state: r.claims.state, [DID_LOG_FIELD]: id.log.map((e) => JSON.stringify(e) + '\n').join('') }).toString() })
  return { status: res.status, body: await res.json() }
}

test('a token whose aud is not the whole client_id is refused (OpenID4VP 1.0: always the full client identifier)', async () => {
  const s = await service()
  const secret = secretOf(12)
  const w = wallet(secret)
  await loginQr(s, w)                                       // the identifier exists
  const b = browser(s.local)
  const r = await opened(w, (await b.call('/anmeldung-log/start')).body.link)
  expect(await handAnswer(s, w, secret, r, { aud: s.service.did })).toMatchObject({ status: 400, body: { did_log_result: 'invalid', error_description: 'token: another audience' } })
  const r2 = await opened(w, (await b.call('/anmeldung-log/start')).body.link)
  expect(await handAnswer(s, w, secret, r2, {})).toMatchObject({ status: 200 })
})

test('an answer after the request has expired is refused by the service (the attempt is swept); the request_uri no longer serves it', async () => {
  const s = await service()
  const b = browser(s.local)
  const { link } = (await b.call('/anmeldung-log/start')).body
  const r = await opened(wallet(secretOf(13)), link)
  later(301)
  expect(await post(s, { state: r.claims.state, id_token: 'x', [DID_LOG_FIELD]: 'x' })).toMatchObject({ status: 400, body: { error_description: 'unknown request' } })
  const { link: link2 } = (await b.call('/anmeldung-log/start')).body
  later(301)
  expect(await wallet(secretOf(13)).open(link2)).toEqual({ ok: false, reason: 'request: HTTP 404' })
})

test('a wallet whose DID method the service does not list refuses, and says so only to the checked redirect_uri', async () => {
  const s = await service()
  const other = new Wallet(secretOf(14), { now: clock, transport: loopbackTransport(), profile: scidVh })
  const b = browser(s.local)
  const { link } = (await b.call('/anmeldung-log/start')).body
  expect(await other.open(link)).toEqual({ ok: false, reason: 'the service supports none of the wallet\'s DID methods' })
  expect(s.service.held().attempts).toBe(1)                 // an error other than user_cancelled leaves the attempt open
})

// ---- the wallet: checking and answering in one step

test('an older confirmation after a newer one sends nothing and leaves the newer service head held', async () => {
  const s = await service()
  const w = wallet(secretOf(20))
  await loginQr(s, w)                                       // the service is known with its first head
  const b = browser(s.local)
  const r1 = await opened(w, (await b.call('/anmeldung-log/start')).body.link)
  later()
  await s.service.rotateKey()
  const r2 = await opened(w, (await b.call('/anmeldung-log/start')).body.link)
  expect(await w.confirm(r2)).toMatchObject({ status: 200 })
  expect(w.state().services[s.service.scid]!.log).toHaveLength(2)
  expect(await w.confirm(r1)).toEqual({ error: 'a newer head of the service is held' })
  expect(await w.cancel(r1)).toEqual({ error: 'a newer head of the service is held' })
  expect(w.state().services[s.service.scid]!.log).toHaveLength(2)
  expect(s.service.held().attempts).toBe(1)                 // r1's attempt got no answer at all
})

test('the request runs out while the person decides: neither identifier nor log is sent, nothing is stored', async () => {
  const s = await service()
  const w = wallet(secretOf(21))
  const b = browser(s.local)
  const r = await opened(w, (await b.call('/anmeldung-log/start')).body.link)
  later(301)
  expect(await w.confirm(r)).toEqual({ error: 'the request: expired' })
  expect(await w.cancel(r)).toEqual({ error: 'the request: expired' })
  expect(w.identity(r.scid)).toBeUndefined()
  expect(w.state().services).toEqual({})
  expect(s.service.held().attempts).toBe(1)                 // nothing reached the service
})

test('only a view the wallet made can be answered; the view cannot be changed', async () => {
  const s = await service()
  const w = wallet(secretOf(22))
  const b = browser(s.local)
  const r = await opened(w, (await b.call('/anmeldung-log/start')).body.link)
  const copy = structuredClone(r) as Shown
  expect(await w.confirm(copy)).toEqual({ error: 'not a request this wallet opened' })
  expect(await w.cancel({ ...r, claims: { ...r.claims, redirect_uri: 'https://evil.example/x' } })).toEqual({ error: 'not a request this wallet opened' })
  expect(await wallet(secretOf(22)).confirm(r)).toEqual({ error: 'not a request this wallet opened' })
  expect(() => { (r.claims as any).redirect_uri = 'https://evil.example/x' }).toThrow(TypeError)
  expect(() => { (r as any).scid = 'QmOther' }).toThrow(TypeError)
  expect(s.service.held().attempts).toBe(1)
  expect(await w.confirm(r)).toMatchObject({ status: 200 })
})

test('two confirmations side by side, and a key change beside a confirmation: one identifier, no head goes back', async () => {
  const s = await service()
  const w = wallet(secretOf(23))
  const b1 = browser(s.local), b2 = browser(s.local)
  const a1 = (await b1.call('/anmeldung-log/start')).body, a2 = (await b2.call('/anmeldung-log/start')).body
  const [r1, r2] = [await opened(w, a1.link), await opened(w, a2.link)]
  const [x1, x2] = await Promise.all([w.confirm(r1), w.confirm(r2)])
  expect([x1, x2]).toMatchObject([{ status: 200 }, { status: 200 }])
  const u1 = (await b1.call('/anmeldung-log/status?vorgang=' + a1.vorgang)).body, u2 = (await b2.call('/anmeldung-log/status?vorgang=' + a2.vorgang)).body
  expect(u1).toEqual(u2)
  expect(w.identity(s.service.scid)!.log).toHaveLength(1)
  // the service moves on; the person changes the key while a confirmation of the newer head runs
  later()
  await s.service.rotateKey()
  const b3 = browser(s.local)
  const a3 = (await b3.call('/anmeldung-log/start')).body
  const r3 = await opened(w, a3.link)
  later()
  const [, sent] = await Promise.all([w.rotate(s.service.scid), w.confirm(r3)])
  expect(sent).toMatchObject({ status: 200 })
  expect(w.state().services[s.service.scid]!.log).toHaveLength(2)    // the rotation did not write back the older service head
  expect(w.identity(s.service.scid)!.log).toHaveLength(2)
})

// ---- the service: what ends an attempt, and one step for answer, account and session

test('what does not reach the verifier\'s step leaves the attempt open: no log, an unreadable log, no token, another error', async () => {
  const s = await service()
  const w = wallet(secretOf(24))
  const b = browser(s.local)
  const { vorgang, link } = (await b.call('/anmeldung-log/start')).body
  const r = await opened(w, link)
  const st = r.claims.state
  expect(await post(s, { state: st, id_token: 'x' })).toMatchObject({ status: 400, body: { did_log_result: 'invalid' } })
  expect(await post(s, { state: st, id_token: 'x', [DID_LOG_FIELD]: 'not a log' })).toMatchObject({ status: 400, body: { did_log_result: 'invalid' } })
  expect(await post(s, { state: st, [DID_LOG_FIELD]: '{"a":1}\n' })).toMatchObject({ status: 400 })
  expect(await post(s, { state: st, error: 'invalid_request' })).toEqual({ status: 200, body: {} })
  expect(await post(s, { state: st, id_token: 'x', [DID_LOG_FIELD]: '{"versionId":"1-x"}\n' })).toMatchObject({ status: 400, body: { did_log_result: 'invalid' } })
  expect((await b.call('/anmeldung-log/status?vorgang=' + vorgang)).body).toEqual({})
  expect(await w.confirm(r)).toMatchObject({ status: 200 })
  expect((await b.call('/anmeldung-log/status?vorgang=' + vorgang)).body).toEqual({ user: w.identity(r.scid)!.did })
})

test('swapped answers between two attempts: refused by the nonce; both attempts and both nonces stay open, and both then log in', async () => {
  const store = new MemoryLoginStore()
  const s = await service({ store })
  const secret = secretOf(25)
  const w = wallet(secret)
  await loginQr(s, w)
  const bA = browser(s.local), bB = browser(s.local)
  const A = (await bA.call('/anmeldung-log/start')).body, B = (await bB.call('/anmeldung-log/start')).body
  const rA = await opened(w, A.link), rB = await opened(w, B.link)
  // the same person on a wallet whose answers are kept, not sent: the test delivers A's answer itself
  const kept = holding(loopbackTransport())
  const wHeld = new Wallet(secret, { now: clock, storage: new MemoryStorage(w.state()), transport: kept.transport })
  await wHeld.confirm(await opened(wHeld, A.link))
  const fA = kept.held[0] as { form: Record<string, string> }
  // A's token and log under B's state
  expect(await post(s, { ...fA.form, state: rB.claims.state })).toMatchObject({ status: 400, body: { error_description: 'token: another nonce' } })
  expect([store.peek(rA.claims.nonce, t), store.peek(rB.claims.nonce, t)]).toEqual(['open', 'open'])
  expect(s.service.held().attempts).toBe(2)
  expect((await bB.call('/anmeldung-log/status?vorgang=' + B.vorgang)).body).toEqual({ error: 'refused' })   // a notice; B stays open
  expect(await post(s, fA.form)).toMatchObject({ status: 200 })
  expect((await bA.call('/anmeldung-log/status?vorgang=' + A.vorgang)).body).toEqual({ user: w.identity(rA.scid)!.did })
  expect(await w.confirm(rB)).toMatchObject({ status: 200 })
  expect((await bB.call('/anmeldung-log/status?vorgang=' + B.vorgang)).body).toEqual({ user: w.identity(rB.scid)!.did })
  expect([store.peek(rA.claims.nonce, t), store.peek(rB.claims.nonce, t)]).toEqual(['spent', 'spent'])
})

test('a valid log with an unusable token leaves the attempt and its nonce open; the continuation is kept; the right answer then logs in', async () => {
  const store = new MemoryLoginStore()
  const s = await service({ store })
  const secret = secretOf(30)
  const w = wallet(secret)
  await loginQr(s, w)
  later()
  await w.rotate(s.service.scid)
  const b = browser(s.local)
  const { vorgang, link } = (await b.call('/anmeldung-log/start')).body
  const r = await opened(w, link)
  expect(await handAnswer(s, w, secret, r, { aud: 'someone else' })).toMatchObject({ status: 400, body: { error_description: 'token: another audience' } })
  const id = w.identity(r.scid)!
  expect((await s.service.holding(id.did))?.head.versionId).toBe(id.log[1]!.versionId)   // the verified continuation is kept
  expect(store.peek(r.claims.nonce, t)).toBe('open')
  expect(await w.confirm(r)).toMatchObject({ status: 200 })
  expect((await b.call('/anmeldung-log/status?vorgang=' + vorgang)).body).toEqual({ user: id.did })
  expect(store.peek(r.claims.nonce, t)).toBe('spent')
})

test('a browser without the attempt\'s cookie collects nothing, and the attempt stays for the browser that started it', async () => {
  const s = await service()
  const w = wallet(secretOf(26))
  const b = browser(s.local)
  const { vorgang, link } = (await b.call('/anmeldung-log/start')).body
  await w.confirm(await opened(w, link))
  const stranger = browser(s.local)
  expect((await stranger.call('/anmeldung-log/status?vorgang=' + vorgang)).body).toEqual({})     // first, before the right one
  expect(stranger.jar.has('sitzung')).toBe(false)
  expect((await b.call('/anmeldung-log/status?vorgang=' + vorgang)).body).toEqual({ user: w.identity(s.service.scid)!.did })
})

test('contested between the answer and the pickup: no session, on either way', async () => {
  const s = await service()
  const w1 = wallet(secretOf(27))
  await loginQr(s, w1)
  const w2 = wallet(secretOf(27), new MemoryStorage(w1.state()))
  later()
  await w1.rotate(s.service.scid)
  // an answer that holds, not yet collected (QR) and not yet redeemed (same device)
  const qr = browser(s.local)
  const q = (await qr.call('/anmeldung-log/start')).body
  expect(await w1.confirm(await opened(w1, q.link))).toMatchObject({ status: 200 })
  const same = browser(s.local)
  const sd = (await same.call('/anmeldung-log/start?geraet=gleich')).body
  const sent = await w1.confirm(await opened(w1, sd.link))
  if ('error' in sent) throw new Error(sent.error)
  // the other device continues the old head: the identifier is contested
  later()
  await w2.rotate(s.service.scid)
  expect((await loginQr(s, w2)).sent).toMatchObject({ status: 400, body: { did_log_result: 'contested' } })
  expect((await qr.call('/anmeldung-log/status?vorgang=' + q.vorgang)).body).toEqual({ error: 'refused' })
  expect(qr.jar.has('sitzung')).toBe(false)
  const back = new URL(sent.redirect_uri!)
  expect((await same.call(back.pathname + back.search)).status).toBe(400)
  expect(same.jar.has('sitzung')).toBe(false)
})

test('an attempt given up while its answer is checked: the check ends and keeps nothing', async () => {
  const s = await service()
  const b = browser(s.local)
  const { vorgang, link } = (await b.call('/anmeldung-log/start')).body
  const kept = holding(loopbackTransport())
  const w = new Wallet(secretOf(28), { now: clock, transport: kept.transport })
  const r = await opened(w, link)
  await w.confirm(r)
  const a = kept.held[0] as { form: Record<string, string> }
  const pending = s.service.receive(new URLSearchParams(a.form))   // runs to its first await
  await s.service.forget(vorgang)
  expect(await pending).toMatchObject({ status: 400, body: { error_description: 'the request is no longer open' } })
  expect(await s.service.holding(w.identity(r.scid)!.did)).toBeUndefined()
  expect(await s.service.collect(vorgang)).toBeNull()
  expect(s.service.held()).toEqual({ attempts: 0, outcomes: 0, notices: 0, codes: 0, sessions: 0 })
})

test('each start is a fresh attempt; what has run out is swept', async () => {
  const s = await service()
  const w = wallet(secretOf(29))
  const b = browser(s.local)
  const one = (await b.call('/anmeldung-log/start')).body, two = (await b.call('/anmeldung-log/start')).body
  expect(one.vorgang).not.toBe(two.vorgang)
  await loginQr(s, w)                                       // a session
  const same = browser(s.local)
  const sd = (await same.call('/anmeldung-log/start?geraet=gleich')).body
  await w.confirm(await opened(w, sd.link))                 // a code nobody redeems
  const left = browser(s.local)
  const l = (await left.call('/anmeldung-log/start')).body
  await w.confirm(await opened(w, l.link))                  // a login nobody collects
  expect(s.service.held()).toMatchObject({ attempts: 2, outcomes: 1, codes: 1, sessions: 1 })
  later(3601)
  await browser(s.local).call('/anmeldung-log/status')      // any request sweeps
  expect(s.service.held()).toEqual({ attempts: 0, outcomes: 0, notices: 0, codes: 0, sessions: 0 })
})

// ---- the wallet: one gate before the transport, and a state no caller reaches

/** a transport that records every POST, and at the moment of each POST what `look` says */
function recording<T> (look: () => T = () => undefined as T) {
  const posts: { body: string, seen: T }[] = []
  const inner = loopbackTransport()
  const transport: Transport = { get: inner.get, post: (url, body, o) => { posts.push({ body, seen: look() }); return inner.post(url, body, o) } }
  return { posts, transport }
}
const kidHead = (body: string): string => {
  const token = new URLSearchParams(body).get('id_token')!
  return /versionId=([^#]+)#/.exec(JSON.parse(new TextDecoder().decode(fromB64u(token.split('.')[0]!))).kid)![1]!
}

test('the clock reaches exp while the wallet derives and signs: no POST', async () => {
  const s = await service()
  const rec = recording()
  const w = new Wallet(secretOf(40), { now: clock, transport: rec.transport })
  await loginQr(s, w)                                       // the identifier exists: confirm goes straight to deriving and signing
  const r = await opened(w, (await browser(s.local).call('/anmeldung-log/start')).body.link)
  const before = rec.posts.length
  const pending = w.confirm(r)                              // runs to its first await: the key derivation
  const saved = t
  t = r.claims.exp * 1000                                   // during derivation and signature
  try { expect(await pending).toEqual({ error: 'the request: expired' }) } finally { t = saved }
  expect(rec.posts.length).toBe(before)
  expect(s.service.held().attempts).toBe(1)
})

test('the service head is deactivated or moves on while the wallet signs: no POST', async () => {
  for (const change of ['deactivated', 'newer'] as const) {
    const s = await service()
    const storage = new MemoryStorage()
    const rec = recording()
    const w = new Wallet(secretOf(41), { now: clock, transport: rec.transport, storage })
    await loginQr(s, w)
    const r = await opened(w, (await browser(s.local).call('/anmeldung-log/start')).body.link)
    let newer: WalletState | null = null
    if (change === 'newer') {
      later()
      await s.service.rotateKey()
      const w2 = new Wallet(secretOf(41), { now: clock, transport: loopbackTransport(), storage: new MemoryStorage(w.state()) })
      await w2.confirm(await opened(w2, (await browser(s.local).call('/anmeldung-log/start')).body.link))
      newer = w2.state()
    }
    const before = rec.posts.length
    const pending = w.confirm(r)
    const st = storage.load()!
    if (newer) storage.save(newer); else { st.services[r.scid]!.deactivated = true; storage.save(st) }
    expect(await pending, change).toEqual({ error: change === 'newer' ? 'a newer head of the service is held' : 'the service DID is deactivated' })
    expect(rec.posts.length, change).toBe(before)
  }
})

test('a key change lands between signing and sending: the token sent names the person\'s head held at that moment', async () => {
  const s = await service()
  const storage = new MemoryStorage()
  const rec = recording<string | undefined>((): string | undefined => w.identity(s.service.scid)?.log.at(-1)?.versionId)
  const w: Wallet = new Wallet(secretOf(42), { now: clock, transport: rec.transport, storage })
  await loginQr(s, w)
  later()
  const r = await opened(w, (await browser(s.local).call('/anmeldung-log/start')).body.link)
  // the same key change made on a copy, stored right after the answer's own step (as a rotation finishing while the token is signed)
  const w2 = new Wallet(secretOf(42), { now: clock, transport: loopbackTransport(), storage: new MemoryStorage(w.state()) })
  await w2.rotate(s.service.scid)
  const rotated = w2.state()
  const save = storage.save.bind(storage)
  let swap: WalletState | null = rotated
  storage.save = (x) => { save(x); if (swap) { const y = swap; swap = null; save(y) } }
  expect(await w.confirm(r)).toMatchObject({ status: 200 })
  const last = rec.posts.at(-1)!
  expect(kidHead(last.body)).toBe(rotated.identities[s.service.scid]!.log[1]!.versionId)
  expect(kidHead(last.body)).toBe(last.seen)
})

test('a key change beside confirmations, in several orders: every token sent names the head held when it was sent', async () => {
  for (const delay of [0, 1, 5, 20]) {
    const s = await service()
    const rec = recording<string | undefined>((): string | undefined => w.identity(s.service.scid)?.log.at(-1)?.versionId)
    const w: Wallet = new Wallet(secretOf(43), { now: clock, transport: rec.transport })
    await loginQr(s, w)
    later()
    const rs = [await opened(w, (await browser(s.local).call('/anmeldung-log/start')).body.link), await opened(w, (await browser(s.local).call('/anmeldung-log/start')).body.link)]
    const rotation = new Promise<void>((ok, fail) => setTimeout(() => { w.rotate(s.service.scid).then(ok, fail) }, delay))
    const sent = await Promise.all([...rs.map((r) => w.confirm(r)), rotation])
    expect(sent.slice(0, 2), `delay ${delay}`).toMatchObject([{ status: 200 }, { status: 200 }])
    for (const p of rec.posts) expect(kidHead(p.body)).toBe(p.seen)
  }
})

test('the transport is called only from the wallet\'s one gate', () => {
  const src = readFileSync(new URL('../src/lab/anmeldung-log/wallet.ts', import.meta.url), 'utf8')
  expect(src.match(/#transport\.post\(/g)).toHaveLength(1)
  expect(src.match(/#transport\.\w+/g)!.sort()).toEqual(['#transport.get', '#transport.post'])
  expect(src.match(/\.fetch\(/g)).toBeNull()
  const gate = src.indexOf('  #send (')
  const next = src.indexOf('\n  async #reply (', gate)
  const call = src.indexOf('#transport.post(')
  expect(gate > 0 && gate < call && call < next).toBe(true)
  // from the checks to the call there is no await
  expect(src.slice(gate, call)).not.toMatch(/\bawait\b/)
})

test('the checked state and the wallet\'s inner methods are out of reach of JavaScript', async () => {
  const s = await service()
  const w = wallet(secretOf(44))
  const r = await opened(w, (await browser(s.local).call('/anmeldung-log/start')).body.link)
  const any = w as any
  expect(Object.getOwnPropertyNames(w)).toEqual(['profile'])
  expect(Object.getOwnPropertySymbols(w)).toEqual([])
  expect(Object.getOwnPropertyNames(Object.getPrototypeOf(w)).sort()).toEqual(['cancel', 'confirm', 'constructor', 'identity', 'open', 'rotate', 'state'])
  for (const k of ['checked', 'commit', 'answer', 'send', 'sendError', 'stillGood', 'storage', 'transport', 'secret', 'o']) expect([k, any[k]]).toEqual([k, undefined])
  expect(JSON.stringify(w)).toBe(JSON.stringify({ profile: w.profile }))
  expect(await w.confirm(r)).toMatchObject({ status: 200 })
})

test('commitState refuses any result in which a held log goes back, whatever the change says', () => {
  const e = (v: string) => ({ versionId: v }) as unknown as Entry
  const held: WalletState = { services: { S: { did: 'd', log: [e('1-a'), e('2-b')] } }, identities: { S: { log: [e('1-x'), e('2-y')], index: 1 } } }
  const tries: [string, WalletState, (s: WalletState) => void, string][] = [
    ['a shorter service log', held, (s) => { s.services.S!.log = [e('1-a')] }, 'a held service log would go back'],
    ['a forked service log', held, (s) => { s.services.S!.log = [e('1-a'), e('2-c')] }, 'a held service log would go back'],
    ['the service dropped', held, (s) => { delete s.services.S }, 'a held service log would go back'],
    ['a deactivation undone', { ...held, services: { S: { ...held.services.S!, deactivated: true } } }, (s) => { delete s.services.S!.deactivated }, 'a held service log would go back'],
    ['a shorter identifier log', held, (s) => { s.identities.S!.log = [e('1-x')] }, 'a held identifier would go back'],
    ['a lower key index', held, (s) => { s.identities.S!.index = 0 }, 'a held identifier would go back'],
    ['the identifier dropped', held, (s) => { delete s.identities.S }, 'a held identifier would go back'],
  ]
  for (const [name, start, change, refused] of tries) {
    const storage = new MemoryStorage(start)
    expect([name, commitState(storage, 0, (s) => { change(s); return { state: s, value: 1 } })]).toEqual([name, { refused }])
    expect(storage.load()).toEqual(start)
  }
  const storage = new MemoryStorage(held)
  expect(commitState(storage, 7, (s) => { s.services.S!.log.push(e('3-c')); return { state: s, value: 'ok' } })).toEqual({ value: 'ok', nowMs: 7 })
  expect(storage.load()!.services.S!.log).toHaveLength(3)
})

test('two first confirmations side by side with different genesis times: exactly one identifier is stored, and both answers carry it', async () => {
  const s = await service()
  let tick = 0
  const moving = () => t + (tick++) * 1000                  // every reading of the clock a second later
  const rec = recording()
  const w = new Wallet(secretOf(45), { now: moving, transport: rec.transport })
  const b1 = browser(s.local), b2 = browser(s.local)
  const a1 = (await b1.call('/anmeldung-log/start')).body, a2 = (await b2.call('/anmeldung-log/start')).body
  const r1 = await opened(w, a1.link), r2 = await opened(w, a2.link)
  const [x1, x2] = await Promise.all([w.confirm(r1), w.confirm(r2)])
  expect([x1, x2]).toMatchObject([{ status: 200 }, { status: 200 }])
  const logs = rec.posts.map((p) => new URLSearchParams(p.body).get(DID_LOG_FIELD))
  expect(logs).toHaveLength(2)
  expect(logs[0]).toBe(logs[1])
  expect(w.identity(s.service.scid)!.log).toHaveLength(1)
  expect(JSON.stringify(w.identity(s.service.scid)!.log[0]) + '\n').toBe(logs[0])
})

// ---- the pickup window is read in the store step, with the time of the decision

/** a store that can hold a session step before it starts, and can run the step once more earlier than the real one (a retry) */
class StepStore extends MemoryLoginStore {
  hold?: Promise<void>
  tryFirstAt?: number
  finalAt?: number
  override async issueSession<T> (did: string, clock: () => number, decide: Parameters<MemoryLoginStore['issueSession']>[2] & ((held: any, now: number) => T)): Promise<T> {
    if (this.hold) await this.hold
    if (this.tryFirstAt !== undefined) { const at = this.tryFirstAt; await super.issueSession(did, () => at, decide) }
    const final = this.finalAt
    return super.issueSession(did, final === undefined ? clock : () => final, decide)
  }
}
const gate = () => { let open!: () => void; const p = new Promise<void>((ok) => { open = ok }); return { p, open } }

/** an admitted QR login not yet collected: the attempt id */
async function answeredQr (s: { service: Service }, w: Wallet): Promise<string> {
  const st = await s.service.start()
  expect(await w.confirm(await opened(w, st.link))).toMatchObject({ status: 200 })
  return st.attempt
}
/** an admitted same-device login not yet redeemed: attempt id and code */
async function answeredSame (s: { service: Service }, w: Wallet): Promise<{ attempt: string, code: string }> {
  const st = await s.service.start('same-device')
  const sent = await w.confirm(await opened(w, st.link))
  if ('error' in sent) throw new Error(sent.error)
  return { attempt: st.attempt, code: new URL(sent.redirect_uri!).searchParams.get('response_code')! }
}

test('QR pickup: the window runs out while the store step waits: no session', async () => {
  const store = new StepStore()
  const s = await service({ store })
  const w = wallet(secretOf(40))
  const attempt = await answeredQr(s, w)
  const g = gate(); store.hold = g.p
  later(4 * 60)
  const pending = s.service.collect(attempt)               // checked in time, then waits in the store
  later(2 * 60)                                            // 6 minutes after the answer
  g.open()
  expect(await pending).toBeNull()
  expect(s.service.held()).toMatchObject({ sessions: 0, outcomes: 0 })
})

test('same-device redeem: the code runs out while the store step waits: no session', async () => {
  const store = new StepStore()
  const s = await service({ store })
  const w = wallet(secretOf(41))
  const { attempt, code } = await answeredSame(s, w)
  const g = gate(); store.hold = g.p
  later(30)
  const pending = s.service.redeem(attempt, code)
  later(40)                                                // 70 s after the answer, the code lives 60 s
  g.open()
  expect(await pending).toBeNull()
  expect(s.service.held()).toMatchObject({ sessions: 0, codes: 0 })
})

test('a store that repeats the session step: the time of the last run decides (QR pickup and redeem)', async () => {
  const store = new StepStore()
  const s = await service({ store })
  const w = wallet(secretOf(42))
  const qr = await answeredQr(s, w)
  const same = await answeredSame(s, w)
  const answered = t
  later(10)                                                // the clock the service reads before the step: in time
  store.tryFirstAt = answered + 1000                       // first run in time, the repeat after both windows
  store.finalAt = answered + 6 * 60_000
  expect(await s.service.collect(qr)).toBeNull()
  expect(await s.service.redeem(same.attempt, same.code)).toBeNull()
  expect(s.service.held()).toMatchObject({ sessions: 0, outcomes: 0, codes: 0 })
})

test('in time, both ways still issue a session, also when the step is repeated', async () => {
  const store = new StepStore()
  const s = await service({ store })
  const w = wallet(secretOf(43))
  const qr = await answeredQr(s, w)
  const same = await answeredSame(s, w)
  store.tryFirstAt = t
  later(10)
  expect(await s.service.collect(qr)).toMatchObject({ session: expect.any(String) })
  expect(await s.service.redeem(same.attempt, same.code)).toMatchObject({ session: expect.any(String) })
  expect(s.service.held().sessions).toBe(2)
})

// ---- a service opened again on a rotated log signs with the key its head names

async function reopened (s: Awaited<ReturnType<typeof service>>, keys: ServiceKeys) {
  const port = Number(new URL(s.local).port)
  const log = fromJsonl(s.service.didLog()) as Entry[]
  s.server.closeAllConnections()
  await new Promise<void>((ok) => s.server.close(() => ok()))
  return service({ keys, log, port })
}

test('a service opened again on its rotated log (once, twice): a new request is accepted and a further rotation works', async () => {
  for (const rotations of [1, 2]) {
    const keys = ServiceKeys.random()
    const s = await service({ keys })
    const w = wallet(secretOf(50 + rotations))
    const first = await loginQr(s, w)
    for (let i = 0; i < rotations; i++) { later(); await s.service.rotateKey() }
    const kid = s.service.kid, head = s.service.headVersion
    const again = await reopened(s, keys)
    expect(again.service.headVersion).toBe(head)
    expect(again.service.kid).toBe(kid)
    const after = await loginQr(again, w)
    expect(after.sent).toMatchObject({ status: 200 })
    expect(after.collected).toEqual(first.collected)
    later(); await again.service.rotateKey()
    expect(again.service.headVersion).not.toBe(head)
    expect((await loginQr(again, w)).collected).toEqual(first.collected)
    later(); await again.service.deactivate()               // the update key index is right as well
  }
})

test('opening an existing log: foreign keys and a deactivated log are refused with a clear error', async () => {
  const keys = ServiceKeys.random()
  const s = await service({ keys })
  later(); await s.service.rotateKey()
  const log = fromJsonl(s.service.didLog()) as Entry[]
  const host = s.service.o.host
  await expect(Service.create({ host, keys: ServiceKeys.random(), now: clock, log })).rejects.toThrow(/service keys|none of the service keys/)
  later(); await s.service.deactivate()
  const dead = fromJsonl(s.service.didLog()) as Entry[]
  await expect(Service.create({ host, keys, now: clock, log: dead })).rejects.toThrow(/deactivated/)
})

test('serve that fails after binding gives the port back: wrong keys, a deactivated log', async () => {
  const keys = ServiceKeys.random()
  const first = await serve({ now: clock, keys })
  const port = Number(new URL(first.local).port)
  later(); await first.service.rotateKey()
  const log = fromJsonl(first.service.didLog()) as Entry[]
  later(); await first.service.deactivate()
  const dead = fromJsonl(first.service.didLog()) as Entry[]
  await new Promise<void>((ok) => first.server.close(() => ok()))
  const free = (): Promise<boolean> => new Promise((ok) => {
    const probe = createServer()
    probe.once('error', () => ok(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => ok(true)))
  })
  expect(await free()).toBe(true)
  await expect(serve({ now: clock, port, keys: ServiceKeys.random(), log })).rejects.toThrow(/service keys|none of the service keys/)
  expect(await free()).toBe(true)
  await expect(serve({ now: clock, port, keys, log: dead })).rejects.toThrow(/deactivated/)
  expect(await free()).toBe(true)
  // and the same port serves again with the right log and keys
  const again = await serve({ now: clock, port, keys, log })
  servers.push(again.server)
  expect(again.local).toBe(first.local)
})
