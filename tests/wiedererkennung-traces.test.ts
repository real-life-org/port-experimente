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
test('without the proven head only the three traces of R10 end differently', () => {
  const differs: string[] = []
  for (const t of traces) {
    const c = { ...t.setup, noProvenHead: true }, end = rule(c).settle(replay(c, t.steps as Event[], true).state).state
    if (DEVICES.some((d) => JSON.stringify(relationships(end.devices[d].tuples, end.devices[d].united)) !== JSON.stringify(t.expect.relationships[d]))) differs.push(t.name)
    expect([rule(c).outstanding(end, 'a'), rule(c).outstanding(end, 'b')]).toEqual([[], []])
  }
  expect(differs).toEqual(['head-changed-before-the-answer', 'proven-by-the-acknowledgement', 'stale-device'])
})

// The two observations the trace is there for: the probe step gives no hit while the pair is not proven, and the
// acknowledgement alone, with no sync or fetch in between, makes the kept probe hit.
test('proven-by-the-acknowledgement: the mapping over t2+t3 is owed from the step that brings the acknowledgement, not before', () => {
  const t = traces.find((x) => x.name === 'proven-by-the-acknowledgement') as Trace
  const probe = t.steps.findIndex((s) => 'fetchProbe' in s && s.fetchProbe === 't3' && s.on === 'a2')
  expect(t.steps[probe + 1]).toMatchObject({ fetchMapping: 't1+t2', on: 'b1' })
  expect((t.steps[probe] as Trace['steps'][number]).after.stillOwed.a).toEqual(['t1+t2'])
  expect((t.steps[probe + 1] as Trace['steps'][number]).after.stillOwed.a).toEqual(['t2+t3'])
})
