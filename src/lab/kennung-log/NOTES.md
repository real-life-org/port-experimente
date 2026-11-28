# A login identifier with a log, at one service

A did:webvh 1.0 log written and verified without witnesses, watchers or a
web location (`log.ts`), and the verifier of a service that keeps one copy
of each identifier's log (`verifier.ts`). The DID string is a template with
`{SCID}` and `parameters.method` is a setting (`profiles.ts`): the same code
writes and verifies `did:webvh:{SCID}:<host>`, `did:vh:{SCID}` and
`did:scid:vh:1:{SCID}`. JCS, base58btc and `eddsa-jcs-2022` come from the
library; nothing else. Measured 2026-11-28; the full table is
`scenarios.expected.json`.

Spec text read from the sources: did:webvh `spec-v1.0/specification.md`
(commit ffd3518), did:vh `spec/specification.md` and
`spec/security_and_privacy.md` (commit cc2eff6), didwebvh#305.

## The log

`create` writes the first entry (Create, steps 1 to 6): one update key, the
hash of the next one (pre-rotation), a document with one Ed25519 key for
`authentication`. `rotate` lets the committed key sign, commit to a new
one, and changes the document's key. `deactivate` turns pre-rotation off
and writes `deactivated: true` with `updateKeys: []` one second later (two
entries, as Deactivate says for a DID under pre-rotation). `append` writes
any entry, signed by any key, for the cases that break a rule.

`verify` checks a whole log, entry by entry: parameters, the keys that may
sign (pre-rotation or not), the proof, `versionId`, the SCID of the first
entry, the entry hash, `versionTime`, `state.id`. The log is valid only if
every entry is (Applying Peer-to-Peer Updates resolves with the
`versionId` of the last entry).

Measured:

1. **Every tampered log is rejected.** 20 kinds of change, each to the
   first and to the second entry of a three-entry log, plus a removed and
   a swapped entry: 42 of 42 rejected, under each of the three names. The
   26 changes outside the proof again, re-signed with the key that signed
   the entry: 26 of 26 rejected (by the SCID, the entry hash, the version
   number, pre-rotation or the parameter rules).
2. **The rules hold where the hash chain does.** 19 entries an authorized
   key wrote that each break one rule: 16 rejected (time not later, not
   whole seconds, no zone or another zone, more than 5 minutes ahead, a
   missing `nextKeyHashes` under pre-rotation, `scid` later, another
   `method`, `portable` under did:vh, a witness, `null`, a string `ttl`,
   another `state.id`, an entry after `updateKeys: []`). Valid: a time 4
   minutes ahead, `method` repeated unchanged, and `deactivated: true` in
   one entry under pre-rotation with the update keys kept (did:vh:
   "there is no need to also remove the authorized keys").
3. **The same keys and time under three names give three SCIDs.** The DID
   string is in the first entry, so the SCID differs; each log is valid
   under its own name only (under another: another `method`, or the
   `state.id` is not the DID). A name chosen now cannot be changed later
   without a new identifier.
4. **Size.** In JSON Lines, with one key in the document: 1186 bytes for
   the first entry under did:vh, 1108 for a key change, 1060 for turning
   pre-rotation off, 1010 for the deactivation. did:scid:vh:1 adds 28 bytes
   per entry, did:webvh with `example.com` 59 to 62.

## The service

One verifier, one copy per identifier. A login brings the whole log and a
compact JWS (EdDSA) whose `kid` is a DID URL with the DID Core parameter
`versionId`: `<did>?versionId=<versionId>#key-1`, the head it was signed
under. Results are values: `ok`, `stale` (with the head the service
holds), `contested`, `invalid` with a reason.

| Case | Result |
|---|---|
| first contact | ok; the head is kept |
| an honest key change | ok, continued; the new head is kept |
| a device with the old state | stale, the service names the head it holds; after syncing, ok |
| an older log played back, with the old authentication key | stale; nothing changes |
| two continuations, the owner first | the owner ok; the copy contested; from then on both contested |
| two continuations, the copy first | the copy ok; the owner contested; from then on both contested |
| a token by the old key, naming the new head | invalid (signature) |
| a token by the old key, naming the old version | invalid (not under the head) |
| a continuation with a key that was not committed | invalid; nothing locked; the owner's continuation is taken after it |
| deactivation | invalid (deactivated), and the deactivation is kept; an old device is stale; an entry after it is invalid |
| a tampered log | invalid; nothing locked |

