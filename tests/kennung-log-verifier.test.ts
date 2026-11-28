import { expect, test } from 'vitest'
import { b64uOf, platformSubtle } from 'rltp-lib'
import { append, keyHash, loginKeys, multikey, rotate, type Entry } from '../src/lab/kennung-log/log'
import { vh } from '../src/lab/kennung-log/profiles'
import { kidOf, MemoryStore, signToken, Verifier, type Held, type NonceState, type Store } from '../src/lab/kennung-log/verifier'
import { at, change, genesis, keyOf, NOW, type Holder } from '../src/lab/kennung-log/scenarios'

// The verifier's single step per DID (head comparison, evidence, nonce,
// admission), its private copy of the input, and its nonces.

const AUD = 'https://service.example'
const T = Math.floor(NOW.getTime() / 1000)
const headOf = (h: Holder): Entry => h.log[h.log.length - 1] as Entry
const didOf = (h: Holder): string => headOf(h).state.id as string

async function tokenFor (h: Holder, nonce: string, o: { key?: Holder['auth'], version?: string, header?: Record<string, unknown> } = {}): Promise<string> {
  const did = didOf(h)
  const claims = { iss: did, sub: did, aud: AUD, nonce, iat: T, exp: T + 300 }
  const kid = kidOf(did, o.version ?? headOf(h).versionId)
  if (!o.header) return signToken(o.key ?? h.auth, kid, claims)
  const te = new TextEncoder()
  const part = (x: unknown) => b64uOf(te.encode(JSON.stringify(x)))
  const input = `${part({ alg: 'EdDSA', typ: 'JWT', kid, ...o.header })}.${part(claims)}`
  const sig = new Uint8Array(await platformSubtle().sign('Ed25519', (o.key ?? h.auth).priv, te.encode(input)))
  return `${input}.${b64uOf(sig)}`
}

const verifier = (store?: Store, now = () => NOW) => new Verifier({ profile: vh, audience: AUD, now, store, nonceTtlSec: 120 })
async function login (v: Verifier, h: Holder, o: Parameters<typeof tokenFor>[2] = {}) {
  const nonce = await v.issueNonce()
  return v.login({ log: h.log, nonce, token: await tokenFor(h, nonce, o) })
}

test('two valid continuations of the same head at once: one ok, the other contested, both branches kept', async () => {
  for (const order of [0, 1]) {
    const v = verifier()
    const o1 = await genesis(vh)
    expect(await login(v, o1)).toMatchObject({ kind: 'ok', step: 'first contact' })
    const mine = await change(o1, 'owner', 1, 1)
    const theirs = await change(o1, 'copy', 1, 2)
    const pair = order === 0 ? [mine, theirs] : [theirs, mine]
    const results = await Promise.all(pair.map((h) => login(v, h)))
    expect(results.map((r) => r.kind).sort()).toEqual(['contested', 'ok'])
    const held = await v.holding(didOf(o1)) as Held
    expect(held.contested).toBe(true)
    expect(held.evidence.map((l) => headOf({ log: l } as Holder).versionId).sort()).toEqual([headOf(mine).versionId, headOf(theirs).versionId].sort())
  }
})

/** A store that holds back one nonce's step until `release` is called. */
class GatedStore implements Store {
  private readonly inner = new MemoryStore()
  private gate: Promise<void> | null = null
  release = (): void => {}
  hold (nonce: string): void { this.held = nonce; this.gate = new Promise((r) => { this.release = r }) }
  private held = ''
  issue (nonce: string, expires: number, now: number) { return this.inner.issue(nonce, expires, now) }
  read (did: string) { return this.inner.read(did) }
  async transact<T> (did: string, nonce: string, clock: () => number, decide: (h: Held | undefined, n: NonceState, now: number) => { held?: Held, result: T }): Promise<T> {
    if (nonce === this.held && this.gate) await this.gate
    return this.inner.transact(did, nonce, clock, decide)
  }
}

test('a login that began before the identifier was contested does not end ok', async () => {
  const store = new GatedStore()
  const v = verifier(store)
  const o1 = await genesis(vh)
  expect(await login(v, o1)).toMatchObject({ kind: 'ok' })
  const nonce = await v.issueNonce()
  store.hold(nonce)
  const early = v.login({ log: o1.log, nonce, token: await tokenFor(o1, nonce) })   // same head, a good token
  await new Promise((r) => setTimeout(r, 20))                                         // its checks are done; its step waits
  expect(await login(v, await change(o1, 'owner', 1, 1))).toMatchObject({ kind: 'ok', step: 'continued' })
  expect(await login(v, await change(o1, 'copy', 1, 2))).toMatchObject({ kind: 'contested' })
  store.release()
  expect(await early).toMatchObject({ kind: 'contested' })
})

