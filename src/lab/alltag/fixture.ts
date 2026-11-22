// Everyday multi-device experiments against the published library
// (`rltp-lib` = @real-life/trust-protocol 0.19.0, the real holder, not a
// model). The pinned 0.3.2 of the older benches stays untouched.
//
// A person's second device is a stand-in, because the library has no
// enrolment and no exchange between a person's devices: a holder over the
// same seed and a copy of the first device's store. Its clock runs late.
import { seedKeys, createHolder } from 'rltp-lib'
import { InMemoryStore } from 'rltp-lib/testing'

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Person = { h: any, store: InMemoryStore, seed: Uint8Array, fill: number, late?: number, read: () => Promise<any> }

export const T0 = Date.parse('2026-10-15T09:00:00Z')
export const LATE = 13_000
let clock = T0 + 5_000_000
export const tick = (n = 10_000): number => (clock += n)
let acts = 0
export const opts = (when: number, extra: Record<string, unknown> = {}): any => ({ when, actId: 'act-' + (++acts), ...extra })
export const ev = (r: any, type: string): any[] => (r.events ?? []).filter((e: any) => e.type === type)
/** A device's own clock at the shared moment `t`: the second device runs
 *  late. Every time a device is given goes through here, and a device's
 *  time never falls. */
const last = new WeakMap<object, number>()
export function clk (P: Person, t: number): number {
  const when = t + (P.late ?? 0)
  if (when < (last.get(P.store) ?? 0)) throw new Error('a device\'s time fell')
  last.set(P.store, when)
  return when
}
/** The options of an act the human takes on device P now. */
export const at = (P: Person, extra: Record<string, unknown> = {}): any => opts(clk(P, tick()), extra)
export const ok = (r: any): any => { if (r.ok !== true) throw new Error('refused: ' + JSON.stringify(r)); return r }
export const short = (type: string): string => type.slice(type.lastIndexOf('/spec/') + 6)

async function holderOver (fill: number, store: InMemoryStore, late?: number): Promise<Person> {
  const seed = new Uint8Array(64).fill(fill)
  const h = await createHolder({ store, keys: seedKeys(seed) } as any, { modules: [], invariants: true } as any)
  return { h, store, seed, fill, late, read: async () => ((await store.read()) as any).state }
}

/** A person who founded its personal community as the application does. */
export async function mk (fill: number): Promise<Person> {
  const P = await holderOver(fill, new InMemoryStore())
  ok(await P.h.foundPersonalCommunity({ name: 'P' + fill }, at(P)))
  return P
}

/** The second device: the same seed, a copy of the store, a late clock. */
export async function copyOf (P: Person): Promise<Person> {
  const store = new InMemoryStore()
  await store.commit(null, ((await P.store.read()) as any).state)
  return holderOver(P.fill, store, LATE)
}

/** Delivers among distinct holders until nothing moves (setup only). */
async function settlePlain (people: Person[], outbound: any[]): Promise<void> {
  let out = [...outbound]
  for (let r = 0; r < 12; r++) {
    const when = tick()
    for (const p of people) out.push(...(await p.h.resume(clk(p, when))).outbound)
    if (!out.length) break
    while (out.length) {
      const o = out.shift()
      for (const to of people) {
        if (!Object.hasOwn((await to.read()).addresses.keys, o.envelope.rkid)) continue
        const got = await to.h.receive(o.envelope, clk(to, when))
        if (got.disposition === 'unique' || got.disposition === 'duplicate-known') out.push(...got.outbound)
        break
      }
    }
  }
}

/** Two persons who met: the whole ceremony, settled. Returns each side's contact. */
export async function met (A: Person, B: Person): Promise<{ a: any, b: any }> {
  const shown = ok(await B.h.show(at(B, { name: 'Bea' })))
  const sc = ok(await A.h.scan(ev(shown, 'encounter.shown')[0].card, at(A, { name: 'Al' })))
  const bundle = sc.outbound.find((o: any) => short(o.type).startsWith('encounter-bundle/'))
  const got = await B.h.receive(bundle.envelope, clk(B, tick()))
  const prompt = (await B.h.prompts()).find((p: any) => p.kind === 'encounter-confirm')
  const d = ok(await B.h.decide(prompt.id, 'accept', at(B)))
  await settlePlain([A, B], [...got.outbound, ...d.outbound])
  return { a: await A.h.contact(ev(sc, 'contact.added')[0].contactId), b: await B.h.contact(ev(got, 'contact.added')[0].contactId) }
}
