import { describe, expect, test } from 'vitest'
import { at, clk, copyOf, ev, met, mk, ok, tick, type Person } from '../src/lab/alltag/fixture'
import { Device } from '../src/lab/alltag/invitation'
import { carry } from '../src/lab/alltag/carrier'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A with phone and laptop (a copy, clock late); B founded a group and knows A. */
async function world (fill: number): Promise<{ T: Device, L: Device, B: Person, b: any, g: string }> {
  const A = await mk(fill), B = await mk(fill + 1)
  const { b } = await met(A, B)
  const g = ev(ok(await B.h.foundGroup({ name: 'Garden' }, at(B))), 'group.founded')[0].groupId
  return { T: new Device('phone', A), L: new Device('laptop', await copyOf(A)), B, b, g }
}

const phase = async (D: Device | Person, g: string): Promise<string | undefined> => (await ('P' in D ? D.P : D).h.groups()).find((x: any) => x.id === g)?.phase
const members = async (P: Person, g: string): Promise<number> => (await P.h.groups()).find((x: any) => x.id === g).members.length
const card = async (D: Device, g: string): Promise<boolean> => (await D.P.h.prompts()).some((p: any) => p.kind === 'group-invite' && p.groupId === g)
/** Open, as measured: what the friend refuses in every run. The laptop
 *  answered the prelude as well and keeps repeating the refused reply (the
 *  library cannot withdraw it), and once a member it issues a group star of
 *  its own under the salt the phone used. */
const SECOND_PRODUCER = ['group-star/0.1: validation-failed', 'membership-prelude-reply/0.1: validation-failed']
const invite = async (B: Person, b: any, g: string): Promise<any[]> => ok(await B.h.invite(g, b.id, at(B))).outbound

