# Recognition by one proof per pair of tuples

A model, not the library (`model.ts`, `scenarios.ts`; the table is pinned in
`scenarios.expected.json`, `tests/wiedererkennung-scenarios.test.ts`). It
asks whether two people who meet again can end up as one contact on every
device, with no act of the user, by one rule. Measured 24 November 2026.

## The candidate

Every encounter makes a fresh tuple (Encounter 4.4). Today the Trust layer
finds out afterwards whether the two already know each other, in two
stages: a probe of blinded anchors under a key of the fresh tuple, whose
match is a hint (Trust 6a.2), and then a continuity mapping under the keys
of both relationships, which is the proof (6a.4), with one side choosing
and duties that stand until both sides agree (6a.3).

The candidate has one document and one rule.

- Two people who share a tuple share a secret (in the protocol the ECDH of
  the tuple's two pair keys; here a random key both ends hold).
- A **proof** for a pair of own tuples {x, y} is a tag under the secret of
  x, bound to y and to the direction it travels in, sent on y. Only the
  other end of x can check it. To anyone else it is a random value.
- **Each side sends one proof for every pair of tuples it holds, once.**
  For a fresh tuple: on that tuple, for every tuple it holds then. For a
  pair it learns of later, because a sibling device made the other tuple:
  when it learns of it.
- **A side unites two tuples when it holds the other side's proof for
  them.**

There is no answer to a proof, no number, no chooser and no state per
pair. What a device holds is a set of facts (tuples, proofs received, pairs
it proved, tuples given up); what it shows is computed from the set.

## What the model gives

| Case | Result |
|---|---|
| Two strangers meet | two new contacts; of the 8 tags a sent (it holds 5 other contacts) the stranger can read none; nothing goes out on any other tuple |
| Two who know each other meet again | one contact on both sides after one delivery each way; two documents; no act of a user |
| A's laptop, which knows the relationship, meets B again | one contact on the laptop, on the phone after the sync, and at B; A sends nothing after the sync |
| A's laptop, which has not heard of the relationship yet, meets B again | B holds two contacts until A's devices sync; then A's devices hold one (they compute it from B's proof, which the laptop kept unread) and send one document; B holds one. No second meeting |
| Both have two devices and meet crosswise, all four apart | after A's devices synced A holds two; after B's devices synced B holds one; then A holds one. No second meeting |
| A's two devices, apart, each meet someone else | two contacts; after the sync A sends one document on one of the two tuples; neither stranger can read a tag of it |
| One proof is lost on the way | one-sided until it is sent again: the side that got a proof holds one contact, the other two |
| A copied key that is still in use | the holder of the copy, meeting A as a new contact, is counted as B |
| A copied key that was given up | the holder of the copy stays a contact of its own |
| B lost everything | a new contact on both sides |
| Order of arrival | a device that got the same facts in the opposite order shows the same |
| Cost with 200 contacts | 200 tags on the fresh tuple (4400 bytes at 22 characters), no document on any other tuple |

## What follows

1. **The cases that needed rules of their own are one case.** A second
   device that learns of a tuple late, both sides with two devices at once,
   a proof that arrives before the device can read it: each is "a fact
   came later", and the picture is computed from the facts. The model
   keeps no candidate list, no kept probes to evaluate again, no sequence
   per tuple direction and no duty per pair.
2. **The crossed case heals at the sync of the own devices, not at the
   next encounter.** Whichever side syncs later sends its proof later, and
   the other side then holds both tuples.
3. **Two devices of one person cannot contradict each other.** A proof has
   no number. Two siblings that prove the same pair send the same tag; a
   receiver that holds it twice holds one fact.
4. **A stranger gets values it cannot read, in a count filled up to a
   step.** A late proof for a pair of tuples with two different people
   goes to one of them, who cannot read it either; that person sees that
   a document came.
5. **A key in use, in foreign hands, is the person.** That is so today
   (Trust 6970, rationale). What the model adds: a key that was given up
   proves nothing afterwards, and what it proved before stands.

## What the model does not show

- The cryptography. A tag here is an HMAC under a shared random key; in
  the protocol the secret is derived from two pair keys, and which keys of
  a relationship still prove (the active head only, or every tuple not
  given up) is a question for the design, with the window a copied older
  key has (Trust 6750, 6960).
- Delivery. A lost proof is sent again by a call of the scenario; the
  duty, its repetition and its end belong to the Delivery contract.
- What uniting does to the state of a relationship (settings, provenance,
  the anchor mapping, the state of introductions). The inventory of Trust
  6a for 0.32 has rules for a union as a set operation; the model unites
  names only.
- Giving up a key is one fact here, set by a call on each device. Two
  devices that gave up the same key apart, holding different proofs then,
  would draw the line differently; in the design it is one entry of the
  person's own log.
- Sizes on the wire, the size of the filling step, the timing of a late
  proof as a signal to the one who gets it, and a person with thousands of
  tuples.
- A third party that relays documents between two ends in real time.
- Whether a person may appear as two to the same counterpart on purpose:
  under this rule it cannot.
