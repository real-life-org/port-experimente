import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { Carrier, RULES, change, device, follows, headId, met, receive, send, settleInPerson, share, takeOver, type Device, type Entry } from '../src/lab/wechsel/model'

// Rules of the model (src/lab/wechsel/model.ts) for a contested
// relationship, each as a sequence: what a meeting settles is one fork, and
// that decision holds through every sync of the person's own devices.

const has = (d: Device, s: string): boolean => d.notices.some((n) => n.includes(s))
const held = (d: Device): number => d.notices.filter((n) => n.includes('held a trust')).length

/** A has a phone and a laptop that both may change keys; B has a phone and
 *  a laptop. A's devices each write a continuation; one reaches B's phone,
 *  the other B's laptop. */
function split (): { c: Carrier, aPhone: Device, aLaptop: Device, bPhone: Device, bLaptop: Device } {
  const c = new Carrier(), [aPhone, aLaptop, bPhone, bLaptop] = [device('a-phone'), device('a-laptop'), device('b-phone'), device('b-laptop')] as [Device, Device, Device, Device]
  met([aPhone, aLaptop], [bPhone, bLaptop], [aPhone, aLaptop], [bPhone])
  change(aPhone, RULES, [aPhone, aLaptop]); change(aLaptop, RULES, [aLaptop])
  send(aPhone, c, RULES, 'message', 'from a\'s phone'); receive(bPhone, c, RULES)
  send(aLaptop, c, RULES, 'message', 'from a\'s laptop'); receive(bLaptop, c, RULES)
  return { c, aPhone, aLaptop, bPhone, bLaptop }
}

test('a fork settled in a meeting stays settled through the sync of the own devices', () => {
  const { c, aPhone, aLaptop, bPhone, bLaptop } = split()
  expect(headId(bPhone.peer.log)).not.toBe(headId(bLaptop.peer.log))

  // the first sync makes the conflict known on both devices
  share(bPhone, bLaptop, false); share(bLaptop, bPhone, false)
  expect([bPhone.peer.contested, bLaptop.peer.contested]).toEqual([true, true])
  send(bPhone, c, RULES, 'trust'); expect(held(bPhone)).toBe(1)

  // the meeting, on the phone
  expect(settleInPerson(bPhone, aPhone.own.log)).toBe(true)
  expect(bPhone.peer.contested).toBe(false)

  // the phone syncs to the laptop, and the laptop back: the decision holds on both
  share(bPhone, bLaptop, false)
  expect(headId(bLaptop.peer.log)).toBe(headId(aPhone.own.log))
  expect([bPhone.peer.contested, bLaptop.peer.contested]).toEqual([false, false])
  share(bLaptop, bPhone, false)
  expect([bPhone.peer.contested, bLaptop.peer.contested]).toEqual([false, false])
  expect(bLaptop.peer.evidence.some((e) => e.id === headId(aLaptop.own.log))).toBe(true)   // the other continuation stays as evidence

  // a statement of trust goes out again, from the device that was not at the meeting
  send(bLaptop, c, RULES, 'trust', 'trust after the meeting')
  expect(held(bLaptop)).toBe(0)
  receive(aPhone, c, RULES)
  expect(aPhone.inbox).toContain('trust after the meeting')

  // a later, new fork on the settled branch is a new conflict
  takeOver(aPhone, aLaptop, true)
  change(aPhone, RULES, [aPhone]); change(aLaptop, RULES, [aLaptop])
  send(aPhone, c, RULES, 'message', 'next from a\'s phone'); receive(bPhone, c, RULES)
  send(aLaptop, c, RULES, 'message', 'next from a\'s laptop'); receive(bPhone, c, RULES)
  expect(bPhone.peer.contested).toBe(true)
  send(bPhone, c, RULES, 'trust'); expect(held(bPhone)).toBe(2)

  // and the sibling that settled the first fork learns of the second one
  expect(bLaptop.peer.contested).toBe(false)
  share(bPhone, bLaptop, false)
  expect(bLaptop.peer.contested).toBe(true)
  send(bLaptop, c, RULES, 'trust'); expect(held(bLaptop)).toBe(1)
})

test('a settlement that arrives by sync does not shorten a log that already continues the settled branch', () => {
  const c = new Carrier(), [aPhone, aLaptop, bPhone, bLaptop] = [device('a-phone'), device('a-laptop'), device('b-phone'), device('b-laptop')] as [Device, Device, Device, Device]
  met([aPhone, aLaptop], [bPhone, bLaptop], [aPhone, aLaptop], [bPhone])
  change(aPhone, RULES, [aPhone]); change(aLaptop, RULES, [aLaptop])
  send(aPhone, c, RULES, 'message', 'one'); receive(bPhone, c, RULES)
  send(aLaptop, c, RULES, 'message', 'other'); receive(bPhone, c, RULES)
  expect(bPhone.peer.contested).toBe(true)
  expect(settleInPerson(bPhone, aPhone.own.log)).toBe(true)
  // b's laptop was offline for all of it and then takes two entries of the settled branch at once
  change(aPhone, RULES, [aPhone])
  send(aPhone, c, RULES, 'message', 'two'); receive(bLaptop, c, RULES)
  expect(headId(bLaptop.peer.log)).toBe(headId(aPhone.own.log))
  share(bPhone, bLaptop, false)
  expect(headId(bLaptop.peer.log)).toBe(headId(aPhone.own.log))
  expect(bLaptop.peer.contested).toBe(false)
})

test('a weighty document is held whatever name the caller gives it first', () => {
  const { c, bPhone, bLaptop } = split()
  share(bPhone, bLaptop, false); share(bLaptop, bPhone, false)
  send(bPhone, c, RULES, 'message', undefined, { kind: 'trust' })
  expect(held(bPhone)).toBe(1)
  send(bPhone, c, RULES, 'message', 'a message while contested')
  expect(has(bPhone, 'held a message')).toBe(false)
})

test('an entry with a key that is no key is no continuation, and the rest of the batch is handled', () => {
  const { c, aPhone, bPhone } = split()
  const good = aPhone.own.log[1] as Entry
  const b = { n: good.n, prev: good.prev, update: 'AAAA', next: good.next, state: good.state }, proof = 'AAAA'
  const bad: Entry = { ...b, proof, id: createHash('sha256').update(JSON.stringify([b.n, b.prev, b.update, b.next, b.state]) + proof).digest('base64url').slice(0, 22) }
  expect(follows(aPhone.own.log[0] as Entry, bad)).toBe(false)
  // the malformed entry travels in front of a good document of the same fetch
  send(aPhone, c, RULES, 'message', 'with a bad entry', { entries: [bad] })
  send(aPhone, c, RULES, 'message', 'after the bad entry')
  expect(() => receive(bPhone, c, RULES)).not.toThrow()
  expect(bPhone.inbox).toContain('after the bad entry')
  expect(bPhone.peer.contested).toBe(false)
})
