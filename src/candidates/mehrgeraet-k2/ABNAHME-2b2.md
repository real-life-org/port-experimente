# K2 step 2b.2: acceptance sheet (phase 1, before any code)

Design: `rltp/design/port-experimente-e15-k2-schritt-2b-kern-entwurf-4-2026-10-21.md`
(core draft 4, Fassung 4) §1 (incl. 1.3, 1.4), §5, §6 "2b.2", §7, §8; draft 3
§1.1, §1.2, §7.2, §7.3; draft 2 §2.1–2.6; design reviews 4 and 5 (Sol).
Code base read: `main` 0a4061c (2b.0 = PR #77, 2b.1 = PR #80).

Rule (draft 3 §7.2, core draft 4 §6): every expected value below is derived by
hand from the event sequence and the bench constants, **before the automaton is
built**. None is taken from a run. Where a value cannot be derived without
running the code, the row says so (`[M]` = measured only) and names what is
missing; where the design leaves the value open, the row points to the list
"Open points before build" at the end (`[O n]`). `[D]` = derived here.

The test file for these rows is `tests/mehrgeraet-k2-automat.test.ts` (new); the
checker column names the function in `src/lab/mehrgeraet/buch.ts` (existing or
to be added in 2b.2) or the holder/ledger read the test asserts directly.

## 0. Bench constants, base worlds, conventions

### 0.1 Constants (`M.PARAM`, `zustellung.ts`, `buch.ts`)

| name | value | source |
|---|---|---|
| budget per mediator relationship (8510) | 10 | `PARAM.budget` |
| devices per person (`slots`) | 2 (K4, B13 (ii): 3) | `k2({ devices })` |
| share per device (MV-9) | ⌊budget / slots⌋ = 5 (W3: ⌊6/3⌋ = 2; W4: ⌊10/3⌋ = 3) | `K1aDevice.share` |
| act lifetime | 7 d | `PARAM.actLifetimeMs` |
| consent reserve (8155) | 1 d (bench) | `PARAM.consentReserveMs` |
| act skew | 1 h | `PARAM.actSkewMs` |
| prekey lifetime | 180 d (W5: 8 d via `stockLifetimeMs`) | `PARAM.prekeyLifetimeMs` |
| budget window | 28 d | `PARAM.budgetWindowMs` |
| 8470 usable | `now + 7 d + 1 h ≤ key.expiresAt` | `M.usable` |
| deliverer repeat | after `HORIZON.ackWait` = 3 rounds without receipt | `Zusteller.advance` |
| deliverer give-up | 12 rounds after carrier acceptance | `HORIZON.giveUp` |
| P-Produktion window | k = 3 rounds in which the device is up | `PRODUCTION.rounds` |
| supply target `to_am` | `max(1, min(⌊(share − belegt)/|M|⌋, 5, ⌊64/|M|⌋))` | `HolderDevice.supply` |

Times. `t0` = 2026-10-17T08:00:00.000Z (world start; setup does not move the
clock). For an issuance at `tI`: `E = tI + 7 d` (act `expiresAt`),
**`TB = E − 1 d`** (ticket submission and resumption end at M, 5.1, equality
included), **`AE = E + 1 h`** (8110.5, acceptance end, equality included). Key
`expiresAt` = allocation time + 180 d (W5: + 8 d). Time-driven transitions fire
strictly after their bound (8110.7: `now > bound`); documents of a round are
handled before the round's tick (`round()`: collect → handle → commit → release
→ `tick` → `zusteller.advance` → reports → flush).

Round order. A world round runs the devices in creation order. W2: A1, B1, M1,
M2 (A2, M3 appended when enrolled). A frame deposited by a device earlier in
the order is collected by a later device in the same world round.

### 0.2 Base worlds

