# Port notes: K1a, one seed, operation journal, static rights (E15 steps 1 to 5)

As of 18 October 2026; since 20 October without a gate after restore
(MV-6 new, MV-34, section "No gate after restore" at the end). K1a is the first positive candidate of the
multi-device experiment: every device derives all keys from the same seed
(like K0), but every committed step of a device travels as one journal
batch to the person's own address, and the rights that consume a hard
limit are assigned to one device in advance. Since step 4 every device
numbers its revisions under a pseudonymous writer tag per relationship.

## What the candidate does

- **Transaction = batch.** The device commits each successful step
  (user action, received frame, time step) as one unit: the operations
  it applied and the production intents it created (digest, sealed bytes,
  address, expected receipt signer, reply address, producing device and
  incarnation). The batch key is the writer incarnation plus a counter.
  Every batch carries the last batch key seen from every writer
  (including the device's own previous batch, and batches with intents
  only); a device applies a batch only once all those heads are known,
  otherwise the frame is deferred, and exactly once.
- **Catch-up over the self address (HSC-440).** After a restore, an
  enrollment or a deferred batch the device sends its heads as a
  `journal-sync` document to the person's own address; every sibling
  answers with the batches the requester lacks, including the requester's
  own earlier incarnations, and with its own heads. The requester keeps
  asking with backoff (1, 2, 4, up to 16 rounds) until an answer shows
  that its heads cover the answerer's, so a lost request, answer or
  receipt does not end the repair (gate review 9). The bench counts a
  repair as finished only when no device of the person still waits for
  catch-up and the self address stays silent for longer than the largest
  re-request interval (gate review 11). A device restored from
  an old backup thus recovers its own history (consumed keys, accepted
  acts) and the siblings' steps; X6 passes. Two requests at once, a
  restore during an answer and a double restore were checked by the
  review. **Input contract of the fold** (gate reviews 26 B2 and 27 B2a):
  a journal frame is checked for form before anything is folded, deep, on
  both journal paths (mailbox and log) with the same check. One table of
  nested shapes in model.ts (`Shape`, `SHAPES`, `OP_FIELDS`,
  `shapeProblem`): payload an object whose body is strict base64; batch
  with exactly writer, counter (positive integer), deps (batch keys),
  ops and intents (`batchProblem`); every op with id (writer, integer
  n ≥ 0), a readable time, a known kind and exactly its fields, down to
  every value that becomes state (`opProblem`): stock keys and listed keys
  (anchor strings, n integer ≥ 0, readable expiry, state from the enum),
  tuples, cards, acts and mediator acts (every field, enums, nullable and
  optional parts), view and allocation key lists, `candidates`, `deps`,
  anchors and act lists as arrays of strings, pairs and edges of length 2;
  intents with a document digest of the bench's form (multibase sha-256)
  and string fields, bytes strict base64 (length, alphabet, padding:
  the round trip gives the same string; `INTENT_FIELDS` in holder.ts);
  the transaction the candidate returns again (`transactionProblem`).
  Numbers are never NaN or infinite. Gate review 28 closed the class of
  inherited keys: **keyed tables never carry a prototype; reads use own
  properties only** (model.ts `table`, `own`, `put`; `aliases`, the
  writers of a relationship, the writers and clears of a view, the cards
  of an act, the clears of a view op, the journal heads), and a store
  image or clone is rebuilt into such tables on load (`fromJson`,
  `cloneState`, used by `reload`, checkpoints and enrolment). On top, the
  shape table gives every identifier and every table key its grammar
  (`GRAMMAR`: `ident` for ids, anchors, rkids and context names, `tag`
  for writer tags as 16 base64url characters, `writer` for
  `<device>@<incarnation>`, `dep` for `<writer>#<n>`, digests and nonces
  in their alphabets) and rejects reserved names (`RESERVED`: the
  properties of `Object.prototype` such as `__proto__`, `constructor`,
  `toString`, and `prototype`) as keys and identifiers at any depth; the
  heads of a `journal-sync` and the writer tag of a counterpart's
  revision are checked the same way. A frame that fails the check, or whose fold throws anything
  but `Missing` (deferred) or `Blocked`, is corrupt: the step is rolled
  back, no receipt, one finding `finding(journal:corrupt-frame@<digest>)`
  per digest, and the round goes on (the sender's deliverer repeats it,
  the finding stays one). Later frames fold as before: the mailbox has no
  order, `deps` keep causality (a batch that names the corrupt one stays
  deferred). A corrupt batch never joins the heads, so a sibling answer
  that names it does not cover them (catch-up goes on; since MV-6 new
  this holds back nothing after restore, only the release at the end of
  an enrolment from the log).
  With the log (step 6) an answer is one unit (gate review 27 B2b): every
  entry is opened and checked for form before any is folded, and the
  answer folds nothing from the first malformed position on; if a later
  pass finds a position p corrupt only while folding (the fold throws)
  after an entry above p was already folded, all effects of the answer
  are rolled back (one checkpoint for the answer, the same snapshot
  machinery as a step) and only the entries below p are folded again; the
  cursor ends at p, one finding per position. A clean answer folds in one
  step as before. Holder State Contract follow-up: „a party MUST validate
  the form of every journal batch before folding; a malformed batch is a
  finding, never state“ (rltp `trust-0.32-folgepunkte-e15-2026-10-18.md`).
- **Incarnation.** A restore from the store gives the device a fresh
  random incarnation (`A1@3f9a1c20`), never a counter from the backup, so
  two restores of the same backup never collide; a batch key seen twice
  with other content is recorded as a journal conflict. The batches
  before the crash stay under the old incarnation, the next steps under
  the new one. Enrollment copies state, journal and intents to the new
  device.
- **Candidate state is part of the step.** The device's checkpoint
  includes the candidate's volatile state (journal, outbox, counter);
  when a step is taken back after a journal frame was applied, the
  candidate forgets the batch too, the sender repeats the frame and the
  devices converge (gate review 7, B1).
- **Intents instead of re-production.** A device resumes only intents it
  produced itself, with the same bytes (HSC-120); an intent of a sibling
  device stays with that device. K0 re-produced an open mapping on the
  enrolled device (X5); K1a does not.
- **Static rights, fixed device count.** The number of devices per
  person is fixed from the first device on (two by default); enrollment
  beyond it is refused, so rights are never redistributed (versioned
  rights are K1b). The acceptance budget per mediator relationship
  (8510, ten) is split evenly across the devices (five each for two) and
  counted from the device's own acceptance operations in the journal,
  unconfirmed and inside the 28-day window; a device without quota blocks
  a ticket, the frame is not acknowledged and the sibling device accepts
  it. The stock keys a
  mediator may name (8570) are split by key number modulo the number of
  devices (8445: the revision lists the numbers), so the devices take
  turns; a mediator device without a nameable key refuses, the other
  introduces. Decisions (consent, decline) are allowed on every device;
  since step 3 the fold decides between them (section below).