test('a verified continuation is kept although its login fails; a sibling is then a fork, and the old head no longer admits', async () => {
  const v = verifier()
  const o1 = await genesis(vh)
  const o2 = await change(o1, 'owner', 1, 1)
  expect(await login(v, o1)).toMatchObject({ kind: 'ok' })
  // the continuation with a token by a key that is not the head's
  expect(await login(v, o2, { key: o1.auth })).toEqual({ kind: 'invalid', reason: 'token: signature does not verify' })
  expect((await v.holding(didOf(o1)))?.head.versionId).toBe(headOf(o2).versionId)
  // a token under the old head, with the old log: stale; with the new log: not under the head
  expect(await login(v, o1)).toEqual({ kind: 'stale', did: didOf(o1), held: headOf(o2).versionId })
  expect(await login(v, o2, { key: o1.auth, version: headOf(o1).versionId })).toEqual({ kind: 'invalid', reason: 'token: signed under another version than the head' })
  // a sibling of the kept continuation
  expect(await login(v, await change(o1, 'copy', 1, 2))).toMatchObject({ kind: 'contested' })
  expect(await login(v, o2)).toMatchObject({ kind: 'contested' })
})

test('the verifier works on its own copy: changing the input during and after the call changes nothing it holds', async () => {
  const v = verifier()
  const o1 = await genesis(vh)
  const did = didOf(o1)
  const original = structuredClone(o1.log)
  const input = structuredClone(o1.log)
  const nonce = await v.issueNonce()
  const pending = v.login({ log: input, nonce, token: await tokenFor(o1, nonce) })
  const vm = (input[0] as any).state.verificationMethod[0]
  vm.publicKeyMultibase = 'z6MkqgiHDj17BY9qa7KiFioFTPLWheArRS8JKPGMeApvEqPk'   // during the call
  expect(await pending).toMatchObject({ kind: 'ok', step: 'first contact' })
  ;(input[0] as any).state.authentication = []                                     // after the call
  expect((await v.holding(did))?.log).toEqual(original)
  expect((await v.holding(did))?.head.doc).toEqual((original[0] as Entry).state)
  // the key it uses is the one it verified
  expect(await login(v, o1)).toMatchObject({ kind: 'ok', step: 'same head' })
})

test('a nonce is issued by the verifier and spent once; a replayed answer is never ok', async () => {
  let now = NOW
  const v = verifier(undefined, () => now)
  const o1 = await genesis(vh)
  const nonce = await v.issueNonce()
  const answer = { log: o1.log, nonce, token: await tokenFor(o1, nonce) }
  expect(await v.login(answer)).toMatchObject({ kind: 'ok' })
  expect(await v.login(answer)).toEqual({ kind: 'invalid', reason: 'nonce: already used' })
  // the same answer twice at once
  const n2 = await v.issueNonce()
  const a2 = { log: o1.log, nonce: n2, token: await tokenFor(o1, n2) }
  expect((await Promise.all([v.login(a2), v.login(a2)])).map((r) => r.kind).sort()).toEqual(['invalid', 'ok'])
  // a nonce the verifier did not issue
  expect(await v.login({ log: o1.log, nonce: 'mine', token: await tokenFor(o1, 'mine') })).toEqual({ kind: 'invalid', reason: 'nonce: not issued here' })
  // an expired nonce
  const n3 = await v.issueNonce()
  const a3 = { log: o1.log, nonce: n3, token: await tokenFor(o1, n3) }
  now = new Date(NOW.getTime() + 121_000)   // the nonce has expired, the token (300 s) has not
  expect(await v.login(a3)).toEqual({ kind: 'invalid', reason: 'nonce: expired' })
})

test('a token with a critical header parameter the verifier does not know is rejected (RFC 7515 4.1.11)', async () => {
  const v = verifier()
  const o1 = await genesis(vh)
  expect(await login(v, o1, { header: { crit: ['exp'], exp: T + 60 } })).toEqual({ kind: 'invalid', reason: 'token: crit names a header parameter this verifier does not support' })
  expect(await login(v, o1, { header: { crit: [] } })).toEqual({ kind: 'invalid', reason: 'token: crit names a header parameter this verifier does not support' })
  expect(await login(v, o1)).toMatchObject({ kind: 'ok' })
})

test('a new head with the authentication key unchanged: a token under the old head fails', async () => {
  const v = verifier()
  const o1 = await genesis(vh)
  expect(await login(v, o1)).toMatchObject({ kind: 'ok' })
  const next = await keyOf('owner update 2')
  const o2: Holder = { log: await rotate(o1.log, { signer: o1.next, next: [next.pubRaw], time: at(1) }), next, auth: o1.auth }
  expect(headOf(o2).state).toEqual(headOf(o1).state)
  expect(await login(v, o2, { version: headOf(o1).versionId })).toEqual({ kind: 'invalid', reason: 'token: signed under another version than the head' })
  expect(await login(v, o2)).toMatchObject({ kind: 'ok', step: 'same head' })
})