**W2** (core, two M devices): `ledgerWorld(k2({ singleDevice: [] }))`. Persons
A (A1), B (B1), M (M1). Encounters A1–M1 (`am`), B1–M1 (`bm`); 2 rounds; enrol
M2 from M1; 3 rounds (A1 and B1 fold M's `device-set@1` with members m1, m2);
`A1.setClass(am.x, on)`, `B1.setClass(bm.x, on)`; 3 rounds. Derived state after
setup (§2.3, `supply`): members sorted {m1, m2}, share 5, `to_am = max(1,
min(⌊5/2⌋, 5, 32)) = 2`; plan: empty first (m1, m2: 1 each, free 3), then up to
2 each (free 1). So **A1 lists 4 keys (2 for m1, 2 for m2), reserviert 4, belegt
0, frei_zuteilbar 1**; B1 the same. M1 nameable: 2 A keys, 2 B keys; M2 likewise.
Tuples from setup (pairCounter): A→M 1, M→A 1, B→M 1, M→B 1; open duties 0.

**W2+A2**: W2, then enrol A2 from A1 after class on, 3 rounds. A2 supplies its
own 4 keys (2 per M device) by the same rule. M1 then holds 4 nameable A keys
for m1 (2 by A1, 2 by A2); the named key `xA` is the smallest by M1's order
(see open point 16), its allocator is written `Ax = by(xA)`, the other A device
`Ay`.

**W3** (K4): `k2({ singleDevice: [], devices: 3, budget: 6 })` → share 2. A (A1),
B (B1), M (M1); encounters, 2 rounds, class on at A1 and B1, 3 rounds: M's set
known as root alone → `to_am = max(1, min(⌊2/1⌋, 5, 64)) = 2` → A1 lists 2 keys
for m1, free 0; B1 the same.

**W4** (B13 (ii)): `k2({ singleDevice: [], devices: 3 })` → share 3; M3 enrolled
like M2 before class on → `to_am = max(1, ⌊3/3⌋) = 1` → A1 lists 1 key per M
device, free 0.

**W5** (resumption `unlisted`): W2 with `stockLifetimeMs = 8 d`.

Every introduction is `M1.introduce(am.y, bm.y)` (A first) unless stated.
`xA`, `xB` = the named keys, `tA`, `tB` = the two ticket intents (digests).

**Drain Z** (ends every K-run): Z1 = clock to `TB + 1 s`, 1 world round (M:
`expire(·, 'consent-reserve')` on open ticket intents; sides: 8325.A7 `offered
→ expired`); Z2 = clock to `AE + 1 s`, 2 world rounds (M: card intents `expire(·,
'act-ended')`, M act `ended`; sides: 8325.A8 `consented → expired` under the K2
capability).

### 0.3 Conventions for the counts

- *Issuance commits*: ledger commits holding an `introduce` op. *Ticket digests*:
  distinct intents of kind ticket. *Deposits*: carrier frames that open to a
  ticket (`ticketDeposits`), repeats included.
- *Acceptances per side*: `ticket-accept` commits (8640.14) in the ledger (at the
  commit, not at the receipt). *Load*: `M.budgetUsed` of the side's relationship
  to M (person-wide, 8510) and `belegt` of the allocating device.
- *Acceptance knowledge* (3a, new in 2b.2): `unknown`/`accepted` per side at the
  issuing M device (from its own receipt) and at its sibling (from the issuer's
  journal batch, §6 B13).
- *Evidence* (3b): `M.evidence(state, rel, anchor).state` at the M device.
- *Transport* per ticket (2): `awaiting-transport`/`handed`/`acked`/`given-up`.
- *Dead-ticket counter* (sheet convention, open point 4): one entry per act, by
  the cause on the side that could not accept or not succeed: `zurueckgezogen`,
  `fremde-zuteilung`, `spaetes-ticket`, `spaet-zugestellt`, `abgang`, `budget`;
  `deadAccepted` = acceptances inside dead acts (the "totes Ticket" of §1).
- *P-Produktion* (extended by 1.4): `obliged`, `kept` (both tickets as committed
  submissions within k up rounds), `omitted:rueckzug`, `omitted:abgang` (per
  ticket, judged on the evidence the device had durably folded before the
  decision round), violations.
- *P-Eigen* (new name for the MV-8 check in this sheet): no device deposits a
  ticket intent whose `device` is another device.

## 1. Core counter-runs K1–K10

Each table gives Soll, derivation and the asserting check. Rows not listed for a
run are 0 / unchanged / not applicable; P-Commit, P-Einmal, P-Recht, P-Aufhebung,
P-Bilanz, P-Versorgung, P-Paar and P-Eigen have 0 violations in every honest K-run
unless a row says otherwise.

### K1 Crash in the issuance, two M devices, resumption of own intents only (MV-8)

Naming: §6 says `between-tickets` and `after-commit`; the code's crash points of
an issuance are `between-sends` and `before-send` (= after the commit, before
the release; open point 12).

**K1a, `between-sends`.** W2. `M1.crashAt = 'between-sends'`; `M1.introduce` →
`crashed` (the batch is committed; release deposits `tA`, then throws before
`tB`). `M1.reload()` (5.3 restart: inc, nonce, `n` kept). 4 rounds, Z.

**K1b, `before-send`.** The same with `crashAt = 'before-send'` (nothing at the
carrier before the crash).

| quantity | K1a | K1b | derivation | asserted by |
|---|---|---|---|---|
| issuance commits | 1 [D] | 1 [D] | `flush`: commit before `before-send`/`between-sends`; reload commits nothing, no second `introduce` | ledger commits |
| distinct ticket digests | 2 [D] | 2 [D] | two intents in the batch; repeats and redeposits are the same digest | ledger intents |
| deposits `tA` / `tB` | 1 / 1 [D] | 1 / 1 [D] | the image is the commit snapshot (`MemoryStore.commit` clones), so after reload both submissions have `report = null` → `unreleased`. K1a: A1 (before M1 in the order) accepts the pre-crash copy of `tA` in round 1 and its receipt reaches M1 in the same round before M1's release, so M1 knows `accepted` and omits the resubmission (decision 13); `tB` is released. K1b: both released in M1's round 1. Receipts reach M1 within 2 rounds < 3 → no repeat | `ticketDeposits` |
| omitted:accepted | 1 [D] | 0 [D] | decision 13; the holder's measure `ticketOmissions` (P-Produktion counts K1a's `tA` as kept: the pre-crash deposit) | `HolderDevice.ticketOmissions` |
| deposits by M2 | 0 [D] | 0 [D] | M2 folds M1's batch (journal out in M1's round 1); intents with `device = M1` are not its own (MV-8) | P-Eigen |
| acceptances A / B | 1 / 1 [D] | 1 / 1 [D] | K1a: A1 accepts the pre-crash copy in round 1, the redeposit is `duplicate-known` (8640.4, same receipt bytes again); B1 in round 2. K1b: both in round 2 | P-Einmal counts, ledger |
| load A / B (budgetUsed; belegt A1, B1) | 1 / 1 [D] | 1 / 1 [D] | one acceptance each, no 8515 | ledger image |
| receipt documents A / B | 1 / 1 [D] | 1 / 1 [D] | a duplicate resends the stored ack bytes (`acks`), no new document | carrier receipts |
| acceptance knowledge at M1, M2 | accepted / accepted [D] | accepted / accepted [D] | M1 from its own receipts (`expected` is in the image); M2 from M1's journal batch carrying the knowledge | M1, M2 state |
| evidence `xA` / `xB` at M1 (end) | unlisted / unlisted [D] | same [D] | after acceptance A1 refills (free 1 → +1 for m1) and lists only active keys; `xA` consumed = not listed, not withdrawn | `M.evidence` |
| act at M (end) | `ended` [D] | `ended` [D] | Z2 passes AE | M act |
| side acts A / B (end) | expired / expired [D] | same [D] | no consent; Z1 8325.A7 | side state |
| cards issued / submitted / connected | 0 / 0 / 0 [D] | same | no consent | ledger |
| tuples A→B / B→A; open duties | 0 / 0; 0 [D] | same | no connection | `pairCounter` |
| writer of M1's next batch | `M1@inc` unchanged, `n = k + 1` [D] | same | 5.3 | journal (see N1) |
| MV-3 conflicts at M2 | 0 [D] | 0 [D] | no reused `writer@inc#n` | M2 findings |
| P-Produktion | obliged 1, kept 1, omitted 0 [D] | same [D] | both committed submissions at the carrier within M1's first up round after the reload (≤ k = 3); K1a's `tA` is the pre-crash deposit | `pProduktion` |
| P-Bilanz max at A1 / B1 | 5 / 5 [D] | same | after the acceptance: belegt 1 + reserviert (4 − 1 + 1) = 5 | `pBilanz(b, 5)` |
| dead tickets (all causes) | 0 [D] | 0 [D] | both accepted; expiry without consent is the 2a cause "no answer" | dead counter |

Mutation K1m: M2 resumes M1's intents (test hook) → P-Eigen ≥ 1 violation [D:
exactly 2 deposits by M2 in K1b, one per intent, in M2's round 1]; acceptances
unchanged (8640.4) [D].

### K2 Ticket reaches A before the matching revision reaches M

