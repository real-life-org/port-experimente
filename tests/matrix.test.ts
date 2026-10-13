import { describe, expect, it } from 'vitest'
import { buildMatrix, promises, toMarkdown, type CandidateRun } from '../src/lab/matrix'
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
    for (const s of ['S1', 'S2', 'S3', 'S4a', 'S4b', 'S4c', 'S4d', 'S4e', 'S4j', 'S4f', 'S5', 'S5b', 'S5c', 'S6', 'S6b', 'S7', 'S8', 'S10a', 'S10b', 'S10c', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T6b', 'T7', 'T8', 'T11', 'T12']) expect(covered.has(s), s).toBe(true)
  })

  it('eine Zelle ist nicht bestanden, sobald ein zugeordnetes Szenario scheitert; bestanden, wenn eines besteht und keines scheitert; sonst nicht abbildbar; ohne Szenario nicht geprüft', () => {
    const runs: CandidateRun[] = [
      { id: 'a', scenarios: [r('S2', 'bestanden'), r('S5c', 'nicht bestanden'), r('S5b', 'nicht abbildbar')], carrier: [r('T1', 'bestanden')] },
      { id: 'b', scenarios: [r('S2', 'bestanden'), r('S5c', 'nicht abbildbar'), r('S5b', 'nicht abbildbar')], carrier: [] },
    ]
    const m = buildMatrix(runs)
    const kv1 = m.ports.find((p) => p.port === 'schlüssel')!.rows.find((row) => row.promise.id === 'KV1')!
    expect(kv1.cells.a!.status).toBe('nicht bestanden')
    expect(kv1.cells.b!.status).toBe('bestanden')
    const i12 = m.ports.find((p) => p.port === 'replikation')!.rows.find((row) => row.promise.id === 'I12')!
    expect(i12.cells.a!.status).toBe('bestanden')
    expect(i12.cells.b!.status).toBe('nicht geprüft')
    const kv3 = m.ports.find((p) => p.port === 'schlüssel')!.rows.find((row) => row.promise.id === 'KV3')!
    expect(kv3.cells.a!.status).toBe('nicht geprüft')
    // Jede Zelle nennt ihre Belege mit Ergebnis.
    expect(kv1.cells.a!.evidence).toEqual([
      { scenario: 'S2', outcome: 'bestanden' },
      { scenario: 'S5b', outcome: 'nicht abbildbar' },
      { scenario: 'S5c', outcome: 'nicht bestanden' },
    ])
  })

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
