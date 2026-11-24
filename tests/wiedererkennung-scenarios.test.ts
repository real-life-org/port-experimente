import { expect, test } from 'vitest'
import { measure } from '../src/lab/wiedererkennung/scenarios'
import expected from '../src/lab/wiedererkennung/scenarios.expected.json'

// A measurement of a model (src/lab/wiedererkennung/model.ts), pinned so
// that a change of the rule shows what moved. Not a requirement. Names and
// secrets are drawn at random in every run; the facts measured do not
// depend on them, which the repetition checks.
test('recognition by one proof per pair of tuples: what the rule gives in the cases the probe needed rules for, and in the counter-runs of its review', () => {
  for (let i = 0; i < 2; i++) expect(measure()).toEqual(expected)
}, 120_000)
