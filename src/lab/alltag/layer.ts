// A prototype of device sync as a layer above the published library, to
// try the cut the design review proposed before anything moves into the
// library: what a device received travels to the person's other devices
// as an input, and what the human did travels as a named entry. Each
// device runs the library's own reception and checks for itself; contacts,
// inbox and conversation are views each device computes.
//
// Scope of this file: messages. The personal log is the smallest thing
// that orders entries (ids, dependencies, exchange of what is missing); it
// is a stand-in for the group log's exchange, not a proposal for it.
import { clk, ok, short, tick, type Person } from './fixture'

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Body =
  | { kind: 'received', envelope: any }                       // a document this device accepted
  | { kind: 'taken', ids: string[] }                          // the application took these inbox entries over
  | { kind: 'sent', contactId: string, text: string, digest: string }
export type Entry = { id: string, deps: string[], body: Body }
export type Line = { dir: 'in' | 'out', contactId?: string, text: string, key: string }

export class Device {
  readonly entries = new Map<string, Entry>()
  private readonly applied = new Set<string>()
  private heads: string[] = []
  private n = 0
  private readonly taken = new Set<string>()
  /** the application's conversation store on this device */
  readonly conversation = new Map<string, Line>()

  constructor (readonly name: string, readonly P: Person) {}

  private write (body: Body): void {
    const e: Entry = { id: `${this.name}#${++this.n}`, deps: [...this.heads], body }
    this.entries.set(e.id, e); this.applied.add(e.id); this.heads = [e.id]
  }

  /** A document arrives from the carrier. Returns what the library answers. */
  async receive (envelope: any, t = tick()): Promise<any[]> {
    const got = await this.P.h.receive(envelope, clk(this.P, t))
    if (got.disposition === 'unique') this.write({ kind: 'received', envelope })
    await this.settleInbox(t)
    return got.disposition === 'unique' || got.disposition === 'duplicate-known' ? got.outbound : []
  }

  /** The human reads: the application takes every inbox entry over. */
  async takeAll (t = tick()): Promise<void> {
    const ids = (await this.P.h.inbox()).map((m: any) => m.id)
    if (!ids.length) return
    for (const id of ids) this.taken.add(id)
    this.write({ kind: 'taken', ids })
    await this.settleInbox(t)
  }

  /** The human writes to a contact. Returns the documents to hand to the carrier. */
  async send (contactId: string, text: string, t = tick()): Promise<any[]> {
    const r = ok(await this.P.h.sendMessage(contactId, text, { when: clk(this.P, t), actId: `${this.name}-send-${this.n}` }))
    const digest = r.outbound[0].digest
    this.conversation.set(digest, { dir: 'out', contactId, text, key: digest })
    this.write({ kind: 'sent', contactId, text, digest })
    return r.outbound
  }

  /** Every inbox entry the person took over, on any device, moves into this device's conversation. */
  private async settleInbox (t: number): Promise<void> {
    const due = (await this.P.h.inbox()).filter((m: any) => this.taken.has(m.id))
    if (!due.length) return
    for (const m of due) this.conversation.set(m.id, { dir: 'in', contactId: m.contactId, text: m.text, key: m.id })
    ok(await this.P.h.takeMessages(due.map((m: any) => m.id), { when: clk(this.P, t) }))
  }

  /** Takes the entries of `from` this device lacks, in causal order. An
   *  entry counts as applied only after its effect is in place: when the
   *  library throws or does not accept a passed-on document, the entry and
   *  everything after it stay open and the next sync tries again. Returns
   *  what the library answers on the way and the entry it stopped at. */
  async syncFrom (from: Device, t = tick()): Promise<{ outbound: any[], stoppedAt: string | null }> {
    const outbound: any[] = []
    let moved = true
    while (moved) {
      moved = false
      for (const e of from.entries.values()) {
        if (this.applied.has(e.id) || !e.deps.every((d) => this.applied.has(d))) continue
        if (e.body.kind === 'received') {
          let got: any
          try { got = await this.P.h.receive(e.body.envelope, clk(this.P, t)) } catch { return { outbound, stoppedAt: e.id } }
          if (got.disposition !== 'unique' && got.disposition !== 'duplicate-known') return { outbound, stoppedAt: e.id }
          if (got.disposition === 'unique') outbound.push(...got.outbound)
        } else if (e.body.kind === 'taken') {
          for (const id of e.body.ids) this.taken.add(id)
        } else {
          this.conversation.set(e.body.digest, { dir: 'out', contactId: e.body.contactId, text: e.body.text, key: e.body.digest })
        }
        this.entries.set(e.id, e); this.applied.add(e.id)
        this.heads = [...this.heads.filter((h) => !e.deps.includes(h)), e.id]
        await this.settleInbox(t)
        moved = true
      }
    }
    return { outbound, stoppedAt: null }
  }
}

/** Hands documents to a holder outside the layer (the friend) and returns its answers with their verdicts. */
export async function handTo (P: Person, docs: any[], t = tick()): Promise<{ answers: any[], verdicts: string[] }> {
  const answers: any[] = [], verdicts: string[] = []
  for (const o of docs) {
    const got = await P.h.receive(o.envelope, clk(P, t))
    verdicts.push(`${short(o.type)}: ${got.disposition}${got.reason ? ' ' + got.reason : ''}`)
    if (got.disposition === 'unique' || got.disposition === 'duplicate-known') answers.push(...got.outbound)
  }
  return { answers, verdicts }
}
