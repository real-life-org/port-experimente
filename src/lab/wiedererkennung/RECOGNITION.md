# Recognition across tuples, on several devices

Status: a trial of a way to write this down (November 2026), after one
adversarial review round and one security review of R10. The rule is `rule.ts`; every statement below
names what pins it. A statement nothing pins is listed under "Stated, not
pinned". `tests/wiedererkennung-traces.test.ts` fails when this page names
a trace that does not exist, or a trace exists that this page does not
name. That check does not show that a trace carries the sentence it is
named under; only reading does.

## What it is for

Two people who already share a tuple meet again; the ceremony opens a
fresh tuple. Recognition finds out, after the ceremony and without asking
anyone, that the two tuples belong to the same two people, and makes them
one **relationship**. Each person may use several devices that sync with
each other.

A relationship is not yet the contact entry an app shows: a relationship
can stand behind more than one entry until their anchors are comparable
(Trust inventory 2145). Entries are not in this model, and nothing here
promises what a contact list shows.

## What is promised

All three hold once every tuple is open on both sides and everything that
has an effect has been synced, fetched and sent.

P1. The tuples of two people fall into relationships by the pairs **both**
people hold in their relation (R3): a chain of such pairs joins its tuples
into one relationship, and every device ends with at least these joins. A
join beyond them comes from a proven head (R10) and is the same on both
sides. For two tuples there is none: one relationship exactly when both
people admit the pair.
*Pinned by:* for two tuples the full walk,
`tests/wiedererkennung-enumerate.test.ts` (58 865 states reached, the
57 472 with both tuples open on both sides judged, no deviation, in both
ranks); for a chain, `traces/joined-by-a-third.json`; that without R10
the joins are exactly those of the relations, the control `noProvenHead`.

P1a. With one device per person, every schedule ends with one
relationship. This statement does not read the candidates the rule wrote.
*Pinned by:* the full walk with one device each, two tuples (164 judged
states) and three (60 676).

P2. With several devices it can end with more than one relationship,
although every opening device knew the other person: a person opened two
tuples on two devices that had not synced in between
(`traces/two-devices-apart.json`; the 12 096 such states of the walk).
Among the four events of this model nothing joins such relationships
afterwards but another opening on a device that knows both.

P2a. A device that knows an earlier tuple, but not that its sibling united
it with a later one, opens a third; the two sides then list different
tuples of the same relationship. It still ends in one relationship, once
the device has synced (R10).
*Pinned by:* `traces/stale-device.json` and its `noProvenHead` outcome
(two relationships on every device).

P3. The devices of one person never end with different relationships, the
two people never end with different relationships, and no mapping stays
owed.
*Pinned by:* the full walk (its checks at rest).

## The four events

The model and the traces know two people with two devices each and four
events. A trace records for every event whether it had an effect: whether
anything changed in what any device or person holds, a newly kept probe
included.

- **open** a tuple on a device: that person's side of the ceremony. Each
  person opens a tuple once, on one device. A tuple comes about only after
  someone opened the one before it.
- **fetch a probe** on a tuple: possible once the counterpart opened the
  tuple, for a device that holds it. The probe is fetched once.
- **fetch a mapping** over a pair: possible while the counterpart owes its
  mapping over the pair (R8), for a device that holds the tuple the mapping
  travels on (R4, R6). Whether the device can verify it is R6 and R7.
- **sync** from a device to its sibling: the tuples it holds, the pairs it
  united, the probes it keeps and what it knows its person took on. What
  is a fact of the person (candidates, acknowledgements) is known to both
  devices at once.

## The rule

R1. **Candidates.** When a device opens a tuple, the **heads** that device
holds then are the tuple's candidates. They are fixed and are a fact of the
person. In the model both devices of the person know them from the opening
on, without a sync; how they reach a sibling device is not shown.
*Pinned by:* `expect.candidates` of every trace; that it is the heads and
not all tuples, by `traces/stale-device.json` (the other person lists t2
alone).

