import { describe, expect, test } from 'vitest'
import { at, clk, copyOf, ev, met, mk, ok, short, tick, type Person } from '../src/lab/alltag/fixture'
import { Device } from '../src/lab/alltag/invitation'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A with phone and laptop (a copy, clock late); B founded a group and knows A. */
async function world (fill: number): Promise<{ T: Device, L: Device, B: Person, b: any, g: string }> {
  const A = await mk(fill), B = await mk(fill + 1)
  const { b } = await met(A, B)
  const g = ev(ok(await B.h.foundGroup({ name: 'Garden' }, at(B))), 'group.founded')[0].groupId
  return { T: new Device('phone', A), L: new Device('laptop', await copyOf(A)), B, b, g }
}

/** The carrier and the friend: hands documents on until nothing moves.
 *  `reach`: which of A's devices the carrier reaches. Returns what B refused. */
async function carry (B: Person, devices: Device[], reach: Device[], first: any[], rounds = 10): Promise<string[]> {
  const refusedByB: string[] = []
  let toA: any[] = [], toB: any[] = []
  const sort = async (docs: any[]): Promise<void> => {
    for (const o of docs) (Object.hasOwn((await B.read()).addresses.keys, o.envelope.rkid) ? toB : toA).push(o)
  }
  await sort(first)
  for (let r = 0; r < rounds; r++) {
    const t = tick()
    await sort((await B.h.resume(clk(B, t))).outbound)
    for (const D of reach) await sort((await D.P.h.resume(clk(D.P, t))).outbound.filter((o: any) => !D.withheld.some((w) => w.digest === o.digest)))
    if (!toA.length && !toB.length) break
    const [a, b] = [toA, toB]; toA = []; toB = []
    for (const o of b) {
      const got = await B.h.receive(o.envelope, clk(B, t))
      if (got.disposition === 'unique' || got.disposition === 'duplicate-known') await sort(got.outbound)
      else refusedByB.push(`${short(o.type)}: ${got.reason ?? got.disposition}`)
    }
    for (const o of a) for (const D of reach) await sort(await D.receive(o.envelope, t))
    void devices
  }
  return [...new Set(refusedByB)].sort()
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
    const late = await carry(B, [T, L], [T, L], acted.outbound)
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
    const refused = await carry(B, [T, L], [T], acted.outbound)
    const learned = await L.syncFrom(T)
    expect(learned.stoppedAt).toBe(null)
    // the join is taken over; the group's log is not part of the personal log,
    // and the page the phone got answers a request only the phone made
    expect({ phone: await phase(T, g), laptop: await phase(L, g), cardOnLaptop: await card(L, g), atB: await members(B, g), refused, notTaken: [...new Set(L.notTaken)] })
      .toEqual({ phone: 'member', laptop: 'joining', cardOnLaptop: false, atB: 2, refused: [], notTaken: ['x-access-page/0.1: validation-failed'] })
    // the laptop's own request for the log, once the carrier reaches it
    await carry(B, [T, L], [T, L], learned.outbound)
    expect(await phase(L, g)).toBe('member')
  })

  test('apart: the phone accepts, the laptop declines: the issued accept stands on both devices', async () => {
    const { T, L, B, b, g } = await world(0x65)
    await carry(B, [T, L], [T, L], await invite(B, b, g))
    const accepted = await T.decide(g, 'accept')
    const declined = await L.decide(g, 'decline')
    expect([accepted.stoppedAt, declined.stoppedAt]).toEqual([null, null])
    await L.syncFrom(T); await T.syncFrom(L)
    const refused = await carry(B, [T, L], [T, L], accepted.outbound)
    await L.syncFrom(T); await T.syncFrom(L)
    expect({ phone: await phase(T, g), laptop: await phase(L, g), cardOnLaptop: await card(L, g), atB: await members(B, g), refused })
      .toEqual({ phone: 'member', laptop: 'member', cardOnLaptop: false, atB: 2, refused: SECOND_PRODUCER })
  })

  test('apart: both devices accept: one accept reaches the friend, both devices are members', async () => {
    const { T, L, B, b, g } = await world(0x67)
    await carry(B, [T, L], [T, L], await invite(B, b, g))
    const onPhone = await T.decide(g, 'accept')
    const onLaptop = await L.decide(g, 'accept')
    await L.syncFrom(T); await T.syncFrom(L)
    // the log names the accept that stands; only that one is handed to the carrier
    const standing = [...T.entries.values()].filter((e) => e.body.kind === 'issued').map((e) => e.id).sort()[0] as string
    const refused = await carry(B, [T, L], [T, L], standing.startsWith('phone') ? onPhone.outbound : onLaptop.outbound)
    await L.syncFrom(T); await T.syncFrom(L)
    expect({ phone: await phase(T, g), laptop: await phase(L, g), atB: await members(B, g), refused })
      .toEqual({ phone: 'member', laptop: 'member', atB: 2, refused: SECOND_PRODUCER })
  })
})
