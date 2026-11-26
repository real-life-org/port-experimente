import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { parseRequestUrl } from '../src/lab/anmeldung/siop'
import { confirm } from '../src/lab/anmeldung/wallet'
import { post, postAndRead, serve } from '../src/lab/anmeldung/http'

// The same login over real HTTP. The QR way (cross-device) is a login attempt (vorgang) that lives in
// the page's script; collecting it signs the browser in with the cookie `sitzung`, exactly once. The
// same-device way binds its attempt to the browser with a cookie of its own (`anmeldung`). Renewing a
// QR code never sets a cookie (review #141).

let server: Server, origin: string
beforeAll(async () => { ({ server, origin } = await serve()) })
afterAll(() => new Promise<void>((ok) => server.close(() => ok())))

/** one browser: its cookies, shared by all its tabs */
function browser (at = () => origin) {
  const jar = new Map<string, string>()
  const call = async (path: string, method = 'GET') => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
    const r = await fetch(at() + path, { method, headers: cookie ? { cookie } : {}, redirect: 'manual' })
    const sets = r.headers.getSetCookie()
    for (const c of sets) { const [kv] = c.split(';'); const [k, v] = kv!.split('='); if (/Max-Age=0/.test(c) || !v) jar.delete(k!); else jar.set(k!, v) }
    const body = r.headers.get('content-type')?.includes('json') ? await r.json() as any : await r.text()
    return { status: r.status, body, setCookie: sets }
  }
  return { call, jar }
}

