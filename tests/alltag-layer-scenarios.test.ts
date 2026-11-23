import { expect, test } from 'vitest'
import { runLayer } from '../src/lab/alltag/layer-scenarios'

test('the layer prototype on the baseline scenarios it covers', async () => {
  const rows = await runLayer()
  expect(rows.filter((r) => r.status === 'green').map((r) => r.id)).toEqual(['N1', 'N3', 'N2', 'M1', 'M2', 'M3', 'K1', 'K2', 'K4'])
  // K3 is open: the laptop ends with two lines for B. K5 is open: two acts apart are two anchor mappings under one number.
  expect(rows.filter((r) => r.status !== 'green')).toEqual([
    { id: 'K3', status: 'red', note: expect.stringContaining('phone 1, laptop 2') },
    { id: 'K5', status: 'red', note: 'given: phone true, laptop true; received at B: true; B refuses: anchor-mapping/0.3: validation-failed' },
  ])
}, 120_000)
