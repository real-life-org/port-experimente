// shared-connect 0.1 without a carrier: the two codes, as an extension of the
// rule of ../tuple-opening/rule.ts. Nothing here signs or checks; a code is
// a fact (it was shown, it was read) and `apply` is the whole rule. The
// traces under `traces/` are recorded from it (traces.ts) and checked
// against it and against the library (tests/offline.test.ts).
//
// The link the inviter shows in person carries the inviter's card (its pair
// keys); the back-code the responder shows carries the proposal and the
// responder's card. A side that holds the other's card can open its tuple
// without a document having been carried.
import * as opening from '../tuple-opening/rule'
import type { Doc, Role } from '../tuple-opening/rule'

export type State = opening.State & {
  /** the responder showed its proposal back as a code */
  back: boolean
  /** the inviter's camera read the back-code: it holds the responder's card */
  card: boolean
}
export type Event =
  | opening.Event
  /** the responder shows its proposal back as a code */
  | { act: 'back' }
  /** the inviter's camera reads the back-code */
  | { act: 'read-back' }

export const start = (): State => ({ ...opening.start(), back: false, card: false })
/** both the other side's issue and its receipt are taken: nothing of the enactment is left to do for this side */
const complete = (s: State, r: Role): boolean => s[r].issueTheirs && s[r].receiptTheirs
const offline = (e: Event): e is { act: 'back' } | { act: 'read-back' } => 'act' in e && (e.act === 'back' || e.act === 'read-back')

export function possible (s: State, e: Event): boolean {
  if (!offline(e)) return opening.possible(s, e)
  // the code is shown once and read once here; an enactment that ended, or completed, shows and reads nothing
  if (e.act === 'back') return s.responder.propose && !s.back && !s.responder.declined && !complete(s, 'responder')
  return s.back && !s.card && !s.inviter.declined && !complete(s, 'inviter')
}

/** The state after the event and what the event sent by the carrier (a code is not sent: it is shown). */
export function apply (s: State, e: Event): { state: State, sent: Doc[] } {
  if (!possible(s, e)) throw new Error(`not possible here: ${JSON.stringify(e)}`)
  if (!offline(e)) {
    const r = opening.apply(s, e)
    const n: State = { ...r.state, back: s.back, card: s.card }
    // X2: the inviter holds the responder's card, and its person accepts: it opens
    if ('act' in e && e.act === 'accept' && n.card) n.inviter.open = true
    return { state: n, sent: r.sent }
  }
  const n = JSON.parse(JSON.stringify(s)) as State, sent: Doc[] = []
  if (e.act === 'back') {
    // X1: the responder holds the inviter's card from the link it scanned: showing the code opens its tuple
    n.back = true; n.responder.open = true
    return { state: n, sent }
  }
  // X2: the back-code hands the inviter the proposal, as a carrier would have, and the responder's card
  n.card = true
  if (!n.inviter.propose) n.inviter.propose = true                       // taken; the person can decide now
  else if (n.inviter.accept) { sent.push('accept', 'issue-inviter'); n.inFlight.push('accept', 'issue-inviter') } // the proposal handed over again (O9)
  if (n.inviter.accept) n.inviter.open = true                            // accepted before the code was read: it opens now
  return { state: n, sent }
}

export const outbox = (s: State, r: Role): Doc[] => opening.outbox(s, r)
