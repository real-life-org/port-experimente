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

6. **A sibling that comes back turns nothing back.** Syncing only ever
   lets a device's own log grow, and what the counterpart acknowledged is
   never forgotten. Giving up one's own continuation after a fork is a
   step of its own.

## Material and paths

A device holds key material (receive keys, access to addresses) and uses
receive paths, and the model keeps the two apart. Which paths a device
uses follows from its log, from the newest entry the counterpart
acknowledged, and from the rules: the head's path always; older ones
while the change is not acknowledged; one more below that if the old path
is to stay open for a while. Two devices with the same log and the same
acknowledgement use the same paths, whatever each still holds. So an old
address that stays open is a rule that says so, and a closed one stays
closed when an older sibling syncs: after change, acknowledgement, return
of the old laptop and a sync in both directions, phone and laptop both use
the new path only (or both the new and the old, under the rule that keeps
it open), although the laptop still holds the old address as material.

## A change secret

The rule `deterministic` is built out: the devices that may change keys
share a random change secret. The key that writes the next entry is
derived from the secret the head committed under; the new state and the
next commitment are derived from the newest secret a device holds. When a
device is removed, the devices that stay get a new secret, and each
relationship changes once: that one change is written with a key from the
old secret and commits to a key from the new one.

| Case | The counterpart follows | Warning at the counterpart | The laptop |
|---|---|---|---|
| the lost device is locked | the owner | none | writes the same entry as the phone, is heard |
| the lost device is unlocked and changes after the owner | the owner | yes | the same entry, is heard |
| the lost device is unlocked and changes before the owner | the lost device | yes | not heard; the owner learns of the refusal |
| the laptop was offline and changes on the old secret | the owner | yes | another entry, refused |
| phone and laptop each remove the tablet, apart | the owner | yes | another entry, refused |

1. **Devices that hold the same secrets write the same entry**, byte for
   byte: no fork, no warning.
2. **After the owner's change stands, the lost device can write nothing
   more**, even when it is handed that entry: the next key comes from a
   secret it never held.
3. **The one change after a removal is a race** against a lost device that
   someone unlocked: whoever reaches the counterpart first is followed.
   A locked device takes no part.
4. **A sibling on the old secret forks**, and so do two siblings that each
   made a new secret: the entry depends on the newest secret. Both are the
   case of finding 1 above, settled the same way (the first stands, the
   other takes it over).

## One main device

Only the main device holds the change secret, and the secret says who may
write the next entry and nothing else: the everyday keys of a new state
are drawn and reach the linked devices by syncing.

1. **A lost linked device cannot change the keys**, with a secret in the
   model as without. Until the main device changes them, the counterpart
   takes what it writes as the person. After the change it is neither
   heard nor does it read.
2. **A linked device is silent after a change until it synced with the
   main device**: its documents are signed under the old key.
3. **A linked device can open a relationship with a binding the main
   device prepared.** The main device, back later, changes the keys and
   the counterpart follows. Without a prepared binding the relationship
   opens unbound and its keys can never be changed.
4. **A counterpart's two devices can follow two continuations.** When they
   sync, both see it and both keep the other one as evidence, but each
   keeps following its own, unless a rule every device applies alike picks
   one (here: the lower id). Which one that is, the rule cannot know.

## Bind yourself, hand over later

Instead of a stock of prepared bindings: a linked device binds a new
relationship to a key it draws itself. At the next sync it hands the key to
the main device, which writes an entry that changes only the binding; from
then on the next writer comes from the main device's secret.

| The laptop gets into foreign hands | The main device knows of the relationship | The counterpart follows | Contested |
|---|---|---|---|
| never | yes | the owner | no |
| before the handover | no | the lost laptop | no |
| after the handover, before the counterpart knows of it | yes | the lost laptop | yes |
| after the counterpart knows of the handover | yes | the owner | yes |

1. **It works without anything prepared**, and the handover changes no
   everyday key: the counterpart has nothing to tell its person.
