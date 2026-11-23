// The third vertical cut of device sync above the published library: an
// encounter, the ceremony by which two persons become contacts.
//
// What is new against messages and invitations: the human's act itself
// creates secrets. Showing a card or scanning one draws a fresh pair label,
// from which the library derives the relationship's keys, its address and
// the contact's id, and a fresh challenge. A sister device that only gets
// the documents passed on cannot open them: they are sealed to an address
// it never derived (measured: `malformed`). And a sister that scans the
// same card itself draws another label: another contact id on each device,
// and a second bundle the counterpart refuses (`consumed-challenge`).
//
// So the act travels with what it drew. An `act` entry carries a seed; the
// library's entropy for that act is a stream derived from the seed, on
// every device. The entry is written before anything is done (the seed is
// drawn first), and every device, the acting one included, applies it by
// the same routine: it runs the library's own act under the entry's seed.
// The devices then hold the same label, keys, address, challenge and
// contact id, and the documents passed on as `received` entries open.
//
// The library needs no stand-in for this: its entropy is a port
// (`createHolder({ entropy })`). What the layer adds is the stream and the
// switch that puts one act under one seed.
//
// Answering a request (the confirm prompt after the counterpart scanned)
// follows the rule between two answers of one person (Anton, 2026-11-23):
// an accept that left a device stands; else a decline on any device wins
// and an accept still in the house is never handed over; else the accept.
// Declining only closes the prompt in the library, so a device that
// declined and then learns that the sister's accept left has to accept
// after all. The library has no entry point for that: `reopen` below is the
// stand-in, it puts the closed prompt back into the store.
import { createHash, randomBytes } from 'node:crypto'
import { createHolder, randomEntropy, seedKeys } from 'rltp-lib'
import { InMemoryStore } from 'rltp-lib/testing'
import { clk, ev, short, tick, LATE, type Person } from './fixture'
import { rule, Sync, type Progress, type Step } from './core'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The library's entropy for one act: every value is derived from the
 *  act's seed, the purpose and a running number per purpose. */
