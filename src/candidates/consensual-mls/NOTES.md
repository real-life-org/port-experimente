# Port notes: a room model rebuilt (E14b)

As of 15 October 2026. The counterpart to `rltp-mls`: the same MLS wrapper
(`rust/mls-wasm`, OpenMLS 0.9.1, ciphersuite 0x0001), but **no authority
log**. Membership is the tree, one leaf per device, the way a room is run
in the model we compare against (source: `rltp/design/mls-abgleich-consensual-2026-10.md`,
sections 2, 4.1, 5, private). Two committer modes, as that room policy
knows them:

- **`any-staged`** (`consensual-mls-any-staged`): every member commits
  itself. On simultaneous commits the smallest hash wins (the contract from
  E13, the same tiebreak as theirs), the loser re-stages its intent on the
  new epoch (`intents`, `restage`). No time window: the bench has no clock;
  what would be a fork after the window in their model is resolved here by
  the rollback of the E13 contract.
- **`owner`** (`consensual-mls-owner`): only the founder commits; members
  send proposals (`propose`), the founder carries them out, never against
  itself. A member's rotation (S7, KV5) is not an own commit either but an
  MLS update proposal (RFC 9420) that the founder commits
  (`proposeUpdate`/`commitPending` at the port; review of #40). That is the
  model of the OpenVTC rooms and of the registry (`rooms/*`: owner as the
  sole committer).

What this model deliberately does **not** have: policy (no `policy`),
roles as a rule (`roles` is only declared so the scenarios run; an empty
`admins` list in their terms), history for newcomers (entries are sealed
under the exporter of their epoch, a newcomer reads nothing from before),
a service, gap repair, fork detection as state.

## Results

Three runs per mode (15 October). "hash-dependent": the result changes
from run to run because the smallest hash decides. For comparison
`rltp-mls` (log + MLS): all S/T passed except S10 blind, T6b blind,
T8/T11.

| | any-staged | owner | rltp-mls | Reason |
|---|---|---|---|---|
| S1–S3 | passed | passed | passed | |
| S4a | passed | passed | passed | the removed reads nothing after the merge |
| S4b | passed | passed | passed | two removals: the loser re-stages |
| S4c | passed (one stays, the hash decides) | passed (the founder stays) | passed (both out) | A4a only demands agreement |
| S4c2 | failed | failed | passed | the winner reads Carol's concurrent entry (LEAK) |
| S4d | passed | passed | passed | |
| S4e, S4j | not applicable | not applicable | passed | no group policy |
| S4f | **hash-dependent** | passed | passed | whether Mallory's chain (x, y) stays is decided by the hash; in owner mode her proposals do not count |
| S5 | failed | failed | passed | a second device reads neither old nor new (finding "without history no CRDT") |
| S5b, S5c | passed | passed | passed | |
| S6, S6b | failed | failed | passed | no history; even the next entry stays unreadable |
| S7 | passed | passed | passed | PCS via rotation |
| S8 | passed | failed | passed | without the founder no removal, Dave keeps reading |
| S10a–c | not applicable | not applicable | with a view service | no service |
| S11 | not applicable | not applicable | passed | |
| T1 | failed | failed | passed | a swallowed commit stays a gap, no repair |
| T2 | **hash-dependent** | passed | passed | if Alice's admission loses, her entry is lost for Bob |
| T3, T4, T7, T12 | passed | passed | passed | |
| T5 | failed | failed | passed | a damaged frame is discarded, not repaired |
| T6, T6b | failed | failed | T6 passed, T6b with a view service | withholding goes unnoticed |
| T8, T11 | not applicable | not applicable | not applicable | |

## Findings

- **Without history there is no CRDT.** A newcomer (S5 second device,
  S6/S6b) not only fails to read the old entries (expected in this model),
  it also reads **no new one**: Yjs updates reference the entry before them
  (inserting "after" an element), and that element is missing. It decrypts
  the new entry but cannot integrate it. For lines that are independent of
  each other (a chat) this never surfaces; for shared state (a map, a
  calendar, a board) KV4 is not a comfort but a precondition. A "CRDT over
  MLS" layer cannot work without an epoch chain (OpenVTC
  `rooms/epoch/chain`, our predecessor table).
- **Lapsed epoch, lost content.** If a commit loses the tiebreak, entries
  sealed under its epoch are unreadable for everyone else (T2: Bob never
  reads Alice's entry). `rltp-mls` re-seals them; this model has no place
  for that (lines are merged by line id, not re-sealed).
- **The hash decides over power.** S4c (mutual removal): one stays, which
  one is decided by the hash. S4f (a removed member invites concurrently):
  whether the removed member's chain stays is decided by the hash; the
  result changes from run to run. With us the matrix decides, the same in
  every run.
- **Confidentiality after removal (S4c2).** Whoever wins the mutual removal
  reads the third party's concurrent entry; with us neither of the two
  reads it.
- **Owner mode.** Without the founder nothing happens (S8: Alice offline,
  Dave's removal stays pending, Dave keeps reading). A member cannot even
  add its own device, it has to propose. That is the model of the OpenVTC
  rooms (owner with an always-on VTA).
- **No repair, no attestation.** A swallowed commit (T1) stays a gap, a
  withheld entry (T6, T6b) goes unnoticed. These are service questions that
  such a model delegates to its relay.
- **What works equally well:** S1–S3, S4a (the removed reads nothing after
  the merge), S4b, S4d, S5b/S5c in any-staged mode, S7 (PCS via rotation),
  T3 (duplicate delivery), T4 (replay), T7, T12.

## What the experiment is meant to show

Not that the model is bad, but **where exactly** it differs from a
log-governed room, scenario by scenario. The table is the basis for joint
research on what groups and rooms really need.
