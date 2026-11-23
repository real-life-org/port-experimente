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

// Two scenarios carry two observations each; the matrix judges a promise by the one that tests it.
test('everyday baseline: the observations of G2 and M8, each on its own', async () => {
  const rows = await runBaseline()
  const parts = (id: string) => rows.find((r) => r.id === id)!.parts
  expect(parts('G2')!.a).toEqual({ status: 'red', note: 'the devices differ in: contacts, profile' })
  expect(parts('G2')!.b!.status).toBe('red')
  // M8: A stays a member and reads on with the laptop (green); the removed phone still reads (red).
  expect(parts('M8')!.a).toEqual({ status: 'green' })
  expect(parts('M8')!.b).toEqual({ status: 'red', note: 'the removed phone reads the new member (3 members)' })
}, 120_000)
