# A login identifier with a log, at one service

A did:webvh 1.0 log written and verified without witnesses, watchers or a
web location (`log.ts`), and the verifier of a service that keeps one copy
of each identifier's log (`verifier.ts`). The DID string is a template with
`{SCID}` and `parameters.method` is a setting (`profiles.ts`): the same code
writes and verifies `did:webvh:{SCID}:<host>`, `did:vh:{SCID}` and
`did:scid:vh:1:{SCID}`. Where the two texts differ, the profile names whose
rules apply (`family`: did:vh or did:webvh). JCS, base58btc and
`eddsa-jcs-2022` come from the library; nothing else. Measured 2026-11-28;
the full table is `scenarios.expected.json`.

Spec text read from the sources: did:webvh `spec-v1.0/specification.md` and
`schemas/v1.0/log_entry.json`, did:vh `spec/specification.md` (both on
`main`, read 2026-11-28), didwebvh#305, RFC 7515.

## The log

`create` writes the first entry (Create, steps 1 to 6): one or more update
keys, the hashes of the next ones (pre-rotation), a document with one
Ed25519 key for `authentication`. `rotate` lets the committed key sign,
commit to a new one, and changes the document's key or keeps it. A key
change replaces only the public key of the one verification method and
keeps every other member of the document (`service`, `alsoKnownAs`, ...).
A document with other than exactly one verification method, listed as the
only entry of `authentication`, is refused with an error: it is unclear
which key the change replaces. One rule, checked on the result: `loginKeys` (log.ts) lists the keys the
login can use in a document, each with the `kid` fragment it is found under
(method id exactly `<did>#<fragment>`, non-empty fragment, no path or query, no
relative id; `Multikey` controlled by the DID; Ed25519). The verifier reads
keys only through it. `create` and `rotate` call it on the new document before
signing and throw unless it yields exactly the new key (or, without a key
change, the same keys as before), so no entry is written whose result the
login cannot use, for whatever reason.
`deactivate` turns pre-rotation off and writes `deactivated: true` with
`updateKeys: []` one second later (two entries, as Deactivate says for a DID
under pre-rotation). `append` writes any entry, signed by any key, for the
cases that break a rule. `fromJsonl` reads JSON Lines strictly: at most one
final newline, every other line, a blank one included, must hold a JSON
value, else the input is invalid. did:webvh 1.0 (The DID Log File) says each
entry has "all extra whitespace removed, a \n character appended, and the
result added to the DID Log file"; it says nothing about empty lines, so this
is the stricter reading, not a rule of the spec.

`verify` copies its input (as JSON) and checks the copy, entry by entry:
parameters, the keys that may sign (pre-rotation or not), the proof,
`versionId`, the SCID of the first entry, the entry hash, `versionTime`,
`state.id`. The log is valid only if every entry is (Applying Peer-to-Peer
Updates resolves with the `versionId` of the last entry). The result is
`ok`, `invalid`, or `unsupported` (did:vh `featureNotSupported`): a
well-formed log with a version or a feature this code does not build.

Measured:

1. **Every tampered log is rejected.** 20 kinds of change, each to the
   first and to the second entry of a three-entry log, plus a removed and
   a swapped entry: 42 of 42 rejected, under each of the three names. The
   26 changes outside the proof again, re-signed with the key that signed
   the entry: 26 of 26 rejected, under did:vh (by the SCID, the entry hash,
   the version number, pre-rotation or the parameter rules).