Sequence (draft 4 §6 K2, review 4 E5). W2. Withhold at M1 every A1
`stock-revision` frame and every frame from M2 (correction found in the build:
M2 folds r2 and journals it, so without this r2 reaches M1 through the journal
in round 1). `M1.introduce` at `tI` (no crash: both tickets at the
carrier inside the action). 3 rounds: A1 accepts `tA` (round 1), refills and
sends r2 (lists 4 keys, not `xA`), receipt to M1 (round 1); B1 the same for `tB`.
Reset the withhold; 2 rounds (M1 folds r2); Z.

| quantity | Soll | derivation | asserted by |
|---|---|---|---|
| issuance commits | 1 [D] | M1 knows `xA` from r1; no further issuance from stale knowledge | ledger |
| digests / deposits | 2 / 2 [D] | no repeat (receipts in round 1) | `ticketDeposits` |
| acceptances A / B; load | 1 / 1; 1 / 1 [D] | 8640.6: `xA` active at A1 at receipt | ledger |
| knowledge at M1 after round 1 | accepted / accepted [D] | receipts arrive before r2 (withheld) | M1 state |
| evidence `xA` at M1: at issuance, at the receipt, after r2 | listed, listed, unlisted [D] | r1 lists it; r2 (consumed) does not; no `withdraw` | `M.evidence` |
| evidence `xA` at M2 (end) | unlisted [D] | M2's copy of r2 is not withheld | `M.evidence` |
| side acts (end) | expired / expired [D] | Z1 | side state |
| P-Produktion | obliged 1, kept 1 [D] | k = 0 | `pProduktion` |
| P-Bilanz max A1 / B1 | 5 / 5 [D] | as K1 | `pBilanz` |

### K3 Withdrawal with the ticket in flight (dead ticket)

W2. Withhold at A1 every ticket frame. `M1.introduce` at `tI`. Round 1: B1
accepts `tB`, receipt; `tA` held at the carrier. `A1.withdrawStock(am.x, [xA])`
(revision with `withdraw: [xA]`, lists 3 keys); A1's next tick supplies (reserviert
3, free 2, m1 has 1 < `to_am` 2 → +1 for m1, revision lists 4 keys). Reset the
withhold; 4 rounds (rounds 2–5); Z.

| quantity | Soll | derivation | asserted by |
|---|---|---|---|
| issuance commits / digests | 1 / 2 [D] | | ledger |
| deposits `tA` | 1 [D] | deposit at `tI`; M1 folds A1's withdrawal in round 2 (A1 deposited it in the action before round 2) → `expire(tA, 'withdrawn')` (decision 15) before its `advance`; the repeat would have been in round 3 | `ticketDeposits` |
| deposits `tB` | 1 [D] | receipt in round 1 | |
| A1 refusals of `tA` | 1, 8640.6 (`state`, withdrawn) [D] | the queued copy arrives in round 2 | A1 dispositions |
| acceptances A / B | 0 / 1 [D] | local withdrawal effective before the receipt | ledger, P-Aufhebung (0) |
| load A / B | 0 / 1 [D] | 8640.6 refusal has no load | ledger |
| knowledge at M1 | unknown / accepted [D] | no receipt from A | M1 state |
| evidence `xA` / `xB` at M1 (end) | withdrawn / unlisted [D] | withdrawal by the bound writer; `xB` consumed | `M.evidence` |
| transport `tA` (end) | handed [D] | decision 3: no withdrawal after carrier acceptance | M1 zusteller |
| side acts (end) | A none; B expired [D] | A has no act; B: Z1 8325.A7 | side state |
| dead tickets | `zurueckgezogen` 1, `deadAccepted` 1 (B) [D] | | dead counter |
| P-Produktion | obliged 1, kept 1 [D] | both deposited in the action | `pProduktion` |
| P-Bilanz max A1 | 4 [D] | 4 → withdraw 3 → supply 4; belegt 0 | `pBilanz` |
| P-Bilanz max B1 | 5 [D] | as K1 | |

### K4 Three M devices, `frei_zuteilbar = 1`

W3 (share 2). Enrol M2 and M3 from M1; 3 rounds (A1, B1 fold the set {m1, m2,
m3}). `M2.introduce`, `M3.introduce` → refused. `M1.introduce`; 3 rounds (A1, B1
accept). `A1.confirmBudget(am.x)` (8515); 3 rounds. Then `m* .introduce` (the
device that got the right); Z.

| quantity | Soll | derivation | asserted by |
|---|---|---|---|
| A1 keys after the enrolments | m1 2, m2 0, m3 0; free 0 [D] | reserviert 2 = share | `own(A1, m)` |
| M2, M3 introduce before | refused, reason no nameable key (A and B side) [D] | | return value |
| P-Versorgung after the enrolments | 0 violations; unsupplied A1 2, B1 2 [D] | free 0 | `pVersorgung(b, 2)` |
| after M1's issuance: A1 belegt / reserviert / free | 1 / 1 / 0 [D] | one of m1's keys consumed; no supply | ledger image |
| after `confirmBudget`: new rights at A1 | exactly 1 [D] | belegt 0, reserviert 1, free 1; empty first in code-unit order: the first of `{anchor_A(m2), anchor_A(m3)}`; then `to_am = max(1, ⌊2/3⌋) = 1`, m1 and the chosen device at 1 → nothing more | ledger allocate ops |
| which device gets it | `m* = min_byCode(anchor of m2, anchor of m3 on A's relationship)` [D, relational] | `members.sort()` in `supply` | `own(A1, m*)` = 1 |
| unsupplied at the end | A1 1, B1 2 [D] | B1 did not confirm (belegt 1, reserviert 1) | `pVersorgung` |
| `m*.introduce` afterwards | refused (no B key for `m*`) [D] | B1 gave no right to m2 or m3 | return value; P-Produktion `noKeys` |
| P-Produktion counts | introductions 4, obliged 1, kept 1, noKeys 3 [D] | M2, M3 before; `m*` after | `pProduktion` |
| P-Bilanz max A1 / B1 | 2 / 2 [D] | | `pBilanz(b, 2)` |
| an issuance by `m*` once B also frees a right | [M] | B1's free right goes to the first empty device by B's anchors, which are independent of A's (open point 14) | measured |

### K5 Ticket at the `expiresAt − consent-reserve` boundary (two variants, plus K5c)

Reading of §6 K5 (open point 1): an issuance cannot commit at its own `TB`
(`expiresAt := issuedAt + 7 d` at the commit); the boundary is reached by the
submission after a crash.

