# "Met": the channel of a shared-connect contact and what it allows

Status: a contract for one derivation, written from what the library does
(rltp-lib 0.20.0) and checked against it (`tests/met.test.ts`). The rule is
`rule.ts`. The ceremony is
[`shared-connect` 0.1](https://github.com/real-life-org/trust-protocol/blob/main/interop/ceremonies/shared-connect.ceremony.json);
when a side opens its tuple is `../tuple-opening/OPENING.md`.

## What it is for

A shared-connect link can be shown as a code to someone in the same room,
or sent in a message to anyone. The protocol treats the two differently:
trust is given only to someone met. This page says how each side tells.

## What is promised

M-P1. Where a side states `sent` or `link` for an enactment, that
enactment gives neither side a reason to trust: toward a contact that came
about only by such enactments the trust act is refused. The promise is
about the channels the devices recorded. A picture of a code that was
passed on and then read by a camera is recorded as `displayed` and `scan`
and is not told apart from a meeting.

M-P2. Meeting later upgrades the contact: after a second enactment in
person and the union of the two tuples (`../wiedererkennung/RECOGNITION.md`)
it is one contact that met.

M-P3. Two honest parties of this protocol derive the same for one
enactment.

What either side states is its own report. "Met" is not proof that the two
were in one place.

## The rule

M1. **Channel.** Each side states in its credential how the link reached
it, as one of four values: `displayed` (it showed the code in person),
`scan` (its camera read a code), `sent` (it sent the link in a message),
`link` (it opened a link it was sent). The inviter states `displayed` or
`sent`, the responder `scan` or `link`. The value is the observation of
the device, fixed when the side shows or reads the link.

M2. **One enactment met**, for a side, when its own channel is `scan` or
`displayed` and the counterpart's credential does not state `link` or
`sent`. The counterpart's statement can take "met" away and cannot give it:
a counterpart that states nothing (a party of another app) leaves the own
observation standing.
*Pinned by:* the table test in `tests/met.test.ts` (six of the twenty
combinations met); the four enactments of two honest parties against the
library.

M3. **A contact met** when any of its tuples came from an encounter
(`encounter-scan`), from an introduction, or from an enactment that met
(M2). A tuple that was replaced still counts.
*Pinned by:* the test "a link and later a scan" against the library.

M4. **Trust.** The trust act (the anchor mapping switched on) toward a
contact that did not meet is refused with `not-met`. Messages, the profile
and group membership do not depend on it.
*Pinned by:* the same tests (`trust` is `taken` exactly where `met`).

M5. **What the contact shows.** The contact shows the channels of its
oldest enactment, and "met" for the contact as a whole (M3). After an
upgrade it therefore shows `sent`/`link` and "met" together.

## Against the library

`lib-run.ts` runs enactments between two holders and reads each side's
contact and the answer to the trust act.

| Enactment | Both sides |
|---|---|
| `displayed` read by `scan` | met, trust taken |
| `displayed` read by `link` (the link behind the code was opened elsewhere) | not met, `not-met` |
| `sent` read by `scan` | not met, `not-met` |
| `sent` read by `link` | not met, `not-met` |
| `sent`/`link`, later `displayed`/`scan`, before recognition is delivered | two contacts: the first not met, the second met |
| the same, after recognition | one contact, met, trust taken |

## Stated, not pinned

- M2 with a counterpart that states no channel: the library's own parties
  always state one.
- M3 for a tuple from an introduction or from `encounter-scan`.
- The upgrade in M-P2 needs the union. Where the two tuples open in
  opposite order on the two sides, the library does not unite them today
  (the trace `crossed-opening` on the recognition page): the contact from
  the link then stays not met beside the one that met.
- A side can state a channel it did not observe, and a camera can read a
  code that was passed on as a picture. Nothing here detects either.

## Not here

The three classes an app shows (`met`, `introduced`, `link`) and their
names; vouching and its provenance (Access); what a group allows a contact
that did not meet; several devices.

## Where this came from

The requirements for Encounter of 31 October 2026 (E1 to E4): classes from
the two channels, trust and vouching only on `met` or `introduced`, a
`link` contact keeps messages, profile and membership. E1 reads as M2 since
25 November 2026: the own channel in person and no objection, so that a
counterpart of another app, which states no channel, can be met.
