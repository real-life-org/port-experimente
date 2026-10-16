# Port notes: WoT Gen 2

As of 3 October 2026. `@web_of_trust/core` 0.6.0 and
`@web_of_trust/adapter-yjs` 0.3.0 from npm, `InProcessLogBroker` as the
relay in process (test broker, deviates from the real relay, see below),
`OutboxMessagingAdapter` in front of messaging as in the RLS. One device
per person.

## Results

| | Result | Reason |
|---|---|---|
| S1 | passed | |
| S2 | passed | the relay locks the old key generation; Carol reads nothing new |
| S3 | passed | Bob writes offline, the edit is delivered after catch-up |
| S4a | passed | Bob's concurrent entry carries the old generation and is discarded |
| S4b | failed | Bob is promoted, but `adapter-yjs` 0.3.0 sends no `admin-add` to the broker; his `space-rotate` is not accepted (see finding 1) |
| S4c | passed, **formally** | for the same reason Bob cannot enforce; concurrent enforcement does not happen at all. Bob himself sees a stale membership afterwards |
| S4d | not applicable | no rotation without a membership change (private) |
| S4e | not applicable | no group policy |
| S4f | passed, **formally** | Mallory's chain never comes into being offline (no delivery without relay); the removal is not checked against an existing chain |
| S5 | not applicable | second devices go through the PersonalDoc, which is a singleton in the process. Sharing storage would mean bypassing exactly that path |
| S6 | passed | the invitation carries all generation keys and a snapshot |
| S7 | not applicable | no public rotation; attacker access to the inbox not wired |
| S8 | failed | as S4b: the relay never learns of Bob's promotion; without Alice nobody removes effectively, Dave keeps reading |

S9 (30 members, 500 operations): Node 15.6 s, of which 7.2 s waiting for
quiescence; headless Chrome 145 13.4 s, of which 7.2 s waiting. Active
time roughly 6 to 8 s, so about 12 to 17 ms per operation (plaintext: 0.04
to 0.08 ms). A lower bound, because work also happens while waiting.

## Findings

1. **Promoted admins cannot enforce: a gap of the implementation, not of
   Gen 2.** Sync 005 requires an `admin-add` to the broker on promotion,
   signed with an existing admin key (`wot-spec/03-wot-sync/005-gruppen.md`,
   "adding new admins"). The real `wot-relay` processes `admin-add`.
   `adapter-yjs` 0.3.0 deliberately does not send it ("NO admin-add broker
   send (non-goal)" in `promoteToAdmin`). Consequence, also in the RLS:
   only the founder can remove effectively. The `InProcessLogBroker`
   additionally has no handler for `admin-add`; the bench would show it
   even after a fix in the adapter only with a matching broker.
2. **The bench does not model concurrent enforcement for Gen 2.** Gen 2
   has a relay; by the partition convention only one side stays online.
   S4b and S4c are therefore one-sided. Even with `admin-add` the relay
   would order (strictly `gen+1`, the second gets `GENERATION_TAKEN` and
   rebuilds). Concurrency exists in Gen 2 only as "noted offline, enforced
   serially later".
3. **No group without a relay.** Devices not attached to the relay cannot
   talk to each other (no P2P).
4. **Rotation is tied to membership.** There is no rotation "just so"; PCS
   after a captured device cannot be established.

## Deviations of the InProcessLogBroker from the real relay

The bench uses the test broker from `@web_of_trust/core` 0.6.0, not
`wot-relay`. Known differences:

- `present-capability` is not checked cryptographically, only noted as a
  scope.
- `admin-add` and other unknown frames are acknowledged with an empty
  receipt and no effect.
- Inbox store-and-forward lives in the `InMemoryMessagingAdapter` (static
  queue), not in the broker.

A run against the real relay (`packages/e2e-log-sync`: `RelayServer` with
`:memory:` SQLite over WebSocket) would be the next step, if one of these
points becomes relevant for the port decision.

## Answers to the seven questions

- **Ordering:** the relay orders rotations totally (`gen+1`), content runs
  as log entries per device with `seq`; the adapter buffers itself
  (blocked-by-key, catch-up).
- **Storage:** DocLogStore (log, deviceId, pending removals), CompactStore
  (snapshots, unlogged edits), KeyManagement (generation keys), metadata.
  Four stores per device.
- **Identity:** did:key (Ed25519), X25519 for ECIES; DID resolver for other
  members' keyAgreement.
- **Transport:** two paths. Inbox (space-invite, key-rotation,
  member-update; ECIES per recipient) and log sync over the relay
  (log-entry, sync-request, space-register, space-rotate,
  present-capability).
- **Authority:** rules in the client (`_members` events, higher generation
  wins, on a tie `removed`), enforcement at the relay (admin set from
  `space-register`, extended per spec by `admin-add`; generation lock). No
  hook for foreign rules.
- **Keys:** an admin generates the new group key (AES-GCM) and distributes
  it by ECIES to every remaining member; own devices via the PersonalDoc.
  Two phases: note, relay confirms, then commit.
- **History:** the invitation carries all previous generation keys and an
  encrypted snapshot; afterwards catch-up over the relay log.
