// The second vertical cut of device sync above the published library: a
// group invitation, answered on one device or on both.
//
// Entries: `received` (a document a device accepted, passed on as input),
// `decided` (the human's answer to one invitation, recorded with the
// invitation's credential digest before anything is done about it),
// `issued` (a device produced the accept; it is still in the house) and
// `confirmed` (the counterpart's answer names the accept it took). The log,
// the applying of entries, `handed` (the accept left the device for the
// carrier), `void` and the door to the carrier are the core's (core.ts).
//
// The rule between two answers of one person (Anton, 2026-11-23): what the
// counterpart took first holds, proven by its answer; what has not left the
// own device may be taken back. In order:
//   1. a confirmed accept stands;
//   2. else an accept that left a device stands (it cannot be called back);
//      where two left, both stay candidates until the answer names one;
//   3. else a decline on any device wins, and an accept still in the house
//      is never handed over;
//   4. else, of the accepts issued, one may leave (the first by entry id).
//
// The library has no way to take a sister device's decision over: its
// welcome is bound to the digest of the accept this holder issued. `adopt`
// below is a stand-in for that missing entry point. It writes the one fact
// into the store that the library checks (the invitation's status and the
// accept's digest) and closes the prompt. That it is a write into the
// store, and how little it writes, is the measurement.
import { clk, short, tick, type Person } from './fixture'
import { rule, Sync, type Progress, type Step } from './core'

/** Documents that concern only the device they reach. */
const PRIVATE = new Set(['delivery-ack/0.1'])
/** Answers a counterpart takes from a second device as well (two-producers.expected.json). */
const TOLERATED = new Set(['delivery-ack/0.1', 'x-access-sync/0.1'])

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Body =
  | { kind: 'received', envelope: any, type: string }
  | { kind: 'decided', credDigest: string, groupId: string, choice: 'accept' | 'decline' }
  | { kind: 'issued', cause: string, credDigest: string, acceptDigest: string }
  | { kind: 'confirmed', credDigest: string, acceptDigest: string }
export type { Progress } from './core'

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

export class Device extends Sync<Body> {
  /** passed-on documents this device's library did not accept, with its verdict */
  readonly notTaken: string[] = []

  private async invite (groupId: string): Promise<any | undefined> {
    return Object.values((await this.P.read()).joining.invites).find((i: any) => i.group === groupId)
  }

  /** The counterpart's answer took an accept of this person: the library joined on it. */
  private async noteConfirmed (): Promise<void> {
    const state = await this.P.read()
    for (const inv of Object.values(state.joining.invites) as any[]) {
      const g = state.groups[inv.group]
      if (!g?.acceptDigest) continue
      const known = this.of('confirmed').some((e) => e.body.credDigest === inv.credDigest)
      if (!known) this.write({ kind: 'confirmed', credDigest: inv.credDigest, acceptDigest: g.acceptDigest }, true)
    }
  }

