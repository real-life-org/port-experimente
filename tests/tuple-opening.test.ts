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

// Every order in which the carrier can deliver, the person accepting or declining: ten schedules.
test('every schedule: accepted, both sides open and either may be first; declined, neither; the library follows each step', async () => {
  const all = everySchedule(), first = { inviter: 0, responder: 0, declined: 0 }
  for (const events of all) {
    const steps = replay(events), a = steps.findIndex((s) => s.after.inviter.open), b = steps.findIndex((s) => s.after.responder.open)
    const end = (steps.at(-1) as Trace['steps'][number]).after
    if (end.inviter.declined) { expect([a, b, end.responder.declined]).toEqual([-1, -1, true]); first.declined++ } else { expect(a >= 0 && b >= 0 && a !== b).toBe(true); first[a < b ? 'inviter' : 'responder']++ }
    expect(end.inFlight).toEqual([])
    expect(await runOnLibrary({ name: '', shows: '', steps }), JSON.stringify(events)).toEqual(steps.map((s) => ({ sent: s.sent, after: s.after })))
  }
  expect([all.length, first]).toEqual([10, { inviter: 5, responder: 4, declined: 1 }])
}, 120_000)

// With one document handed over once more at any point: 6 896 schedules. A redelivery never changes what a side holds
// or whether it is open. Against the library every 23rd is run here (300 schedules); all of them were run once by hand.
test('one redelivery anywhere: nothing changes but what is sent again, and the library follows', async () => {
  const all = everySchedule(1)
  expect(all.length).toBe(6896)
  for (const [i, events] of all.entries()) {
    const steps = replay(events)
    for (const [k, s] of steps.entries()) if ('redeliver' in s) { const before = (steps[k - 1] as Trace['steps'][number]).after; expect([s.after.inviter, s.after.responder]).toEqual([before.inviter, before.responder]) }
    if (i % 23 === 0) expect(await runOnLibrary({ name: '', shows: '', steps }), JSON.stringify(events)).toEqual(steps.map((s) => ({ sent: s.sent, after: s.after })))
  }
}, 240_000)
