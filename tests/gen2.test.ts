import { describe, expect, it } from 'vitest'
import { runAll } from '../src/lab/scenarios'
import { gen2 } from '../src/candidates/gen2'

// WoT Gen 2 aus den veröffentlichten Paketen (@web_of_trust/core 0.6.0,
// @web_of_trust/adapter-yjs 0.3.0), InProcessLogBroker als Relay im Prozess.
// Die Erwartungen halten das heutige Verhalten fest (Basislinie, Plan E1);
// Begründungen in src/candidates/gen2/NOTES.md.
describe('Kandidat WoT Gen 2', () => {
  it('Basislinie je Szenario', async () => {
    const results = await runAll(gen2)
    const byId = Object.fromEntries(results.map((r) => [r.scenario, r.outcome]))
    expect(byId, JSON.stringify(results, null, 1)).toEqual({
      S1: 'bestanden',
      S2: 'bestanden',
      S3: 'bestanden',
      S4a: 'bestanden', // Relay sperrt Bobs veraltete Generation
      S4b: 'nicht bestanden', // befördeter Admin kann nicht durchsetzen (Relay kennt nur den Gründer)
      S4c: 'bestanden', // nur der Gründer kann durchsetzen; Bobs Entfernung bleibt vorgemerkt
      S4d: 'nicht abbildbar', // keine Rotation ohne Mitgliedschaftsänderung
      S4e: 'nicht abbildbar', // keine Gruppenregeln
      S4f: 'bestanden', // ohne Relay erreicht Mallorys Einladung niemanden
      S5: 'bestanden', // PersonalDoc-Sync durch geteilten Speicher ersetzt
      S6: 'bestanden',
      S7: 'nicht abbildbar',
      S8: 'nicht bestanden', // ohne Gründer kann niemand entfernen
    })
  }, 240_000)
})
