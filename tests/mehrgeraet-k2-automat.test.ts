// E15 K2 step 2b.2: the issuance automaton, the act-end stop and the restart from the last commit
// (rltp/design/port-experimente-e15-k2-schritt-2b-kern-entwurf-4-2026-10-21.md, Fassung 4, §1, §5, §6 "2b.2").
//
// Every expected value below comes from the acceptance sheet `src/candidates/mehrgeraet-k2/ABNAHME-2b2.md`, derived by
// hand before the automaton was built (draft 3 §7.2); the comment at each assertion names the sheet row. Nothing is taken
// from a run. Worlds: W2 (A1, B1, M1 + M2, share 5), W2+A2, W3 (three M devices, share 2), W4 (three M devices, share 3),
// W5 (8-day stock keys).

import { describe, expect, it } from 'vitest'
import { diSign, jcs, receive, seal } from '@real-life/trust-protocol'
import type { Json } from '@real-life/trust-protocol'
import { MemoryStore } from '../src/lab/zustellung'
import { k2 } from '../src/candidates/mehrgeraet-k2'
import { Buch, deadTickets, judge, ledgerWorld, oneSided, pairCounter, type Check } from '../src/lab/mehrgeraet/buch'
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
      const k = ownBatches(s.M1, writer)
      await reload(s, s.M1)
      expect(s.M1.cand.writer).toBe(writer) // 5.3: writer `M1@inc` unchanged
      expect(ownBatches(s.M1, writer)).toBe(k) // Soll (S5): `n` continues from the committed journal (next batch k + 1)
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
      // Soll (S5): receipt documents 1 / 1 (a duplicate resends the stored bytes), cards 0.
      expect([new Set(s.buch.carrier.receipts.filter((x) => x.ref === tA.digest).map((x) => x.frame)).size, new Set(s.buch.carrier.receipts.filter((x) => x.ref === tB.digest).map((x) => x.frame)).size]).toEqual([1, 1])
      expect(s.w.carrier.carried.filter((f) => kind(s, f) === 'introduction-card').length).toBe(0)
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
    expect(deadTickets(Buch.load(s.buch.dump()))).toEqual(dead) // Opus-Review 54 S6: the counter from the dump
    const cs = await checks(s)
    expect(allOk(cs)).toEqual([])
    expect([prop(cs, 'P-Produktion').counts.obliged, prop(cs, 'P-Produktion').counts.kept]).toEqual([1, 1])
    // Soll (S5): P-Bilanz max at A1 4 (4 → withdrawal 3 → supply 4, belegt 0), at B1 5.
    const max = (dev: string) => Math.max(...s.buch.balances.filter((r) => r.device === dev).map((r) => r.belegt + r.reserviert))
    expect([max('A1'), max('B1')]).toEqual([4, 5])
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
    carrier.deposit = (address: string, bytes: Uint8Array, from?: string) => {
      if (address === ka) throw new WireUnreachable('bench fault: deposit at xA unreachable')
      return deposit(address, bytes, from)
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

const BOUNDS = [-SEC, 0, SEC] as const
const at = (s: World, ms: number) => {
  s.w.clock.set(new Date(ms).toISOString())
  s.buch.note('advance', undefined, {})
}
/** W2, one issuance at tI, both tickets accepted (2 rounds). */
async function issuedWorld(o: { automaton?: boolean } = {}) {
  const s = await world(o)
  const { act } = await introduce(s, s.M1)
  const x = issued(s.M1, act)
  return { s, act, ...x, E: Date.parse(x.a.expiresAt) }
}
const cardsOf = (s: World, device: string) => s.w.carrier.carried.filter((f) => kind(s, f) === 'introduction-card' && s.w.frameOrigin(f.bytes)?.device === device).length

describe('K2 step 2b.2: the six act-end tests (5.2), each at boundary −1 s / 0 / +1 s', () => {
  for (const d of BOUNDS) {
    it(`T1 (${d / SEC} s). End before carrier acceptance (card, act-ended at AE): deposited iff now ≤ AE`, async () => {
      const { s, act, E } = await issuedWorld()
      await s.round(2)
      await s.B1.consent(act)
      await s.round(1)
      s.A1.online = false
      await s.A1.consent(act)
      expect(cardsOf(s, 'A1')).toBe(0)
      at(s, E + HOUR + d)
      s.A1.online = true
      await s.round(2)
      expect(cardsOf(s, 'A1')).toBe(d <= 0 ? 1 : 0)
      expect([sideState(s.A1, act), sideState(s.B1, act)]).toEqual(d <= 0 ? ['connected', 'connected'] : ['expired', 'expired'])
    }, 240_000)

    it(`T2 (${d / SEC} s). End after carrier acceptance without receipt: the repetition ends after AE, the report stays handed`, async () => {
      const { s, act, E } = await issuedWorld()
      await s.round(2)
      s.w.carrier.faults.withhold('B1', (f) => kind(s, f) === 'introduction-card' && s.w.frameOrigin(f.bytes)?.device === 'A1')
      await s.A1.consent(act)
      await s.B1.consent(act)
      await s.round(2)
      at(s, E + HOUR + d)
      await s.round(1)
      expect(cardsOf(s, 'A1')).toBe(d <= 0 ? 2 : 1)
      const cA = M.act(s.A1.state, act).ownCardDigest!
      expect(s.A1.zusteller.report(cA)?.state).toBe('accepted')
      expect(s.A1.zusteller.submissions.get(cA)?.stopped).toBe(d <= 0 ? undefined : 'act-ended')
    }, 240_000)

    it(`T3 (${d / SEC} s). End with a late receipt: the receipt counts also after the expire (delivered)`, async () => {
      const { s, act, E } = await issuedWorld()
      await s.round(2)
      s.w.carrier.faults.withhold('A1', (f) => kind(s, f) === 'delivery-ack' && s.w.frameOrigin(f.bytes)?.device === 'B1')
      await s.A1.consent(act)
      await s.B1.consent(act)
      await s.round(2)
      expect([sideState(s.A1, act), sideState(s.B1, act)]).toEqual(['connected', 'connected'])
      at(s, E + HOUR + d)
      await s.round(1)
      s.w.carrier.faults.reset()
      await s.round(1)
      const cA = M.act(s.A1.state, act).ownCardDigest!
      expect(s.A1.zusteller.report(cA)).toEqual({ state: 'delivered', late: false })
      expect(M.own(M.act(s.A1.state, act).cards, cA) ?? M.act(s.A1.state, act).o).toBe('delivered')
    }, 240_000)

    for (const automaton of [true, false]) {
      it(`T4${automaton ? '' : ' control'} (${d / SEC} s). Ticket between expiresAt and AE: ${automaton ? 'accepted iff now ≤ AE (8110.5), receipt → accepted' : 'old 8640.3 refuses after expiresAt'}`, async () => {
        const { s, act, a, tA, E } = await issuedWorld({ automaton })
        s.w.carrier.faults.withhold('A1', (f) => kind(s, f) === 'introduction-ticket')
        at(s, E + HOUR + d)
        s.w.carrier.faults.reset()
        await s.round(2)
        const ok = automaton && d <= 0
        expect(acceptances(s, act, a.a.key)).toBe(ok ? 1 : 0)
        // Soll for B (Opus-Review 54 S5): no round ran before the time step, so tB arrives at AE + d too: the same as A.
        expect(acceptances(s, act, a.b.key)).toBe(ok ? 1 : 0)
        expect(load(s.A1, s.am.x, s.w.clock.now())).toBe(ok ? 1 : 0)
        expect(sideState(s.A1, act)).toBe(ok ? 'expired' : 'none')
        if (automaton) {
          expect(knowledge(s.M1, act)[0]).toBe(ok ? 'accepted' : 'unknown')
          expect(deposits(s, tA)).toBe(1)
          const dead = deadTickets(s.buch, s.w)
          expect([dead.causes['spaetes-ticket'], dead.causes['spaet-zugestellt']]).toEqual(ok ? [1, 0] : [0, 1])
        }
      }, 240_000)
    }

    for (const automaton of [true, false]) {
      it(`T5${automaton ? '' : ' control'} (${d / SEC} s). Counter card after expiresAt, before AE, own card submitted: ${automaton ? 'connected iff now ≤ AE' : 'old A8 expired the act at expiresAt'}`, async () => {
        const { s, act, E } = await issuedWorld({ automaton })
        await s.round(2)
        s.w.carrier.faults.withhold('A1', (f) => kind(s, f) === 'introduction-card' && s.w.frameOrigin(f.bytes)?.device === 'B1')
        await s.A1.consent(act)
        await s.B1.consent(act)
        await s.round(2)
        expect(sideState(s.B1, act)).toBe('connected')
        at(s, E + SEC)
        await s.round(1)
        expect(sideState(s.A1, act)).toBe(automaton ? 'consented' : 'expired')
        at(s, E + HOUR + d)
        s.w.carrier.faults.reset()
        await s.round(1)
        const ok = automaton && d <= 0
        expect(sideState(s.A1, act)).toBe(ok ? 'connected' : 'expired')
        if (automaton) {
          const cs = await checks(s)
          expect(prop(cs, 'P-Paar').counts.bothSides).toBe(ok ? 1 : 0)
          expect(oneSided(s.buch)['late-card']).toBe(ok ? 0 : 1)
        }
      }, 240_000)
    }

    it(`T6a (${d / SEC} s). consent-reserve boundary before carrier acceptance: submitted iff now ≤ TB`, async () => {
      const s = await world()
      s.M1.online = false
      const { act } = await introduce(s, s.M1)
      const { a, tA, tB } = issued(s.M1, act)
      expect(s.M1.zusteller.report(tA.digest)?.state).toBe('awaiting-transport')
      at(s, Date.parse(a.expiresAt) - DAY + d)
      s.M1.online = true
      await s.round(2)
      expect([deposits(s, tA), deposits(s, tB)]).toEqual(d <= 0 ? [1, 1] : [0, 0])
      expect([acceptances(s, act, a.a.key), acceptances(s, act, a.b.key)]).toEqual(d <= 0 ? [1, 1] : [0, 0])
      if (d > 0) expect(s.M1.zusteller.report(tA.digest)).toEqual({ state: 'failed', reason: 'consent-reserve' })
      else {
        await s.A1.consent(act)
        expect(sideState(s.A1, act)).toBe('consented')
      }
    }, 240_000)

    it(`T6b (${d / SEC} s). consent-reserve boundary after carrier acceptance without receipt: repeated iff now ≤ TB`, async () => {
      const { s, tA, E } = await issuedWorld()
      s.w.carrier.faults.withhold('A1', (f) => kind(s, f) === 'introduction-ticket')
      await s.round(2)
      at(s, E - DAY + d)
      await s.round(1)
      expect(deposits(s, tA)).toBe(d <= 0 ? 2 : 1)
      expect(s.M1.zusteller.report(tA.digest)?.state).toBe('accepted')
    }, 240_000)

    it(`T6c (${d / SEC} s). Side consent at the boundary (8155): consent iff now ≤ TB, else the next tick expires the act`, async () => {
      const { s, act, E } = await issuedWorld()
      await s.round(2)
      at(s, E - DAY + d)
      await s.A1.consent(act)
      expect(sideState(s.A1, act)).toBe(d <= 0 ? 'consented' : 'offered')
      await s.round(1)
      if (d > 0) expect(sideState(s.A1, act)).toBe('expired')
    }, 240_000)
  }
})

const enc = new TextEncoder()
type Raw = { sendDoc(type: string, ctx: string, peer: string, peerKa: string, rkid: string, payload: Record<string, unknown>): Promise<{ digest: string } | null> }
const ownBatches = (d: HolderDevice, writer: string) => (d.cand.heads?.() ?? {})[writer] ?? 0
const conflicts = (d: HolderDevice) => d.state.findings.filter((f) => f.startsWith('Journal-Konflikt')).length

describe('K2 step 2b.2: restart from the last commit (5.3)', () => {
  it('N1. Restart after k batches: batch k + 1 under the unchanged writer `M1@inc`, folded by M2, no MV-3 conflict', async () => {
    const s = await world()
    const writer = s.M1.cand.writer
    s.M1.crashAt = 'after-commit'
    await s.round(1)
    expect(s.M1.isDown).toBe(true)
    const k = ownBatches(s.M1, writer)
    expect(k).toBeGreaterThanOrEqual(2)
    await reload(s, s.M1)
    expect(s.M1.cand.writer).toBe(writer)
    await introduce(s, s.M1) // one more own batch: the issuance batch
    expect(ownBatches(s.M1, writer)).toBe(k + 1) // Soll (5.3): batch k + 1 under the same writer
    await s.round(2)
    expect(ownBatches(s.M2!, writer)).toBe(ownBatches(s.M1, writer)) // M2 folded it
    expect([conflicts(s.M1), conflicts(s.M2!)]).toEqual([0, 0])
  }, 240_000)

  it('N2. Restart after the acceptance, before the receipt: one acceptance, consumption in the store, receipt after the rebuild, writer unchanged', async () => {
    const s = await world()
    const { act } = await introduce(s, s.M1)
    const { a } = issued(s.M1, act)
    const writer = s.A1.cand.writer
    s.A1.crashAt = 'after-commit'
    await s.round(1)
    expect(s.A1.isDown).toBe(true)
    expect(knowledge(s.M1, act)[0]).toBe('unknown')
    await reload(s, s.A1)
    await s.round(3)
    expect(s.A1.cand.writer).toBe(writer)
    expect(acceptances(s, act, a.a.key)).toBe(1)
    expect(M.rel(s.A1.state, s.am.x).stock.find((k) => k.anchor === a.a.key)?.state).toBe('consumed')
    expect(knowledge(s.M1, act)[0]).toBe('accepted')
    expect(conflicts(s.A1)).toBe(0)
  }, 240_000)

  for (const keepInc of [false, true]) {
    it(`N${keepInc ? '4 (mutation)' : '3'}. Restore from an image${keepInc ? ' keeping `inc`: the reused batch key collides at M2 (MV-3), so the counter-probe fails' : ': a fresh journal incarnation, no reuse of `writer@inc#n`, no MV-3 conflict'}`, async () => {
      const s = await world()
      const writer = s.M1.cand.writer
      const store = s.w.stores.get('M1')!
      const image = store.snapshot()
      const k = ownBatches(s.M1, writer)
      await introduce(s, s.M1) // batch k + 1 after the image
      await s.round(2)
      expect(ownBatches(s.M2!, writer)).toBeGreaterThan(k)
      store.restore(image)
      if (keepInc) (store as unknown as { restored: boolean }).restored = false // test-only mutation: the image path loses its marker
      await reload(s, s.M1)
      expect(s.M1.cand.writer === writer).toBe(keepInc)
      await introduce(s, s.M1)
      await s.round(2)
      // Soll: N3 0; N4 ≥ 1 (the first new batch k + 1 reuses `M1@inc#(k+1)` with other content; whether later numbers collide
      // too depends on whether their bytes happen to be equal, Opus-Review 54 S5, so only ≥ 1 is derived).
      if (keepInc) expect(conflicts(s.M2!)).toBeGreaterThanOrEqual(1)
      else expect(conflicts(s.M2!)).toBe(0)
      if (!keepInc) expect(ownBatches(s.M2!, s.M1.cand.writer)).toBeGreaterThanOrEqual(1)
    }, 240_000)
  }

  it('N5. Path marker: a stolen copy (`welt.steal`, an image) gets a new incarnation; the crash restart of the victim keeps its own', async () => {
    const s = await world()
    const writer = s.A1.cand.writer
    const thief = await s.w.steal(s.A1, 'T1')
    expect(thief.cand.writer).not.toBe(writer)
    s.A1.crashAt = 'after-commit'
    await s.round(1)
    await reload(s, s.A1)
    expect(s.A1.cand.writer).toBe(writer)
    expect(new MemoryStore().takeRestored()).toBe(false)
  }, 240_000)
})

