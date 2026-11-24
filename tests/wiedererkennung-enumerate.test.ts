import { expect, test } from 'vitest'
import { draw, walk } from '../src/lab/wiedererkennung/enumerate'

// Every schedule of two people with two devices each and two tuples
// (src/lab/wiedererkennung/enumerate.ts, over the rule in rule.ts). A check
// of a model, not of the library. `states` are the states reached; `judged`
// those with both tuples open on both sides, which are brought to rest and
// checked.
test('two devices each: with the probe read again, every schedule ends as the candidate relations say', () => {
  const r = walk({ tuples: ['t1', 't2'] })
  expect(r.problems).toEqual([])
  expect([r.states, r.judged]).toEqual([58865, 57472])
  expect(r.atRest).toEqual({ 'both relations give 1, devices show 1111': 45376, 'both relations give 2, devices show 2222': 12096 })
}, 240_000)

test('the other rank of the two tuples gives the same', () => {
  const r = walk({ tuples: ['t1', 't2'], rank: ['t2', 't1'] })
  expect(r.problems).toEqual([])
  expect(r.atRest).toEqual({ 'both relations give 1, devices show 1111': 45376, 'both relations give 2, devices show 2222': 12096 })
}, 240_000)

test('control: a probe read once, when it is fetched, and not handed on: some schedules end with two relationships although both relations hold the pair', () => {
  const r = walk({ tuples: ['t1', 't2'], readOnce: true })
  expect(r.states).toBe(35348)
  expect(r.atRest['both relations give 1, devices show 2222']).toBe(672)
  expect(r.problems).toEqual(['a device shows other relationships than the pairs both relations hold'])
}, 240_000)

test('control: a probe kept and read again by the device that fetched it, not handed on: no schedule ends wrongly', () => {
  const r = walk({ tuples: ['t1', 't2'], noForward: true })
  expect(r.states).toBe(31876)
  expect(r.problems).toEqual([])
}, 240_000)

// A statement that is not computed from the candidates the rule itself wrote.
test.each([[['t1', 't2'], 199, 164], [['t1', 't2', 't3'], 62755, 60676]] as const)('one device per person, tuples %j: every schedule ends with one relationship', (tuples, states, judged) => {
  const r = walk({ tuples: [...tuples], single: true })
  expect(r.problems).toEqual([])
  expect([r.states, r.judged]).toEqual([states, judged])
  expect(Object.keys(r.atRest)).toEqual(['both relations give 1, devices show 1010'])
}, 240_000)

test('three tuples, two devices each, drawn at random: every schedule ends as the candidate relations say', () => {
  expect(draw({ tuples: ['t1', 't2', 't3'] }, 300).problems).toEqual([])
}, 240_000)
