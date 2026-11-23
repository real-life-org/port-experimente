import { expect, test } from 'vitest'
import { runBaseline } from '../src/lab/alltag/baseline'

// The same standings as the library repository's baseline test pins (2 green, 3 inexpressible, 22 red).
test('everyday baseline against the published library: the standings', async () => {
  const rows = await runBaseline()
  const by = (s: string): string[] => rows.filter((r) => r.status === s).map((r) => r.id)
  expect(by('green')).toEqual(['N1', 'M1'])
  expect(by('inexpressible')).toEqual(['P3', 'N2', 'S1'])
  expect(by('red')).toHaveLength(22)
}, 120_000)
