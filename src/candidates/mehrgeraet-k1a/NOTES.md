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

## Results (17 October, K1a against X1–X12)

See the matrix (`matrix.md`, multi-device port) for the cells; the table
below is filled from the report run.

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

Counts over X1 to X12 with two devices: 8 kept, 3 not kept, 1 not
applicable (K0: 1 kept, 10 not kept, 1 not applicable).

Reservations (gate reviews 8 and 9): a successful restore with reachable
history (X6) is not the same as repair after lost sync traffic, which
the acceptance run covers for one device and one loss at a time (X21
measures repair rounds and traffic under reordering, duplicates and
concurrent requests); a thief with the device's image has the same self
anchor and receives new history through the sync as well (X9, one seed);
X1, X2 and X5 show
fixed rights with the entitled device available and no re-production,
not a transfer of rights or a takeover after a device is lost (K1b,
X20); X8 and X11 do not show a union of the person's own tuples (X14,
X15).

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

## Limits of step 1

- The device count is fixed; a third device is refused. Transferring or
  re-splitting rights is K1b.
- No transfer of quota between devices (that is K1b); no takeover of a
  sibling's intent when the sibling is lost (X20, K2).
- The journal is a plain list of batches in the device's store; no
  cleanup, no tombstones, no bound on its size; a sync answer re-sends
  whole batches (X21 measures size and repair traffic).
- The acceptance run checks one person with two devices; X13–X18 and
  X21 are the broad K1a matrix and come next.
