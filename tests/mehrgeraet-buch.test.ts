import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// E15 K2 step 2b.0 (design 2b draft 2 §5.1–§5.4, §6 "2b.0"; draft 3 §7.1, §7.2, §8 "2b.0", §12 D1): the outcome ledger
// ("Außenwirkungsbuch"), its checkers (P-Einmal, P-Commit, P-Produktion, P-Paar per act, tuple counter) and the minimal
// generator over the step-2a paths with M as single-writer fixture.
//   L1. The ledger survives a holder restore: nothing in it changes when a device is rebuilt from an old image.
//   G0. Replay: a seed and a sequence give the same run.
//   G1. Generator, fixed seeds: every property holds on the step-2a code (failure: seed + shrunk sequence printed).
//   U1–U4. Mutations (test-only hooks on the devices, never flags in the code): each checker is shown failing.
//   U5. The reference model's negative side: no admissible key, no obligation, no false alarm.
//   U6. Wrongly bound tickets (voucher = own key in both) → P-Commit fails (Tor-Review 42 B1, MV-30 / draft 2 §2.3).
//   U7. Union duties ended by `depart` (`moot`) are not open (Tor-Review 42 B2).
//   U8. Tickets signed in the context of the other M relationship → P-Commit fails by the receiver predicate, 8640.2
//       (Tor-Review 43 B1).
//   U9. Carrier submission addresses swapped after the commit (intent and sealed bytes unchanged) → P-Commit fails, and
//       P-Produktion does not count the duty kept (Tor-Review 43 B2).
//   B1, B2 (Tor-Review 44). The ledger opens every committed ticket frame with the key its address names, as that receiver
//       would: tickets sealed to the other side's key under the "right" addresses → P-Commit `sealed-to-other-key`,
//       P-Produktion not kept (B1); the committed act side's key agreement set to the other side's → P-Commit names
//       `own.keyAgreement` (B2).
//   T1. The binding table covers every field of the committed act side, the act, the intent and the opened ticket.
//   T2. The reviewer's nine binding cases of review 44 (b), parametrised, with their violation counts.
//   U10. A ticket frame deposited at the carrier directly, no producer report, validly sealed to an A stock key →
//       P-Commit `ticket-without-commit` (addendum to review 44, before review 45).
//   R1, R2. The dump is a complete artefact: dump → load → re-check gives the same results (Tor-Review 42 S1).
//   N1. The observation seam is fail-safe: a throwing observer changes nothing in holder or carrier (Tor-Review 42 (a)).
//   S1. Shrinking: a failing generated sequence shrinks to the smallest sequence that still fails the same property.
//   D1. Astra's D1 sequence (design review 1): Soll 1 accepted act id on x; red on 2a (expected-fail, closes in 2c).
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

