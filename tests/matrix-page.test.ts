import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildMatrix, promises, type CandidateRun } from '../src/lab/matrix'
import { pageData, renderPage, summaryCounts, updateFindingsSummary } from '../src/lab/matrix-page'
import { assemble, readRuns, writeResult } from '../src/lab/report-files'
import { reportCandidates as knownCandidates } from '../src/candidates/report'
import { candidateEn, promiseEn, scenarioEn } from '../src/lab/matrix-en'
import { candidates } from '../src/candidates/index'
import { nodeCandidates } from '../src/candidates/node-only'
import { multiDeviceCandidates } from '../src/candidates/mehrgeraet'
import { everydayCandidates, everydayScenarioIds } from '../src/candidates/alltag'
import { scenarios } from '../src/lab/scenarios'
import { carrierScenarios } from '../src/lab/traeger'
import { x15 } from '../src/lab/mehrgeraet/scenarios'
import type { ScenarioResult } from '../src/lab/types'

// Die Seite public/matrix.html entsteht aus den Ergebnisdateien des Reports (Anton, 17.10.: alle Ports, auch Zustellung und Mehrgerät).
// Sie darf nicht driften: jede Zusage, jedes Szenario und jeder Kandidat des Codes braucht seinen englischen Text.

const r = (scenario: string, outcome: ScenarioResult['outcome'], extra: Partial<ScenarioResult> = {}): ScenarioResult => ({ scenario, title: scenario, outcome, authority: 'a', keys: 'k', ms: 1, ...extra })

