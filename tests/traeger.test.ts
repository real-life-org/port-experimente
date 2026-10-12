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
      T1: 'bestanden', // Lückenreparatur (I12): die Replik fordert den fehlenden Vorgänger beim Autor des Belegs nach
      T2: 'bestanden',
      T3: 'bestanden',
      T4: 'bestanden',
      T5: 'bestanden',
      T6: 'bestanden', // bemerkbar, sobald ein Dritter auf dem vorgehaltenen Eintrag aufbaut (kausale Köpfe im Inhalt); reines Zurückhalten des ganzen Feeds bleibt unbemerkbar (D5)
      T6b: 'nicht bestanden', // blind: ein eingefrorener Feed ist ohne beglaubigtes Ziel nicht bemerkbar (Befund, D5)
      T7: 'bestanden', // blind: Carol wird bedient, kann aber nichts öffnen (KV1)
      T8: 'nicht abbildbar', // ein Prüfstand-Relay kennt keinen Wechsel
      T11: 'nicht abbildbar', // ein Kandidat trägt eine Gruppe
      T12: 'nicht bestanden', // Rahmen im Klartext (Befund #24)
    })
  }, 300_000)

  it('T7 mit Dienst der Klasse Sicht: das entfernte Gerät wird verweigert', async () => {
    const results = await runCarrier(() => rltpBeekem({ dienst: 'sichten' }))
    const t7 = results.find((r) => r.scenario === 'T7')!
    expect(t7.outcome, t7.authority).toBe('bestanden')
    expect(t7.authority).toContain('wird verweigert')
  }, 300_000)
})
