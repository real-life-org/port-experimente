# Port notes: RLTP authority over BeeKEM (E6, E7, E8, E9)

As of 5 October 2026. The experiment on the cut from the synthesis:
**authority with us, key agreement as an adapter.** A minimal authority log
by the conflict matrix (`authority.ts`) decides membership; BeeKEM 0.4.0
(Keyhive's CGKA as a crate of its own, without Keyhive's delegation chains)
delivers the keys, via `rust/beekem-wasm`; Yjs the content; history via the
predecessor chain as in Keyhive run b. Over the bench network, no server.
Since E7 several devices per person: one BeeKEM leaf per device, the log
knows only persons.

## Results

| | Result | Reason |
|---|---|---|
| S1–S3 | passed | |
| S4a | passed | Bob's entry under the old key stays readable ("content residual"), Bob reads nothing new |
| S4b | passed | two removals at the same time: both hold, **nobody reads along** (KV2, KV6) |
| S4c | passed | mutual removal: **both out**, everyone agrees (decision 2 of the synthesis) |
| S4d | passed | rotation next to a removal (KV5, KV6) |
| S4e | not applicable | no group policy in the experiment |
| S4f | passed | strong removal transitively: Mallory's chain invalid; the key tree is healed |
| S5 | passed | second device: the person adds her own leaf, reads old (chain) and new; the member list still shows only persons |
| S5b | passed | lost device: the person removes her device, the finder reads nothing after the removal (KV1), the person stays a member |
| S5c | passed | removing the person removes all her leaves, none reads anything new |
| S6 | failed | history only via the chain of the next entry (as Keyhive b) |
| S6b | passed | |
| S7 | passed | a passive thief (whole state, full eavesdropper) reads nothing after the rotation (KV5) |
| S8 | passed | founder without a special role |
| S10a–c | not applicable | without a service; results of the service variants under E8 |

Load (Node): S9b 0.67 ms per device and received message (Keyhive b 0.46,
p2panda 8.3, plaintext 0.06). S9 (30 members, 500 operations) 183 ms per
operation, median of 3. That is slower than Keyhive b (51 ms), and the
reason is not BeeKEM: the authority log recomputes the fixpoint over all
operations on every operation (quadratic), it is not optimized.

## What the experiment shows

The cut holds. With membership from outside and BeeKEM only for the keys,
the candidate passes everything the mandatory row of the matrix demands,
including the three points where every other candidate fails somewhere:
simultaneous removals (K10), no owner (K9), PCS after a captured device
(K4). The six invariants of the key port are thereby shown not only at the
core (`rust/beekem-wasm/tests/peer.rs`) but in interplay with authority
decisions.

What a real adapter additionally has to settle:

1. **The binding in the log (KV3).** Here the BeeKEM operation travels as an
   attachment of the authority operation (`cgka` in the `auth` frame),
   without a digest in the operation itself. In the casting the digest
   belongs in the enforcement operation, as `contentKeyCommitment` does
   today.
2. **Healing.** If an admission becomes invalid later (strong removal), its
   leaf is already in the tree. Here every admin who sees the deviation
   removes it; duplicate removals are no-ops in BeeKEM. In the casting this
   is a duty of enforcement: the tree follows membership, never the other
   way round.
3. **Replay behaviour.** BeeKEM applies simultaneous structural changes only
   on the next own operation; until then `members()` shows the old state,
   and without a shared key the next encryption rotates itself. The adapter
   has to reckon with that (S4c: "key=no" until the next entry).
4. **Signatures and authority.** BeeKEM checks no authority, every signer
   may remove. That is exactly right for the cut, but requires that only
   operations from valid authority decisions reach the tree (here: `isValid`
   before `receive`).
5. **History (KV4)** comes from the app chain as in Keyhive b. S6 directly
   after admission would need ARK's nudge (an entry under the new key after
   every admission).

## Authority log: finding from the review of PR #11

The first version of the fixpoint started with "all operations valid" and
took every not yet excluded removal for strong removal, even one without
authority. An unauthorized removal (a member removes an admin) thereby
suppressed a simultaneous valid admission, and because the fixpoint never
re-examined the excluded, it stayed that way (repro: Alice admits Eve,
Carol at the same time removes Alice without authority; Eve was missing
everywhere). Now every round first determines the authority of every
operation from its valid ancestors; strong removal strikes only through
removals **with** authority, and every round re-checks all operations
(bound: operations + 2 rounds). Lesson for the casting: "valid" is two
checks in a fixed order, authority before concurrency, and only the first
may feed the second.

Decided 5 October (in the candidate since E9 step 1b): chains of
simultaneous removals. A removes B, B removes C at the same time (both
admins). Today: B's removal has authority and suppresses C's simultaneous
admissions, but is itself invalid through A, so C stays a member.
Consistent would be either "removals with authority always hold, only the
admissions of a removed member lapse" (a generalization of decision 2, then
C is out) or "only valid removals suppress" (then a three-cycle oscillates
and needs a tiebreak).

## E7: persons in the log, devices in the tree

The question was whether the key port knows persons or devices as members.
Answer from the experiment: **both, on separate levels.** The authority log
keeps persons (subject of `add`/`remove`, roles, conflict matrix). BeeKEM
keeps devices: one leaf per device, because only then can a single device
be removed without the person (S5b), and a captured device does not reveal
the leaf secrets of the person's other devices. The bridge is the device
card (person, member id, share key), which every device sends to everyone
in advance.

Three rules sufficed:

1. **Admitting a person** adds all leaves of her devices known at that time
   to the tree (`addMember`).
2. **A person adds her own devices herself**: every device that is itself
   in the tree and whose person is a member adds missing leaves of its own
   devices (`ensureOwnLeaves`, after every card and every BeeKEM
   operation). The condition is "is in the tree", not "holds the key":
   directly after creation nobody holds a key, only the first content
   creates it, and until then the second device would otherwise be left
   out.
