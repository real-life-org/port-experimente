// The second vertical cut of device sync above the published library: a
// group invitation, answered on one device or on both.
//
// Entries: `received` (a document a device accepted, passed on as input),
// `decided` (the human's answer to one invitation, recorded with the
// invitation's credential digest before anything is done about it), and
// `issued` (the proof that a device produced the document a decision calls
// for: here the accept and its digest).
//
// The library has no way to take a sister device's decision over: its
// welcome is bound to the digest of the accept this holder issued. `adopt`
// below is a stand-in for that missing entry point. It writes the one fact
// into the store that the library checks (the invitation's status and the
// accept's digest) and closes the prompt. That it is a write into the
// store, and how little it writes, is the measurement.
import { clk, ok, short, tick, type Person } from './fixture'

/** Documents that concern only the device they reach. */
const PRIVATE = new Set(['delivery-ack/0.1'])
/** Answers a counterpart takes from a second device as well (two-producers.expected.json). */
const TOLERATED = new Set(['delivery-ack/0.1', 'x-access-sync/0.1'])

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Body =
  | { kind: 'received', envelope: any, type: string }
  | { kind: 'decided', credDigest: string, groupId: string, choice: 'accept' | 'decline' }
  | { kind: 'issued', cause: string, credDigest: string, acceptDigest: string }
export type Entry = { id: string, deps: string[], body: Body }
export type Progress = { outbound: any[], stoppedAt: string | null }

/** Stand-in for a library entry point that does not exist: this device
 *  takes over that the person accepted (with the accept a sister device
 *  issued) or declined the invitation `credDigest`. */
async function adopt (P: Person, credDigest: string, to: { status: 'accepted', acceptDigest: string } | { status: 'declined' }): Promise<boolean> {
  const snap = (await P.store.read()) as any
  const inv = snap.state.joining.invites[credDigest]
  if (!inv) return false
  const invites = { ...snap.state.joining.invites, [credDigest]: { ...inv, ...to } }
  if (to.status === 'declined') delete invites[credDigest].acceptDigest
  const prompts = { ...snap.state.prompts }
  delete prompts[inv.promptId]
  const r = await P.store.commit(snap.version, { ...snap.state, joining: { ...snap.state.joining, invites }, prompts })
  if (!(r as any).ok) throw new Error('adopt: the store moved')
  return true
}

export class Device {
  readonly entries = new Map<string, Entry>()
  private readonly applied = new Set<string>()
  private heads: string[] = []
  private n = 0
  /** documents this device's library produced that must not reach the
   *  carrier: answers to a sister's input of a kind a counterpart refuses
   *  from a second producer, and an accept the log does not let stand */
  readonly withheld: any[] = []
  /** passed-on documents this device's library did not accept, with its verdict */
  readonly notTaken: string[] = []
  private readonly produced = new Map<string, any[]>()

  constructor (readonly name: string, readonly P: Person) {}

  private know (e: Entry): void {
    this.entries.set(e.id, e)
    this.heads = [...this.heads.filter((h) => !e.deps.includes(h)), e.id]
  }

  private write (body: Body, done: boolean): Entry {
    const e: Entry = { id: `${this.name}#${++this.n}`, deps: [...this.heads], body }
    this.know(e)
    if (done) this.applied.add(e.id)
    return e
  }

  private async invite (groupId: string): Promise<any | undefined> {
    return Object.values((await this.P.read()).joining.invites).find((i: any) => i.group === groupId)
  }

  /** A document arrives from the carrier. Returns what the library answers. */
  async receive (envelope: any, t = tick()): Promise<any[]> {
    const got = await this.P.h.receive(envelope, clk(this.P, t))
    // an acknowledgement settles a document only its issuer holds: it is not passed on
    if (got.disposition === 'unique' && !PRIVATE.has(short(got.type))) this.write({ kind: 'received', envelope, type: short(got.type) }, true)
    const more = await this.applyOpen(t)
    return [...(got.disposition === 'unique' || got.disposition === 'duplicate-known' ? got.outbound : []), ...more.outbound]
  }

