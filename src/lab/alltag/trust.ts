// The fourth vertical cut of device sync above the published library:
// trust between two contacts, given on one device or on both.
//
// Giving and withdrawing trust are acts of the person, not answers to a
// request of one counterpart: there is no prompt and nothing to decline.
// The act travels like the acts of an encounter, with a seed and the acting
// device's time (encounter.ts), and every device applies it by the core's
// routine (core.ts).
import { randomBytes } from 'node:crypto'
import { clk, short, tick } from './fixture'
import { Sync, type Progress, type Step } from './core'
import { follows, type Seeded } from './encounter'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Answers a counterpart takes from a second device as well (two-producers.expected.json). */
const TOLERATED = new Set(['delivery-ack/0.1'])
/** Documents that concern only the device they reach. */
const PRIVATE = new Set(['delivery-ack/0.1'])

export type Body =
  | { kind: 'received', envelope: any, type: string, when: number }
  | { kind: 'act', act: 'trust' | 'untrust', contactId: string, seed: string, when: number }

export class Device extends Sync<Body, Seeded> {
  /** passed-on documents this device's library did not accept, with its verdict */
  readonly notTaken: string[] = []
  /** what the library returned for each act entry on this device */
  readonly results = new Map<string, any>()

  /** A document arrives from the carrier. Returns what the library answers. */
  receive (envelope: any, t = tick()): Promise<any[]> {
    return this.exclusive(async () => {
      const when = clk(this.P, t)
      const got = await this.P.h.receive(envelope, when)
      const mine: any[] = got.disposition === 'unique' || got.disposition === 'duplicate-known' ? [...got.outbound] : []
      // recorded as open: what follows the document is issued by the routine every device runs for the entry,
      // so a break there leaves the entry open here as well
      if (got.disposition === 'unique' && !PRIVATE.has(short(got.type))) this.write({ kind: 'received', envelope, type: short(got.type), when }, false)
      const more = await this.applyOpen(t)
      return [...mine, ...more.outbound]
    })
  }

  /** The human gives or withdraws trust on this device. */
  act (act: 'trust' | 'untrust', contactId: string, t = tick()): Promise<Progress & { result: any }> {
    return this.exclusive(async () => {
      const e = this.write({ kind: 'act', act, contactId, seed: randomBytes(32).toString('hex'), when: clk(this.P, t) }, false)
      const p = await this.applyOpen(t)
      return { ...p, result: this.results.get(e.id) }
    })
  }

  /** Every entry of this cut carries its time: what the library owes after it is drawn from the entry. */
  protected issues (id: string, body: Body): Promise<any[]> { return follows(this.P, id, body.when) }

  /** Trust is no answer to a request: nothing waits for a rule at the door. */
  protected mayLeave (): boolean { return true }
  protected carriesAnswer (): boolean { return false }

  protected async apply (e: { id: string, body: Body }, own: boolean): Promise<Step> {
    const outbound: any[] = []
    if (e.body.kind === 'received') {
      const got = await this.P.h.receive(e.body.envelope, e.body.when)
      if (got.disposition === 'unique') {
        for (const o of got.outbound) (TOLERATED.has(short(o.type)) ? outbound : this.withheld).push(o)
      } else if (got.disposition !== 'duplicate-known') {
        this.notTaken.push(`${e.body.type}: ${got.reason ?? got.disposition}`)
      }
      return { outbound }
    }
    const b = e.body
    const o = { when: b.when, actId: e.id }
    const r = await this.P.under(b.seed, async () => (b.act === 'trust' ? this.P.h.trust(b.contactId, o) : this.P.h.untrust(b.contactId, o)))
    this.results.set(e.id, r)
    if (!r.ok) this.refuse(e, r.code)
    else (own ? outbound : this.withheld).push(...r.outbound)
    return { outbound }
  }
}
