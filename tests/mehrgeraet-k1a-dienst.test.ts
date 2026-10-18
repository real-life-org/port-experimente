import { describe, expect, it } from 'vitest'
import { Welt15 } from '../src/lab/mehrgeraet/welt'
import type { HolderDevice } from '../src/lab/mehrgeraet/holder'
import { journalGrowth, runX15, serviceLearns } from '../src/lab/mehrgeraet/scenarios'
import { k1a } from '../src/candidates/mehrgeraet-k1a'
import { multiDeviceCandidates } from '../src/candidates/mehrgeraet'
import { Carrier } from '../src/lab/zustellung'
import * as M from '../src/lab/mehrgeraet/model'

// E15 K1a Schritt 6 als Variante (Anton 18.10.: „Journal beim Dienst ist eine Option zum Untersuchen, keine Festlegung“).
// Gleiche Regeln wie K1a; die Welt macht die Self-Adresse jeder Person zur Ablage (`selfLog`). Local-first mit dem Träger
// als Briefkasten; Schritt 6 gibt dem Träger an der Self-Adresse eine Ablagerolle: Dienst = Verfügbarkeit, nicht
// Autorität (Replication Tür D1: der Träger kann nur zerstören); Exit: jedes Gerät kann die Ablage neu aufsetzen.
//   HSC-440 (catch-up): „After restore, enrollment or a deferred batch a device MUST catch up …“ (Folgepunkt 32); hier
//   antwortet die Ablage, nicht die Schwester. Identity §6.1/§6.3, ID-STATE-1 (Zustand beim Speicherdienst): der Dienst
//   hält versiegelte Bytes, Position, Zeit; er entscheidet nichts.
//   1. Träger: nur Ablage-Adressen behalten, geordnet; Lesen ab Position nur für registrierte Geräte; Antwort mit der
//      nächsten Abholung; Störungen je Anfrage, Antwort, Eintrag.
//   2. Restore-Gegenlauf (Review 18) ohne Schwester-Sperre: die zurückgenommene Karte erreicht B nie.
//   3. Restore mit verlorener Schwester: Freigabe nach einer Runde (K1a: nie, ohne Widerruf).
//   4. Bindung (MV-5): eine Antwort auf eine frühere Anfrage beendet das Nachholen nicht.
//   5. Träger unerreichbar: die Sperre bleibt, bis die Antwort kommt.
//   6. Enrollment aus der Ablage: das neue Gerät beginnt leer und faltet ab Beginn.
//   7. Alle Szenarien: dieselben Ausgänge wie K1a; X21 mit einem Antwortenden.
//   8. Was der Dienst lernt; Wachstum im Langlauf (nur Zahlen).

const variant = () => k1a({ journalAtService: true })
const byId = (rs: Awaited<ReturnType<typeof runX15>>) => Object.fromEntries(rs.map((r) => [r.scenario, r]))

