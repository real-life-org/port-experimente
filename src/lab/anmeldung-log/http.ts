// The service behind HTTP. Node only; endpoints, no page.
//
//   GET  /.well-known/did.jsonl          the service's did:webvh log (did:webvh 1.0, The DID to HTTPS Transformation)
//   GET  /anmeldung-log/start            cross-device: a login attempt (vorgang) bound to this browser, the outer link
//   GET  /anmeldung-log/start?geraet=gleich   same-device: the outer link, the attempt bound by a cookie
//   GET  /anmeldung-log/anfrage/<id>     the request_uri: the signed Request Object
//   POST /anmeldung-log/antwort          the redirect_uri (direct_post, form-encoded)
//   GET  /anmeldung-log/status?vorgang=  the signed-in account; with vorgang, collect a confirmed attempt once,
//                                        or the notice of an attempt that stays open (cancelled, refused)
//   POST /anmeldung-log/abbrechen?vorgang=   the starting browser gives the attempt up for good
//   GET  /anmeldung-log/fertig?response_code=   the same-device return into the browser
//
// The browser bindings are those of src/lab/anmeldung/http.ts, rebuilt: a QR
// attempt is collected only with its id and its own cookie (v_<id>); the
// same-device attempt is bound by the cookie `anmeldung`; collecting gives
// the signed-in cookie `sitzung` exactly once (the session comes from the
// service, in one step with a fresh look at the identifier). What has run out
// is swept on every request and on a timer.
//
// The service calls itself by its public HTTPS origin (the one in its DID);
// tests listen on 127.0.0.1 and give the wallet a transport of their own
// (tests/anmeldung-log-loopback.ts).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { b64uOf, rand } from 'rltp-lib'
import { REQUEST_MEDIA_TYPE } from './profile'
import { REQUEST_PATH, RESPONSE_PATH, RETURN_PATH, Service, ServiceKeys, type Collected, type ServiceOptions } from './service'

const BINDING_MAX_AGE_S = 600
const SWEEP_EVERY_MS = 60_000
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
  // the QR way: attempt -> the browser binding (the value of its cookie v_<attempt>) and its start
  const bindings = new Map<string, { value: string, at: number }>()
  const bound = (req: IncomingMessage, vorgang: string): boolean => {
    const b = bindings.get(vorgang)
    return Boolean(b) && now() - b!.at <= BINDING_MAX_AGE_S * 1000 && cookieOf(req, BINDING + vorgang) === b!.value
  }
  const sweep = (): void => {
    service?.sweep()
    for (const [id, b] of bindings) if (now() - b.at > BINDING_MAX_AGE_S * 1000) bindings.delete(id)
  }
  const cookie = (name: string, value: string, maxAgeS?: number): string =>
    `${name}=${value}; HttpOnly; SameSite=Lax; Secure; Path=/${maxAgeS !== undefined ? `; Max-Age=${maxAgeS}` : ''}`
  const signIn = (res: ServerResponse, c: Collected & { session: string }, clear: string): void => {
    res.setHeader('Set-Cookie', [cookie(SIGNED_IN, c.session), cookie(clear, '', 0)])
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1'), path = url.pathname
    sweep()
    if (req.method === 'GET' && path === '/.well-known/did.jsonl') {
      res.writeHead(200, { 'Content-Type': 'text/jsonl', 'Access-Control-Allow-Origin': '*' }); res.end(service.didLog()); return
    }
    if (req.method === 'GET' && path === '/anmeldung-log/start') {
      const same = url.searchParams.get('geraet') === 'gleich'
      const s = await service.start(same ? 'same-device' : 'cross-device')
      const vorgang = s.attempt
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
      const login = id ? service.session(id) : null
      if (login) { json(res, 200, login); return }
      const vorgang = url.searchParams.get('vorgang')
      // collected only by the browser that started the attempt; any other leaves it untouched
      const done = vorgang && bound(req, vorgang) ? await service.collect(vorgang) : null
      if (done && vorgang) {
        // a notice: the attempt stays open, and so does its binding
        if ('notice' in done) { json(res, 200, { error: done.notice }); return }
        bindings.delete(vorgang)
        if ('error' in done) { res.setHeader('Set-Cookie', cookie(BINDING + vorgang, '', 0)); json(res, 200, { error: done.error }); return }
        signIn(res, done, BINDING + vorgang); json(res, 200, done.login); return
      }
      json(res, 200, {})
      return
    }
    if (req.method === 'POST' && path === '/anmeldung-log/abbrechen') {
      // only the browser that started the attempt: its binding (QR) or its same-device cookie
      const vorgang = url.searchParams.get('vorgang') ?? ''
      const qr = bound(req, vorgang), same = cookieOf(req, SAME_DEVICE) === vorgang
      if (!vorgang || (!qr && !same)) { json(res, 403, { error: 'not this browser\'s attempt' }); return }
      await service.forget(vorgang)
      if (qr) { bindings.delete(vorgang); res.setHeader('Set-Cookie', cookie(BINDING + vorgang, '', 0)) } else res.setHeader('Set-Cookie', cookie(SAME_DEVICE, '', 0))
      json(res, 200, {})
      return
    }
    if (req.method === 'GET' && path === RETURN_PATH) {
      const id = cookieOf(req, SAME_DEVICE)
      const done = await service.redeem(id ?? '', url.searchParams.get('response_code') ?? '')
      if (done && 'session' in done && id) { signIn(res, done, SAME_DEVICE); res.writeHead(303, { Location: '/' }); res.end(); return }
      json(res, 400, { error: 'login not possible' })
      return
    }
    res.writeHead(404); res.end()
  }
  const server = createServer((req, res) => { handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end() }) })
  await new Promise<void>((ok, no) => { server.once('error', no); server.listen(opts.port ?? 0, '127.0.0.1', () => { server.off('error', no); ok() }) })
  const port = (server.address() as { port: number }).port
  const host = `${opts.hostName ?? 'dienst.localhost'}%3A${port}`
  // The DID names the port, so the port is bound first; whatever fails from here on gives it back before the error is returned.
  try {
    service = await Service.create({ ...opts, host, keys: opts.keys ?? ServiceKeys.random(), now })
  } catch (e) {
    await new Promise<void>((ok) => { server.close(() => ok()); server.closeAllConnections() })
    throw e
  }
  // also swept while nobody asks; the timer does not keep the process alive and ends with the server
  const timer = setInterval(sweep, SWEEP_EVERY_MS)
  timer.unref?.()
  server.on('close', () => clearInterval(timer))
  return { server, service, origin: service.origin, local: `http://127.0.0.1:${port}` }
}
