import { describe, expect, it } from 'vitest'
import { seal, diSign, jcs, edFromSeed, rand, anchorOfEd } from '@real-life/trust-protocol'
import type { Json } from '@real-life/trust-protocol'
import { Welt15 } from '../src/lab/mehrgeraet/welt'
import { HolderDevice, TYPES, seedScheme, type CandidateDevice, type MultiDeviceCandidate } from '../src/lab/mehrgeraet/holder'
import { runX15 } from '../src/lab/mehrgeraet/scenarios'
import { k0 } from '../src/candidates/mehrgeraet-k0'
import * as M from '../src/lab/mehrgeraet/model'

// E15 Gegenläufe (Tor-Review 2, Loop-Review #55–#57): der Prüfstand muss
// falsche Erfolge abfangen und korrektes Verhalten durchlassen.
//   1. Fremd signierte Dokumente an eine unveränderte Adresse wirken nicht (#55).
//   2. Versand und Absturzstelle before-send liegen hinter dem Commit (#56).
//   3. Ein echter Neustart (neue Instanz aus dem Store) behält die Zuordnung der Quittungen (#57).
//   4. Orakel: korrektes Blockieren besteht X1; „nach neun alles verweigern“ fällt bei X2;
//      eine überschriebene Ablehnung wird bei X3 erkannt.

const enc = new TextEncoder()
const byId = (rs: Awaited<ReturnType<typeof runX15>>) => Object.fromEntries(rs.map((r) => [r.scenario, r]))

/** K0 mit einem Haken: der Test entscheidet je Operation, ob sie erlaubt ist. */
function k0With(authorize: (device: string, op: M.Op, state: M.HolderState) => boolean): MultiDeviceCandidate {
  const base = k0()
  const wrap = (name: string, d: CandidateDevice): CandidateDevice => ({ ...d, authorize: (op, state) => authorize(name, op, state) })
  return {
    ...base,
    capabilities: new Set(['rights']),
    async first(person, device, seed) {
      return wrap(device, await base.first(person, device, seed))
    },
    async enrol(from, device) {
      const e = await base.enrol(from, device)
      return { cand: wrap(device, e.cand), state: e.state }
    },
  }
}

/** Ein minimales Journal (K1-Skelett, ohne Rechte): jede Operation reist als Rahmen an die eigene Adresse. */
function journal(hack?: (op: M.Op, state: M.HolderState) => void): MultiDeviceCandidate {
  const seeds = new Map<string, Uint8Array>()
  const device = (person: string, name: string, seed: Uint8Array): CandidateDevice => {
    const out: M.Op[] = []
    const log: M.Op[] = []
    return {
      keys: seedScheme(seed),
      writer: `${name}@1`,
      record(op) {
        log.push(op)
        out.push(op)
      },
      takeOwnFrames: () => out.splice(0).map((op) => ({ body: enc.encode(JSON.stringify(op)) })),
      receiveOwnFrame(body) {
        const op = JSON.parse(new TextDecoder().decode(body)) as M.Op
        log.push(op)
        return [op]
      },
      persist: () => log,
      restore() {},
      authorize(op, state) {
        hack?.(op, state)
        return true
      },
    }
  }
  return {
    id: 'journal-test',
    title: 'Journal ohne Rechte (Testskelett)',
    capabilities: new Set(['journal']),
    async first(person, name, seed) {
      seeds.set(person, seed)
      return device(person, name, seed)
    },
    async enrol(from, name) {
      return { cand: device(from.person, name, seeds.get(from.person)!), state: structuredClone(from.state) }
    },
  }
}

