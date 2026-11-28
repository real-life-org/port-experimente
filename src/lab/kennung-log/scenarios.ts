// The flows of a login identifier with a log at one service, each with its
// result pinned in scenarios.expected.json. Keys come from fixed labels and
// times are fixed, so every log is the same on every run (Ed25519 is
// deterministic): a change of a rule or of the format shows as a diff.
import { createHash } from 'node:crypto'
import { anchorOfEd, diSign, edFromSeed, type KeyPair } from 'rltp-lib'
import { append, create, deactivate, didDocument, keyHash, multikey, rotate, toJsonl, verify, type Entry, type Profile } from './log'
import { scidVh, vh, webvh } from './profiles'
import { kidOf, signToken, Verifier, type LoginResult } from './verifier'

/** A key pair from a label (test keys; nothing secret). */
export const keyOf = (label: string): Promise<KeyPair> => edFromSeed(new Uint8Array(createHash('sha256').update(`kennung-log test key: ${label}`).digest()))

export const T0 = Date.parse('2026-11-01T10:00:00Z')
export const at = (day: number): string => new Date(T0 + day * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
export const NOW = new Date('2026-11-20T00:00:00Z')
const AUD = 'https://service.example'
const te = new TextEncoder()

/** A person's identifier as one device holds it: the log, the key the head
 *  committed to, and the authentication key of the head. */
export interface Holder { log: Entry[], next: KeyPair, auth: KeyPair }

export async function genesis (profile: Profile, who = 'owner'): Promise<Holder> {
  const [u0, u1, a0] = await Promise.all([keyOf(`${who} update 0`), keyOf(`${who} update 1`), keyOf(`${who} auth 0`)])
  return { log: await create({ profile, updateKey: u0, next: [u1.pubRaw], authKey: a0.pubRaw, time: at(0) }), next: u1, auth: a0 }
}

/** The key change: the committed key signs, commits to a new one, and the
 *  document gets a new authentication key. `as` names whose new keys they are. */
export async function change (h: Holder, as: string, n: number, day: number): Promise<Holder> {
  const [next, auth] = await Promise.all([keyOf(`${as} update ${n + 1}`), keyOf(`${as} auth ${n}`)])
  return { log: await rotate(h.log, { signer: h.next, next: [next.pubRaw], authKey: auth.pubRaw, time: at(day) }), next, auth }
}

/** A login: the device's log and a token under its head, signed with `key`
 *  (default: the head's authentication key), naming `version` (default: the head). */
async function login (v: Verifier, h: Holder, o: { key?: KeyPair, version?: string } = {}): Promise<LoginResult> {
  const nonce = await v.issueNonce()
  const head = h.log[h.log.length - 1] as Entry
  const did = head.state.id as string
  const t = Math.floor(NOW.getTime() / 1000)
  const token = await signToken(o.key ?? h.auth, kidOf(did, o.version ?? head.versionId), { iss: did, sub: did, aud: AUD, nonce, iat: t, exp: t + 300 })
  return v.login({ log: h.log, token, nonce })
}
const verifier = (profile: Profile = vh): Verifier => new Verifier({ profile, audience: AUD, now: () => NOW })

type Step = { who: string, presents: string, result: string, holds: string }
/** A log is named by its head's version number and by whose it is. */
const names = new Map<string, string>()
const named = (h: Holder, name: string): Holder => { names.set((h.log[h.log.length - 1] as Entry).versionId, name); return h }
const nameOf = (versionId: string | undefined): string => versionId === undefined ? '-' : names.get(versionId) ?? versionId
function show (r: LoginResult): string {
  switch (r.kind) {
    case 'ok': return `ok, ${r.step}`
    case 'stale': return `stale, the service names ${nameOf(r.held)}`
    case 'contested': return 'contested'
    case 'invalid': return `invalid: ${r.reason}`
    case 'unsupported': return `unsupported: ${r.reason}`
  }
}
async function step (v: Verifier, who: string, h: Holder, o?: { key?: KeyPair, version?: string, label?: string }): Promise<Step> {
  const r = await login(v, h, o)
  const did = (h.log[0] as Entry).state.id as string
  const held = await v.holding(did)
  const holds = held === undefined ? 'nothing' : `${nameOf(held.head.versionId)}${held.contested ? `, contested, ${held.evidence.map((l) => nameOf(l[l.length - 1]?.versionId)).join(' and ')} as evidence` : ''}`
  return { who, presents: o?.label ?? nameOf((h.log[h.log.length - 1] as Entry).versionId), result: show(r), holds }
}

async function firstContact (): Promise<Step[]> {
  const v = verifier()
  const o = named(await genesis(vh), 'v1')
  return [await step(v, 'owner', o), await step(v, 'owner', o)]
}

async function honestChange (): Promise<Step[]> {
  const v = verifier()
  const o1 = named(await genesis(vh), 'v1')
  const o2 = named(await change(o1, 'owner', 1, 1), 'v2')
  return [await step(v, 'owner', o1), await step(v, 'owner', o2), await step(v, 'owner', o2)]
}

async function deviceWithTheOldState (): Promise<Step[]> {
  const v = verifier()
  const laptop = named(await genesis(vh), 'v1')
  const phone = named(await change(laptop, 'owner', 1, 1), 'v2')
  return [
    await step(v, 'laptop', laptop),
    await step(v, 'phone, after the change', phone),
    await step(v, 'laptop, not synced', laptop),
    await step(v, 'laptop, after syncing with the phone', phone),
  ]
}

async function olderLogPlayedBack (): Promise<Step[]> {
  const v = verifier()
  const o1 = named(await genesis(vh), 'v1')
  const o2 = named(await change(o1, 'owner', 1, 1), 'v2')
  return [
    await step(v, 'owner', o1),
    await step(v, 'owner', o2),
    await step(v, 'someone with the old log and the old authentication key', o1),
    await step(v, 'owner', o2),
  ]
}

/** Two valid continuations of v1: the owner's, and one by someone who holds
 *  a copy of the committed key (a copied device). */
async function twoContinuations (ownerFirst: boolean): Promise<Step[]> {
  const v = verifier()
  const o1 = named(await genesis(vh), 'v1')
  const mine = named(await change(o1, 'owner', 1, 2), 'v2 (owner)')
  const theirs = named(await change(o1, 'copy', 1, 1), 'v2 (copy)')
  const first: [string, Holder] = ownerFirst ? ['owner', mine] : ['copy', theirs]
  const second: [string, Holder] = ownerFirst ? ['copy', theirs] : ['owner', mine]
  return [
    await step(v, 'owner', o1),
    await step(v, ...first),
    await step(v, ...second),
    await step(v, ...first),
    await step(v, ...second),
  ]
}

async function oldKeyAfterTheChange (): Promise<Step[]> {
  const v = verifier()
  const o1 = named(await genesis(vh), 'v1')
  const o2 = named(await change(o1, 'owner', 1, 1), 'v2')
  return [
    await step(v, 'owner', o1),
    await step(v, 'owner', o2),
    await step(v, 'v2 with a token by the old key, naming v2', o2, { key: o1.auth }),
    await step(v, 'v2 with a token by the old key, naming v1', o2, { key: o1.auth, version: (o1.log[0] as Entry).versionId }),
    await step(v, 'owner', o2),
  ]
}

/** A valid continuation whose login fails is still kept: the verified
 *  log replaces the held one (Applying Peer-to-Peer Updates, step 4). */
async function continuationWithAFailingLogin (): Promise<Step[]> {
  const v = verifier()
  const o1 = named(await genesis(vh), 'v1')
  const o2 = named(await change(o1, 'owner', 1, 2), 'v2 (owner)')
  const copy = named(await change(o1, 'copy', 1, 1), 'v2 (copy)')
  return [
    await step(v, 'owner', o1),
    await step(v, 'owner, with a token by the old authentication key', o2, { key: o1.auth }),
    await step(v, 'someone with the old log and the old authentication key', o1),
    await step(v, 'copy', copy),
    await step(v, 'owner', o2),
  ]
}

/** Someone holds the first update key (revealed in v1) and the first
 *  authentication key, but not the committed one. */
async function uncommittedKey (): Promise<Step[]> {
  const v = verifier()
  const o1 = named(await genesis(vh), 'v1')
  const [u0, thief, thiefAuth] = await Promise.all([keyOf('owner update 0'), keyOf('thief update'), keyOf('thief auth')])
  const did = (o1.log[0] as Entry).state.id as string
  const own = named({ log: await append(o1.log, { parameters: { updateKeys: [multikey(thief.pubRaw)], nextKeyHashes: [] }, state: didDocument(did, thiefAuth.pubRaw), signer: thief, time: at(1) }), next: thief, auth: thiefAuth }, 'v2 (own key)')
  const old = named({ log: await append(o1.log, { parameters: { updateKeys: [multikey(u0.pubRaw)], nextKeyHashes: [] }, state: didDocument(did, thiefAuth.pubRaw), signer: u0, time: at(1) }), next: u0, auth: thiefAuth }, 'v2 (first update key)')
  const inherit = named({ log: await append(o1.log, { parameters: {}, state: didDocument(did, thiefAuth.pubRaw), signer: u0, time: at(1) }), next: u0, auth: thiefAuth }, 'v2 (updateKeys left out)')
  const o2 = named(await change(o1, 'owner', 1, 2), 'v2 (owner)')
  return [
    await step(v, 'owner', o1),
    await step(v, 'thief, with its own key', own),
    await step(v, 'thief, with the first update key', old),
    await step(v, 'thief, leaving updateKeys out', inherit),
    await step(v, 'owner', o2),
  ]
}

async function deactivation (): Promise<Step[]> {
  const v = verifier()
  const o1 = named(await genesis(vh), 'v1')
  const log = await deactivate(o1.log, { signer: o1.next, time: at(1) })
  names.set((log[1] as Entry).versionId, 'v2 (pre-rotation off)')
  const off = named({ log, next: o1.next, auth: o1.auth }, 'v3 (deactivated)')
  const after = named({ log: await append(log, { parameters: { updateKeys: [multikey(o1.next.pubRaw)] }, state: (log[0] as Entry).state, signer: o1.next, time: at(3) }), next: o1.next, auth: o1.auth }, 'v4 (after deactivation)')
  return [
    await step(v, 'owner', o1),
    await step(v, 'owner, deactivated', off),
    await step(v, 'owner, an old device', o1),
    await step(v, 'owner, deactivated', off),
    await step(v, 'someone with the last update key', after),
  ]
}

// ── tampering ───────────────────────────────────────────────────────────

type Tamper = [string, (e: any) => void]
export const TAMPERS: Tamper[] = [
  ['versionId: another version number', (e) => { e.versionId = e.versionId.replace(/^\d+/, (n: string) => String(Number(n) + 1)) }],
  ['versionId: another entry hash', (e) => { e.versionId = e.versionId.slice(0, -1) + (e.versionId.endsWith('a') ? 'b' : 'a') }],
  ['versionTime: one second later', (e) => { e.versionTime = new Date(Date.parse(e.versionTime) + 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') }],
  ['versionTime: with fractional seconds', (e) => { e.versionTime = e.versionTime.replace('Z', '.000Z') }],
  ['parameters.method: another method', (e) => { e.parameters.method = 'did:webvh:0.5' }],
  ['parameters.scid: another value', (e) => { e.parameters.scid = 'QmQADVkZYexfLuZ6yiQt1tQjxU6nJgFuC4nDncYd4g4uxy' }],
  ['parameters.updateKeys: another key', (e) => { e.parameters.updateKeys = ['z6MkqgiHDj17BY9qa7KiFioFTPLWheArRS8JKPGMeApvEqPk'] }],
  ['parameters.nextKeyHashes: another hash', (e) => { e.parameters.nextKeyHashes = ['QmQADVkZYexfLuZ6yiQt1tQjxU6nJgFuC4nDncYd4g4uxy'] }],
  ['parameters: portable true added', (e) => { e.parameters.portable = true }],
  ['parameters: an unknown parameter added', (e) => { e.parameters.extra = 1 }],
  ['state.id: another DID', (e) => { e.state.id = e.state.id.slice(0, -1) + (e.state.id.endsWith('a') ? 'b' : 'a') }],
  ['state: another authentication key', (e) => { e.state.verificationMethod[0].publicKeyMultibase = 'z6MkqgiHDj17BY9qa7KiFioFTPLWheArRS8JKPGMeApvEqPk' }],
  ['proof.proofValue: one character changed', (e) => { const v = e.proof[0].proofValue; e.proof[0].proofValue = v.slice(0, 5) + (v[5] === 'a' ? 'b' : 'a') + v.slice(6) }],
  ['proof.verificationMethod: another key', (e) => { e.proof[0].verificationMethod = 'did:key:z6MkqgiHDj17BY9qa7KiFioFTPLWheArRS8JKPGMeApvEqPk#z6MkqgiHDj17BY9qa7KiFioFTPLWheArRS8JKPGMeApvEqPk' }],
  ['proof.cryptosuite: ecdsa-jcs-2019', (e) => { e.proof[0].cryptosuite = 'ecdsa-jcs-2019' }],
  ['proof.proofPurpose: authentication', (e) => { e.proof[0].proofPurpose = 'authentication' }],
  ['proof.created: another time', (e) => { e.proof[0].created = '2026-10-01T00:00:00Z' }],
  ['proof: the proof twice', (e) => { e.proof = [e.proof[0], e.proof[0]] }],
  ['proof: an object, not a list', (e) => { e.proof = e.proof[0] }],
  ['entry: an extra property', (e) => { e.extra = 1 }],
]

/** A three-entry log (genesis, a key change, a second key change) under a
 *  profile, for tampering. */
export async function threeEntries (profile: Profile): Promise<Entry[]> {
  const o1 = await genesis(profile)
  const o2 = await change(o1, 'owner', 1, 1)
  return (await change(o2, 'owner', 2, 2)).log
}

/** Each tampering, applied once to the first and once to the second entry. */
export async function tampered (profile: Profile): Promise<Array<{ field: string, entry: number, log: Entry[] }>> {
  const base = await threeEntries(profile)
  const out: Array<{ field: string, entry: number, log: Entry[] }> = []
  for (const [field, f] of TAMPERS) for (const i of [0, 1]) {
    const log = structuredClone(base)
    f(log[i])
    out.push({ field, entry: i + 1, log })
  }
  const gap = structuredClone(base); gap.splice(1, 1)
  out.push({ field: 'log: the second of three entries removed', entry: 2, log: gap })
  const swap = structuredClone(base); [swap[1], swap[2]] = [swap[2] as Entry, swap[1] as Entry]
  out.push({ field: 'log: second and third entry swapped', entry: 2, log: swap })
  return out
}

/** Re-sign an entry with `key`, as someone who holds an authorized key would
 *  after changing it. */
async function resign (e: Entry, key: KeyPair): Promise<Entry> {
  const { proof: _p, ...body } = e
  const signed = await diSign({ anchor: anchorOfEd(key.pubRaw), ed: { priv: key.priv } }, body, (e.proof[0] as any)?.created ?? e.versionTime)
  const { proof, ...rest } = signed
  return { ...rest, proof: [proof] } as Entry
}

type TamperRow = { 'as changed': string, 're-signed by the key that signed the entry': string }
async function tamperTable (): Promise<{ cases: number, rejected: number, reSigned: number, reSignedRejected: number, reasons: Record<string, TamperRow>, atTheService: Step[] }> {
  const reasons: Record<string, TamperRow> = {}
  let rejected = 0, reSigned = 0, reSignedRejected = 0
  const signers = await Promise.all([keyOf('owner update 0'), keyOf('owner update 1')])
  const cases = await tampered(vh)
  const why = (r: Awaited<ReturnType<typeof verify>>): string => r.ok ? 'accepted' : `entry ${r.at + 1}: ${r.reason}`
  for (const c of cases) {
    const r = await verify(c.log, { profile: vh, now: NOW })
    if (!r.ok) rejected++
    let again = 'not applicable'
    if (!c.field.startsWith('proof') && !c.field.startsWith('log:')) {
      const log = structuredClone(c.log)
      log[c.entry - 1] = await resign(log[c.entry - 1] as Entry, signers[c.entry - 1] as KeyPair)
      const r2 = await verify(log, { profile: vh, now: NOW })
      reSigned++
      if (!r2.ok) reSignedRejected++
      again = why(r2)
    }
    reasons[`${c.field} (entry ${c.entry})`] = { 'as changed': why(r), 're-signed by the key that signed the entry': again }
  }
  // At the service: a tampered log is no evidence and locks nothing.
  const v = verifier()
  const o1 = named(await genesis(vh), 'v1')
  const o2 = named(await change(o1, 'owner', 1, 1), 'v2')
  const bad = structuredClone(o2.log); (bad[1] as any).state.verificationMethod[0].publicKeyMultibase = multikey(o2.auth.pubRaw).replace(/.$/, 'x')
  return {
    cases: cases.length,
    rejected,
    reSigned,
    reSignedRejected,
    reasons,
    atTheService: [
      await step(v, 'owner', o1),
      await step(v, 'someone with a tampered v2', { ...o2, log: bad }, { label: 'v2 (tampered)' }),
      await step(v, 'owner', o2),
    ],
  }
}

/** Entries written and signed by an authorized key that break one rule of
 *  the method: the hash chain holds, the rule decides. */
async function rules (): Promise<Record<string, string>> {
  const o1 = await genesis(vh)
  const did = (o1.log[0] as Entry).state.id as string
  const [n2, u0] = await Promise.all([keyOf('owner update 2'), keyOf('owner update 0')])
  const committed = { updateKeys: [multikey(o1.next.pubRaw)], nextKeyHashes: [await keyHash(multikey(n2.pubRaw))] }
  const next = (parameters: Record<string, unknown>, time = at(1), state: Record<string, unknown> = (o1.log[0] as Entry).state) =>
    append(o1.log, { parameters, state, signer: o1.next, time, created: at(1) })
  const cases: Record<string, Promise<Entry[]>> = {
    'versionTime equal to the previous entry\'s': next(committed, at(0)),
    'versionTime before the previous entry\'s': next(committed, at(-1)),
    'versionTime with fractional seconds': next(committed, at(1).replace('Z', '.500Z')),
    'versionTime without a zone': next(committed, at(1).replace('Z', '')),
    'versionTime in a non-UTC zone': next(committed, at(1).replace('Z', '+01:00')),
    'versionTime six minutes after the verifier\'s clock': next(committed, new Date(NOW.getTime() + 360_000).toISOString().replace(/\.\d{3}Z$/, 'Z')),
    'versionTime four minutes after the verifier\'s clock': next(committed, new Date(NOW.getTime() + 240_000).toISOString().replace(/\.\d{3}Z$/, 'Z')),
    'the first entry with fractional seconds': create({ profile: vh, updateKey: u0, next: [o1.next.pubRaw], authKey: o1.auth.pubRaw, time: at(0).replace('Z', '.500Z') }),
    'nextKeyHashes left out under pre-rotation': next({ updateKeys: committed.updateKeys }),
    'scid in a later entry': next({ ...committed, scid: (o1.log[0] as Entry).parameters.scid }),
    'method repeated in a later entry': next({ ...committed, method: vh.method }),
    'method changed in a later entry': next({ ...committed, method: 'did:vh:1.1' }),
    'portable false under did:vh': next({ ...committed, portable: false }),
    'a witness configured': next({ ...committed, witness: { threshold: 1, witnesses: [{ id: 'did:key:' + multikey(n2.pubRaw) }] } }),
    'a parameter set to null': next({ ...committed, ttl: null }),
    'ttl as a string': next({ ...committed, ttl: '3600' }),
    'state.id another DID': next(committed, at(1), didDocument(did.replace('did:vh:', 'did:vh:x'), o1.auth.pubRaw)),
    'an entry after updateKeys [] that set new nextKeyHashes, pre-rotation off': (async () => {
      const off = await next({ updateKeys: committed.updateKeys, nextKeyHashes: [] })
      const empty = await append(off, { parameters: { updateKeys: [], nextKeyHashes: committed.nextKeyHashes }, state: (o1.log[0] as Entry).state, signer: o1.next, time: at(2) })
      return append(empty, { parameters: { updateKeys: [multikey(n2.pubRaw)], nextKeyHashes: [] }, state: (o1.log[0] as Entry).state, signer: n2, time: at(3) })
    })(),
    'method did:vh:99.0 in a later entry': next({ ...committed, method: 'did:vh:99.0' }),
    'method did:vh:0.9 in a later entry': next({ ...committed, method: 'did:vh:0.9' }),
    'a watcher': next({ ...committed, watchers: ['https://watcher.example'] }),
    'an entry after updateKeys [] without pre-rotation': (async () => {
      const off = await next({ updateKeys: committed.updateKeys, nextKeyHashes: [] })
      const empty = await append(off, { parameters: { updateKeys: [] }, state: (o1.log[0] as Entry).state, signer: o1.next, time: at(2) })
      return append(empty, { parameters: { updateKeys: [multikey(n2.pubRaw)], nextKeyHashes: [] }, state: (o1.log[0] as Entry).state, signer: n2, time: at(3) })
    })(),
    'deactivated true in one entry under pre-rotation, update keys kept': next({ ...committed, deactivated: true }),
  }
  const out: Record<string, string> = {}
  for (const [name, log] of Object.entries(cases)) {
    const r = await verify(await log, { profile: vh, now: NOW })
    out[name] = r.ok ? `valid (${r.versions.length} entries)` : `${r.kind} at entry ${r.at + 1}: ${r.reason}`
  }
  return out
}

/** The same kind of entries under did:webvh, where its text differs from did:vh's. */
async function webvhRules (): Promise<Record<string, string>> {
  const p = webvh('example.com')
  const o1 = await genesis(p)
  const st = (o1.log[0] as Entry).state
  const [n2, u0] = await Promise.all([keyOf('owner update 2'), keyOf('owner update 0')])
  const committed = { updateKeys: [multikey(o1.next.pubRaw)], nextKeyHashes: [await keyHash(multikey(n2.pubRaw))] }
  const next = (parameters: Record<string, unknown>, time = at(1)) => append(o1.log, { parameters, state: st, signer: o1.next, time, created: at(1) })
  const empty = { ...webvh(''), did: 'did:webvh:{SCID}:' }
  const cases: Record<string, [Profile, Promise<Entry[]>]> = {
    'versionTime with fractional seconds': [p, next(committed, at(1).replace('Z', '.500Z'))],
    'the first entry with fractional seconds': [p, create({ profile: p, updateKey: u0, next: [o1.next.pubRaw], authKey: o1.auth.pubRaw, time: at(0).replace('Z', '.500Z') })],
    'an empty host': [empty, create({ profile: empty, updateKey: u0, next: [o1.next.pubRaw], authKey: o1.auth.pubRaw, time: at(0) })],
    'a host without a dot': [webvh('localhost'), create({ profile: webvh('localhost'), updateKey: u0, next: [o1.next.pubRaw], authKey: o1.auth.pubRaw, time: at(0) })],
    'portable true in the first entry': [p, create({ profile: p, updateKey: u0, next: [o1.next.pubRaw], authKey: o1.auth.pubRaw, time: at(0), extraParameters: { portable: true } })],
    'portable false in a later entry': [p, next({ ...committed, portable: false })],
    'portable true in a later entry': [p, next({ ...committed, portable: true })],
    'a watcher': [p, next({ ...committed, watchers: ['https://watcher.example'] })],
    'watchers: not a URL': [p, next({ ...committed, watchers: ['not a URL'] })],
    'method did:webvh:1.1 in a later entry': [p, next({ ...committed, method: 'did:webvh:1.1' })],
    'an entry after updateKeys [] that set new nextKeyHashes, pre-rotation off': [p, (async () => {
      const off = await next({ updateKeys: committed.updateKeys, nextKeyHashes: [] })
      const empty = await append(off, { parameters: { updateKeys: [], nextKeyHashes: committed.nextKeyHashes }, state: st, signer: o1.next, time: at(2) })
      return append(empty, { parameters: { updateKeys: [multikey(n2.pubRaw)], nextKeyHashes: [] }, state: st, signer: n2, time: at(3) })
    })()],
  }
  const out: Record<string, string> = {}
  for (const [name, [profile, log]] of Object.entries(cases)) {
    const r = await verify(await log, { profile, now: NOW })
    out[name] = r.ok ? `valid (${r.versions.length} entries)` : `${r.kind} at entry ${r.at + 1}: ${r.reason}`
  }
  return out
}

// ── names ───────────────────────────────────────────────────────────────

const PROFILES: Record<string, Profile> = { 'did:webvh (example.com)': webvh('example.com'), 'did:vh': vh, 'did:scid:vh:1': scidVh }

/** The same keys and times under the three names, and each log verified
 *  under each name. */
async function threeNames (): Promise<{ dids: Record<string, string>, distinctScids: number, crossCheck: Record<string, string> }> {
  const dids: Record<string, string> = {}
  const logs: Record<string, Entry[]> = {}
  for (const [name, p] of Object.entries(PROFILES)) { logs[name] = (await genesis(p)).log; dids[name] = (logs[name]![0] as Entry).state.id as string }
  const scids = new Set(Object.values(logs).map((l) => (l[0] as Entry).parameters.scid))
  const crossCheck: Record<string, string> = {}
  for (const [a, log] of Object.entries(logs)) for (const [b, p] of Object.entries(PROFILES)) {
    const r = await verify(log, { profile: p, now: NOW })
    crossCheck[`written as ${a}, verified as ${b}`] = r.ok ? 'valid' : `invalid: ${r.reason}`
  }
  return { dids, distinctScids: scids.size, crossCheck }
}

/** Bytes per entry in JSON Lines form (one Ed25519 key in the document). */
async function sizes (): Promise<Record<string, number[]>> {
  const out: Record<string, number[]> = {}
  for (const [name, p] of Object.entries(PROFILES)) {
    const o1 = await genesis(p)
    const o2 = await change(o1, 'owner', 1, 1)
    const log = await deactivate(o2.log, { signer: o2.next, time: at(2) })
    out[`${name}: genesis, key change, pre-rotation off, deactivation`] = log.map((e) => te.encode(toJsonl([e])).length)
  }
  return out
}

export async function measure (): Promise<Record<string, unknown>> {
  names.clear()
  return {
    'first contact': await firstContact(),
    'an honest key change': await honestChange(),
    'a device with the old state': await deviceWithTheOldState(),
    'an older log played back': await olderLogPlayedBack(),
    'two continuations, the owner first': await twoContinuations(true),
    'two continuations, the copy first': await twoContinuations(false),
    'a token under the old key after the change': await oldKeyAfterTheChange(),
    'a continuation whose login fails': await continuationWithAFailingLogin(),
    'a continuation with a key that was not committed': await uncommittedKey(),
    'deactivation': await deactivation(),
    'tampered entries': await tamperTable(),
    'rules, broken by an entry an authorized key wrote': await rules(),
    'rules under did:webvh where its text differs': await webvhRules(),
    'the same keys under three names': await threeNames(),
    'sizes': await sizes(),
  }
}
