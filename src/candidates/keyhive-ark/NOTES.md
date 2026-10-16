# Port notes: Keyhive (run a, Automerge over ARK and Subduction)

As of 3 October 2026. Keyhive the way it is meant to be used:
`@automerge/automerge-repo-keyhive` (ARK) 0.6.0-alpha.1 with the
automerge-repo fork 2.6.0-subduction.48, `@automerge/automerge-subduction`
0.16.1, and a real Subduction server (`subduction_cli` 0.18.0, Rust,
release binary) as the relay. Own transport: the bench only switches
devices online and offline; a partition means only the first group reaches
the server. Node and CI only, the browser cannot start a server. One device
per person.

Setup as in run b: an **admin group co-owns the document**, admins go into
the group, members directly onto the document (see finding 2).

## Results

| | Result | Reason |
|---|---|---|
| S1–S3 | passed | |
| S4a | passed | Bob's concurrent entry is **discarded** (Alice and Carol do not see it), unlike run b: the server no longer accepts Bob's blob after the revocation |
| S4b | passed | simultaneous removals of different people: nobody reads along |
| S4c | failed | Bob cannot remove the founder (root of the delegations, as in run b). Plus finding 3: Carol keeps seeing Bob as a member |
| S4d | passed | `forcePcsUpdate` next to a removal |
| S4e | not applicable | no group policy |
| S4f | failed | ARK revokes with `retain_all_other_members = true`: whoever Mallory invited stays (x). Offline, x cannot invite anyone because x never received the document. Plus finding 3 |
| S5 | not applicable | a person as a group of their devices, not wired in the bench |
| S6 | passed | ARK's "nudge": after every admission an edit under the new key, so the new member can read the history. No app chain needed (Automerge provides the content DAG) |
| S6b | passed | |
| S7 | not applicable | an attacker would have to read Sedimentree blobs from the server; not wired |
| S8 | passed | an admin removes without the founder |

Load (Node, including waiting for quiescence, hence rough): S9 (30 members,
500 authority operations) 153 s, of which 131 s waiting; it completes,
unlike p2panda. S9b (10 members, 100 entries) 10.5 s, of which 10.1 s
waiting. The waiting time is set by the server (Keyhive state every 2 s),
not by compute.

## Findings

1. **The path to the server is unstated.** ARK needs the server's contact
   card up front (`syncServer: {contactCardJson, peerId}`), but the server
   publishes it nowhere: it generates it afresh with randomness on every
   start, the ready file holds only port and peer id, a development seed is
   undocumented. Over the wire it works: a bootstrap hive with
   `syncServer: "none"` asks `RequestContactCard`, the server answers with
   the card attached, and ARK accepts it via `receiveContactCard`. The
   candidate intercepts it there. Two further stumbling blocks: the
   Subduction wasm must be initialized before ARK (`initSubduction()`), and
   the server hashes its socket string as the service name while the
   client hashes the host of the URL (so port 0 does not work).
2. **"Admin" in Keyhive does not mean "may remove anyone".** An admin set
   directly on the document may only revoke delegations that descend from
   itself (`keyhive_core`, `revoke_member`: proof via its own delegation
   chain or via a group it belongs to). ARK's
   `addMemberToDoc(…, Access.admin())` is therefore not enough for S4b and
   S8 ("keyhive rejected this"). With the admin group as co-owner
   (`generateGroup`, `keyhive.addMember(group, doc, admin)`) both pass. The
   founder nevertheless remains unremovable (S4c).
3. **Non-admins do not see changes to the admin group.** When an admin is
   removed from the group (S4c Bob, S4f Mallory), the remaining members
   keep listing them, even after 6 s of quiescence. Removals on the
   document (S2, S8) reach everyone. Conjecture: for a member not in the
   group, the group's events are not "reachable" in Keyhive, so the server
   does not forward them. Whether the removed can still read along is not
   checked by S4c; open.
4. **ARK keeps the invitations of a removed member**
   (`retain_all_other_members = true`, S4f). That is a product decision of
   ARK, not a limit of Keyhive.

## Comparison of the two Keyhive runs

| | Run a (Automerge, ARK, Subduction) | Run b (Yjs, `@keyhive/keyhive`, bench network) |
|---|---|---|
| S4a entry of a concurrently removed member | discarded (server) | stays visible |
| S4c mutual removal | ✗ (non-admins' view stale) | ✓ |
| S6 history directly after admission | ✓ (nudge) | ✗ (only after the next entry) |
| S7 PCS | not applicable | ✓ |
| History | Automerge commits plus ARK envelope | own predecessor chain for Yjs |
| Server | indispensable (relay, does not order) | none |

The difference shows what an adapter for Yjs has to replace: the content
DAG for the predecessor chain (run b builds it itself) and the nudge after
admission. Everything else is the same in both runs: delegation chains,
BeeKEM, the founder's seniority.

## Answers to the seven questions

- **Ordering:** Subduction (Sedimentree) orders blobs causally, Keyhive
  buffers events with missing dependencies. The app orders nothing.
- **Storage:** `StorageAdapterInterface` for repo and ARK (blobs, Keyhive
  archive and events, pre-key secrets, PCS key hashes).
- **Identity:** Ed25519 per peer (WebCrypto or storage), contact card with
  pre-keys; cards are exchanged out of band.
- **Transport:** one WebSocket to the Subduction server; over it blobs
  (Sedimentree) and Keyhive events (SUK frames). No P2P.
- **Authority:** delegation chains, conflicts by seniority, causal depth,
  digest. The server checks access with its own Keyhive before it accepts
  or hands out blobs (S4a). No hook for own rules.
- **Keys:** BeeKEM; ARK rotates after its own admissions (`forcePcsUpdate`
  plus nudge), after revocations it relies on CGKA.
- **History:** Automerge commits carry the predecessors, ARK attaches the
  predecessors' keys per blob (`blob-interceptor`); a new member reads the
  history immediately after the nudge.
