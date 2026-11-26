// The example web app behind HTTP. Node only; the browser session is a cookie.
//
// Routes:
//   GET  /                 the page: on a computer the QR code, on a phone one button to the app
//   POST /abmelden         end the signed-in session
//   GET  /start            a cross-device request: QR code and wallet link
//   GET  /start?geraet=gleich   a same-device request: wallet link only
//   GET  /status           what the page polls (cross-device)
//   POST /anmeldung/antwort     the response_uri (direct_post, form-encoded)
//   GET  /fertig?response_code= the same-device return into the browser
//   GET  /wallet, /wallet.js    the demo wallet page (demo crutch, see NOTES.md)
//
// Local tests use http on 127.0.0.1; the demo (demo.ts) runs https on the LAN.

import { createServer as createHttp, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttps } from 'node:https'
import QRCode from 'qrcode'
import { rand, b64uOf } from 'rltp-lib'
import { WebApp, type Login } from './webapp'

export const RESPONSE_PATH = '/anmeldung/antwort'
export const RETURN_PATH = '/fertig'
export const WALLET_PATH = '/wallet'
/** a signed-in session lives one hour; a login before it lives as webapp.ts decides */
export const SESSION_LIFETIME_MS = 60 * 60_000
export const SWEEP_EVERY_MS = 60_000
export const MAX_OPEN_REQUESTS = 10_000
/** the Web of Trust app's link for a login request */
export const APP_LINK = 'https://web-of-trust.de/a'

// The look of web-of-trust.de and the app: the Web of Trust tokens (apps/wot-v3/src/styles/tokens.css),
// light and dark, system fonts (no external font requests).
const STYLE = `:root{color-scheme:light dark;--bg:oklch(98% 0.003 265);--fg:oklch(22% 0.004 265);--card:oklch(100% 0 0);
--primary:oklch(55% 0.21 264);--primary-fg:oklch(100% 0 0);--muted:oklch(95% 0.005 265);--muted-fg:oklch(44% 0.008 265);
--accent:oklch(95% 0.03 264);--border:oklch(90% 0.008 265);--success:oklch(55% 0.17 142);--destructive:oklch(54% 0.19 27);
--radius:0.5rem;--shadow:0 10px 15px -3px oklch(0% 0 0 / .10),0 4px 6px -4px oklch(0% 0 0 / .10)}
@media (prefers-color-scheme:dark){:root{--bg:oklch(15% 0.02 265);--fg:oklch(95% 0.01 247);--card:oklch(20% 0.02 265);
--primary:oklch(65% 0.19 264);--primary-fg:oklch(15% 0.02 265);--muted:oklch(25% 0.02 265);--muted-fg:oklch(70% 0.01 247);
--accent:oklch(30% 0.08 264);--border:oklch(30% 0.02 265);--success:oklch(65% 0.17 142);--destructive:oklch(60% 0.19 27);
--shadow:0 10px 15px -3px oklch(0% 0 0 / .15),0 4px 6px -4px oklch(0% 0 0 / .15)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;font:16px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--fg);background:var(--bg)}
header{display:flex;align-items:center;gap:.6rem;padding:1rem 1.25rem;max-width:40rem;margin:0 auto}
header svg{width:2rem;height:2rem}header b{font-weight:600}header span{margin-left:auto;font-size:.8rem;color:var(--muted-fg);background:var(--muted);padding:.15rem .55rem;border-radius:999px}
main{max-width:40rem;margin:0 auto;padding:0 1.25rem 2.5rem}
.card{background:var(--card);border:1px solid var(--border);border-radius:calc(var(--radius) + 4px);box-shadow:var(--shadow);padding:1.75rem 1.5rem;text-align:center}
h1{font-size:1.45rem;line-height:1.25;margin:0 0 .4rem;font-weight:650}
p{margin:.4rem 0}.muted{color:var(--muted-fg);font-size:.92rem}
.button{font:inherit;font-weight:600;display:block;width:100%;padding:.85rem 1rem;border:0;border-radius:var(--radius);background:var(--primary);color:var(--primary-fg);cursor:pointer;text-decoration:none;margin:1.25rem 0 .5rem}
.quiet{font:inherit;background:none;border:0;color:var(--primary);cursor:pointer;text-decoration:underline;text-underline-offset:3px;padding:.25rem;margin-top:.75rem}
#qr{display:inline-block;margin:1.25rem auto .5rem;padding:.6rem;background:#fff;border-radius:var(--radius);border:1px solid var(--border)}
#qr svg{display:block;width:min(15rem,70vw);height:auto}
.avatar{width:5.5rem;height:5.5rem;border-radius:50%;object-fit:cover;display:block;margin:.25rem auto 1rem;border:1px solid var(--border)}
.initial{display:flex;align-items:center;justify-content:center;font-size:2.2rem;font-weight:600;color:#fff}
.did{font-family:"Source Code Pro",ui-monospace,monospace;font-size:.85rem;color:var(--muted-fg);overflow-wrap:anywhere}
.ok{color:var(--success);font-weight:600;margin-bottom:.75rem}.err{color:var(--destructive)}
footer{max-width:40rem;margin:0 auto;padding:0 1.25rem 2rem;text-align:center}
[hidden]{display:none!important}label{display:block;margin:1rem 0 .3rem}
input{font:inherit;width:100%;padding:.6rem;border:1px solid var(--border);border-radius:var(--radius);background:var(--card);color:var(--fg)}`

