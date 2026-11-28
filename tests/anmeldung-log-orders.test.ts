import { describe, expect, test } from 'vitest'
import { MemoryLoginStore, REQUEST_PATH, Service, ServiceKeys } from '../src/lab/anmeldung-log/service'
import type { NonceState } from '../src/lab/kennung-log/verifier'
import { SERVICE_SEED, T0, drawn, eventsFor, every, fixedServiceLog, replay, type EventName, type Outcome, type Setup } from './anmeldung-log-orders'

// The login after the profile in many orders (tests/anmeldung-log-orders.ts):
// every order of small sets of events, each set aimed at one or more of the
// properties E1–E13; then random orders of larger random sets, each from a
// fixed seed. A failure names the property, the order and the seed.

const shown = (o: Outcome): string => o.failure ? `${o.failure.problems.map((p) => `${p.property}: ${p.detail}`).join('; ')}\n  order #${o.failure.index}${o.failure.seed !== undefined ? ` (seed ${o.failure.seed})` : ''}: ${o.failure.order.join(' → ')}` : 'ok'

// [setup, events, properties the set is aimed at, number of orders]
const SETS: [Setup, EventName[], string, number][] = [
  ['returning', ['confirm', 'confirm2'], 'E1 E9 (the same wallet confirms twice)', 70],
  ['returning', ['confirm', 'other'], 'E1 E9 (another person answers the same request)', 70],
  ['answered', ['collect', 'collect'], 'E1 (one session per attempt)', 6],
  ['answered', ['redeem', 'foreign'], 'E1 E2 (the code, and another browser)', 6],
  ['answered', ['collect', 'foreign'], 'E2', 6],
  ['returning', ['confirm', 'late301'], 'E3 (no answer after the request ran out)', 5],
  ['answered', ['collect', 'late301'], 'E3 (pickup window)', 3],
  ['answered', ['redeem', 'late61'], 'E3 (the code)', 3],
  ['returning', ['confirm', 'device2'], 'E4 E9 (a second device with the old state)', 70],
  ['rotated', ['confirm', 'second'], 'E4 (views under an older and a newer service head)', 23],
  ['returning', ['rotate', 'confirm'], 'E4 E7 (key change of the person beside a confirmation)', 15],
  ['answered', ['fork', 'collect'], 'E5 (contested after admitted, before pickup)', 15],
  ['answered', ['fork', 'redeem'], 'E5 (the same on the same device)', 15],
  ['returning', ['confirm', 'fork'], 'E4 E5 E9 (two continuations)', 70],
  ['returning', ['cancel', 'late301'], 'E6 (a cancel after the request ran out)', 3],
  ['returning', ['cancel', 'confirm'], 'E6 E9 (cancel does not end the attempt)', 15],
  ['returning', ['rotateService', 'start'], 'E8 (a key change of the service while a request is signed)', 21],
  ['returning', ['start', 'late301'], 'E8 E13 (the clock passes the window while a request is signed)', 6],
  ['returning', ['start', 'late300'], 'E13 (the clock reaches exactly exp while a request is signed)', 6],
  ['returning', ['start', 'late299'], 'E13 (the clock moves to just inside the window while a request is signed)', 6],
  ['returning', ['confirm', 'late300'], 'E3 E6 (no answer exactly at exp)', 5],
  ['returning', ['cancel', 'late300'], 'E6 (a cancel exactly at exp)', 3],
  ['returning', ['swapped', 'second'], 'E9 (an answer under another attempt\'s state)', 70],
  ['first', ['confirm', 'device1st'], 'E10 (two devices, one storage, first login)', 210],
  ['first', ['confirm', 'other'], 'E1 E10 (two persons, first login)', 252],
  ['answered', ['forget', 'collect'], 'E11 (given up, then collected)', 6],
  ['returning', ['confirm', 'forget'], 'E9 E11 (given up while the answer is checked)', 12],
  ['returning', ['rotateService', 'tick', 'rotateService'], 'E12 (two key changes of the service, a second apart)', 30],
  ['returning', ['rotateService', 'open'], 'E4 E8 (the wallet follows a key change of the service)', 28],
  ['returning', ['confirm', 'tick', 'collect'], 'all (a login collected, the clock moving)', 31],
  ['returning', ['confirm', 'cancel', 'late301'], 'E3 E6 E9 (answer, cancel and the end of the window)', 69],
  ['returning', ['rotate', 'confirm', 'collect'], 'E4 E7 E1 (a key change, the answer, the pickup)', 114],
]

