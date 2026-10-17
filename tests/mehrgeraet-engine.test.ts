import { describe, expect, it } from 'vitest'
import { Welt15 } from '../src/lab/mehrgeraet/welt'
import { k0 } from '../src/candidates/mehrgeraet-k0'
import * as M from '../src/lab/mehrgeraet/model'

// E15: serielle Kontrollläufe der Engine (ein Gerät je Person). Sie zeigen,
// dass der Prüfstand das Sollmodell trägt, bevor K0 gegen die X-Szenarien läuft.

describe('E15 Engine, seriell (ein Gerät je Person)', () => {
  it('Begegnung, Vorrat, Vorstellung, Consent beider Seiten, Verbindung; keine Doppel', async () => {
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
    // M hält Sichten mit fünf Schlüsseln je Seite.
    expect(M.rel(Mm.state, am.y.id).view?.keys.length).toBe(5)
    expect(M.rel(Mm.state, bm.y.id).view?.keys.length).toBe(5)
    const r = await Mm.introduce(am.y.id, bm.y.id, 'Alice', 'Bob')
    expect('act' in r).toBe(true)
    const actId = (r as { act: string }).act
    await w.until(() => A.state.acts.length === 1 && B.state.acts.length === 1)
    expect(M.act(A.state, actId).state).toBe('offered')
    expect(M.act(B.state, actId).state).toBe('offered')
    // 8640.14: own verbraucht, Budget zählt, Nachfüllen auf fünf aktive.
    expect(M.rel(A.state, am.x.id).stock.filter((k) => k.state === 'consumed').length).toBe(1)
    expect(M.budgetUsed(M.rel(A.state, am.x.id), w.clock.now())).toBe(1)
    await w.rounds(2)
    expect(M.rel(A.state, am.x.id).stock.filter((k) => k.state === 'active').length).toBe(4) // 8485: nachgefüllt wird erst unter drei
    await A.consent(actId)
    await w.rounds(3)
    expect(M.act(A.state, actId).state).toBe('consented')
    expect(M.act(B.state, actId).pending).not.toBeNull() // 8910.4: Alices Karte wartet bei Bob
    await B.consent(actId)
    const n = await w.until(() => M.act(A.state, actId).state === 'connected' && M.act(B.state, actId).state === 'connected')
    expect(n).toBeGreaterThan(0)
    expect(A.state.relationships.length).toBe(2) // M und B
    expect(w.duplicates('A')).toBe(0)
    expect(w.duplicates('B')).toBe(0)
    // 8630: M hält vom Akt nur Marken.
    expect(Mm.state.consumed.length).toBe(2)
    expect(Mm.state.acts.length).toBe(0)
  }, 60_000)

  it('Ablehnung ist terminal und still; Budget: die elfte Annahme fällt bei Schritt 10', async () => {
    const w = new Welt15(k0())
    const A = await w.person('A', 'A1')
    const Mm = await w.person('M', 'M1')
    const am = await w.encounter(A, Mm)
    const others: Array<{ rel: string }> = []
    for (let i = 0; i < 11; i++) {
      const C = await w.person(`C${i}`, `C${i}-1`)
      const cm = await w.encounter(C, Mm)
      await w.rounds(1)
      await C.setClass(cm.x.id, true)
      others.push({ rel: cm.y.id })
    }
    await w.rounds(2)
    await A.setClass(am.x.id, true)
    await w.rounds(3)
    const acts: string[] = []
    for (let i = 0; i < 11; i++) {
      const r = await Mm.introduce(am.y.id, others[i]!.rel)
      expect('act' in r, JSON.stringify(r)).toBe(true)
      acts.push((r as { act: string }).act)
      await w.rounds(3)
    }
    const relA = M.rel(A.state, am.x.id)
    expect(A.state.acts.length).toBe(10) // 8510/8640.10: die elfte fällt
    expect(M.budgetUsed(relA, w.clock.now())).toBe(10)
    expect(A.state.findings.some((f) => f.includes('Budget erschöpft'))).toBe(true)
    await A.decline(acts[0]!)
    expect(M.act(A.state, acts[0]!).state).toBe('declined')
    await A.consent(acts[0]!)
    expect(M.act(A.state, acts[0]!).state).toBe('declined') // terminal (8325.A3)
    expect(A.measures.framesOut).toBeGreaterThan(0)
    const before = A.measures.framesOut
    await w.rounds(2)
    expect(A.measures.framesOut).toBe(before) // 8765: nichts gesendet
  }, 120_000)
})

describe('E15 Engine, Kontinuität seriell', () => {
  it('zweite Begegnung derselben Personen: Probe trifft, Mappings laufen, eine Beziehung mit zwei Tupeln, keine Doppel', async () => {
    const w = new Welt15(k0())
    const A = await w.person('A', 'A1')
    const B = await w.person('B', 'B1')
    const first = await w.encounter(A, B)
    await w.rounds(2)
    expect(A.state.relationships.length).toBe(1)
    const second = await w.encounter(A, B)
    const n = await w.until(() => A.state.relationships.length === 1 && B.state.relationships.length === 1 && A.state.relationships[0]!.tuples.length === 2)
    expect(n).toBeGreaterThan(0)
    expect(B.state.relationships[0]!.tuples.length).toBe(2)
    expect(w.duplicates('A')).toBe(0)
    expect(w.duplicates('B')).toBe(0)
    // 2280: der Kopf ist das Tupel mit dem größten Record-Anker, das andere deaktiviert.
    const ra = A.state.relationships[0]!
    expect(ra.tuples.filter((t) => t.deactivated).length).toBe(1)
    expect([first.x.id, second.x.id]).toContain(M.head(ra).id)
    // 6845: beide Pflichten enden united, sobald die Quittungen da sind.
    await w.rounds(3)
    expect(A.state.duties.map((d) => d.state)).toEqual(['united'])
    expect(B.state.duties.map((d) => d.state)).toEqual(['united'])
  }, 60_000)
})
