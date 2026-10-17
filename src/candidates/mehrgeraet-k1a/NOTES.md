# Port notes: K1a, one seed, operation journal, static rights (E15 step 1)

As of 17 October 2026. K1a is the first positive candidate of the
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
  receipt does not end the repair (gate review 9). A device restored from
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

## Results (17 October, K1a against X1–X18 and X21)

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
| X7 continuity across devices | failed | passed | every device holds two entries to B with one tuple each: the facts are shared, nothing is united |
| X8 enrollment | passed | n/a | state, journal and intents copied; A2 consents and connects at once |
| X9 device revocation | failed | n/a | the thief with the image reads four documents and holds an act (one seed) |
| X10 restricted app | n/a | n/a | step 1 has no rights profile per app |
| X11 long separation | passed | n/a | both devices connected after reunion, stable after three rounds, no double effects, journal about 22 kB |
| X12 delivery per device | passed | passed | B's effect once, A1 delivered after two rounds, A2 equal after one round |
| X13 mediator devices against the shared budget | passed | passed | M1 and M2 each issue one introduction offline at budget 9, A1 sees one ticket, A2 the other: ten acts, no overrun, five blocked acceptances, no key named twice |
| X14 double introduction | failed | passed | two acts, both connected; with B1 and B2 separated while consenting, B1, B2 and C1 each hold two entries with one tuple (no union) |
| X15 union ∥ running act | passed | passed | A2, separated from A1, unites the two relationships to M while A1's card is in transit; one entry with two tuples on both devices, the act connected, its mediator and acceptance on the united relationship, M's view on the united head |
| X16 old stock after class revocation | failed | passed | A2, separated, accepts a ticket on a key A1 withdrew; after healing both devices hold the act and the key is consumed |
| X17 parallel production | failed | passed | both devices refill and send revision 2 with different keys; one revision number from two operations, M records 6270 findings; probe sequence (6680) not modelled |
| X18 two cards of one act | failed | passed | B receives two card documents with the same card key, connects once, no conflict mark; A's devices keep different hand-over digests and never agree |
| X21 journal robustness | passed | n/a | repair after old and double restore with reordering, duplicates, concurrent requests and two crashes in 7 rounds; after 15 rounds of lost requests, answers or receipts each in 1 round; no missing batch, no double effect, no conflict; 621 frames and 1.5 MB on the self address, of which 260 journal frames (1.09 MB for an 11-batch, 22 kB journal) and 438 repeats; the journal does not grow |

Counts over X1 to X18 and X21 with two devices: 11 kept, 7 not kept, 1
not applicable (K0: 1 kept, 17 not kept, 1 not applicable).

Reservations (gate reviews 8 and 9): a successful restore with reachable
history (X6) is not the same as repair after lost sync traffic (X21
measures that separately); a thief with the device's image has the same self
anchor and receives new history through the sync as well (X9, one seed);
X1, X2 and X5 show
fixed rights with the entitled device available and no re-production,
not a transfer of rights or a takeover after a device is lost (K1b,
X20); X8 and X11 do not show a union of the person's own tuples (X14).

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
- **Shared tuples are not united (X7).** Both devices learn both
  encounters with B from the journal, so each holds two relationship
  entries to B; the continuity protocol (probe, mapping, union, 6975) runs
  only between a device's own tuple and the counterpart, never between
  two own tuples of the same person. Sharing the facts is not merging
  them; K1a needs the union step over own tuples (I-6).
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
  and replies) or lost receipts on the self address, the device converges
  within one round of healing, without any new domain operation, and the
  self address falls silent at once. Lost requests and answers leave A2
  behind for the whole loss; lost receipts do not (the answers arrive, only
  their acknowledgement is missing). The cost is the full journal on every
  answer: 260 journal frames carry 1.09 MB to repair an 11-batch journal of
  22 kB; 438 of 621 deposits on the self address are repeats by the
  delivery layer, 306 are receipts; A1 sends 284 answer frames, A2 two.
  Three frames go from A's devices to counterparts during the repair. The
  journal does not grow during repair.
- **Mediator devices hold the shared budget (X13).** Two mediator devices
  issuing offline against A's budget at nine do not overrun it: A's
  devices split the acceptance quota, the device without quota blocks, and
  the person ends at ten acts. K0 reaches eleven.
- **Own tuples are still not united (X14).** Two acts from A1 and A2 for the
  same pair connect on B1 and B2. Each probe is checked by the device that
  lacks the other tuple and acknowledged; once the journal heals, no device
  checks again, and B and C keep two entries each. Without the separation
  of B1 and B2 the outcome depends on frame order (the acts were united in
  about half of the runs); the scenario separates them so the result is
  stable. This is the same gap as X7: K1a needs a union step over the
  person's own tuples.
- **A union through the counterpart travels well (X15).** When M's mapping
  unites two relationships on one device, the union is an operation in the
  journal; the other device folds it, re-points the running act and its
  acceptance to the united relationship, and the act connects. No union
  over own tuples is needed here, since the counterpart detects the
  continuity.
- **Revocation and production are not rights (X16, X17).** A device that
  did not see the class revocation accepts a ticket on a withdrawn key,
  and the fold then marks the key consumed on every device. Two devices
  refilling apart send the same revision number with different keys, and
  M records the conflict (6270). Static rights cover consumption (budget,
  nameable keys), not changes of the class or of revision numbers.
- **Two hand-overs of one act do not fold (X18).** Both devices consent and
  send a card; with one seed the card key is the same, so B sees a
  repetition and connects once. A's devices each keep their own hand-over
  digest, since the fold takes the last hand-over operation, and their
  projections never agree. With keys per device (K2) B would also see two
  different cards (8910.8).
- **Bench note: a repeated ticket after a budget refusal.** The ticket that
  A refuses for budget (8640.13) consumes the key; the mediator repeats the
  unacknowledged ticket and A then records 8640.12 (mediator conformance)
  for the repeat. X13 does not use that count; X1, which counts 8640.12,
  has no budget refusal.

## Limits of step 1

- The device count is fixed; a third device is refused. Transferring or
  re-splitting rights is K1b.
- No transfer of quota between devices (that is K1b); no takeover of a
  sibling's intent when the sibling is lost (X20, K2).
- No union step over the person's own tuples: two tuples to the same
  person that the continuity probes missed stay two entries (X7, X14).
- Class changes, revision numbers and hand-overs are not rights and have
  no merge rule beyond the fold: X16, X17 and X18 fail.
- The journal is a plain list of batches in the device's store; no
  cleanup, no tombstones, no bound on its size; every sibling that
  receives a request answers with all batches after the requester's heads,
  and every new request of the backoff is answered again in full (X21: 1.09 MB of
  journal frames for a 22 kB journal).
- Every scenario runs one person per role with two devices; X19, X20, X22
  and X23 are not built, X10 needs rights per app.
