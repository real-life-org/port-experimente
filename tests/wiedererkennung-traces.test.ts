import { readdirSync, readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { DEVICES, relationships, rule, type Event } from '../src/lab/wiedererkennung/rule'
import { build, replay, type Trace } from '../src/lab/wiedererkennung/traces'

const dir = new URL('../src/lab/wiedererkennung/traces/', import.meta.url)
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
const traces = files.map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as Trace)

// What another implementation of the rule would do with a trace: replay the
// steps, compare every step's effect and what every device shows at the end.
test.each(traces.map((t) => [t.name, t] as const))('trace %s replays to what it expects', (_name, t) => {
  const r = rule(t.setup), run = replay(t.setup, t.steps as Event[])
  expect(run.steps).toEqual(t.steps)
  expect([...r.events(run.state, false)].filter((e) => r.apply(run.state, e).effect)).toEqual([])   // at rest
  for (const d of DEVICES) expect(relationships(run.state.devices[d].tuples, run.state.devices[d].united)).toEqual(t.expect.relationships[d])
  expect(run.state.people.a.candidates).toEqual(t.expect.candidates.a)
  expect(run.state.people.b.candidates).toEqual(t.expect.candidates.b)
  expect({ a: r.outstanding(run.state, 'a'), b: r.outstanding(run.state, 'b') }).toEqual(t.expect.stillOwed)
  if (t.control) {
    const c = { ...t.setup, [t.control.without]: true }, end = rule(c).settle(replay(c, t.steps as Event[], true).state).state
    for (const d of DEVICES) expect(relationships(end.devices[d].tuples, end.devices[d].united)).toEqual(t.control.relationships[d])
    expect(t.control.relationships).not.toEqual(t.expect.relationships)
  }
})

test('the trace files are what the walk gives today', () => {
  const fresh = (JSON.parse(JSON.stringify(build())) as Trace[]).sort((x, y) => x.name.localeCompare(y.name))
  expect([...traces].sort((x, y) => x.name.localeCompare(y.name))).toEqual(fresh)
}, 240_000)

test('the page names every trace, and only traces that exist', () => {
  const page = readFileSync(new URL('../src/lab/wiedererkennung/RECOGNITION.md', import.meta.url), 'utf8')
  const named = [...new Set([...page.matchAll(/traces\/([a-z-]+\.json)/g)].map((m) => m[1] as string))].sort()
  expect(named).toEqual(files)
})

// The proven head changes one pinned case and no other: without it, only stale-device ends differently.
test('without the proven head every trace but stale-device and the one built on it ends as it does with it', () => {
  const differs: string[] = []
  for (const t of traces) {
    const c = { ...t.setup, noProvenHead: true }, end = rule(c).settle(replay(c, t.steps as Event[], true).state).state
    if (DEVICES.some((d) => JSON.stringify(relationships(end.devices[d].tuples, end.devices[d].united)) !== JSON.stringify(t.expect.relationships[d]))) differs.push(t.name)
    expect([rule(c).outstanding(end, 'a'), rule(c).outstanding(end, 'b')]).toEqual([[], []])
  }
  expect(differs).toEqual(['head-changed-before-the-answer', 'stale-device'])
})
