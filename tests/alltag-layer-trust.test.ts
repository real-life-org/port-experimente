import { describe, expect, test } from 'vitest'
import { at, clk, ok, short, tick, type Person } from '../src/lab/alltag/fixture'
import { Device as Enc, cardOf, first, second } from '../src/lab/alltag/encounter'
import { Device } from '../src/lab/alltag/trust'
import { carry } from '../src/lab/alltag/carrier'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A and B met and are verified on both sides; then A has phone and laptop (a copy, clock late). */
async function world (fill: number): Promise<{ T: Device, L: Device, B: Person, a: string, b: string }> {
  const A = await first(fill), B = await first(fill + 1)
  const setup = new Enc('setup', A)
  const scanned = await setup.act({ act: 'scan', card: cardOf(ok(await B.h.show(at(B, { name: 'Bea' })))), name: 'Al' })
  const got = await B.h.receive(scanned.outbound[0].envelope, clk(B, tick()))
  const d = ok(await B.h.decide((await B.h.prompts())[0].id, 'accept', at(B)))
  await carry(B, [], [setup], [...got.outbound, ...d.outbound], 20)
  return { T: new Device('phone', A), L: new Device('laptop', await second(A)), B, a: (await A.h.contacts())[0].id, b: (await B.h.contacts())[0].id }
}
const trust = async (P: Person, id: string): Promise<string> => { const t = (await P.h.contact(id)).trust; return `given ${t.given}, received ${t.received}` }
const mapping = (docs: any[]): string[] => docs.filter((o) => short(o.type).startsWith('anchor-mapping/')).map((o) => o.digest)
const both = async (T: Device, L: Device): Promise<void> => { await L.syncFrom(T); await T.syncFrom(L) }

