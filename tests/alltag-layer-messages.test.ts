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
    acks.push(...(await L.syncFrom(T)))
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

  // Open finding. B's acknowledgement names the document it acknowledges; only
  // the device that issued that document holds it and can settle it. Handed
  // to both devices, each acknowledgement is refused by the sister. The
  // layer has no answer yet: the delivery state of an issued document would
  // have to travel as proof. `fails` marks the wanted outcome as not reached.
  test.fails('B\'s acknowledgements reach both devices and neither refuses one', async () => {
    const { T, L, B, a } = await world(0x4f)
    const out = [...(await T.send(a.id, 'from the phone')), ...(await L.send(a.id, 'from the laptop'))]
    const { answers } = await handTo(B, out)
    const back: string[] = []
    for (const o of answers) for (const D of [T, L]) {
      const got = await D.P.h.receive(o.envelope, clk(D.P, tick()))
      back.push(`${D.name}: ${got.disposition}${got.reason ? ' ' + got.reason : ''}`)
    }
    expect(back.filter((v) => v.includes('failed'))).toEqual([])
  })
})