**K5a (equality).** W2. `M1.crashAt = 'before-send'`; `M1.introduce` at `tI` →
crashed. Clock to `TB` exactly. `M1.reload()`; 2 rounds; `A1.consent(X)`,
`B1.consent(X)` at `TB`; 3 rounds; Z.

**K5b (one step later).** The same, reload at `TB + 1 s`; no consent.

**K5c (spaetes-ticket, added by this sheet).** W2. `M1.introduce` at `tI`;
withhold `tA` at A1; 3 rounds at `tI`; clock to `TB + 1 s`; reset; 2 rounds; Z.

| quantity | K5a | K5b | K5c | derivation | asserted by |
|---|---|---|---|---|---|
| submissions (tickets at the carrier) | 2 [D] | 0 [D] | 2 digests, `tA` 2 deposits, `tB` 1 [D] | K5a: release at `TB`, `now ≤ TB`; K5b: the submission gate itself refuses at `TB + 1 s` (release runs before the tick, open point 9); K5c: repeat in round 3 at `tI`, then the tick at `TB + 1 s` expires before `advance` | `ticketDeposits` |
| repeats after the boundary | 0 [D] | 0 [D] | 0 [D] | | |
| acceptances A / B | 1 / 1 [D] | 0 / 0 [D] | 1 / 1 [D] | K5a: 8640.3 at `TB` ≤ E; K5c: A1 at `TB + 1 s` ≤ AE | ledger |
| load A / B | 1 / 1 [D] | 0 / 0 [D] | 1 / 1 [D] | | ledger |
| consent possible at A1 | yes: `consented` [D] | — | no [D] | 8155: `now > E − 1 d` false at `TB`; K5c: A1's tick in the acceptance round expires the act (A7) | side state |
| cards issued / submitted / connected sides | 2 / 2 / 2 [D] | 0 | 0 | AE far; cards cross within 3 rounds | ledger, `pPaar` bothSides 1 |
| tuples A→B / B→A | 1 / 1 [D] | 0 / 0 | 0 / 0 | | `pairCounter` |
| knowledge at M1 | accepted / accepted [D] | unknown / unknown [D] | accepted / accepted [D] | K5c: receipt after `TB` still counts | M1 state |
| transport `tA`, `tB` | acked [D] | given-up / given-up [D] | acked [D] | K5b: expire before carrier acceptance | M1 zusteller |
| M act (end) | ended [D] | ended [D] | ended [D] | Z2 | |
| side acts (end) | connected / connected [D] | none [D] | expired / expired [D] | | |
| dead tickets | 0 [D] | 0 | `spaetes-ticket` 1, `deadAccepted` 2 [D] | | dead counter |
| P-Produktion | obliged 1, kept 1 [D] | obliged 0, counted `down` 1, 0 violations [D] | obliged 1, kept 1 [D] | K5b: no round in which submission was admissible (decision 2) | `pProduktion` |

### K6 One-sided connection by a late card (1.3)

W2. `M1.introduce` at `tI`; 2 rounds (both accept). `A1.consent(X)`,
`B1.consent(X)`; withhold at A1 every card frame from B1; 3 rounds (B1 receives
A1's card, its own card is submitted, connects; A1's card acked). Clock to
`AE + 1 s`; 1 round (A1 tick under the K2 capability: `consented → expired`; B1
tick: `expire(cB, 'act-ended')`). Reset; 2 rounds.

| quantity | Soll | derivation | asserted by |
|---|---|---|---|
| side acts | B connected, A expired [D] | late card refused at A1 (`after-acceptance-end-8110.5`, no ack) | side state |
| P-Paar | 0 violations; connectedActs 1, bothSides 0 [D] | only B committed `connect` | `pPaar` |
| one-sided connection, cause late card | 1 [D] | new counter (1.3) | `pPaar` counts |
| deposits of B1's card | 2 [D] | deposit in the consent action; repeat at B1's round 3 (no receipt); at `AE + 1 s` expire before `advance` | carrier |
| A1 card refusals | 2 [D] | both queued copies arrive after AE; a refused frame is `unique` again | `cardLog` |
| cards issued / submitted | 2 / 2 [D] | | ledger |
| tuples B→A / A→B; open duties | 1 / 0; 0 [D] | | `pairCounter` |
| acceptances, load | 1 / 1, 1 / 1 [D] | | ledger |
| knowledge at M1 | accepted / accepted [D] | | M1 state |
| dead tickets | 0 [D] | the act succeeded on one side; counted as one-sided, not dead | dead counter |

### K7 Resumption after a lifted tombstone effect, intent seen before and after the lift (5.1, Q6)

