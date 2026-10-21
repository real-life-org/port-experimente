// E15 K2 step 2b.2: the issuance automaton, the act-end stop and the restart from the last commit
// (rltp/design/port-experimente-e15-k2-schritt-2b-kern-entwurf-4-2026-10-21.md, Fassung 4, §1, §5, §6 "2b.2").
//
// Every expected value below comes from the acceptance sheet `src/candidates/mehrgeraet-k2/ABNAHME-2b2.md`, derived by
// hand before the automaton was built (draft 3 §7.2); the comment at each assertion names the sheet row. Nothing is taken
// from a run. Worlds: W2 (A1, B1, M1 + M2, share 5), W2+A2, W3 (three M devices, share 2), W4 (three M devices, share 3),
// W5 (8-day stock keys).

import { describe, expect, it } from 'vitest'
import { k2 } from '../src/candidates/mehrgeraet-k2'
import { deadTickets, judge, ledgerWorld, oneSided, pairCounter, type Buch, type Check } from '../src/lab/mehrgeraet/buch'
import { frameHash, TYPES, type HolderDevice } from '../src/lab/mehrgeraet/holder'
import * as M from '../src/lab/mehrgeraet/model'
import type { Welt15 } from '../src/lab/mehrgeraet/welt'
import { WireUnreachable, type CrashPoint } from '../src/lab/zustellung'

const SEC = 1000
const HOUR = 3600 * SEC
const DAY = 24 * HOUR

interface World {
  w: Welt15
  buch: Buch
  A1: HolderDevice
  A2?: HolderDevice
  B1: HolderDevice
  M1: HolderDevice
  M2?: HolderDevice
  M3?: HolderDevice
  /** Relationship ids: A's and B's to M (`am.x`, `bm.x`), M's to A and B (`am.y`, `bm.y`). */
  am: { x: string; y: string }
  bm: { x: string; y: string }
  share: number
  round(n?: number): Promise<void>
}

/** W2 and its variants (sheet §0.2). */
async function world(o: { m2?: boolean; m3?: boolean; a2?: boolean; budget?: number; devices?: number; stockLifetimeMs?: number; automaton?: boolean } = {}): Promise<World> {
  const cand = k2({ singleDevice: [], ...(o.budget ? { budget: o.budget } : {}), ...(o.devices ? { devices: o.devices } : {}), ...(o.stockLifetimeMs ? { stockLifetimeMs: o.stockLifetimeMs } : {}), ...(o.automaton === false ? { automaton: false } : {}) })
  const { w, buch } = ledgerWorld(cand)
  const A1 = await w.person('A', 'A1')
  const B1 = await w.person('B', 'B1')
  const M1 = await w.person('M', 'M1')
  const am = await w.encounter(A1, M1)
  const bm = await w.encounter(B1, M1)
  const round = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      await w.rounds(1)
      buch.note('round', undefined, { up: w.devices.filter((d) => d.online && !d.isDown).map((d) => d.name) })
    }
  }
  await round(2)
  let M2: HolderDevice | undefined
  let M3: HolderDevice | undefined
  if (o.m2 !== false) {
    M2 = await w.enrol(M1, 'M2')
    if (o.m3) M3 = await w.enrol(M1, 'M3')
    await round(3)
  }
  await A1.setClass(am.x.id, true)
  await B1.setClass(bm.x.id, true)
  await round(3)
  const A2 = o.a2 ? await w.enrol(A1, 'A2') : undefined
  if (A2) await round(3)
  const share = (A1.cand as { acceptanceShare?: number }).acceptanceShare!
  return { w, buch, A1, A2, B1, M1, M2, M3, am: { x: am.x.id, y: am.y.id }, bm: { x: bm.x.id, y: bm.y.id }, share, round }
}

/** An M device's anchors (the `for` of keys assigned to it) in one relationship. */
async function mine(d: HolderDevice, rel: string): Promise<string[]> {
  const r = M.findRel(d.state, rel)
  return r ? Promise.all(r.tuples.map(async (t) => (await d.cand.keys.pair(t.ownKey)).anchor)) : []
}

