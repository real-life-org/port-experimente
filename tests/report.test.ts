import { it } from 'vitest'
import { runAll } from '../src/lab/scenarios'
import { runCarrier } from '../src/lab/traeger'
import type { RunKind } from '../src/lab/matrix'
import { reason, writeResult } from '../src/lab/report-files'
import type { ScenarioResult } from '../src/lab/types'
import { allCandidates as candidates } from '../src/candidates/node-only'
import { multiDeviceCandidates } from '../src/candidates/mehrgeraet'
import { runX15 } from '../src/lab/mehrgeraet/scenarios'
import { everydayCandidates } from '../src/candidates/alltag'

// Misst die Kandidaten und schreibt je Kandidat eine Ergebnisdatei nach results/<id>.json:
//   REPORT=1 pnpm vitest run report                      (alle Kandidaten)
//   REPORT=1 REPORT_ONLY=keyhive,gen2 pnpm vitest run report   (nur diese; die anderen Dateien bleiben)
// Die Matrix und ihre Seite entstehen danach aus den Dateien: pnpm matrix.
// Kann ein Kandidat hier nicht laufen (kein lokaler Stack, kein Server-Binary), steht das mit dem Grund in seiner
// Datei, und der Bericht läuft weiter. Eine vorhandene Messung ersetzt er dabei nicht: REPORT_OVERWRITE=1 erzwingt es.
type Entry = { id: string; kind: RunKind; run: () => Promise<{ scenarios: ScenarioResult[]; carrier: ScenarioResult[] }> }

const entries: Entry[] = [
  ...candidates.map((c): Entry => ({
    id: c.id,
    kind: 'group',
    run: async () => {
      const scenarios = await runAll(c.make)
      const carrier = await runCarrier(c.make)
      for (const r of [...scenarios, ...carrier]) process.stdout.write([c.id, c.transport, r.scenario, r.outcome, r.authority, r.keys, `${r.ms.toFixed(1)} ms`].join(' | ') + '\n')
      return { scenarios, carrier }
    },
  })),
  // E15: Mehrgeräte-Kandidaten laufen die X-Szenarien; seriell ist der Kontrolllauf, er steht nicht in der Matrix.
  ...multiDeviceCandidates.map((c): Entry => ({
    id: c.id,
    kind: 'multidevice',
    run: async () => {
      const xs = await runX15(c.make())
      for (const r of xs) process.stdout.write([c.id, 'mehrgerät', r.scenario, r.outcome, r.detail, JSON.stringify(r.measures)].join(' | ') + '\n')
      return { scenarios: [], carrier: xs.map((r) => ({ scenario: r.scenario, title: r.title, outcome: r.outcome, crashed: r.crashed, promiseChanged: r.promiseChanged, authority: r.detail, keys: JSON.stringify(r.measures), ms: 0 })) }
    },
  })),
  // Mehrgerät im Alltag: die veröffentlichte Bibliothek, wie sie ist, und unter dem Schicht-Prototyp; Alltagsszenarien XA-….
  ...everydayCandidates.map((c): Entry => ({
    id: c.id,
    kind: 'everyday',
    run: async () => {
      const xs = await c.run()
      for (const r of xs) process.stdout.write([c.id, 'alltag', r.scenario, r.outcome, r.authority].join(' | ') + '\n')
      return { scenarios: [], carrier: xs }
    },
  })),
]

it.runIf(process.env.REPORT)('Bericht', async () => {
  const only = new Set((process.env.REPORT_ONLY ?? '').split(',').filter(Boolean))
  const unknown = [...only].filter((id) => !entries.some((e) => e.id === id))
  if (unknown.length) throw new Error(`REPORT_ONLY nennt unbekannte Kandidaten: ${unknown.join(', ')}`)
  const notRun: string[] = []
  for (const e of entries) {
    if (only.size && !only.has(e.id)) continue
    const at = new Date().toISOString()
    try {
      writeResult({ id: e.id, kind: e.kind, at, ...(await e.run()) })
    } catch (err) {
      const why = reason(err)
      notRun.push(`${e.id}: ${why}`)
      process.stdout.write(`${e.id} | nicht gelaufen | ${why}\n`)
      writeResult({ id: e.id, kind: e.kind, at, notRun: why, scenarios: [], carrier: [] }, undefined, { keepMeasured: !process.env.REPORT_OVERWRITE })
    }
  }
  if (notRun.length) process.stdout.write(`\nnicht gelaufen (${notRun.length}):\n  ${notRun.join('\n  ')}\n`)
}, 3_600_000)
