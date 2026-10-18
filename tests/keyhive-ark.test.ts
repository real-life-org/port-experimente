import { describe, expect, it } from 'vitest'
import { runAll } from '../src/lab/scenarios'
import { ARK_NO_BOUND, ARK_OBSERVATION_WINDOW_MS, ARK_TIMING_RUNS, keyhiveArk } from '../src/candidates/keyhive-ark'
import { runFaults } from '../src/lab/zeit'

// Keyhive, Lauf a: Automerge über ARK und einen lokalen Subduction-Server
// (Rust-Binary aus .cache/, siehe scripts/fetch-subduction.sh). Nur in Node.
// Erwartungen halten das heutige Verhalten fest (Plan E3a); Begründungen in
// src/candidates/keyhive-ark/NOTES.md.
//
// S6 und S6b hängen von der Zustellzeit des Servers ab, und der Stack gibt keine Zustellschranke zu (Review 23 B1/B2,
// Herleitung am Kandidaten). Nach der Regel (Anton 18.10.: bestanden nur, was in jedem Zweig hält) ist der Pin fest
// „nicht bestanden, abhängig von: Zustellzeit …“, unabhängig vom Glück des Laufs. Jeder der ARK_TIMING_RUNS Läufe wird
// streng geprüft (Review 23 B3): keine Ausnahme, Dave Mitglied. Die Verteilung steht nur in den Details.
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
    // ARKs Nudge öffnet die Historie, wenn der Server zustellt; wann, sagt nur die Verteilung.
    const window = (ARK_OBSERVATION_WINDOW_MS / 1000).toFixed(1).replace('.', '\\.')
    for (const id of timed) {
      const r = results.find((x) => x.scenario === id)!
      process.stderr.write(`${id}: ${r.outcome} | ${r.authority} | ${r.keys} | ${(r.ms / 1000).toFixed(1)} s\n`)
      expect(r.outcome, id).toBe('nicht bestanden')
      expect(r.authority, id).toMatch(
        new RegExp(`^abhängig von: Zustellzeit des Subduction-Servers; ${ARK_NO_BOUND.replace(/[()]/g, '\\$&')}; Verteilung: \\d+/${ARK_TIMING_RUNS} innerhalb des Beobachtungsfensters ${window} s \\(`),
      )
      expect(r.runs, id).toHaveLength(ARK_TIMING_RUNS)
      expect(runFaults(r.runs!, 'Dave Mitglied: ja'), `${id}: ${JSON.stringify(r.runs)}`).toEqual([])
    }
  }, 1_200_000)
})
