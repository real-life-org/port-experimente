import { describe, expect, test } from 'vitest'
import { fromB64u, b64uOf } from 'rltp-lib'
import { parseRequestUrl, requestUrl } from '../src/lab/anmeldung/siop'
import { confirm, mayOpen, review } from '../src/lab/anmeldung/wallet'
import { WebApp } from '../src/lab/anmeldung/webapp'

// Logging into an ordinary web app with the Web of Trust app, SIOPv2-shaped.
// Notes: src/lab/anmeldung/NOTES.md.

const T0 = Date.UTC(2026, 10, 25, 9, 0, 0)
const root = (n: number): Uint8Array => new Uint8Array(32).fill(n)
const ANTON = root(1), HOLGER = root(2)
const shop = () => new WebApp('https://beispiel.org', 'https://beispiel.org/anmeldung/antwort', 'Beispiel')
const other = () => new WebApp('https://andere.example', 'https://andere.example/antwort')

describe('Anmeldung mit der Web-of-Trust-App', () => {
  test('normaler Ablauf: QR, bestätigen, angemeldet', async () => {
    const app = shop()
    const { url } = app.start('browser-1', T0)
    const req = parseRequestUrl(url)!
    const shown = review(req)
    expect(shown).toEqual({ ok: true, origin: 'https://beispiel.org', host: 'beispiel.org',
      text: 'beispiel.org möchte dich anmelden. Es sieht nur einen Namen für dich, der nur dort gilt.' })
    const a = await confirm(req, ANTON, T0 + 5_000)
    expect(a.response_uri).toBe('https://beispiel.org/anmeldung/antwort')
    expect(await app.receive(a.body, T0 + 6_000)).toEqual({ ok: true, user: a.did })
    expect(app.poll('browser-1')).toEqual({ user: a.did })
    expect(a.did.startsWith('did:key:z6Mk')).toBe(true)
  })

  test('die Anfrage übersteht den Weg als URL', () => {
    const { request, url } = shop().start('b', T0)
    expect(parseRequestUrl(url)).toEqual(request)
    expect(parseRequestUrl(url.replace('response_type=id_token', 'response_type=code'))).toBeNull()
    expect(parseRequestUrl('https://beispiel.org')).toBeNull()
  })

  test('der Name geht nur mit, wenn der Mensch ihn teilt', async () => {
    const app = shop()
    const req = app.start('b', T0).request
    const a = await confirm(req, ANTON, T0, { name: 'Anton' })
    expect(await app.receive(a.body, T0)).toEqual({ ok: true, user: a.did, name: 'Anton' })
  })

  test('angezeigt wird die Adresse, nie der selbst gewählte Name der Web-App', () => {
    const req = { ...shop().start('b', T0).request, client_name: 'Deine Bank' }
    const shown = review(req)
    expect(shown.ok && shown.text.startsWith('beispiel.org ')).toBe(true)
    expect(JSON.stringify(shown)).not.toContain('Deine Bank')
  })

  test('die App verweigert, wenn die Antwort an eine andere Adresse ginge', async () => {
    const req = { ...shop().start('b', T0).request, response_uri: 'https://angreifer.example/fang' }
    expect(review(req)).toEqual({ ok: false, reason: 'Antwort ginge an eine andere Adresse als die Web-App' })
    await expect(confirm(req, ANTON, T0)).rejects.toThrow()
  })

  test('falsche Zufallszahl wird abgewiesen', async () => {
    const app = shop()
    const req = app.start('b', T0).request
    const a = await confirm({ ...req, nonce: 'eine-andere' }, ANTON, T0)
    expect(await app.receive(a.body, T0)).toEqual({ ok: false, reason: 'falsche Zufallszahl' })
    expect(app.poll('b')).toBeNull()
  })

  test('dieselbe Antwort zweimal: die zweite wird abgewiesen', async () => {
    const app = shop()
    const a = await confirm(app.start('b', T0).request, ANTON, T0)
    expect((await app.receive(a.body, T0)).ok).toBe(true)
    expect(await app.receive(a.body, T0 + 1000)).toEqual({ ok: false, reason: 'unbekannte Anfrage' })   // answered: gone at once
  })

  test('zwei gleichzeitige Antworten: genau eine wird angenommen', async () => {
    const app = shop()
    const req = app.start('b', T0).request
    const a = await confirm(req, ANTON, T0)
    const same = await Promise.all([app.receive(a.body, T0), app.receive(a.body, T0)])
    expect(same.filter((r) => r.ok)).toHaveLength(1)
    const app2 = shop()
    const req2 = app2.start('c', T0).request
    const [telefon, tablet] = await Promise.all([confirm(req2, ANTON, T0), confirm(req2, ANTON, T0)])
    const both = await Promise.all([app2.receive(telefon.body, T0), app2.receive(tablet.body, T0)])
    expect(both.filter((r) => r.ok)).toHaveLength(1)
  })

  test('eine abgewiesene Antwort verbraucht die Anfrage nicht', async () => {
    const app = shop()
    const req = app.start('b', T0).request
    const bad = await confirm({ ...req, nonce: 'eine-andere' }, ANTON, T0)
    const good = await confirm(req, ANTON, T0)
    const [r1, r2] = await Promise.all([app.receive(bad.body, T0), app.receive(good.body, T0)])
    expect(r1).toEqual({ ok: false, reason: 'falsche Zufallszahl' })
    expect(r2).toEqual({ ok: false, reason: 'Anfrage wird gerade geprüft' })
    expect(await app.receive(good.body, T0)).toEqual({ ok: true, user: good.did })
  })

  test('abgelaufene Anfrage und abgelaufenes Token werden abgewiesen', async () => {
    const app = shop()
    const late = await confirm(app.start('b', T0).request, ANTON, T0)
    expect(await app.receive(late.body, T0 + 6 * 60_000)).toEqual({ ok: false, reason: 'Anfrage abgelaufen' })
    const app2 = shop()
    const old = await confirm(app2.start('c', T0).request, ANTON, T0 - 400_000)   // signed with a clock 400 s behind
    expect(await app2.receive(old.body, T0)).toEqual({ ok: false, reason: 'abgelaufen' })
  })

  test('veränderte Unterschrift oder veränderter Inhalt wird abgewiesen', async () => {
    const app = shop()
    const a = await confirm(app.start('b', T0).request, ANTON, T0)
    const [h, p, s] = a.body.id_token.split('.') as [string, string, string]
    const claims = JSON.parse(new TextDecoder().decode(fromB64u(p)))
    const forged = `${h}.${b64uOf(new TextEncoder().encode(JSON.stringify({ ...claims, name: 'Jemand' })))}.${s}`
    expect(await app.receive({ ...a.body, id_token: forged }, T0)).toEqual({ ok: false, reason: 'Unterschrift ungültig' })
  })

  test('ein Token für Web-App A wird bei Web-App B abgewiesen', async () => {
    const a = shop(), b = other()
    const tokenForA = await confirm(a.start('x', T0).request, ANTON, T0)
    const stateAtB = b.start('y', T0).request.state
    expect(await b.receive({ id_token: tokenForA.body.id_token, state: stateAtB }, T0)).toEqual({ ok: false, reason: 'für eine andere Web-App ausgestellt' })
  })

  test('zwei Geräte desselben Menschen landen im selben Konto', async () => {
    const app = shop()
    const telefon = await confirm(app.start('laptop', T0).request, ANTON, T0)
    const tablet = await confirm(app.start('arbeitsrechner', T0).request, ANTON, T0)   // same root (stage 1)
    await app.receive(telefon.body, T0); await app.receive(tablet.body, T0)
    expect(app.poll('laptop')!.user).toBe(app.poll('arbeitsrechner')!.user)
  })

  test('zwei Web-Apps sehen zwei Namen, zwei Menschen zwei Konten', async () => {
    const atShop = await confirm(shop().start('b', T0).request, ANTON, T0)
    const atOther = await confirm(other().start('b', T0).request, ANTON, T0)
    const holger = await confirm(shop().start('b', T0).request, HOLGER, T0)
    expect(atShop.did).not.toBe(atOther.did)
    expect(atShop.did).not.toBe(holger.did)
  })

  // A limit, measured, not a promise: the cross-device QR way cannot tell who
  // started the request. Someone who shows the person a QR code of a real
  // login at beispiel.org that they started themselves is logged in as that
  // person once the person confirms. The app shows the right address, so the
  // person sees nothing wrong. See NOTES.md.
  test('Grenze: wer die Anfrage gestartet hat, wird angemeldet, auch ein Fremder', async () => {
    const app = shop()
    const fremd = app.start('browser-des-fremden', T0)
    const a = await confirm(parseRequestUrl(fremd.url)!, ANTON, T0)
    await app.receive(a.body, T0)
    expect(app.poll('browser-des-fremden')).toEqual({ user: a.did })
  })

  test('gleiches Gerät: die Antwort meldet niemanden an, sie gibt einen Rücksprung mit Code', async () => {
    const app = shop()
    const req = app.start('handy-browser', T0, 'same-device').request
    const a = await confirm(req, ANTON, T0)
    const r = await app.receive(a.body, T0)
    expect(r.ok && 'redirect_uri' in r).toBe(true)
    const back = new URL((r as { redirect_uri: string }).redirect_uri)
    expect(back.origin + back.pathname).toBe('https://beispiel.org/fertig')
    expect(mayOpen(req, back.href)).toBe(true)
    expect(app.poll('handy-browser')).toBeNull()
    const code = back.searchParams.get('response_code')!
    expect(app.redeem('handy-browser', code, T0 + 1000)).toEqual({ ok: true, user: a.did })
    expect(app.redeem('handy-browser', code, T0 + 2000)).toEqual({ ok: false, reason: 'unbekannter oder verbrauchter Code' })
  })

  test('gleiches Gerät: wer den Link eines Fremden öffnet, meldet weder sich noch den Fremden an', async () => {
    const app = shop()
    const fremd = app.start('browser-des-fremden', T0, 'same-device')        // the stranger starts and sends the link
    const r = await app.receive((await confirm(parseRequestUrl(fremd.url)!, ANTON, T0)).body, T0)
    const code = new URL((r as { redirect_uri: string }).redirect_uri).searchParams.get('response_code')!
    expect(app.poll('browser-des-fremden')).toBeNull()                         // the stranger is not logged in
    expect(app.redeem('antons-browser', code, T0)).toEqual({ ok: false, reason: 'Code gehört zu einem anderen Browser' })
    expect(app.redeem('browser-des-fremden', code, T0)).toEqual({ ok: false, reason: 'unbekannter oder verbrauchter Code' })
  })

  test('gleiches Gerät: ein Code gilt nur kurz', async () => {
    const app = shop()
    const req = app.start('b', T0, 'same-device').request
    const r = await app.receive((await confirm(req, ANTON, T0)).body, T0)
    const code = new URL((r as { redirect_uri: string }).redirect_uri).searchParams.get('response_code')!
    expect(app.redeem('b', code, T0 + 61_000)).toEqual({ ok: false, reason: 'Code abgelaufen' })
  })

  test('die App öffnet einen Rücksprung nur auf der Adresse der Web-App', () => {
    const req = shop().start('b', T0, 'same-device').request
    expect(mayOpen(req, 'https://beispiel.org/fertig?response_code=x')).toBe(true)
    expect(mayOpen(req, 'https://angreifer.example/fertig?response_code=x')).toBe(false)
    expect(mayOpen(req, 'javascript:alert(1)')).toBe(false)
  })

  test('die Anfrage-URL enthält nichts außer den SIOPv2-Feldern', () => {
    const { url } = shop().start('b', T0)
    const keys = [...new URLSearchParams(url.slice(url.indexOf('?') + 1)).keys()].sort()
    expect(keys).toEqual(['client_id', 'client_name', 'id_token_type', 'nonce', 'response_mode', 'response_type', 'response_uri', 'scope', 'state'])
    expect(requestUrl(parseRequestUrl(url)!)).toBe(url)
  })

  test('Speicher: eine beantwortete Anfrage ist sofort weg, Abgelaufenes räumt sweep weg (review #139)', async () => {
    const app = shop()
    const answered = app.start('a', T0).request
    app.start('b', T0)                                                  // never answered
    const same = app.start('c', T0, 'same-device').request              // answered, code never redeemed
    await app.receive((await confirm(answered, ANTON, T0)).body, T0)   // cross-device, never collected
    await app.receive((await confirm(same, ANTON, T0)).body, T0)
    expect(app.held()).toEqual({ pending: 1, loggedIn: 1, codes: 1 })
    app.sweep(T0 + 59_000)
    expect(app.held()).toEqual({ pending: 1, loggedIn: 1, codes: 1 })
    app.sweep(T0 + 61_000)
    expect(app.held()).toEqual({ pending: 1, loggedIn: 1, codes: 0 })
    app.sweep(T0 + 5 * 60_000 + 1)
    expect(app.held()).toEqual({ pending: 0, loggedIn: 0, codes: 0 })
  })

  // Review #139, round 2: confirmed in time, collected after the request's own five minutes
  test('Grenzfall: bestätigt nach 4:59, abgeholt nach 5:01, Laptop und Telefon', async () => {
    const app = shop()
    const req = app.start('laptop', T0).request
    const a = await confirm(req, ANTON, T0 + 299_000)
    expect(await app.receive(a.body, T0 + 299_000)).toEqual({ ok: true, user: a.did })
    app.sweep(T0 + 301_000)
    expect(app.take('laptop', T0 + 301_000)).toEqual({ user: a.did })
    expect(app.take('laptop', T0 + 302_000)).toBeNull()                          // exactly once
  })

  test('Grenzfall: bestätigt nach 4:59, Rücksprung nach 5:01, gleiches Gerät', async () => {
    const app = shop()
    const req = app.start('handy', T0, 'same-device').request
    const r = await app.receive((await confirm(req, ANTON, T0 + 299_000)).body, T0 + 299_000)
    const code = new URL((r as { redirect_uri: string }).redirect_uri).searchParams.get('response_code')!
    app.sweep(T0 + 301_000)
    expect(app.redeem('handy', code, T0 + 301_000)).toMatchObject({ ok: true })
  })

  test('die Abholfrist zählt ab der Bestätigung und endet mit ihr', async () => {
    const app = shop()
    const req = app.start('laptop', T0).request
    await app.receive((await confirm(req, ANTON, T0 + 60_000)).body, T0 + 60_000)
    expect(app.take('laptop', T0 + 60_000 + 5 * 60_000 + 1)).toBeNull()
  })

  // Review #139, round 3: a new start of the same browser during the check of the old answer
  test('Neustart während der Prüfung: die alte Anmeldung legt nichts ab', async () => {
    const app = shop()
    const req = app.start('browser', T0).request
    const answer = await confirm(req, ANTON, T0)
    const checking = app.receive(answer.body, T0)        // the check is running (claimed before its first await)
    app.forget('browser')                                  // the browser starts a new login meanwhile
    expect(await checking).toEqual({ ok: false, reason: 'Anmeldung ersetzt' })
    expect(app.take('browser', T0)).toBeNull()
    expect(app.held()).toEqual({ pending: 0, loggedIn: 0, codes: 0 })
  })

  test('Neustart während der Prüfung, gleiches Gerät: kein Rücksprungcode bleibt', async () => {
    const app = shop()
    const req = app.start('handy', T0, 'same-device').request
    const checking = app.receive((await confirm(req, ANTON, T0)).body, T0)
    app.forget('handy')
    expect(await checking).toEqual({ ok: false, reason: 'Anmeldung ersetzt' })
    expect(app.held().codes).toBe(0)
  })
})


describe('inFlight: eine neue Anmeldung ersetzt keine laufende Bestätigung (Review #141)', () => {
  test('während der Prüfung und bis zur Abholung', async () => {
    const app = new WebApp('https://shop.example', 'https://shop.example/antwort')
    const T = Date.UTC(2026, 10, 26)
    const { request } = app.start('s', T)
    expect(app.inFlight('s', T)).toBe(false)
    const a = await confirm(request, new Uint8Array(32).fill(15), T)
    const checking = app.receive(a.body, T)                 // the check runs (await inside)
    expect(app.inFlight('s', T)).toBe(true)
    expect(await checking).toMatchObject({ ok: true })
    expect(app.inFlight('s', T)).toBe(true)                 // confirmed, not yet collected
    expect(app.take('s', T)).toMatchObject({ user: a.did })
    expect(app.inFlight('s', T)).toBe(false)
  })
})
