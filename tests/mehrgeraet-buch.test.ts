import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// E15 K2 step 2b.0 (design 2b draft 2 §5.1–§5.4, §6 "2b.0"; draft 3 §7.1, §7.2, §8 "2b.0", §12 D1): the outcome ledger
// ("Außenwirkungsbuch"), its checkers (P-Einmal, P-Commit, P-Produktion, P-Paar per act, tuple counter) and the minimal
// generator over the step-2a paths with M as single-writer fixture.
//   L1. The ledger survives a holder restore: nothing in it changes when a device is rebuilt from an old image.
//   G0. Replay: a seed and a sequence give the same run.
//   G1. Generator, fixed seeds: every property holds on the step-2a code (failure: seed + shrunk sequence printed).
//   U1–U4. Mutations (test-only hooks on the devices, never flags in the code): each checker is shown failing.
//   S1. Shrinking: a failing generated sequence shrinks to the smallest sequence that still fails the same property.
//   D1. Astra's D1 sequence (design review 1): Soll 1 accepted act id on x; red on 2a (expected-fail, closes in 2b.3).
//
// Every expected number below is derived by hand from the scenario (comment at each), written before the run; none is
// taken from a run (draft 3 §7.2). Randomness is seeded (as in `mehrgeraet-seeds.test.ts`) so a seed replays exactly; that
// is what makes shrinking meaningful.

const rng = vi.hoisted(() => ({
  n: 1,
  bytes(size: number): Buffer {
    const b = Buffer.alloc(size)
    for (let i = 0; i < size; i++) {
      this.n = (Math.imul(this.n, 1664525) + 1013904223) >>> 0
      b[i] = this.n >>> 24
    }
    return b
  },
  uuid(): string {
    const b = this.bytes(16)
    b[6] = (b[6]! & 15) | 64
    b[8] = (b[8]! & 63) | 128
    const h = b.toString('hex')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  },
}))
vi.mock('node:crypto', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:crypto')>()), randomBytes: (n: number) => rng.bytes(n), randomUUID: () => rng.uuid() }))

import { TYPES, type HolderDevice } from '../src/lab/mehrgeraet/holder'
import { ledgerWorld, pCommit, pEinmal, pPaar, pProduktion, type Buch } from '../src/lab/mehrgeraet/buch'
import { generate, report, runSequence, show, shrink, type GenEvent, type Mutation } from '../src/lab/mehrgeraet/generator'
import { k2 } from '../src/candidates/mehrgeraet-k2'
import * as M from '../src/lab/mehrgeraet/model'

const reseed = (seed: number) => void (rng.n = seed)
const spies: Array<{ mockRestore(): void }> = []
beforeAll(() => {
  spies.push(vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => rng.uuid() as `${string}-${string}-${string}-${string}-${string}`))
  spies.push(
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(a: T): T => {
      if (a) new Uint8Array(a.buffer, a.byteOffset, a.byteLength).set(rng.bytes(a.byteLength))
      return a
    }),
  )
})
afterAll(() => {
  for (const s of spies) s.mockRestore()
})

const cand = () => k2()
const prop = (r: { checks: Array<{ property: string; ok: boolean; violations: string[]; counts: Record<string, number> }> }, p: string) => r.checks.find((c) => c.property === p)!

// ── Test-only mutations (hooks on the instances of one world; the code under test has no switch for them) ──
type Priv = { sendDoc: (type: string, ...rest: unknown[]) => Promise<{ digest: string } | null>; handle: (bytes: Uint8Array, address: string) => Promise<void>; connect: (a: M.Act, card: M.Card) => Promise<void> }
const priv = (d: HolderDevice) => d as unknown as Priv
/** M produces no ticket at all (the issuance commits its consumption without ticket intents). */
const suppressTickets: Mutation = (g) => {
  const d = priv(g.Mm)
  const orig = d.sendDoc.bind(g.Mm)
  d.sendDoc = async (type, ...rest) => (type === TYPES.ticket ? null : orig(type, ...rest))
}
/** M hands each ticket to the carrier the moment it is built, before the store commit of the issuance. */
const ticketBeforeCommit: Mutation = (g) => {
  const d = priv(g.Mm)
  const orig = d.sendDoc.bind(g.Mm)
  d.sendDoc = async (type, ...rest) => {
    const r = await orig(type, ...rest)
    if (type === TYPES.ticket && r) g.Mm.zusteller.deposit(r.digest)
    return r
  }
}
/** A side without rule 8640.12: a consumed stock key looks active to the ticket check (restored after the frame). */
function without8640_12(d: HolderDevice): void {
  const p = priv(d)
  const orig = p.handle.bind(d)
  p.handle = async (bytes, address) => {
    const flipped = d.state.relationships.flatMap((r) => r.stock.filter((k) => k.state === 'consumed'))
    for (const k of flipped) k.state = 'active'
    try {
      await orig(bytes, address)
    } finally {
      for (const k of flipped) if (k.state === 'active') k.state = 'consumed'
    }
  }
}
/** A side connects under a key agreement other than the counterpart's card (its own card's): a different pair context. */
const wrongPairAtA: Mutation = (g) => {
  for (const d of g.w.of('A')) {
    const p = priv(d)
    const orig = p.connect.bind(d)
    p.connect = (a, card) => orig(a, { ...card, keyAgreement: a.ownCard?.keyAgreement ?? card.keyAgreement })
  }
}

