import { describe, expect, test } from 'vitest'
import { at, clk, copyOf, ok, short, tick, type Person } from '../src/lab/alltag/fixture'
import { Device, cardOf, first, second } from '../src/lab/alltag/encounter'
import { carry } from '../src/lab/alltag/carrier'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A with phone and laptop (a copy, clock late) and a friend-to-be B. */
async function world (fill: number): Promise<{ T: Device, L: Device, B: Person }> {
  const A = await first(fill), B = await first(fill + 1)
  return { T: new Device('phone', A), L: new Device('laptop', await second(A)), B }
}
const lines = async (P: Person): Promise<string[]> => (await P.h.contacts()).map((c: any) => `${c.displayName} ${c.verification}`)
const ids = async (D: Device): Promise<string[]> => (await D.P.h.contacts()).map((c: any) => c.id).sort()
const request = async (D: Device): Promise<string | undefined> => (await D.P.h.prompts()).find((p: any) => p.kind === 'encounter-confirm')?.contactId
const both = async (T: Device, L: Device): Promise<void> => { await L.syncFrom(T); await T.syncFrom(L) }

/** B shows its card, device D of A scans it, B confirms; the carrier reaches `reach`. */
async function scans (D: Device, B: Person, reach: Device[]): Promise<{ sent: any[], refused: string[] }> {
  const card = cardOf(ok(await B.h.show(at(B, { name: 'Bea' }))))
  const a = await D.act({ act: 'scan', card, name: 'Al' })
  expect(a.stoppedAt).toBe(null)
  const got = await B.h.receive(a.outbound[0].envelope, clk(B, tick()))
  const prompt = (await B.h.prompts()).find((p: any) => p.kind === 'encounter-confirm')
  const d = ok(await B.h.decide(prompt.id, 'accept', at(B)))
  return { sent: a.outbound, refused: await carry(B, [], reach, [...got.outbound, ...d.outbound]) }
}
/** Device D of A shows its card, B scans it; the carrier reaches `reach`. */
async function shows (D: Device, B: Person, reach: Device[], sync?: () => Promise<void>): Promise<string[]> {
  const a = await D.act({ act: 'show', name: 'Al' })
  await sync?.()
  return carry(B, [], reach, ok(await B.h.scan(cardOf(a.result), at(B, { name: 'Bea' }))).outbound)
}

/** Open, as measured: once both devices hold the contact, each issues the
 *  documents that follow an encounter on its own (the continuity probe, the
 *  star, the group star of the personal community) under the number the
 *  other used, and the friend refuses the second. */
const SECOND_PRODUCER = ['continuity-probe/0.1: validation-failed', 'group-star/0.1: validation-failed', 'star/0.2: validation-failed']

describe('what the library does without the layer (measured)', () => {
  test('a sister device cannot open what the scanning device received, and scanning the same card itself makes another contact the friend refuses', async () => {
    const A = await first(0x11), B = await first(0x12)
    const L = await copyOf(A), L2 = await copyOf(A)
    const card = cardOf(ok(await B.h.show(at(B, { name: 'Bea' }))))
    const sc = ok(await A.h.scan(card, at(A, { name: 'Al' })))
    const got = await B.h.receive(sc.outbound[0].envelope, clk(B, tick()))
    const d = ok(await B.h.decide((await B.h.prompts())[0].id, 'accept', at(B)))
    const passedOn = [...got.outbound, ...d.outbound]
    for (const o of passedOn) expect((await A.h.receive(o.envelope, clk(A, tick()))).disposition).toBe('unique')
    // passed on to the laptop: sealed to an address the laptop never derived
    expect(await Promise.all(passedOn.map(async (o) => (await L.h.receive(o.envelope, clk(L, tick()))).reason))).toEqual(['malformed', 'malformed'])
    expect(await L.h.contacts()).toEqual([])
    // the laptop scans the same card itself: another label, another contact id, and the friend takes no second bundle
    const own = ok(await L2.h.scan(card, at(L2, { name: 'Al' })))
    expect((await L2.h.contacts())[0].id).not.toBe((await A.h.contacts())[0].id)
    expect((await B.h.receive(own.outbound[0].envelope, clk(B, tick()))).reason).toBe('consumed-challenge')
  })
})