test('the time of the nonce and of the token is the time of the decision: expiry while the step waits is never ok', async () => {
  for (const [what, ttl, jump, reason] of [['the nonce', 120, 121, 'nonce: expired'], ['the token', 1000, 301, 'token: outside its time']] as const) {
    let now = NOW
    const store = new GatedStore()
    const v = new Verifier({ profile: vh, audience: AUD, now: () => now, store, nonceTtlSec: ttl })
    const o1 = await genesis(vh)
    const nonce = await v.issueNonce()
    store.hold(nonce)
    const pending = v.login({ log: o1.log, nonce, token: await tokenFor(o1, nonce) })   // token: 300 s
    await new Promise((r) => setTimeout(r, 20))                                          // checks done at NOW, the step waits
    now = new Date(NOW.getTime() + jump * 1000)                                          // it runs later, once the time is out
    store.release()
    expect(await pending, what).toEqual({ kind: 'invalid', reason })
  }
})

test('expired nonces are dropped when a new one is issued; a spent one stays until it expires', async () => {
  let now = NOW
  const store = new MemoryStore()
  const v = new Verifier({ profile: vh, audience: AUD, now: () => now, store, nonceTtlSec: 120 })
  const o1 = await genesis(vh)
  const n1 = await v.issueNonce()
  const answer = { log: o1.log, nonce: n1, token: await tokenFor(o1, n1) }
  expect(await v.login(answer)).toMatchObject({ kind: 'ok' })
  await v.issueNonce(); await v.issueNonce()
  expect(store.nonceCount).toBe(3)
  expect(await v.login(answer)).toEqual({ kind: 'invalid', reason: 'nonce: already used' })   // spent, not yet expired
  now = new Date(NOW.getTime() + 121_000)
  await v.issueNonce()
  expect(store.nonceCount).toBe(1)
  expect((await v.login(answer)).kind).toBe('invalid')
})

// ── one rule for rotation and login ─────────────────────────────────────

/** A genesis whose head document is `edit(doc)`, written under pre-rotation by the committed key. */
async function withDoc (edit: (doc: Record<string, unknown>) => Record<string, unknown>): Promise<Holder> {
  const g = await genesis(vh)
  const head = headOf(g)
  const next = await keyOf('doc editor next')
  const params = { updateKeys: [multikey(g.next.pubRaw)], nextKeyHashes: [await keyHash(multikey(next.pubRaw))] }
  return { log: await append(g.log, { parameters: params, state: edit(head.state), signer: g.next, time: at(1) }), next, auth: g.auth }
}
const methodOf = (doc: Record<string, unknown>): Record<string, unknown> => (doc.verificationMethod as Record<string, unknown>[])[0]!

test('a key in JWK form is refused by rotate before anything is written', async () => {
  const h = await withDoc((doc) => {
    const { publicKeyMultibase, ...vm } = methodOf(doc)
    return { ...doc, verificationMethod: [{ ...vm, type: 'JsonWebKey', publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: 'AAAA' } }] }
  })
  const a1 = await keyOf('jwk new auth')
  const before = JSON.stringify(h.log)
  await expect(rotate(h.log, { signer: h.next, next: [], authKey: a1.pubRaw, time: at(2) })).rejects.toThrow(/authentication key/)
  expect(JSON.stringify(h.log)).toBe(before)
})

test('service endpoint, rotation, login with the new key; the old key is refused', async () => {
  const hub = { id: 'did:example:x#hub', type: 'LinkedDomains', serviceEndpoint: 'https://example.com/hub' }
  const h = await withDoc((doc) => ({ ...doc, service: [{ ...hub, id: `${doc.id}#hub` }] }))
  const store = new MemoryStore()
  const v = verifier(store)
  expect(await login(v, h)).toMatchObject({ kind: 'ok', step: 'first contact' })
  const moved = await change(h, 'owner', 2, 2)
  const nonce = await v.issueNonce()
  const did = didOf(moved)
  const t = { iss: did, sub: did, aud: AUD, nonce, iat: T, exp: T + 300 }
  const kid = kidOf(did, headOf(moved).versionId)
  expect(await v.login({ log: moved.log, nonce, token: await signToken(moved.auth, kid, t) })).toMatchObject({ kind: 'ok', step: 'continued' })
  const n2 = await v.issueNonce()
  expect(await v.login({ log: moved.log, nonce: n2, token: await signToken(h.auth, kid, { ...t, nonce: n2 }) })).toEqual({ kind: 'invalid', reason: 'token: signature does not verify' })
  expect((await store.read(did))?.head.doc.service).toEqual([{ ...hub, id: `${did}#hub` }])
})