3. **Removing a person** removes every one of her leaves, **removing a
   device** (`removeDevice`, own person or admin) removes one and sends a
   revocation (`revoke`) so that no device re-adds it later and admins heal
   it in case the removal did not arrive.

What this means for the port:

- The authority port needs no devices. A member is a person, and the
  conflict matrix stays unchanged.
- The key port needs a mapping person → devices and two operations that do
  not exist in the authority log: add a device and remove a device. Neither
  changes membership, but both create a new secret (KV1 holds per leaf,
  not per person).
- Who may add a device is an authority question that stays open here
  without signatures: in the experiment the card with the person's name
  suffices. In the casting an existing device of the person must sign the
  binding (otherwise a stranger binds itself to Bob's name), and the
  revocation belongs in the log or in a signed device chain, not in a loose
  frame.
- History for the second device comes from the chain as for new members
  (S5 reads "before" only with the next entry). A direct key transfer
  between a person's devices (to the new device's share key) would be
  faster and would solve S6 for the device-change case.
- Cards and revocations are knowledge per replica and change only through
  received frames. In a partition an admin therefore heals nothing that was
  not delivered; after delivery everyone converges (test "#14"). Whether a
  person can be removed is decided by the log, not by the card table: after
  revocation of her last device she has no card but is a member (test
  "#13").
- Open: two devices of the same person add a third at the same time in a
  partition (duplicate admission in BeeKEM); not tested here.

## E8: an enforcing, key-blind service at the relay

Question: what does enforcement at the relay add to enforcement in the
replicas, and what must the service know for it? Two variants of the same
candidate (`service.ts`), transport class "bench relay, enforcing":

- **Views (Access §7.3).** The service does not know the log. After every
  change, every member device proposes the view of its state (seq,
  predecessor hash, identities = device ids, m for the next view); the
  service counts identical proposals from devices that are in the old and
  the new view as a quorum (m = 1 with one identity, otherwise 2) and
  confirms the accepted view to everyone (`ack`). Proposals go to the
  service alone ("keep").
- **Log replica (control, as Gen 2).** The service keeps a replica of the
  authority log and evaluates it itself.

Both bind a device via its own card to its BeeKEM id (without proof of
possession; §7.3 demands a challenge) and serve only devices that are
members per the view or the log (displacement, §9.3). Both **always let
authority operations through**, also from removed members, and gate only
content, key operations and revocations.

| | Views | Log replica | Reason |
|---|---|---|---|
| S1–S8 | as without a service | as without a service | S4a: the removed member's concurrent entry reaches nobody any more |
| S10a removed member writes concurrently | passed | passed | the relay discards, no residual; Bob is no longer served |
| S10b removal without relay, the removed writes at the relay | passed | passed | the service lets through until the removal reaches it (stale view, expected); discarded afterwards |
| S10c mutual removal leaves only Carol | **failed** | passed | views: m=2 of the old view can no longer be met with one identity, the service freezes and keeps serving Alice (§7.3 "stated residual"). Log replica: evaluates itself |

### Findings

1. **Evidence is never gated.** The first version also discarded authority
   operations from non-members. With that, under mutual removal the relay
   side never saw Bob's removal of Alice, the replicas diverged, and with
   views the service froze on a wrong state. Access §9.3 already says so
   ("non-effecting evidence transport of 3.6 is never gated"); the
   experiment shows that this is no subtlety but that the conflict matrix
   depends on it. For the port: the service gates effect (content, keys),
   never evidence (authority operations).
2. **The displaced learn nothing.** Whoever the service no longer serves
   also does not get the operation that removed him (S10c: Bob keeps seeing
   {bob, carol}). Without a service he learned it from the mesh. That is the
   place of Access §10.2 `removal-notice`: a delivery to one, not a
   replication frame. For E11 the first hard delivery case out of the
   group.
3. **The quorum freezes.** Views with a fixed m from the predecessor view
   fail on exactly the cases the matrix solves: mutual removal that drops
   below the quorum. The spec calls this "stated residual" and demands
   lowering m beforehand; with simultaneous removals there is no
   beforehand. The log replica has no such problem because it computes the
   same matrix as the replicas. For the casting: either m follows the view
   itself (m = min(2, |identities|) of the **new** view, then a single
   signer is admissible when shrinking to one), or the service gets the log.
   Views buy nothing here that the log replica does not have, but cost
   traffic (below).
4. **Views are expensive.** Every member device proposes after every frame
   until the service confirms; with 30 members and 500 operations S9 was
   not finished after ten minutes (without a service 193 ms per operation).
   At smaller scale it still scales: 10 × 100: without service 14.6, log
   replica 11.3, views 11.4 ms per operation; 30 × 100: views 59; 30 × 200:
   views 74, log replica 54. The service even saves work (discarded frames
   reach nobody), but the views grow superlinearly with the number of
   operations. On the page this variant therefore runs only 30 × 100
   (`loadSize`). Rejected proposals (wrong seq, because the confirmation
   had not arrived yet) are the normal case, not the exception: 5 to 10 per
   scenario with three to four devices.
5. **What the service learns.** Views: device ids of all members, seq,
   group affiliation of the ids; the ids are the same across groups here
   (one BeeKEM key pair per device), a service for several groups could link
   groups via devices. Log replica: additionally persons, roles and the
   whole operation history. Gen 3 foresees member anchors per group (device
   × group); here that would be an own share key per group.

### Delivery hypotheses DV1–DV6 (from the delivery session, not decided)

Reading: "breaks" means breaks **at the candidate**; the hypothesis then
stands as a requirement on the port, not as refuted. A service without
these promises does exactly what the table shows.

