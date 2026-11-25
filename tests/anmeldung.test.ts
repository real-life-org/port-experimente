import { describe, expect, test } from 'vitest'
import { fromB64u, b64uOf } from 'rltp-lib'
import { parseRequestUrl, requestUrl } from '../src/lab/anmeldung/siop'
import { confirm, review } from '../src/lab/anmeldung/wallet'
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
    expect(await app.receive(a.body, T0 + 1000)).toEqual({ ok: false, reason: 'Anfrage schon beantwortet' })
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

  test('die Anfrage-URL enthält nichts außer den SIOPv2-Feldern', () => {
    const { url } = shop().start('b', T0)
    const keys = [...new URLSearchParams(url.slice(url.indexOf('?') + 1)).keys()].sort()
    expect(keys).toEqual(['client_id', 'client_name', 'id_token_type', 'nonce', 'response_mode', 'response_type', 'response_uri', 'scope', 'state'])
    expect(requestUrl(parseRequestUrl(url)!)).toBe(url)
  })
})