2. **The rules hold where the hash chain does.** Under did:vh, 23 entries an
   authorized key wrote that each break or test one rule: 16 invalid (time
   not later, not whole seconds, no zone or another zone, more than 5
   minutes ahead, a missing `nextKeyHashes` under pre-rotation, `scid`
   later, a lower `method`, `portable` under did:vh, `null`, a string
   `ttl`, another `state.id`, and an entry after `updateKeys: []` without
   pre-rotation, also when that entry set new `nextKeyHashes`), 4
   unsupported (`method` `did:vh:1.1` or `did:vh:99.0`, a witness, a
   watcher), 3 valid (a time 4 minutes ahead, `method` repeated unchanged,
   and `deactivated: true` in one entry under pre-rotation with the update
   keys kept: did:vh says "there is no need to also remove the authorized
   keys").
3. **Under did:webvh, 11 entries where its text differs.** Fractional
   seconds are valid, in the first entry and later, and "strictly greater"
   is compared on the digits. `state.id` is parsed by the
   `webvh-method-specific-id` ABNF: an empty host and a host without a dot
   are invalid. `portable: true` is unsupported in the first entry and
   invalid later. A watcher is unsupported, a watcher that is not an
   http(s) URL invalid. An entry after `updateKeys: []` that set new
   `nextKeyHashes` is valid: did:webvh 1.0 has no rule against it (did:vh
   has, see 2).
4. **Several update keys.** Two keys in the first entry: the second may
   sign the next entry. Two committed keys declared together under
   pre-rotation: either signs. A committed and an uncommitted key declared
   together: rejected, whichever signs.
5. **The same keys and time under three names give three SCIDs.** The DID
   string is in the first entry, so the SCID differs; each log is valid
   under its own name only (under another: another `method`, or the
   `state.id` is not the DID). A name chosen now cannot be changed later
   without a new identifier.
6. **Size.** In JSON Lines, UTF-8 bytes, with one key in the document:
   1186 bytes for the first entry under did:vh, 1108 for a key change, 1060
   for turning pre-rotation off, 1010 for the deactivation. did:scid:vh:1
   adds 28 bytes per entry, did:webvh with `example.com` 59 to 62.

## The service

One verifier, one copy per identifier. The verifier issues a nonce for
each login request; a login brings the whole log and a compact JWS (EdDSA)
whose `kid` is a DID URL with the DID Core parameter `versionId`:
`<did>?versionId=<versionId>#key-1`, the head it was signed under. Results
are values: `ok`, `stale` (with the head the service holds), `contested`,
`invalid` with a reason, `unsupported`.

A login runs in two parts. First, without state, on a private copy of the
input: the log, and the token against the head of that log (signature,
`kid`, audience, nonce claim equal to the request's nonce, no `crit`).
Then one step per DID (`Store.transact`): take the time, compare with the
held log, keep evidence, check the nonce's expiry and the token's `iat` and
`exp` against that time, admit or refuse, against what is held at that
moment, and spend the nonce only with an admitted login. Keeping the log
state and admitting the login are kept apart inside that step: evidence is
kept whatever the login; the nonce is spent only when the login is
admitted. A caller can hook into the step (`before`: the answer is not
considered at all; `admit`: the caller refuses or takes an admitted login
in the same step). The memory store runs that step without a pause; the
interface is shaped so that a database can run it as one transaction.

| Case | Result |
|---|---|
| first contact | ok; the head is kept |
| an honest key change | ok, continued; the new head is kept |
| a device with the old state | stale, the service names the head it holds; after syncing, ok |
| an older log played back, with the old authentication key | stale; nothing changes |
| two continuations, the owner first | the owner ok; the copy contested; from then on both contested |
| two continuations, the copy first | the copy ok; the owner contested; from then on both contested |
| two continuations at the same moment | one ok, the other contested; both branches kept |
| a login that began before the identifier was contested, decided after | contested |
| a token by the old key, naming the new head | invalid (signature) |
| a token by the old key, naming the old version | invalid (not under the head) |
| a new head with the authentication key unchanged, a token naming the old head | invalid (not under the head) |
| a valid continuation with a failing token | invalid; the continuation is kept; the nonce stays open; a sibling of it is then contested |
| a token for another nonce, or another refused answer | invalid; the nonce stays open; a right answer then is ok while the nonce is still open and the identifier still eligible: not after what the refused answer left kept stands against it (after a kept deactivation: invalid with the deactivated log, stale with an older one; after a kept fork: contested; after a kept continuation: an answer under the older head is stale) |
| a continuation with a key that was not committed | invalid; nothing locked; the owner's continuation is taken after it |
| deactivation | invalid (deactivated), and the deactivation is kept; an old device is stale; an entry after it is invalid |
| a tampered log | invalid; nothing locked |
| the same answer twice, one after the other or at once | one ok, then invalid (nonce already used) |
| a nonce not issued here, or expired | invalid |
| a token with `crit` | invalid (RFC 7515 4.1.11: an extension not understood makes the JWS invalid; this verifier understands none) |

1. **The first valid continuation stands.** A second one that does not
   continue the held log is a fork: both branches are kept as evidence and
   the identifier is contested; while contested, every login is refused,
   the owner's too. Who reached the service first decides which head it
   holds; it cannot tell which branch is the owner's.
2. **A verified continuation is kept, whatever the login.** did:vh,
   Applying Peer-to-Peer Updates, step 4: "If resolution succeeds, replace
   the held DID Log and witness proofs file with the ones used in step 3.
   Otherwise, reject the update and keep the held files unchanged."
   Resolution there is of the log alone; a login token is not part of it.
   So a valid continuation replaces the held log even when its token fails
   (wrong key, wrong nonce); the login is refused. From then on a sibling
   branch is a fork, and a token under the old head no longer admits.
   Exceptions: on first contact the log is kept only with a login that
   holds, or when it is deactivated (our choice: a service does not keep
   logs of identifiers that never logged in).
3. **Invalid and unsupported input is no evidence.** A log that fails
   verification changes nothing, contests nothing.
4. **The token names its head.** A token under an earlier head fails,
   whether its key changed or not: the `versionId` in the protected `kid`
   must be the head's.
5. **A nonce is spent once, by an admitted login.** It is issued by the
   verifier with an expiry (300 s by default) and spent in the step by the
   first login that names it and is admitted; a refused answer leaves it
   open, so an invalid or misdirected answer cannot use up a request (SIOPv2
   asks for nonce equality and replay protection and leaves the way to the
   RP). The same valid answer twice, one after the other or at once, is ok
   at most once. The clock is read in the step,
   so a nonce or token that expires while the call waits for the store is
   not `ok`. Issuing a nonce drops the ones that have expired (spent ones
   stay until their expiry, so a replay still reads "already used"; after
   that it reads "not issued here").

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
   The five others are of two kinds:
   - *A finding about the library.* An extra property in the first entry
     is accepted: didwebvh-ts rebuilds the first entry from its four signed
     fields and checks SCID, entry hash and signature on that projection
     (`src/core/resolution.ts` in its source map, lines 497 to 530),
     so the added property is in none of them. Whether or not other
     properties are allowed, Verify the Entry Hash hashes the entry as
     given, with `proof` removed and `versionId` replaced. In a later entry
     the same change breaks the entry hash there too.
   - *An unclear place in the spec.* A proof given twice and a proof object
     instead of a list (each for either entry) are accepted. The log
     section shows `"proof" : []`, Update step 8 speaks of a proof object,
     and the JSON schema allows an object or an array without `maxItems: 1`.
     A doubled identical proof shows no further authority.
4. **didwebvh-ts takes no log without a host, and the host is the cause.**
   With `method` `did:webvh:1.0` in all three: the log with `example.com`
   resolves; the same log without a host fails with "state.id must include
   SCID and domain segments"; under the did:vh name "state.id must be a
   valid did:webvh identifier". With `method` `did:vh:1.0` (did:vh and
   did:scid:vh:1) it fails earlier, on the method. No foreign
   implementation checks the host-free names.

## Where this reads the text one way, or departs from it

- `versionTime`: whole seconds under did:vh (its rule), fractional seconds
  allowed under did:webvh. `proof.created` is checked by the library's
  `diVerify`: it must be present, a UTC time (`Z` or `+00:00`) with at most
  three fractional digits and a valid calendar date, and it is signed; it
  is not compared with `versionTime` or the clock. The did:webvh schema
  lists `created` as optional.
- `create` takes `versionTime` as a parameter, and the tests pass fixed
  times. That is for reproducible tests only: both methods ask for the
  current time when the SCID is generated (did:webvh "the current time in
  UTC ISO8601 format", did:vh "the current time in UTC ISO8601 format in
  whole seconds").
- `proof` must be a list of exactly one proof, and an entry carries only
  the five properties. This is a rule of this test bench, not a duty
  did:webvh states without doubt: the prose lists five properties and
  shows a list, the schema allows a bare proof object, more than one
  proof, and does not forbid other properties.
- `null` in `parameters` is rejected. Both methods forbid producers to use
  it; did:webvh's note asks resolvers to accept it from early
  implementations as the default value.
- Not built, and `unsupported`: a `method` of another well-formed version
  (did:vh: `featureNotSupported`; did:webvh only says resolution
  terminates, so the same classification is ours there), a non-empty
  `witness`, a non-empty `watchers`, `portable: true` in the first did:webvh
  entry. A non-empty `witness` that is malformed is `invalid`: no
  `threshold` or one that is not an integer from 1 to the number of
  distinct witness ids, an empty or missing `witnesses`, an `id` that is
  not an Ed25519 did:key, or duplicate ids (did:vh, The witness Parameter;
  did:webvh 1.0 states the same). An entry with an unknown `method` is not processed further; for
  the other features the rest of the entry must verify first, else it is
  `invalid`. A lower `method` is invalid.
- `updateKeys: []` without pre-rotation ends the log under did:vh (its
  Authorized Keys: "every later entry fails verification, including one
  that sets a non-empty nextKeyHashes or new updateKeys"); under did:webvh
  1.0 there is no such rule and such a log continues.
- did:webvh `state.id`: parsed by the ABNF with the rules beside it (dotted
  name, labels by RFC 1123, port 1 to 65535, no IP address, path segments).
  A percent-encoded ASCII character that no host name has (`%20`, `%2F`,
  `%00`) is `invalid`. Not done: IDNA processing (a name that decodes to
  non-ASCII, with only host-name characters in ASCII, is unsupported) and the TLS server identity check of RFC 9525.
- `state.id` must be the DID in every entry (no portability); did:webvh
  with portability only needs one entry to match the resolved DID, and the
  SCID to match in every entry.
- The `method` of did:scid:vh:1 is `did:vh:1.0`. This is an assumption of
  this experiment and says nothing about what interoperates today: the
  did:vh draft says "this specification does not define that case".
- The `versionId` in the token's `kid` is a rule of this login profile;
  SIOPv2 does not ask for it.

## What it does not show

- Settling a contested identifier, moving an account to a new identifier,
  or which of two branches is the owner's.
- Storage: the store is in memory. Its one step is the shape a database
  transaction would take; no database runs it here.
- The login demo, the app, the library, a bridge, a signed request: none is
  changed or used.
- Several authentication keys, other key types.
