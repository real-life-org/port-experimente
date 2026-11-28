# Login after the profile: a service with a DID, a signed request, an identifier with a log

A test bench, not the app and not the library. It builds the login profile
`x-anmeldung-log/1`: a SIOPv2 (draft 13) login with an ID token only, with
named rules taken from OpenID4VP 1.0 and RFC 9101. The service has its own
`did:webvh` and signs every request; the person answers with an identifier
with a log (kennung-log), whose keys are derived from the service's verified
SCID. Measured 2026-11-28.

Spec text read: SIOPv2 draft 13 and OpenID4VP 1.0 (local copies, line
numbers below refer to them), RFC 9101 and RFC 6749 (rfc-editor.org, text),
did:webvh 1.0 (identity.foundation/didwebvh/v1.0 and
`spec-v1.0/specification.md`), especially The DID to HTTPS Transformation.
For the transport: the IANA IPv4 and IPv6 Special-Purpose Address
Registries and the IANA Internet Protocol Version 6 Address Space registry
(iana.org, read 2026-11-28; the two special-purpose registers last updated
2025-10-09), RFC 6052, RFC 3056, RFC 4380 (rfc-editor.org, text).

## What is built

- `profile.ts`: the fixed values, the outer link, the Request Object (sign and
  check), where a did:webvh log lives (`locate`), the derivation context.
- `service.ts`: the Relying Party. A `did:webvh` written with
  `kennung-log/log.ts` (update key, pre-rotation, one Ed25519 key in the
  document), key change of the service (`rotateKey`; a service opened on an
  existing log takes its key state from the head: the index whose derived
  key is the head's login key, with update key and pre-rotation commitment
  matching, else opening throws, also for a deactivated log), a signed Request Object
  per login behind a `request_uri`, the answer checked by
  `kennung-log/verifier.ts`, and the lifecycle of one login.
- `http.ts`: the service behind HTTP (endpoints only, no page):
  `/.well-known/did.jsonl`, `/anmeldung-log/start`, `/anmeldung-log/anfrage/<id>`
  (request_uri), `/anmeldung-log/antwort` (redirect_uri), `/anmeldung-log/status`,
  `/anmeldung-log/abbrechen` (the starting browser gives the attempt up),
  `/anmeldung-log/fertig`.
- `wallet.ts`: the demo wallet as a module. Resolve and verify the service's
  log, check the request, derive the keys, create and store the person's log
  at the first login, sign, answer, cancel, change the person's key. All its
  writes go through one step (`commitState`) with a condition on the result;
  every POST goes through one gate (`#send`). Its state and inner methods are
  JavaScript private fields (`#`).
- `transport.ts`: how the wallet reads (GET) and sends (POST): size cap, time
  limit, no redirect, https only; the default transport is `node:https` with
  a lookup that connects only to globally reachable addresses, after the two
  IANA special-purpose registers held as data in the file. Tests give the
  wallet their own transport (`tests/anmeldung-log-loopback.ts`).
- `vector.ts`, `vector.json`: one complete positive vector.

Not reused by import from `src/lab/anmeldung/`: its `WebApp` writes the old
request (unsigned, `subject_signed`, `response_uri`) and checks a `did:key`
token, its HTTP helpers are not exported. Rebuilt here after it, unchanged in
behaviour: the attempt (vorgang) bound to the starting browser by a cookie of
its own (`v_<id>`), collecting exactly once into a fresh signed-in cookie, the
same-device way with its own short-lived cookie and a one-time
`response_code` (60 s, used up by any attempt) in the `redirect_uri` of the
HTTP answer, the sweep of what has run out (on every request and on a timer
that does not keep the process alive). Not rebuilt: the page, renewing a QR
code (`/erneuern`), the cap on open requests, the demo wallet page.

## The flow

1. The service starts a login: it takes a nonce from the verifier
   (`issueNonce`), signs the Request Object with the key of its head, and keeps
   it behind `https://<origin>/anmeldung-log/anfrage/<random>`.
