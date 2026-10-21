import { describe, expect, it } from 'vitest'
import * as M from '../src/lab/mehrgeraet/model'
import { signerId, TYPES, type HolderDevice } from '../src/lab/mehrgeraet/holder'
import { ledgerWorld, pBilanz } from '../src/lab/mehrgeraet/buch'
import { k2 } from '../src/candidates/mehrgeraet-k2'

// E15 K2 step 2b.1 "allocation by A" (rltp/design/port-experimente-e15-k2-schritt-2b-kern-entwurf-4-2026-10-21.md, Fassung 4,
// §2, §3, §4, §6 "2b.1"; draft 2 §3.1–3.4, §3.6, §3.7; draft 3 §4, §5.4).
//
// Part 1, the fold at M (pure model, §3.3): every row of the set rules in both arrival orders and with duplicates gives the
// same usability per M device (`for`) and the same evidence state; class state (last value per (writer, inc)) apart from
// the tombstones (`bury[]`, B6) with the revocation exception (§4, D4); unknown `for` (MV-22, Q4); equivocation and the
// current listing (highest non-equivocated `rev`, Q6).
//
// Every expected value below is derived by hand from the listed revisions (comment at each), written before the code ran.

// ── Model fixture: M's relationship to A (tuple M:e1, M's own set m1 + m2, A's set a1 + a2) ──
const t0 = '2026-10-17T08:00:00.000Z'
const exp = '2027-04-15T08:00:00.000Z' // t0 + 180 days (8465)
const exp2 = '2027-04-16T08:00:00.000Z'
const SIGNING = 'A'.repeat(43) // 32 bytes base64url (the fold trusts the parser's form check, §3.1)
const PROOF = 'A'.repeat(86) // 64 bytes base64url
const N1 = Buffer.alloc(32, 1).toString('base64')
const N2 = Buffer.alloc(32, 2).toString('base64')
const [a1, a2, m1, m2] = ['a-dev-1', 'a-dev-2', 'm-dev-1', 'm-dev-2']
const [w1, w2] = [signerId(a1), signerId(a2)]
const [i1, i2] = ['inc1inc1inc1inc1', 'inc2inc2inc2inc2']
const REL = 'M:e1'
let seq = 0
const op = (body: Record<string, unknown>, writer = 'w@1') => ({ id: { writer, n: ++seq }, at: t0, ...body }) as unknown as M.Op
const proof = { type: 't', cryptosuite: 'c', created: t0, verificationMethod: 'v', proofPurpose: 'p', proofValue: 'x' }
const cert = (root: string, kind: 'admit' | 'revoke', anchor: string, by = root): M.SetCert => ({ root, kind, anchor, keyAgreement: kind === 'admit' ? `r-${anchor}` : null, by, proof })
const key = (anchor: string, n: number, forM: string, o: { nonce?: string; expiresAt?: string; ka?: string } = {}): M.RevKey => ({ n, nonce: o.nonce ?? N1, anchor, signing: SIGNING, keyAgreement: o.ka ?? `r-${anchor}`, expiresAt: o.expiresAt ?? exp, for: forM, proof: PROOF })
const revision = (writer: string, inc: string, rev: number, keys: M.RevKey[], o: { withdraw?: string[]; bury?: string[]; burn?: string[]; classOff?: true } = {}): M.StockRevision => ({ writer, inc, rev, keys: [...keys].sort((x, y) => M.byCode(x.anchor, y.anchor)), withdraw: [...(o.withdraw ?? [])].sort(), bury: [...(o.bury ?? [])].sort(), burn: [...(o.burn ?? [])].sort(), ...(o.classOff ? { classOff: true as const } : {}) })
const sr = (r: M.StockRevision) => op({ kind: 'stock-revision', rel: REL, scope: REL, revision: r })
const ownSet = (certs: M.SetCert[]) => op({ kind: 'device-set', root: m1, rootKeyAgreement: `r-${m1}`, certs, local: M.table([[m1, 'M1']]) })
const aSet = (certs: M.SetCert[]) => op({ kind: 'device-set', root: a1, rootKeyAgreement: `r-${a1}`, certs })
const admitM2 = ownSet([cert(m1, 'admit', m2)])
const admitA2 = aSet([cert(a1, 'admit', a2)])
const revokeA2 = aSet([cert(a1, 'revoke', a2)])