- **Re-evaluation of received probes (step 2).** Two devices of a person
  can each open a tuple to the same counterpart before the journal brings
  the other's. A counterpart probe that arrives on one of them is checked
  against the tuples the receiving device holds at that moment; the
  sibling's tuple is not among them, so a hit that the person as a whole
  would have is missed. With the candidate flag `reevaluateProbes` the
  device keeps every received probe, per own arrival tuple, with the
  entries that hit nothing. Whenever it folds a sibling's journal batch
  that adds own tuples, it evaluates every kept probe again against its
  now larger set of own pair anchors, with the same hit rule as at
  arrival (6806). This is an extension beyond 6800, 6802, 6806 and 6960,
  not a derivation from them (see the assumption below). A hit owes the own
  mapping on the arrival tuple (6845.1, 6840), as a hit at first
  evaluation does; the union happens only on the counterpart's verified
  mapping (6900, 6975.1, 6975.2). The probe is the counterpart's own,
  sent at its scan with its frozen candidate list (2300, 6750 on its
  side); nothing is added to any candidate list, no new message type
  exists, and no clock is read.
  - **Every match is a hit.** A probe with several matching entries now
    owes one mapping per matched pair (6806: "each probe match"), not
    only for the first match. This is what makes a third encounter heal
    two old tuples at once (X7b).
  - **What is journalised.** The re-evaluation runs inside the step that
    folds the batch; the duty operation and the mapping intent it
    produces are part of that step's commit and travel as one batch. The
    kept probes themselves are device state like a received frame: part
    of the checkpoint (rolled back with a failed step) and of the store
    image (they survive a rebuild), not of the journal.
  - **Which device re-evaluates.** Received frames do not travel in the
    journal, so only a device that received the probe holds it. Its
    sibling learns the duty from the journal and maps nothing itself (the
    pair duty already exists). If both devices received the probe and
    re-evaluate while separated, or one maps from re-evaluation while the
    other verifies the counterpart's answer, two mappings over the same
    pair can arise; the counterpart unites once and records only the edge
    for the second (6975.3).
  - **Concurrent unions.** With one seed both devices listen on every
    tuple address, so the counterpart's answer mapping reaches both and
    both may unite over the same edge. Two fold rules make that converge:
    a union over an edge that is already united keeps the effect of the
    canonically smallest operation (6230: one union, not two, in every
    order); a pair duty that two devices each bring to `united` keeps the
    smallest mapping digest (6845.9 stays final). Without them the ledger
    shows the union from two operations and the duty digests differ
    between the devices (checked by removing them: tests 5 and 6 fail).
    Reservation: rule (a) makes the ledger show one union where two
    devices each produced one. The ledger therefore shows the set effect
    (6230), not single production: whether one mapping, one union and one
    follow-up revision were produced needs a production or traffic oracle
    (frames per device and kind at the carrier), not the ledger. That
    oracle is an open point (6845 production identity, gate review 16 S3).
  - **Retention.** Per own arrival tuple only the latest probe received
    on it: its entries that hit nothing replace the kept entries of any
    earlier probe on that tuple, they are never united with them. The
    rule follows from 6750: the counterpart's candidate list is frozen at
    its scan, so a repeated probe shows nothing the first did not; a
    probe that differs is the counterpart's latest statement and the only
    one kept. The hard bound is therefore the size of one probe (the
    counterpart's candidate list), whatever the number of probes; a
    counterpart that sends many probes with different entries leaves only
    those of its last (test 7c). An entry that hits is dropped (a pair
    anchor matches exactly one tuple); the set is dropped when it is
    empty or when the relationship of the arrival tuple departs, whether
    the departure is local or folded from a sibling's journal batch (the
    drop is part of every apply: local `depart`, journal fold, rebuild
    from the store; test 7b). Entries for the counterpart's other
    contacts never hit and stay until departure.
  - **Enrolment.** Kept probes are part of the device image that
    enrolment copies, as state, journal and intents are: an enrolled
    device receives the kept probes of the device it is enrolled from and
    re-evaluates them when its journal brings new own tuples, also while
    that device is offline (test 7d: A3 enrolled from A2, A2 offline, A's
    journal brings A1's tuple, A3 hits on A2's kept probe and maps; the
    duplicate is resolved without A2).
  - **Assumption beyond the inventory (spec follow-up).** Re-evaluation
    is an extension beyond 6800, 6802, 6806 and 6960. 6800 and 6802 bound
    the candidate relation, 6806 states the hit rule, 6960 governs the
    verification of a mapping; none of them provides for evaluating a
    probe again or for searching every tuple the person holds. The
    candidate evaluates a probe against the own tuples of all devices of
    the person and repeats this when that set grows through the journal;
    the inventory evaluates a probe once, at arrival. Repetition and the
    wider search set are two decisions for the spec. 6750 is kept
    literally on the sender's side.

## Step 3: decision and hand-over fold rules

Anton's decision of 18 October 2026 (question catalogue class 2, answers
1b and 2a), line "soft": what has reached the counterpart holds; what is
still inside the person's own house the fold may re-decide. The rules are
fold rules of the model (`src/lab/mehrgeraet/model.ts`, `resolveDecision`)
and apply to every candidate; K0 devices never fold a sibling's
operations, so K0 behaves as before.

- **Rule 1: the same decision from two devices is one effect.** Two
  consents (or two declines) of the same person on the same act fold into
  one state and one ledger effect, carried by the canonically smallest
  operation, as for concurrent unions. The act remembers every decision
  with its operation id (`decisions`), so the result does not depend on
  arrival order. The same holds for the act's connect and card effects:
  two devices that each connect the act (both hold the counter card under
  one seed) produce one connect effect.
- **Rule 2: consent against decline.** If an own card of the act is
  submitted (8325.0: O in `taken`, `delivered`, `given-up`) or the act is
  connected, consent holds; the decline is recorded as a conflict
  (`conflict:decline:<act>` and a finding), not as a contradiction.
  Otherwise the decline holds (8325.A3): the consent is recorded as
  `conflict:consent:<act>`, P stays in the state but is hidden in the
  projection, and the device that produced the card withdraws it if it
  never reached the carrier (8232.2; 8765: a side that declines sends
  nothing). Withdrawal is an operation (`hand-over cancelled`) in the same
  journal step. A card the carrier already has is not withdrawn (8326.9);
  its `taken` report then decides rule 2 for consent, and the fold leaves
  `declined` again.
- **Rule 3: two hand-overs of one act.** O is kept per hand-over (digest of
  the card document, `cards`), so a sibling's hand-over never overwrites
  the own one; O of the act is the furthest of its cards. The winning
  hand-over is the one with the smaller digest; the act's `ownCardDigest`
  converges to it on every device. Two hand-overs are always concurrent (a
  device that knows the sibling's consent does not consent and produces no
  card), so "first in journal order" reduces to the tie rule. The losing
  card is withdrawn like a declined one if it never reached the carrier.
- **B's behaviour with two cards (bench rule, 8910).** Under one seed both
  cards carry the same card key and the same payload, so their comparison
  digest V is the same (8910.0 over the payload, 8913 independent of the
  document bytes). B keeps the first verified card and treats the second
  as a repetition of the act (8910.7): acknowledged, no second connect, no
  conflict mark K. A card with different content (keys per device, K2)
  would be refused with K := yes (8910.8).
  Bench limit (gate review 18 S1): the bench card carries only the card
  anchor and the key-exchange key. That is why two cards of one act under
  one seed are byte-identical in their payload and B treats the second as
  a repetition (8910.7). A full card with its own `at` and `nonce` would
  differ, and B would set K by 8910.8 (Astra's counter-run: a second signed
  card with a different `card.at`/`card.nonce` sets K = true). The X18 pass
  holds for the simplified payload only; which fields make two cards "the
  same card" is a spec follow-up (8727, 8740, 8910).
