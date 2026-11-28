# Login after the profile: a service with a DID, a signed request, an identifier with a log

A test bench, not the app and not the library. It builds the login profile
`x-anmeldung-log/1`: a SIOPv2 (draft 13) login with an ID token only, with
named rules taken from OpenID4VP 1.0 and RFC 9101. The service has its own
`did:webvh` and signs every request; the person answers with an identifier
with a log (kennung-log), whose keys are derived from the service's verified
SCID. Measured 2026-11-28.

Spec text read: SIOPv2 draft 13 and OpenID4VP 1.0 (local copies, line
numbers below refer to them), RFC 9101 (rfc-editor.org, text), did:webvh 1.0
(identity.foundation/didwebvh/v1.0 and `spec-v1.0/specification.md`),
especially The DID to HTTPS Transformation.

## What is built

- `profile.ts`: the fixed values, the outer link, the Request Object (sign and
  check), where a did:webvh log lives (`locate`), the derivation context.
- `service.ts`: the Relying Party. A `did:webvh` written with
  `kennung-log/log.ts` (update key, pre-rotation, one Ed25519 key in the
  document), key change of the service (`rotateKey`), a signed Request Object
  per login behind a `request_uri`, the answer checked by
  `kennung-log/verifier.ts`, and the lifecycle of one login.
- `http.ts`: the service behind HTTP (endpoints only, no page):
  `/.well-known/did.jsonl`, `/anmeldung-log/start`, `/anmeldung-log/anfrage/<id>`
  (request_uri), `/anmeldung-log/antwort` (redirect_uri), `/anmeldung-log/status`,
  `/anmeldung-log/fertig`.
- `wallet.ts`: the demo wallet as a module. Fetch with limits, resolve and
  verify the service's log, check the request, derive the keys, create and
  store the person's log at the first login, sign, answer, cancel, change the
  person's key.
- `vector.ts`, `vector.json`: one complete positive vector.

Not reused by import from `src/lab/anmeldung/`: its `WebApp` writes the old
request (unsigned, `subject_signed`, `response_uri`) and checks a `did:key`
token, its HTTP helpers are not exported. Rebuilt here after it, unchanged in
behaviour: the attempt (vorgang) bound to the starting browser by a cookie of
its own (`v_<id>`), collecting exactly once into a fresh signed-in cookie, the
same-device way with its own short-lived cookie and a one-time
`response_code` (60 s, used up by any attempt) in the `redirect_uri` of the
HTTP answer, claiming a request before the first await. Not rebuilt: the
page, renewing a QR code (`/erneuern`), the cap on open requests, the sweep,
the demo wallet page.

## The flow

1. The service starts a login: it takes a nonce from the verifier
   (`issueNonce`), signs the Request Object with the key of its head, and keeps
   it behind `https://<origin>/anmeldung-log/anfrage/<random>`.
2. QR code or link: `https://web-of-trust.de/a#client_id=decentralized_identifier%3A<DID>&request_uri=<...>`.
3. The wallet, before anything is shown: the outer link must have both
   parameters (a link without `request_uri` or with `request` is refused,
   nothing is fetched); the DID must be a `did:webvh`; its HTTPS location is
   computed; the `request_uri` must be on that origin; the log is fetched,
   verified as the log of exactly that DID, not deactivated, and for a known
   service it must continue the held log; the Request Object is fetched and
   checked against the key its `kid` names in the head's document; its
   `redirect_uri` must be on exactly the HTTPS origin of the DID (host and
   port).
4. The person confirms: keys from the secret and the verified SCID; at the
   first login the log of the identifier is created (current time) and stored
   before anything is sent; the ID token (`iss` = `sub` = the DID, `aud` = the
   whole `client_id`, `nonce`, `iat`, `exp` 300 s later, `kid`
   `<did>?versionId=<head>#key-1`); a POST with `id_token`, `state`, `did_log`
   to the `redirect_uri`, no redirect followed.
5. The service: `state` names the request; exactly one answer per request;
   `verifier.login` checks log, token (signature under the head, `aud` equal to
   the whole `client_id`, `iss` = `sub` = the DID, nonce issued here and spent
   once, time) and the held log state. `ok` logs in the starting browser (QR) or
   returns `redirect_uri` with a one-time code (same device).

## Where each rule comes from