W2. `M1.crashAt = 'before-send'`; `M1.introduce` at `tI` (names `xA` by A1).
Enrol A2 from A1; 3 rounds (M1 down). Withhold at A1 every frame at A's self
addresses (A1 never folds A2's journal, as 2b.1 K1). `A2.setClass(am.x, off)`
(off revision: `withdraw` own, `bury` every known anchor incl. `xA`).

**K7a (seen before):** `M1.reload()`; round 1 (M1 folds the off revision →
`xA` withdrawn → `tA` held, `tB` released); `w.revoke(A1, A2)`; round 2 (M1 folds
the revocation → A2's tombstone counts only where no non-revoked writer
currently lists; A1 lists `xA` → listed → `tA` released); 3 rounds; Z.

**K7b (seen after):** keep M1 down; `w.revoke(A1, A2)`; 2 rounds; `M1.reload()`;
1 round (M1 folds both before its release); 3 rounds; Z.

| quantity | K7a | K7b | derivation | asserted by |
|---|---|---|---|---|
| deposits `tA` / `tB` | 1 / 1 [D] | 1 / 1 [D] | one submission per digest in both orders | `ticketDeposits` |
| M1 round in which `tA` is deposited | 2 [D] | 1 [D] | | ledger seq |
| evidence `xA` at M1 | listed → withdrawn → listed [D] | listed → listed [D] | §3.3, §4 revocation exception; a function of the set | `M.evidence` per round |
| acceptances A1 / B1 | 1 / 1 [D] | 1 / 1 [D] | `xA` active at A1 (it never folded the off) | ledger |
| P-Produktion | obliged 1, kept 1, omitted 0 [D] | same [D] | K7a: the window restarts in round 2 when `xA` is listed again (decision 6), `tA` deposited in that round | `pProduktion` |
| P-Aufhebung | 0 [D] | 0 [D] | M1's committed image at the release holds `xA` listed | `pAufhebung` |
| knowledge at M1 | accepted / accepted [D] | same | | M1 state |

### K8 Late delivery after the act end, departure before both and after one submission (1, 8232.1)

**K8a (ticket after the acceptance end).** W2. Withhold at B1 every ticket frame.
`M1.introduce` at `tI`; 2 rounds (A1 accepts, receipt). Clock to `AE + 1 s`; 1
round (A1: 8325.A7 expired). Reset; 2 rounds (B1 receives `tB`, 8640.3 refuses
under the K2 capability, no ack).

**K8b (departure before either submission).** W2. `M1.crashAt = 'before-send'`;
`M1.introduce`; `M1.reload()`; `M1.depart(am.y relationship)` before any round
(8232.1: both unsubmitted tickets cancelled); 3 rounds; Z.

**K8c (departure after the counter-ticket).** W2. Bench fault (new, open point
5): deposits at the address of `xA` throw `WireUnreachable`. `M1.introduce`:
`tA` → `awaiting-transport (transport-unreachable)`, `tB` → handed.
`M1.depart(relationship to A)`: `tA` cancelled (unsubmitted on the departed
relationship), `tB` continues. Lift the fault; 3 rounds; Z.

| quantity | K8a | K8b | K8c | derivation | asserted by |
|---|---|---|---|---|---|
| tickets at the carrier | 2 (`tB` 1 deposit) [D] | 0 [D] | 1 (`tB`) [D] | K8a: no repeat of `tB` (sinceDeposit 2, then expire at the tick before `advance`) | `ticketDeposits` |
| omitted:abgang | 0 | 2 [D] | 1 [D] | per cancelled ticket, departure committed before the decision | `pProduktion` |
| acceptances A / B | 1 / 0 [D] | 0 / 0 [D] | 0 / 1 [D] | | ledger |
| load A / B | 1 / 0 [D] | 0 / 0 [D] | 0 / 1 [D] | | ledger |
| receipts | 1 (A) [D] | 0 [D] | 1 (B) [D] | | carrier |
| knowledge at M1 | accepted / unknown [D] | unknown / unknown [D] | unknown / accepted [D] | | M1 state |
| side acts (end) | A expired, B none [D] | none / none [D] | A none, B expired [D] | | side state |
| dead tickets | `spaet-zugestellt` 1, `deadAccepted` 1 [D] | `abgang` 1, `deadAccepted` 0 [D] | `abgang` 1, `deadAccepted` 1 [D] | | dead counter |
| P-Produktion violations | 0; kept 1 [D] | 0; kept 0, omitted 2 [D] | 0; kept 0, omitted 1, 1 committed submission [D] | 1.4 | `pProduktion` |
| 8232.1 row | Annahmeende: no unsubmitted ticket left [D] | "before either is submitted" [D] | "after the other one is submitted" [D] | | test comment |

### K9 `connected`/`declined` before and after journal reconciliation (1.3, review 5 D1)

W2+A2. `M1.introduce`; 3 rounds (`Ax` accepts, `Ay` folds the acceptance from
`Ax`'s journal, B1 accepts). Withhold every frame at A's self addresses for `Ax`
and for `Ay`. `Ay.decline(X)`; `Ax.consent(X)` (`Ax` is the allocator, it
produces the one card); `B1.consent(X)`; 3 rounds (both cards cross; B1 and `Ax`
connect). Check **before**. Reset; 4 rounds. Check **after**. Z.

| quantity | before | after | derivation | asserted by |
|---|---|---|---|---|
| states `Ax` / `Ay` / B1 | connected / declined / connected [D] | connected / connected / connected [D] | after: rule 2 (Anton 18.10.): `Ax`'s card was submitted, the consent decides (MV-15 over the folded evidence) | side state |
| P-Paar violations | 0 [D] | 0 [D] | `Ay` does not know the consent before; after, its projection is `connected` | `pPaar` (new reconstructed-state row) |
| conflict finding `decline` at A | 0 [D] | 1 [D] | the fold keeps the decline as conflict, not state | A ledger/effects |
| P-Paar bothSides | 1 [D] | 1 [D] | `Ax` and B1 with the same pair context | `pPaar` |
| cards issued / submitted | 2 / 2 [D] | 2 / 2 | `Ay` produces none (producer rule) | ledger |
| tuples A→B / B→A | 1 / 1 [D] | 1 / 1 | | `pairCounter` |
| acceptances A / B | 1 / 1 [D] | | only `Ax` opens `tA` | ledger |

Mutation K9m: a fixture where `Ay` folds `Ax`'s consent and hand-over and still
projects `declined` → 1 P-Paar violation [D].

### K10 Commit, crash before submission, restart folds A's withdrawal, resumption omitted (1.4)

W2. `M1.crashAt = 'before-send'`; `M1.introduce` at `tI` → crashed.
`A1.withdrawStock(am.x, [xA])`; 1 round (A1 supplies +1 for m1; M1 down; M2
folds). `M1.reload()`; 3 rounds (round 1: M1 folds the withdrawal before its
release → `tA` held, `tB` released; B1 accepts in round 2); Z.

| quantity | Soll | derivation | asserted by |
|---|---|---|---|
| tickets at the carrier | 1 (`tB`) [D] | | `ticketDeposits` |
| omitted:rueckzug | 1 [D] | `xA` withdrawn in M1's committed image before the decision round | `pProduktion` |
| P-Produktion violations | 0; obliged 1, kept 0 [D] | | `pProduktion` |
| `tA` intent | held, never deleted, re-checked each round until `TB`, then given-up [D] | 5.1 due work | M1 intents / zusteller |
| acceptances A / B; load | 0 / 1; 0 / 1 [D] | | ledger |
| knowledge at M1 | unknown / accepted [D] | | M1 state |
| evidence `xA` / `xB` | withdrawn / unlisted [D] | | `M.evidence` |
| side acts (end) | A none, B expired [D] | | side state |
| dead tickets | `zurueckgezogen` 1, `deadAccepted` 1 [D] | | dead counter |

## 2. The six act-end tests (5.2)

All under the K2 capability; each with the boundary −1 s, 0, +1 s; documents of
a round are handled before its tick (8110.7). W2, issuance at `tI`, both tickets
accepted in round 1 unless stated. "Control" = the same row on the old path
(capability off).

| test | sequence | −1 s | 0 | +1 s | asserted by |
|---|---|---|---|---|---|
| T1 end before carrier acceptance (card, `act-ended`) | B1 consents, its card reaches A1; `A1.online = false`; `A1.consent` (card `awaiting-transport`); clock to `AE + d`; `A1.online = true`; 2 rounds | card deposits 1; B1 connected; A1 connected [D] | the same [D] (`advance` deposits; tick not strictly after) | deposits 0, transport given-up; A1 expired, B1 expired [D] | carrier, states |
| T2 end after carrier acceptance without receipt | both consent; withhold A1's card at B1; 2 rounds at `tI`; clock to `AE + d`; 1 round | card deposits 2 (repeat in round 3) [D] | 2 [D] | 1, no repeat after the expire, transport stays handed (taken) [D] | carrier |
| T3 end with a late receipt | both consent; A1's card reaches B1 (B1 connects); withhold B1's receipt at A1; clock to `AE + d`; 1 round; reset; 1 round | O delivered, `late` false [D] | delivered [D] | delivered, receipt after expire counts [D] | A1 act cards, zusteller |
| T4 receipt between `expiresAt` and `AE` (ticket) | withhold `tA` at A1; clock to `E + 1 h + d`; reset; 2 rounds | A1 accepts, receipt, knowledge accepted, load 1, A act expired in the same round (A7), `spaetes-ticket` 1 [D] | the same [D] | refused (8640.3), knowledge unknown, load 0, `spaet-zugestellt` 1 [D] | ledger, M1 state |
| T4 control (old 8640.3 at `expiresAt`) | the same | refused [D] | refused [D] | refused [D] | ledger |
| T5 counter card after `expiresAt`, before AE, own card submitted | both consent; A1's card reaches B1; withhold B1's card at A1; clock to `E + 1 s`, 1 round; clock to `AE + d`; reset; 1 round | A1 connected, P-Paar bothSides 1 [D] | connected [D] | refused (`after-acceptance-end-8110.5`), A1 expired, one-sided 1 [D] | states, `pPaar` |
| T5 control (old A8 at `expiresAt`) | the same | A1 expired at `E + 1 s`; the card at `AE − 1 s` hits the terminal branch, not connected [D] | same [D] | same [D] | states |
| T6 consent-reserve boundary (tickets) | (a) `M1.online = false` at the issuance (both `awaiting-transport`); clock to `TB + d`; online; 2 rounds | deposits 2, acceptances 2, consent possible [D] | the same [D] (equality included) | deposits 0, given-up 2, acceptances 0 [D] | carrier, ledger |
| T6 (b) after carrier acceptance without receipt | withhold `tA` at A1; 2 rounds at `tI`; clock to `TB + d`; 1 round | `tA` deposits 2 [D] | 2 [D] | 1 [D] | carrier |
| T6 (c) side consent at the boundary | A1 accepted at `tI`; clock to `TB + d`; `A1.consent(X)` | consented [D] | consented [D] | no consent; the next tick expires (A7) [D] | side state |
| T6 (d) resumption after a crash at the boundary | = K5a / K5b | | | | |

## 3. Restart tests (5.3)

| test | sequence | Soll | asserted by |
|---|---|---|---|
| N1 restart after k batches | W2; M1 writes k ≥ 2 batches; `crashAt = 'after-commit'` in a round; `M1.reload()`; M1 commits once more; 2 rounds | next batch `M1@inc#(k+1)`, writer unchanged, M2 folds it, 0 `Journal-Konflikt` findings, M2's head for `M1@inc` = k + 1 [D] (today: new inc, `n = 1`) | journal heads, M2 findings |
| N2 restart after acceptance, before the receipt | W2; `A1.crashAt = 'after-commit'` in the round it accepts `tA`; `A1.reload()`; 3 rounds | 1 `ticket-accept` commit, `xA` consumed in A1's store, receipt released after the reload, knowledge at M1 accepted, a repeat of `tA` is `duplicate-known` with the stored receipt, writer of A1 unchanged [D] | ledger, A1 state |
| N3 counter-probe: image restore | W2; snapshot M1's store after j = k − 1 batches; M1 writes batch k; `store.restore(image)`; `M1.reload({ fresh: true })`; M1 commits once; 2 rounds | new writer `M1@inc′`, its first batch `n = 1`, no `writer@inc#n` reused with other content, 0 MV-3 conflicts at M2 [D] (only path distinction and fresh journal incarnation; not P-Einmal) | M2 findings, batch keys |
| N4 mutation: image restore keeps `inc` | N3 with the plain `reload()` on the image | the new batch is `M1@inc#k` with other content → exactly 1 `Journal-Konflikt` at M2 → N3's assertion fails [D] | `it.fails` or inverted assertion |
| N5 path marker | `scenarios.ts` image restore and `welt.steal` call the fresh path, the crash restart the plain one | the stolen copy gets a new inc; the restarted device keeps it [D] | inc tags |

## 4. Resumption tests (5.1)

| test | sequence | Soll | asserted by |
|---|---|---|---|
| R1 `unlisted` → resubmit | W5. `M1.crashAt = 'before-send'`; introduce at `t0` (`t0 + 7 d 1 h ≤ t0 + 8 d`); clock to `t0 + 23 h + 1 s`; 1 round (A1, B1 age all 4 keys, 8470 fails; each m device has 0 usable → free 1 → 1 new key; revision lists it only); `M1.reload()`; 3 rounds; Z | evidence `xA`, `xB` unlisted at the decision; 2 submissions; A1 accepts on an `aging` key (8640.6; 8640.7: `t0 + 8 d ≥ t0 + 7 d + 1 h`); acceptances 1 / 1; P-Bilanz max A1 5 (4 aging reserved + 1 new, then belegt 1 + 4) [D] | ledger, `M.evidence`, `pBilanz` |
| R2 effective `withdrawn` → omit | = K10 | | |
| R3 lifted tombstone → resubmit | = K7a (and K7b for the order) | | |
| R4 `burn` (fixture, measured) | W2; crafted `stock-revision@2` of A1's writer under another `inc` tag with `burn: [inc of xA]`, delivered to M1 while M1 holds `tA` after a `before-send` crash | evidence state of `xA` and whether `tA` is resubmitted: [M] (the core has no `burned` evidence case, 5.1; draft 3 §1.2 omitted on burn; open point 10) | measured |

## 5. B13 (i) and (ii)

| case | sequence | Soll | asserted by |
|---|---|---|---|
| (i) receipt signed by another A device | W2+A2 with `Ax`, `Ay`; withhold `Ax`'s receipt at M1; fixture: `Ay` signs a delivery-ack with `ref = tA` under its own key, sealed to `tA`'s `replyTo`, deposited at M1 | M1: 1 `failed(ack-from-unexpected-signer)` (`expected = xA` anchor, not a set root, so `peerIn` is plain equality); knowledge A stays unknown; after the reset `Ax`'s receipt → accepted [D] | M1 dispositions, state |
| (ii-a) receipt reaches another M device, re-sealed (only if cheap, decision 7; otherwise measured) | W4; M1 issues; fixture: the side's signed receipt document re-sealed to M2's key agreement of its context on the A relationship, deposited at M2 | M2: 1 `failed(ack-unbound)`, `unboundAcks` 1; M2 knowledge from M1's journal only (accepted after M1's batch); M1 accepted from its own receipt; the act ends regularly (Z), no hang [D] | M2 dispositions, measures |
| (ii-b) the same bytes misrouted (main fixture, decision 7) | the frame sealed to M1's `replyTo` deposited at M2's address | M2: 1 `failed(malformed): …` (it cannot open it), no `accepted` at M2 from it, no hang; M1 `accepted` only from its own receipt [D] | M2 dispositions |

## 6. Budget-cause fixture (1, `budget`)

W2. Test hook: A1's `acceptanceShare` returns 0 (`share` artificially lowered).
`M1.introduce`; 3 rounds; Z.

| quantity | Soll | derivation | asserted by |
|---|---|---|---|
| `xA` at A1 | consumed [D] | 8640.13: `occupied 0 ≥ share 0` → `ticket-refuse-budget` | A1 stock |
| A acts / receipts / load (belegt, budgetUsed) | 0 / 0 / 0 / 0, `belegt` unchanged [D] | the branch returns before the op and before `refill` | ledger |
| A1 supply afterwards | none (free = max(0, 0 − 0 − 3) = 0) [D] | the hook also lowers the supply share | ledger allocate ops |
| B acceptance / load | 1 / 1 [D] | | ledger |
| dead tickets | `budget` 1 (fixture), `deadAccepted` 1 [D] | | dead counter |
| P-Bilanz with the run share 5 | 0 violations [D]; with share 0 it would fail (reserviert 3 > 0), not asserted | | `pBilanz(b, 5)` |

## 7. Count of numbers

Derived `[D]`: 215 marked values across K1–K10, the act-end, restart,
resumption, B13 and budget tables (one marker per value or per row of values;
relational values such as `m*` and `k + 1` included). Measured only `[M]`: 2
(K4 follow-up issuance, R4 burn). Pending a decision `[O]`: 0 (the three were
resolved by the decisions below: K3 and T2 transport `handed`, K5b `down`).

## 7a. Corrections found while building (phase 2)

- K2: the journal from M2 to M1 is withheld too (above).
- K1a: `omitted:accepted` is the holder's measure; P-Produktion counts the issuance kept.
- The restore marker of the store holds until the device's next commit (not until the next rebuild): X21 restores A2 from
  an image and crashes it before its first commit; a restart then started from the loaded image, kept that image's
  incarnation and rewrote batches #2–#6 of it (5 MV-3 conflicts at A1). With the marker held until a commit, that rebuild is
  fresh again and X21 is back to 0 conflicts.
- N3/N4: the image is taken at k batches, one more batch follows, then the image is loaded; the mutation clears the
  store's marker (test-only).
- R4 (measured): the burn makes `xA` `withdrawn` at M1, `tA` is not resubmitted, 0 acceptances.

## 8. Current code against the design (for the build)

- The deliverer has no clock and no `expire`; before the first carrier
  acceptance it never gives up (`Zusteller.advance`), after it it repeats until
  `HORIZON.giveUp` rounds.
- `onAck` ignores ticket receipts (tickets are not in `sent`); only the
  submission turns `delivered`. No acceptance knowledge exists, at M or in M's
  journal.
- The ticket payload has no MV-24 shape (`dispatch` checks revision and card
  only); the batch parser does not check the issuance composition (draft 2 §2.3).
- `reload()` always creates a new incarnation (`K1aDevice.restore`: `inc =
  fresh()`, `n = 0`); there is no restart/image marker; `scenarios.ts` image
  restores and `welt.steal` share the path.
- `round()` releases held submissions in the online block before `tick()`, so
  a deadline enforced only through `expire` from the tick lets a resumption out
  one round late (K5b; open point 9). The release is not gated on evidence.
- Side ticket branch (`ticketAcceptance` 8640.3) refuses at `now > expiresAt`
  (no skew); 8325.A8 expires `consented` at `now > expiresAt`; the card branch
  already uses `expiresAt + act-skew` (§5.2: three places, behind a K2 option).
- `depart` discards only unreleased submissions whose address is a tuple peer
  key agreement of the departed relationship; ticket addresses are stock keys, so
  today neither ticket is cancelled (K8b, K8c), and an `awaiting-transport`
  submission (report set) is never discarded.
- The return values of the two `sendDoc` calls of an issuance are ignored
  (`introduce`; draft 2 §2.2 no. 3).
- A card to a stock key the side holds as withdrawn or consumed, with no act,
  is buffered and acknowledged (`dispatch` card branch, `!a`), while §1 (8850.5)
  says refusal without ack (open point 8).
- `introduce` picks the "smallest anchor" with `localeCompare`; `supply` sorts
  members with `.sort()` (code units) and the canonical order elsewhere is
  `M.byCode` (open point 16).
- P-Produktion knows only the original duty; it has no omission reasons and
  no rule for a window that lies after `TB` (1.4; open points 2, 6).
- The bench's `consentReserveMs` is P1D; inventory 8155 states P7D (not a 2b.2
  question; the sheet uses the bench value).

