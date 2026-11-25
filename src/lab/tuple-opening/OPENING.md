# When each side opens its tuple under shared-connect

Status: a contract for one transition, written from what the library does
(rltp-lib 0.20.0) and checked against it step by step
(`tests/tuple-opening.test.ts`). The ceremony itself is
[`shared-connect` 0.1](https://github.com/real-life-org/trust-protocol/blob/main/interop/ceremonies/shared-connect.ceremony.json);
its documents, proofs and checks are defined there and are not repeated
here. This page says one thing the ceremony definition leaves to each
party: at which point a side treats the relationship as there.

## What it is for

A tuple is the pair of keys two people share after a ceremony; from the
moment a side opens it, that side shows a contact, sends on the tuple and
starts recognition on it (`../wiedererkennung/RECOGNITION.md`: the opening
fixes the tuple's candidates). The two sides of one enactment do not open
at the same moment, and which one opens first is not fixed.

## What is promised

O-P1. A side that has opened its tuple holds the other side's credential,
and knows that the other side holds its own.

O-P2. Once all six documents are delivered, both sides have opened.
*Pinned by:* the last step of every trace.

O-P3. Which side opens first depends on the order of delivery, not on the
role.
*Pinned by:* `traces/in-order.json` (the inviter first) and
`traces/responder-first.json` (the responder first; the same documents,
the two receipts delivered in the other order); of the nine orders in which
the six documents of an accepted enactment can be delivered, the inviter
opens first in five and the responder in four
(`tests/tuple-opening.test.ts`).

O-P4. If the inviter's person declines, neither side opens.
*Pinned by:* `traces/declined.json`.

O-P5. A document handed over a second time changes nothing on the side
that gets it.
*Pinned by:* `traces/handed-over-again.json`; the walk with one redelivery
at any point (`tests/tuple-opening.test.ts`).

## The documents

Seven documents, six of them in an accepted enactment, named here by step
and sender:

| Name | From → to | In the ceremony |
|---|---|---|
| `propose` | responder → inviter | step `propose` |
| `accept` | inviter → responder | the `#response` of `propose` |
| `decline` | inviter → responder | instead of `accept`: a trust-task-error on step `propose` with the decline code |
| `issue-inviter` | inviter → responder | step `issue-inviter` |
| `issue-responder` | responder → inviter | step `issue-responder` |
| `receipt-of-issue-inviter` | responder → inviter | the `#response` of `issue-inviter` |
| `receipt-of-issue-responder` | inviter → responder | the `#response` of `issue-responder` |

## The rule

Two words. A side **takes** a document when it accepts it and acts on it;
that is what a delivery does, unless O5 says otherwise. A side **holds
back** a document it was handed but has not taken yet. A document held back
counts for nothing until it is taken.

O1. **Propose.** The responder sends `propose` when its person confirmed
the link. The inviter takes it and waits for its person; its person can
accept only after that.

O2. **Accept.** When the inviter's person accepts, the inviter sends
`accept` and `issue-inviter` together.

O3. **The responder issues on the acceptance.** When the responder takes
`accept`, it sends `issue-responder`. It does not wait for the inviter's
issue.

O4. **An issue is answered with its receipt.** A side that takes the other
side's issue sends the receipt of that issue.

O5. **An issue before the acceptance waits.** If `issue-inviter` reaches
the responder before `accept`, the responder holds it, answers nothing and
opens nothing. When `accept` arrives, the responder first does O3 and then
takes what it holds, in the order it arrived, in the same step.
*Pinned by:* `traces/issue-before-acceptance.json` (the held issue; the
step of the acceptance sends `issue-responder`, then the receipt).

O6. **Opening.** A side opens its tuple at the step at which it has taken
both: the other side's issue (O4) and the other side's receipt of its own
issue. Neither alone opens. A receipt that arrives before the issue is
taken at once, not held back; it opens nothing yet. This is the same for
both roles. An open tuple stays open; an issue handed over again after
that is still answered with its receipt (O9). From that step on the side shows a contact; `open` in a trace
means both.
*Pinned by:* every trace (`after.*.open` at each step);
`traces/issue-before-acceptance.json` for the receipt that arrives first
and opens nothing.

O7. **No tuple without the card.** The tuple needs the other side's key
agreement key, which an RLTP party sends as a card inside its issue. If the
other side's issue carries no card (another app's party), the enactment
completes at the same step and that side keeps the credentials, without a
tuple and without a contact. The other side opens if the issue it took
carried a card.

O8. **Decline.** When the inviter's person declines instead, the inviter
sends `decline` and the enactment is over for it. The responder takes
`decline`, drops what it holds back, and the enactment is over for it too.
Neither side issues or opens. In a trace `declined` is true for the inviter
from the step its person declined, for the responder from the step it took
`decline`.
*Pinned by:* `traces/declined.json` (the decline, and that neither side
opens).

O9. **Handed over again.** A document a side was handed before (taken, or
still held back) changes nothing when it is handed over again; it is not
held back a second time. The side sends again, unchanged, its answer to
that document, as the table says. A document is told by its name: a copy
sent again is the same document.

| Handed over again | Sent again |
|---|---|
| `propose`, after the person accepted | `accept`, `issue-inviter` |
| `propose`, after the person declined | `decline` |
| `propose`, before the person decided | nothing |
| `accept` | `issue-responder` (not the receipt of an issue it had held back, O5) |
| `issue-inviter`, `issue-responder`, taken | its receipt |
| an issue still held back | nothing |
| a receipt, `decline` | nothing |

A copy sent again travels like any document and is, where it arrives, a
document handed over again.
*Pinned by:* `traces/handed-over-again.json`; the walk with one redelivery.

O10. **After a restart** a side sends again its own documents the other
side may still be waiting for. While its enactment runs, that is everything
it sent so far: for the responder `propose`, then `issue-responder`, then
its receipt; for the inviter `accept` (or `decline`), `issue-inviter`, then
its receipt. Once its tuple is open, only its receipt: the other side may
have received everything else, but this receipt may not have left. What is
sent again arrives as a document handed over again (O9).
*Pinned by:* `after.*.outbox` at every step of every trace and schedule,
against the library's own list.

## The steps of a trace

- `{ "act": "propose" }`: O1, the responder's part.
- `{ "act": "accept" }`: O2. `{ "act": "decline" }`: O8. Either is
  possible once, after the inviter took `propose`.
- `{ "deliver": "<name>" }`: the carrier hands one copy of the document in
  flight to the side it is for.
- `{ "redeliver": "<name>" }`: the carrier hands over once more a document
  it delivered before; nothing leaves the flight.

Every step records `sent`, the documents the step put in flight, in the
order they were sent, and `after`: per side whether its tuple is open,
whether the enactment was declined for it, which documents it holds back,
and its `outbox`, what it would send again after a restart (O10); and what
is in flight, sorted by name, a document sent twice named
twice.

## Read by a second implementation

Twice a fresh session was given this page and the steps of the traces
without results, and wrote the transition in Rust: once for O1 to O7 (three
traces), once for the page with O8 and O9 (five traces). Each program
equals the rule at every step of every schedule: the first on the nine
orders of an accepted enactment (72 steps, six orders it had not seen), the
second on all 6 906 schedules (95 551 steps). What they had to decide is on
the page now: the words "take" and "hold back", the early receipt in O6,
what `open` and `declined` mean in a trace, and the wording of O9, whose
first sentence had contradicted its table.

## Stated, not pinned

- O8, that the responder drops what it holds back: in every schedule the
  responder holds nothing when `decline` arrives, because the inviter sends
  its issue only when its person accepted. The model drops the list; no
  trace or walk tells that from leaving it.
- O7: both parties of every trace send a card.
- The inviter holds back an `issue-responder` that arrives before its
  person accepted, as the responder does in O5, and takes it in the step of
  the acceptance, after `accept` and `issue-inviter` are sent. No honest
  schedule reaches this: the responder issues only after the acceptance.
- O-P1 is what O6 gives if the checks of the ceremony hold; the model has
  no document that fails a check.

## Not in the model

An error of the other side that is not a decline; a second proposal on the
same handle; the offline back-code; several devices of one person. The
time rules are `../freshness/FRESH.md`.

## Against the library

`lib-run.ts` runs the traces against the published library with two
holders and carries the documents one by one. At every step of every
trace, of each of the ten schedules without a redelivery, and of the 6 896
schedules with one redelivery at any point, the library sends the same
documents, the same side holds a contact, the same documents are held
back, and the outbox is the same. A document sent again has the content of the first. The test runs
300 of the 6 896; all were run once by hand (eight minutes).

## What follows for recognition

Two enactments between the same two people can complete in opposite order
on the two sides (O-P3). The tuples then open in opposite order, which is
the schedule of the trace `crossed-opening` on the recognition page.