describe('K2 step 2b.2: resumption as due work (5.1)', () => {
  it('R1. `unlisted` → resubmitted: the named keys aged (8475) and are no longer listed, A accepts on `aging` (8640.6); W5', async () => {
    const s = await world({ stockLifetimeMs: 8 * DAY })
    const t0 = Date.parse(s.w.clock.now())
    const { act } = await introduce(s, s.M1, 'before-send')
    const { a, tA, tB } = issued(s.M1, act)
    at(s, t0 + 23 * HOUR + SEC)
    await s.round(1)
    expect(M.rel(s.A1.state, s.am.x).stock.find((k) => k.anchor === a.a.key)?.state).toBe('aging')
    await reload(s, s.M1)
    await s.round(1)
    expect([evidence(s.M1, a.a), evidence(s.M1, a.b)]).toEqual(['unlisted', 'unlisted'])
    expect([deposits(s, tA), deposits(s, tB)]).toEqual([1, 1])
    await s.round(2)
    expect([acceptances(s, act, a.a.key), acceptances(s, act, a.b.key)]).toEqual([1, 1])
    const cs = await checks(s)
    expect(allOk(cs)).toEqual([])
    expect(prop(cs, 'P-Bilanz').counts.max).toBe(5)
  }, 240_000)

  it('R4. `burn` (fixture, measured until 2c): a crafted revision burns the incarnation of xA while tA is held after a crash', async () => {
    const s = await world()
    const { act } = await introduce(s, s.M1, 'before-send')
    const { a, tA } = issued(s.M1, act)
    const r = M.rel(s.A1.state, s.am.x)
    const h = M.head(r)
    const k = await s.A1.cand.keys.pair(h.ownKey)
    const inc = r.stock.find((x) => x.anchor === a.a.key)!.inc!
    const payload = { writer: M.signerId(k.anchor), inc: 'fixtureincfixtur', rev: 1, keys: [], withdraw: [], bury: [], burn: [inc] }
    await (s.A1 as unknown as Raw).sendDoc(TYPES.stockRevision, h.ownKey, h.peer, h.peerKeyAgreement, k.rkid, payload)
    await s.round(1)
    await reload(s, s.M1)
    await s.round(3)
    // Measured, no Soll (core draft 4 §5.1: `burned` only as a form consequence in the core; decision 10: burned = withdrawn).
    const measured = { evidence: evidence(s.M1, a.a), deposits: deposits(s, tA), acceptances: acceptances(s, act, a.a.key) }
    expect(['unknown', 'listed', 'unlisted', 'withdrawn']).toContain(measured.evidence)
    ;(globalThis as { r4?: unknown }).r4 = measured
    if (process.env.MEASURE_OUT) (await import('node:fs')).writeFileSync(process.env.MEASURE_OUT, JSON.stringify(measured))
  }, 240_000)
})

