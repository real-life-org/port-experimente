# Port notes: K0, one seed, no merge (E15 baseline)

As of 17 October 2026. The multi-device experiment (E15) asks how several
devices of one person hold the same holder state, local-first, without a
lease. K0 is today's cut: every device derives all keys from the same
seed, each device keeps its own holder state, nothing is merged.
Enrollment copies the state once. K0 is the baseline that has to fail
X1, X2, X3 and X7 visibly; otherwise the bench is not calibrated.

The bench (`src/lab/mehrgeraet/`): a target model as a small state
machine (`model.ts`, rule ids from the inventories of Trust 0.32 §8 and
§6a and the Holder State Contract), a holder device over the E11 carrier,
dispatcher, clock and store (`holder.ts`), the world with persons, devices,
encounters and measurements (`welt.ts`), the scenarios X1 to X12
(`scenarios.ts`). Every scenario runs twice: with two devices per person
and serially (one device per person). The serial run is the control: it
must pass for K0, and it does.

## Results (17 October, K0)

| | two devices | serial | what the bench measured |
|---|---|---|---|
| X1 double consumption | failed | passed | M1 and M2 name the same stock key of A in two acts; A records a conformance failure of the mediator (8640.12) |
| X2 budget at 9 | failed | passed | A1 accepts the tenth ticket, A2 the eleventh: 11 accepted acts, each device counts 10 |
| X3 consent ∥ decline | failed | passed | A1 connected, A2 declined, B connected; the projections differ |
| X4 class off ∥ send | failed | passed | M2 still names a withdrawn key, A2 accepts and refills, M1 sees an equivocation on revision 3 (6270) |
| X5 departure ∥ replay | failed | passed | A2 resumes a `sent` duty after A1 departed; B is departed on A1 only |
| X6 restore from backup | failed | n/a | A2 falls back to revision 1 against M's 2, holds three keys as active that M marked consumed, lost three acts, and refuses a ticket naming a key it never had (8640.5) |
| X7 continuity across devices | failed | passed | A1–B1 and A2–B2 stay two relationships on each side: one double per person |
| X8 enrollment | passed | n/a | the state copy (about 9 KB) gives A2 the same projection; A2 consents and connects |
| X9 device revocation | failed | n/a | a thief with A2's seed and state re-registers and reads the next ticket |
| X10 restricted app | n/a | n/a | K0 has no rights per device |
| X11 long separation | failed | n/a | A1 connected two acts; A2, back after 30 rounds, holds them as offered; the projections never agree |
| X12 delivery per device | failed | passed | lost receipt and unreachable carrier end as in T9/T10; B's effect once; A2 never catches up with A1's delivered card |

Counts over X1 to X12 with two devices: 1 kept, 10 not kept, 1 not
applicable.

## Findings

- **Determinism hides some conflicts.** Both devices refill the same
  relationship with the same nonce and the same numbers, so their
  revisions coincide byte for byte and M treats the second as a repeat.
  The conflict appears only when the inputs differ (X4: one device has
  withdrawn, the other refills). That is the kernel of option 3 in the
  problem note, and its limit.
- **The carrier replays what a restored device has not confirmed.** A
  device restored from a backup collects again every frame the carrier
  still holds for its address (the frames wait until every registered
  device has confirmed). With the sibling device offline, A2 re-accepted
  the three tickets and re-converged by accident; X6 therefore lets both
  devices confirm first.
- **A seed is a capability.** Revoking a device at the carrier changes
  nothing for a thief who holds the seed: the addresses are the same keys
  (X9). Revocation needs keys per device (K2).
- **Enrollment by copy is cheap and immediately stale.** A2 sees
  everything at enrollment (X8) and diverges from the first action on
  (X3, X11).

## Simplifications of the target model (for the gate review)

- Stock keys are `active` at allocation; carrier registration and
  confirmation (8475.S1, S2) are immediate.
- The card hand-over state O knows `intent`, `handed`, `taken`,
  `delivered`, `given-up`; the adapter query, demarcation and re-hand-over
  of 8326 are not modelled.
- Continuity: a probe carries blinded counterpart anchors (the frozen
  candidate list of the tuple), a mapping carries one blinded entry; a
  verified mapping unites (6975), a hit only creates the duty (6845.1).
  Pair keys for blinding are derived from the two anchors, not from an ECDH.
- A resumed duty (6845.10) re-produces the mapping instead of resuming
  the stored bytes.
- Departure: no document to the counterpart (8475.S6: nothing is sent);
  tuples of departed relationships take part in no hit, mapping or union.
- Time: acts expire at `expiresAt − consent-reserve` (offered) or
  `expiresAt` (consented); keys age by 8470; no tombstones yet.
- Blocked is all or nothing: when the candidate refuses an operation, the
  device takes back everything the step did so far (state, submissions,
  receipts, journal entries) and does not acknowledge the frame; the
  counterpart repeats it. Key derivations and address registrations at
  the carrier are not taken back, they carry no state.
- Receipts: every submission records the anchor it expects the receipt
  from (the document's recipient); a receipt from anyone else, or for a
  submission the device does not know, has no effect. A journal frame
  expects the person's own self anchor, which under one seed is the same
  on every device; a candidate with keys per device (K2) has to name the
  expected signer differently.
