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

/** Answers a counterpart takes from a second device as well (two-producers.expected.json). */
const TOLERATED = new Set(['delivery-ack/0.1'])
/** Documents that concern only the device they reach. */
const PRIVATE = new Set(['delivery-ack/0.1'])

export type Act =
  | { act: 'show', name?: string }
  | { act: 'scan', card: any, name?: string }
  | { act: 'confirm', contactId: string, choice: 'accept' | 'decline' }
export type Body =
  | { kind: 'received', envelope: any, type: string }
  | ({ kind: 'act', seed: string, when: number } & Act)
  | { kind: 'handed', contactId: string, cause: string }     // the accept of entry `cause` left its device for the carrier
export type Entry = { id: string, deps: string[], body: Body }
export type Progress = { outbound: any[], stoppedAt: string | null }
type Confirm = Extract<Body, { act: 'confirm' }>

/** Stand-in for a library entry point that does not exist: this device
 *  declined the request and takes the decision back. Declining only closed
 *  the prompt; the stand-in puts the prompt back as it was. */
async function reopen (P: Person, prompt: any): Promise<void> {
  const snap = (await P.store.read()) as any
  const r = await P.store.commit(snap.version, { ...snap.state, prompts: { ...snap.state.prompts, [prompt.id]: prompt } })
  if (!(r as any).ok) throw new Error('reopen: the store moved')
}

export class Device {
  readonly entries = new Map<string, Entry>()
  private readonly applied = new Set<string>()
  private heads: string[] = []
  private n = 0
  /** documents this device's library produced that must not reach the
   *  carrier: its copy of a sister's act or answer, and an accept the rule
   *  does not let stand */
  readonly withheld: any[] = []
  /** passed-on documents this device's library did not accept, with its verdict */
  readonly notTaken: string[] = []
  /** what the library returned for each act entry on this device */
  readonly results = new Map<string, any>()
  /** the confirm prompt of each request as the library opened it, kept for `reopen` */
  private readonly prompts = new Map<string, any>()
  /** where this device stands with a rule it cannot follow (pinned as measured) */
  readonly stuck: string[] = []

  constructor (readonly name: string, readonly P: Seeded) {}

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

  /** A document arrives from the carrier. Returns what the library answers. */
  async receive (envelope: any, t = tick()): Promise<any[]> {
    const got = await this.P.h.receive(envelope, clk(this.P, t))
    if (got.disposition === 'unique' && !PRIVATE.has(short(got.type))) this.write({ kind: 'received', envelope, type: short(got.type) }, true)
    const more = await this.applyOpen(t)
    return [...(got.disposition === 'unique' || got.disposition === 'duplicate-known' ? got.outbound : []), ...more.outbound]
  }