test('Anmeldung über HTTP: Seite startet, App antwortet, Seite holt ab und ist angemeldet', async () => {
  const b = browser()
  const start = await b.call('/start')
  const { vorgang, url } = start.body
  // the QR way sets only the attempt's own binding cookie, never the signed-in one
  expect(start.setCookie.map((c) => c.split('=')[0])).toEqual(['v_' + vorgang])
  expect((await b.call('/status?vorgang=' + vorgang)).body).toEqual({})
  const answer = await confirm(parseRequestUrl(url)!, new Uint8Array(32).fill(7), Date.now(), { name: 'Anton' })
  expect(await post(answer)).toBe(200)
  expect((await b.call('/status?vorgang=' + vorgang)).body).toEqual({ user: answer.did, name: 'Anton' })
  expect((await b.call('/status')).body).toEqual({ user: answer.did, name: 'Anton' })   // signed in now
  expect((await browser().call('/status')).body).toEqual({})                            // another browser is not
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

test('ein untergeschobenes Cookie meldet niemanden an', async () => {
  const b = browser(); b.jar.set('sitzung', 'vom-fremden-gesetzt')
  expect((await b.call('/status')).body).toEqual({})
})

test('ein Vorgang wird genau einmal abgeholt; ohne das Cookie bekommt danach niemand etwas', async () => {
  const b = browser()
  const { vorgang, url } = (await b.call('/start')).body
  const answer = await confirm(parseRequestUrl(url)!, new Uint8Array(32).fill(11), Date.now())
  expect(await post(answer)).toBe(200)
  expect((await b.call('/status?vorgang=' + vorgang)).body).toEqual({ user: answer.did })
  const other = browser()                                   // knows the attempt id, not the cookie
  const again = await other.call('/status?vorgang=' + vorgang)
  expect(again.body).toEqual({})
  expect(again.setCookie).toEqual([])
})

test('die Vorgangs-ID allein holt nichts ab: ein fremder Browser zuerst geht leer aus, der startende danach nicht (Review #141, Runde 4)', async () => {
  const b = browser()
  const { vorgang, url } = (await b.call('/start')).body
  const answer = await confirm(parseRequestUrl(url)!, new Uint8Array(32).fill(19), Date.now())
  expect(await post(answer)).toBe(200)
  const fremd = browser()                                   // knows the id (it travels in URLs), not the binding
  const first = await fremd.call('/status?vorgang=' + vorgang)
  expect(first.body).toEqual({})
  expect(first.setCookie).toEqual([])
  expect((await fremd.call('/erneuern?vorgang=' + vorgang)).status).toBe(410)
  expect((await b.call('/status?vorgang=' + vorgang)).body).toEqual({ user: answer.did })
  expect(b.jar.has('v_' + vorgang)).toBe(false)             // the binding is used up with the collect
})

test('Erneuern ersetzt die Anfrage desselben Vorgangs; die alte gilt nicht mehr; nur die eigene Bindung wird aufgefrischt', async () => {
  const b = browser()
  const first = (await b.call('/start')).body
  const renewed = await b.call('/erneuern?vorgang=' + first.vorgang)
  expect(renewed.status).toBe(200)
  // only this attempt's own binding is refreshed; never the signed-in cookie
  expect(renewed.setCookie.map((c) => c.split('=')[0])).toEqual(['v_' + first.vorgang])
  expect(renewed.body.vorgang).toBe(first.vorgang)
  expect(renewed.body.url).not.toBe(first.url)
  const old = await confirm(parseRequestUrl(first.url)!, new Uint8Array(32).fill(12), Date.now())
  expect(await post(old)).toBe(400)
  const now = await confirm(parseRequestUrl(renewed.body.url)!, new Uint8Array(32).fill(12), Date.now())
  expect(await post(now)).toBe(200)
  expect((await b.call('/status?vorgang=' + first.vorgang)).body).toEqual({ user: now.did })
  expect((await b.call('/erneuern?vorgang=unbekannt')).status).toBe(410)
})

test('Startseite zeigt einen QR-Code, der auf die Wallet mit der Anfrage zeigt', async () => {
  const r = (await browser().call('/start')).body as { url: string, walletLink: string, qrSvg: string }
  expect(r.qrSvg.startsWith('<svg')).toBe(true)
  expect(r.walletLink).toBe(`${origin}/wallet#${encodeURIComponent(r.url)}`)
  expect(parseRequestUrl(decodeURIComponent(new URL(r.walletLink).hash.slice(1)))).not.toBeNull()
})

test('gleiches Gerät über HTTP: bestätigen, Rücksprung, angemeldet in genau diesem Browser', async () => {
  const b = browser()
  const start = await b.call('/start?geraet=gleich')
  expect(b.jar.has('anmeldung')).toBe(true)
  expect(start.body.qrSvg).toBeUndefined()
  const answer = await confirm(parseRequestUrl(start.body.url)!, new Uint8Array(32).fill(13), Date.now())
  const sent = await postAndRead(answer)
  expect(sent.status).toBe(200)
  expect(sent.redirect_uri!.startsWith(origin + '/fertig?response_code=')).toBe(true)
  expect((await b.call('/status')).body).toEqual({})                    // nothing to poll on this way
  const back = await b.call(new URL(sent.redirect_uri!).pathname + new URL(sent.redirect_uri!).search)
  expect(back.status).toBe(303)
  expect(b.jar.has('anmeldung')).toBe(false)                            // the attempt cookie is gone
  expect((await b.call('/status')).body).toEqual({ user: answer.did })
})

test('gleiches Gerät über HTTP: der Rücksprung in einem fremden Browser meldet niemanden an', async () => {
  const fremd = browser()
  const start = await fremd.call('/start?geraet=gleich')
  const answer = await confirm(parseRequestUrl(start.body.url)!, new Uint8Array(32).fill(14), Date.now())
  const sent = await postAndRead(answer)
  const path = new URL(sent.redirect_uri!).pathname + new URL(sent.redirect_uri!).search
  const anton = browser()
  const inAntonsBrowser = await anton.call(path)                        // no attempt of this request here
  expect(inAntonsBrowser.status).toBe(400)
  expect(anton.jar.size).toBe(0)
  expect((await fremd.call(path)).status).toBe(400)                     // the code is used up
  expect((await fremd.call('/status')).body).toEqual({})
})

test('eine zweite Antwort auf dieselbe Anfrage bekommt 400 mit Grund', async () => {
  const answer = await confirm(parseRequestUrl((await browser().call('/start')).body.url)!, new Uint8Array(32).fill(8), Date.now())
  expect(await post(answer)).toBe(200)
  const again = await fetch(answer.response_uri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(answer.body).toString() })
  expect(again.status).toBe(400)
  expect(await again.json()).toEqual({ error: 'invalid_request', error_description: 'unbekannte Anfrage' })
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
    const demo = await (await fetch(o2 + '/start?wallet=demo')).json() as { url: string, walletLink: string }
    expect(demo.walletLink).toBe(`${o2}/wallet#${encodeURIComponent(demo.url)}`)
  } finally {
    await new Promise<void>((ok) => s2.close(() => ok()))
  }
})

