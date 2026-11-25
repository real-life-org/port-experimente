// @ts-nocheck
// The rule of rule.ts against the published library: two holders run
// shared-connect enactments with given channels, and each side's contact is
// read: the channels it shows, whether it met, and whether the trust act is
// taken. Type checking is off: the library's results are read loosely here.
import { seedKeys, createHolder } from 'rltp-lib'
import { InMemoryStore } from 'rltp-lib/testing'
import { kindOf } from '../tuple-opening/lib-run'
import { recipientOf, type Doc, type Role } from '../tuple-opening/rule'
import type { Channel } from './rule'

const RELAYS = [{ kind: 'tsp-mediator', address: 'did:web:mediator.example' }]
const other = (r: Role): Role => (r === 'inviter' ? 'responder' : 'inviter')
/** the order in which every document arrives as it was sent; the inviter opens first */
export const IN_ORDER: Doc[] = ['propose', 'accept', 'issue-inviter', 'issue-responder', 'receipt-of-issue-inviter', 'receipt-of-issue-responder']
/** the same with the two receipts the other way round; the responder opens first */
export const RESPONDER_FIRST: Doc[] = ['propose', 'accept', 'issue-inviter', 'issue-responder', 'receipt-of-issue-responder', 'receipt-of-issue-inviter']

export type Seen = { contacts: Array<{ channel: Channel | null, theirChannel: Channel | null, met: boolean | null, trust: string }> }
export type Pair = { a: any, b: any, enact: (inviter: 'a' | 'b', shown: 'displayed' | 'sent', read: 'scan' | 'link', order?: Doc[]) => Promise<void>, settle: () => Promise<void>, seen: (p: 'a' | 'b') => Promise<Seen> }

export async function pair (): Promise<Pair> {
  let clock = Date.parse('2026-10-15T09:00:00Z'), acts = 0
  const now = (): number => (clock += 10_000)
  const at = (extra = {}) => ({ when: now(), actId: 'run-' + (++acts), ...extra })
  const make = async (fill: number) => createHolder({ store: new InMemoryStore(), keys: seedKeys(new Uint8Array(64).fill(fill)) }, { modules: [], invariants: true })
  const H = { a: await make(1), b: await make(2) }
  for (const p of ['a', 'b']) { const r = await H[p].foundPersonalCommunity({ name: p }, at()); if (r && r.ok === false) throw new Error(`community: ${r.code}`) }

  /** what the library sends on its own after a tuple opened (probes, mappings, stars, acknowledgements): the envelope and whom it is for */
  const outbox: Array<{ to: 'a' | 'b', envelope: unknown }> = []
  const post = (from: 'a' | 'b', result: any): void => { for (const o of result?.outbound ?? []) outbox.push({ to: from === 'a' ? 'b' : 'a', envelope: o.envelope }) }
  /** Deliver everything the library sends on its own, and what that causes, until nothing is left: recognition runs to its end. */
  async function settle (): Promise<void> {
    for (let round = 0; round < 20; round++) {
      for (const p of ['a', 'b'] as const) post(p, await H[p].resume(now()))
      if (!outbox.length) return
      for (const d of outbox.splice(0)) post(d.to, await H[d.to].receive(d.envelope, now()))
    }
  }

  /** One enactment: `inviter` shows the link by `shown`, the other reads it by `read`; the six documents are delivered in `order`. */
  async function enact (inviter: 'a' | 'b', shown: 'displayed' | 'sent', read: 'scan' | 'link', order: Doc[] = IN_ORDER): Promise<void> {
    const P: Record<Role, any> = { inviter: H[inviter], responder: H[inviter === 'a' ? 'b' : 'a'] }
    const flight = new Map<Doc, unknown>(), did: Partial<Record<Role, string>> = {}
    const collect = (from: Role, result: any): void => {
      if (result.ok === false) throw new Error(`refused: ${result.code}`)
      post(from === 'inviter' ? inviter : (inviter === 'a' ? 'b' : 'a'), result)
      for (const e of (result.events ?? []).filter((x) => x.type === 'sharedconnect.send')) for (const doc of e.docs) flight.set(kindOf(from, doc) as Doc, doc)
    }
    const show = await P.inviter.sharedConnectShow({ relays: RELAYS, name: 'inviter', channel: shown }, at())
    const link = show.events.find((e) => e.type === 'sharedconnect.shown')
    const proposed = await P.responder.sharedConnectPropose({ link: link.link, relays: RELAYS, channel: read, name: 'responder' }, at())
    did.inviter = link.did; did.responder = proposed.events.find((e) => e.type === 'sharedconnect.proposed').did
    collect('responder', proposed)
    for (const d of order) {
      const to = recipientOf(d)
      collect(to, await P[to].sharedConnectReceive(flight.get(d), did[other(to)], now()))
      if (d === 'propose') {
        const prompt = (await P.inviter.prompts()).find((x) => x.kind === 'shared-connect-confirm')
        collect('inviter', await P.inviter.decide(prompt.id, 'accept', at()))
      }
    }
  }
  /** each contact of `p`: what its view says, and what the trust act answers (tried on a copy of nothing: the act is made, then taken back) */
  async function seen (p: 'a' | 'b'): Promise<Seen> {
    const out: Seen['contacts'] = []
    for (const c of await H[p].contacts()) {
      const r = await H[p].setClass(c.id, 'anchorMapping', 'on', at())
      if (r.ok !== false) await H[p].setClass(c.id, 'anchorMapping', 'off', at())
      out.push({ channel: c.sharedConnect?.channel ?? null, theirChannel: c.sharedConnect?.theirChannel ?? null, met: c.sharedConnect?.met ?? null, trust: r.ok === false ? r.code : 'taken' })
    }
    return { contacts: out }
  }
  return { a: H.a, b: H.b, enact, settle, seen }
}
