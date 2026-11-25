// When each side of a shared-connect 0.1 enactment opens its tuple: the rule
// as a small model. Nothing here signs, checks or sends; a document is its
// name, a state is plain data and `apply` is the whole rule. The traces
// under `traces/` are recorded from it (traces.ts) and checked against it
// and against the library (tests/tuple-opening.test.ts).
//
// The six documents of an enactment, by who sends them:
//
//   propose                       responder → inviter
//   accept                        inviter → responder   (the propose's #response)
//   issue-inviter                 inviter → responder   (the inviter's credential)
//   issue-responder               responder → inviter   (the responder's credential)
//   receipt-of-issue-inviter      responder → inviter   (the #response to issue-inviter)
//   receipt-of-issue-responder    inviter → responder   (the #response to issue-responder)

export type Role = 'inviter' | 'responder'
export const DOCS = ['propose', 'accept', 'issue-inviter', 'issue-responder', 'receipt-of-issue-inviter', 'receipt-of-issue-responder'] as const
export type Doc = typeof DOCS[number]
/** who a document is for */
export const recipientOf = (d: Doc): Role => (d === 'propose' || d === 'issue-responder' || d === 'receipt-of-issue-inviter' ? 'inviter' : 'responder')

export type Side = {
  /** the responder sent its propose; the inviter took it */
  propose: boolean
  /** the inviter's person accepted; the responder took the acceptance */
  accept: boolean
  /** it took the other side's issue (and sent its receipt) */
  issueTheirs: boolean
  /** it took the other side's receipt of its own issue */
  receiptTheirs: boolean
  /** documents that arrived before the acceptance and wait for it */
  held: Doc[]
  /** its tuple is open */
  open: boolean
}
export type State = { inviter: Side, responder: Side, /** sent and not yet delivered */ inFlight: Doc[] }

export type Event =
  /** the responder read the link and its person confirmed: it proposes */
  | { act: 'propose' }
  /** the inviter's person accepts the proposal */
  | { act: 'accept' }
  /** the carrier hands a document to the side it is for */
  | { deliver: Doc }

const side = (): Side => ({ propose: false, accept: false, issueTheirs: false, receiptTheirs: false, held: [], open: false })
export const start = (): State => ({ inviter: side(), responder: side(), inFlight: [] })

export function possible (s: State, e: Event): boolean {
  if ('act' in e) return e.act === 'propose' ? !s.responder.propose : s.inviter.propose && !s.inviter.accept
  return s.inFlight.includes(e.deliver)
}

/** The state after the event, what the event sent, and whether it changed anything but the carrier. */
export function apply (s: State, e: Event): { state: State, sent: Doc[], effect: boolean } {
  if (!possible(s, e)) throw new Error(`not possible here: ${JSON.stringify(e)}`)
  const n = JSON.parse(JSON.stringify(s)) as State, sent: Doc[] = []
  const send = (d: Doc): void => { sent.push(d); n.inFlight.push(d) }
  /** a side opens its tuple when it holds both: the other side's issue and the other side's receipt of its own */
  const settle = (r: Role): void => { if (n[r].issueTheirs && n[r].receiptTheirs) n[r].open = true }
  const take = (d: Doc): void => {
    const r = recipientOf(d), me = n[r]
    if (d === 'propose') { me.propose = true; return }
    if (d === 'accept') {
      me.accept = true
      send('issue-responder')                                  // the responder issues as soon as the acceptance is in
      for (const h of me.held.splice(0)) take(h)               // what waited for the acceptance, in the order it arrived
      return
    }
    if (d === 'issue-inviter' || d === 'issue-responder') {
      if (!me.accept) { me.held.push(d); return }              // an issue before the acceptance waits; nothing is answered
      me.issueTheirs = true
      send(d === 'issue-inviter' ? 'receipt-of-issue-inviter' : 'receipt-of-issue-responder')
      settle(r); return
    }
    me.receiptTheirs = true; settle(r)
  }
  if ('act' in e) {
    if (e.act === 'propose') { n.responder.propose = true; send('propose') }
    else {
      n.inviter.accept = true; send('accept'); send('issue-inviter')          // the acceptance and the inviter's issue leave together
      for (const h of n.inviter.held.splice(0)) take(h)                       // not reached by an honest schedule: the responder issues after the acceptance
    }
  } else {
    n.inFlight.splice(n.inFlight.indexOf(e.deliver), 1)
    take(e.deliver)
  }
  return { state: n, sent, effect: true }
}