- **O per hand-over by rank (gate review 18 B1b).** Two values for the same
  hand-over (digest) fold by rank, not by arrival order: `none` < `intent`
  < `handed` < `cancelled` < `taken` < `given-up` < `delivered`. A
  withdrawal that held never returns to `handed` (8326.8); a card the
  carrier has taken holds against a withdrawal (8326.9, the line "what has
  reached the carrier holds", as in rule 2); `delivered` is last (8326.10).
  Cancelled-then-delivered and delivered-then-cancelled fold to the same
  state on every device.
- **No gate after restore (MV-6 new, MV-34, Anton 20 October; replaces
  the hold of gate review 18 B1a).** A device rebuilt from the store waits
  for nobody: it requests catch-up (acceleration, HSC-440) and acts at once
  from its reachable state; whatever it sends twice or against a decision
  taken meanwhile, the counterpart catches by the rules (rule 2: a card
  that reached the carrier holds; 8640.12 at the side). The catch-up
  answer still counts only if it is bound to the device's current request
  (gate review 19 B1a, `staleSyncAnswers`), but it ends data catch-up, not
  a hold. Details, prices and the tests that changed: "No gate after
  restore" at the end.
- **Local withdrawal (`Zusteller.demarcate`).** The bench's delivery
  adapter discards a submission that never reached the carrier (recorded,
  or `awaiting-transport` without a successful deposit), like a
  `not-taken` answer that demarcates every hand-over (8326.4) followed by
  8326.8.

What the user sees: tapping consent on the phone shows "accepted" at once
and it stays, unless the separated laptop declined earlier and the card
had not yet left the phone; then the phone shows "declined" after the
devices meet. A decline on the laptop, made while the phone's card was
already out, turns into "connected" after the devices meet.

Two oracles changed with the rules. X3 checks the rule (connected exactly
when an own card was submitted, otherwise declined on every device), and
heals A2 one round before A1, so A1 folds the decline before its card
reaches the carrier (the decline branch); the submitted branch is the
counter-run "consent with card taken, decline offline" in
`tests/mehrgeraet-k1a.test.ts`. Both X3 and X18 mark a pass in which a
device's own decision was overridden, or two devices each consented, as
`promiseChanged` ("promise changed", ≈ in the matrix): terminality of
8325 holds for the person only after the devices have united.

## Step 4: pseudonymous writer tags per relationship

Anton's decision (18 October, question 3, answer 3a): both devices
refill and send revisions without waiting for a right or for each other;
numbers are monotonic per writer; the counterpart reads two writers; the
writer id is pseudonymous per relationship.

**Derivation.** `writerTagOf(seed, device, relationship)` =
HMAC-SHA256 under `derive(seed, 'writer-tag')` over
`<relationship id>|<device name>`, first 12 bytes, base64url. The
relationship id is the resolved id in the holder state (the same on all
devices of the person). M does not hold the seed, so it can neither
compute a tag nor link the tags of one device across relationships. The
tag is per device, not per incarnation: a per-incarnation tag would make
every restore look like a new device to M (one more writer per restore,
an inflated device count, a dead writer's keys left in M's view). The
device's own counter comes from its image: since MV-6 new a restored
device allocates and numbers at once from its reachable state; a number
its lost incarnation already used is a named price (6270 equivocation at
M, section "No gate after restore"). The `owed` mechanism remains only for
enrolment from the log (step 6), the one case that still waits for a
witness. Capability
`writer-tags`, option `k1a({ writerTags: false })` for the counter-run;
K0 has no tag and is unchanged.

**Numbering.** 8500 (0.32): "A sender MUST number each revision of a
relationship one above the highest revision of that relationship its
persistent state holds." The bench applies it per writer: the holder
state keeps per relationship and tag the highest revision and whether it
was empty (`Relationship.writers`); a revision is numbered one above that
writer's highest; the effect is `revision:<rel>:<tag>:<n>`. The tag
travels in the revision payload and, without a function on the bench, in
probe and mapping payloads (the bench numbers neither, see limits).

**M's rule.** 6270 per writer in the scope of the tuple (6280): a
revision above the writer's held revision is accepted (gaps allowed:
numbers of cancelled revisions stay consumed, 8500); equal number and
equal keys is a repetition; equal number and different keys is an
equivocation finding (6270); lower is refused. M's view keeps per tag the
latest revision; that revision replaces the writer's previous keys; the
effective view is the union by anchor over the writers whose latest
revision lies above their clear mark. Class off: 8535 "On a withdrawal by
the class turning off (8475.S6), the sender MUST send a revision with an
empty `keys` list on the relationship, whether or not it lags." Any device
may send it; M, on accepting an empty revision, records as clear marks
the latest revision of every writer it holds in that scope, so the empty
revision withdraws the keys of all writers. Clear marks fold as a
maximum and the writer entries per revision number, so M's devices reach
the same view in any fold order. A head change (8557) starts a new view.

**Class off across writers.** A writer's revision that reaches M after
another writer's empty revision lists keys again. Therefore a device that
folds a sibling's class off withdraws every key still live in its state
(keys it allocated itself while separated, which the sibling's withdrawal
did not name; 8475.S6) and, if its own latest revision listed keys,
sends an empty revision under its own tag. Due work from the state (B6),
checked in every refill pass; only with tags.

**Acceptance tests** (`tests/mehrgeraet-k1a.test.ts`, "K1a Schritt 4";
`tests/mehrgeraet-modell.test.ts`, "K1a Schritt 4"): X17 two devices and
serial, counter-run without tags (fails as before); one device in two
relationships has two tags and the counterparts see different ones; the
tag survives a restore; a writer that reuses a number with different
content (restore without a sibling, counter lost) gets a 6270 finding at
M; restore with a sibling (since MV-6 new): the same reuse of number 3 and
the same finding, after healing the devices agree and the next number is
4 at M; class off on
A1 while A2 refills separated: M holds A2's keys for a while, after
healing A2 sends an empty revision under its tag, M's view is empty on
both M devices, no live keys on A, no 6270. Model: union of two writers
with the same number in every order, 6270 per writer, clear marks in
every order, per-writer effects on A's side.

**Stock numbers per device (gate review 21 B1).** With shared numbers two
devices refilling separated allocate the same `(nonce, n)`; under one seed
that is the same anchor, but each device stamps its own expiry. Review 21
advanced the clock one hour between A1's and A2's refill in X17: the same
anchors for n = 6–8 with expiry 08:00 and 09:00, A's devices never agreed,
M took the value of the lexicographically first writer, and nothing was
reported. Fix: every device allocates numbers only from its own class
(`mayAllocate`): ⌊n / devices⌋ mod devices = its index, i.e. blocks of
`devices` consecutive numbers dealt in turn (two devices: 1, 4, 5, 8, 9, …
and 2, 3, 6, 7, …). Not the plain residue n mod devices: the counterpart
names by n mod devices since step 1 (`mayName`), and with both splits equal
each mediator device could name the keys of exactly one issuer device
(measured: X2 and X13 fail with the plain residue, M2 names nothing while
A2 has not refilled). With the block class every issuer class holds both
residues. The refill target still counts the person's active keys at the
relationship (all devices, through the journal), not per class, so one
device keeps M supplied alone. Measured with A2 offline the whole time
(A1 accepts its full share of five tickets): M's usable view after each
introduction 4, 3, 5, 4, 3 keys, exactly as with shared numbers; no
refusal, no 6270, no finding. The other class just stays unused.
Option `k1a({ allocationSplit: false })` for the counter-run.

As a defensive fold rule, the same anchor with a different value (expiry,
key agreement, number) never folds silently: A's stock and M's union over
writers both keep the canonically smallest value (the same in every fold
order) and record `conflict:key-value:<anchor>` once per anchor. X17
measures it (`keyValueConflicts`, must be 0). Tests ("K1a Review 21"):
review 21's clock-skew refill gives disjoint numbers, equal projections,
no 6270 and no conflict; the same run without the split records the
conflict on A and M and both persons' projections still agree; A2 offline:
A1 alone accepts its share, M never falls below two usable keys, every
stock number lies in A1's class.

## Step 5: X16 oracle per decision 4a

Anton's decision (18 October, question 4, answer 4a): a ticket on a key
that was withdrawn meanwhile holds; the withdrawal takes effect when the
empty revision reaches M (8535). The X16 oracle no longer fails on the
accepted ticket. After healing it requires: (a) the A devices agree;
(b) the key is consumed at most once across the person, exactly once if a
device accepted the ticket (one `accept:<act>` operation, the key
`consumed` on every device); (c) the act is held on every device if any
device accepted it, otherwise on none (serial: the only device knows the
withdrawal and refuses by 8640.6); (d) M's view is empty on every M
device; (e) no double final effect; (f) no equivocation at M. The number
of tickets accepted on withdrawn keys stays a measure
(`acceptedAfterRevocation`, information). Single consumption counts per
key, not per act (gate review 21 B2): on the holder's side the effects are
`accept:<act>`, so the ledger check maps every accepted act to its own
stock key and counts the acts per key across all act ids (`finalEffects`),
and `acceptOperations` sums the accept operations of every act on the named
key. Mutation test: a second `ticket-accept` on the same key under another
act id makes X16 fail (two accept operations, one double consumption). This is an oracle change, not a
candidate change: K1a passed every new condition already after step 4.
K0 with two devices still fails X16, now because A1 never learns the act
and A2 keeps the class on (devices disagree), not because of the ticket.

## Results (18 October, K1a against X1–X18, X7b and X21)

See the matrix (`matrix.md`, multi-device port) for the cells; the table
below is filled from the report run and the acceptance tests. "Serial"
is the control run with one device per person and undivided rights
(`k1a({ devices: 1 })`); K0 passes the same serial control for every
scenario that has one.

