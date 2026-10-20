# K2: device keys (step 1), device sets and one card per act (step 2a)

Plan E15, sections 6o.4, 6r, 6s and 6t (`rltp/design/port-experimente-e15-mehrgeraet-plan-2026-10-17.md`).
Candidate `k2-device-keys` (K2-strict, M as single-writer fixture) in
`index.ts`, counter-run `k2-device-keys-distributed-m` (two M devices, no
split); tests `tests/mehrgeraet-k2.test.ts`; measurements
`src/lab/mehrgeraet/geraetemengen.ts`. K2 reuses K1a's journal, holder and
model (`src/lab/mehrgeraet/{holder,model,welt}.ts`,
`src/candidates/mehrgeraet-k1a`). Step 2a comes first; the step-2
sections follow where they still hold (with the parts 2a removed marked),
then step 1.

## Step 2a (20 October 2026)

Step 2 (#74) did not hold as a whole: gate reviews 33–39 found fourteen
blockers, the last ones (B9–B14) all in M's distributed issuance and
restore. Astra's root review (plan 6t) cut it along the invariant
"proof → decision → exclusive acquisition → durable external effect":
2a takes the parts that held, 2b redesigns M's issuance. Anton, 20
October: (1) 2b with the core of step 5 (A assigns stock keys per M
device); (2) restore rule (iii), nobody waits for anybody (MV-34), no
service is a prerequisite (MV-35), MV-6 new: no gate after restore for A
and M; (3) MV-30, MV-31, MV-32 adopted; strict, the shared variant goes.

**What 2a is** (accepted scope of this PR):

- `device-set@1` with proof fold, cumulative revisions, signed `deps`,
  enrolment admission, unknown / known-empty / revoked kept apart, limit
  S1 named (below, "Limits of step 2").
- Card set reference with historical cover through `deps` and the full
  key binding in the buffer; E1 (a), E3 (a); producer rule E2 (iv).
- Tombstones per anchor, person-wide on class off (`personWide` when the
  class is off; B6 stays closed); `buried`, `viewKeys`, `usableView` and
  its consumers (selection, rights check, `stockAt`, scenario measures).
- Receive, fold, card and decryption oracles, the anchor-pair oracle
  (X18), the fold-input validation (6270 receive contract, form errors).
- Stock keys per device (strict) only.
- M as a **single-writer fixture**: the K2 scenarios give M one device
  (`bench.singleDevice: ['M']`, `scenarios.ts` `setup`, the X23 world in
  `geraetemengen.ts`); M names every usable key (`mayName` not split).

**Not accepted in 2a** (explicitly; step 2b): distributed issuance by
more than one mediator device (the right per M device comes from A,
MV-32), and restore of a mediator from an old backup as a property
(only the rule (iii) behaviour below is built and tested, not the
property suite of 2b). Cells that exercise a distributed mediator: X14
(A mediates on two devices) fails in 2a; counter-run
`singleDevice: []` (two M devices, no split): X1, X13, X14 fail.

**Removed** (from #74):

- the shared variant (`k2-shared-stock`, `stock: 'shared'`, seeds in the
  batch, `holdsStock` for the set, rotation of every live key with empty
  revision and refill on revocation, the shared-only tests R4, T2, C9,
  X23 counter-run "card late"); its measurements stay below as a closed
  comparison;
- the interim split of naming rights (`nameSlot`, the anchor cycle
  `ANCHOR_CYCLE` / `stockCtx`, `mediatorSplit`) and its tests V1, V3, V4,
  V5; 2b replaces it with A's assignment per M device;
- M's held issuance of review 38/39 (`holdIssue`, `releaseIssued`,
  `resumeTickets`, the `issuing` image field, the intent's `act` field,
  the cancel finding) and its tests W1, W2;
- the gate after restore, for K2 and K1a alike (MV-6 new, MV-34): see
  K1a NOTES, "No gate after restore".

**M's issuance (MV-30).** One step: both stock keys are checked and
acquired against the same state (`usableView`), the consumption
(`introduce`) and both complete ticket intents with their bytes are one
journal batch, committed to the store (`flush`) before any ticket leaves
the device (HSC-110, 8570.2, 8605). A crash between commit and send leaves
nothing at the carrier; after the rebuild the same bytes go out, one act
(test N1). Nothing waits for a sibling.

**Restore (rule (iii), MV-6 new).** A device rebuilt from an old image
acts at once from its reachable state. For M: it names from that state,
so it may name a key its lost incarnation already consumed; A and B
refuse the second act by rule 8640.12 (finding `… abgewiesen nach Regel
8640.12 …`, no act, no receipt), the first act stays the only one on the
key, and M takes the next key (its own consumption of the refused act
marks the key; test N2). For A: the allocating device may produce the
card of an act again when it folds the consent before its own earlier
production (same card key from the device secret, same V): B treats it
as a repetition (8910.7), no K, one connection, both A devices agree;
the person's hand-over digest moves to the canonically smaller one (test
C7). These are named prices; their frequency depends on how current the
image is (MV-6 new; measured in 2b).

**Limit of the single-use promise (gate review 40 B3).** A holds single
use only while A's reachable state holds the consumption. If A and M are
both restored from images before act α, and a second act β on the same
key reaches the restored A device before its sibling's journal, A accepts
β (B refuses it, its key is consumed). After healing both A devices hold
two accepted acts on one key; the fold reports it
(`consumption:double-accept:<key>`, the same finding on every A device in
every fold order) and both A devices agree (test B3). Named price in 2a;
2b closes it with decision D1 (b): a rebuilt device withdraws its stock
keys from before the image and refills with fresh anchors.

**Sibling pool keys after restore (gate review 40 B4).** A device restored
from an image taken after a sibling's pool arrived, which opens a new
relationship before catching up, picks the same free pool entry it had
already assigned to a relationship opened after the image. Two
counterparts (C and D) then hold the same sibling anchor with its key
agreement and can link the two relationships through it. The fold
reports `pool-use: Schlüssel <device>#<i> zwei Beziehungen zugewiesen` on
both A devices, which agree (test B4). Named price in 2a; 2b (note only):
a rebuilt device discards pool entries from before its image and uses
only entries provided after it.

**No progress guarantee across restores (gate review 40 (c)).** "M takes
the next key" holds per call from the reachable state. Restoring M again
and again to the same old image names the same consumed key each time
(each refused by 8640.12); progress across restores is not promised in
2a. 2b's D1 (b) gives it (the rebuilt device's old keys are withdrawn).

**Results (two devices at A and B, M one device; X1–X18, X7b, X21):**

| | K1a | K2 step 1 | K2 step 2 (#74, strict) | K2 step 2a | note |
|---|---|---|---|---|---|
| X1 | ✓ | ✓ | ✓ | ✓ | one M device (fixture) |
| X2 | ✓ | ✓ | ✓ | ✓ | |
| X3 | ≈ | ≈ | ≈ | ≈ | rule 2 |
| X4–X6 | ✓ | ✓ | ✓ | ✓ | X6: M now issues the ticket (one device names every key) |
| X7 strict | ✗ | ✗ | ✗ | ✗ | frozen candidate lists (2300) |
| X7b, X8 | ✓ | ✓ | ✓ | ✓ | |
| X9 | ✗ | ≈ | ≈ | ≈ | thief reads 0 after the revocation |
| X10 | – | – | – | – | K2b |
| X11, X12 | ✓ | ✓ | ✓ | ✓ | X11 journal 52.5 kB (#74: 60.9 kB, no shared seeds, one M device) |
| X13 | ✓ | ✓ | ≈ | ≈ | structural (MV-9 under device keys) |
| X14 | ✓ | ✓ | ✓ | **✗** | A mediates on two devices: without a split both name the same key, B and C refuse the second act (8640.12, 12 findings); distributed mediator, not accepted in 2a (2b) |
| X15–X17 | ✓ | ✓ | ✓ | ✓ | |
| X18 | ≈ | ✗ | ≈ | ≈ | one card, no K, anchor-pair oracle holds |
| X21 | ✓ | ✓ | ✓ | **✗** | branch forced (bench rule 6m): A2 allocated the first act's key (M's choice decides otherwise; A declines acts until M names a key of A2). No gate (MV-6 new): A2 restored from an image before both acts folds A1's consent before its own earlier production and produces the card again from its reachable state (visible restore artefact: same card key, same V, B repetition); end state consistent (0 missing batches, 0 doubles, 0 conflicts, nobody catching up, both A devices equal) but not the state before (the hand-over digest moved), which X21's oracle requires. In the branch "A1 allocates" X21 holds (11 of 20 seeds red before the branch was forced) |

**K2 step 2a: 16 kept (X3, X9, X13, X18 under a changed promise), 3 not
kept (X7 strict, X14, X21), 1 n/a (X10).** #74 strict was 18/1/1.
Changed cells against #74: X14 (fixture limit: distributed mediator, not
accepted) and X21 (restore artefact under MV-6 new; the oracle is not
relaxed). Serial control (one device): no cell fails (#74's serial run
with the anchor cycle failed X1, X4, X14, X17 under `devices: 2` slots;
not a 2a change). K0, K1a and K1a with the journal at the service: no
cell changed against main (K1a NOTES).

