// Traces of the rule in rule.ts: schedules written by hand, with what every
// step sent and what each side shows after it. A trace is data
// (traces/*.json): another implementation replays the steps and compares.
import { apply, possible, start, type Doc, type Event, type State } from './rule'

export type Shown = { inviter: { open: boolean, held: Doc[] }, responder: { open: boolean, held: Doc[] }, inFlight: Doc[] }
export type Step = Event & { sent: Doc[], after: Shown }
export type Trace = { name: string, shows: string, steps: Step[] }

const shown = (s: State): Shown => ({
  inviter: { open: s.inviter.open, held: s.inviter.held }, responder: { open: s.responder.open, held: s.responder.held }, inFlight: [...s.inFlight].sort(),
})

export function replay (events: Event[]): Step[] {
  let cur = start()
  return events.map((raw) => {
    const e = ('act' in raw ? { act: raw.act } : { deliver: raw.deliver }) as Event
    const r = apply(cur, e); cur = r.state
    return { ...e, sent: r.sent, after: shown(cur) }
  })
}

const OPENING: Event[] = [{ act: 'propose' }, { deliver: 'propose' }, { act: 'accept' }]
export function build (): Trace[] {
  const t = (name: string, shows: string, rest: Event[]): Trace => ({ name, shows, steps: replay([...OPENING, ...rest]) })
  return [
    t('in-order', 'Every document arrives in the order it was sent. The inviter holds the responder\'s issue and receipt first and opens its tuple; the responder opens when the inviter\'s receipt arrives.', [
      { deliver: 'accept' }, { deliver: 'issue-inviter' }, { deliver: 'issue-responder' }, { deliver: 'receipt-of-issue-inviter' }, { deliver: 'receipt-of-issue-responder' },
    ]),
    t('responder-first', 'The same documents, the two receipts delivered in the other order: the responder opens its tuple first. Which side opens first is decided by the carrier, not by the role.', [
      { deliver: 'accept' }, { deliver: 'issue-inviter' }, { deliver: 'issue-responder' }, { deliver: 'receipt-of-issue-responder' }, { deliver: 'receipt-of-issue-inviter' },
    ]),
    t('issue-before-acceptance', 'The inviter\'s issue overtakes its acceptance. The responder holds it and answers nothing; when the acceptance arrives it issues and takes the held issue in the same step. The receipt of the inviter\'s issue then reaches the inviter before the responder\'s issue does: a receipt alone opens nothing.', [
      { deliver: 'issue-inviter' }, { deliver: 'accept' }, { deliver: 'receipt-of-issue-inviter' }, { deliver: 'issue-responder' }, { deliver: 'receipt-of-issue-responder' },
    ]),
  ]
}

/** Every schedule from the first act to the last delivery: all orders in which the carrier can deliver. */
export function everySchedule (): Event[][] {
  const out: Event[][] = []
  const go = (s: State, done: Event[]): void => {
    const next: Event[] = [...(['propose', 'accept'] as const).map((act) => ({ act })), ...[...new Set(s.inFlight)].sort().map((deliver) => ({ deliver }))].filter((e) => possible(s, e))
    if (!next.length) { out.push(done); return }
    for (const e of next) go(apply(s, e).state, [...done, e])
  }
  go(start(), [])
  return out
}
