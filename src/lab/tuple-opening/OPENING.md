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
the six documents can be delivered, the inviter opens first in five and
the responder in four (`tests/tuple-opening.test.ts`).

## The documents

Six documents per enactment, named here by step and sender:

| Name | From → to | In the ceremony |
|---|---|---|
| `propose` | responder → inviter | step `propose` |
| `accept` | inviter → responder | the `#response` of `propose` |
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
both roles. From that step on the side shows a contact; `open` in a trace
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

## The steps of a trace

- `{ "act": "propose" }`: O1, the responder's part.
- `{ "act": "accept" }`: O2.
- `{ "deliver": "<name>" }`: the carrier hands the document to the side it
  is for. A document is delivered once.

Every step records `sent`, the documents the step put in flight, in the
order they were sent, and `after`: per side whether its tuple is open and
which documents it holds back, and what is in flight (sorted by name).

## Read by a second implementation

A session that was given this page and the steps of the three traces
without results wrote the transition in Rust. Its output equals the rule at
every step of the three traces and of all nine schedules, six of which it
had not seen. The two words at the head of the rule, the early receipt in
O6 and the meaning of `open` come from the list of what it had to decide.

## Stated, not pinned

- O7: both parties of every trace send a card.
- The inviter holds back an `issue-responder` that arrives before its
  person accepted, as the responder does in O5, and takes it in the step of
  the acceptance, after `accept` and `issue-inviter` are sent. No honest
  schedule reaches this: the responder issues only after the acceptance.
- O-P1 is what O6 gives if the checks of the ceremony hold; the model has
  no document that fails a check.

## Not in the model

A document delivered twice (the ceremony answers it with what it sent the
first time); a decline; an error of the other side; expiry of the link; a
second proposal on the same handle; what a side does after a restart; the
offline back-code; several devices of one person.

## Against the library

`lib-run.ts` runs the traces against the published library with two
holders and carries the documents one by one. At every step of every trace,
and of each of the nine possible schedules, the library sends the same
documents, the same side holds a contact, and the same documents are held
back.

## What follows for recognition

Two enactments between the same two people can complete in opposite order
on the two sides (O-P3). The tuples then open in opposite order, which is
the schedule of the trace `crossed-opening` on the recognition page.
