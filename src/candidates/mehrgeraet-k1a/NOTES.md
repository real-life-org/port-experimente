# Port notes: K1a, one seed, operation journal, static rights (E15 steps 1 and 2)

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
  introduces. Decisions (consent, decline) are allowed on every device:
  a conflict stays visible in the fold (8325 finding, X3).
- **Union of own tuples (step 2).** Two devices of a person can each open
  a tuple before the journal brings the other's (X7: A1 meets B1, A2 meets
  B2; X14: B1 and B2 connect one act each). Each tuple's candidate
  snapshot (2300) was taken on its device and lacks the other, so no probe
  ever tests the pair. The holder, with the candidate flag `lateProbes`,
  looks for such pairs whenever it applies a journal batch and in every
  time step: two own tuples in different relationships, neither in the
  other's frozen candidate list. On one device this cannot happen, because
  a later tuple always has every earlier one of a held relationship in its
  snapshot, so the condition identifies concurrent openings without knowing
  which device opened what. For each pair the device adds the other
  tuple's counterpart anchor to the candidate list of the tuple with the
  larger record anchor (operation `candidates`) and sends a probe on that
  tuple carrying only the new blinded entry. From there the unchanged
  continuity flow runs: the counterpart, whose own devices share both of
  its tuples through its journal, finds a hit and owes a mapping (6845.1);
  the side verifies it and unites (6975.1, 6975.2) with its own mapping in
  the same step; the counterpart verifies that mapping and unites as well,
  or records the edge if it already has (6975.3). The step runs on both
  persons alike; whichever side learns its pair last probes when the other
  side already knows both of its tuples.
  - **How own tuples are matched.** The holder has no identity of the
    counterpart person: tuple peers are pair anchors, one per encounter
    or act. The device does not decide that two tuples belong to the same
    person; it only notices that two of its tuples were never tested
    against each other. The counterpart decides through the probe hit, and
    the union needs the verified mapping, as on one device.
  - **What is journalised.** The `candidates` operation, the probe intent,
    the union, the duty and the mapping intent are operations and intents
    of the device's step, so they travel as one batch; a sibling folds the
    added candidate and does not probe the same pair again. If both
    devices detect the pair before either batch arrives, both probe; a
    counterpart device that checks the second probe after the first finds
    the duty already in `hit` and sends no second mapping, while two
    counterpart devices checking at once may each send one (covered by the
    rules below).
  - **Concurrent unions.** With one seed both devices listen on every
    tuple address, so a counterpart mapping reaches both and both may
    unite over the same edge, each with its own mapping back. Two fold
    rules make that converge: a union over an edge that is already
    united keeps the effect of the canonically smallest operation (6230:
    one union, not two, in every order); a pair duty that two devices
    each bring to `united` keeps the smallest mapping digest (6845.9 stays
    final). Without them the ledger shows the union from two operations
    and the duty digests differ between the devices (checked by
    counter-run).
  - **Assumption beyond the inventory.** 2300 freezes the snapshot of
    "the active heads of its relationships then". The candidate reads
    "its relationships" as the person's, so a tuple a sibling device
    opened concurrently is added once the device knows it; 6750 (no entry
    for a tuple that was not an active head when the probed tuple opened)
    is otherwise kept. Whether a concurrent opening on another device
    counts as "then" is not decided by the inventory.

## Results (18 October, K1a against X1–X18 and X21)

See the matrix (`matrix.md`, multi-device port) for the cells; the table
below is filled from the report run and the acceptance tests. "Serial"
is the control run with one device per person and undivided rights
(`k1a({ devices: 1 })`); K0 passes the same serial control for every
scenario that has one.

