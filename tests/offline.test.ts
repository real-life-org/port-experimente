import { readdirSync, readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { seedKeys, createHolder } from 'rltp-lib'
import { InMemoryStore } from 'rltp-lib/testing'
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

// ── two properties the traces do not show: identity of the contact, and time ──

const RELAYS = [{ kind: 'tsp-mediator', address: 'did:web:mediator.example' }]
const DAY = 86_400_000
/** two holders after the two codes: the responder showed its code, the inviter read it and its person accepted */
async function twoCodes (accept: boolean) {
  let t = Date.parse('2026-10-15T09:00:00Z'), n = 0
  const at = () => ({ when: (t += 10_000), actId: 'offline-' + (++n) })
  const make = async (fill: number) => createHolder({ store: new InMemoryStore(), keys: seedKeys(new Uint8Array(64).fill(fill)) }, { modules: [], invariants: true })
  const I: any = await make(11), R: any = await make(12)
  const ev = (r: any, type: string) => (r.events ?? []).filter((e: any) => e.type === type)
  const shown = ev(await I.sharedConnectShow({ relays: RELAYS, name: 'inviter' }, at()), 'sharedconnect.shown')[0]
  const proposed = await R.sharedConnectPropose({ link: shown.link, relays: RELAYS, channel: 'scan', name: 'responder' }, at())
  const rDid = ev(proposed, 'sharedconnect.proposed')[0].did
  const code = ev(await R.sharedConnectBack({ id: shown.id }, at()), 'sharedconnect.shown')[0].link
  let fromI: any[] = []
  if (accept) {
    await I.sharedConnectReadBack(shown.id, code, (t += 10_000))
    const prompt = (await I.prompts()).find((x: any) => x.kind === 'shared-connect-confirm')
    fromI = ev(await I.decide(prompt.id, 'accept', at()), 'sharedconnect.send').flatMap((e: any) => e.docs)
  }
  return { I, R, id: shown.id as string, iDid: shown.did as string, rDid: rDid as string, fromI, ev, now: () => t, later: (ms: number) => (t += ms) }
}
const only = async (h: any) => { const cs = await h.contacts(); expect(cs.length).toBe(1); return cs[0].id as string }
const enactment = async (h: any) => { const vs = await h.sharedConnect(); expect(vs.length).toBe(1); return vs[0] }

test('one contact, the same before and after the documents: the enactment that opened it is the one that completes', async () => {
  const s = await twoCodes(true)
  const before = { i: await only(s.I), r: await only(s.R) }
  for (const side of [s.I, s.R]) { const v = await enactment(side); expect([v.id, v.status]).toEqual([s.id, 'open']) }
  expect([(await enactment(s.I)).contactId, (await enactment(s.R)).contactId]).toEqual([before.i, before.r])
  // a carrier is there: every document, and everything it causes, until nothing moves
  let wave: Array<{ to: any, from: string, docs: any[] }> = [{ to: s.R, from: s.iDid, docs: s.fromI }]
  for (let round = 0; round < 12 && wave.length; round++) {
    const next: typeof wave = []
    for (const w of wave) for (const doc of w.docs) {
      const r = await w.to.sharedConnectReceive(doc, w.from, s.later(10_000))
      expect(r.ok, JSON.stringify(r)).toBe(true)
      const docs = s.ev(r, 'sharedconnect.send').flatMap((e: any) => e.docs)
      if (docs.length) next.push(w.to === s.R ? { to: s.I, from: s.rDid, docs } : { to: s.R, from: s.iDid, docs })
    }
    wave = next
  }
  // exactly one contact on each side, with the id it had; the same enactment, complete, naming that contact
  expect({ i: await only(s.I), r: await only(s.R) }).toEqual(before)
  for (const [side, cid] of [[s.I, before.i], [s.R, before.r]] as const) {
    const v = await enactment(side)
    expect([v.id, v.status, v.contactId]).toEqual([s.id, 'complete', cid])
    expect(Object.keys((await side.snapshot()).state.relationships).length).toBe(1)
  }
}, 60_000)

test('thirty-one days after the code, nothing delivered: the responder keeps its contact and its open enactment; the acceptance, arriving then, is still taken', async () => {
  // the inviter read the code and accepted, but no carrier came for thirty-one days
  const s = await twoCodes(true)
  const contact = await only(s.R)
  const day31 = s.later(31 * DAY)
  expect((await s.R.tick(day31)).ok).toBe(true)
  expect(await only(s.R)).toBe(contact)
  const v = await enactment(s.R)
  expect([v.id, v.status, v.contactId]).toEqual([s.id, 'open', contact])
  // the inviter too opened from a code: it keeps both as well
  expect((await s.I.tick(day31)).ok).toBe(true)
  expect([(await enactment(s.I)).status, (await s.I.contacts()).length]).toEqual(['open', 1])
  // the acceptance and the inviter's issue arrive on day thirty-one: taken, the responder issues
  const [accept] = s.fromI
  const r = await s.R.sharedConnectReceive(accept, s.iDid, s.later(10_000))
  expect(r.ok).toBe(true)
  expect(s.ev(r, 'sharedconnect.accepted').length).toBe(1)
  expect(await only(s.R)).toBe(contact)
  // the counter-case of FRESH, F4: a responder that showed no code holds no contact, and its enactment is gone
  const plain = await twoCodes(false)
  const P: any = await createHolder({ store: new InMemoryStore(), keys: seedKeys(new Uint8Array(64).fill(13)) }, { modules: [], invariants: true })
  const link = (await plain.I.sharedConnect())[0]
  expect(link.status).toBe('open')
  const shown2 = plain.ev(await plain.I.sharedConnectShow({ relays: RELAYS }, { when: plain.later(10_000), actId: 'offline-second' }), 'sharedconnect.shown')[0]
  expect((await P.sharedConnectPropose({ link: shown2.link, relays: RELAYS, channel: 'scan' }, { when: plain.later(10_000), actId: 'offline-p' })).ok).toBe(true)
  expect((await P.tick(plain.later(31 * DAY))).ok).toBe(true)
  expect([(await P.contacts()).length, (await P.sharedConnect()).length]).toEqual([0, 0])
}, 60_000)
