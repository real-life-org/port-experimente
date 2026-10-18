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
//   Hybrid nach Tor-Review 25 (Anton 18.10.: „das Log beim Dienst ist Beschleunigung, nie Freigabegrund“; Replication D1:
//   Zurückhalten durch den Träger darf nie eine Freigabe bewirken): Daten aus der Ablage, Freigabe nach Restore nur mit dem
//   Zeugnis einer Schwester oder dem Widerruf aller Schwestern, wie im Default.
//   2. Restore-Gegenlauf, Schwester verloren: gefaltet nach 2 Runden, gesperrt bis zum Widerruf; Karte erreicht B nie.
//   3. Schwester erreichbar: Sperre endet mit ihrem Zeugnis (eine Runde nach dem Default).
//   4. B1: leere, verkürzte, umgeordnete Antwort gibt nichts frei.
//   5. B2: beschädigte Einträge: Befund, Cursor bleibt, Backoff, Sperre hält.
//   6. Restore mit verlorener Schwester und gültiger Karte: gesperrt bis Widerruf wie K1a.
//   7. Bindung (MV-5). 8. Träger unerreichbar. 9. S2: verlorene Antwort, nächste Runde neu.
//   10. Enrollment aus der Ablage. 11. Alle Szenarien: dieselben Ausgänge wie K1a. 12. Was der Dienst lernt; Wachstum.

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

  /**
   * Astras Gegenlauf (Review 18, Review 25): A1 stimmt offline zu (Karte beim Adapter, nie beim Träger), Backup; A2 lehnt
   * ab, B stimmt zu; die Geräte heilen (beide abgelehnt, Karte zurückgenommen). Dann kommt A1 aus dem Backup mit der Karte
   * `handed` zurück; A2 ist verloren (offline, nicht widerrufen) oder erreichbar.
   */
  async function restoredCounterRun(siblingLive: boolean, make = variant) {
    const p = await withA2(make)
    const { w, A, A2, B, act } = p
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
    if (!siblingLive) A2.online = false
    w.stores.get('A1')!.restore(backup)
    await A.reload()
    expect(M.act(A.state, act).o).toBe('handed') // der Stand des Backups
    return p
  }
  /** Antworten der Ablage an A1 verfälschen (der Dienst kann zurückhalten, verkürzen, umordnen, beschädigen). */
  function tamper(w: Welt15, mode: 'empty' | 'truncated' | 'corrupt' | 'reverse') {
    const take = w.carrier.takeLogAnswers.bind(w.carrier)
    w.carrier.takeLogAnswers = (name) =>
      take(name).map((a) => {
        if (name !== 'A1') return a
        const half = a.from + Math.floor((a.end - a.from) / 2)
        if (mode === 'empty') return { ...a, end: a.from, entries: [] }
        if (mode === 'truncated') return { ...a, end: half, entries: a.entries.filter((e) => e.pos < half) }
        if (mode === 'corrupt') return { ...a, entries: a.entries.map((e) => ({ ...e, bytes: new Uint8Array([0]) })) }
        return { ...a, entries: [...a.entries].reverse() }
      })
    return () => void (w.carrier.takeLogAnswers = take)
  }

  it('2. Hybrid (Anton 18.10., Review 25 B1): A2 verloren und nicht widerrufen; die Ablage bringt die Ablehnung schnell (gefaltet, einig), die Sperre bleibt bis zum Widerruf wie im Default; die zurückgenommene Karte erreicht B nie', async () => {
    const { w, A, B, act } = await restoredCounterRun(false)
    const g0 = A.gatedRounds
    const folded = await w.until(() => !A.logPending && M.act(A.state, act).o === 'cancelled', 5)
    expect(folded).toBe(2) // Leseanfrage in Runde 1, Antwort gelesen und gefaltet in Runde 2
    await w.rounds(20)
    expect(A.gated).toBe(true) // die Antwort der Ablage beendet die Sperre nicht
    expect(A.witnessPending).toBe(true)
    expect(A.gatedRounds - g0).toBe(22)
    expect(M.act(A.state, act)).toMatchObject({ state: 'declined', o: 'cancelled' }) // aktuell aus der Ablage, obwohl gesperrt
    expect(a1CardDeposits(A, act)).toBe(0)
    A.deviceRevoked('A2') // „Gerät entfernen“: erst jetzt fällt die Sperre
    await w.rounds(3)
    expect(A.gated).toBe(false)
    expect(a1CardDeposits(A, act)).toBe(0)
    expect(M.act(B.state, act)).toMatchObject({ state: 'consented', pending: null })
  }, 300_000)

  it('3. Hybrid mit erreichbarer Schwester: die Sperre endet erst mit dem Zeugnis von A2 (Antwort auf die laufende Anfrage, Köpfe gedeckt); die Daten kamen schon aus der Ablage; gleich viele gesperrte Runden wie der Default', async () => {
    const { w, A, B, act } = await restoredCounterRun(true)
    const g0 = A.gatedRounds
    const folded = await w.until(() => !A.logPending, 5)
    expect(folded).toBe(2)
    expect(A.gated).toBe(true) // gefaltet, aber noch kein Zeugnis
    expect(M.act(A.state, act).o).toBe('cancelled')
    expect(await w.until(() => !A.gated, 10)).toBeGreaterThan(0)
    const gated = A.gatedRounds - g0
    expect(a1CardDeposits(A, act)).toBe(0)
    expect(M.act(B.state, act).state).toBe('consented')
    // Gegenprobe Default (Briefkasten): derselbe Ablauf.
    const mb = await restoredCounterRun(true, () => k1a())
    const m0 = mb.A.gatedRounds
    expect(await mb.w.until(() => !mb.A.gated, 10)).toBeGreaterThan(0)
    expect(gated).toBe(mb.A.gatedRounds - m0 + 1) // eine Runde mehr: die Anfrage an die Schwester geht nach dem Falten hinaus
    expect(a1CardDeposits(mb.A, mb.act)).toBe(0)
  }, 300_000)

  for (const mode of ['empty', 'truncated', 'reverse'] as const)
    it(`4. Review 25 B1 (${mode}): eine leere, verkürzte oder umgeordnete Antwort der Ablage gibt nichts frei; mit verlorener Schwester bleibt die Sperre, mit erreichbarer bezeugt A2 und liefert, was fehlt`, async () => {
      for (const live of [false, true]) {
        const { w, A, B, act } = await restoredCounterRun(live)
        tamper(w, mode)
        await w.rounds(25)
        expect(A.gated, `live=${live}`).toBe(!live)
        expect(a1CardDeposits(A, act), `live=${live}`).toBe(0)
        expect(M.act(B.state, act).state).toBe('consented')
        if (live || mode !== 'empty') expect(M.act(A.state, act).o, `live=${live}`).toBe('cancelled')
        else expect(M.act(A.state, act).o).toBe('handed') // der Dienst hielt alles zurück, die Sperre hält
      }
    }, 300_000)

  it('5. Review 25 B2: beschädigte Einträge zählen nie als gefaltet; Befund journal:corrupt-entry je Position, der Cursor bleibt davor, erneut mit Backoff; die Sperre hält; heil gelesen geht es weiter', async () => {
    const { w, A, B, act } = await restoredCounterRun(false)
    const heal = tamper(w, 'corrupt')
    const r0 = A.logRequests
    await w.rounds(20)
    expect(A.logPending).toBe(true)
    expect(A.snapshotState().logCursor).toBe(0)
    expect(A.logCorrupt).toBeGreaterThan(0)
    expect(A.dispositions.filter((d) => d.startsWith('finding(journal:corrupt-entry@')).length).toBe(A.logCorrupt) // je Position einmal
    expect(A.logRequests - r0).toBeLessThanOrEqual(5) // Backoff 1, 2, 4, 8 statt jede Runde
    expect(A.gated).toBe(true)
    expect(a1CardDeposits(A, act)).toBe(0)
    expect(M.act(A.state, act).o).toBe('handed')
    heal()
    expect(await w.until(() => !A.logPending, 20)).toBeGreaterThan(0)
    expect(M.act(A.state, act).o).toBe('cancelled')
    expect(A.gated).toBe(true)
    expect(M.act(B.state, act).state).toBe('consented')
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

  it('6. Restore mit verlorener Schwester und gültiger Karte: gefaltet und einig nach 2 Runden, gesperrt bis zum Widerruf wie K1a (20 von 20); danach geht die Karte hinaus', async () => {
    const { w, A, B, act } = await restoredWithLostSibling()
    expect(await w.until(() => !A.logPending, 5)).toBe(2)
    await w.rounds(18)
    expect(A.gatedRounds).toBe(20)
    expect(a1CardDeposits(A, act)).toBe(0)
    const mb = await restoredWithLostSibling(() => k1a())
    await mb.w.rounds(20)
    expect(mb.A.gatedRounds).toBe(20)
    expect(a1CardDeposits(mb.A, mb.act)).toBe(0)
    A.deviceRevoked('A2')
    expect(await w.until(() => a1CardDeposits(A, act) === 1 && M.act(B.state, act).state === 'connected', 20)).toBeGreaterThan(0)
  }, 300_000)

  it('7. Bindung (MV-5): eine Antwort der Ablage auf eine frühere Leseanfrage zählt nicht; erst die Antwort auf die laufende', async () => {
    const { w, A, act } = await restoredWithLostSibling()
    const self = (await A.cand.keys.pair('self/A')).rkid
    await A.round()
    expect(w.carrier.logReads.filter((r) => r.device === 'A1' && r.address === self).length).toBe(1)
    await A.reload() // neue Inkarnation, keine laufende Anfrage: die bereitliegende Antwort ist alt
    await A.round()
    expect(A.staleSyncAnswers).toBe(1)
    expect(A.logPending).toBe(true)
    expect(a1CardDeposits(A, act)).toBe(0)
    expect(await w.until(() => !A.logPending, 5)).toBeGreaterThan(0)
  }, 300_000)

  it('8. Träger unerreichbar: Leseanfragen mit Backoff, gesperrt; danach gefaltet, die Freigabe wartet weiter auf Zeugnis oder Widerruf', async () => {
    const { w, A, act } = await restoredWithLostSibling()
    w.carrier.unreachable = true
    await w.rounds(6)
    expect(A.logPending).toBe(true)
    expect(A.logRequests).toBeLessThanOrEqual(3) // 1, 2, 4
    expect(a1CardDeposits(A, act)).toBe(0)
    w.carrier.unreachable = false
    expect(await w.until(() => !A.logPending, 20)).toBeGreaterThan(0)
    expect(A.gated).toBe(true)
    expect(a1CardDeposits(A, act)).toBe(0)
  }, 300_000)

  it('9. Review 25 S2: eine verlorene Antwort der Ablage wird in der nächsten Runde neu angefragt (höchstens eine Leseanfrage je Runde); nach der Verlustphase gefaltet in einer Runde', async () => {
    const { w, A } = await restoredWithLostSibling()
    w.carrier.logFaults.dropAnswer((d) => d === 'A1')
    await w.rounds(10)
    expect(A.logPending).toBe(true)
    expect(A.logRequests).toBe(10)
    w.carrier.faults.reset()
    expect(await w.until(() => !A.logPending, 5)).toBe(2) // Anfrage in der ersten Runde nach der Heilung, Antwort in der zweiten
  }, 300_000)

  it('10. Enrollment aus der Ablage: A2 beginnt leer (keine Zustandskopie), faltet die Ablage ab Beginn, die Freigabe bezeugt A1; danach dieselbe Projektion, die Absichten aus dem Journal und die behaltenen Proben', async () => {
    const { w, A, Mm, am, bm } = await pair()
    const r = await Mm.introduce(am.y.id, bm.y.id)
    if (!('act' in r)) throw new Error(r.refused)
    await w.rounds(3)
    const A2 = await w.enrol(A, 'A2')
    expect(A2.state.relationships).toEqual([])
    expect(A2.intents.size).toBe(0)
    expect(A2.logPending).toBe(true)
    const n = await w.until(() => !A2.logPending, 5)
    expect(n).toBe(2) // Anfrage am Ende der ersten Runde, Antwort gelesen in der zweiten
    expect(M.canonical(A2.projection())).toBe(M.canonical(A.projection()))
    expect([...A2.intents.keys()].sort()).toEqual([...A.intents.keys()].sort())
    expect(A2.logEntriesRead).toBeGreaterThan(0)
    expect(await w.until(() => !A2.gated, 5)).toBeGreaterThan(0) // Zeugnis von A1
    expect(A2.gatedRounds).toBeGreaterThanOrEqual(2)
    expect(await A2.consent(r.act)).toBe('ok')
    // Gegenprobe: ohne Ablage bleibt der alte Weg (Zustandskopie).
    const mb = await pair(() => k1a())
    const B2 = await mb.w.enrol(mb.A, 'A2')
    expect(B2.state.relationships.length).toBe(mb.A.state.relationships.length)
  }, 300_000)

  it('11. alle Szenarien mit zwei Geräten: dieselben Ausgänge wie K1a; X21: Daten aus der Ablage, Zeugnis der Schwester, Reparatur nach jedem Verlust in einer Runde (S2), Dienstvolumen nach Störungen getrennt (S3)', async () => {
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
    for (const k of ['Restore', 'RequestLoss', 'AnswerLoss', 'JournalLoss']) expect(x[`repairRounds${k}`], k).toBe(1)
    expect(x.syncReplyFrames as number).toBeGreaterThan(0) // die Schwester bezeugt
    expect(x.answersService as number).toBeGreaterThan(0)
    expect(x.logRequests as number).toBeGreaterThanOrEqual(x.answersService as number) // verlorene Anfragen erreichen den Träger nicht
    expect(x.serviceBytesServed as number).toBeLessThan(x.serviceBytesSent as number) // Antwort- und Eintragsverlust
    expect(x.serviceRequestBytes as number).toBeGreaterThan(0)
    expect(x.serviceHeadBytes as number).toBeGreaterThan(0)
    expect(x.devicesPendingSync).toBe(0)
    expect(r.X8!.measures.enrolRounds).toBe(2)
    expect(r.X8!.measures.enrolGatedRounds as number).toBeGreaterThanOrEqual(2)
  }, 1_800_000)

  it('12. was der Dienst lernt und Wachstum im Langlauf: Zahlen, keine Kompaktierung', async () => {
    const g = await journalGrowth(variant(), { rounds: 200 })
    expect(g.agree).toBe(true)
    expect(g.issued).toBeGreaterThan(5)
    expect(g.connected).toBeGreaterThan(0)
    expect(g.opsBytes + g.intentBytes).toBeLessThanOrEqual(g.journalBytes)
    expect(g.removableIntents).toBeLessThanOrEqual(g.doneIntents)
    expect(g.doneIntents).toBeLessThanOrEqual(g.intents)
    expect(g.batchesBelowMinHead).toBeLessThanOrEqual(g.batches)
    expect(g.batchesOlderThanWindow).toBeGreaterThan(0) // 200 × 4 h > 28 d
    expect(g.series.length).toBe(10)
    for (let i = 1; i < g.series.length; i++) expect(g.series[i]!.logEntries).toBeGreaterThanOrEqual(g.series[i - 1]!.logEntries) // die Ablage wächst nur
    expect(g.service.readers.length).toBeGreaterThan(0)
    expect(g.service.collectors.length).toBe(2)
    expect(g.service.entries).toBe(g.logEntries)
    expect(g.service.perReader.A2!.cursors[0]).toBe(0) // der Dienst sieht Cursor, Zeit und Rückstand je Leser
    expect(g.service.sizePattern.distinct).toBeGreaterThan(1)
    // Review 25 S1: ein verlorenes, nicht widerrufenes Gerät blockiert „entfernbar“; erst sein Widerruf gäbe frei.
    const gl = await journalGrowth(variant(), { rounds: 60, lose: { round: 20 } })
    expect(gl.lost).toEqual(['A2'])
    expect(gl.removableIntents).toBeLessThan(gl.removableIntentsIfLostRevoked)
    expect(gl.batchesBelowMinHead).toBeLessThan(gl.batchesBelowLiveHead)
    // Ohne Ablage hält der Dienst nichts.
    const mb = await pair(() => k1a())
    const self = (await mb.A.cand.keys.pair('self/A')).rkid
    expect(serviceLearns(mb.w, self).entries).toBe(0)
  }, 1_200_000)
})