2. QR code or link: `https://web-of-trust.de/a#client_id=decentralized_identifier%3A<DID>&request_uri=<...>`.
3. The wallet, before anything is shown: the outer link must have both
   parameters (a link without `request_uri` or with `request` is refused,
   nothing is fetched); the DID must be a `did:webvh`; its HTTPS location is
   computed; the `request_uri` must be on that origin; the log is fetched,
   verified as the log of exactly that DID, and for a known service it must
   be the held log or continue it; a deactivated head is refused and kept;
   the Request Object is fetched and checked, with the time after the fetch,
   against the key its `kid` names in the head's document; its
   `redirect_uri` must be on exactly the HTTPS origin of the DID (host and
   port). The caller gets a frozen view of the request; the checked state
   stays in the wallet.
4. The person confirms: in one step, at that moment, the request must still
   be in its window and the service head it was checked under must be the
   held one or continue it; then the head and, at the first login, the
   identifier (keys from the secret and the verified SCID, log at the current
   time) are stored. The ID token is signed (`iss` = `sub` = the DID, `aud` =
   the whole `client_id`, `nonce`, `iat`, `exp` 300 s later, `kid`
   `<did>?versionId=<head>#key-1`). Then the gate, synchronously right before
   the POST: the request still in its window, the held service head still
   the checked one or its continuation (not deactivated), and the person's
   held head still the one the token names; if only that last one moved (a
   key change meanwhile), the token is signed again under the held head.
   Otherwise nothing is sent. The POST carries `id_token`, `state`, `did_log`
   to the `redirect_uri`, no redirect followed.
5. The service: `state` names the attempt; `verifier.login` checks log,
   token (signature under the head, `aud` equal to the whole `client_id`,
   `iss` = `sub` = the DID, the nonce of this open attempt, time) and the
   held log state. Only an admitted login ends the attempt: in the verifier's
   step that spends the nonce it is handed out to the starting browser (QR)
   or as a one-time code in the returned `redirect_uri` (same device).
   Collecting or redeeming issues the session in one store step that looks
   at the identifier again.

## Where each rule comes from