function streamOf (seed: string): any {
  const n = new Map<string, number>()
  const draw = (purpose: string, len: number): Uint8Array => {
    const i = n.get(purpose) ?? 0; n.set(purpose, i + 1)
    const out = new Uint8Array(len)
    for (let off = 0, block = 0; off < len; block++) {
      const h = createHash('sha256').update(`${seed}|${purpose}|${i}|${block}`).digest()
      out.set(h.subarray(0, Math.min(h.length, len - off)), off); off += h.length
    }
    return out
  }
  return {
    bytes: draw,
    id: (purpose: string): string => {
      const b = draw(purpose, 16); b[6] = (b[6]! & 0x0f) | 0x40; b[8] = (b[8]! & 0x3f) | 0x80
      const x = Buffer.from(b).toString('hex')
      return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`
    },
  }
}

/** A holder whose entropy can be put under a seed for the length of one act. */
export type Seeded = Person & { under: <T>(seed: string, run: () => Promise<T>) => Promise<T> }
async function holderOver (fill: number, store: InMemoryStore, late?: number): Promise<Seeded> {
  const seed = new Uint8Array(64).fill(fill)
  const platform = randomEntropy()
  let current: any = platform
  const entropy = { bytes: (p: any, len: number) => current.bytes(p, len), id: (p: any) => current.id(p) }
  const h = await createHolder({ store, keys: seedKeys(seed), entropy } as any, { modules: [], invariants: true } as any)
  const under = async <T>(s: string, run: () => Promise<T>): Promise<T> => { current = streamOf(s); try { return await run() } finally { current = platform } }
  return { h, store, seed, fill, late, read: async () => ((await store.read()) as any).state, under }
}
/** A person's first device, with its personal community founded as the application does. */
export async function first (fill: number): Promise<Seeded> {
  const P = await holderOver(fill, new InMemoryStore())
  const r = await P.h.foundPersonalCommunity({ name: 'P' + fill }, { when: clk(P, tick()), actId: 'found-' + fill })
  if (!r.ok) throw new Error('founding refused')
  return P
}
/** The second device: the same seed, a copy of the store, a late clock. */
export async function second (P: Person): Promise<Seeded> {
  const store = new InMemoryStore()
  await store.commit(null, ((await P.store.read()) as any).state)
  return holderOver(P.fill, store, LATE)
}

/** What the library issues by itself once an entry is applied (its duties:
 *  the continuity probe and the stars after an encounter, the anchor mapping
 *  after trust was given) is drawn under the entry's id and at the entry's
 *  time, on every device, right after the entry. Two devices that apply the
 *  same entry on the same state then issue the same document, byte for
 *  byte, and the counterpart sees one. */
export async function follows (P: Seeded, id: string, when: number): Promise<any[]> {
  return (await P.under(`follows|${id}`, async () => P.h.resume(when))).outbound
}

/** Answers a counterpart takes from a second device as well (two-producers.expected.json). */
const TOLERATED = new Set(['delivery-ack/0.1'])
/** Documents that concern only the device they reach. */
const PRIVATE = new Set(['delivery-ack/0.1'])

export type Act =
  | { act: 'show', name?: string }
  | { act: 'scan', card: any, name?: string }
  | { act: 'confirm', contactId: string, choice: 'accept' | 'decline' }
export type Body =
  | { kind: 'received', envelope: any, type: string, when: number }   // a document a device accepted, with the device's time then
  | ({ kind: 'act', seed: string, when: number } & Act)
export type { Progress } from './core'
type Confirm = Extract<Body, { act: 'confirm' }>

/** Stand-in for a library entry point that does not exist: this device
 *  declined the request and takes the decision back. Declining only closed
 *  the prompt; the stand-in puts the prompt back as it was. */
async function reopen (P: Person, prompt: any): Promise<void> {
  const snap = (await P.store.read()) as any
  const r = await P.store.commit(snap.version, { ...snap.state, prompts: { ...snap.state.prompts, [prompt.id]: prompt } })
  if (!(r as any).ok) throw new Error('reopen: the store moved')
}

export class Device extends Sync<Body, Seeded> {
  /** passed-on documents this device's library did not accept, with its verdict */
  readonly notTaken: string[] = []
  /** what the library returned for each act entry on this device */
  readonly results = new Map<string, any>()
  /** the confirm prompt of each request as the library opened it, kept for `reopen` */
  private readonly prompts = new Map<string, any>()
  /** where this device stands with a rule it cannot follow (pinned as measured) */
  readonly stuck: string[] = []

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

  /** The human acts on this device. The act is recorded with a fresh seed
   *  before anything is done, then applied like any entry. Returns the
   *  library's result of the act beside the progress. */
  act (a: Act, t = tick()): Promise<Progress & { result: any }> {
    return this.exclusive(async () => {
      // kind, seed and time are the layer's: they come after what the caller gave
      const e = this.write({ ...a, kind: 'act', seed: randomBytes(32).toString('hex'), when: clk(this.P, t) }, false)
      const p = await this.applyOpen(t)
      return { ...p, result: this.results.get(e.id) }
    })
  }

  /** The answers to a request that took effect, by the entries this device knows. */
  private confirms (contactId: string): Array<{ id: string, body: Confirm }> {
    return this.effective(this.of('act').filter((e) => e.body.act === 'confirm' && e.body.contactId === contactId)) as any
  }

  /** What holds for a request by the entries this device knows: the entry whose answer stands. */
  verdict (contactId: string): { id: string, body: Confirm } | null {
    const all = this.confirms(contactId)
    const accepts = all.filter((c) => c.body.choice === 'accept').map((c) => c.id)
    const v = rule({ handed: this.handed(contactId).filter((c) => accepts.includes(c)), declined: all.some((c) => c.body.choice === 'decline'), first: accepts[0] })
    if (v === 'open') return null
    return (v === 'declined' ? all.find((c) => c.body.choice === 'decline') : all.find((c) => c.id === v.accepts[0])) ?? null
  }

  /** The credential delivery is the document that proves the person's answer to a request. */
  protected carriesAnswer (doc: any): boolean { return short(doc.type).startsWith('encounter-credential-delivery/') }

  protected subjectOf (body: Body): string | undefined {
    return body.kind === 'act' && body.act === 'confirm' ? body.contactId : undefined
  }

  /** A decline of the request is running on some device: chosen, neither applied nor refused yet. */
  declining (contactId: string): boolean {
    return this.running(this.of('act').filter((e) => e.body.act === 'confirm' && e.body.contactId === contactId)).some((e) => (e.body as Confirm).choice === 'decline')
  }

  /** At the door. An accept that already left stays free to leave again: every accept that left is a
   *  candidate until the counterpart's answer names one, and if the one this device counts first never
   *  arrives, the other must still be able to. An accept that has not left yet may leave while it is the
   *  answer that stands and no decline is running. */
  protected mayLeave (contactId: string, cause: string): boolean {
    if (this.handed(contactId).includes(cause)) return true
    return this.verdict(contactId)?.id === cause && !this.declining(contactId)
  }

  private async prompt (contactId: string): Promise<any | undefined> {
    const p = (await this.P.h.prompts()).find((x: any) => x.kind === 'encounter-confirm' && x.contactId === contactId)
    if (p) this.prompts.set(contactId, (await this.P.read()).prompts[p.id])
    return p
  }

  /** Runs the library's act of an entry under the entry's seed and at the
   *  entry's time. The act id is the entry's id, so a repeated application
   *  replays the library's journal instead of acting twice.
   *
   *  The time is the acting device's, not the time of the replay: a device
   *  that catches up a day later must hold the ceremony at the moment it
   *  took place, or the counterpart's answer from that moment no longer
   *  fits. The library never lets a holder's time fall: where this device
   *  has already been active later, it raises the act to that time. */
  private async run (id: string, b: Extract<Body, { kind: 'act' }>): Promise<any> {
    const o = { when: b.when, actId: id }
    const r = await this.P.under(b.seed, async () => {
      if (b.act === 'show') return this.P.h.show({ ...o, ...(b.name ? { name: b.name } : {}) })
      if (b.act === 'scan') return this.P.h.scan(b.card, { ...o, ...(b.name ? { name: b.name } : {}) })
      // the prompt as it is, or as this device last saw it: a repeat after a break completes the same act under
      // its act id, and an answer to a request that is closed here is the library's to refuse
      const prompt = (await this.prompt(b.contactId)) ?? this.prompts.get(b.contactId)
      return prompt ? this.P.h.decide(prompt.id, b.choice, o) : { ok: false, code: 'no-prompt' }
    })
    this.results.set(id, r)
    return r
  }

  /** Brings this device's library in line with what holds for a request. */
  protected async settle (contactId: string): Promise<string | void> {
    const v = this.verdict(contactId)
    const contact = await this.P.h.contact(contactId)
    if (!contact) return 'the request is not here yet'
    if (!v) return
    const open = await this.prompt(contactId)
    const accepted = contact.verification === 'mutual'
    if (v.body.choice === 'accept') {
      if (accepted) return
      // declined here, and the sister's accept left: take the decline back and accept
      if (!open) { const kept = this.prompts.get(contactId); if (!kept) return; await reopen(this.P, kept) }
      const r = await this.run(v.id, v.body)
      // this device's copy of a sister's accept stays in the house; its own accept goes through the door (toCarrier)
      if (r.ok && !this.own(v.id)) this.withheld.push(...r.outbound)
    } else {
      if (open) await this.run(v.id, v.body)
      // (an accept of this device stays in the house: the door asks the rule)
      const note = `${contactId}: accepted here, the decline holds; the library cannot take the accept back`
      if (accepted && !this.stuck.includes(note)) this.stuck.push(note)
    }
  }

  protected async apply (e: { id: string, body: Body }, own: boolean): Promise<Step> {
    const outbound: any[] = []
    if (e.body.kind === 'received') {
      // at the time the receiving device took it, like an act (the library raises it where this device was active later)
      const got = await this.P.h.receive(e.body.envelope, e.body.when)
      if (got.disposition === 'unique') {
        for (const o of got.outbound) (TOLERATED.has(short(o.type)) ? outbound : this.withheld).push(o)
        // the library takes a credential it cannot place (the ceremony stands at another time here) without a word: say so
        if (e.body.type.startsWith('encounter-credential-delivery/') && !ev(got, 'encounter.accepted').length) this.notTaken.push(`${e.body.type}: taken without effect`)
      } else if (got.disposition !== 'duplicate-known') {
        this.notTaken.push(`${e.body.type}: ${got.reason ?? got.disposition}`)
      }
      // what follows: this device's own goes out, its copy of a sister's stays (it is the same document)
      ;(own ? outbound : this.withheld).push(...await follows(this.P, e.id, e.body.when))
      return { outbound }
    }
    if (e.body.act === 'confirm') {
      // a sister's answer: nothing happens here until its device says what became of it (`took`, `void`)
      if (!own) return
      if (!(await this.P.h.contact(e.body.contactId))) return { wait: 'the request is not here yet' }
      const r = await this.run(e.id, e.body)
      if (!r.ok) { this.refuse(e, r.code); return }
      if (e.body.choice === 'accept') this.leaves(e.id, e.body.contactId, r.outbound)
      return { outbound: r.outbound }
    }
    const r = await this.run(e.id, e.body)
    if (!r.ok) this.refuse(e, r.code)
    else (own ? outbound : this.withheld).push(...r.outbound, ...await follows(this.P, e.id, e.body.when))
    return { outbound }
  }
}

export const cardOf = (result: any): any => ev(result, 'encounter.shown')[0].card
