import { describe, expect, it } from 'vitest'
import { runAll } from '../src/lab/scenarios'
import { ARK_DELIVERY_BOUND_MS, ARK_TIMING_RUNS, keyhiveArk } from '../src/candidates/keyhive-ark'

// Keyhive, Lauf a: Automerge über ARK und einen lokalen Subduction-Server
// (Rust-Binary aus .cache/, siehe scripts/fetch-subduction.sh). Nur in Node.
// Erwartungen halten das heutige Verhalten fest (Plan E3a); Begründungen in
// src/candidates/keyhive-ark/NOTES.md.
//
// S6 und S6b hängen von der Zustellzeit des Servers ab (Anton 18.10.: Zeit als Verteilung messen, nie als
// Einzelergebnis). Der Prüfstand läuft sie ARK_TIMING_RUNS-mal; die Zelle besteht nur, wenn jeder Lauf innerhalb der
// hergeleiteten Schranke zustellt (Herleitung am Kandidaten). Der Pin hält die Regel fest, nicht einen Glücksfall:
// Dave ist in jedem Lauf Mitglied (streng), die Verteilung steht in der Ausgabe, und der Ausgang folgt aus ihr.
const timed = ['S6', 'S6b']

describe('Kandidat Keyhive über ARK und Subduction', () => {
  it('Basislinie je Szenario', async () => {
    const results = await runAll(keyhiveArk)
    const byId = Object.fromEntries(results.filter((r) => !timed.includes(r.scenario)).map((r) => [r.scenario, r.outcome]))
    expect(byId, JSON.stringify(results, null, 1)).toEqual({
      S1: 'bestanden',
      S2: 'bestanden',
      S3: 'bestanden',
      S4a: 'bestanden', // Server verwirft den Blob des gleichzeitig Entfernten
      S4b: 'bestanden', // Admin-Gruppe als Miteigentümerin; sonst „keyhive rejected“
      S4c: 'nicht bestanden', // Gründerin nicht entfernbar; Nicht-Admins sehen Gruppenänderung nicht
      S4c2: 'nicht bestanden', // wie S4c
      S4d: 'bestanden',
      S4e: 'nicht abbildbar',
      S4j: 'nicht abbildbar',
      S4f: 'nicht bestanden', // ARK behält Einladungen des Entfernten (retain_all_other_members)
      S5: 'nicht abbildbar',
      S5b: 'nicht abbildbar',
      S5c: 'nicht abbildbar',
      S7: 'nicht abbildbar', // Angreifer gegen Sedimentree-Blobs nicht verdrahtet
      S8: 'bestanden',
      S11: 'nicht abbildbar',
      S10a: 'nicht abbildbar',
      S10b: 'nicht abbildbar',
      S10c: 'nicht abbildbar',
    })
    // ARKs Nudge öffnet die Historie sofort, wenn der Server rechtzeitig zustellt.
    const bound = (ARK_DELIVERY_BOUND_MS / 1000).toFixed(1)
    for (const id of timed) {
      const r = results.find((x) => x.scenario === id)!
      process.stderr.write(`${id}: ${r.outcome} | ${r.authority} | ${r.keys} | ${(r.ms / 1000).toFixed(1)} s\n`)
      expect(r.authority, id).toContain('Dave Mitglied: ja')
      expect(r.authority, id).not.toContain('Dave Mitglied: nein')
      const m = r.authority.match(new RegExp(`(\\d+)/${ARK_TIMING_RUNS} innerhalb ${bound.replace('.', '\\.')} s \\(`))
      expect(m, `${id}: ${r.authority}`).not.toBeNull()
      const kept = Number(m![1])
      if (kept === ARK_TIMING_RUNS) expect(r.outcome, id).toBe('bestanden')
      else {
        expect(r.outcome, id).toBe('nicht bestanden')
        expect(r.authority, id).toMatch(new RegExp(`^abhängig von: Zustellzeit des Subduction-Servers, ${kept}/${ARK_TIMING_RUNS} `))
      }
    }
  }, 1_200_000)
})