| Rule | Source |
|---|---|
| `id_token_type=subject_signed_id_token` | SIOPv2 Z. 453 |
| `response_type=id_token`, `scope=openid` | SIOPv2 Z. 234–237 (a Self-Issued OP supports `id_token` and `openid`); the request shape is OpenID Connect's (Z. 445); the values are the profile's choice |
| Request by reference; `client_id` is the only further required parameter, the link carries just these two | SIOPv2 Z. 455–457; RFC 9101 5.2, 5.2.2 |
| Further parameters in the outer link are ignored and steer nothing | RFC 6749 3.1 ("MUST ignore unrecognized request parameters"); RFC 9101 5 ("MUST only use the parameters included in the Request Object") |
| `client_id` outside equal to `client_id` inside; only the Request Object's parameters are used | RFC 9101 5 ("MUST only use the parameters included in the Request Object"), 6.3, 10.7 |
| No `request` or `request_uri` inside the Request Object | RFC 9101 4 |
| `typ` = `oauth-authz-req+jwt`; refused without it | OpenID4VP 1.0 Z. 268 (taken over); RFC 9101 10.8 recommends it for new profiles |
| `aud` = `https://self-issued.me/v2` | SIOPv2 Z. 505 (static discovery) |
| `iss` in the Request Object is written and ignored | RFC 9101 4 (SHOULD contain `iss`); OpenID4VP 1.0 Z. 270 (Wallet MUST ignore it) |
| `client_id` = `decentralized_identifier:<DID>`; request MUST be signed; key by `kid` from `verificationMethod`; DID resolution by the method | OpenID4VP 1.0 Z. 600 (taken over; SIOPv2 Z. 340 refers to a placeholder) |
| Signature check, `kid` must name a key of the client | RFC 9101 6.2 |
| `client_metadata` with `subject_syntax_types_supported` (`did:vh`), `client_name` as text | SIOPv2 Z. 412–415 |
| `nonce` in every request | SIOPv2 Z. 461 |
| `response_mode=direct_post`, the address in `redirect_uri` | SIOPv2 Z. 509–512 (the cross-device request); for the same device SIOPv2 Z. 541 allows a response mode other than the fragment, and the profile chooses `direct_post` there too |
| POST, `application/x-www-form-urlencoded`, no redirect followed | SIOPv2 Z. 574–578 |
| `user_cancelled`, `subject_syntax_types_not_supported` | SIOPv2 Z. 590–602 |
| ID token: `iss` = `sub`, `aud` contains the `client_id`, signature by the `kid` key of the resolved document, `sub` = `id`, `exp`, `nonce` | SIOPv2 Z. 662–671 |
| Nonce known to the RP and not used before | SIOPv2 Z. 677 |
| `aud` is the whole `client_id` with the prefix | OpenID4VP 1.0 Z. 1907–1909 (taken over) |
| Extra field `did_log` in the answer | OpenID4VP 1.0 Z. 1168–1172 allows additional response parameters; name, format, duty to check are profile rules |
| 200 with JSON after a processed answer or error; `redirect_uri` in that JSON with a fresh random value | OpenID4VP 1.0 Z. 1276–1287 (taken over for the `redirect_uri` endpoint) |
| Log URL: `https://<host>[:<port>]/.well-known/did.jsonl`, or `/<path>/did.jsonl` with path segments | did:webvh 1.0, The DID to HTTPS Transformation, steps 1–5 |
| The service serves the log as `text/jsonl` (SHOULD); the wallet does not require it | did:webvh 1.0, same section, step 6 |
| The SCID of the requested DID must be that of the log; the log must be that DID's | did:webvh 1.0, Read; kennung-log `verify(..., { did })` |
| `request_uri` an https URI | RFC 9101 5.2 |
| Request Object served as `application/oauth-authz-req+jwt` | RFC 9101 4 |
| Nonce compared and not replayed; how is the RP's | SIOPv2 Z. 669, 677 |
| IPv4: refused unless the most specific row says "Globally Reachable: True"; rows nest | IANA IPv4 Special-Purpose Address Registry (every row, footnote 2), table `IPV4_SPECIAL` |
| IPv6: refused unless the most specific row says "Globally Reachable: True"; rows nest | IANA IPv6 Special-Purpose Address Registry (every row, footnote 1), table `IPV6_SPECIAL` |
| IPv6 only from 2000::/3 | IANA Internet Protocol Version 6 Address Space (2000::/3 the one "Global Unicast" block) |
| `64:ff9b::/96` judged by the IPv4 address in its last 32 bits | RFC 6052 2.2 (format), 3.1 (MUST NOT represent non-global IPv4) |
| `2002::/16` (register "N/A", "See RFC 3056") judged by its IPv4 address, bits 16–47 | RFC 3056 2 (`2002:V4ADDR::/48`) |

## Profile rules (ours, not from a spec)

- **`did_log`**: the form field with the person's log as JSON Lines (the
  did.jsonl form). The service verifies it with `kennung-log/log.ts` under the
  identity profile (default did:vh) and keeps its state (`verifier.ts`).
- **Derivation context**: `HKDF-SHA-256(secret, salt empty, info, 32)` as the
  Ed25519 seed, with `info` the JCS of
  `{index, method, profile, purpose, role, scid, subject_method}`: `profile`
  `x-anmeldung-log/1`, `purpose` `login identifier`, `method` `did:webvh`
  (the service's), `scid` the SCID of the verified service log, `role`
  `update` or `auth`, `index` 0, 1, … (key n of each role), `subject_method`
  the method of the person's identifier as its DID begins (`did:vh`,
  `did:scid:vh:1`), so two methods never share keys. JCS delimits every
  value. The SCID reaches the derivation only from the checked state the
  wallet keeps inside; the caller's view is frozen, and a view the wallet did
  not make is refused. Outside the library: the library derives keys only for
  its closed label registry (as in `src/lab/anmeldung/`).
- **Keys of the person's log**: genesis with update key 0, committed to update
  key 1, authentication key 0; the change n signs with update key n, commits
  to n+1, authentication key n.
- **Origin rules**: `redirect_uri` exactly on the HTTPS origin of the DID
  (profile section 9); the `request_uri` too, so that nothing is fetched from
  anyone but the service (profile section 10.3); the same-device return opened
  only on that origin.
- **Fetch limits**: https only, Request Object at most 16 KiB, log at most
  256 KiB, answer at most 16 KiB, 5 s for the whole exchange, no redirect
  followed, no credentials in the URL, no IP address as host.
