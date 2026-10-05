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
      S4b: 'nicht bestanden', // befördeter Admin: adapter-yjs 0.3.0 sendet kein admin-add (Sync 005 verlangt es)
      S4c: 'bestanden', // formal: Bob kann aus demselben Grund nicht durchsetzen, nichts ist gleichzeitig
      S4d: 'nicht abbildbar', // keine Rotation ohne Mitgliedschaftsänderung
      S4e: 'nicht abbildbar', // keine Gruppenregeln
      S4f: 'bestanden', // formal: Mallorys Kette entsteht offline gar nicht
      S5: 'nicht abbildbar', // Zweitgerät läuft über das PersonalDoc (Singleton im Prozess)
      S5b: 'nicht abbildbar',
      S5c: 'nicht abbildbar',
      S6: 'bestanden',
      S6b: 'bestanden',
      S7: 'nicht abbildbar',
      S8: 'nicht bestanden', // wie S4b: Relay erfährt nie von Bobs Beförderung
    })
  }, 240_000)
})
