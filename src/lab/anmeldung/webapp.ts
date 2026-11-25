// The web app's side: start a login for a browser session, take the wallet's
// answer at the response_uri, and let the right browser session in.
//
// Two ways, as in OpenID4VP:
// - cross-device: the browser shows a QR code, the phone answers, the waiting
//   browser session is logged in when it polls. Whoever started the request
//   is logged in (the measured limit in NOTES.md).
// - same-device: the browser opens the app by a link on the same device. The
//   answer does not log anyone in; it returns a redirect_uri with a one-time
//   response_code, which the wallet opens in the same browser. Only the
//   browser session that started the request can redeem the code.
//
// Transport-free: `start` returns the request, `receive` takes the posted
// body, `poll`/`take` serve the waiting page, `redeem` the same-device return.
// http.ts puts it behind HTTP.

import { rand, b64uOf } from 'rltp-lib'
import { requestUrl, verifyIdTokenSignature, type LoginRequest } from './siop'

const REQUEST_LIFETIME_MS = 5 * 60_000
const CODE_LIFETIME_MS = 60_000
const MAX_TOKEN_AGE_S = 600
const CLOCK_SKEW_S = 60

export type Mode = 'cross-device' | 'same-device'
export type Login = { user: string, name?: string }

// `checking` is set before the first await of `receive` and cleared only if
// the answer fails, so two concurrent answers cannot both pass: JavaScript
// runs the check-and-set before the await without interruption.
interface Pending { session: string, nonce: string, created: number, mode: Mode, done: boolean, checking: boolean }
interface Code { session: string, login: Login, created: number }

export type Receipt =
  | ({ ok: true } & Login)                              // cross-device: the waiting session is logged in
  | { ok: true, redirect_uri: string }                  // same-device: open this in the same browser
  | { ok: false, reason: string }

export type Redemption = ({ ok: true } & Login) | { ok: false, reason: string }

export class WebApp {
  private pending = new Map<string, Pending>()
  private loggedIn = new Map<string, Login>()           // browser session -> user (cross-device)
  private codes = new Map<string, Code>()               // response_code -> login (same-device)

  constructor (
    readonly clientId: string,
    readonly responseUri: string,
    readonly clientName?: string,
    readonly returnUri: string = new URL('/fertig', clientId).href,
  ) {}

  /** A browser session asks to log in: make a request for the QR code or the link. */
  start (session: string, nowMs: number, mode: Mode = 'cross-device'): { request: LoginRequest, url: string } {
    const state = b64uOf(rand(16)), nonce = b64uOf(rand(16))
    this.pending.set(state, { session, nonce, created: nowMs, mode, done: false, checking: false })
    const request: LoginRequest = {
      response_type: 'id_token', response_mode: 'direct_post', scope: 'openid', id_token_type: 'subject_signed',
      client_id: this.clientId, response_uri: this.responseUri, nonce, state,
      ...(this.clientName ? { client_name: this.clientName } : {}),
    }
    return { request, url: requestUrl(request) }
  }

  /** The wallet posts its answer here. */
  async receive (body: { id_token?: unknown, state?: unknown }, nowMs: number): Promise<Receipt> {
    const p = typeof body.state === 'string' ? this.pending.get(body.state) : undefined
    if (!p) return { ok: false, reason: 'unbekannte Anfrage' }
    if (p.done) return { ok: false, reason: 'Anfrage schon beantwortet' }
    if (nowMs - p.created > REQUEST_LIFETIME_MS) return { ok: false, reason: 'Anfrage abgelaufen' }
    if (p.checking) return { ok: false, reason: 'Anfrage wird gerade geprüft' }
    p.checking = true                                   // claimed before the first await
    const r = await this.check(body.id_token, p, nowMs)
    if (!r.ok) { p.checking = false; return r }
    p.done = true
    if (p.mode === 'same-device') {
      const code = b64uOf(rand(16))
      this.codes.set(code, { session: p.session, login: r.login, created: nowMs })
      const u = new URL(this.returnUri); u.searchParams.set('response_code', code)
      return { ok: true, redirect_uri: u.href }
    }
    this.loggedIn.set(p.session, r.login)
    return { ok: true, ...r.login }
  }

  private async check (token: unknown, p: Pending, nowMs: number): Promise<{ ok: true, login: Login } | { ok: false, reason: string }> {
    const checked = await verifyIdTokenSignature(String(token))
    if (!checked.ok) return checked
    const c = checked.claims, now = Math.floor(nowMs / 1000)
    if (c.aud !== this.clientId) return { ok: false, reason: 'für eine andere Web-App ausgestellt' }
    if (c.nonce !== p.nonce) return { ok: false, reason: 'falsche Zufallszahl' }
    if (typeof c.iat !== 'number' || typeof c.exp !== 'number') return { ok: false, reason: 'ohne Zeitangaben' }
    if (c.iat > now + CLOCK_SKEW_S) return { ok: false, reason: 'aus der Zukunft' }
    if (c.exp < now || c.exp - c.iat > MAX_TOKEN_AGE_S) return { ok: false, reason: 'abgelaufen' }
    return { ok: true, login: { user: c.sub, ...(typeof c.name === 'string' ? { name: c.name } : {}) } }
  }

  /** What the waiting page asks (cross-device): is this browser session logged in? */
  poll (session: string): Login | null {
    return this.loggedIn.get(session) ?? null
  }

  /**
   * Hand a completed cross-device login over exactly once and forget it under
   * this session id. The HTTP layer moves it to a fresh, authenticated session.
   */
  take (session: string): Login | null {
    const entry = this.loggedIn.get(session) ?? null
    this.loggedIn.delete(session)
    return entry
  }

  /**
   * The same-device return: the browser opens the redirect_uri with the
   * response_code. The code is used up by the first attempt, right or wrong,
   * and counts only for the browser session that started the request.
   */
  redeem (session: string, code: string, nowMs: number): Redemption {
    const c = this.codes.get(code)
    this.codes.delete(code)
    if (!c) return { ok: false, reason: 'unbekannter oder verbrauchter Code' }
    if (nowMs - c.created > CODE_LIFETIME_MS) return { ok: false, reason: 'Code abgelaufen' }
    if (c.session !== session) return { ok: false, reason: 'Code gehört zu einem anderen Browser' }
    return { ok: true, ...c.login }
  }
}
