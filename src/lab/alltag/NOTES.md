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

## Messages through a layer above the library (`layer.ts`)

The first vertical cut of the build the design review proposed for device
sync (in the private design journal: review 1 of the sync draft): a device
passes what it received on to the person's other devices as an input, and
what the human did as a named entry; each device runs the library's own
reception and computes its views itself. Built as a layer above the
published library, so nothing moves into the library before the cut holds.

Three kinds of entry carry the whole message case: `received` (the
envelope a device accepted), `taken` (the application took inbox entries
over), `sent` (a message the human wrote). Measured 2026-11-23, library
0.19.0, second device 13 s late:

| Scenario | Result |
|---|---|
| both devices get the message from the carrier, the phone reads it | one conversation line on each device, both inboxes empty, the friend refuses nothing, status `delivered` |
| only the phone gets it; the laptop learns it from the phone | same |
| the laptop learns "read" before the carrier brings it the message | same on the laptop |
| the laptop was off for 30 days, carrier copy and entries in either order | same on the laptop |
| both devices read the same message apart | one line on each |
| the human writes from both devices apart | both devices show both lines, the friend gets both |
| a sync breaks off while taking a passed-on document | the entry stays open, the next sync brings the message |
| the friend's acknowledgements reach both devices | **open**: each is accepted by the device that issued the document and refused by the sister (pinned as measured) |

What the layer had to keep that the library does not: the set of inbox
entries the person took over on any device. The library's take is local and
immediate; a message that reaches a device after the person read it
elsewhere needs a mark that waits for it.

Not covered: the personal log here is the smallest thing that orders
entries, in memory and unsealed; it stands in for the exchange and is no
proposal for it. Nothing here concerns who may write an entry.
