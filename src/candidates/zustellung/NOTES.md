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
| `tsp-direct-connection` | TSP Rev 3 direct, form (b) of E11b | the recipient's connection DID (carrier-scoped per relationship and side) | the sender's connection DID (its account) |
| `tsp-direct-egress-session` | TSP Rev 3 direct, form (a) of E11b | the recipient's connection DID | the sender's egress identity (own session) |
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
  `forward` in the bench: only once an intermediary sits in the bench.
  Against the live VTI mediator, routed TSP is measured in "E11b live"
  below.
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

## E11b live (21 October 2026)

Live probe of Rev 3 routed TSP against the VTI mediator, step 1 of E11b
(`tests/zustellung-live.test.ts`, code in `src/lab/zustellung-live/`,
offline tests `tests/zustellung-live-{parser,contract,protocol}.test.ts`).
The probe shows positively whether a form is carried and measures costs
and what the mediator sees; it does not explain why a form is not shown.
Live runs are not part of the report and create no matrix cell.

**Run:** 2026-10-21, 08:37:34Z to 08:59:03Z UTC. Instance
`did:webvh:QmR5xG…diator` (shortened as in the protocol: first 16, last
6 characters; the default `MEDIATOR_DID`), document `versionId`
`2-QmZPSfHt` (number and first 8 hash characters, as in the protocol),
socket host `mediator.vtc.storm.ws`.
Libraries: `@openvtc/vti-tsp-js` 0.3.0, `@openvtc/vti-didcomm-js` 0.12.0,
`@real-life/trust-protocol` 0.3.2, Node 24.21.0. Settings: 3 runs, window
and ack deadline 20 s, post-observation 30 s, all forms. Protocol JSON:
`.cache/e11b-live/2026-10-21T08-59-02.896Z.json` (local, gitignored).

Forms (inner sender / outer sender / socket): D-c direct connection /
– / connection; D-es direct egress / – / egress session; D-e direct
egress / – / connection; R-cc routed connection / connection /
connection; R-c routed egress / connection / connection; R-es routed
egress / egress / egress session; R-ce routed egress / egress /
connection. Routed: inner layer to the receiver's connection DID, outer
layer `packRouted` to the mediator DID with `route = [receiver]`, sealed
to the mediator's first `keyAgreement` (`#key-1`). R-c' was not measured:
the `TSPTransport` service names a URL, no own VID or key
(`no-own-target`).

| Form | Stage | Transport | Contract |
|---|---|---|---|
| D-c | 0 | carries (12/12 positive) | carries (12/12) |
| D-es | 0 | carries (12/12) | carries (12/12) |
| D-e | 0 | not shown (0/12) | not shown (0/12) |
| R-cc | 0 | carries (12/12) | carries (12/12) |
| R-c | 0 | carries (12/12) | carries (12/12) |
| R-es | 0 | carries (12/12) | carries (12/12) |
| R-ce | 0 | not shown (0/12) | not shown (0/12) |

12 rows = 3 runs × 2 relationships (A–B, A–C) × 2 directions. Transport =
64-byte probe received, opened, type `direct`, payload byte-equal.
Contract = sealed delivery document received as `unique` and a signed
`delivery-ack/0.1` verified at the sender within the deadline (sender
state `accepted → delivered`). The controls match the binding
measurement of 17 October (D-c and D-es carried, D-e not shown); no
baseline deviation.

**Probe outcome:** threshold reached (R-c and R-es carry in transport and
contract on stage 0). Stage 1 (mediator handshake) was not run: routed
forms carried on stage 0.

**RT1, observed delivery.** In the carried forms every frame arrived on
the receiver's connection socket within the window, as the inner TSP
packet byte for byte (`inner-bytes-equal` in all 72 routed rows, never
the outer layer). No unassigned frame, no control frame. In D-e and
R-ce nothing arrived on any socket; the sessions of each of these two
form passes counted 24 DIDComm problem reports (code class `e.p.*`), as
many as TSP frames were sent in that pass; no other form pass counted
any. Which socket received them and what the code says is not recorded
(fixed lists only). DIDComm status
messages: 228 over the whole run.

