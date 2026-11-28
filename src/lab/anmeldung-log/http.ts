// The service behind HTTP. Node only; endpoints, no page.
//
//   GET  /.well-known/did.jsonl          the service's did:webvh log (did:webvh 1.0, The DID to HTTPS Transformation)
//   GET  /anmeldung-log/start            cross-device: a login attempt (vorgang) bound to this browser, the outer link
//   GET  /anmeldung-log/start?geraet=gleich   same-device: the outer link, the attempt bound by a cookie
//   GET  /anmeldung-log/anfrage/<id>     the request_uri: the signed Request Object
//   POST /anmeldung-log/antwort          the redirect_uri (direct_post, form-encoded)
//   GET  /anmeldung-log/status?vorgang=  the signed-in account; with vorgang, collect a confirmed attempt once
//   GET  /anmeldung-log/fertig?response_code=   the same-device return into the browser
//
// The browser bindings are those of src/lab/anmeldung/http.ts, rebuilt: a QR
// attempt is collected only with its id and its own cookie (v_<id>); the
// same-device attempt is bound by the cookie `anmeldung`; collecting mints the
// signed-in cookie `sitzung` exactly once.
//
// The service calls itself by its public HTTPS origin (the one in its DID);
// tests listen on 127.0.0.1 and the wallet reaches it with `loopbackForTests`.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { b64uOf, rand } from 'rltp-lib'
import { REQUEST_MEDIA_TYPE } from './profile'
import { REQUEST_PATH, RESPONSE_PATH, RETURN_PATH, Service, ServiceKeys, type Login, type ServiceOptions } from './service'

export const SESSION_LIFETIME_MS = 60 * 60_000
const BINDING_MAX_AGE_S = 600
const SIGNED_IN = 'sitzung', SAME_DEVICE = 'anmeldung', BINDING = 'v_'
const MAX_BODY = 256 * 1024

const cookieOf = (req: IncomingMessage, name: string): string | null => new RegExp(`(?:^|;\\s*)${name}=([A-Za-z0-9_-]+)`).exec(req.headers.cookie ?? '')?.[1] ?? null
const freshId = (): string => b64uOf(rand(16))
const json = (res: ServerResponse, code: number, o: unknown): void => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)) }
async function bodyOf (req: IncomingMessage): Promise<string> {
  let raw = ''
  for await (const chunk of req) { raw += chunk; if (raw.length > MAX_BODY) throw new Error('too large') }
  return raw
}

export interface ServeOptions extends Partial<Omit<ServiceOptions, 'host'>> {
  /** The DNS name in the DID; the port is added. Default `dienst.localhost`. */
  hostName?: string
  port?: number
}

/** Start the service on 127.0.0.1. Its DID is `did:webvh:<SCID>:<hostName>%3A<port>`. */
export async function serve (opts: ServeOptions = {}): Promise<{ server: Server, service: Service, origin: string, local: string }> {
  const now = opts.now ?? Date.now
  let service!: Service
  const authenticated = new Map<string, { login: Login, at: number }>()
  const bindings = new Map<string, { value: string, at: number }>()
  const bound = (req: IncomingMessage, vorgang: string): boolean => {
    const b = bindings.get(vorgang)
    return Boolean(b) && now() - b!.at <= BINDING_MAX_AGE_S * 1000 && cookieOf(req, BINDING + vorgang) === b!.value
  }
  const cookie = (name: string, value: string, maxAgeS?: number): string =>
    `${name}=${value}; HttpOnly; SameSite=Lax; Secure; Path=/${maxAgeS !== undefined ? `; Max-Age=${maxAgeS}` : ''}`
  const signIn = (res: ServerResponse, login: Login, clear: string): void => {
    const fresh = freshId(); authenticated.set(fresh, { login, at: now() })
    res.setHeader('Set-Cookie', [cookie(SIGNED_IN, fresh), cookie(clear, '', 0)])
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1'), path = url.pathname
    if (req.method === 'GET' && path === '/.well-known/did.jsonl') {
      res.writeHead(200, { 'Content-Type': 'text/jsonl', 'Access-Control-Allow-Origin': '*' }); res.end(service.didLog()); return
    }
    if (req.method === 'GET' && path === '/anmeldung-log/start') {
      const same = url.searchParams.get('geraet') === 'gleich'
      const vorgang = freshId()
      const s = await service.start(vorgang, same ? 'same-device' : 'cross-device')
      if (same) { res.setHeader('Set-Cookie', cookie(SAME_DEVICE, vorgang, BINDING_MAX_AGE_S)); json(res, 200, { link: s.link }); return }
      const value = freshId()
      bindings.set(vorgang, { value, at: now() })
      res.setHeader('Set-Cookie', cookie(BINDING + vorgang, value, BINDING_MAX_AGE_S))
      json(res, 200, { vorgang, link: s.link })
      return
    }
    if (req.method === 'GET' && path.startsWith(REQUEST_PATH)) {
      const jwt = service.requestObject(path.slice(REQUEST_PATH.length))
      if (!jwt) { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); res.end(); return }
      res.writeHead(200, { 'Content-Type': REQUEST_MEDIA_TYPE, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }); res.end(jwt); return
    }
    if (req.method === 'POST' && path === RESPONSE_PATH) {
      res.setHeader('Access-Control-Allow-Origin', '*')
      if (!(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) { json(res, 400, { error: 'invalid_request', error_description: 'not form-encoded' }); return }
      const r = await service.receive(new URLSearchParams(await bodyOf(req)))
      json(res, r.status, r.body)
      return
    }
    if (req.method === 'GET' && path === '/anmeldung-log/status') {
      const id = cookieOf(req, SIGNED_IN)
      const s = id ? authenticated.get(id) : undefined
      if (s && now() - s.at <= SESSION_LIFETIME_MS) { json(res, 200, s.login); return }
      const vorgang = url.searchParams.get('vorgang')
      const done = vorgang && bound(req, vorgang) ? service.take(vorgang) : null
      if (done && vorgang) {
        bindings.delete(vorgang)
        if ('cancelled' in done) { res.setHeader('Set-Cookie', cookie(BINDING + vorgang, '', 0)); json(res, 200, { error: 'user_cancelled' }); return }
        signIn(res, done, BINDING + vorgang); json(res, 200, done); return
      }
      json(res, 200, {})
      return
    }
    if (req.method === 'GET' && path === RETURN_PATH) {
      const id = cookieOf(req, SAME_DEVICE)
      const login = service.redeem(id ?? '', url.searchParams.get('response_code') ?? '')
      if (login && id) { signIn(res, login, SAME_DEVICE); res.writeHead(303, { Location: '/' }); res.end(); return }
      json(res, 400, { error: 'login not possible' })
      return
    }
    res.writeHead(404); res.end()
  }
  const server = createServer((req, res) => { handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end() }) })
  await new Promise<void>((ok) => server.listen(opts.port ?? 0, '127.0.0.1', ok))
  const port = (server.address() as { port: number }).port
  const host = `${opts.hostName ?? 'dienst.localhost'}%3A${port}`
  service = await Service.create({ ...opts, host, keys: opts.keys ?? ServiceKeys.random(), now })
  return { server, service, origin: service.origin, local: `http://127.0.0.1:${port}` }
}
