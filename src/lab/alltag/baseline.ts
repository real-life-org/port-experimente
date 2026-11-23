// @ts-nocheck
// The everyday multi-device baseline, for the conformance matrix: what a
// person with two devices gets from the published library as it is (one
// writer per holder). The scenarios are the ones of the library
// repository's `lib/test/multi-device-baseline.test.mjs` (trust-protocol,
// state of 2026-11-23), ported unchanged in substance; that test is the
// gate for the library, this copy feeds the matrix. Type checking is off
// because the body is the JavaScript of that test.
//
// green → kept, red → not kept, inexpressible → not applicable.
import { seedKeys, createHolder } from 'rltp-lib'
import { InMemoryStore } from 'rltp-lib/testing'

const T0 = Date.parse('2026-10-15T09:00:00Z')
let acts = 0
const opts = (when, extra = {}) => ({ when, actId: 'base-' + (++acts), ...extra })
const ev = (r, type) => (r.events ?? []).filter((e) => e.type === type)
async function person (fill, { store = new InMemoryStore() } = {}) {
  const seed = new Uint8Array(64).fill(fill)
  const h = await createHolder({ store, keys: seedKeys(seed) }, { modules: [], invariants: true })
  return { h, store, seed, read: async () => (await store.read()).state }
}
const assert = {
  equal: (a, b, m) => { if (a !== b) throw new Error(m ?? `${a} !== ${b}`) },
  ok: (c, m) => { if (!c) throw new Error(m ?? 'assertion') },
}

const DAY = 86_400_000
const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r)); return r }
let clock = T0 + 1_000_000
const tick = (n = 10_000) => (clock += n)
/** A device's own clock at the shared moment `t`: the second device runs
 *  late. Every time a device is given goes through here, and a device's
 *  time never falls. */
const last = new WeakMap()
function clk (P, t) {
  const when = t + (P.late ?? 0)
  assert.ok(when >= (last.get(P.store) ?? 0), 'a device\'s time never falls')
  last.set(P.store, when)
  return when
}
/** The options of an act the human takes on device P now. */
const at = (P, extra) => opts(clk(P, tick()), extra)

/** Delivers outbound and all it causes, to every device holding the address. */
async function route (people, outbound, when = tick(), { rounds = 12 } = {}) {
  let out = [...outbound]
  const seen = []
  for (let r = 0; r < rounds; r++) {
    for (const p of people) out.push(...(await p.h.resume(clk(p, when))).outbound)
    if (!out.length) break
    while (out.length) {
      const o = out.shift()
      for (const to of people) {
        if (!Object.hasOwn((await to.read()).addresses.keys, o.envelope.rkid)) continue
        const got = await to.h.receive(o.envelope, clk(to, when))
        seen.push({ o, to, got })
        if (got.disposition === 'unique' || got.disposition === 'duplicate-known') out.push(...got.outbound)
      }
    }
  }
  return seen
}

/** A person who founded its personal community as the application does. */
async function mk (fill) {
  const P = { ...(await person(fill)), fill }
  ok(await P.h.foundPersonalCommunity({ name: 'P' + fill }, at(P)))
  return P
}
/** The second device's clock: it takes every document this much later. */
const LATE = 13_000
const fromSeed = async (P) => ({ ...(await person(P.fill)), fill: P.fill, late: LATE })
async function copyOf (P) {
  const store = new InMemoryStore()
  await store.commit(null, (await P.store.read()).state)
  return { ...(await person(P.fill, { store })), fill: P.fill, late: LATE }
}

/** A and B meet: B shows, A scans, B confirms, all settles. Each device on its own clock. */
async function met (A, B) {
  const shown = ok(await B.h.show(at(B, { name: 'Bea' })))
  const sc = ok(await A.h.scan(ev(shown, 'encounter.shown')[0].card, at(A, { name: 'Al' })))
  const got = await B.h.receive(sc.outbound.find((o) => short(o.type).startsWith('encounter-bundle/')).envelope, clk(B, tick()))
  const prompt = (await B.h.prompts()).find((p) => p.kind === 'encounter-confirm')
  const d = ok(await B.h.decide(prompt.id, 'accept', at(B)))
  await route([A, B], [...got.outbound, ...d.outbound])
  return { a: await A.h.contact(ev(sc, 'contact.added')[0].contactId), b: await B.h.contact(ev(got, 'contact.added')[0].contactId) }
}

