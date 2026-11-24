# Recognition with several devices: the proof in the probe

A model, not the library (`model.ts`, `scenarios.ts`; the table is pinned in
`scenarios.expected.json`, `tests/wiedererkennung-scenarios.test.ts`). It
asks whether two people who meet again end up as one contact on every
device, with no act of the user, when each of them has several devices.
Measured 24 November 2026.

## Outcome

Not taken up for Trust 0.32. A fourth review ran a schedule this table does
not have: two people, two tuples, two devices each; A's first device opens
x then y, B's first device opens y then x; the two probes that carry the
proof are fetched by the two second devices, which do not hold the other
tuple yet. After every sync and delivery all four devices hold two
contacts and nothing is owed: a probe that was fetched and could not be
read triggers nothing later, and change 2 does not apply, because on each
side the second opening knew the first tuple. `meet` here opens both ends
in one call, so the scenarios cannot draw that order. Closing it takes a
further rule, and the attempt was bounded to these two changes. What
stands: the proof in the probe simplifies the proving for one device.

## Every schedule, for the inventory as it is (`enumerate.ts`)

What Trust 0.32 takes instead: the inventory's recognition unchanged, on
several devices, with one addition decided on 18 October: the probe a
device fetched is a fact its siblings get, and a device reads the probes it
holds again when its facts grow. `enumerate.ts` does not sample. It walks
every schedule of two people with two devices each and two tuples: the two
openings of an encounter are separate steps on a device of each person's
choice, any device that holds a tuple may fetch what waits on it, own
devices sync one way at a time in any order. Every reachable state with
all tuples opened is run to rest and checked
(`tests/wiedererkennung-enumerate.test.ts`).

| | States | At rest |
|---|---|---|
| The probe is read again from the log | 42 481 | every state ends as the candidate relations of the two sides say: one contact on all four devices where both relations hold the pair (28 992), two where they do not (12 096). Two devices of one person never differ, no mapping stays owed |
| The probe is read once, by the device that fetched it | 26 356 | 162 states end with two contacts on all four devices although both relations hold the pair: the crossed case of the fourth review |

Two tuples end as one contact exactly if **both** sides hold the pair in
their relation: on each side, the device that opened the later tuple knew
the earlier one, or the two sides opened them in opposite order. Where one
side opened its two tuples on two devices that had not synced, it stays
two contacts, whatever the other side knew.

Not in this walk: lost devices, time, deleted keys, more than one probe
per tuple, the outputs a union triggers, and the carrier's word for an
acknowledgement reaching a sibling.

## What is modelled

The 0.32 inventory of Trust 6a, written for one device per holder: the
candidates of a fresh tuple are the heads the opening device holds then
(2300, 6816); a pair is admitted against the receiver's own record, both
ways round (6802, 6960); a union is a set (6975); a side that united a
pair owes its own proof for it until the other side has booked it (table
6845, acknowledgement at the effect). With two changes:

1. **The probe carries the proof.** Where the probe names a blinded anchor
   per candidate (6730), it carries a value under the secrets of both
   tuples, bound to the end the prover holds in each. A side that can make
   a value itself, for a pair it admits, unites at once. The hit, and the
   blinded naming in the mapping (`entry`, F-2), are gone.
2. **Tuples that two own devices opened apart are candidates for each
   other**, if both are heads when a device of the person first holds
   both. The device writes that down, and the person owes its proof for
   the pair from then on.

An earlier form of this model (up to `9df7be6`) had no answer at all: one
document, kept by the receiver until it could read it, acknowledged when
kept. Three reviews found its problems all in that: a bound on what is
kept can lock out the one proof that is needed, "kept" says nothing about
"booked", and a repair rule did not repair. This form keeps the
inventory's answer instead and keeps nothing unread.

## What the model gives