describe('K2 step 2b.0: outcome ledger', () => {
  it('L1. The ledger survives a holder restore: A1 rebuilt from an image before α changes nothing in it; α, accepted by the lost incarnation, stays the one accepted act on its key', async () => {
    reseed(11)
    const { w, buch } = ledgerWorld(k2())
    const A = await w.person('A', 'A1')
    const B = await w.person('B', 'B1')
    const Mm = await w.person('M', 'M1')
    const am = await w.encounter(A, Mm)
    const bm = await w.encounter(B, Mm)
    await w.rounds(2)
    await A.setClass(am.x.id, true)
    await B.setClass(bm.x.id, true)
    await w.rounds(3)
    const image = w.stores.get('A1')!.snapshot()
    const r = await Mm.introduce(am.y.id, bm.y.id)
    expect('act' in r).toBe(true)
    const alpha = (r as { act: string }).act
    await w.until(() => A.state.acts.some((a) => a.id === alpha) && B.state.acts.some((a) => a.id === alpha), 10)
    const x = Mm.state.mediatorActs.find((a) => a.id === alpha)!.a.key
    const before = buch.dump()
    const commitsBefore = buch.commits.length
    w.stores.get('A1')!.restore(image)
    await A.reload()
    // Soll: the restore and the rebuild add nothing and remove nothing (a rebuild commits nothing by itself).
    expect(buch.dump()).toBe(before)
    expect(A.state.acts.some((a) => a.id === alpha), 'Voraussetzung: das Abbild kennt α nicht').toBe(false)
    await w.rounds(3)
    // Soll: everything recorded before the restore is still there, unchanged (the ledger only grows).
    expect(M.canonical(buch.commits.slice(0, commitsBefore))).toBe(M.canonical(JSON.parse(before).commits))
    // Soll 1 on x: α was accepted at A1's commit before the restore (A1 allocated every A key: A has one device); the image
    // predates α, but the ledger keeps the lost incarnation's acceptance. B's key: 1 (α). Nothing else was introduced.
    expect([...(buch.acceptedOn().get(x) ?? [])]).toEqual([alpha])
    expect(pEinmal(buch).ok).toBe(true)
  }, 60_000)
})

describe('K2 step 2b.0: generator over the 2a paths (M single-writer fixture)', () => {
  // Fixed seeds (standing bench rule: 20 per configuration; 2b.0 has one configuration, 40 events each; `GEN_SEEDS=<n>` for more). Soll: no violation of any
  // property on the step-2a code: issuance is one batch committed before the tickets leave (MV-30), M is one device, no
  // restore, so no key carries two acts, every ticket follows its commit, every committed issuance reaches the carrier.
  const SEEDS = Array.from({ length: Number(process.env.GEN_SEEDS ?? 20) }, (_, i) => i + 1)
  it('G0. Replay: the same seed and sequence give the same ledger (acts, keys, commits, carrier book), so a shrunk sequence is the failing run', async () => {
    const events = generate(3, 40)
    const view = (b: Buch) => M.canonical({ commits: b.commits.map((c) => ({ device: c.device, writer: c.writer, n: c.n, ops: c.ops.map((o) => o.kind) })), accepted: [...b.acceptedOn()].map(([k, a]) => [k, [...a]]), tickets: b.carrier.tickets.map((t) => [t.act, t.named]) })
    const one = await runSequence(cand, events, { seed: 3, reseed })
    const two = await runSequence(cand, events, { seed: 3, reseed })
    expect(view(two.buch)).toBe(view(one.buch))
  }, 60_000)
  for (const seed of SEEDS) {
    it(`G1. seed ${String(seed).padStart(2, '0')}: P-Einmal, P-Commit, P-Produktion, P-Paar hold`, async () => {
      const events = generate(seed, 40)
      const r = await runSequence(cand, events, { seed, reseed })
      const failed = r.checks.filter((c) => !c.ok)
      const reports: string[] = []
      for (const c of failed) {
        const s = await shrink(cand, events, c.property, { seed, reseed, maxRuns: 60 })
        const min = await runSequence(cand, s.events, { seed, reseed })
        reports.push(report(seed, c.property, s.events, prop(min, c.property).violations))
      }
      expect(reports, reports.join('\n')).toEqual([])
      // The run exercised the paths it claims (otherwise a green result says nothing).
      expect(prop(r, 'P-Produktion').counts.introductions, events.map(show).join(', ')).toBeGreaterThan(0)
    }, 120_000)
  }
})

