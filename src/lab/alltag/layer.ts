// A prototype of device sync as a layer above the published library, to
// try the cut the design review proposed before anything moves into the
// library: what a device received travels to the person's other devices
// as an input, and what the human did travels as a named entry. Each
// device runs the library's own reception and checks for itself; contacts,
// inbox and conversation are views each device computes.
//
// Scope of this file: messages. The log and the applying of entries are the
// core's (core.ts); this file says what a message entry is and does.
import { clk, ok, short, tick, type Person } from './fixture'
import { Sync, type Progress, type Step } from './core'

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Body =
  | { kind: 'received', envelope: any }                       // a document this device accepted
  | { kind: 'taken', ids: string[] }                          // the application took these inbox entries over
  | { kind: 'sent', contactId: string, text: string, digest: string }
export type Line = { dir: 'in' | 'out', contactId?: string, text: string, key: string }
export type { Progress } from './core'

/** One device of the person: the library's holder, the personal log as far
 *  as this device knows it, and the application's conversation store.
 *
 *  What the human did is recorded once, as an entry with fixed ids, before
 *  anything is done about it. Every device, the acting one included, then
 *  applies that entry to its own inbox and conversation by the same
 *  routine. An entry is applied on a device when the device has taken its
 *  whole effect over; until then it stays open and is tried again, always
 *  with the ids it was written with. */
export class Device extends Sync<Body> {
  /** the application's conversation store on this device */
  readonly conversation = new Map<string, Line>()

  /** A document arrives from the carrier. Returns what the library answers. */
  receive (envelope: any, t = tick()): Promise<any[]> {
    return this.exclusive(async () => {
      const got = await this.P.h.receive(envelope, clk(this.P, t))
      if (got.disposition === 'unique') this.write({ kind: 'received', envelope }, true)
      const { outbound } = await this.applyOpen(t)
      return [...(got.disposition === 'unique' || got.disposition === 'duplicate-known' ? got.outbound : []), ...outbound]
    })
  }

  /** The human reads: the application takes every inbox entry over. The
   *  act is recorded with the ids read now; a message that arrives later is
   *  not part of it. */
  takeAll (t = tick()): Promise<Progress> {
    return this.exclusive(async () => {
      const ids = (await this.P.h.inbox()).map((m: any) => m.id)
      if (ids.length) this.write({ kind: 'taken', ids }, false)
      return this.applyOpen(t)
    })
  }

  /** The human writes to a contact. Returns the documents to hand to the carrier. */
  send (contactId: string, text: string, t = tick()): Promise<any[]> {
    return this.exclusive(async () => {
      const r = ok(await this.P.h.sendMessage(contactId, text, { when: clk(this.P, t), actId: `${this.name}-send-${this.next - 1}` }))
      const digest = r.outbound[0].digest
      this.conversation.set(digest, { dir: 'out', contactId, text, key: digest })
      this.write({ kind: 'sent', contactId, text, digest }, true)
      return r.outbound
    })
  }

  /** Messages have no answer whose standing a handover would give. */
  protected mayLeave (): boolean { return true }
  protected carriesAnswer (): boolean { return false }
  /** A stop is named by its entry alone. */
  protected stopped (id: string): string { return id }

  /** `received`: the library accepted the document (an accepted one runs on
   *  as `duplicate-known`). `taken`: no named message is left in the inbox,
   *  and each that was there stands once in the conversation. A named
   *  message that has not reached this device yet does not hold the entry
   *  open; it is taken over when it arrives (`after`). `sent`: the line
   *  stands in the conversation. */
  protected async apply (e: { id: string, body: Body }, _own: boolean, t: number): Promise<Step> {
    if (e.body.kind === 'received') {
      const got = await this.P.h.receive(e.body.envelope, clk(this.P, t))
      if (got.disposition !== 'unique' && got.disposition !== 'duplicate-known') return { wait: got.disposition }
      return { outbound: got.disposition === 'unique' ? got.outbound : [] }
    }
    if (e.body.kind === 'taken') return (await this.take(e.body.ids, t)) ? undefined : { wait: 'not all taken' }
    this.conversation.set(e.body.digest, { dir: 'out', contactId: e.body.contactId, text: e.body.text, key: e.body.digest })
  }

  /** A message the person read elsewhere before it arrived here: its
   *  `taken` entry is applied, the message is taken over on arrival. */
  protected async after (t: number): Promise<void> {
    await this.take(this.of('taken').flatMap((e) => (this.applied.has(e.id) ? e.body.ids : [])), t)
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
