# How long a shared-connect link and its proposal are good

Status: a contract for the time rules of the first step, written from what
the library does (rltp-lib 0.20.0) and checked against it to the second
(`tests/freshness.test.ts`). The rule is `rule.ts`. The ceremony is
[`shared-connect` 0.1](https://github.com/real-life-org/trust-protocol/blob/main/interop/ceremonies/shared-connect.ceremony.json),
whose note on freshness this page makes exact; what follows the proposal is
`../tuple-opening/OPENING.md`.

## What is promised

F-P1. A code shown in person cannot be used later than ten minutes after it
was shown, give or take a minute of clock difference.

F-P2. Once the inviter took the proposal, nothing in the enactment expires:
the person may accept a day or a month later, and documents may arrive
late; both sides still open.
*Pinned by:* the test "only the proposal has a window".

F-P3. One link connects one person.
*Pinned by:* the test "one link, one proposer".

## The rule

All times in seconds; `exp` is the link's expiry, `now` the clock of the
side that acts.

F1. **Lifetime.** The link carries its expiry. The inviter sets it when it
shows the link: ten minutes unless it states a lifetime; at most ten
minutes for a code shown in person (`displayed`), at most seven days for a
link sent in a message (`sent`). A sent link without a stated lifetime
lives ten minutes.

F2. **The responder** reads the link and proposes only while `now < exp`.
No tolerance: at the second of the expiry the link is refused.

F3. **The inviter** takes a proposal issued at `issuedAt` when all three
hold, and refuses it otherwise:

| Condition | Refusal |
|---|---|
| `now - issuedAt > -60` (not issued more than a minute ahead of the inviter's clock) | `not-fresh` |
| `now - issuedAt < 660` (younger than ten minutes plus the minute of tolerance) | `not-fresh` |
| `now < exp + 60` | `expired-link` |

The ten minutes of the second row hold for a sent link too: a proposal on
a link that lives for days must still reach the inviter within eleven
minutes of being issued.

F4. **Nothing later has a window.** The acceptance, the issues and the
receipts are taken whenever they arrive.

F5. **Single use.** The inviter takes one proposal per link. A proposal
from another identity on the same link is refused.

*Pinned by:* `tests/freshness.test.ts` runs the library at the seconds
around every boundary of F1 to F3 and compares with `rule.ts`.

## Stated, not pinned

- A responder and an inviter whose clocks differ: the tests give both the
  same clock.
- F5 after a decline, and a second proposal from the same identity (the
  redelivery of `OPENING.md`, O9).
- Whether a refused proposal uses up the link.

## Not here

What the app shows when a link expired; when an enactment that was never
answered leaves the holder's state; the offline back-code, whose proposal
has no expiry of its own.

## For an app

The app shows codes in person only and states ten minutes. An app that
sends links has to state the lifetime, or the link is dead after ten
minutes (F1). Whatever it states, the person who opens the link has to be
reachable by the inviter's device within eleven minutes of proposing (F3):
a proposal that waits longer in an inbox is refused.
