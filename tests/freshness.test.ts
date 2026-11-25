import { expect, test } from 'vitest'
import { run } from '../src/lab/freshness/lib-run'
import { lifetime, mayDecide, mayPropose, proposal } from '../src/lab/freshness/rule'

const DAY = 86400

test('how long a link lives: ten minutes unless stated, a shown code at most ten minutes, a sent link at most seven days', async () => {
  for (const channel of ['displayed', 'sent'] as const) for (const minutes of [undefined, 0.5, 1, 1.012, 1.02, 10, 11, 7 * 1440, 7 * 1440 + 1]) {
    expect((await run({ channel, ...(minutes === undefined ? {} : { minutes }), proposedAt: 1, deliveredAt: 2 })).expS, `${channel} ${minutes}`).toBe(lifetime(channel, minutes))
  }
  expect([lifetime('sent'), lifetime('displayed', 30), lifetime('sent', 30), lifetime('sent', 8 * 1440), lifetime('sent', 0.5), lifetime('sent', 1.012)]).toEqual([600, 600, 1800, 7 * DAY, 60, 61])
})

test('the responder proposes only before the link expires, to the second', async () => {
  for (const at of [598, 599, 600, 601]) {
    const o = await run({ channel: 'displayed', proposedAt: at, deliveredAt: at + 1 })
    expect(o.propose === 'sent', `at ${at}`).toBe(mayPropose(at, 600))
    if (!mayPropose(at, 600)) expect(o.propose).toBe('refused: link-invalid')
  }
})

// Each row: the link's lifetime, when the proposal was issued, and the times of delivery around a boundary.
test.each([
  ['age: under eleven minutes', { channel: 'sent', minutes: 7 * 1440 }, 30, [629, 630, 631, 689, 690, 691]],
  ['the link: under a minute after its expiry', { channel: 'displayed' }, 590, [599, 600, 601, 659, 660, 661]],
  ['issued in the future: under a minute ahead', { channel: 'displayed' }, 100, [39, 40, 41, 99, 100]],
  ['a sent link on its third day', { channel: 'sent', minutes: 7 * 1440 }, 3 * DAY, [3 * DAY + 300, 3 * DAY + 659, 3 * DAY + 660]],
] as const)('the inviter and a proposal, %s', async (_n, link, issuedAt, deliveries) => {
  for (const now of deliveries) {
    const o = await run({ ...link, proposedAt: issuedAt, deliveredAt: now } as never), want = proposal(issuedAt, now, o.expS)
    expect(o.inviter, `issued ${issuedAt}, delivered ${now}`).toBe(want === 'taken' ? 'taken' : `refused: ${want}`)
  }
})

test('the person decides until thirty days after the link expired, to the second', async () => {
  for (const at of [DAY, 30 * DAY, 30 * DAY + 659, 30 * DAY + 660, 30 * DAY + 661]) {
    const o = await run({ channel: 'displayed', proposedAt: 30, deliveredAt: 40, restAt: at })
    expect(o.contacts, `decided at ${at}`).toEqual(mayDecide(at, o.expS) ? [1, 1] : [0, 0])
  }
})

test('after the decision nothing has a window: accepted at once, every later document carried sixty days or a year later, both sides open', async () => {
  expect((await run({ channel: 'displayed', proposedAt: 30, deliveredAt: 40, decideAt: 50, restAt: 60 * DAY })).contacts).toEqual([1, 1])
  expect((await run({ channel: 'displayed', proposedAt: 30, deliveredAt: 40, decideAt: 50, restAt: 365 * DAY })).contacts).toEqual([1, 1])
})

test('one link, one proposer: a second identity on the same link is refused', async () => {
  expect((await run({ channel: 'displayed', proposedAt: 30, deliveredAt: 40, second: true })).second).toBe('refused: issuer')
})