describe('K2 step 2b.0: mutations show each checker failing', () => {
  // One plain introduction, then the drain (k + 3 plain rounds, all devices up).
  const one: GenEvent[] = [{ k: 'introduce' }]

  it('U0. Control: the same sequence without a mutation keeps every property (1 issuance, 2 tickets, 1 obligation kept)', async () => {
    const r = await runSequence(cand, one, { seed: 21, reseed })
    for (const c of r.checks) expect(c.violations, c.property).toEqual([])
    // Soll: one issuance (M has 5 keys of each side, 8485 refill-to), its two tickets at the carrier, one obligation kept.
    expect(prop(r, 'P-Commit').counts).toEqual({ tickets: 2, issuances: 1 })
    expect(prop(r, 'P-Produktion').counts).toMatchObject({ introductions: 1, obliged: 1, kept: 1 })
  }, 60_000)

  it('U1. Suppressed tickets → P-Commit and P-Produktion fail', async () => {
    const r = await runSequence(cand, one, { seed: 21, reseed, mutation: suppressTickets })
    // Soll P-Commit: the issuance batch holds the consumption and 0 ticket intents → 1 violation (existence); no ticket at
    // the carrier → no "ticket without commit" violation. Soll P-Produktion: 1 obligation (reference: 5 + 5 admissible keys),
    // 0 of 2 tickets within k rounds → 1 violation. P-Einmal, P-Paar unaffected.
    expect(prop(r, 'P-Commit').violations).toHaveLength(1)
    expect(prop(r, 'P-Commit').counts).toEqual({ tickets: 0, issuances: 1 })
    expect(prop(r, 'P-Produktion').violations).toHaveLength(1)
    expect(prop(r, 'P-Produktion').counts).toMatchObject({ obliged: 1, kept: 0 })
    expect(prop(r, 'P-Einmal').ok && prop(r, 'P-Paar').ok).toBe(true)
  }, 60_000)

  it('U2. Ticket handed to the carrier before the commit → P-Commit fails (P-Produktion holds)', async () => {
    const r = await runSequence(cand, one, { seed: 21, reseed, mutation: ticketBeforeCommit })
    // Soll: both tickets reach the carrier inside the action, before `flush` commits the batch → 2 violations; after the
    // commit the release hands the same bytes again (2 more deposits, each with an earlier commit → no violation). The batch
    // itself is complete (2 intents). P-Produktion: 2 of 2 tickets in time → kept.
    expect(prop(r, 'P-Commit').violations).toHaveLength(2)
    expect(prop(r, 'P-Commit').counts.issuances).toBe(1)
    expect(prop(r, 'P-Produktion').ok).toBe(true)
  }, 60_000)

  it('U3. Without 8640.12 at A → P-Einmal fails: M restored from an image before α names x again for β (A–C, a fresh C key); the control run refuses β', async () => {
    // Soll with 8640.12 (control): accepted act ids on x = 1 (α; A refuses β by 8640.12, the voucher check 8640.9 does not
    // catch it because β's voucher is C's fresh key). Soll without 8640.12: 2 (α and β) → P-Einmal 1 violation.
    const control = await restoredMediator(31, false)
    expect(control.preconditions, 'Voraussetzungen').toEqual({ sameKey: true, cAccepted: true })
    expect(control.onX).toBe(1)
    expect(pEinmal(control.buch).ok).toBe(true)
    const mutated = await restoredMediator(31, true)
    expect(mutated.preconditions, 'Voraussetzungen').toEqual({ sameKey: true, cAccepted: true })
    expect(mutated.onX).toBe(2)
    expect(pEinmal(mutated.buch).violations).toHaveLength(1)
  }, 120_000)

  it('U4. A connects under another pair context → P-Paar fails (control holds)', async () => {
    // One introduction, both sides consent (A1 and B1; the allocating device produces each card, E2 (iv)), rounds to connect.
    const seq: GenEvent[] = [{ k: 'introduce' }, { k: 'round' }, { k: 'round' }, { k: 'consent', device: 'A1' }, { k: 'consent', device: 'B1' }, { k: 'round' }, { k: 'round' }, { k: 'round' }, { k: 'round' }]
    const control = await runSequence(cand, seq, { seed: 41, reseed, drain: 6 })
    // Soll: 1 act connected on both sides with the same pair (A's card ↔ B's card) → 0 violations.
    expect(prop(control, 'P-Paar').counts).toEqual({ connectedActs: 1, bothSides: 1 })
    expect(prop(control, 'P-Paar').violations).toEqual([])
    const mutated = await runSequence(cand, seq, { seed: 41, reseed, drain: 6, mutation: wrongPairAtA })
    // Soll: the same act connected on both sides, A's tuple names a key agreement that is not B's card's → 1 violation.
    expect(prop(mutated, 'P-Paar').counts).toEqual({ connectedActs: 1, bothSides: 1 })
    expect(prop(mutated, 'P-Paar').violations).toHaveLength(1)
  }, 60_000)

  it('S1. Shrinking: a generated sequence failing P-Commit under suppressed tickets shrinks to one introduction that commits', async () => {
    const seed = 7
    const events = generate(seed, 16)
    expect(events.some((e) => e.k === 'introduce' && e.crash !== 'before-commit'), 'Voraussetzung: eine Ausstellung, die committet').toBe(true)
    const r = await runSequence(cand, events, { seed, reseed, mutation: suppressTickets })
    expect(prop(r, 'P-Commit').ok).toBe(false)
    const s = await shrink(cand, events, 'P-Commit', { seed, reseed, mutation: suppressTickets, maxRuns: 60 })
    // Soll: one event; an introduction that reaches its commit (plain, `before-send` or `between-sends`): every other event
    // can go, and without an issuance that commits there is no batch to miss its tickets.
    expect(s.events, report(seed, 'P-Commit', s.events, [])).toHaveLength(1)
    expect(s.events[0]!.k).toBe('introduce')
    expect((s.events[0] as { crash?: string }).crash).not.toBe('before-commit')
  }, 150_000)
})

