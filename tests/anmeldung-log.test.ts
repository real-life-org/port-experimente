import { afterAll, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import { b64uOf } from 'rltp-lib'
import { toJsonl, type Entry } from '../src/lab/kennung-log/log'
import { CLIENT_ID_PREFIX, keyContext, locate, outerLink, parseOuter, REQUEST_TYP, SIOP_AUD, signRequestObject, type RequestClaims } from '../src/lab/anmeldung-log/profile'
import { serviceLog, ServiceKeys } from '../src/lab/anmeldung-log/service'
import { deriveKey, limitedFetch, Wallet } from '../src/lab/anmeldung-log/wallet'

// What the wallet refuses before anything is shown or sent, against services
// built by hand on 127.0.0.1 (each with its own did:webvh under
// <name>.localhost%3A<port>). Every refusal is checked to send nothing.

const T = Date.parse('2026-11-28T10:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const servers: Server[] = []
afterAll(async () => { await Promise.all(servers.map((s) => new Promise<void>((ok) => s.close(() => ok())))) })
const wallet = (n = 1) => new Wallet(new Uint8Array(32).fill(n), { now: () => T, fetch: { loopbackForTests: true } })

interface Fake { port: number, origin: string, host: string, did: string, log: Entry[], keys: ServiceKeys, routes: Map<string, { type: string, body: string, status?: number, location?: string }>, hits: string[], posts: string[] }

/** A service on 127.0.0.1 that serves exactly what the test puts in `routes`. Its log is real unless replaced. */
async function fake (name = 'dienst', seed = 1): Promise<Fake> {
  const routes = new Map<string, { type: string, body: string, status?: number, location?: string }>()
  const hits: string[] = [], posts: string[] = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    if (req.method === 'POST') posts.push(body)
    hits.push(`${req.method} ${req.url}`)
    const r = routes.get(req.url ?? '')
    if (!r) { res.writeHead(404); res.end(); return }
    res.writeHead(r.status ?? 200, { 'Content-Type': r.type, ...(r.location ? { Location: r.location } : {}) }); res.end(r.body)
  })
  servers.push(server)
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const port = (server.address() as { port: number }).port
  const host = `${name}.localhost%3A${port}`
  const keys = new ServiceKeys(new Uint8Array(32).fill(seed))
  const log = await serviceLog(host, keys, iso(T - 86_400_000))
  const did = log[0]!.state.id as string
  routes.set('/.well-known/did.jsonl', { type: 'text/jsonl', body: toJsonl(log) })
  return { port, origin: `https://${name}.localhost:${port}`, host, did, log, keys, routes, hits, posts }
}

function claims (f: Fake, o: Partial<RequestClaims> = {}): RequestClaims {
  const iat = Math.floor(T / 1000)
  return {
    iss: CLIENT_ID_PREFIX + f.did, aud: SIOP_AUD, client_id: CLIENT_ID_PREFIX + f.did,
    response_type: 'id_token', response_mode: 'direct_post', scope: 'openid', id_token_type: 'subject_signed_id_token',
    redirect_uri: f.origin + '/antwort', nonce: 'n-1', state: 's-1',
    client_metadata: { subject_syntax_types_supported: ['did:vh'], client_name: 'Fake' },
    iat, nbf: iat, exp: iat + 300, ...o,
  }
}
/** serve a Request Object at /r and return the link to it */
async function offer (f: Fake, o: { claims?: Partial<RequestClaims>, kid?: string, jwt?: string, clientId?: string, requestUri?: string } = {}): Promise<string> {
  const jwt = o.jwt ?? await signRequestObject(await f.keys.auth(0), o.kid ?? `${f.did}#key-1`, claims(f, o.claims))
  f.routes.set('/r', { type: 'application/oauth-authz-req+jwt', body: jwt })
  return outerLink(o.clientId ?? CLIENT_ID_PREFIX + f.did, o.requestUri ?? f.origin + '/r')
}
const b64 = (o: unknown) => b64uOf(new TextEncoder().encode(JSON.stringify(o)))

