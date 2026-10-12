import { describe, expect, it } from 'vitest'
import { runCarrier } from '../src/lab/traeger'
import { rltpBeekem } from '../src/candidates/rltp-beekem'

// Träger-Prüfstand (E10): der BeeKEM-Kandidat über das Prüfstand-Relay, das
// den Gegner spielt. Erwartungen pinnen Befunde, nicht nur Erfolge.
describe('Träger-Prüfstand: rltp-beekem über das Prüfstand-Relay', () => {
  it('T-Szenarien', async () => {
    const results = await runCarrier(rltpBeekem)
    const byId = Object.fromEntries(results.map((r) => [r.scenario, r.outcome]))
    expect(byId, JSON.stringify(results, null, 1)).toEqual({
      T1: 'nicht bestanden', // kein Reparaturmechanismus: eine verlorene Operation bleibt verloren (Befund, I12)
      T2: 'bestanden',
      T3: 'bestanden',
      T4: 'bestanden',
      T5: 'bestanden',
      T6: 'nicht bestanden', // blind: gezieltes Zurückhalten ist nicht bemerkbar (Befund, D5)
      T12: 'nicht bestanden', // Rahmen im Klartext (Befund #24)
    })
  }, 300_000)
})