/** `introduce` noted in the ledger as the generator does (P-Produktion's reference reads the event). */
async function introduce(s: World, m: HolderDevice, crash?: CrashPoint, order: 'ab' | 'ba' = 'ab') {
  const [relA, relB] = order === 'ab' ? [s.am.y, s.bm.y] : [s.bm.y, s.am.y]
  const detail: Record<string, unknown> = { relA, relB, mineA: await mine(m, relA), mineB: await mine(m, relB), result: null, armed: crash ?? null, up: !m.isDown && m.online }
  s.buch.note('introduce', m.name, detail)
  if (crash) m.crashAt = crash
  const r = await m.introduce(relA, relB)
  m.crashAt = null
  detail.result = r
  const act = 'act' in r ? r.act : m.state.mediatorActs[m.state.mediatorActs.length - 1]?.id
  return { r, act: act! }
}
async function reload(s: World, d: HolderDevice, opts?: { fresh?: boolean }) {
  await d.reload(opts)
  s.buch.note('reload', d.name)
}

/** The issued act at M1 and its ticket intents per side. */
function issued(m: HolderDevice, act: string) {
  const a = m.state.mediatorActs.find((x) => x.id === act)!
  const t = (side: 'a' | 'b') => [...m.intents.values()].find((i) => i.kind === TYPES.ticket && i.act === act && i.side === side)!
  return { a, tA: t('a'), tB: t('b') }
}
/** Deposits at the carrier of the bytes of an intent (repeats included). */
const deposits = (s: World, i: { bytes: Uint8Array }) => s.w.carrier.carried.filter((f) => frameHash(f.bytes) === frameHash(i.bytes)).length
/** 8640.14 commits in the ledger for an act on a key. */
const acceptances = (s: World, act: string, key: string) => s.buch.commits.flatMap((c) => c.ops).filter((op) => op.kind === 'ticket-accept' && op.act.id === act && op.act.own === key).length
const knowledge = (m: HolderDevice, act: string) => {
  const k = m.state.mediatorActs.find((x) => x.id === act)?.known
  return [k?.a ? 'accepted' : 'unknown', k?.b ? 'accepted' : 'unknown']
}
const evidence = (m: HolderDevice, side: { rel: string; key: string }) => M.evidence(m.state, side.rel, side.key).state
const sideState = (d: HolderDevice, act: string) => d.state.acts.find((x) => x.id === act)?.state ?? 'none'
const load = (d: HolderDevice, rel: string, now: string) => M.budgetUsed(M.rel(d.state, rel), now)
const prop = (cs: Check[], p: Check['property']) => cs.find((c) => c.property === p)!
const kind = (s: World, f: { bytes: Uint8Array }) => s.w.frameOrigin(f.bytes)?.kind
/** Drain Z (sheet §0.2): Z1 to `TB + 1 s`, 1 round; Z2 to `AE + 1 s`, 2 rounds. */
async function drain(s: World, a: M.MediatorAct) {
  s.w.clock.set(new Date(Date.parse(a.expiresAt) - DAY + SEC).toISOString())
  s.buch.note('advance', undefined, {})
  await s.round(1)
  s.w.clock.set(new Date(Date.parse(a.expiresAt) + HOUR + SEC).toISOString())
  s.buch.note('advance', undefined, {})
  await s.round(2)
}
async function checks(s: World) {
  return judge(s.buch, { share: s.share })
}
const allOk = (cs: Check[]) => cs.filter((c) => !c.ok).map((c) => `${c.property}: ${c.violations.join('; ')}`)