1. **The first valid continuation stands.** A second one that does not
   continue the held log is kept as evidence and the identifier is
   contested; while contested, every login is refused, the owner's too.
   Who reached the service first decides which head it holds; it cannot
   tell which branch is the owner's.
2. **Invalid input is no evidence.** A log that fails verification changes
   nothing, contests nothing.
3. **The log moves together with a login.** A valid continuation is taken
   only when the token holds under its head; with a token for another
   nonce the service keeps the old head, and the next continuation of that
   old head is followed. Two cases do not wait for a token: a fork (the
   two logs are the evidence) and a deactivation (signed by the update
   keys).
4. **The token names its head.** A token under the old key fails whether it
   names the new head or the old one.

## Cross-check with didwebvh-ts

`didwebvh-ts` 3.1.0 (DIF) as a devDependency, without a network: its
`resolveDID` takes a `fetch` option, its `resolveDIDFromLog` a log in
memory.

1. **log.ts writes did:webvh, didwebvh-ts resolves it.** Three entries under
   `example.com` and under `example.com%3A8443:dids:alice`: fetched from
   `https://example.com/.well-known/did.jsonl` and
   `https://example.com:8443/dids/alice/did.jsonl`, no error, the same
   `versionId`, the same document plus the implicit `#files` and `#whois`
   services, every earlier version by `versionId`. A deactivated log is
   deactivated there.
2. **didwebvh-ts writes, log.ts verifies.** A log from `createDID` with
   pre-rotation, two `updateDID` (the second turns pre-rotation off) and
   `deactivateDID`: valid at each of the four stages, deactivated at the
   end.
3. **Tampered logs: 37 of 42 rejected by both, none accepted by log.ts.**
   didwebvh-ts accepts a proof given twice and a proof object instead of a
   list (both for either entry), and an extra property in the first entry,
   which it does not hash (it rebuilds the first entry from its four signed
   fields; in a later entry the same change breaks the entry hash).
4. **didwebvh-ts takes no log without a host**: did:vh and did:scid:vh:1
   logs fail with "'did:vh:1.0' is not a supported method version." No
   foreign implementation checks the host-free names.

## Where this reads the text one way, or departs from it

- Whole seconds for `versionTime` (a did:vh rule) apply to did:webvh too;
  did:webvh 1.0 does not ask for them. didwebvh-ts writes whole seconds.
- `proof` must be a list of exactly one proof, and an entry carries only
  the five properties ("Each entry is a JSON object consisting of the
  following properties"). The JSON schema of did:webvh 1.0 allows a bare
  proof object and does not forbid other properties.
- `null` in `parameters` is rejected. did:webvh says resolvers SHOULD take
  it as the default value; did:vh says it MUST NOT be used.
- Not supported, and rejected rather than skipped: witnesses (a non-empty
  `witness`), `portable: true`, a change of `method`. For a well-formed
  `method` of a later version did:vh asks for `featureNotSupported`; here
  every such log is invalid.
- `state.id` must be the DID in every entry (no portability); did:webvh
  only needs one entry to match the resolved DID.
- The proof's `created` must be a UTC time (the library's `diVerify`); the
  methods say nothing about it.
- The `method` of did:scid:vh:1 is `did:vh:1.0`. No text specifies it; the
  did:vh note "Future use by did:scid:vh" describes that case and leaves it
  undefined.
- The `versionId` in the token's `kid` is our convention, not from SIOPv2.

## What it does not show

- The first entry from a seed: `versionTime` is a parameter of `create`;
  whether a fixed time is allowed is open.
- Settling a contested identifier, moving an account to a new identifier,
  or which of two branches is the owner's.
- Concurrency: the service is in memory and single-threaded; taking the
  log, spending the nonce and admitting the account are not one stored
  transaction.
- The login demo, the app, the library, a bridge, a signed request: none is
  changed or used.
- Several update keys, several authentication keys, other key types.