| | Service frames in E8 | Finding |
|---|---|---|
| DV1 an ack is arrival, never a decision | `ack` confirms an **accepted** view, so a quorum verdict, not an arrival signal. For a proposal there is no arrival signal | breaks at the candidate: verdict and arrival need two separate frames |
| DV2 nothing accepted ends silently | discarded content (S10a) and rejected proposals (wrong seq) disappear without feedback; the writer notices nothing | breaks at the candidate: exactly the error DV2 forbids |
| DV3 at least once, idempotent over the content | proposals are idempotent over their content (same hash = same signature); sequence is the order, hash the identity | holds |
| DV4 the carrier learns nothing linking | see finding 5: device ids are global | breaks at the candidate: global device keys; anchors per group (device × group) heal it |
| DV5 rejections repeatable, without a statement about the parties | there are no rejections (see DV2) | not applicable |
| DV6 address per relationship or group, not global | the address in the bench is the device name; in the service the global device id | breaks at the candidate, as DV4 |

Ordering: for views the service needs a total order (seq +1, predecessor
hash); the replicas themselves need only a causal one. A service switch is
not tested; with views the new service would have to take over the chain
from a registered view, with the log replica catch up on the log.

## Answers to the seven questions

- **Ordering:** causal, via predecessors in authority operations and in
  BeeKEM operations; both sides buffer what lacks predecessors.
- **Storage:** authority log, BeeKEM state (serializable, contains the leaf
  secrets), key table of the chain.
- **Identity:** Ed25519 per device (member id in the tree), X25519 share key
  as a pre-key; card with the person's name to everyone in advance. Person
  = name in the log.
- **Transport:** five frames to everyone (replication): card, authority
  operation with attached BeeKEM operations, loose BeeKEM operation
  (rotation, healing, device admission, update on write), device
  revocation, content with chain. With a service two more to one party
  (delivery): view proposal to the service, confirmation of the service to
  the served devices. The only single-recipient candidate without a service
  is the BeeKEM welcome message, which here travels to everyone inside the
  add op.
- **Authority:** our log; strong removal with mutual removal as the
  exception; founder without a special role. Since E9 with signatures and
  policy per Access §4 (below).
- **Keys:** BeeKEM. New secret per removal, rotation on demand, merging of
  parallel secrets via conflict keys.
- **History:** predecessor chain in the replica.

## E9: signatures, policy, fork (step 1)