function base(withM2 = true): M.HolderState {
  const s = M.emptyState('M')
  const t: M.Tuple = { id: REL, own: m1, ownKey: `k/${REL}`, peer: a1, peerKeyAgreement: `r-${a1}`, record: `${REL}:own`, openedAt: t0, candidates: [], deactivated: false }
  M.apply(s, op({ kind: 'open-tuple', rel: null, tuple: t, provenance: 'encounter', vouchedBy: null, act: null }))
  M.apply(s, ownSet([]))
  M.apply(s, admitA2)
  if (withM2) M.apply(s, admitM2)
  return s
}
/** What the test compares per order: usable anchors for m1 and for m2, the evidence state of each named anchor, class, findings of 2b.1. */
function see(s: M.HolderState, anchors: string[]) {
  const use = (d: string) => M.usableView(s, REL, t0, new Set([d])).unconsumed.map((k) => k.anchor)
  const ev = Object.fromEntries(anchors.map((a) => [a, M.evidence(s, REL, a)]))
  const kinds = ['conflict:assignment:', 'doppelte-bindung:', 'conflict:nonce:', 'equivocation:', 'fremder-anker:']
  return { m1: use(m1), m2: use(m2), ev, classOff: M.classOff(s, REL), findings: s.findings.filter((f) => kinds.some((k) => f.startsWith(k))).sort() }
}
/** Forward, reverse, every op twice (fresh op ids, as a sibling's journal batch has), and seeded shuffles with duplicates. */
function orders(ops: M.Op[]): Array<{ name: string; ops: M.Op[] }> {
  const dup = (o: M.Op) => ({ ...structuredClone(o), id: { writer: 'sibling@2', n: ++seq } }) as M.Op
  const out = [
    { name: 'forward', ops },
    { name: 'reverse', ops: [...ops].reverse() },
    { name: 'duplicates', ops: [...ops, ...[...ops].reverse().map(dup)] },
  ]
  let r = 2026
  const next = () => ((r = (r * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  for (let i = 0; i < 6; i++) {
    const all = [...ops, ...ops.filter(() => next() < 0.5).map(dup)]
    out.push({ name: `shuffle ${i}`, ops: all.map((o) => ({ o, k: next() })).sort((x, y) => x.k - y.k).map((x) => x.o) })
  }
  return out
}
function holds(ops: M.Op[], anchors: string[], want: ReturnType<typeof see>, start: () => M.HolderState = () => base()) {
  for (const o of orders(ops)) {
    const s = start()
    for (const x of o.ops) M.apply(s, x)
    expect(see(s, anchors), o.name).toEqual(want)
  }
}
const ev = (state: M.Evidence['state'], conflict = false): M.Evidence => ({ state, conflict })
const none: string[] = []

describe('K2 step 2b.1, part 1: set rules at M as functions of the folded set (§3.3), every order, with duplicates', () => {
  it('Z1. One binding: a listing of x for m1 and y for m2 by A1; m1 may name x only, m2 y only (the `for` filter)', () => {
    // Soll: x bound to (w1, i1, for m1), y to (w1, i1, for m2); both listed; m1 → [x], m2 → [y]; no finding.
    holds([sr(revision(w1, i1, 1, [key('x', 0, m1), key('y', 1, m2)]))], ['x', 'y'], { m1: ['x'], m2: ['y'], ev: { x: ev('listed'), y: ev('listed') }, classOff: false, findings: none })
  })

  it('Z2. A binding of w with a differing immutable field: conflict mark, for ever, beats every higher listing (expiresAt; inc)', () => {
    // Soll (expiresAt): rev 1 lists x with exp, rev 2 lists x with exp2 (same writer, inc) → conflict:assignment:x; rev 3
    // lists x with exp again (higher) → x stays unusable; y in rev 3 is usable. Evidence x: listed (rev 3 is current) with
    // conflict; y listed.
    holds(
      [sr(revision(w1, i1, 1, [key('x', 0, m1)])), sr(revision(w1, i1, 2, [key('x', 0, m1, { expiresAt: exp2 })])), sr(revision(w1, i1, 3, [key('x', 0, m1), key('y', 1, m1)]))],
      ['x', 'y'],
      { m1: ['y'], m2: none, ev: { x: ev('listed', true), y: ev('listed') }, classOff: false, findings: ['conflict:assignment:x'] },
    )
    // Soll (inc): the same anchor under two incarnations of w1 (a restore input in the core, 0.2) → conflict, x unusable.
    holds([sr(revision(w1, i1, 1, [key('x', 0, m1)])), sr(revision(w1, i2, 1, [key('x', 0, m1)]))], ['x'], { m1: none, m2: none, ev: { x: ev('listed', true) }, classOff: false, findings: ['conflict:assignment:x'] })
  })

  it('Z3. Faulty A: two writers bind the same anchor (only with a shared private part) → conflict mark and `doppelte-bindung`', () => {
    // Soll: x listed by w1 and by w2 with identical fields → conflict:assignment:x and doppelte-bindung:x; unusable for all.
    holds([sr(revision(w1, i1, 1, [key('x', 0, m1)])), sr(revision(w2, i2, 1, [key('x', 0, m1)]))], ['x'], { m1: none, m2: none, ev: { x: ev('listed', true) }, classOff: false, findings: ['conflict:assignment:x', 'doppelte-bindung:x'] })
  })

  it('Z4. Withdrawal by the bound writer is effective, also before the binding arrives (withdrawal before refill)', () => {
    // Soll: rev 1 lists x, y; rev 2 lists y only and withdraws x → x withdrawn, y usable. In reverse order the withdrawal
    // arrives first: still withdrawn (a set, not a latch on arrival).
    holds([sr(revision(w1, i1, 1, [key('x', 0, m1), key('y', 1, m1)])), sr(revision(w1, i1, 2, [key('y', 1, m1)], { withdraw: ['x'] }))], ['x', 'y'], { m1: ['y'], m2: none, ev: { x: ev('withdrawn'), y: ev('listed') }, classOff: false, findings: none })
    // Soll: a withdrawal of an anchor never listed (z) stays kept and harmless; a later listing of z by the same writer under
    // a higher rev does not revive it (withdrawal before refill: the set wins).
    holds([sr(revision(w1, i1, 1, [key('y', 1, m1)], { withdraw: ['z'] })), sr(revision(w1, i1, 2, [key('y', 1, m1), key('z', 2, m1)]))], ['y', 'z'], { m1: ['y'], m2: none, ev: { y: ev('listed'), z: ev('withdrawn') }, classOff: false, findings: none })
  })

  it('Z5. A foreign withdrawal is ineffective (`fremder-anker`), kept per (w′, anchor)', () => {
    // Soll: w1 lists x; w2 withdraws x → x stays usable for m1, finding fremder-anker:<w2>:x.
    holds([sr(revision(w1, i1, 1, [key('x', 0, m1)])), sr(revision(w2, i2, 1, [], { withdraw: ['x'] }))], ['x'], { m1: ['x'], m2: none, ev: { x: ev('listed') }, classOff: false, findings: [`fremder-anker:${w2}:x`] })
  })

  it('Z6. `bury` with class off: tombstone; class on again with fresh anchors: the buried anchor stays buried, the fresh one is usable', () => {
    // Soll: rev 1 lists x; rev 2 classOff with bury [x] (keys empty); rev 3 lists y without classOff → class on (last value),
    // x buried (withdrawn), y usable.
    holds([sr(revision(w1, i1, 1, [key('x', 0, m1)])), sr(revision(w1, i1, 2, [], { classOff: true, bury: ['x'], withdraw: ['x'] })), sr(revision(w1, i1, 3, [key('y', 1, m1)]))], ['x', 'y'], { m1: ['y'], m2: none, ev: { x: ev('withdrawn'), y: ev('listed') }, classOff: false, findings: none })
  })

  it('Z7. Off → on → late old off revision: the class state stays on (last value by rev), the late `bury` buries only what it names and the own anchors of lower revs', () => {
    // Soll: rev 1 lists x; rev 2 off (bury [x]); rev 3 on, lists y. Whatever arrives last: class on, x buried, y usable.
    // Here only the order of rev 2 and rev 3 matters; the shuffles cover it.
    holds([sr(revision(w1, i1, 1, [key('x', 0, m1)])), sr(revision(w1, i1, 3, [key('y', 1, m1)])), sr(revision(w1, i1, 2, [], { classOff: true, bury: ['x'] }))], ['x', 'y'], { m1: ['y'], m2: none, ev: { x: ev('withdrawn'), y: ev('listed') }, classOff: false, findings: none })
    // Soll: an off revision buries the own anchors of lower revs even if its bury[] does not name them: rev 1 lists x,
    // rev 2 off with bury [] (issuer forgot x) → x buried; class off.
    holds([sr(revision(w1, i1, 1, [key('x', 0, m1)])), sr(revision(w1, i1, 2, [], { classOff: true }))], ['x'], { m1: none, m2: none, ev: { x: ev('withdrawn') }, classOff: true, findings: none })
  })

  it('Z8. Class off of any non-revoked writer wins for the person ("aus gewinnt", 4.10): A2 off makes A1\'s keys unusable while it lasts', () => {
    // Soll: w1 lists x (on); w2 rev 1 off with bury [] → person off → nothing usable; x not buried (w2's bury does not name it).
    holds([sr(revision(w1, i1, 1, [key('x', 0, m1)])), sr(revision(w2, i2, 1, [], { classOff: true }))], ['x'], { m1: none, m2: none, ev: { x: ev('listed') }, classOff: true, findings: none })
  })

  it('Z9. Revocation exception (B6, D4): a revoked issuer\'s tombstone counts only for anchors no non-revoked writer currently lists', () => {
    // Fixture: w1 lists x unchanged; w2 (A2) turns the class off and buries x (any member may bury any anchor, B6).
    const ops = [sr(revision(w1, i1, 1, [key('x', 0, m1)])), sr(revision(w2, i2, 1, [], { classOff: true, bury: ['x'] }))]
    // Soll, w2 revoked: its class off does not count, its tombstone neither (w1 currently lists x) → x usable, listed.
    holds([...ops, revokeA2], ['x'], { m1: ['x'], m2: none, ev: { x: ev('listed') }, classOff: false, findings: none })
    // Soll, w2 not revoked but on again (rev 2 without classOff): the tombstone of a non-revoked issuer is final → x buried;
    // the class is on.
    holds([...ops, sr(revision(w2, i2, 2, []))], ['x'], { m1: none, m2: none, ev: { x: ev('withdrawn') }, classOff: false, findings: none })
  })

  it('Z10. Q6: tombstone of a revoked issuer, listing, unlisting, equivocation of the unlisting: evidence is a function of the set, not a latch', () => {
    // Fixture: w2 buries x (off, then on again) and is revoked; w1 rev 1 lists x, rev 2 unlists it (lists y).
    const head = [sr(revision(w2, i2, 1, [], { classOff: true, bury: ['x'] })), sr(revision(w2, i2, 2, [])), revokeA2, sr(revision(w1, i1, 1, [key('x', 0, m1)])), sr(revision(w1, i1, 2, [key('y', 1, m1)]))]
    // Soll: nobody non-revoked currently lists x (w1's current is rev 2) → the revoked issuer's tombstone counts → x withdrawn.
    holds(head, ['x', 'y'], { m1: ['y'], m2: none, ev: { x: ev('withdrawn'), y: ev('listed') }, classOff: false, findings: none })
    // Soll: a second rev 2 of (w1, i1) with other bytes (lists z) → rev 2 equivocated, current falls back to rev 1, which lists
    // x → the revoked tombstone no longer counts → x listed and usable again; y, z only in equivocated versions → unlisted.
    holds([...head, sr(revision(w1, i1, 2, [key('z', 2, m1)]))], ['x', 'y', 'z'], { m1: ['x'], m2: none, ev: { x: ev('listed'), y: ev('unlisted'), z: ev('unlisted') }, classOff: false, findings: [`equivocation:${w1}:${i1}:2`] })
  })

  it('Z11. Unknown `for` (MV-22, Q4): folded, usable for nobody until the set knowledge brings the member; set revision before or after the listing', () => {
    // Soll without m2's admission: y (for m2) is bound and listed but usable for nobody; no finding.
    holds([sr(revision(w1, i1, 1, [key('x', 0, m1), key('y', 1, m2)]))], ['x', 'y'], { m1: ['x'], m2: none, ev: { x: ev('listed'), y: ev('listed') }, classOff: false, findings: none }, () => base(false))
    // Soll with the admission in either order: y usable for exactly m2.
    holds([sr(revision(w1, i1, 1, [key('x', 0, m1), key('y', 1, m2)])), admitM2], ['x', 'y'], { m1: ['x'], m2: ['y'], ev: { x: ev('listed'), y: ev('listed') }, classOff: false, findings: none }, () => base(false))
  })

  it('Z12. Nonce conflict within (writer, inc): no listing of that (writer, inc) usable; withdraw, bury, burn from it still effective', () => {
    // Soll: rev 1 lists x (nonce N1), rev 2 lists x, y (nonce N2) and withdraws v of w1's (w1, i2) listing → conflict:nonce
    // for (w1, i1); x and y unusable (x also differs in nonce → conflict:assignment:x); v (bound to w1 via i2) withdrawn;
    // u (also (w1, i2)) stays usable.
    holds(
      [sr(revision(w1, i2, 1, [key('u', 7, m1, { nonce: N2 }), key('v', 8, m1, { nonce: N2 })])), sr(revision(w1, i1, 1, [key('x', 0, m1)])), sr(revision(w1, i1, 2, [key('x', 0, m1, { nonce: N2 }), key('y', 1, m1, { nonce: N2 })], { withdraw: ['v'] }))],
      ['u', 'v', 'x', 'y'],
      { m1: ['u'], m2: none, ev: { u: ev('listed'), v: ev('withdrawn'), x: ev('listed', true), y: ev('listed', true) }, classOff: false, findings: ['conflict:assignment:x', `conflict:nonce:${w1}:${i1}`] },
    )
  })

  it('Z13. Equivocation: current listing = highest non-equivocated rev, before and after a higher revision; all equivocated → no current listing, no class value, withdrawals still effective', () => {
    // Soll: rev 1 lists x; two different rev 2 (lists y | lists z) → rev 2 equivocated → current rev 1 → x usable, y, z unlisted.
    const eq = [sr(revision(w1, i1, 1, [key('x', 0, m1)])), sr(revision(w1, i1, 2, [key('y', 1, m1)])), sr(revision(w1, i1, 2, [key('z', 2, m1)]))]
    holds(eq, ['x', 'y', 'z'], { m1: ['x'], m2: none, ev: { x: ev('listed'), y: ev('unlisted'), z: ev('unlisted') }, classOff: false, findings: [`equivocation:${w1}:${i1}:2`] })
    // Soll: a rev 3 listing y (before or after the equivocation) is current → y usable; x, z unlisted.
    holds([...eq, sr(revision(w1, i1, 3, [key('y', 1, m1)]))], ['x', 'y', 'z'], { m1: ['y'], m2: none, ev: { x: ev('unlisted'), y: ev('listed'), z: ev('unlisted') }, classOff: false, findings: [`equivocation:${w1}:${i1}:2`] })
    // Soll: only rev 1, twice (one off with withdraw [q], one listing q): all equivocated → no current listing, the off value
    // does not count, the withdrawal of q is effective (q withdrawn), nothing usable.
    holds([sr(revision(w1, i1, 1, [key('q', 0, m1)])), sr(revision(w1, i1, 1, [], { classOff: true, withdraw: ['q'] }))], ['q'], { m1: none, m2: none, ev: { q: ev('withdrawn') }, classOff: false, findings: [`equivocation:${w1}:${i1}:1`] })
  })

  it('Z14. Lower and equal rev: a late lower revision changes no listing; the same bytes again are nothing new', () => {
    // Soll: rev 2 lists x, y; a late rev 1 lists x only → current rev 2 → x, y usable; rev 2 again (same bytes) → no
    // equivocation.
    const r2 = revision(w1, i1, 2, [key('x', 0, m1), key('y', 1, m1)])
    holds([sr(r2), sr(revision(w1, i1, 1, [key('x', 0, m1)])), sr(structuredClone(r2))], ['x', 'y'], { m1: ['x', 'y'], m2: none, ev: { x: ev('listed'), y: ev('listed') }, classOff: false, findings: none })
  })

  it('Z15. A conflict persists after an empty revision', () => {
    // Soll: x in conflict (two expiresAt), then rev 3 empty → x unlisted, still conflict; nothing usable.
    holds([sr(revision(w1, i1, 1, [key('x', 0, m1)])), sr(revision(w1, i1, 2, [key('x', 0, m1, { expiresAt: exp2 })])), sr(revision(w1, i1, 3, []))], ['x'], { m1: none, m2: none, ev: { x: ev('unlisted', true) }, classOff: false, findings: ['conflict:assignment:x'] })
  })

  it('Z16. `burn` (format; no restore use in the core): a burnt incarnation lists nothing usable', () => {
    // Soll: (w1, i1) lists x; (w1, i2) burns i1 and lists y → x withdrawn, y usable.
    holds([sr(revision(w1, i1, 1, [key('x', 0, m1)])), sr(revision(w1, i2, 1, [key('y', 1, m1, { nonce: N2 })], { burn: [i1] }))], ['x', 'y'], { m1: ['y'], m2: none, ev: { x: ev('withdrawn'), y: ev('listed') }, classOff: false, findings: none })
  })

  it('Z17. Revoked writer: its listings are not usable (the revocation buries its anchors, draft 3 §5.4), the remaining writer is', () => {
    // Soll: w1 lists x, w2 lists y; w2 revoked → y withdrawn, x usable.
    holds([sr(revision(w1, i1, 1, [key('x', 0, m1)])), sr(revision(w2, i2, 1, [key('y', 1, m1, { nonce: N2 })])), revokeA2], ['x', 'y'], { m1: ['x'], m2: none, ev: { x: ev('listed'), y: ev('withdrawn') }, classOff: false, findings: none })
  })

  it('Z19. The folded set survives an image (JSON) and the projection carries it (two devices compare it in `agree`)', () => {
    const s = base()
    for (const o of [sr(revision(w1, i1, 1, [key('x', 0, m1)])), sr(revision(w1, i1, 2, [], { classOff: true, bury: ['x'] }))]) M.apply(s, o)
    const back = M.fromJson(JSON.parse(JSON.stringify(s)) as M.HolderState)
    expect(see(back, ['x'])).toEqual(see(s, ['x']))
    expect((M.project(back, t0).contacts[0]!.view as M.StockView).revs).toEqual(M.rel(s, REL).view!.revs)
  })

  it('Z18. The op is form-checked like every journal op (MV-24): a revision without `proof` is not an op', () => {
    const good = sr(revision(w1, i1, 1, [key('x', 0, m1)]))
    expect(M.opProblem(good)).toBe(null)
    const bad = structuredClone(good) as unknown as { revision: { keys: Array<Record<string, unknown>> } }
    delete bad.revision.keys[0]!.proof
    expect(M.opProblem(bad)).not.toBe(null)
  })
})

// ── Part 2: the allocator and the parser in a world (holder, carrier, journal) ──

type Raw = { sendDoc(type: string, ctx: string, peer: string, peerKa: string, rkid: string, payload: Record<string, unknown>): Promise<{ digest: string } | null>; completed: Set<string>; anchorOfCtx: Map<string, string> }
const raw = (d: HolderDevice) => d as unknown as Raw
const DAY = 24 * 3600 * 1000

/**
 * A world: A1 (and A2), B1, M1 (and M2 enrolled before or after the class goes on), class on at A and B for M. Default
 * budget 10, two slots per person: share 5 per device (MV-9).
 */
async function zw(o: { budget?: number; a2?: boolean; m2?: 'before' | 'after' } = {}) {
  const { w, buch } = ledgerWorld(k2(o.budget ? { budget: o.budget } : {}))
  const A = await w.person('A', 'A1')
  const B = await w.person('B', 'B1')
  const Mm = await w.person('M', 'M1')
  const am = await w.encounter(A, Mm)
  const bm = await w.encounter(B, Mm)
  await w.rounds(2)
  let M2: HolderDevice | undefined
  if (o.m2 === 'before') {
    M2 = await w.enrol(Mm, 'M2')
    await w.rounds(3)
  }
  await A.setClass(am.x.id, true)
  await B.setClass(bm.x.id, true)
  await w.rounds(3)
  const A2 = o.a2 ? await w.enrol(A, 'A2') : undefined
  if (A2) await w.rounds(3)
  if (o.m2 === 'after') {
    M2 = await w.enrol(Mm, 'M2')
    await w.rounds(3)
  }
  /** M device d's anchor in its relationship to A (the `for` of keys assigned to it). */
  const anchorAt = async (d: HolderDevice, rel = am.y.id) => (await d.cand.keys.pair(M.head(M.rel(d.state, rel)).ownKey)).anchor
  /** A device's own keys in the relationship to M, optionally assigned to M device `m` and in state `state`. */
  const own = (d: HolderDevice, forM?: string, state?: M.StockState) => M.rel(d.state, am.x.id).stock.filter((k) => k.by === d.name && (forM === undefined || k.for === forM) && (state === undefined || k.state === state))
  const nameable = (m: HolderDevice, rel = am.y.id) => m.stockAt(M.relOfTuple(m.state, rel)!.id).nameable
  return { w, buch, A, A2, B, Mm, M2, am, bm, anchorAt, own, nameable }
}
/** `stock-revision@2` of device d in rel as d would build it; `signer` signs the proofs (the faulty-A fixture), `o` overrides. */
async function craft(d: HolderDevice, rel: string, o: { rev?: number; keys?: M.StockKey[]; withdraw?: string[]; bury?: string[]; classOff?: true; signer?: HolderDevice } = {}): Promise<M.StockRevision> {
  const r = M.rel(d.state, rel)
  const writer = signerId((await d.cand.keys.pair(M.head(r).ownKey)).anchor)
  const inc = d.cand.incTag!(rel)
  const keys: M.RevKey[] = []
  for (const k of [...(o.keys ?? [])].sort((a, b) => M.byCode(a.anchor, b.anchor))) {
    const ks = await (o.signer ?? d).cand.keys.pair(k.key)
    const body = { n: k.n, nonce: k.nonce, anchor: k.anchor, keyAgreement: k.keyAgreement, expiresAt: k.expiresAt, for: k.for! }
    keys.push({ ...body, signing: Buffer.from(ks.ed.pubRaw).toString('base64url'), proof: Buffer.from(await crypto.subtle.sign('Ed25519', ks.ed.priv, M.proofContent(writer, inc, body) as BufferSource)).toString('base64url') })
  }
  return { writer, inc, rev: o.rev ?? (M.own(r.writers, `${writer}.${inc}`)?.revision ?? 0) + 1, keys, withdraw: [...(o.withdraw ?? [])].sort(M.byCode), bury: [...(o.bury ?? [])].sort(M.byCode), burn: [], ...(o.classOff ? { classOff: true as const } : {}) }
}
async function send(d: HolderDevice, rel: string, payload: unknown, type: string = TYPES.stockRevision) {
  const h = M.head(M.rel(d.state, rel))
  return raw(d).sendDoc(type, h.ownKey, h.peer, h.peerKeyAgreement, (await d.cand.keys.pair(h.ownKey)).rkid, payload as Record<string, unknown>)
}

describe('K2 step 2b.1, part 2: format and parser (MV-24, §3.1, §3.2)', () => {
  it('F1. Poison vectors of `stock-revision@2`: each ends with a finding naming the path, unchanged state and head at M, no receipt; the unchanged revision folds', async () => {
    const s = await zw()
    const mRel = () => M.relOfTuple(s.Mm.state, s.am.y.id)!
    const keys = s.own(s.A).slice(0, 2)
    expect(keys).toHaveLength(2)
    const base = await craft(s.A, s.am.x.id, { keys })
    const k0 = base.keys[0]!
    const k1 = base.keys[1]!
    const clone = () => structuredClone(base) as unknown as Record<string, unknown> & { keys: Array<Record<string, unknown>> }
    // Soll per vector: the path the form check names (§3.1 order of checks: shape, writer, rev, bounds, order, class, burn, per key).
    const vectors: Array<[string, () => unknown, string]> = [
      ['missing field', () => { const p = clone(); delete p.keys[0]!.for; return p }, 'stock-revision.keys[0].for'],
      ['listing without proof', () => { const p = clone(); delete p.keys[0]!.proof; return p }, 'stock-revision.keys[0].proof'],
      ['wrong proof', () => { const p = clone(); p.keys[0]!.proof = k1.proof; return p }, 'stock-revision.keys[0].proof'],
      ['bury without classOff', () => ({ ...clone(), bury: [k0.anchor] }), 'stock-revision.bury(classOff)'],
      ['non-integer n', () => { const p = clone(); p.keys[0]!.n = 1.5; return p }, 'stock-revision.keys[0].n'],
      ['n out of range', () => { const p = clone(); p.keys[0]!.n = 2 ** 32; return p }, 'stock-revision.keys[0].n'],
      ['duplicate anchors', () => ({ ...clone(), keys: [k0, k0] }), 'stock-revision.keys(order)'],
      ['non-canonical bytes: keys unsorted', () => ({ ...clone(), keys: [k1, k0] }), 'stock-revision.keys(order)'],
      ['non-canonical bytes: classOff false', () => ({ ...clone(), classOff: false }), 'stock-revision.classOff'],
      ['non-canonical bytes: withdraw unsorted', () => ({ ...clone(), withdraw: [k1.anchor, k0.anchor].sort().reverse() }), 'stock-revision.withdraw(order)'],
      ['writer is not the signer', () => ({ ...clone(), writer: signerId('someone-else') }), 'stock-revision.writer'],
      ['rev 0', () => ({ ...clone(), rev: 0 }), 'stock-revision.rev'],
      ['burn of the running inc', () => ({ ...clone(), burn: [base.inc] }), 'stock-revision.burn(inc)'],
      ['anchor not of signing', () => { const p = clone(); p.keys[0]!.signing = k1.signing; return p }, 'stock-revision.keys[0].anchor'],
      ['two nonces in one revision', () => { const p = clone(); p.keys[1]!.nonce = Buffer.alloc(32, 9).toString('base64'); return p }, 'stock-revision.keys[1].nonce'],
      ['for not an anchor', () => { const p = clone(); p.keys[0]!.for = 'not-an-anchor'; return p }, 'stock-revision.keys[0].for'],
    ]
    for (const [name, make, path] of vectors) {
      const view = M.canonical(mRel().view)
      const sent = await send(s.A, s.am.x.id, make())
      await s.w.rounds(2)
      expect(raw(s.Mm).completed.has(sent!.digest), name).toBe(false)
      expect(s.Mm.state.findings.some((f) => f.startsWith('stock-revision von') && f.includes(`Form ${path} (MV-24)`)), `${name}: ${s.Mm.state.findings.slice(-3).join(' | ')}`).toBe(true)
      expect(M.canonical(mRel().view), name).toBe(view)
    }
    // Control: the unchanged revision is folded and receipted.
    const ok = await send(s.A, s.am.x.id, base)
    await s.w.rounds(2)
    expect(raw(s.Mm).completed.has(ok!.digest)).toBe(true)
    expect(mRel().view!.revs!.some((r) => M.canonical(r) === M.canonical(base))).toBe(true)
  }, 120_000)
})

describe('K2 step 2b.1, part 2: `for` at M and at A', () => {
  it('W1. m2 names m1\'s key (test hook on m2\'s own anchors): A refuses without an act (`fremde-zuteilung`), no receipt, no budget load; B accepts its side', async () => {
    const s = await zw({ m2: 'before' })
    const m1 = await s.anchorAt(s.Mm)
    const m2 = await s.anchorAt(s.M2!)
    // Soll of the supply (share 5, |M| = 2): empties first by anchor (1 + 1), then to_am = ⌊5/2⌋ = 2 each → 2 + 2, 1 free.
    expect([s.own(s.A, m1).length, s.own(s.A, m2).length]).toEqual([2, 2])
    expect([s.nameable(s.Mm), s.nameable(s.M2!)]).toEqual([2, 2])
    // Hook: m2 takes m1's anchor for its own in the A relationship (choice and ticket context), and its rights check passes.
    const t = M.relOfTuple(s.M2!.state, s.am.y.id)!.tuples[0]!
    raw(s.M2!).anchorOfCtx.set(t.ownKey, m1)
    ;(s.M2!.cand as { authorize?: unknown }).authorize = () => true
    const r = await s.M2!.introduce(s.am.y.id, s.bm.y.id)
    expect('act' in r).toBe(true)
    const act = s.M2!.state.mediatorActs.at(-1)!
    expect(s.own(s.A).find((k) => k.anchor === act.a.key)!.for).toBe(m1)
    await s.w.rounds(4)
    // Soll: A 0 acts, 1 finding `fremde-zuteilung`, the key still active, belegt 0; B 1 act (its key is assigned to m2).
    expect(s.A.state.acts).toHaveLength(0)
    expect(s.A.state.findings.filter((f) => f.includes('fremde-zuteilung'))).toHaveLength(1)
    expect(s.own(s.A).find((k) => k.anchor === act.a.key)!.state).toBe('active')
    expect((s.A.cand as { occupied(rel: string, st: M.HolderState, now: string): number }).occupied(s.am.x.id, s.A.state, s.w.clock.now())).toBe(0)
    expect(s.B.state.acts.map((a) => a.id)).toEqual([act.id])
  }, 120_000)

  it('W2. Faulty A (fixture sharing the private part): A2 lists A1\'s key with a valid proof → conflict mark and `doppelte-bindung` at both M devices (direct and via the journal), the key unusable, the others usable', async () => {
    const s = await zw({ a2: true, m2: 'before' })
    const m1 = await s.anchorAt(s.Mm)
    const x = s.own(s.A, m1)[0]!
    const before = s.nameable(s.Mm)
    // M2 gets A's revisions only through M1's journal from here on.
    s.w.carrier.faults.withhold('M2', (f) => s.w.frameOrigin(f.bytes)?.kind === 'stock-revision')
    // A2's revision lists x alone (proof by A1's private part): one nonce per revision (§3.1), so it is A2's complete listing.
    await send(s.A2!, s.am.x.id, await craft(s.A2!, s.am.x.id, { keys: [x], signer: s.A }))
    await s.w.rounds(4)
    for (const m of [s.Mm, s.M2!]) {
      const rel = M.relOfTuple(m.state, s.am.y.id)!.id
      expect(m.state.findings, m.name).toContain(`doppelte-bindung:${x.anchor}`)
      expect(m.state.findings, m.name).toContain(`conflict:assignment:${x.anchor}`)
      expect(M.evidence(m.state, rel, x.anchor), m.name).toEqual({ state: 'listed', conflict: true })
    }
    // Soll: before = 2 keys of A1 + 2 of A2 for m1; m1 loses x (conflict) and A2's two (A2's current listing is now [x]) → 1.
    expect(before).toBe(4)
    expect(s.nameable(s.Mm)).toBe(1)
    s.w.carrier.faults.reset()
  }, 120_000)

  it('W3. The fold over the journal: an M device that gets A\'s revisions only through its sibling\'s journal has the same usability and evidence per `for` (withdrawal, class off, class on); the late direct copies change nothing', async () => {
    const s = await zw({ m2: 'before' })
    const m1 = await s.anchorAt(s.Mm)
    const m2 = await s.anchorAt(s.M2!)
    s.w.carrier.faults.withhold('M2', (f) => s.w.frameOrigin(f.bytes)?.kind === 'stock-revision')
    const same = () => {
      const r1 = M.relOfTuple(s.Mm.state, s.am.y.id)!.id
      const r2 = M.relOfTuple(s.M2!.state, s.am.y.id)!.id
      const anchors = s.own(s.A).map((k) => k.anchor)
      for (const forM of [m1, m2]) expect(M.usableView(s.M2!.state, r2, s.w.clock.now(), new Set([forM])).listed, forM.slice(-6)).toEqual(M.usableView(s.Mm.state, r1, s.w.clock.now(), new Set([forM])).listed)
      for (const a of anchors) expect(M.evidence(s.M2!.state, r2, a), a.slice(-6)).toEqual(M.evidence(s.Mm.state, r1, a))
    }
    await s.A.withdrawStock(s.am.x.id, [s.own(s.A, m2)[0]!.anchor])
    await s.w.rounds(4)
    same()
    await s.A.setClass(s.am.x.id, false)
    await s.w.rounds(4)
    same()
    expect(M.classOff(s.M2!.state, M.relOfTuple(s.M2!.state, s.am.y.id)!.id)).toBe(true)
    await s.A.setClass(s.am.x.id, true)
    await s.w.rounds(4)
    same()
    // Soll after class on: every own key was withdrawn at class off (reserviert 0, frei 5): empties first (1 + 1), then
    // to_am 2 → 2 + 2 fresh keys; at each M device exactly its own 2.
    expect([s.nameable(s.Mm), s.nameable(s.M2!)]).toEqual([2, 2])
    s.w.carrier.faults.reset()
    await s.w.rounds(3)
    same()
    expect([s.nameable(s.Mm), s.nameable(s.M2!)]).toEqual([2, 2])
  }, 120_000)
})

describe('K2 step 2b.1, part 2: balance and supply (§2.1, §2.3)', () => {
  it('B1. Small quota (frei_zuteilbar = 1, two M devices): the empty device gets the right; before that it refuses (`kein benennbarer Schlüssel`)', async () => {
    // budget 4 → share 2 per device. M1 alone at class on: to_am = 2 → 2 keys for m1, frei 0. M2 enrolled: empty, frei 0.
    const s = await zw({ budget: 4, m2: 'after' })
    const m1 = await s.anchorAt(s.Mm)
    const m2 = await s.anchorAt(s.M2!)
    expect([s.own(s.A, m1).length, s.own(s.A, m2).length]).toEqual([2, 0])
    expect('refused' in (await s.M2!.introduce(s.am.y.id, s.bm.y.id))).toBe(true)
    // M1 introduces A–B; A1 accepts (belegt 1, reserviert 1, frei 0); A1 confirms (8515: belegt 0, frei 1) → m1 has 1
    // usable key (not empty), m2 none (empty) → m2 gets the one right; to_am = ⌊2/2⌋ = 1, m1 at 1: nothing more.
    const r = await s.Mm.introduce(s.am.y.id, s.bm.y.id)
    expect('act' in r).toBe(true)
    await s.w.rounds(3)
    expect(s.A.state.acts).toHaveLength(1)
    expect(s.own(s.A, m2)).toHaveLength(0)
    await s.A.confirmBudget(s.am.x.id)
    await s.w.rounds(3)
    expect(s.own(s.A, m2, 'active')).toHaveLength(1)
    expect(s.own(s.A, m1, 'active')).toHaveLength(1)
    expect(s.nameable(s.M2!)).toBe(1)
    expect(pBilanz(s.buch, 2).ok).toBe(true)
  }, 120_000)

  it('B2. Full reservation does not supply; at the first `expiresAt` the rights free and the empty device is supplied (rounds from `prekeyLifetimeMs`); the 8470 gap before it; 8475.S8 retires the old keys', async () => {
    const s = await zw({ m2: 'after' })
    const m1 = await s.anchorAt(s.Mm)
    const m2 = await s.anchorAt(s.M2!)
    // Soll: 5 keys for m1 (|M| = 1 at class on: to_am = 5), all allocated at t0, expiresAt = t0 + 180 d; m2 empty, frei 0.
    expect([s.own(s.A, m1).length, s.own(s.A, m2).length]).toEqual([5, 0])
    s.w.clock.advance(172 * DAY)
    await s.w.rounds(2)
    // Day 172: 172 d + 7 d + 1 h ≤ 180 d (8470): m1 names its 5; m2 still nothing.
    expect([s.nameable(s.Mm), s.nameable(s.M2!)]).toEqual([5, 0])
    let steps = 0
    let gap = 0
    while (s.nameable(s.M2!) === 0 && steps < 20) {
      s.w.clock.advance(DAY)
      await s.w.rounds(2)
      steps++
      if (s.nameable(s.Mm) === 0 && s.nameable(s.M2!) === 0) gap++
    }
    // Soll: days 173–180 the keys are aging (not nameable, 8470) but still reserved (now ≤ expiresAt): 8 steps with no
    // nameable A key anywhere; day 181 (step 9) frees 5 rights: both devices empty → 1 + 1, to_am 2 → 2 + 2.
    expect(steps).toBe(9)
    expect(gap).toBe(8)
    expect([s.own(s.A, m1, 'active').length, s.own(s.A, m2, 'active').length]).toEqual([2, 2])
    expect([s.nameable(s.Mm), s.nameable(s.M2!)]).toEqual([2, 2])
    expect(s.own(s.A, m1, 'aging')).toHaveLength(5)
    // 8475.S8: after expiresAt + key-retention (day 270) the five old keys are tombstones at A.
    s.w.clock.advance(90 * DAY)
    await s.w.rounds(2)
    expect(s.own(s.A, m1, 'tombstoned')).toHaveLength(5)
    expect(pBilanz(s.buch, 5).ok).toBe(true)
  }, 300_000)

  it('B3. `aging` with a ticket in flight does not exceed the share: no refill while aging keys are reserved; the late acceptance fits (P-Bilanz max 5)', async () => {
    const s = await zw()
    s.w.clock.advance(172 * DAY)
    await s.w.rounds(2)
    s.w.carrier.faults.withhold('A1', (f) => s.w.frameOrigin(f.bytes)?.kind === 'introduction-ticket')
    const r = await s.Mm.introduce(s.am.y.id, s.bm.y.id)
    expect('act' in r).toBe(true)
    s.w.clock.advance(2 * DAY)
    await s.w.rounds(3)
    // Day 174: all 5 own keys aging (8470), still reserved; frei 0: no new key.
    expect(s.own(s.A, undefined, 'aging')).toHaveLength(5)
    expect(s.own(s.A, undefined, 'active')).toHaveLength(0)
    s.w.carrier.faults.reset()
    await s.w.rounds(3)
    // Soll: the ticket (act until day 179, key until day 180, 8640.7) is accepted: belegt 1 + reserviert 4 = 5.
    expect(s.A.state.acts).toHaveLength(1)
    const bal = pBilanz(s.buch, 5)
    expect(bal.ok, bal.violations.join('\n')).toBe(true)
    expect(bal.counts.max).toBe(5)
  }, 120_000)

  it('B4. Revocation of an M device: A withdraws every live key assigned to it and lists the successors in the same batch; M names the rest (Tor-Review 46 B1: batch content and numbers)', async () => {
    for (const o of [{ budget: undefined, gone: 2, add: 3, listed: 5 }, { budget: 4, gone: 1, add: 1, listed: 2 }] as const) {
      // Soll, share 5 (default): supply at class on with |M| = 2: 1 + 1, then to_am ⌊5/2⌋ = 2 → 2 + 2, frei 1. Revocation of
      // M2: withdraw its 2 keys → reserviert 2, frei 3, members {m1}, to_am 5, m1 has 2 → allocate 3; the revision lists 5.
      // Soll, share 2 (budget 4): 1 + 1 (to_am ⌊2/2⌋ = 1), frei 0. Revocation: withdraw 1 → frei 1, to_am 2 → allocate 1;
      // the revision lists 2. Both in the one batch of the revocation step (draft 2 §3.7).
      const s = await zw({ m2: 'before', ...(o.budget ? { budget: o.budget } : {}) })
      const m1 = await s.anchorAt(s.Mm)
      const m2 = await s.anchorAt(s.M2!)
      const gone = s.own(s.A, m2).map((k) => k.anchor)
      expect(gone, `share ${o.budget ?? 10}`).toHaveLength(o.gone)
      await s.w.revoke(s.Mm, s.M2!)
      await s.w.rounds(4)
      expect(s.own(s.A, m2, 'withdrawn').map((k) => k.anchor).sort()).toEqual([...gone].sort())
      expect(s.own(s.A, m1, 'active')).toHaveLength(o.listed)
      const batch = (s.A.cand as unknown as { journal(): Array<{ ops: M.Op[] }> }).journal().find((b) => b.ops.some((x) => x.kind === 'withdraw' && gone.every((a) => x.anchors.includes(a))))!
      const kinds = batch.ops.map((x) => x.kind)
      expect(kinds.filter((k) => k === 'withdraw' || k === 'allocate' || k === 'revision')).toEqual(['withdraw', 'allocate', 'revision'])
      const alloc = batch.ops.find((x): x is M.Op & { kind: 'allocate' } => x.kind === 'allocate')!
      expect(alloc.keys.map((k) => k.for)).toEqual(Array(o.add).fill(m1))
      const rev = batch.ops.find((x): x is M.Op & { kind: 'revision' } => x.kind === 'revision')!
      expect(rev.keys.map((k) => k.anchor).sort()).toEqual(s.own(s.A, m1, 'active').map((k) => k.anchor).sort())
      expect(s.nameable(s.Mm)).toBe(o.listed)
      const rel = M.relOfTuple(s.Mm.state, s.am.y.id)!.id
      for (const a of gone) expect(M.evidence(s.Mm.state, rel, a).state).toBe('withdrawn')
    }
  }, 240_000)
})

describe('K2 step 2b.1, part 2: what A knows of M\'s device set (draft 2 §3.4, E3)', () => {
  const setFrames = (s: Awaited<ReturnType<typeof zw>>) => (f: { bytes: Uint8Array }) => s.w.frameOrigin(f.bytes)?.kind === 'device-set'
  const introAndConfirm = async (s: Awaited<ReturnType<typeof zw>>) => {
    const r = await s.Mm.introduce(s.am.y.id, s.bm.y.id)
    expect('act' in r).toBe(true)
    await s.w.rounds(3)
    await s.A.confirmBudget(s.am.x.id)
    await s.w.rounds(3)
  }

  it('E1. Delayed admission: before A knows m2, a freed right goes to m1; after it knows m2 (and frees another), the empty m2 gets it', async () => {
    const { w, buch: _, ...rest } = await zw()
    const s = { w, buch: _, ...rest }
    w.carrier.faults.withhold('A1', setFrames(s))
    const M2 = await w.enrol(s.Mm, 'M2')
    await w.rounds(3)
    const m1 = await s.anchorAt(s.Mm)
    const m2 = await s.anchorAt(M2)
    // Soll: A knows {m1}; one acceptance, then 8515 frees 1: m1 (4 usable) is under to_am 5 → m1 gets it; m2 none.
    await introAndConfirm(s)
    expect([s.own(s.A, m1, 'active').length, s.own(s.A, m2).length]).toEqual([5, 0])
    w.carrier.faults.reset()
    await w.rounds(3)
    // Soll: A knows {m1, m2}; frei 0 → nothing for m2 yet (full reservation, 9.1 (a)).
    expect(s.own(s.A, m2)).toHaveLength(0)
    await introAndConfirm(s)
    // Soll: frei 1, m2 empty → m2 gets it (empties first); m1 keeps 4.
    expect([s.own(s.A, m1, 'active').length, s.own(s.A, m2, 'active').length]).toEqual([4, 1])
  }, 120_000)

  it('E2. Revocation before the older admission: A folds the cumulative set revision (admission and revocation of m2) in either order; m2 is never a member, no key for it', async () => {
    const s = await zw()
    s.w.carrier.faults.withhold('A1', setFrames(s))
    const M2 = await s.w.enrol(s.Mm, 'M2')
    await s.w.rounds(3)
    const m2 = await s.anchorAt(M2)
    await s.w.revoke(s.Mm, M2)
    await s.w.rounds(2)
    s.w.carrier.faults.reset()
    s.w.carrier.faults.reverse(true) // the later revision first
    await s.w.rounds(3)
    s.w.carrier.faults.reset()
    await introAndConfirm(s)
    // Soll: no key for m2 ever; the freed right goes to m1 (members {m1}).
    expect(M.rel(s.A.state, s.am.x.id).stock.filter((k) => k.for === m2)).toHaveLength(0)
    expect(s.own(s.A, await s.anchorAt(s.Mm), 'active')).toHaveLength(5)
  }, 120_000)

  it('E3. Different set states at A1 and A2: each allocates by its own knowledge (A1 knows m2, A2 does not yet); no contradiction, each assigns only its own keys', async () => {
    const s = await zw({ a2: true })
    const self = s.w.selfAddresses('A')
    s.w.carrier.faults.withhold('A2', (f) => setFrames(s)(f) || self.has(f.address)) // nor through A1's journal
    const M2 = await s.w.enrol(s.Mm, 'M2')
    await s.w.rounds(3)
    const m1 = await s.anchorAt(s.Mm)
    const m2 = await s.anchorAt(M2)
    // Each A device withdraws one own key (user action): frei 1 each. Soll: A1 (knows {m1, m2}) → m2 empty → m2; A2 (knows
    // {m1}) → m1 at 4 < to_am 5 → m1.
    await s.A.withdrawStock(s.am.x.id, [s.own(s.A, m1, 'active')[0]!.anchor])
    await s.A2!.withdrawStock(s.am.x.id, [s.own(s.A2!, m1, 'active')[0]!.anchor])
    await s.w.rounds(3)
    expect([s.own(s.A, m1, 'active').length, s.own(s.A, m2, 'active').length]).toEqual([4, 1])
    expect([s.own(s.A2!, m1, 'active').length, s.own(s.A2!, m2, 'active').length]).toEqual([5, 0])
    s.w.carrier.faults.reset()
    await s.w.rounds(3)
    // Soll: A2 now knows m2, frei 0 → unchanged (named price of 9.1 (a)); both A devices agree on the state.
    expect([s.own(s.A2!, m1, 'active').length, s.own(s.A2!, m2, 'active').length]).toEqual([5, 0])
    expect(s.w.agree('A')).toEqual({ agree: true, diff: '' })
    expect(s.nameable(M2)).toBe(1)
  }, 120_000)

  it('E4. Set states: unknown → only the root; known empty → no key (refusal is the named state)', async () => {
    // Unknown: A1 forgets M's set (fixture on the state) after M2 is admitted; class on → every key for the root m1.
    const s = await zw({ m2: 'before' })
    const m1 = await s.anchorAt(s.Mm)
    await s.A.setClass(s.am.x.id, false)
    await s.w.rounds(2)
    const root = M.head(M.rel(s.A.state, s.am.x.id)).peer
    expect(root).toBe(m1)
    delete (s.A.state.sets as Record<string, unknown>)[root]
    await s.A.setClass(s.am.x.id, true)
    await s.w.rounds(2)
    // Soll: |M| = 1 (the root), to_am 5 → 5 keys for m1, none for anyone else.
    expect(s.own(s.A, undefined, 'active').map((k) => k.for)).toEqual([m1, m1, m1, m1, m1])
    // Known empty: a revocation of the root by the root in A2's view of M's set (fixture op) → members [] → no key.
    const t = await zw({ a2: true })
    const rootT = M.head(M.rel(t.A2!.state, t.am.x.id)).peer
    await t.A2!.setClass(t.am.x.id, false)
    await t.w.rounds(2)
    const proof = { type: 't', cryptosuite: 'c', created: t0, verificationMethod: 'v', proofPurpose: 'p', proofValue: 'x' }
    M.apply(t.A2!.state, op({ kind: 'device-set', root: rootT, rootKeyAgreement: M.own(t.A2!.state.sets, rootT)!.rootKeyAgreement, certs: [{ root: rootT, kind: 'revoke', anchor: rootT, keyAgreement: null, by: rootT, proof }] }))
    expect(M.setView(M.own(t.A2!.state.sets, rootT)).members).toEqual([])
    const before = t.own(t.A2!).length
    await t.A2!.setClass(t.am.x.id, true)
    await t.w.rounds(1)
    expect(t.own(t.A2!).length).toBe(before)
  }, 120_000)
})

describe('K2 step 2b.1, part 2: class state and tombstones in a world (§4)', () => {
  it('K1. Revocation exception, both versions: A2 turns the class off and buries A1\'s keys (A1 never folds it); revoked → A1\'s keys usable again; not revoked and on again → A1\'s keys stay buried, A2\'s fresh keys are usable', async () => {
    for (const revoked of [true, false]) {
      const s = await zw({ a2: true })
      const self = s.w.selfAddresses('A')
      s.w.carrier.faults.withhold('A1', (f) => self.has(f.address))
      const a1keys = s.own(s.A, undefined, 'active').map((k) => k.anchor)
      expect(a1keys).toHaveLength(5)
      await s.A2!.setClass(s.am.x.id, false)
      await s.w.rounds(3)
      const rel = M.relOfTuple(s.Mm.state, s.am.y.id)!.id
      expect(s.nameable(s.Mm), `${revoked}: off`).toBe(0)
      for (const a of a1keys) expect(M.evidence(s.Mm.state, rel, a).state).toBe('withdrawn') // buried by A2 (B6)
      if (revoked) {
        await s.w.revoke(s.A, s.A2!)
        await s.w.rounds(4)
        // Soll: A2's class value and tombstones no longer count; A1 lists its 5 keys unchanged → 5 nameable, all A1's.
        expect(M.usableView(s.Mm.state, rel, s.w.clock.now()).listed.map((k) => k.anchor).sort()).toEqual([...a1keys].sort())
      } else {
        await s.A2!.setClass(s.am.x.id, true)
        await s.w.rounds(3)
        // Soll: A2 on again with 5 fresh keys (its own were withdrawn at off: frei 5); A1's 5 buried for good → 5 nameable, none of A1's.
        const listed = M.usableView(s.Mm.state, rel, s.w.clock.now()).listed.map((k) => k.anchor)
        expect(listed).toHaveLength(5)
        expect(listed.filter((a) => a1keys.includes(a))).toEqual([])
        for (const a of a1keys) expect(M.evidence(s.Mm.state, rel, a).state).toBe('withdrawn')
      }
    }
  }, 240_000)

  it('K2. The named price (draft 3 §4): a sister offline through the whole off phase, whose new anchor the issuer did not know, is blocked only by the class state; after "on" M can name it and the sister accepts. Soll: 1 acceptance', async () => {
    const s = await zw({ a2: true })
    const self = s.w.selfAddresses('A')
    s.w.carrier.faults.withhold('A1', (f) => self.has(f.address))
    s.w.carrier.faults.withhold('A2', (f) => self.has(f.address))
    // A2 replaces one key (user action): its new anchor y is unknown to A1 (journal held back both ways).
    const before = new Set(s.own(s.A2!).map((k) => k.anchor))
    await s.A2!.withdrawStock(s.am.x.id, [s.own(s.A2!, undefined, 'active')[0]!.anchor])
    await s.w.rounds(3)
    const y = s.own(s.A2!, undefined, 'active').find((k) => !before.has(k.anchor))!.anchor
    expect(M.rel(s.A.state, s.am.x.id).stock.some((k) => k.anchor === y)).toBe(false)
    s.A2!.online = false
    await s.A.setClass(s.am.x.id, false)
    await s.w.rounds(3)
    await s.A.setClass(s.am.x.id, true)
    await s.w.rounds(3)
    const rel = M.relOfTuple(s.Mm.state, s.am.y.id)!.id
    expect(M.usableView(s.Mm.state, rel, s.w.clock.now()).listed.map((k) => k.anchor)).toContain(y)
    // M names y (choice restricted to y by a test hook on `mayName`; the canonical choice would take the smallest anchor).
    const ofA = new Set(M.usableView(s.Mm.state, rel, s.w.clock.now()).listed.map((k) => k.anchor))
    ;(s.Mm.cand as { mayName?: (k: M.ListedKey) => boolean }).mayName = (k) => !ofA.has(k.anchor) || k.anchor === y
    const r = await s.Mm.introduce(s.am.y.id, s.bm.y.id)
    expect('act' in r).toBe(true)
    s.A2!.online = true
    await s.w.rounds(4)
    // Soll: 1 acceptance on y (A2 never saw the off phase).
    expect(s.buch.acceptedOn().get(y)?.size ?? 0).toBe(1)
  }, 120_000)
})
