import { describe, expect, it } from 'vitest'
import { runAll } from '../src/lab/scenarios'
import { keyhiveArk } from '../src/candidates/keyhive-ark'

// Keyhive, Lauf a: Automerge über ARK und einen lokalen Subduction-Server
// (Rust-Binary aus .cache/, siehe scripts/fetch-subduction.sh). Nur in Node.
// Erwartungen halten das heutige Verhalten fest (Plan E3a); Begründungen in
// src/candidates/keyhive-ark/NOTES.md.
describe('Kandidat Keyhive über ARK und Subduction', () => {
  it('Basislinie je Szenario', async () => {
    const results = await runAll(keyhiveArk)
    const byId: Record<string, string> = Object.fromEntries(results.map((r) => [r.scenario, r.outcome]))
    // S6 und S6b hängen auf dem CI-Runner vom Timing ab: In etwa 3 von 100
    // Läufen bekam Dave Alices Historie nicht innerhalb der Ruhefrist (S6:
    // liest {}, S6b: nur Bobs gleichzeitigen Eintrag, auch nach Alices neuem
    // Eintrag). Lokal nicht nachgestellt, auch nicht unter Last. Die Zelle
    // misst ARKs Lieferweg an Neue, nicht den Prüfstand; deshalb hier beide
    // Ausgänge, aber nur mit Dave als Mitglied und ohne Fehler (NOTES.md).
    for (const id of ['S6', 'S6b']) {
      const r = results.find((x) => x.scenario === id)!
      expect(['bestanden', 'nicht bestanden'], JSON.stringify(r)).toContain(r.outcome)
      expect(r.authority, JSON.stringify(r)).toBe('Dave Mitglied: ja')
      byId[id] = 'zeitabhängig'
    }
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
      S6: 'zeitabhängig', // meist bestanden: ARKs Nudge öffnet die Historie sofort
      S6b: 'zeitabhängig', // meist bestanden
      S7: 'nicht abbildbar', // Angreifer gegen Sedimentree-Blobs nicht verdrahtet
      S8: 'bestanden',
      S11: 'nicht abbildbar',
      S10a: 'nicht abbildbar',
      S10b: 'nicht abbildbar',
      S10c: 'nicht abbildbar',
    })
  }, 600_000)
})
