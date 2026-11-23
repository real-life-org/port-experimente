// The scenarios of the everyday baseline that the layer prototype covers,
// run through the layer (`layer.ts`, `invitation.ts`, `encounter.ts`, `trust.ts`), for the conformance
// matrix. Same ids and same expectations as the baseline; a scenario the
// prototype does not cover is not listed and shows as not run.
import { at, clk, copyOf, ev, met, mk, ok, tick, type Person } from './fixture'
import { Device as Msg } from './layer'
import { Device as Inv } from './invitation'
import { carry } from './carrier'
import { Device as Enc, cardOf, first, second } from './encounter'
import { Device as Trust } from './trust'

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface LayerRow { id: string, status: 'green' | 'red', note?: string }
const verdict = (id: string, ok_: boolean, note: string): LayerRow => (ok_ ? { id, status: 'green' } : { id, status: 'red', note })

async function messages (fill: number): Promise<{ T: Msg, L: Msg, B: Person, a: any, b: any }> {
  const A = await mk(fill), B = await mk(fill + 1)
  const { a, b } = await met(A, B)
  return { T: new Msg('phone', A), L: new Msg('laptop', await copyOf(A)), B, a, b }
}
async function invited (fill: number): Promise<{ T: Inv, L: Inv, B: Person, g: string }> {
  const A = await mk(fill), B = await mk(fill + 1)
  const { b } = await met(A, B)
  const g = ev(ok(await B.h.foundGroup({ name: 'Garden' }, at(B))), 'group.founded')[0].groupId
  const T = new Inv('phone', A), L = new Inv('laptop', await copyOf(A))
  await carry(B, [T, L], [T, L], ok(await B.h.invite(g, b.id, at(B))).outbound)
  return { T, L, B, g }
}
const inbox = async (D: Msg): Promise<number> => (await D.P.h.inbox()).length
const phase = async (D: Inv, g: string): Promise<string | undefined> => (await D.P.h.groups()).find((x: any) => x.id === g)?.phase
const card = async (D: Inv, g: string): Promise<boolean> => (await D.P.h.prompts()).some((p: any) => p.kind === 'group-invite' && p.groupId === g)
const members = async (P: Person, g: string): Promise<number> => (await P.h.groups()).find((x: any) => x.id === g).members.length