// Orders in which the test found real faults (fixed in service.ts); each was red before the fix.
describe('orders that found faults', () => {
  test('a key change of the service lands while a request is signed: the try is given up and the request is signed again under the new head (E8)', async () => {
    // start derives its key, the key change is published, then start's nonce is stored and checked: the key state moved, so the nonce is spent and a new try follows
    const r = await replay('returning', ['rotateService', 'start'], [0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1])
    expect(r.order).toEqual(['rotateService(begin)', 'start(begin)', 'start(service key)', 'rotateService(service key)', 'start(store: nonce)', 'start(store: nonce check)', 'start(store: nonce check returns)', 'start(store: close)', 'start(service key)', 'start(store: nonce)', 'start(store: nonce check)', 'start(store: nonce check returns)'])
    expect(r.problems).toEqual([])
  })
  test('the clock passes the request window while it is signed: a new window and a new nonce, the first nonce spent (E8, E13)', async () => {
    const r = await replay('returning', ['start', 'late301'], [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(r.order).toEqual(['start(begin)', 'start(service key)', 'late301(begin)', 'start(store: nonce)', 'start(store: nonce check)', 'start(store: nonce check returns)', 'start(store: close)', 'start(service key)', 'start(store: nonce)', 'start(store: nonce check)', 'start(store: nonce check returns)'])
    expect(r.problems).toEqual([])
  })
  test('the clock reaches exactly exp while a request is signed: the link is not issued with a window that is closed (E13)', async () => {
    const r = await replay('returning', ['start', 'late300'], [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(r.order).toContain('start(store: close)')
    expect(r.problems).toEqual([])
  })
  test('two key changes of the service side by side: one moves the log on by exactly one entry, the other is refused as changed meanwhile (E12)', async () => {
    const r = await replay('returning', ['rotateService', 'rotateService'], [0, 1, 0, 1])
    expect(r.order).toEqual(['rotateService(begin)', 'rotateService(begin)', 'rotateService(service key)', 'rotateService(service key)'])
    expect(r.problems).toEqual([])
    expect(r.results.filter((x) => 'ok' in x)).toHaveLength(1)
    expect(r.results.filter((x) => 'error' in x).map((x) => (x as { error: string }).error)).toEqual([expect.stringMatching(/changed meanwhile/)])
    expect(r.serviceEntries.after - r.serviceEntries.before).toBe(1)
  })
  test('a view checked under the newer service head is confirmed first; then the view checked under the older head sends nothing (E6, E4)', async () => {
    // rotated: A opened under the first head, B after the key change; B goes all the way first, then A
    const r = await replay('rotated', ['confirm', 'second'], Array(40).fill(1))
    expect(r.problems).toEqual([])
    expect(r.order.findIndex((x) => x.startsWith('confirm'))).toBeGreaterThan(r.order.map((x) => x.startsWith('second')).lastIndexOf(true))
    expect(r.results).toEqual([{ ok: { error: 'a newer head of the service is held' } }, { ok: { status: 200, body: {} } }])
  })
})

describe('the return of a store step', () => {
  // The store decides at exp − 1 ms; the clock reaches exactly exp before the answer reaches start().
  test('start never returns a link whose request is null at once: the answer of the step is not trusted past the clock (E13)', async () => {
    let t = T0
    let slips = 0
    class SlippingStore extends MemoryLoginStore {
      override async inspectNonce<T> (nonce: string, clock: () => number, decide: (state: NonceState, now: number) => T): Promise<T> {
        const exp = this.nonces.get(nonce)?.expires as number
        // the first step decides at exp − 1 ms, and the answer comes back once the clock stands at exp
        const first = slips++ === 0
        const r = await super.inspectNonce(nonce, first ? () => exp - 1 : clock, decide)
        if (first) t = exp
        return r
      }
    }
    const svc = await Service.create({ host: 'dienst.example', keys: new ServiceKeys(SERVICE_SEED), now: () => t, store: new SlippingStore(), log: await fixedServiceLog() })
    const s = await svc.start('cross-device')
    expect(slips).toBeGreaterThan(1)   // the first try was given up, a new window was taken
    expect(svc.requestObject(s.requestUri.slice((svc.origin + REQUEST_PATH).length))).not.toBeNull()
  })
})

describe('every order of small sets', () => {
  test.each(SETS.map(([s, e, why, n]) => [`${s}: ${e.join(', ')} — ${why}: ${n} orders`, s, e, n] as const))('%s', async (_name, setup, events, n) => {
    const o = await every(setup, events)
    expect(shown(o)).toBe('ok')
    expect(o.orders).toBe(n)
  }, 120_000)
})

test('the sets above are every order of their events: together', () => {
  expect(SETS.reduce((n, x) => n + x[3], 0)).toBe(1264)
})

describe('random orders of larger sets, fixed seeds', () => {
  const setups: Setup[] = ['returning', 'answered', 'first', 'rotated']
  test.each(setups)('%s: 25 sets of 5 to 7 events, 4 orders each', async (setup) => {
    for (let k = 1; k <= 25; k++) {
      const seed = setups.indexOf(setup) * 100 + k
      const events = eventsFor(seed, 5 + (k % 3), setup)
      const o = await drawn(setup, events, [1, 2, 3, 4].map((i) => seed * 1000 + i))
      expect(`${setup} [${events.join(', ')}]: ${shown(o)}`).toBe(`${setup} [${events.join(', ')}]: ok`)
    }
  }, 120_000)
})
