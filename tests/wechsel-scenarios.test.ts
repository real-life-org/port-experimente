import { expect, test } from 'vitest'
import { measure } from '../src/lab/wechsel/scenarios'
import expected from '../src/lab/wechsel/scenarios.expected.json'

// A measurement of a model (src/lab/wechsel/model.ts), pinned so that a
// change of a rule shows what moved. Not a requirement.
test('key change of a relationship with hidden devices: what each rule buys', () => {
  expect(measure()).toEqual(expected)
})
