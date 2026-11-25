// The example web app behind HTTP: one page, a start route, a status route the
// page polls, and the response_uri the wallet posts to (direct_post,
// application/x-www-form-urlencoded). Node only; the browser session is a
// cookie. Local use: http on 127.0.0.1; a real web app runs on https.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { rand, b64uOf } from 'rltp-lib'
import { WebApp } from './webapp'

export const RESPONSE_PATH = '/anmeldung/antwort'

const PAGE = `<!doctype html><meta charset="utf-8"><title>Beispiel-Web-App</title>
<style>body{font:16px system-ui;max-width:38rem;margin:3rem auto;padding:0 1rem}code{word-break:break-all;display:block;background:#eee;padding:.6rem}</style>
<h1>Beispiel-Web-App</h1>
<p id="state">Nicht angemeldet.</p>
<button id="go">Mit Web of Trust anmelden</button>
<p id="hint" hidden>Diese Anfrage mit der App scannen (QR folgt in Schritt 2):</p>
<code id="url" hidden></code>
<script>
const $=id=>document.getElementById(id)
$('go').onclick=async()=>{
  const r=await (await fetch('/start')).json()
  $('url').textContent=r.url; $('url').hidden=false; $('hint').hidden=false
  const t=setInterval(async()=>{const s=await (await fetch('/status')).json()
    if(s.user){clearInterval(t);$('state').textContent='Angemeldet als '+(s.name?s.name+' ('+s.user+')':s.user);$('url').hidden=true;$('hint').hidden=true}},1000)
}
</script>`

function sessionOf (req: IncomingMessage, res: ServerResponse): string {
  const m = /(?:^|;\s*)sitzung=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')
  if (m?.[1]) return m[1]
  const s = b64uOf(rand(16))
  res.setHeader('Set-Cookie', `sitzung=${s}; HttpOnly; SameSite=Lax; Path=/`)
  return s
}

async function bodyOf (req: IncomingMessage): Promise<string> {
  let raw = ''
  for await (const chunk of req) { raw += chunk; if (raw.length > 64_000) throw new Error('zu groß') }
  return raw
}

const json = (res: ServerResponse, code: number, o: unknown): void => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)) }

/** Start the example web app on 127.0.0.1. Port 0 picks a free one. */
export async function serve (port = 0, now: () => number = Date.now): Promise<{ server: Server, origin: string, app: WebApp }> {
  let app!: WebApp
  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0]
      if (req.method === 'GET' && path === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE); return }
      if (req.method === 'GET' && path === '/start') { json(res, 200, { url: app.start(sessionOf(req, res), now()).url }); return }
      if (req.method === 'GET' && path === '/status') { json(res, 200, app.poll(sessionOf(req, res)) ?? {}); return }
      if (req.method === 'POST' && path === RESPONSE_PATH) {
        const form = new URLSearchParams(await bodyOf(req))
        const r = await app.receive({ id_token: form.get('id_token') ?? undefined, state: form.get('state') ?? undefined }, now())
        json(res, r.ok ? 200 : 400, r.ok ? {} : { error: 'invalid_request', error_description: r.reason })
        return
      }
      res.writeHead(404); res.end()
    })().catch(() => { res.writeHead(500); res.end() })
  })
  await new Promise<void>((ok) => server.listen(port, '127.0.0.1', ok))
  const addr = server.address()
  const origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : port}`
  app = new WebApp(origin, origin + RESPONSE_PATH, 'Beispiel-Web-App')
  return { server, origin, app }
}

/** What the wallet does with its answer: post it to the response_uri. */
export async function post (answer: { response_uri: string, body: { id_token: string, state: string } }): Promise<number> {
  const r = await fetch(answer.response_uri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(answer.body).toString() })
  return r.status
}
