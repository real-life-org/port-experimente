import { expect, test } from 'vitest'
import { measure } from '../src/lab/wechsel/scenarios'
import expected from '../src/lab/wechsel/scenarios.expected.json'
import { measure as measureGroup } from '../src/lab/wechsel/group-scenarios'
import expectedGroup from '../src/lab/wechsel/group-scenarios.expected.json'

// A measurement of a model (src/lab/wechsel/model.ts), pinned so that a
// change of a rule shows what moved. Not a requirement.
test('key change of a relationship with hidden devices: what each rule buys', () => {
  expect(measure()).toEqual(expected)
})

test('a person\'s key in a group that changes when a device is removed: what each rule buys', () => {
  expect(measureGroup()).toEqual(expectedGroup)
})