describe('K2 step 2b.2: B13 (i) and (ii)', () => {
  it('B13 (i). A receipt signed by another A device: `ack-from-unexpected-signer`, knowledge unchanged; the allocator\'s receipt then makes it accepted', async () => {
    const s = await world({ a2: true })
    const { act } = await introduce(s, s.M1)
    const { a, tA } = issued(s.M1, act)
    const by = M.rel(s.A1.state, s.am.x).stock.find((k) => k.anchor === a.a.key)!.by
    const Ax = by === 'A1' ? s.A1 : s.A2!
    const Ay = by === 'A1' ? s.A2! : s.A1
    s.w.carrier.faults.withhold('M1', (f) => kind(s, f) === 'delivery-ack' && s.w.frameOrigin(f.bytes)?.device === Ax.name)
    await s.round(2)
    expect(acceptances(s, act, a.a.key)).toBe(1)
    const own = M.rel(Ay.state, s.am.x).stock.find((k) => k.by === Ay.name)!
    const ky = await Ay.cand.keys.pair(own.key)
    const now = s.w.clock.now()
    const doc = await diSign({ anchor: ky.anchor, ed: { priv: ky.ed.priv } }, { id: crypto.randomUUID(), type: TYPES.ack, issuer: ky.anchor, recipient: tA.expected, replyTo: '', issuedAt: now, payload: { ref: tA.digest, meaning: 'received' } }, now)
    s.w.carrier.deposit(tA.replyTo, enc.encode(jcs(await seal(doc as unknown as Json, tA.replyTo))))
    await s.round(1)
    expect(s.M1.dispositions.filter((x) => x === 'failed(ack-from-unexpected-signer)').length).toBe(1)
    expect(knowledge(s.M1, act)[0]).toBe('unknown')
    s.w.carrier.faults.reset()
    await s.round(1)
    expect(knowledge(s.M1, act)[0]).toBe('accepted')
  }, 300_000)

  for (const variant of ['misrouted', 're-sealed'] as const) {
    it(`B13 (ii-${variant === 'misrouted' ? 'b' : 'a'}). The receipt reaches another M device (${variant}): ${variant === 'misrouted' ? '`failed(malformed)`' : '`ack-unbound`'} at M2, no \`accepted\` from it, no hang; W4`, async () => {
      const s = await world({ m3: true, devices: 3 })
      const { act } = await introduce(s, s.M1)
      const { a, tA } = issued(s.M1, act)
      s.w.carrier.faults.withhold('M1', (f) => kind(s, f) === 'delivery-ack' && s.w.frameOrigin(f.bytes)?.device === 'A1')
      await s.round(2)
      expect(acceptances(s, act, a.a.key)).toBe(1)
      const ack = s.w.carrier.carried.find((f) => kind(s, f) === 'delivery-ack' && s.w.frameOrigin(f.bytes)?.device === 'A1' && f.address === tA.replyTo)!
      const ctx = M.rel(s.M1.state, s.am.y).tuples[0]!.ownKey
      const m2Address = (await s.M2!.cand.keys.pair(ctx)).rkid
      let bytes = ack.bytes
      if (variant === 're-sealed') {
        const keys = new Map(s.M1.receiverKeys())
        const v = await receive(JSON.parse(new TextDecoder().decode(ack.bytes)), (rkid) => keys.get(rkid))
        bytes = enc.encode(jcs(await seal(v.document as unknown as Json, m2Address)))
      }
      const before = s.M2!.dispositions.length
      s.w.carrier.deposit(m2Address, bytes)
      await s.round(1)
      const got = s.M2!.dispositions.slice(before)
      if (variant === 'misrouted') expect(got.some((x) => x.startsWith('failed(malformed)'))).toBe(true)
      else {
        expect(got.filter((x) => x === 'failed(ack-unbound)').length).toBe(1)
        expect(s.M2!.measures.unboundAcks).toBeGreaterThanOrEqual(1)
      }
      expect(knowledge(s.M2!, act)[0]).toBe('unknown') // not from that receipt
      s.w.carrier.faults.reset()
      await s.round(2)
      expect(knowledge(s.M1, act)[0]).toBe('accepted') // from its own receipt
      expect(knowledge(s.M2!, act)[0]).toBe('accepted') // from M1's journal
      await drain(s, issued(s.M1, act).a)
      expect(sideState(s.A1, act)).toBe('expired')
    }, 300_000)
  }
})