const withId = (idOf: (did: string) => string) => (doc: Record<string, unknown>): Record<string, unknown> => {
  const id = idOf(doc.id as string)
  return { ...doc, verificationMethod: [{ ...methodOf(doc), id }], authentication: [id] }
}

test('rotate and login share one rule: what rotate takes, login can use; what login refuses, rotate refuses', async () => {
  const mk = (edit: (vm: Record<string, unknown>, doc: Record<string, unknown>) => Record<string, unknown>) =>
    (doc: Record<string, unknown>) => ({ ...doc, verificationMethod: [edit(methodOf(doc), doc)] })
  const accepted: Record<string, (doc: Record<string, unknown>) => Record<string, unknown>> = {
    plain: (doc) => doc,
    'extra member on the method': mk((vm) => ({ ...vm, comment: 'x' })),
    'other fragment': (doc) => {
      const id = `${doc.id}#signing`
      return { ...doc, verificationMethod: [{ ...methodOf(doc), id }], authentication: [id] }
    },
    'extra document members': (doc) => ({ ...doc, alsoKnownAs: ['https://example.com/a'], service: [] }),
  }
  const refused: Record<string, (doc: Record<string, unknown>) => Record<string, unknown>> = {
    'JWK': mk(({ publicKeyMultibase, ...vm }) => ({ ...vm, type: 'JsonWebKey', publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: 'AAAA' } })),
    'another controller': mk((vm) => ({ ...vm, controller: 'did:example:other' })),
    'not a Multikey': mk((vm) => ({ ...vm, type: 'Ed25519VerificationKey2020' })),
    'not an Ed25519 multikey': mk((vm) => ({ ...vm, publicKeyMultibase: 'z6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc' })),
    // method ids the login cannot find under <did>#<fragment>
    'id with a path': withId((did) => `${did}/keys#signing`),
    'id with a query': withId((did) => `${did}?service=x#signing`),
    'id of another DID': withId(() => 'did:example:other#signing'),
    'empty fragment': withId((did) => `${did}#`),
    'no fragment': withId((did) => did),
    // DID Core 5.2.1: the id of a verification method is a DID URL; neither side supports the relative form
    'relative id': withId(() => '#signing'),
  }
  for (const [name, edit] of Object.entries(accepted)) {
    const h = await withDoc(edit)
    const a1 = await keyOf(`shared rule ${name}`)
    const log = await rotate(h.log, { signer: h.next, next: [], authKey: a1.pubRaw, time: at(2) })
    const did = didOf(h)
    const fragment = String((methodOf(headOf(h).state).id as string).split('#')[1])
    const v = verifier()
    const nonce = await v.issueNonce()
    const token = await signToken(a1, kidOf(did, (log[log.length - 1] as Entry).versionId, fragment), { iss: did, sub: did, aud: AUD, nonce, iat: T, exp: T + 300 })
    expect(await v.login({ log, nonce, token }), name).toMatchObject({ kind: 'ok' })
  }
  for (const [name, edit] of Object.entries(refused)) {
    const h = await withDoc(edit)
    const a1 = await keyOf(`shared rule ${name}`)
    await expect(rotate(h.log, { signer: h.next, next: [], authKey: a1.pubRaw, time: at(2) }), name).rejects.toThrow(/authentication key/)
    expect(loginKeys(headOf(h).state), name).toEqual([])
  }
})

test('one rule, checked on the result: rotate succeeds only if the login can use the new key', async () => {
  const shapes = [
    (doc: Record<string, unknown>) => doc,
    withId((did) => `${did}#signing`),
    withId((did) => `${did}#a/b`),
    withId((did) => `${did}/keys#signing`),
    withId((did) => `${did}#`),
    withId(() => '#signing'),
    withId((did) => `${did}?x=1#k`),
    (doc: Record<string, unknown>) => ({ ...doc, authentication: [{ ...methodOf(doc) }], verificationMethod: [] }),
  ]
  let accepted = 0
  for (const [i, edit] of shapes.entries()) {
    const h = await withDoc(edit)
    const a1 = await keyOf(`property ${i}`)
    let log: Entry[] | undefined
    try { log = await rotate(h.log, { signer: h.next, next: [], authKey: a1.pubRaw, time: at(2) }) } catch { log = undefined }
    if (!log) continue
    accepted++
    const head = log[log.length - 1] as Entry
    const keys = loginKeys(head.state)
    expect(keys.length, `shape ${i}`).toBe(1)
    const did = didOf(h)
    const v = verifier()
    const nonce = await v.issueNonce()
    const token = await signToken(a1, kidOf(did, head.versionId, keys[0]!.fragment), { iss: did, sub: did, aud: AUD, nonce, iat: T, exp: T + 300 })
    expect(await v.login({ log, nonce, token }), `shape ${i}`).toMatchObject({ kind: 'ok' })
  }
  expect(accepted).toBe(3)
})
