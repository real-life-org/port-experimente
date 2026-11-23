import type { ScenarioResult } from '../lab/types'
import { runBaseline } from '../lab/alltag/baseline'
import { runLayer } from '../lab/alltag/layer-scenarios'

// The everyday multi-device candidates (src/lab/alltag): not candidate
// stacks of the model bench but the published library itself, as it is and
// under the layer prototype. They run the everyday scenarios (XA-…), which
// the matrix maps to the same multi-device promises as the X scenarios of
// the model.
const outcome = { green: 'bestanden', red: 'nicht bestanden', inexpressible: 'nicht abbildbar' } as const
const result = (id: string, title: string, status: keyof typeof outcome, note?: string): ScenarioResult =>
  ({ scenario: 'XA-' + id, title, outcome: outcome[status], authority: note ?? (status === 'green' ? 'holds' : ''), keys: '—', ms: 0 })

export const everydayScenarioIds = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'P1', 'P2', 'P3', 'N1', 'N2', 'N3', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'S1'].map((id) => 'XA-' + id)

export const everydayCandidates: Array<{ id: string; run: () => Promise<ScenarioResult[]> }> = [
  { id: 'lib-one-writer', run: async () => (await runBaseline()).map((r) => result(r.id, r.title, r.status, r.note)) },
  {
    id: 'layer-d-prototype',
    run: async () => {
      const titles = new Map((await runBaseline()).map((r) => [r.id, r.title]))
      return (await runLayer()).map((r) => result(r.id, titles.get(r.id) ?? r.id, r.status, r.note))
    },
  },
]
