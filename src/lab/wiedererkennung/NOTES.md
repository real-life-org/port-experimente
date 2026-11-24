# Recognition by one proof per pair of tuples

A model, not the library (`model.ts`, `scenarios.ts`; the table is pinned in
`scenarios.expected.json`, `tests/wiedererkennung-scenarios.test.ts`). It
asks whether two people who meet again can end up as one contact on every
device, with no further act of the user, by one rule. Measured 24 November
2026, after two design reviews the same day.

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
   a sibling device made the other tuple: when it learns of it. Every tuple
   gets a second document some time after its first, whether or not there
   is anything more to prove, so that its coming says nothing.
2. **A side that holds the other side's proof for a pair unites the two
   tuples**, if on its own side each of the two is the head of its
   relationship (or the two are united already), whichever of them the
   proof stands under and whichever it came on. The sender proves with all
   it holds; the receiver decides by what it knows. The union is a fact:
   the person's devices share it, and nothing takes it back.
3. **A proof is owed until the carrier says the other side has it.** Any
   device of the person can send it: it is the same document, byte for
   byte, the filling included.

There is no answer to a proof, no number and no chooser.

## What the model gives

| Case | Result |
|---|---|
| Two strangers meet | two new contacts; of the 256 values a sent (it holds 5 other contacts) the stranger can read none; nothing goes out on any other tuple |
| Two who know each other meet again | one contact on both sides after one delivery each way; two documents; no act of a user |
| A's laptop, which knows the relationship, meets B again | one contact on the laptop, on the phone after the sync, and at B; after the sync A sends the fresh tuple's second document |
| A's laptop, which has not heard of the relationship yet, meets B again | B holds two contacts until A's devices sync; then A's devices hold one (from B's proof, which the laptop kept unread) and send two documents, the second of each tuple, one of them with the proof; B holds one. No second meeting |
| Both have two devices and meet crosswise, all four apart | after A's devices synced A holds two; after B's devices synced B holds one; then A holds one. No second meeting |
| A's two devices, apart, each meet someone else | two contacts; after the sync A sends the second document on each of the two tuples, 256 values each, one of them with the proof for the pair; neither stranger can read a value |
| The second document of every tuple | a stranger holds two documents of 256 values from a person with one device, and two of 256 from a person whose two devices each met someone apart; it can read none of them |
| One proof is lost on the way | one-sided (the side that got a proof holds one contact, the other two) until a sibling of the sender sends the same document again |
| A device fetches the other side's proof and is lost before it shares it | one-sided, also after both sides sent all they owe: A's remaining device holds two contacts, B one. The next encounter joins them |
| A contact hands in a value on a tuple that is not its own | no effect: it cannot make the value without the secret of that tuple |
| A's own devices scan each other | the contacts they share stay apart: a device cannot prove as the other end of a tuple it holds one end of |
| A copied key of the head of a relationship | the holder of the copy, meeting A as a new contact, is counted as B |
| A copied key of an older tuple, the proof under it | the holder of the copy stays a contact of its own |
| A copied key of an older tuple, the proof the other way round (under the fresh tuple, on the old one) | the same: a contact of its own |
| Three tuples, proofs for two pairs under the same tuple | A holds one or two contacts for B, depending on which proof it read first, until B's devices synced and proved the last pair; then one |
| Two siblings make the second document of one tuple apart, one knowing a tuple more | the receiver holds two second documents that share 255 of 256 values and none with the first; it can read none |
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
   every tuple it holds; the receiver unites two tuples only if both are
   heads of their relationships on its own side. So a copy of an older key
   attaches nothing where the receiver knows the union, whichever way round
   the proof is made, and a side that fell behind (a proof fetched by a
   device that was lost) is caught up by the next encounter, where the
   other side proves with all it holds.
5. **Which pairs get united depends on the order of reading; which tuples
   end up together does not, once a proof for every pair has come.** Two
   parts of one person always have two heads with a proof between them.
   Until then two devices with the same documents can show different
   pictures, and they agree once they share what they united.
6. **What is left of a duty per pair is "sent, not yet acknowledged".** It
   needs no hit and no time limit, and any device of the person can
   discharge it.

## What the reviews changed

The second review (the model as of `4d18d89`): the head rule looked only at
the tuple a proof stands under, not at the one it comes on, so the holder
of a copied older key was counted as the person when it proved the other
way round (20 of 20 runs). The rule takes two heads now. Catching up proved
only pairs of heads, so a pair could go unproved for good; it proves every
pair now. The filling depended on what the sender knew, so two siblings'
documents gave away what they share; it depends on the tuple and the
document's place now.

The first review:


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
  older tuple, and what it united then spreads to its siblings as a fact:
  the window of a copied older key is the time until every device of the
  receiving person knows the union. Not a scenario. Neither is a device
  restored from an old image.
- Two second documents of one tuple that differ in one value tell the
  receiver that one sender knew of something the other did not.
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
- When the second document goes out. Here it goes with the first catching
  up after the tuple was made; the delay, and whether its time still shows
  a sync, are for the design. A pair learned of after the second document
  takes a third, and that one comes only when there is something to prove.
- A third party that relays the ceremony between two ends in real time.
