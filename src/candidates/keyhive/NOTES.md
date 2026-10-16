# Port notes: Keyhive (run b, Yjs)

As of 3 October 2026. `@keyhive/keyhive` 0.3.0-alpha.1 (tag `next`), the
WebAssembly bindings of the Rust core, without Automerge. Content stays in
Yjs. No server: all messages go over the bench network to everyone. One
device per person. Run a (Automerge over ARK and Subduction) is in
`../keyhive-ark/NOTES.md`, with a comparison of the two runs.

Setup as in the README and in ARK: an **admin group co-owns the
document**. Admins go into the group, members directly onto the document.
Only this way may an admin also revoke delegations they did not issue
themselves (otherwise "Proof missing to authorize revocation").

## Results

| | Result | Reason |
|---|---|---|
| S1–S3 | passed | |
| S4a | passed | Bob's concurrent entry stays visible to Alice and Carol (as with p2panda) |
| S4b | passed | **simultaneous removals: nobody reads along** (unlike p2panda) |
| S4c | passed | Bob cannot remove the founder: she is the root of all delegations (seniority). Alice removes Bob |
| S4d | passed | `forcePcsUpdate` next to a removal |
| S4e | not applicable | no group policy (fixed levels Relay/Read/Edit/Admin) |
| S4f | failed | Mallory's chain (x, y) remains, see the open observation |
| S5 | not applicable | a person as a group of their devices exists, not yet wired in the bench |
| S6 | failed | no history directly after admission |
| S6b | passed | after the next entry the whole history, via the predecessor chain |
| S7 | passed | after `forcePcsUpdate` a passive attacker reads nothing new, see the S7 section. No other candidate can model S7 |
| S8 | passed | an admin removes without the founder |

Load (Node): S9 (30 members, 500 authority operations) 25.6 s, 51 ms per
operation; headless Chrome 145 median 13 s, 26 ms. S9b (10 members, 100
entries) **0.46 ms per device and message** (p2panda 8.3 ms, plaintext
0.06 ms).

## S7 in detail: what is tested and what is not

Tested (bench model): a **passive** attacker captures Bob's entire device
state (Keyhive archive, signing key, the key table of the app's
predecessor chain, Bob's Yjs state) and afterwards sees all traffic. It
evaluates it with the same logic as an honest device (ingest events, known
keys, predecessor chain, CGKA, retry).

- Positive control: it reads an entry between theft and rotation.
- After `forcePcsUpdate` by Bob it does not read the next entry.
- Alice and Carol read it.

Not tested: an **active** attacker who injects operations with the captured
key (for example its own CGKA update before Bob); whether Bob notices the
compromise; rotation by a device other than the compromised one. The claim
is therefore: PCS against a passive eavesdropper after a rotation by the
affected device, in the core and in this candidate's app chain.

## Findings

1. **History is the app's business.** Keyhive itself gives a new member no
   access to old entries. ARK builds an envelope around every entry for
   this: the keys of the predecessors, encrypted with the entry's own key
   (`blob-interceptor.js`). The predecessors come from the dependencies of
   the Automerge commits. For Yjs the candidate rebuilds this envelope; the
   predecessors are the entries seen since the last own entry. Consequence:
   history only from the next entry on (S6 ✗, S6b ✓). For our port this
   means: P3 needs a **content DAG**, which for Yjs the adapter (or our log)
   must provide.
2. **The founder cannot be removed.** Other admins cannot revoke the root
   of the delegations (S4c). That is Keyhive's seniority; for "the group
   owns itself" (K9) the founder stays permanently special.
3. **Open observation on cascades.** In our setup, people invited by a
   later-removed admin stay members and keep reading, even without
   concurrency and with `retain_all_other_members = false`. The design
   docs promise a cascade. Whether that is a bug or due to the nested setup
   (group as co-owner) is unresolved.

## Answers to the seven questions

- **Ordering:** Keyhive buffers itself. `ingestEventsBytes` holds back
  events with missing dependencies. The candidate buffers content until it
  can be decrypted. Events that arise while ingesting foreign events are
  not forwarded (as in ARK, otherwise echo).
- **Storage:** Keyhive archive (`toArchive`), ciphertext store, pre-key
  secrets; plus, in the candidate, the key table of the entries.
- **Identity:** an Ed25519 signing key per peer; the contact card (with
  pre-keys) must be present before the invitation. Mapping to did:key:
  open (both Ed25519).
- **Transport:** three kinds: contact cards, Keyhive events (delegations,
  revocations, CGKA operations, pre-keys) and content in the envelope. All
  to everyone.
- **Authority:** delegation chains (convergent capabilities), conflicts by
  seniority, causal depth, digest. No hook for own rules.
- **Keys:** BeeKEM. New key on removal, `forcePcsUpdate` for rotation
  without a membership change, PCS demonstrated (S7).
- **History:** via the predecessor chain in the replica, not via the
  invitation. That is the form Access §9.4 ("causal encryption") intends
  for P3, except that the chain has to be built outside Keyhive.