async function pair(make = variant) {
  const w = new Welt15(make())
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
async function withA2(make = variant) {
  const p = await pair(make)
  const A2 = await p.w.enrol(p.A, 'A2')
  await p.w.rounds(3)
  const r = await p.Mm.introduce(p.am.y.id, p.bm.y.id)
  if (!('act' in r)) throw new Error(r.refused)
  await p.w.until(() => [p.A, A2, p.B].every((d) => d.state.acts.some((a) => a.id === r.act)))
  return { ...p, A2, act: r.act }
}
/** Kartendokumente von A1 an B, die den Träger erreicht haben. */
const a1CardDeposits = (A: HolderDevice, act: string) => {
  const a = M.act(A.state, act)
  return [...A.zusteller.submissions.values()].filter((x) => x.address === a.voucher.keyAgreement && A.intents.get(x.digest)?.kind.includes('introduction-card') && x.deposits > 0).length
}
const states = (w: Welt15, act: string) => w.of('A').map((d) => `${M.act(d.state, act).state}/${M.act(d.state, act).o}`)

describe('K1a Schritt 6 (Variante): Journal beim Dienst', () => {
  it('Variante als zweiter Kandidateneintrag mit derselben Fabrik und der Prüfstandsoption selfLog', () => {
    const ids = multiDeviceCandidates.map((c) => c.id)
    expect(ids).toEqual(['k0-one-seed', 'k1a-static', 'k1a-journal-service'])
    const v = multiDeviceCandidates.find((c) => c.id === 'k1a-journal-service')!.make()
    expect(v.bench).toEqual({ selfLog: true })
    expect(k1a().bench).toBeUndefined()
    expect(new Welt15(v).selfLog).toBe(true)
    expect(new Welt15(k1a()).selfLog).toBe(false)
  })

  it('1. Träger: Ablage nur an gewählten Adressen, geordnet, lesbar ab Position für registrierte Geräte; Antwort mit der nächsten Abholung; Störungen', () => {
    const c = new Carrier()
    let t = 0
    c.now = () => new Date(t).toISOString()
    c.retain('self')
    c.register('d1', 'self')
    c.register('d2', 'self')
    c.register('d1', 'other')
    for (let i = 0; i < 3; i++) {
      t = i * 1000
      c.deposit('self', new Uint8Array([i]))
      c.deposit('other', new Uint8Array([10 + i]))
    }
    expect(c.log('self').map((e) => [e.pos, e.bytes[0], e.at])).toEqual([[0, 0, new Date(0).toISOString()], [1, 1, new Date(1000).toISOString()], [2, 2, new Date(2000).toISOString()]])
    expect(c.log('other')).toEqual([])
    // Abholen und Bestätigen löscht den Briefkasten, nicht die Ablage.
    const f = c.collect('d1')
    c.conclude('d1', f.map((x) => x.id))
    c.conclude('d2', c.collect('d2').map((x) => x.id))
    expect(c.pending('self')).toBe(0)
    expect(c.log('self').length).toBe(3)
    // Lesen ab Position 1; die Antwort liegt erst mit der nächsten Abholung bereit; nur registrierte Geräte.
    c.readLog('d1', 'self', 1, 'r1')
    c.readLog('fremd', 'self', 0, 'r2')
    expect(c.takeLogAnswers('fremd')).toEqual([])
    const [a] = c.takeLogAnswers('d1')
    expect(a).toMatchObject({ req: 'r1', from: 1, end: 3 })
    expect(a!.entries.map((e) => e.pos)).toEqual([1, 2])
    expect(c.takeLogAnswers('d1')).toEqual([])
    // Störungen: Anfrage verloren, Antwort verloren, Einträge verloren (Kopf zugestellt); unerreichbar wirft.
    c.logFaults.dropRequest((d) => d === 'd1')
    c.readLog('d1', 'self', 0, 'r3')
    expect(c.takeLogAnswers('d1')).toEqual([])
    c.faults.reset()
    c.logFaults.dropAnswer(() => true)
    c.readLog('d1', 'self', 0, 'r4')
    expect(c.takeLogAnswers('d1')).toEqual([])
    c.faults.reset()
    c.logFaults.dropEntries((_, e) => e.pos === 1)
    c.readLog('d1', 'self', 0, 'r5')
    expect(c.takeLogAnswers('d1')[0]!.entries.map((e) => e.pos)).toEqual([0, 2])
    c.faults.reset()
    c.unreachable = true
    expect(() => c.readLog('d1', 'self', 0, 'r6')).toThrow()
    c.unreachable = false
    // Ein abgemeldetes (widerrufenes) Gerät liest nicht mehr.
    c.unregister('d2')
    c.readLog('d2', 'self', 0, 'r7')
    expect(c.takeLogAnswers('d2')).toEqual([])
    // Zerstören kann der Träger: eine verschluckte Einlieferung fehlt auch in der Ablage (Tür D1).
    c.faults.drop((x) => x.bytes[0] === 99)
    c.deposit('self', new Uint8Array([99]))
    expect(c.log('self').length).toBe(3)
    expect(c.logReads.map((r) => [r.device, r.from, r.entries])).toEqual([['d1', 1, 2], ['d1', 0, 3], ['d1', 0, 3]])
  })

  it('2. Restore-Gegenlauf (Review 18) ohne Schwester-Sperre: A2 ist verloren und nicht widerrufen; die zurückgenommene Karte erreicht B nie, A1 ist nach der Antwort des Dienstes frei', async () => {
    const { w, A, A2, B, act } = await withA2()
    // Astras Gegenlauf: A1 stimmt offline zu (Karte beim Adapter, nie beim Träger), Backup; A2 lehnt ab, B stimmt zu.
    A.online = A2.online = false
    expect(await A.consent(act)).toBe('ok')
    A.commit()
    const backup = w.stores.get('A1')!.snapshot()
    expect(await A2.decline(act)).toBe('ok')
    expect(await B.consent(act)).toBe('ok')
    A2.online = true
    await w.rounds(1)
    A.online = true
    await w.rounds(20)
    expect(states(w, act)).toEqual(['declined/cancelled', 'declined/cancelled'])
    expect(a1CardDeposits(A, act)).toBe(0)
    // A2 geht verloren (offline für immer, nicht widerrufen); A1 kommt aus dem Backup vor der Rücknahme zurück.
    A2.online = false
    w.stores.get('A1')!.restore(backup)
    await A.reload()
    expect(M.act(A.state, act).o).toBe('handed') // der Stand des Backups
    const gated0 = A.gatedRounds
    expect(await w.until(() => !A.syncPending, 5)).toBeGreaterThan(0)
    await w.rounds(30)
    expect(A.gatedRounds - gated0).toBe(1)
    expect(a1CardDeposits(A, act)).toBe(0)
    expect(M.act(B.state, act)).toMatchObject({ state: 'consented', pending: null })
    expect(M.act(A.state, act)).toMatchObject({ state: 'declined', o: 'cancelled' })
    // Mit dem Briefkasten (K1a) bliebe A1 hier gesperrt, bis A2 widerrufen ist (K1a Schritt 3, Test 8).
  }, 300_000)

  /** Restore A1 aus einem Backup mit gültiger Zustimmung (Karte nie beim Träger), A2 verloren (offline, antwortet nie, nicht widerrufen). */
  async function restoredWithLostSibling(make = variant) {
    const p = await withA2(make)
    const { w, A, A2, B, act } = p
    A.online = A2.online = false
    expect(await A.consent(act)).toBe('ok')
    A.commit()
    const backup = w.stores.get('A1')!.snapshot()
    expect(await B.consent(act)).toBe('ok')
    w.stores.get('A1')!.restore(backup)
    await A.reload()
    A.online = true
    return p
  }

  it('3. Restore mit verlorener Schwester: die Sperre fällt nach einer Runde (Antwort des Dienstes), die Karte geht hinaus, B verbindet; K1a bleibt ohne Widerruf gesperrt', async () => {
    const { w, A, B, act } = await restoredWithLostSibling()
    const n = await w.until(() => a1CardDeposits(A, act) === 1 && M.act(B.state, act).state === 'connected', 20)
    expect(n).toBeGreaterThan(0)
    expect(A.gatedRounds).toBe(1)
    expect(A.syncPending).toBe(false)
    expect(M.act(A.state, act).state).toBe('connected')
    // Gegenprobe: derselbe Ablauf mit Briefkasten.
    const mb = await restoredWithLostSibling(() => k1a())
    await mb.w.rounds(20)
    expect(mb.A.gatedRounds).toBe(20)
    expect(a1CardDeposits(mb.A, mb.act)).toBe(0)
  }, 300_000)

  it('4. Bindung (MV-5): eine Antwort auf eine frühere Anfrage beendet das Nachholen nicht; erst die Antwort auf die laufende', async () => {
    const { w, A, act } = await restoredWithLostSibling()
    // Die erste Anfrage geht hinaus (Runde 1); vor dem Lesen der Antwort baut sich A1 noch einmal aus dem Store auf.
    const self = (await A.cand.keys.pair('self/A')).rkid
    await A.round()
    expect(w.carrier.logReads.filter((r) => r.device === 'A1' && r.address === self).length).toBe(1)
    await A.reload() // neue Inkarnation, keine laufende Anfrage: die bereitliegende Antwort ist alt
    await A.round()
    expect(A.staleSyncAnswers).toBe(1)
    expect(A.syncPending).toBe(true)
    expect(a1CardDeposits(A, act)).toBe(0)
    expect(await w.until(() => !A.syncPending, 5)).toBeGreaterThan(0)
  }, 300_000)

  it('5. Träger unerreichbar: Anfrage wirft nicht durch, die Sperre bleibt mit Backoff, bis der Dienst antwortet', async () => {
    const { w, A, act } = await restoredWithLostSibling()
    w.carrier.unreachable = true
    await w.rounds(6)
    expect(A.syncPending).toBe(true)
    expect(a1CardDeposits(A, act)).toBe(0)
    w.carrier.unreachable = false
    expect(await w.until(() => !A.syncPending, 20)).toBeGreaterThan(0)
    expect(await w.until(() => a1CardDeposits(A, act) === 1, 5)).toBeGreaterThan(0)
  }, 300_000)

  it('6. Enrollment aus der Ablage: A2 beginnt leer (keine Zustandskopie), faltet die Ablage ab Beginn und hat danach dieselbe Projektion, die Absichten aus dem Journal und die behaltenen Proben', async () => {
    const { w, A, Mm, am, bm } = await pair()
    const r = await Mm.introduce(am.y.id, bm.y.id)
    if (!('act' in r)) throw new Error(r.refused)
    await w.rounds(3)
    const A2 = await w.enrol(A, 'A2')
    expect(A2.state.relationships).toEqual([])
    expect(A2.intents.size).toBe(0)
    expect(A2.syncPending).toBe(true)
    const n = await w.until(() => !A2.syncPending, 5)
    expect(n).toBe(2) // Anfrage am Ende der ersten Runde, Antwort gelesen in der zweiten
    expect(M.canonical(A2.projection())).toBe(M.canonical(A.projection()))
    expect([...A2.intents.keys()].sort()).toEqual([...A.intents.keys()].sort())
    expect(A2.logEntriesRead).toBeGreaterThan(0)
    expect(A2.gatedRounds).toBe(1)
    // A2 handelt danach wie nach einer Kopie.
    expect(await A2.consent(r.act)).toBe('ok')
    // Gegenprobe: ohne Ablage bleibt der alte Weg (Zustandskopie).
    const mb = await pair(() => k1a())
    const B2 = await mb.w.enrol(mb.A, 'A2')
    expect(B2.state.relationships.length).toBe(mb.A.state.relationships.length)
  }, 300_000)

  it('7. alle Szenarien mit zwei Geräten: dieselben Ausgänge wie K1a; X21 mit einem Antwortenden (dem Dienst), alle Verlustphasen wirksam', async () => {
    const r = byId(await runX15(variant(), false))
    for (const x of Object.values(r)) expect(x.crashed, `${x.scenario}: ${x.detail}`).toBeFalsy()
    const want: Record<string, string> = {
      X1: 'bestanden', X2: 'bestanden', X3: 'bestanden', X4: 'bestanden', X5: 'bestanden', X6: 'bestanden', X7: 'nicht bestanden', X7b: 'bestanden', X8: 'bestanden', X9: 'nicht bestanden', X10: 'nicht abbildbar', X11: 'bestanden', X12: 'bestanden',
      X13: 'bestanden', X14: 'bestanden', X15: 'bestanden', X16: 'bestanden', X17: 'bestanden', X18: 'bestanden', X21: 'bestanden',
    }
    for (const [id, outcome] of Object.entries(want)) expect(r[id]?.outcome, `${id}: ${r[id]?.detail}`).toBe(outcome)
    expect(Object.values(r).filter((x) => x.promiseChanged).map((x) => x.scenario).sort()).toEqual(['X18', 'X3'])
    const x = r.X21!.measures
    for (const k of ['RequestLoss', 'AnswerLoss', 'JournalLoss']) expect(x[`behindAfter${k}`], k).toBe(1)
    expect(x.answersA1).toBe(0)
    expect(x.answersA2).toBe(0)
    expect(x.syncRequestFrames).toBe(0)
    expect(x.syncReplyFrames).toBe(0)
    expect(x.answersService as number).toBeGreaterThan(0)
    expect(x.devicesPendingSync).toBe(0)
    expect(r.X8!.measures.enrolRounds).toBe(2)
  }, 1_800_000)

  it('8. was der Dienst lernt und Wachstum im Langlauf: Zahlen, keine Kompaktierung', async () => {
    const g = await journalGrowth(variant(), { rounds: 200 })
    expect(g.agree).toBe(true)
    expect(g.issued).toBeGreaterThan(5)
    expect(g.connected).toBeGreaterThan(0)
    expect(g.opsBytes + g.intentBytes).toBeLessThanOrEqual(g.journalBytes)
    expect(g.removableIntents).toBeLessThanOrEqual(g.intents)
    expect(g.batchesBelowMinHead).toBeLessThanOrEqual(g.batches)
    expect(g.batchesOlderThanWindow).toBeGreaterThan(0) // 200 × 4 h > 28 d
    expect(g.series.length).toBe(10)
    for (let i = 1; i < g.series.length; i++) expect(g.series[i]!.logEntries).toBeGreaterThanOrEqual(g.series[i - 1]!.logEntries) // die Ablage wächst nur
    expect(g.service.readers.length).toBeGreaterThan(0)
    expect(g.service.collectors.length).toBe(2)
    expect(g.service.entries).toBe(g.logEntries)
    // Ohne Ablage hält der Dienst nichts.
    const mb = await pair(() => k1a())
    const self = (await mb.A.cand.keys.pair('self/A')).rkid
    expect(serviceLearns(mb.w, self).entries).toBe(0)
  }, 1_200_000)
})