describe('K2 step 2b.2: core counter-runs K1–K10', () => {
  for (const variant of ['between-sends', 'before-send'] as const) {
    it(`K1${variant === 'between-sends' ? 'a' : 'b'}. Crash at \`${variant}\` with two M devices: restart from the last commit, own intents only (MV-8), sheet K1`, async () => {
      const s = await world()
      const { act } = await introduce(s, s.M1, variant)
      expect(s.M1.isDown).toBe(true)
      const writer = s.M1.cand.writer
      await reload(s, s.M1)
      expect(s.M1.cand.writer).toBe(writer) // 5.3: writer `M1@inc` unchanged
      await s.round(4)
      const { a, tA, tB } = issued(s.M1, act)
      // Soll: issuance commits 1, digests 2.
      expect(s.buch.commits.filter((c) => c.ops.some((op) => op.kind === 'introduce')).length).toBe(1)
      expect(new Set([tA.digest, tB.digest]).size).toBe(2)
      // Soll: deposits tA / tB = 1 / 1 (K1a: the pre-crash copy, the resubmission omitted on known `accepted`, decision 13).
      expect([deposits(s, tA), deposits(s, tB)]).toEqual([1, 1])
      // Soll: deposits by M2 0 (P-Eigen): no carrier frame of these bytes produced by M2.
      expect(s.w.carrier.carried.filter((f) => s.w.frameOrigin(f.bytes)?.device === 'M2' && s.w.frameOrigin(f.bytes)?.kind === 'introduction-ticket').length).toBe(0)
      // Soll: acceptances 1 / 1, load 1 / 1.
      expect([acceptances(s, act, a.a.key), acceptances(s, act, a.b.key)]).toEqual([1, 1])
      const now = s.w.clock.now()
      expect([load(s.A1, s.am.x, now), load(s.B1, s.bm.x, now)]).toEqual([1, 1])
      // Soll: knowledge accepted / accepted at M1 and (journal) M2.
      expect(knowledge(s.M1, act)).toEqual(['accepted', 'accepted'])
      expect(knowledge(s.M2!, act)).toEqual(['accepted', 'accepted'])
      // Soll: evidence unlisted / unlisted (consumed, refilled listing).
      expect([evidence(s.M1, a.a), evidence(s.M1, a.b)]).toEqual(['unlisted', 'unlisted'])
      // Soll: no MV-3 conflict at M2.
      expect(s.M2!.state.findings.filter((f) => f.startsWith('Journal-Konflikt'))).toEqual([])
      await drain(s, a)
      expect([sideState(s.A1, act), sideState(s.B1, act)]).toEqual(['expired', 'expired'])
      expect(pairCounter(s.buch).tuples['A→B'] ?? 0).toBe(0)
      const cs = await checks(s)
      expect(allOk(cs)).toEqual([])
      const pp = prop(cs, 'P-Produktion').counts
      expect([pp.obliged, pp.kept]).toEqual([1, 1])
      // Soll (decision 13): K1a omits the resubmission of tA once (gate `accepted`), K1b nothing.
      expect(s.M1.ticketOmissions.filter((x) => x.reason === 'accepted').length).toBe(variant === 'between-sends' ? 1 : 0)
      expect(prop(cs, 'P-Bilanz').counts.max).toBe(5)
      expect(deadTickets(s.buch, s.w).deadAccepted).toBe(0)
    }, 240_000)
  }

  it('K2. Ticket reaches A before the matching revision reaches M: stale knowledge does not prevent the acceptance, no further issuance (sheet K2)', async () => {
    const s = await world()
    // Withhold at M1 every A1 stock revision (the revision after the acceptance, r2).
    // M2 folds r2 and journals it; that copy reaches M1 through the journal, so the journal from M2 is withheld too.
    s.w.carrier.faults.withhold('M1', (f) => (kind(s, f) === 'stock-revision' && s.w.frameOrigin(f.bytes)?.device === 'A1') || s.w.frameOrigin(f.bytes)?.device === 'M2')
    const { act } = await introduce(s, s.M1)
    const { a, tA, tB } = issued(s.M1, act)
    expect(evidence(s.M1, a.a)).toBe('listed') // at the issuance
    await s.round(3)
    expect(acceptances(s, act, a.a.key)).toBe(1)
    expect(knowledge(s.M1, act)).toEqual(['accepted', 'accepted']) // receipts before r2
    expect(evidence(s.M1, a.a)).toBe('listed') // r2 withheld
    expect(evidence(s.M2!, a.a)).toBe('unlisted') // M2's copy not withheld
    s.w.carrier.faults.reset()
    await s.round(2)
    expect(evidence(s.M1, a.a)).toBe('unlisted')
    expect([deposits(s, tA), deposits(s, tB)]).toEqual([1, 1])
    expect(s.buch.commits.filter((c) => c.ops.some((op) => op.kind === 'introduce')).length).toBe(1)
    await drain(s, a)
    expect([sideState(s.A1, act), sideState(s.B1, act)]).toEqual(['expired', 'expired'])
    const cs = await checks(s)
    expect(allOk(cs)).toEqual([])
    expect([prop(cs, 'P-Produktion').counts.obliged, prop(cs, 'P-Produktion').counts.kept]).toEqual([1, 1])
    expect(prop(cs, 'P-Bilanz').counts.max).toBe(5)
  }, 240_000)

  it('K3. Withdrawal with the ticket in flight: no acceptance at A, the deliverer stops repeating on `withdrawn` (decision 15), dead ticket `zurueckgezogen` (sheet K3)', async () => {
    const s = await world()
    s.w.carrier.faults.withhold('A1', (f) => kind(s, f) === 'introduction-ticket')
    const { act } = await introduce(s, s.M1)
    const { a, tA, tB } = issued(s.M1, act)
    await s.round(1)
    expect(acceptances(s, act, a.b.key)).toBe(1)
    await s.A1.withdrawStock(s.am.x, [a.a.key])
    s.w.carrier.faults.reset()
    await s.round(4)
    // Soll: tA 1 deposit (M1 folds the withdrawal in round 2, expire before the repeat of round 3), tB 1.
    expect([deposits(s, tA), deposits(s, tB)]).toEqual([1, 1])
    expect(s.A1.ticketLog.filter((x) => x.act === act).map((x) => x.outcome)).toEqual(['state:withdrawn'])
    expect([acceptances(s, act, a.a.key), acceptances(s, act, a.b.key)]).toEqual([0, 1])
    const now = s.w.clock.now()
    expect([load(s.A1, s.am.x, now), load(s.B1, s.bm.x, now)]).toEqual([0, 1])
    expect(knowledge(s.M1, act)).toEqual(['unknown', 'accepted'])
    expect([evidence(s.M1, a.a), evidence(s.M1, a.b)]).toEqual(['withdrawn', 'unlisted'])
    expect(s.M1.zusteller.report(tA.digest)?.state).toBe('accepted') // decision 3: handed, no withdrawal
    expect(s.M1.zusteller.submissions.get(tA.digest)?.stopped).toBe('withdrawn')
    await drain(s, a)
    expect([sideState(s.A1, act), sideState(s.B1, act)]).toEqual(['none', 'expired'])
    const dead = deadTickets(s.buch, s.w)
    expect([dead.causes.zurueckgezogen, dead.deadAccepted]).toEqual([1, 1])
    const cs = await checks(s)
    expect(allOk(cs)).toEqual([])
    expect([prop(cs, 'P-Produktion').counts.obliged, prop(cs, 'P-Produktion').counts.kept]).toEqual([1, 1])
  }, 240_000)

  it('K4. Three M devices, `frei_zuteilbar = 1`: exactly one new right, to the first empty device by code-unit anchor order (sheet K4)', async () => {
    const s = await world({ m2: false, devices: 3, budget: 6 })
    expect(s.share).toBe(2)
    const own = (d: HolderDevice, forM?: string) => M.rel(d.state, d === s.A1 ? s.am.x : s.bm.x).stock.filter((k) => k.by === d.name && k.state === 'active' && (forM === undefined || k.for === forM))
    const anchorAt = async (d: HolderDevice, rel: string) => (await mine(d, rel))[0]!
    const m1A = await anchorAt(s.M1, s.am.y)
    expect([own(s.A1).length, own(s.A1, m1A).length]).toEqual([2, 2])
    const M2 = await s.w.enrol(s.M1, 'M2')
    const M3 = await s.w.enrol(s.M1, 'M3')
    await s.round(3)
    const m2A = await anchorAt(M2, s.am.y)
    const m3A = await anchorAt(M3, s.am.y)
    expect([own(s.A1, m2A).length, own(s.A1, m3A).length]).toEqual([0, 0])
    expect('refused' in (await introduce(s, M2)).r).toBe(true)
    expect('refused' in (await introduce(s, M3)).r).toBe(true)
    const { act, r } = await introduce(s, s.M1)
    expect('act' in r).toBe(true)
    await s.round(3)
    const ia = issued(s.M1, act)
    expect([acceptances(s, act, ia.a.a.key), acceptances(s, act, ia.a.b.key)]).toEqual([1, 1])
    expect(own(s.A1).length).toBe(1) // belegt 1, reserviert 1, free 0
    await s.A1.confirmBudget(s.am.x)
    await s.round(3)
    const first = [m2A, m3A].sort(M.byCode)[0]!
    const second = [m2A, m3A].sort(M.byCode)[1]!
    // Soll: exactly one new right, to `min_byCode(anchor_A(m2), anchor_A(m3))`.
    expect([own(s.A1, first).length, own(s.A1, second).length, own(s.A1, m1A).length]).toEqual([1, 0, 1])
    const mStar = first === m2A ? M2 : M3
    // Soll: `m*` still has no B key → refused.
    expect('refused' in (await introduce(s, mStar)).r).toBe(true)
    await drain(s, ia.a)
    const cs = await checks(s)
    expect(allOk(cs)).toEqual([])
    const pp = prop(cs, 'P-Produktion').counts
    expect([pp.introductions, pp.obliged, pp.kept, pp.noKeys]).toEqual([4, 1, 1, 3])
    expect(prop(cs, 'P-Bilanz').counts.max).toBe(2)
    // Soll: unsupplied at the end: A1 1, B1 2 → 3.
    expect(prop(cs, 'P-Versorgung').counts.unsupplied).toBe(3)
  }, 300_000)

  for (const v of ['a', 'b'] as const) {
    it(`K5${v}. Submission after a \`before-send\` crash at ${v === 'a' ? 'TB (equality admissible)' : 'TB + 1 s (nothing submitted)'} (sheet K5, decision 1)`, async () => {
      const s = await world()
      const { act } = await introduce(s, s.M1, 'before-send')
      const { a, tA, tB } = issued(s.M1, act)
      const tb = Date.parse(a.expiresAt) - DAY
      s.w.clock.set(new Date(tb + (v === 'a' ? 0 : SEC)).toISOString())
      s.buch.note('advance', undefined, {})
      await reload(s, s.M1)
      await s.round(2)
      if (v === 'a') {
        expect([deposits(s, tA), deposits(s, tB)]).toEqual([1, 1])
        expect([acceptances(s, act, a.a.key), acceptances(s, act, a.b.key)]).toEqual([1, 1])
        await s.A1.consent(act)
        await s.B1.consent(act)
        expect([sideState(s.A1, act), sideState(s.B1, act)]).toEqual(['consented', 'consented']) // 8155: equality admissible
        await s.round(3)
        expect([sideState(s.A1, act), sideState(s.B1, act)]).toEqual(['connected', 'connected'])
        expect(knowledge(s.M1, act)).toEqual(['accepted', 'accepted'])
        expect([s.M1.zusteller.report(tA.digest)?.state, s.M1.zusteller.report(tB.digest)?.state]).toEqual(['delivered', 'delivered'])
        expect([pairCounter(s.buch).tuples['A→B'], pairCounter(s.buch).tuples['B→A']]).toEqual([1, 1])
      } else {
        expect([deposits(s, tA), deposits(s, tB)]).toEqual([0, 0])
        expect([acceptances(s, act, a.a.key), acceptances(s, act, a.b.key)]).toEqual([0, 0])
        expect(knowledge(s.M1, act)).toEqual(['unknown', 'unknown'])
        expect([s.M1.zusteller.report(tA.digest), s.M1.zusteller.report(tB.digest)]).toEqual([{ state: 'failed', reason: 'consent-reserve' }, { state: 'failed', reason: 'consent-reserve' }])
      }
      await drain(s, a)
      const cs = await checks(s)
      expect(allOk(cs)).toEqual([])
      const pp = prop(cs, 'P-Produktion').counts
      if (v === 'a') {
        expect([pp.obliged, pp.kept]).toEqual([1, 1])
        expect(prop(cs, 'P-Paar').counts.bothSides).toBe(1)
      } else expect([pp.obliged, pp.down]).toEqual([0, 1]) // decision 2
    }, 240_000)
  }

  it('K5c. spaetes-ticket: submitted on time, delivered after TB; A accepts (8640.3 until AE), its act expires at once (A7), no consent possible (sheet K5c)', async () => {
    const s = await world()
    const { act } = await introduce(s, s.M1)
    const { a, tA, tB } = issued(s.M1, act)
    s.w.carrier.faults.withhold('A1', (f) => kind(s, f) === 'introduction-ticket')
    await s.round(3)
    s.w.clock.set(new Date(Date.parse(a.expiresAt) - DAY + SEC).toISOString())
    s.buch.note('advance', undefined, {})
    s.w.carrier.faults.reset()
    await s.round(2)
    expect([deposits(s, tA), deposits(s, tB)]).toEqual([2, 1])
    expect([acceptances(s, act, a.a.key), acceptances(s, act, a.b.key)]).toEqual([1, 1])
    expect(sideState(s.A1, act)).toBe('expired')
    await s.A1.consent(act)
    expect(sideState(s.A1, act)).toBe('expired')
    expect(knowledge(s.M1, act)).toEqual(['accepted', 'accepted'])
    await drain(s, a)
    const dead = deadTickets(s.buch, s.w)
    expect([dead.causes['spaetes-ticket'], dead.deadAccepted]).toEqual([1, 2])
    const cs = await checks(s)
    expect(allOk(cs)).toEqual([])
    expect([prop(cs, 'P-Produktion').counts.obliged, prop(cs, 'P-Produktion').counts.kept]).toEqual([1, 1])
  }, 240_000)

  it('K6. One-sided connection by a late card: B connected, A expired, no P-Paar violation (sheet K6, core draft 4 §1.3)', async () => {
    const s = await world()
    const { act } = await introduce(s, s.M1)
    const { a } = issued(s.M1, act)
    await s.round(2)
    await s.A1.consent(act)
    await s.B1.consent(act)
    s.w.carrier.faults.withhold('A1', (f) => kind(s, f) === 'introduction-card')
    await s.round(3)
    expect(sideState(s.B1, act)).toBe('connected')
    s.w.clock.set(new Date(Date.parse(a.expiresAt) + HOUR + SEC).toISOString())
    s.buch.note('advance', undefined, {})
    await s.round(1)
    expect(sideState(s.A1, act)).toBe('expired')
    s.w.carrier.faults.reset()
    await s.round(2)
    expect([sideState(s.A1, act), sideState(s.B1, act)]).toEqual(['expired', 'connected'])
    const bCard = s.w.carrier.carried.filter((f) => kind(s, f) === 'introduction-card' && s.w.frameOrigin(f.bytes)?.device === 'B1').length
    expect(bCard).toBe(2) // deposit + repeat at round 3, no repeat after the expire
    expect(s.A1.cardLog.filter((x) => x.act === act).map((x) => x.outcome)).toEqual(['after-acceptance-end-8110.5', 'after-acceptance-end-8110.5'])
    expect(oneSided(s.buch)).toEqual({ 'late-card': 1, other: 0 })
    expect([pairCounter(s.buch).tuples['B→A'] ?? 0, pairCounter(s.buch).tuples['A→B'] ?? 0]).toEqual([1, 0])
    const cs = await checks(s)
    expect(allOk(cs)).toEqual([])
    expect(prop(cs, 'P-Paar').counts).toEqual({ connectedActs: 1, bothSides: 0 })
    expect(deadTickets(s.buch, s.w).deadAccepted).toBe(0)
  }, 240_000)

  for (const v of ['a', 'b'] as const) {
    it(`K7${v}. Resumption after a lifted tombstone effect, intent seen ${v === 'a' ? 'before' : 'after'} the lift: one submission per digest (sheet K7, 5.1)`, async () => {
      const s = await world()
      const { act } = await introduce(s, s.M1, 'before-send')
      const { a, tA, tB } = issued(s.M1, act)
      const A2 = await s.w.enrol(s.A1, 'A2')
      await s.round(3)
      const selves = s.w.selfAddresses('A')
      s.w.carrier.faults.withhold('A1', (f) => selves.has(f.address))
      await A2.setClass(s.am.x, false)
      if (v === 'a') {
        await reload(s, s.M1)
        await s.round(1)
        expect(evidence(s.M1, a.a)).toBe('withdrawn')
        expect(deposits(s, tA)).toBe(0)
        expect(deposits(s, tB)).toBe(1)
        await s.w.revoke(s.A1, A2)
        await s.round(1)
        expect(evidence(s.M1, a.a)).toBe('listed')
        expect(deposits(s, tA)).toBe(1) // resubmitted in M1's round 2
      } else {
        await s.w.revoke(s.A1, A2)
        await s.round(2)
        await reload(s, s.M1)
        await s.round(1)
        expect(evidence(s.M1, a.a)).toBe('listed')
        expect([deposits(s, tA), deposits(s, tB)]).toEqual([1, 1])
      }
      await s.round(3)
      expect([deposits(s, tA), deposits(s, tB)]).toEqual([1, 1])
      expect([acceptances(s, act, a.a.key), acceptances(s, act, a.b.key)]).toEqual([1, 1])
      expect(knowledge(s.M1, act)).toEqual(['accepted', 'accepted'])
      expect(s.M1.ticketOmissions.filter((x) => x.reason === 'withdrawn').length).toBe(v === 'a' ? 1 : 0)
      s.w.carrier.faults.reset()
      await drain(s, a)
      const cs = await checks(s)
      expect(allOk(cs)).toEqual([])
      expect([prop(cs, 'P-Produktion').counts.obliged, prop(cs, 'P-Produktion').counts.kept]).toEqual([1, 1])
    }, 300_000)
  }

  it('K8a. Ticket after the acceptance end: A accepts, B refuses by 8640.3 at AE + 1 s, dead `spaet-zugestellt` (sheet K8a)', async () => {
    const s = await world()
    s.w.carrier.faults.withhold('B1', (f) => kind(s, f) === 'introduction-ticket')
    const { act } = await introduce(s, s.M1)
    const { a, tA, tB } = issued(s.M1, act)
    await s.round(2)
    s.w.clock.set(new Date(Date.parse(a.expiresAt) + HOUR + SEC).toISOString())
    s.buch.note('advance', undefined, {})
    await s.round(1)
    expect(sideState(s.A1, act)).toBe('expired')
    s.w.carrier.faults.reset()
    await s.round(2)
    expect([deposits(s, tA), deposits(s, tB)]).toEqual([1, 1])
    expect(s.B1.ticketLog.filter((x) => x.act === act).map((x) => x.outcome)).toEqual(['8640.3'])
    expect([acceptances(s, act, a.a.key), acceptances(s, act, a.b.key)]).toEqual([1, 0])
    const now = s.w.clock.now()
    expect([load(s.A1, s.am.x, now), load(s.B1, s.bm.x, now)]).toEqual([1, 0])
    expect(knowledge(s.M1, act)).toEqual(['accepted', 'unknown'])
    expect([s.M1.zusteller.report(tA.digest)?.state, s.M1.zusteller.report(tB.digest)?.state]).toEqual(['delivered', 'accepted']) // receipts 1 (A); tB handed, stopped
    expect(s.M1.zusteller.submissions.get(tB.digest)?.stopped).toBe('consent-reserve')
    expect([sideState(s.A1, act), sideState(s.B1, act)]).toEqual(['expired', 'none'])
    const dead = deadTickets(s.buch, s.w)
    expect([dead.causes['spaet-zugestellt'], dead.deadAccepted]).toEqual([1, 1])
    const cs = await checks(s)
    expect(allOk(cs)).toEqual([])
    expect([prop(cs, 'P-Produktion').counts.obliged, prop(cs, 'P-Produktion').counts.kept]).toEqual([1, 1])
  }, 240_000)

  it('K8b. Departure of M from A before either ticket is submitted: both cancelled (8232.1), 2 omissions `abgang`, no violation (sheet K8b)', async () => {
    const s = await world()
    const { act } = await introduce(s, s.M1, 'before-send')
    const { a, tA, tB } = issued(s.M1, act)
    await reload(s, s.M1)
    await s.M1.depart(s.am.y)
    await s.round(3)
    expect([deposits(s, tA), deposits(s, tB)]).toEqual([0, 0])
    expect([acceptances(s, act, a.a.key), acceptances(s, act, a.b.key)]).toEqual([0, 0])
    expect(knowledge(s.M1, act)).toEqual(['unknown', 'unknown'])
    await drain(s, a)
    expect([sideState(s.A1, act), sideState(s.B1, act)]).toEqual(['none', 'none'])
    const dead = deadTickets(s.buch, s.w)
    expect([dead.causes.abgang, dead.deadAccepted]).toEqual([1, 0])
    const cs = await checks(s)
    expect(allOk(cs)).toEqual([])
    const pp = prop(cs, 'P-Produktion').counts
    expect([pp.obliged, pp.kept, pp['omitted:abgang']]).toEqual([1, 0, 2])
  }, 240_000)

  it('K8c. Departure of M from A after the counter-ticket is submitted (bench fault: deposit at xA unreachable): tA cancelled, B accepts (sheet K8c, decision 5)', async () => {
    const s = await world()
    const carrier = s.w.carrier
    const deposit = carrier.deposit.bind(carrier)
    let ka = ''
    carrier.deposit = (address: string, bytes: Uint8Array) => {
      if (address === ka) throw new WireUnreachable('bench fault: deposit at xA unreachable')
      return deposit(address, bytes)
    }
    // The named key is the smallest by code units among M1's nameable A keys (decision 16).
    ka = M.usableView(s.M1.state, s.am.y, s.w.clock.now(), new Set(await mine(s.M1, s.am.y))).unconsumed.sort((x, y) => M.byCode(x.anchor, y.anchor))[0]!.keyAgreement
    const { act } = await introduce(s, s.M1)
    const { a, tA, tB } = issued(s.M1, act)
    expect(a.a.keyAgreement).toBe(ka)
    expect(s.M1.zusteller.report(tA.digest)).toEqual({ state: 'awaiting-transport', reason: 'transport-unreachable' })
    await s.M1.depart(s.am.y)
    carrier.deposit = deposit
    await s.round(3)
    expect([deposits(s, tA), deposits(s, tB)]).toEqual([0, 1])
    expect(s.M1.zusteller.submissions.has(tA.digest)).toBe(false) // cancelled (8232.1)
    expect([acceptances(s, act, a.a.key), acceptances(s, act, a.b.key)]).toEqual([0, 1])
    expect(knowledge(s.M1, act)).toEqual(['unknown', 'accepted'])
    await drain(s, a)
    expect([sideState(s.A1, act), sideState(s.B1, act)]).toEqual(['none', 'expired'])
    const dead = deadTickets(s.buch, s.w)
    expect([dead.causes.abgang, dead.deadAccepted]).toEqual([1, 1])
    const cs = await checks(s)
    expect(allOk(cs)).toEqual([])
    const pp = prop(cs, 'P-Produktion').counts
    expect([pp.obliged, pp.kept, pp['omitted:abgang']]).toEqual([1, 0, 1])
  }, 240_000)

  it('K9. connected/declined before and after the journal reconciliation: no P-Paar violation either time, the decline ends as conflict (sheet K9, review 5 D1)', async () => {
    const s = await world({ a2: true })
    const { act } = await introduce(s, s.M1)
    const { a } = issued(s.M1, act)
    await s.round(3)
    const by = M.rel(s.A1.state, s.am.x).stock.find((k) => k.anchor === a.a.key)!.by
    const Ax = by === 'A1' ? s.A1 : s.A2!
    const Ay = by === 'A1' ? s.A2! : s.A1
    expect(sideState(Ay, act)).toBe('offered') // knows the acceptance from Ax's journal
    const selves = s.w.selfAddresses('A')
    s.w.carrier.faults.withhold(Ax.name, (f) => selves.has(f.address))
    s.w.carrier.faults.withhold(Ay.name, (f) => selves.has(f.address))
    await Ay.decline(act)
    await Ax.consent(act)
    await s.B1.consent(act)
    await s.round(3)
    expect([sideState(Ax, act), sideState(Ay, act), sideState(s.B1, act)]).toEqual(['connected', 'declined', 'connected'])
    let cs = await checks(s)
    expect(allOk(cs)).toEqual([])
    expect(prop(cs, 'P-Paar').counts.bothSides).toBe(1)
    s.w.carrier.faults.reset()
    await s.round(4)
    expect([sideState(Ax, act), sideState(Ay, act), sideState(s.B1, act)]).toEqual(['connected', 'connected', 'connected'])
    expect(s.w.of('A').some((d) => d.state.effects.some((e) => e.id === `conflict:decline:${act}`))).toBe(true)
    cs = await checks(s)
    expect(allOk(cs)).toEqual([])
    expect(prop(cs, 'P-Paar').counts).toEqual({ connectedActs: 1, bothSides: 1 })
    expect([pairCounter(s.buch).tuples['A→B'], pairCounter(s.buch).tuples['B→A']]).toEqual([1, 1])
  }, 300_000)

  it('K10. M commits X, crashes before the submission, the restart folds A\'s withdrawal: the resumption is omitted, 1 omission `rueckzug`, 0 violations (sheet K10, 1.4)', async () => {
    const s = await world()
    const { act } = await introduce(s, s.M1, 'before-send')
    const { a, tA, tB } = issued(s.M1, act)
    await s.A1.withdrawStock(s.am.x, [a.a.key])
    await s.round(1)
    await reload(s, s.M1)
    await s.round(3)
    expect([deposits(s, tA), deposits(s, tB)]).toEqual([0, 1])
    expect(s.M1.zusteller.report(tA.digest)).toBeNull() // held, due work
    expect([acceptances(s, act, a.a.key), acceptances(s, act, a.b.key)]).toEqual([0, 1])
    expect(knowledge(s.M1, act)).toEqual(['unknown', 'accepted'])
    expect([evidence(s.M1, a.a), evidence(s.M1, a.b)]).toEqual(['withdrawn', 'unlisted'])
    await drain(s, a)
    expect(s.M1.zusteller.report(tA.digest)).toEqual({ state: 'failed', reason: 'consent-reserve' }) // given-up at TB
    expect([sideState(s.A1, act), sideState(s.B1, act)]).toEqual(['none', 'expired'])
    const dead = deadTickets(s.buch, s.w)
    expect([dead.causes.zurueckgezogen, dead.deadAccepted]).toEqual([1, 1])
    const cs = await checks(s)
    expect(allOk(cs)).toEqual([])
    const pp = prop(cs, 'P-Produktion').counts
    expect([pp.obliged, pp.kept, pp['omitted:rueckzug']]).toEqual([1, 0, 1])
  }, 240_000)
})
