import { describe, expect, it } from 'vitest'
import { runAll } from '../src/lab/scenarios'
import { p2panda } from '../src/candidates/p2panda'

// p2panda-spaces 0.7.1 als WebAssembly (rust/p2panda-wasm, gepatchte Kopien
// unter vendor/). Erwartungen halten das heutige Verhalten fest (Plan E2);
// Begründungen in src/candidates/p2panda/NOTES.md.
describe('Kandidat p2panda (WebAssembly)', () => {
  it('Basislinie je Szenario', async () => {
    const results = await runAll(p2panda)
    const byId = Object.fromEntries(results.map((r) => [r.scenario, r.outcome]))
    expect(byId, JSON.stringify(results, null, 1)).toEqual({
      S1: 'bestanden',
      S2: 'bestanden',
      S3: 'bestanden',
      S4a: 'bestanden', // Bobs gleichzeitiger Eintrag bleibt sichtbar (Strong Removal betrifft Gruppenoperationen)
      S4b: 'nicht bestanden', // ein Entfernter liest nach gleichzeitigen Entfernungen mit (Befund)
      S4c: 'bestanden', // gegenseitige Entfernung: beide raus
      S4d: 'nicht abbildbar', // keine Rotation ohne Mitgliedschaftsänderung (SpaceUpdate nicht umgesetzt)
      S4e: 'nicht abbildbar', // keine Gruppenregeln
      S4f: 'bestanden', // Mallorys Kette wird transitiv ungültig
      S5: 'nicht abbildbar', // verschachtelte Gruppen für Geräte noch nicht verdrahtet
      S6: 'bestanden',
      S6b: 'bestanden',
      S7: 'nicht abbildbar',
      S8: 'bestanden', // Admin entfernt ohne Gründerin
    })
  }, 120_000)
})
