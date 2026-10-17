import { describe, expect, it } from 'vitest'
import { Welt15 } from '../src/lab/mehrgeraet/welt'
import { HolderDevice } from '../src/lab/mehrgeraet/holder'
import { runX15 } from '../src/lab/mehrgeraet/scenarios'
import { k1a, type K1aDevice } from '../src/candidates/mehrgeraet-k1a'
import * as M from '../src/lab/mehrgeraet/model'

// E15 K1a Schritt 1: der Abnahmelauf aus Tor-Review 6 (Plan 6e).
//   1. Ohne Recht ganz blockiert: das Gerät ohne Annahmekontingent nimmt kein Ticket an, das andere schon;
//      ein Mediatorgerät benennt nur die ihm zugeteilten Schlüssel.
//   2. Autorisiert → Commit: der Schritt steht als ein Batch im Journal, mit Operationen und Absichten.
//   3. Absturz vor Versand → neue Instanz mit neuer Inkarnation → dieselben Bytes gehen hinaus.
//   4. Dupliziertes, umgeordnetes, unvollständiges Journal → genau eine Wirkung, gleiche vollständige Projektion.
//   5. Eine Absicht des anderen Geräts wird nicht neu produziert (X5 besteht).

const byId = (rs: Awaited<ReturnType<typeof runX15>>) => Object.fromEntries(rs.map((r) => [r.scenario, r]))

async function pair() {
  const w = new Welt15(k1a())
  const A = await w.person('A', 'A1')
  const B = await w.person('B', 'B1')
  const Mm = await w.person('M', 'M1')
  const am = await w.encounter(A, Mm)
  const bm = await w.encounter(B, Mm)
  await w.rounds(2)
  await A.setClass(am.x.id, true)
  await B.setClass(bm.x.id, true)
  await w.rounds(3)
  return { w, A, B, Mm, am, bm }
}

