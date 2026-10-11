import { describe, expect, it } from 'vitest'
import { runAll } from '../src/lab/scenarios'
import { rltpBeekem } from '../src/candidates/rltp-beekem'

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
  S4d: 'bestanden',
  S4e: 'bestanden',
  S4j: 'bestanden',
  S4f: 'bestanden',
  S5: 'bestanden',
  S5b: 'bestanden',
  S5c: 'bestanden',
  S6: 'nicht bestanden',
  S6b: 'bestanden',
  S7: 'bestanden',
  S8: 'bestanden',
  S10a: 'bestanden', // Relay verwirft den gleichzeitigen Eintrag des Entfernten: kein Residual
  S10b: 'bestanden', // Sicht veraltet, bis die Entfernung das Relay erreicht; danach verworfen
}

describe('E8: Dienst am Relay', () => {
  it('Variante 1: Sichten (Access §7.3)', async () => {
    const results = await runAll(() => rltpBeekem({ dienst: 'sichten' }))
    const byId = Object.fromEntries(results.map((r) => [r.scenario, r.outcome]))
    expect(byId, JSON.stringify(results, null, 1)).toEqual({
      ...gemeinsam,
      // Gegenseitige Entfernung lässt nur Carol: m=2 aus der alten Sicht ist nicht mehr
      // erfüllbar, der Dienst bleibt auf der alten Sicht (§7.3 „stated residual“).
      S10c: 'nicht bestanden',
    })
  }, 120_000)

  it('Variante 2: Log-Replik (Kontrolle)', async () => {
    const results = await runAll(() => rltpBeekem({ dienst: 'logreplik' }))
    const byId = Object.fromEntries(results.map((r) => [r.scenario, r.outcome]))
    expect(byId, JSON.stringify(results, null, 1)).toEqual({
      ...gemeinsam,
      S10c: 'bestanden',
    })
  }, 120_000)
})
