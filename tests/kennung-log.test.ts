import { expect, test } from 'vitest'
import { edFromSeed, rand } from 'rltp-lib'
import { append, create, deactivate, fromJsonl, keyHash, multikey, rotate, toJsonl, verify, type Entry } from '../src/lab/kennung-log/log'
import { scidVh, vh, webvh } from '../src/lab/kennung-log/profiles'
import { kidOf, signToken, Verifier } from '../src/lab/kennung-log/verifier'
import { at, change, genesis, keyOf, NOW, tampered } from '../src/lab/kennung-log/scenarios'

const fresh = () => edFromSeed(rand(32))

test('write, change keys and deactivate under each name, with keys drawn at random; the log survives JSON Lines', async () => {
  for (const p of [webvh('example.com'), vh, scidVh]) {
    const [u0, u1, u2, a0, a1] = await Promise.all([fresh(), fresh(), fresh(), fresh(), fresh()])
    let log = await create({ profile: p, updateKey: u0, next: [u1.pubRaw], authKey: a0.pubRaw, time: at(0) })
    log = await rotate(log, { signer: u1, next: [u2.pubRaw], authKey: a1.pubRaw, time: at(1) })
    log = await deactivate(log, { signer: u2, time: at(2) })
    const back = fromJsonl(toJsonl(log))
    const r = await verify(back, { profile: p, now: NOW })
    expect(r.ok && r.versions.map((v) => [v.versionNumber, v.deactivated])).toEqual([[1, false], [2, false], [3, false], [4, true]])
    expect(r.ok && r.did).toBe(p.did.replace('{SCID}', (log[0] as Entry).parameters.scid as string))
  }
})

test('the same keys and time under three names give three SCIDs, each valid only under its own name', async () => {
  const logs = await Promise.all([webvh('example.com'), vh, scidVh].map(async (p) => (await genesis(p)).log))
  expect(new Set(logs.map((l) => (l[0] as Entry).parameters.scid)).size).toBe(3)
  const ps = [webvh('example.com'), vh, scidVh]
  for (const [i, log] of logs.entries()) for (const [j, p] of ps.entries()) expect((await verify(log, { profile: p, now: NOW })).ok).toBe(i === j)
})

test('the caller can require the DID it asked for', async () => {
  const log = (await genesis(vh)).log
  const did = (log[0] as Entry).state.id as string
  expect((await verify(log, { profile: vh, now: NOW, did })).ok).toBe(true)
  expect(await verify(log, { profile: vh, now: NOW, did: did.slice(0, -1) + 'x' })).toMatchObject({ ok: false, reason: 'the log is not the log of this DID' })
})

test('every tampered log is rejected', async () => {
  for (const p of [webvh('example.com'), vh, scidVh]) {
    const cases = await tampered(p)
    expect(cases.length).toBe(42)
    for (const c of cases) expect((await verify(c.log, { profile: p, now: NOW })).ok, `${c.field} (entry ${c.entry})`).toBe(false)
  }
})

test('the service: an invalid log locks nothing, a verified continuation is kept even when its login fails, a second valid continuation locks every login', async () => {
  const aud = 'https://service.example'
  const v = new Verifier({ profile: vh, audience: aud, now: () => NOW })
  const t = Math.floor(NOW.getTime() / 1000)
  const loginWith = async (h: Awaited<ReturnType<typeof genesis>>, claimed?: string) => {
    const head = h.log[h.log.length - 1] as Entry
    const did = head.state.id as string
    const nonce = await v.issueNonce()
    return v.login({ log: h.log, nonce, token: await signToken(h.auth, kidOf(did, head.versionId), { iss: did, sub: did, aud, nonce: claimed ?? nonce, iat: t, exp: t + 60 }) })
  }
  const o1 = await genesis(vh)
  expect(await loginWith(o1)).toMatchObject({ kind: 'ok', step: 'first contact' })
  expect(await v.login({ log: [{ nope: 1 }], nonce: await v.issueNonce(), token: 'x.y.z' })).toMatchObject({ kind: 'invalid' })
  const o2 = await change(o1, 'owner', 1, 1)
  expect(await loginWith(o2)).toMatchObject({ kind: 'ok', step: 'continued', versionId: (o2.log[1] as Entry).versionId })
  expect(await loginWith(o1)).toEqual({ kind: 'stale', did: (o1.log[0] as Entry).state.id, held: (o2.log[1] as Entry).versionId })
  // a token for another nonce: the login fails, the verified continuation is kept
  const o3 = await change(o2, 'owner', 2, 2)
  const did = (o3.log[2] as Entry).state.id as string
  expect(await loginWith(o3, 'other')).toEqual({ kind: 'invalid', reason: 'token: another nonce' })
  expect((await v.holding(did))?.head.versionId).toBe((o3.log[2] as Entry).versionId)
  // so another continuation of v2 is a fork, and the identifier is contested
  const fork = await change(o2, 'copy', 2, 3)
  expect(await loginWith(fork)).toMatchObject({ kind: 'contested' })
  expect(await loginWith(o3)).toMatchObject({ kind: 'contested' })
  expect(await v.holding(did)).toMatchObject({ contested: true, head: { versionId: (o3.log[2] as Entry).versionId }, evidence: [o3.log, fork.log] })
})