**RT2, inner VID ≠ socket DID.** R-c carries with the inner sender =
egress identity and the outer sender = connection DID (the socket's
authenticated DID); R-es carries with both = egress identity on its own
session. R-ce (outer sender = egress identity on the connection socket)
was not shown, as D-e was. The receiver opened the inner frame under the
partner's egress key in R-c and R-es.

**RT6, what the mediator sees (offline fact plus live).** After opening
the routing layer the mediator reads the inner sender and receiver from
the inner envelope (`decodeEnvelope`; offline test in
`zustellung-live-parser.test.ts`). In R-c it therefore sees per
relationship and side the connection DID (login, socket, outer sender)
and the egress identity (inner sender); in R-es the egress identity for
all three plus a second login under the connection DID for pickup.
Sizes (inner / outer): probe 393 B / 801 B and document 1539 B / 1947 B
in every send; acks 1560 or 1563 B inner, 1968 or 1971 B outer (1560 /
1968 B: two acks in R-cc, one in R-c, three in R-es); the routing layer
adds 408 B to every frame. Alice's two relationships share
no DID in any form (per-relationship derivation). **RT6-G:** the partner
opens frames whose sender is the connection DID only in D-c and R-cc; in
D-es, R-c and R-es it sees only the egress identity.

**RT7, costs.** Logins: 48 attempted, 48 succeeded (estimate 48: 7
forms × 4 connection identities, 2 forms × 4 egress identities, 3
delete-to-ack forms × 4 fresh sessions). Sessions per relationship on
the sending side: one in D-c, D-e, R-cc, R-c, R-ce; two in D-es and R-es.
Sockets opened 48, at most 8 at once. Bytes over the whole run, per
direction: out 686 292 B on the socket, of which 309 888 B TSP (binary),
376 404 B other (DIDComm: live-delivery changes, pickup acks, logins
excluded since HTTP); in 735 192 B on the socket, of which 279 552 B TSP
as base64url text (209 664 B logical), 455 640 B other. Per form pass
(4 identities, 3 runs) the TSP share out: D-c 41 928 B, R-c 56 625 B,
R-es 56 619 B; the non-TSP share in: D-c 73 752 B, R-c 72 984 B, R-es
79 840 B (four more sessions). Latency send → receipt (median / max of
12): D-c 121 / 152 ms, D-es 166 / 215 ms, R-cc 120 / 126 ms, R-c 125 /
212 ms, R-es 174 / 208 ms. Document sent → ack received at the sender
(handler entry, before decryption and proof check): D-c 263 / 282 ms,
D-es 309 / 359 ms, R-cc 262 / 289 ms, R-c 300 / 361 ms, R-es 336 /
404 ms. Document sent → ack verified was not measured in this run (gate
review 1 C4); the probe records it from the next run on. Three runs are
three samples, not a distribution.

**Delete-to-ack (observation only, D-c, R-c, R-es).** After closing all
sessions, a fresh session per connection identity saw no frame within
30 s. That is no proof of deletion: the pickup ack is best effort.

**RT8.** Stage 1 not executed (not needed); no XRFI sent, no XRFA/XRFD
observed. The mediator carried routed frames without a TSP relationship
handshake in this run.

**Key binding:** confirmed (inner packets opened in every routed form
that carried); routing key `#key-1`, fingerprint `bc0974f7`.

**Not answered by step 1:** RT3 foreign inner sender, RT4 ack loss and
trias, RT5 peer change with referral, T1–T12 on the routed wire (step 3,
intermediary in the bench); causes of any non-delivery (D-e, R-ce);
whether the mediator checks the inner VID; internal checks, storage,
analysis in the mediator and network metadata (IP, concurrent logins);
delivery paths other than the pickup socket; a general handshake duty
and the receiver handshake of Rev 3 §7.2.2; give-up bound,
`delivered(late)`, queue deletion; peer-change costs and latency or loss
distributions.

