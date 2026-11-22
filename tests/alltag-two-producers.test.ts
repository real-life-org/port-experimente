import { expect, test } from 'vitest'
import { measure } from '../src/lab/alltag/two-producers'
import expected from '../src/lab/alltag/two-producers.expected.json'

// A measurement of the published library (rltp-lib 0.19.0), pinned so that
// a library bump shows what moved. Not a requirement.
test('two producers: what the counterpart answers to the phone\'s and the laptop\'s document, by type', async () => {
  expect(await measure()).toEqual(expected)
}, 120_000)