2. **The window ends when the counterpart knows of the handover**, not at
   the handover: until then the key the laptop drew still stands at the
   counterpart.
3. **Before the first sync the relationship exists on the laptop alone.**
   Lost then, the main device never hears of it. That is a matter of
   syncing, with or without any binding.

## A contested relationship

A second valid continuation marks the relationship as contested at the
counterpart, also when the counterpart has one device. The first one it
accepted stays in use; what carries weight (a statement of trust, a vouch,
an invitation, a credential) is held back; messages go on. The two settle
it in a meeting: the person shows its log, the counterpart takes it,
whichever continuation it followed before.

| | The owner was first | The old main device was first |
|---|---|---|
| before the meeting the counterpart follows | the owner | the old main device |
| marked contested | yes | yes |
| a statement of trust is held back | yes | yes |
| a message while contested reaches | the owner | the old main device |
| after the meeting the counterpart follows | the owner | the owner |
| the old main device is heard afterwards | no | no |
| it can contest the relationship again | no | no |

A meeting settles a fork, not a position and not the relationship for
good. The fork is named by the entry both continuations follow. Whether a
relationship is contested is computed on each device: it holds a competing
continuation for a fork that was not settled. Nothing sets or copies a flag.
From that follows (`tests/wechsel-contested.test.ts`):

- The decision of a meeting travels with the sync of the person's own
  devices and holds there. A device that was not at the meeting takes the
  settled branch, keeps the other one as evidence, and may state trust
  again. A sync in the other direction changes nothing.
- A device whose log already continues the settled branch keeps its log
  when the settlement arrives.
- A later fork on the settled branch is a new conflict, on the device that
  sees it and, after a sync, on its sibling, whatever either settled
  before.
- One warning per fork: a third continuation of a fork already contested
  adds evidence and no new warning; one for a settled fork is dropped, and
  it does not cancel the answer owed for another fork in the same document.
- An entry whose key cannot be read continues nothing, and the documents
  fetched with it are handled.

**First sync, then act.** A main device that was removed and reaches one of
the person's devices before it changes keys learns of it, drops its secret
and changes nothing. If it reaches none, it changes as before: the rule
binds an honest app that is online, nothing else.

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
   computes the same key for A; one of the two is read, the device whose
   change lost is not until it took the other's keys (which of them loses
   is decided by the entries' ids). If both write the same change, both
   are read; the model does not derive it here but hands both devices one
   prepared key, so this row shows the effect of an identical change, not
   that a derivation produces one.
5. **Who may write a change decides the theft case.** If the key every
   device holds may write it, or the lost device holds the update key, the
   lost device changes first, is taken as A, and the owner cannot change
   afterwards. Without the update key the lost device can change nothing.
6. **A sibling without the new keys reads nothing after the change**: the
   keys have to reach it through the person's own devices.

Not modelled: the group's key agreement (the new epoch is sealed to a list
of receive keys, and the new keys reach the chosen devices by a function
call), two devices sending under one leaf, votes, joining, the personal
group. The removal of one device by a change of the person's key is
therefore shown only against this stand-in, not against a key tree.

## What the switches cover

Every document is signed under the head of the sender's log and checked
under the head the receiver holds, in every variant. What a document says
about the receiver's log (the acknowledgement) counts only after that
check. The switch for log heads removes the two heads and nothing else;
since the heads are also how a change is acknowledged, a variant without
them never stops attaching the entry and never closes the old receive
path. That is the effect measured in finding 3, not a weaker check.

## What the model does not show

- A join to a group on a device that holds no secret.
- Which of two continuations is the owner's: a counterpart's devices can
  agree on one, not on the right one.
- Holders, wrapping, handing the role over, recovery, time.

## Limits

- One relationship, one carrier, no time. Open requests are a plain
  request and answer, not the library's membership flow.
- A device "takes the sibling's state" by a function call; the personal
  group that would carry it is not modelled.
- The warning at the counterpart cannot tell an honest fork from an
  attacker: both look the same on the wire.