describe('an encounter through the layer', () => {
  test('the phone scans B\'s card: the laptop holds B under the same id, verified on both sides, and no second bundle leaves', async () => {
    const { T, L, B } = await world(0x21)
    const { sent, refused } = await scans(T, B, [T])
    expect((await L.syncFrom(T)).stoppedAt).toBe(null)
    expect(await ids(L)).toEqual(await ids(T))
    expect({ phone: await lines(T.P), laptop: await lines(L.P), atB: await lines(B) }).toEqual({ phone: ['Bea mutual'], laptop: ['Bea mutual'], atB: ['Al mutual'] })
    // the laptop ran the same act under the same seed and at the act's time: its bundle is the same document, and it stays in the house
    expect(L.withheld.map((o: any) => short(o.type))).toContain('encounter-bundle/0.1')
    expect(L.withheld.find((o: any) => short(o.type) === 'encounter-bundle/0.1').digest).toBe(sent[0].digest)
    expect(refused).toEqual([])
    expect([L.notTaken, T.notTaken]).toEqual([[], []])
    // open: the documents that follow the encounter, from both devices
    expect(await carry(B, [], [T, L], [])).toEqual(SECOND_PRODUCER)
  })

  test('the phone shows its card and B scans it; only the phone is reached: the request stands on the laptop, and the laptop answers it', async () => {
    const { T, L, B } = await world(0x25)
    expect(await shows(T, B, [T])).toEqual([])
    expect(await request(L)).toBe(undefined)
    expect((await L.syncFrom(T)).stoppedAt).toBe(null)
    expect(await request(L)).toBe(await request(T))
    const d = await L.act({ act: 'confirm', contactId: (await request(L))!, choice: 'accept' })
    expect(d.outbound.map((o: any) => short(o.type))).toEqual(['encounter-credential-delivery/0.1'])
    // the friend takes the laptop's credential; what it refuses is what follows the encounter, from the second device
    expect(await carry(B, [], [L], L.toCarrier(d.outbound))).toEqual(SECOND_PRODUCER)
    expect((await T.syncFrom(L)).stoppedAt).toBe(null)
    expect({ phone: await lines(T.P), laptop: await lines(L.P), atB: await lines(B), open: [await request(T), await request(L)] })
      .toEqual({ phone: ['Bea mutual'], laptop: ['Bea mutual'], atB: ['Al mutual'], open: [undefined, undefined] })
    expect(await ids(L)).toEqual(await ids(T))
    // the phone's copy of the same answer is the same document, and it stays in the house
    expect(T.withheld.map((o: any) => short(o.type))).toEqual(['encounter-credential-delivery/0.1'])
    expect(T.withheld[0].digest).toBe(d.outbound[0].digest)
  })

  test('both devices get the request from the carrier, the phone answers: the request closes on the laptop', async () => {
    const { T, L, B } = await world(0x29)
    await shows(T, B, [T, L], async () => { await L.syncFrom(T) })
    expect([await request(T), await request(L)].every(Boolean)).toBe(true)
    const d = await T.act({ act: 'confirm', contactId: (await request(T))!, choice: 'accept' })
    await carry(B, [], [T], T.toCarrier(d.outbound))
    expect(await lines(L.P)).toEqual(['Bea incoming'])
    await both(T, L)
    expect({ laptop: await lines(L.P), open: await request(L), atB: await lines(B) }).toEqual({ laptop: ['Bea mutual'], open: undefined, atB: ['Al mutual'] })
  })

  test('the request reaches the laptop before the laptop learns that the phone showed a card: it opens once the show is here and the carrier brings it again', async () => {
    const { T, L, B } = await world(0x2d)
    await shows(T, B, [L])
    expect(await request(L)).toBe(undefined)                 // sealed to an address the laptop has not derived yet
    await L.syncFrom(T)
    expect(await request(L)).toBe(undefined)                 // the refused copy is gone; the entry of the show is applied
    await carry(B, [], [L], [], 20)                          // the friend's library sends again
    expect(await request(L)).toBeTruthy()
  })

  test('apart: both devices accept the request: one relationship on every side', async () => {
    const { T, L, B } = await world(0x31)
    await shows(T, B, [T]); await L.syncFrom(T)
    const [d1, d2] = [await T.act({ act: 'confirm', contactId: (await request(T))!, choice: 'accept' }), await L.act({ act: 'confirm', contactId: (await request(L))!, choice: 'accept' })]
    expect(d1.outbound[0].digest).not.toBe(d2.outbound[0].digest)
    const refused = await carry(B, [], [T, L], [...T.toCarrier(d1.outbound), ...L.toCarrier(d2.outbound)])
    const [s1, s2] = [await L.syncFrom(T), await T.syncFrom(L)]
    expect([s1.stoppedAt, s2.stoppedAt]).toEqual([null, null])
    expect({ phone: await lines(T.P), laptop: await lines(L.P), atB: await lines(B) }).toEqual({ phone: ['Bea mutual'], laptop: ['Bea mutual'], atB: ['Al mutual'] })
    expect((await B.h.contacts())[0].relationships).toHaveLength(1)
    // the friend takes both credentials; what it refuses is what follows the encounter
    expect(refused).toEqual(SECOND_PRODUCER)
  })

  test('apart: the phone accepts and its accept leaves, the laptop declines: the accept stands on both devices', async () => {
    const { T, L, B } = await world(0x35)
    await shows(T, B, [T]); await L.syncFrom(T)
    const d1 = await T.act({ act: 'confirm', contactId: (await request(T))!, choice: 'accept' })
    const d2 = await L.act({ act: 'confirm', contactId: (await request(L))!, choice: 'decline' })
    expect(d2.outbound).toEqual([])                          // a decline is no document
    await carry(B, [], [T], T.toCarrier(d1.outbound))
    expect(await lines(L.P)).toEqual(['Bea incoming'])
    await both(T, L)
    expect({ phone: await lines(T.P), laptop: await lines(L.P), atB: await lines(B), open: await request(L) })
      .toEqual({ phone: ['Bea mutual'], laptop: ['Bea mutual'], atB: ['Al mutual'], open: undefined })
    expect([T.stuck, L.stuck]).toEqual([[], []])
  })

  test('apart: the phone accepts offline and the accept has not left it; the laptop declines: nothing reaches the friend (open: the phone keeps showing the contact as verified)', async () => {
    const { T, L, B } = await world(0x39)
    await shows(T, B, [T]); await L.syncFrom(T)
    const contactId = (await request(T))!
    const d1 = await T.act({ act: 'confirm', contactId, choice: 'accept' })
    await L.act({ act: 'confirm', contactId, choice: 'decline' })
    await both(T, L)
    expect(T.toCarrier(d1.outbound)).toEqual([])
    await carry(B, [], [T, L], [])
    await both(T, L)
    expect({ laptop: await lines(L.P), atB: await lines(B), open: [await request(T), await request(L)] }).toEqual({ laptop: ['Bea incoming'], atB: ['Al outgoing'], open: [undefined, undefined] })
    // measured, not wanted: the library cannot take an accept back
    expect(await lines(T.P)).toEqual(['Bea mutual'])
    expect(T.stuck).toEqual([`${contactId}: accepted here, the decline holds; the library cannot take the accept back`])
  })

  test('the laptop declines before the phone looks: the request closes on the phone, nothing reaches the friend', async () => {
    const { T, L, B } = await world(0x3d)
    await shows(T, B, [T]); await L.syncFrom(T)
    await L.act({ act: 'confirm', contactId: (await request(L))!, choice: 'decline' })
    await both(T, L)
    await carry(B, [], [T, L], [])
    expect({ phone: await lines(T.P), laptop: await lines(L.P), atB: await lines(B), open: [await request(T), await request(L)] })
      .toEqual({ phone: ['Bea incoming'], laptop: ['Bea incoming'], atB: ['Al outgoing'], open: [undefined, undefined] })
  })

  test('apart: the phone meets B, the laptop meets C: both devices hold both under the same ids', async () => {
    const { T, L, B } = await world(0x41)
    const C = await first(0x43)
    await scans(T, B, [T])
    await scans(L, C, [L])
    expect([(await ids(T)).length, (await ids(L)).length]).toEqual([1, 1])
    const [s1, s2] = [await L.syncFrom(T), await T.syncFrom(L)]
    expect([s1.stoppedAt, s2.stoppedAt]).toEqual([null, null])
    expect((await ids(T)).length).toBe(2)
    expect(await ids(L)).toEqual(await ids(T))
    expect((await lines(T.P)).sort()).toEqual(['Bea mutual', 'Bea mutual'])
    expect((await lines(L.P)).sort()).toEqual(['Bea mutual', 'Bea mutual'])
    expect([await lines(B), await lines(C)]).toEqual([['Al mutual'], ['Al mutual']])
  })

  test('applying the entry of a scan breaks off on the laptop: it stays open, the next sync applies it, one contact', async () => {
    const { T, L, B } = await world(0x45)
    await scans(T, B, [T])
    const h = L.P.h
    L.P.h = { ...h, scan: async () => { throw new Error('crash') }, prompts: h.prompts, contact: h.contact, contacts: h.contacts, receive: h.receive, show: h.show, decide: h.decide }
    expect((await L.syncFrom(T)).stoppedAt).toMatch(/crash/)
    expect(await ids(L)).toEqual([])
    L.P.h = h
    expect((await L.syncFrom(T)).stoppedAt).toBe(null)
    expect((await L.syncFrom(T)).stoppedAt).toBe(null)
    expect(await ids(L)).toEqual(await ids(T))
    expect(await lines(L.P)).toEqual(['Bea mutual'])
  })

  test('the laptop catches up a day after the phone met B: it holds the encounter at the time it took place, verified like the phone', async () => {
    const { T, L, B } = await world(0x4d)
    await scans(T, B, [T])
    const s1 = await L.syncFrom(T, tick(24 * 3600 * 1000))
    expect(s1.stoppedAt).toBe(null)
    expect({ phone: await lines(T.P), laptop: await lines(L.P), atB: await lines(B) }).toEqual({ phone: ['Bea mutual'], laptop: ['Bea mutual'], atB: ['Al mutual'] })
    expect(await ids(L)).toEqual(await ids(T))
    expect(L.notTaken).toEqual([])
  })

  test('the phone accepted offline, the laptop declined, the phone\'s sync breaks off: the phone knows the decline, and its accept does not leave', async () => {
    const { T, L, B } = await world(0x51)
    await shows(T, B, [T]); await L.syncFrom(T)
    const contactId = (await request(T))!
    const d1 = await T.act({ act: 'confirm', contactId, choice: 'accept' })
    await L.act({ act: 'confirm', contactId, choice: 'decline' })
    // the phone learns the decline, but applying it breaks off before anything is settled
    const h = T.P.h
    T.P.h = { ...h, contact: async () => { throw new Error('crash') } }
    expect((await T.syncFrom(L)).stoppedAt).toBe('laptop#2: crash')   // while taking over that the decline took effect
    T.P.h = h
    expect(T.verdict(contactId)!.body.choice).toBe('decline')
    // at the door the rule is asked again: nothing leaves, and no handover is recorded
    expect(T.toCarrier(d1.outbound)).toEqual([])
    expect([...T.entries.values()].some((e) => e.body.kind === 'handed')).toBe(false)
    await carry(B, [], [T, L], [])
    await both(T, L)
    expect(await lines(B)).toEqual(['Al outgoing'])
    expect(T.verdict(contactId)!.body.choice).toBe('decline')
  })

  test('the library refuses the laptop\'s decline: it had no effect and counts nowhere, the phone\'s accept leaves', async () => {
    const { T, L, B } = await world(0x5d)
    await shows(T, B, [T]); await L.syncFrom(T)
    const contactId = (await request(T))!
    const d1 = await T.act({ act: 'confirm', contactId, choice: 'accept' })
    const h = L.P.h
    L.P.h = { ...h, decide: async () => ({ ok: false, code: 'refused-here' }) }
    const d2 = await L.act({ act: 'confirm', contactId, choice: 'decline' })
    L.P.h = h
    expect({ stoppedAt: d2.stoppedAt, refused: L.refused }).toEqual({ stoppedAt: null, refused: ['laptop#1: refused-here'] })
    expect([...L.entries.values()].some((e) => e.body.kind === 'void' && e.body.cause === 'laptop#1')).toBe(true)
    // the one evaluation: on the laptop and, after the sync, on the phone, the refused decline is no answer
    expect(L.verdict(contactId)).toBe(null)
    expect((await T.syncFrom(L)).stoppedAt).toBe(null)
    expect(T.verdict(contactId)!.body.choice).toBe('accept')
    const leaving = T.toCarrier(d1.outbound)
    expect(leaving.map((o: any) => short(o.type))).toEqual(['encounter-credential-delivery/0.1'])
    await carry(B, [], [T], leaving)
    await both(T, L)
    expect({ phone: await lines(T.P), laptop: await lines(L.P), atB: await lines(B), open: await request(L) })
      .toEqual({ phone: ['Bea mutual'], laptop: ['Bea mutual'], atB: ['Al mutual'], open: undefined })
  })

  test('open, as measured: the laptop was active itself the next day before it catches up: the earlier encounter stays unverified on it, and the sync says so', async () => {
    const { T, L, B } = await world(0x61)
    await scans(T, B, [T])
    // the laptop's own act a day later moves its time past the encounter
    await L.act({ act: 'show', name: 'Al' }, tick(24 * 3600 * 1000))
    expect((await L.syncFrom(T)).stoppedAt).toBe(null)
    await carry(B, [], [T, L], [], 20); await both(T, L)
    // the library never lets a holder's time fall: the laptop holds the ceremony at its own later time, and the
    // friend's credential from the day before does not fit it. The library takes it without effect.
    expect({ phone: await lines(T.P), laptop: await lines(L.P), atB: await lines(B) }).toEqual({ phone: ['Bea mutual'], laptop: ['Bea outgoing'], atB: ['Al mutual'] })
    expect(await ids(L)).toEqual(await ids(T))
    expect(L.notTaken).toContain('encounter-credential-delivery/0.1: taken without effect')
  })

  // Review of #105/#106: a sister sees a running answer and one that took effect apart.
  const only = (D: Device, ...ids: string[]): { entries: Device['entries'] } => ({ entries: new Map([...D.entries].filter(([id]) => ids.includes(id))) })

  test('the phone syncs while the laptop\'s decline is still running, the library then refuses it: the phone\'s accept waited and leaves', async () => {
    const { T, L, B } = await world(0x65)
    await shows(T, B, [T]); await L.syncFrom(T)
    const contactId = (await request(T))!
    const d1 = await T.act({ act: 'confirm', contactId, choice: 'accept' })
    const h = L.P.h
    L.P.h = { ...h, decide: async () => ({ ok: false, code: 'refused-here' }) }
    await L.act({ act: 'confirm', contactId, choice: 'decline' })
    L.P.h = h
    // round one: only the laptop's choice has reached the phone
    expect((await T.syncFrom(only(L, 'laptop#1'))).stoppedAt).toBe(null)
    expect({ holds: T.verdict(contactId)!.body.choice, declining: T.declining(contactId), leaves: T.toCarrier(d1.outbound) }).toEqual({ holds: 'accept', declining: true, leaves: [] })
    // round two: the library refused the decline
    expect((await T.syncFrom(L)).stoppedAt).toBe(null)
    expect({ holds: T.verdict(contactId)!.body.choice, declining: T.declining(contactId) }).toEqual({ holds: 'accept', declining: false })
    const leaving = T.toCarrier(d1.outbound)
    expect(leaving.map((o: any) => short(o.type))).toEqual(['encounter-credential-delivery/0.1'])
    await carry(B, [], [T], leaving); await both(T, L)
    expect({ phone: await lines(T.P), laptop: await lines(L.P), atB: await lines(B) }).toEqual({ phone: ['Bea mutual'], laptop: ['Bea mutual'], atB: ['Al mutual'] })
  })

  test('a decline that reaches the phone in two rounds or in one gives the same: what holds, the request on the phone, the door', async () => {
    const run = async (fill: number, rounds: 1 | 2, fate: 'took' | 'void'): Promise<unknown> => {
      const { T, L, B } = await world(fill)
      await shows(T, B, [T]); await L.syncFrom(T)
      const contactId = (await request(T))!
      const d1 = await T.act({ act: 'confirm', contactId, choice: 'accept' })
      const h = L.P.h
      if (fate === 'void') L.P.h = { ...h, decide: async () => ({ ok: false, code: 'refused-here' }) }
      await L.act({ act: 'confirm', contactId, choice: 'decline' })
      L.P.h = h
      if (rounds === 2) { await T.syncFrom(only(L, 'laptop#1')); T.toCarrier(d1.outbound) }
      await T.syncFrom(L)
      return { holds: T.verdict(contactId)!.body.choice, declining: T.declining(contactId), leaves: T.toCarrier(d1.outbound).length, phone: await lines(T.P) }
    }
    expect(await run(0x69, 2, 'void')).toEqual(await run(0x6d, 1, 'void'))
    expect(await run(0x71, 2, 'took')).toEqual(await run(0x75, 1, 'took'))
    expect(await run(0x79, 2, 'void')).toEqual({ holds: 'accept', declining: false, leaves: 1, phone: ['Bea mutual'] })
    expect(await run(0x7d, 2, 'took')).toEqual({ holds: 'decline', declining: false, leaves: 0, phone: ['Bea mutual'] })
  })

  test('no competing accept: while the laptop\'s decline is running and after the library refused it, the request stays open on the phone', async () => {
    const { T, L, B } = await world(0x81)
    await shows(T, B, [T]); await L.syncFrom(T)
    const contactId = (await request(T))!
    const h = L.P.h
    L.P.h = { ...h, decide: async () => ({ ok: false, code: 'refused-here' }) }
    await L.act({ act: 'confirm', contactId, choice: 'decline' })
    L.P.h = h
    await T.syncFrom(only(L, 'laptop#1'))
    expect({ holds: T.verdict(contactId), declining: T.declining(contactId), open: await request(T) }).toEqual({ holds: null, declining: true, open: contactId })
    await T.syncFrom(L)
    expect({ holds: T.verdict(contactId), declining: T.declining(contactId), open: await request(T), laptop: await request(L) }).toEqual({ holds: null, declining: false, open: contactId, laptop: contactId })
  })

  test('the library stores the phone\'s accept and the call breaks off; the phone learns the laptop\'s decline: the credential the library offers again does not leave', async () => {
    const { T, L, B } = await world(0x85)
    await shows(T, B, [T]); await L.syncFrom(T)
    const contactId = (await request(T))!
    const h = T.P.h
    T.P.h = { ...h, decide: async (...a: any[]) => { await h.decide(...a); throw new Error('crash after the commit') } }
    expect((await T.act({ act: 'confirm', contactId, choice: 'accept' })).stoppedAt).toMatch(/crash after the commit/)
    T.P.h = h
    // the library holds the credential in its outbox; the layer has no note yet whose it is
    const offered = (await T.P.h.resume(clk(T.P, tick(3600_000)))).outbound   // an hour later the library tries again
    expect(offered.map((o: any) => short(o.type))).toContain('encounter-credential-delivery/0.1')
    expect(T.toCarrier(offered).map((o: any) => short(o.type))).not.toContain('encounter-credential-delivery/0.1')
    await L.act({ act: 'confirm', contactId, choice: 'decline' })
    expect((await T.syncFrom(L)).stoppedAt).toBe(null)
    expect(T.verdict(contactId)!.body.choice).toBe('decline')
    await carry(B, [], [T, L], [], 20); await both(T, L)
    expect(await lines(B)).toEqual(['Al outgoing'])
  })

  test('the same break without a decline only delays the accept: the next application completes the act and the credential leaves', async () => {
    const { T, L, B } = await world(0x89)
    await shows(T, B, [T]); await L.syncFrom(T)
    const contactId = (await request(T))!
    const h = T.P.h
    T.P.h = { ...h, decide: async (...a: any[]) => { await h.decide(...a); throw new Error('crash after the commit') } }
    await T.act({ act: 'confirm', contactId, choice: 'accept' })
    T.P.h = h
    await carry(B, [], [T, L], [], 20); await both(T, L)
    expect({ phone: await lines(T.P), laptop: await lines(L.P), atB: await lines(B) }).toEqual({ phone: ['Bea mutual'], laptop: ['Bea mutual'], atB: ['Al mutual'] })
    expect([...T.entries.values()].filter((e) => e.body.kind === 'took')).toHaveLength(1)
  })

  test('apart: both accepts left their devices; the one counted first is not delivered: the other is still free to leave again', async () => {
    const { T, L, B } = await world(0x8d)
    await shows(T, B, [T]); await L.syncFrom(T)
    const contactId = (await request(T))!
    const [d1, d2] = [await T.act({ act: 'confirm', contactId, choice: 'accept' }), await L.act({ act: 'confirm', contactId, choice: 'accept' })]
    expect([T.toCarrier(d1.outbound).length, L.toCarrier(d2.outbound).length]).toEqual([1, 1])   // both left, neither arrived
    await both(T, L)
    expect([T.verdict(contactId)!.id, L.verdict(contactId)!.id]).toEqual(['laptop#1', 'laptop#1'])
    // the phone's accept is not the one counted first, but it left: the library's repeat goes through the door
    expect(T.toCarrier(d1.outbound).map((o: any) => short(o.type))).toEqual(['encounter-credential-delivery/0.1'])
    await carry(B, [], [T], T.toCarrier(d1.outbound)); await both(T, L)
    expect({ phone: await lines(T.P), laptop: await lines(L.P), atB: await lines(B) }).toEqual({ phone: ['Bea mutual'], laptop: ['Bea mutual'], atB: ['Al mutual'] })
  })

  test('two acts entered at once on one device: each draws from its own seed, the laptop derives the same two cards', async () => {
    const { T, L } = await world(0x91)
    const [a, b] = await Promise.all([T.act({ act: 'show', name: 'Al' }), T.act({ act: 'show', name: 'Al' })])
    expect([a.stoppedAt, b.stoppedAt]).toEqual([null, null])
    expect((await L.syncFrom(T)).stoppedAt).toBe(null)
    const cards = (D: Device): string[] => ['phone#1', 'phone#2'].map((id) => JSON.stringify(cardOf(D.results.get(id))))
    expect(cards(L)).toEqual(cards(T))
    expect(cards(T)[0]).not.toBe(cards(T)[1])
  })

  test('the time and the seed of an act are the layer\'s: a caller cannot set them', async () => {
    const { T } = await world(0x95)
    await T.act({ act: 'show', name: 'Al', when: 0, seed: 'x', kind: 'received' } as any)
    const e = [...T.entries.values()][0]!.body as any
    expect({ kind: e.kind, seeded: e.seed.length, later: e.when > 0 }).toEqual({ kind: 'act', seeded: 64, later: true })
  })

  test('a card the library refuses for good: the act is closed as refused, a later act runs, and the laptop does not hang on it', async () => {
    const { T, L, B } = await world(0x55)
    const good = cardOf(ok(await B.h.show(at(B, { name: 'Bea' }))))
    const bad = await T.act({ act: 'scan', card: { ...good, name: 'Mallory' }, name: 'Al' })
    expect({ ok: bad.result.ok, code: bad.result.code, stoppedAt: bad.stoppedAt }).toEqual({ ok: false, code: 'card-invalid', stoppedAt: null })
    expect(T.refused).toEqual(['phone#1: card-invalid'])
    // a later, valid act is not held up
    const shown = await T.act({ act: 'show', name: 'Al' })
    expect(shown.stoppedAt).toBe(null)
    expect(cardOf(shown.result)).toBeTruthy()
    // the laptop learns that nothing happened and goes on to the show
    expect((await L.syncFrom(T)).stoppedAt).toBe(null)
    expect(L.refused).toEqual([])
    await carry(B, [], [T, L], ok(await B.h.scan(cardOf(shown.result), at(B, { name: 'Bea' }))).outbound)
    expect([await request(T), await request(L)].every(Boolean)).toBe(true)
    expect(await ids(L)).toEqual(await ids(T))
  })

  test('a step that breaks off is tried again, a refusal is not: the laptop meets the refused act before it knows the phone was refused', async () => {
    const { T, L, B } = await world(0x59)
    const good = cardOf(ok(await B.h.show(at(B, { name: 'Bea' }))))
    await T.act({ act: 'scan', card: { ...good, name: 'Mallory' }, name: 'Al' })
    // only the act entry reaches the laptop, not yet the note that it was refused
    const act = [...T.entries.values()].find((e) => e.body.kind === 'act')!
    const partial = new Device('phone', T.P); partial.entries.set(act.id, act)
    expect((await L.syncFrom(partial)).stoppedAt).toBe(null)
    expect(L.refused).toEqual(['phone#1: card-invalid'])     // the library's own verdict, the same on this device
    expect((await L.syncFrom(T)).stoppedAt).toBe(null)
    expect(await ids(L)).toEqual([])
  })

  test('open, as measured: B meets the phone and later, apart, the laptop: the phone ends with one line, the laptop with two, the friend with one or two', async () => {
    const { T, L, B } = await world(0x49)
    await scans(T, B, [T])
    await scans(L, B, [L])
    expect((await lines(B)).length).toBe(2)                   // two relationships until continuity joins them
    await both(T, L)
    await carry(B, [], [T, L], [], 30)
    await both(T, L)
    expect({ phone: (await ids(T)).length, laptop: (await ids(L)).length }).toEqual({ phone: 1, laptop: 2 })
    // Depends on chance (the fresh labels): in 20 runs the friend joined the two relationships 10 times and kept two
    // 10 times. In both branches the laptop refuses the friend's mapping: it answers the probe of the other device.
    expect([1, 2]).toContain((await lines(B)).length)
    expect(L.notTaken.length).toBeGreaterThan(0)
    expect([...new Set(L.notTaken)]).toEqual(['continuity-mapping/0.1: validation-failed'])
  })
})
