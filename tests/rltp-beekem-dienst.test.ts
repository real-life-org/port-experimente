import { describe, expect, it } from 'vitest'
import { runAll } from '../src/lab/scenarios'
import { rltpBeekem } from '../src/candidates/rltp-beekem'
import { BeekemPeer, loadWasm } from '../src/candidates/rltp-beekem/load'
import { World } from '../src/lab/world'
import type { Msg } from '../src/lab/types'

// E8: durchsetzender, schlüsselblinder Dienst am Relay des Prüfstands, in
// zwei Varianten gegen denselben BeeKEM-Kandidaten. Begründungen in
// src/candidates/rltp-beekem/NOTES.md, Abschnitt E8.
const gemeinsam = {
  S1: 'bestanden',
  S2: 'bestanden',
  S3: 'bestanden',
  S4a: 'bestanden',
  S4b: 'bestanden',
  S4c: 'bestanden',
  S4c2: 'bestanden',
  S4d: 'bestanden',
  S4e: 'bestanden',
  S4j: 'bestanden',
  S4f: 'bestanden',
  S5: 'bestanden',
  S5b: 'bestanden',
  S5c: 'bestanden',
  S6: 'bestanden', // E10: Historie über die Tabellen der versiegelten Autoritätsrahmen
  S6b: 'bestanden',
  S7: 'bestanden',
  S8: 'bestanden',
  S10a: 'bestanden', // Relay verwirft den gleichzeitigen Eintrag des Entfernten: kein Residual
  S10b: 'bestanden', // Sicht veraltet, bis die Entfernung das Relay erreicht; danach verworfen
}

describe('E8: Dienst am Relay', () => {
  it('Variante 1: Sichten (Access 0.56 §7.3, Quorum der Vorgängersicht)', async () => {
    const results = await runAll(() => rltpBeekem({ dienst: 'sichten' }))
    const byId = Object.fromEntries(results.map((r) => [r.scenario, r.outcome]))
    expect(byId, JSON.stringify(results, null, 1)).toEqual({
      ...gemeinsam,
      // Gegenseitige Entfernung lässt nur Carol: m=2 aus der alten Sicht ist nicht mehr
      // erfüllbar, der Dienst bleibt auf der alten Sicht. Das ist der „stated residual“
      // von Access 0.56 §7.3, wie geschrieben (E9 Schritt 2: S10c').
      S10c: 'nicht bestanden',
    })
  }, 120_000)

  it("Variante 1b: Sichten, m folgt der neuen Sicht (Guss-Plan 0.54; S10c')", async () => {
    const results = await runAll(() => rltpBeekem({ dienst: 'sichten', mRule: 'new' }))
    const byId = Object.fromEntries(results.map((r) => [r.scenario, r.outcome]))
    expect(byId, JSON.stringify(results, null, 1)).toEqual({
      ...gemeinsam,
      S10c: 'bestanden',
    })
  }, 120_000)

  it('Variante 2: Log-Replik (Kontrolle)', async () => {
    const results = await runAll(() => rltpBeekem({ dienst: 'logreplik' }))
    const byId = Object.fromEntries(results.map((r) => [r.scenario, r.outcome]))
    expect(byId, JSON.stringify(results, null, 1)).toEqual({
      ...gemeinsam,
      S6: 'nicht bestanden', // Klartextmodus (der Dienst liest das Log): keine Tabellen an den Autoritätsrahmen, Historie erst über die Kette
      S10c: 'bestanden',
    })
  }, 120_000)

  it('#32: Inhalt eines entfernten Geräts, außen als auth deklariert, wirkt beim Empfänger nicht', async () => {
    await loadWasm()
    const c = rltpBeekem({ dienst: 'sichten' })
    const w = new World(c)
    for (const p of ['alice', 'bob', 'carol']) await w.device(p, p)
    await w.flush()
    await w.createGroup('alice')
    await w.add('alice', 'bob')
    await w.add('alice', 'carol')
    await w.flush()
    await w.write('alice', 'vorher')
    await w.flush()
    // Carol sichert ihren Zustand, wird entfernt, und baut mit dem alten Zustand einen frischen Inhalt,
    // außen als Autoritätsrahmen deklariert (der Ausnahmeweg des Dienstes).
    const stolen = (await c.steal('carol')) as { state: Uint8Array }
    await w.remove('alice', 'carol')
    await w.flush()
    expect(c.service!.serves('carol')).toBe(false)
    const peer = BeekemPeer.fromState(stolen.state)
    const enc = new TextEncoder()
    const dec = new TextDecoder()
    const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
    const plain = enc.encode(JSON.stringify({ t: 'content', u: b64(new Uint8Array([1, 2, 3])) }))
    const ref = crypto.getRandomValues(new Uint8Array(32))
    const r = (await peer.encrypt(ref, [], plain)) as { ciphertext: Uint8Array }
    const frame = { t: 'sealed', kind: 'auth', c: b64(r.ciphertext), iv: b64(new Uint8Array(12)), tab: '', ref: Buffer.from(ref).toString('hex'), heads: [], by: 'x' }
    const msg: Msg = { id: 99999, from: 'carol', label: 'auth', body: enc.encode(JSON.stringify(frame)) }
    // Der Dienst lässt Autoritätsrahmen bewiesener Geräte durch (Evidenz); der Empfänger prüft die Art gegen den Inhalt.
    expect(c.service!.accept(msg)).toBe('weiter')
    const before = w.read('alice').length
    const { content } = await c.receive('alice', msg)
    expect(content).toEqual([])
    expect(c.status('alice')).toContain('behauptet auth, enthält content')
    expect(w.read('alice').length).toBe(before)
    void dec
  })
})
