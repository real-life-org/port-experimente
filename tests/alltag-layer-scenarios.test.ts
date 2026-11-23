import { expect, test } from 'vitest'
import { runLayer } from '../src/lab/alltag/layer-scenarios'

test('the layer prototype on the baseline scenarios it covers', async () => {
  expect(await runLayer()).toEqual(['N1', 'N3', 'N2', 'M1', 'M2', 'M3'].map((id) => ({ id, status: 'green' })))
}, 120_000)
