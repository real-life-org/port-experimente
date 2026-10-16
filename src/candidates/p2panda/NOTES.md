# Port notes: p2panda

As of 3 October 2026. `p2panda-spaces` 0.7.1 (with `p2panda-auth`,
`p2panda-encryption`, `p2panda-core`) as WebAssembly via
`rust/p2panda-wasm`. Patched copies under `rust/p2panda-wasm/vendor/`
(only feature definitions and `web-time` instead of `std::time`, see
there). No server: all messages go over the bench network to everyone.
One device per person.

## Results

| | Result | Reason |
|---|---|---|
| S1 | passed | |
| S2 | passed | removal creates a new secret; Carol reads nothing new |
| S3 | passed | |
| S4a | passed | Bob's concurrent entry stays **visible** to Alice and Carol: strong removal applies to group operations, not to content encrypted with the old secret (like the "content residual" in RLTP Gen 3) |
| S4b | failed | **finding 1**: after simultaneous removals one of the removed keeps reading |
| S4c | passed | mutual removal: both out, everyone agrees |
| S4d | not applicable | no rotation without a membership change (`SpaceUpdate` not implemented in 0.7.1) |
| S4e | not applicable | no group policy (fixed levels Pull/Read/Write/Manage) |
| S4f | passed | Mallory's chain (x, y) becomes invalid transitively |
| S5 | not applicable | devices as nested groups exist, not yet wired in the bench |
| S6 | passed | the welcome message carries the previous secrets (see finding 2) |
| S7 | not applicable | no rotation, no attacker access wired |
| S8 | passed | an admin removes without the founder |

S9 (30 members, 500 authority operations) aborts as soon as the space has
four removals behind it (finding 2). Until then 70 to 100 ms per operation
(Node, headless Chrome 145).

S9b (10 members, 100 encrypted entries): 7.5 s in Node, so **8.3 ms per
device and received message** (plaintext 0.06 ms). The cost per device
grows roughly linearly with group size (5 members 4.5 ms, 10: 6.7 ms,
20: 16 ms per device and message). Conjecture, not profiled: after every
message the whole space state is serialized and stored (as p2panda's
SQLite store does too).

## Findings

1. **Simultaneous removals of different people let a removed member keep
   reading.** Alice removes Carol, Bob removes Dave at the same time. Each
   distributes a new secret to the members as they see them, so also to
   the person the other one removes. After merging, the membership is
   right ({Alice, Bob}), but the group keeps encrypting with a secret that
   Carol or Dave knows (which of the two changes between runs). p2panda
   does not require a repair. Admitting does not heal it (no new secret),
   only the next removal does. Reproduced natively:
   `rust/p2panda-wasm/tests/peer.rs`,
   `befund_gleichzeitige_entfernungen_einer_liest_mit`.
2. **After four removals the space can admit nobody.** The welcome message
   to a new member carries all previous group secrets (for the history);
   every removal adds one (about 150 bytes). `p2panda-core` decodes
   headers only with byte sequences up to 512 bytes (`operation/any.rs`,
   `length_limit(512)`). From the fourth removal on, the new member rejects
   its own admission message. This also applies to re-admission. Open:
   whether apps stay below the limit by deleting old keys (intended for
   forward secrecy according to the README). Natively:
   `befund_aufnahme_scheitert_nach_mehreren_entfernungen`.
3. **Little was missing in the browser.** Storage traits without SQLite
   (features) and `web-time` instead of `std::time`. After that
   `p2panda-spaces` runs unchanged in WebAssembly.

Both findings go to p2panda only after Anton's decision.

## Answers to the seven questions

- **Ordering:** the app must provide it. `Manager::process` expects
  messages "signature-checked, dependency-checked & partially ordered". The
  wrapper verifies the signature, stores, and holds messages back until
  their dependencies (`auth_dependencies`, `space_dependencies`,
  `auth_message_id`) are processed. In the full stack `p2panda-stream`
  does this.
- **Storage:** five traits (spaces, space messages, groups, key registry,
  key secrets) plus `Transaction`. The app stores the states returned by
  `create_space`, `add`, `remove`, `publish` and `process` itself and
  thereby keeps the transaction boundary.
- **Identity:** an Ed25519 key per peer (actor id = public key), plus
  X25519 pre-keys. Mapping to did:key: still open.
- **Transport:** one message kind, signed p2panda operations (header with
  spaces arguments). All messages to everyone; key bundles must be present
  before admission.
- **Authority:** group CRDT with fixed levels; conflict resolution via an
  exchangeable resolver (`StrongRemoveResolver`). Promotion is known to
  `p2panda-auth` (`Promote`), `p2panda-spaces` does not offer it; the role
  is assigned on admission.
- **Keys:** DCGKA in the data scheme: a new secret on every removal,
  distributed via direct messages inside the membership message. No
  rotation without a membership change.
- **History:** via the welcome message (all secrets), not via the replica.
  That is exactly the point Access §9.7 wanted to defer for P3, and the
  cause of finding 2.
