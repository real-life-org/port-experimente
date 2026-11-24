import { expect, test } from 'vitest'
import { explore } from '../src/lab/wiedererkennung/enumerate'

// Every schedule of two people with two devices each and two tuples
// (src/lab/wiedererkennung/enumerate.ts). A check of a model, not of the
// library.
test('recognition after Trust 6a on two devices: with the probe read again from the log, every schedule ends as the candidate relations say', () => {
  const r = explore(2, true)
  expect(r.problems).toEqual([])
  expect(r.atRest).toEqual({ 'both relations give 1, devices show 1111': 28992, 'both relations give 2, devices show 2222': 12096, 'at rest with more than one contact': 12096 })
})

test('without reading the probe again, some schedules end with two contacts although both relations hold the pair', () => {
  const r = explore(2, false)
  expect(r.atRest['both relations give 1, devices show 2222']).toBe(162)
  expect(r.problems).toEqual(['a device shows other contacts than the pairs both relations hold'])
})