test('Dauerbetrieb: Sitzungen laufen nach einer Stunde ab, offene Anfragen nach fünf Minuten, und es gibt eine Obergrenze (review #139)', async () => {
  let t = Date.now()
  const { server: s3, origin: o3, app } = await serve({ now: () => t, maxOpenRequests: 2 })
  try {
    const b = browser(() => o3)
    const { vorgang, url } = (await b.call('/start')).body
    const answer = await confirm(parseRequestUrl(url)!, new Uint8Array(32).fill(16), t)
    expect(await post(answer)).toBe(200)
    expect((await b.call('/status?vorgang=' + vorgang)).body).toEqual({ user: answer.did })
    expect(app.held().pending).toBe(0)
    const c = browser(() => o3)
    await c.call('/start'); await c.call('/start')
    expect(app.held().pending).toBe(2)
    expect((await c.call('/start')).status).toBe(503)
    t += 5 * 60_000 + 1
    expect((await c.call('/start')).status).toBe(200)
    expect(app.held().pending).toBe(1)
    expect((await b.call('/status')).body).toEqual({ user: answer.did })
    t += 60 * 60_000
    expect((await b.call('/status')).body).toEqual({})
  } finally {
    await new Promise<void>((ok) => s3.close(() => ok()))
  }
})

// Review #139, round 2: the binding holds from the confirmation until the pickup ends
test('Grenzfall über HTTP: bestätigt nach 4:59, abgeholt nach 5:01, in beiden Modi', async () => {
  let t = Date.now()
  const t0 = t
  const { server: s4, origin: o4 } = await serve({ now: () => t })
  try {
    const laptop = browser(() => o4), handy = browser(() => o4)
    const l = (await laptop.call('/start')).body
    const h = (await handy.call('/start?geraet=gleich')).body
    t = t0 + 299_000
    const la = await confirm(parseRequestUrl(l.url)!, new Uint8Array(32).fill(17), t)
    expect(await post(la)).toBe(200)
    const ha = await postAndRead(await confirm(parseRequestUrl(h.url)!, new Uint8Array(32).fill(18), t))
    expect(ha.status).toBe(200)
    t = t0 + 301_000
    expect((await laptop.call('/status?vorgang=' + l.vorgang)).body).toEqual({ user: la.did })
    const back = await handy.call(new URL(ha.redirect_uri!).pathname + new URL(ha.redirect_uri!).search)
    expect(back.status).toBe(303)
  } finally {
    await new Promise<void>((ok) => s4.close(() => ok()))
  }
})

// Profile on the page (name and picture, both only as the person shared them in the app)
const PICTURE = 'data:image/webp;base64,' + 'A'.repeat(20_000) + '=='

async function signedIn (b: ReturnType<typeof browser>, fill: number, opts: { name?: string, picture?: string } = {}) {
  const { vorgang, url } = (await b.call('/start')).body
  const answer = await confirm(parseRequestUrl(url)!, new Uint8Array(32).fill(fill), Date.now(), opts)
  expect(await post(answer)).toBe(200)
  return { answer, collected: (await b.call('/status?vorgang=' + vorgang)).body }
}

test('ein geteiltes Bild kommt mit dem Namen auf der Seite an', async () => {
  const { answer, collected } = await signedIn(browser(), 21, { name: 'Anton', picture: PICTURE })
  expect(collected).toEqual({ user: answer.did, name: 'Anton', picture: PICTURE })
})

test('ein Bild, das kein eingebettetes Bild ist, zeigt die Seite nicht (keine fremde Adresse, nicht zu groß)', async () => {
  for (const picture of ['https://tracker.example/pixel.png', 'data:text/html;base64,PHNjcmlwdD4=', 'data:image/webp;base64,' + 'A'.repeat(120_000)]) {
    const { answer, collected } = await signedIn(browser(), 22, { name: 'Anton', picture })
    expect(collected).toEqual({ user: answer.did, name: 'Anton' })     // the login counts; only the picture is dropped
  }
})

test('Abmelden beendet die Sitzung', async () => {
  const b = browser()
  const { answer } = await signedIn(b, 23)
  expect((await b.call('/status')).body.user).toBe(answer.did)
  const cookie = b.jar.get('sitzung')!
  await b.call('/abmelden', 'POST')
  expect((await b.call('/status')).body).toEqual({})
  expect(await (await fetch(origin + '/status', { headers: { cookie: `sitzung=${cookie}` } })).json()).toEqual({})
})

