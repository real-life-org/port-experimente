# Recognition across tuples, on several devices

Status: a trial of a way to write this down (November 2026). The rule is
`rule.ts`; every statement below names what pins it. A statement nothing
pins is listed under "Stated, not pinned". `tests/wiedererkennung-traces.test.ts`
fails when this page names a trace that does not exist, or a trace exists
that this page does not name.

## What it is for

Two people who already share a tuple meet again; the ceremony opens a
fresh tuple. Recognition finds out, after the ceremony and without asking
anyone, that the two tuples belong to the same two people, and makes them
one contact. Each person may use several devices that sync with each
other.

## What is promised

P1. The tuples of two people fall into contacts by the pairs **both**
people hold in their relation (R3): a chain of such pairs joins its tuples
into one contact. Every schedule ends with exactly these contacts on every
device, once everything is synced, fetched and sent. For two tuples that
is: one contact exactly when both people admit the pair.
*Pinned by:* for two tuples the full walk,
`tests/wiedererkennung-enumerate.test.ts` (42 481 states, no deviation);
for a chain, `traces/joined-by-a-third.json` (neither person admits
t1+t2, both admit each with t3, one contact of all three). Three tuples in
general: see "Stated, not pinned".

P2. Where one person opened its two tuples on two devices that had not
synced in between, the pair is in neither that person's relation; it stays
two contacts on both sides. Nothing heals it but another encounter.
*Pinned by:* `traces/two-devices-apart.json`; the 12 096 states of the
full walk that end with two contacts on all four devices.

P3. The devices of one person never end with different contacts, and no
mapping stays owed.
*Pinned by:* the full walk (its three checks at rest).

## The rule

R1. **Candidates.** When a device opens a tuple, the heads that device
holds then are the tuple's candidates. They are fixed and are a fact of the
person; sibling devices get them by sync and never change them.
*Pinned by:* `expect.candidates` of every trace.

R2. **Probe.** The opener sends a probe on the tuple that lists its
candidates. Any device of the counterpart that holds the tuple may fetch it.

R3. **Admitted pair.** A person admits a pair of tuples if one was a
candidate of the other, either way round.
*Pinned by:* `traces/crossed-opening.json` (the pair is admitted only the
other way round).

R4. **Hit.** A device that reads a probe on a tuple it holds, finds listed
another tuple it holds, and admits the pair, has a hit. A hit unites
nothing. The person then owes its mapping over the pair.
*Pinned by:* `traces/met-again.json`.

R5. **Read again.** A fetched probe is kept and handed to sibling devices.
Every device reads the probes it holds again whenever what it holds grows.
*Pinned by:* `traces/probe-read-again.json` and its `readOnce` outcome; the
control walk (672 of 28 404 states end wrongly without this rule).

R6. **Mapping.** A device that holds both tuples of a pair and admits the
pair verifies the counterpart's mapping over it: it unites the two tuples,
acknowledges, and its person owes its own mapping over the pair.
*Pinned by:* `traces/met-again.json`.

R7. **Not verifiable.** A device that does not hold both tuples, or does
not admit the pair, cannot verify a mapping: nothing changes, nothing is
acknowledged, and the sender keeps owing it.
*Pinned by:* `traces/mapping-not-verifiable.json` (the step with
`"effect": false`).

R8. **Owed until acknowledged.** A mapping is owed by the person, not by a
device; an acknowledgement any device of the person learns of ends it for
all of them.
*Pinned by:* `expect.stillOwed` of every trace; P3.

R9. **Contacts and head.** The contacts of a device are its tuples grouped
by the pairs it united. The head of a contact is its tuple of the highest
rank.

## Stated, not pinned

- The rank of a tuple is the order of its record anchor, which is not the
  order the tuples came about. The walk and the traces use one order for
  both.
- Three tuples: one trace (P1) and a random draw (`enumerate.ts`, `draw`),
  not a full walk.
- What a probe and a mapping are on the wire, and that a mapping proves the
  keys of both tuples: the model takes it as given.
- R2 and R9 are used by every trace and singled out by none.

## Not in the model

Lost devices and restore; time (retry, how long a mapping is owed, when a
replaced tuple stops being answered); what a union sends afterwards
(profile, anchor mapping); a tuple opened by one side only; more than one
probe per tuple; the ceremony that opens a tuple.

## Against the library

`lib-run.ts` runs the same traces against the published library (0.19.0,
which implements Trust 0.31: chaining, one device per holder) and
`lib-run.expected.json` pins what it does. A measurement of where the
library stands, not a requirement on it.

| Trace | Library |
|---|---|
| `met-again` | after every step each person holds as many contacts as the rule gives there (the receiver goes from two to one at the step it is handed the mapping); one contact on both sides at the end |
| `crossed-opening` | issues no mapping: differs from the rule at the two mapping steps and ends with two contacts on both sides; the rule gives one (R3: it does not admit the pair the other way round) |
| `two-devices-apart`, `probe-read-again`, `mapping-not-verifiable`, `joined-by-a-third` | not runnable: a person acts on two devices |

## Where this came from

The rules are the ones of the Trust 0.32 inventory for section 6a, with the
addition R5 for several devices (decision of 18 October 2026, confirmed 24
November): R1 2300 and 6816, R2 6660 and 6730, R3 6802 and 6960, R4 6800,
6804 and 6806, R6 6940 to 6975, R7 6945 and 6845.4, R8 6845, R9 2280.