describe('K2 step 2b.2: budget-cause fixture (core draft 4 §1)', () => {
  it('F1. `share` artificially lowered to 0 at A1: the key is consumed, no act, no receipt, `belegt` unchanged; dead `budget` (fixture)', async () => {
    const s = await world()
    Object.defineProperty(s.A1.cand, 'acceptanceShare', { get: () => 0 })
    const allocBefore = s.buch.commits.filter((c) => c.device === 'A1' && c.ops.some((op) => op.kind === 'allocate')).length
    const { act } = await introduce(s, s.M1)
    const { a } = issued(s.M1, act)
    await s.round(3)
    expect(M.rel(s.A1.state, s.am.x).stock.find((k) => k.anchor === a.a.key)?.state).toBe('consumed')
    expect(sideState(s.A1, act)).toBe('none')
    expect(acceptances(s, act, a.a.key)).toBe(0)
    expect(load(s.A1, s.am.x, s.w.clock.now())).toBe(0)
    expect(knowledge(s.M1, act)).toEqual(['unknown', 'accepted'])
    expect(s.buch.commits.filter((c) => c.device === 'A1' && c.ops.some((op) => op.kind === 'allocate')).length).toBe(allocBefore)
    expect(acceptances(s, act, a.b.key)).toBe(1)
    await drain(s, a)
    const dead = deadTickets(s.buch, s.w)
    expect([dead.causes.budget, dead.deadAccepted]).toEqual([1, 1])
    const cs = await judge(s.buch, { share: 5 })
    expect(prop(cs, 'P-Bilanz').ok).toBe(true)
  }, 240_000)
})