import { frameHash, TYPES, type HolderDevice } from '../src/lab/mehrgeraet/holder'
import { diSign, jcs, seal, type Json } from '@real-life/trust-protocol'
import { Buch, bindingGaps, ledgerWorld, openTickets, pairCounter, pCommit, pEinmal, pPaar, pProduktion } from '../src/lab/mehrgeraet/buch'
import { generate, report, runSequence, show, shrink, type GenEvent, type GenWorld, type Mutation } from '../src/lab/mehrgeraet/generator'
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
/** M binds each ticket's voucher to the ticket's own side (voucher anchor = own key) instead of the other side's key. */
const wrongVoucher: Mutation = (g) => {
  const d = priv(g.Mm)
  const orig = d.sendDoc.bind(g.Mm)
  d.sendDoc = async (type, ...rest) => {
    if (type === TYPES.ticket) {
      const p = rest[4] as { own: string; voucher: Record<string, unknown> } // sendDoc(type, issuerCtx, recipient, toRkid, replyTo, payload, fan)
      rest[4] = { ...p, voucher: { ...p.voucher, anchor: p.own } }
    }
    return orig(type, ...rest)
  }
}
/** M signs each ticket with its key of the other M relationship (ticket to A in the context of M–B and back). */
const wrongSigner: Mutation = (g) => {
  const d = priv(g.Mm)
  const orig = d.sendDoc.bind(g.Mm)
  d.sendDoc = async (type, ...rest) => {
    if (type === TYPES.ticket) {
      const a = M.head(M.rel(g.Mm.state, g.ma)).ownKey
      const b = M.head(M.rel(g.Mm.state, g.mb)).ownKey
      rest[0] = rest[0] === a ? b : a // sendDoc(type, issuerCtx, …): the signing context
    }
    return orig(type, ...rest)
  }
}
/** After `sendDoc` M's deliverer submits each ticket at the other side's key agreement; intent and sealed bytes unchanged. */
const swappedAddress: Mutation = (g) => {
  const d = priv(g.Mm)
  const orig = d.sendDoc.bind(g.Mm)
  d.sendDoc = async (type, ...rest) => {
    const r = await orig(type, ...rest)
    if (type === TYPES.ticket && r) {
      const p = rest[4] as { voucher: { keyAgreement: string } }
      ;(g.Mm.zusteller.submissions.get(r.digest) as { address: string }).address = p.voucher.keyAgreement
    }
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
    // Soll: one issuance (M holds 6 keys of each side: two devices per side, each lists its share ceil(5/2) = 3 of 8485
    // refill-to 5, `stockShare`), its two tickets at the carrier, one obligation kept.
    expect(prop(r, 'P-Commit').counts).toEqual({ tickets: 2, issuances: 1 })
    expect(prop(r, 'P-Produktion').counts).toMatchObject({ introductions: 1, obliged: 1, kept: 1 })
  }, 60_000)

  it('U1. Suppressed tickets → P-Commit and P-Produktion fail', async () => {
    const r = await runSequence(cand, one, { seed: 21, reseed, mutation: suppressTickets })
    // Soll P-Commit: the issuance batch holds the consumption and 0 ticket intents → 1 violation (existence); no ticket at
    // the carrier → no "ticket without commit" violation. Soll P-Produktion: 1 obligation (reference: 6 + 6 admissible keys),
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
    // The bench logs both introductions and every round (as the generator does), so P-Produktion is checked on them, not on
    // an empty set (Tor-Review 42 (d)). Soll P-Produktion in both runs: 2 introductions, both obliged (the reference admits
    // A keys besides x, consumed by α in the ledger, and B's resp. C's listed keys), both kept (each issuance's two tickets
    // leave at its commit, at least three logged rounds with M up follow each), 0 violations; P-Commit and P-Paar hold.
    const control = await restoredMediator(31, false)
    expect(control.preconditions, 'Voraussetzungen').toEqual({ sameKey: true, cAccepted: true })
    expect(control.onX).toBe(1)
    expect(pEinmal(control.buch).ok).toBe(true)
    const mutated = await restoredMediator(31, true)
    expect(mutated.preconditions, 'Voraussetzungen').toEqual({ sameKey: true, cAccepted: true })
    expect(mutated.onX).toBe(2)
    expect(pEinmal(mutated.buch).violations).toHaveLength(1)
    for (const r of [control, mutated]) {
      expect((await pProduktion(r.buch)).counts).toMatchObject({ introductions: 2, obliged: 2, kept: 2, noKeys: 0, open: 0 })
      expect((await pProduktion(r.buch)).violations).toEqual([])
      expect((await pCommit(r.buch)).ok && pPaar(r.buch).ok).toBe(true)
    }
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

  it('U5. Reference model, negative side: twelve introductions against a budget of ten; the last two find no admissible A key in the delivery protocol, M refuses them, no violation', async () => {
    // Soll: 8510 budget 10 per relationship for the person, split over A's two devices (MV-9: share 5 each); a device lists
    // at most as many own keys as it has acceptances left (`quotaLeft`), so after 10 acceptances A lists no key. With three
    // rounds after each introduction (ticket, acceptance and the next revision arrive), introductions 1–10 are issued and
    // obliged (10 kept), 11 and 12 find no admissible A key (reference: noKeys 2) and M refuses them. B has the same budget
    // and is never the short side first. A accepts 10 acts on 10 keys; P-Einmal holds.
    const seq: GenEvent[] = Array.from({ length: 12 }, () => [{ k: 'introduce' }, { k: 'round' }, { k: 'round' }, { k: 'round' }] as GenEvent[]).flat()
    const r = await runSequence(cand, seq, { seed: 61, reseed })
    for (const c of r.checks) expect(c.violations, c.property).toEqual([])
    expect(prop(r, 'P-Produktion').counts).toMatchObject({ introductions: 12, obliged: 10, kept: 10, noKeys: 2 })
    const refused = r.buch.events.filter((e) => e.kind === 'introduce' && 'refused' in ((e.detail?.result as object) ?? {}))
    expect(refused).toHaveLength(2)
    const accA = r.buch.commits.filter((c) => c.person === 'A').flatMap((c) => c.ops).filter((o) => o.kind === 'ticket-accept')
    expect(accA).toHaveLength(10)
  }, 60_000)

  it('U6. Wrongly bound tickets: M binds each voucher to the ticket\'s own side → P-Commit fails (control holds); the other checkers unchanged', async () => {
    // Control = U0's sequence and seed: P-Commit 0 violations, 2 tickets, 1 issuance.
    const control = await runSequence(cand, one, { seed: 21, reseed })
    expect(prop(control, 'P-Commit').violations).toEqual([])
    expect(prop(control, 'P-Commit').counts).toEqual({ tickets: 2, issuances: 1 })
    const r = await runSequence(cand, one, { seed: 21, reseed, mutation: wrongVoucher })
    // Soll P-Commit: the one issuance batch holds two ticket intents, each naming its own side's key as `own` (so the
    // `own` check alone passes) but also as voucher, not the key acquired for the other side (MV-30, 8605) → 1 violation
    // (one per issuance). Its bytes were committed before they left → no "ticket without commit" violation. Tickets at the
    // carrier: A and B refuse a ticket whose voucher is one of their own stock keys (8640.8), no receipt, so the deliverer repeats
    // each after ackWait = 3 rounds; the drain has k + 3 = 6 rounds → each ticket deposited at the commit, after round 3
    // and after round 6 → 3 × 2 = 6. P-Produktion: both tickets at the carrier in time → 1 obligation kept. P-Einmal: no
    // acceptance (0 keys, 0 accepts). P-Paar: nothing connected.
    expect(prop(r, 'P-Commit').violations).toHaveLength(1)
    expect(prop(r, 'P-Commit').violations[0]).toContain('voucher')
    expect(prop(r, 'P-Commit').counts).toEqual({ tickets: 6, issuances: 1 })
    expect(prop(r, 'P-Produktion').violations).toEqual([])
    expect(prop(r, 'P-Produktion').counts).toMatchObject({ introductions: 1, obliged: 1, kept: 1 })
    expect(prop(r, 'P-Einmal')).toMatchObject({ ok: true, counts: { keys: 0, accepts: 0 } })
    expect(prop(r, 'P-Paar')).toMatchObject({ ok: true, counts: { connectedActs: 0, bothSides: 0 } })
    // The other bindings, each broken alone in a copy of the control ledger (dump → load); the control's two tickets were
    // each deposited once (accepted, receipted). Soll (Tor-Review 43: the carrier check binds each deposit to the address
    // its commit holds for that frame):
    // - expected receipt signer of one intent → 1 (the issuance; the carrier check is unchanged);
    // - address of one intent set to the other's → 2: that ticket's deposit is no longer the committed submission (1), and
    //   the ledger, opening the committed bytes with the key the new address names (the other side's), cannot open them:
    //   sealed to another key (Tor-Review 44) (1, the issuance);
    // - frame hashes of the two intents swapped, addresses and committed bytes kept → 3: each deposit's frame is now
    //   committed for the other address (2), and in the issuance the committed bytes no longer hash to the committed
    //   frames and the committed frames are not the sealed frames of its documents (1).
    const broken = async (f: (i: Buch['commits'][number]['intents']) => void) => {
      const b = Buch.load(control.buch.dump())
      const c = b.commits.find((x) => x.ops.some((o) => o.kind === 'introduce'))!
      f(c.intents.filter((i) => i.kind === TYPES.ticket))
      return pCommit(b)
    }
    const other = (xs: string[], x: string) => xs.find((y) => y !== x)!
    const sides = (is: Buch['commits'][number]['intents']) => is.map((i) => i.expected)
    for (const [what, f, n] of [
      ['expected', (is: Buch['commits'][number]['intents']) => void (is[0]!.expected = other(sides(is), is[0]!.expected)), 1],
      ['address', (is: Buch['commits'][number]['intents']) => void (is[0]!.address = is[1]!.address), 2],
      ['frames', (is: Buch['commits'][number]['intents']) => void ([is[0]!.frames, is[1]!.frames] = [is[1]!.frames, is[0]!.frames]), 3],
    ] as const) {
      const c = await broken(f)
      expect(c.violations, what).toHaveLength(n)
      expect(c.violations.filter((v) => v.startsWith('issuance')), what).toHaveLength(1)
      expect(c.violations.find((v) => v.startsWith('issuance')), what).toContain(what)
    }
  }, 60_000)

  it('U8. Tickets signed in the other M relationship\'s context → exactly P-Commit fails, by the receiver predicate (8640.2); the other checkers unchanged (Tor-Review 43 B1)', async () => {
    const r = await runSequence(cand, one, { seed: 21, reseed, mutation: wrongSigner })
    // Soll P-Commit: the issuance batch is complete and mirror-bound in its fields, but the ticket to A is signed with M's
    // key of M–B and the ticket to B with M's key of M–A. The receiver predicate (the holder's own 8640 check) on A's resp.
    // B's committed image refuses each by 8640.2 (the signer is no counterpart on that relationship) → 1 violation (the
    // issuance, both tickets in it). The bytes left after their commit at the committed addresses → no carrier violation.
    // Tickets at the carrier: both sides refuse (8640.2), no receipt, the deliverer repeats after 3 and 6 rounds → 3 × 2 = 6.
    // P-Produktion: both committed submissions at the carrier in time → 1 obligation kept. P-Einmal: no acceptance.
    // P-Paar: nothing connected.
    expect(prop(r, 'P-Commit').violations).toHaveLength(1)
    expect(prop(r, 'P-Commit').violations[0]).toContain('8640.2')
    expect(prop(r, 'P-Commit').violations[0]!.match(/8640\.2/g)).toHaveLength(2)
    expect(prop(r, 'P-Commit').counts).toEqual({ tickets: 6, issuances: 1 })
    expect(prop(r, 'P-Produktion').violations).toEqual([])
    expect(prop(r, 'P-Produktion').counts).toMatchObject({ introductions: 1, obliged: 1, kept: 1 })
    expect(prop(r, 'P-Einmal')).toMatchObject({ ok: true, counts: { keys: 0, accepts: 0 } })
    expect(prop(r, 'P-Paar')).toMatchObject({ ok: true, counts: { connectedActs: 0, bothSides: 0 } })
  }, 60_000)

  it('U9. Submission addresses swapped after sendDoc (intent and sealed bytes unchanged) → P-Commit fails per deposit; P-Produktion does not count the duty kept (Tor-Review 43 B2)', async () => {
    const r = await runSequence(cand, one, { seed: 21, reseed, mutation: swappedAddress })
    // Soll P-Commit: the issuance batch is unchanged and passes the receiver predicate. Each ticket is deposited at the
    // other side's key agreement: the device there cannot open it (sealed to the named key), no receipt, the deliverer
    // repeats after 3 and 6 rounds → 3 × 2 = 6 deposits, none of them the committed submission (frame committed for
    // another address) → 6 violations, counts 6 tickets, 1 issuance. P-Produktion: 1 obligation; 0 of 2 committed
    // submissions reach the carrier within k rounds → 1 violation, 0 kept. P-Einmal: no acceptance. P-Paar: nothing.
    expect(prop(r, 'P-Commit').violations).toHaveLength(6)
    for (const v of prop(r, 'P-Commit').violations) expect(v).toContain('address')
    expect(prop(r, 'P-Commit').counts).toEqual({ tickets: 6, issuances: 1 })
    expect(prop(r, 'P-Produktion').violations).toHaveLength(1)
    expect(prop(r, 'P-Produktion').counts).toMatchObject({ introductions: 1, obliged: 1, kept: 0 })
    expect(prop(r, 'P-Einmal')).toMatchObject({ ok: true, counts: { keys: 0, accepts: 0 } })
    expect(prop(r, 'P-Paar')).toMatchObject({ ok: true, counts: { connectedActs: 0, bothSides: 0 } })
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
  // Logged like the generator does (P-Produktion reads introductions and rounds from the ledger): M's addresses per side.
  const addr = async (rel: string) => Promise.all((Mm.state.relationships.find((x) => x.id === rel || x.tuples.some((t) => t.id === rel))?.tuples ?? []).map(async (t) => (await Mm.cand.keys.pair(t.ownKey)).rkid))
  const [addrA, addrB, addrC] = [await addr(am.y.id), await addr(bm.y.id), await addr(cm.y.id)]
  const round = async () => {
    await w.rounds(1)
    buch.note('round', undefined, { up: w.devices.filter((d) => d.online).map((d) => d.name) })
  }
  const until = async (pred: () => boolean, max: number) => {
    for (let i = 0; i < max; i++) {
      await round()
      if (pred()) return
    }
  }
  const introduce = async (rel1: string, rel2: string, a1: string[], a2: string[]) => {
    const detail: Record<string, unknown> = { addrA: a1, addrB: a2, result: null, armed: null, up: true }
    buch.note('introduce', Mm.name, detail)
    const r = await Mm.introduce(rel1, rel2)
    detail.result = r
    return r
  }
  const image = w.stores.get('M1')!.snapshot()
  const ra = await introduce(am.y.id, bm.y.id, addrA, addrB)
  const alpha = Mm.state.mediatorActs.find((a) => a.id === (ra as { act: string }).act)!
  await until(() => w.of('A').some((d) => d.state.acts.some((a) => a.id === alpha.id)) && B.state.acts.some((a) => a.id === alpha.id), 10)
  w.stores.get('M1')!.restore(image)
  await Mm.reload()
  buch.note('restore', 'M1')
  const rb = await introduce(am.y.id, cm.y.id, addrA, addrC)
  const beta = 'act' in rb ? Mm.state.mediatorActs.find((a) => a.id === rb.act) : undefined
  await until(() => !!beta && C.state.acts.some((a) => a.id === beta.id), 10)
  for (let i = 0; i < 4; i++) await round()
  return { buch, onX: buch.acceptedOn().get(alpha.a.key)?.size ?? 0, preconditions: { sameKey: beta?.a.key === alpha.a.key, cAccepted: !!beta && C.state.acts.some((a) => a.id === beta.id) } }
}

describe('K2 step 2b.0: D1 (design review 1, Astra) as a fixed test', () => {
  // Expected-fail (`it.fails`): red on the step-2a code by design. Design review 1 D1
  // (rltp/design/port-experimente-e15-codex-design-k2-schritt-2b-2026-10-20.md): A's single use does not survive the
  // allowed restore, because 8640.12 checks the current local key state and A's restored image has x active again. The
  // incarnation rule (accept only on keys of the running incarnation, restart revision with `burn`) is step 2c (core
  // draft 4 §0.2, §6); there this test turns green and loses `.fails`. A broken precondition returns early, so the body passes and
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

describe('K2 step 2b.0: union duty counter follows the committed state (Tor-Review 42 B2)', () => {
  it('U7. Two encounters A–B, receipts lost: A\'s duty stays `sent` (1 open); A departs the relationship → its duty is `moot`, 0 open for A (B, not departed, keeps 1)', async () => {
    reseed(71)
    const { w, buch } = ledgerWorld(k2())
    const A = await w.person('A', 'A1')
    const B = await w.person('B', 'B1')
    w.carrier.faults.drop((f) => w.frameOrigin(f.bytes)?.kind === 'delivery-ack')
    await w.encounter(A, B)
    await w.rounds(2)
    await w.encounter(A, B)
    await w.rounds(3)
    // Soll before: the second encounter opens a second tuple of the same relationship on each side → one union duty per
    // side (6845); its mapping is accepted by the carrier (`sent`), the receipt is dropped → never `united` → 1 open each.
    const duty = A.state.duties.find((d) => d.state === 'sent')
    expect(duty, 'Voraussetzung: As Pflicht ist gesendet').toBeDefined()
    expect(pairCounter(buch).openDuties).toEqual({ A: 1, B: 1 })
    expect(await A.depart(M.relOfTuple(A.state, duty!.pair[0])!.id)).toBe('ok')
    // Soll after: `depart` ends A's duties of that relationship as `moot` (6845.7) in the committed state → 0 open for A;
    // B did not depart and learns nothing without a round → 1.
    expect(A.state.duties.map((d) => d.state)).toEqual(['moot'])
    expect(pairCounter(buch).openDuties).toEqual({ A: 0, B: 1 })
  }, 60_000)
})

describe('K2 step 2b.0: the dump is a complete artefact (Tor-Review 42 S1)', () => {
  const one: GenEvent[] = [{ k: 'introduce' }]
  const all = async (b: Buch) => M.canonical({ checks: [pEinmal(b), await pCommit(b), await pProduktion(b), pPaar(b)], counter: pairCounter(b), accepted: [...b.acceptedOn()].map(([k, a]) => [k, [...a].sort()]) })

  it('R1. dump → load → re-check: the same checker results and counters; loaded again, the same dump (U0 control, U1, U2: P-Commit still fails after the reload)', async () => {
    for (const mutation of [undefined, suppressTickets, ticketBeforeCommit]) {
      const r = await runSequence(cand, one, { seed: 21, reseed, mutation })
      const dump = r.buch.dump()
      const loaded = Buch.load(dump)
      expect(loaded.dump()).toBe(dump)
      expect(await all(loaded)).toBe(await all(r.buch))
    }
    // Soll after the reload, as in U1 and U2 on the live ledger: U1 P-Commit 1 violation, U2 P-Commit 2 violations.
    const u1 = Buch.load((await runSequence(cand, one, { seed: 21, reseed, mutation: suppressTickets })).buch.dump())
    expect((await pCommit(u1)).violations).toHaveLength(1)
    const u2 = Buch.load((await runSequence(cand, one, { seed: 21, reseed, mutation: ticketBeforeCommit })).buch.dump())
    expect((await pCommit(u2)).violations).toHaveLength(2)
  }, 120_000)

  it('R2. The production mapping P-Commit reads is in the dump: removing it after a valid issuance changes the dump', async () => {
    const r = await runSequence(cand, one, { seed: 21, reseed })
    const dump = r.buch.dump()
    expect((await pCommit(r.buch)).ok).toBe(true)
    ;(r.buch as unknown as { byDigest: Map<string, unknown> }).byDigest.clear()
    // Soll: P-Commit fails without the mapping (the binding row `production`, the second condition next to the opened
    // bytes, finds no sealed frames of the document), and the dump shows it.
    expect((await pCommit(r.buch)).ok).toBe(false)
    expect(r.buch.dump()).not.toBe(dump)
    expect((await pCommit(Buch.load(r.buch.dump()))).ok).toBe(false)
  }, 60_000)
})

describe('K2 step 2b.0: the observation seam is fail-safe (Tor-Review 42 (a))', () => {
  it('N1. Observers that throw in every hook (committed, produced, admitted, carrier) leave holder and carrier exactly as without observers; the errors land in the ledger', async () => {
    // U4's sequence (issuance, both consents, connect): every hook fires.
    const seq: GenEvent[] = [{ k: 'introduce' }, { k: 'round' }, { k: 'round' }, { k: 'consent', device: 'A1' }, { k: 'consent', device: 'B1' }, { k: 'round' }, { k: 'round' }, { k: 'round' }, { k: 'round' }]
    const outcome = (g: GenWorld) => M.canonical({ devices: g.w.devices.map((d) => [d.name, d.state, d.dispositions]), carried: g.w.carrier.carried.map((f) => [f.address, frameHash(f.bytes)]), introduced: g.buch.events.filter((e) => e.kind === 'introduce').map((e) => e.detail?.result) })
    let quiet: GenWorld | undefined
    let loud: GenWorld | undefined
    await runSequence(cand, seq, {
      seed: 41,
      reseed,
      mutation: (g) => {
        quiet = g
        for (const d of g.w.devices) d.observer = null
        g.w.carrier.observe = null
      },
    })
    await runSequence(cand, seq, {
      seed: 41,
      reseed,
      mutation: (g) => {
        loud = g
        const boom = (hook: string) => () => {
          throw new Error(`observer failed in ${hook}`)
        }
        g.buch.committed = boom('committed')
        g.buch.produced = boom('produced')
        g.buch.admitted = boom('admitted')
        g.w.carrier.observe = boom('carrier')
      },
    })
    expect(outcome(loud!)).toBe(outcome(quiet!))
    // Soll: each hook fired at least once in the sequence and its error was recorded, none escaped.
    expect([...new Set(loud!.buch.errors.map((e) => e.hook))].sort()).toEqual(['admitted', 'carrier', 'committed', 'produced'])
  }, 120_000)
})

// ── Tor-Review 44: the ledger opens frames as the receiver ──

/**
 * Tor-Review 44 B1 (the reviewer's counter-run): M seals each ticket to the other side's stock key (the voucher's key
 * agreement), then sets the submission address and the intent address to the side's own key agreement before the commit.
 */
const sealedToOther: Mutation = (g) => {
  const d = priv(g.Mm)
  const orig = d.sendDoc.bind(g.Mm)
  d.sendDoc = async (type, ...rest) => {
    if (type !== TYPES.ticket) return orig(type, ...rest)
    const address = rest[2] as string // sendDoc(type, issuerCtx, recipient, toRkid, …)
    const p = rest[4] as { voucher: { anchor: string; keyAgreement: string } }
    rest[5] = [{ anchor: p.voucher.anchor, rkid: p.voucher.keyAgreement }] // the fan: the key the frame is sealed to
    const r = await orig(type, ...rest)
    if (r) {
      ;(g.Mm.zusteller.submissions.get(r.digest) as { address: string }).address = address
      ;((g.Mm as unknown as { intents: Map<string, { address: string }> }).intents.get(r.digest)!).address = address
    }
    return r
  }
}
/**
 * Tor-Review 44 B2 (the reviewer's counter-run): the committed act's side a names B's key agreement; A's ticket is still
 * sealed and addressed to A's actual key agreement, so the counter-ticket to B carries the wrong key agreement as voucher.
 */
const actSideAgreement: Mutation = (g) => {
  const mm = g.Mm as unknown as { emit: (body: { kind: string; act?: M.MediatorAct }) => unknown; sendDoc: (type: string, ...rest: unknown[]) => Promise<unknown> }
  const emit = mm.emit.bind(g.Mm)
  const send = mm.sendDoc.bind(g.Mm)
  let changed = ''
  let real = ''
  mm.emit = (body) => {
    if (body.kind === 'introduce' && body.act) {
      changed = body.act.a.key
      real = body.act.a.keyAgreement
      body.act.a.keyAgreement = body.act.b.keyAgreement
    }
    return emit(body)
  }
  mm.sendDoc = async (type, ...rest) => {
    if (type === TYPES.ticket && (rest[4] as { own: string }).own === changed) {
      rest[2] = real
      rest[5] = [{ anchor: changed, rkid: real }]
    }
    return send(type, ...rest)
  }
}
/** M's ticket payload changed before signing (the bytes are sealed and committed as M built them). */
const ticketPayload =
  (f: (p: { own: string; issuedAt: string; voucher: { anchor: string } }) => void): Mutation =>
  (g) => {
    const d = priv(g.Mm)
    const orig = d.sendDoc.bind(g.Mm)
    d.sendDoc = async (type, ...rest) => {
      if (type === TYPES.ticket) f(rest[4] as { own: string; issuedAt: string; voucher: { anchor: string } })
      return orig(type, ...rest)
    }
  }
/** The named key's allocator commits a shorter life for it while M builds the ticket (before the issuance commit). */
const shortKey: Mutation = (g) => {
  const d = priv(g.Mm)
  const orig = d.sendDoc.bind(g.Mm)
  d.sendDoc = async (type, ...rest) => {
    if (type === TYPES.ticket) {
      const own = (rest[4] as { own: string }).own
      const allocator = g.w.devices.find((x) => x.state.relationships.some((r) => r.stock.some((k) => k.anchor === own && k.by === x.name)))!
      allocator.state.relationships.flatMap((r) => r.stock).find((k) => k.anchor === own)!.expiresAt = '2026-10-18T08:00:00.000Z'
      allocator.commit()
    }
    return orig(type, ...rest)
  }
}

describe('K2 step 2b.0: the ledger opens frames as the receiver (Tor-Review 44)', () => {
  const one: GenEvent[] = [{ k: 'introduce' }]

  it('B1. Tickets sealed to the other side\'s stock key, intent and submission addresses set to the side\'s own key agreement → exactly P-Commit fails with `sealed-to-other-key`; P-Produktion does not count the duty kept', async () => {
    const r = await runSequence(cand, one, { seed: 21, reseed, mutation: sealedToOther })
    // Soll P-Commit: the issuance batch holds two ticket intents at A's resp. B's key agreement whose bytes are sealed to
    // the other side's key. The ledger opens each committed frame with the key its address names: neither opens →
    // `sealed-to-other-key` twice, and no opened ticket names either side → 1 violation (the issuance). Every deposit is
    // the committed submission (bytes and address as committed) → no carrier violation. At the carrier: the device at
    // each address cannot open its ticket, no receipt, the deliverer repeats after 3 and 6 rounds → 3 × 2 = 6 deposits.
    // P-Produktion: 1 obligation; a deposit counts only if its committed frame opens at its address → 0 of 2 → 1
    // violation, 0 kept. P-Einmal: no acceptance. P-Paar: nothing connected.
    expect(prop(r, 'P-Commit').violations).toHaveLength(1)
    expect(prop(r, 'P-Commit').violations[0]!.match(/sealed-to-other-key/g)).toHaveLength(2)
    expect(prop(r, 'P-Commit').counts).toEqual({ tickets: 6, issuances: 1 })
    expect(prop(r, 'P-Produktion').violations).toHaveLength(1)
    expect(prop(r, 'P-Produktion').counts).toMatchObject({ introductions: 1, obliged: 1, kept: 0 })
    expect(prop(r, 'P-Einmal')).toMatchObject({ ok: true, counts: { keys: 0, accepts: 0 } })
    expect(prop(r, 'P-Paar')).toMatchObject({ ok: true, counts: { connectedActs: 0, bothSides: 0 } })
  }, 60_000)

  it('B2. The committed act side a names B\'s key agreement, A\'s ticket sealed and addressed correctly → exactly P-Commit fails, naming `own.keyAgreement`', async () => {
    const r = await runSequence(cand, one, { seed: 21, reseed, mutation: actSideAgreement })
    // Soll P-Commit: both tickets open at their addresses and pass the receiver predicate (B's voucher check 8640.8 sees
    // A's anchor, not an own key). The binding table: A's ticket opens with the key at A's actual key agreement, which
    // is not the committed `act.a.keyAgreement` (B's) → `own.keyAgreement`; B's voucher carries the committed (wrong)
    // key agreement, equal to the committed side, so `voucher.keyAgreement` holds; nothing else differs → 1 violation
    // (the issuance) with exactly one row. Both sides accept and receipt at once → 2 deposits, both committed
    // submissions. P-Einmal: 2 keys, 2 accepts, no violation. P-Produktion: 1 kept. P-Paar: nothing connected.
    expect(prop(r, 'P-Commit').violations).toHaveLength(1)
    expect(prop(r, 'P-Commit').violations[0]).toContain('own.keyAgreement')
    expect(prop(r, 'P-Commit').violations[0]!.split('; ')).toHaveLength(1)
    expect(prop(r, 'P-Commit').counts).toEqual({ tickets: 2, issuances: 1 })
    expect(prop(r, 'P-Einmal')).toMatchObject({ ok: true, counts: { keys: 2, accepts: 2 } })
    expect(prop(r, 'P-Produktion')).toMatchObject({ ok: true, counts: { obliged: 1, kept: 1 } })
    expect(prop(r, 'P-Paar').ok).toBe(true)
  }, 60_000)

  it('T1. The binding table covers every field of the committed act side, the act, the commit intent and the opened ticket; a field added anywhere without a row is a gap', async () => {
    const r = await runSequence(cand, one, { seed: 21, reseed })
    const c = r.buch.commits.find((x) => x.ops.some((o) => o.kind === 'introduce'))!
    const op = c.ops.find((o): o is M.Op & { kind: 'introduce' } => o.kind === 'introduce')!
    const i = c.intents.find((x) => x.kind === TYPES.ticket)!
    const opened = (await openTickets(r.buch)).get(`${c.seq}|${i.digest}|0`)
    expect(opened?.ok, 'Voraussetzung: das Ticket öffnet an seiner Adresse').toBe(true)
    const doc = (opened as { doc: Record<string, unknown> }).doc
    const fields = (extra: { act?: object; side?: object; intent?: object; payload?: object }) => ({
      act: { ...op.act, ...extra.act },
      sides: [{ ...op.act.a, ...extra.side }, op.act.b],
      intent: { ...i, ...extra.intent },
      doc: { ...doc, payload: { ...(doc.payload as object), ...extra.payload } },
    })
    // Soll: no gap on the real objects; each added field is exactly one gap, named by its path.
    expect(bindingGaps(fields({}))).toEqual([])
    expect(bindingGaps(fields({ side: { extra: 1 } }))).toEqual(['side.extra'])
    expect(bindingGaps(fields({ act: { extra: 1 } }))).toEqual(['act.extra'])
    expect(bindingGaps(fields({ intent: { extra: 1 } }))).toEqual(['intent.extra'])
    expect(bindingGaps(fields({ payload: { extra: 1 } }))).toEqual(['doc.payload.extra'])
  }, 60_000)

  // Review 44 (b), the reviewer's nine binding cases, each from seed 21 and one introduction (U0's control), with the
  // violation counts they measured; each derived here by hand:
  // 1. voucher = own (U6): both tickets open and are refused by 8640.8 at their receivers; one issuance → 1; the six
  //    deposits (refused, repeated after 3 and 6 rounds) are committed submissions.
  // 2. signer of the other M relationship (U8): 8640.2 twice (and the `mediator` row twice), one issuance → 1.
  // 3. submission addresses swapped after `sendDoc` (U9): the issuance is unchanged; each of the six deposits is at an
  //    address its commit does not hold for that frame → 6.
  // 4. issuance time in the future (2030): 8640.3 and `issuedAt` on both tickets, one issuance → 1.
  // 5. `own` set to the other side (ticket to A names B's key, sealed and addressed to A): each ticket opens at its address,
  //    the one naming A's key sits at B's address (8640.5, `own.anchor`, `own.keyAgreement`), one issuance → 1.
  // 6. the named key ends before the act (its allocator commits the shorter life before the issuance): 8640.7 on both,
  //    one issuance → 1.
  // 7. one wrong `expected` in the control dump: row `expected` on one ticket → 1.
  // 8. both tickets at the carrier before their commit (U2): 2 deposits without an earlier commit → 2; the deposits after
  //    the commit are committed submissions, the issuance holds.
  // 9. an extra carrier entry with the other ticket's frame at the first ticket's address: that frame is committed for
  //    the other address → 1.
  const nine: Array<[string, { mutation?: Mutation; edit?: (b: Buch) => Buch }, number, string]> = [
    ['voucher = own', { mutation: wrongVoucher }, 1, '8640.8'],
    ['signer of the other M relationship', { mutation: wrongSigner }, 1, '8640.2'],
    ['submission addresses swapped', { mutation: swappedAddress }, 6, 'not the committed submission'],
    ['issuance time in the future', { mutation: ticketPayload((p) => void (p.issuedAt = '2030-01-01T00:00:00.000Z')) }, 1, '8640.3'],
    ['own set to the other side', { mutation: ticketPayload((p) => void (p.own = p.voucher.anchor)) }, 1, '8640.5'],
    ['named key ends before the act', { mutation: shortKey }, 1, '8640.7'],
    [
      'one wrong expected in the control dump',
      {
        edit: (b) => {
          const x = Buch.load(b.dump())
          const is = x.commits.find((c) => c.ops.some((o) => o.kind === 'introduce'))!.intents.filter((i) => i.kind === TYPES.ticket)
          is[0]!.expected = is[1]!.expected
          return x
        },
      },
      1,
      'expected',
    ],
    ['both tickets before their commit', { mutation: ticketBeforeCommit }, 2, 'without an earlier commit'],
    [
      'extra carrier entry with the other ticket frame',
      {
        edit: (b) => {
          const ps = b.productions.filter((p) => p.type === TYPES.ticket)
          b.carrier.tickets.push({ ...b.carrier.tickets[0]!, seq: 1_000_000, frame: ps.find((p) => p.digest !== b.carrier.tickets[0]!.digest)!.frames[0]! })
          return b
        },
      },
      1,
      'not the committed submission',
    ],
  ]
  for (const [label, how, n, word] of nine)
    it(`T2. ${label} → ${n} P-Commit violation(s)`, async () => {
      const r = await runSequence(cand, one, { seed: 21, reseed, mutation: how.mutation })
      const c = await pCommit(how.edit ? how.edit(r.buch) : r.buch)
      expect(c.violations, c.violations.join('\n')).toHaveLength(n)
      for (const v of c.violations) expect(v).toContain(word)
    }, 60_000)
})

/**
 * After M's real issuance, a ticket M never produced is handed to the carrier directly: signed with M's key on M–A, naming an
 * unused A stock key and an unused B key, sealed to that A key and deposited at its key agreement. No producer reports it.
 */
const unreportedTicket: Mutation = (g) => {
  const orig = g.Mm.introduce.bind(g.Mm)
  g.Mm.introduce = async (...args: Parameters<HolderDevice['introduce']>) => {
    const r = await orig(...args)
    const act = g.Mm.state.mediatorActs[0]!
    const unused = (person: string) =>
      g.w
        .of(person)
        .flatMap((d) => d.state.relationships.flatMap((x) => x.stock.filter((k) => k.by === d.name && k.state === 'active')))
        .find((k) => k.anchor !== act.a.key && k.anchor !== act.b.key)!
    const own = unused('A')
    const voucher = unused('B')
    const m = await g.Mm.cand.keys.pair(M.head(M.rel(g.Mm.state, g.ma)).ownKey)
    const now = g.w.clock.now()
    const payload = { act: crypto.randomUUID(), issuedAt: now, expiresAt: new Date(Date.parse(now) + M.PARAM.actLifetimeMs).toISOString(), own: own.anchor, voucher: { anchor: voucher.anchor, keyAgreement: voucher.keyAgreement, name: 'B' } }
    const doc = await diSign({ anchor: m.anchor, ed: { priv: m.ed.priv } }, { id: crypto.randomUUID(), type: TYPES.ticket, issuer: m.anchor, recipient: own.anchor, replyTo: m.rkid, issuedAt: now, payload }, now)
    g.w.carrier.deposit(own.keyAgreement, new TextEncoder().encode(jcs(await seal(doc as unknown as Json, own.keyAgreement))))
    return r
  }
}

describe('K2 step 2b.0: ticket frames without a producer report (addendum to Tor-Review 44)', () => {
  it('U10. A validly sealed ticket deposited at an A stock key address with no producer report → exactly P-Commit fails with `ticket-without-commit`; control holds', async () => {
    const one: GenEvent[] = [{ k: 'introduce' }]
    const control = await runSequence(cand, one, { seed: 21, reseed })
    for (const c of control.checks) expect(c.violations, c.property).toEqual([])
    const r = await runSequence(cand, one, { seed: 21, reseed, mutation: unreportedTicket })
    // Soll P-Commit: the real issuance as in U0 (2 tickets, 1 issuance, bound). The extra frame is at a stock key address
    // of an observed device (A's allocator), no producer reported it, so the ledger opens it with that key: it opens to a
    // ticket, and no earlier commit of the signing device (M) holds these bytes → 1 violation `ticket-without-commit`.
    // It is not a reported ticket, so `tickets` stays 2. The other checkers: A accepts the extra ticket on a third, unused
    // key (8640 passes: M's signer, own key at the address, voucher not A's) → P-Einmal 3 keys, 3 accepts, no violation;
    // P-Produktion reads the one logged introduction, kept; P-Paar: nothing connected.
    expect(prop(r, 'P-Commit').violations).toHaveLength(1)
    expect(prop(r, 'P-Commit').violations[0]).toContain('ticket-without-commit')
    expect(prop(r, 'P-Commit').counts).toEqual({ tickets: 2, issuances: 1 })
    expect(prop(r, 'P-Einmal')).toMatchObject({ ok: true, counts: { keys: 3, accepts: 3 } })
    expect(prop(r, 'P-Produktion')).toMatchObject({ ok: true, counts: { obliged: 1, kept: 1 } })
    expect(prop(r, 'P-Paar').ok).toBe(true)
  }, 60_000)
})
