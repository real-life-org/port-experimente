import { readdirSync, readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { runOnLibrary } from '../src/lab/tuple-opening/lib-run'
import { build, everySchedule, replay, type Trace } from '../src/lab/offline/traces'
import type { Event } from '../src/lab/offline/rule'

const dir = new URL('../src/lab/offline/traces/', import.meta.url)
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
const traces = files.map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as Trace)
const want = (steps: Trace['steps']) => steps.map((s) => ({ sent: s.sent, after: s.after }))

test.each(traces.map((t) => [t.name, t] as const))('trace %s replays to what it records, and ends with nothing in flight', (_n, t) => {
  expect(replay(t.steps as Event[])).toEqual(t.steps)
  expect((t.steps.at(-1) as Trace['steps'][number]).after.inFlight).toEqual([])
})

test('the trace files are what the rule gives today', () => {
  expect([...traces].sort((x, y) => x.name.localeCompare(y.name))).toEqual(JSON.parse(JSON.stringify(build())).sort((x: Trace, y: Trace) => x.name.localeCompare(y.name)))
})

// The library (rltp-lib, the version in package.json) does at every step what the trace records: the same
// documents sent, the same side holding a contact, the same documents held back, the same outbox.
test.each(traces.map((t) => [t.name, t] as const))('the library follows %s at every step', async (_n, t) => {
  expect(await runOnLibrary(t)).toEqual(want(t.steps))
}, 60_000)

test('the page names every trace, and only traces that exist', () => {
  const page = readFileSync(new URL('../src/lab/offline/OFFLINE.md', import.meta.url), 'utf8')
  expect([...new Set([...page.matchAll(/traces\/([a-z-]+\.json)/g)].map((m) => m[1] as string))].sort()).toEqual(files)
})

test('two codes and the acceptance, nothing carried: both sides are open', () => {
  const steps = replay([{ act: 'propose' }, { act: 'back' }, { act: 'read-back' }, { act: 'accept' }])
  expect(steps.map((s) => [s.after.responder.open, s.after.inviter.open])).toEqual([[false, false], [true, false], [true, false], [true, true]])
  expect(steps.flatMap((s) => 'deliver' in s ? [s] : [])).toEqual([])
})

// The two codes shown and read at any point of any delivery order: 33 799 schedules. In the rule: a side that opened
// stays open; the responder is open from the step it showed its code, the inviter from the step it holds the card and
// its person accepted, or from its last document; the end is both open, or after a decline the responder alone (it
// showed its code before the decline reached it) or neither. Against the library every 113th is run here (300
// schedules); all of them were run once by hand.
test('every schedule with the two codes: who is open when, how it ends, and the library follows', async () => {
  const all = everySchedule(), ends = { both: 0, responder: 0, neither: 0 }
  expect(all.length).toBe(33799)
  for (const [i, events] of all.entries()) {
    const steps = replay(events)
    let open = [false, false], back = false, card = false, accepted = false
    for (const s of steps) {
      if ('act' in s && s.act === 'back') back = true
      if ('act' in s && s.act === 'read-back') card = true
      if ('act' in s && s.act === 'accept') accepted = true
      const now = [s.after.inviter.open, s.after.responder.open]
      expect(open[0] && !now[0] || open[1] && !now[1], 'a side that opened stays open').toBe(false)
      if (back) expect(now[1]).toBe(true)
      if (card && accepted) expect(now[0]).toBe(true)
      open = now
    }
    const end = (steps.at(-1) as Trace['steps'][number]).after
    expect(end.inFlight).toEqual([])
    if (end.inviter.declined) { expect(end.inviter.open).toBe(false); expect(end.responder.declined).toBe(true); ends[end.responder.open ? 'responder' : 'neither']++ } else { expect([end.inviter.open, end.responder.open]).toEqual([true, true]); ends.both++ }
    if (i % 113 === 0) expect(await runOnLibrary({ steps }), JSON.stringify(events)).toEqual(want(steps))
  }
  expect(ends).toEqual({ both: 33790, responder: 8, neither: 1 })
}, 600_000)