describe('E15 Gegenläufe: Bindung, Commit-Grenze, Neustart', () => {
  it('#55: eine fremd signierte Revision an Ms unveränderte A-Adresse ändert Ms Sicht nicht', async () => {
    const w = new Welt15(k0())
    const A = await w.person('A', 'A1')
    const Mm = await w.person('M', 'M1')
    const am = await w.encounter(A, Mm)
    await w.rounds(2)
    await A.setClass(am.x.id, true)
    await w.rounds(3)
    const before = M.rel(Mm.state, am.y.id).view!
    expect(before.keys.length).toBe(5)
    // E signiert selbst, versiegelt an Ms Schlüssel des A–M-Tupels (die Adresse ist öffentlich).
    const e = await edFromSeed(rand(32))
    const anchor = anchorOfEd(e.pubRaw)
    const doc = await diSign({ anchor, ed: { priv: e.priv } }, { id: 'x', type: TYPES.revision, issuer: anchor, recipient: am.y.own, replyTo: 'nowhere', issuedAt: w.clock.now(), payload: { revision: 999, keys: [] } }, w.clock.now())
    const env = await seal(doc as unknown as Json, am.x.peerKeyAgreement)
    w.carrier.deposit(am.x.peerKeyAgreement, enc.encode(jcs(env)))
    await w.rounds(2)
    expect(M.rel(Mm.state, am.y.id).view).toEqual(before)
    expect(Mm.dispositions).toContain('failed(validation-failed)')
  }, 60_000)

  it('#56: before-send liegt hinter dem Commit; nach dem Neuaufbau geht die gesicherte Revision hinaus', async () => {
    const w = new Welt15(k0())
    const A = await w.person('A', 'A1')
    const Mm = await w.person('M', 'M1')
    const am = await w.encounter(A, Mm)
    await w.rounds(2)
    const carried = w.carrier.carried.length
    A.crashAt = 'before-send'
    expect(await A.setClass(am.x.id, true)).toBe('crashed')
    expect(A.crashes).toEqual(['before-send'])
    expect(w.carrier.carried.length).toBe(carried) // nichts hat das Gerät verlassen
    await w.rounds(2)
    expect(M.rel(Mm.state, am.y.id).view).toBeNull()
    await A.reload()
    await w.rounds(3)
    expect(M.rel(Mm.state, am.y.id).view?.keys.length).toBe(5) // die gesicherte Absicht ging nach dem Neuaufbau hinaus
    expect(M.rel(A.state, am.x.id).classOn).toBe(true)
  }, 60_000)

  it('#57: ein echter Neustart aus dem Store behält die Zuordnung der Kartenquittung (taken → delivered)', async () => {
    const w = new Welt15(k0())
    const A = await w.person('A', 'A1')
    const B = await w.person('B', 'B1')
    const Mm = await w.person('M', 'M1')
    const am = await w.encounter(A, Mm)
    const bm = await w.encounter(B, Mm)
    await w.rounds(2)
    await A.setClass(am.x.id, true)
    await B.setClass(bm.x.id, true)
    await w.rounds(3)
    const r = await Mm.introduce(am.y.id, bm.y.id)
    expect('act' in r).toBe(true)
    const actId = (r as { act: string }).act
    await w.until(() => A.state.acts.length === 1 && B.state.acts.length === 1)
    B.online = false
    await A.consent(actId)
    await w.rounds(1)
    expect(M.act(A.state, actId).o).toBe('taken')
    // Neue Instanz aus demselben Store, die alte ist weg.
    const A1b = new HolderDevice('A1', 'A', A.cand, w.carrier, w.clock, w.stores.get('A1'))
    await A1b.reload()
    w.devices.splice(w.devices.indexOf(A), 1, A1b)
    B.online = true
    const n = await w.until(() => M.act(A1b.state, actId).o === 'delivered')
    expect(n).toBeGreaterThan(0)
  }, 60_000)
})

describe('E15 Gegenläufe: Orakel', () => {
  it('X1: ein Kandidat, der M2 das Vorstellen verweigert (kein Verbrauchsrecht), besteht; blockiert wird gemessen', async () => {
    const c = k0With((device, op) => !(device === 'M2' && op.kind === 'introduce'))
    const r = byId(await runX15(c, false, ['X1']))
    expect(r.X1!.outcome, r.X1!.detail).toBe('bestanden')
    expect(r.X1!.measures.blockedOperations).toBeGreaterThanOrEqual(1)
    expect(r.X1!.measures.progressAfterHeal).toBe(1)
  }, 300_000)

  it('X2: „nach neun alles verweigern“ fällt, weil die Person nur neun statt zehn annimmt', async () => {
    const c = k0With((_, op, state) => !(op.kind === 'ticket-accept' && state.relationships.some((r) => r.accepted.length >= 9)))
    const r = byId(await runX15(c, false, ['X2']))
    expect(r.X2!.outcome, r.X2!.detail).toBe('nicht bestanden')
    expect(r.X2!.measures.acceptedActs).toBe(9)
    expect(r.X2!.measures.budgetOverrun).toBe(0)
  }, 300_000)

  it('X3: ein Journal, in dem die Zustimmung eine Ablehnung überschreibt, wird erkannt (terminaler Zustand verlassen)', async () => {
    // Hack: sobald das Gerät ein Consent eines anderen Geräts für einen abgelehnten Akt kennt, öffnet es ihn wieder.
    const seen = new Map<string, M.Op>()
    const c = journal((op, state) => {
      for (const o of seen.values()) {
        if (o.kind !== 'consent') continue
        const a = state.acts.find((x) => x.id === o.act)
        if (a && a.state === 'declined') {
          a.state = 'offered'
          M.apply(state, { ...o, id: { writer: `${o.id.writer}-again`, n: o.id.n } })
        }
      }
      if (op.kind === 'consent') seen.set(op.act, op)
    })
    const r = byId(await runX15(c, false, ['X3']))
    expect(r.X3!.outcome, r.X3!.detail).toBe('nicht bestanden')
    expect(r.X3!.measures.leftTerminal).toBe(1)
  }, 300_000)
})
