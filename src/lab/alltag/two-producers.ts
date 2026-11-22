// What a counterpart does when two devices of one person each produce a
// document for the same cause, per document type. The phone (T) and the
// laptop (L, see fixture.ts) come to a point where both will produce;
// everything settles; for every document type that reached the counterpart
// B the table says what B answered to the phone's and to the laptop's.
// The phone's documents are handed over first.
//
// The carrier stand-in hands an envelope to every device holding its
// address. Whether a real mediator does is a separate measurement.
// Introductions (Trust §8) are out of scope.
import { copyOf, ev, met, mk, ok, opts, short, tick, type Person } from './fixture'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Sent = { o: any, from: Person }
type Table = Record<string, { phone: Set<string>, laptop: Set<string> }>
export type Row = Record<string, string>

const verdict = (got: any): string => got.disposition + (got.reason ? ' ' + got.reason : '') + (got.ref ? ' ' + got.ref : '')

/** Delivers `first` (each `{o, from}`) and all it causes to every device
 *  holding the address, and records what `B` answered to the documents of
 *  `T` and of `L`, by type. */
async function settle ({ T, L, B, others = [] }: { T: Person, L: Person, B: Person, others?: Person[] }, first: Sent[], table: Table = {}, { rounds = 14 } = {}): Promise<Table> {
  const people = [T, L, B, ...others]
  let out: Sent[] = [...first]
  for (let r = 0; r < rounds; r++) {
    const when = tick()
    for (const p of people) for (const o of (await p.h.resume(when + (p.late ?? 0))).outbound) out.push({ o, from: p })
    if (!out.length) break
    while (out.length) {
      const { o, from } = out.shift() as Sent
      for (const to of people) {
        if (to === from || !Object.hasOwn((await to.read()).addresses.keys, o.envelope.rkid)) continue
        const got = await to.h.receive(o.envelope, when + (to.late ?? 0))
        if (to === B && (from === T || from === L)) {
          const row = (table[short(o.type)] ??= { phone: new Set(), laptop: new Set() })
          row[from === T ? 'phone' : 'laptop'].add(verdict(got))
        }
        if (got.disposition === 'unique' || got.disposition === 'duplicate-known') for (const x of got.outbound) out.push({ o: x, from: to })
      }
    }
  }
  return table
}
/** The table of a scenario, one line per document type. */
function rows (table: Table): Row {
  const side = (set: Set<string>): string => set.size ? [...set].sort().join(' / ') : 'none sent'
  return Object.fromEntries(Object.entries(table).sort().map(([t, r]) => [t, `phone: ${side(r.phone)} | laptop: ${side(r.laptop)}`]))
}
const from = (P: Person, r: any): Sent[] => r.outbound.map((o: any) => ({ o, from: P }))
const founded = async (P: Person): Promise<string> => ev(ok(await P.h.foundGroup({ name: 'Garden' }, opts(tick()))), 'group.founded')[0].groupId
const invitePrompt = async (P: Person, g: string): Promise<any> => (await P.h.prompts()).find((p: any) => p.kind === 'group-invite' && p.groupId === g)
async function pair (f: number): Promise<{ T: Person, B: Person, a: any, b: any }> {
  const T = await mk(f), B = await mk(f + 1)
  const { a, b } = await met(T, B)
  return { T, B, a, b }
}