## Decisions before build (coordinator for Anton, 21 October 2026)

1. K5: submission after a `before-send` crash, restart at `TB` (K5a) and `TB + 1 s` (K5b).
2. P-Produktion obliges only over rounds in which submission was admissible (usable, evidence `listed`/`unlisted`, before `TB`); a k-window wholly after `TB` or inside an outage counts as `down`, no violation; "a later act end is no excuse" holds for production possible before `TB`.
3. After `expire` of an intent the carrier already accepted, the transport stays `handed` (no withdrawal), never `given-up`; a late receipt makes it `acked`.
4. Dead-ticket counter per act, by the cause of the failed side; `deadAccepted` separate, as in this sheet.
5. K8c with the new bench fault (deposit at `xA` unreachable) is admissible; the crash variant is measured only.
6. The P-Produktion window is k rounds from the first round in which submission is admissible; when the evidence returns to `listed` the window starts again (general rule in NOTES).
7. B13 (ii): main fixture "carrier delivers to M2's address" → M2 `failed(malformed)`, no `accepted` at M2, no hang; the issuer gets `accepted` only from its own receipt; the `ack-unbound` variant only if cheap, otherwise noted as measured.
8. A card to a key the side does not hold as `active`/`aging` is refused without ack (8850.5 sharpened) in 2b.2, with a fixed test; NOTES mark it "derived (core §1, Anton may veto)".
9. `TB` is checked in the release (`round()`) and in the resumption themselves; `expire` from the tick only drives the deliverer state.
10. `burned` is treated like `withdrawn` (draft 3 §1.2); R4 stays measured until 2c.
11. Acceptance knowledge at siblings: journal op `ticket-ack@1 { act, side, receiptDigest, at }` with an MV-24 shape, written only by the issuer.
12. Crash points: the code names hold (`before-send`, `between-sends`, round `after-commit`); the mapping to §6 is in NOTES.
13. Submission with known `accepted` is omitted (saves transport, no outside effect, 8640.4); measure `omitted:accepted`; NOTES mark it derived.
14. K4 follow-up issuance measured, as in this sheet.
15. `withdrawn`/`burned` also ends the deliverer's repetition (`expire(digest, 'withdrawn')`); K3 Soll 1 deposit instead of 2 (re-derived above).
16. One order: code units (`M.byCode`) everywhere, `introduce` switched from `localeCompare`; no K2 cell may flip (details and measures may change).
Side finding: the bench keeps `consentReserveMs` P1D against 8155 P7D; spec follow-up in NOTES.

