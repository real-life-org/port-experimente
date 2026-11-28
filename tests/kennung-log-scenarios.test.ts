import { expect, test } from 'vitest'
import { measure } from '../src/lab/kennung-log/scenarios'
import expected from '../src/lab/kennung-log/scenarios.expected.json'

// A measurement of src/lab/kennung-log (log.ts, verifier.ts), pinned so
// that a change of a rule or of the format shows what moved.
test('a login identifier with a did:webvh-format log at one service: every flow', async () => {
  expect(await measure()).toEqual(expected)
})
