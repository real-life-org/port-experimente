// @ts-nocheck
// The traces of the rule (traces/*.json), run against the published
// library instead of the model: what the library does with the same steps.
// A measurement, pinned in lib-run.expected.json; it says where the
// library stands against the rule, not what is right.
//
// The library has one device per holder, so only traces in which each
// person acts on one device can run; the others are reported as not
// runnable. How a step of a trace is done with the library:
//
//   open t on X       the first opening of t: the other person shows a
//                     card, X scans it. The second opening: X is handed the
//                     bundle and accepts the encounter.
//   fetchProbe t on X X is handed the counterpart's continuity probe on t.
//   fetchMapping on X X is handed a continuity mapping of the counterpart.
//   sync              skipped (to a device that never acts).
//
// Probes and mappings are held back until a step asks for them; every
// other document (acknowledgements, credentials, stars, profiles) is
// delivered at once, because the rule says nothing about them. After every
// step the contacts each person holds are compared with what the rule gives
// at that step, so a mapping that takes effect later than its step shows.
// Type
// checking is off: the library's results are read loosely here.
import { seedKeys, createHolder } from 'rltp-lib'
import { InMemoryStore } from 'rltp-lib/testing'
import { contacts as groups, rule, start, type Device, type Event } from './rule'
import type { Trace } from './traces'

const PROBE = 'https://real-life.org/trust-tasks/spec/continuity-probe/0.1'
const MAPPING = 'https://real-life.org/trust-tasks/spec/continuity-mapping/0.1'
const BUNDLE = 'https://real-life.org/trust-tasks/spec/encounter-bundle/0.1'

/** `afterStep`: per step that is not a sync, the contacts each person holds then, as "a/b", in the library and by the rule;
 *  `differsAt`: the steps (counted from 1) after which the two differ. */
export type LibRun = { runnable: boolean, why?: string, notFollowed: string[], afterStep: Array<{ step: number, library: string, rule: string }>, differsAt: number[], contacts: { a: number, b: number }, expected: { a: number, b: number }, asExpected: boolean }

export async function runOnLibrary (t: Trace): Promise<LibRun> {
  // the devices that act (a sync is no act of the person): a trace can run where each person acts on one, whatever its name
  const acting = { a: new Set<string>(), b: new Set<string>() }
  for (const s of t.steps) if (!('sync' in s)) acting[s.on[0]].add(s.on)
  const device = { a: ([...acting.a][0] ?? 'a1') as Device, b: ([...acting.b][0] ?? 'b1') as Device }
  const expected = { a: t.expect.contacts[device.a].length, b: t.expect.contacts[device.b].length }
  if (acting.a.size > 1 || acting.b.size > 1) return { runnable: false, why: 'a person acts on two devices; the library has one device per holder', notFollowed: [], afterStep: [], differsAt: [], contacts: { a: 0, b: 0 }, expected, asExpected: false }
  // the rule beside the library, step by step
  const model = rule(t.setup)
  let byRule = start()
  const afterStep: LibRun['afterStep'] = [], differsAt: number[] = []
  const ruleShows = (): string => `${groups(byRule.devices[device.a].tuples, byRule.devices[device.a].united).length}/${groups(byRule.devices[device.b].tuples, byRule.devices[device.b].united).length}`

  let clock = Date.parse('2026-10-15T09:00:00Z'), acts = 0
  const now = (): number => (clock += 10_000)
  const at = (extra = {}) => ({ when: now(), actId: 'run-' + (++acts), ...extra })
  const make = async (fill: number) => { const store = new InMemoryStore(); return { h: await createHolder({ store, keys: seedKeys(new Uint8Array(64).fill(fill)) }, { modules: [], invariants: true }), store } }
  const P = { a: await make(1), b: await make(2) }
  const other = (p) => (p === 'a' ? 'b' : 'a')
  /** held back: probes and mappings, with the person they are for and the tuple they travel on; bundles by tuple */
  const held: Array<{ to: string, type: string, tuple: string | null, envelope: unknown }> = []
  /** the pair anchor a document is addressed to → the trace's tuple */
  const tupleOf = new Map<string, string>()
  let opening: string | null = null

  /** Take what a person sends: hold back probes, mappings and bundles, deliver the rest at once. */
  async function take (from: string, outbound: any[]): Promise<void> {
    for (const o of outbound ?? []) {
      if (!tupleOf.has(o.recipient) && opening) tupleOf.set(o.recipient, opening)
      if (o.type === PROBE || o.type === MAPPING || o.type === BUNDLE) { held.push({ to: other(from), type: o.type, tuple: tupleOf.get(o.recipient) ?? null, envelope: o.envelope }); continue }
      await hand(other(from), o.envelope)
    }
  }
  async function hand (to: string, envelope: unknown): Promise<any> {
    const got = await P[to].h.receive(envelope, now())
    await take(to, got.outbound)
    return got
  }
  /** let both libraries do what they do on their own */
  async function turn (): Promise<void> { for (const p of ['a', 'b']) await take(p, (await P[p].h.resume(now())).outbound) }
  const pull = (to: string, type: string, tuple?: string) => { const i = held.findIndex((d) => d.to === to && d.type === type && (tuple === undefined || d.tuple === tuple)); return i < 0 ? null : held.splice(i, 1)[0] }

  const notFollowed: string[] = []
  const opened = new Set<string>()
  for (const [i, s] of t.steps.entries()) {
    const event = Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'effect')) as Event
    const label = `step ${i + 1} ${JSON.stringify(event)}`
    byRule = model.apply(byRule, event).state
    if ('sync' in s) continue
    const me = s.on[0]
    await act()
    const library = `${(await P.a.h.contacts()).length}/${(await P.b.h.contacts()).length}`
    afterStep.push({ step: i + 1, library, rule: ruleShows() })
    if (library !== ruleShows()) differsAt.push(i + 1)
    async function act (): Promise<void> {
    if ('open' in s) {
      opening = s.open
      if (!opened.has(s.open)) {
        const shown = await P[other(me)].h.show(at({ name: other(me) }))
        const card = shown.events.find((e) => e.type === 'encounter.shown').card
        const scanned = await P[me].h.scan(card, at({ name: me }))
        if (!scanned.ok) notFollowed.push(`${label}: scan refused (${scanned.code})`)
        await take(me, scanned.outbound)
        opened.add(s.open)
      } else {
        const bundle = pull(me, BUNDLE, s.open)
        if (!bundle) { notFollowed.push(`${label}: no bundle to accept`); return }
        await hand(me, bundle.envelope)
        const prompt = (await P[me].h.prompts()).find((p) => p.kind === 'encounter-confirm')
        if (!prompt) { notFollowed.push(`${label}: no prompt after the bundle`); return }
        await take(me, (await P[me].h.decide(prompt.id, 'accept', at())).outbound)
      }
      await turn(); opening = null
      return
    }
    const doc = 'fetchProbe' in s ? pull(me, PROBE, s.fetchProbe) : pull(me, MAPPING)
    if (!doc) { notFollowed.push(`${label}: the library has no such document waiting`); return }
    await hand(me, doc.envelope)
    await turn()
    }
  }
  // to rest: deliver whatever is still held, and what that causes
  for (let round = 0; round < 12; round++) {
    await turn()
    if (!held.length) break
    for (const d of held.splice(0)) await hand(d.to, d.envelope)
  }
  const contacts = { a: (await P.a.h.contacts()).length, b: (await P.b.h.contacts()).length }
  return { runnable: true, notFollowed, afterStep, differsAt, contacts, expected, asExpected: differsAt.length === 0 && contacts.a === expected.a && contacts.b === expected.b }
}
