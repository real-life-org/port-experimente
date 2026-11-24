import { expect, test } from 'vitest'
import { walk } from '../src/lab/wiedererkennung/enumerate'

// Every schedule of two people with two devices each and two tuples
// (src/lab/wiedererkennung/enumerate.ts, over the rule in rule.ts). A check
// of a model, not of the library.
test('recognition on two devices: with the probe read again, every schedule ends as the candidate relations say', () => {
  const r = walk({ tuples: ['t1', 't2'] })
  expect(r.problems).toEqual([])
  expect(r.states).toBe(42481)
  expect(r.atRest).toEqual({ 'both relations give 1, devices show 1111': 28992, 'both relations give 2, devices show 2222': 12096 })
}, 240_000)

test('reading the probe once, when it is fetched, some schedules end with two contacts although both relations hold the pair', () => {
  const r = walk({ tuples: ['t1', 't2'], readOnce: true })
  expect(r.states).toBe(28404)
  expect(r.atRest['both relations give 1, devices show 2222']).toBe(672)
  expect(r.problems).toEqual(['a device shows other contacts than the pairs both relations hold'])
}, 240_000)
