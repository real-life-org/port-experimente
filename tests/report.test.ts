import { it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { runAll } from '../src/lab/scenarios'
import { runCarrier } from '../src/lab/traeger'
import { buildMatrix, toMarkdown, type CandidateRun } from '../src/lab/matrix'
import { allCandidates as candidates } from '../src/candidates/node-only'

// Gibt die Ergebnistabelle aller Kandidaten und die Konformitätsmatrix aus:
//   REPORT=1 pnpm test report            (Tabelle auf stdout, Matrix nach matrix.md)
//   REPORT=1 MATRIX_OUT=pfad pnpm test report
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
  const md = toMarkdown(buildMatrix(runs))
  writeFileSync(process.env.MATRIX_OUT ?? 'matrix.md', md)
  process.stdout.write('\n' + md)
}, 3_600_000)
