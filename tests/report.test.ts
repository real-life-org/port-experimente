import { it } from 'vitest'
import { runAll } from '../src/lab/scenarios'
import { allCandidates as candidates } from '../src/candidates/node-only'

// Gibt die Ergebnistabelle aller Kandidaten aus: REPORT=1 pnpm test report
it.runIf(process.env.REPORT)('Bericht', async () => {
  for (const c of candidates) {
    for (const r of await runAll(c.make)) {
      process.stdout.write([c.id, c.transport, r.scenario, r.outcome, r.authority, r.keys, `${r.ms.toFixed(1)} ms`].join(' | ') + '\n')
    }
  }
})
