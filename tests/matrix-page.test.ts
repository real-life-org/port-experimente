import { describe, expect, it } from 'vitest'
import { buildMatrix, promises, type CandidateRun } from '../src/lab/matrix'
import { pageData, renderPage } from '../src/lab/matrix-page'
import { candidateEn, promiseEn, scenarioEn } from '../src/lab/matrix-en'
import { candidates } from '../src/candidates/index'
import { nodeCandidates } from '../src/candidates/node-only'
import { multiDeviceCandidates } from '../src/candidates/mehrgeraet'
import { scenarios } from '../src/lab/scenarios'
import { carrierScenarios } from '../src/lab/traeger'
import { x15 } from '../src/lab/mehrgeraet/scenarios'
import type { ScenarioResult } from '../src/lab/types'

// Die Seite public/matrix.html entsteht aus dem Report-Lauf (Anton, 17.10.: alle Ports, auch Zustellung und Mehrgerät).
// Sie darf nicht driften: jede Zusage, jedes Szenario und jeder Kandidat des Codes braucht seinen englischen Text.

const r = (scenario: string, outcome: ScenarioResult['outcome'], extra: Partial<ScenarioResult> = {}): ScenarioResult => ({ scenario, title: scenario, outcome, authority: 'a', keys: 'k', ms: 1, ...extra })

describe('Matrixseite aus dem Report', () => {
  it('jede Zusage, jedes Szenario und jeder Kandidat hat einen englischen Text', () => {
    for (const p of promises) expect(promiseEn[p.id], p.id).toBeDefined()
    for (const s of [...scenarios.map((s) => s.id), ...carrierScenarios.map((s) => s.id), ...x15.map((s) => s.id)]) expect(scenarioEn[s], s).toBeDefined()
    for (const c of [...candidates.map((c) => c.id), ...nodeCandidates.map((c) => c.id), ...multiDeviceCandidates.map((c) => c.id)]) expect(candidateEn[c], c).toBeDefined()
  })

  it('zwei Familien: Gruppen-Kandidaten in drei Ports, Mehrgeräte-Kandidaten im vierten; alle Zusagen, Marken erhalten', () => {
    const runs: CandidateRun[] = [
      { id: 'klartext', scenarios: [r('S1', 'bestanden'), r('S2', 'nicht bestanden')], carrier: [r('T1', 'bestanden')] },
      { id: 'k0-one-seed', scenarios: [], carrier: [r('X8', 'bestanden'), r('X7', 'nicht bestanden', { crashed: true }), r('X3', 'nicht bestanden', { promiseChanged: true })] },
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
    expect(mg.find((x) => x.id === 'MG7')!.cells['k0-one-seed']).toEqual({ status: 'not run', ev: [{ s: 'X7', o: 'nicht bestanden', c: true }] })
    expect(mg.find((x) => x.id === 'MG3')!.cells['k0-one-seed']).toEqual({ status: 'not kept', ev: [{ s: 'X3', o: 'nicht bestanden', p: true }] })
    expect(mg.find((x) => x.id === 'MG8')!.cells['k0-one-seed']!.status).toBe('kept')
    expect(mg.find((x) => x.id === 'MG10')!.cells['k0-one-seed']!.status).toBe('not run')
    expect(d.families[0]!.ports[2]!.rows.find((x) => x.id === 'I9')!.cells.klartext!.status).toBe('untested')
    expect(d.res.klartext!.S2).toEqual({ o: 'nicht bestanden', a: 'a', k: 'k', ms: '1.0 ms' })
    expect(d.scen.X7).toContain('A1 meets B1')
    const html = renderPage(d)
    expect(html).toContain('run of 17 October 2026')
    expect(html).toContain('Two tables: two candidate stacks as rows, 53 promises across four ports as columns.')
    expect(html).toContain('const D = {"at":')
    expect(html).not.toContain('__DATA__')
    expect(html).toContain('⚠ run crashed')
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
})