| Rule | Source |
|---|---|
| `response_type=id_token`, `scope=openid`, `id_token_type=subject_signed_id_token` | SIOPv2 Z. 453 |
| Request by reference; with `request_uri` only `client_id` beside it | SIOPv2 Z. 455–459; RFC 9101 5.2, 5.2.2 |
| `client_id` outside equal to `client_id` inside; only the Request Object's parameters are used | RFC 9101 5 ("MUST only use the parameters included in the Request Object"), 6.3, 10.7 |
| No `request` or `request_uri` inside the Request Object | RFC 9101 4 |
| `typ` = `oauth-authz-req+jwt`; refused without it | OpenID4VP 1.0 Z. 268 (taken over); RFC 9101 10.8 recommends it for new profiles |
| `aud` = `https://self-issued.me/v2` | SIOPv2 Z. 505 (static discovery) |
| `iss` in the Request Object is written and ignored | RFC 9101 4 (SHOULD contain `iss`); OpenID4VP 1.0 Z. 270 (Wallet MUST ignore it) |
| `client_id` = `decentralized_identifier:<DID>`; request MUST be signed; key by `kid` from `verificationMethod`; DID resolution by the method | OpenID4VP 1.0 Z. 600 (taken over; SIOPv2 Z. 340 refers to a placeholder) |
| Signature check, `kid` must name a key of the client | RFC 9101 6.2 |
| `client_metadata` with `subject_syntax_types_supported` (`did:vh`), `client_name` as text | SIOPv2 Z. 412–415 |
| `nonce` in every request | SIOPv2 Z. 461 |
| `response_mode=direct_post`, the address in `redirect_uri`, for both ways | SIOPv2 Z. 509–512 |
| POST, `application/x-www-form-urlencoded`, no redirect followed | SIOPv2 Z. 574–578 |
| `user_cancelled`, `subject_syntax_types_not_supported` | SIOPv2 Z. 590–602 |
| ID token: `iss` = `sub`, `aud` contains the `client_id`, signature by the `kid` key of the resolved document, `sub` = `id`, `exp`, `nonce` | SIOPv2 Z. 662–671 |
| Nonce known to the RP and not used before | SIOPv2 Z. 677 |
| `aud` is the whole `client_id` with the prefix | OpenID4VP 1.0 Z. 1907–1909 (taken over) |
| Extra field `did_log` in the answer | OpenID4VP 1.0 Z. 1168–1172 allows additional response parameters; name, format, duty to check are profile rules |
| 200 with JSON after a processed answer or error; `redirect_uri` in that JSON with a fresh random value | OpenID4VP 1.0 Z. 1276–1287 (taken over for the `redirect_uri` endpoint) |
| Log URL: `https://<host>[:<port>]/.well-known/did.jsonl`, or `/<path>/did.jsonl` with path segments; `text/jsonl` | did:webvh 1.0, The DID to HTTPS Transformation, steps 1–6 |
| The SCID of the requested DID must be that of the log; the log must be that DID's | did:webvh 1.0, Read; kennung-log `verify(..., { did })` |
| `request_uri` an https URI | RFC 9101 5.2 |
| Request Object served as `application/oauth-authz-req+jwt` | RFC 9101 4 |

## Profile rules (ours, not from a spec)

- **`did_log`**: the form field with the person's log as JSON Lines (the
  did.jsonl form). The service verifies it with `kennung-log/log.ts` under the
  identity profile (default did:vh) and keeps its state (`verifier.ts`).
- **Derivation context**: `HKDF-SHA-256(secret, salt empty, info, 32)` as the
  Ed25519 seed, with `info` the JCS of
  `{index, method, profile, purpose, role, scid}`: `profile`
  `x-anmeldung-log/1`, `purpose` `login identifier`, `method` `did:webvh`,
  `scid` the SCID of the verified service log, `role` `update` or `auth`,
  `index` 0, 1, … (key n of each role). JCS delimits every value. The SCID
  reaches the derivation only through `Checked.scid`, which only `evaluate`
  sets, from `verify`. Outside the library: the library derives keys only for
  its closed label registry (as in `src/lab/anmeldung/`).
- **Keys of the person's log**: genesis with update key 0, committed to update
  key 1, authentication key 0; the change n signs with update key n, commits
  to n+1, authentication key n.
- **Origin rules**: `redirect_uri` exactly on the HTTPS origin of the DID
  (profile section 9); the `request_uri` too, so that nothing is fetched from
  anyone but the service (profile section 10.3); the same-device return opened
  only on that origin.
