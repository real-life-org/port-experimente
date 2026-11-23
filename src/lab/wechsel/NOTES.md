# Changing a relationship's keys with hidden devices

A model, not the library (`model.ts`): an identifier with a log in the
shape of did:vh, two persons, several devices per person that the
counterpart does not see, and a carrier with one mailbox per address that
deletes what was fetched. Signatures are real; encryption is modelled as
possession of the receive key. The rules under discussion are switches, so
the table shows what each one buys. Measured 2026-11-24; the full table is
`scenarios.expected.json`.

The base rules: between two peers the first continuation a party accepted
stands, a second one is refused and kept as evidence; every document
carries the head of the sender's log and the head it holds of the
receiver's log; a device keeps the old receive key and address until the
counterpart acknowledged the change.

## Findings

1. **Two own devices that change apart fork without any attacker.** The
   counterpart refuses the second continuation, shows a warning, and the
   losing device's first message is lost. The loser learns it from the
   refusal and is heard again once it took the sibling's state. If the
   next state is derived from a secret the devices share instead of drawn,
   both write the same entry: no refusal, no warning, nothing lost.
2. **A lost device that holds an update key takes the relationship over.**
   It changes first; the counterpart then listens to it, refuses the
   owner, and sends its next message to the lost device. The owner learns
   of it only if the refusal is answered to the address in the refused
   entry; answered to the address the counterpart holds, the owner hears
   nothing. A lost device without an update key cannot change anything.
3. **An acknowledgement by one device of the counterpart is not the
   counterpart.** After B's phone acknowledged the change, B's laptop
   still holds the old state: its message goes to an address A no longer
   fetches, and it refuses A's documents. Three ways out, measured:
   B's devices share what they hold of A's log (everything works); or A
   keeps the old receive path open for a while after the acknowledgement
   (the laptop is heard, asks for the log, misses one document and reads
   the next); or no log heads and the entry attached for ever (works, at
   the price of never closing the old path).
4. **What the counterpart writes before it knows goes to the old key and
   address.** Whoever fetches first reads it: the owner or the lost
   device. If the owner drops the old path at once, only the lost device
   can. After the counterpart processed the change, the lost device reads
   nothing more.
5. **A sibling that was not told is told by the counterpart.** Its answer
   under the old key is refused; the reply to the old address tells it
   that its state is stale and that the counterpart holds an entry it
   does not know.

6. **A sibling that comes back does not turn a change back.** Syncing
   only ever lets a device's own log grow; a shorter log changes nothing.
   Giving up one's own continuation after a fork is a step of its own.

## The same question in a group (`group.ts`)

Candidate: in each group a person has one key that all its devices hold;
removing a device is a change of that key, written into the group's log.
Person A with phone, laptop and a lost tablet, and a member B. Measured
2026-11-24; the table is `group-scenarios.expected.json`.

1. **The other member sees one writer for A**, whichever device wrote.
2. **A change removes the lost device.** It reads nothing written after
   the change, and what it writes under the old key after seeing the
   change does not count.
3. **What was written beside the change is a choice.** If an entry counts
   by its place alone, the other member takes what the lost device wrote
   beside the change, and also what the honest laptop wrote offline. If a
   change seals only what it saw, both are left out, and the laptop has to
   write its entry again under the new key.
4. **Two own devices that change apart do not break the group.** Everyone
   computes the same key for A; the device whose change lost is not read
   until it took the other's keys. With a derived next key both write the
   same change and both are read.
5. **Who may write a change decides the theft case.** If the key every
   device holds may write it, or the lost device holds the update key, the
   lost device changes first, is taken as A, and the owner cannot change
   afterwards. Without the update key the lost device can change nothing.
6. **A sibling without the new keys reads nothing after the change**: the
   keys have to reach it through the person's own devices.

Not modelled: the group's key agreement (the new epoch is sealed to a list
of receive keys), votes, joining, the personal group.

## What the switches cover

Every document is signed under the head of the sender's log and checked
under the head the receiver holds, in every variant. What a document says
about the receiver's log (the acknowledgement) counts only after that
check. The switch for log heads removes the two heads and nothing else;
since the heads are also how a change is acknowledged, a variant without
them never stops attaching the entry and never closes the old receive
path. That is the effect measured in finding 3, not a weaker check.

## Limits

- One relationship, one carrier, no time. Open requests are a plain
  request and answer, not the library's membership flow.
- A device "takes the sibling's state" by a function call; the personal
  group that would carry it is not modelled.
- The warning at the counterpart cannot tell an honest fork from an
  attacker: both look the same on the wire.
