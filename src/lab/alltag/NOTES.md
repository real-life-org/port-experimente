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
- **One producer, or the same bytes, for what follows an encounter.** Once
  both devices hold the contact, each issues the continuity probe, the star
  and the group star of the personal community under the number the other
  used; the friend refuses the second (`validation-failed`, RLTP-TRU-6700,
  RLTP-TRU-5150). In the last scenario this decides the outcome: the
  friend's continuity mapping answers the probe of one device, and the
  other device refuses it.
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

