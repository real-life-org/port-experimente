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
  incarnation). The batch key is the writer incarnation plus a counter;
  the previous batch of the same device is the predecessor. A device
  applies a batch only after its predecessor (otherwise the frame is
  deferred and the sender's dispatcher repeats it), and exactly once.
- **Incarnation.** A restore from the store gives the device a new
  incarnation (`A1@2`); the batches before the crash stay under the old
  one, the next steps under the new one. Enrollment copies state, journal
  and intents to the new device.
- **Intents instead of re-production.** A device resumes only intents it
  produced itself, with the same bytes (HSC-120); an intent of a sibling
  device stays with that device. K0 re-produced an open mapping on the
  enrolled device (X5); K1a does not.
- **Static rights at enrollment.** The acceptance budget per mediator
  relationship (8510, ten) is split evenly across the person's devices
  (five each for two); a device without quota blocks a ticket, the frame
  is not acknowledged and the sibling device accepts it. The stock keys a
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
| X6 restore from backup | failed | n/a | new incarnation, but no catch-up: two stale active keys, two acts missing |
| X7 continuity across devices | failed | passed | every device holds two entries to B with one tuple each: the facts are shared, nothing is united |
| X8 enrollment | passed | n/a | state, journal and intents copied; A2 consents and connects at once |
| X9 device revocation | failed | n/a | the thief with the image reads four documents and holds an act (one seed) |
| X10 restricted app | n/a | n/a | step 1 has no rights profile per app |
| X11 long separation | passed | n/a | both devices connected after reunion, stable after three rounds, no double effects, journal about 22 kB |
| X12 delivery per device | passed | passed | B's effect once, A1 delivered after two rounds, A2 equal after one round |

Counts over X1 to X12 with two devices: 7 kept, 4 not kept, 1 not
applicable (K0: 1 kept, 10 not kept, 1 not applicable).

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
  override a decline either (model fix in this step). Making consent and
  decline a device right is the open question for the multi-writer
  contract, not something a journal solves.
- **No catch-up after a backup (X6).** A2 restored from an old backup gets
  a new incarnation but never the batches it missed: the carrier has
  concluded them for A2, and K1a has no gap repair (HSC-440). Two keys
  that M consumed stay active on A2 and two acts are missing. Gap repair
  over the journal is the first item of the broad K1a matrix (X21).
- **Shared tuples are not united (X7).** Both devices learn both
  encounters with B from the journal, so each holds two relationship
  entries to B; the continuity protocol (probe, mapping, union, 6975) runs
  only between a device's own tuple and the counterpart, never between
  two own tuples of the same person. Sharing the facts is not merging
  them; K1a needs the union step over own tuples (I-6).
- **A seed is still a capability (X9).** The thief with A2's image reads
  the next ticket and holds the act; revocation at the carrier changes
  nothing under one seed, as with K0. Keys per device (K2) are the answer.
- **Hash parity starves a device.** The first cut split nameable keys by
  anchor hash: with five keys in stock M1 got one, and A refills only
  under three active keys, so M1 could not introduce again. Splitting by
  key number modulo devices alternates them (3/2) and the revision has to
  list the numbers (8445).
- **Journal size (X11):** about 22 kB of batches after two acts and a
  thirty-round separation; no cleanup yet.

## Limits of step 1

- Rights are split only at enrollment and only between the enrolling
  device and the new one; a third device changes the shares of the first
  two without telling them (fine for two devices, not beyond).
- No transfer of quota between devices (that is K1b); no takeover of a
  sibling's intent when the sibling is lost (X20, K2).
- The journal is a plain list of batches in the device's store; no
  cleanup, no tombstones, no bound on its size (X21 measures the size).
- The acceptance run checks one person with two devices; X13–X18 and
  X21 are the broad K1a matrix and come next.
