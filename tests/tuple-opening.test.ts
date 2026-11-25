import { readdirSync, readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { runOnLibrary } from '../src/lab/tuple-opening/lib-run'
import { build, everySchedule, replay, type Trace } from '../src/lab/tuple-opening/traces'
import type { Event } from '../src/lab/tuple-opening/rule'

const dir = new URL('../src/lab/tuple-opening/traces/', import.meta.url)
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
const traces = files.map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as Trace)

test.each(traces.map((t) => [t.name, t] as const))('trace %s replays to what it records', (_n, t) => {
  expect(replay(t.steps as Event[])).toEqual(t.steps)
})

test('the trace files are what the rule gives today', () => {
  expect([...traces].sort((x, y) => x.name.localeCompare(y.name))).toEqual(JSON.parse(JSON.stringify(build())).sort((x: Trace, y: Trace) => x.name.localeCompare(y.name)))
})

// The library (rltp-lib, the version in package.json) does at every step what the trace records:
// the same documents sent, the same side holding a contact, the same documents held back.
test.each(traces.map((t) => [t.name, t] as const))('the library follows %s at every step', async (_n, t) => {
  const lib = await runOnLibrary(t)
  expect(lib).toEqual(t.steps.map((s) => ({ sent: s.sent, after: s.after })))
}, 60_000)

test('the page names every trace, and only traces that exist', () => {
  const page = readFileSync(new URL('../src/lab/tuple-opening/OPENING.md', import.meta.url), 'utf8')
  expect([...new Set([...page.matchAll(/traces\/([a-z-]+\.json)/g)].map((m) => m[1] as string))].sort()).toEqual(files)
})

// Every order in which the carrier can deliver the six documents: nine schedules. In each, both sides end open,
// one of them first; and the library does at every step what the rule gives.
test('every schedule: both sides open at the end, either may be first, and the library follows each step', async () => {
  const all = everySchedule(), first = { inviter: 0, responder: 0 }
  for (const [i, events] of all.entries()) {
    const steps = replay(events), a = steps.findIndex((s) => s.after.inviter.open), b = steps.findIndex((s) => s.after.responder.open)
    expect(a >= 0 && b >= 0 && a !== b).toBe(true)
    first[a < b ? 'inviter' : 'responder']++
    expect(await runOnLibrary({ name: `schedule ${i}`, shows: '', steps }), JSON.stringify(events)).toEqual(steps.map((s) => ({ sent: s.sent, after: s.after })))
  }
  expect([all.length, first]).toEqual([9, { inviter: 5, responder: 4 }])
}, 120_000)