const strip = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'commitSeq' ? undefined : x)))
const shows = async (P) => strip({
  contacts: await P.h.contacts(), groups: await P.h.groups(), profile: await P.h.profile(),
  inbox: await P.h.inbox(), prompts: await P.h.prompts(),
})
/** The sections two devices show differently; empty when they show the same. */
async function differ (X, Y) {
  const [x, y] = [await shows(X), await shows(Y)]
  return Object.keys(x).filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k]))
}

const green = { status: 'green' }
const red = (note) => ({ status: 'red', note })
const inexpressible = (note) => ({ status: 'inexpressible', note })
/** green when both devices show the same, and `also` holds */
async function same (T, L, also = true, what = '') {
  const d = await differ(T, L)
  if (d.length) return red('the devices differ in: ' + d.join(', '))
  return also ? green : red(what)
}
const short = (type) => type.slice(type.lastIndexOf('/spec/') + 6)
/** What was refused on the way, by whom: `who` names the receivers (`{phone: T, friend: B}`). */
function refused (seen, who) {
  const name = (p) => Object.entries(who).find(([, x]) => x === p)?.[0] ?? '?'
  const out = seen.filter((s) => s.got.disposition !== 'unique' && s.got.disposition !== 'duplicate-known')
    .map((s) => `${name(s.to)} refuses ${short(s.o.type)} (${s.got.reason ?? s.got.disposition})`)
  return [...new Set(out)].sort()
}

async function invited (people, inviter, groupId, contactId) {
  await route(people, ok(await inviter.h.invite(groupId, contactId, at(inviter))).outbound)
}
const invitePrompt = async (P, groupId) => (await P.h.prompts()).find((p) => p.kind === 'group-invite' && p.groupId === groupId)
async function founded (P, name = 'Garden') {
  return ev(ok(await P.h.foundGroup({ name }, at(P))), 'group.founded')[0].groupId
}
const phaseOf = async (P, groupId) => (await P.h.groups()).find((g) => g.id === groupId)?.phase

/** A with phone T, friend B, met; then the laptop as a copy of T.
 *  `profile`: A's profile class toward B is on before the copy. */
async function pairWithCopy (f, { profile = false } = {}) {
  const T = await mk(f), B = await mk(f + 1)
  const { a, b } = await met(T, B)
  if (profile) await route([T, B], ok(await T.h.setClass(a.id, 'profile', 'on', at(T))).outbound)
  const L = await copyOf(T)
  return { T, L, B, a, b }
}