| | two devices | serial | what the bench measured |
|---|---|---|---|
| X1 double consumption | passed | passed | M1 and M2 name different keys (number classes); no 8640.12 at A |
| X2 budget at 9 | passed | passed | ten acts for the person, seven acceptances blocked, the sibling takes what one device may not |
| X3 consent ∥ decline | passed, promise changed | passed | rule 2, no own card submitted: A1 folds A2's decline before its card reaches the carrier, withdraws it (O `cancelled`), both devices declined after one round; no card at the carrier or at B, B stays consented without A's card; one decline effect, the consent as conflict, one finding |
| X4 class off ∥ send | passed | passed | M's view empty on both devices, the running act connected on both, no equivocation |
| X5 departure ∥ replay | passed | passed | A2 holds A1's mapping intent and produces nothing; only repeats of earlier bytes reach B |
| X6 restore from backup | passed | n/a | new incarnation; the catch-up over the self address brings the missed batches, own earlier incarnation included |
| X7 continuity across devices | failed | passed | both persons open concurrently on two devices each: every device holds two entries to the other person with one tuple each; neither frozen probe holds the other tuple, so re-evaluation finds nothing; the duplicate heals at the next encounter (X7b) |
| X7b third encounter after X7 | passed | passed | after the symmetric concurrent pair and a sync every device holds two entries; A1 meets B1 again: the fresh probes carry both old tuples (2300), both sides hit both, and after two rounds A1, A2, B1 and B2 each hold one entry with three tuples; no duplicate, no double effect |
| X8 enrollment | passed | n/a | state, journal and intents copied; A2 consents and connects at once |
| X9 device revocation | failed | n/a | the thief with the image reads four documents and holds an act (one seed) |
| X10 restricted app | n/a | n/a | step 1 has no rights profile per app |
| X11 long separation | passed | n/a | both devices connected after reunion, stable after three rounds, no double effects, journal about 23 kB |
| X12 delivery per device | passed | passed | B's effect once, A1 delivered after two rounds, A2 equal after one round |
| X13 mediator devices against the shared budget | passed | passed | M1 and M2 each issue one introduction offline at budget 9, A1 sees one ticket, A2 the other: ten acts, no overrun, five blocked acceptances, no key named twice |
| X14 double introduction | passed | passed | two acts, both connected; with B1 and B2 separated while consenting, C's probe on its second tuple (which holds the first) misses at the B device that lacks B's other tuple; after B's journal heals, that device re-evaluates the kept probe, hits and maps; B1, B2 and C1 each hold one entry with both tuples, no double effect |
| X15 union ∥ running act | passed | passed | A2, separated from A1, unites the two relationships to M while A1's card is in transit; one entry with two tuples on both devices, the act connected, its mediator and acceptance on the united relationship, M's view on the united head |
| X16 old stock after class revocation | passed (oracle after 4a, step 5) | passed | A2, separated, accepts a ticket on a key A1 withdrew (holds under 4a); after healing both devices hold the act, one acceptance operation, the key consumed on both, class off on both, M's view empty on both M devices, no double effect, no equivocation, equal after one round; serial: A1 refuses the ticket (8640.6), key withdrawn |
| X17 parallel production | passed (step 4) | passed | A1 and A2, separated, each accept a ticket and refill; A1 sends revision 2 of its tag, A2 revision 1 of its tag; M accepts both, no 6270, no number from two operations; M's view on both M devices: 2 writers, 6 keys (the union); the next introduction is accepted; A's and M's devices each agree after one round; M learns 2 writer tags on the relationship to A (1 serial), tags per M relationship 2/1/1 (A, B, C), 0 linkable across relationships; probe sequence (6680) not modelled |
| X18 two cards of one act | passed, promise changed | passed | rules 1 and 3: both cards were taken while the devices were separated, so nothing is withdrawn; A's ledger holds one consent and one connect effect, both devices hold the same hand-over digest and agree after one round; two card documents reach B (each B device receives both), B connects once, no conflict mark |
| X21 journal robustness | passed | n/a | repair after old and double restore with reordering, duplicates, concurrent requests and two crashes in 7 rounds; after 15 rounds of lost requests, answers, journal batches alone (reply head and receipts delivered) or receipts each in 1 round; after every phase no missing batch key and the reference projection on both devices; repair ends with no device waiting for catch-up and 17 silent rounds on the self address; no double effect, no conflict; 813 frames and 2.2 MB on the self address, of which 395 journal frames (1.66 MB for an 11-batch, 23 kB journal; the writer tags in the operations add about 0.2 kB); 569 repeats, 566 on the self address and 3 to counterparts; the journal does not grow |

Counts over X1 to X18, X7b and X21 with two devices: 17 kept (X3 and X18
under a changed promise), 2 not kept (X7, X9), 1 not applicable (K0: 1
kept, 18 not kept, 1 not applicable, unchanged). Step 2 changed X14 and
added X7b; step 3 changed X3 and X18; step 4 changed X17; step 5 changed
X16 by its oracle; every other outcome is the same as after step 1.

Reservations (gate reviews 8 and 9): a successful restore with reachable
history (X6) is not the same as repair after lost sync traffic (X21
measures that separately); a thief with the device's image has the same self
anchor and receives new history through the sync as well (X9, one seed);
X1, X2 and X5 show
fixed rights with the entitled device available and no re-production,
not a transfer of rights or a takeover after a device is lost (K1b,
X20); X8 and X11 do not show a union of the person's own tuples (X14
and X7b do).

## Findings

- **Static rights keep the hard limits (X1, X2).** Two mediator devices
  never name the same key: each may only name keys of its number class;
  a device without a nameable key refuses and the other introduces. The
  person's budget holds at ten across both devices (five each, seven
  blocked acceptances in X2); the frame a device cannot accept stays
  unacknowledged and the sibling accepts it.
- **Consent against decline converges by rule 2 (X3, step 3).** Until
  step 2 the fold kept the first terminal state on each device and the
  devices never agreed. With rule 2 both end in the same state: declined
  when no own card was submitted (X3), connected when one was (counter-run:
  A1's card taken, A2 declines offline; after healing both connected, the
  decline as conflict finding on both, A2 sends nothing but journal frames
  and receipts, one card document at the carrier, B connects once). A
  connect from the other device on an act declined without a submitted
  card is still refused and recorded as `conflict:connect:<act>`.
- **Catch-up after a backup works through the journal (X6).** A2 restored
  from an old backup gets a new incarnation and, after one sync round,
  every batch it missed, including those of its own earlier incarnation;
  the keys M consumed are consumed on A2 again, the acts are back. What
  the sync does not do: bound the journal, forget anything, or decide
  between two devices that answer the same request (both answer, the
  requester deduplicates).
- **Concurrent openings on both sides heal only at the next encounter
  (X7, X7b).** Both devices learn both encounters with B from the
  journal, but each tuple's probe was sent with the candidate list of
  its own device, and B's likewise. When A and B both open concurrently
  on two devices each, no probe holds the other tuple, on either side, so
  re-evaluation has nothing to find and every device keeps two entries.
  At the next encounter the fresh probe of each side carries both old
  tuples (2300), the other side hits both, and the three tuples end in
  one entry on every device (X7b). Re-evaluation helps whenever at least
  one side opened its two tuples in order (one device, or a sync in
  between): that side's second probe holds the first tuple.
- **A seed is still a capability (X9).** The thief with A2's image reads
  the next ticket and holds the act; revocation at the carrier changes
  nothing under one seed, as with K0, and the catch-up answers the thief
  like any device because it signs with the shared self anchor. Keys per
  device (K2) are the answer.
- **Hash parity starves a device.** The first cut split nameable keys by
  anchor hash: with five keys in stock M1 got one, and A refills only
  under three active keys, so M1 could not introduce again. Splitting by
  key number modulo devices alternates them (3/2) and the revision has to
  list the numbers (8445).
- **Journal size (X11):** about 22 kB of batches after two acts and a
  thirty-round separation; no cleanup yet.
