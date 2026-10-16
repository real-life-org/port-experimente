// The summary table in public/findings.html must match the cells in public/matrix.html.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

type Cell = { status: string }
type Matrix = { cands: { id: string }[]; ports: { rows: { cells: Record<string, Cell> }[] }[] }
type Counts = { kept: number; partial: number; notKept: number; na: number; untested: number }
type Row = { cands: string[]; kept: number; partial: number; notKept: number; na: number }

const read = (p: string) => readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8')

function countsFromMatrix(): Map<string, Counts> {
  const html = read('matrix.html')
  const start = html.indexOf('const D = ') + 'const D = '.length
  const end = html.indexOf(';\n', start)
  const D = JSON.parse(html.slice(start, end)) as Matrix
  const out = new Map<string, Counts>()
  for (const c of D.cands) {
    const n: Counts = { kept: 0, partial: 0, notKept: 0, na: 0, untested: 0 }
    for (const port of D.ports) for (const row of port.rows) {
      const status = row.cells[c.id]?.status
      if (status === 'kept') n.kept++
      else if (status === 'partial') n.partial++
      else if (status === 'not kept') n.notKept++
      else if (status === 'untested') n.untested++
      else n.na++ // 'n/a' and 'not run'
    }
    out.set(c.id, n)
  }
  return out
}

function rowsFromFindings(): Row[] {
  const html = read('findings.html')
  const rows: Row[] = []
  for (const m of html.matchAll(/<tr data-cand="([^"]+)">(.*?)<\/tr>/gs)) {
    const nums = [...(m[2] ?? '').matchAll(/<td class="num[^"]*">(\d+)<\/td>/g)].map((x) => Number(x[1]))
    const [kept, partial, notKept, na] = nums
    if (kept === undefined || partial === undefined || notKept === undefined || na === undefined) {
      throw new Error(`summary row ${m[1]} has ${nums.length} numbers, expected 4`)
    }
    rows.push({ cands: (m[1] ?? '').split(' '), kept, partial, notKept, na })
  }
  return rows
}

describe('findings summary', () => {
  it('matches the matrix cell by cell and never counts partial as kept', () => {
    const counts = countsFromMatrix()
    const rows = rowsFromFindings()
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) for (const id of r.cands) {
      const n = counts.get(id)
      if (!n) throw new Error(`candidate ${id} not in the matrix`)
      expect({ id, kept: n.kept, partial: n.partial, notKept: n.notKept, na: n.na })
        .toEqual({ id, kept: r.kept, partial: r.partial, notKept: r.notKept, na: r.na })
    }
  })
})