describe('trust through the layer', () => {
  test('the phone gives trust: it holds on the laptop, the friend sees one effect, and nobody refuses anything', async () => {
    const { T, L, B, a, b } = await world(0x21)
    const given = await T.act('trust', a)
    expect(given.stoppedAt).toBe(null)
    expect((await L.syncFrom(T)).stoppedAt).toBe(null)
    // the anchor mapping the library issues after the act is the same document on both devices
    expect(mapping(given.outbound)).toHaveLength(1)
    expect(mapping(L.withheld)).toEqual(mapping(given.outbound))
    const refused = await carry(B, [], [T, L], T.toCarrier(given.outbound), 20)
    await both(T, L)
    expect({ phone: await trust(T.P, a), laptop: await trust(L.P, a), atB: await trust(B, b), refused, notTaken: [T.notTaken, L.notTaken] })
      .toEqual({ phone: 'given true, received false', laptop: 'given true, received false', atB: 'given false, received true', refused: [], notTaken: [[], []] })
  })

  test('the friend gives trust, only the phone is reached: the laptop learns it, and the star that follows is one document', async () => {
    const { T, L, B, a, b } = await world(0x25)
    const refused = await carry(B, [], [T], ok(await B.h.trust(b, at(B))).outbound, 20)
    expect([await trust(T.P, a), await trust(L.P, a)]).toEqual(['given false, received true', 'given false, received false'])
    expect((await L.syncFrom(T)).stoppedAt).toBe(null)
    expect(await trust(L.P, a)).toBe('given false, received true')
    expect([refused, await carry(B, [], [T, L], [], 20), L.notTaken]).toEqual([[], [], []])
  })

  test('the phone withdraws trust: it is withdrawn on the laptop, nobody refuses anything', async () => {
    const { T, L, B, a } = await world(0x29)
    await carry(B, [], [T], T.toCarrier((await T.act('trust', a)).outbound), 20); await both(T, L)
    const withdrawn = await T.act('untrust', a)
    await L.syncFrom(T)
    const refused = await carry(B, [], [T, L], T.toCarrier(withdrawn.outbound), 20)
    expect({ phone: await trust(T.P, a), laptop: await trust(L.P, a), refused }).toEqual({ phone: 'given false, received false', laptop: 'given false, received false', refused: [] })
  })

  test('applying the phone\'s act breaks off on the laptop after the library took it: the next sync completes it with the same document', async () => {
    const { T, L, B, a } = await world(0x2d)
    const given = await T.act('trust', a)
    const h = L.P.h
    L.P.h = { ...h, resume: async () => { throw new Error('crash') } }
    expect((await L.syncFrom(T)).stoppedAt).toBe('phone#1: crash')
    L.P.h = h
    expect((await L.syncFrom(T)).stoppedAt).toBe(null)
    expect(mapping(L.withheld)).toEqual(mapping(given.outbound))
    expect(await carry(B, [], [T, L], T.toCarrier(given.outbound), 20)).toEqual([])
  })

  test('taking the friend\'s trust breaks off on the phone before what follows is issued: the entry stays open, and the star is still one document', async () => {
    const { T, L, B, a, b } = await world(0x3d)
    ok(await B.h.trust(b, at(B)))
    const docs = (await B.h.resume(clk(B, tick()))).outbound   // the friend's mapping comes from its library's own turn
    const theirs = docs.find((o: any) => short(o.type) === 'anchor-mapping/0.3')
    const h = T.P.h
    T.P.h = { ...h, resume: async () => { throw new Error('crash') } }
    const answers = await T.receive(theirs.envelope)
    T.P.h = h
    expect([...T.entries.values()].map((e) => e.body.kind)).toEqual(['received'])
    expect(await trust(T.P, a)).toBe('given false, received true')   // the library took the document; what follows is still owed
    await carry(B, [], [], answers)
    expect((await T.syncFrom(T)).stoppedAt).toBe(null)       // the next call completes the entry
    await L.syncFrom(T)
    expect([await trust(T.P, a), await trust(L.P, a)]).toEqual(['given false, received true', 'given false, received true'])
    expect(await carry(B, [], [T, L], [], 20)).toEqual([])
  })

  test('open, as measured: apart, both devices give trust: one effect at the friend, the devices agree, the friend refuses the second mapping', async () => {
    const { T, L, B, a, b } = await world(0x31)
    const [t, l] = [await T.act('trust', a), await L.act('trust', a)]
    expect(mapping(t.outbound)).not.toEqual(mapping(l.outbound))   // two acts, two documents under the same number
    const refused = await carry(B, [], [T, L], [...T.toCarrier(t.outbound), ...L.toCarrier(l.outbound)], 20)
    await both(T, L)
    expect({ phone: await trust(T.P, a), laptop: await trust(L.P, a), atB: await trust(B, b) })
      .toEqual({ phone: 'given true, received false', laptop: 'given true, received false', atB: 'given false, received true' })
    // each device meets the sister's act when the trust is already given: the library refuses it, the entry is closed
    expect([T.refused, L.refused]).toEqual([['laptop#1: already-given'], ['phone#1: already-given']])
    expect(refused).toEqual(['anchor-mapping/0.3: validation-failed'])
  })

  test('open, as measured: the friend\'s trust reaches both devices from the carrier: each issues the star that follows at its own time', async () => {
    const { T, L, B, a, b } = await world(0x35)
    const refused = await carry(B, [], [T, L], ok(await B.h.trust(b, at(B))).outbound, 20)
    await both(T, L)
    expect([await trust(T.P, a), await trust(L.P, a)]).toEqual(['given false, received true', 'given false, received true'])
    expect(refused).toEqual(['star/0.2: validation-failed'])
  })

  test('open, as measured: the laptop was active itself the next day before it learns of the trust: its mapping is another document', async () => {
    const { T, L, B, a } = await world(0x39)
    const given = await T.act('trust', a)
    await carry(B, [], [T], T.toCarrier(given.outbound), 20)
    await L.resume(tick(24 * 3600 * 1000))                   // the laptop's own turn a day later moves its time on
    await L.syncFrom(T)
    expect(await trust(L.P, a)).toBe('given true, received false')
    expect(mapping(L.withheld)).not.toEqual(mapping(given.outbound))
  })
})