describe('a group invitation through the layer', () => {
  test('both devices get the invitation, the phone accepts: the laptop is a member without an act of its own', async () => {
    const { T, L, B, b, g } = await world(0x61)
    const early = await carry(B, [T, L], [T, L], await invite(B, b, g))
    expect([await card(T, g), await card(L, g)]).toEqual([true, true])
    const acted = await T.decide(g, 'accept')
    expect(acted.stoppedAt).toBe(null)
    expect((await L.syncFrom(T)).stoppedAt).toBe(null)
    const late = await carry(B, [T, L], [T, L], T.toCarrier(acted.outbound))
    await L.syncFrom(T); await T.syncFrom(L)
    expect({ phone: await phase(T, g), laptop: await phase(L, g), cardOnLaptop: await card(L, g), atB: await members(B, g) })
      .toEqual({ phone: 'member', laptop: 'member', cardOnLaptop: false, atB: 2 })
    expect({ early, late }).toEqual({ early: ['membership-prelude-reply/0.1: validation-failed'], late: SECOND_PRODUCER })
    // the pages the phone got answer requests only the phone made
    expect([...new Set(L.notTaken)]).toEqual(['x-access-page/0.1: validation-failed'])
  })

  test('only the phone is reached by the carrier; the laptop learns the join from the phone and the group\'s log once it reaches the carrier', async () => {
    const { T, L, B, b, g } = await world(0x63)
    await carry(B, [T, L], [T], await invite(B, b, g))
    const acted = await T.decide(g, 'accept')
    const refused = await carry(B, [T, L], [T], T.toCarrier(acted.outbound))
    const learned = await L.syncFrom(T)
    expect(learned.stoppedAt).toBe(null)
    // the join is taken over; the group's log is not part of the personal log,
    // and the page the phone got answers a request only the phone made
    expect({ phone: await phase(T, g), laptop: await phase(L, g), cardOnLaptop: await card(L, g), atB: await members(B, g), refused, notTaken: [...new Set(L.notTaken)] })
      .toEqual({ phone: 'member', laptop: 'joining', cardOnLaptop: false, atB: 2, refused: [], notTaken: ['x-access-page/0.1: validation-failed'] })
    // the laptop's own request for the log, once the carrier reaches it
    await carry(B, [T, L], [T, L], L.toCarrier(learned.outbound))
    expect(await phase(L, g)).toBe('member')
  })

  test('apart: the phone accepts and its accept leaves for the carrier, the laptop declines: the accept stands on both devices', async () => {
    const { T, L, B, b, g } = await world(0x65)
    await carry(B, [T, L], [T, L], await invite(B, b, g))
    const accepted = await T.decide(g, 'accept')
    const leaving = T.toCarrier(accepted.outbound)            // it is out of the house before the devices hear of each other
    const declined = await L.decide(g, 'decline')
    expect([accepted.stoppedAt, declined.stoppedAt]).toEqual([null, null])
    await L.syncFrom(T); await T.syncFrom(L)
    const refused = await carry(B, [T, L], [T, L], leaving)
    await L.syncFrom(T); await T.syncFrom(L)
    expect({ phone: await phase(T, g), laptop: await phase(L, g), cardOnLaptop: await card(L, g), atB: await members(B, g), refused })
      .toEqual({ phone: 'member', laptop: 'member', cardOnLaptop: false, atB: 2, refused: SECOND_PRODUCER })
  })

  test('apart: the phone accepts offline, the accept has not left it; the laptop declines: the decline wins and nothing reaches the friend', async () => {
    const { T, L, B, b, g } = await world(0x69)
    await carry(B, [T, L], [T, L], await invite(B, b, g))
    const accepted = await T.decide(g, 'accept')              // still in the house
    await L.decide(g, 'decline')
    await L.syncFrom(T); await T.syncFrom(L)
    const cred = async (D: Device): Promise<string> => Object.keys((await D.P.read()).joining.invites)[0] as string
    expect([T.verdict(await cred(T)), L.verdict(await cred(L))]).toEqual(['declined', 'declined'])
    expect(T.toCarrier(accepted.outbound)).toEqual([])
    const refused = await carry(B, [T, L], [T, L], [])
    const status = async (D: Device): Promise<string[]> => Object.values((await D.P.read()).joining.invites).map((i: any) => i.status)
    expect({ phone: [await phase(T, g), await status(T), await card(T, g)], laptop: [await phase(L, g), await status(L), await card(L, g)], atB: await members(B, g), refused })
      .toEqual({ phone: [undefined, ['declined'], false], laptop: [undefined, ['declined'], false], atB: 1, refused: ['membership-prelude-reply/0.1: validation-failed'] })
  })

  test('apart: both devices accept, the devices hear of each other first: one accept leaves, both devices are members', async () => {
    const { T, L, B, b, g } = await world(0x67)
    await carry(B, [T, L], [T, L], await invite(B, b, g))
    const onPhone = await T.decide(g, 'accept')
    const onLaptop = await L.decide(g, 'accept')
    await L.syncFrom(T); await T.syncFrom(L)
    const leaving = [...T.toCarrier(onPhone.outbound), ...L.toCarrier(onLaptop.outbound)]
    expect(leaving).toHaveLength(1)
    const refused = await carry(B, [T, L], [T, L], leaving)
    await L.syncFrom(T); await T.syncFrom(L)
    expect({ phone: await phase(T, g), laptop: await phase(L, g), atB: await members(B, g), refused })
      .toEqual({ phone: 'member', laptop: 'member', atB: 2, refused: SECOND_PRODUCER })
  })

  test('apart: both devices accept and both accepts leave: the friend takes the first, both devices are members', async () => {
    const { T, L, B, b, g } = await world(0x6b)
    await carry(B, [T, L], [T, L], await invite(B, b, g))
    const leaving = [...T.toCarrier((await T.decide(g, 'accept')).outbound), ...L.toCarrier((await L.decide(g, 'accept')).outbound)]
    expect(leaving).toHaveLength(2)
    const refused = await carry(B, [T, L], [T, L], leaving)
    await L.syncFrom(T); await T.syncFrom(L)
    await carry(B, [T, L], [T, L], [])
    await L.syncFrom(T); await T.syncFrom(L)
    expect({ phone: await phase(T, g), laptop: await phase(L, g), atB: await members(B, g) }).toEqual({ phone: 'member', laptop: 'member', atB: 2 })
    expect(refused).toContain('membership-accept/0.2: validation-failed')
  })

  // Both accepts left their devices; the devices hear of each other before
  // the friend answers. Neither may give up its accept for the sister's:
  // which one the friend takes is known only from the welcome.
  for (const first of ['phone', 'laptop'] as const) {
    test(`apart: both accepts leave, the devices sync before delivery, the ${first}'s accept is delivered first: both devices are members`, async () => {
      const { T, L, B, b, g } = await world(first === 'phone' ? 0x6d : 0x6f)
      await carry(B, [T, L], [T, L], await invite(B, b, g))
      const fromPhone = T.toCarrier((await T.decide(g, 'accept')).outbound), fromLaptop = L.toCarrier((await L.decide(g, 'accept')).outbound)
      await L.syncFrom(T); await T.syncFrom(L)
      const cred = Object.keys((await T.P.read()).joining.invites)[0] as string
      expect([T.verdict(cred), L.verdict(cred)].map((v) => (typeof v === 'string' ? v : v.accepts.length))).toEqual([2, 2])
      await carry(B, [T, L], [T, L], first === 'phone' ? [...fromPhone, ...fromLaptop] : [...fromLaptop, ...fromPhone])
      await L.syncFrom(T); await T.syncFrom(L)
      await carry(B, [T, L], [T, L], [])
      await L.syncFrom(T); await T.syncFrom(L)
      expect({ phone: await phase(T, g), laptop: await phase(L, g), atB: await members(B, g) }).toEqual({ phone: 'member', laptop: 'member', atB: 2 })
      expect([T.verdict(cred), L.verdict(cred)].map((v) => (typeof v === 'string' ? v : v.accepts.length))).toEqual([1, 1])
    })
  }

  const credOf = async (D: Device): Promise<string> => Object.keys((await D.P.read()).joining.invites)[0] as string
  // The counter-cases the review of the encounter cut found there (port-experimente#105), for the invitation.
  test('the phone accepted offline, the laptop declined, the phone\'s sync breaks off: at the door the accept does not leave', async () => {
    const { T, L, B, b, g } = await world(0x81)
    await carry(B, [T, L], [T, L], await invite(B, b, g))
    const accepted = await T.decide(g, 'accept')
    await L.decide(g, 'decline')
    const real = T.P.h
    T.P.h = Object.create(real, { prompts: { value: async () => { throw new Error('store unavailable') } }, decide: { value: async () => { throw new Error('store unavailable') } } })
    const snapRead = T.P.read
    T.P.read = async () => { throw new Error('store unavailable') }
    expect((await T.syncFrom(L)).stoppedAt).toMatch(/store unavailable/)
    T.P.h = real; T.P.read = snapRead
    expect(T.verdict(await credOf(T))).toBe('declined')
    expect(T.toCarrier(accepted.outbound).filter((o: any) => o.type.includes('membership-accept'))).toEqual([])
    await carry(B, [T, L], [T, L], [])
    await L.syncFrom(T); await T.syncFrom(L)
    expect({ atB: await members(B, g), verdict: [T.verdict(await credOf(T)), L.verdict(await credOf(L))] }).toEqual({ atB: 1, verdict: ['declined', 'declined'] })
  })

  test('the library refuses the laptop\'s answer for good: the entry is closed, it counts nowhere, and the phone\'s accept leaves', async () => {
    const { T, L, B, b, g } = await world(0x85)
    await carry(B, [T, L], [T, L], await invite(B, b, g))
    const accepted = await T.decide(g, 'accept')
    const real = L.P.h
    L.P.h = Object.create(real, { decide: { value: async () => ({ ok: false, code: 'refused-here' }) } })
    const declined = await L.decide(g, 'decline')
    L.P.h = real
    expect(declined.stoppedAt).toBe(null)
    expect((await T.syncFrom(L)).stoppedAt).toBe(null)
    expect((await L.syncFrom(T)).stoppedAt).toBe(null)
    expect([T.verdict(await credOf(T)), L.verdict(await credOf(L))].map((v) => (typeof v === 'string' ? v : 'accept'))).toEqual(['accept', 'accept'])
    const leaving = T.toCarrier(accepted.outbound)
    expect(leaving.some((o: any) => o.type.includes('membership-accept'))).toBe(true)
    await carry(B, [T, L], [T, L], leaving)
    await L.syncFrom(T); await T.syncFrom(L)
    expect({ phone: await phase(T, g), laptop: await phase(L, g), atB: await members(B, g) }).toEqual({ phone: 'member', laptop: 'member', atB: 2 })
  })

  // Review of #106: a sister sees a running answer and one that took effect apart.
  /** The log of D up to and including entry `id`: what a sync brought that broke off there. */
  const only = (D: Device, id: string): { entries: Device['entries'] } => { const all = [...D.entries]; return { entries: new Map(all.slice(0, all.findIndex(([x]) => x === id) + 1)) } }
  const decidedId = (D: Device): string => [...D.entries.values()].find((e) => e.body.kind === 'decided' && e.id.startsWith(D.name + '#'))!.id
  const refusing = async (L: Device, g: string): Promise<void> => {
    const real = L.P.h
    L.P.h = Object.create(real, { decide: { value: async () => ({ ok: false, code: 'refused-here' }) } })
    await L.decide(g, 'decline')
    L.P.h = real
  }

  test('the phone syncs while the laptop\'s decline is still running, the library then refuses it: the phone\'s accept waited and leaves', async () => {
    const { T, L, B, b, g } = await world(0x89)
    await carry(B, [T, L], [T, L], await invite(B, b, g))
    const accepted = await T.decide(g, 'accept')
    await refusing(L, g)
    const accept = (docs: any[]): number => docs.filter((o: any) => o.type.includes('membership-accept')).length
    // round one: only the laptop's choice has reached the phone
    expect((await T.syncFrom(only(L, decidedId(L)))).stoppedAt).toBe(null)
    expect({ declining: T.declining(await credOf(T)), leaves: accept(T.toCarrier(accepted.outbound)) }).toEqual({ declining: true, leaves: 0 })
    // round two: the library refused the decline
    await T.syncFrom(L); await L.syncFrom(T)
    expect(T.declining(await credOf(T))).toBe(false)
    const leaving = T.toCarrier(accepted.outbound)
    expect(accept(leaving)).toBe(1)
    await carry(B, [T, L], [T, L], leaving)
    await L.syncFrom(T); await T.syncFrom(L)
    expect({ phone: await phase(T, g), laptop: await phase(L, g), atB: await members(B, g) }).toEqual({ phone: 'member', laptop: 'member', atB: 2 })
  })

  test('no competing accept: while the laptop\'s decline is running and after the library refused it, the invitation stays open on the phone with its card', async () => {
    const { T, L, B, b, g } = await world(0x8d)
    await carry(B, [T, L], [T, L], await invite(B, b, g))
    await refusing(L, g)
    const state = async (D: Device): Promise<unknown> => ({ holds: D.verdict(await credOf(D)), card: await card(D, g), status: (await D.P.read()).joining.invites[await credOf(D)].status })
    await T.syncFrom(only(L, decidedId(L)))
    expect({ ...(await state(T) as object), declining: T.declining(await credOf(T)) }).toEqual({ holds: 'open', card: true, status: 'open', declining: true })
    await T.syncFrom(L)
    expect({ ...(await state(T) as object), declining: T.declining(await credOf(T)) }).toEqual({ holds: 'open', card: true, status: 'open', declining: false })
    expect(await state(L)).toEqual(await state(T))
    // and the phone can still answer
    const accepted = await T.decide(g, 'accept')
    await L.syncFrom(T)
    await carry(B, [T, L], [T, L], T.toCarrier(accepted.outbound))
    await L.syncFrom(T); await T.syncFrom(L)
    expect({ phone: await phase(T, g), laptop: await phase(L, g), atB: await members(B, g) }).toEqual({ phone: 'member', laptop: 'member', atB: 2 })
  })

  test('a decline that reaches the phone in two rounds or in one gives the same: what holds, the card, the status in the library, the door', async () => {
    const run = async (fill: number, rounds: 1 | 2, fate: 'took' | 'void'): Promise<unknown> => {
      const { T, L, B, b, g } = await world(fill)
      await carry(B, [T, L], [T, L], await invite(B, b, g))
      const accepted = await T.decide(g, 'accept')
      if (fate === 'void') await refusing(L, g); else await L.decide(g, 'decline')
      if (rounds === 2) { await T.syncFrom(only(L, decidedId(L))); T.toCarrier(accepted.outbound) }
      await T.syncFrom(L)
      const cred = await credOf(T), v = T.verdict(cred)
      return { holds: typeof v === 'string' ? v : 'accept', card: await card(T, g), status: (await T.P.read()).joining.invites[cred].status, declining: T.declining(cred),
        leaves: T.toCarrier(accepted.outbound).filter((o: any) => o.type.includes('membership-accept')).length }
    }
    expect(await run(0x91, 2, 'void')).toEqual(await run(0x95, 1, 'void'))
    expect(await run(0x99, 2, 'took')).toEqual(await run(0x9d, 1, 'took'))
    expect(await run(0xa1, 2, 'void')).toEqual({ holds: 'accept', card: false, status: 'accepted', declining: false, leaves: 1 })
    expect(await run(0xa5, 2, 'took')).toEqual({ holds: 'declined', card: false, status: 'declined', declining: false, leaves: 0 })
  })

  test('the library stores the phone\'s accept and the call breaks off; the phone learns the laptop\'s decline: the accept the library offers again does not leave', async () => {
    const { T, L, B, b, g } = await world(0xa9)
    await carry(B, [T, L], [T, L], await invite(B, b, g))
    const real = T.P.h
    T.P.h = Object.create(real, { decide: { value: async (...a: any[]) => { await real.decide(...a); throw new Error('crash after the commit') } } })
    expect((await T.decide(g, 'accept')).stoppedAt).toMatch(/crash after the commit/)
    T.P.h = real
    const accepts = (docs: any[]): number => docs.filter((o: any) => o.type.includes('membership-accept')).length
    const offered = (await T.P.h.resume(clk(T.P, tick(3600_000)))).outbound   // an hour later the library tries again
    expect({ offered: accepts(offered), leaves: accepts(T.toCarrier(offered)) }).toEqual({ offered: 1, leaves: 0 })
    await L.decide(g, 'decline')
    expect((await T.syncFrom(L)).stoppedAt).toBe(null)
    await L.syncFrom(T)
    await carry(B, [T, L], [T, L], [], 20)
    expect({ atB: await members(B, g), holds: [T.verdict(await credOf(T)), L.verdict(await credOf(L))] }).toEqual({ atB: 1, holds: ['declined', 'declined'] })
  })
})
