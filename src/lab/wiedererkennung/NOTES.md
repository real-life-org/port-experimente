# Recognition by one proof per pair of tuples

A model, not the library (`model.ts`, `scenarios.ts`; the table is pinned in
`scenarios.expected.json`, `tests/wiedererkennung-scenarios.test.ts`). It
asks whether two people who meet again can end up as one contact on every
device, with no act of the user, by one rule. Measured 24 November 2026,
after a design review of the first form of the model the same day.

## The candidate

Every encounter makes a fresh tuple (Encounter 4.4). Today the Trust layer
finds out afterwards whether the two already know each other, in two
stages: a probe of blinded anchors under a key of the fresh tuple, whose
match is a hint (Trust 6a.2), and then a continuity mapping under the keys
of both relationships, which is the proof (6a.4), with one side choosing
and duties that stand until both sides agree (6a.3).

The candidate has one document and three sentences.

1. **Each side proves every pair of its tuples once.** The proof for the
   pair {x, y} is a value under the secrets of both tuples, bound to the end
   the prover holds in each, and it travels on y. Only someone who holds the
   other end of x and the other end of y can check it; to anyone else it is
   a random value. For a fresh tuple the proofs go out on that tuple, for
   every tuple the side holds then. For a pair it learns of later, because
   a sibling device made the other tuple: when it learns of it.
2. **A side that holds the other side's proof for a pair unites the two
   tuples**, if on its own side the tuple the proof stands under is the head
   of its relationship (or the two are united already). The sender proves
   with all it holds; the receiver decides by what it knows. The union is a
   fact: the person's devices share it, and nothing takes it back.
3. **A proof is owed until the carrier says the other side has it.** Any
   device of the person can send it: it is the same document, byte for
   byte, the filling included.

There is no answer to a proof, no number and no chooser.

## What the model gives

| Case | Result |
|---|---|
| Two strangers meet | two new contacts; of the 256 values a sent (it holds 5 other contacts) the stranger can read none; nothing goes out on any other tuple |
| Two who know each other meet again | one contact on both sides after one delivery each way; two documents; no act of a user |
| A's laptop, which knows the relationship, meets B again | one contact on the laptop, on the phone after the sync, and at B; A sends nothing after the sync |
| A's laptop, which has not heard of the relationship yet, meets B again | B holds two contacts until A's devices sync; then A's devices hold one (from B's proof, which the laptop kept unread) and send one document; B holds one. No second meeting |
| Both have two devices and meet crosswise, all four apart | after A's devices synced A holds two; after B's devices synced B holds one; then A holds one. No second meeting |
| A's two devices, apart, each meet someone else | two contacts; after the sync A sends one document of 256 values on one of the two tuples; neither stranger can read a value of it |
| One proof is lost on the way | one-sided (the side that got a proof holds one contact, the other two) until a sibling of the sender sends the same document again |
| A device fetches the other side's proof and is lost before it shares it | one-sided, and neither side sends anything more: A's remaining device holds two contacts, B one. The next encounter joins them |
| A contact hands in a value on a tuple that is not its own | no effect: it cannot make the value without the secret of that tuple |
| A's own devices scan each other | the contacts they share stay apart: a device cannot prove as the other end of a tuple it holds one end of |
| A copied key of the head of a relationship | the holder of the copy, meeting A as a new contact, is counted as B |
| A copied key of an older tuple of a relationship | the holder of the copy stays a contact of its own |
| B lost everything | a new contact on both sides |
| The same proof sent twice | the receiver holds one document and 256 different values: a repeat shows nothing the first sending did not |
| Random schedules | three people with 3, 3 and 2 devices; encounters, deliveries, syncs of single pairs of devices and sendings in random order, nothing lost; then all delivered and synced. 60 runs: every device shows one contact per person it shares a tuple with, and no contact holds tuples of two people |
| Cost with 300 contacts | 512 values on the fresh tuple, no document on any other tuple |

## What follows

1. **The cases that needed rules of their own are one case.** A second
   device that learns of a tuple late, both sides with two devices at once,
   a proof that arrives before the device can read it: each is "a fact
   came later". The model keeps no candidate list frozen at the opening, no
   sequence per tuple direction and no chooser.
2. **The crossed case heals at the sync of the own devices, not at the
   next encounter.** Whichever side syncs later sends its proof later, and
   the other side then holds both tuples.
3. **Two devices of one person cannot contradict each other.** A proof has
   no number, and two siblings that prove the same pair send the same
   bytes.
4. **Who proves and who decides are two things.** The sender proves with
   every tuple it holds; the receiver accepts a proof only under a tuple
   that is the head of its relationship on the receiver's own side. So a
   copy of an older key attaches nothing where the receiver knows the
   union, and a side that fell behind (a proof fetched by a device that was
   lost) is caught up by the next encounter, where the other side proves
   with all it holds.
5. **What is left of a duty per pair is "sent, not yet acknowledged".** It
   needs no hit and no time limit, and any device of the person can
   discharge it.

## What the review of the first form changed

The first form bound the value to the name of the tuple it travels on, not
to that tuple's secret, and not to the prover's end of x. A contact could
hand in a value on a tuple it has no part in, and two own devices that
scanned each other merged every contact they share. Both are scenarios now.
The first form let every tuple prove that was not explicitly given up, with
"given up" a fact each device drew its own line for; two devices then
showed different pictures from the same facts. The union is a fact now and
the head rule decides what proves. The filling was drawn fresh, so two
sendings gave the exact count; it is derived now and the step is 256.

## What the model does not show

- The cryptography. A value here is an HMAC under two shared random keys;
  in the protocol the secrets are derived from pair keys, and the binding
  is to pair anchors.
- A device that has not heard of a union yet still takes a proof under the
  older tuple: the window of a copied older key is the time until every
  device of the receiving person knows the union. Not a scenario.
- A change of a relationship's key (a device removed, Model 4). The model
  has no "this tuple proves under a new key now", and nothing that tells
  the other side.
- The head. Here it is the largest name of the group; what sending on the
  head and receiving on the other tuples of a relationship means while the
  two sides hold different unions is not modelled (Trust 2280, 6190–6245).
- What uniting does to the state of a relationship (settings, provenance,
  the anchor mapping, the state of introductions), and what in the 0.32
  inventory hangs on "the other side booked the union": the carrier's word
  here means "a device of the other side fetched the document", not "the
  other side united".
- Keeping. A device keeps every document it received, readable or not,
  for good, and reads it again when it holds more. A bound per tuple is
  not modelled; neither is a new device that needs what was kept.
- A proof that arrives on an introduced tuple before the receiver opened
  it (inventory 6815).
- Sizes on the wire, a person with thousands of tuples, and what the
  carrier sees.
- The late proof as a signal: it goes to one of the two people of the pair,
  comes only when there is something to prove, and its time shows that the
  sender's devices synced.
- A third party that relays the ceremony between two ends in real time.
