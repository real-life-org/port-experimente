import { describe, expect, test } from 'vitest'
import { at, clk, copyOf, met, mk, ok, tick, type Person } from '../src/lab/alltag/fixture'
import { Device, handTo } from '../src/lab/alltag/layer'

/* eslint-disable @typescript-eslint/no-explicit-any */
const DAY = 86_400_000

/** A with phone and laptop (a copy, clock late), friend B; they met before the copy. */
async function world (fill: number): Promise<{ T: Device, L: Device, B: Person, a: any, b: any }> {
  const A = await mk(fill), B = await mk(fill + 1)
  const { a, b } = await met(A, B)
  return { T: new Device('phone', A), L: new Device('laptop', await copyOf(A)), B, a, b }
}
const texts = (D: Device): string[] => [...D.conversation.values()].map((l) => `${l.dir}:${l.text}`).sort()
const inbox = async (D: Device): Promise<number> => (await D.P.h.inbox()).length
/** B writes; returns the document for the carrier. */
const written = async (B: Person, b: any, text: string): Promise<any> => ok(await B.h.sendMessage(b.id, text, at(B))).outbound[0]
const status = async (B: Person, doc: any): Promise<string> => (await B.h.deliveryStatus(doc.digest)).items[0]?.status

describe('messages through the layer: one conversation on both devices, each message once', () => {
  test('both devices get the message from the carrier, the phone reads it', async () => {
    const { T, L, B, b } = await world(0x41)
    const doc = await written(B, b, 'hello')
    const acks = [...(await T.receive(doc.envelope)), ...(await L.receive(doc.envelope))]
    await T.takeAll()
    await L.syncFrom(T); await T.syncFrom(L)
    const { verdicts } = await handTo(B, acks)
    expect([texts(T), texts(L)]).toEqual([['in:hello'], ['in:hello']])
    expect([await inbox(T), await inbox(L)]).toEqual([0, 0])
    expect(verdicts.filter((v) => v.includes('failed'))).toEqual([])
    expect(await status(B, doc)).toBe('delivered')
  })

  test('only the phone gets it from the carrier and reads it; the laptop learns it from the phone', async () => {
    const { T, L, B, b } = await world(0x43)
    const doc = await written(B, b, 'hello')
    const acks = await T.receive(doc.envelope)
    await T.takeAll()
    acks.push(...(await L.syncFrom(T)).outbound)
    const { verdicts } = await handTo(B, acks)
    expect([texts(T), texts(L)]).toEqual([['in:hello'], ['in:hello']])
    expect([await inbox(T), await inbox(L)]).toEqual([0, 0])
    expect(verdicts.filter((v) => v.includes('failed'))).toEqual([])
  })

  test('the laptop learns "read" from the phone before the carrier brings it the message', async () => {
    const { T, L, B, b } = await world(0x45)
    const doc = await written(B, b, 'hello')
    await T.receive(doc.envelope)
    await T.takeAll()
    await L.syncFrom(T)
    await L.receive(doc.envelope)             // the carrier is late
    expect(texts(L)).toEqual(['in:hello'])
    expect(await inbox(L)).toBe(0)
  })

  test('the laptop was off for 30 days and gets both the carrier\'s copy and the phone\'s entries, in either order', async () => {
    for (const carrierFirst of [true, false]) {
      const { T, L, B, b } = await world(carrierFirst ? 0x47 : 0x49)
      const doc = await written(B, b, 'hello')
      await T.receive(doc.envelope)
      await T.takeAll()
      const later = tick(30 * DAY)
      if (carrierFirst) { await L.receive(doc.envelope, later); await L.syncFrom(T, later) } else { await L.syncFrom(T, later); await L.receive(doc.envelope, later) }
      expect(texts(L), `carrier first: ${carrierFirst}`).toEqual(['in:hello'])
      expect(await inbox(L), `carrier first: ${carrierFirst}`).toBe(0)
    }
  })

  test('both devices read the same message apart', async () => {
    const { T, L, B, b } = await world(0x4b)
    const doc = await written(B, b, 'hello')
    await T.receive(doc.envelope); await L.receive(doc.envelope)
    await T.takeAll(); await L.takeAll()
    await L.syncFrom(T); await T.syncFrom(L)
    expect([texts(T), texts(L)]).toEqual([['in:hello'], ['in:hello']])
    expect([await inbox(T), await inbox(L)]).toEqual([0, 0])
  })

  test('A writes from the phone and from the laptop apart: both devices show the whole conversation, B gets both', async () => {
    const { T, L, B, a } = await world(0x4d)
    const out = [...(await T.send(a.id, 'from the phone')), ...(await L.send(a.id, 'from the laptop'))]
    await L.syncFrom(T); await T.syncFrom(L)
    const { verdicts } = await handTo(B, out)
    expect(verdicts.filter((v) => v.includes('failed'))).toEqual([])
    expect((await B.h.inbox()).map((m: any) => m.text).sort()).toEqual(['from the laptop', 'from the phone'])
    expect([texts(T), texts(L)]).toEqual([['out:from the laptop', 'out:from the phone'], ['out:from the laptop', 'out:from the phone']])
  })

  test('a sync that breaks off leaves the entry open: the next sync brings the message', async () => {
    const { T, L, B, b } = await world(0x51)
    const doc = await written(B, b, 'hello')
    await T.receive(doc.envelope)
    await T.takeAll()
    // the laptop's library throws once while taking the passed-on document
    const real = L.P.h
    let thrown = 0
    L.P.h = Object.create(real, { receive: { value: async (...args: any[]) => { if (!thrown++) throw new Error('store unavailable'); return real.receive(...args) } } })
    const first = await L.syncFrom(T)
    expect(first.stoppedAt).toBe('phone#1')
    expect([texts(L), await inbox(L)]).toEqual([[], 0])
    const second = await L.syncFrom(T)
    expect(second.stoppedAt).toBe(null)
    expect([texts(L), await inbox(L)]).toEqual([['in:hello'], 0])
  })

  test('taking "read" over breaks off after the conversation line, before the inbox is emptied: the next sync finishes it', async () => {
    const { T, L, B, b } = await world(0x53)
    const doc = await written(B, b, 'hello')
    await T.receive(doc.envelope); await L.receive(doc.envelope)
    await T.takeAll()
    const real = L.P.h
    let thrown = 0
    L.P.h = Object.create(real, { takeMessages: { value: async (...args: any[]) => { if (!thrown++) throw new Error('store unavailable'); return real.takeMessages(...args) } } })
    const first = await L.syncFrom(T)
    expect({ stoppedAt: first.stoppedAt, lines: texts(L), inbox: await inbox(L) }).toEqual({ stoppedAt: 'phone#2', lines: ['in:hello'], inbox: 1 })
    const again = await L.syncFrom(T)
    expect({ stoppedAt: again.stoppedAt, lines: texts(L), inbox: await inbox(L) }).toEqual({ stoppedAt: null, lines: ['in:hello'], inbox: 0 })
  })

  test('reading A fails once on the phone, then B arrives: A is read on both devices, B stays unread on both', async () => {
    const { T, L, B, b } = await world(0x55)
    const docA = await written(B, b, 'A')
    await T.receive(docA.envelope); await L.receive(docA.envelope)
    const real = T.P.h
    let thrown = 0
    T.P.h = Object.create(real, { takeMessages: { value: async (...args: any[]) => { if (!thrown++) throw new Error('store unavailable'); return real.takeMessages(...args) } } })
    const first = await T.takeAll()
    expect(first.stoppedAt).toBe('phone#2')
    const docB = await written(B, b, 'B')
    await T.receive(docB.envelope); await L.receive(docB.envelope)   // the phone's next step finishes the reading of A
    const synced = await L.syncFrom(T)
    expect(synced.stoppedAt).toBe(null)
    const unread = async (D: Device): Promise<string[]> => (await D.P.h.inbox()).map((m: any) => m.text)
    expect({ phone: [texts(T), await unread(T)], laptop: [texts(L), await unread(L)] }).toEqual({ phone: [['in:A'], ['B']], laptop: [['in:A'], ['B']] })
  })

  // Open finding, stated as what is measured. B's acknowledgement names the
  // document it acknowledges; only the device that issued that document
  // holds it and can settle it. Handed to both devices, each acknowledgement
  // is accepted by its issuer and refused by the sister. The layer has no
  // answer yet: the delivery state of an issued document would have to
  // travel as proof. When that is built, this expectation changes.
  test('open: B\'s acknowledgements reach both devices, each is refused by the sister of its document\'s issuer', async () => {
    const { T, L, B, a } = await world(0x4f)
    const fromPhone = await T.send(a.id, 'from the phone'), fromLaptop = await L.send(a.id, 'from the laptop')
    const ackOf = async (docs: any[]): Promise<any> => {
      const { answers, verdicts } = await handTo(B, docs)
      expect(verdicts).toEqual(['message/0.1: unique'])
      expect(answers).toHaveLength(1)
      return answers[0]
    }
    const forPhone = await ackOf(fromPhone), forLaptop = await ackOf(fromLaptop)
    const take = async (D: Device, o: any): Promise<string> => {
      const got = await D.P.h.receive(o.envelope, clk(D.P, tick()))
      return got.disposition + (got.reason ? ' ' + got.reason : '')
    }
    expect({
      'phone takes the ack of its own document': await take(T, forPhone),
      'laptop takes the ack of the phone\'s document': await take(L, forPhone),
      'laptop takes the ack of its own document': await take(L, forLaptop),
      'phone takes the ack of the laptop\'s document': await take(T, forLaptop),
    }).toEqual({
      'phone takes the ack of its own document': 'unique',
      'laptop takes the ack of the phone\'s document': 'failed validation-failed',
      'laptop takes the ack of its own document': 'unique',
      'phone takes the ack of the laptop\'s document': 'failed validation-failed',
    })
  })
})
