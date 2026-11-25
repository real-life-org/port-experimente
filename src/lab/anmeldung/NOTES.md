# Logging into a web app with the Web of Trust app (SIOPv2-shaped)

A prototype, not the library and not the app. It asks whether a person can
log into an ordinary web app with the Web of Trust app, in the shape of
Self-Issued OpenID Provider v2 (SIOPv2), with one identifier per web app.
Built 25 November 2026, step 1 of 4.

## What it shows

- `siop.ts`: the request a web app shows (`openid://?…`, request by value:
  `response_type=id_token`, `response_mode=direct_post`, `client_id`,
  `response_uri`, `nonce`, `state`), and the self-issued ID token
  (`iss` = `sub` = a `did:key`, `aud` = the web app, `nonce`, `iat`, `exp`,
  optionally `name`), signed as a compact JWS with EdDSA. The key id is the
  `did:key` with its own value as fragment.
- `wallet.ts`: what the app does. It shows the host of the web app's
  address, never the self-asserted `client_name`, and refuses when the
  answer would go to another origin than the web app (client_id scheme
  `redirect_uri`). Text shown: "beispiel.org möchte dich anmelden. Es sieht
  nur einen Namen für dich, der nur dort gilt." The person can add a name.
- `webapp.ts`: what the web app does. Start a login for a browser session,
  take the posted answer, check signature, audience, nonce (once), request
  age (5 min) and token time (60 s skew, at most 10 min), then let the
  waiting session in.
- `http.ts`: the same behind HTTP on 127.0.0.1: one page, `/start`,
  `/status` (polled), and the `response_uri` taking
  `application/x-www-form-urlencoded`. The browser session is a cookie.

Tests: `tests/anmeldung.test.ts` (16), `tests/anmeldung-http.test.ts` (4).

Review of #128 (25 November) found three gaps, all fixed with a test that
fails on the first version: concurrent answers could both pass, because the
signature check lay between the lookup and the use of the request; the
wallet's post followed redirects, so the signed token could leave the checked
origin; the server took any session id from the cookie and bound the login
to it. Still open from that angle: the session id is not renewed at login.

## Results

| Promise | Result |
|---|---|
| Login works: QR, confirm, logged in | holds |
| A token for web app A is refused at web app B | holds |
| A second answer to the same request is refused | holds |
| Two concurrent answers to one request: exactly one is taken | holds (claimed before the first await) |
| A refused answer does not use up the request | holds |
| The app's post follows no redirect, so the token reaches no other origin | holds (`redirect: 'manual'`) |
| The server binds a login only to a session id it issued itself | holds (planted ids get a fresh one) |
| Wrong nonce, expired request, expired token, changed content: refused | holds |
| The app refuses an answer address on another origin | holds |
| Two devices of the same person (same root, multi-device stage 1) reach the same account | holds |
| Two web apps see two identifiers; two people get two accounts | holds |
| Whoever started the request is the one logged in | **does not hold** (limit below) |

## Limits

- **The cross-device QR way cannot tell who started the request.** Someone
  who starts a real login at beispiel.org and shows the person its QR code
  is logged in as that person once the person confirms. The app shows the
  right address, so the person sees nothing wrong. Measured in the test
  "Grenze". This is the known weakness of cross-device flows (OpenID4VP
  security considerations describe the same). Ways out, not built: the
  same-device way (link instead of QR, answer back in the same browser), a
  short code shown on both screens that the person compares, or binding the
  answer to the browser that started it.
- **The web app is not authenticated toward the app.** With the client_id
  scheme `redirect_uri` the app can only show the address it was given. A
  signed request (other client_id schemes) is not built.
- **Key derivation outside the library (deviation).** The library derives
  keys only for the closed label registry of Identity §6.1. "A web app I log
  into" is no context there, so `wallet.ts` derives the key with HKDF under
  the experimental info string `x-anmeldung/0.1/` plus the SHA-256 of the
  web app's origin, from the root key material. Whether such a label belongs
  in the registry is open (rltp design note of 25 November, question 3).
- **`did:key` does not survive a key change.** A web app that stores the
  identifier loses the person when the key changes. With an identifier with
  a log (multi-device model 4, E4/E5) the web app has to resolve the log.
- **Local only, http.** A real web app runs on https.

## Next steps

2. A demonstration with a real QR code: laptop browser and phone.
3. The confirmation screen in the v3 app.
4. Authentik locally in Docker with a small bridge that speaks OpenID
   Connect toward Authentik and SIOPv2 toward the app.
