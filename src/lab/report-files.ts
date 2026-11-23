// Result files of the report: one file per candidate under results/, written
// by the report run (tests/report.test.ts) and read back to assemble the
// matrix and its page (tests/matrix-assemble.test.ts, `pnpm matrix`).
//
// A candidate is re-measured alone (REPORT_ONLY=<id>); the others keep their
// file. A candidate that cannot run where the report runs (no local stack,
// no server binary) gets a file that says so, with the reason, and shows on
// the page as not run. The page itself is build output, not a committed file.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { buildMatrix, type CandidateRun, type Matrix, type RunKind } from './matrix'
import { candidateEn } from './matrix-en'
import { pageData, type PageData } from './matrix-page'
import type { ScenarioResult } from './types'

export const resultsDir = new URL('../../results/', import.meta.url)

export interface ResultFile {
  id: string
  kind: RunKind
  /** When this candidate ran (ISO). */
  at: string
  /** Set when the candidate could not run: the reason. */
  notRun?: string
  scenarios: ScenarioResult[]
  carrier: ScenarioResult[]
}

const fileOf = (dir: URL, id: string) => new URL(`${id}.json`, dir)

/** Timings are rounded to a tenth of a millisecond so a re-run changes fewer lines. */
const rounded = (r: ScenarioResult): ScenarioResult => ({ ...r, ms: Math.round(r.ms * 10) / 10 })

/**
 * Writes the file of one candidate. With `keepMeasured`, a file that holds a
 * measurement is left alone: a run that failed on this machine does not
 * replace what another machine measured. Returns whether it wrote.
 */
export function writeResult(file: ResultFile, dir: URL = resultsDir, opts: { keepMeasured?: boolean } = {}): boolean {
  mkdirSync(dir, { recursive: true })
  if (opts.keepMeasured && existsSync(fileOf(dir, file.id)) && !(JSON.parse(readFileSync(fileOf(dir, file.id), 'utf8')) as ResultFile).notRun) return false
  const out: ResultFile = { ...file, scenarios: file.scenarios.map(rounded), carrier: file.carrier.map(rounded) }
  writeFileSync(fileOf(dir, file.id), JSON.stringify(out, null, 1) + '\n')
  return true
}

/** The first line of an error, as the reason a candidate did not run; paths of this machine are cut to the checkout. */
export const reason = (e: unknown): string => String(e instanceof Error ? e.message : e).split('\n')[0]!.split(process.cwd() + '/').join('').slice(0, 300)

/**
 * The runs of all known candidates, in the order of the page (the order of
 * `candidateEn`). A candidate without a result file is in the list as not
 * run, so a missing file shows on the page instead of dropping a row.
 */
export function readRuns(known: ReadonlyArray<{ id: string; kind: RunKind }>, dir: URL = resultsDir): CandidateRun[] {
  const order = Object.keys(candidateEn)
  const rank = (id: string) => { const i = order.indexOf(id); return i < 0 ? order.length : i }
  return [...known].sort((a, b) => rank(a.id) - rank(b.id)).map(({ id, kind }) => {
    const f = fileOf(dir, id)
    if (!existsSync(f)) return { id, kind, scenarios: [], carrier: [], notRun: `no result file results/${id}.json` }
    const r = JSON.parse(readFileSync(f, 'utf8')) as ResultFile
    if (r.id !== id) throw new Error(`results/${id}.json names candidate ${r.id}`)
    if (r.kind !== kind) throw new Error(`results/${id}.json has kind ${r.kind}, the candidate list says ${kind}`)
    return r
  })
}

/** Matrix and page data from the runs. The page date is the latest run. */
export function assemble(runs: readonly CandidateRun[]): { matrix: Matrix; page: PageData } {
  const matrix = buildMatrix(runs)
  const at = runs.map((r) => r.at).filter((x): x is string => !!x).sort().at(-1) ?? new Date(0).toISOString()
  return { matrix, page: pageData(matrix, runs, at) }
}