| | two devices | serial | what the bench measured |
|---|---|---|---|
| X1 double consumption | passed | passed | M1 and M2 name different keys (number classes); no 8640.12 at A |
| X2 budget at 9 | passed | passed | ten acts for the person, seven acceptances blocked, the sibling takes what one device may not |
| X3 consent ∥ decline | failed | passed | A1 connected, A2 declined; both effects in the ledger, contradiction at B; the devices never agree |
| X4 class off ∥ send | passed | passed | M's view empty on both devices, the running act connected on both, no equivocation |
| X5 departure ∥ replay | passed | passed | A2 holds A1's mapping intent and produces nothing; only repeats of earlier bytes reach B |
| X6 restore from backup | passed | n/a | new incarnation; the catch-up over the self address brings the missed batches, own earlier incarnation included |
| X7 continuity across devices | passed | passed | A1, A2, B1 and B2 each hold one entry to the other person with both tuples, no duplicate across devices, stable after four rounds (late probe, step 2) |
| X8 enrollment | passed | n/a | state, journal and intents copied; A2 consents and connects at once |
| X9 device revocation | failed | n/a | the thief with the image reads four documents and holds an act (one seed) |
| X10 restricted app | n/a | n/a | step 1 has no rights profile per app |
| X11 long separation | passed | n/a | both devices connected after reunion, stable after three rounds, no double effects, journal about 22 kB |
| X12 delivery per device | passed | passed | B's effect once, A1 delivered after two rounds, A2 equal after one round |
| X13 mediator devices against the shared budget | passed | passed | M1 and M2 each issue one introduction offline at budget 9, A1 sees one ticket, A2 the other: ten acts, no overrun, five blocked acceptances, no key named twice |
| X14 double introduction | passed | passed | two acts, both connected on B1, B2 and C1; with B1 and B2 separated while consenting, B's late probe after healing reaches C, and B1, B2 and C1 each hold one entry with both tuples; no double effect |
| X15 union ∥ running act | passed | passed | unchanged by step 2: A2, separated from A1, unites the two relationships to M while A1's card is in transit; one entry with two tuples on both devices, the act connected, its mediator and acceptance on the united relationship, M's view on the united head |
| X16 old stock after class revocation | failed | passed | A2, separated, accepts a ticket on a key A1 withdrew; after healing both devices hold the act and the key is consumed |
| X17 parallel production | failed | passed | both devices refill and send revision 2 with different keys; one revision number from two operations, M records 6270 findings; probe sequence (6680) not modelled |
| X18 two cards of one act | failed | passed | fails for two reasons: A's ledger holds consent and connect of the act each from two operations (two double final effects at A, none at B), and A's devices keep different hand-over digests and never agree; B receives two card documents with the same card key, connects once, no conflict mark |
| X21 journal robustness | passed | n/a | repair after old and double restore with reordering, duplicates, concurrent requests and two crashes in 7 rounds; after 15 rounds of lost requests, answers, journal batches alone (reply head and receipts delivered) or receipts each in 1 round; after every phase no missing batch key and the reference projection on both devices; repair ends with no device waiting for catch-up and 17 silent rounds on the self address; no double effect, no conflict; 813 frames and 2.1 MB on the self address, of which 395 journal frames (1.65 MB for an 11-batch, 22 kB journal); 569 repeats, 566 on the self address and 3 to counterparts; the journal does not grow |

Counts over X1 to X18 and X21 with two devices: 13 kept, 5 not kept, 1
not applicable (K0: 1 kept, 17 not kept, 1 not applicable). Step 2
changed X7 and X14; every other outcome is the same as after step 1. In
the matrix MG7 (continuity across devices) is now kept.

Reservations (gate reviews 8 and 9): a successful restore with reachable
history (X6) is not the same as repair after lost sync traffic (X21
measures that separately); a thief with the device's image has the same self
anchor and receives new history through the sync as well (X9, one seed);
X1, X2 and X5 show
fixed rights with the entitled device available and no re-production,
not a transfer of rights or a takeover after a device is lost (K1b,
X20); X8 and X11 do not show a union of the person's own tuples (X7 and
X14 do).

## Findings

- **Static rights keep the hard limits (X1, X2).** Two mediator devices
  never name the same key: each may only name keys of its number class;
  a device without a nameable key refuses and the other introduces. The
  person's budget holds at ten across both devices (five each, seven
  blocked acceptances in X2); the frame a device cannot accept stays
  unacknowledged and the sibling accepts it.
- **Decisions are not a right in step 1, so X3 stays a visible conflict.**
  A1 consents, A2 declines; the fold keeps the first terminal state on
  each device (A1 connected, A2 declined), records the contradiction, and
  the devices never agree. A connect from the other device must not
  override a decline either; the refused attempt is recorded as a
  conflict, not as an executed connect (model fix in this step). Making consent and
  decline a device right is the open question for the multi-writer
  contract, not something a journal solves.
- **Catch-up after a backup works through the journal (X6).** A2 restored
  from an old backup gets a new incarnation and, after one sync round,
  every batch it missed, including those of its own earlier incarnation;
  the keys M consumed are consumed on A2 again, the acts are back. What
  the sync does not do: bound the journal, forget anything, or decide
  between two devices that answer the same request (both answer, the
  requester deduplicates).
