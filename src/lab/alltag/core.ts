// The common core of the layer prototype: what the three cuts (messages,
// invitation, encounter) each built for themselves and the reviews each
// time found faults in. A cut supplies its kinds of entry, how one is
// applied (which call of the library), and what holds for a subject; the
// rest is here, once.
//
// The rules of the core:
//
//   1. First record, then act. What the human did is an entry before
//      anything is done about it, and every device, the acting one
//      included, applies it by the same routine (`applyOpen`).
//   2. A break leaves an entry open, a refusal closes it. A step that breaks
//      off (an exception) is tried again by the next call. A refusal by the
//      library is its verdict: the acting device notes in the log that
//      nothing happened (`void`), the entry is closed, what follows runs.
//   3. One evaluation of what took effect. An entry that is `void` counts
//      nowhere: not in the sync, not in what holds, not at the door
//      (`effective`).
//   4. The rule is asked at the door. Whether a document that gives an
//      answer its standing may leave is decided from the entries the device
//      knows at the moment of the first handover (`toCarrier`), not from
//      what an earlier application managed to do.
//   5. Between two answers of one person (Anton, 2026-11-23): what the
//      counterpart took first holds, proven by its answer; what has not left
//      the own device may be taken back (`rule`).
//
// The log itself is the smallest thing that orders entries (ids,
// dependencies, exchange of what is missing): a stand-in for the group
// log's exchange, not a proposal for it. It is in memory and unsealed.
import { tick, type Person } from './fixture'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The entries every cut has. `subject` is what an answer is about (an invitation, a request). */
export type CoreBody =
  | { kind: 'void', cause: string, code: string }       // the library refused the act of entry `cause` on its device: nothing happened
  | { kind: 'handed', subject: string, cause: string }  // the answer of entry `cause` left its device for the carrier
export type Entry<B> = { id: string, deps: string[], body: B | CoreBody }
export type Progress = { outbound: any[], stoppedAt: string | null }
/** What applying one entry gave: documents for the carrier, or a reason the entry has to wait. */
export type Step = { outbound?: any[], wait?: string } | void

/** Rule 5 as a function of what a device knows about one subject.
 *  `confirmed`: the accept the counterpart's answer names. `handed`: the
 *  accepts that left a device. `declined`: a decline on any device.
 *  `first`: the accept that may leave where nothing else decides. */
export function rule<T> (known: { confirmed?: T, handed: T[], declined: boolean, first?: T }): { accepts: T[] } | 'declined' | 'open' {
  if (known.confirmed !== undefined) return { accepts: [known.confirmed] }
  // every accept that left may be the one the counterpart takes: all stay candidates until its answer names one
  if (known.handed.length) return { accepts: known.handed }
  if (known.declined) return 'declined'
  return known.first !== undefined ? { accepts: [known.first] } : 'open'
}

export abstract class Sync<B extends { kind: string }, P extends Person = Person> {
  /** the personal log as this device knows it, in an order that respects dependencies */
  readonly entries = new Map<string, Entry<B>>()
  protected readonly applied = new Set<string>()
  private heads: string[] = []
  private n = 0
  /** documents this device's library produced that must not reach the carrier */
  readonly withheld: any[] = []
  /** acts the library refused for good on this device, with its code: closed, not retried */
  readonly refused: string[] = []
  /** documents that give an answer its standing once they leave: entry → subject and documents */
  private readonly standing = new Map<string, { subject: string, docs: any[] }>()

  constructor (readonly name: string, readonly P: P) {}

  // ---- the log

  private know (e: Entry<B>): void {
    this.entries.set(e.id, e)
    this.heads = [...this.heads.filter((h) => !e.deps.includes(h)), e.id]
  }

  /** Records an entry of this device. `done`: its effect is already in place here. */
  protected write (body: B | CoreBody, done: boolean): Entry<B> {
    const e: Entry<B> = { id: `${this.name}#${++this.n}`, deps: [...this.heads], body }
    this.know(e)
    if (done) this.applied.add(e.id)
    return e
  }

  /** The number the next entry of this device gets. */
  protected get next (): number { return this.n + 1 }

  protected own (id: string): boolean { return id.startsWith(this.name + '#') }

  /** The entries of the cut's own kinds, in the order of the log. */
  protected of<K extends B['kind']> (kind: K): Array<{ id: string, body: Extract<B, { kind: K }> }> {
    return [...this.entries.values()].filter((e) => e.body.kind === kind) as any
  }

