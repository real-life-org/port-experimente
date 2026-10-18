# Port notes: K1a, one seed, operation journal, static rights (E15 steps 1 to 3)

As of 18 October 2026. K1a is the first positive candidate of the
multi-device experiment: every device derives all keys from the same seed
(like K0), but every committed step of a device travels as one journal
batch to the person's own address, and the rights that consume a hard
limit are assigned to one device in advance.

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
  review.
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
- **No release before catch-up after a restore (gate review 18 B1a).**
  After a rebuild from the store image, a device whose person has another
  device (known from enrollment, or a foreign writer in its journal)
  releases nothing to a counterpart (card, mapping, revision, receipt)
  until its own catch-up has completed: the sibling answered the
  `journal-sync` request and the own heads cover the sibling's. The
  answer counts only if it is bound to the device's current request
  (gate review 19 B1a): every request carries a fresh random request id,
  the answerer echoes it, and an answer with an older or a foreign id is
  dropped (`staleSyncAnswers`); an old, validly signed answer replayed
  after the restore no longer ends the catch-up. The same answer a second
  time changes nothing. Backoff re-requests and the answerer asking back
  when the requester knows more are unchanged (X21 keeps its repair
  rounds). Only
  traffic on the self address (journal, catch-up, receipts on it) goes
  out; held submissions neither deposit nor repeat, and their deadlines
  do not run. After the catch-up the fold decides which of them are still
  valid: a card the journal shows as `cancelled` is demarcated locally
  without a new operation, a card the fold now declines or that lost rule
  3 is withdrawn as usual, the rest goes out after the round's commit. A
  device whose sibling never answers stays held (no deadlock for others,
  but nothing leaves it); a device of a person with one device, or a K0
  device without journal, holds nothing back. Revoking the sibling lifts
  the hold (gate review 19, question 3): a revoked device no longer counts
  as a sibling (the revoking device records it in its store image); when
  the device waits only on revoked siblings, nobody is left to catch up
  with, and in the next round the fold decides what goes out (restore A1,
  A2 lost, A1 revokes A2: held for every round before the revocation,
  released in the round after it, B connects once). In the bench only the
  revoking device learns the revocation.
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
| X11 long separation | passed | n/a | both devices connected after reunion, stable after three rounds, no double effects, journal about 22 kB |
| X12 delivery per device | passed | passed | B's effect once, A1 delivered after two rounds, A2 equal after one round |
| X13 mediator devices against the shared budget | passed | passed | M1 and M2 each issue one introduction offline at budget 9, A1 sees one ticket, A2 the other: ten acts, no overrun, five blocked acceptances, no key named twice |
| X14 double introduction | passed | passed | two acts, both connected; with B1 and B2 separated while consenting, C's probe on its second tuple (which holds the first) misses at the B device that lacks B's other tuple; after B's journal heals, that device re-evaluates the kept probe, hits and maps; B1, B2 and C1 each hold one entry with both tuples, no double effect |
| X15 union ∥ running act | passed | passed | A2, separated from A1, unites the two relationships to M while A1's card is in transit; one entry with two tuples on both devices, the act connected, its mediator and acceptance on the united relationship, M's view on the united head |
| X16 old stock after class revocation | failed | passed | A2, separated, accepts a ticket on a key A1 withdrew; after healing both devices hold the act and the key is consumed |
| X17 parallel production | failed | passed | both devices refill and send revision 2 with different keys; one revision number from two operations, M records 6270 findings; probe sequence (6680) not modelled |
| X18 two cards of one act | passed, promise changed | passed | rules 1 and 3: both cards were taken while the devices were separated, so nothing is withdrawn; A's ledger holds one consent and one connect effect, both devices hold the same hand-over digest and agree after one round; two card documents reach B (each B device receives both), B connects once, no conflict mark |
| X21 journal robustness | passed | n/a | repair after old and double restore with reordering, duplicates, concurrent requests and two crashes in 7 rounds; after 15 rounds of lost requests, answers, journal batches alone (reply head and receipts delivered) or receipts each in 1 round; after every phase no missing batch key and the reference projection on both devices; repair ends with no device waiting for catch-up and 17 silent rounds on the self address; no double effect, no conflict; 813 frames and 2.1 MB on the self address, of which 395 journal frames (1.65 MB for an 11-batch, 22 kB journal); 569 repeats, 566 on the self address and 3 to counterparts; the journal does not grow |

Counts over X1 to X18, X7b and X21 with two devices: 15 kept (X3 and X18
under a changed promise), 4 not kept, 1 not applicable (K0: 1 kept, 18
not kept, 1 not applicable). Step 2 changed X14 and added X7b; step 3
changed X3 and X18; every other outcome is the same as after step 1.

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
  did not see the class revocation accepts a ticket on a withdrawn key,
  and the fold then marks the key consumed on every device. Two devices
  refilling apart send the same revision number with different keys, and
  M records the conflict (6270). Static rights cover consumption (budget,
  nameable keys), not changes of the class or of revision numbers.
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

## Limits of steps 1 to 3

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
  united relationship would each produce a revision under the same
  number; that is the open production question of X17.
- Class changes and revision numbers are not rights and have no merge
  rule beyond the fold: X16 and X17 fail.
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
- After a restore a device holds back everything for its counterparts
  until a sibling answers its current catch-up request. A restored device
  with a lost, unrevoked sibling sends nothing to counterparts until the
  sibling is revoked; no time bound, decision Anton pending. Measured:
  restore A1 from a backup with a valid consent, A2 lost: after 70 rounds
  A1 is still held (`gatedRounds` 70, no card at the carrier, B stays
  `consented`). Taking over is X20.
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