/**
 * U3's world: A (two devices), B, C, M (one device). M's image before α; α between A and B, both accept; M rebuilt from
 * the image names x again for β between A and C (C's smallest key is fresh); rounds until C holds β.
 */
async function restoredMediator(seed: number, mutate: boolean): Promise<{ buch: Buch; onX: number; preconditions: { sameKey: boolean; cAccepted: boolean } }> {
  reseed(seed)
  const { w, buch } = ledgerWorld(k2())
  const A = await w.person('A', 'A1')
  const B = await w.person('B', 'B1')
  const C = await w.person('C', 'C1')
  const Mm = await w.person('M', 'M1')
  const am = await w.encounter(A, Mm)
  const bm = await w.encounter(B, Mm)
  const cm = await w.encounter(C, Mm)
  await w.rounds(2)
  await A.setClass(am.x.id, true)
  await B.setClass(bm.x.id, true)
  await C.setClass(cm.x.id, true)
  await w.rounds(3)
  await w.enrol(A, 'A2')
  await w.rounds(2)
  if (mutate) for (const d of w.of('A')) without8640_12(d)
  const image = w.stores.get('M1')!.snapshot()
  const ra = await Mm.introduce(am.y.id, bm.y.id)
  const alpha = Mm.state.mediatorActs.find((a) => a.id === (ra as { act: string }).act)!
  await w.until(() => w.of('A').some((d) => d.state.acts.some((a) => a.id === alpha.id)) && B.state.acts.some((a) => a.id === alpha.id), 10)
  w.stores.get('M1')!.restore(image)
  await Mm.reload()
  buch.note('restore', 'M1')
  const rb = await Mm.introduce(am.y.id, cm.y.id)
  const beta = 'act' in rb ? Mm.state.mediatorActs.find((a) => a.id === rb.act) : undefined
  await w.until(() => !!beta && C.state.acts.some((a) => a.id === beta.id), 10)
  await w.rounds(4)
  return { buch, onX: buch.acceptedOn().get(alpha.a.key)?.size ?? 0, preconditions: { sameKey: beta?.a.key === alpha.a.key, cAccepted: !!beta && C.state.acts.some((a) => a.id === beta.id) } }
}