## Open points before build (answered by the decisions above)

1. **K5-Folge nicht konstruierbar wie geschrieben.** §6: „M committet X bei
   `expiresAt − consent-reserve`“. `expiresAt` entsteht beim Commit als
   `issuedAt + 7 d`; ein Akt kann nicht an seiner eigenen Frist committet werden.
   Das Blatt liest K5 als Einreichung nach Absturz (`before-send`) mit Neustart
   genau bei `TB` (K5a) bzw. `TB + 1 s` (K5b). Bitte bestätigen.
2. **P-Produktion, wenn die k Runden nach `TB` liegen** (K5b: Gerät vom Commit
   bis nach `TB` aus). 1.4 kennt nur `rueckzug` und `abgang`; „späteres Aktende
   keine Entschuldigung“ steht gegen 5.1 („Einreichung endet bei `TB`“).
   Vorschlag: Pflicht nur über Runden vor `TB`; fällt das Fenster dahinter, Zählung
   wie `down` (kein Verstoß). Entscheidung nötig.
3. **Transportzustand nach `expire` einer schon vom Träger angenommenen
   Absicht**: bleibt `handed`, oder `given-up`? 5.2 sagt „späte Quittung zählt
   (given-up → acked)“, nennt den Übergang nach Trägerannahme aber nicht.
