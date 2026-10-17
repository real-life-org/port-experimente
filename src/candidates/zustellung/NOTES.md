# Port notes: delivery (E11, 16 October 2026)

The delivery bench (`src/lab/zustellung.ts`) tests pair traffic: a sealed
document from Alice to Bob over a carrier that stores and forwards. The
candidate is the **wire**: how the sealed envelope is addressed and framed.
The **dispatcher** (sender trias per Delivery §6.1, at-least-once per §6.3,
a report before the trias) and the **receiver** (dispositions per §6.2 via
`receive` from the lib, receipt `delivery-ack/0.1` signed and kept
byte-identical) are the same code for every wire. No clock: horizons are
rounds (`HORIZON`: report after 1, retry after 3, give up after 12).

Wires:

| Wire | Frame | Address | Sender as the carrier sees it |
|---|---|---|---|
| `lab` | the lib envelope (`seal`, AES-256-GCM to the rkid), unchanged | the recipient's rkid | none (submission is principal-free, §5a.4) |
| `tsp` | TSP Rev 3 direct (vti-tsp-js 0.3.0): HPKE, outer signature | the recipient's VID (did:key per relationship and side) | the sender's VID in the cleartext envelope |
| `didcomm-authcrypt` | DIDComm v2 JWE, ECDH-1PU+A256KW (vti-didcomm-js 0.12.0) | the recipient's kid (did:key per relationship and side) | `skid` in the protected header |
| `didcomm-anoncrypt` | DIDComm v2 JWE, ECDH-ES+A256KW | the recipient's kid | none |

The identities per relationship and side derive from a seed, as in
`trust-protocol/binding/vti-wire.mjs`; the lib itself (0.3.2) does not
export its mediator adapter, so the dispatcher is written afresh here,
against the promises the port requires, not against the form of 0.79.

## Results (16 October, all wires equal unless noted)