- **Repair works and ends, at a price (X21).** A2 restored twice from an
  old backup while A1 restarts and asks at the same time, under reordering
  and duplicates, with A2 crashing before and A1 after a commit, recovers
  every batch (its own earlier incarnation's included) in 7 rounds. After
  15 rounds of lost requests (only A2's), lost answers (A1's journal frames
  and replies), lost journal batches alone (A1's journal frames, while the
  reply head and the receipts pass) or lost receipts on the self address,
  the device converges within one round of healing, without any new domain
  operation; after every phase both devices hold every batch key and the
  reference projection. Lost requests, answers and batches leave A2 behind
  for the whole loss; lost receipts do not (the answers arrive, only their
  acknowledgement is missing). With the reply head delivered but the
  batches lost, A2 sees that its heads do not cover A1's and keeps asking.
  The repair counts as finished only when no device of A still waits for
  catch-up and the self address then stays silent for 17 rounds, longer
  than the largest re-request interval of 16 (gate review 11 B2: a device
  silent in its backoff is not done). The counter-run in which A2's head
  comparison answers "not covered" after every restore keeps A2 waiting
  for 60 rounds with about 48 more self frames, and X21 fails. The cost is
  the full journal on every answer: 395 journal frames carry 1.65 MB to
  repair an 11-batch journal of 22 kB; of the 813 deposits on the self
  address 355 are receipts, and 566 of them are repeats by the delivery
  layer (3 more repeats go to counterparts); A1 sends 423 answer frames,
  A2 two. Three frames go from A's devices to counterparts during the
  repair. The journal does not grow during repair. Exact frame and byte
  counts vary slightly between runs.
- **Mediator devices hold the shared budget (X13).** Two mediator devices
  issuing offline against A's budget at nine do not overrun it: A's
  devices split the acceptance quota, the device without quota blocks, and
  the person ends at ten acts. K0 reaches eleven.
- **Asymmetric concurrent openings unite through re-evaluation (X14,
  test 4).** Only one side has two concurrent tuples, the other opened in
  order: its second probe carries the first tuple and misses at the
  device that lacks it; after the journal heals, that device re-evaluates
  the kept probe and hits. In the acceptance test from gate review 13
  (A on two devices, B on one) every probe of A is dropped for the whole
  run, and A and B still end in one entry with both tuples on every
  device: A2 maps from re-evaluation, B unites and answers. In X14 the
  same happens with B on two devices and C on one.
- **Concurrent unions on both devices converge (step 2).** A1 and A2,
  separated from each other after both learned both tuples to B: A2 maps
  from re-evaluation, A1 verifies B's answer mapping (it reaches both,
  one seed) and unites with an operation of its own. After healing both
  hold one entry with both tuples, the same projection, one union effect
  for the edge and no double effect at A or B. Duplicated and reordered
  frames during the whole flow give the same result.
- **A union through the counterpart travels well (X15).** When M's mapping
  unites two relationships on one device, the union is an operation in the
  journal; the other device folds it, re-points the running act and its
  acceptance to the united relationship, and the act connects. No
  re-evaluation is involved: A2's new tuple has the old one in its
  snapshot.
- **Revocation and production are not rights (X16, X17).** A device that
  did not see the class revocation accepts a ticket on a withdrawn key;
  under decision 4a the ticket holds, and the fold marks the key consumed
  once on every device (step 5). Two devices refilling apart number their
  revisions under their own writer tags (step 4), so M accepts both and
  records no 6270. Static rights cover consumption (budget, nameable
  keys), not changes of the class; revision numbers are per writer.
