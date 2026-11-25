// @ts-nocheck
// The time rules of a shared-connect proposal against the published library:
// an inviter shows a link at time 0, a responder proposes at `proposedAt`,
// the proposal reaches the inviter at `deliveredAt` (all in seconds). What
// the responder's and the inviter's library answer is read from their
// results. Type checking is off: the results are read loosely.
import { seedKeys, createHolder } from 'rltp-lib'
import { InMemoryStore } from 'rltp-lib/testing'
import { kindOf } from '../tuple-opening/lib-run'
import type { Doc } from '../tuple-opening/rule'

const RELAYS = [{ kind: 'tsp-mediator', address: 'did:web:mediator.example' }]
const T0 = Date.parse('2026-10-15T09:00:00Z')
export type Case = { channel: 'displayed' | 'sent', minutes?: number, proposedAt: number, deliveredAt: number, /** a second responder proposes on the same link, delivered a second later */ second?: boolean,
  /** after the proposal is taken: the person accepts at `decideAt` (default: `restAt`) and every later document is carried at `restAt` */ restAt?: number, decideAt?: number,
  /** only this document is carried at `restAt`; every other one at once after the decision */ late?: Doc }
export type Outcome = { expS: number, propose: string, inviter: string, second?: string, /** contacts each side holds at the end, with `restAt` */ contacts?: [number, number] }

export async function run (c: Case): Promise<Outcome> {
  let acts = 0
  const at = (s: number) => ({ when: T0 + s * 1000, actId: 'run-' + (++acts) })
  const make = async (fill: number) => createHolder({ store: new InMemoryStore(), keys: seedKeys(new Uint8Array(64).fill(fill)) }, { modules: [], invariants: true })
  const inviter = await make(1), responder = await make(2)
  const shown = await inviter.sharedConnectShow({ relays: RELAYS, name: 'inviter', channel: c.channel, ...(c.minutes === undefined ? {} : { minutes: c.minutes }) }, at(0))
  const link = shown.events.find((e) => e.type === 'sharedconnect.shown')
  const expS = Number(new URLSearchParams(String(link.link).split('#')[1]).get('_exp')) - T0 / 1000
  let sentBy = ''
  /** what the inviter says to a proposal: the event that names it */
  const take = async (from: any, proposedAt: number, deliveredAt: number): Promise<{ propose: string, inviter: string }> => {
    const p = await from.sharedConnectPropose({ link: link.link, relays: RELAYS, channel: c.channel === 'displayed' ? 'scan' : 'link', name: 'responder' }, at(proposedAt))
    if (p.ok === false) return { propose: `refused: ${p.code}`, inviter: 'nothing arrives' }
    const doc = p.events.find((e) => e.type === 'sharedconnect.send').docs[0], did = p.events.find((e) => e.type === 'sharedconnect.proposed').did
    if (from === responder) sentBy = did
    const r = await inviter.sharedConnectReceive(doc, did, T0 + deliveredAt * 1000)
    const ev = (r.events ?? []).find((e) => e.type === 'sharedconnect.pending' || e.type === 'sharedconnect.refused')
    return { propose: 'sent', inviter: r.ok === false ? `refused: ${r.code}` : ev?.type === 'sharedconnect.pending' ? 'taken' : ev ? `refused: ${ev.reason}` : `other: ${(r.events ?? []).map((e) => e.type).join(',')}` }
  }
  const first = await take(responder, c.proposedAt, c.deliveredAt)
  let contacts: [number, number] | undefined
  if (c.restAt !== undefined && first.inviter === 'taken') {
    const when = T0 + c.restAt * 1000, dids = { inviter: link.did, responder: sentBy }
    const decideAt = T0 + (c.decideAt ?? c.restAt) * 1000
    const prompt = (await inviter.prompts()).find((x) => x.kind === 'shared-connect-confirm')
    let queue: Array<{ to: 'inviter' | 'responder', doc: unknown }> = []
    const last: typeof queue = []
    const post = (from: 'inviter' | 'responder', r: any): void => {
      for (const e of (r.events ?? []).filter((x) => x.type === 'sharedconnect.send')) for (const doc of e.docs) (c.late !== undefined && kindOf(from, doc) === c.late ? last : queue).push({ to: from === 'inviter' ? 'responder' : 'inviter', doc })
    }
    const carry = async (at: number): Promise<void> => { while (queue.length) { const q = queue; queue = []; for (const d of q) post(d.to, await (d.to === 'inviter' ? inviter : responder).sharedConnectReceive(d.doc, dids[d.to === 'inviter' ? 'responder' : 'inviter'], at)) } }
    // a prompt that expired is gone or refuses the act: nothing is sent then
    if (prompt) post('inviter', await inviter.decide(prompt.id, 'accept', { when: decideAt, actId: 'run-accept' }))
    if (c.late !== undefined) await carry(decideAt + 1000)        // everything but the late document, right after the decision
    // each side's upkeep runs before the late documents arrive: what it no longer keeps is gone
    for (const h of [inviter, responder]) await h.tick(when)
    queue.push(...last.splice(0))
    await carry(when)
    contacts = [(await inviter.contacts()).length, (await responder.contacts()).length]
  }
  return { expS, ...first, ...(contacts ? { contacts } : {}), ...(c.second ? { second: (await take(await make(3), c.proposedAt, c.deliveredAt + 1)).inviter } : {}) }
}
