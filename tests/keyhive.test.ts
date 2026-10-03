import { describe, expect, it } from 'vitest'
import { runAll } from '../src/lab/scenarios'
import { keyhive } from '../src/candidates/keyhive'

// Keyhive über @keyhive/keyhive 0.3.0-alpha.1, Inhalt Yjs (Plan E3, Lauf b).
// Erwartungen halten das heutige Verhalten fest; Begründungen in
// src/candidates/keyhive/NOTES.md.
describe('Kandidat Keyhive (Yjs über @keyhive/keyhive)', () => {
  it('Basislinie je Szenario', async () => {
    const results = await runAll(keyhive)
    const byId = Object.fromEntries(results.map((r) => [r.scenario, r.outcome]))
    expect(byId, JSON.stringify(results, null, 1)).toEqual({
      S1: 'bestanden',
      S2: 'bestanden',
      S3: 'bestanden',
      S4a: 'bestanden', // Bobs gleichzeitiger Eintrag bleibt sichtbar
      S4b: 'bestanden', // gleichzeitige Entfernungen: niemand liest mit
      S4c: 'bestanden', // Bob kann die Gründerin nicht entfernen (Seniorität)
      S4d: 'bestanden', // forcePcsUpdate neben Entfernung
      S4e: 'nicht abbildbar', // keine Gruppenregeln
      S4f: 'nicht bestanden', // Mallorys Kette bleibt (offene Beobachtung, siehe NOTES)
      S5: 'nicht abbildbar', // Geräte als Gruppe der Person, im Prüfstand noch nicht verdrahtet
      S6: 'nicht bestanden', // Historie erst nach dem nächsten Eintrag
      S6b: 'bestanden', // über die Vorgänger-Kette (wie ARK, hier für Yjs)
      S7: 'bestanden', // PCS: nach forcePcsUpdate öffnet der Angreifer nichts
      S8: 'bestanden', // Admin entfernt ohne die Gründerin
    })
  }, 120_000)
})