describe('Matrixseite aus dem Report', () => {
  it('jede Zusage, jedes Szenario und jeder Kandidat hat einen englischen Text', () => {
    for (const p of promises) expect(promiseEn[p.id], p.id).toBeDefined()
    for (const s of [...scenarios.map((s) => s.id), ...carrierScenarios.map((s) => s.id), ...x15.map((s) => s.id), ...everydayScenarioIds]) expect(scenarioEn[s], s).toBeDefined()
    for (const c of [...candidates.map((c) => c.id), ...nodeCandidates.map((c) => c.id), ...multiDeviceCandidates.map((c) => c.id), ...everydayCandidates.map((c) => c.id)]) expect(candidateEn[c], c).toBeDefined()
  })

  it('die Liste des Berichts (report.ts) nennt genau die Kandidaten des Berichts, je mit ihrer Familie', () => {
    const fromCode = [
      ...[...candidates.filter((c) => c.make).map((c) => c.id), ...nodeCandidates.map((c) => c.id)].map((id) => `${id}:group`),
      ...multiDeviceCandidates.map((c) => `${c.id}:multidevice`),
      ...everydayCandidates.map((c) => `${c.id}:everyday`),
    ]
    expect(knownCandidates.map((c) => `${c.id}:${c.kind}`).sort()).toEqual([...new Set(fromCode)].sort())
  })

  it('ein Kandidat ohne Lauf steht mit Grund in seiner Familie, alle Zellen „not run“; die Seite trägt das Datum des jüngsten Laufs', () => {
    const runs: CandidateRun[] = [
      { id: 'klartext', kind: 'group', at: '2026-10-17T12:00:00.000Z', scenarios: [r('S1', 'bestanden')], carrier: [] },
      { id: 'rltp-beekem-datarooms', kind: 'group', at: '2026-11-23T09:00:00.000Z', notRun: 'no local stack', scenarios: [], carrier: [] },
      { id: 'layer-d-prototype', kind: 'everyday', scenarios: [], carrier: [], notRun: 'no result file results/layer-d-prototype.json' },
    ]
    const { page } = assemble(runs)
    expect(page.at).toBe('2026-11-23T09:00:00.000Z')
    expect(page.families[0]!.cands).toEqual(['klartext', 'rltp-beekem-datarooms'])
    expect(page.families[1]!.cands).toEqual(['layer-d-prototype'])
    expect(page.cands.find((c) => c.id === 'rltp-beekem-datarooms')).toMatchObject({ notRun: 'no local stack', at: '2026-11-23T09:00:00.000Z' })
    const a1 = page.families[0]!.ports[0]!.rows.find((x) => x.id === 'A1')!
    expect(a1.cells['rltp-beekem-datarooms']).toEqual({ status: 'not run', ev: [{ s: 'S1', o: 'nicht gelaufen' }] })
    expect(a1.cells.klartext!.status).toBe('kept')
    // Der Alltags-Kandidat ohne Datei behält seine Alltagsszenarien, obwohl sein Lauf keine Ergebnisse hat.
    const mg13 = page.families[1]!.ports[0]!.rows.find((x) => x.id === 'MG13')!
    expect(mg13.cells['layer-d-prototype']!.status).toBe('not run')
    expect(mg13.cells['layer-d-prototype']!.ev.map((e) => e.s)).toEqual(['XA-N1', 'XA-N2', 'XA-N3'])
    expect(summaryCounts(page).get('rltp-beekem-datarooms')!.kept).toBe(0)
  })

  it('zwei Familien: Gruppen-Kandidaten in drei Ports, Mehrgeräte-Kandidaten im vierten; alle Zusagen, Marken erhalten', () => {
    const runs: CandidateRun[] = [
      { id: 'klartext', scenarios: [r('S1', 'bestanden'), r('S2', 'nicht bestanden')], carrier: [r('T1', 'bestanden')] },
      { id: 'k0-one-seed', scenarios: [], carrier: [r('X8', 'bestanden'), r('X5', 'nicht bestanden', { crashed: true }), r('X12', 'nicht bestanden', { promiseChanged: true })] },
    ]
    const d = pageData(buildMatrix(runs), runs, '2026-10-17T12:00:00.000Z')
    expect(d.families.map((f) => f.id)).toEqual(['group', 'multidevice'])
    expect(d.families[0]!.cands).toEqual(['klartext'])
    expect(d.families[1]!.cands).toEqual(['k0-one-seed'])
    expect(d.families[0]!.ports.map((p) => p.id)).toEqual(['authority', 'key', 'replication'])
    expect(d.families[1]!.ports.map((p) => p.id)).toEqual(['multidevice'])
    const all = d.families.flatMap((f) => f.ports.flatMap((p) => p.rows.map((x) => x.id)))
    expect(all.sort()).toEqual(promises.map((p) => p.id).sort())
    const mg = d.families[1]!.ports[0]!.rows
    expect(mg.find((x) => x.id === 'MG5')!.cells['k0-one-seed']).toEqual({ status: 'not run', ev: [{ s: 'X5', o: 'nicht bestanden', c: true }] })
    expect(mg.find((x) => x.id === 'MG12')!.cells['k0-one-seed']).toEqual({ status: 'not kept', ev: [{ s: 'X12', o: 'nicht bestanden', p: true }] })
    expect(mg.find((x) => x.id === 'MG8')!.cells['k0-one-seed']!.status).toBe('kept')
    expect(mg.find((x) => x.id === 'MG10')!.cells['k0-one-seed']!.status).toBe('not run')
    expect(d.families[0]!.ports[2]!.rows.find((x) => x.id === 'I9')!.cells.klartext!.status).toBe('untested')
    expect(d.res.klartext!.S2).toEqual({ o: 'nicht bestanden', a: 'a', k: 'k', ms: '1.0 ms' })
    expect(d.scen.X5).toContain('A1 ends the relationship with B')
    const html = renderPage(d)
    expect(html).toContain('latest run 17 October 2026')
    expect(html).toContain('Two tables: two candidate stacks as rows, 62 promises across four ports as columns.')
    expect(html).toContain('const D = {"at":')
    expect(html).not.toContain('__DATA__')
    expect(html).toContain('⚠ run crashed')
  })

  it('Ergebnisdateien: je Kandidat eine Datei; eine fehlende zeigt sich als nicht gelaufen; ein gescheiterter Lauf ersetzt keine Messung', () => {
    const dir = pathToFileURL(mkdtempSync(join(tmpdir(), 'results-')) + '/')
    const known = [{ id: 'klartext', kind: 'group' as const }, { id: 'gen2', kind: 'group' as const }]
    writeResult({ id: 'klartext', kind: 'group', at: '2026-10-17T12:00:00.000Z', scenarios: [r('S1', 'bestanden', { ms: 1.2345 })], carrier: [] }, dir)
    let runs = readRuns(known, dir)
    expect(runs.map((x) => x.id)).toEqual(['gen2', 'klartext']) // Reihenfolge der Seite, nicht der Liste
    expect(runs[0]).toMatchObject({ kind: 'group', notRun: 'no result file results/gen2.json', scenarios: [] })
    expect(runs[1]!.scenarios[0]!.ms).toBe(1.2)
    // Ein Lauf, der hier scheitert, lässt die Messung stehen …
    expect(writeResult({ id: 'klartext', kind: 'group', at: '2026-11-23T09:00:00.000Z', notRun: 'kein Stack', scenarios: [], carrier: [] }, dir, { keepMeasured: true })).toBe(false)
    expect(readRuns(known, dir)[1]!.notRun).toBeUndefined()
    // … schreibt aber, wo es noch keine gibt, und eine neue Messung ersetzt den Vermerk.
    expect(writeResult({ id: 'gen2', kind: 'group', at: '2026-11-23T09:00:00.000Z', notRun: 'kein Stack', scenarios: [], carrier: [] }, dir, { keepMeasured: true })).toBe(true)
    expect(readRuns(known, dir)[0]!.notRun).toBe('kein Stack')
    writeResult({ id: 'gen2', kind: 'group', at: '2026-11-23T10:00:00.000Z', scenarios: [r('S1', 'bestanden')], carrier: [] }, dir)
    runs = readRuns(known, dir)
    expect(runs[0]!.notRun).toBeUndefined()
    // Eine Datei unter falschem Namen oder mit falscher Familie bricht ab.
    expect(() => readRuns([{ id: 'gen2', kind: 'multidevice' }], dir)).toThrow(/kind group/)
  })

  it('Messausgaben kommen unverändert in die Seite, auch mit $& und </script> (Issue #62)', () => {
    const runs: CandidateRun[] = [{ id: 'klartext', scenarios: [r('S1', 'bestanden', { authority: 'Ausgabe mit $& und $1 und $$', keys: 'ein </script><script>alert(1)</script> im Text' })], carrier: [] }]
    const d = pageData(buildMatrix(runs), runs, '2026-10-17T12:00:00.000Z')
    const html = renderPage(d)
    expect(html).toContain('Ausgabe mit $& und $1 und $$')
    expect(html.split('</script>').length).toBe(2) // genau das eine Skriptende der Seite
    const embedded = /const D = (.*?);\n/.exec(html)![1]!
    expect(JSON.parse(embedded)).toEqual(d) // die eingebetteten Daten sind die Daten, nur anders geschrieben
  })

  it('ein Lauf mit einem Kandidaten oder Szenario ohne englischen Text bricht ab, statt eine lückenhafte Seite zu schreiben', () => {
    const runs: CandidateRun[] = [{ id: 'neu', scenarios: [r('S1', 'bestanden')], carrier: [] }]
    expect(() => pageData(buildMatrix(runs), runs, '2026-10-17T12:00:00.000Z')).toThrow(/candidate neu/)
    const runs2: CandidateRun[] = [{ id: 'klartext', scenarios: [r('S99', 'bestanden')], carrier: [] }]
    expect(() => pageData(buildMatrix(runs2), runs2, '2026-10-17T12:00:00.000Z')).toThrow(/scenario S99/)
  })

  it('die Zusammenfassung der Befunde-Seite kommt aus demselben Lauf; Kandidaten mit verschiedenen Zahlen bekommen eigene Zeilen', () => {
    const runs: CandidateRun[] = [
      { id: 'consensual-mls-any-staged', scenarios: [r('S1', 'bestanden'), r('S4f', 'bestanden')], carrier: [] },
      { id: 'consensual-mls-owner', scenarios: [r('S1', 'bestanden'), r('S4f', 'nicht bestanden')], carrier: [] },
      { id: 'klartext', scenarios: [r('S1', 'bestanden')], carrier: [] },
    ]
    const d = pageData(buildMatrix(runs), runs, '2026-10-17T12:00:00.000Z')
    const html = '<table>\n  <tr data-cand="consensual-mls-any-staged consensual-mls-owner"><td>MLS room (two modes)</td><td class="num ok">14</td><td class="num part">0</td><td class="num no">9</td><td class="num na">8</td></tr>\n  <tr data-cand="klartext"><td>Plaintext</td><td class="num ok">0</td><td class="num part">0</td><td class="num no">0</td><td class="num na">0</td></tr>\n</table>'
    const out = updateFindingsSummary(html, d)
    expect(out).toContain('<tr data-cand="consensual-mls-any-staged"><td>MLS room, any-staged</td>')
    expect(out).toContain('<tr data-cand="consensual-mls-owner"><td>MLS room, owner</td>')
    expect(out).not.toContain('MLS room (two modes)')
    const kl = /<tr data-cand="klartext"><td>Plaintext<\/td><td class="num ok">(\d+)<\/td><td class="num part">(\d+)<\/td><td class="num no">(\d+)<\/td><td class="num na">(\d+)<\/td>/.exec(out)!
    expect(kl.slice(1).map(Number)).toEqual([1, 0, 0, 30]) // S1 → A1 kept; 30 Zusagen mit Szenario nicht gelaufen, die 10 ohne Szenario zählen nicht
  })
})