  /** A document arrives from the carrier. Returns what the library answers. */
  async receive (envelope: any, t = tick()): Promise<any[]> {
    const got = await this.takeTrying(envelope, t)
    await this.noteConfirmed()
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

  /** The accept a device issued for its answer `cause`, if this device knows of one. */
  private acceptOf (cause: string): string | undefined {
    return this.of('issued').find((e) => e.body.cause === cause)?.body.acceptDigest
  }

  /** What holds for an invitation by the entries this device knows: the
   *  accepts that stand (by digest), a decline, or nothing yet. Only answers
   *  that took effect count (the core's one evaluation). */
  verdict (credDigest: string): { accepts: string[] } | 'declined' | 'open' {
    const decided = this.effective(this.of('decided').filter((e) => e.body.credDigest === credDigest))
    const issued = this.effective(this.of('issued').filter((e) => e.body.credDigest === credDigest)).filter((e) => !this.voided(e.body.cause))
    const handed = [...new Set(this.handed(credDigest).flatMap((cause) => this.acceptOf(cause) ?? []))]
    return rule({
      confirmed: this.effective(this.of('confirmed').filter((e) => e.body.credDigest === credDigest))[0]?.body.acceptDigest,
      handed,
      declined: decided.some((d) => d.body.choice === 'decline'),
      first: issued[0]?.body.acceptDigest,
    })
  }

  protected subjectOf (body: Body): string | undefined {
    return body.kind === 'decided' ? body.credDigest : undefined
  }

  /** At the door: the accept of this device's answer `cause` may leave while it is one of the accepts that stand. */
  protected mayLeave (credDigest: string, cause: string): boolean {
    const v = this.verdict(credDigest), mine = this.acceptOf(cause)
    return typeof v !== 'string' && mine !== undefined && v.accepts.includes(mine)
  }

  /** Brings this device's library in line with what holds for the
   *  invitation. The library holds one accept digest per invitation; while
   *  several accepts are candidates, a device keeps its own if it is one of
   *  them, and `takeTrying` tries the others when an answer does not fit. */
  protected async settle (credDigest: string): Promise<void> {
    const v = this.verdict(credDigest)
    const state = (await this.P.read()).joining.invites[credDigest]
    if (!state || v === 'open') return
    const candidates = v === 'declined' ? [] : v.accepts
    if (state.status !== 'joined') {
      if (v === 'declined' && state.status !== 'declined') await adopt(this.P, credDigest, { status: 'declined' })
      if (v !== 'declined' && !candidates.includes(state.acceptDigest)) await adopt(this.P, credDigest, { status: 'accepted', acceptDigest: candidates[0] as string })
    }
    // an accept of this device that cannot stand never reaches the carrier (again)
    for (const x of this.of('issued')) {
      if (x.body.credDigest === credDigest && !candidates.includes(x.body.acceptDigest)) this.withheld.push(...this.producedBy(x.body.cause))
    }
  }

  /** Hands a document to the library. Where it is refused while an
   *  invitation still has several candidate accepts, the document may be the
   *  counterpart's answer to another candidate than the one this device
   *  holds: each is tried, and the one the library takes the answer under
   *  stays. Otherwise the device is left as it was. */
  private async takeTrying (envelope: any, t: number): Promise<any> {
    let got = await this.P.h.receive(envelope, clk(this.P, t))
    if (got.disposition === 'unique' || got.disposition === 'duplicate-known') return got
    for (const inv of Object.values((await this.P.read()).joining.invites) as any[]) {
      const v = this.verdict(inv.credDigest)
      if (inv.status !== 'accepted' || v === 'declined' || v === 'open' || v.accepts.length < 2) continue
      for (const candidate of v.accepts.filter((d) => d !== inv.acceptDigest)) {
        await adopt(this.P, inv.credDigest, { status: 'accepted', acceptDigest: candidate })
        got = await this.P.h.receive(envelope, clk(this.P, t))
        if (got.disposition === 'unique' || got.disposition === 'duplicate-known') return got
      }
      await adopt(this.P, inv.credDigest, { status: 'accepted', acceptDigest: inv.acceptDigest })
    }
    return got
  }

  protected async apply (e: { id: string, body: Body }, own: boolean, t: number): Promise<Step> {
    const outbound: any[] = []
    if (e.body.kind === 'received') {
      const got = await this.takeTrying(e.body.envelope, t)
      await this.noteConfirmed()
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
      return { outbound }
    }
    if (e.body.kind === 'decided') {
      const state = (await this.P.read()).joining.invites[e.body.credDigest]
      if (!state) return { wait: 'the invitation has not reached this device yet' }
      if (own && state.status === 'open') {
        const prompt = (await this.P.h.prompts()).find((p: any) => p.id === state.promptId)
        const r = await this.P.h.decide(prompt.id, e.body.choice, { when: clk(this.P, t), actId: `${e.id}-decide` })
        // the library's refusal is its verdict on the answer: closed, noted in the log, and it counts nowhere
        if (!r.ok) { this.refuse(e, r.code); await this.settle(e.body.credDigest); return }
        if (e.body.choice === 'accept') {
          const acceptDigest = (await this.P.read()).joining.invites[e.body.credDigest].acceptDigest
          this.leaves(e.id, e.body.credDigest, r.outbound)
          this.write({ kind: 'issued', cause: e.id, credDigest: e.body.credDigest, acceptDigest }, true)
        }
        outbound.push(...r.outbound)
      }
    }
    await this.settle(e.body.credDigest)
    return { outbound }
  }
}
