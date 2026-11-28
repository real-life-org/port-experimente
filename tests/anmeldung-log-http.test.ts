import { afterAll, expect, test } from 'vitest'
import type { Server } from 'node:http'
import { multikey, rotate, type Entry } from '../src/lab/kennung-log/log'
import { scidVh } from '../src/lab/kennung-log/profiles'
import { serve } from '../src/lab/anmeldung-log/http'
import { ServiceKeys, type Service } from '../src/lab/anmeldung-log/service'
import { deriveKey, MemoryStorage, Wallet, type Checked } from '../src/lab/anmeldung-log/wallet'
import { DID_LOG_FIELD } from '../src/lab/anmeldung-log/profile'
import { kidOf, signToken } from '../src/lab/kennung-log/verifier'

// The flows over real HTTP on 127.0.0.1: the service speaks of itself as
// https://dienst.localhost:<port> (the origin in its DID); the wallet reaches
// it there with its explicit test option. One clock for service and wallet,
// moved by hand, so that log entries are seconds apart.

let t = Date.parse('2026-11-28T10:00:00Z')
const clock = () => t
const later = (s = 2) => { t += s * 1000 }
const servers: Server[] = []
afterAll(async () => { await Promise.all(servers.map((s) => new Promise<void>((ok) => s.close(() => ok())))) })

async function service (o: { keys?: ServiceKeys, hostName?: string } = {}) {
  const s = await serve({ now: clock, name: 'Beispieldienst', ...o })
  servers.push(s.server)
  return s
}
const secretOf = (n: number) => new Uint8Array(32).fill(n)
const wallet = (secret: Uint8Array, storage = new MemoryStorage()) => new Wallet(secret, { now: clock, storage, fetch: { loopbackForTests: true } })

/** one browser: its cookies */
function browser (local: string) {
  const jar = new Map<string, string>()
  const call = async (path: string) => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
    const r = await fetch(local + path, { headers: cookie ? { cookie } : {}, redirect: 'manual' })
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const [k, v] = kv!.split('='); if (/Max-Age=0/.test(c) || !v) jar.delete(k!); else jar.set(k!, v) }
    const body = r.headers.get('content-type')?.includes('json') ? await r.json() as any : await r.text()
    return { status: r.status, body }
  }
  return { call, jar }
}

async function opened (w: Wallet, link: string): Promise<Checked> {
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
  expect(stale.collected).toEqual({})
  // the second device changes the key from the old head: a second continuation
  later()
  await w2.rotate(s.service.scid)
  expect((await loginQr(s, w2)).sent).toMatchObject({ status: 400, body: { did_log_result: 'contested' } })
  later()
  const owner = await loginQr(s, w1)
  expect(owner.sent).toMatchObject({ status: 400, body: { did_log_result: 'contested' } })
  expect(owner.collected).toEqual({})
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
  const ka = await deriveKey(secretOf(8), { method: 'did:webvh', scid: a.service.scid }, 'auth', 0)
  const kb = await deriveKey(secretOf(8), { method: 'did:webvh', scid: b.service.scid }, 'auth', 0)
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

test('the person cancels: user_cancelled reaches the checked redirect_uri, the waiting browser learns it, the request is gone', async () => {
  const s = await service()
  const w = wallet(secretOf(10))
  const b = browser(s.local)
  const { vorgang, link } = (await b.call('/anmeldung-log/start')).body
  const r = await opened(w, link)
  expect(await w.cancel(r)).toMatchObject({ status: 200, body: {} })
  expect((await b.call('/anmeldung-log/status?vorgang=' + vorgang)).body).toEqual({ error: 'user_cancelled' })
  expect(await w.confirm(r)).toMatchObject({ status: 400, body: { error_description: 'unknown request' } })
  expect(w.identity(r.scid)?.log).toHaveLength(1)           // created on confirm, but no login
  expect((await b.call('/anmeldung-log/status')).body).toEqual({})
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

/** an answer signed by hand with the wallet's derived key, to change one claim */
async function handAnswer (s: { service: Service, local: string }, w: Wallet, secret: Uint8Array, r: Checked, claims: Record<string, unknown>) {
  const id = w.identity(r.scid)!
  const head = id.log[id.log.length - 1] as Entry
  const key = await deriveKey(secret, { method: 'did:webvh', scid: r.scid }, 'auth', id.index)
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

test('an answer after the request has expired is refused; the request_uri no longer serves it', async () => {
  const s = await service()
  const w = wallet(secretOf(13))
  const b = browser(s.local)
  const { link } = (await b.call('/anmeldung-log/start')).body
  const r = await opened(w, link)
  later(301)
  expect(await w.confirm(r)).toMatchObject({ status: 400, body: { error_description: 'request expired' } })
  const { link: link2 } = (await b.call('/anmeldung-log/start')).body
  later(301)
  expect(await w.open(link2)).toEqual({ ok: false, reason: 'request: HTTP 404' })
})

test('a wallet whose DID method the service does not list refuses, and says so only to the checked redirect_uri', async () => {
  const s = await service()
  const other = new Wallet(secretOf(14), { now: clock, fetch: { loopbackForTests: true }, profile: scidVh })
  const b = browser(s.local)
  const { link } = (await b.call('/anmeldung-log/start')).body
  expect(await other.open(link)).toEqual({ ok: false, reason: 'the service supports none of the wallet\'s DID methods' })
  expect(s.service.held().pending).toBe(0)                  // the error answer ended the request
})
