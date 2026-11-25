import { expect, test } from 'vitest'
import { pair } from '../src/lab/met/lib-run'
import { CHANNELS, HONEST, contactMet, mayTrust, metInEnactment, type Channel } from '../src/lab/met/rule'

// The whole rule for one enactment: the own channel against what the counterpart states.
test('one enactment met exactly when the own channel is in person and the counterpart states no link', () => {
  const met: string[] = []
  for (const own of CHANNELS) for (const theirs of [...CHANNELS, null] as Array<Channel | null>) if (metInEnactment(own, theirs)) met.push(`${own}/${theirs}`)
  expect(met).toEqual(['scan/scan', 'scan/displayed', 'scan/null', 'displayed/scan', 'displayed/displayed', 'displayed/null'])
})

test('between two honest parties both sides derive the same, and only "displayed" read by "scan" met', () => {
  expect(HONEST.map((h) => [metInEnactment(h.inviter, h.responder), metInEnactment(h.responder, h.inviter)])).toEqual([[true, true], [false, false], [false, false], [false, false]])
})

test('a contact met when any of its tuples did', () => {
  const link = { enactment: { own: 'link', theirs: 'sent' } } as const, scan = { enactment: { own: 'scan', theirs: 'displayed' } } as const
  expect([contactMet([link]), contactMet([link, scan]), contactMet([link, 'introduction']), mayTrust([link]), mayTrust([link, scan])]).toEqual([false, true, true, false, true])
})

// The library (rltp-lib, the version in package.json): the contact view and the trust act.
test.each(HONEST.map((h) => [`${h.inviter} read by ${h.responder}`, h] as const))('the library, %s: each side shows the channels, "met" as the rule gives it, and takes the trust act only then', async (_n, h) => {
  const p = await pair()
  await p.enact('a', h.inviter, h.responder); await p.settle()
  const met = metInEnactment(h.inviter, h.responder), trust = met ? 'taken' : 'not-met'
  expect(await p.seen('a')).toEqual({ contacts: [{ channel: h.inviter, theirChannel: h.responder, met, trust }] })
  expect(await p.seen('b')).toEqual({ contacts: [{ channel: h.responder, theirChannel: h.inviter, met, trust }] })
}, 60_000)

test('the library, a link and later a scan: two contacts until recognition united them, then one that met', async () => {
  const p = await pair()
  await p.enact('a', 'sent', 'link'); await p.settle()
  await p.enact('a', 'displayed', 'scan')
  // the second tuple is open on both sides, nothing of recognition delivered yet
  expect((await p.seen('a')).contacts.map((c) => [c.channel, c.met, c.trust]).sort()).toEqual([['displayed', true, 'taken'], ['sent', false, 'not-met']])
  await p.settle()
  // one contact; it shows the channels of its oldest enactment and met by the later one
  expect(await p.seen('a')).toEqual({ contacts: [{ channel: 'sent', theirChannel: 'link', met: true, trust: 'taken' }] })
  expect(await p.seen('b')).toEqual({ contacts: [{ channel: 'link', theirChannel: 'sent', met: true, trust: 'taken' }] })
}, 60_000)

test('the library, the scan with the roles swapped: the same', async () => {
  const p = await pair()
  await p.enact('a', 'sent', 'link'); await p.settle()
  await p.enact('b', 'displayed', 'scan'); await p.settle()
  expect(await p.seen('a')).toEqual({ contacts: [{ channel: 'sent', theirChannel: 'link', met: true, trust: 'taken' }] })
}, 60_000)