- **Two hand-overs of one act fold by rules 1 and 3 (X18, step 3).** Both
  devices consent and send a card while separated. Before step 3 A's
  ledger held consent and connect each from two operations and A's
  devices kept different hand-over digests. Now A's ledger holds one
  consent and one connect effect and both devices hold the smaller
  digest. Counter-runs: without rule 1 the ledger oracle sees the two
  double effects even with the digest hidden from the projection; without
  rule 3 the digests differ and the projections never agree. Both cards
  were already taken, so B receives two card documents; with one seed they
  are a repetition (8910.7) and B connects once. When one card is still
  at the adapter (device offline), the losing one is withdrawn and B
  receives one card or two, depending on which digest wins (test "rule 3
  at the device"). With keys per device (K2) B would see two different
  cards (8910.8).
- **Bench note: a repeated ticket after a budget refusal.** The ticket that
  A refuses for budget (8640.13) consumes the key; the mediator repeats the
  unacknowledged ticket and A then records 8640.12 (mediator conformance)
  for the repeat. X13 does not use that count; X1, which counts 8640.12,
  has no budget refusal.

## Spec follow-ups from step 3

- **8325 terminality per person after union.** 8325.0 calls `declined`
  and `connected` terminal per side. With several devices and the soft
  line the fold may leave `declined` (a sibling's card was submitted) and
  may move `consented` to `declined` (no card submitted). The inventory
  needs to say that terminality holds for the person once its devices
  have united, and which state the user is shown before.
- **8326/8910: two cards of one act.** Two devices of one person can each
  hand over a card for the same act. 8326 has one O per act; the bench
  keeps O per hand-over and lets the smaller digest win. 8910 decides what
  the counterpart keeps: under one seed the second card is a repetition
  (8910.7); with keys per device it would be refused with K (8910.8). The
  inventory needs a rule for which card counts and what the counterpart
  does with the second.
- **8326: withdrawal safe against restore, merge per hand-over.** A device
  restored from a backup taken before a withdrawal must not release the
  withdrawn card before it has caught up its own journal; the state of one
  hand-over merges by rank (`cancelled` over the pre-carrier states,
  `taken`/`delivered` over `cancelled`). The inventory needs both rules.
- **8727/8740/8910: full card identity and the notion of repetition.** The
  bench card has no `at` or `nonce`, so two cards of one act under one seed
  are equal and the second is a repetition (8910.7). With full cards the
  inventory needs to say which fields decide that two cards are the same
  card, or whether a second fresh card of the same act always sets K
  (8910.8).

## Spec follow-ups from steps 4 and 5

- **8500/6270 per writer.** 8500 (0.32) numbers revisions per
  relationship; with two devices of one person producing independently
  the inventory needs a writer component: numbering per writer, the
  writer id in the revision, and 6270 compared per writer within the
  scope of 6280. The writer id must be pseudonymous per relationship.
- **6680/6280/6300 per writer.** The probe sequence per tuple direction
  (6680: "starting at 1, strictly increasing, and persisted atomically
  before send") and the mapping revision per pair scope (6280, 6300) have
  the same problem as 8500 when two devices send on the same tuple; the
  bench carries the tag in probe and mapping but models neither number.
- **8535 across writers.** The empty revision on class off must withdraw
  the keys of every writer, not only the sender's; a writer whose keyed
  revision reaches M after it lists keys again, so every writer that
  learns the class off sends its own empty revision. The inventory needs
  both rules and M's union rule (latest revision per writer, union over
  writers, clear marks).
- **8445 per writer.** Shared key numbers are not harmless under one seed:
  the same `(nonce, n)` derives the same anchor, but each device stamps
  its own expiry (review 21 B1). The bench gives every device its own
  class of numbers (blocks dealt in turn, orthogonal to the counterpart's
  naming split); the inventory needs numbers per writer, and the receiver
  rule for the same anchor with a different value (8445 next to 6270).
- **What M learns about the device count.** With writer tags M learns per
  relationship how many devices of the person have sent it a revision,
  probe or mapping (measured: two tags on the relationship to A); it
  cannot link them across relationships. Whether that is acceptable is a
  decision on the privacy section (the fallback is 3b with a deadline).
- **8640.6 and 8535 under 4a.** The withdrawal takes effect at M; a device
  that still holds the key active accepts a ticket on it, the person keeps
  the act, the key is consumed once. The inventory may state this
  explicitly next to 8535.

## What re-evaluation adds (plan section 5: carrier, M, counterpart)

On the receiving side, keeping entries means the receiver can run later
equality tests with them. The bench runs them only against its own pair
anchors: an
entry is `HMAC(k_p, a)` under the pair key of the arrival tuple, and the
receiver computes candidates only from anchors of tuples it holds itself.
It can learn whether the counterpart's frozen list names one of its own
anchors (that is, one of its own tuples), and nothing about third
parties: an entry for the counterpart's contact with someone else never
matches and tells the receiver nothing beyond the count of entries. Only
the latest probe per arrival tuple is kept, so the number of such tests
is bounded by one probe.

Nothing on the wire beyond the mapping a hit owes anyway. Re-evaluation
reads probes the device has already received and acknowledged; it sends
no probe, no request and no further document type. Measured on the
bench against main (deposits at the carrier, continuity documents, 25
rounds after the encounters):

- Symmetric concurrent pair (X7 flow): four probes on both, nothing
  else on either; identical traffic.
- Asymmetric pair (A on two devices, B on one): four probes on both; on
  this branch two mappings more (A2's mapping owed by its hit, 6845.1,
  and B's answer mapping, 6845.1 second trigger), on main none because
  the pair is never united.

The carrier sees the mapping frames of an ordinary union. M, as
mediator, sees nothing. The counterpart receives a mapping some rounds
after its probe instead of right away; the delay tells it that the hit
was found late, which in K1a happens only after a journal fold, so it
can infer that the person uses more than one device.

## What writer tags show (plan section 5: carrier, M, counterpart)

- **Carrier:** not the tag itself, which is inside the sealed document;
  but every revision, probe and mapping grows by the field (the same
  initial revision: 2389 bytes without tag, 2426 with). Neither size correlation nor send times are measured.
- **M:** per relationship, one tag per device that sent it a revision
  (X17: 2 tags on the relationship to A with two devices, 1 serial; per M
  relationship 2/1/1 for A, B, C), so the number of the person's devices
  that refilled; tags of one device in two relationships differ ("0
  linkable" in X17 counts equal tags across relationships only, nothing
  about sizes or timing; test "Kennung je Gerät und Beziehung"). A restore
  does not add a tag.
- **Counterpart of a probe or mapping:** the tag of the device that opened
  the tuple or owed the mapping, per relationship; the same count as M
  for the devices that sent it continuity documents.

## Limits of steps 1 to 5

- The device count is fixed; a third device is refused. Transferring or
  re-splitting rights is K1b.
- No transfer of quota between devices (that is K1b); no takeover of a
  sibling's intent when the sibling is lost (X20, K2).
- When both persons open concurrently on two devices each (X7 strict),
  the duplicate stays until the next encounter between them (X7b); there
  is no step that heals it earlier.
- Kept probes are device state. A device that is lost takes its kept
  probes with it (an enrolled device gets those of the device it is
  enrolled from at enrolment, nothing later), and only a
  journal fold triggers re-evaluation (no re-evaluation after a union or
  a local opening).
- Entries of a kept probe for the counterpart's other contacts never hit
  and are kept until the arrival tuple's relationship departs or a later
  probe on the same tuple replaces them.
- The ledger shows the set effect of concurrent unions (fold rule (a)),
  not how often a mapping, union or revision was produced; single
  production needs a production or traffic oracle, which the bench does
  not have for step 2 yet.
- The bench evaluates a probe against every own tuple, not only the
  arrival tuple's candidate list and mutual candidates (6800, 6802); the
  repetition over the person's tuples is an assumption beyond the
  inventory.
- The tie rules for concurrent unions (smallest operation for the union
  effect, smallest digest for a `united` duty) are bench rules of the
  fold, not inventory rules. Concurrent unions with own stock on the
  united relationship each produce a revision; with writer tags each
  under its own writer's next number.
- Class changes are not rights; the `class` operation folds as the last
  applied value, so a class toggle on a restored device during its
  catch-up can be undone by the fold of older operations of its earlier
  incarnation (not exercised by an X scenario).
- Writer tags (step 4): probes and mappings carry the tag but the bench
  numbers neither (6680, 6280/6300 not modelled). Key numbers `n` are
  split by device class (review 21 B1); the class is fixed with the device
  count, so a restore without a sibling can still reuse a number of its
  own class (the fold then records `conflict:key-value`). The tag is derived from the
  resolved relationship id; a union that keeps the other relationship's id
  gives the device a new tag there (a new view scope at M anyway, 8557).
- A restored device continues its writer's counter from the backup and
  can reuse a number its lost incarnation sent; M records 6270 (tests
  "Gegenlauf: derselbe Schreiber" and, with a sibling, "Restore mit
  Schwester unter MV-6 neu"). Since MV-6 new this holds with a sibling
  too (no wait for the catch-up).
- M's union keeps keys from a writer's latest revision even if another
  writer consumed them meanwhile; M does not name them because its
  consumption marks are holder-wide (8570). Convergence to an empty view
  after class off relies on every writer that listed keys sending its own
  empty revision once it learns the class off.
- X16 under 4a: the act accepted on a withdrawn key holds; serially the
  only device refuses (8640.6), so the two-device and the serial run end
  with a different act set; both pass the oracle.
- Terminality of 8325 now holds for the person only after the devices
  have united: a device can show "consented" and later "declined" (its
  card never left), or "declined" and later "connected" (the sibling's
  card was already out). X3 and X18 pass under this changed promise, not
  under 8325 as written.
- Rule 2 decides by whether a card reached the carrier. X3 heals A2 one
  round before A1 to reach the decline branch; when both return in the
  same round A1's card reaches the carrier first and consent holds. The
  boundary is the bench's adapter (`demarcate`), not a query answer of
  Delivery (8326.4 to 8326.6 are not modelled).
- The fold assumes each writer's operations arrive in that writer's order
  (the journal's heads guarantee it). A connect folded before the
  sibling's `taken` on an act declined without a submitted card is
  recorded as a conflict and not re-applied later; this order does not
  occur with the journal.
- If the device holding the winning card is lost before it hands the card
  over, the act waits for that device; taking over a sibling's intent is
  X20.
- Rule 1 keeps one effect for two connects or two card hand-overs; how
  often a card document, a probe or a connect was produced is measured
  separately (X18: two card documents to B), not in the ledger.
- The tie rule of rule 3 (smaller digest) and the per-hand-over O are
  bench rules of the fold, not inventory rules.
- The bench card carries only anchor and key-exchange key: two cards of one
  act under one seed are byte-identical in payload and B treats the second
  as a repetition (8910.7). A full card with its own `at`/`nonce` would
  differ and B would set K (8910.8); X18 passes for the simplified card.
- Since MV-6 new nothing holds a restored device back; the lockout with a
  lost, unrevoked sibling (formerly 70 of 70 rounds held) is gone, and
  question 4.1 (time bound) is moot. Restore artefacts are the price
  (section "No gate after restore"). Taking over is X20.
- One seed: the revoked device still holds the self key, so an answer it
  sends to a current request would still count; the request id binds an
  answer to a request, not to a device (K2).
- Sibling knowledge comes from enrollment (both devices record each other)
  or from a foreign writer in the journal. A backup taken before the
  enrollment knows no sibling and releases at once.
- The journal is a plain list of batches in the device's store; no
  cleanup, no tombstones, no bound on its size; every sibling that
  receives a request answers with all batches after the requester's heads,
  and every new request of the backoff is answered again in full (X21: 1.65 MB of
  journal frames for a 22 kB journal).
- X21 ends a repair by the catch-up flag of the devices (`syncPending`) and
  a silent window on the self address; the batch-loss phase drops all of
  A1's journal frames for 15 rounds, not a chosen subset of batches, and
  every loss phase starts from a fresh restore of A2 only.
- Every scenario runs one person per role with two devices; X19, X20, X22
  and X23 are not built, X10 needs rights per app.

## Step 6 (variant): journal retained at the self address

Anton, 18 October: "journal at the service is an option to study, not a
decision". This step builds it as a comparable variant and measures it
against K1a. It is an option under study, not the default: `k1a()` is
unchanged, the variant is `k1a({ journalAtService: true })`, listed as
the second multi-device entry `k1a-journal-service` ("K1a + journal at
the service") and run against the same scenarios.

### Principle (Anton, 18 October, after gate review 25)

**The log at the service is an acceleration, never a release ground.**
Withholding by the carrier must never cause a release (Replication door
D1). Gate review 25 showed why the first build broke this: the gate after
restore ended with the log answer, and the service decides that answer
alone. An empty answer `{req, from, end: from, entries: []}` or entries
replaced by garbage released a withdrawn card to B (B1, B2).

Log beschleunigt das Nachholen; die Freigabe bezeugt die Schwester oder
der Widerruf.

The lockout question (a restored device whose only sibling is lost stays
gated until the user revokes that sibling) had no answer without trusting
the service. Since MV-6 new (20 October) there is no gate after restore at
all, in this variant as in the default: the log brings data, nothing
waits for the witness. Only enrolment from the log keeps the witness of
the enrolling device (a live ceremony, MV-34 allows it). The results
table below is from 18 October; its gate rows are superseded (section
"No gate after restore" at the end).

### Design (hybrid)

- **Carrier (`zustellung.ts`).** An address can be retained
  (`retain`): deposits there are kept as an ordered log with position
  and deposit time, in addition to the mailbox delivery to registered
  devices; receipts unchanged. `readLog(device, address, from, req)`
  serves registered devices only (a revoked device is unregistered), the
  answer `{ req, from, end, entries }` is collected with the next pickup.
  Faults for the log: request lost, answer lost, single entries lost
  with the answer head delivered. A dropped deposit is missing from the
  log too. All other addresses stay mailboxes.
- **World (`Welt15Options.selfLog`).** Default from the candidate's
  bench option (`bench.selfLog`); every device of a person retains its
  self address.
- **Two tracks in the holder.** Data: the device reads the log from its
  own position (`logCursor`, part of the store image) and folds every
  entry through the same path as a delivered journal frame
  (`receiveOwnFrame`, `applyRemote`, `applied`), in passes until nothing
  is deferred (track `logSync`, request id bound, MV-5). Release: the
  sibling track of K1a, unchanged (`journal-sync` to the self address, an
  answer from a sibling bound to the current request id whose heads the
  device covers, HSC-440, MV-6); its first request goes out one round
  after the log request, with the heads folded from the log, so the
  sibling sends only what the log did not bring and witnesses the rest.
- **No gate after restore (MV-6 new, MV-34).** A rebuilt device acts at
  once; both tracks only bring data (section "No gate after restore").
  The only hold left is the live ceremony of an enrolment from the log
  (below): it ends only on (i) a sibling's answer covering the device's
  heads or (ii) the revocation of every sibling (`deviceRevoked`); the
  log answer never ends it. Reading is not delivery: no receipt, no
  `completed`.
- **Corrupt entries (review 25 B2).** `replay` returns `folded`, `skip`
  (verified and without effect: own or known frame, receipt or other
  valid traffic at the self address) or `corrupt` (undecodable, cannot be
  opened, invalid signature, foreign signer, broken journal body). A
  corrupt entry never counts as folded: the cursor stops before it, a
  finding `finding(journal:corrupt-entry@<pos>)` is recorded once per
  position, the next read starts at it, with backoff (1, 2, 4, up to 16
  rounds). The release is untouched by it. After gate review 26 (B2 rest) the
  body is checked for shape before folding, as in the mailbox path
  (payload object with a string body, `batchProblem`, `opProblem`,
  `transactionProblem`), and any exception from the fold other than
  `Missing` or `Blocked` is corrupt as well (`CorruptFrame`, step rolled
  back): a validly self-signed frame with `payload: null` or a batch with
  `ops: null` no longer aborts the round. Policy: block. From the first
  corrupt position on, the answer folds nothing further (the log is
  ordered; skipping would fold later entries ahead of a step the device
  cannot read); the next read starts at the corrupt position. Enrolment
  from the log uses the same path: a corrupt first entry blocks the log
  track at position 0, the sibling track still delivers and witnesses.
  After gate review 27 the form check is deep (B2a, the input contract
  above) and the answer is a unit (B2b): form of every entry first, and a
  position found corrupt only in a later pass rolls the whole answer back
  to a re-fold below it, so no effect above the cursor survives.
- **Lost log answers (review 25 S2).** If no answer to the current read
  arrived with the next pickup (request or answer lost), the device asks
  again in that round: at most one log read per device and round, never a
  frame at the self address. An incomplete answer (gap, corrupt entry) or
  an unreachable carrier waits with backoff.
- **Enrolment from the log.** The new device starts with empty state and
  an empty journal and folds the log from position 0 (no snapshot, no
  compaction). The ceremony gives only slot, sibling knowledge and the
  kept probes (device state, not journal, MV-18), adopted when the
  ceremony ends; the release is the enrolling device's witness. The
  ceremony survives a reload of the new device (gate review 40 B2): the
  image carries `ceremony`, the device keeps waiting for the witness and
  then works off `owed` and the ceremony's probes in its first round
  without the ceremony. `selfLog: false` keeps the state copy.

### Results, both variants side by side

Full run of X1–X18, X7b and X21 with two devices, same scenarios. Under
controlled randomness (UUIDs, `randomBytes`, `getRandomValues` seeded)
all 40 result objects of K0 and K1a, including every measure and detail,
are identical to main b13706b.

| | K1a | K1a + journal at the service (hybrid) |
|---|---|---|
| outcomes | 17 passed (X3, X18 promise changed), 2 failed (X7 strict, X9), 1 n/a (X10) | identical in every cell |
| X6 restore from backup | passed, converged after 1 round | passed, converged after 1 round |
| X8 enrolment | state copy 3 546 B; connected after 1 round | folded from the log after 2 rounds: 8 entries, 50 131 B read; gated 2 rounds until A1's witness; state afterwards 3 546 B; connected after 1 round |
| X9 revocation | failed, thief reads 5 documents | failed, thief reads 5 documents; with a fresh registration the thief can also read the log (one seed = capability, unchanged) |
| X11, X12 | passed | passed |
| X21 repair, restore / request / answer / batch loss | 7 / 1 / 1 / 1 rounds | 1 / 1 / 1 / 1 rounds |
| X21 self address | 813 frames, 2.16 MB (journal 395 frames, 1.66 MB) | 578 frames, 1.52 MB (journal 279 frames, 1.16 MB; 38 requests, 29 answers, A1 answers 305) |
| X21 service | – | 42 log reads sent, 27 reached the carrier; sent 4 429 entries / 7.24 MB, arrived 1 771 entries / 2.66 MB; requests 3.1 kB, answer heads 1.5 kB; log 351 entries, 631 kB |

Counter-runs (`tests/mehrgeraet-k1a-dienst.test.ts`), before (first
build, 383bbc8) and after (hybrid):

| | before | after |
|---|---|---|
| Review-18 counter-run, A2 lost, not revoked | gated 1 round, then released by the log answer | folded and current (declined/cancelled) after 2 rounds, gated until revocation (22 of 22 rounds in the test); card never reaches B |
| same, A2 reachable | – | gated 2 rounds until A2's witness (K1a mailbox: 1 round); card never reaches B |
| Astra's empty answer (B1) | released, B `connected` | A2 lost: gated, state stays `handed` (the service withheld everything), card 0; A2 reachable: A2 witnesses and delivers, `cancelled`, card 0 |
| truncated tail, reordered log | – | same as empty: no release; folded what came |
| corrupt entries (B2) | cursor 40, released, B `connected` | cursor stays 0, one finding per position, at most 5 reads in 20 rounds (backoff), gated, card 0; folded once the entries are intact |
| restore with lost sibling, valid card | released after 1 gated round | folded after 2 rounds, gated 20 of 20 rounds like K1a; after revocation the card goes out and B connects |
| 10 rounds of lost log answers, then healed (S2) | next read on the backoff schedule (round 16) | one read per round (10), folded 2 rounds after healing |
| X21 repair after loss phases | 5 / 5 / 5 | 1 / 1 / 1 |
| X21 service volume (S3) | 999 entries, 1.84 MB counted before the faults | sent 7.24 MB, arrived 2.66 MB, plus requests and heads |

Revoking the lost sibling after the service withheld everything releases
from the device's own state, exactly as in K1a: the release comes from
the user's revocation, not from withholding.

### What the service learns (200-round long run)

Long run (`journalGrowth`): A, B, M with two devices each and four more
counterparts at M, the clock advances 4 h per round (33.3 days), every 10
rounds M introduces A to the next counterpart, one A device (alternating)
and the counterpart consent, A1 confirms the budget every 50 rounds; 20
acts issued, 19 connected, both A devices agree.

- The service holds 1 266 entries, 2.15 MB, at A's self address; sizes
  1 184 / 1 185 / 17 758 B (min / median / max), 80 distinct sizes, the
  two most frequent (1 185 B: 778 entries, 1 184 B: 228) are receipts;
  196 distinct deposit times over 33 days; 2 collecting devices.
- Per reader it sees the cursor positions, read times and backlog: here
  one reader, A2 at enrolment, cursor 0, backlog 8 entries (60.7 kB),
  request 116 B, answer head 124 B. After a restore it would see which
  position the backup had, how long the device was away and how much it
  lacked.
- It does not see kinds; by world knowledge 258 entries (952 kB) are
  journal frames and 1 006 entries (1.19 MB, 56 %) receipts. Size and
  timing still show them apart, and deposit times show when the person
  acts. Cross-relationship linking at the service does not arise (one
  self address per person), the person's activity profile does.
- A separate receipt address for journal frames would reuse `replyTo`
  (no wire change: other addressing and registration); not built.

### Growth (numbers only, no compaction built)

At round 200 the journal holds 252 batches, 348 kB (K1a 347 679 B, the
variant 347 680 B): operations 121.5 kB (35 %), production intents
203.0 kB (58 %), the rest is batch framing. Removable, if a rule allowed
it (review 25 S1: an intent counts only if it is delivered or withdrawn
AND every device of the fixed device list has folded its batch):

- both devices live: 81 of 81 intents (202.5 kB) removable now; 252 of
  252 batches below the minimum head;
- A2 lost from day 5 (round 30, offline, not revoked): 81 intents done,
  removable now 5 (13.1 kB); if A2 were revoked 81 (202.5 kB); batches
  below the minimum head 11 (22.5 kB) of 224, without A2 224 (340 kB).
  The same numbers for K1a with the mailbox;
- batches older than the longest window (28 days, 8510): 15 batches,
  36.1 kB.

A restore from an older backup, enrolment from position 0 and the missing
snapshot still need the history; the numbers are a ceiling for a
snapshot rule, not a deletion rule. The log at the service grows to
2.15 MB in 200 rounds; with A2 lost from day 5 it holds 913 entries,
3.38 MB, of which 867 are journal frames for 224 batches: A1's deliverer
repeats every journal frame A2 does not acknowledge, and the log keeps
every repeat.

### Limits

- **Not equivocation-safe at the service.** The service can reorder,
  drop the tail, answer with a shorter `end` or keep a foreign writer
  branch from a reader; nothing in the log reveals it. `deps` detects
  inner gaps only (a batch whose predecessor is missing is deferred). This
  is exactly why the log is not a release ground.
- (Superseded 20 October, MV-6 new:) no lockout after restore any more;
  the log only brings data. Without the log's data and without the
  sibling, a restored device acts from its old image (named price).
- Cost of the hybrid: both tracks run; the sibling still sends batches
  for stale requests its deliverer repeats (X21: 279 journal frames,
  1.16 MB), and the per-round re-read after a lost answer re-sends the
  whole log tail (X21: 7.24 MB sent for 2.66 MB arrived).
- No compaction, no snapshot: the log is unbounded and keeps repeats.
- A permanently corrupt entry keeps the log track pending (re-read with
  backoff) and, by the block policy, nothing behind it is folded from the
  log; the sibling track still repairs and releases. Only a holder of the
  seed can write a validly self-signed corrupt entry.
- A bench error inside the fold now shows as a corrupt finding with its
  message (`failed(journal-corrupt): fold: …`), not as a crash.
- One seed stays a capability (X9): a thief with the image registers and
  reads the log.
- The service learns the person's activity profile (count, size and time
  of steps, cursor, read times and backlog per reader); hiding it
  (padding, batching, cover traffic) is not built.

### Conclusion

Journal beim Dienst = Beschleunigung, kein Freigabegrund; seit MV-6 neu
(20.10.) gibt es nach Restore keine Freigabe-Sperre mehr; der Dienst kann
zurückhalten, aber nichts bewirken (MV-23, MV-35).

## No gate after restore (MV-6 new, MV-34, 20 October 2026)

Anton, 20 October (plan 6t, decision 2): restore rule (iii), **nobody
waits for anybody** (MV-34) and **no service is a prerequisite** (MV-35).
MV-6 new: a device rebuilt from the store waits for nobody; it catches up
on what is reachable (sibling journal or log) and acts; whatever it sends
twice or against a decision taken meanwhile, the counterpart catches by
the rules (rule 2: a handed-over card holds; A keeps single use, 8640.12
as a rule). Restore artefacts are a named price; how rare they are
depends on how current the image is. Question 4.1 is moot.

**What changed in the holder** (shared by K0, K1a and K2):

- `reload` no longer sets the hold (`catchUp`); catch-up is requested as
  before and still binds answers to the current request (gate review 19
  B1a), but it only brings data. Released, refills and revision numbering
  happen at once from the image (`parked`, `owed` and the gate checks in
  `refill`, `sendRevision`, `produce`, `publishSets` stay only for
  enrolment from the log, below; that ceremony survives a reload, gate
  review 40 B2).
- **P kept after a decline (MV-31).** A counter card that arrives at an act
  the person declined is refused as before (8910.6, `card-refused`, V
  recorded), and its checked payload is kept as hidden P (`card-pending`;
  the projection shows no P for a declined act, 8325.A3). Rule 2 can still
  turn the decline into a consent (a restored device re-sends its card,
  the carrier takes it); then the device whose own card is submitted
  connects with that P (`connectOwed`, 8325.A5c; under device sets only
  the producer, as before). Without this, the review-18 counter-run ended
  with B connected and A consented without a tuple (B's card had been
  refused and receipted).
- **8640.12 as a rule.** A ticket on a stock key the side already consumed
  is refused with the finding `… abgewiesen nach Regel 8640.12
  (Einmalverbrauch bei A; Restore-Artefakt oder Konformitätsfehler des
  Mediators)`, no act, no receipt; the mediator takes the next key (its
  own consumption marks the key). Same behaviour as before, now a rule.
- **Kept:** enrolment from the log (step 6, `startFromLog`) still releases
  nothing until the enrolling device witnesses: the new device starts
  empty, and enrolment is a live ceremony with the old device (MV-34
  allows live ceremonies). Open for Anton whether it stays.

**Cells.** None of K0, K1a or the K1a variant with the journal at the
service changed: under controlled randomness all 120 result objects
(two devices and serial) equal main 69c70a1 in outcome, promise flag,
crash flag and measures; the only differences are K0's X18 detail (the
anchor-pair oracle's reasons, since step 2) and X21's byte measures (a few
bytes, the X18 oracle draws randomness; already so on #74). Why no cell
moves: no scenario restores a device from an image that misses a decision
its sibling made meanwhile and then lets the stale step reach a
counterpart before the fold. X3 (consent against decline) has no restore;
X6 and X21 restore with the sibling online, so data catch-up finishes
within a round; whatever the restored device does from its image before
that changes none of the measured outcomes or measures (compared, not
argued).

**Unit tests changed** (`tests/mehrgeraet-k1a.test.ts`, step 3: 4–7, step
4: 4; `tests/mehrgeraet-k1a-dienst.test.ts`: 2–8, 13, 14, 17):

- Review-18 counter-run (step 3, test 4): formerly "nothing leaves before
  catch-up; the withdrawn card never reaches B". Now a **visible restore
  artefact, consistent**: A1 restored from the backup re-sends the card
  A2 had withdrawn (A1's journal held back three rounds, the card goes out
  in the first round); B connects; A1 folds A2's decline and rule 2 decides
  for the consent (the card reached the carrier); A1 connects with B's
  card kept as hidden P; both A devices agree (`connected`), one connect
  at B, the decline stays as conflict finding.
- Mirror (5): the valid card goes out without waiting for catch-up.
- Stale answer (6): still does not end data catch-up; acting does not
  depend on it.
- Lost sibling (7, formerly 7 and 8): the card goes out at once, no
  revocation, no time bound, `gatedRounds` 0.
- Writer tags (step 4, test 4): restore with a sibling now reuses revision
  number 3 with other content; M records 6270, the ledger holds exactly
  the double `revision:<rel>:<tag>:3`; after healing the devices agree and
  the next revision (4) holds at M.
- Variant with the log: the data track is unchanged (folded after 2
  rounds, corrupt entries a finding per position, cursor, backoff, binding
  to the current read, a log answer as one unit); the release assertions
  now say "no gate, the card goes out". If the service withholds
  everything and the sibling is lost (test 4, empty), A1 knows neither the
  decline nor B's card: B is connected, A1 stays `consented` until data
  arrives (named price, MV-35: the dependence on reachable data).

**Named prices of the restore rule** (all consistent, none silent):
re-sent withdrawn card (rule 2 turns the decline into a consent, conflict
finding); revision number reused (6270 finding at M, a double in the
ledger); a re-allocated stock key with the same anchor and another value
(`conflict:key-value`); a connection that stays open on one side until the
restored device reaches data (no sibling, no log).
