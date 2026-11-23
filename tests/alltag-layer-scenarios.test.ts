import { expect, test } from 'vitest'
import { runLayer } from '../src/lab/alltag/layer-scenarios'

test('the layer prototype on the baseline scenarios it covers', async () => {
  const rows = await runLayer()
  expect(rows.filter((r) => r.status === 'green').map((r) => r.id)).toEqual(['N1', 'N3', 'N2', 'M1', 'M2', 'M3', 'K1', 'K2'])
  // K3 is open: both devices issue the continuity probe, the friend's mapping answers one of them
  expect(rows.filter((r) => r.status !== 'green')).toEqual([{ id: 'K3', status: 'red', note: expect.stringContaining('phone 1, laptop 2') }])
}, 120_000)
