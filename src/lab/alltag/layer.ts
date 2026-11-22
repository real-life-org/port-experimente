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

export type Progress = { outbound: any[], stoppedAt: string | null }

/** One device of the person: the library's holder, the personal log as far
 *  as this device knows it, and the application's conversation store.
 *
 *  What the human did is recorded once, as an entry with fixed ids, before
 *  anything is done about it. Every device, the acting one included, then
 *  applies that entry to its own inbox and conversation by the same
 *  routine. An entry is applied on a device when the device has taken its
 *  whole effect over; until then it stays open and is tried again, always
 *  with the ids it was written with. */
export class Device {
  /** the personal log as this device knows it, in an order that respects dependencies */
  readonly entries = new Map<string, Entry>()
  private readonly applied = new Set<string>()
  private heads: string[] = []
  private n = 0
  /** the application's conversation store on this device */
  readonly conversation = new Map<string, Line>()

  constructor (readonly name: string, readonly P: Person) {}

  private know (e: Entry): void {
    this.entries.set(e.id, e)
    this.heads = [...this.heads.filter((h) => !e.deps.includes(h)), e.id]
  }

  /** Records an entry of this device. `done`: its effect is already in place here. */
  private write (body: Body, done: boolean): Entry {
    const e: Entry = { id: `${this.name}#${++this.n}`, deps: [...this.heads], body }
    this.know(e)
    if (done) this.applied.add(e.id)
    return e
  }

  /** A document arrives from the carrier. Returns what the library answers. */
  async receive (envelope: any, t = tick()): Promise<any[]> {
    const got = await this.P.h.receive(envelope, clk(this.P, t))
    if (got.disposition === 'unique') this.write({ kind: 'received', envelope }, true)
    const { outbound } = await this.applyOpen(t)
    return [...(got.disposition === 'unique' || got.disposition === 'duplicate-known' ? got.outbound : []), ...outbound]
  }

  /** The human reads: the application takes every inbox entry over. The
   *  act is recorded with the ids read now; a message that arrives later is
   *  not part of it. */
  async takeAll (t = tick()): Promise<Progress> {
    const ids = (await this.P.h.inbox()).map((m: any) => m.id)
    if (ids.length) this.write({ kind: 'taken', ids }, false)
    return this.applyOpen(t)
  }

  /** The human writes to a contact. Returns the documents to hand to the carrier. */
  async send (contactId: string, text: string, t = tick()): Promise<any[]> {
    const r = ok(await this.P.h.sendMessage(contactId, text, { when: clk(this.P, t), actId: `${this.name}-send-${this.n}` }))
    const digest = r.outbound[0].digest
    this.conversation.set(digest, { dir: 'out', contactId, text, key: digest })
    this.write({ kind: 'sent', contactId, text, digest }, true)
    return r.outbound
  }

  /** Learns the entries of `from` this device lacks and applies what is open. */
  async syncFrom (from: Device, t = tick()): Promise<Progress> {
    let moved = true
    while (moved) {
      moved = false
      for (const e of from.entries.values()) {
        if (this.entries.has(e.id) || !e.deps.every((d) => this.entries.has(d))) continue
        this.know(e); moved = true
      }
    }
    return this.applyOpen(t)
  }

  /** Applies every open entry whose dependencies are applied, in order.
   *
   *  `received`: the library accepted the document (an accepted one runs on
   *  as `duplicate-known`). `taken`: no named message is left in the inbox,
   *  and each that was there stands once in the conversation. A named
   *  message that has not reached this device yet does not hold the entry
   *  open; it is taken over when it arrives (the pass at the end).
   *  `sent`: the line stands in the conversation.
   *  When a step fails, the entry and everything after it stay open; the
   *  call returns the entry it stopped at and the answers produced so far. */
  private async applyOpen (t: number): Promise<Progress> {
    const outbound: any[] = []
    let moved = true
    while (moved) {
      moved = false
      for (const e of this.entries.values()) {
        if (this.applied.has(e.id) || !e.deps.every((d) => this.applied.has(d))) continue
        try {
          if (e.body.kind === 'received') {
            const got = await this.P.h.receive(e.body.envelope, clk(this.P, t))
            if (got.disposition !== 'unique' && got.disposition !== 'duplicate-known') return { outbound, stoppedAt: e.id }
            if (got.disposition === 'unique') outbound.push(...got.outbound)
          } else if (e.body.kind === 'taken') {
            if (!(await this.take(e.body.ids, t))) return { outbound, stoppedAt: e.id }
          } else {
            this.conversation.set(e.body.digest, { dir: 'out', contactId: e.body.contactId, text: e.body.text, key: e.body.digest })
          }
        } catch {
          return { outbound, stoppedAt: e.id }
        }
        this.applied.add(e.id)
        moved = true
      }
    }
    // a message the person read elsewhere before it arrived here: its
    // `taken` entry is applied, the message is taken over on arrival
    try { await this.take([...this.entries.values()].flatMap((e) => (e.body.kind === 'taken' && this.applied.has(e.id) ? e.body.ids : [])), t) } catch { /* next call */ }
    return { outbound, stoppedAt: null }
  }

  /** Moves the named inbox entries into the conversation, one line per id,
   *  and out of the inbox. True when none of them is left in the inbox. */
  private async take (ids: string[], t: number): Promise<boolean> {
    const due = (await this.P.h.inbox()).filter((m: any) => ids.includes(m.id))
    if (!due.length) return true
    for (const m of due) this.conversation.set(m.id, { dir: 'in', contactId: m.contactId, text: m.text, key: m.id })
    ok(await this.P.h.takeMessages(due.map((m: any) => m.id), { when: clk(this.P, t) }))
    return !(await this.P.h.inbox()).some((m: any) => ids.includes(m.id))
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