- **Fetch limits**: https only, Request Object at most 16 KiB, log at most
  256 KiB, answer at most 16 KiB, 5 s, no redirect followed, no credentials in
  the URL, no host that is an IP address, `localhost`, `*.localhost`, `*.local`
  or `*.internal`. Tests only: `loopbackForTests` fetches `https://*.localhost:<port>`
  over http from 127.0.0.1.
- **Request Object window**: `iat` and `nbf` at most 60 s ahead, `exp` later
  than now, `exp − iat` at most 300 s. `crit` is refused. `response_uri` in
  the Request Object is refused (this profile uses `redirect_uri`).
- **Known service**: the wallet keeps the service's log per SCID when the
  person confirms; a later log must have the held head at the same position.
  A shorter log is refused too.
- **The key that signs requests** is the document's one `authentication` key
  (that is what `kennung-log/log.ts` writes and rotates); OpenID4VP asks only
  that it be in `verificationMethod`. Its `kid` is `<did>#key-1`, without
  `versionId`; the wallet checks it against the head it just verified.
- **Refusals by the service**: HTTP 400 with JSON `error` `invalid_request`,
  `error_description`, `did_log_result` (`stale`, `contested`, `invalid`,
  `unsupported`) and, for `stale`, `held_version_id`. OpenID4VP does not define
  an answer for a refused response.
- **One answer per request**: the verifier spends the nonce in its step
  whatever the result, so a request ends with its first answer that is read,
  also a refused one or an error (the old demo kept a refused answer's request
  open).
- **Errors from the wallet** go only to the `redirect_uri` of a request that
  passed every check; a request that failed a check gets no answer at all.
  `user_cancelled` is shown to the waiting browser.

## Measured

`tests/anmeldung-log-http.test.ts` (14, over HTTP on 127.0.0.1):
first login with two devices and on the same device; return; key change of
the person; second wallet with the old state is `stale` and told the head;
two continuations `contested`, then the owner too; key change of the service,
the wallet follows; a held service log that the new one does not continue is
refused; another service gives another identifier and other keys; two wallets
with the same secret derive the same keys, and their first entries (other
times) give two identifiers; cancel; the same answer twice; wrong `aud`;
expired request; a DID method the service does not list.

`tests/anmeldung-log.test.ts` (29): every refusal sends nothing. Changed
request, `kid` not in the document, `kid` of another DID, another key under the
right `kid`, `client_id` outside ≠ inside (also without the prefix inside),
`redirect_uri` on another host, another port, over http, unsigned
(`alg: none`), no `typ`, expired, too long a window, wrong `aud`,
`response_uri` instead of `redirect_uri`, `id_token_type=subject_signed`, a
log of another DID, a log changed after signing, another service's SCID in the
DID text with that service's log, `request_uri` on another origin, a redirect
on the log fetch, a log too large; refused without any fetch: request by
value, no `request_uri`, `client_id` without prefix, a service DID that is not
`did:webvh`; a claim naming another SCID changes nothing; the transformation
examples of did:webvh 1.0; fetch limits; the return address opened only on the service origin.

`tests/anmeldung-log-vector.test.ts` (3): `vector.json` is what the code builds
from fixed seeds and a fixed time; checked from its texts alone (wallet,
derived keys, ID token signature, service); one changed byte is refused.

Sizes in the vector (bytes): outer link 233 (RFC 9101 asks the request URI to
stay under 512), Request Object 1110, service log 1261 (one entry), person log
1186 (one entry), ID token 688, POST body 2285.

## What it does not show

- Not built: a service moving to another domain (`portable`), services
  without a domain, a second client identifier prefix (`x509_san_dns`), a logo,
  `did:key` as service DID.
- TLS: tests run over plain http on 127.0.0.1 with the explicit test option;
  certificate checks (RFC 9101 8, did:webvh RFC 9525) are the platform's and
  are not exercised. A name that resolves to a local address is not caught
  (only literal addresses and local names); DNS over HTTPS (did:webvh, Read,
  step 3) is not used.
- The two-device way still cannot tell who started the request: the signed
  request proves the service, not that the confirming person sits at the
  browser that is logged in (profile section 9, stage 5).
- One person log per service on one wallet; syncing between devices is a copy
  of the state (`MemoryStorage(w.state())`). Backup and recovery of the log
  (profile section 11) are not modelled; with the same secret a second wallet
  derives the same keys but not the same identifier.
- Settling a contested identifier; deactivation of a person's identifier at
  the service beyond what `verifier.ts` already measures.
- Name or picture of the person: the ID token carries none.
- App 3.3.1 does not speak this format; `src/lab/anmeldung/` stays for it.
- All state is in memory.
