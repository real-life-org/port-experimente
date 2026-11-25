import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
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

test('die App folgt keiner Weiterleitung: das Token erreicht keine andere Adresse', async () => {
  let caught = 0
  const catcher = createServer((_req, res) => { caught++; res.end() })
  await new Promise<void>((ok) => catcher.listen(0, '127.0.0.1', ok))
  const catcherPort = (catcher.address() as AddressInfo).port
  const redirector = createServer((_req, res) => { res.writeHead(307, { Location: `http://127.0.0.1:${catcherPort}/fang` }); res.end() })
  await new Promise<void>((ok) => redirector.listen(0, '127.0.0.1', ok))
  const at = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}`
  try {
    const req = { response_type: 'id_token', response_mode: 'direct_post', scope: 'openid', id_token_type: 'subject_signed',
      client_id: at, response_uri: at + '/antwort', nonce: 'n', state: 's' } as const
    const answer = await confirm(req, new Uint8Array(32).fill(9), Date.now())   // passes the origin check
    expect(await post(answer)).toBe(0)
    expect(caught).toBe(0)
  } finally {
    await new Promise<void>((ok) => redirector.close(() => ok()))
    await new Promise<void>((ok) => catcher.close(() => ok()))
  }
})

test('eine vorgegebene Sitzungs-ID wird nicht übernommen', async () => {
  const planted = 'vom-fremden-gesetzt'
  const r = await fetch(origin + '/start', { headers: { cookie: `sitzung=${planted}` } })
  const issued = r.headers.get('set-cookie')!.split(';')[0]!
  expect(issued).not.toBe(`sitzung=${planted}`)
  const answer = await confirm(parseRequestUrl(((await r.json()) as any).url)!, new Uint8Array(32).fill(10), Date.now())
  expect(await post(answer)).toBe(200)
  const asPlanted = await fetch(origin + '/status', { headers: { cookie: `sitzung=${planted}` } })
  expect(await asPlanted.json()).toEqual({})
  const asIssued = await fetch(origin + '/status', { headers: { cookie: issued } })
  expect(await asIssued.json()).toEqual({ user: answer.did })
})

test('eine zweite Antwort auf dieselbe Anfrage bekommt 400 mit Grund', async () => {
  const page = browser()
  const answer = await confirm(parseRequestUrl((await page('/start')).url)!, new Uint8Array(32).fill(8), Date.now())
  expect(await post(answer)).toBe(200)
  const again = await fetch(answer.response_uri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(answer.body).toString() })
  expect(again.status).toBe(400)
  expect(await again.json()).toEqual({ error: 'invalid_request', error_description: 'Anfrage schon beantwortet' })
})
