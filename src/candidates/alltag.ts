import type { ScenarioResult } from '../lab/types'
import { runBaseline, type BaselineRow } from '../lab/alltag/baseline'
import { runLayer } from '../lab/alltag/layer-scenarios'

// The everyday multi-device candidates (src/lab/alltag): not candidate
// stacks of the model bench but the published library itself, as it is and
// under the layer prototype. They run the everyday scenarios (XA-…), which
// the matrix maps to the same multi-device promises as the X scenarios of
// the model.
const outcome = { green: 'bestanden', red: 'nicht bestanden', inexpressible: 'nicht abbildbar' } as const
const result = (id: string, title: string, status: keyof typeof outcome, note?: string): ScenarioResult =>
  ({ scenario: 'XA-' + id, title, outcome: outcome[status], authority: note ?? (status === 'green' ? 'holds' : ''), keys: '—', ms: 0 })

// A scenario with two observations enters the matrix as two (G2a, G2b), so each promise is judged by the observation that tests it.
const partTitle: Record<string, string> = {
  G2a: 'a new phone while the old one is still there: the new phone shows the same',
  G2b: 'A removes the old phone from the new one: the old one speaks to no friend any more',
  M8a: 'A removes the lost phone: A stays a member and reads on with the laptop',
  M8b: 'A removes the lost phone: the phone reads nothing new from G',
}
const rowsOf = (r: BaselineRow): ScenarioResult[] =>
  r.parts ? Object.entries(r.parts).map(([k, p]) => result(r.id + k, partTitle[r.id + k] ?? r.title, p.status, p.note)) : [result(r.id, r.title, r.status, r.note)]

export const everydayScenarioIds = ['G1', 'G2a', 'G2b', 'G3', 'G4', 'G5', 'G6', 'K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'P1', 'P2', 'P3', 'N1', 'N2', 'N3', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8a', 'M8b', 'S1'].map((id) => 'XA-' + id)

export const everydayCandidates: Array<{ id: string; run: () => Promise<ScenarioResult[]> }> = [
  { id: 'lib-one-writer', run: async () => (await runBaseline()).flatMap(rowsOf) },
  {
    id: 'layer-d-prototype',
    run: async () => {
      const titles = new Map((await runBaseline()).map((r) => [r.id, r.title]))
      return (await runLayer()).map((r) => result(r.id, titles.get(r.id) ?? r.id, r.status, r.note))
    },
  },
]
