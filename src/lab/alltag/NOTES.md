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

**The rule between two answers of one person** (decided 2026-11-23): what
the counterpart took first holds, proven by its answer; what has not left
the own device may be taken back. In the layer, in this order: a confirmed
accept stands; else an accept that left a device stands; else a decline on
any device wins and an accept still in the house is never handed over; else
one of the issued accepts may leave. For that the log carries two more
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