// ── Opus-Review 54 (rltp/design/port-experimente-e15-opus-review54-2026-10-22.md): the reviewer's counter-runs as fixed tests ──

type Inner = { guarded(f: () => Promise<void>): Promise<boolean>; emit(body: Record<string, unknown>): unknown; commit(): void; ticketGateOf(d: string): string | null; applyRemote(tx: { ops: M.Op[]; intents: Array<{ device: string }> }): Promise<void> }
const inner = (d: HolderDevice) => d as unknown as Inner

describe('Opus-Review 54: the checkers see resumption errors in both directions (B1)', () => {
  it('R54-B1a. A sibling writes `ticket-ack` for both sides (PROBE1): not folded (foreign writer), the missing production is a P-Produktion violation', async () => {
    const s = await world()
    const carrier = s.w.carrier
    const deposit = carrier.deposit.bind(carrier)
    const blocked = new Set<string>()
    carrier.deposit = (address: string, bytes: Uint8Array, from?: string) => {
      if (blocked.has(address)) throw new WireUnreachable('probe fault')
      return deposit(address, bytes, from)
    }
    const view = (rel: string) => M.usableView(s.M1.state, rel, s.w.clock.now()).unconsumed.map((k) => k.keyAgreement)
    for (const a of [...view(s.am.y), ...view(s.bm.y)]) blocked.add(a)
    const { act } = await introduce(s, s.M1)
    const { a, tA, tB } = issued(s.M1, act)
    await s.round(1)
    const m2 = inner(s.M2!)
    await m2.guarded(async () => {
      m2.emit({ kind: 'ticket-ack', act, side: 'a', receiptDigest: tA.digest })
      m2.emit({ kind: 'ticket-ack', act, side: 'b', receiptDigest: tB.digest })
    })
    m2.commit()
    await s.round(2)
    // Soll: M1 folds neither (writer M2 is not the issuer M1): knowledge stays unknown, a finding names the foreign writer.
    expect(knowledge(s.M1, act)).toEqual(['unknown', 'unknown'])
    expect(s.M1.state.findings.filter((f) => f.startsWith('ticket-ack:foreign-writer')).length).toBe(2)
    // Soll: the bench fault keeps both tickets `awaiting-transport` for 3 rounds in which submission is admissible → violation.
    await drain(s, a)
    const cs = await checks(s)
    expect(prop(cs, 'P-Produktion').violations).toHaveLength(1)
    expect(prop(cs, 'P-Produktion').counts['omitted:accepted']).toBe(0)
    carrier.deposit = deposit
  }, 300_000)

  it('R54-B1b. K10 with a release that ignores `withdrawn` (PROBE6, mutation): the submission despite `withdrawn` is a P-Aufhebung violation; control holds', async () => {
    for (const mutated of [false, true]) {
      const s = await world()
      const { act } = await introduce(s, s.M1, 'before-send')
      const { a, tA } = issued(s.M1, act)
      await s.A1.withdrawStock(s.am.x, [a.a.key])
      await s.round(1)
      await reload(s, s.M1)
      if (mutated) {
        const m = inner(s.M1)
        const orig = m.ticketGateOf.bind(m)
        m.ticketGateOf = (d: string) => {
          const g = orig(d)
          return g === 'withdrawn' ? null : g
        }
      }
      await s.round(3)
      expect(evidence(s.M1, a.a)).toBe('withdrawn')
      expect(deposits(s, tA) > 0).toBe(mutated)
      await drain(s, a)
      const cs = await checks(s)
      // Soll: control 0 violations (K10); mutated: P-Aufhebung 1 violation (one deposit of tA while M1's committed state holds xA withdrawn) and P-Produktion no `kept`.
      expect(prop(cs, 'P-Aufhebung').violations).toHaveLength(mutated ? 1 : 0)
      expect(prop(cs, 'P-Produktion').counts['omitted:rueckzug']).toBe(mutated ? 0 : 1)
    }
  }, 400_000)
})