export const SCENARIOS: Record<string, () => Promise<Row>> = {
  'trust given on the phone, the laptop holds the same state': async () => {
    const { T, B, a } = await pair(0x21)
    const r = ok(await T.h.trust(a.id, opts(tick())))
    const L = await copyOf(T)
    return rows(await settle({ T, L, B }, from(T, r)))
  },
  'trust given apart on both': async () => {
    const { T, B, a } = await pair(0x23)
    const L = await copyOf(T)
    return rows(await settle({ T, L, B }, [...from(T, ok(await T.h.trust(a.id, opts(tick())))), ...from(L, ok(await L.h.trust(a.id, opts(tick()))))]))
  },
  'B trusts A, both devices answer': async () => {
    const { T, B, b } = await pair(0x25)
    const L = await copyOf(T)
    return rows(await settle({ T, L, B }, from(B, ok(await B.h.trust(b.id, opts(tick()))))))
  },
  'the same profile set apart on both': async () => {
    const { T, B, a } = await pair(0x27)
    await settle({ T, L: T, B }, from(T, ok(await T.h.setClass(a.id, 'profile', 'on', opts(tick())))))
    const L = await copyOf(T)
    return rows(await settle({ T, L, B }, [...from(T, ok(await T.h.setProfile({ name: 'Ada' }, opts(tick())))), ...from(L, ok(await L.h.setProfile({ name: 'Ada' }, opts(tick()))))]))
  },
  'different profiles set apart on both': async () => {
    const { T, B, a } = await pair(0x29)
    await settle({ T, L: T, B }, from(T, ok(await T.h.setClass(a.id, 'profile', 'on', opts(tick())))))
    const L = await copyOf(T)
    return rows(await settle({ T, L, B }, [...from(T, ok(await T.h.setProfile({ name: 'Ada' }, opts(tick())))), ...from(L, ok(await L.h.setProfile({ name: 'Ada L.' }, opts(tick()))))]))
  },
  'B writes a message, both devices acknowledge': async () => {
    const { T, B, b } = await pair(0x2b)
    const L = await copyOf(T)
    return rows(await settle({ T, L, B }, from(B, ok(await B.h.sendMessage(b.id, 'hello', opts(tick()))))))
  },
  'B invites A, both devices answer the prelude, the phone accepts': async () => {
    const { T, B, b } = await pair(0x2d)
    const g = await founded(B)
    const L = await copyOf(T)
    const t = await settle({ T, L, B }, from(B, ok(await B.h.invite(g, b.id, opts(tick())))))
    const p = await invitePrompt(T, g)
    if (!p) throw new Error('the phone holds no invitation')
    return rows(await settle({ T, L, B }, from(T, ok(await T.h.decide(p.id, 'accept', opts(tick())))), t))
  },
  'B invites A, both devices accept apart': async () => {
    const { T, B, b } = await pair(0x2f)
    const g = await founded(B)
    const L = await copyOf(T)
    const t = await settle({ T, L, B }, from(B, ok(await B.h.invite(g, b.id, opts(tick())))))
    const [pt, pl] = [await invitePrompt(T, g), await invitePrompt(L, g)]
    if (!pt || !pl) throw new Error('a device holds no invitation')
    return rows(await settle({ T, L, B }, [...from(T, ok(await T.h.decide(pt.id, 'accept', opts(tick())))), ...from(L, ok(await L.h.decide(pl.id, 'accept', opts(tick()))))], t))
  },
  'A invited B on the phone, both devices take the answers': async () => {
    const { T, B, a } = await pair(0x31)
    const g = await founded(T)
    const inv = ok(await T.h.invite(g, a.id, opts(tick())))
    const L = await copyOf(T)
    const t = await settle({ T, L, B }, from(T, inv))
    // each device issued an invitation of its own: B answers every one it holds
    const ps = (await B.h.prompts()).filter((p: any) => p.kind === 'group-invite' && p.groupId === g)
    if (!ps.length) throw new Error('B holds no invitation')
    for (const p of ps) {
      const d = await B.h.decide(p.id, 'accept', opts(tick()))
      if (d.ok) await settle({ T, L, B }, from(B, d), t)
    }
    // which invitation B answers first is not fixed (prompt ids are random),
    // and the device that issued it serves B's first request for the log
    const out = rows(t)
    const page = t['x-access-page/0.1']
    if (page && page.phone.size + page.laptop.size === 1) out['x-access-page/0.1'] = 'the device whose invitation was answered first: ' + [...page.phone, ...page.laptop][0] + ' | the other: none sent'
    return { ...out, 'invitations B holds': String(ps.length) }
  },
  'B asks the group log of a group A founded, both devices answer': async () => {
    const { T, B, a } = await pair(0x33)
    const g = await founded(T)
    await settle({ T, L: T, B }, from(T, ok(await T.h.invite(g, a.id, opts(tick())))))
    await settle({ T, L: T, B }, from(B, ok(await B.h.decide((await invitePrompt(B, g)).id, 'accept', opts(tick())))))
    const L = await copyOf(T)
    return rows(await settle({ T, L, B }, from(B, ok(await B.h.syncGroups({ when: tick(), groupId: g })))))
  },
  'A showed a card on the phone, B scans it, both devices confirm': async () => {
    const T = await mk(0x35), B = await mk(0x36)
    const shown = ok(await T.h.show(opts(tick(), { name: 'Al' })))
    const L = await copyOf(T)
    const sc = ok(await B.h.scan(ev(shown, 'encounter.shown')[0].card, opts(tick(), { name: 'Bea' })))
    const t = await settle({ T, L, B }, from(B, sc))
    const [pt, pl] = [T, L].map(async (P) => (await P.h.prompts()).find((p: any) => p.kind === 'encounter-confirm'))
    const acts: Sent[] = []
    for (const [P, pp] of [[T, await pt], [L, await pl]] as Array<[Person, any]>) if (pp) acts.push(...from(P, ok(await P.h.decide(pp.id, 'accept', opts(tick())))))
    return rows(await settle({ T, L, B }, acts, t))
  },
}

/** Every scenario's table, in order. */
export async function measure (): Promise<Record<string, Row>> {
  const got: Record<string, Row> = {}
  for (const [name, run] of Object.entries(SCENARIOS)) {
    try { got[name] = await run() } catch (e) { (e as Error).message = `${name}: ${(e as Error).message}`; throw e }
  }
  return got
}