  /** Learns the entries of `from` this device lacks and applies what is open. */
  async syncFrom (from: { entries: Map<string, Entry<B>> }, t = tick()): Promise<Progress> {
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

  // ---- what took effect (rule 3)

  /** The library refused the act of this entry on its device: it had no effect, anywhere. */
  voided (id: string): boolean {
    return [...this.entries.values()].some((x) => x.body.kind === 'void' && (x.body as any).cause === id)
  }

  /** Of the given entries those that took effect, by entry id. */
  protected effective<E extends { id: string }> (entries: E[]): E[] {
    return entries.filter((e) => !this.voided(e.id)).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
  }

  /** The entries whose answer about `subject` left a device, by entry id. */
  protected handed (subject: string): string[] {
    const causes = [...this.entries.values()].flatMap((e) => (e.body.kind === 'handed' && (e.body as any).subject === subject ? [(e.body as any).cause as string] : []))
    return [...new Set(causes)].filter((c) => !this.voided(c)).sort()
  }

  // ---- applying (rules 1 and 2)

  /** Applies one entry of the cut's own kinds. Throwing means the step broke off. */
  protected abstract apply (e: { id: string, body: B }, own: boolean, t: number): Promise<Step>
  /** What holds for `subject` may have changed (a handover, a refused answer): bring the library in line. */
  protected async settle (_subject: string, _t: number): Promise<void> {}
  /** The subject an entry of the cut answers, if it is an answer. */
  protected subjectOf (_body: B): string | undefined { return undefined }
  /** Runs after every pass over the open entries. */
  protected async after (_t: number): Promise<void> {}
  /** How a stop is named in the progress. */
  protected stopped (id: string, why: string): string { return `${id}: ${why}` }

  /** The library refused the act of `e` for good: closed here, and noted in the log by the acting device. */
  protected refuse (e: { id: string }, code: string): void {
    this.refused.push(`${e.id}: ${code}`)
    if (this.own(e.id) && !this.voided(e.id)) this.write({ kind: 'void', cause: e.id, code }, true)
  }

  /** Applies every open entry whose dependencies are applied, in order.
   *  When a step breaks off or has to wait, the entry and everything after
   *  it stay open; the call returns where it stopped and the documents
   *  produced so far. */
  protected async applyOpen (t: number): Promise<Progress> {
    const outbound: any[] = []
    let moved = true
    while (moved) {
      moved = false
      for (const e of [...this.entries.values()]) {
        if (this.applied.has(e.id) || !e.deps.every((d) => this.applied.has(d))) continue
        try {
          if (e.body.kind === 'handed') {
            await this.settle((e.body as any).subject, t)
          } else if (e.body.kind === 'void') {
            // the act it names is skipped where it has not run; an answer it names no longer counts: what holds is settled again
            const cause = this.entries.get((e.body as any).cause)
            const subject = cause && cause.body.kind !== 'void' && cause.body.kind !== 'handed' ? this.subjectOf(cause.body as B) : undefined
            if (subject !== undefined) await this.settle(subject, t)
          } else if (!this.voided(e.id)) {
            // (an entry that is void: the acting device was refused, nothing happened there, nothing happens here)
            const step = await this.apply(e as { id: string, body: B }, this.own(e.id), t)
            if (step?.outbound) outbound.push(...step.outbound)
            if (step?.wait !== undefined) return { outbound, stoppedAt: this.stopped(e.id, step.wait) }
          }
        } catch (err) {
          return { outbound, stoppedAt: this.stopped(e.id, (err as Error).message) }
        }
        this.applied.add(e.id)
        moved = true
      }
    }
    try { await this.after(t) } catch { /* the next call */ }
    return { outbound, stoppedAt: null }
  }

  // ---- the door to the carrier (rule 4)

  /** The documents entry `cause` of this device produced give its answer about `subject` its standing once they leave. */
  protected leaves (cause: string, subject: string, docs: any[]): void {
    this.standing.set(cause, { subject, docs })
  }

  /** The documents an entry of this device produced for the door. */
  protected producedBy (cause: string): any[] { return this.standing.get(cause)?.docs ?? [] }

  /** Whether the answer of entry `cause` about `subject` may leave now, by what this device knows. */
  protected abstract mayLeave (subject: string, cause: string): boolean

  /** What of `docs` may go to the carrier now. An answer that leaves is
   *  recorded as handed. Before the first handover the rule is asked, from
   *  the entries: the handover gives an answer its standing, so it must not
   *  be what decides whether it may be handed over. */
  toCarrier (docs: any[]): any[] {
    const out: any[] = []
    next: for (const o of docs) {
      if (this.withheld.some((w) => w.digest === o.digest)) continue
      for (const [cause, s] of this.standing) {
        if (!s.docs.some((m) => m.digest === o.digest)) continue
        if (this.handed(s.subject).includes(cause)) continue
        if (this.voided(cause) || !this.mayLeave(s.subject, cause)) { this.withheld.push(o); continue next }
        this.write({ kind: 'handed', subject: s.subject, cause }, true)
      }
      out.push(o)
    }
    return out
  }
}
