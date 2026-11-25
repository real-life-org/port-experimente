# shared-connect as RLTP runs it: where each part is written down

The ceremony
[`shared-connect` 0.1](https://github.com/real-life-org/trust-protocol/blob/main/interop/ceremonies/shared-connect.ceremony.json)
defines the documents two parties exchange, their proofs and their checks.
What a party does with them on its own side is not in the definition. The
pages below state that for RLTP, each written from what the library does
and checked against it by the tests named there. Library: rltp-lib 0.20.0.

| Step in the life of a contact | Page | What it settles |
|---|---|---|
| A link is shown or sent, a proposal comes back | [`freshness/FRESH.md`](freshness/FRESH.md) | how long a link lives; when a proposal is taken; how long an enactment that is not complete is kept |
| Acceptance or decline, the two credentials and their receipts | [`tuple-opening/OPENING.md`](tuple-opening/OPENING.md) | at which step each side opens its tuple and shows a contact; documents that overtake each other; a decline; a document handed over again; what is sent again after a restart |
| The contact is there | [`met/MET.md`](met/MET.md) | the channel each side states; whether the two met; that only a contact that met can be trusted |
| The same two people connect again | [`wiedererkennung/RECOGNITION.md`](wiedererkennung/RECOGNITION.md) | when two tuples become one relationship, on several devices; this is the rule for Trust 0.32, which the library does not implement yet (its page says where the library stands) |

## How the pages hang together

- The opening of a tuple (OPENING, O6) is the moment recognition starts
  on it: its candidates are fixed then (RECOGNITION, R1).
- Which side opens first depends on the order of delivery (OPENING, O-P3).
  Two enactments between the same people can therefore open in opposite
  order on the two sides, the schedule `crossed-opening` of RECOGNITION.
- A contact from a link is upgraded by meeting later only through the
  union of the two tuples (MET, M-P2; RECOGNITION).
- The thirty days an open enactment is kept (FRESH, F4) are each side's
  own: one side can hold a contact the other never got (FRESH, F-P2).

## Not written down yet

- Connecting without a network. The app does not use shared-connect then:
  with no carrier it shows the card of `encounter-scan`, and the other side
  shows its answer back as a second code (Encounter 0.32 describes that
  ceremony). A contact from it met (MET, M3). The offline form of
  shared-connect itself, the proposal shown back as a code, is built and
  read by the library (`vectors/shared-connect.json`), but its holder does
  not offer it and the app does not use it; with a party of another app
  there is no offline way today.
- A party without a card (another app): the enactment completes and the
  credentials are kept, without a tuple (OPENING, O7, stated and not
  pinned).
- An error of the other side that is not a decline.
- The messaging identity of an enactment (a `did:peer` per enactment,
  derived from the challenge).
- What an app shows for an enactment that expired, was declined or failed.
- Several devices of one person inside one enactment.