**Verification 2a:** 232/232 tests in the 14 bench files on a75db3b
(K2 file with M2/M2b; K1a and K1a-service 75/75), typecheck green; after
the X21 branch forcing the K2 file again (49 + M2/M2b unchanged) and the
seed sweep `SEEDS=all`: K2-strict 20/20 and K1a 20/20 give their tables;
K0, K1a and K1a-service against main: no cell, no measure changed (only
K0's X18 detail and X21 byte measures, as on #74). Report run once.

**Tests 2a** (`tests/mehrgeraet-k2.test.ts`): matrix 2 (16/3/1), 2b
(counter-run two M devices), 2c (serial); N1 (MV-30), N2 (rule (iii) at
M, 8640.12 as a rule), C7 (restore artefact at A, consistent); the step-2
tests that still apply, strict only (S1–S10, C1–C6, C8, R1–R3, T1, U1,
V2 with one M candidate, M1–M5, J1). Seed sweep: K2-strict with the 2a
table and K1a.

## Step 2 (19 October 2026; as far as 2a keeps it)

### Anton's decisions (plan 6r)

- **Line:** state arises only from proof; what went out on proof holds;
  where two valid proofs could collide, the structure makes sure only one
  arises, instead of someone choosing.
- **E1 (a):** a relationship B bound to a thief's card (valid membership
  proof at the time) does not heal after revocation; a named price. The
  card carries a signed device-set reference; a card before its proof is
  deferred (no V, no K); a known revocation beats an older reference.
- **E2 (iv):** only the device that allocated the named stock key
  produces the card: one card per act, no selection, no new message.
  Decision 6o.5 no. 7 is replaced: two cards of one act from one device
  set do not occur structurally; if they do, it is equivocation of the
  same holder (K). The selection receipt of the design review (6q 3a/3d)
  is not built.
- **E3 (a):** a card from outside the device set is refused without K;
  K stays for two different cards of the same device, a contradicting key
  binding (8850.6 (d)), and equivocation of a set revision is a finding of
  its own (6270), not the K of an act.