- **Only globally reachable addresses**: the default transport resolves the
  name once in its own `lookup` and connects to exactly those addresses, and
  only if every one of them is globally reachable after the two IANA
  special-purpose registers (an allow rule, not a list of local ranges):
  IPv4 is refused in multicast (224/4) and class E (240/4) and wherever the
  most specific register row does not say "True"; IPv6 is taken only from
  2000::/3, minus the rows there that do not say "True" (documentation
  `2001:db8::/32` and `3fff::/20`, benchmarking `2001:2::/48`, the old ORCHID
  block, the rest of `2001::/23`); Teredo `2001::/32` ("N/A") is refused;
  6to4 `2002::/16` and the Well-Known Prefix `64:ff9b::/96` are judged by the
  IPv4 address inside; everything else outside 2000::/3 is refused, among it
  `64:ff9b:1::/48`, IPv4-mapped and IPv4-compatible addresses, `fc00::/7`,
  `fe80::/10`, `ff00::/8`. ORCHIDv2, AMT, AS112 and the anycast rows the
  registers mark "True" are allowed. A name that answers with one address
  that is not allowed is refused. What is promised is exactly this: the
  wallet connects only to addresses that these two registers mark globally
  reachable; what a device's routing makes of such an address (a local
  NAT64, a VPN, a route to a private network) lies outside it. Shown for
  Node only; for the app (WebView, Capacitor) it is a requirement on its
  HTTP layer.
- **Redirects**: a 3xx is not followed; the exchange is aborted, which
  closes the socket, before the error is returned.
- **Request Object window**: `exp` later than `iat`, `iat` and `nbf` at most
  60 s ahead, `exp` later than now, `exp − iat` at most 300 s; checked at the
  time after the fetch, and again when the person answers or cancels.
  `crit` is refused. `response_uri` in the Request Object is refused (this
  profile uses `redirect_uri`).
- **Known service**: the wallet keeps the service's log per SCID when the
  person confirms; a later log must be the held one or continue it (a shorter
  or forked log is refused). A deactivated head is kept as soon as it is seen,
  also from a request that is refused, and nothing older is taken after it.
  When the person answers or cancels, the head the request was checked under
  is compared with the head held at that moment, in the same step that
  stores, and again in the gate right before the POST: an older confirmation
  after a newer one sends nothing and changes nothing. Every write of the
  wallet (answer, cancel, deactivation, key change) goes through this one
  step, which refuses any result in which a held service log or identifier
  log would go back.
- **One gate before the transport**: the wallet prepares everything first
  (keys derived, token signed, body built); then one function, the only one
  in the module that calls `transport.post`, checks without an await between
  the check and the call: the request's window at that moment, the held
  service head against the checked one, and for an answer the person's held
  head against the one the token names. Answers, `user_cancelled` and
  `subject_syntax_types_not_supported` all go through it. The token sent
  names the head held when it is sent.
- **Private state**: what the wallet checked, its storage, transport and
  secret, and its inner steps are JavaScript private fields and methods
  (`#`); a caller, also one in plain JavaScript, reaches only `profile` and
  the public methods.
- **The key that signs requests** is the document's one `authentication` key
  (that is what `kennung-log/log.ts` writes and rotates); OpenID4VP asks only
  that it be in `verificationMethod`. Its `kid` is `<did>#key-1`, without
  `versionId`; the wallet checks it against the head it just verified.
- **Refusals by the service**: HTTP 400 with JSON `error` `invalid_request`,
  `error_description`, `did_log_result` (`stale`, `contested`, `invalid`,
  `unsupported`) and, for `stale`, `held_version_id`. OpenID4VP does not define
  an answer for a refused response.