describe('Opus-Review 54: the derived rows of the sheet that were not built (B2)', () => {
  it('K1m. Mutation: M2 resumes M1\'s intents → P-Eigen fails with exactly 2 deposits by M2 (K1b, M2\'s round 1); acceptances unchanged (8640.4)', async () => {
    for (const mutated of [false, true]) {
      const s = await world()
      if (mutated) {
        const m2 = inner(s.M2!)
        const orig = m2.applyRemote.bind(m2)
        m2.applyRemote = (tx) => orig({ ...tx, intents: tx.intents.map((i) => ({ ...i, device: 'M2' })) })
      }
      const { act } = await introduce(s, s.M1, 'before-send')
      const { a } = issued(s.M1, act)
      await reload(s, s.M1)
      await s.round(2)
      const cs = await checks(s)
      expect(prop(cs, 'P-Eigen').violations).toHaveLength(mutated ? 2 : 0)
      expect([acceptances(s, act, a.a.key), acceptances(s, act, a.b.key)]).toEqual([1, 1])
    }
  }, 400_000)

  it('K9m. Mutation: Ay folds Ax\'s consent and hand-over and still projects `declined` → exactly 1 P-Paar violation (`DeclinedRow`)', async () => {
    const s = await world({ a2: true })
    const { act } = await introduce(s, s.M1)
    const { a } = issued(s.M1, act)
    await s.round(3)
    const by = M.rel(s.A1.state, s.am.x).stock.find((k) => k.anchor === a.a.key)!.by
    const Ay = by === 'A1' ? s.A2! : s.A1
    const Ax = by === 'A1' ? s.A1 : s.A2!
    await Ax.consent(act)
    await s.B1.consent(act)
    await s.round(4)
    expect(sideState(Ay, act)).toBe('connected')
    let cs = await checks(s)
    expect(prop(cs, 'P-Paar').violations).toEqual([])
    M.act(Ay.state, act).state = 'declined' // test-only: the projection is wrong although the image holds the submitted card
    inner(Ay).commit()
    cs = await checks(s)
    expect(prop(cs, 'P-Paar').violations).toHaveLength(1)
  }, 300_000)

  for (const automaton of [true, false]) {
    it(`D8${automaton ? '' : ' control'}. Decision 8 (8850.5 sharpened): B's card to A's withdrawn key ${automaton ? 'is refused without ack, B repeats' : 'is buffered and acknowledged (old path)'} (PROBE4)`, async () => {
      const s = await world({ automaton })
      s.w.carrier.faults.withhold('A1', (f) => kind(s, f) === 'introduction-ticket')
      const { act } = await introduce(s, s.M1)
      await s.round(1)
      const { a } = issued(s.M1, act)
      await s.A1.withdrawStock(s.am.x, [a.a.key])
      s.w.carrier.faults.reset()
      await s.round(2)
      await s.B1.consent(act)
      await s.round(4)
      const bCard = M.act(s.B1.state, act).ownCardDigest!
      const log = s.A1.cardLog.filter((x) => x.act === act).map((x) => x.outcome)
      // Soll: B1's card deposited in the consent action and repeated in B1's round 3 (no receipt) → 2 arrivals at A1, both refused; old path: 1, buffered, receipt.
      if (automaton) {
        expect(log).toEqual(['8850.5-not-held', '8850.5-not-held'])
        expect(s.B1.zusteller.report(bCard)?.state).toBe('accepted')
      } else {
        expect(log).toEqual(['buffered'])
        expect(s.B1.zusteller.report(bCard)?.state).toBe('delivered')
      }
    }, 240_000)
  }
})

