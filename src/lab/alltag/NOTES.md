# Everyday multi-device experiments

Experiments on a person with two devices, run against the published
library (`rltp-lib`, an alias for `@real-life/trust-protocol` 0.19.0), not
against a model. The older multi-device bench (`src/lab/mehrgeraet`,
`src/candidates/mehrgeraet-*`) models the Trust layer by hand on library
0.3.2 and stays as it is; it covers introductions with several devices.

Measurements and prototypes belong here. The library repository keeps one
test of this strand, the baseline of everyday scenarios
(`lib/test/multi-device-baseline.test.mjs`), which every build step there
has to move.

## Two producers (`two-producers.ts`)

What a counterpart answers when the phone and the laptop each produce a
document for the same cause. Measured 2026-11-22, library 0.19.0; the full
table is `two-producers.expected.json`.

| Document | The second device's document at the counterpart |
|---|---|
| `delivery-ack` | accepted |
| `profile`, same body and revision | accepted |
| `profile`, another body under the same revision | refused, RLTP-TRU-6270 |
| `anchor-mapping` | refused, RLTP-TRU-6270, also when the laptop only holds the state of the phone's act |
| `star`, `group-star` | refused, RLTP-TRU-5150 |
| `membership-prelude-reply` | refused, RLTP-MT-3965 |
| `membership-accept` | refused, RLTP-MT-3270 |
| `x-access-page` | refused |
| `membership-invite` | accepted as a second invitation: the invitee holds two |
| `x-membership-welcome` | accepted, once per answered invitation |
| `encounter-credential-delivery` | accepted |
| `continuity-probe` | one accepted, one refused (RLTP-TRU-6700) |

Only acknowledgements and an identical profile tolerate two producers
without a rule. The second invitation is the one case where the second
document silently has a second effect.

Not measured: whether a real mediator hands a document to every device of
an address; whether two accepted credential deliveries make two
relationships.