describe('K1a Schritt 1: Abnahmelauf', () => {
  it('1. Rechte: das Annahmekontingent ist je Gerät statisch, ein Mediatorgerät benennt nur seine Schlüssel', async () => {
    const w = new Welt15(k1a({ budget: 2 })) // 2 je Person: ein Platz je Gerät
    const A = await w.person('A', 'A1')
    const Mm = await w.person('M', 'M1')
    const am = await w.encounter(A, Mm)
    const cs = []
    for (const n of ['C', 'D', 'E']) {
      const C = await w.person(n, `${n}1`)
      const cm = await w.encounter(C, Mm)
      await w.rounds(1)
      await C.setClass(cm.x.id, true)
      cs.push(cm.y.id)
    }
    await w.rounds(2)
    await A.setClass(am.x.id, true)
    await w.rounds(3)
    const A2 = await w.enrol(A, 'A2')
    const M2 = await w.enrol(Mm, 'M2')
    await w.rounds(2)
    expect((A.cand as K1aDevice).slots).toBe(2)
    // Drei Vorstellungen an A: A1 darf eine annehmen, A2 eine, die dritte bleibt bei beiden blockiert.
    for (const c of cs) {
      const r = await Mm.introduce(am.y.id, c)
      if (!('act' in r)) {
        // M1 darf den kanonisch gewählten Schlüssel nicht benennen: M2 versucht es.
        const r2 = await M2.introduce(am.y.id, c)
        expect('act' in r2, JSON.stringify(r2)).toBe(true)
      }
      await w.rounds(4)
    }
    const accepted = new Set([...A.state.acts, ...A2.state.acts].map((a) => a.id))
    expect(accepted.size).toBe(2)
    expect(A.measures.blocked + A2.measures.blocked).toBeGreaterThanOrEqual(1)
    expect(A.dispositions.concat(A2.dispositions)).toContain('blocked(ticket-accept)')
    // Beide Geräte tragen am Ende dieselbe Projektion (das Journal hat die Annahmen verteilt).
    await w.rounds(3)
    expect(w.agree('A')).toEqual({ agree: true, diff: '' })
  }, 120_000)

  it('2. Commit: ein gelungener Schritt ist ein Batch mit Operationen und Absichten; das Schwestergerät faltet ihn genau einmal', async () => {
    const { w, A, Mm, am } = await pair()
    const A2 = await w.enrol(A, 'A2')
    await w.rounds(2)
    const before = (A.cand as K1aDevice).persist().batches.length
    expect(await A.setClass(am.x.id, false)).toBe('ok') // Klasse aus: withdraw + Revision, eine Absicht
    const p = (A.cand as K1aDevice).persist()
    expect(p.batches.length).toBe(before + 1)
    const last = p.batches[p.batches.length - 1]!
    expect(last.ops.map((o) => o.kind)).toEqual(['class', 'withdraw', 'revision'])
    expect(last.intents.length).toBe(1)
    expect(last.intents[0]!.device).toBe('A1')
    expect(last.intents[0]!.expected).toBe(am.x.peer)
    await w.rounds(3)
    expect(M.rel(A2.state, am.x.id).classOn).toBe(false)
    expect(A2.intents.has(last.intents[0]!.digest)).toBe(true)
    expect(A2.zusteller.submissions.has(last.intents[0]!.digest)).toBe(false) // nicht neu eingeliefert
    expect(A2.state.applied.filter((k) => k.startsWith('A1@')).length).toBe(new Set(A2.state.applied.filter((k) => k.startsWith('A1@'))).size)
    expect(w.agree('A')).toEqual({ agree: true, diff: '' })
    expect(M.rel(Mm.state, am.y.id).view?.keys.length).toBe(0)
  }, 60_000)

  it('3. Absturz vor Versand: neue Instanz, neue Inkarnation, dieselben Bytes', async () => {
    const { w, A, Mm, am } = await pair()
    const A2 = await w.enrol(A, 'A2')
    await w.rounds(2)
    const writer = A.cand.writer
    A.crashAt = 'before-send'
    expect(await A.setClass(am.x.id, false)).toBe('crashed')
    const digest = [...A.intents.values()].find((i) => i.kind.includes('prekeys') && i.writer === writer && A.zusteller.report(i.digest) === null)!.digest
    const bytes = A.zusteller.submissions.get(digest)!.frame
    const A1b = new HolderDevice('A1', 'A', A.cand, w.carrier, w.clock, w.stores.get('A1'))
    await A1b.reload()
    w.devices.splice(w.devices.indexOf(A), 1, A1b)
    expect(A1b.cand.writer).not.toBe(writer)
    expect(A1b.cand.writer.startsWith('A1@')).toBe(true)
    const mark = w.carrier.carried.length
    await w.rounds(3)
    const sent = w.carrier.carried.slice(mark).filter((f) => f.address === am.x.peerKeyAgreement)
    expect(sent.length).toBeGreaterThanOrEqual(1)
    expect(Buffer.compare(sent[0]!.bytes, bytes)).toBe(0)
    expect(M.rel(Mm.state, am.y.id).view?.keys.length).toBe(0)
    // Der Schritt vor dem Absturz steht im Journal unter der alten Inkarnation, der nächste unter der neuen.
    await A1b.setClass(am.x.id, true)
    const ws = (A1b.cand as K1aDevice).persist().batches.map((b) => b.writer)
    expect(ws).toContain(writer)
    expect(ws[ws.length - 1]).toBe(A1b.cand.writer)
    await w.rounds(3)
    expect(w.agree('A')).toEqual({ agree: true, diff: '' })
    void A2
  }, 60_000)

  it('4. Journal doppelt, umgeordnet, unvollständig: genau eine Wirkung, gleiche Projektion', async () => {
    const { w, A, Mm, am } = await pair()
    const A2 = await w.enrol(A, 'A2')
    await w.rounds(2)
    const self = (await A.cand.keys.pair('self/A')).rkid
    // Erst wird ein Rahmen für A2 zurückgehalten, dann doppelt und umgekehrt geliefert.
    let held: Uint8Array | null = null
    w.carrier.faults.withhold('A2', (f) => { if (f.address === self && !held) held = f.bytes; return !!held && Buffer.compare(held, f.bytes) === 0 })
    await A.setClass(am.x.id, false)
    await w.rounds(1)
    await A.setClass(am.x.id, true)
    await w.rounds(1)
    w.carrier.faults.duplicate(true)
    w.carrier.faults.reverse(true)
    await w.rounds(3)
    expect(A2.dispositions.some((d) => d.startsWith('deferred(batch:'))).toBe(true)
    expect(w.agree('A').agree).toBe(false) // der zurückgehaltene Rahmen fehlt noch
    w.carrier.faults.reset()
    const n = await w.until(() => w.agree('A').agree, 15)
    expect(n).toBeGreaterThan(0)
    expect(A2.state.applied.filter((k, i, a) => a.indexOf(k) !== i), 'doppelt angewandt').toEqual([])
    // Endgültige Wirkungen genau einmal (Klassen-Umschaltungen an/aus/an sind keine).
    const finals = A2.state.effects.map((e) => e.id).filter((id) => /^(accept|ticket|connect|card|mapping|consent|decline):/.test(id))
    expect(new Set(finals).size).toBe(finals.length)
    expect(M.canonical(A2.projection())).toBe(M.canonical(A.projection()))
    expect(M.rel(Mm.state, am.y.id).view?.keys.length).toBe(5)
  }, 90_000)

  it('5. X5: die Absicht des anderen Geräts wird nicht neu produziert; X2: das Kontingent hält die Grenze', async () => {
    const r = byId(await runX15(k1a(), false, ['X5', 'X2']))
    expect(r.X5!.crashed).toBeFalsy()
    expect(r.X5!.outcome, r.X5!.detail).toBe('bestanden')
    expect(r.X2!.crashed).toBeFalsy()
    expect(r.X2!.outcome, r.X2!.detail).toBe('bestanden')
    expect(r.X2!.measures.blockedOperations).toBeGreaterThanOrEqual(1)
  }, 600_000)
})