Question: does the casting Access 0.54–0.56 hold against code? Step 1
replaces, in the authority log (`authority.ts`), the roles and the unsigned
operations by the spec form; the cut (authority with us, BeeKEM for keys)
stays. Step 2 (view chain per §7.3 with signatures, m from the new view,
challenge; S10c', S10d) is pending.

- **Signatures.** Every operation carries a signature set over its
  envelope; the id is the digest of the envelope (body without proofs), an
  envelope that does not match the id is not the signed one. A signer
  counts if its signature verifies under the key that the valid admission
  (or the genesis) registered for it, and it is a member at the position
  (policy currency). Ed25519 per person, shared over her devices (as the
  seed is today); the group DID co-signs the genesis and is discarded
  (RLTP-ACC-3060). `@noble/curves`, synchronous, so that folding stays
  synchronous.
- **Policy as data.** `any-member`, `threshold k`, `actors`, `vouch n`,
  `all`, `any`, `strongest` (§4.2); validity via satisfaction sets (§4.4),
  `strongest` and the order ≥ by enumeration over the finite universe
  (signers ⊆ members, vouchers ⊆ members, yes of the subject; bound 16
  members). Structural check: arities, depth ≤ 4, non-empty compositions,
  vouch only on `member.add`, at least one concrete rule. Roles no longer
  exist: "admin" is an entry in the `actors` of `member.add`/`member.remove`;
  `policy.change` is `strongest`. Promoting = a `policy.change` that
  appends the name.
- **Fork (class rule 3, RLTP-ACC-3495).** `policy.change` next to an
  enforcement (remove, policy.change): both lapse; in the fork every further
  enforcement lapses, admissions go on; ended by a `policy.change` whose
  predecessors contain both branches (authorized under the policy before
  the fork, because the siblings lapsed). Strong removal runs before class
  rule 3 (§3.6: dispositions first).

| | Result | Reason |
|---|---|---|
| S1–S8, S5b/c, S10a/b | unchanged | regression |
| S4e | **passed** (previously not applicable) | two `policy.change` at the same time: fork, everyone agrees (`fork=ja`) |
| S4j | passed | `policy.change` next to a removal: fork, Carol stays; a `policy.change` on both ends it, afterwards the removal takes effect |
| S4g (log) | passed | without, forged, foreign signature and altered envelope: invalid; genesis needs founder and group key |
| S4h (log) | passed | `threshold 2`: one signature is not enough, two simultaneous single signatures form no removal, non-members do not count |
| S4i (log) | passed | `vouch 2`: one voucher too few; nothing without the subject's yes; vouchers of another admission do not count; vouch on `member.remove` structurally invalid |
| strongest (log) | passed | resolves to `actors({alice,bob},2)`; `all[actors(a),actors(b)] ≥ threshold(2)` (§4.4) |
| S10c (views) | unchanged failed | step 2 |
| S9 | 267 ms per operation (30 × 500, median of 3; E6: 183) | signatures are re-verified per fold, and the fold is still quadratic; S9b 0.46 ms per device and delivery (5 × 200), unchanged |

### From the review of PR #16 (Codex, CodeRabbit)

- **An admission does not replace a key binding (#17).** The first version
  reset the subject's key on every valid admission; under
  `member.add = any-member` a member could bind Alice's name to a key of
  its own and then remove as Alice. Now: whoever already has a key comes
  back only under the same one; a member is not admitted again; two
  simultaneous admissions of the same person under different keys both
  lapse. A key change needs a rule of its own (Access `anchor.rotate`), not
  built here. For the casting: the binding name → key is a state of its own
  next to membership; which operation may set it should be stated.
- **Proofs of the same envelope are merged.** Signatures and vouchers are
  not part of the id; a second copy brings its own along (`'ergänzt'`),
  otherwise co-signatures delivered later are lost and two replicas judge
  the same operation differently. The candidate takes BeeKEM attachments
  into the tree exactly once, even if the operation becomes valid only
  through later delivery.
- **Strong removal counts verified signers**, never claimed names;
  otherwise an attached invalid signature under the name of someone just
  removed could bring down a valid operation.
- **A join per fork pair.** A `policy.change` ends only the fork whose two
  siblings it has as predecessors; an enforcement that lapsed in the fork
  forms no further pair itself (otherwise a lapsed `remove` poisons the
  join that is meant to end the fork).
- **Promotion extends the rules** instead of replacing them by
  `actors(k=1)`; `threshold` and `vouch` are preserved.
- **A promotion holds only as long as its admission holds (#18).** A causal
  predecessor does not bind: under `add:vouch:1` the admission was invalid,
  the following `policy.change` valid, and a later ordinary admission made
  the orphaned actors rights effective. New in the envelope: `dependsOn`, a
  validity dependency that the fixpoint checks every round (including
  proofs delivered later and later invalidation; only predecessors
  allowed). For the casting: the spec knows authority only per position;
  "holds only with X" is a mechanism of its own, which the admission chain
  of the membership tasks (invite → accept → add) already provides for the
  admission. For policy that hangs on an admission it is missing, and
  `actors` that name non-members are the reason.

### Step 1b: invariants (consolidation after the review)

The four review rounds were special cases of one class: ordering, shared
proofs, competing admissions, dependencies. Instead of patching further
repros, four invariants now hold, three of them as property tests with
seeded graphs (`tests/authority-props.test.ts`, 60 graphs, partitions,
proofs distributed over copies, key conflicts, unauthorized signers,
promotions with dependsOn):

- **I1 Determinism.** The same evidence yields the same state (members,
  policy, version, fork, validity per operation), independent of delivery
  order and of how proofs are distributed over copies.
- **I2 No rights from failed admissions.** A promotion holds only if every
  admission it depends on holds; every member has a valid admission, and
  its key comes from it.
- **I3 Keys never win through copies.** Per person at most one key among all
  valid admissions; additional copies or partial proofs do not change the
  state (monotonicity of the merge).
- **I4 The tree follows the state.** The key side does not react per frame
  but reconciles with the state after every fold and before every
  encryption (`reconcile`): remove leaves of non-members, add missing
  leaves of members (after a rotation, when no shared key is held at the
  moment), add own devices. Every member with a key repairs, without a
  policy quorum (resolves finding 5). **Design change against E6 (note 4
  there):** BeeKEM attachments always go into the tree, whether the
  authority operation holds or not. The tree has its own causal history; if
  a replica does not apply an attachment, it can no longer apply any
  operation that builds on it (for instance a writer's rotation), and the
  replicas diverge (repro: Carol, who had never applied a removal that
  lapsed in a fork, could not open Dave's entry). Authority therefore acts
  as a repair after the fold, not as a gate before the tree; KV1 holds
  because the repair runs before encryption and BeeKEM merges simultaneous
  repairs. That is also what Keyhive does (delegations and BeeKEM are merged
  separately, the cascade repairs). Repro that failed before: Dave's
  replica saw Alice's removal of Bob first, then Bob's admission of x as
  suppressed; Carol's simultaneous policy change let the removal lapse in
  the fork, the admission became valid, and x was missing from the tree
  (`tests/rltp-beekem.test.ts`).
- **Removal chains per the decision of 5 October** caught up: removals with
  authority always hold, only the remaining operations of a simultaneously
  removed member lapse (A removes B, B removes C at the same time: both
  out). The candidate still had the old rule since E6 (B's removal lapsed).
  A removal that lapsed itself (fork, authority) suppresses nothing.

### Step 2: view chain per §7.3 with signatures

Since step 2 the view service (`service.ts`) checks signatures and
possession, not claims: every device has an Ed25519 device key (in the
card), the `identities` of a view are the device keys of all devices of the
members (one identity per device, E7), a view proposal carries the device's
signature over the view content (7110), the service merges copies and
counts only signers that are in the old and the new view and whose
signature verifies (7180). Binding device → key via a proof of possession:
the service issues a challenge to the card, the device signs it; without an
answer no proposal and no write counts (7.3 "proof of possession"). Reading
(delivery) is not bound to the proof of possession in the bench, because
the challenge has to reach the device; in the spec reading runs over an
authenticated session.

| | Result | Reason |
|---|---|---|
| S10d (service) | passed | forged signature, foreign signature under own name, signer outside the old view, replay of an old view, wrong predecessor, unanswered challenge: none of them counts; a write without proof of possession is discarded |
| S10c' rule `parent` (Access 0.56 §7.3, as written) | **failed** | quorum = effective m of the predecessor view (2); after mutual removal one identity remains, the service freezes: the spec's "stated residual" |
| S10c' rule `new` (casting plan 0.54: m_effective = min(m_parent, \|identities_new\|)) | passed | Carol alone carries the new view, Alice and Bob are no longer served |
| S1–S10b | unchanged | under both rules and in the log replica |

**Finding 9 (for 0.57): casting plan and spec contradict each other on m.**
The casting plan 0.54 (§7.3 line) decided "m follows the new view" so that
mutual removal does not freeze the service (E8 finding 3); Access 0.56 §7.3
keeps the quorum of the predecessor view and explicitly names the freezing
as "stated residual" (the group lowers m beforehand, the way out is
re-registration). Both are built and measured here; the decision is
pending. With simultaneous removals there is no "beforehand", so the spec
rule does not carry exactly the case the matrix solves (S4c), and the group
loses its service binding.

### Step 3: fixpoint, fast path

The 267 ms per operation (step 1) did not come from the fold but from
folding completely anew after every operation (every fold quadratic, 500
operations → cubic). Now there is a fast path: an operation that builds on
all current heads is concurrent with nothing; it can let no earlier
operation lapse (strong removal and class rule 3 need concurrency) and open
or end no fork that is not already determined by its predecessors. Its
validity depends only on the folded state, so one step suffices. Only a
concurrent operation or a later delivery of proofs triggers the full fold.
The full fold itself is unchanged quadratic.

Property test I5 (`authority-props.test.ts`): fast path and full fold yield
the same state after every single operation, over the 60 seeded graphs with
partitions, forks, dependsOn and copies.

| | before | after |
|---|---|---|
| S9 (30 × 500, median of 3) | 267 ms/op (E6 without signatures: 183) | **17.8 ms/op** (Keyhive b: 51) |
| S9b (5 × 200) | 0.46 ms per device and delivery | 0.50 |
| views, 30 × 100 | 59 ms/op (E8) | 31.9 ms/op |

## E10: carrier bench, first pass (12 October)

The carrier plays the adversary (`src/lab/traeger.ts`, catalogue T in the
plan). Fault injection at the bench relay (`World.carrier()`): drop,
withhold per device, reorder, duplicate, tamper, replay; the same
catalogue runs over PWS (`transport.faults`, a wrapper around the real
server). Both carriers show the same picture:

| | Door | Relay | PWS | Finding |
|---|---|---|---|---|
| T1 frame silently lost | DV2, I12 | ~~failed~~ passed | ~~failed~~ passed | First pass: **no gap repair**, a lost authority operation stayed lost. Since the second pass every content names its writer's authority heads, and the replica requests missing predecessors from the author (below, "gap repair"). Repair is a duty of the replica, not of the carrier. |
| T2 reorder | I2 | passed | passed | While building it came out that loose BeeKEM operations arriving before their predecessors were discarded instead of buffered. Now `pendingCgka`, retried on every repair. |
| T3 duplicate | DV3 | passed | passed | idempotent over id and content |
| T4 old removal replayed | I8 | passed | passed | `known`, no state change. Since sealed frames the carrier replays all of Alice's old authority frames; it can no longer select the removal. |
| T5 tampered / garbage | D1 | passed | passed | digest of the envelope, form before content; garbage is noted, never thrown (new: `receive` no longer throws). Since sealed frames the carrier can no longer write anything targeted (reinterpret an admission as a removal); it can only destroy. And what is destroyed, gap repair brings back: Alice's next content evidences the missing operations, Alice resends them, Dave and Eve arrive after all. A damaged entry with a known key is discarded and noted; one without a key stays `unopened` but no longer holds anything up (review of #31). |
| T6 one entry withheld from one device | D5, I5 | ~~failed~~ passed | ~~failed~~ passed | First pass: not noticeable. With the heads in the envelope Carol notices the gap as soon as anyone builds on the withheld entry (here Dave's content), and fetches it from whoever built on it. The carrier therefore cannot withhold a single entry permanently without withholding everything after it as well. |
| T6b device frozen (everything withheld) | D5, I5 | failed | failed | **Blind is not noticeable.** Carol sees a standing feed and cannot tell it from silence; there is no attested target against which she could check her state. That is the door a service of class view/log with attestation closes (Replication §4.1), and question 3 to PWS. |
| T7 removed device keeps asking | §9.3, KV1 | passed | passed | class blind keeps serving Carol, she opens nothing (KV1); with a service of class view she is refused (second run with `dienst: 'sichten'`). The door distinguishes classes, not carriers. |
| T8 carrier switch mid-life | I15 | not applicable | passed | relay: no switch. PWS: export/import, then admission and writing on the new server, the newcomer reads the whole history. While building: admission hands out the key only with the next rotation (BeeKEM), the scenario has to deliver between admission and writing. |
| T11 two groups on one carrier | DV4/DV6 | not applicable | not applicable | limit of the harness: one candidate carries one group. What a carrier reads per group (names, device numbers) is shown by T12. |
| T12 sealed entry | I6 | ~~failed~~ passed | ~~failed~~ passed | First pass: frames in plaintext (#24), only content sealed. Third pass: everything over the carrier is a sealed entry, cards go over the encounter (below, "sealed frames"). |

Not run: T9/T10 (delivery adapter, E11). T6b, T7, T8 and T11 were added in
the second pass; the carrier switch runs over the optional hook
`CarrierFaults.rebind`, which only PWS offers.

**What the carrier bench has already shown:** the red cells are not
properties of a carrier but of the candidate or of the service class: gap
repair and sealed frames were missing in the candidate (the first has since
been built), attested targets are missing from every blind class. A second
carrier (PWS) delivers exactly the same matrix row. For the evaluation this
means: carriers differ only at T7–T11 and in cost.

### Gap repair (I12), second pass

Built per Replication §5.12, without changing the carrier:

- **Envelope.** Every content carries `heads` (the writer's authority heads
  at the time of writing) and `by` (its device key). That is the Access
  envelope in its smallest form; authority operations carry their
  predecessors anyway (`preds`, `dependsOn`).
- **Detection.** A gap is a predecessor that a held entry names and the log
  does not hold: from waiting authority operations and from unopened
  content. Checked after every fold (`reconcile`) and on every content.
- **Request.** A `repair` frame to the devices of the author of the
  evidence (for content `by`, for operations the devices of the signers),
  with `missing`, `evidence` (the naming entries) and `have` (own heads).
  One run per missing id. The evidence hangs on the authority dependencies
  (envelopes are kept until all heads are in the log), not on the key tree:
  a content can be openable and still evidence a gap (review of #27: lost
  policy change). If the request is lost, the replica repeats it as soon as
  a frame from an addressed device arrives (the source is reachable but has
  not answered), at most three times per run; requests go out only in
  response to traffic, so no loop. After that the run stays visibly open
  (`anfragen=3`) until the adapter restarts it with `rerunRepair(device)`,
  for instance after network healing (#30); the restart resets the counter
  and asks the sources again.
- **Answer.** Only an addressed device answers, only to an evidenced
  request, with the closure of the missing operations minus the closure of
  the asker's heads, in causal order, as the original frames (the replica
  deduplicates: `known`). For this, every device keeps the authority frames
  it has sent or accepted. Under a service of class view/log the request is
  a write (proof of possession and membership, I7).
- **State.** `lücke=N (awaiting-source)` or `lücke=0 (repariert N)` in the
  status; a run ends when the predecessor arrives. Not modelled:
  `repair-horizon` (the bench has no clock) and `awaiting-source` as a
  reported result to the user; both are tasks of the adapter, not of the
  candidate.

Check: T1 on relay and PWS (relay: the lost frame is delivered again; PWS:
Alice stores it as a new resource), plus the candidate test "gap repair"
(request withheld: state visibly open; released: repaired, and only Alice
answers). What the carrier additionally sees: heads (hashes) and device
keys per content, see `pws/NOTES.md`, check 3. For the port: the envelope
turns "withholding" (T6) into "withholding everything" (T6b); only the
attested view closes that as well.

### Sealed frames (T12), third pass

Path 1 (Anton, 12 October): T12 now, with a minimal welcome in the bench;
E11 replaces it by the delivery adapter.

- **Everything over the carrier is an entry.** Authority operations,
  revocations, repair requests and content go as `sealed`: the inner frame
  under the entry key (BeeKEM `encrypt`, as before only for content), plus
  the predecessor table. Only the envelope stays in plaintext: `kind` (kind
  of the inner frame, for the service), `heads`, `by`. The reference of an
  entry is a hash over randomness and plaintext, so that identical frames
  (a resent operation, two identical requests) get different keys.
- **Three things stay outside.** BeeKEM operations (themselves ciphertext
  to the leaves; they precede their authority operation as frames of their
  own, because the newcomer has to take them into the tree without an entry
  key). The welcome to a new device: the group and the admission, with
  X25519 against the card's welcome key, HKDF, AES-GCM; only that device
  can open it. And the cards: they go over the encounter channel (`direct`
  in the harness, delivery without a carrier, without a service, without
  fault injection), as in the spec cards come from the encounter. With a
  bench service, cards still go over the service, because it learns the
  device binding from the card (in the spec from the view). The service of
  class log reads the authority log (§9.3): for that there is the plaintext
  mode (`klartext`), only for it.
- **Newcomers read the history with the admission.** The predecessor tables
  of the sealed authority frames pass the key chain on down to the genesis:
  S6 (history without a new entry) now passes, not only via the chain of
  the next content.
- **A removal is sealed under the key before the removal**, but sent only
  after the BeeKEM attachments: the removed member must still be able to
  open it (Access §10.2, delivery of the removal), the others open it with
  the old key, which BeeKEM keeps. Without this order Carol in S4j never
  learned of her removal and the fork did not happen.
- **Two separate controls (review of #31, three rounds).** The first version
  hung tree reconciliation and gap repair on the same condition "no
  unopened authority frames"; that was a circle: waiting for completeness
  while blocking the way there, and every damaged frame blocked
  permanently. Now:
  - *Gap repair without a lock.* Evidence comes only from opened entries
    (the writer had the key) and from waiting operations. Unopened frames
    evidence nothing, their envelope is unvouched; nor do they hold anything
    up. A damaged frame, wherever damaged, is thereby invisible to repair;
    what it contained is fetched by the next intact evidence. Side effect:
    fewer requests (T2 before 7 requests and three triple answers, now 2).
  - *Tree reconciliation with restraint.* An unopened authority frame means:
    this replica knows its log lags behind what is in circulation. Whether
    it will still open, never open (an epoch without us, until the table of
    a later entry brings it) or is damaged, it cannot tell. In all three
    cases it does not touch foreign leaves, neither remove (healing) nor
    add, otherwise it would take out the leaf of someone just admitted or
    put back the leaf of someone just removed (that is what the first run
    looked like: dozens of `heal`/`heal-add`, and in T2 Dave brought Carol
    back into the tree). The members on the current state do that (I4:
    every member with a key). Targeted, not blanket (round 4): only frames
    whose key operation is in the tree count, so from an epoch in which
    this replica is present; a frame with an unknown `keyOp` says nothing
    about its log and holds nothing up. Its own devices it always adds, the
    tree vouches for that (without a key it does not work): an unreadable
    frame blocks no second device. Reading, writing, repair continue in any
    case. A key operation alone triggers no reconciliation; reconciliation
    happens after authority operations and before writing.
  - *Consequence for T2:* Bob's removal of Carol is concurrent with Dave's
    admission and sealed under a key without Dave. Dave reads it only with
    the next entry of a member that has read it (chain, as Keyhive b); T2
    therefore writes once more at the end.
- **The envelope is unvouched (#32).** `kind` in plaintext only controls
  the service's exception (authority frames pass without the membership
  gate because they are evidence for the conflict matrix, but only from
  devices with a proven key). What the envelope claims, the content has to
  redeem: if the inner kind does not match `kind`, the entry is discarded
  and noted. Otherwise a removed device with kept state could declare fresh
  content as `auth` and deliver it past the service (regression in the
  service test).
- **Damaged entries hold nothing up.** The rule "no reconciliation and no
  gap check while authority frames are unopened" applies only to frames
  whose key may still arrive (key operation not in the tree or attempts not
  exhausted). An entry that does not open with a known key is damaged and
  is thrown out; one with exhausted attempts stays but does not count. What
  they contained is fetched by repair via the evidence of later entries
  (review of #31: before, a destroyed frame blocked every repair
  permanently).
- **Writing waits.** Whoever has no key at the moment and cannot rotate
  (own leaf missing, for instance after a simultaneous removal that later
  lapses) puts the frame back (`queued`) until a member adds the leaf (I4)
  and the next frame brings the key. That is the primer's "healing =
  writing waits".
- **No authority without a key.** Without a key a device, since sealed
  frames, no longer reads the log either (`ungeöffnet=N`) until the next
  rotation of a member reaches it again (and via its table the keys of the
  sealed authority frames).
- **Reconciliation after every rotation (#33, S4f).** A rotation merges
  simultaneous tree changes (KV6): only afterwards do, for instance, the
  leaves from a lapsed branch (Mallory's invitations of x and y) stand in
  the tree. After healing nobody had a key (healing needs one), Alice's
  next entry rotated, the rotation brought x and y into the tree, and the
  entry went to five leaves: x and y read new content although no log
  listed them as members. Now, before every entry: the recipient set is the
  tree after the rotation, and it is checked, not assumed. Heal first
  (always, even if this replica lags behind: confidentiality outranks
  reconciliation quiet, a leaf removed too early is re-added by a member on
  the current state, an entry to a non-member cannot be recalled), add
  foreign leaves only on the current state, then `treeSafe`: every leaf in
  the tree belongs to a member per the log, otherwise the entry waits
  (`queued`, note "writing waits"). Only a repair request then goes out
  unsealed, it carries no secrets, so that gap repair never hangs on the
  confidentiality rule (review of #34). The exception remains the removal:
  its entry is sealed under the key the removed member still has (§10.2);
  its leaf is a recipient for this one entry, all other strangers are not.
  S4f has since checked confidentiality after healing, not only
  membership; before it said `keys: —`. Side effect: finding 8 resolves,
  Bob gets his leaf re-added with the next rotation after the lapsed
  removal and reads the next entry.

- **Cost (finding 12).** Every authority operation is now a BeeKEM entry
  that every replica opens with `decrypt`. Keyhive looks up the key via the
  hash of the PCS epoch and, for an epoch that is not the current one,
  replays the tree history (profile: blake3 and serialization of the tree);
  several to ten milliseconds per call at 30 members, growing with the
  history. In S9 (50 operations per delivery round, constant removing and
  re-admitting) that hits every replica that lags behind. Countermeasures in
  the candidate: `keyOp` in the envelope (the digest of the writer's last
  key operation, the spec's keyOpDigest): no BeeKEM attempt before the
  operation is in the tree; one key generation per replica: no second
  attempt without a new key; at most three BeeKEM attempts per entry, after
  that only the table of a later entry (no gate on "has key": without a
  current key BeeKEM still opens earlier epochs, and that is exactly how a
  removal arrives); encoding via `Buffer` (the character-wise base64
  helpers were 40 % of the time). Result: S9 30 × 100 **201 ms/op**,
  30 × 500 **823 ms/op** (superlinear, history), before 17.8; S9b 0.29 ms
  per device and delivery (before 0.50, Buffer). What remains lies in the
  wrapper (`rust/beekem-wasm`: historical keys not cached) and in the
  pattern "one entry per operation"; chaining entries of the same epoch
  under a derived key would not help S9 (every operation changes the
  epoch). For the comparison of candidates this is the number that counts:
  sealed, not plaintext.

Check: T12 on relay and PWS (`carried()` or the server storage: no names,
no content, only ciphertext with an envelope; PWS `visible()`: no persons,
no `card`); S1–S10, E9, gap repair, service variants all passed unchanged.
For the port: the plaintext envelope is what a carrier learns: kind of the
frame, heads as hashes, a device key as a pseudonym; plus sizes, times and
the bench's device names.

### Attested target for class view (D5, I5), 13 October

The bench service now attests its convergence target per Replication §4.1
(form 0.26, shortened: without genesisDigest, session, registrationCore):
`seq` in a chain, `prev` as the digest of the predecessor, `chain` as the
digest of the first target, a signature under an attestation key that is
stable over the session (so that equivocation would be provable), scope
`stored`: a key-blind service attests what it holds, never admissibility.
`heads` here are the references of all stored sealed entries (the service
does not see the chain of entries, so no real heads; grow-only, as the
consistency duty demands). In addition the service keeps the entries it let
through by reference and delivers them on `fetch` (source duty, I1/I12
against the service as a source).

On the device side a **sync tick** (`Candidate.poll`, called by the bench
at the start of every delivery round, the app comes to the foreground):
with a service the device asks `target-request` with a nonce and `since`
(the last target it knows). Three separate checks on the target (review of
#36, three counter-checks): **signature** under the key seen the first time
(TOFU as §7.3); **chain**: seq exactly +1, `prev` = digest of the accepted
predecessor, `chain` = chain identity, otherwise the target lies with a
note; on `since` the service delivers the intermediate targets so that the
chain is checkable even if other devices asked in between; **freshness**:
the open request is answered only by a target with its echo (signed) and
to this device, an old valid target is a chain link, never an answer. The
missing set is a set of digests.

**The reception boundary (round 3, Codex: "'present' was in turn a count, a
reference and a decryption success").** Three statements, three states,
kept apart:

| State | Statement | Where |
|---|---|---|
| verified stored | the bytes of this entry lie here; identity = digest of the bytes, the same the service attests | `stored` (device), `stored` by digest (service) |
| decrypted | the content is readable | `keys`, `heads`, table |
| checked | the kind matches the envelope, the authority has judged | fold, `verworfen` notes |

Target progress comes **only** from the first state: an entry of the target
is delivered when byte-identical bytes are there, whether or not they can
be opened yet. A damaged copy has a different digest and does not count;
on the next tick everything the target names and is not stored is fetched
again. Decryption and its attempt counter lie behind that and are kept per
copy (by digest): a damaged copy of the same reference does not use up the
attempts of the right one. The same bytes a second time are a duplicate
(T3) and are not accepted again. Checked end to end: withheld, delivered
damaged, delivered right, recovered. Both requests go out unsealed (ids
only) and are a read at the service: proven key and membership (I7).
Status: `ziel=seq N (M fehlen, K geholt)` or `ziel=angefragt, keine
Antwort`.

Result: T6 with a view service now passes via the target (one entry
withheld → named in the target → fetched from the service), T6b passes
(feed frozen → request without an answer, sampleable). Class blind stays
red at T6b, there is no target there; PWS likewise until the feed is
attested (question 3 to Dmitri). Not modelled: the horizon after which "no
answer" becomes a result; rotation of the attestation key; equivocation
proof from two chains.

### KV3 at the candidate: key operation without a log entry (S11, 14 October)

Review of PR #37 (Codex): the positive control read along via the captured
old state, not via the leaf; a forgery that created no leaf at all still
passed S11. Now `attackerOpen` with `via: 'forged'` reads exclusively via
the leaf; without an effective leaf S11 is "failed" (attacker model
ineffective), without a forgery after the removal "not applicable".
Regression: `tests/rltp-beekem.test.ts`.

KV3 ("the log binds the epoch to the secret") had no scenario in the
matrix. S11 checks the promise from the attack side: Mallory captures her
own state, is removed and with the old state adds a new leaf for herself to
the tree (`forgeKeyOp`, capability `forge-key-op`: a BeeKEM admission that
no log entry covers). The frames reach all members as over the carrier.
Positive control beforehand: as long as she is a member, the same leaf is
her right (K7) and reads. After the removal it reads nothing: the tree
follows the log, reconciliation before every entry (`treeSafe`) takes the
uncovered leaf out before a key reaches it. Passed in all variants; not
applicable for the other candidates (no forgery from a captured state
modelled).

### Conformance matrix and the service variants at the carrier (13 October)

The matrix (`src/lab/matrix.ts`, output `REPORT=1 pnpm test report` and
the page) runs S1–S10 and T1–T12 for all candidates. A promise holds only
if every mapped scenario passes; if a part passes and the rest is not
applicable, it says "partial" (review of #35: before, a passed part turned
a composite promise green, and A4 "both out" rested on S4c, which only
demands agreement; now S4c2 checks the expectation including
confidentiality, and that immediately shows something: p2panda leaves both
out after mutual removal, but Bob still reads Carol's new entry, as in
S4b). For the service variants of this candidate catalogue T has thereby
run for the first time; what turned red are findings, not bench errors:

| | Views | Log replica (plaintext mode) | Finding |
|---|---|---|---|
| T1 frame silently lost | ✓ | ✗ | In plaintext mode the BeeKEM attachments travel inside the authority frame; if it is lost, the key is lost too, the next content cannot be opened and evidences nothing. Gap repair fetches authority, not keys (known limit, I12 is authority repair). |
| T2 reorder | ✗ | ✗ | With a service a reordered content arrives before the writer's proof of possession or before the view that admits it; the service discards it for good instead of holding it. With a blind carrier the replica carries the order, with a service it would have to (Access §9.3: evidence transport never gated, content gated, but a verdict "too early" is neither). Open. |
| T5 tampered | ✓ | ✗ | plaintext mode: a truncated authority frame is discarded, but Dave and Eve do not follow, because in plaintext mode no content evidences them (see T1). |
| T6 one entry withheld | ✓ | ✗ | as T1: without a key no evidence. |
| T6b feed frozen | ~~✗~~ ✓ | ✗ | Since the attestation (above): the service of class view attests its target, Carol asks at the sync tick and gets no answer, the state says so. Log replica: plaintext mode without a target query in the test, the finding remains there. |
| T12 sealed | ✗ | ✗ | With a bench service cards go over the service (device binding from the card); the log service reads the log in plaintext, that is its class (§9.3). The carrier sees here what the service is meant to see. |

What the matrix shows for the other candidates: a T scenario whose fault
rule never applies at the carrier (Keyhive names everything `event`,
p2panda and plaintext name their operations differently) stands as "not
applicable", not as passed; in the first run those were silent hits. T2,
T3, T7 and T12 apply to everyone because they need no frame kind: p2panda
fails on reordering (T2), plaintext on duplicates (T3) and on the removed
member (T7), Keyhive and p2panda pass T12 (binary frames without names).

### Where the code had to deviate from the casting (finding for 0.57)

1. **Author of a k-of-n operation.** The spec disposes "a removal of its
   author" (RLTP-ACC-3400); an operation with a signature set has no single
   author. Here it lapses as soon as **one** of its valid signers is removed
   at the same time (fail-closed). The casting should say so: all
   co-signers are authors, or only the `author` of the envelope.
2. **Promotion is constitution.** Without roles, "x becomes admin" is a
   `policy.change`. Whoever is removed at the same time as promoting
   someone (S4f) triggers no fork, because strong removal applies first;
   if class rule 3 came first, every removal of an admin who is promoting
   at that moment would fork. The order of the dispositions therefore
   carries more than §3.6 suggests; it should stand as a rule with
   rationale.
3. **What goes on in a fork.** §3.6 says "fails closed". Here only
   enforcement lapses; admissions and content go on (the key tree follows
   membership). Whether an admission should hold in a fork is a decision
   for the casting.
4. **Consent of the subject.** `vouch` demands "A contains the subject";
   here the subject's signature verifies under the key from the admission
   itself, before the subject is a member. An admission without a vouch
   rule needs no yes of the subject here; in the spec the membership tasks
   provide that (accept), outside the log. The voucher is bound to the
   nonce of the admission, not to an accept document (simplification).
5. **Healing under a quorum.** In step 1 only those healed who satisfied
   `may(person, member.remove)`; under `threshold 2` nobody. Since step 1b
   every member with a key repairs (I4): healing is the reconciliation of
   the tree with membership, not a membership decision. For the casting:
   say so.
7. **Validity dependency** (`dependsOn`, from #18): "holds only with X" is a
   mechanism of its own next to authority per position; the admission chain
   of the membership tasks provides it for the admission, for policy that
   hangs on an admission it is missing, and `actors` that name non-members
   are the reason.
8. **Re-admission after a lapsed removal.** If a removal lapses later
   (fork), the affected member's leaf is already out of the tree. Resolved
   with reconciliation after every rotation (#33): the next writing member
   re-adds the leaf, the entry reaches him (`tests/rltp-beekem.test.ts`).
   For the casting the question remains whether the leaf may come back
   under the same share key or needs fresh material (a key state after a
   removal is never reused); the bench takes the same leaf.
6. **Not modelled:** pending exits in the policy currency (5.4, no
   `member.leave` in the bench); the transport cost bound of the policy
   (§4.4); `strongest` beyond 16 members (a symbolic order is needed, the
   spec allows it); a person's key change (`anchor.rotate`).