  /** The human answers the invitation to `groupId` on this device. */
  async decide (groupId: string, choice: 'accept' | 'decline', t = tick()): Promise<Progress> {
    const inv = await this.invite(groupId)
    if (!inv) throw new Error(`${this.name}: no invitation to ${groupId}`)
    this.write({ kind: 'decided', credDigest: inv.credDigest, groupId, choice }, false)
    return this.applyOpen(t)
  }

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

  /** The accept the log proves issued for an invitation, by the rule: an
   *  issued accept stands, whatever else was decided; of two, the one whose
   *  entry id sorts first. */
  private issuedFor (credDigest: string): { cause: string, acceptDigest: string } | undefined {
    return [...this.entries.values()].filter((e) => e.body.kind === 'issued' && e.body.credDigest === credDigest)
      .sort((x, y) => (x.id < y.id ? -1 : 1)).map((e) => e.body as any)[0]
  }

  private async applyOpen (t: number): Promise<Progress> {
    const outbound: any[] = []
    let moved = true
    while (moved) {
      moved = false
      for (const e of [...this.entries.values()]) {
        if (this.applied.has(e.id) || !e.deps.every((d) => this.applied.has(d))) continue
        const own = e.id.startsWith(this.name + '#')
        try {
          if (e.body.kind === 'received') {
            const got = await this.P.h.receive(e.body.envelope, clk(this.P, t))
            if (got.disposition === 'unique') {
              // a sister took this document from the carrier and answered it. This
              // device's own answer goes out only where a counterpart takes a
              // second one (the two-producer table); the rest stays here
              for (const o of got.outbound) (TOLERATED.has(short(o.type)) ? outbound : this.withheld).push(o)
            } else if (got.disposition !== 'duplicate-known') {
              // the library's verdict on a passed-on document is final for this
              // device (it answers something only the sister issued); the log moves on
              this.notTaken.push(`${e.body.type}: ${got.reason ?? got.disposition}`)
            }
          } else if (e.body.kind === 'decided') {
            const state = (await this.P.read()).joining.invites[e.body.credDigest]
            if (!state) return { outbound, stoppedAt: e.id }          // the invitation has not reached this device yet
            if (own && state.status === 'open') {
              const prompt = (await this.P.h.prompts()).find((p: any) => p.id === state.promptId)
              const r = ok(await this.P.h.decide(prompt.id, e.body.choice, { when: clk(this.P, t), actId: `${e.id}-decide` }))
              outbound.push(...r.outbound)
              this.produced.set(e.id, r.outbound)
              if (e.body.choice === 'accept') {
                const acceptDigest = (await this.P.read()).joining.invites[e.body.credDigest].acceptDigest
                this.write({ kind: 'issued', cause: e.id, credDigest: e.body.credDigest, acceptDigest }, true)
              }
            } else if (!own && e.body.choice === 'decline' && state.status === 'open') {
              await adopt(this.P, e.body.credDigest, { status: 'declined' })
            }
            // a sister's accept is taken over by its `issued` entry, not here
          } else {
            const winner = this.issuedFor(e.body.credDigest)!
            const state = (await this.P.read()).joining.invites[e.body.credDigest]
            if (!state) return { outbound, stoppedAt: e.id }
            if (state.status !== 'joined' && state.acceptDigest !== winner.acceptDigest) await adopt(this.P, e.body.credDigest, { status: 'accepted', acceptDigest: winner.acceptDigest })
            // an accept of this device that does not stand is not handed to the carrier (any more)
            for (const x of this.entries.values()) {
              if (x.body.kind === 'issued' && x.body.credDigest === e.body.credDigest && x.body.acceptDigest !== winner.acceptDigest) this.withheld.push(...(this.produced.get(x.body.cause) ?? []))
            }
          }
        } catch (err) {
          return { outbound, stoppedAt: `${e.id}: ${(err as Error).message}` }
        }
        this.applied.add(e.id)
        moved = true
      }
    }
    return { outbound, stoppedAt: null }
  }
}
