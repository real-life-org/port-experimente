# Everyday multi-device experiments

Experiments on a person with two devices, run against the published
library (`rltp-lib`, an alias for `@real-life/trust-protocol` 0.19.0), not
against a model. The older multi-device bench (`src/lab/mehrgeraet`,
`src/candidates/mehrgeraet-*`) models the Trust layer by hand on library
0.3.2 and stays as it is; it covers introductions with several devices.

Measurements and prototypes belong here. The library repository keeps one
test of this strand, the baseline of everyday scenarios
(`lib/test/multi-device-baseline.test.mjs`), which every build step there
has to move.

## Two producers (`two-producers.ts`)

What a counterpart answers when the phone and the laptop each produce a
document for the same cause. Measured 2026-11-22, library 0.19.0; the full
table is `two-producers.expected.json`.

| Document | The second device's document at the counterpart |
|---|---|
| `delivery-ack` | accepted |
| `profile`, same body and revision | accepted |
| `profile`, another body under the same revision | refused, RLTP-TRU-6270 |
| `anchor-mapping` | refused, RLTP-TRU-6270, also when the laptop only holds the state of the phone's act |
| `star`, `group-star` | refused, RLTP-TRU-5150 |
| `membership-prelude-reply` | refused, RLTP-MT-3965 |
| `membership-accept` | refused, RLTP-MT-3270 |
| `x-access-page` | refused |
| `membership-invite` | accepted as a second invitation: the invitee holds two |
| `x-membership-welcome` | accepted, once per answered invitation |
| `encounter-credential-delivery` | accepted |
| `continuity-probe` | one accepted, one refused (RLTP-TRU-6700) |

Only acknowledgements and an identical profile tolerate two producers
without a rule. The second invitation is the one case where the second
document silently has a second effect.

Not measured: whether a real mediator hands a document to every device of
an address; whether two accepted credential deliveries make two
relationships.

## What is left afterwards (`aftermath.ts`)

The table above says what the counterpart answers to the second document.
This says whether that answer leaves damage. Seven scenarios, each with two
devices and with one, settled, then five more days of delivery. Measured
2026-11-23, library 0.19.0; the full table is `aftermath.expected.json`.

| Scenario | The friend shows | The two devices show | Still sent and refused days later |
|---|---|---|---|
| the friend trusts; each device takes the star | as with one device | the same | the laptop's `star`, once a day (RLTP-TRU-5150) |
| the friend writes a message | as with one device | the same | nothing |
| the friend sets a profile | as with one device | the same | nothing |
| the friend invites; each device answers the prelude; the phone accepts | as with one device | differ: the laptop is no member | the laptop's `membership-prelude-reply` (RLTP-MT-3965) |
| the friend invites; both devices accept apart | as with one device | differ: the laptop is no member | the laptop's `membership-prelude-reply` and `membership-accept` (RLTP-MT-3270) |
| trust is given on both devices apart | as with one device | differ in the profile section | the laptop's `anchor-mapping` (RLTP-TRU-6270) |
| nothing happens for a week | as with one device | the same | nothing |

Three findings:

1. **The counterpart is never damaged.** In every scenario the friend shows
   what it shows with one device. A refusal of the second document costs
   the counterpart nothing but the refusal.
2. **The refused device never learns.** A refusal carries no reason and no
   acknowledgement, so the laptop offers the same document again, once a
   day, for as long as measured. What would end it is an acknowledgement
   "taken, without effect" where the counterpart refuses today.
3. **A device refuses the answer to its sibling's document.** The laptop
   refuses the friend's `delivery-ack`, `x-membership-welcome` and
   `x-access-page` that answer the phone's documents (`validation-failed`),
   and so stays outside the group the person joined. That is the person's
   own side: the laptop would need the phone's sent documents.

Without a second device the same scenarios send acknowledgements for days
as well (24 to 60 in five days); that is the library's own repetition and
no effect of the second device.

## The common core of the layer (`core.ts`)

The three cuts below each built their own log, their own loop over open
entries and their own handover to the carrier, and the reviews of all three
found faults in exactly those parts. They now share one core
(`tests/alltag-core.test.ts` tests it without the library, with a toy cut).
A cut supplies its kinds of entry, how one is applied, and what holds for a
subject. The core holds five rules:

1. **First record, then act.** What the human did is an entry before
   anything is done about it; every device, the acting one included,
   applies it by the same routine.