describe('Opus-Review 54: serialization per device (B3, draft 2 §2.2 no. 1, E1 of review 1)', () => {
  it('R54-B3a. Two concurrent `introduce` on M1 (PROBE5): two issuances on two distinct key pairs, no error, no double consumption', async () => {
    const s = await world()
    const [r1, r2] = await Promise.all([s.M1.introduce(s.am.y, s.bm.y), s.M1.introduce(s.am.y, s.bm.y)])
    expect(['act' in r1, 'act' in r2]).toEqual([true, true])
    const acts = s.M1.state.mediatorActs
    expect(acts).toHaveLength(2)
    expect(new Set(acts.map((x) => x.a.key)).size).toBe(2)
    expect(new Set(acts.map((x) => x.b.key)).size).toBe(2)
    await s.round(3)
    const cs = await checks(s)
    expect(prop(cs, 'P-Einmal').ok).toBe(true)
    expect(prop(cs, 'P-Einmal').counts.accepts).toBe(4)
  }, 240_000)

  it('R54-B3b. A third concurrent `introduce` finds no key pair left (2 + 2 keys for m1): refused, not a double issuance', async () => {
    const s = await world()
    const rs = await Promise.all([s.M1.introduce(s.am.y, s.bm.y), s.M1.introduce(s.am.y, s.bm.y), s.M1.introduce(s.am.y, s.bm.y)])
    expect(rs.filter((r) => 'act' in r)).toHaveLength(2)
    expect(s.M1.state.mediatorActs).toHaveLength(2)
  }, 240_000)

  it('R54-B3c. Receipt while issuing: a round of M1 runs concurrently with an `introduce`; both complete, the state is the serial one', async () => {
    const s = await world()
    const first = await introduce(s, s.M1)
    await s.round(1)
    const [, r] = await Promise.all([s.M1.round(), s.M1.introduce(s.am.y, s.bm.y)])
    expect('act' in r).toBe(true)
    await s.round(3)
    expect(knowledge(s.M1, first.act)).toEqual(['accepted', 'accepted'])
    const cs = await checks(s)
    expect(prop(cs, 'P-Einmal').ok).toBe(true)
  }, 240_000)
})