  /** The human acts on this device. The act is recorded with a fresh seed
   *  before anything is done, then applied like any entry. Returns the
   *  library's result of the act beside the progress. */
  async act (a: Act, t = tick()): Promise<Progress & { result: any }> {
    const e = this.write({ kind: 'act', seed: randomBytes(32).toString('hex'), when: clk(this.P, t), ...a }, false)
    const p = await this.applyOpen(t)
    return { ...p, result: this.results.get(e.id) }
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

  /** What of `docs` may go to the carrier now. An accept that leaves is recorded as handed. */
  toCarrier (docs: any[]): any[] {
    const out: any[] = []
    for (const o of docs) {
      if (this.withheld.some((w) => w.digest === o.digest)) continue
      for (const [cause, r] of this.results) {
        const b = this.entries.get(cause)!.body as any
        if (b.act !== 'confirm' || b.choice !== 'accept' || !cause.startsWith(this.name + '#') || !(r.outbound ?? []).some((m: any) => m.digest === o.digest)) continue
        const known = [...this.entries.values()].some((e) => e.body.kind === 'handed' && e.body.cause === cause)
        if (!known) this.write({ kind: 'handed', contactId: b.contactId, cause }, true)
      }
      out.push(o)
    }
    return out
  }

  private confirms (contactId: string): Array<{ id: string, body: Confirm }> {
    return [...this.entries.values()].filter((e) => e.body.kind === 'act' && e.body.act === 'confirm' && e.body.contactId === contactId)
      .sort((x, y) => (x.id < y.id ? -1 : 1)) as any
  }

  /** What holds for a request by the entries this device knows: the entry whose answer stands. */
  verdict (contactId: string): { id: string, body: Confirm } | null {
    const all = this.confirms(contactId)
    const handed = [...this.entries.values()].flatMap((e) => (e.body.kind === 'handed' && e.body.contactId === contactId ? [e.body.cause] : [])).sort()
    return all.find((c) => c.id === handed[0]) ?? all.find((c) => c.body.choice === 'decline') ?? all[0] ?? null
  }

  private async prompt (contactId: string): Promise<any | undefined> {
    const p = (await this.P.h.prompts()).find((x: any) => x.kind === 'encounter-confirm' && x.contactId === contactId)
    if (p) this.prompts.set(contactId, (await this.P.read()).prompts[p.id])
    return p
  }

  /** Runs the library's act of an entry under the entry's seed. The act id
   *  is the entry's id, so a repeated application replays the library's
   *  journal instead of acting twice. */
  private async run (id: string, b: Extract<Body, { kind: 'act' }>, t: number): Promise<any> {
    const o = { when: Math.max(b.when, clk(this.P, t)), actId: id }
    const r = await this.P.under(b.seed, async () => {
      if (b.act === 'show') return this.P.h.show({ ...o, ...(b.name ? { name: b.name } : {}) })
      if (b.act === 'scan') return this.P.h.scan(b.card, { ...o, ...(b.name ? { name: b.name } : {}) })
      const prompt = await this.prompt(b.contactId)
      return prompt ? this.P.h.decide(prompt.id, b.choice, o) : { ok: false, code: 'no-prompt' }
    })
    this.results.set(id, r)
    return r
  }

  /** Brings this device's library in line with what holds for a request. */
  private async settle (contactId: string, t: number): Promise<void> {
    const v = this.verdict(contactId)
    const contact = await this.P.h.contact(contactId)
    if (!v || !contact) return
    const open = await this.prompt(contactId)
    const accepted = contact.verification === 'mutual'
    if (v.body.choice === 'accept') {
      if (accepted) return
      // declined here, and the sister's accept left: take the decline back and accept
      if (!open) { const kept = this.prompts.get(contactId); if (!kept) return; await reopen(this.P, kept) }
      const r = await this.run(v.id, v.body, t)
      if (r.ok && !v.id.startsWith(this.name + '#')) this.withheld.push(...r.outbound)
    } else {
      if (open) await this.run(v.id, v.body, t)
      // every accept of this device stays in the house
      for (const c of this.confirms(contactId)) if (c.body.choice === 'accept') this.withheld.push(...(this.results.get(c.id)?.outbound ?? []))
      const note = `${contactId}: accepted here, the decline holds; the library cannot take the accept back`
      if (accepted && !this.stuck.includes(note)) this.stuck.push(note)
    }
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
              for (const o of got.outbound) (TOLERATED.has(short(o.type)) ? outbound : this.withheld).push(o)
            } else if (got.disposition !== 'duplicate-known') {
              this.notTaken.push(`${e.body.type}: ${got.reason ?? got.disposition}`)
            }
          } else if (e.body.kind === 'handed') {
            await this.settle(e.body.contactId, t)
          } else if (e.body.act === 'confirm') {
            // the request has not reached this device yet: the entry waits
            if (!(await this.P.h.contact(e.body.contactId))) return { outbound, stoppedAt: `${e.id}: the request is not here yet` }
            // the acting device answers its own prompt; what then holds is settled for every device alike
            if (own && (await this.prompt(e.body.contactId))) {
              const r = await this.run(e.id, e.body, t)
              if (!r.ok) return { outbound, stoppedAt: `${e.id}: ${r.code}` }
              outbound.push(...r.outbound)
            }
            await this.settle(e.body.contactId, t)
          } else {
            const r = await this.run(e.id, e.body, t)
            if (!r.ok) return { outbound, stoppedAt: `${e.id}: ${r.code}` }
            ;(own ? outbound : this.withheld).push(...r.outbound)
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

export const cardOf = (result: any): any => ev(result, 'encounter.shown')[0].card