test('a well-formed request is accepted, and confirming posts once to the redirect_uri', async () => {
  const f = await fake()
  const w = wallet()
  const o = await w.open(await offer(f))
  expect(o.ok).toBe(true)
  if (!o.ok) return
  f.routes.set('/antwort', { type: 'application/json', body: '{}' })
  expect(await w.confirm(o.request)).toMatchObject({ status: 200 })
  expect(f.posts).toHaveLength(1)
  const form = new URLSearchParams(f.posts[0])
  expect([...form.keys()]).toEqual(['id_token', 'state', 'did_log'])
})

const refusals: [string, (f: Fake) => Promise<string>, string][] = [
  ['a changed request (signature no longer matches)', async (f) => {
    const [h, , s] = (await signRequestObject(await f.keys.auth(0), `${f.did}#key-1`, claims(f))).split('.')
    return offer(f, { jwt: `${h}.${b64(claims(f, { redirect_uri: f.origin + '/anders' }))}.${s}` })
  }, 'request: signature does not verify'],
  ['a kid that is not in the document', (f) => offer(f, { kid: `${f.did}#key-2` }), 'request: kid is not a key of the service DID at its current head'],
  ['a kid of another DID', (f) => offer(f, { kid: `did:webvh:${f.log[0]!.parameters.scid as string}:other.example#key-1` }), 'request: kid is not a key of the service DID at its current head'],
  ['a request signed with another key under the right kid', async (f) => {
    const jwt = await signRequestObject(await f.keys.auth(7), `${f.did}#key-1`, claims(f))
    return offer(f, { jwt })
  }, 'request: signature does not verify'],
  ['client_id outside and inside differ', (f) => offer(f, { claims: { client_id: CLIENT_ID_PREFIX + 'did:webvh:other' } }), 'request: client_id outside and inside differ'],
  ['client_id inside without the prefix', (f) => offer(f, { claims: { client_id: f.did } }), 'request: client_id outside and inside differ'],
  ['redirect_uri on another host', (f) => offer(f, { claims: { redirect_uri: `https://anderer.localhost:${f.port}/antwort` } }), 'redirect_uri is not on the HTTPS origin of the service DID'],
  ['redirect_uri on another port', (f) => offer(f, { claims: { redirect_uri: `https://dienst.localhost:${f.port + 1}/antwort` } }), 'redirect_uri is not on the HTTPS origin of the service DID'],
  ['redirect_uri over http', (f) => offer(f, { claims: { redirect_uri: `http://dienst.localhost:${f.port}/antwort` } }), 'redirect_uri is not on the HTTPS origin of the service DID'],
  ['an unsigned request (alg none)', (f) => offer(f, { jwt: `${b64({ alg: 'none', typ: REQUEST_TYP })}.${b64(claims(f))}.` }), 'request: not signed with EdDSA'],
  ['a request without typ', async (f) => {
    const c = claims(f)
    const key = await f.keys.auth(0)
    const input = `${b64({ alg: 'EdDSA', kid: `${f.did}#key-1` })}.${b64(c)}`
    const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', key.priv, new TextEncoder().encode(input)))
    return offer(f, { jwt: `${input}.${b64uOf(sig)}` })
  }, 'request: typ is not oauth-authz-req+jwt'],
  ['an expired request', (f) => offer(f, { claims: { iat: Math.floor(T / 1000) - 400, nbf: Math.floor(T / 1000) - 400, exp: Math.floor(T / 1000) - 100 } }), 'request: expired'],
  ['a request valid for longer than the profile allows', (f) => offer(f, { claims: { exp: Math.floor(T / 1000) + 3600 } }), 'request: valid for longer than this profile allows'],
  ['a request for the wrong audience', (f) => offer(f, { claims: { aud: 'https://wallet.example' } }), 'request: aud is not https://self-issued.me/v2'],
  ['a request with response_uri (OpenID4VP) instead of redirect_uri', (f) => offer(f, { claims: { response_uri: f.origin + '/antwort' } as any }), 'request: response_uri is not part of this profile (redirect_uri with direct_post)'],
  ['a request with id_token_type subject_signed (the OpenID4VP example value)', (f) => offer(f, { claims: { id_token_type: 'subject_signed' } }), 'request: id_token_type does not ask for subject_signed_id_token'],
  ['a log that is the log of another DID', async (f) => {
    const g = await fake('anderer', 2)
    f.routes.set('/.well-known/did.jsonl', { type: 'text/jsonl', body: toJsonl(g.log) })
    return offer(f)
  }, 'service log: the log is not the log of this DID'],
  ['a log changed after signing', async (f) => {
    const log = structuredClone(f.log); (log[0]!.state as any).service = [{ id: '#x', type: 'X', serviceEndpoint: 'https://x.example' }]
    f.routes.set('/.well-known/did.jsonl', { type: 'text/jsonl', body: toJsonl(log) })
    return offer(f)
  }, 'service log: signature does not verify'],
  ['the SCID of another service in the DID text, with that service\'s log served', async (f) => {
    // the DID names A's SCID but this host; A's log names A's host in state.id, so it is not this DID's log
    const a = await fake('a-dienst', 3)
    const forged = `did:webvh:${a.log[0]!.parameters.scid as string}:${f.host}`
    f.routes.set('/.well-known/did.jsonl', { type: 'text/jsonl', body: toJsonl(a.log) })
    return offer(f, { clientId: CLIENT_ID_PREFIX + forged, claims: { client_id: CLIENT_ID_PREFIX + forged } })
  }, 'service log: state.id is not the DID'],
  ['a request_uri on another origin', async (f) => {
    const g = await fake('anderer', 4)
    await offer(g)
    return outerLink(CLIENT_ID_PREFIX + f.did, g.origin + '/r')
  }, 'request_uri is not on the origin of the service DID'],
  ['a log fetch answered with a redirect', async (f) => {
    f.routes.set('/.well-known/did.jsonl', { type: 'text/plain', body: '', status: 302, location: 'https://example.com/did.jsonl' })
    return offer(f)
  }, 'service log: a redirect (not followed)'],
  ['a log too large', async (f) => {
    f.routes.set('/.well-known/did.jsonl', { type: 'text/jsonl', body: toJsonl(f.log) + ' '.repeat(300_000) })
    return offer(f)
  }, 'service log: too large'],
]

