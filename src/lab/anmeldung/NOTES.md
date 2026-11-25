# Logging into a web app with the Web of Trust app (SIOPv2-shaped)

A prototype, not the library and not the app. It asks whether a person can
log into an ordinary web app with the Web of Trust app, in the shape of
Self-Issued OpenID Provider v2 (SIOPv2), with one identifier per web app.
Step 1 built 25 November 2026 (#128), step 2 (real QR code on laptop and
phone, and the same-device way) the same day.

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
  After a same-device answer it opens the return address only on the web
  app's own origin (`mayOpen`).
- `webapp.ts`: what the web app does, in two ways as in OpenID4VP.
  *Cross-device*: the browser shows a QR code, the phone answers, the
  waiting browser session is logged in when it polls. *Same-device*: the
  browser opens the app by a link on the same device; the answer logs no one
  in but returns a `redirect_uri` with a one-time `response_code` (valid
  60 s, used up by any attempt), which only the browser session that
  started the request can redeem. Both ways check signature, audience,
  nonce (once), request age (5 min) and token time (60 s skew, at most
  10 min).
- `http.ts`: the web app behind HTTP. One page with two buttons ("Mit dem
  Telefon anmelden" shows a QR code, "Auf diesem Gerät anmelden" opens the
  wallet by link), `/start`, `/status` (polled), the `response_uri`
  (form-encoded), the return `/fertig`, and the demo wallet page.
- `wallet-page.ts`: the demo wallet in the browser, bundled by Vite.
- `demo.ts`, `scripts/anmeldung-demo.mjs`: the demonstration on the LAN.

## Running the demonstration

```sh
pnpm anmeldung:demo          # https://<LAN address>:8790, PORT and DEMO_HOST (IP or DNS name) override
PUBLIC_ORIGIN=https://<tunnel> pnpm anmeldung:demo   # behind a public https tunnel: plain http on PORT
```

Behind a tunnel or proxy that ends TLS, `PUBLIC_ORIGIN` is the address QR code, link and response_uri
name; the demo then needs no certificate of its own (review #139: before, the QR code sent the app to
the LAN address even when the page was opened through a tunnel).

Laptop and phone in the same network. The certificate is self-signed for the
LAN address (made with `openssl`, kept in the bench cache); both browsers
warn once. https is needed because phone browsers give WebCrypto (and so
Ed25519) only to secure origins.

- *Laptop plus phone*: open the address on the laptop, "Mit dem Telefon
  anmelden", scan the code with the phone's camera app, confirm. The code
  disappears on the laptop and it shows the login.
- *Same device*: open the address on the phone, "Auf diesem Gerät
  anmelden", confirm; the phone's browser returns to the web app, logged in.

**Demo crutch.** Until step 3 the wallet is a web page served by the web
app's own server (`/wallet`), holding a test identity in that browser's
storage. The QR code carries an https link to it instead of the `openid://`
request, because no app claims that scheme yet. In the real app the wallet
is the Web of Trust app on its own; nothing of the web app's origin touches
its keys.

Visual check (headless Chrome 145, desktop and phone viewports, 25
November): both ways run through, the laptop page shows the login after the
phone confirmed, the phone returns logged in. Tried by Anton on a real
laptop and phone the same day: the phone's camera reads the QR code and the
login goes through.

## Tests

`tests/anmeldung.test.ts` (20), `tests/anmeldung-http.test.ts` (9),
`tests/anmeldung-wallet-store.test.ts` (4).

Finding #135: with blocked browser storage the demo wallet fell back to a
random key and so switched accounts unnoticed. `wallet-store.ts` now stores
and reads back the test identity and reports a failure; the wallet shows it
before anything is signed and offers to try again (checked in headless
Chrome with a throwing `localStorage`: message shown, nothing posted).

Review of #128 found three gaps, all fixed with a test that fails on the
first version: concurrent answers could both pass, because the signature
check lay between the lookup and the use of the request; the wallet's post
followed redirects, so the signed token could leave the checked origin; the
server took any session id from the cookie and bound the login to it. A
second round found that a pre-login id the server had issued still worked
after the login. Now `/start` mints a fresh pre-login id and binds the
request to it, and collecting the completed login (`/status` or `/fertig`)
mints a new, authenticated id and drops the pre-login one.