- **What ends an attempt**: a login consumes the attempt and its nonce
  atomically exactly when signature, `iss`/`sub`, audience, time and the
  nonce of this open attempt are valid and the account check admits it (not
  `stale`, not `contested`, not deactivated). That happens in the verifier's
  step, which spends the nonce only then, and the login is handed out in the
  same step. Invalid or swapped answers (a token for attempt A under the
  `state` of B; a valid log with an unusable token; no `did_log`, a log that
  does not verify, no `id_token`, another error) leave the attempt and its
  nonce open. Valid evidence (a continuation, a fork, a deactivation) is kept
  by the verifier whatever the login, and a fork locks the identifier.
  `user_cancelled` is acknowledged (200) and shown to the waiting browser,
  but does not end the attempt. Ended for good without a login only by the
  browser that started it (`forget`, `POST /anmeldung-log/abbrechen`, which
  spends the nonce in one store step) and by running out. An answer for an
  attempt that is no longer open at the time of the step decides and keeps
  nothing.
- **Store**: the verifier's `Store` (`transact`, one step per DID, the nonce
  spent only with an admitted login) and two further steps of the service
  (`LoginStore`): `closeAttempt` (an attempt ends without a login: its nonce
  is spent and the service's maps change in the same step) and
  `issueSession` (reads the identifier and issues the session in one step,
  writes nothing to the store). The service's maps change in a store step
  only inside its callback, through a journal that is put back when the
  step fails or is tried again.
- **Account and session**: a good answer is handed out in the verifier's step
  (pickup for the waiting browser, or a one-time code). Collecting it, or
  redeeming the code, issues the session in one store step that reads the
  identifier again: contested or deactivated by then, there is no session
  (`{"error":"refused"}`, final). The pickup window (5 min) and the code's
  life (60 s) are read in that step with the time the store gives it, and
  nowhere earlier: a step that waits or is repeated decides with its own time. While the attempt is open the waiting
  browser is told, as a notice that ends nothing, of a cancel
  (`{"error":"user_cancelled"}`) and of an answer that reached the
  verifier's step and was refused (`{"error":"refused"}`).
- **Attempts**: every start is a fresh attempt with its own id; the service
  API takes no session id to reuse.
- **Errors from the wallet** go only to the `redirect_uri` of a request that
  passed every check and still passes them at that moment; a request that
  failed a check gets no answer at all.

## Measured

`tests/anmeldung-log-http.test.ts` (34, over HTTP on 127.0.0.1):
first login with two devices and on the same device; return; key change of
the person; second wallet with the old state is `stale` and told the head;
two continuations `contested`, then the owner too; the waiting browser learns
the refusal; key change of the service, the wallet follows; a held service
log that the new one does not continue is refused; another service gives
another identifier and other keys; two wallets with the same secret derive
the same keys, and their first entries (other times) give two identifiers;
the same answer twice; wrong `aud`; an answer after expiry; a DID method the
service does not list (the attempt stays open). Wallet: an older
confirmation after a newer one sends nothing and keeps the newer head, also
for cancel; the request runs out while the person decides: nothing sent,
nothing stored; the clock reaches `exp` while the wallet derives and signs:
no POST; the service head is deactivated or moves on while it signs: no
POST; a key change lands between signing and sending: the token sent names
the head held at that moment (checked on the POST itself), also with key
changes beside confirmations in several orders; the transport is called
only from the gate, with no await between check and call; the checked state
and the inner methods are not reachable from JavaScript; `commitState`
itself refuses every way a held log or index goes back; two first
confirmations side by side with different genesis times store exactly one
identifier and both send it; a copied or changed view, or another wallet's,
is refused and the view cannot be changed; two confirmations side by side
give one identifier; a key change beside a confirmation keeps the newer
service head. Service: cancel is shown to the waiting browser and leaves
attempt and nonce open; only the starting browser gives the attempt up, and
then the nonce is spent; after a cancel the person can still confirm; no
log, an unreadable log, no token, another error leave the attempt open and
the right answer then logs in; swapped answers between two attempts are
refused by the nonce, both attempts and nonces stay open and both then log
in; a valid continuation with an unusable token is kept, the nonce stays
open, the right answer then logs in; a browser without the attempt's cookie
collects nothing first, and the right one then does; contested between the
answer and the pickup gives no session on either way; an attempt given up
while its answer is checked keeps nothing; fresh attempt ids and the sweep.

`tests/anmeldung-log.test.ts` (40): every refusal sends nothing. Changed
request, `kid` not in the document, `kid` of another DID, another key under the
right `kid`, `client_id` outside ≠ inside (also without the prefix inside),
`redirect_uri` on another host, another port, over http, unsigned
(`alg: none`), no `typ`, expired, `exp` not later than `iat`, too long a
window, wrong `aud`, `response_uri` instead of `redirect_uri`,
`id_token_type=subject_signed`, a log of another DID, a log changed after
signing, another service's SCID in the DID text with that service's log,
`request_uri` on another origin, a redirect on the log fetch, a log too
large; refused without any fetch: request by value, no `request_uri`,
`client_id` without prefix, a service DID that is not `did:webvh`; a claim
naming another SCID changes nothing; further parameters in the outer link
steer nothing; the transformation examples of did:webvh
1.0; the return address opened only on the service origin; the window checked
after a slow fetch; a shorter service log and a deactivated one (kept, also
at first sight); every row of both IANA registers, with an address that row
decides; further addresses (multicast, class E, IPv4 inside IPv6, outside
2000::/3, `64:ff9b:1::/48`, 6to4, Teredo); the default transport with an
injected resolver (refused addresses, a mixed answer refused, a global
address tried, one lookup); the default transport against a real loopback
service (refused, no request reaches it); https, credentials, IP hosts
refused before sending; a fetch with no answer and one that stalls in its
body end after the time limit; a 3xx is aborted and its socket closed well
before the time limit, for GET and POST.

`tests/anmeldung-log-vector.test.ts` (4): `vector.json` is what the code builds
from fixed inputs; checked from its texts alone: both derivations complete,
every key of service and person derived anew from the inputs and the stated
rule, the genesis commitments against the derived update key 1, every field
that repeats another compared (compact JWS against its decoded parts, POST
against token, state and log, logs against DIDs, link against request,
inputs against the parts built from them, the media type of the POST), both
signatures by hand, then wallet and service; one changed byte is refused;
each of eleven changes to a copy (rows removed or doubled, media type,
service name, host, times, request id, both genesis commitments) is
reported.

Sizes in the vector (bytes): outer link 233, `request_uri` 68 (RFC 9101 5.2:
the request URI SHOULD NOT exceed 512 ASCII characters), Request Object 1110,
service log 1261 (one entry), person log 1186 (one entry), ID token 688, POST
body 2285.

## What it does not show

- Not built: a service moving to another domain (`portable`), services
  without a domain, a second client identifier prefix (`x509_san_dns`), a logo,
  `did:key` as service DID.
- TLS: tests run over plain http on 127.0.0.1 with a transport built in the
  test; certificate checks (RFC 9101 8, did:webvh RFC 9525) are `node:https`'s
  and are not exercised. DNS over HTTPS (did:webvh, Read, step 3) is not used.
- A service on a shared origin: the wallet accepts any signed path on the
  DID's origin, so one origin can carry several account spaces under one DID.
  A path as an account space of its own would need a response address bound
  in advance (for example in the DID document); not built.
- Who fetches a request can answer it with a valid identifier of their own:
  that answer is a valid login for this attempt, and in the QR way the
  waiting browser then gets that account. Invalid answers and
  `user_cancelled` no longer end the attempt, but no rule for consuming an
  attempt closes this without a binding to the wallet that is meant, which
  the attempt does not carry.
- The two-device way still cannot tell who started the request: the signed
  request proves the service, not that the confirming person sits at the
  browser that is logged in (profile section 9, stage 5).
- Several devices of one person: a second device does not create its own
  identifier; it gets the log, the rotation index and the key state from
  syncing the person's own devices (here a copy of the state,
  `MemoryStorage(w.state())`). Rotations on two devices without that sync
  make the identifier contested. With the same secret alone a second wallet
  derives the same keys; its first entry gives another identifier when it is
  written in another second, and the same one when written in the same
  second (the time is the only other input). For an existing identifier,
  which may have been rotated, the sync is needed either way. Backup and
  recovery of the log, also after a rotation (profile section 11), are not
  modelled.
- Sessions already running when an identifier becomes contested stay; what
  happens to them is the operator's decision. Settling a contested
  identifier; deactivation of a person's identifier at the service beyond
  what `verifier.ts` already measures.
- Name or picture of the person: the ID token carries none.
- App 3.3.1 does not speak this format; `src/lab/anmeldung/` stays for it.
- All state is in memory.
