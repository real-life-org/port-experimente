// @ts-nocheck
// The traces of the rule (traces/*.json), run against the published library:
// two holders, the documents of one shared-connect enactment carried one by
// one in the order the trace gives. After every step it reads what the step
// sent, whether each side holds a contact (its tuple is open) and what its
// enactment holds back. Type checking is off: the library's results are
// read loosely here.
import { seedKeys, createHolder } from 'rltp-lib'
import { InMemoryStore } from 'rltp-lib/testing'
import { recipientOf, type Doc, type Role } from './rule'
import type { Shown, Trace } from './traces'

const RELAYS = [{ kind: 'tsp-mediator', address: 'did:web:mediator.example' }]
const other = (r: Role): Role => (r === 'inviter' ? 'responder' : 'inviter')

/** which of the six documents this is, by its type and who sent it */
export function kindOf (from: Role, doc: any): Doc | null {
  const t = String(doc?.type ?? '').split('/spec/')[1] ?? ''
  if (t === 'vrc/relationships/propose/0.1') return 'propose'
  if (t === 'vrc/relationships/propose/0.1#response') return 'accept'
  if (t === 'vrc/relationships/issue/0.1') return from === 'inviter' ? 'issue-inviter' : 'issue-responder'
  if (t === 'vrc/relationships/issue/0.1#response') return from === 'inviter' ? 'receipt-of-issue-responder' : 'receipt-of-issue-inviter'
  return null
}

export type LibStep = { sent: Doc[], after: Shown }
export async function runOnLibrary (t: Trace): Promise<LibStep[]> {
  let clock = Date.parse('2026-10-15T09:00:00Z'), acts = 0
  const now = (): number => (clock += 10_000)
  const at = (extra = {}) => ({ when: now(), actId: 'run-' + (++acts), ...extra })
  const make = async (fill: number) => createHolder({ store: new InMemoryStore(), keys: seedKeys(new Uint8Array(64).fill(fill)) }, { modules: [], invariants: true })
  const P: Record<Role, any> = { inviter: await make(1), responder: await make(2) }
  const flight = new Map<Doc, unknown>(), did: Partial<Record<Role, string>> = {}
  let sent: Doc[] = []
  /** what a call of `from` sent in the ceremony goes into flight; the library's own outbox (probes, stars) is not carried */
  const collect = (from: Role, result: any): void => {
    if (result.ok === false) throw new Error(`refused: ${result.code}`)
    for (const e of (result.events ?? []).filter((x) => x.type === 'sharedconnect.send')) for (const doc of e.docs) {
      const k = kindOf(from, doc)
      if (!k) throw new Error(`a document the rule does not know: ${doc?.type}`)
      flight.set(k, doc); sent.push(k)
    }
  }
  const held = async (r: Role): Promise<Doc[]> => {
    const es = Object.values((await P[r].snapshot()).state.sharedConnect?.enactments ?? {}) as any[]
    return es.flatMap((e) => (e.flow?.held ?? []).map((d) => kindOf(other(r), d)))
  }
  const out: LibStep[] = []
  for (const s of t.steps) {
    sent = []
    if ('act' in s && s.act === 'propose') {
      const shown = await P.inviter.sharedConnectShow({ relays: RELAYS, name: 'inviter' }, at())
      const link = shown.events.find((e) => e.type === 'sharedconnect.shown')
      const proposed = await P.responder.sharedConnectPropose({ link: link.link, relays: RELAYS, channel: 'scan', name: 'responder' }, at())
      did.inviter = link.did; did.responder = proposed.events.find((e) => e.type === 'sharedconnect.proposed').did
      collect('responder', proposed)
    } else if ('act' in s) {
      const prompt = (await P.inviter.prompts()).find((x) => x.kind === 'shared-connect-confirm')
      collect('inviter', await P.inviter.decide(prompt.id, 'accept', at()))
    } else {
      const to = recipientOf(s.deliver), doc = flight.get(s.deliver)
      if (!doc) throw new Error(`not in flight: ${s.deliver}`)
      flight.delete(s.deliver)
      collect(to, await P[to].sharedConnectReceive(doc, did[other(to)], now()))
    }
    out.push({ sent, after: {
      inviter: { open: (await P.inviter.contacts()).length > 0, held: await held('inviter') },
      responder: { open: (await P.responder.contacts()).length > 0, held: await held('responder') },
      inFlight: [...flight.keys()].sort(),
    } })
  }
  return out
}