A second live run was a smoke test before this one (D-c only, 1 run, 8
logins, same instance, 08:36Z): D-c carried in transport and contract.

**Probe changes after this run (gate review 1, no new live run).** The
run above used protocol schema `e11b-live/1`. Since `e11b-live/2`:
each form pass fixes an end of observation; callbacks entering after it
was fixed are listed under `events.afterClose` and never counted.
Callbacks in flight are awaited before the sockets close and before the
result is frozen, until none is in flight over a full event-loop turn
(gate review 2 C1, 9d1adb0). "In flight" covers, beyond the TSP
handler, the processing of every inbound frame in a session (the
library's DIDComm unpack and the status, problem-report and frame-error
counters it feeds, registered from the moment the frame arrives, gate
review 3 C1) and every pickup ack, including the ones the library
starts detached after a delivered DIDComm message, a redelivery or a
refused frame (gate review 4 C1). If that wait runs out of time, the run
is invalid (`settle-timeout`). From then on a TSP handler still running
changes no probe state and sends neither an ack nor a pickup ack, a
pickup ack still being packed is not sent, and the session changes none
of its counters (bytes, DIDComm types, problem codes, frame errors,
consumer failures); decryption or encryption already started may still
finish, without effect. Late failures are discarded. A pass that ends
early, by that settle timeout or by an error (send, pack, evaluation),
takes the same end: it settles, closes and is still evaluated, every
probe and document registered so far has its row and every ack its
resolvable `docRow`, the run is invalid with the error's class, and the
fresh delete-to-ack session of that pass and all later passes, stage 1
included, are skipped (gate review 3 C2, #78). Rows and acks list
every receipt (relative time, class, socket, verdict, counted, picked),
built from the final event set when the result is frozen (gate review 2
C2, 9d1adb0). Rows carry `tAckReceivedMs` and `tAckVerifiedMs`;
`costs.roundTripMs` is document → ack verified, `costs.ackReceivedMs` the
figure reported above. `costs.sizes` gives min / median / max over all
sends of a kind. Send and XRFI registers live per form pass (draft 3
§3.2). A second copy of a document or ack is `duplicate-known` and gets
no ack of its own; the first copy reserves the digest before its ack is
sent. That is a deliberate probe simplification: Delivery §6.2 would send
the kept ack again for a duplicate.

**Narrower than draft 3 §15 (deliberate).** Method and service ids are
shown only as a fragment from a fixed list (`key-N`, `keys-N`, `service`,
`tsp`, `auth`, `files`, `whois`), otherwise as a local label `m<n>` /
`s<n>`, where §15 C6 allows any fragment of `[A-Za-z0-9._-]` up to 64
characters. `versionId` is shown as number plus the first 8 hash
characters, not in full. Both only drop detail; the run above needed
none of it.

## E11b step 2: direct forms (21 October 2026)

The two direct send forms of the E11b plan (§2) as wires of the bench,
next to the `tsp` reference wire, so the forms stand in one table
(`src/candidates/zustellung/tsp-direct*.ts`, tests
`tests/zustellung-direct-forms.test.ts`, seed sweep
`tests/zustellung-direct-seeds.test.ts`). Per relationship and side a
connection DID and an egress identity, carrier-scoped as in the binding:
the derivation and the gate against the lib's `carrierScopedIdentity`
come from step 1 (`src/lab/zustellung-live/identities.ts`), with root =
the party's wire seed and nonce = SHA-256 of the peer's rkid. Frames are
TSP Rev 3 direct to the partner's connection DID; the forms differ only
in the sender.

- **(b) `tsp-direct-connection`:** the sender is the connection DID, the
  account at the carrier (its session and its address).
- **(a) `tsp-direct-egress-session`:** the sender is the egress identity,
  which holds a session of its own at the carrier.
- **Spec form (control, not in `wires`):** the egress identity as the
  sender without a session of its own (adapter spec §5a.10).

**Sessions.** The bench carrier knows registrations (device, address); a
session is the registration of an identity. `SessionCarrier`
(`src/lab/zustellung-sessions.ts`, a subclass; the shared core
`src/lab/zustellung.ts` is unchanged) adds the rule the live mediator
showed: a frame is forwarded only if its envelope sender holds a session
at the carrier, otherwise it is dropped silently. The bench has no socket
per deposit, so the rule reads "the envelope sender holds a session here";
for the forms modelled here that equals "the envelope sender is the
socket's identity" (a sender either sends on its own session or has
none). T9, T10 and Z1 to Z5 run on the default carrier (no rule), as for
every wire; the session rule runs as its own cells: one document from
Alice to Bob and Bob's receipt back, both under the rule.