- **Two variants, measured side by side:** K2-strict (a stock key's
  private part only on the allocating device, only it opens the ticket)
  and K2-shared (the private part travels in the sealed journal, "the key
  belongs to the set, production to the device"). Anton, 20 October:
  strict; shared is removed in 2a, its measurements below stay as a
  closed comparison.

### What step 2 builds

**`device-set@1`** (`https://real-life.org/rltp/e15/device-set/0.1`), a
revisioned type for the 6270 list, one set per relationship context and
person. The **root** is the anchor the counterpart verified first for
this relationship: at an encounter the anchor of the QR, after an
introduction the card anchor (the card is signed by the voucher key M
named). The truth are the **proofs**: an admission
`{root, kind: admit, anchor, keyAgreement, by}` or a revocation
`{root, kind: revoke, anchor, by}`, each DI-signed by `by`. A key is a
member if a chain of admissions leads from it to the root (`ever`) and no
revocation by an ever-admitted key names it; revocations are final, an
old list cannot bring a key back (`model.ts` `setView`). The fold is a
two-phase set: proofs only grow, so any order of arrival gives the same
set. A revision carries all proofs the signer knows (cumulative), the
digests of the revisions it knows (`deps`, signed) and a number per signer;
6270 per signer only detects repetition and equivocation (same signer,
same number, other content: the finding `Equivokation (6270)`, never K).
Receive passes every valid revision to the fold, older or conflicting
ones included; the fold decides in any order (below, "Receive passes
everything to the fold").
The signer of a revision must be the root or a key whose admission chain
is in the revision itself (signed dependencies, never "in my list right
now"). A revision signed by a key the receiver already knows as revoked
is refused (a known revocation beats; the one receive-side filter left,
see limit S1 below). Counterparts (B, M) know a
person's set only from these proofs; the bench list of step 1 is gone for
them (`DeviceDirectory` has no `recipients` any more).

**Delivery** (`holder.ts` `recipientsOf`, `sendDoc`): no proof yet means
unknown membership, the document goes to the root alone; a known set
means one sealed copy per member; a **known-empty set** (every member
revoked) is an explicit delivery failure (`failed(empty-device-set)`, no
frame at all, never to the recorded key; review 31 S1 pulled forward). A
signer is a peer only if it is a member.

**Admission of siblings** (plan 6o.2): every device keeps a pool of public
keys per sibling (`pool/<i>`, four, refilled below two; journal op
`pool`). The device that opens a relationship (encounter, card) admits
each sibling with the smallest unused key of that sibling's pool reserved
for it (`pool-use`, from then on that sibling's key for the context) and
publishes the set. Only the opening device admits by pool, so one device
never gets two keys for one context. Without a pool key the sibling stays
out until one arrives (`admitPending`, measured gap: test S10).

**Enrolment** (QR between the own devices): the new device shows its key
for every context of the person and a pool per sibling; the old device
admits it in every set where it is a member and sends one revision per
relationship (one step per root, so no journal frame exceeds 64 KiB).

**Card** (`holder.ts` `produce`, dispatch `TYPES.card`): the producer is
the device whose name the stock key carries (`StockKey.by`, set at
allocation). A consent on any other device is a consent op without card
(journal); the allocating device produces the card when it consents or
when it folds the consent (since 2a also right after a restore, from its
reachable state: a second production of the same card is a restore
artefact, test C7), never after the act's expiry. The card payload names the digest of the producer's set
revision (`set`), sent in the same step to B's voucher key. The reference
resolves against B's folded set state: it holds if B knows that revision
itself or a folded revision covers it through its signed `deps`
(cumulative revisions name every revision their signer knows), so a newer
revision that overtakes the referenced one does not strand the card. At B: the
signer must be `from` itself (the voucher key; any other key is a card
from outside the set, refused without K, E3 (a)); without the referenced
proof the card is deferred (`Missing('device-set')`: rolled back, no V,
no K, no receipt, the sender repeats; test C3); a revoked root is refused
without K (test C4); a contradicting `fromKeyAgreement` under the right
`from` sets K (8850.6 (d), test C5); two different cards of the same
signer stay 8910.8 K. The same set check runs in the buffer branch
(8910.1–.3: no buffer entry before the proof), in the buffer selection
(8640.15: a revoked root is discarded; the buffered card keeps its whole
key binding and a contradicting `fromKeyAgreement` sets K there as on
direct arrival, 8850.6 (d)) and before the pending re-check (8325.A5c). One card identity: the producer records the payload digest
`ownCardV` (as V at B, 8910.0); `withdrawLosingCards` never withdraws a
card as the loser of a digest comparison under device sets (there is no
second card), only after a decline (rule 2). 2290: the record anchor stays
that of the chosen tuple (the opener's), set changes never touch it
(test S9); 2300 unchanged.

**Ticket**: M seals the ticket to the named stock key (plan 6o.2: only the
holder of the private part opens it); the side reads the channel as the
relationship of that stock key and checks the signer against M's set on
any of its tuples: only the allocating device registered the key (test
C6).

**MV-9 under device keys**: each device keeps its own share of the stock
at M (⌈3/devices⌉ below, ⌈5/devices⌉ to) and lists only its own keys; an
acceptance counts for the device that allocated the named key, whichever
device accepted, and a device lists at most as many keys as it can still
accept. So every key M can name can be accepted (only its holder opens
the ticket, a key of a device without quota would be dead). An empty own list never goes out while
the class is on (an empty revision is 8535's class-off signal and names
the anchors it withdraws, below).

**Revocation** (`holder.ts` `revokeInSets`, after the carrier
deregistration): the revoking device writes a revocation proof in every
own set where the revoked device is a member and it is a member itself,
and sends one revision per relationship. Rotation: the revoked device's
own stock keys are withdrawn in the state (M stops naming them because
their signer is revoked in the set it holds for A). (#74's shared variant
also withdrew every live key, sent the empty revision and refilled.)
Counter-run `counterpartRevocation: false`: none of this (carrier only).

**Bench-side in step 2** (named, step 3): the person's own devices still
learn the set from the bench list (`DeviceDirectory`: journal writer check,
self addresses, sibling names); the revocation is not a journalized
operation; a pending card context (act not connected) gets revocation
entries only from devices that are members of its set; enrolment and
restore do not yet check revoked writers (review 31 S2). Since MV-6 new
there is no gate after restore; the tests' `rogue` (a thief's own
software ignoring a gate) is kept and changes nothing.

### Results of #74 (two devices also at M, X1–X18, X7b, X21; superseded by step 2a above)

| | K1a | K2 step 1 | K2-strict | K2-shared | note |
|---|---|---|---|---|---|
| X1 | ✓ | ✓ | ✓ | ✓ | interim rule `mediatorSplit` |
| X2 | ✓ | ✓ | ✓ | ✓ | 0 blocked acceptances (step 1: 5); the 10th and 11th introduction take the authorized path (B6) |
| X3 | ≈ | ≈ | ≈ | ≈ | rule 2 |
| X4 | ✓ | ✓ | ✓ | ✓ | |
| X5 | ✓ | ✓ | ✓ | ✓ | 0 new frames to B, 6 repeats |
| X6 | ✓ | ✓ | ✓ | ✓ | |
| X7 strict | ✗ | ✗ | ✗ | ✗ | frozen candidate lists (2300) |
| X7b | ✓ | ✓ | ✓ | ✓ | |
| X8 | ✓ | ✓ | ✓ | ✓ | state copy 5 538 B (sets and pools); A2 addressable in every relationship after 1 round, from the counterparts' proofs |
| X9 | ✗ | ≈ | ≈ | ≈ | thief reads 0 after the revocation; step 2: counterparts from revocation entries, own devices still from the bench list |
| X10 | – | – | – | – | K2b |
| X11 | ✓ | ✓ | ✓ | ✓ | journal 60.8 kB / 57.3 kB (step 1: 28.1 kB) |
| X12 | ✓ | ✓ | ✓ | ✓ | the allocating device consents and delivers (E2 (iv)) |
| X13 | ✓ | ✓ | ≈ | ≈ | structural: at budget 9 A lists one acceptable key, M can issue only one, no race (MV-9 under device keys) |
| X14–X17 | ✓ | ✓ | ✓ | ✓ | X17: M takes both signers, 2 findings 8435 |
| X18 | ≈ | ✗ | ≈ | ≈ | one card, no K, anchor-pair oracle holds (below) |
| X21 | ✓ | ✓ | ✓ | ✓ | restore repair 11 rounds (step 1: 7); self addresses 1 125 / 1 534 frames, 3.8 / 4.7 MB; journal after 53.4 / 58.0 kB |

**K2-strict and K2-shared: 18 kept (X3, X9, X13, X18 under a changed
promise), 1 not kept (X7 strict), 1 n/a (X10)**; K2 step 1 was 17/2/1
(red X7, X18). Counter-run without the interim rule: X1, X13, X14 fail.
Serial control (one device, both variants): no cell fails.

### X23 time model

`timeModel` (`geraetemengen.ts`): 30 days, steps of 6 hours, A2 offline
from day 8 to day 22 (14 of 30 days), M introduces A to one of four
persons every day, the user consents on the first A device that shows the
act, the counterpart at once, the user confirms the acceptance budget
daily (8515; the per-device share is lifted, budget 1000). Stock key
lifetime = naming window beyond the act (8470 needs the whole act lifetime
of remaining validity: expiresAt = allocation + act-lifetime + act-skew +
window). Five runs per cell under seeded randomness (seeds 1–5; which A
device opens which relationship, and so whose keys M names, varies with
the seed); sums over 5 × 30 = 150 introductions, range per run in
brackets.

| variant | window | issued | on A2's keys | of them while A2 sleeps | expired unseen (8155) | no card by the acceptance end (8110.5) | card late at C (8110.5 at C) | connected |
|---|---|---|---|---|---|---|---|---|
| K1a | 2 d | 135 | – | – | 0 | 0 | 0 | 135 |
| K1a | 7 d | 145 | – | – | 0 | 0 | 0 | 145 |
| K1a | 30 d | 150 | – | – | 0 | 0 | 0 | 150 |
| K2-strict | 2 d | 135 | 39 (6–10) | 3 (0–1) | **3** (0–1) | 0 | 0 | 132 |
| K2-strict | 7 d | 150 | 53 (9–12) | 8 (1–2) | **8** (1–2) | 0 | 0 | 142 |
| K2-strict | 30 d | 150 | 36 (6–9) | 9 (1–3) | **9** (1–3) | 0 | 0 | 141 |
| K2-shared | 2 d | 135 | 39 (6–10) | 3 (0–1) | 0 | **3** (0–1) | 0 | 132 |
| K2-shared | 7 d | 150 | 53 (9–12) | 8 (1–2) | 0 | **8** (1–2) | 0 | 142 |
| K2-shared | 30 d | 150 | 52 (7–14) | 9 (1–3) | 0 | **9** (1–3) | 0 | 141 |

Evidence per loss (review 34 S4: every time is the time of the event,
taken from the journal op that caused it, not from the next observation;
C's side measured on its own: `cardLog` at C records every card arrival
with its outcome, `expire` op in C's journal):

| variant | loss class | issued (day) | consent cutoff / act expiry | seen / consented on A | card produced (journal) | card at C | refused at C | act expired at C |
|---|---|---|---|---|---|---|---|---|
| K2-strict | 8155 (3/8/9) | inside A2's sleep (8–14) | +6 / +7 d | never (holder online 0 steps before the cutoff) | never | never | – | 0.25 d after expiry (next step at C) |
| K2-shared | 8110.5 (3/8/9) | inside A2's sleep (8–14) | +6 / +7 d | 0.25 d after issue, on A1 | never (no `produce` op on any A device; allocator online 0 steps before expiry) | never | – | 0.25 d after expiry |
| K2-shared, review 34 counter-run (seeds 2, 3, 5, 2 days, A2 asleep days 0–8, window 30 d; test in `mehrgeraet-seeds.test.ts`) | card late (1 per seed) | day 1 | day 7 / day 8 | day 1.25 on A1 | day 8 (A2 back, `produce` op at the acceptance end) | after day 8 | `after-acceptance-end-8110.5` | day 8.25 (`expire` op in C's journal; review 35 S5) |

The table numbers did not change with the correction: under the default
sleep (days 8–22) no card is produced at the edge, so every shared loss is
a card that was never produced, confirmed now by the journals (no
`produce` op) and by C (no card arrived). The earlier classification was
wrong only where the producer returns right at the acceptance end;
Astra's counter-run shows that case, and it is now counted as a card
produced in time that reaches C too late (C refuses it with 8110.5), not
as a card never produced.

Refusals by M (a row of their own, review 33 S2; reason and M's stock at
that moment, `stockAt` on both M devices, counted with the same checks as
the choice in `introduce`):

| variant | window | refused | reason | stock at the refusal |
|---|---|---|---|---|
| K1a | 2 d | 15 (3) | no nameable key | both sides: listed, 0 usable (8470: less than the act lifetime left), on both M devices |
| K1a | 7 d | 5 (1) | no nameable key | C's side: 5 listed, 0 usable; A's side nameable |
| K2-strict, K2-shared | 2 d | 15 (3) | no nameable key | C's side: 3 listed, 0 usable; A's side nameable |
| all | 30 d (K2 also 7 d) | 0 | | |

**Evidence per loss** (review 33 S2: `timeModel` records, per lost
introduction, the measured cause, never the outcome read backwards; test
M2b checks the structure): the named key's device (holder; K2: the
allocator), issue time, consent cutoff (8155), act expiry (8110.5), when a
device of A first held the act, when the user consented, when the card
was produced (the `produce` op in the journal, K1a: the consent op with
the card; review 34 S4), at C when a card arrived, with which reason C
refused it and when C's act expired, the steps in which the holder was online and
a ticket received in that round could still have been shown before the
cutoff, the steps in which the allocator was online between consent and
expiry, and the holder's measured offline windows. Result over all 5 ×
150 introductions: every 8155 loss (strict 3/8/9) is a ticket on A2's key,
issued inside A2's offline window, with the cutoff inside it, and A2 online
in 0 usable steps before the cutoff; every 8110.5 loss (shared 3/8/9) is
consented, has no `produce` op in any A journal and no card arrival at C, and A2 was online in 0 steps
between consent and act expiry (the producer does not produce after
expiry, `produce`); no loss of another kind. The refusals are not losses
of issued introductions: they come from the counterpart's stock (C, one
device, introduced every fourth day: with a 2-day window its keys no
longer have the act lifetime left when M would name them), not from A's
sleeping device; in K1a at 2 days A's side is also unusable.

Reading: every loss is a ticket on a key of the sleeping device issued
while it sleeps, and in every run the loss equals that count. Both
variants lose the same introductions: K2-strict before consent (only the
holder opens the ticket, the consent cutoff passes unseen), K2-shared after
consent (any device sees and consents, but the allocating device stays
offline until the act expires and produces no card). Shared stock keys
move the loss from 8155 to 8110.5; they do not remove it, because
production stays with the allocator (E2 (iv)). The loss is bounded by the
sleeping device's listed share (≤ 3 keys, MV-9 under device keys), not by
the length of the sleep; it grows with the window (2 % at 2 days, 5 % at
7, 6 % at 30). K1a (one seed, every device opens and produces) loses
nothing. These numbers replace the earlier 3/9/13 (a throwaway script
whose seeding is not on record; review 33 confirmed only one seed). Now
the seeds 1–5 of the seed-sweep generator, on the head with the review-33
fix; rerun on the head with the review-34 fix (journal times, C's
evidence), same numbers. Grid dependence: steps of 6 hours; a ticket counts
as shown only from the step after its arrival, and in each step the bench
attempts the day's introduction before the world round, so a ticket issued
in a step is delivered in that step's round at the earliest. How the
results depend on this time grid (step length, order of introduction and
round) is not measured.

### X9 thief window, rotation, enrolment fan-out

Thief window (`thiefWindow`: theft of A2's image, two rounds of activity by
M and B before the revocation, two after; counted: documents the thief
reads, receipts excluded; five seeds, equal in every seed unless a range is
given):

| | K1a | K2-strict | K2-shared | K2-strict, carrier only |
|---|---|---|---|---|
| reads before revocation | 7 | 7 | 9 | 7 |
| of which tickets | 2 | 1 | 2 | 1 |
| reads after revocation | 11 | **0** | **0** | 3–5 |
| rounds until B / M know the revocation | – | 1 / 1 | 1 / 1 | – |

Before the revocation K2-shared exposes more (the thief also holds the
siblings' stock keys and reads tickets on them). After it, both variants
read nothing new; the counter-run without revocation entries keeps
reading, as K1a does.

Rotation traffic on revocation (`revocationTraffic`: A with M, B and C, A1
revokes A2; frames from A's devices to counterparts until quiet, receipts
and journal excluded):

Five seeds, frames equal in every seed, bytes within ±5 B:

| | K1a | K2-strict | K2-shared |
|---|---|---|---|
| set revisions (frames) | 0 | 4 | 4 |
| stock revisions to M (frames) | 0 | 0 | 4 (empty, then refill; one copy per M device) |
| total | 0 | 4 / 12.6 kB | 8 / 18.8 kB |
| counterparts reached | 0 | 3 | 3 |

Bench-side: the siblings learn the revocation from the bench list; a
journalized revocation, revocation entries for pending card contexts
where the revoker is no member, and the takeover of open intents are step
3.

Enrolment fan-out (`enrolFanout`: A with M and n encounters, enrol A2):

| relationships | set revisions | bytes | rounds until addressable everywhere | ceremony (QR) |
|---|---|---|---|---|
| 3 + M | 4 | 9.2 kB | 1 | 1 571 B |
| 10 + M | 11 | 25.4 kB | 1 | 2 523 B |

### X18 and the anchor-pair oracle

X18 passes in both variants from the structure, not from a missing K:
one card (`cardsProducedByA` 1, one hand-over digest), no K at B, and the
anchor-pair oracle (`geraetemengen.ts` `anchorPairOracle`, design review
6q 5a) holds: every honest device of both persons holds the same tuple,
A's own anchor is B's counter anchor and vice versa with both key
agreement keys (the two cards), every key B seals to for A's root (and A
for B's) opens a frame actually sealed to it on a device that holds the
private key, and V on each side is the payload digest of the other's card.
Counter-run: a forged counter anchor fails the oracle (test M1). Without
the producer rule (`producerRule: false`) K2-shared shows K at B (8910.8:
two cards of the same signer, the set's key) and K2-strict refuses the
second card without K (signed under a key that is not `from`) (test C2).
X18 stays marked as a changed promise: two consents (rule 1), the
terminality of 8325 only after the fold.

### Identity K0 and K1a

Under controlled randomness the 120 result objects of K0, K1a and the K1a
variant with the journal at the service (two devices and serial) match
main 69c70a1 byte for byte (checked again after the review-33 fix), with
one exception: K0's X18 detail (failed on
main and here) now also names the anchor-pair oracle's reasons. The
oracle applies to every candidate, and its reasons are reported for every
candidate (CodeRabbit #74). Outcomes and measures are the same in all
120. Shared changes take effect only under `deviceSets`: the commutative
P rule after a connect (below), the new op kinds, the X2/X12/X13/X21
scenario adjustments (allocator consents, authorized path, structural
X13, wait for the peer's ticket).

### Receive passes everything to the fold (review 33)

Gate review 33 found four blockers of one class: the receive path
filtered or discarded input before the fold saw it, so the result
depended on arrival order. One contract replaces the four spots, modelled
on the withdrawal marks of K1a step 4 (a fold as maximum, order-free):

- **Set revisions** (`holder.ts` dispatch `TYPES.deviceSet`): every valid
  revision reaches the fold with all its proofs, its number, its digest
  and its signed `deps`; nothing is dropped as "already known" or "older".
  The fold (`model.ts` op `device-set`) is a two-phase set; two proofs
  with the same key (kind, anchor, issuer) and different content keep the
  canonically smallest in the state, both versions are kept for the
  finding (`equivocal`), one finding per conflict; per signer the highest
  number counts, the same number with another digest is a 6270
  equivocation (finding, canonically smaller digest). Test R1: two
  conflicting revisions no. 99 in both orders and duplicated give the
  same set (B1; S1b covers the model alone).
- **Card set reference**: `seen` grows by every digest a folded revision
  names in `deps`; a card on revision 1 resolves when only revision 2
  (deps: revision 1) arrived, and the late revision 1 folds instead of
  being refused (test R2, B2). A card whose root a covering revision
  revokes is refused without K (E3 (a)); without any proof the card stays
  deferred and the sender reports `failed(expired-by-adapter-policy)`
  after twelve rounds, never silently (test R2b).
- **Buffered card**: the buffer keeps `fromKeyAgreement`; on assignment
  to the ticket 8850.6 (d) sets K, no connect (test R3, B3).
- **Shared rotation**: the empty revision names what it withdraws (since
  review 34 as tombstones per anchor, below; review 33 had signed number
  marks); M also folds a revision of a writer lower than the one it holds
  (keys unchanged, tombstones folded) instead of refusing it. Three devices, A3 offline, A1 revokes A2: in forward and
  reverse arrival order and with every frame duplicated, no key of A3
  that A2 knew stays nameable at either M device, and the refill stays
  nameable (test R4, B4). K1a keeps its receiver-side marks (identical to
  main).

The one receive-side filter left is S1 (limits below).

### Tombstones per anchor (review 34 B5)

Gate review 34 found that signed number marks (`clears: {writer: n}`)
had no bound: A2 signed revision 0 with `clears: {A1: 1000000}` before
its revocation, M took the mark as a maximum, and after the revocation
and A1's refill M had no nameable key. A number names keys that do not
exist yet. Now a withdrawal names the concrete anchors it withdraws, and
M keeps a tombstone per anchor:

- **Sender** (`holder.ts` `sendRevision`): an empty revision carries
  `tombstones`, the sorted anchors of the stock it withdraws, consumed
  keys left out (8570.2 marks them at M already). On class off, in both
  variants: every anchor of the person the issuer knows (its own and its
  siblings' from the journal; review 35 B6). Shared also on the rotation
  after a revocation. Strict with the class still on (an empty share):
  only the device's own anchors. `clears` under device
  keys is a form error at M (finding, no receipt).
- **Fold** (`model.ts` `applyWriterView`, op `view` with `standing: 'person'`): every
  folded revision of a signer, lower ones included, adds its tombstones
  to `tombstones[anchor]` (set of signers). Both only grow; the view is a function of the folded
  set (`viewKeys`, `buried`): order-free, idempotent under duplicates. A
  buried anchor is absent from the view whichever writer lists it, so the
  tombstone dominates any listing of that anchor, before or after it.
- **Who may bury** (review 35 B6; decision under Anton's rule 1b,
  "a decision of the person may be spoken by any device"; Anton may
  veto): class off is a decision of the person. Any member device's
  tombstone counts for any anchor of the person at M, in both variants;
  there is no standing by listing any more. A tombstone for an anchor
  nobody lists yet is kept and takes effect when a listing of that anchor
  arrives (same result in every order). Price, named: a stolen device can
  bury all of the person's keys at M until its revocation; the refill
  after the revocation restores (fresh anchors), and the rule below
  restores every old anchor a remaining device still lists.
- **Revoked signers** (`M.usableView`, `M.buried` with the
  revoked set M holds for the counterpart): a tombstone of a signer M
  knows as revoked counts only for an anchor that no unrevoked writer
  lists in its latest revision. So a revoked device never takes away a key
  a remaining device still vouches for. What a revoked device could reach
  before its revocation: every anchor of the person; after M knows the
  revocation, only those no remaining device lists (its own, withdrawn by
  the rotation anyway). Anchors created after the revocation (the refill)
  are fresh keys it cannot know (the journal is sealed to members only).
- **Strict class-off** (review 35 B6, Astra's counter-run): A1 turns
  the class off while A2 is offline; A1's empty revision names A2's
  anchors too, so M names none of the person's keys once it has folded
  it and refuses to introduce; A2 returns with its journal delayed and
  there is nothing to accept. Before the fix M still named two of A2's
  keys and an introduction led to a connection.
- **Naming split after a revocation** (found with the review-35 fix):
  the interim split rule (`mayName`, then n mod devices) read the key's
  number from the stored view, which leaves out every anchor buried at
  fold time, so a restored key stayed unnameable after the revocation.
  The review-35 fix read the number from the writers' listings instead,
  which review 36 found order-dependent (B7); since review 36 the split
  gets the canonical value from `M.usableView` (next section). T1 checks
  that M introduces again after the revocation.
- Restore and enrolment: tombstones are part of the view op
  (journal) and of the state image (`fromJson`, projection), so a
  restored or newly enrolled M device holds them (test T2).

Tests: model (all 120 orders of listing, withdrawal, refill and a
re-listing of buried anchors, with duplicates; a member buries a sibling's
anchor and one listed only later, every order; revoked rule; image), T1
(Astra's probe in both variants: the `clears` revision is refused; A2's
tombstones for A1's anchors bury them before the revocation, the named
price; after the revocation every active A1 key is nameable again), T2
(restore of M1 from an image before the revocation, M3 enrolled after),
U1 (review 35 B6, both variants, forward, reverse, duplicates: A2
offline, A1 class off, M names nothing and refuses to introduce, A2
returns with a delayed journal, no connection; restore of M1 and an M3
enrolled after: still nothing; class on again: the refill is nameable),
R4 (B4 stays closed: every order and duplicates).

### One computation of M's view (review 36 B7)

Reviews 33 to 36 each found a new blocker in the previous fix, all in how
M's usable view of a side's stock was computed: receive filtering (33),
number marks (34), standing by listing (35), and the split reading the
first listing instead of the canonical value (36: A1 lists an anchor with
n=2, A2 the same anchor with n=3; M1 learnt A1 first, M2 A2 first; both
held the canonical n=2, yet each device's split found "its" listing and
both named the key: two acts on one stock key). The cause was that each
consumer computed the view itself. Now there is one pure function,
`M.usableView(state, rel, now)` in `model.ts`:

1. writers whose signer the side revoked in one of its sets drop out
   (from `state.sets`, `M.signerId`);
2. tombstones act per `M.buried` (a revoked signer only where no
   remaining writer vouches);
3. per anchor the canonically smallest value (`viewKeys`, review 21 B1);
4. then expiry (8470) and consumption (8570.2).

It returns `listed`, `usable`, `unconsumed`; it is a function of the
folded state and the time, hence the same in every receive order.
Consumers, all reading from it:

- the key selection in `introduce` (`holder.ts`, via `nameable`);
- the naming split: `mayName` takes the canonical key (`mayName(key)`,
  K1a `n mod devices`; K2 2a: no split, M is one device; 2b: A's
  assignment per M device), never an anchor to look up;
- the rights check of an introduction (`authorize`, K1a, inherited by K2):
  the canonical key of each named anchor from `usableView`;
- the stock count `stockAt` (X23 refusals and their stock record);
- the scenario measures of M's view (X4 and X16 "M's view has no keys",
  the X17 writer detail).

Deleted: `holder.ts` `unrevokedKeys`, the selection's and `stockAt`'s own
filter chains, K2's `mayName` that scanned the writers' listings, K1a's
`mayName` that read the stored view, and the measures reading
`view.keys` (4 computations and 4 measure reads). The stored
`view.keys` stays the fold's record (K0's single-writer view, the
equivocation check on receive, the projection) and is documented as never
read for a decision. Test V2 (property: 200 seeded random orders with
duplicates of conflicting listings, tombstones and a revocation; the view
is the same, `authorize` and `stockAt` agree with `usableView`; 2a: one M
candidate, no split). V1 (two M devices learning the writers in opposite
orders) left with the split in 2a.

Review 36 S6: U1 now withholds A's journal at the returning device A2
(it was held at A1, so A2's class was already off); B6 stays closed.

R1 flakiness (review 35 verification, "red once under parallel load"):
not load. The test's oracle sorted the two conflicting proofs with
`localeCompare`, the fold keeps the code-unit smaller (`<`). Where the
first differing character of the two key-agreement keys orders
differently in the two (e.g. `Y` < `r` by code unit, `r` first in a
locale), the test expected the other proof. Measured: 38 of 3000 random
key pairs disagree (1.3 %), 3.7 % per R1 run (three orders); before the
fix 1 failure in 30 runs alone without load, after it 0 in 40.

### Removed in 2a: the split by anchor (review 37 B8) and the held issuance (review 38)

#74 bound an M device's right to name a stock key to the immutable anchor
(`nameSlot`, with an anchor cycle against starvation), then held M's
tickets until a sibling receipted the journal batch and re-checked them
when the restore gate opened (`holdIssue`, `releaseIssued`,
`resumeTickets`). Review 39 found four new blockers in that issuance path
(B11–B14: second restore, a third uninformed M device, receipts from
another sibling, a reordered catch-up answer), the second rise in a row
(two-rises rule: stop). Anton, 20 October: 2b redesigns M's issuance as one
state machine (MV-30) with A's assignment per M device (MV-32) and restore
rule (iii); 2a removes both interim mechanisms and runs M as one device.
Their measurements (refusals per M device under `n mod 2`, plain hash and
cycle) are in the plan, section 6s.

### Counter card through the sibling (8325.A5c)

Under strict the counter card reaches only the producer (it is sealed to
the producer's stock key). The re-check after a journal fold
(`connectOwed`) stays: the producer re-checks a waiting P it folded from a
sibling. Since MV-6 new the same re-check runs for K1a on the device whose
own card is submitted (K1a NOTES, "No gate after restore"). #74's test C9
(shared: the counter card first at the sibling) left with the shared
variant.

### X21 phase end under device sets

Under device sets a journal batch can be missing on a device while its
content is already in that device's state through a sibling's cumulative
revision (a `device-set` op): the projection is stable, the device is
still catching up. X21 ended each phase with `untilStable` and counted the
batch as missing one round before it arrived; K2-shared failed X21 in 5 of
60 seeds. The phase end is now `untilSettled`: as long as a batch is
missing and a device still catches up, the bench waits; a batch missing
with no device catching up still counts as missing. Without missing
batches it equals `untilStable`, so K0 and K1a are unchanged (identity
above). After the change 60 of 60 seeds pass for K2-shared and 30 of 30 for
K2-strict.

### Seed sweep (review 33 S3, standing bench rule)

`tests/mehrgeraet-seeds.test.ts`: the X15 matrix under 20 fixed seeds
(1–20) for K2-strict and K1a (2a; #74 also K2-shared). Every random source is seeded
from one versioned generator (LCG, version 1): `randomBytes` and
`randomUUID` from `node:crypto`, the global `crypto.randomUUID` and
`crypto.getRandomValues`. Each seed must give exactly the outcome table
above (K2) and K1a's table (17/2/1, ≈ X3, X18), outcome, ≈ flag and crash
flag per cell; a failure names the variant, the seed and the cells. Every
counterexample a sweep finds becomes a permanent test (the review-33
reorderings are R1–R4; the sweep after the fix found none).

#74 after the fix: 60 of 60 (20 seeds × 3 variants) gave the table. 2a:
see "Verify" at the end (`SEEDS=all`, 40 = 20 seeds × 2 variants). Runtime:
one matrix per seed and variant takes about 32 s on an idle machine, the
full sweep about 32 minutes on one core (here six shards, 15–26 minutes
under load). The default run (CI) takes seed 1 of each variant (97 s);
`SEEDS=all` runs all 20, like `REPORT=1` for the report.

### Limits of step 2

- The own device list is still bench-side (above); full revocation
  propagation, journalized revocation and the takeover of a revoked
  device's intents (X20) are step 3.
- E1 (a) is a price, measured: a thief that produces the card for an act
  on its stolen stock key before the revocation binds B to its card; A1
  never sees that card (the thief's batches are refused), so no
  revocation reaches that relationship and the thief stays bound (test
  C8).
- A thief admitted before the revocation keeps what it admitted (chain
  revocation is K2b); a revision of a revoked device that reached a
  counterpart before the revocation stays (history, E1 (a)); after it, it
  is refused.
- **S1, the remaining order dependence**: a revision signed by a key the
  receiver already knows as revoked is refused before the fold. So the
  proofs a revoked device admitted count only where its revision arrived
  before the revocation: A2 admits a further key, A1 revokes A2; admission
  first, the key stays a member at B; revocation first, it never becomes
  one (review 33, reproduced). Order independence holds for everything
  else on the receive path (proofs, numbers, deps, marks); for proofs of a
  revoked issuer it holds only once chain revocation (K2b) makes every
  proof by a revoked key void regardless of arrival. Mutual revocations (thief revokes the honest device first)
  leave the honest device out: K2b root revocation.
- A ticket on the key of an offline or lost device waits for that device
  (only it opens the ticket); #74's shared variant moved the wait to the
  card. X23 measures it.
- A set proof that arrives at a stock key for a card that never comes
  stays in the state (bounded only by acts); `deps` (and with it `seen`)
  grows with every revision; a lower set revision or stock revision folds
  and is receipted (it changes nothing the fold already holds). `deps` are
  taken as signed: a member could name a digest that never existed, which
  only resolves card references to its own set (the set content comes
  from the proofs alone).
- The commutative P rule (a pending card does not set P after the act
  connected) holds only for acts with a producer card (`ownCardV`); K1a's
  fold keeps the old order-dependent rule to stay identical (it converges
  in every K1a scenario; spec follow-up).
- A known-empty counterpart set is an explicit delivery failure: nothing
  goes out, and a set revision that could not go out is not recorded as
  published (test S3b). If such a set fills again (a late, older admission
  of a key that was never revoked), nothing resends what failed: the
  stock revision, the own set revision, or a produced card (the card stays
  undelivered until the act expires; the set revision waits for the next
  regular trigger such as refill or enrolment). One class, one rule for
  step 3: on "set no longer empty", resend every document that failed as
  `empty-device-set`, together with all entry paths (review 31 S2;
  CodeRabbit #74, three findings of this class).
- 2a: M is a single-writer fixture. With more than one mediator device
  (X14, or the counter-run `singleDevice: []`) two devices name the same
  key; the side refuses the second act (8640.12 as a rule). Which M device
  may name which key is step 2b (A's assignment, MV-32).
- 2a, restore (MV-6 new): a restored device acts from its old image.
  Named artefacts: M names a consumed key again (refused by rule 8640.12,
  a dead ticket at the side whose key was fresh), A produces a card again
  (same V, repetition at B; X21 red because the hand-over digest moves),
  a revision number reused (6270 finding), two accepted acts on one key
  when A and M are both restored (finding `consumption:double-accept`,
  review 40 B3), one sibling pool key assigned to two relationships
  (finding `pool-use`, linkable by the two counterparts, review 40 B4),
  and no progress guarantee when M is restored repeatedly to the same
  image (review 40 (c)). Frequency against image age is measured in 2b;
  B3, B4 and (c) close with D1 (b) in 2b.
- Received documents are checked against their form before any field
  access (MV-24, `DOC_SHAPES` in the model; review 40 B1): a signed
  revision without `keys` or a card without `card` is a form error
  (finding, no receipt, no effect), the round goes on (tests B1a, B1b).
- Enrolment from the log is a live ceremony that survives a reload of the
  new device: the image carries `ceremony`, the device keeps waiting for
  the witness and then works off `owed` and the ceremony's probes
  (review 40 B2; K1a-service test "Tor-Review 40 B2").
- X21's forced branch (bench rule 6m) declines acts until M names an A2
  key; each decline consumes a stock key, so after several declines M can
  find nothing nameable. The bench then waits for the refill (up to six
  times two rounds) instead of failing on M's random choice (flaky once in
  the review-40 verification run).
- X21's restore repair takes 11 rounds instead of 7 (more batches: set
  proofs, pools, revisions per writer).
- **Journal frame size (review 38 S8), a limit, not chunked.** A journal
  batch travels base64 in one journal document under Delivery's bound
  (plaintext ≤ 65 536 B), so a batch must stay below about 48.5 KB. The
  largest batch is the old M device's enrolment batch: one device-set
  document per counterpart device (intent copies), and that document
  grows with the own device count, batch ≈ D × (576 + 1250·D) B plus ops.
  Measured (D devices at A and at M): 8.3 KB (2), 15.3 (3), 24.8 (4),
  36.8 (5), 51.4 KB (6, base64 68.5 KB). Five devices per side run, six
  fail with `JournalOversize` (explicit, never silent; test J1). Splitting
  a batch over several frames is step 3's frame-size question.

### Spec follow-ups (step 2)

1. **`device-set@1` in the 6270 type list** with its scope (root per
   relationship context), the fold (two-phase, chain to the root,
   revocations final), cumulative revisions with signed `deps`, and the
   rule that a known revocation beats a later revision of the revoked
   key.
2. **8910 K separation** (E3 (a)): K only for two cards of the same signer
   and 8850.6 (d); a card under another key than `from` is refused before
   8910 without K; set equivocation is a finding of its own.
3. **Card set reference**: the card names the set revision of its root;
   it resolves against the folded set state (the revision itself or a
   revision covering it through `deps`); 8910.1–.8, 8640.15, 8325.A5c
   defer a card without that proof, refuse one whose root is revoked, and
   run the full 8850.6 check on every entry path (buffer included).
4. **8155 and 8110.5 under device keys**: with keys per device the
   consent cutoff can pass unseen (strict; #74's shared variant moved it
   to the end of acceptance); X23 gives the numbers. 8640.2 (channel) reads as the relationship of the stock key the
   ticket is sealed to.
5. **HSC-120** (unchanged from step 1): takeover after revocation is a
   re-production with the same effect identity (`card:<act>`), not the
   same bytes; step 3.
6. **MV-9 under device keys**: the quota per device travels with the keys
   it lists; 8485/8512 per device.
7. **6270 receive contract**: receive never filters; conflicting proofs
   fold to the canonical smallest with both kept for the finding; empty
   revisions (8535) name the anchors they withdraw (tombstones per anchor,
   any member may bury any anchor of the person; a revoked signer's
   tombstone never buries a key an unrevoked writer still lists), so
   withdrawal is order-free and bounded (8535 under per-signer writers;
   reviews 34, 35).
8. **Multi-writer contract, question 4.10 (class across writers)**:
   answered (Fable under rule 1b, 19.10.; Anton may veto): off wins, and
   any member device may tombstone all anchors of the person. Price: a
   stolen device can bury all of the person's keys at M until its
   revocation; the refill restores.
9. **Canonical key value for naming rights** (review 36): whatever decides
   naming rights reads the same effective, canonical key value as the
   selection (one computation of the usable view over unrevoked writers,
   tombstones, canonical value per anchor, expiry, consumption). In 2b the
   right itself comes from A (MV-32), not from a computation at M.
10. **8640.12 as a rule** (MV-6 new): a second act on a consumed stock key
   is refused by the side (no act, no receipt), whether the mediator
   restored from an old image or misbehaves; the mediator takes the next
   key.
11. **P after a decline** (MV-31): the checked counter card of a declined
   act stays as hidden P, so rule 2 can still connect (K1a NOTES).

## Step 1 (18 October 2026)

### Assumptions in force

Fable's recommendations from plan 6o.5, adopted as working assumptions
under Anton's go. Anton may overturn them; where cheap they are switches.

- **Annahme (6o.5 Nr. 1).** K2a first. Both K2 cuts keep the K1a journal;
  "without journal" (plan section 3) stays a counter-run, not built in
  step 1. K2a = device set authorised by member signature (step 2), K2b =
  certificate and rights (step 4).
- **Annahme (6o.5 Nr. 2).** The counterpart sees the device set per
  relationship; keys are derived per relationship, so the count is
  visible, the keys are not linkable across relationships. In step 1 the
  set reaches the counterpart through the bench list (below).
- **Annahme (6o.5 Nr. 3).** Revocation = carrier deregistration at once
  AND a device-set revision to every counterpart (end-to-end). Step 1 has
  only the first part plus the bench-list update; the revision is step 3.
  Switch: `counterpartRevocation: false` = carrier only.
- **Annahme (6o.5 Nr. 4).** Enrolment by QR between the person's own
  devices. Step 1: a bench ceremony inside `enrol` (public keys both
  ways, 197 B each), see "Enrolment".
- **Annahme (6o.5 Nr. 5).** X19/K1b not in K2's scope: rights stay static
  per device (MV-9), the device count is fixed.

## What K2 step 1 does

### Keys per device

Every device has its own 32-byte secret, drawn at creation (first device,
enrolment), never derived from anything the person shares. The world
still draws a seed per person and hands it to `first`; K2 ignores it, no
device holds it. The secret is part of the device's image (`persist`), so
a restore brings the same keys back and a thief with the image holds
exactly that device's keys.

| | K0 / K1a | K2 step 1 |
|---|---|---|
| key for context `ctx` | `ed = sha256(personSeed ‖ "ed/" ‖ ctx)`, `x = sha256(personSeed ‖ "x/" ‖ ctx)`: every device the same key | `sha256(deviceSecret ‖ "ed/" ‖ ctx)`, `sha256(deviceSecret ‖ "x/" ‖ ctx)`: one key per device and context |
| contexts | `self/<person>`, `enc/<id>/<person>`, `introduction/<nonce>/<n>`, `card/<act>/<person>` | unchanged names; `<nonce>` is now per device (below) |
| journal signature | none (the frame is signed by the shared self key) | Ed25519 journal key `sha256(deviceSecret ‖ "journal-sign")` per device |
| writer tag | `HMAC(sha256(seed ‖ "writer-tag"), rel ‖ device)` | none (the writer is the signing device key) |

What stays: relationship ids, tuple ids, record ids (`<id>:<anchor>`),
act ids, context names, the journal's batch keys (`<device>@<incarnation>#n`).
What changes meaning: the anchor in a tuple, a stock key or a card is the
**recorded anchor**, the key of the device that created it. Every other
device of the set holds its own key for the same context: it signs with
it, receives under it, and the counterpart accepts it (step-1 bench list).
Anchors per tuple are therefore per device now; the shared state keeps
the creator's (probe blinding and pair keys use the recorded anchors, so
both devices compute the same entries).

### Carrier registration per device

Each device registers its own rkid for every context it holds, its own
self address included (one self address per device; `HolderDevice.selfAddress`,
`Welt15.selfAddresses(person)`). The person's self address is the set of
its devices' self addresses. **The carrier does not know the device set
in step 1.** It only sees registrations; who can read what is decided by
whom a sender seals to, and that comes from a bench-side list held by the
candidate (`DeviceDirectory`) until step 2 builds `device-set@1`. A thief
that re-registers A2's addresses after the revocation receives nothing,
because no sender seals to A2 any more (X9); in the carrier-only
counter-run it keeps reading.

### Counterparts (step-1 simplification; replaced in step 2 by `device-set@1`)

A counterpart learns the person's device set through the bench list
(`recipients`): it seals every document once per device of the current
set, each copy at that device's own address (one submission, copies in
`Submission.extra` and `Intent.copies`), and accepts a signature by any
device of the set for that context (`isPeer`). The first receipt from any
device closes the submission, as under one seed. Revocation updates the
list at once. **Nothing about counterparts is measured in step 1** beyond
what X17 already showed (two writers at M); what B and M learn about
devices, the set revision and its fan-out are steps 2 and 3.

### Journal: signed by the device, sealed per sibling

- Every batch carries `sig`: the producing device's Ed25519 signature
  over the canonical batch. The frame around it is a `journal/0.1`
  document signed by the sending device's self key and sealed once per
  sibling of the current set, each copy at the sibling's own self
  address. With no sibling in the set nothing goes out.
- A sync request goes to every sibling; the answer (missing batches and
  heads) goes only to the requesting device, sealed to its self key, and
  stays bound to the request id (MV-5).
- Two signatures because relays exist: a sync answer re-sends batches of
  other devices (and of the requester's own earlier incarnations); the
  inner signature keeps the producer, the outer one the sender.
- The fold verifies before anything else (`K2Device.receiveOwnFrame`): a
  batch whose writer device is not in the current set, or whose signature
  is not its writer's, throws `UnknownWriter`; the holder records the
  finding `journal:unknown-writer@<digest>`, folds nothing, sends no
  receipt (`HolderDevice.unknownWriters`). The same finding at frame level
  when the frame's signer is no device of the current set. Then K1a's
  shape and order checks run unchanged on the batch without `sig`.
- The gate after restore lets traffic to the siblings' self addresses
  pass (journal, sync, receipts on them), as it let the shared self
  address pass in K1a.

### Writer and stock

- The writer of a revision is the signing device key of the relationship
  (8500 and 6270 per signer). The table key is `signerId(anchor)`, a
  16-character hash of the signer's anchor; it is not on the wire, M
  computes it from the signature. A device's writer in a relationship is
  its own key for the head tuple's context.
- Only the signer determines the writer (gate review 31 B1). Under
  `signerWriters` a payload field `writer` in a revision, probe or
  mapping is a form error, also when it names the signer itself: finding
  at the receiver, no effect, no receipt, the per-writer state untouched
  (`tests/mehrgeraet-k2.test.ts` 8). Before the fix the field won over
  the signer: A2 could sign a revision 1000 under A1's writer and M then
  rejected A1's next real revision. K1a (writer tags in the field) is
  unchanged (test 8b).
- Every device numbers its own stock under its own nonce
  (`stockNonce`, derived from the device secret per relationship; 8430,
  8445 per device). The person's stock is the union of the devices'
  stocks; numbers may coincide across devices, the identity is
  (nonce, n) and the anchor differs anyway. The model still reports a
  second nonce on a relationship (8435, "zweiter Vorrat"): that finding
  now marks the normal case (X17: 2) and is a spec follow-up.
- **Several M devices: removed in 2a.** Step 1 ran with an interim split
  of naming rights among M's devices (first by `n mod devices`, then by
  the anchor); 2a removed it with its tests (section "Removed in 2a")
  and runs M as a single-writer fixture (`bench.singleDevice: ['M']`).
  Per-device keys remove writer tags and number classes, but not the
  case that two M devices name the same key of A's stock; the allocation
  per M device that A enforces is step 2b. Counter-run with two M devices
  (`singleDevice: []`): X1, X13 and X14 fail (test 2b).

### Incarnation: kept

A restore brings the same device keys back from the image together with
an older journal; without a fresh incarnation the device would number
batches again from its old counter and reuse `A2@inc#n` with other
content (MV-3, gate review 7 B2). So the incarnation stays per restore,
the writer tag does not come back, and the device key stays per device.
The batch signature binds the batch to the device, the incarnation to
the run of that device.

### Enrolment

`welt.enrol` is unchanged; the K2 candidate's `enrol` is the ceremony:
the new device draws its secret, the two devices exchange name, self
anchor, self rkid and journal key (QR stand-in: 197 B each way,
`k2().ceremonies`), the bench list takes the new device, and the old
device hands over state, journal, intents and kept probes as in K1a.
The counterparts learn the new device from the bench list (step-1
simplification); `device-set@1` and its fan-out are step 2.

## What fell away from K1a, and why

| K1a mechanism | in K2 step 1 | why |
|---|---|---|
| writer tags (step 4, HMAC under a seed key, `writer` field in revision, probe, mapping) | removed; writer = signing device key, no field | with keys per device the signer is already a pseudonym per relationship |
| number classes ⌊n/devices⌋ mod devices (review 21 B1) | removed (`allocationSplit` off) | own nonce per device: two devices never produce the same (nonce, n) anchor |
| shared n under one nonce | removed | as above |
| `n mod devices` split for M (`mayName`) | removed in 2a (step 1 kept an interim split; M is a single-writer fixture in 2a) | the allocation per M device that A enforces is step 2b |
| shared self anchor as signer of journal frames, one self address | removed | journal signed per device, one self address per device |
| `conflict:key-value` | stays in the model, never fires | an anchor belongs to one device |

Unchanged and running for K2 (shared holder/model code, verified by the
X results and `tests/mehrgeraet-k2.test.ts`): fold rules 1–3, probe
re-evaluation and the retention rule, catch-up with request binding (no
gate after restore since 2a, MV-6 new; only enrolment from the log keeps
its live ceremony), the acceptance quota per device, prototype-free tables, the shape table and the form checks.

## Results (18 October, two devices, X1–X18, X7b, X21)

| | K1a | K2 step 1 | difference |
|---|---|---|---|
| X1 double consumption | ✓ | ✓ | same (interim rule). Without it: M1 and M2 name the same key once, one double consumption at M, 12 × 8640.12 at A (✗) |
| X2 budget at 9 | ✓ | ✓ | 5 blocked acceptances instead of 7 |
| X3 consent ∥ decline | ≈ | ≈ | same |
| X4 class off ∥ send | ✓ | ✓ | same |
| X5 departure ∥ replay | ✓ | ✓ | 0 new frames to B; 4 repeats (K1a 3): the copies to B2's addresses count |
| X6 restore from backup | ✓ | ✓ | same keys from the image, new incarnation, converged after 1 round; the next ticket is refused as in K1a (split); without the interim rule it is issued |
| X7 strict | ✗ | ✗ | same (device sets do not change frozen candidate lists) |
| X7b | ✓ | ✓ | same |
| X8 enrolment | ✓ | ✓ | state copy 3 545 B (K1a 3 546); QR 197 B each way |
| X9 revocation | ✗ (thief reads 5, holds 1 act) | ≈ (thief reads 0, holds 0) | passes only under the step-1 simplification, marked as changed promise; carrier only: ✗ (thief reads 2, holds 1 act) |
| X10 | – | – | no rights per app (K2b, step 4) |
| X11 long separation | ✓ | ✓ | journal 28 086 B (K1a 22 920) |
| X12 delivery per device | ✓ | ✓ | 24 × duplicate-known at B (K1a 30) |
| X13 mediator devices against the budget | ✓ | ✓ | same (interim rule). Without it: budget holds (10, no overrun), but one key named twice at M (✗) |
| X14 double introduction | ✓ | ✓ | same (interim rule). Without it: A1 and A2 (A as mediator) name the same keys of B and C, 2 double consumptions, B and C refuse (8640.12) (✗) |
| X15 union ∥ running act | ✓ | ✓ | same |
| X16 old stock after class revocation | ✓ | ✓ | same |
| X17 parallel production | ✓ | ✓ | M takes both writers (signers), 0 linkable; 2 findings 8435 at A (two nonces, the normal case now) |
| X18 two cards of one act | ≈ | ✗ | the two devices' cards differ (card keys per device), B marks K (8910.8) on both B devices; still one consent, one connect, no double effect. Decision 6o.5 no. 7 (step 2) |
| X21 journal robustness | ✓ | ✓ | repair 7/1/1/1/1 rounds as K1a; self addresses 781 frames / 2.54 MB (K1a 813 / 2.16 MB), journal frames 395 / 2.07 MB (K1a 395 / 1.66 MB), journal 27.6 kB (K1a 22.5 kB), receipts 323 (K1a 355) |

Counts (step 1 as measured on 18 October, with the interim split that 2a
removed): **K2 step 1 (interim split on): 17 kept (X3 and
X9 under a changed promise), 2 not kept (X7 strict, X18), 1 n/a (X10)**:
the K1a count, red X7 and X18 instead of X7 and X9. Counter-run without
the interim split: 14 / 5 / 1, red X1, X7, X13,
X14, X18. X18 stays red in step 1 by design: decision 6o.5 no. 7 (two
cards of one act from the current set are a repetition) is step 2. Serial control
(`k2({ devices: 1 })`): every cell with a control run passes, as K1a.
K1a: 17 / 2 / 1 unchanged; K0: 1 / 18 / 1 unchanged.

**Identical K0 and K1a.** Under controlled randomness (UUIDs,
`randomBytes`, `getRandomValues` seeded per scenario) all 80 result
objects of K0 and K1a (two devices and serial, every detail and measure)
and all 40 of the K1a variant with the journal at the service are
byte-identical to main 2487c9c. The shared code only changes behaviour
when a candidate supplies the new optional methods (`recipients`,
`selfPeers`, `selfDevice`, `signerWriters`, `stockNonce`).

## Fan-out cost

Scripted flow (A, B, M; one introduction, both consent; measured with a
throwaway script, numbers from one run; the frame counts are asserted in
`tests/mehrgeraet-k2.test.ts` 6):

| | K1a, 2 devices | K2, 2 devices | K1a, 3 devices | K2, 3 devices |
|---|---|---|---|---|
| journal frames for 5 batch sends | 5 / 19 421 B | 5 / 20 205 B | 5 / 19 432 B | 10 / 40 408 B |
| tickets from M (one to A, one to B) | 2 / 3 219 B | 3 / 4 830 B | 2 / 3 220 B | 4 / 6 440 B |
| receipts on the self addresses | 24 / 28 434 B | 20 / 23 696 B | 71 / 84 122 B | 51 / 60 429 B |
| own frames total | 29 / 47 855 B | 25 / 43 901 B | 76 / 103 554 B | 61 / 100 837 B |
| journal held | 14 959 B | 15 542 B | 14 973 B | 15 542 B |

- Journal: one copy per sibling (devices − 1) instead of one frame on a
  shared address; with two devices the same count, about 4 % more bytes
  (batch signature 88 B); with three devices twice the frames.
- Counterpart documents: one copy per device of the receiving person.
- Receipts fall: a receipt goes only to the sending device's own
  address (K1a: every device of the shared address collected them).
- Journal size: the signature and the copies inside production intents
  (each copy is the whole sealed document) make it larger: +4 % in the
  short flow, +22 % in X21, +23 % in X11.

## What the thief can do (X9, step 1)

- **Before the revocation** the thief with A2's image is A2: it reads
  every copy sealed to A2 (revisions, tickets, journal frames from A1,
  sync answers to A2's requests) and nothing sealed to A1; it never
  collects at A1's addresses (`tests/mehrgeraet-k2.test.ts` 3). It can
  sign frames A1 accepts at frame level (A2's self key), but every batch
  it writes carries its own writer name, which is not in the set: A1
  records `journal:unknown-writer` and folds nothing (test 1d). A thief
  that kept A2's name could write batches A1 folds; that is the residual
  until revocation (plan 6o.3, "Sicherheitsrest").
- **After the revocation** (carrier deregistration, bench list updated)
  it reads 0 new documents and holds no new act; its frames are rejected
  at frame level. This holds only under the step-1 simplification: the
  counterparts learn the revocation from the bench list at once. With
  the carrier alone (`counterpartRevocation: false`) the thief
  re-registers A2's addresses and reads 2 documents and holds an act (X9
  ✗), the counter-run plan 6o.3 asks for.

## Limits of step 1

- The device set reaches counterparts through the bench list; no
  `device-set@1`, no member signature, no revision fan-out, no window in
  which B still seals to a revoked device. X9's ✓ is therefore marked as
  a changed promise (≈), never as fulfilment.
- The bench derives every device's key for every context on demand, also
  for contexts another device opened; in step 2 a device gets its
  siblings' public keys from a stock exchanged at enrolment and over the
  journal.
- Revoked writers (open question 3): every batch of a device outside the
  current set is rejected, also its batches from before the revocation
  that a sibling relays later (a device enrolled after a revocation gets
  the journal by copy, so no scenario hits it). This retroactive
  rejection is recorded as input for step 3: a revocation mark per writer
  (Widerrufsmarke je Schreiber) that separates the batches signed before
  the mark from those after it. No change in step 1.
- The history depends on the entry path (gate review 31 S2): a sibling
  that relays an old batch of a revoked device gets `unknown-writer` (no
  fold, no receipt), while enrolment takes over the same already applied
  batch with the state unchecked, and restore takes over the image. Input
  for step 3: enrolment and restore apply the revocation marks per writer
  too, so a revoked device's batches are rejected on every entry path,
  not only on relay.
- An empty device set (gate review 31 S1): when the last recipient
  device leaves the `DeviceDirectory`, `recipients()` returns `[]` and
  `sendDoc()` still seals one frame to the recorded address (the key of
  a revoked device). Input for step 3: an unknown key and a known empty
  set are different cases; the known empty set is an explicit delivery
  failure, never a frame to the recorded key.
- Fixed device count and static rights as in K1a (assumption no. 5).
- X1, X13, X14 pass only through the interim rule (K1a's static split
  at M) until step 5 builds the allocation per M device.
- X18 fails until decision 6o.5 no. 7 (step 2).
- No variant with the journal at the service for K2.
- The carrier sees one registration set per device; whether it can link
  a person's devices (registration sessions, timing) is not measured.
- What the carrier learns under K2 (gate review 31 S3): more addresses
  per person (one per device and context, one self address per device)
  and sending patterns that can be correlated: with three devices one
  journal send is two copies at the siblings' self addresses, one
  document to A is three copies at the same moment. The address count
  alone does not tie the addresses to a person; the timing of the copies
  may. Measure for step 3: addresses per person at the carrier and the
  share of copies that leave together. Whether this is acceptable is a
  decision for Anton (with 6o.5 no. 2).
- The production intents carry every copy's sealed bytes; that is the
  largest share of the journal growth.

## Spec follow-ups

1. **Identity: derivation per device.** Identity reserves the `device/`
   prefix for a per-device root (§15.1) and requires that a device key
   authorised for one anchor is never reused under another (context
   scoping). K2 derives every key per device and context from a device
   secret that is not derived from the root IKM; the bench meets the
   context-scoping rule. Open: whether the device secret is a random root
   (as here) or derived under `device/…` from the root IKM (then the
   root must not be on the device), and how recovery without any device
   (Magic Words) re-creates a device set.
2. **2290, record anchor under device sets.** The bench keeps the
   creator's anchor as the recorded one (record id `<id>:<anchor>`, the
   smaller own pair anchor in the inventory). Under a device set the
   relationship has one anchor per device; 2290 must say which one is the
   record anchor (the opening device's, the set's smallest) and how
   2300/6806 blind it, or every device's anchor must be a candidate.
3. **HSC-120 against takeover.** Same bytes stay with the producing
   device (MV-8 unchanged); an intent now carries one copy per recipient
   device. A takeover after revocation (X20, step 3) cannot continue the
   same bytes (signed by a key the counterpart now refuses): HSC-120's
   "same bytes" has to make room for a re-production with the same
   effect identity (MV-21).
4. 8435/8445: a second stock under another nonce is the normal case with
   keys per device; the finding "zweiter Vorrat" needs a new reading
   (Folgepunkt 12, step 5).
5. 8500/6270 per signing key: the writer of a revision is the signer, no
   writer field; MV-11 shrinks to "number per signing device key".
6. 8910.7/.8: two cards of one act from two devices differ (X18); 6o.5
   no. 7.
7. Journal signatures: what signs a batch (the producing device's journal
   key) and what signs the frame (the sender's self key), and that relays
   need the inner signature.

## Verify

```sh
export PATH=/home/fritz/.n/n/versions/node/24.21.0/bin:$PATH
pnpm vitest run tests/mehrgeraet-k2.test.ts
SEEDS=all pnpm vitest run tests/mehrgeraet-seeds.test.ts   # 20 seeds × K2-strict, K1a (default: seed 1)
REPORT=1 pnpm vitest run report   # column k2-device-keys in the multi-device port
```
