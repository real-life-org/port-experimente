// The example web app behind HTTP. Node only; the browser session is a cookie.
//
// Routes:
//   GET  /                 the page: log in with the phone (QR) or on this device (link)
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
/** the Web of Trust app's link for a login request */
export const APP_LINK = 'https://web-of-trust.de/a'

const STYLE = `body{font:17px/1.5 system-ui,sans-serif;max-width:34rem;margin:2.5rem auto;padding:0 1rem;color:#1b2420;background:#f6f8f7}
h1{font-size:1.6rem;margin:0 0 1rem}button,.button{font:inherit;padding:.7rem 1rem;border-radius:6px;border:1px solid #2c6a55;background:#2c6a55;color:#fff;cursor:pointer;text-decoration:none;display:inline-block}
.secondary{background:#fff;color:#2c6a55}.row{display:flex;flex-wrap:wrap;gap:.6rem;margin:1rem 0}#qr svg{width:min(22rem,100%);height:auto;background:#fff}
.muted{color:#5a6862;font-size:.92rem}.ok{background:#dcece5;padding:.8rem 1rem;border-radius:6px;overflow-wrap:anywhere}
[hidden]{display:none!important}label{display:block;margin:1rem 0 .3rem}input{font:inherit;width:100%;box-sizing:border-box;padding:.6rem;border:1px solid #9fb3aa;border-radius:6px}`

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Beispiel-Web-App</title><link rel="icon" href="data:,">
<style>${STYLE}</style>
<h1>Beispiel-Web-App</h1>
<p id="state">Nicht angemeldet.</p>
<div class="row" id="choices">
  <button id="phone">Mit dem Telefon anmelden</button>
  <button id="here" class="secondary">Auf diesem Gerät anmelden</button>
</div>
<label class="muted" id="demobox"><input type="checkbox" id="demo" style="width:auto;margin-right:.4rem">Demo-Wallet im Browser benutzen (statt der Web-of-Trust-App)</label>
<div id="qrbox" hidden><p>Scanne den Code mit der Kamera deines Telefons.</p><div id="qr"></div>
<p class="muted">Der Code gilt fünf Minuten. Er verschwindet, sobald du in der App bestätigt hast.</p></div>
<script>
const $=id=>document.getElementById(id)
const show=s=>{$('state').innerHTML='';const d=document.createElement('div');d.className='ok';d.textContent='Angemeldet als '+(s.name?s.name+' · ':'')+s.user;$('state').append(d);$('choices').hidden=true;$('qrbox').hidden=true;$('demobox').hidden=true}
const w=()=>$('demo').checked?'&wallet=demo':''
fetch('/status').then(r=>r.json()).then(s=>{if(s.user)show(s)})
let timer
$('phone').onclick=async()=>{
  const r=await (await fetch('/start?geraet=anderes'+w())).json()
  $('qr').innerHTML=r.qrSvg; $('qrbox').hidden=false
  clearInterval(timer); timer=setInterval(async()=>{const s=await (await fetch('/status')).json(); if(s.user){clearInterval(timer);show(s)}},1000)
}
$('here').onclick=async()=>{ const r=await (await fetch('/start?geraet=gleich'+w())).json(); location.href=r.walletLink }
</script>`

const WALLET_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Web of Trust · Anmeldung</title><link rel="icon" href="data:,">
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
  for await (const chunk of req) { raw += chunk; if (raw.length > 64_000) throw new Error('zu groß') }
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
}

/** Start the example web app. Port 0 picks a free one. */
export async function serve (opts: ServeOptions = {}): Promise<{ server: Server, origin: string, app: WebApp }> {
  const now = opts.now ?? Date.now
  let app!: WebApp, origin!: string
  const preLogin = new Set<string>()
  const authenticated = new Map<string, Login>()
  // behind a TLS-terminating proxy (Traefik) the server speaks http, but the browser sees https
  const secure = Boolean(opts.https) || (opts.publicOrigin ?? '').startsWith('https:')
  const signIn = (res: ServerResponse, login: Login): void => {
    const fresh = freshId(); authenticated.set(fresh, login)
    res.setHeader('Set-Cookie', `sitzung=${fresh}; HttpOnly; SameSite=Lax; Path=/${secure ? '; Secure' : ''}`)
  }
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', origin), path = url.pathname
    if (req.method === 'GET' && path === '/') { html(res, 200, PAGE); return }
    if (req.method === 'GET' && path === '/start') {
      const old = cookieId(req); if (old) preLogin.delete(old)
      const id = freshId(); preLogin.add(id)
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
      if (signedIn) { json(res, 200, signedIn); return }
      if (id && preLogin.has(id)) {
        const done = app.take(id)
        if (done) { preLogin.delete(id); signIn(res, done); json(res, 200, done); return }
      }
      json(res, 200, {})
      return
    }
    if (req.method === 'GET' && path === RETURN_PATH) {
      const id = cookieId(req), code = url.searchParams.get('response_code') ?? ''
      const r = app.redeem(id && preLogin.has(id) ? id : '', code, now())   // a code is used up by any attempt
      if (r.ok && id) { preLogin.delete(id); signIn(res, { user: r.user, ...(r.name ? { name: r.name } : {}) }); res.writeHead(303, { Location: '/' }); res.end(); return }
      html(res, 400, `<!doctype html><meta charset="utf-8"><style>${STYLE}</style><h1>Anmeldung nicht möglich</h1><p>${escapeHtml(r.ok ? 'keine Sitzung' : r.reason)}</p><p><a href="/">Zur Startseite</a></p>`)
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
    if (req.method === 'GET' && path === WALLET_PATH) { html(res, 200, WALLET_PAGE); return }
    if (req.method === 'GET' && path === WALLET_PATH + '.js' && opts.walletScript) {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); res.end(await opts.walletScript()); return
    }
    res.writeHead(404); res.end()
  }
  const listener = (req: IncomingMessage, res: ServerResponse): void => { handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end() }) }
  const server: Server = opts.https ? createHttps(opts.https, listener) as unknown as Server : createHttp(listener)
  await new Promise<void>((ok) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', ok))
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
