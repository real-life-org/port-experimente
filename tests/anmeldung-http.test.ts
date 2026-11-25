import { afterAll, beforeAll, expect, test } from 'vitest'
import type { Server } from 'node:http'
import { parseRequestUrl } from '../src/lab/anmeldung/siop'
import { confirm } from '../src/lab/anmeldung/wallet'
import { post, serve } from '../src/lab/anmeldung/http'

// The same login over real HTTP: the browser session is a cookie, the wallet
// posts to the response_uri, the page polls /status.

let server: Server, origin: string
beforeAll(async () => { ({ server, origin } = await serve()) })
afterAll(() => new Promise<void>((ok) => server.close(() => ok())))

function browser () {
  let cookie = ''
  return async (path: string) => {
    const r = await fetch(origin + path, { headers: cookie ? { cookie } : {} })
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]!
    return r.json() as Promise<any>
  }
}

test('Anmeldung über HTTP: Seite startet, App antwortet, Seite ist angemeldet', async () => {
  const page = browser()
  const { url } = await page('/start')
  expect(await page('/status')).toEqual({})
  const answer = await confirm(parseRequestUrl(url)!, new Uint8Array(32).fill(7), Date.now(), { name: 'Anton' })
  expect(await post(answer)).toBe(200)
  expect(await page('/status')).toEqual({ user: answer.did, name: 'Anton' })
  expect(await browser()('/status')).toEqual({})          // another browser stays logged out
})

test('eine zweite Antwort auf dieselbe Anfrage bekommt 400 mit Grund', async () => {
  const page = browser()
  const answer = await confirm(parseRequestUrl((await page('/start')).url)!, new Uint8Array(32).fill(8), Date.now())
  expect(await post(answer)).toBe(200)
  const again = await fetch(answer.response_uri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(answer.body).toString() })
  expect(again.status).toBe(400)
  expect(await again.json()).toEqual({ error: 'invalid_request', error_description: 'Anfrage schon beantwortet' })
})
