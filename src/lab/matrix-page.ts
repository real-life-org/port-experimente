// The matrix page (public/matrix.html) from a report run: the same matrix as
// matrix.md, in English, as one table per candidate family (group
// candidates in the three group ports, multi-device candidates in the
// multi-device port), with the recorded bench output behind every cell.
// Written by `REPORT=1 pnpm vitest run report`; the page is never edited
// by hand, the English text lives in matrix-en.ts.

import { readFileSync } from 'node:fs'
import type { CandidateRun, Matrix, CellStatus } from './matrix'
import { candidateEn, portEn, promiseEn, scenarioEn } from './matrix-en'

export interface PageEvidence {
  s: string
  o: string
  c?: boolean
  p?: boolean
}
export interface PageRow {
  id: string
  title: string
  ref: string
  scs: string[]
  gap: string | null
  cells: Record<string, { status: string; ev: PageEvidence[] }>
}
export interface PageData {
  at: string
  cands: Array<{ id: string; name: string; desc: string }>
  families: Array<{ id: string; title: string; cands: string[]; ports: Array<{ id: string; title: string; rows: PageRow[] }> }>
  /** Candidate → scenario → what the bench recorded (German, shown as such). */
  res: Record<string, Record<string, { o: string; a: string; k: string; ms: string }>>
  scen: Record<string, string>
}

const statusEn = (status: CellStatus, hasScenarios: boolean): string =>
  status === 'bestanden' ? 'kept' : status === 'nicht bestanden' ? 'not kept' : status === 'teilweise' ? 'partial' : status === 'nicht abbildbar' ? 'n/a' : hasScenarios ? 'not run' : 'untested'

function need<T>(table: Record<string, T>, key: string, what: string): T {
  const v = table[key]
  if (v === undefined) throw new Error(`matrix page: no English text for ${what} ${key} (src/lab/matrix-en.ts)`)
  return v
}

/** The page data from a matrix and its runs. Throws when an English text is missing, so the page cannot drift. */
export function pageData(m: Matrix, runs: readonly CandidateRun[], at: string): PageData {
  const cands = runs.map((r) => ({ id: r.id, ...need(candidateEn, r.id, 'candidate') }))
  const res: PageData['res'] = {}
  const scen: Record<string, string> = {}
  for (const r of runs) {
    res[r.id] = {}
    for (const x of [...r.scenarios, ...r.carrier]) {
      res[r.id]![x.scenario] = { o: x.outcome, a: x.authority, k: x.keys, ms: x.ms ? `${x.ms.toFixed(1)} ms` : '' }
      scen[x.scenario] = need(scenarioEn, x.scenario, 'scenario')
    }
  }
  const port = (p: Matrix['ports'][number]) => {
    const en = portEn[p.port]
    return {
      id: en.id,
      title: en.title,
      rows: p.rows.map((row) => {
        const pe = need(promiseEn, row.promise.id, 'promise')
        const cells: PageRow['cells'] = {}
        for (const c of p.candidates) {
          const cell = row.cells[c]!
          cells[c] = { status: statusEn(cell.status, row.promise.scenarios.length > 0), ev: cell.evidence.map((e) => ({ s: e.scenario, o: e.outcome, ...(e.crashed ? { c: true } : {}), ...(e.promiseChanged ? { p: true } : {}) })) }
        }
        return { id: row.promise.id, title: pe.title, ref: pe.ref, scs: [...row.promise.scenarios].sort(), gap: pe.gap, cells }
      }),
    }
  }
  const group = m.ports.filter((p) => p.port !== 'mehrgerät' && p.candidates.length)
  const multi = m.ports.filter((p) => p.port === 'mehrgerät' && p.candidates.length)
  const families: PageData['families'] = []
  if (group.length) families.push({ id: 'group', title: 'Group candidates: authority, key and replication ports', cands: group[0]!.candidates.slice(), ports: group.map(port) })
  if (multi.length) families.push({ id: 'multidevice', title: 'Multi-device candidates: the multi-device port', cands: multi[0]!.candidates.slice(), ports: multi.map(port) })
  return { at, cands, families, res, scen }
}

const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty']
const word = (n: number) => words[n] ?? String(n)

/** The page: the template with data, date and lede filled in. */
export function renderPage(d: PageData, template = readFileSync(new URL('./matrix-page.html', import.meta.url), 'utf8')): string {
  const promises = d.families.reduce((n, f) => n + f.ports.reduce((k, p) => k + p.rows.length, 0), 0)
  const ports = d.families.reduce((n, f) => n + f.ports.length, 0)
  const lede = `${d.families.length === 1 ? 'One table' : `${word(d.families.length)[0]!.toUpperCase() + word(d.families.length).slice(1)} tables`}: ${word(d.cands.length)} candidate stacks as rows, ${promises} promises across ${word(ports)} ports as columns. Hover over a column header for the promise and its source, over a cell for the scenarios behind it and what the bench recorded; click to pin the hint.`
  const date = new Date(d.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  return template.replace('__DATE__', date).replace('__LEDE__', lede).replace('__DATA__', JSON.stringify(d))
}
