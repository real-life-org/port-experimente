import { expect, test } from 'vitest'
import { measure } from '../src/lab/alltag/aftermath'
import expected from '../src/lab/alltag/aftermath.expected.json'

// A measurement of the published library, pinned so that a library bump
// shows what moved. Not a requirement.
test('aftermath: what is left after two devices took the same document, next to one device', async () => {
  expect(await measure()).toEqual(expected)
}, 300_000)
