// What is left after two devices of one person each took the same document
// from the carrier, or each did the same act, and everything was delivered:
// per scenario, next to the same scenario with one device.
//
// two-producers.ts says what the counterpart answers to the second document.
// This says whether that answer leaves damage: do the two devices show the
// same afterwards, does the counterpart show what it shows with one device,
// and what is still being sent and refused days later.
//
// Two comparisons with different reach. The friend with two devices against
// with one: per contact verification and trust flags, per group phase and
// the numbers of members and pending, the number of inbox items (the row
// "the friend shows"); nothing else of the friend is compared. The phone
// against the laptop: everything `sig` reads. Counters, revisions and
// message contents are in neither.
//
// The second device is the stand-in of fixture.ts (same seed, a copy of the
// store, a late clock); the carrier stand-in hands an envelope to every
// device that holds its address.
import { at, clk, copyOf, ev, met, mk, ok, short, tick, type Person } from './fixture'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Sent = { o: any, from: Person }
type Cast = { T: Person, L: Person, B: Person }
export type Row = Record<string, string>
const DAY = 86_400_000
const DAYS = 5

const sig = async (P: Person): Promise<any> => ({
  contacts: (await P.h.contacts()).map((c: any) => ({ name: c.displayName, verification: c.verification, trust: c.trust, canMessage: c.canMessage })),
  groups: (await P.h.groups()).map((g: any) => ({ name: g.name, phase: g.phase, members: g.members.length, pending: g.pending.length })),
  profile: { ...(await P.h.profile()), commitSeq: undefined },   // a store's own counter, not something a device shows
  inbox: (await P.h.inbox()).length,
  prompts: (await P.h.prompts()).map((p: any) => p.kind).sort(),
})
const differ = (x: any, y: any): string[] => Object.keys(x).filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k]))
const who = (c: Cast, p: Person): string => (p === c.B ? 'friend' : p === c.T ? 'phone' : 'laptop')
const bad = (got: any): boolean => got.disposition !== 'unique' && got.disposition !== 'duplicate-known'

/** Delivers `first` and all it causes to every device holding the address;
 *  logs every document sent and every refusal as `sender type → verdict`. */
async function settle (c: Cast, first: Sent[], log: { sent: string[], refused: string[] }, rounds = 14, step = 10_000): Promise<void> {
  const people = [...new Set([c.T, c.L, c.B])]
  let out: Sent[] = [...first]
  for (let r = 0; r < rounds; r++) {
    const when = tick(step)
    for (const p of people) for (const o of (await p.h.resume(clk(p, when))).outbound) out.push({ o, from: p })
    if (!out.length) break
    while (out.length) {
      const { o, from } = out.shift() as Sent
      log.sent.push(`${who(c, from)} ${short(o.type)}`)
      for (const to of people) {
        if (to === from || !Object.hasOwn((await to.read()).addresses.keys, o.envelope.rkid)) continue
        const got = await to.h.receive(o.envelope, clk(to, when))
        if (bad(got)) log.refused.push(`${who(c, to)} refuses ${who(c, from)}'s ${short(o.type)} (${got.reason ?? got.disposition}${got.ref ? ' ' + got.ref : ''})`)
        else for (const x of got.outbound) out.push({ o: x, from: to })
      }
    }
  }
}
const count = (xs: string[]): string => {
  const m = new Map<string, number>()
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1)
  return [...m].sort().map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join('; ') || 'nothing'
}
const from = (P: Person, r: any): Sent[] => r.outbound.map((o: any) => ({ o, from: P }))
const founded = async (P: Person): Promise<string> => ev(ok(await P.h.foundGroup({ name: 'Garden' }, at(P))), 'group.founded')[0].groupId
const invitePrompt = async (P: Person, g: string): Promise<any> => (await P.h.prompts()).find((p: any) => p.kind === 'group-invite' && p.groupId === g)
const owing = async (P: Person): Promise<number> => { const s = await P.read(); return Object.keys(s.duties ?? {}).length + Object.keys(s.outbox ?? {}).length }

type Run = (c: Cast, a: any, b: any, log: { sent: string[], refused: string[] }) => Promise<void>
/** Each scenario starts from two persons who met. `two` says whether the
 *  person has a second device; the scenario asks `c.L === c.T` where the
 *  second device acts on its own. */
