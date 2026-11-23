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

## Limits

- One relationship, one carrier, no time. Open requests are a plain
  request and answer, not the library's membership flow.
- A device "takes the sibling's state" by a function call; the personal
  group that would carry it is not modelled.
- The warning at the counterpart cannot tell an honest fork from an
  attacker: both look the same on the wire.
