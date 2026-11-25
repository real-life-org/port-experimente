// Traces of the rule in rule.ts: schedules written by hand, with what every
// step sent and what each side shows after it. A trace is data
// (traces/*.json): another implementation replays the steps and compares.
import { DOCS, apply, outbox, possible, start, type Doc, type Event, type State } from './rule'

/** `outbox`: what the side would send again after a restart */
export type Shown = { inviter: { open: boolean, declined: boolean, held: Doc[], outbox: Doc[] }, responder: { open: boolean, declined: boolean, held: Doc[], outbox: Doc[] }, inFlight: Doc[] }
export type Step = Event & { sent: Doc[], after: Shown }
export type Trace = { name: string, shows: string, steps: Step[] }

const shown = (s: State): Shown => ({
  inviter: { open: s.inviter.open, declined: s.inviter.declined, held: s.inviter.held, outbox: outbox(s, 'inviter') },
  responder: { open: s.responder.open, declined: s.responder.declined, held: s.responder.held, outbox: outbox(s, 'responder') },
  inFlight: [...s.inFlight].sort(),
})

export function replay (events: Event[]): Step[] {
  let cur = start()
  return events.map((raw) => {
    const e = ('act' in raw ? { act: raw.act } : 'redeliver' in raw ? { redeliver: raw.redeliver } : { deliver: raw.deliver }) as Event
    const r = apply(cur, e); cur = r.state
    return { ...e, sent: r.sent, after: shown(cur) }
  })
}

const OPENING: Event[] = [{ act: 'propose' }, { deliver: 'propose' }, { act: 'accept' }]
export function build (): Trace[] {
  const t = (name: string, shows: string, events: Event[]): Trace => ({ name, shows, steps: replay(events) })
  return [
    t('in-order', 'Every document arrives in the order it was sent. The inviter holds the responder\'s issue and receipt first and opens its tuple; the responder opens when the inviter\'s receipt arrives.', [...OPENING,
      { deliver: 'accept' }, { deliver: 'issue-inviter' }, { deliver: 'issue-responder' }, { deliver: 'receipt-of-issue-inviter' }, { deliver: 'receipt-of-issue-responder' },
    ]),
    t('responder-first', 'The same documents, the two receipts delivered in the other order: the responder opens its tuple first. Which side opens first is decided by the carrier, not by the role.', [...OPENING,
      { deliver: 'accept' }, { deliver: 'issue-inviter' }, { deliver: 'issue-responder' }, { deliver: 'receipt-of-issue-responder' }, { deliver: 'receipt-of-issue-inviter' },
    ]),
    t('issue-before-acceptance', 'The inviter\'s issue overtakes its acceptance. The responder holds it and answers nothing; when the acceptance arrives it issues and takes the held issue in the same step. The receipt of the inviter\'s issue then reaches the inviter before the responder\'s issue does: a receipt alone opens nothing.', [...OPENING,
      { deliver: 'issue-inviter' }, { deliver: 'accept' }, { deliver: 'receipt-of-issue-inviter' }, { deliver: 'issue-responder' }, { deliver: 'receipt-of-issue-responder' },
    ]),
    t('declined', 'The inviter\'s person declines. The responder takes the decline; neither side opens, and nothing more is sent. The proposal handed over once more is answered with the decline again.', [
      { act: 'propose' }, { deliver: 'propose' }, { act: 'decline' }, { deliver: 'decline' }, { redeliver: 'propose' }, { deliver: 'decline' },
    ]),
    t('handed-over-again', 'Documents the carrier hands over a second time change nothing; each is answered with what its first delivery sent. The acceptance handed over again brings the responder\'s issue again, not the receipt it sent in the same step for an issue it had held back. The copies travel and are answered in turn until a receipt ends the chain.', [...OPENING,
      { deliver: 'issue-inviter' }, { redeliver: 'issue-inviter' }, { deliver: 'accept' }, { redeliver: 'accept' }, { deliver: 'issue-responder' }, { deliver: 'issue-responder' },
      { deliver: 'receipt-of-issue-inviter' }, { deliver: 'receipt-of-issue-responder' }, { deliver: 'receipt-of-issue-responder' }, { redeliver: 'propose' },
      { deliver: 'accept' }, { deliver: 'issue-inviter' }, { deliver: 'issue-responder' }, { deliver: 'receipt-of-issue-inviter' }, { deliver: 'receipt-of-issue-responder' }, { redeliver: 'receipt-of-issue-inviter' },
    ]),
  ]
}

/** Every schedule from the first act until nothing is in flight: all orders in which the carrier can deliver, the inviter's
 *  person accepting or declining, and with `redeliveries` documents handed over once more at any point. */
export function everySchedule (redeliveries = 0): Event[][] {
  const out: Event[][] = []
  const go = (s: State, done: Event[], left: number): void => {
    const acts: Event[] = (['propose', 'accept', 'decline'] as const).map((act) => ({ act }))
    const next = [...acts, ...[...new Set(s.inFlight)].sort().map((deliver) => ({ deliver }) as Event)].filter((e) => possible(s, e))
    const more = left > 0 ? DOCS.map((redeliver) => ({ redeliver }) as Event).filter((e) => possible(s, e)) : []
    if (!next.length && left === 0) { out.push(done); return }
    for (const e of next) go(apply(s, e).state, [...done, e], left)
    for (const e of more) go(apply(s, e).state, [...done, e], left - 1)
  }
  go(start(), [], redeliveries)
  return out
}
