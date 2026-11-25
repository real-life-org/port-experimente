# How long a shared-connect link and its proposal are good

Status: a contract for the time rules of the first step, written from what
the library does (rltp-lib 0.22.0) and checked against it to the second
(`tests/freshness.test.ts`). The rule is `rule.ts`. The ceremony is
[`shared-connect` 0.1](https://github.com/real-life-org/trust-protocol/blob/main/interop/ceremonies/shared-connect.ceremony.json),
whose note on freshness this page makes exact; what follows the proposal is
`../tuple-opening/OPENING.md`.

## What is promised

F-P1. A code shown in person cannot be used later than ten minutes after it
was shown, give or take a minute of clock difference.

F-P2. Once the inviter took the proposal, each side has until thirty days
after the link's expiry to complete its part: the inviter's person to
decide, and each side to take the documents meant for it. A side that
completed stays open. A side whose enactment is still open when its upkeep
runs after that time no longer keeps it; documents that arrive later
complete nothing there. So one side can hold a contact and the other none.
*Pinned by:* the tests "the person decides until thirty days after the
link expired", "accepted at once, the rest carried late" and "one receipt
carried late" (for either role).

F-P3. One link connects one person.
*Pinned by:* the test "one link, one proposer".

## The rule

All times in seconds; `exp` is the link's expiry, `now` the clock of the
side that acts.

F1. **Lifetime.** The link carries its expiry. The inviter sets it when it
shows the link: ten minutes unless it states a lifetime; the stated
lifetime rounded to the second and at least one minute; at most ten
minutes for a code shown in person (`displayed`), at most seven days for a
link sent in a message (`sent`). A sent link without a stated lifetime
lives ten minutes.

F2. **The responder** reads the link and proposes only while `now < exp`.
No tolerance: at the second of the expiry the link is refused.

F3. **The inviter** takes a proposal issued at `issuedAt` when both hold,
and refuses it otherwise:

| Condition | Refusal |
|---|---|
| `now - issuedAt >= -60` (not issued more than a minute ahead of the inviter's clock) | `not-fresh` |
| `now < exp + 60` | `expired-link` |

The proposal has no age limit of its own: on a link that lives for days it
is taken whenever it reaches the inviter before the link's expiry, also
when the inviter's device was offline in between.

F4. **Kept for thirty days.** Each side keeps an enactment that is not
complete while `now < exp + 60 + 30 days`, by its own clock. While it is
kept, the inviter's person can accept or decline, and the acceptance, the
issues and the receipts are taken whenever they arrive: they have no age
limit of their own. When a side's upkeep runs after that moment, the
enactment is gone with its open question; a document that arrives then
finds nothing, and that side does not open. A complete enactment is kept.

F5. **Single use.** The inviter takes one proposal per link. A proposal
from another identity on the same link is refused.

*Pinned by:* `tests/freshness.test.ts` runs the library at the seconds
around every boundary of F1 to F4 and compares with `rule.ts`.

## Stated, not pinned

- A responder and an inviter whose clocks differ: the tests give both the
  same clock.
- F5 after a decline, and a second proposal from the same identity (the
  redelivery of `OPENING.md`, O9).
- Whether a refused proposal uses up the link.

## Not here

What the app shows when a link expired; when an enactment that was never
answered leaves the holder's state; the offline back-code (`../offline/OFFLINE.md`): its
proposal is taken under F3 like one a carrier delivered.

## For an app

The app shows codes in person only and states ten minutes. An app that
sends links has to state the lifetime, or the link is dead after ten
minutes (F1); within the lifetime it states, the person who opens the link
is connected whenever the inviter's device next fetches its documents.
