import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { measure, writeResult, type ResultFile } from '../src/lab/report-files'
import { reportCandidates } from '../src/candidates/report'
import type { ScenarioResult } from '../src/lab/types'

// Review of #103: a candidate is loaded only when selected and measured on its own.
// p2panda's module cannot be loaded here, as in a checkout without the generated WebAssembly packages.
vi.mock('../src/candidates/p2panda', () => { throw new Error("Cannot find module './pkg/p2panda_wasm.js'") })

const tmp = () => pathToFileURL(mkdtempSync(join(tmpdir(), 'results-')) + '/')
const read = (dir: URL, id: string) => JSON.parse(readFileSync(new URL(`${id}.json`, dir), 'utf8')) as ResultFile
const r = (scenario: string): ScenarioResult => ({ scenario, title: scenario, outcome: 'bestanden', authority: 'a', keys: 'k', ms: 1 })

describe('Bericht: jeder Kandidat für sich', () => {
  it('ein unabhängiger Kandidat läuft allein, ohne dass ein anderer geladen wird', async () => {
    const dir = tmp()
    expect(await measure(reportCandidates, { only: ['klartext'], dir })).toEqual([])
    const k = read(dir, 'klartext')
    expect(k.notRun).toBeUndefined()
    expect(k.scenarios.length).toBeGreaterThan(10)
    expect(k.scenarios.find((s) => s.scenario === 'S1')!.outcome).toBe('bestanden')
  }, 300_000)

  it('Klartext und p2panda gemeinsam ausgewählt, p2panda lädt nicht: Klartext ist gemessen, der Ausfall steht allein bei p2panda; eine vorhandene Messung bleibt', async () => {
    const dir = tmp()
    writeResult({ id: 'p2panda', kind: 'group', at: '2026-10-20T00:00:00.000Z', scenarios: [r('S1')], carrier: [] }, dir)
    const notRun = await measure(reportCandidates, { only: ['p2panda', 'klartext'], dir })
    expect(notRun.map((x) => x.id)).toEqual(['p2panda'])
    expect(notRun[0]!.why).not.toBe('')
    expect(read(dir, 'klartext').notRun).toBeUndefined()
    expect(read(dir, 'klartext').scenarios.length).toBeGreaterThan(10)
    // Die Messung von p2panda von einer anderen Maschine bleibt stehen …
    expect(read(dir, 'p2panda')).toMatchObject({ at: '2026-10-20T00:00:00.000Z', scenarios: [{ scenario: 'S1' }] })
    // … ohne eine solche steht der Grund in der Datei.
    const fresh = tmp()
    await measure(reportCandidates, { only: ['p2panda'], dir: fresh })
    expect(read(fresh, 'p2panda')).toMatchObject({ kind: 'group', scenarios: [], carrier: [] })
    expect(read(fresh, 'p2panda').notRun).toBe(notRun[0]!.why)
  }, 300_000)

  it('ein Kandidat, der beim Laufen scheitert, hält die folgenden nicht auf; unbekannte Auswahl bricht ab', async () => {
    const dir = tmp()
    const list = [
      { id: 'gen2', kind: 'group' as const, load: async () => async () => { throw new Error('relay down\nstack') } },
      { id: 'klartext', kind: 'group' as const, load: async () => async () => ({ scenarios: [r('S1')], carrier: [] }) },
    ]
    expect(await measure(list, { dir })).toEqual([{ id: 'gen2', why: 'relay down' }])
    expect(read(dir, 'gen2').notRun).toBe('relay down')
    expect(read(dir, 'klartext').scenarios).toHaveLength(1)
    await expect(measure(list, { dir, only: ['nope'] })).rejects.toThrow(/unknown candidates selected: nope/)
  })
})