R2. **Probe.** The opener sends a probe on the tuple that lists its
candidates. One device of the counterpart that holds the tuple fetches it;
its siblings get it by sync.

R3. **Admitted pair.** A person admits a pair of tuples if, among its own
candidates, one was a candidate of the other, either way round. What the
counterpart's probe lists says which tuples to look at (R4), not whether
the pair is admitted.
*Pinned by:* `traces/crossed-opening.json` (admitted only the other way
round).

R4. **Hit.** A device that reads a probe on a tuple it holds, finds listed
another tuple it holds, and admits the pair, has a hit. A hit unites
nothing. The person then takes on its mapping over the pair, once: a later
hit on the same pair adds nothing. The mapping travels on the tuple the
probe came on.
*Pinned by:* `traces/met-again.json` (`after` of the probe steps: still
two relationships, the mapping owed).

R5. **Read again.** A device keeps the probes it fetched and reads them
again whenever what it holds grows or a pair becomes proven (R10).
*Pinned by:* `traces/probe-read-again.json` and its `readOnce` outcome; the
control walk `readOnce` (672 states end wrongly). The model also hands
fetched probes to sibling devices. That is not needed for P1 to P3: the
control walk `noForward` (kept and read again by the fetching device, not
handed on) ends without a deviation.

R6. **Mapping.** A device that holds both tuples of a pair and either
admits the pair or knows that its person took on its own mapping over it
(R10; whether that mapping was acknowledged since does not matter)
verifies the counterpart's mapping over it: it unites the two tuples,
acknowledges, and its person owes its own mapping over the pair, on the
tuple the mapping came on.
*Pinned by:* `traces/met-again.json` (`after` of the mapping steps).

R7. **Not verifiable.** A device that does not hold both tuples cannot
verify a mapping: nothing changes, nothing is acknowledged, and the sender
keeps owing it.
*Pinned by:* `traces/mapping-not-verifiable.json` (the step with
`"effect": false`: the device holds the tuple the mapping travels on, not
the other).

R8. **Owed until acknowledged or settled.** A mapping is taken on by the
person, not by a device. It is owed from then until the counterpart
acknowledged it, or until its two tuples are joined by other pairs each of
which the person verified and had its own mapping acknowledged for,
whenever that path completes.
*Pinned by:* `traces/settled-by-a-path.json` (the mapping over t1+t3
leaves `stillOwed` at the step that completes the path).

R9. **Relationships and head.** The relationships of a device are its
tuples grouped by the pairs it united. The head of a relationship is its
tuple of the highest rank. The rank is the order of the tuples' record
anchors; the record anchor of a tuple is the smaller, by the bytes of the
`did:key` string, of its two pair anchors.
*Pinned by:* the pair `traces/stale-device.json` and
`traces/stale-device-other-rank.json` (same steps, other rank: the other
person lists another tuple, and the pair that joins is another).

R10. **Proven head.** A pair is proven on a device if the device united it
and the person's own mapping over it was acknowledged. A device that reads
a kept probe also has a hit where the listed tuple is not admitted with the
probe's tuple, but is the head of its relationship on this device now and
a proven pair joins it directly (one pair, not a path) to one of the
person's own candidates of the probe's tuple. A listed tuple that is no
head never hits this way. The hit decides: the answer over the pair is
verified because the person took on the pair (R6), also if the head has
changed by then. The other person needs nothing but R3.
*Pinned by:* `traces/stale-device.json` (the hit at the probe step after
the sync; its `noProvenHead` outcome) and
`traces/head-changed-before-the-answer.json` (the answer verified after a
fourth tuple took the head); that the pair must be proven, and that the
acknowledgement is a cause to read again (R5),
`traces/proven-by-the-acknowledgement.json` (no hit at the probe step
while the acknowledgement is missing; the mapping owed at the step that
brings it); that no other trace ends differently without R10,
`tests/wiedererkennung-traces.test.ts`.

It is the head alone, not any tuple of a candidate's relationship: taking
any of them would let the copied key of a replaced tuple bring a new
contact into the relationship.