2. **A break leaves an entry open, a refusal closes it.** An exception is
   tried again by the next call, and until it is done the library gets no
   turn of its own (`resume`): what the entry still owes must come from
   the entry. A refusal by the library is its verdict:
   the acting device notes in the log that nothing happened (`void`), the
   entry is closed, what follows runs.
3. **Three facts about an answer, each its own entry.** The person chose
   (the answer's entry): the decision is running. The library applied it
   (`took`) or refused it for good (`void`). An accept that took effect was
   handed to the carrier (`handed`). A sister device tells a running answer
   from one that took effect: until `took` it keeps its prompt and changes
   nothing in its library, and a competing accept only waits.
4. **One evaluation of what took effect, asked every time.** The sync, what
   holds and the door ask the same function. Whether a document may leave
   is computed from the entries known at that moment, not from a list an
   earlier application left behind: what a running decline holds up leaves
   once the decline turned out void. A handover stays binding.
5. **Between two answers of one person**: a confirmed accept stands; else
   every accept that left a device; else a decline; else the first accept.

The door is closed by default. A document that proves an answer of the
person (the membership accept, the encounter's credential delivery) leaves
only when the layer can assign it to an answer that took effect and the
rule lets that answer leave; one it cannot assign waits. This holds for
the first call and for every later offer by the library's `resume`. The
case behind it: the library stores the accept and the call breaks off
before the layer notes whose document it is; the device then learns a
decline, and the library offers the stored document again.

What stays a limit of the library: the document is in its outbox. The
layer keeps it from the carrier; it cannot remove it or undo the accept
in the holder.

The test for rule 3 and 4: whether a decision and what became of it reach
a sister in one sync or in two, the sister ends with the same verdict, the
same prompt and the same answer at the door (core, invitation and
encounter each have this test).

Moving the invitation cut onto the core closed two faults it had and the
encounter review had found there: an accept left the device although a
decline was known when the sync had broken off, and an answer the library
refused held up everything after it. Both are tests of the invitation now.

Not unified: the time an entry is applied at. The encounter cut runs acts
and passed-on documents at the time of the device that acted or received;
messages and invitations still use the time of the replay.

## Messages through a layer above the library (`layer.ts`)

The first vertical cut of the build the design review proposed for device
sync (in the private design journal: review 1 of the sync draft): a device
passes what it received on to the person's other devices as an input, and
what the human did as a named entry; each device runs the library's own
reception and computes its views itself. Built as a layer above the
published library, so nothing moves into the library before the cut holds.

Three kinds of entry carry the whole message case: `received` (the
envelope a device accepted), `taken` (the application took inbox entries
over), `sent` (a message the human wrote). Measured 2026-11-23, library
0.19.0, second device 13 s late:

| Scenario | Result |
|---|---|
| both devices get the message from the carrier, the phone reads it | one conversation line on each device, both inboxes empty, the friend refuses nothing, status `delivered` |
| only the phone gets it; the laptop learns it from the phone | same |
| the laptop learns "read" before the carrier brings it the message | same on the laptop |
| the laptop was off for 30 days, carrier copy and entries in either order | same on the laptop |
| both devices read the same message apart | one line on each |
| the human writes from both devices apart | both devices show both lines, the friend gets both |
| a sync breaks off while taking a passed-on document | the entry stays open, the next sync brings the message |
| taking "read" over breaks off between the conversation line and the inbox | the entry stays open; after the next sync one line, an empty inbox |
| reading A fails once on the phone, then B arrives | A is read on both devices, B stays unread on both |
| the friend's acknowledgements reach both devices | **open**: each is accepted by the device that issued the document and refused by the sister (pinned as measured) |

What the layer had to keep that the library does not: which inbox entries
the person took over on any device (read from the `taken` entries of the
log). The library's take is local and
immediate; a message that reaches a device after the person read it
elsewhere needs a mark that waits for it.

What the human did is recorded once, as an entry with fixed ids, before
anything is done about it; every device, the acting one included, applies
that entry by the same routine. An entry is applied when the device has
taken its whole effect over, and only then does its progress move; a
repeated entry tolerates the steps already done and works on the ids it was
written with. Whether progress and effect must also survive a process
breaking off between them is a question for a persistent implementation and
is not answered here.

Not covered: the personal log here is the smallest thing that orders
entries, in memory and unsealed; it stands in for the exchange and is no
proposal for it. Nothing here concerns who may write an entry.

## A group invitation through the layer (`invitation.ts`)

The second vertical cut: a friend invites the person into a group; the
person answers on one device or on both. Entries: `received`, `decided`
(the answer to one invitation, recorded with the invitation's credential
digest before anything is done), `issued` (the proof that a device
produced the document a decision calls for: the accept and its digest).
Measured 2026-11-23, library 0.19.0, second device 13 s late:

| Scenario | Result |
|---|---|
| both devices get the invitation, the phone accepts | both devices `member`, the laptop's card is gone, the friend's log holds two members |
| only the phone is reached by the carrier | the laptop takes the join over from the phone and stands at `joining`; it is `member` once the carrier reaches it and its own request for the group's log is answered |
| apart: the phone accepts and the accept leaves for the carrier, the laptop declines | the accept stands: both devices `member` |
| apart: the phone accepts offline, the accept has not left it, the laptop declines | the decline wins on both devices, the accept is never handed over, the friend's log holds one member |
| apart: both accept, the devices hear of each other first | one accept leaves: both devices `member` |
| apart: both accept and both accepts leave | the friend takes the first and refuses the second: both devices `member` |
| apart: both accepts leave and the devices sync before the friend answers (either accept delivered first) | both stay candidates until the welcome names one: both devices `member` |

**The rule between two answers of one person** (decided 2026-11-23): what
the counterpart took first holds, proven by its answer; what has not left
the own device may be taken back. In the layer, in this order: a confirmed
accept stands; else an accept that left a device stands; else a decline on
any device wins and an accept still in the house is never handed over; else
one of the issued accepts may leave. Where two accepts left their
devices, neither device gives its accept up for the sister's: both stay
candidates until the counterpart's answer names one. The library holds one
accept digest per invitation, so a device whose library refuses an answer
tries it under the other candidate. For that the log carries two more
entries: `handed` (the accept left the device) and `confirmed` (the
counterpart's answer names the accept it took).

**What the library lacks, and the stand-in for it.** A device cannot take
a sister's decision over: the welcome is bound to the digest of the accept
this holder issued. `adopt` in `invitation.ts` writes the one fact the
library checks into the store (the invitation's status and the accept's
digest) and closes the prompt. With that single fact the library's own
reception of the welcome does the rest. This is the shape of the entry
point the library would need: "this invitation was accepted with the accept
of digest X", or "declined".

**Rules the layer needed per kind of document** (from the two-producer
table): an acknowledgement is not passed on; an answer this device's
library produces while taking a sister's input over goes out only where the
counterpart takes a second one (`delivery-ack`, `x-access-sync`); an accept
that does not stand is withheld; a passed-on document this device's library
refuses is recorded and the log moves on.

**Open, pinned as measured.**

- The friend refuses the laptop's `membership-prelude-reply` (both devices
  answered the prelude before they could know of each other) and the laptop
  keeps repeating it: the library cannot withdraw an issued document.
- The friend refuses the laptop's `group-star`: once a member, the laptop
  issues its own under the salt the phone used.
- The laptop does not take the phone's `x-access-page` over: it answers a
  request only the phone made. The group's log does not travel between the
  person's devices; a device that the carrier does not reach stays at
  `joining`.

**Limits of the rule.** It works where there is one counterpart whose
answer counts: the inviter's welcome names the accept it took, both devices
read that one answer, and the group's log keeps the same fact. It does not
work for what goes to many at once. A profile changed apart on two devices
reaches twenty friends in either order; each keeps the one that came first,
and "what the counterpart took first" has twenty answers. There the devices
agree on one version after their sync and send it to all as a newer one.
And the human has to be told: who declines on the laptop and is a member
all the same needs to read that the phone accepted.

## An encounter through the layer (`encounter.ts`)

The third cut, measured 2026-11-23, library 0.19.0. Tests:
`tests/alltag-layer-encounter.test.ts`.

What is new against messages and invitations: the human's act creates
secrets. Showing or scanning a card draws a fresh pair label, from which
the library derives the relationship's keys, its address and the contact's
id, and a fresh challenge. Measured without the layer:

| | Result |
|---|---|
| the documents the scanning device received, passed on to the sister | `malformed`: sealed to an address the sister never derived |
| the sister scans the same card itself | another contact id; the friend refuses the second bundle (`consumed-challenge`) |

So "what a device received travels as an input" is not enough for an act
that draws randomness. The `act` entry carries a seed, drawn before
anything is done; the library's entropy for that act is a stream derived
from the seed, on every device, the acting one included. No stand-in is
needed for this: entropy is a port of the library
(`createHolder({ entropy })`).

The entry also carries the acting device's time, and every device runs the
act at that time (the library raises it where a device has been active
later). With seed and time a sister produces the same document, byte for
byte, as the acting device: the bundle of a scan and the credential of an
answer have the same digest on both. A `received` entry carries the time
the receiving device took the document, for the same reason. Run at the
time of the replay instead, a laptop that caught up a day later ended with
the contact `outgoing` while phone and friend held `mutual`, and its sync
reported nothing.

| Scenario | Result |
|---|---|
| the phone scans B's card, the laptop learns it | the same contact id on both devices, verified on both sides; the laptop's bundle is the same document and stays in the house |
| the phone shows its card, only the phone is reached, the laptop answers the request | verified on both devices and at B; the phone's credential for the same answer stays in the house |
| both devices get the request, the phone answers | the request closes on the laptop |
| the request reaches the laptop before it learns of the show | refused once; open after the show is applied and the friend's library sends again |
| apart: both devices accept | one relationship on every side; B takes both credentials |
| apart: the phone's accept left, the laptop declined | the accept stands on both devices |
| apart: the phone's accept has not left, the laptop declined | nothing reaches B; **open**: the phone keeps showing the contact as verified, the library cannot take an accept back |
| the laptop declines before the phone looks | the request closes on the phone |
| apart: the phone meets B, the laptop meets C | both devices hold both under the same ids |
| applying a scan breaks off on the laptop | the entry stays open, the next sync applies it, one contact |
| the laptop catches up a day after the phone met B | verified on the laptop like on the phone |
| the phone accepted offline, the laptop declined, the phone's sync breaks off | the phone knows the decline; at the door its accept does not leave, B stays `outgoing` |
| the library refuses the laptop's decline | it had no effect and counts nowhere (sync, verdict, door); the phone's accept leaves |
| the laptop was active itself the next day before it catches up | **open**: phone and friend `mutual`, the laptop `outgoing` under the same contact id; the library takes the friend's credential without effect, the layer reports it as not taken |
| the library refuses a card for good (`card-invalid`) | the act is closed as refused, a later act runs, the laptop does not hang on it |
| B meets the phone and later, apart, the laptop | **open**: the phone ends with one line for B, the laptop with two; B with one or two, by chance (10 and 10 in 20 runs) |

What the library would need:

- **Taking a decline back.** Declining a request only closes the prompt.
  A device that declined and then learns that the sister's accept left has
  no way to accept. The stand-in `reopen` puts the prompt back into the
  store.
- **Withdrawing an accept** that has not left the device (the same need as
  in the invitation cut).
- **The same bytes for what follows an encounter** (closed in the layer,
  see the trust cut below). Once both devices hold the contact, each issues
  the continuity probe, the star and the group star of the personal
  community. Drawn by each device on its own, the friend refused the second
  of each (`validation-failed`, RLTP-TRU-6700, RLTP-TRU-5150). Drawn under
  the entry they follow and at its time, they are the same documents, and
  the friend refuses nothing. The last scenario stays open all the same:
  there the two devices met B in two acts, and the friend's continuity
  mapping answers the probe of one of them.
- **Taking over a ceremony that is already verified.** Running the act at
  its original time works only while the sister's holder has seen no later
  time; the library never lets a holder's time fall. A sister that was
  active later holds the ceremony at its own time, and the counterpart's
  credential no longer fits. It needs a way to take over the confirmation
  the acting device already checked, with the acting device still
  recognisable.
- **Same bytes for what a duty produces.** For an act, seed and time in
  the entry give the same document on every device. The documents that
  follow an encounter come from the library's duties on `resume`, with
  each device's own entropy and time. Whether the same bytes from each
  device would be a way out there was not tried.

Two rules of the layer came out of the review of this cut and hold for
every cut:

- **The rule is asked at the door.** Whether an accept may leave is
  decided from the entries the device knows at the moment of the first
  handover, not from what an earlier application managed to do. The
  handover gives an accept its standing; it must not be what decides
  whether it may be handed over.
- **One evaluation of what took effect.** An answer the library refused on
  its device (`void`) counts nowhere: not in the sync, not in what a device
  shows, not at the door. All three ask the same function.
- **A refusal closes, a break does not.** A step that breaks off (an
  exception) leaves the entry open and is tried again. A refusal by the
  library is its verdict on the act: the acting device notes in the log
  that nothing happened (`void`), the entry is closed, and what follows
  runs. A sister that meets the act before the note gets the library's own
  verdict.

The seed in an entry is as secret as the keys derived from it; in this
prototype the log is in memory and unsealed.

## Trust through the layer (`trust.ts`)

The fourth cut, measured 2026-11-23, library 0.19.0. Tests:
`tests/alltag-layer-trust.test.ts`. Giving and withdrawing trust are acts
of the person, not answers to a request: no prompt, nothing to decline,
nothing that waits at the door.

The act itself produces no document. The anchor mapping is issued by the
library's own turn (`resume`) afterwards, and the star by the turn after
trust was received. Left to each device, that is two producers under one
number: the friend refused the second mapping (RLTP-TRU-6270) in every
case, also when the laptop had only taken the phone's act over.

What closes it: **what the library issues by itself once an entry is
applied is drawn under the entry's id and at the entry's time, on every
device, right after the entry** (`follows` in `encounter.ts`). Two devices
that apply the same entry on the same state issue the same document, byte
for byte; the counterpart sees one. The same now holds in the encounter
cut, where the three refusals after every encounter are gone.

| Scenario | Result |
|---|---|
| the phone gives trust, the laptop learns it | given on both devices, one effect at the friend, the same anchor mapping on both, nobody refuses anything |
| the friend gives trust, only the phone is reached | received on both devices; the star that follows is one document |
| the phone withdraws trust | withdrawn on both devices, nobody refuses anything |
| applying the phone's act breaks off on the laptop | the next sync completes it with the same document |
| apart: both devices give trust | **open**: one effect at the friend, the devices agree, the friend refuses the second mapping: two acts are two documents under one number |
| the friend's trust reaches both devices from the carrier | **open**: each device takes it at its own time and issues its own star; the friend refuses the second |
| the laptop was active itself the next day before it learns of the trust | **open**: its mapping is another document (a holder's time never falls) |

Baseline scenarios through the layer: K4 passes, K5 stays open.

Where the documents are issued: by the core, after every application of
an entry of any kind, on every device (`issues`). The library's own turn
first completes what is open, and gets no turn while an entry is broken.
Otherwise a device that broke off while taking a document would let the
library issue the owed star by itself, with its own time and fresh
randomness, and its sister would derive another one from the entry.

Two rules for what the library issues by itself:

- **One entry, one duty, one document.** A shared entry yields the same
  document, by digest, for the same duty on every device: also after a
  break, and whether the carrier's pass or the sync comes first. A repeat
  uses the document already issued.
- **A difference between devices needs a named reason.** After an
  encounter the credential, the star, the group star and the first probe
  agree by digest; the laptop holds exactly one probe more, because the
  acknowledgement of the first reached only the phone.

A limit of the layer, and what the library would need: one call of
`resume` hands out several things at once (what follows an answer, a
probe that fell due, a repeat), and the layer cannot tell from the call
which duty a document comes from. It draws them all under the entry it
just applied. To decide per document what to pass on or hold back, the
holder would have to name the duty behind each document it issues;
guessing it from the turn that happens to run brings the same fault back.

What is left of the two-producer question after this cut:

- an acknowledgement reaches only the device the carrier reaches and is
  not passed on. The sister's library then still owes what the
  acknowledgement settled: measured after an encounter, the laptop issues
  one continuity probe more than the phone. With the same documents on
  both devices an acknowledgement would fit the sister as well; passing
  it on was tried and changes several pinned outcomes, so it is left for
  its own step;
- the same act on two devices apart (K5): needs numbers per writer on the
  wire, or a counterpart that takes the second document of the same
  meaning;
- a document both devices take from the carrier themselves: the entry and
  its time differ per device, so what follows differs;
- a sister whose time has moved past the entry.

Not a matter of devices: after trust is withdrawn, the friend keeps
showing it as received, on one device as on two.

A trap of the prototype: each cut keeps its own log, and an entry's id is
the library's act id. Two cuts on one holder must not use the same device
name, or the library replays the journal of the other cut's act. A real
personal log is one log per device.