## Results

| Promise | Result |
|---|---|
| Login works: QR, confirm, logged in | holds |
| Same device: confirm, return, logged in in exactly this browser | holds |
| Same device: whoever opens a stranger's link logs in neither themself nor the stranger | holds |
| Same device: the response_code works once, briefly, only for its browser | holds |
| The app opens a return address only on the web app's origin | holds |
| A token for web app A is refused at web app B | holds |
| A second answer to the same request is refused | holds |
| Two concurrent answers to one request: exactly one is taken | holds (claimed before the first await) |
| A refused answer does not use up the request | holds |
| The app's post follows no redirect, so the token reaches no other origin | holds (`redirect: 'manual'`) |
| The server binds a login only to a session id it issued itself | holds (planted ids get a fresh one) |
| The login ends in a new session; the earlier id alone gets nothing afterwards | holds |
| Wrong nonce, expired request, expired token, changed content: refused | holds |
| The app refuses an answer address on another origin | holds |
| Two devices of the same person (same root, multi-device stage 1) reach the same account | holds |
| Two web apps see two identifiers; two people get two accounts | holds |
| Laptop plus phone: whoever started the request is the one logged in | **does not hold** (limit below) |

## Limits

- **The cross-device QR way cannot tell who started the request.** Someone
  who starts a real login at beispiel.org and shows the person its QR code
  is logged in as that person once the person confirms. The app shows the
  right address, so the person sees nothing wrong. Measured in the test
  "Grenze". The same-device way does not have this limit. Decided (Anton,
  25 November): no number to compare and no animated QR code, because a
  forged page can copy both live; real protection needs the same device or
  proof of proximity (Bluetooth, as passkeys do, only through the operating
  system). For laptop plus phone the limit stays and is named.
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
- **The QR code is dense**, because it carries the whole request (request
  by value). Request by reference (`request_uri`) would make it small.

## The real app as wallet (25 November)

`ANMELDUNG_WALLET=app pnpm anmeldung:demo` makes QR code and link point at the Web of Trust app
(`https://web-of-trust.de/a#…`, its experimental login, web-of-trust#553) instead of the demo wallet.
Two conditions for that, both found while switching:

- **A certificate the phone trusts.** The app posts its answer to the response_uri; it cannot be told
  to accept a self-signed certificate as a browser can. The example web app needs a public address
  with a valid certificate (a tunnel or a server); the LAN address with the self-signed certificate
  only works with the demo wallet.
- **CORS at the response_uri.** The app answers from its web view (origin `https://localhost` on
  Android, `capacitor://localhost` on iOS) with `fetch`, which Capacitor does not route natively
  here. The response_uri therefore sends `Access-Control-Allow-Origin: *`; a web app without it
  receives the login but the app cannot read the answer and reports it as unreachable. SIOPv2
  assumes a native wallet without CORS; this is a difference for every web app the app logs into.

## As a service

The example web app also runs as a service on the team's server, so others can try the login
without a laptop on the same network: `scripts/build-anmeldung-server.mjs` bundles `server.ts`
(plain http behind Traefik, `PUBLIC_ORIGIN`, `ANMELDUNG_WALLET`, default `app`) and the wallet page
into `dist-anmeldung/`; `Dockerfile.anmeldung` puts the two files into a Node image;
`.github/workflows/anmeldung-image.yml` builds it on every pull request and pushes
`ghcr.io/real-life-org/anmeldung-demo:latest` from `main`; `deploy/anmeldung/docker-compose.yml`
runs it with the Traefik labels (domain from `ANMELDUNG_DOMAIN`). The page offers the demo wallet
per login, for phones whose app does not have the login yet. Sessions live in memory: a restart logs
everyone out.

## Next steps

3. The confirmation screen in the v3 app, claiming the `openid://` scheme
   (or a universal link) instead of the demo wallet page.
4. Authentik locally in Docker with a small bridge that speaks OpenID
   Connect toward Authentik and SIOPv2 toward the app.