// the Web of Trust mark (apps/landing/public/favicon.svg)
const LOGO = `<svg viewBox="0 0 100 100" aria-hidden="true"><rect x="5" y="5" width="90" height="90" rx="18" fill="#2563eb"/><g transform="translate(17,15.5) scale(3)" fill="#fff" stroke="#fff" stroke-width="2" stroke-linecap="round"><circle cx="18.72" cy="8.82" r="2.5"/><circle cx="5.28" cy="5.28" r="2.5"/><circle cx="8.82" cy="18.72" r="2.5"/><line x1="6.04" x2="8.06" y1="8.18" y2="15.82"/><line x1="15.81" x2="8.18" y1="8.05" y2="6.04"/><line x1="16.59" x2="10.94" y1="10.94" y2="16.59"/></g></svg>`
const ICON = `data:image/svg+xml,${encodeURIComponent(LOGO.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '))}`

// One way per device: on a computer the QR code shows at once (scan it with the app), on a phone one
// button opens the app on this device. The other way stays one quiet link away. The demo wallet in the
// browser only with ?demo (for development).
const PAGE = `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Beispiel-Web-App · Anmelden</title><link rel="icon" href="${ICON}">
<style>${STYLE}</style>
<header>${LOGO}<b>Beispiel-Web-App</b><span>Vorführung</span></header>
<main><div class="card">
<section id="laden"><p class="muted">Lädt …</p></section>
<section id="qrbox" hidden>
  <h1>Mit Web of Trust anmelden</h1>
  <p class="muted">Scanne den Code mit der Web-of-Trust-App und bestätige dort.</p>
  <div id="qr"></div>
  <p class="muted">Der Code erneuert sich von selbst.</p>
  <button class="quiet" id="zuHier">Auf diesem Gerät anmelden</button>
</section>
<section id="hierbox" hidden>
  <h1>Mit Web of Trust anmelden</h1>
  <p class="muted">Die Web-of-Trust-App öffnet sich. Bestätige dort, dann kommst du hierher zurück.</p>
  <button class="button" id="hier">Mit Web of Trust anmelden</button>
  <button class="quiet" id="zuQr">Mit einem anderen Gerät anmelden</button>
</section>
<section id="drin" hidden>
  <p class="ok">Angemeldet</p>
  <div id="bild"></div>
  <h1 id="name"></h1>
  <p class="did" id="did"></p>
  <button class="quiet" id="ab">Abmelden</button>
</section>
<section id="fehlerbox" hidden>
  <p class="err" id="fehler"></p>
  <button class="button" id="nochmal">Noch einmal versuchen</button>
</section>
</div></main>
<footer><p class="muted">Deine Identität bleibt in deiner App. Diese Seite sieht nur, was du dort freigibst.</p></footer>
<script>
const $=id=>document.getElementById(id)
const demo=new URLSearchParams(location.search).has('demo')?'&wallet=demo':''
const mobil=matchMedia('(pointer: coarse)').matches&&matchMedia('(max-width: 48rem)').matches
let poll=0,erneuern=0
const nur=id=>{for(const s of ['laden','qrbox','hierbox','drin','fehlerbox'])$(s).hidden=s!==id}
const stopp=()=>{clearInterval(poll);clearTimeout(erneuern)}
const fehler=t=>{nur('fehlerbox');$('fehler').textContent=t}
const weiter=()=>mobil?nur('hierbox'):qr()
const start=async g=>{const r=await fetch('/start?geraet='+g+demo);if(r.status===409)return{confirmed:true};if(!r.ok)throw new Error('busy');return r.json()}
async function qr(){
  stopp()
  let r
  try{r=await start('anderes')}catch{fehler('Gerade nicht möglich.');return}
  // just confirmed in the app: keep the code, collect the login
  if(r.confirmed){status();poll=setInterval(status,1500);erneuern=setTimeout(qr,5000);return}
  $('qr').innerHTML=r.qrSvg;nur('qrbox')
  poll=setInterval(status,1500)
  erneuern=setTimeout(qr,270000)   // the request lives five minutes
}
async function hier(){
  stopp()
  try{const r=await start('gleich');if(r.confirmed){status();return}location.href=r.walletLink}catch{fehler('Gerade nicht möglich.')}
}
async function status(){const s=await (await fetch('/status')).json();if(s.user){stopp();zeige(s)}}
function farbe(t){let h=0;for(const c of t)h=(h*31+c.charCodeAt(0))>>>0;return 'oklch(58% 0.15 '+(h%360)+')'}
function zeige(s){
  const b=$('bild');b.replaceChildren()
  if(typeof s.picture==='string'&&s.picture.startsWith('data:image/')){const i=document.createElement('img');i.className='avatar';i.alt='';i.src=s.picture;b.append(i)}
  else{const d=document.createElement('div');d.className='avatar initial';d.style.background=farbe(s.user);d.textContent=(s.name||'?').trim().charAt(0).toUpperCase()||'?';b.append(d)}
  $('name').textContent=s.name||'Ohne Namen'
  $('did').textContent=s.user.length>34?s.user.slice(0,20)+'…'+s.user.slice(-8):s.user
  $('did').title=s.user
  nur('drin')
}
$('zuHier').onclick=()=>{stopp();nur('hierbox')}
$('zuQr').onclick=qr
$('nochmal').onclick=weiter
$('hier').onclick=hier
$('ab').onclick=async()=>{await fetch('/abmelden',{method:'POST'});weiter()}
fetch('/status').then(r=>r.json()).then(s=>{if(s.user)zeige(s);else weiter()}).catch(()=>fehler('Gerade nicht möglich.'))
</script>`

