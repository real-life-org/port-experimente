# Port notes: RLTP authority over MLS (E13)

As of 14 October 2026. Third variant of the key port: the same authority,
the same frames and the same candidate code as `rltp-beekem`
(`rltpBeekem({ keyPort: 'mls' })`), with MLS (RFC 9420) via OpenMLS 0.9.1
in `rust/mls-wasm` underneath instead of BeeKEM. The interface both fulfil
is in `../rltp-beekem/keyport.ts` (`KeyPeer`, `KeyPort`).

MLS sits **below** the authority log: commits are derived from log entries
(admission, removal, rotation, healing), never the other way round (Access
§9.1). Membership is decided by the matrix; MLS yields an exporter secret
per epoch, from which the entry key per reference is derived (SHA-256 over
label, exporter, reference). The predecessor table of the sealed frames and
the gap repair are unchanged.

## Results

All S and T scenarios as for `rltp-beekem` (four runs in a row, no
flicker); expectations in `tests/rltp-mls.test.ts`.

| | Result | Reason |
|---|---|---|
| S1–S8, S4a–S4j, S5–S5c, S6, S6b | passed | as BeeKEM |
| S4b, S4d, S4j | passed | simultaneous commits: tiebreak (below), healing catches up |
| S7 | passed | PCS only via the explicit rotation; MLS does not rotate on write (BeeKEM: `updateOp` per entry) |
| S10a–c | not applicable (blind) / as BeeKEM with `rltp-mls-sichten` (S10c only with m following the new view) | service variants are independent of the key port |
| T1–T7, T12 | passed | as BeeKEM |
| T6b | failed (blind) / passed (view) | as BeeKEM (D5) |
| T8, T11 | not applicable | as BeeKEM |
| S11 | passed | KV3: the forged leaf never gains access; finding below ("forgery as a sibling") |

## What differs from BeeKEM

**Linear.** MLS knows exactly one commit per epoch. BeeKEM merges
simultaneous operations; MLS has to choose. Consequences for the candidate
(all in `index.ts` under `port.linear`):

1. **One healer per group.** With BeeKEM every member with a key heals
   (adds missing leaves, removes foreign ones); simultaneous healings
   merge. With MLS they would lose the tiebreak against each other. So only
   the member with the smallest person id among the members per the log
   **that have a leaf in the tree** heals; every person adds their own
   further devices themselves (otherwise healer and person would collide).
   That is KV6 via healing, as linear/0.1 intends. The "with a leaf" is
   necessary (review of #39): if a fork discards the removal of the
   smallest person, she is back in the log but without a leaf; were she the
   healer, nobody would re-add her.
2. **Reconcile after every commit.** A foreign commit can move the tree
   away from the log (lost tiebreak); with BeeKEM reconciling after
   authority operations and before writing suffices, with MLS `reconcile`
   also runs after every `cgka` frame.
3. **Welcome.** MLS knows no join without a welcome; it travels in the
   candidate's `welcome` frame (field `key`), encrypted to the card's
   welcome key, together with group and admission. Plus the digest of
   exactly the commit that admitted this device (field `commit`, one per
   card, not the last one of the admission): for MLS that commit is no
   longer processable after the welcome (`stale`), for the candidate it is
   the newcomer's key state (`keyOp` of its next frames, the opening gate
   for the others). A removed device (group inactive) buffers commits like
   a device without a group until a welcome re-admits it.
4. **No rotation on write.** PCS (KV5) only via `rotate`.

**Epoch choice contract** (`rust/mls-wasm/src/peer.rs`, head of the file):

1. Commits form a tree over epochs; per epoch the one with the smallest
   hash holds, the same for all replicas, independent of order; only over
   keys, never over membership.
