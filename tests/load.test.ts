import { expect, it } from 'vitest'
import { runLoad } from '../src/lab/load'
import { klartext } from '../src/candidates/klartext'

it('S9-Last läuft für den Klartext-Kandidaten fehlerfrei durch', async () => {
  const r = await runLoad(klartext, 30, 500)
  expect(r.error).toBeUndefined()
  expect(r.operations).toBe(500)
  expect(r.msPerOp).toBeGreaterThan(0)
})