| Case | Result |
|---|---|
| Two strangers meet | two new contacts; one probe each way, 256 values, of which the stranger can read none; nothing on any other tuple, nothing afterwards |
| Two who know each other meet again | one contact on both sides as soon as the two probes arrived; then each side's own proof for the pair, four documents in all; nothing owed afterwards |
| A's laptop, which knows the relationship, meets B again | one contact everywhere, nothing more to send after A's devices synced |
| A's laptop, which has not heard of the relationship yet, meets B again | B holds two contacts until A's devices sync; then three documents and one contact everywhere. No second meeting |
| Both have two devices and meet crosswise, all four apart | after A's devices synced and sent, A still holds two (B's devices each hold one tuple and cannot read A's proof); after B's devices synced too, one contact on all four. No second meeting |
| A's two devices, apart, each meet someone else | two contacts; after the sync one of the two strangers gets one document with one value per sending of A, cannot read it and never acknowledges it |
| A proof is lost on the way | a sibling of the sender sends the same document; one contact on both sides, nothing owed |
| A device fetches, unites and is lost before it shares it | one-sided for good: A's remaining device holds two contacts, B one; nothing is owed; the next encounter joins only one of A's two parts (B proves with its one head) |
| A device fetches a proof it cannot read (it holds one of the two tuples) | no acknowledgement; the sender tries again; one contact everywhere after the receiver's devices synced |
| A contact hands in a value on a tuple that is not its own | no effect |
| A's own devices scan each other | the contacts they share stay apart |
| A copied key of the head of a relationship | the holder of the copy, meeting A as a new contact, is counted as B |
| A copied key of an older tuple, the value on the fresh tuple or on the old one | a contact of its own |
| A copied key of a tuple that is no head any more, met by a device that never heard of the tuple | a contact of its own, also after A's devices synced |
| Three tuples, the third made by a device that knew only the first | one contact at A as soon as the probes arrived |
| B lost everything | a new contact |
| A is restored from an image older than its second tuple with B; B's head is the tuple A kept | one contact on both sides |
| The same; B's head is the tuple A lost | a new contact on both sides, also after one more encounter |
| Random schedules | three people with 3, 3 and 2 devices; encounters, deliveries, syncs of single pairs of devices and sendings in random order, nothing lost; then all sent, delivered and synced. 60 runs: every device shows one contact per person, no contact holds tuples of two people, and no proof is still owed between two tuples of the same two people |
| Cost with 300 contacts | 512 values on the fresh tuple, no document on any other tuple |

## What follows

1. **With the two changes the inventory's rules carry several devices.**
   The crossed case and the late-sync case end in one contact without a
   further encounter. No rule is added for them beyond change 2.
2. **Nothing unread needs to be kept.** A device that fetches a proof it
   cannot read does not acknowledge it, and the proof stays owed. A device
   lacks a tuple only if its person's devices opened the two apart, and
   then the person owes a proof for the pair itself.
3. **Two devices of one person cannot contradict each other in a proof.**
   The own proof for a pair is the same bytes on every device; it has no
   number.
4. **A mapping for a pair the receiver does not admit, between tuples it
   holds as one relationship already, is acknowledged** (Trust 6975.3).
   Without that, duties stayed open for good in the random runs.
5. **The price of change 2 is a document to a stranger.** Two own devices
   that meet two different people apart owe a proof for that pair. It goes
   to one of the two, who cannot read it and never acknowledges it. It
   tells them that a document came late; the model sends it again on every
   sending, and has no end for it.
6. **What a lost device takes with it stays lost** (the inventory's D-5).
   The next encounter heals half of it, because a probe names heads only
   (6750). A probe that names every tuple whose key is held would heal it
   (measured in the earlier form); that is a decision.

## What the model does not show

- The cryptography. A value is an HMAC under two shared random keys.
- Time. A duty that is never acknowledged has no end here (6845.8,
  6845.11), and a probe has no second, later sending.
- Deleted keys (6245), the head while two sides hold different unions
  (2280, 6190–6240), what a union does to the state of a relationship
  (6980, 6985, table 6987), the hold before an introduced tuple opens
  (table 6815), the migration from 0.31.
- A device that learns of a tuple and of the union that replaced it in two
  steps: it writes "opened apart, both heads" down in between, and the
  window of a copied older key is that time.
- That a sync brings every fact a device holds. A partial sync of facts is
  not modelled.
- Sizes on the wire and the chunks of a probe (6790).
- The carrier as an attacker, and a third party that relays the ceremony.