// ── rules found in review round 1 ───────────────────────────────────────

const committedTo = async (keys: Uint8Array[]) => Promise.all(keys.map((k) => keyHash(multikey(k))))

test('updateKeys [] with new nextKeyHashes while pre-rotation is off: every later entry fails under did:vh (Authorized Keys)', async () => {
  for (const p of [vh, webvh('example.com')]) {
    const o1 = await genesis(p)
    const [n2] = await Promise.all([keyOf('owner update 2')])
    const st = (o1.log[0] as Entry).state
    // pre-rotation off, then the active key empties updateKeys and commits to n2
    const off = await append(o1.log, { parameters: { updateKeys: [multikey(o1.next.pubRaw)], nextKeyHashes: [] }, state: st, signer: o1.next, time: at(1) })
    const empty = await append(off, { parameters: { updateKeys: [], nextKeyHashes: await committedTo([n2!.pubRaw]) }, state: st, signer: o1.next, time: at(2) })
    expect((await verify(empty, { profile: p, now: NOW })).ok).toBe(true)
    const revived = await append(empty, { parameters: { updateKeys: [multikey(n2!.pubRaw)], nextKeyHashes: [] }, state: st, signer: n2!, time: at(3) })
    const r = await verify(revived, { profile: p, now: NOW })
    // did:vh says so; did:webvh 1.0 has no such rule, and the entry verifies there under pre-rotation
    if (p === vh) expect(r).toMatchObject({ ok: false, kind: 'invalid', at: 3, reason: 'no key is authorized after updateKeys [] while pre-rotation was off' })
    else expect(r.ok).toBe(true)
  }
})

test('several update keys declared at once', async () => {
  const [u0, u0b, u1, u1b, u2, x, a0] = await Promise.all(['u0', 'u0b', 'u1', 'u1b', 'u2', 'x', 'a0'].map((l) => keyOf(`several ${l}`)))
  // no pre-rotation: two keys in the first entry, the second signs the next entry
  let log = await create({ profile: vh, updateKey: u0!, moreUpdateKeys: [u0b!.pubRaw], next: [], authKey: a0!.pubRaw, time: at(0) })
  expect((log[0] as Entry).parameters.updateKeys).toEqual([multikey(u0!.pubRaw), multikey(u0b!.pubRaw)])
  log = await append(log, { parameters: {}, state: (log[0] as Entry).state, signer: u0b!, time: at(1) })
  expect((await verify(log, { profile: vh, now: NOW })).ok).toBe(true)
  // pre-rotation: two keys committed, both declared, the second signs
  const pre = await create({ profile: vh, updateKey: u0!, next: [u1!.pubRaw, u1b!.pubRaw], authKey: a0!.pubRaw, time: at(0) })
  const st = (pre[0] as Entry).state
  const both = await append(pre, { parameters: { updateKeys: [multikey(u1!.pubRaw), multikey(u1b!.pubRaw)], nextKeyHashes: await committedTo([u2!.pubRaw]) }, state: st, signer: u1b!, time: at(1) })
  expect((await verify(both, { profile: vh, now: NOW })).ok).toBe(true)
  // one committed key and one that was not: rejected, whichever signs
  for (const signer of [u1!, x!]) {
    const mixed = await append(pre, { parameters: { updateKeys: [multikey(u1!.pubRaw), multikey(x!.pubRaw)], nextKeyHashes: await committedTo([u2!.pubRaw]) }, state: st, signer, time: at(1) })
    expect(await verify(mixed, { profile: vh, now: NOW })).toMatchObject({ ok: false, at: 1, reason: 'an update key was not committed to by the previous entry' })
  }
})