const SCENARIOS = {
  // ---- devices
  G1: ['A adds the laptop next to the phone: the laptop shows the same contacts, trust, profile and groups', async () => {
    const T = await mk(0x21), B = await mk(0x22)
    await met(T, B)
    ok(await T.h.addDevice('laptop', at(T)))
    return same(T, await fromSeed(T))
  }],
  G2: ['a new phone while the old one is still there, then A removes the old one: the new phone shows the same, the old one speaks to no friend any more', async () => {
    const T = await mk(0x23), B = await mk(0x24)
    ok(await T.h.addDevice('phone', at(T)))
    const { a } = await met(T, B)
    ok(await T.h.addDevice('phone-2', at(T)))
    const N = await fromSeed(T)
    const notes = []
    const d = await differ(T, N)
    if (d.length) notes.push('the devices differ in: ' + d.join(', '))
    const gone = await N.h.revokeDevice('phone', at(N))
    if (!gone.ok) notes.push('the new phone cannot remove the old one: ' + gone.code)
    await route([T, N, B], ok(await T.h.sendMessage(a.id, 'still here', at(T))).outbound)
    if ((await B.h.inbox()).length) notes.push('B accepts a message of the old phone')
    return notes.length ? red(notes.join('; ')) : green
  }],
  G3: ['the phone is lost, A removes it from the laptop: the phone speaks to no friend any more', async () => {
    const T = await mk(0x25), B = await mk(0x26)
    ok(await T.h.addDevice('phone', at(T)))
    const { a } = await met(T, B)
    const L = await copyOf(T)
    ok(await L.h.revokeDevice('phone', at(L)))
    await route([T, L, B], ok(await T.h.sendMessage(a.id, 'still here', at(T))).outbound)
    return (await B.h.inbox()).length ? red('B accepts a message of the removed device') : green
  }],
  G4: ['every device is lost, A has the recovery words: contacts, trust, profile, groups and messages come back', async () => {
    const T = await mk(0x27), B = await mk(0x28)
    const { b } = await met(T, B)
    await founded(T)
    await route([T, B], ok(await B.h.sendMessage(b.id, 'hello', at(B))).outbound)
    return same(T, await fromSeed(T))
  }],
  G5: ['A restores an old image while the laptop goes on: the restored device catches up', async () => {
    const T = await mk(0x29), B = await mk(0x2a), C = await mk(0x2b)
    await met(T, B)
    const R = await copyOf(T)
    await met(T, C)
    await route([T, R, B, C], [])
    return same(T, R)
  }],
  G6: ['the laptop was off for 30 days: it catches up', async () => {
    const { T, L, B, a } = await pairWithCopy(0x2c)
    ok(await T.h.trust(a.id, at(T)))
    await route([T, B], [])
    await route([T, L, B], [], tick(30 * DAY))
    return same(T, L)
  }],

  // ---- contacts and trust
  K1: ['A meets B with the phone: B is on the laptop too', async () => {
    const T = await mk(0x31), B = await mk(0x32)
    const L = await copyOf(T)
    await met(T, B)
    await route([T, L, B], [])
    return same(T, L)
  }],
  K2: ['apart: the phone meets B, the laptop meets C: both devices show B and C', async () => {
    const T = await mk(0x33), B = await mk(0x34), C = await mk(0x35)
    const L = await copyOf(T)
    await met(T, B)
    await met(L, C)
    await route([T, L, B, C], [])
    return same(T, L)
  }],
  K3: ['B meets the phone, later and apart the laptop: one line for B on both devices, one line for A at B', async () => {
    const T = await mk(0x36), B = await mk(0x37)
    const L = await copyOf(T)
    await met(T, B)
    await met(L, B)
    await route([T, L, B], [])
    const n = (await B.h.contacts()).length
    return same(T, L, n === 1, `B holds ${n} lines for A`)
  }],
  K4: ['A trusts B on the phone: it holds on the laptop, B sees one effect and no device refuses anything', async () => {
    const { T, L, B, a, b } = await pairWithCopy(0x38)
    const bad = refused(await route([T, L, B], ok(await T.h.trust(a.id, at(T))).outbound), { phone: T, laptop: L, friend: B })
    if (!(await B.h.contact(b.id)).trust.received) return red('B did not receive the trust')
    const d = await differ(T, L)
    const notes = [...(d.length ? ['the devices differ in: ' + d.join(', ')] : []), ...bad]
    return notes.length ? red(notes.join('; ')) : green
  }],
  K5: ['apart: A trusts B on the phone and on the laptop: one effect at B, nobody refuses anything', async () => {
    const { T, L, B, a, b } = await pairWithCopy(0x3a)
    const t = ok(await T.h.trust(a.id, at(T)))
    const l = ok(await L.h.trust(a.id, at(L)))
    const bad = refused(await route([T, L, B], [...t.outbound, ...l.outbound]), { phone: T, laptop: L, friend: B })
    if (!(await B.h.contact(b.id)).trust.received) return red('B did not receive the trust')
    const d = await differ(T, L)
    const notes = [...(d.length ? ['the devices differ in: ' + d.join(', ')] : []), ...bad]
    return notes.length ? red(notes.join('; ')) : green
  }],
  K6: ['A removes B on the phone and, apart, writes to B on the laptop: B is gone on both devices', async () => {
    const { T, L, B, a } = await pairWithCopy(0x3c)
    const d = ok(await T.h.depart(a.id, at(T)))
    const m = await L.h.sendMessage(a.id, 'hello', at(L))
    await route([T, L, B], [...d.outbound, ...(m.outbound ?? [])])
    return same(T, L, (await L.h.contacts()).length === 0, 'the laptop still holds B')
  }],

  // ---- profile
  P1: ['A changes the profile on the phone: the laptop and the friends show it', async () => {
    const { T, L, B, b } = await pairWithCopy(0x41, { profile: true })
    await route([T, L, B], ok(await T.h.setProfile({ name: 'Ada' }, at(T))).outbound)
    return same(T, L, (await B.h.contact(b.id)).displayName === 'Ada', 'B does not show the name')
  }],
  P2: ['apart: the profile changed on the phone and on the laptop: both devices and every friend end on the same', async () => {
    const { T, L, B, b } = await pairWithCopy(0x43, { profile: true })
    const t = ok(await T.h.setProfile({ name: 'Ada' }, at(T)))
    const l = ok(await L.h.setProfile({ name: 'Ada L.' }, at(L)))
    const bad = refused(await route([T, L, B], [...t.outbound, ...l.outbound]), { phone: T, laptop: L, friend: B })
    const atB = (await B.h.contact(b.id)).displayName
    const own = [(await T.h.profile()).name, (await L.h.profile()).name]
    if (own[0] !== own[1]) return red([`phone shows ${own[0]}, laptop ${own[1]}, B ${atB}`, ...bad].join('; '))
    return same(T, L, atB === own[0], 'B shows another name')
  }],
  P3: ['A gives B another of its profiles on the phone: the laptop knows the assignment', async () =>
    inexpressible('one profile per sender (Trust 6b); no profile is assigned per contact')],

  // ---- messages
  N1: ['B writes to A: the message is on the phone and the laptop', async () => {
    const { T, L, B, b } = await pairWithCopy(0x51)
    await route([T, L, B], ok(await B.h.sendMessage(b.id, 'hello', at(B))).outbound)
    const n = [(await T.h.inbox()).length, (await L.h.inbox()).length]
    return n[0] === 1 && n[1] === 1 ? green : red(`inbox: phone ${n[0]}, laptop ${n[1]}`)
  }],
  N2: ['A writes from the phone: the message is in the conversation on the laptop', async () =>
    inexpressible('the library holds no record of sent messages; the conversation is the application\'s')],
  N3: ['A takes a message over on the phone: the laptop no longer offers it as new', async () => {
    const { T, L, B, b } = await pairWithCopy(0x53)
    await route([T, L, B], ok(await B.h.sendMessage(b.id, 'hello', at(B))).outbound)
    const ids = (await T.h.inbox()).map((m) => m.id)
    if (!ids.length) return red('the phone did not receive the message')
    await T.h.takeMessages(ids, { when: clk(T, tick()) })
    await route([T, L, B], [])
    const n = (await L.h.inbox()).length
    return n === 0 ? green : red(`the laptop still offers ${n}`)
  }],

  // ---- groups
  M1: ['an invitation to G arrives: the card is on the phone and the laptop', async () => {
    const { T, L, B, b } = await pairWithCopy(0x61)
    const g = await founded(B)
    await invited([T, L, B], B, g, b.id)
    const has = [!!(await invitePrompt(T, g)), !!(await invitePrompt(L, g))]
    return has[0] && has[1] ? green : red(`card: phone ${has[0]}, laptop ${has[1]}`)
  }],
  M2: ['A accepts on the phone: the laptop is in G without an act of its own, its card is decided', async () => {
    const { T, L, B, b } = await pairWithCopy(0x63)
    const g = await founded(B)
    await invited([T, L, B], B, g, b.id)
    const p = await invitePrompt(T, g)
    if (!p) return red('the phone holds no invitation')
    await route([T, L, B], ok(await T.h.decide(p.id, 'accept', at(T))).outbound)
    const ph = [await phaseOf(T, g), await phaseOf(L, g)]
    return ph[0] === 'member' && ph[1] === 'member' && !(await invitePrompt(L, g)) ? green : red(`phase: phone ${ph[0]}, laptop ${ph[1]}`)
  }],
  M3: ['apart: accept on the phone, decline on the laptop: one outcome on both devices and in the log', async () => {
    const { T, L, B, b } = await pairWithCopy(0x65)
    const g = await founded(B)
    await invited([T, L, B], B, g, b.id)
    const [pt, pl] = [await invitePrompt(T, g), await invitePrompt(L, g)]
    if (!pt || !pl) return red(`card: phone ${!!pt}, laptop ${!!pl}`)
    const t = ok(await T.h.decide(pt.id, 'accept', at(T)))
    const l = ok(await L.h.decide(pl.id, 'decline', at(L)))
    await route([T, L, B], [...t.outbound, ...l.outbound])
    const ph = [await phaseOf(T, g), await phaseOf(L, g)]
    const atB = (await B.h.groups()).find((x) => x.id === g).members.length
    if (ph[0] !== ph[1]) return red(`phase: phone ${ph[0]}, laptop ${ph[1]}; B's log holds ${atB} members`)
    return (atB === 2) === (ph[0] === 'member') ? green : red(`both devices ${ph[0]}, B's log holds ${atB} members`)
  }],
  M4: ['A founds G on the phone and invites B from the laptop: B joins, both devices show B as a member', async () => {
    const { T, L, B, a } = await pairWithCopy(0x67)
    const g = await founded(T)
    await route([T, L, B], [])
    const inv = await L.h.invite(g, a.id, at(L))
    if (!inv.ok) return red('the laptop cannot invite: ' + inv.code)
    await route([T, L, B], inv.outbound)
    const p = await invitePrompt(B, g)
    if (!p) return red('B holds no invitation')
    await route([T, L, B], ok(await B.h.decide(p.id, 'accept', at(B))).outbound)
    const n = async (P) => (await P.h.groups()).find((x) => x.id === g)?.members.length
    const got = [await phaseOf(B, g), await n(T), await n(L)]
    return got[0] === 'member' && got[1] === 2 && got[2] === 2 ? green : red(`B ${got[0]}, members: phone ${got[1]}, laptop ${got[2]}`)
  }],
  M5: ['apart: the phone invites C, the laptop leaves G: one outcome, A is not half a member', async () => {
    const T = await mk(0x69), B = await mk(0x6a), C = await mk(0x6b)
    await met(T, B)
    const { a: c } = await met(T, C)
    const g = await founded(T)
    const L = await copyOf(T)
    const inv = ok(await T.h.invite(g, c.id, at(T)))
    const left = ok(await L.h.leaveGroup(g, at(L)))
    await route([T, L, B, C], [...inv.outbound, ...left.outbound])
    const pc = await invitePrompt(C, g)
    if (pc) await route([T, L, B, C], ok(await C.h.decide(pc.id, 'accept', at(C))).outbound)
    const ph = [await phaseOf(T, g), await phaseOf(L, g), await phaseOf(C, g)]
    return ph[0] === ph[1] ? green : red(`phase: phone ${ph[0]}, laptop ${ph[1]}, C ${ph[2]}`)
  }],
  M6: ['A leaves G on the phone: the laptop shows G as left', async () => {
    const T = await mk(0x6c)
    const g = await founded(T)
    const L = await copyOf(T)
    await route([T, L], ok(await T.h.leaveGroup(g, at(T))).outbound)
    const ph = [await phaseOf(T, g), await phaseOf(L, g)]
    return ph[0] === 'left' && ph[1] === 'left' ? green : red(`phase: phone ${ph[0]}, laptop ${ph[1]}`)
  }],
  M7: ['A adds the laptop while a member of G: the laptop has G with its members and their provenance', async () => {
    const T = await mk(0x6e), B = await mk(0x6f)
    const { a } = await met(T, B)
    const g = await founded(T)
    await invited([T, B], T, g, a.id)
    await route([T, B], ok(await B.h.decide((await invitePrompt(B, g)).id, 'accept', at(B))).outbound)
    assert.ok(Object.values(await T.h.groupProvenance(g)).some((by) => by.length), 'the phone holds who invited B')
    ok(await T.h.addDevice('laptop', at(T)))
    const L = await fromSeed(T)
    if ((await phaseOf(L, g)) !== 'member') return red('the laptop does not hold G')
    const view = async (P) => JSON.stringify([strip((await P.h.groups()).find((x) => x.id === g)), await P.h.groupProvenance(g)])
    return (await view(L)) === (await view(T)) ? green : red('the laptop shows other members or another provenance')
  }],
  M8: ['A removes the lost phone: A stays a member, the phone reads nothing new from G', async () => {
    const T = await mk(0x71), B = await mk(0x72), C = await mk(0x73)
    ok(await T.h.addDevice('phone', at(T)))
    const { a: tb } = await met(T, B)
    const { a: bc } = await met(B, C)
    const g = await founded(T)
    await invited([T, B], T, g, tb.id)
    await route([T, B], ok(await B.h.decide((await invitePrompt(B, g)).id, 'accept', at(B))).outbound)
    const L = await copyOf(T)
    ok(await L.h.revokeDevice('phone', at(L)))
    await invited([T, L, B, C], B, g, bc.id)
    await route([T, L, B, C], ok(await C.h.decide((await invitePrompt(C, g)).id, 'accept', at(C))).outbound)
    const count = async (P) => (await P.h.groups()).find((x) => x.id === g).members.length
    assert.equal(await count(B), 3, 'C joined')
    if ((await phaseOf(L, g)) !== 'member') return red('the laptop is no member')
    if ((await count(L)) !== 3) return red(`the laptop does not read the new member (${await count(L)} members)`)
    return (await count(T)) === 2 ? green : red(`the removed phone reads the new member (${await count(T)} members)`)
  }],

  // ---- what others learn
  S1: ['others can tell that A has several devices, cannot link them across relationships, and see no device list', async () =>
    inexpressible('a device has no identity on the wire: every device of a seed presents the same keys')],
}

export interface BaselineRow { id: string, title: string, status: 'green' | 'red' | 'inexpressible', note?: string }

/** Runs every scenario. A scenario that throws did not reach its observation and throws here too. */
export async function runBaseline (): Promise<BaselineRow[]> {
  const out = []
  for (const [id, [title, run]] of Object.entries(SCENARIOS)) {
    let r
    try { r = await run() } catch (e) { e.message = `${id}: ${e.message}`; throw e }
    out.push({ id, title, status: r.status, ...(r.note ? { note: r.note } : {}) })
  }
  return out
}