test('die Seite: auf dem Rechner der QR-Code, auf dem Telefon ein Knopf, die Demo-Wallet nur mit ?demo, nach einem Fehler ein Knopf', async () => {
  const html = await (await fetch(origin + '/')).text()
  expect(html).toContain('id="qrbox"')
  expect(html).toContain('id="hierbox"')
  expect(html).toContain("matchMedia('(pointer: coarse)')")
  expect(html).not.toContain('id="demo"')
  expect(html).toContain("has('demo')")
  expect(html).toContain('id="nochmal"')
})

// Review #141: after a successful collect the browser stays signed in, whenever and from whichever
// tab an old QR renewal arrives.
test('Erneuerung kurz nach der Bestätigung, vor der Abholung: 409, die Anmeldung bleibt abholbar', async () => {
  let t = Date.UTC(2026, 10, 26, 12, 0, 0)
  const s = await serve({ now: () => t })
  try {
    const b = browser(() => s.origin)
    const { vorgang, url } = (await b.call('/start')).body
    t += 269_900
    const answer = await confirm(parseRequestUrl(url)!, new Uint8Array(32).fill(31), t, { name: 'Anton' })
    expect(await post(answer)).toBe(200)
    t += 100
    const renew = await b.call('/erneuern?vorgang=' + vorgang)
    expect(renew.status).toBe(409)
    expect(renew.setCookie).toEqual([])
    expect((await b.call('/status?vorgang=' + vorgang)).body).toEqual({ user: answer.did, name: 'Anton' })
  } finally { s.server.close() }
})

test('Erneuerung nach der Abholung, aus demselben oder einem zweiten Tab, auch Minuten später: das Anmelde-Cookie bleibt', async () => {
  let t = Date.UTC(2026, 10, 26, 12, 0, 0)
  const s = await serve({ now: () => t })
  try {
    const b = browser(() => s.origin)                      // one browser, two tabs share its cookies
    const tabA = (await b.call('/start')).body
    const tabB = (await b.call('/start')).body
    const answer = await confirm(parseRequestUrl(tabA.url)!, new Uint8Array(32).fill(32), t)
    expect(await post(answer)).toBe(200)
    expect((await b.call('/status?vorgang=' + tabA.vorgang)).body.user).toBe(answer.did)   // tab A collects
    const signed = b.jar.get('sitzung')
    // tab A's timer was already on its way with its attempt
    const lateA = await b.call('/erneuern?vorgang=' + tabA.vorgang)
    expect(lateA.status).toBe(410)
    expect(lateA.setCookie).toEqual([])
    // tab B's timer fires before its next poll
    const renewB = await b.call('/erneuern?vorgang=' + tabB.vorgang)
    expect(renewB.status).toBe(200)
    expect(renewB.setCookie.map((c) => c.split('=')[0])).toEqual(['v_' + tabB.vorgang])
    expect(b.jar.get('sitzung')).toBe(signed)
    expect((await b.call('/status?vorgang=' + tabB.vorgang)).body.user).toBe(answer.did)
    // minutes later, an old renewal again
    t += 3 * 60_000
    expect((await b.call('/erneuern?vorgang=' + tabA.vorgang)).setCookie).toEqual([])
    expect((await b.call('/status')).body.user).toBe(answer.did)
  } finally { s.server.close() }
})

test('jeder angezeigte Code trägt bis zum Ende seines Abholfensters: erneuert nach 9 Minuten, bestätigt nach 10:01, abgeholt (Review #141, Runde 5)', async () => {
  let t = Date.UTC(2026, 10, 26, 12, 0, 0)
  const s = await serve({ now: () => t })
  try {
    const b = browser(() => s.origin)
    const { vorgang } = (await b.call('/start')).body
    t += 4 * 60_000; await b.call('/erneuern?vorgang=' + vorgang)
    t += 5 * 60_000
    const renewed = (await b.call('/erneuern?vorgang=' + vorgang)).body   // 9:00
    t += 61_000                                                             // 10:01
    const answer = await confirm(parseRequestUrl(renewed.url)!, new Uint8Array(32).fill(33), t)
    expect(await post(answer)).toBe(200)
    expect((await b.call('/status?vorgang=' + vorgang)).body).toEqual({ user: answer.did })
  } finally { s.server.close() }
})