describe('Opus-Review 54: smaller findings', () => {
  it('S7. Decision 4a: a ticket on a key the issuer\'s sibling buried, still active at the accepting device, is accepted (the content X16 lost)', async () => {
    const s = await world({ a2: true })
    const { act } = await introduce(s, s.M1, 'before-send')
    const { a, tA } = issued(s.M1, act)
    const by = M.rel(s.A1.state, s.am.x).stock.find((k) => k.anchor === a.a.key)!.by
    const Ax = by === 'A1' ? s.A1 : s.A2!
    const Ay = by === 'A1' ? s.A2! : s.A1
    const selves = s.w.selfAddresses('A')
    s.w.carrier.faults.withhold(Ax.name, (f) => selves.has(f.address))
    for (const m of ['M1', 'M2']) s.w.carrier.faults.withhold(m, (f) => s.w.frameOrigin(f.bytes)?.device === Ay.name || s.w.frameOrigin(f.bytes)?.device === 'M2')
    await Ay.setClass(s.am.x, false) // buries xA (B6), Ax never folds it, M not yet
    await reload(s, s.M1)
    await s.round(2)
    expect(deposits(s, tA)).toBe(1)
    expect(acceptances(s, act, a.a.key)).toBe(1) // 4a: the ticket counts
    s.w.carrier.faults.reset()
    await s.round(3)
    expect(evidence(s.M1, a.a)).toBe('withdrawn') // the burial arrives after the submission
  }, 300_000)

  it('S9 (8110.7). A ticket arriving after TB is accepted and its act expired in the same round: documents before the time transition', async () => {
    const { s, act, a, E } = await issuedWorld()
    s.w.carrier.faults.withhold('A1', (f) => kind(s, f) === 'introduction-ticket')
    at(s, E - DAY + SEC)
    s.w.carrier.faults.reset()
    await s.w.rounds(1) // exactly one round: the ticket is handled, then the tick (A7) fires
    expect(acceptances(s, act, a.a.key)).toBe(1)
    expect(sideState(s.A1, act)).toBe('expired')
  }, 240_000)
})