test('did:webvh: state.id is parsed by the method-specific-id ABNF; an empty host is rejected', async () => {
  const empty = { ...webvh(''), did: 'did:webvh:{SCID}:' }
  const log = (await genesis(empty)).log
  expect(await verify(log, { profile: empty, now: NOW })).toMatchObject({ ok: false, kind: 'invalid', at: 0, reason: 'state.id is not a did:webvh DID: the domain is not a dotted name' })
  for (const [host, ok] of [['example.com', true], ['example.com%3A8443:dids:alice', true], ['localhost', false], ['example.com%3A0', false], ['example.com%3A65536', false], ['ex%3Aample.com', false], ['1.2.3.4', false], ['example..com', false], ['example.com:..', false], ['example.com:%2e%2e', false], ['example.com:a%2Fb', false], ['example.com:%zz', false], ['-example.com', false], ['exa%20mple.com', false], ['example.com%20', false], ['ex%2Fample.com', false], ['ex%00ample.com', false]] as const) {
    const p = webvh(host)
    expect((await verify((await genesis(p)).log, { profile: p, now: NOW })).ok, host).toBe(ok)
  }
})

test('versionTime: fractional seconds under did:webvh, whole seconds under did:vh', async () => {
  for (const [p, ok] of [[webvh('example.com'), true], [vh, false]] as const) {
    const [u0, u1, a0] = await Promise.all(['u0', 'u1', 'a0'].map((l) => keyOf(`time ${l}`)))
    let log = await create({ profile: p, updateKey: u0!, next: [u1!.pubRaw], authKey: a0!.pubRaw, time: at(0).replace('Z', '.500Z') })
    expect((await verify(log, { profile: p, now: NOW })).ok).toBe(ok)
    // strictly later, to the fraction
    log = await create({ profile: p, updateKey: u0!, next: [u1!.pubRaw], authKey: a0!.pubRaw, time: at(0).replace('Z', '.5Z') })
    const st = (log[0] as Entry).state
    const later = await append(log, { parameters: { updateKeys: [multikey(u1!.pubRaw)], nextKeyHashes: [] }, state: st, signer: u1!, time: at(0).replace('Z', '.5000001Z'), created: at(1) })
    const same = await append(log, { parameters: { updateKeys: [multikey(u1!.pubRaw)], nextKeyHashes: [] }, state: st, signer: u1!, time: at(0).replace('Z', '.50Z'), created: at(1) })
    expect((await verify(later, { profile: p, now: NOW })).ok).toBe(ok)
    expect((await verify(same, { profile: p, now: NOW })).ok).toBe(false)
  }
})