const SCENARIOS: Record<string, Run> = {
  'the friend trusts; each device takes the star': async (c, _a, b, log) => {
    await settle(c, from(c.B, ok(await c.B.h.trust(b.id, at(c.B)))), log)
  },
  'the friend writes a message; each device takes it': async (c, _a, b, log) => {
    await settle(c, from(c.B, ok(await c.B.h.sendMessage(b.id, 'hello', at(c.B)))), log)
  },
  'the friend sets a profile; each device takes it': async (c, _a, _b, log) => {
    await settle(c, from(c.B, ok(await c.B.h.setProfile({ name: 'Bea B.' }, at(c.B)))), log)
  },
  'the friend invites; each device answers the prelude; the phone accepts': async (c, _a, b, log) => {
    const g = await founded(c.B)
    await settle(c, from(c.B, ok(await c.B.h.invite(g, b.id, at(c.B)))), log)
    const p = await invitePrompt(c.T, g)
    if (!p) { log.refused.push('the phone holds no invitation'); return }
    await settle(c, from(c.T, ok(await c.T.h.decide(p.id, 'accept', at(c.T)))), log)
  },
  'the friend invites; both devices accept apart': async (c, _a, b, log) => {
    const g = await founded(c.B)
    await settle(c, from(c.B, ok(await c.B.h.invite(g, b.id, at(c.B)))), log)
    const acts: Sent[] = []
    for (const P of new Set([c.T, c.L])) {
      const p = await invitePrompt(P, g)
      if (p) acts.push(...from(P, ok(await P.h.decide(p.id, 'accept', at(P)))))
    }
    await settle(c, acts, log)
  },
  'trust is given on both devices apart': async (c, a, _b, log) => {
    const acts: Sent[] = []
    for (const P of new Set([c.T, c.L])) acts.push(...from(P, ok(await P.h.trust(a.id, at(P)))))
    await settle(c, acts, log)
  },
  'nothing happens for a week': async (c, _a, _b, log) => {
    tick(7 * DAY)
    await settle(c, [], log, 3, 0)
  },
}

async function run (name: string, fill: number, two: boolean): Promise<Row> {
  const T = await mk(fill), B = await mk(fill + 1)
  const { a, b } = await met(T, B)
  const L = two ? await copyOf(T) : T
  const c: Cast = { T, L, B }
  const now = { sent: [] as string[], refused: [] as string[] }
  const scenario = SCENARIOS[name]
  if (!scenario) throw new Error('no scenario ' + name)
  await scenario(c, a, b, now)
  const later = { sent: [] as string[], refused: [] as string[] }
  // one step of the clock per day; what falls due is delivered at that instant
  const start = tick(0)
  for (let d = 0; d < DAYS; d++) { tick(DAY); await settle(c, [], later, 6, 0) }
  if (tick(0) - start !== DAYS * DAY) throw new Error(`observed ${(tick(0) - start) / DAY} days, not ${DAYS}`)
  const [t, l, f] = [await sig(T), await sig(L), await sig(B)]
  return {
    'refused while settling': count(now.refused),
    [`sent in the ${DAYS} days after`]: count(later.sent),
    [`refused in the ${DAYS} days after`]: count(later.refused),
    'the devices differ in': two ? (differ(t, l).join(', ') || 'nothing') : 'one device',
    'still owing (duties and outbox)': `phone ${await owing(T)}${two ? `, laptop ${await owing(L)}` : ''}, friend ${await owing(B)}`,
    'the friend shows': JSON.stringify({ contacts: f.contacts.map((x: any) => ({ v: x.verification, given: x.trust.given, received: x.trust.received, pending: x.trust.pending })), groups: f.groups.map((g: any) => `${g.phase}/${g.members}/${g.pending}`), inbox: f.inbox }),
    'the phone shows': JSON.stringify({ contacts: t.contacts.map((x: any) => ({ name: x.name, v: x.verification, given: x.trust.given, received: x.trust.received, pending: x.trust.pending })), groups: t.groups.map((g: any) => `${g.phase}/${g.members}/${g.pending}`), inbox: t.inbox }),
  }
}

/** Every scenario with two devices and with one, and what differs. */
export async function measure (): Promise<Record<string, { two: Row, one: Row, differs: string[] }>> {
  const out: Record<string, { two: Row, one: Row, differs: string[] }> = {}
  let fill = 0x41
  for (const name of Object.keys(SCENARIOS)) {
    try {
      const two = await run(name, fill, true), one = await run(name, fill + 2, false)
      fill += 4
      out[name] = { two, one, differs: Object.keys(two).filter((k) => k !== 'the devices differ in' && two[k] !== one[k]) }
    } catch (e) { (e as Error).message = `${name}: ${(e as Error).message}`; throw e }
  }
  return out
}
