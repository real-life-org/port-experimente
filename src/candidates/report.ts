import type { RunKind } from '../lab/matrix'
import type { CandidateFactory, ScenarioResult } from '../lab/types'

// The candidates of the report: id, family and a load function, nothing
// else. Importing this file loads no candidate. A candidate's code (its
// WebAssembly package, its server, the published library) is imported by
// `load`, after the report has selected it and inside its error handling:
// a candidate whose prerequisite is missing is recorded as not run, and
// every other candidate is measured without it. The assembly of the matrix
// reads this list for ids and families and never calls `load`.
//
// The options here repeat those of the browser registry (index.ts), which
// imports its candidates statically; tests/matrix-page.test.ts holds the
// ids and families of both against each other.

export type Measured = { scenarios: ScenarioResult[]; carrier: ScenarioResult[] }
export interface ReportCandidate {
  id: string
  kind: RunKind
  /** Imports the candidate and returns its measuring run. Throws when a prerequisite is missing. */
  load: () => Promise<() => Promise<Measured>>
}

const line = (...cells: unknown[]) => process.stdout.write(cells.join(' | ') + '\n')

/** A group candidate runs the S scenarios and the carrier scenarios. `factory` imports the candidate's module. */
const group = (id: string, factory: () => Promise<CandidateFactory>): ReportCandidate => ({
  id,
  kind: 'group',
  load: async () => {
    const make = await factory()
    const { runAll } = await import('../lab/scenarios')
    const { runCarrier } = await import('../lab/traeger')
    return async () => {
      const scenarios = await runAll(make)
      const carrier = await runCarrier(make)
      for (const r of [...scenarios, ...carrier]) line(id, r.scenario, r.outcome, r.authority, r.keys, `${r.ms.toFixed(1)} ms`)
      return { scenarios, carrier }
    }
  },
})

/** E15: a multi-device candidate of the model runs the X scenarios. */
const multiDevice = (id: string): ReportCandidate => ({
  id,
  kind: 'multidevice',
  load: async () => {
    const { multiDeviceCandidates } = await import('./mehrgeraet')
    const { runX15 } = await import('../lab/mehrgeraet/scenarios')
    const c = multiDeviceCandidates.find((x) => x.id === id)
    if (!c) throw new Error(`no multi-device candidate ${id}`)
    return async () => {
      const xs = await runX15(c.make())
      for (const r of xs) line(id, 'mehrgerät', r.scenario, r.outcome, r.detail, JSON.stringify(r.measures))
      return { scenarios: [], carrier: xs.map((r) => ({ scenario: r.scenario, title: r.title, outcome: r.outcome, crashed: r.crashed, promiseChanged: r.promiseChanged, authority: r.detail, keys: JSON.stringify(r.measures), ms: 0 })) }
    }
  },
})

/** Everyday multi-device: the published library as it is and under the layer prototype; scenarios XA-…. */
const everyday = (id: string): ReportCandidate => ({
  id,
  kind: 'everyday',
  load: async () => {
    const { everydayCandidates } = await import('./alltag')
    const c = everydayCandidates.find((x) => x.id === id)
    if (!c) throw new Error(`no everyday candidate ${id}`)
    return async () => {
      const xs = await c.run()
      for (const r of xs) line(id, 'alltag', r.scenario, r.outcome, r.authority)
      return { scenarios: [], carrier: xs }
    }
  },
})

const beekem = async () => (await import('./rltp-beekem')).rltpBeekem
const mls = async () => (await import('./consensual-mls')).consensualMls

export const reportCandidates: readonly ReportCandidate[] = [
  group('gen2', async () => (await import('./gen2')).gen2),
  group('p2panda', async () => (await import('./p2panda')).p2panda),
  group('keyhive', async () => (await import('./keyhive')).keyhive),
  group('rltp-beekem', async () => { const f = await beekem(); return () => f() }),
  group('rltp-beekem-sichten', async () => { const f = await beekem(); return () => f({ dienst: 'sichten' }) }),
  group('rltp-mls', async () => { const f = await beekem(); return () => f({ keyPort: 'mls' }) }),
  group('rltp-mls-sichten', async () => { const f = await beekem(); return () => f({ keyPort: 'mls', dienst: 'sichten' }) }),
  group('consensual-mls-any-staged', async () => { const f = await mls(); return () => f({ committer: 'any-staged' }) }),
  group('consensual-mls-owner', async () => { const f = await mls(); return () => f({ committer: 'owner' }) }),
  group('rltp-beekem-logreplik', async () => { const f = await beekem(); return () => f({ dienst: 'logreplik' }) }),
  group('klartext', async () => (await import('./klartext')).klartext),
  group('keyhive-ark', async () => { const m = await import('./keyhive-ark'); return () => m.keyhiveArk() }),
  group('rltp-beekem-pws', async () => { const m = await import('./pws'); return () => m.rltpBeekemPws() }),
  group('rltp-beekem-datarooms', async () => { const m = await import('./datarooms'); return () => m.rltpBeekemDatarooms() }),
  multiDevice('k0-one-seed'),
  multiDevice('k1a-static'),
  multiDevice('k1a-journal-service'),
  multiDevice('k2-device-keys'),
  everyday('lib-one-writer'),
  everyday('layer-d-prototype'),
]