describe('K2 step 2b.0: D1 (design review 1, Astra) as a fixed test', () => {
  // Expected-fail (`it.fails`): red on the step-2a code by design. Design review 1 D1
  // (rltp/design/port-experimente-e15-codex-design-k2-schritt-2b-2026-10-20.md): A's single use does not survive the
  // allowed restore, because 8640.12 checks the current local key state and A's restored image has x active again. The
  // incarnation rule (accept only on keys of the running incarnation, restart revision with `burn`) is step 2b.3 (draft 3
  // §8); there this test turns green and loses `.fails`. A broken precondition returns early, so the body passes and
  // `it.fails` turns red: the expected failure is only the Soll on x.
  it.fails('D1. Images of A_x and M hold x unused; α (A–B) accepted; M rebuilt names x for β (A–C, fresh C key); A_x refuses β (8640.12), C accepts; A_x rebuilt from its image before its siblings catch up; a repetition of β reaches it. Soll: 1 accepted act id on x (2a: 2, α and β)', async () => {
    reseed(51)
    const { w, buch } = ledgerWorld(k2())
    const A = await w.person('A', 'A1')
    const B = await w.person('B', 'B1')
    const C = await w.person('C', 'C1')
    const Mm = await w.person('M', 'M1')
    const am = await w.encounter(A, Mm)
    const bm = await w.encounter(B, Mm)
    const cm = await w.encounter(C, Mm)
    await w.rounds(2)
    await A.setClass(am.x.id, true)
    await B.setClass(bm.x.id, true)
    await C.setClass(cm.x.id, true)
    await w.rounds(3)
    await w.enrol(A, 'A2')
    await w.rounds(2)
    // 1. Images of both A devices and of M before α (x is the key M will name; its allocator is known only after α).
    const imagesA = new Map(w.of('A').map((d) => [d.name, w.stores.get(d.name)!.snapshot()]))
    const imageM = w.stores.get('M1')!.snapshot()
    // 2. α between A and B; both accept.
    const ra = await Mm.introduce(am.y.id, bm.y.id)
    if (!('act' in ra)) return
    const alpha = Mm.state.mediatorActs.find((a) => a.id === ra.act)!
    const x = alpha.a.key
    await w.until(() => w.of('A').some((d) => d.state.acts.some((a) => a.id === alpha.id)) && B.state.acts.some((a) => a.id === alpha.id), 10)
    const by = A.state.relationships.flatMap((r) => r.stock).find((k) => k.anchor === x)?.by
    const Ax = w.of('A').find((d) => d.name === by)
    if (!Ax) return
    // 3. M rebuilt from its image names x again for β between A and C (C's key is fresh).
    w.stores.get('M1')!.restore(imageM)
    await Mm.reload()
    buch.note('restore', 'M1')
    const rb = await Mm.introduce(am.y.id, cm.y.id)
    if (!('act' in rb)) return
    const beta = Mm.state.mediatorActs.find((a) => a.id === rb.act)!
    if (beta.a.key !== x) return
    // 4. A_x refuses β by 8640.12; C accepts.
    await w.until(() => C.state.acts.some((a) => a.id === beta.id) && Ax.state.findings.some((f) => f.startsWith(`ticket ${beta.id.slice(0, 8)}`) && f.includes('8640.12')), 3)
    if (!C.state.acts.some((a) => a.id === beta.id) || !Ax.state.findings.some((f) => f.includes('8640.12'))) return
    // 5. A_x rebuilt from its image before α; its siblings' journal is held back (catch-up delayed); M's deliverer repeats
    // β (no receipt from A_x, ackWait 3 rounds, give-up after 12) and the repetition reaches A_x.
    const self = w.selfAddresses('A')
    w.carrier.faults.withhold(Ax.name, (f) => self.has(f.address))
    w.stores.get(Ax.name)!.restore(imagesA.get(Ax.name))
    await Ax.reload()
    buch.note('restore', Ax.name)
    await w.until(() => Ax.state.acts.some((a) => a.id === beta.id), 10)
    w.carrier.faults.reset()
    await w.rounds(4)
    // Soll (draft 3 §7.2): 1 accepted act id on x over the whole history (P-Einmal). Step 2a: A_x's lost incarnation
    // accepted α, its rebuilt incarnation accepts β → 2.
    expect([...(buch.acceptedOn().get(x) ?? [])].length, `accepted on x: ${[...(buch.acceptedOn().get(x) ?? [])].join(', ')}`).toBe(1)
  }, 120_000)
})
