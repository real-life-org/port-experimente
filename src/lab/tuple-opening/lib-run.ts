// @ts-nocheck
// The traces of the rule (traces/*.json), run against the published library:
// two holders, the documents of one shared-connect enactment carried one by
// one in the order the trace gives (a redelivery hands the same bytes again). After every step it reads what the step
// sent, whether each side holds a contact (its tuple is open) and what its
// enactment holds back. Type checking is off: the library's results are
// read loosely here.
import { seedKeys, createHolder } from 'rltp-lib'
import { InMemoryStore } from 'rltp-lib/testing'
import { recipientOf, type Doc, type Role } from './rule'
import type { Shown, Trace } from './traces'

const RELAYS = [{ kind: 'tsp-mediator', address: 'did:web:mediator.example' }]
const other = (r: Role): Role => (r === 'inviter' ? 'responder' : 'inviter')

/** a document as text, whatever the order of its members */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x !== null && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x))

/** which of the seven documents this is, by its type and who sent it */
export function kindOf (from: Role, doc: any): Doc | null {
  const t = String(doc?.type ?? '').split('/spec/')[1] ?? ''
  if (t === 'vrc/relationships/propose/0.1') return 'propose'
  if (t === 'vrc/relationships/propose/0.1#response') return 'accept'
  if (t === 'vrc/relationships/issue/0.1') return from === 'inviter' ? 'issue-inviter' : 'issue-responder'
  if (t.startsWith('trust-task-error/')) return 'decline'
  if (t === 'vrc/relationships/issue/0.1#response') return from === 'inviter' ? 'receipt-of-issue-responder' : 'receipt-of-issue-inviter'
  return null
}

export type LibStep = { sent: Doc[], after: Shown }
export async function runOnLibrary (t: { name?: string, shows?: string, steps: unknown[] }): Promise<LibStep[]> {
  let clock = Date.parse('2026-10-15T09:00:00Z'), acts = 0
  const now = (): number => (clock += 10_000)
  const at = (extra = {}) => ({ when: now(), actId: 'run-' + (++acts), ...extra })
  const make = async (fill: number) => createHolder({ store: new InMemoryStore(), keys: seedKeys(new Uint8Array(64).fill(fill)) }, { modules: [], invariants: true })
  const P: Record<Role, any> = { inviter: await make(1), responder: await make(2) }
  /** in flight by name (a document sent again is there twice); `docs` keeps every document for a redelivery */
  const flight: Doc[] = [], docs = new Map<Doc, unknown>(), did: Partial<Record<Role, string>> = {}
  let sent: Doc[] = []
  /** the enactment's id (the link's handle) and the responder's back-code, for the offline acts of ../offline */
  let id = '', code = ''
  /** what a call of `from` sent in the ceremony goes into flight; the library's own outbox (probes, stars) is not carried */
  const collect = (from: Role, result: any): void => {
    if (result.ok === false) throw new Error(`refused: ${result.code}`)
    for (const e of (result.events ?? []).filter((x) => x.type === 'sharedconnect.send')) for (const doc of e.docs) {
      const k = kindOf(from, doc)
      if (!k) throw new Error(`a document the rule does not know: ${doc?.type}`)
      if (docs.has(k) && canon(docs.get(k)) !== canon(doc)) throw new Error(`sent again with another content: ${k}`)
      docs.set(k, doc); flight.push(k); sent.push(k)
    }
  }
  const side = async (r: Role) => {
    const es = Object.values((await P[r].snapshot()).state.sharedConnect?.enactments ?? {}) as any[]
    const view = (await P[r].sharedConnect())[0]
    const contacts = await P[r].contacts()
    // one enactment opens at most one contact, whatever is delivered or handed over again afterwards
    if (contacts.length > 1) throw new Error(`${r} holds ${contacts.length} contacts for one enactment`)
    if (es.length > 1) throw new Error(`${r} holds ${es.length} enactments`)
    return { open: contacts.length > 0, declined: es.some((e) => e.status === 'declined'), held: es.flatMap((e) => (e.flow?.held ?? []).map((d) => kindOf(other(r), d))), outbox: (view?.outbox ?? []).map((d) => kindOf(r, d)) }
  }
  const out: LibStep[] = []
  for (const s of t.steps) {
    sent = []
    if ('act' in s && s.act === 'propose') {
      const shown = await P.inviter.sharedConnectShow({ relays: RELAYS, name: 'inviter' }, at())
      const link = shown.events.find((e) => e.type === 'sharedconnect.shown')
      const proposed = await P.responder.sharedConnectPropose({ link: link.link, relays: RELAYS, channel: 'scan', name: 'responder' }, at())
      did.inviter = link.did; did.responder = proposed.events.find((e) => e.type === 'sharedconnect.proposed').did
      id = link.id
      collect('responder', proposed)
    } else if ('act' in s && s.act === 'back') {
      const back = await P.responder.sharedConnectBack({ id }, at())
      if (back.ok === false) throw new Error(`refused: ${back.code}`)
      code = back.events.find((e) => e.type === 'sharedconnect.shown').link
    } else if ('act' in s && s.act === 'read-back') {
      collect('inviter', await P.inviter.sharedConnectReadBack(id, code, now()))
    } else if ('act' in s) {
      const prompt = (await P.inviter.prompts()).find((x) => x.kind === 'shared-connect-confirm')
      collect('inviter', await P.inviter.decide(prompt.id, s.act, at()))
    } else {
      const d = 'redeliver' in s ? s.redeliver : s.deliver, to = recipientOf(d)
      if ('deliver' in s) { if (!flight.includes(d)) throw new Error(`not in flight: ${d}`); flight.splice(flight.indexOf(d), 1) }
      collect(to, await P[to].sharedConnectReceive(docs.get(d), did[other(to)], now()))
    }
    out.push({ sent, after: { inviter: await side('inviter'), responder: await side('responder'), inFlight: [...flight].sort() } })
  }
  return out
}
