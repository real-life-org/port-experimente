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
    let broke = false
    T.P.h = new Proxy(h, { get: (o, k) => (k === 'contact' && !broke ? async () => { broke = true; throw new Error('crash') } : o[k]) })
    expect((await T.syncFrom(L)).stoppedAt).toMatch(/crash/)
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
