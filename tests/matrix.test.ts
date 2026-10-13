import { describe, expect, it } from 'vitest'
import { buildMatrix, promises, toMarkdown, type CandidateRun } from '../src/lab/matrix'
import { runScenario, scenarios } from '../src/lab/scenarios'
import { klartext } from '../src/candidates/klartext'
import type { ScenarioResult } from '../src/lab/types'

// Konformitätsmatrix (Plan: „Träger-Prüfstand und Konformitätsmatrix“): je
// Port Zusage × Kandidat, jede Zelle aus ausgeführten Szenarien.
const r = (scenario: string, outcome: ScenarioResult['outcome']): ScenarioResult => ({ scenario, title: scenario, outcome, authority: '', keys: '', ms: 1 })

describe('Konformitätsmatrix', () => {
  it('jede Zusage nennt ihren Port, ihre Quelle und die Szenarien, die sie prüfen; jedes Szenario des Katalogs ist zugeordnet', () => {
    const ids = new Set(promises.map((p) => p.id))
    expect(ids.size).toBe(promises.length)
    for (const p of promises) expect(p.ref.length, p.id).toBeGreaterThan(0)
    const covered = new Set(promises.flatMap((p) => p.scenarios))
    for (const s of ['S1', 'S2', 'S3', 'S4a', 'S4b', 'S4c', 'S4c2', 'S4d', 'S4e', 'S4j', 'S4f', 'S5', 'S5b', 'S5c', 'S6', 'S6b', 'S7', 'S8', 'S10a', 'S10b', 'S10c', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T6b', 'T7', 'T8', 'T11', 'T12']) expect(covered.has(s), s).toBe(true)
  })

  it('eine Zusage gilt nur, wenn jedes zugeordnete Szenario besteht; ein Teil macht sie teilweise, ein Scheitern nicht bestanden', () => {
    const runs: CandidateRun[] = [
      { id: 'a', scenarios: [r('S2', 'bestanden'), r('S5c', 'nicht bestanden'), r('S5b', 'nicht abbildbar')], carrier: [r('T1', 'bestanden')] },
      { id: 'b', scenarios: [r('S2', 'bestanden'), r('S5c', 'nicht abbildbar'), r('S5b', 'nicht abbildbar')], carrier: [] },
      { id: 'c', scenarios: [r('S2', 'bestanden'), r('S5c', 'bestanden'), r('S5b', 'bestanden')], carrier: [] },
      { id: 'd', scenarios: [r('S5', 'bestanden'), r('S5b', 'nicht abbildbar'), r('S5c', 'nicht abbildbar')], carrier: [] },
    ]
    const m = buildMatrix(runs)
    const row = (port: 'schlüssel' | 'replikation', id: string) => m.ports.find((p) => p.port === port)!.rows.find((x) => x.promise.id === id)!
    expect(row('schlüssel', 'KV1').cells.a!.status).toBe('nicht bestanden')
    expect(row('schlüssel', 'KV1').cells.b!.status).toBe('teilweise') // S2 besteht, Geräte nicht abbildbar
    expect(row('schlüssel', 'KV1').cells.c!.status).toBe('bestanden')
    // Review zu #35: K7 verspricht Zweitgerät und Widerruf und Entfernung aller Geräte; nur S5 reicht nicht.
    expect(row('schlüssel', 'K7').cells.d!.status).toBe('teilweise')
    expect(row('replikation', 'I12').cells.a!.status).toBe('bestanden')
    expect(row('replikation', 'I12').cells.b!.status).toBe('nicht geprüft')
    expect(row('schlüssel', 'KV3').cells.a!.status).toBe('nicht geprüft')
    // Jede Zelle nennt alle Belege, auch nicht gelaufene.
    expect(row('schlüssel', 'KV1').cells.a!.evidence).toEqual([
      { scenario: 'S2', outcome: 'bestanden' },
      { scenario: 'S5b', outcome: 'nicht abbildbar' },
      { scenario: 'S5c', outcome: 'nicht bestanden' },
    ])
    expect(row('schlüssel', 'K7').cells.a!.evidence[0]).toEqual({ scenario: 'S5', outcome: 'nicht gelaufen' })
  })

  it('A4 (beide draußen) fällt, wenn Entfernen nichts tut: das Szenario prüft das Soll, nicht nur Einigkeit (Review zu #35)', async () => {
    const noRemoval = () => {
      const c = klartext()
      return { ...c, removeMember: async () => {} }
    }
    const s4c2 = scenarios.find((s) => s.id === 'S4c2')!
    const s4c = scenarios.find((s) => s.id === 'S4c')!
    const results = [await runScenario(noRemoval, s4c), await runScenario(noRemoval, s4c2)]
    expect(results[0]!.outcome).toBe('bestanden') // Einigkeit allein hält auch ohne Entfernung
    expect(results[1]!.outcome).toBe('nicht bestanden')
    const m = buildMatrix([{ id: 'x', scenarios: results, carrier: [] }])
    const a4 = m.ports.find((p) => p.port === 'autorität')!.rows.find((x) => x.promise.id === 'A4')!
    expect(a4.cells.x!.status).toBe('nicht bestanden')
    const kv2 = m.ports.find((p) => p.port === 'schlüssel')!.rows.find((x) => x.promise.id === 'KV2')!
    expect(kv2.cells.x!.status).toBe('nicht bestanden')
  }, 60_000)

  it('Markdown: eine Tabelle je Port, Kandidaten als Spalten, Belege in der Zelle', () => {
    const runs: CandidateRun[] = [{ id: 'a', scenarios: [r('S1', 'bestanden')], carrier: [] }]
    const md = toMarkdown(buildMatrix(runs))
    expect(md).toContain('## Autoritäts-Port')
    expect(md).toContain('## Schlüssel-Port')
    expect(md).toContain('## Replikations-Port')
    expect(md).toContain('| a |')
    expect(md).toMatch(/\| A1 [^|]*\| ✓ S1 \|/)
  })
})
