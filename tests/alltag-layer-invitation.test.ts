import { describe, expect, test } from 'vitest'
import { at, copyOf, ev, met, mk, ok, type Person } from '../src/lab/alltag/fixture'
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
})