const WALLET_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Web of Trust · Anmeldung</title><link rel="icon" href="${ICON}">
<style>${STYLE}</style>
<h1>Web of Trust</h1>
<div id="app"><p>Lädt …</p></div>
<p class="muted">Vorführung: Diese Seite steht für die Web-of-Trust-App. Sie hält eine Test-Identität nur in diesem Browser.</p>
<script type="module" src="${WALLET_PATH}.js"></script>`

// Sessions. Two kinds of id, both issued by this server (visitors without a
// login get no id at all):
// - pre-login: minted fresh by /start and the only id the login request is
//   bound to. Whoever knew the browser's earlier id (an earlier pre-login id,
//   or one planted from outside) does not know this one.
// - authenticated: minted when the completed login is collected (/status for
//   cross-device, /fertig for same-device). The pre-login id is dropped at
//   that moment and can neither read the account nor collect the login again.
// An id the server did not issue, or no longer accepts, is treated as absent.
const cookieId = (req: IncomingMessage): string | null => /(?:^|;\s*)sitzung=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1] ?? null
const freshId = (): string => b64uOf(rand(16))

async function bodyOf (req: IncomingMessage): Promise<string> {
  let raw = ''
  // room for a profile picture in the token
  for await (const chunk of req) { raw += chunk; if (raw.length > 256_000) throw new Error('zu groß') }
  return raw
}

const json = (res: ServerResponse, code: number, o: unknown): void => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)) }
const html = (res: ServerResponse, code: number, body: string): void => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body) }
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export interface ServeOptions {
  port?: number
  host?: string                                   // default 127.0.0.1
  https?: { key: string, cert: string }
  publicOrigin?: string                           // what the web app calls itself; default from the bound address
  walletScript?: () => Promise<string>            // the bundled demo wallet (demo.ts)
  /** where QR code and link send the person: the demo wallet page (default), or the Web of Trust app
   *  through its app link https://web-of-trust.de/a#… (the app's experimental login, web-of-trust#553) */
  wallet?: 'demo' | 'app'
  now?: () => number
  /** the cap on open login requests (default MAX_OPEN_REQUESTS) */
  maxOpenRequests?: number
}

/** Start the example web app. Port 0 picks a free one. */
export async function serve (opts: ServeOptions = {}): Promise<{ server: Server, origin: string, app: WebApp }> {
  const now = opts.now ?? Date.now
  let app!: WebApp, origin!: string
  // signed-in sessions with their start; a login before it is the web app's (one lifecycle, webapp.ts)
  const authenticated = new Map<string, { login: Login, at: number }>()
  const sweep = (): void => {
    const t = now()
    app?.sweep(t)
    for (const [id, s] of authenticated) if (t - s.at > SESSION_LIFETIME_MS) authenticated.delete(id)
  }
  // behind a TLS-terminating proxy (Traefik) the server speaks http, but the browser sees https
  const secure = Boolean(opts.https) || (opts.publicOrigin ?? '').startsWith('https:')
  const signIn = (res: ServerResponse, login: Login): void => {
    const fresh = freshId(); authenticated.set(fresh, { login, at: now() })
    res.setHeader('Set-Cookie', `sitzung=${fresh}; HttpOnly; SameSite=Lax; Path=/${secure ? '; Secure' : ''}`)
  }
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', origin), path = url.pathname
    sweep()
    if (req.method === 'GET' && path === '/') { html(res, 200, PAGE); return }
    if (req.method === 'GET' && path === '/start') {
      // a cap on open requests: nobody fills the memory by starting logins
      const cap = opts.maxOpenRequests ?? MAX_OPEN_REQUESTS
      if (app.held().pending >= cap) { json(res, 503, { error: 'busy' }); return }
      const old = cookieId(req)
      // a confirmed (or just checked) login of this browser wins over a renewed QR code: the page
      // collects it through /status first
      if (old && !authenticated.has(old) && app.inFlight(old, now())) { json(res, 409, { error: 'confirmed' }); return }
      if (old && !authenticated.has(old)) app.forget(old)
      const id = freshId()
      res.setHeader('Set-Cookie', `sitzung=${id}; HttpOnly; SameSite=Lax; Path=/${secure ? '; Secure' : ''}`)
      const same = url.searchParams.get('geraet') === 'gleich'
      const started = app.start(id, now(), same ? 'same-device' : 'cross-device')
      // the page may ask for the demo wallet (or the app) per login; otherwise the server's choice
      const asked = url.searchParams.get('wallet')
      const wallet = asked === 'demo' || asked === 'app' ? asked : (opts.wallet ?? 'demo')
      const walletLink = wallet === 'app' ? `${APP_LINK}#${encodeURIComponent(started.url)}` : `${origin}${WALLET_PATH}#${encodeURIComponent(started.url)}`
      json(res, 200, same ? { url: started.url, walletLink } : { url: started.url, walletLink, qrSvg: await QRCode.toString(walletLink, { type: 'svg', margin: 2, errorCorrectionLevel: 'L' }) })
      return
    }
    if (req.method === 'GET' && path === '/status') {
      const id = cookieId(req)
      const signedIn = id ? authenticated.get(id) : undefined
      if (signedIn) { json(res, 200, signedIn.login); return }
      const done = id ? app.take(id, now()) : null
      if (done) { signIn(res, done); json(res, 200, done); return }
      json(res, 200, {})
      return
    }
    if (req.method === 'GET' && path === RETURN_PATH) {
      const id = cookieId(req), code = url.searchParams.get('response_code') ?? ''
      const r = app.redeem(id ?? '', code, now())   // a code is used up by any attempt
      if (r.ok && id) { signIn(res, { user: r.user, ...(r.name ? { name: r.name } : {}), ...(r.picture ? { picture: r.picture } : {}) }); res.writeHead(303, { Location: '/' }); res.end(); return }
      html(res, 400, `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Anmeldung nicht möglich</title><link rel="icon" href="${ICON}"><style>${STYLE}</style><header>${LOGO}<b>Beispiel-Web-App</b></header><main><div class="card"><h1>Anmeldung nicht möglich</h1><p class="muted">${escapeHtml(r.ok ? 'keine Sitzung' : r.reason)}</p><a class="button" href="/">Noch einmal</a></div></main>`)
      return
    }
    if (req.method === 'POST' && path === RESPONSE_PATH) {
      // the Web of Trust app answers from its web view (origin https://localhost or capacitor://localhost),
      // so the response_uri lets any origin read its answer; the request is a simple form post (no preflight)
      res.setHeader('Access-Control-Allow-Origin', '*')
      const form = new URLSearchParams(await bodyOf(req))
      const r = await app.receive({ id_token: form.get('id_token') ?? undefined, state: form.get('state') ?? undefined }, now())
      if (!r.ok) { json(res, 400, { error: 'invalid_request', error_description: r.reason }); return }
      json(res, 200, 'redirect_uri' in r ? { redirect_uri: r.redirect_uri } : {})
      return
    }
    if (req.method === 'POST' && path === '/abmelden') {
      const id = cookieId(req); if (id) { authenticated.delete(id); app.forget(id) }
      res.setHeader('Set-Cookie', `sitzung=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`)
      json(res, 200, {}); return
    }
    if (req.method === 'GET' && path === WALLET_PATH) { html(res, 200, WALLET_PAGE); return }
    if (req.method === 'GET' && path === WALLET_PATH + '.js' && opts.walletScript) {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); res.end(await opts.walletScript()); return
    }
    res.writeHead(404); res.end()
  }
  const listener = (req: IncomingMessage, res: ServerResponse): void => { handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end() }) }
  const server: Server = opts.https ? createHttps(opts.https, listener) as unknown as Server : createHttp(listener)
  await new Promise<void>((ok) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', ok))
  // also swept while nobody asks; the timer does not keep the process alive and ends with the server
  const timer = setInterval(sweep, SWEEP_EVERY_MS)
  timer.unref?.()
  server.on('close', () => clearInterval(timer))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : opts.port
  origin = opts.publicOrigin ?? `${opts.https ? 'https' : 'http'}://127.0.0.1:${port}`
  app = new WebApp(origin, origin + RESPONSE_PATH, 'Beispiel-Web-App', origin + RETURN_PATH)
  return { server, origin, app }
}

/**
 * What the wallet does with its answer: post it to the response_uri, and only
 * there. A redirect is not followed (`redirect: 'manual'`): the wallet checked
 * the origin of the response_uri, and a redirect could carry the signed token
 * to another origin. A redirect answer counts as a failed post. For a
 * same-device request the web app answers with a redirect_uri to open.
 */
export async function post (answer: { response_uri: string, body: { id_token: string, state: string } }): Promise<number> {
  return (await postAndRead(answer)).status
}

export async function postAndRead (answer: { response_uri: string, body: { id_token: string, state: string } }): Promise<{ status: number, redirect_uri?: string }> {
  const r = await fetch(answer.response_uri, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(answer.body).toString() })
  if (r.status >= 300 && r.status < 400) return { status: 0 }
  const body = await r.json().catch(() => ({})) as { redirect_uri?: unknown }
  return { status: r.status, ...(typeof body.redirect_uri === 'string' ? { redirect_uri: body.redirect_uri } : {}) }
}