| | Result | Finding |
|---|---|---|
| T9 receipt lost | passed | the sender repeats the same bytes after `ackWait`; the receiver answers `duplicate-known`, effect once, receipt re-sent byte-identical; `delivered`, not `late` |
| T10 device offline, carrier unreachable | passed | report after one round: `awaiting-transport(offline)`, then `(transport-unreachable)`; a receiver offline is `accepted` for the sender (the carrier has it); then `delivered` |
| Z1 what the carrier learns | passed | no content, no anchor, no name. lab: rkid, 668 B. TSP: sender and receiver VID, 996 B. DIDComm authcrypt: `skid` and kid, 2562 B; anoncrypt: kid only, 2209 B |
| Z2 carrier switch | passed | what is waiting (`awaiting-transport`) goes out on the new carrier; the relationship (rkid, anchor) stays; the wire needs no renegotiation |
| Z3 multiple devices | passed | two devices under one address: the carrier holds the frame until every registered device has confirmed; both acknowledge, the sender takes the first |
| Z4 foreign sender (to Bob's unchanged recipient key, only the sender is foreign) | passed | lab and anoncrypt: the frame opens, the document fails on its proof (`failed(proof-invalid)`); TSP: the outer signature against Alice's key fails; authcrypt: ECDH-1PU with Alice's key fails. Both at the wire (issue #42) |
| Z5 wrong recipient key (Carol's relationship with Bob, delivered to Bob's Alice address) | passed | TSP, authcrypt, anoncrypt: own address and own key per relationship, the frame does not open (`no recipients[] entry for kid`, signature). lab: the address here is the party's rkid, not the relationship's (a bench simplification), the envelope opens, the proof fails |

## What the experiment shows

1. **The trias belongs to the dispatcher, not to the carrier (question 2).**
   No wire speaks `accepted`, `delivered` or `awaiting-transport`; all four
   produce the same row because the dispatcher speaks them: from "the
   carrier took it" (accepted), from the verified receipt (delivered), from
   its own state (report). A carrier without a storing third party (direct,
   Iroh) would change nothing about this, only `accepted` would coincide
   with `delivered`.
2. **An inbox per relationship is form, not a promise (question 1).** The
   address is per relationship (rkid, VID, kid), but the carrier needs no
   inbox per relationship: it needs "hold frames for an address until every
   registered device has confirmed". Multiple devices (Z3) are a property
   of registration, not of the address.
3. **What the carrier learns is decided by the wire (question 3).** The lib
   envelope and anoncrypt show only the recipient; TSP and authcrypt also
   show the sender, as a relationship identity, not as an anchor. That is
   DV4/DV6 measured at the wire: exactly one identity is linkable per
   relationship, none across relationships. The price of a sender in the
   frame: Z4.
4. **Sender verification: at the wire or at the document (new question).**
   TSP and authcrypt reject a foreign sender before the document is seen
   (Z4: outer signature, ECDH-1PU, both bound to the sender key Bob's
   endpoint knows as Alice's); lab and anoncrypt only at the document's
   proof, because their frame carries no sender. Both hold, but only the
   second stage is mandatory for us (§5a.4: submission without a sender;
   the proof under the anchor is the sender check). A port must not assume
   the wire check, and anoncrypt must not claim one (issue #42).
5. **Carrier switch without losing the relationship (question 4)** is cheap
   at the dispatcher, because nothing about the relationship lives at the
   carrier: register anew, resubmit what is waiting.
6. **Size.** The lib envelope is 668 B for a document of about 300 B; TSP
   adds 50 %, DIDComm triples it (JSON JWE, base64url). All far below
   MT-2240 (16 KB).
7. **Address per relationship (Z5).** TSP and DIDComm derive an own identity
   per relationship here; a frame to Bob's Carol key does not open at Bob's
   Alice endpoint. The lab wire takes the party's rkid as the address, the
   same for all relationships: a bench simplification, not the lib's form
   (Delivery §5a.2: rkid per relationship).
8. **The trias stays, the give-up bound applies (issue #43).** After
   `accepted`, an outage (device offline, carrier unreachable) does not
   revert the state; `awaiting-transport` exists only before the trias
   (§6.1). Availability is kept separately (`transport`). Two deadlines:
   before acceptance there is no giving up, only the honest report each
   round (the submission still lies with the adapter); from acceptance on,
   the declared give-up bound counts, also under a later outage. A receipt
   after `failed` means `delivered(late)`. Three regressions.

## Deliberately not tested

- A real mediator or intermediary (VTI mediator, DIDComm mediator with
  pickup): the carrier here is the model "store and forward with
  registration", the same for every wire. The live probe in
  `trust-protocol/binding` passed against the VTI mediator on 4 September;
  what a mediator additionally learns (connection DID, timings) is in
  `spec/adapter-vti-mediator.md` §9.
- Routed TSP (an intermediary on the path, `packRouted`) and DIDComm
  `forward`: only once an intermediary sits in the bench.
- Giving up and the late receipt are pinned as regressions (dispatcher),
  not as wire scenarios.

## Harness extensions for E15 (17 October 2026)

The multi-device experiment (E15, plan in the workshop repository)
reuses this bench: the carrier, the dispatcher and the wire. Four things
were added to `src/lab/zustellung.ts`; every E11 scenario above runs
unchanged with the defaults.

- **Clock.** `Device`, `sealDoc` and the receipt take a `Clock`; the
  default is the real clock, `VirtualClock` advances only on `advance`
  or `set`, `skewed(ms)` is the view of a device whose clock is off.
  Rounds and time are now independent.
- **Fault facade on the carrier.** `carrier.faults` follows the
  `CarrierFaults` pattern of the group bench: `drop` (carried, never
  delivered, in `swallowed`), `withhold` per device (the frame stays
  until the rule falls), `reverse`, `duplicate`, `reset`. The one-shot
  flags (`unreachable`, `offline`, `dropDeliveryTo`, `dropNextDeposit`)
  stay. `unregister(device)` revokes a device: it collects nothing more
  and frames that only waited for it are cleaned up. `pending(address)`
  counts what still lies at an address.
- **Store.** `Store<DeviceState>` with `commit`/`load`; `MemoryStore`
  counts commits and offers `snapshot`/`restore` for backups. A device
  with a store commits after handling a round's frames (before it
  confirms them to the carrier) and after dispatching, and before a send
  leaves (the submission is recorded, committed, then deposited). Crash
  points for tests: `crashAt = 'before-commit' | 'after-commit' |
  'before-send'`; a crashed device does nothing until `reload()`, which
  rebuilds it from the store. A receipt is recorded with the effect and
  deposited only after the round's commit (#54): while the receiver is
  down before its commit, the sender never sees `delivered`. Tests show: a crash before the commit
  loses the effect but not the frame (it is delivered again, effect
  once); a crash after the commit sees the frame again as
  `duplicate-known`; a crash before the send dispatches on reload; an
  old snapshot restored makes the device forget later submissions.
- **Key resolution per device.** `DeviceOptions.resolve` replaces the
  one-key rule `rkid === party.rkid`; a device holding several
  relationship keys opens what is sealed to any of them.

Tests: `tests/zustellung-harness.test.ts`.