| Form | Sessions per relationship | Bytes per document (20 seeds) | Z1: sender's account in the frame | T9, T10, Z1–Z5 | Under the session rule |
|---|---|---|---|---|---|
| `tsp` (reference: one did:key per relationship and side, the address) | 2 (registrations) | 1491–1494 B | the sender's VID is its address | all passed | delivered |
| (b) `tsp-direct-connection` | 2 | 1491–1494 B | **visible**: sender = connection DID | all passed | delivered |
| (a) `tsp-direct-egress-session` | 4 | 1491–1494 B | **hidden**: sender = egress identity | all passed | delivered |
| spec form (control) | 2 | 1485–1488 B deposited | hidden | not run (not a wire) | **dropped** at the carrier, Bob sees nothing, Alice `failed(expired-by-adapter-policy)` after the give-up bound |

Bytes: the document frame in Z1 (payload `geheim-drei`); in the session
cells the document frame is 1485–1488 B and the receipt 1560–1563 B for
all three wires (the sealed document varies by a few bytes through
base58 proof values). For identical payloads of 1000, 1001 and 1002 bytes
all three wires produce the same frame size: the forms cost no bytes,
only sessions.

What it shows:

1. **The two forms are equal at the dispatcher and the receiver.** T9,
   T10, Z1 to Z5 pass on both, with the same bytes; Z4 (foreign sender) and
   Z5 (wrong recipient key) are rejected at the wire, as on `tsp` (outer
   signature against the expected sender key, own key per relationship).
2. **Z1, what the partner opens.** In (b) the sender of every frame is the
   sender's connection DID; in (a) the frame never contains the sender's
   connection DID (byte search), only the egress identity. **But in both
   direct forms the partner delivers its receipts to the sender's
   connection DID: it knows the account as the delivery address.** (a)
   hides the account as the sender of a frame, not from the partner.
   Alice's two relationships share no DID in either form.
3. **Sessions are the price of (a):** 4 sessions per relationship against 2
   in (b) (and 2 registrations on `tsp`).
4. **The session rule is what separates (a) from the spec form.** Under the
   rule the spec form is dropped silently at the carrier (no disposition at
   Bob, so not a wire rejection), and the dispatcher never ends silent: it
   stays `accepted`, repeats after `ackWait` (each repetition dropped too)
   and gives up after 12 rounds. Without the rule (default carrier) the
   same wire passes; that is why it is not a registered wire.
5. **Parser rule (#95, MV-24).** After `unpack` the wire checks revision,
   sender and receiver against the expected pair, type `direct` and a
   non-empty payload; a control frame (`packInvite`), an empty `direct` and
   frames under the genuine partner's key that name another sender or
   receiver are rejected at the wire and counted as `failed(malformed): tsp:
   …`, never passed to `receive`.
6. **Branches and seeds.** The wires make no random decision (no
   `CoinBranches`); chance enters only through keys, nonces, UUIDs and HPKE.
   The seed sweep runs every cell of the table above under 20 fixed seeds
   (generator of `tests/mehrgeraet-seeds.test.ts`); all 20 give the table.

Not modelled: a socket per deposit (the rule is per sender, not per
socket), the mediator's login and its handshake, what the mediator links
across the two sessions of (a) (live: "E11b live", RT6), routed forms
(step 3).
