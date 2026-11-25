import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { parseRequestUrl } from '../src/lab/anmeldung/siop'
import { confirm } from '../src/lab/anmeldung/wallet'
import { post, postAndRead, serve } from '../src/lab/anmeldung/http'

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

test('beim Login gibt es eine neue Sitzung; die alte ID allein bekommt danach nichts', async () => {
  const start = await fetch(origin + '/start')
  const before = start.headers.get('set-cookie')!.split(';')[0]!
  const answer = await confirm(parseRequestUrl(((await start.json()) as any).url)!, new Uint8Array(32).fill(11), Date.now())
  expect(await post(answer)).toBe(200)

  const collect = await fetch(origin + '/status', { headers: { cookie: before } })
  expect(await collect.json()).toEqual({ user: answer.did })
  const after = collect.headers.get('set-cookie')!.split(';')[0]!
  expect(after).not.toBe(before)

  const withOld = await fetch(origin + '/status', { headers: { cookie: before } })
  expect(await withOld.json()).toEqual({})                    // cannot read the account
  expect(withOld.headers.get('set-cookie')).toBeNull()        // cannot collect the new session
  const withNew = await fetch(origin + '/status', { headers: { cookie: after } })
  expect(await withNew.json()).toEqual({ user: answer.did })
})

test('eine früher ausgegebene ID gilt nach einem neuen Start nicht mehr', async () => {
  const first = (await fetch(origin + '/start')).headers.get('set-cookie')!.split(';')[0]!
  const second = await fetch(origin + '/start', { headers: { cookie: first } })
  const now = second.headers.get('set-cookie')!.split(';')[0]!
  expect(now).not.toBe(first)
  const answer = await confirm(parseRequestUrl(((await second.json()) as any).url)!, new Uint8Array(32).fill(12), Date.now())
  expect(await post(answer)).toBe(200)
  expect(await (await fetch(origin + '/status', { headers: { cookie: first } })).json()).toEqual({})
  expect(await (await fetch(origin + '/status', { headers: { cookie: now } })).json()).toEqual({ user: answer.did })
})

test('Startseite zeigt einen QR-Code, der auf die Wallet mit der Anfrage zeigt', async () => {
  const r = await (await fetch(origin + '/start')).json() as { url: string, walletLink: string, qrSvg: string }
  expect(r.qrSvg.startsWith('<svg')).toBe(true)
  expect(r.walletLink).toBe(`${origin}/wallet#${encodeURIComponent(r.url)}`)
  expect(parseRequestUrl(decodeURIComponent(new URL(r.walletLink).hash.slice(1)))).not.toBeNull()
})

test('gleiches Gerät über HTTP: bestätigen, Rücksprung, angemeldet in genau diesem Browser', async () => {
  const start = await fetch(origin + '/start?geraet=gleich')
  const cookie = start.headers.get('set-cookie')!.split(';')[0]!
  const { url, qrSvg } = await start.json() as { url: string, qrSvg?: string }
  expect(qrSvg).toBeUndefined()
  const answer = await confirm(parseRequestUrl(url)!, new Uint8Array(32).fill(13), Date.now())
  const sent = await postAndRead(answer)
  expect(sent.status).toBe(200)
  expect(sent.redirect_uri!.startsWith(origin + '/fertig?response_code=')).toBe(true)
  expect(await (await fetch(origin + '/status', { headers: { cookie } })).json()).toEqual({})   // no polling login

  const back = await fetch(sent.redirect_uri!, { headers: { cookie }, redirect: 'manual' })
  expect(back.status).toBe(303)
  const signedIn = back.headers.get('set-cookie')!.split(';')[0]!
  expect(signedIn).not.toBe(cookie)
  expect(await (await fetch(origin + '/status', { headers: { cookie: signedIn } })).json()).toEqual({ user: answer.did })
  expect(await (await fetch(origin + '/status', { headers: { cookie } })).json()).toEqual({})
})

test('gleiches Gerät über HTTP: der Rücksprung in einem fremden Browser meldet niemanden an', async () => {
  const fremd = await fetch(origin + '/start?geraet=gleich')
  const fremdCookie = fremd.headers.get('set-cookie')!.split(';')[0]!
  const answer = await confirm(parseRequestUrl(((await fremd.json()) as any).url)!, new Uint8Array(32).fill(14), Date.now())
  const sent = await postAndRead(answer)
  const inAntonsBrowser = await fetch(sent.redirect_uri!, { redirect: 'manual' })            // Anton's browser: no session of this request
  expect(inAntonsBrowser.status).toBe(400)
  expect(inAntonsBrowser.headers.get('set-cookie')).toBeNull()
  const strangerLater = await fetch(sent.redirect_uri!, { headers: { cookie: fremdCookie }, redirect: 'manual' })
  expect(strangerLater.status).toBe(400)                                                    // the code is used up
  expect(await (await fetch(origin + '/status', { headers: { cookie: fremdCookie } })).json()).toEqual({})
})

test('eine zweite Antwort auf dieselbe Anfrage bekommt 400 mit Grund', async () => {
  const page = browser()
  const answer = await confirm(parseRequestUrl((await page('/start')).url)!, new Uint8Array(32).fill(8), Date.now())
  expect(await post(answer)).toBe(200)
  const again = await fetch(answer.response_uri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(answer.body).toString() })
  expect(again.status).toBe(400)
  expect(await again.json()).toEqual({ error: 'invalid_request', error_description: 'Anfrage schon beantwortet' })
})

test('die Antwortadresse darf von jeder Origin gelesen werden (die App antwortet aus ihrem WebView)', async () => {
  const req = parseRequestUrl(((await (await fetch(origin + '/start')).json()) as any).url)!
  const answer = await confirm(req, new Uint8Array(32).fill(15), Date.now())
  const r = await fetch(answer.response_uri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://localhost' }, body: new URLSearchParams(answer.body).toString() })
  expect(r.status).toBe(200)
  expect(r.headers.get('access-control-allow-origin')).toBe('*')
})

test('mit wallet: app zeigen QR-Code und Link auf die App (https://web-of-trust.de/a)', async () => {
  const { server: s2, origin: o2 } = await serve({ wallet: 'app' })
  try {
    const r = await (await fetch(o2 + '/start')).json() as { url: string, walletLink: string }
    expect(r.walletLink).toBe(`https://web-of-trust.de/a#${encodeURIComponent(r.url)}`)
  } finally {
    await new Promise<void>((ok) => s2.close(() => ok()))
  }
})