2. Every replica keeps snapshots of the last 8 abandoned epochs. A commit
   onto an abandoned epoch is checked against its snapshot: smaller hash
   than the one applied there → roll back to that epoch, take the commit,
   `lost`; larger hash → `stale`. The same epoch number does not mean the
   same parent: if the commit cannot be applied on the state of its epoch,
   it comes from another branch, and whether that branch wins is decided
   only by its parent, which may still arrive (reordering). It then waits
   at the candidate (`pendingCgka`, retried after every change) and lapses
   only when its epoch falls out of the snapshots. Deeper than the
   snapshots reach → `stale` (no longer resolvable, a finding).
3. What is missing after a rollback is restored by healing from the log.
   Frames sealed under a lapsed epoch are unreadable for everyone else;
   their author re-seals them after reconciling (`sealed`/`stranded` in
   `index.ts`).
4. A welcome onto a higher epoch than one's own replaces one's own group
   (`reset`: it stood on a lapsed branch); everything sealed since the join
   goes out again. A welcome onto an inactive group (after removal)
   re-admits; one of equal or older epoch changes nothing.

Findings behind the contract (T2 flickered in one of four runs before it
stood):

- Alice admits Dave, Bob removes Carol at the same time. If Alice's commit
  loses, her admission (sealed under the lapsed epoch) and Dave's welcome
  are dead: Bob never sees Dave, Dave hangs on a branch nobody else knows
  (points 3 and 4).
- The same epoch number does not mean the same parent. Alice's healing
  after the rollback (epoch 3→4 on the valid branch) and her earlier commit
  on the lapsed branch (also 3→4) are not siblings; whoever compares them
  by number alone falls onto the wrong branch and never gets out (Bob:
  tree without Dave, a commit waits forever). Hence the trial application
  with rollback (point 2).
- With only one snapshot (one epoch back) a replica that had already made
  two own commits before the sibling commit would be permanently split
  off.
- The commit that admitted the newcomer cannot be recognized by epoch
  number: after a `reset` Dave took a commit from the lapsed branch (same
  number) for his own, carried it as `keyOp`, and Bob never opened Dave's
  entries. Hence the welcome carries the commit digest (point 3 above)
  instead of the peer guessing. And a removed device discarded the commit
  of its re-admission as `stale` (group inactive, same epoch): S4j, Carol
  did not see the end of the fork.
- Review of PR #39 (CodeRabbit): the failure path on the current epoch
  only popped the new snapshot, not the oldest one evicted by it, and left
  in storage what `process_message` wrote before the failure. Now the same
  checkpoint rollback as for abandoned epochs.
- Review of PR #39 (Codex): a commit from another branch counted as
  finally lapsed as soon as it was not applicable on the current epoch.
  Counter-check: the child of the winning branch delivered before its
  parent → discarded, although it fits after the lost tiebreak. Now it
  waits (point 2); native test `kind_vor_gewinnendem_vorgaenger…`.
- On the candidate side: `noteOp` was not idempotent. A repair answer sends
  old key operations again; the receiver booked them again and from then on
  carried that old operation as the `keyOp` of its frames. A newcomer that
  never applied it (with MLS, commits before the join are `stale`) never
  tried to open those frames (T2: Dave does not read Bob's entry; S4j:
  Carol does not see the end of the fork). With BeeKEM this stayed hidden,
  because there every frame comes with an operation of its own and the tree
  absorbs old operations.

## Findings

