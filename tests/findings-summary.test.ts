// The summary table in public/findings.html must match the cells in public/matrix.html.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

type Cell = { status: string }
type Matrix = { cands: { id: string }[]; ports: { rows: { cells: Record<string, Cell> }[] }[] }

const read = (p: string) => readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8')

function countsFromMatrix(): Record<string, Record<string, number>> {
  const html = read('matrix.html')
  const start = html.indexOf('const D = ') + 'const D = '.length
  const end = html.indexOf(';\n', start)
  const D = JSON.parse(html.slice(start, end)) as Matrix
  const out: Record<string, Record<string, number>> = {}
  for (const c of D.cands) {
    const n: Record<string, number> = { kept: 0, partial: 0, 'not kept': 0, 'n/a': 0, untested: 0 }
    for (const port of D.ports) for (const row of port.rows) {
      const st = row.cells[c.id].status
      n[st === 'not run' ? 'n/a' : st] = (n[st === 'not run' ? 'n/a' : st] ?? 0) + 1
    }
    out[c.id] = n
  }
  return out
}

function rowsFromFindings(): { cands: string[]; kept: number; partial: number; notKept: number; na: number }[] {
  const html = read('findings.html')
  const rows = [...html.matchAll(/<tr data-cand="([^"]+)">.*?<\/tr>/gs)]
  return rows.map((m) => {
    const nums = [...m[0].matchAll(/<td class="num[^"]*">(\d+)<\/td>/g)].map((x) => Number(x[1]))
    expect(nums).toHaveLength(4)
    return { cands: m[1].split(' '), kept: nums[0], partial: nums[1], notKept: nums[2], na: nums[3] }
  })
}

describe('findings summary', () => {
  it('matches the matrix cell by cell and never counts partial as kept', () => {
    const counts = countsFromMatrix()
    const rows = rowsFromFindings()
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) for (const id of r.cands) {
      const n = counts[id]
      expect(n, id).toBeDefined()
      expect({ id, kept: n.kept, partial: n.partial, notKept: n['not kept'], na: n['n/a'] })
        .toEqual({ id, kept: r.kept, partial: r.partial, notKept: r.notKept, na: r.na })
    }
  })
})
