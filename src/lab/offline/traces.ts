// Traces of the rule in rule.ts: schedules written by hand, with what every
// step sent and what each side shows after it. A trace is data
// (traces/*.json): another implementation replays the steps and compares.
import type { Doc } from '../tuple-opening/rule'
import type { Shown } from '../tuple-opening/traces'
import { apply, outbox, possible, start, type Event, type State } from './rule'

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

const CODES: Event[] = [{ act: 'propose' }, { act: 'back' }, { act: 'read-back' }, { act: 'accept' }]
export function build (): Trace[] {
  const t = (name: string, shows: string, events: Event[]): Trace => ({ name, shows, steps: replay(events) })
  return [
    t('two-codes', 'No carrier. The responder scans the link, proposes and shows its proposal back: it opens. The inviter\'s camera reads the code, its person accepts: it opens. Three documents wait in flight. Then a carrier is there: the proposal arrives as a document handed over again and is answered once more, the acceptance and the issues are taken, and both sides complete; the copies sent again are answered in turn until receipts end the chain.', [...CODES,
      { deliver: 'propose' }, { deliver: 'accept' }, { deliver: 'issue-inviter' }, { deliver: 'issue-responder' }, { deliver: 'receipt-of-issue-inviter' }, { deliver: 'receipt-of-issue-responder' },
      { deliver: 'accept' }, { deliver: 'issue-inviter' }, { deliver: 'issue-responder' }, { deliver: 'receipt-of-issue-inviter' }, { deliver: 'receipt-of-issue-responder' },
    ]),
    t('declined-after-the-code', 'The responder showed its code and opened. The inviter\'s person reads the code and declines. The inviter holds no contact; the responder keeps the one it opened, and its enactment is declined once the decline arrives.', [
      { act: 'propose' }, { act: 'back' }, { act: 'read-back' }, { act: 'decline' }, { deliver: 'decline' }, { deliver: 'propose' }, { deliver: 'decline' },
    ]),
    t('code-never-read', 'The responder showed its code and opened; the inviter never read it. A carrier brings the proposal, the person accepts, and the enactment completes as it does with a carrier: the inviter opens at its last step.', [
      { act: 'propose' }, { act: 'back' }, { deliver: 'propose' }, { act: 'accept' },
      { deliver: 'accept' }, { deliver: 'issue-inviter' }, { deliver: 'issue-responder' }, { deliver: 'receipt-of-issue-inviter' }, { deliver: 'receipt-of-issue-responder' },
    ]),
    t('code-after-the-acceptance', 'The proposal came by a carrier and the person accepted; then the carrier is gone. The responder shows its code and opens; the inviter reads it, holds the card now and opens at that step, and answers the proposal once more.', [
      { act: 'propose' }, { deliver: 'propose' }, { act: 'accept' }, { act: 'back' }, { act: 'read-back' },
      { deliver: 'accept' }, { deliver: 'issue-inviter' }, { deliver: 'issue-responder' }, { deliver: 'receipt-of-issue-inviter' }, { deliver: 'receipt-of-issue-responder' },
      { deliver: 'accept' }, { deliver: 'issue-inviter' }, { deliver: 'issue-responder' }, { deliver: 'receipt-of-issue-inviter' }, { deliver: 'receipt-of-issue-responder' },
    ]),
  ]
}

/** Every schedule from the first act until nothing is possible and nothing is in flight: the two codes shown and read at
 *  any point, the carrier delivering in any order, the inviter's person accepting or declining. */
export function everySchedule (): Event[][] {
  const out: Event[][] = []
  const acts: Event[] = (['propose', 'back', 'read-back', 'accept', 'decline'] as const).map((act) => ({ act }))
  const go = (s: State, done: Event[]): void => {
    const next = [...acts, ...[...new Set(s.inFlight)].sort().map((deliver) => ({ deliver }) as Event)].filter((e) => possible(s, e))
    if (!next.length) { out.push(done); return }
    for (const e of next) go(apply(s, e).state, [...done, e])
  }
  go(start(), [])
  return out
}