- **Shared tuples need a late probe (X7).** Both devices learn both
  encounters with B from the journal, but the candidate snapshot of each
  tuple was taken on its own device, so no probe tested the pair and each
  device kept two entries to B. Sharing the facts is not merging them.
  With the late probe (step 2) the device that holds both tuples probes
  the newer one with the other's counterpart anchor; B, whose devices
  share both of B's tuples, hits and maps, and both persons unite through
  verified mappings. Without the late probe K1a still fails X7
  (counter-run in the tests).
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
- **Own tuples after a double introduction (X14).** Two acts from A1 and A2
  for the same pair connect on B1 and B2 while B1 and B2 are separated.
  Each of C's probes is checked by the B device that lacks the other tuple
  and acknowledged. Once B's journal heals, a B device holds both tuples to
  C, neither in the other's snapshot, and probes again; C (one device,
  both tuples) hits, maps, and B and C unite. C itself never needs a late
  probe: its second tuple has the first in its snapshot.
- **A union through the counterpart travels well (X15).** When M's mapping
  unites two relationships on one device, the union is an operation in the
  journal; the other device folds it, re-points the running act and its
  acceptance to the united relationship, and the act connects. No late
  probe is involved: A2's new tuple has the old one in its snapshot.
- **Concurrent unions on both devices converge (step 2).** A1 and A2,
  separated from each other after both learned both tuples to B, each
  verify B's mapping (it reaches both, one seed) and each unite with an
  operation of its own. After healing both hold one entry with both
  tuples, the same projection, one union effect for the edge and no
  double effect at A or B. Duplicated and reordered frames during the
  whole flow give the same result.
- **Revocation and production are not rights (X16, X17).** A device that
  did not see the class revocation accepts a ticket on a withdrawn key,
  and the fold then marks the key consumed on every device. Two devices
  refilling apart send the same revision number with different keys, and
  M records the conflict (6270). Static rights cover consumption (budget,
  nameable keys), not changes of the class or of revision numbers.
- **Two hand-overs of one act do not fold (X18).** Both devices consent and
  send a card. A's ledger then holds the consent and the connect of the
  act each from two operations: two double final effects at A, counted by
  the same ledger oracle as in the other scenarios (gate review 11 B1; the
  first cut counted only B's connect). With one seed the card key is the
  same, so B sees a repetition and connects once, no double effect at B.
  A's devices also each keep their own hand-over digest, since the fold
  takes the last hand-over operation, and their projections never agree.
  The two reasons are independent: with the digest hidden from the
  projection A's devices agree and X18 still fails on A's double effects
  (permanent counter-run). With keys per device (K2) B would also see two
  different cards (8910.8). The multi-writer contract needs a rule for
  concurrent consents and hand-overs that fixes convergence and a single
  final effect.
- **Bench note: a repeated ticket after a budget refusal.** The ticket that
  A refuses for budget (8640.13) consumes the key; the mediator repeats the
  unacknowledged ticket and A then records 8640.12 (mediator conformance)
  for the repeat. X13 does not use that count; X1, which counts 8640.12,
  has no budget refusal.

## Limits of steps 1 and 2

- The device count is fixed; a third device is refused. Transferring or
  re-splitting rights is K1b.
- No transfer of quota between devices (that is K1b); no takeover of a
  sibling's intent when the sibling is lost (X20, K2).
- The late probe rests on an assumption the inventory does not make: the
  2300 snapshot read per person, a concurrently opened sibling tuple
  added once known. The device recognises no counterpart person; it only
  finds own tuples never tested against each other, and the counterpart's
  hit decides. Pairs are found by scanning all own tuples (quadratic).
- A late probe goes out once per pair; if it is lost to a counterpart
  that does not yet know both of its tuples, the pair relies on the
  counterpart's own late probe. Each concurrent pair costs a probe, also
  when the two tuples belong to different people (no hit then).
- Concurrent unions with own stock on the united relationship would each
  produce a revision (6987.5, 6987.14) under the same number; that is
  the open production question of X17, not exercised by X7 or X14.
- The tie rules for concurrent unions (smallest operation for the union
  effect, smallest digest for a `united` duty) are bench rules of the
  fold, not inventory rules.
- Class changes, revision numbers and hand-overs are not rights and have
  no merge rule beyond the fold: X16, X17 and X18 fail.
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
