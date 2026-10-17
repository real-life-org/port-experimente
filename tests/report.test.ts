import { it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { runAll } from '../src/lab/scenarios'
import { runCarrier } from '../src/lab/traeger'
import { buildMatrix, toMarkdown, type CandidateRun } from '../src/lab/matrix'
import { pageData, renderPage, updateFindingsSummary } from '../src/lab/matrix-page'
import { allCandidates as candidates } from '../src/candidates/node-only'
import { multiDeviceCandidates } from '../src/candidates/mehrgeraet'
import { runX15 } from '../src/lab/mehrgeraet/scenarios'

// Gibt die Ergebnistabelle aller Kandidaten und die Konformitätsmatrix aus:
//   REPORT=1 pnpm test report            (Tabelle auf stdout, Matrix nach matrix.md, Seite nach public/matrix.html)
//   REPORT=1 MATRIX_OUT=pfad PAGE_OUT=pfad pnpm test report
it.runIf(process.env.REPORT)('Bericht', async () => {
  const runs: CandidateRun[] = []
  for (const c of candidates) {
    const scenarios = await runAll(c.make)
    const carrier = await runCarrier(c.make)
    for (const r of [...scenarios, ...carrier]) {
      process.stdout.write([c.id, c.transport, r.scenario, r.outcome, r.authority, r.keys, `${r.ms.toFixed(1)} ms`].join(' | ') + '\n')
    }
    runs.push({ id: c.id, scenarios, carrier })
  }
  // E15: Mehrgeräte-Kandidaten laufen die X-Szenarien; seriell ist der Kontrolllauf, er steht nicht in der Matrix.
  for (const c of multiDeviceCandidates) {
    const xs = await runX15(c.make())
    for (const r of xs) process.stdout.write([c.id, 'mehrgerät', r.scenario, r.outcome, r.detail, JSON.stringify(r.measures)].join(' | ') + '\n')
    runs.push({ id: c.id, scenarios: [], carrier: xs.map((r) => ({ scenario: r.scenario, title: r.title, outcome: r.outcome, crashed: r.crashed, promiseChanged: r.promiseChanged, authority: r.detail, keys: JSON.stringify(r.measures), ms: 0 })) })
  }
  const matrix = buildMatrix(runs)
  const md = toMarkdown(matrix)
  writeFileSync(process.env.MATRIX_OUT ?? 'matrix.md', md)
  // Die Seite aus demselben Lauf (alle Ports, auch Zustellung und Mehrgerät); die englischen Texte in src/lab/matrix-en.ts.
  const page = pageData(matrix, runs, new Date().toISOString())
  writeFileSync(process.env.PAGE_OUT ?? 'public/matrix.html', renderPage(page))
  // Die Zusammenfassung der Befunde-Seite aus demselben Lauf (hash-abhängige Zellen wechseln von Lauf zu Lauf).
  const findings = process.env.FINDINGS_OUT ?? 'public/findings.html'
  writeFileSync(findings, updateFindingsSummary(readFileSync(findings, 'utf8'), page))
  process.stdout.write('\n' + md)
}, 3_600_000)
