// The web app's side: start a login for a browser session, take the wallet's
// answer at the response_uri, and let the waiting browser session in.
//
// Transport-free: `start` returns the request, `receive` takes the posted
// body, `poll` is what the waiting page asks. demo.ts puts it behind HTTP.

import { rand, b64uOf } from 'rltp-lib'
import { requestUrl, verifyIdTokenSignature, type LoginRequest } from './siop'

const REQUEST_LIFETIME_MS = 5 * 60_000
const MAX_TOKEN_AGE_S = 600
const CLOCK_SKEW_S = 60

// `checking` is set before the first await of `receive` and cleared only if
// the answer fails, so two concurrent answers cannot both pass: JavaScript
// runs the check-and-set before the await without interruption.
interface Pending { session: string, nonce: string, created: number, done: boolean, checking: boolean }

export type Receipt =
  | { ok: true, user: string, name?: string }
  | { ok: false, reason: string }

export class WebApp {
  private pending = new Map<string, Pending>()
  private loggedIn = new Map<string, { user: string, name?: string }>()   // browser session -> user

  constructor (readonly clientId: string, readonly responseUri: string, readonly clientName?: string) {}

  /** A browser session asks to log in: make a request for the QR code. */
  start (session: string, nowMs: number): { request: LoginRequest, url: string } {
    const state = b64uOf(rand(16)), nonce = b64uOf(rand(16))
    this.pending.set(state, { session, nonce, created: nowMs, done: false, checking: false })
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
    this.loggedIn.set(p.session, r.entry)
    return { ok: true, ...r.entry }
  }

  private async check (token: unknown, p: Pending, nowMs: number): Promise<{ ok: true, entry: { user: string, name?: string } } | { ok: false, reason: string }> {
    const checked = await verifyIdTokenSignature(String(token))
    if (!checked.ok) return checked
    const c = checked.claims, now = Math.floor(nowMs / 1000)
    if (c.aud !== this.clientId) return { ok: false, reason: 'für eine andere Web-App ausgestellt' }
    if (c.nonce !== p.nonce) return { ok: false, reason: 'falsche Zufallszahl' }
    if (typeof c.iat !== 'number' || typeof c.exp !== 'number') return { ok: false, reason: 'ohne Zeitangaben' }
    if (c.iat > now + CLOCK_SKEW_S) return { ok: false, reason: 'aus der Zukunft' }
    if (c.exp < now || c.exp - c.iat > MAX_TOKEN_AGE_S) return { ok: false, reason: 'abgelaufen' }
    return { ok: true, entry: { user: c.sub, ...(typeof c.name === 'string' ? { name: c.name } : {}) } }
  }

  /** What the waiting page asks: is this browser session logged in, and as whom? */
  poll (session: string): { user: string, name?: string } | null {
    return this.loggedIn.get(session) ?? null
  }
}
