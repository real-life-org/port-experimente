import { expect, test } from 'vitest'
import { edFromSeed, rand } from 'rltp-lib'
import { create, deactivate, fromJsonl, rotate, toJsonl, verify, type Entry } from '../src/lab/kennung-log/log'
import { scidVh, vh, webvh } from '../src/lab/kennung-log/profiles'
import { kidOf, signToken, Verifier } from '../src/lab/kennung-log/verifier'
import { at, change, genesis, NOW, tampered } from '../src/lab/kennung-log/scenarios'

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

test('the service: an invalid log locks nothing, a second valid continuation locks every login', async () => {
  const aud = 'https://service.example'
  const v = new Verifier({ profile: vh, audience: aud, now: () => NOW })
  const t = Math.floor(NOW.getTime() / 1000)
  const loginWith = async (h: Awaited<ReturnType<typeof genesis>>, nonce: string) => {
    const head = h.log[h.log.length - 1] as Entry
    const did = head.state.id as string
    return v.login({ log: h.log, nonce, token: await signToken(h.auth, kidOf(did, head.versionId), { iss: did, sub: did, aud, nonce, iat: t, exp: t + 60 }) })
  }
  const o1 = await genesis(vh)
  expect(await loginWith(o1, 'a')).toMatchObject({ kind: 'ok', step: 'first contact' })
  expect(await v.login({ log: [{ nope: 1 }], nonce: 'b', token: 'x.y.z' })).toMatchObject({ kind: 'invalid' })
  const o2 = await change(o1, 'owner', 1, 1)
  expect(await loginWith(o2, 'c')).toMatchObject({ kind: 'ok', step: 'continued', versionId: (o2.log[1] as Entry).versionId })
  expect(await loginWith(o1, 'd')).toEqual({ kind: 'stale', did: (o1.log[0] as Entry).state.id, held: (o2.log[1] as Entry).versionId })
  // a token for another nonce does not move the log
  const o3 = await change(o2, 'owner', 2, 2)
  const head3 = o3.log[2] as Entry
  const did = head3.state.id as string
  expect(await v.login({ log: o3.log, nonce: 'e', token: await signToken(o3.auth, kidOf(did, head3.versionId), { iss: did, sub: did, aud, nonce: 'other', iat: t, exp: t + 60 }) })).toEqual({ kind: 'invalid', reason: 'token: another nonce' })
  expect(v.holding(did)?.head.versionId).toBe((o2.log[1] as Entry).versionId)
  // so the service still holds v2, and whichever continuation of v2 comes first is followed
  const fork = await change(o2, 'copy', 2, 3)
  expect(await loginWith(fork, 'f')).toMatchObject({ kind: 'ok', step: 'continued' })
  expect(await loginWith(o3, 'g')).toMatchObject({ kind: 'contested' })
  expect(await loginWith(fork, 'h')).toMatchObject({ kind: 'contested' })
  expect(v.holding(did)).toMatchObject({ contested: true, head: { versionId: (fork.log[2] as Entry).versionId }, evidence: [o3.log] })
})
