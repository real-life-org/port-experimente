import { expect, it } from 'vitest'
import { runLoad } from '../src/lab/load'
import { klartext } from '../src/candidates/klartext'

it('S9-Last läuft für den Klartext-Kandidaten fehlerfrei durch', async () => {
  const r = await runLoad(klartext, 30, 500)
  expect(r.error).toBeUndefined()
  expect(r.operations).toBe(500)
  expect(r.msPerOp).toBeGreaterThan(0)
})

it('meldet bei mehreren Läufen den Median', async () => {
  const { runLoadMedian } = await import('../src/lab/load')
  const r = await runLoadMedian(klartext, 3, 10, 50)
  expect(r.runs).toBe(3)
  expect(r.error).toBeUndefined()
})

it('lehnt eine Zahl von Läufen ab, die keine positive ganze Zahl ist', async () => {
  const { runLoadMedian } = await import('../src/lab/load')
  for (const runs of [0, -1, 1.5]) {
    await expect(runLoadMedian(klartext, runs, 3, 5)).rejects.toThrow(RangeError)
  }
})