4. **Einheit des Zählers toter Tickets**: je Akt oder je Seite/Ticket, und wem
   die Ursache zugerechnet wird. Das Blatt zählt je Akt nach der Ursache auf der
   gescheiterten Seite, `deadAccepted` getrennt.
5. **K8c nach Absturz nicht eindeutig**: nach `between-sends` weiß das neu
   gestartete M nicht, dass das erste Ticket beim Träger ist (Abbild vom Commit);
   8232.1 „nach Einreichung des anderen“ wäre aus Ms Wissen „vor beiden“. Das Blatt
   baut K8c mit einer neuen Prüfstandsstörung (Einlieferung an `xA` unerreichbar).
   Zulässig? Die Absturzvariante würde gemessen.
6. **Fenster von P-Produktion bei vorübergehender Unterlassung** (K7a): beginnt
   das k-Runden-Fenster neu, wenn der Nachweisstand auf `listed` zurückkehrt? Das
   Blatt legt K7a so, dass die Einreichung in Runde 2 liegt; die allgemeine Regel
   fehlt.
7. **B13 (ii) Fixture**: „Träger stellt an die falsche Adresse zu“ ergibt bei
   M2 `failed(malformed)` (kann nicht öffnen), nicht `ack-unbound`. `ack-unbound`
   setzt voraus, dass die signierte Quittung an M2 neu versiegelt wird. Welche
   Fixture ist gemeint? Das Blatt führt beide.
8. **Karte an einen nicht mehr `active`/`aging` gehaltenen Schlüssel** (§1,
   8850.5: ohne Ack abweisen) widerspricht dem heutigen Pufferzweig (puffert und
   quittiert). Gehört der Umbau zu 2b.2? Kein K-Lauf prüft ihn bisher.
9. **Ort der Einreichungsgrenze**: die Grenze `TB` muss in Freigabe und
   Wiederaufnahme selbst geprüft werden, nicht nur über `expire` aus dem Tick (die
   Freigabe läuft in `round()` vor dem Tick). Bestätigung, dass 5.1 so gemeint ist.
10. **`burn` und Wiederaufnahme**: Kern 5.1 unterlässt nur bei `withdrawn`,
    Entwurf 3 §1.2 auch bei `burned`. R4 bleibt gemessen; soll der Bau `burned`
    wie `withdrawn` behandeln?
11. **Annahmewissen bei den Schwestern**: braucht eine neue Journaloperation
    (Quittung → `accepted`) mit MV-24-Form; Name und Form sind nicht entworfen.
12. **Benennung der Absturzstellen**: §6 `between-tickets`/`after-commit` gegen
    Code `between-sends`/`before-send` (Ausstellung) und `after-commit` (Runde).
    Das Blatt bildet ab; bitte bestätigen.
13. **Einreichung trotz bekanntem `accepted`**: nach Neustart reicht M1 `tA` ein,
    obwohl die Quittung in derselben Runde schon gefaltet wurde (K1a: 2 Einlieferungen).
    5.1 nennt kein Unterlassen bei `accepted`; harmlos (8640.4). Soll es so bleiben?
14. **K4-Folgeausstellung**: ob nach je einem freien Recht bei A und B dasselbe
    leere M-Gerät beide bekommt, hängt von den Ankern zweier unabhängiger
    Beziehungen ab; nur messbar.
15. **Wiederholung eines eingereichten Tickets an einen bei M `withdrawn`
    bekannten Schlüssel** (K3): 5.1 regelt Einreichung und Wiederaufnahme, nicht
    die Wiederholung durch den Zusteller. Das Blatt nimmt an: Wiederholung bis `TB`
    (Soll 2 Einlieferungen). Soll `withdrawn` auch Wiederholungen beenden?
16. **Ordnung für „kleinster Anker“**: `introduce` sortiert mit `localeCompare`,
    `supply` und Kanonform mit Codeeinheiten (`.sort()`, `M.byCode`). Für die
    Sollwerte relativ (benannter Schlüssel = Minimum nach der gebauten Ordnung);
    vor dem Bau eine Ordnung festlegen.