test('a well-formed log with an unknown version or a feature not built is unsupported, not invalid', async () => {
  const o1 = await genesis(vh)
  const st = (o1.log[0] as Entry).state
  const [n2] = await Promise.all([keyOf('owner update 2')])
  const committed = { updateKeys: [multikey(o1.next.pubRaw)], nextKeyHashes: await committedTo([n2!.pubRaw]) }
  const next = (parameters: Record<string, unknown>) => append(o1.log, { parameters: { ...committed, ...parameters }, state: st, signer: o1.next, time: at(1) })
  const kind = async (log: Entry[], p = vh) => { const r = await verify(log, { profile: p, now: NOW }); return r.ok ? 'ok' : `${r.kind}: ${r.reason}` }
  expect(await kind(await next({ method: 'did:vh:1.1' }))).toBe('unsupported: method did:vh:1.1 is not supported')
  expect(await kind(await next({ method: 'did:vh:99.0' }))).toBe('unsupported: method did:vh:99.0 is not supported')
  expect(await kind(await next({ method: 'did:vh:0.9' }))).toBe('invalid: method changes to a lower version')
  expect(await kind(await next({ method: 'did:vh:01.0' }))).toBe('invalid: method is not of the form did:vh:<major>.<minor>')
  expect(await kind(await next({ method: 'did:webvh:1.0' }))).toBe('invalid: method is not of the form did:vh:<major>.<minor>')
  expect(await kind(await next({ witness: { threshold: 1, witnesses: [{ id: 'did:key:' + multikey(n2!.pubRaw) }] } }))).toBe('unsupported: witnesses are not supported here')
  expect(await kind(await next({ witness: {} }))).toBe('ok')
  // a non-empty but malformed witness configuration is invalid; only a well-formed one is unsupported
  const wid = 'did:key:' + multikey(n2!.pubRaw), wid2 = 'did:key:' + multikey(o1.auth.pubRaw)
  for (const bad of [{ witnesses: [{ id: wid }] }, { threshold: 0, witnesses: [{ id: wid }] }, { threshold: 1.5, witnesses: [{ id: wid }] }, { threshold: '1', witnesses: [{ id: wid }] }, { threshold: 2, witnesses: [{ id: wid }] },
    { threshold: 1, witnesses: [{ id: wid }, { id: wid }] }, { threshold: 2, witnesses: [{ id: wid }, { id: wid }] }, { threshold: 1, witnesses: [] }, { threshold: 1 }, { threshold: 1, witnesses: [{}] }, { threshold: 1, witnesses: [{ id: 'did:web:example.com' }] }, { threshold: 1, witnesses: ['x'] }]) {
    expect(await kind(await next({ witness: bad })), JSON.stringify(bad)).toMatch(/^invalid: (witness|a witness)/)
  }
  expect(await kind(await next({ witness: { threshold: 2, witnesses: [{ id: wid }, { id: wid2 }] } }))).toBe('unsupported: witnesses are not supported here')
  expect(await kind(await next({ witness: [] }))).toBe('invalid: witness is not an object')
  expect(await kind(await next({ watchers: ['https://watcher.example'] }))).toBe('unsupported: watchers are not supported here')
  expect(await kind(await next({ watchers: ['not a URL'] }))).toBe('invalid: watchers is not a list of http(s) URLs')
  expect(await kind(await next({ watchers: [] }))).toBe('ok')
  // a first entry with an unknown version
  const [u0] = await Promise.all([keyOf('owner update 0')])
  const v99 = await create({ profile: { ...vh, method: 'did:vh:99.0' }, updateKey: u0!, next: [o1.next.pubRaw], authKey: o1.auth.pubRaw, time: at(0) })
  expect(await kind(v99)).toBe('unsupported: method did:vh:99.0 is not supported')
  // a tampered entry that also carries a feature not built is invalid
  const bad = structuredClone(await next({ watchers: ['https://watcher.example'] })); (bad[1] as any).state.id += 'x'
  expect(await kind(bad)).toMatch(/^invalid: /)
  // did:webvh: portable true in the first entry is a feature not built; in a later entry it is invalid
  const w = webvh('example.com')
  const wo = await genesis(w)
  const portable = await create({ profile: { ...w, method: w.method }, updateKey: u0!, next: [wo.next.pubRaw], authKey: wo.auth.pubRaw, time: at(0), extraParameters: { portable: true } })
  expect(await kind(portable, w)).toBe('unsupported: portable true is not supported here')
  const later = await append(wo.log, { parameters: { updateKeys: [multikey(wo.next.pubRaw)], nextKeyHashes: [], portable: true }, state: (wo.log[0] as Entry).state, signer: wo.next, time: at(1) })
  expect(await kind(later, w)).toBe('invalid: portable true in a later entry')
})

test('did:webvh host: a percent-encoded ASCII character no host has is invalid; only a non-ASCII name is unsupported', async () => {
  const kind = async (host: string) => {
    const p = webvh(host)
    const r = await verify((await genesis(p)).log, { profile: p, now: NOW })
    return r.ok ? 'ok' : r.kind
  }
  for (const h of ['exa%20mple.com', 'example.com%20', 'ex%7Fample.com', 'ex%00ample.com', 'ex%2Fample.com', 'ex%20%C3%BCmple.com']) expect(await kind(h), h).toBe('invalid')
  for (const h of ['b%C3%BCcher.example', 'xn--bcher-kva.example']) expect(await kind(h), h).toBe(h.startsWith('xn') ? 'ok' : 'unsupported')
})