- **KV3, forgery as a sibling (S11, 16 October).** The removed member's
  state is captured immediately before the removal, on the same epoch on
  which Alice removes her (S11 checks the common parent; issue #45). The
  forgery is thereby a sibling of the removal commit. Depending on the
  hash it wins the tiebreak: then the members roll back to the old epoch,
  take the forgery, re-seal their stranded frames, and the healer removes
  both leaves of the removed member again (S11 reports "forgery won",
  epoch advances). If it loses, it is stale. Both branches are covered
  deliberately: natively (`faelschung_als_geschwister…`, a loop until both
  branches were seen) and at the candidate (the test repeats S11 until
  both branches occurred). The leaf gains access in neither branch
  (reconciling before every entry, `treeSafe`). The lever that remains: a
  removed member can force rollbacks and re-sealing with grindable hashes
  as long as its epoch lies within the snapshots (8). BeeKEM has no such
  lever (the admission is merged concurrently and healed, without a
  rollback). A leaf without a card reads nothing even as a member (K7 runs
  over cards), with both ports; MLS heals it immediately after the commit,
  BeeKEM only before the next entry (which is why S11 measures "tree +1 or
  epoch advanced").
- **Old state, deep rollback (found while building S11, 16 October).** If
  an attacker forges from a state several epochs back, the members check
  the commit against the snapshot of that epoch (up to 8 back) and roll
  back there on a smaller hash, with re-sealing and healing across all
  epochs in between (seen: three epochs). No access, but a repeatable lever
  as long as the epoch lies within the snapshots. For the port: snapshots
  should not admit commits from leaves the log has since removed to the
  tiebreak at all (check rule "the committer is a member of the epoch's
  retained set", mls-abgleich §6 (i)). Not built; noted as a finding.
- **A clone's commit locks out the original (S11, 16 October).** If a
  captured state (the same leaf) submits a commit, the real device cannot
  process it: OpenMLS accepts no message from its own leaf. The device
  stays on its epoch with `wartende-cgka` and reads nothing new, although
  its leaf is in the tree; the healer sees no reason to re-admit it. With
  BeeKEM the operations are merged. For the port: a device that stands
  behind a commit of its own leaf must get itself welcomed afresh
  (detection: own leaf index, not own operation). Not built; noted as a
  finding.
- **KeyPackage reuse.** MLS intends a KeyPackage to be single-use; the
  bench's card carries one as the share key, and a re-admission (S4j, T4)
  uses the same card. The peer puts the consumed bundle back into storage
  after the join (`restore_key_package`). In practice a re-admission needs
  a fresh card or a KeyPackage stock at the service.
- **Welcome size against RLTP-MT-2240 (16 KB).** Measured with the ratchet
  tree extension (the newcomer needs no service that holds the tree): 839 B
  at 1 member, 2.7 KB at 10, 6.5 KB at 30, about 190 B per further member;
  the 16 KB would be reached at around 80 members. Commits: 735 B to 3.3 KB
  (30 members). Sealed entry of 100 B plaintext: 184 B. Peer state at 30
  members: 47 KB.
- **Wasm size.** `mls_wasm_bg.wasm` 2.6 MB against 0.97 MB for BeeKEM.
- **Several commits before the sibling.** The tiebreak presupposes that the
  lost epoch is still held as a snapshot (8 back). A replica that collects
  commits offline for longer stays split off until it is welcomed again
  (`reset`). Did not occur in the bench.
- **S9 load.** 30 members × 100 operations: about 290 ms per operation (the
  BeeKEM candidate about a tenth); every admission is a commit over the
  whole group, and every commit is copied once as a snapshot. Hence
  `loadSize` 30 × 100.

## Layout

- `rust/mls-wasm/src/peer.rs`: `Peer` (OpenMLS group, exporter per epoch,
  snapshots, own commit digests), `rust/mls-wasm/src/wasm.rs`: `MlsPeer`
  bindings with the same surface as `beekem-wasm` (synchronous, errors as
  `Error`).
- `rust/mls-wasm/tests/peer.rs`: lifecycle with theft and rotation;
  simultaneous commits with bystanders; rollback across several epochs; a
  commit from another branch is not a sibling; a welcome replaces a lapsed
  branch; forgery as a sibling, both branches.
- `src/candidates/rltp-mls/load.ts`: loads `pkg/` (gitignored, built by
  `scripts/build-wasm.sh`).
- Registered as `rltp-mls` and `rltp-mls-sichten` in
  `src/candidates/index.ts`.
