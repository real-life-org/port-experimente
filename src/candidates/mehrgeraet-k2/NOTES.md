# K2 step 1: device keys, registration per device, device-signed journal

Plan E15, section 6o.4 step 1 (`rltp/design/port-experimente-e15-mehrgeraet-plan-2026-10-17.md`),
Anton's go for K2 on 18 October 2026. Candidate `k2-device-keys`
(`index.ts`), tests `tests/mehrgeraet-k2.test.ts`. K2 reuses K1a's
journal, holder and model (`src/lab/mehrgeraet/{holder,model,welt}.ts`,
`src/candidates/mehrgeraet-k1a`); this note says what changes and what
the bench measured.

## Assumptions in force

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

### Counterparts (step-1 simplification)

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
- Every device numbers its own stock under its own nonce
  (`stockNonce`, derived from the device secret per relationship; 8430,
  8445 per device). The person's stock is the union of the devices'
  stocks; numbers may coincide across devices, the identity is
  (nonce, n) and the anchor differs anyway. The model still reports a
  second nonce on a relationship (8435, "zweiter Vorrat"): that finding
  now marks the normal case (X17: 2) and is a spec follow-up.
- **Interim rule until step 5: `mediatorSplit` on (default).** M keeps
  K1a's `n mod devices` split of the keys a mediator device may name.
  Nothing in step 1 replaces it: per-device keys remove writer tags and
  number classes, but not the case that two M devices name the same key
  of A's stock. The allocation per M device that A enforces (4.5 (b)) is
  step 5 and replaces the interim rule there. Counter-run
  `mediatorSplit: false` (`k2-device-keys-no-split`): M names any key,
  X1, X13 and X14 fail (measured, "Results").

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
| `n mod devices` split for M (`mayName`) | **kept as interim rule** (`mediatorSplit`, default on; off = counter-run) | nothing in step 1 replaces it; the allocation per M device that A enforces (4.5 (b)) is step 5 |
| shared self anchor as signer of journal frames, one self address | removed | journal signed per device, one self address per device |
| `conflict:key-value` | stays in the model, never fires | an anchor belongs to one device |

Unchanged and running for K2 (shared holder/model code, verified by the
X results and `tests/mehrgeraet-k2.test.ts`): fold rules 1–3, probe
re-evaluation and the retention rule, catch-up with request binding, the
gate after restore and its end by revocation, the acceptance quota per
device, prototype-free tables, the shape table and the form checks.

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

Counts: **K2 step 1 (interim rule `mediatorSplit` on): 17 kept (X3 and
X9 under a changed promise), 2 not kept (X7 strict, X18), 1 n/a (X10)**:
the K1a count, red X7 and X18 instead of X7 and X9. Counter-run without
the interim rule (`mediatorSplit: false`): 14 / 5 / 1, red X1, X7, X13,
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
- Fixed device count and static rights as in K1a (assumption no. 5).
- X1, X13, X14 pass only through the interim rule (K1a's static split
  at M) until step 5 builds the allocation per M device.
- X18 fails until decision 6o.5 no. 7 (step 2).
- No variant with the journal at the service for K2.
- The carrier sees one registration set per device; whether it can link
  a person's devices (registration sessions, timing) is not measured.
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
REPORT=1 pnpm vitest run report   # column k2-device-keys in the multi-device port
```