test('did:webvh: the future limit compares to the fraction (now plus tolerance ends at .250)', async () => {
  const p = webvh('example.com')
  const [u0, a0] = await Promise.all([keyOf('fut u0'), keyOf('fut a0')])
  const now = new Date('2026-11-20T00:00:00.250Z'), tol = 300
  const edge = (frac: string) => create({ profile: p, updateKey: u0!, next: [], authKey: a0!.pubRaw, time: `2026-11-20T00:05:00${frac}Z` })
  for (const [frac, ok] of [['', true], ['.2', true], ['.250', true], ['.2500000001', false], ['.900', false]] as const) {
    expect((await verify(await edge(frac), { profile: p, now, toleranceSec: tol })).ok, frac).toBe(ok)
  }
})

test('a key change keeps every other member of the DID document, and refuses a shape it cannot continue', async () => {
  const [u0, u1, u2, u3, a0, a1, a2] = await Promise.all([fresh(), fresh(), fresh(), fresh(), fresh(), fresh(), fresh()])
  const p = webvh('example.com')
  const first = await create({ profile: p, updateKey: u0, next: [u1.pubRaw], authKey: a0.pubRaw, time: at(0) })
  const head = first[0] as Entry
  const did = head.state.id as string
  const extra = {
    service: [{ id: `${did}#hub`, type: 'LinkedDomains', serviceEndpoint: 'https://example.com/hub' }],
    alsoKnownAs: ['https://example.com/alice'],
  }
  // A document with a service endpoint, written under pre-rotation.
  const params = { updateKeys: [multikey(u1.pubRaw)], nextKeyHashes: [await keyHash(multikey(u2.pubRaw))] }
  let log = await append(first, { parameters: params, state: { ...head.state, ...extra }, signer: u1, time: at(1) })
  expect(await verify(log, { profile: p, now: NOW })).toMatchObject({ ok: true })
  log = await rotate(log, { signer: u2, next: [u3.pubRaw], authKey: a1.pubRaw, time: at(2) })
  const state = (log[log.length - 1] as Entry).state
  expect(state.service).toEqual(extra.service)
  expect(state.alsoKnownAs).toEqual(extra.alsoKnownAs)
  expect(state.authentication).toEqual(head.state.authentication)
  expect((state.verificationMethod as { publicKeyMultibase: string }[])[0]!.publicKeyMultibase).toBe(multikey(a1.pubRaw))
  expect(await verify(log, { profile: p, now: NOW })).toMatchObject({ ok: true })

  // Two verification methods: which one is replaced is unclear, so it is refused.
  const vm = (head.state.verificationMethod as Record<string, unknown>[])[0]!
  const two = { ...head.state, verificationMethod: [vm, { ...vm, id: `${did}#key-2` }] }
  const odd = await append(first, { parameters: params, state: two, signer: u1, time: at(1) })
  await expect(rotate(odd, { signer: u2, next: [u3.pubRaw], authKey: a2.pubRaw, time: at(2) })).rejects.toThrow(/verification method/)
  // Without a new authentication key the document is carried over as it is.
  expect(((await rotate(odd, { signer: u2, next: [u3.pubRaw], time: at(2) })).at(-1) as Entry).state).toEqual(two)
})

test('JSON Lines: exactly one trailing newline is allowed, every other line holds a JSON value', async () => {
  const [u0, a0] = await Promise.all([fresh(), fresh()])
  const log = await create({ profile: webvh('example.com'), updateKey: u0, next: [], authKey: a0.pubRaw, time: at(0) })
  const two = await append(log, { parameters: {}, state: (log[0] as Entry).state, signer: u0, time: at(1) })
  const [l1, l2] = toJsonl(two).split('\n') as [string, string]
  expect(fromJsonl(`${l1}\n${l2}\n`)).toEqual(two)
  expect(fromJsonl(`${l1}\n${l2}`)).toEqual(two)
  for (const bad of [`\n${l1}\n${l2}\n`, `${l1}\n\n${l2}\n`, `${l1}\n${l2}\n\n`, `${l1}\n   \n${l2}\n`, `${l1}\n${l2}\n  `, '', '\n']) {
    expect(fromJsonl(bad)).toBeNull()
  }
})