export async function runLayer (): Promise<LayerRow[]> {
  const rows: LayerRow[] = []
  {
    const { T, L, B, b } = await messages(0xa1)
    const doc = ok(await B.h.sendMessage(b.id, 'hello', at(B))).outbound[0]
    await T.receive(doc.envelope); await L.receive(doc.envelope)
    const n = [await inbox(T), await inbox(L)]
    rows.push(verdict('N1', n[0] === 1 && n[1] === 1, `inbox: phone ${n[0]}, laptop ${n[1]}`))
    await T.takeAll(); await L.syncFrom(T)
    rows.push(verdict('N3', (await inbox(L)) === 0 && L.conversation.size === 1, `the laptop still offers ${await inbox(L)}`))
  }
  {
    const { T, L, a } = await messages(0xa3)
    await T.send(a.id, 'from the phone'); await L.syncFrom(T)
    rows.push(verdict('N2', [...L.conversation.values()].some((l) => l.dir === 'out' && l.text === 'from the phone'), 'the laptop does not show the sent message'))
  }
  {
    const { T, L, B, g } = await invited(0xa5)
    const cards = [await card(T, g), await card(L, g)]
    rows.push(verdict('M1', cards[0] === true && cards[1] === true, `card: phone ${cards[0]}, laptop ${cards[1]}`))
    const acted = await T.decide(g, 'accept'); await L.syncFrom(T)
    await carry(B, [T, L], [T, L], T.toCarrier(acted.outbound)); await L.syncFrom(T); await T.syncFrom(L)
    const ph = [await phase(T, g), await phase(L, g)]
    rows.push(verdict('M2', ph[0] === 'member' && ph[1] === 'member' && !(await card(L, g)), `phase: phone ${ph[0]}, laptop ${ph[1]}`))
  }
  {
    // apart: accept on the phone, decline on the laptop; once with the accept out of the house, once with it still inside
    const out = await invited(0xa7)
    const leaving = out.T.toCarrier((await out.T.decide(out.g, 'accept')).outbound)
    await out.L.decide(out.g, 'decline'); await out.L.syncFrom(out.T); await out.T.syncFrom(out.L)
    await carry(out.B, [out.T, out.L], [out.T, out.L], leaving); await out.L.syncFrom(out.T); await out.T.syncFrom(out.L)
    const a = [await phase(out.T, out.g), await phase(out.L, out.g), await members(out.B, out.g)]
    const ins = await invited(0xa9)
    const held = await ins.T.decide(ins.g, 'accept')
    await ins.L.decide(ins.g, 'decline'); await ins.L.syncFrom(ins.T); await ins.T.syncFrom(ins.L)
    await carry(ins.B, [ins.T, ins.L], [ins.T, ins.L], ins.T.toCarrier(held.outbound))
    const b = [await phase(ins.T, ins.g), await phase(ins.L, ins.g), await members(ins.B, ins.g)]
    rows.push(verdict('M3', a[0] === 'member' && a[1] === 'member' && a[2] === 2 && b[0] === undefined && b[1] === undefined && b[2] === 1,
      `accept out: ${a.join('/')}; accept held: ${b.join('/')}`))
  }
  {
    // K1: the phone meets B, the laptop learns it
    const { T, L, B } = await encounter(0xb1)
    await scans(T, B)
    const met = await idsOf(T)
    await L.syncFrom(T); await T.syncFrom(L)
    const k1 = [await shown(T), await shown(L)]
    rows.push(verdict('K1', met.length === 1 && k1[0] === `${met[0]} mutual` && k1[1] === k1[0], `met as ${met.join(', ')}; phone ${k1[0]}; laptop ${k1[1] || 'nothing'}`))
  }
  {
    // K2: a fresh pair of devices, apart: the phone meets B, the laptop meets C; only then they sync
    const { T, L, B } = await encounter(0xb3)
    const C = await first(0xb7)
    await scans(T, B)
    await scans(L, C)
    const apart = [await idsOf(T), await idsOf(L)]
    await L.syncFrom(T); await T.syncFrom(L)
    const k2 = [await shown(T), await shown(L)]
    // the ids each device met under, both verified, on both devices
    const want = [...apart[0]!, ...apart[1]!].map((id) => `${id} mutual`).sort().join(', ')
    rows.push(verdict('K2', apart[0]!.length === 1 && apart[1]!.length === 1 && apart[0]![0] !== apart[1]![0] && k2[0] === want && k2[1] === want,
      `apart: phone ${apart[0]!.join(', ')}, laptop ${apart[1]!.join(', ')}; after sync: phone ${k2[0]}; laptop ${k2[1]}`))
  }
  {
    // K3: B meets the phone and later, apart, the laptop
    const { T, L, B } = await encounter(0xb5)
    await scans(T, B); await scans(L, B)
    await L.syncFrom(T); await T.syncFrom(L)
    await carry(B, [], [T, L], [], 30)
    await L.syncFrom(T); await T.syncFrom(L)
    const n = [(await T.P.h.contacts()).length, (await L.P.h.contacts()).length, (await B.h.contacts()).length]
    const notTaken = [...new Set(L.notTaken)]
    rows.push(verdict('K3', n[0] === 1 && n[1] === 1 && n[2] === 1,
      `lines for B: phone ${n[0]}, laptop ${n[1]}; lines for A at B: ${n[2]}${notTaken.length ? `; the laptop did not take: ${notTaken.join(', ')}` : ''}`))
  }
  {
    // K4: A trusts B on the phone; K5: apart, on the phone and on the laptop
    for (const [id, apart] of [['K4', false], ['K5', true]] as const) {
      const { T, L, B } = await encounter(id === 'K4' ? 0xc1 : 0xc5)
      await scans(T, B)
      await L.syncFrom(T); await T.syncFrom(L)
      const [a, b] = [(await T.P.h.contacts())[0].id, (await B.h.contacts())[0].id]
      // each cut of the prototype keeps its own log: other names, so the entry ids (the library's act ids) do not repeat those of the encounter
      const [t, l] = [new Trust('phone-trust', T.P), new Trust('laptop-trust', L.P)]
      const out = t.toCarrier((await t.act('trust', a)).outbound)
      if (apart) out.push(...l.toCarrier((await l.act('trust', a)).outbound))
      await l.syncFrom(t); await t.syncFrom(l)
      const refused = await carry(B, [], [t, l], out, 20)
      await l.syncFrom(t); await t.syncFrom(l)
      const given = [(await T.P.h.contact(a)).trust.given, (await L.P.h.contact(a)).trust.given, (await B.h.contact(b)).trust.received]
      rows.push(verdict(id, given.every(Boolean) && !refused.length && !t.notTaken.length && !l.notTaken.length,
        `given: phone ${given[0]}, laptop ${given[1]}; received at B: ${given[2]}; B refuses: ${refused.join(', ') || 'nothing'}`))
    }
  }
  return rows
}

async function encounter (fill: number): Promise<{ T: Enc, L: Enc, B: Person }> {
  const A = await first(fill), B = await first(fill + 1)
  return { T: new Enc('phone', A), L: new Enc('laptop', await second(A)), B }
}
/** B shows its card, device D scans it, B confirms; the carrier reaches D only. */
async function scans (D: Enc, B: Person): Promise<void> {
  const a = await D.act({ act: 'scan', card: cardOf(ok(await B.h.show(at(B, { name: 'Bea' })))), name: 'Al' })
  const got = await B.h.receive(a.outbound[0].envelope, clk(B, tick()))
  const prompt = (await B.h.prompts()).find((p: any) => p.kind === 'encounter-confirm')
  await carry(B, [], [D], [...got.outbound, ...ok(await B.h.decide(prompt.id, 'accept', at(B))).outbound])
}
const idsOf = async (D: Enc): Promise<string[]> => (await D.P.h.contacts()).map((c: any) => c.id as string).sort()
/** What a device shows of its contacts: the full id and the verification, sorted. */
const shown = async (D: Enc): Promise<string> => (await D.P.h.contacts()).map((c: any) => `${c.id} ${c.verification}`).sort().join(', ')
