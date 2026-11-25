# shared-connect without a carrier: two codes

Status: a contract for one transition, written from what the library does
(rltp-lib 0.22.0) and checked against it step by step
(`tests/offline.test.ts`). The rule is `rule.ts`, an extension of the rule
of `../tuple-opening/OPENING.md`, whose documents and words ("take",
"hold back", "open") are used here. The ceremony is
[`shared-connect` 0.1](https://github.com/real-life-org/trust-protocol/blob/main/interop/ceremonies/shared-connect.ceremony.json);
its note `offline` defines the two codes and what they carry.

## What it is for

Two people stand in front of each other and neither device reaches a
carrier. With a carrier a side opens its tuple only after four documents
went back and forth (OPENING, O6). Here two codes do it: the link the
inviter shows, and a code the responder shows back. After them both sides
show a contact, and the documents follow when there is a carrier.

## What is promised

X-P1. After the responder scanned the link and showed its code back, and
the inviter's camera read that code and its person accepted, both sides
have opened. No document was carried.
*Pinned by:* the first four steps of `traces/two-codes.json`; the test
"two codes and the acceptance, nothing carried".

X-P2. A side opens once. The documents that follow by a carrier complete
the same enactment and open nothing more.
*Pinned by:* every trace to its last step; the walk over every schedule
(a side that opened stays open, and the library holds one contact).

X-P3. A side opens only with the other side's card in hand: the pair keys
of the other side, under a proof of its pair key made for this one code.
*Pinned in the library's own tests* (a card that does not verify, a card
under another link, a card another key than the later issue names); the
model has no card that fails.

X-P4. The two sides do not open at the same moment, and the responder
opens without knowing what the inviter will do. If the inviter's person
declines, or the code is never read and no carrier ever comes, the
responder holds a contact the inviter does not.
*Pinned by:* `traces/declined-after-the-code.json`; the walk (eight of
33 799 schedules end with the responder alone).

## The two codes

| Code | Shown by | Carries |
|---|---|---|
| the link | the inviter | what every link carries, and the inviter's card |
| the back-code | the responder | its proposal (the document `propose`), and the responder's card |

A card is the pair's key agreement key under a proof of the pair anchor.
A link sent in a message carries no card; neither does a link too long
for it (a very long name). The responder then cannot show a code back
(`no-card`), and the enactment runs by a carrier alone.

## The rule

X1. **The responder shows its code.** After it proposed (O1), for a link
its own camera read and that carried the inviter's card, the responder
can show its proposal back as a code. At that step it opens its tuple,
toward the keys of the card in the link. Its proposal stays in flight as
before: a carrier may still deliver it.

X2. **The inviter reads the code.** The code hands the inviter the
proposal, as a delivery would (O1: its person can decide now), and the
responder's card. If the proposal had been delivered before, the code is
that document handed over again (O9: after the acceptance the inviter
sends `accept` and `issue-inviter` again). The inviter opens its tuple at
the step at which it holds the card and its person has accepted: at the
acceptance, or, where the acceptance came first, when the code is read.

X3. **Everything else is as with a carrier.** The acceptance, the issues
and the receipts are sent as O2 to O4 say and wait in flight. Delivered
later, they are taken as OPENING says; a side that is open already stays
as it is. The proposal, delivered after the code was read, is a document
handed over again. A decline ends the enactment for both (O8); a tuple
that is open stays open.

X4. **Shown once, read once, while the enactment runs.** A side whose
enactment is declined or complete shows no code and takes none.

## The steps of a trace

The steps of OPENING, and two more:

- `{ "act": "back" }`: X1.
- `{ "act": "read-back" }`: X2.

`sent`, `after` and `outbox` as in OPENING. A code is not in `sent`: it is
shown, not carried. `outbox` is what a side sends again after a restart
(O10); a side that opened by a code and is not complete sends everything
it sent so far.

## Against the library

`../tuple-opening/lib-run.ts` runs the traces against the published
library with two holders (`sharedConnectBack`, `sharedConnectReadBack`).
At every step of the four traces the library sends the same documents,
the same side holds a contact, the same documents are held back and the
outbox is the same. The same holds on the schedules of the walk: the two
codes shown and read at any point of any delivery order, 33 799
schedules, of which the test runs 300; all were run once by hand.

`traces/code-never-read.json` is the case in which only the responder
used a code; `traces/code-after-the-acceptance.json` the one in which the
carrier was there for the proposal and gone afterwards.

## What an app can do on the opened tuple

Measured in the library's tests (`shared-connect-offline.test.mjs`), not
here: trust and an invitation into a group are taken at once and wait in
the outbox; a message is refused as `not-ready` until the first document
of the other side arrived on the tuple (Message Tasks 5.1), so an app
keeps it and sends it then. The other side's delivery hints come with the
card of its issue step: until then nothing is delivered on the
relationship. The contact met (`../met/MET.md`, M2: the own channel is in
person, and the other side has stated nothing yet).

## Stated, not pinned

- X4 for a code shown or read a second time: the library gives the same
  code again and opens nothing twice; a second reading is the proposal
  handed over again. The model allows each act once.
- A back-code is not shown after the link expired
  (`../freshness/FRESH.md`, F3: the inviter would refuse its proposal),
  and not when it would pass 1200 characters (a long name in the
  proposal). The model has no time and no length.
- An enactment that opened a contact is kept whatever its end; the thirty
  days of FRESH, F4, are for an enactment that opened none.

## Not in the model

A card that fails its check; a party of another app, which reads no
back-code and shows none; several devices of one person; recognition on
a tuple that only one side opened (`../wiedererkennung/RECOGNITION.md`
leaves such tuples out).