## Read by a second implementation

A session that was given this page, the format of the traces and their
steps without results wrote the rule in Rust, without the model and the
library. Its output equals the traces at every step (eleven traces, 198
steps; one of the traces was written after its program). It listed where
the page left it to decide; the section on the four events and the words
"own candidates", "took on" and "one pair, not a path" above come from
that list.

## Stated, not pinned

- R6 says a device must **admit** the pair, or know that its person took
  on its own mapping over it at some time, to verify a mapping. In this
  model an honest mapping only ever comes over a pair for which that holds,
  so no schedule reaches a refusal for that reason, and a rule without the
  check passes every trace and walk. Pinning it needs a mapping handed in
  from outside.
- That R10 holds against the copied key of a replaced tuple is argued, not
  modelled: the model has no forged mapping. The argument: such a tuple is
  no head, so a probe naming it has no hit, and no mapping over it is owed.
- R10 answers a probe that names a head where R3 alone would stay silent.
  Whoever knows the anchor of a tuple that is a head today learns from the
  mapping that it belongs to the relationship of the tuple the probe came
  on. A tuple that is no head any more gives no such answer.
- In the model candidates and acknowledgements are facts of the person at
  once; how they reach a sibling device is not shown.
- Three tuples with two devices each: four traces and a random draw
  (`enumerate.ts`, `draw`, 300 schedules in the test), no full walk. Four
  tuples: one trace.
- What a probe and a mapping are on the wire, and that a mapping proves the
  keys of both tuples: the model takes it as given.
- Tuple names are distinct, not empty and without `+`; the model refuses
  others.

## Not in the model

Contact entries and what an app shows; lost devices and restore; time
(retry, how long a mapping is owed, when a replaced tuple stops being
answered); what a union sends afterwards (profile, anchor mapping) and
whether the other side takes it; a tuple opened by one side only; a probe
in several parts fetched by two devices; relationships migrated from
Trust 0.31; the ceremony that opens a tuple.

## Against the library

`lib-run.ts` runs the same traces against the published library (0.20.0,
which implements Trust 0.31: chaining, one device per holder), under both
ceremonies that open a tuple: `shared-connect` 0.1, which the app uses, and
`encounter-scan`. `lib-run.expected.json` pins what it does. A measurement
of where the library stands, not a requirement on it. It compares the
number of contact entries the library shows with the number of
relationships the rule gives, after every step.

The outcome is the same under both ceremonies:

| Trace | Library |
|---|---|
| `met-again` | after every step each person holds as many contacts as the rule gives there (the receiver goes from two to one at the step it is handed the mapping); one contact on both sides at the end |
| `crossed-opening` | issues no mapping: differs from the rule at the two mapping steps and ends with two contacts on both sides; the rule gives one relationship (R3: it does not admit the pair the other way round) |
| `settled-by-a-path` (three tuples, one device each) | ends with one contact on both sides, but not by the rule's steps: it chains, so on t3 it issues a mapping over t1+t3 where the rule asks for t2+t3 (that one is never issued, and the run leaves the other held); from there on it differs at every step and four steps are not followed |
| the eight traces with two devices of one person | not runnable |

For `shared-connect`, each side opens its tuple when it has taken both the
other side's issue and the other side's receipt of its own
(`../tuple-opening/OPENING.md`); which side is first depends on the order
of delivery. The two sides therefore open two tuples in opposite order as
soon as the last receipts of two enactments arrive in the other order than
the ceremonies ran; `crossed-opening` is that schedule and needs no
scanning in both directions.

## Where this came from

The rules are the ones of the Trust 0.32 inventory for section 6a, with the
additions R5 and R10 for several devices (R5: decision of 18 October 2026,
confirmed 24 November; R10: decision of 24 November): R1 2300 and 6816,
R2 6660 and 6730, R3 6802 and 6960, R4 6800, 6804 and 6806, R6 6940 to
6975, R7 6945 and 6845.4, R8 6845, R9 2280.
