// When each side of a shared-connect 0.1 enactment opens its tuple: the rule
// as a small model. Nothing here signs, checks or sends; a document is its
// name, a state is plain data and `apply` is the whole rule. The traces
// under `traces/` are recorded from it (traces.ts) and checked against it
// and against the library (tests/tuple-opening.test.ts).
//
// The documents of an enactment, by who sends them:
//
//   propose                       responder → inviter
//   accept                        inviter → responder   (the propose's #response)
//   decline                       inviter → responder   (instead of accept: an error document)
//   issue-inviter                 inviter → responder   (the inviter's credential)
//   issue-responder               responder → inviter   (the responder's credential)
//   receipt-of-issue-inviter      responder → inviter   (the #response to issue-inviter)
//   receipt-of-issue-responder    inviter → responder   (the #response to issue-responder)

export type Role = 'inviter' | 'responder'
export const DOCS = ['propose', 'accept', 'decline', 'issue-inviter', 'issue-responder', 'receipt-of-issue-inviter', 'receipt-of-issue-responder'] as const
export type Doc = typeof DOCS[number]
/** who a document is for */
export const recipientOf = (d: Doc): Role => (d === 'propose' || d === 'issue-responder' || d === 'receipt-of-issue-inviter' ? 'inviter' : 'responder')

export type Side = {
  /** the responder sent its propose; the inviter took it */
  propose: boolean
  /** the inviter's person accepted; the responder took the acceptance */
  accept: boolean
  /** the inviter's person declined; the responder took the decline. The enactment is over for this side. */
  declined: boolean
  /** it took the other side's issue (and sent its receipt) */
  issueTheirs: boolean
  /** it took the other side's receipt of its own issue */
  receiptTheirs: boolean
  /** documents that arrived before the acceptance and wait for it */
  held: Doc[]
  /** its tuple is open */
  open: boolean
}
export type State = { inviter: Side, responder: Side, /** sent and not yet delivered; a document sent again is there twice */ inFlight: Doc[] }

export type Event =
  /** the responder read the link and its person confirmed: it proposes */
  | { act: 'propose' }
  /** the inviter's person accepts the proposal */
  | { act: 'accept' }
  /** the inviter's person declines the proposal */
  | { act: 'decline' }
  /** the carrier hands a document in flight to the side it is for */
  | { deliver: Doc }
  /** the carrier hands over once more a document it delivered before */
  | { redeliver: Doc }

const side = (): Side => ({ propose: false, accept: false, declined: false, issueTheirs: false, receiptTheirs: false, held: [], open: false })
export const start = (): State => ({ inviter: side(), responder: side(), inFlight: [] })

/** whether the side the document is for has been handed it before (taken or held back) */
export function handed (s: State, d: Doc): boolean {
  const me = s[recipientOf(d)]
  if (me.held.includes(d)) return true
  if (d === 'propose') return me.propose
  if (d === 'accept') return me.accept
  if (d === 'decline') return me.declined
  return d === 'issue-inviter' || d === 'issue-responder' ? me.issueTheirs : me.receiptTheirs
}

/** What a side sends again after a restart: its own documents the other side may still be waiting for. While the
 *  enactment runs, everything it sent so far; once its tuple is open, only its receipt. */
export function outbox (s: State, r: Role): Doc[] {
  const me = s[r]
  // complete: both the other side's issue and its receipt are taken (O6; the moment the tuple opens here)
  const complete = me.issueTheirs && me.receiptTheirs
  if (r === 'inviter') {
    if (complete) return ['receipt-of-issue-responder']
    return [...(me.accept ? ['accept' as const] : []), ...(me.declined ? ['decline' as const] : []), ...(me.accept ? ['issue-inviter' as const] : []), ...(me.issueTheirs ? ['receipt-of-issue-responder' as const] : [])]
  }
  if (complete) return ['receipt-of-issue-inviter']
  return [...(me.propose ? ['propose' as const] : []), ...(me.accept ? ['issue-responder' as const] : []), ...(me.issueTheirs ? ['receipt-of-issue-inviter' as const] : [])]
}

export function possible (s: State, e: Event): boolean {
  if ('act' in e) return e.act === 'propose' ? !s.responder.propose : s.inviter.propose && !s.inviter.accept && !s.inviter.declined
  if ('redeliver' in e) return handed(s, e.redeliver)
  return s.inFlight.includes(e.deliver)
}

/** The state after the event and what the event sent. */
export function apply (s: State, e: Event): { state: State, sent: Doc[] } {
  if (!possible(s, e)) throw new Error(`not possible here: ${JSON.stringify(e)}`)
  const n = JSON.parse(JSON.stringify(s)) as State, sent: Doc[] = []
  const send = (d: Doc): void => { sent.push(d); n.inFlight.push(d) }
  /** a side opens its tuple when it has taken both: the other side's issue and the other side's receipt of its own */
  const settle = (r: Role): void => { if (n[r].issueTheirs && n[r].receiptTheirs) n[r].open = true }
  /** A document the side was handed before: it changes nothing. The side sends again what it sent when it took it. */
  const again = (d: Doc): void => {
    const me = n[recipientOf(d)]
    if (me.held.includes(d)) return                                             // still held back: there was no answer yet
    if (d === 'propose') { if (me.accept) { send('accept'); send('issue-inviter') } else if (me.declined) send('decline'); return }
    if (d === 'accept') { send('issue-responder'); return }                     // only its own issue, not the receipt of a held one
    if (d === 'issue-inviter') send('receipt-of-issue-inviter')
    if (d === 'issue-responder') send('receipt-of-issue-responder')
    // a receipt or a decline has no answer
  }
  const take = (d: Doc): void => {
    const r = recipientOf(d), me = n[r]
    if (d === 'propose') { me.propose = true; return }
    if (d === 'decline') { me.declined = true; me.held = []; return }           // over: what was held back is dropped
    if (d === 'accept') {
      me.accept = true
      send('issue-responder')                                                   // the responder issues as soon as the acceptance is in
      for (const h of me.held.splice(0)) take(h)                                // what waited for the acceptance, in the order it arrived
      return
    }
    if (d === 'issue-inviter' || d === 'issue-responder') {
      if (!me.accept) { me.held.push(d); return }                               // an issue before the acceptance waits; nothing is answered
      me.issueTheirs = true
      send(d === 'issue-inviter' ? 'receipt-of-issue-inviter' : 'receipt-of-issue-responder')
      settle(r); return
    }
    me.receiptTheirs = true; settle(r)
  }
  if ('act' in e) {
    if (e.act === 'propose') { n.responder.propose = true; send('propose') }
    else if (e.act === 'decline') { n.inviter.declined = true; n.inviter.held = []; send('decline') }
    else {
      n.inviter.accept = true; send('accept'); send('issue-inviter')            // the acceptance and the inviter's issue leave together
      for (const h of n.inviter.held.splice(0)) take(h)                         // not reached by an honest schedule: the responder issues after the acceptance
    }
  } else if ('redeliver' in e) {
    again(e.redeliver)
  } else {
    const before = handed(s, e.deliver)
    n.inFlight.splice(n.inFlight.indexOf(e.deliver), 1)
    if (before) again(e.deliver); else take(e.deliver)                          // a second copy in flight is a redelivery
  }
  return { state: n, sent }
}