for (const [name, make, reason] of refusals) {
  test(`refused: ${name}; nothing is sent`, async () => {
    const f = await fake()
    const link = await make(f)
    expect(await wallet().open(link)).toEqual({ ok: false, reason })
    expect(f.posts).toEqual([])
  })
}

test('refused without any fetch: a request by value, a link without request_uri, a client_id without prefix, a service DID that is not did:webvh', async () => {
  const f = await fake()
  const c = claims(f)
  const byValue = 'https://web-of-trust.de/a#' + new URLSearchParams(Object.entries(c).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])).toString()
  expect(await wallet().open(byValue)).toEqual({ ok: false, reason: 'no request_uri: an unsigned request is not accepted' })
  expect(await wallet().open(`https://web-of-trust.de/a#client_id=x&request=${'e'.repeat(10)}&request_uri=${encodeURIComponent(f.origin + '/r')}`)).toEqual({ ok: false, reason: 'a request by value is not accepted' })
  expect(await wallet().open(outerLink(f.did, f.origin + '/r'))).toEqual({ ok: false, reason: 'client_id has no decentralized_identifier prefix' })
  expect(await wallet().open(outerLink(CLIENT_ID_PREFIX + 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK', f.origin + '/r'))).toEqual({ ok: false, reason: 'the service DID is not a did:webvh' })
  expect(f.hits).toEqual([])
})

test('the SCID comes only from the verified log: a claim naming another SCID changes nothing', async () => {
  const f = await fake()
  const a = await fake('a-dienst', 5)
  const w = wallet(9)
  const o = await w.open(await offer(f, { claims: { scid: a.log[0]!.parameters.scid } as any }))
  if (!o.ok) throw new Error(o.reason)
  expect(o.request.scid).toBe(f.log[0]!.parameters.scid)
  f.routes.set('/antwort', { type: 'application/json', body: '{}' })
  await w.confirm(o.request)
  const own = w.identity(o.request.scid)!.log[0]!.parameters.updateKeys as string[]
  const fromF = await deriveKey(new Uint8Array(32).fill(9), { method: 'did:webvh', scid: f.log[0]!.parameters.scid as string }, 'update', 0)
  const { multikey } = await import('../src/lab/kennung-log/log')
  expect(own).toEqual([multikey(fromF.pubRaw)])
})

test('the return address is opened only on the service origin', async () => {
  for (const [given, opened] of [[`https://dienst.localhost:PORT/fertig?response_code=x`, true], ['https://evil.example/fertig?response_code=x', false], [`http://dienst.localhost:PORT/fertig`, false]] as const) {
    const f = await fake()
    const w = wallet()
    const o = await w.open(await offer(f))
    if (!o.ok) throw new Error(o.reason)
    const uri = given.replace('PORT', String(f.port))
    f.routes.set('/antwort', { type: 'application/json', body: JSON.stringify({ redirect_uri: uri }) })
    const sent = await w.confirm(o.request)
    expect('redirect_uri' in sent ? sent.redirect_uri : undefined).toBe(opened ? uri : undefined)
  }
})

test('did:webvh 1.0, The DID to HTTPS Transformation: the examples of the spec', () => {
  const S = 'QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ'
  expect(locate(`did:webvh:${S}:example.com`)).toMatchObject({ logUrl: 'https://example.com/.well-known/did.jsonl', origin: 'https://example.com' })
  expect(locate(`did:webvh:${S}:issuer.example.com`)).toMatchObject({ logUrl: 'https://issuer.example.com/.well-known/did.jsonl' })
  expect(locate(`did:webvh:${S}:example.com:dids:issuer`)).toMatchObject({ logUrl: 'https://example.com/dids/issuer/did.jsonl', origin: 'https://example.com' })
  expect(locate(`did:webvh:${S}:example.com%3A3000:dids:issuer`)).toMatchObject({ logUrl: 'https://example.com:3000/dids/issuer/did.jsonl', origin: 'https://example.com:3000' })
  expect(locate(`did:webvh:${S}:example.com%3A3000`)).toMatchObject({ logUrl: 'https://example.com:3000/.well-known/did.jsonl' })
  expect(locate(`did:webvh:${S}:127.0.0.1`)).toHaveProperty('error')
  expect(locate(`did:webvh:${S}:example.com#key-1`)).toEqual({ error: 'not a bare DID' })
})

test('fetches: https only, no local address without the test option, no credentials', async () => {
  expect(await limitedFetch('http://example.com/x', { maxBytes: 10 })).toEqual({ error: 'not https' })
  for (const u of ['https://127.0.0.1/x', 'https://[::1]/x', 'https://localhost/x', 'https://dienst.localhost:1/x', 'https://drucker.local/x', 'https://0x7f000001/x']) {
    expect(await limitedFetch(u, { maxBytes: 10 })).toEqual({ error: 'a local address' })
  }
  expect(await limitedFetch('https://a:b@example.com/x', { maxBytes: 10 })).toEqual({ error: 'credentials in the URL' })
})

test('the derivation context is fixed, versioned and delimited', () => {
  expect(keyContext('did:webvh', 'QmX', 'auth', 0)).toBe('{"index":0,"method":"did:webvh","profile":"x-anmeldung-log/1","purpose":"login identifier","role":"auth","scid":"QmX"}')
  expect(parseOuter('openid://?client_id=x&request_uri=y')).toEqual({ error: 'not a login link' })
})
