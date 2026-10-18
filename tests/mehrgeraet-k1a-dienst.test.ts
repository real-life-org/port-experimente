import { describe, expect, it } from 'vitest'
import { Welt15 } from '../src/lab/mehrgeraet/welt'
import { TYPES, transactionProblem, type HolderDevice } from '../src/lab/mehrgeraet/holder'
import { diSign, digestBytes, jcs, seal } from '@real-life/trust-protocol'
import { journalGrowth, runX15, serviceLearns } from '../src/lab/mehrgeraet/scenarios'
import { batchProblem, k1a } from '../src/candidates/mehrgeraet-k1a'
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
//   Review 26 B2 (Rest): 13. Ablage, 14. Briefkasten, 15. Enrollment aus der Ablage: kaputte Form oder werfende Faltung
//   ist ein Befund, kein Abbruch; 16. Formprüfung.
//   Review 27: B2a tiefe Formprüfung (13, 14, 16: verschachtelte Werte, beide Pfade); 17. B2b: eine Antwort ist eine Einheit.

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
  // ── Review 26 B2 (Rest): Form vor dem Falten, jede Ausnahme der Faltung ist `corrupt` ──
  // Ein gültig self-signierter Journalrahmen (Seed) mit kaputter Form brach die Runde mit einem TypeError ab, ohne Befund
  // und Backoff. Jetzt: Formprüfung (Payload, Batch, Operationen, Absichten) vor dem Falten; eine Ausnahme aus
  // `receiveOwnFrame`/`applyRemote` außer `Missing` (zurückgestellt) und `Blocked` ist `corrupt`. Ablage: Cursor bleibt,
  // Befund `journal:corrupt-entry@pos` je Position, Backoff, und ab der beschädigten Position faltet die Antwort nichts
  // weiter (Blockieren: die Reihenfolge der Ablage zählt). Briefkasten (Default-K1a): Befund `journal:corrupt-frame@digest`
  // je Digest, keine Quittung, die Runde läuft weiter, spätere Rahmen falten (deps schützen die Kausalität).
  const X = 'X@feed'
  const xop = (extra: Record<string, unknown>) => ({ id: { writer: X, n: 1 }, at: '2026-10-17T08:00:00.000Z', ...extra })
  const T0 = '2026-10-17T08:00:00.000Z'
  const INTENT = { digest: 'uEiAtcRZCtyawRAFifKn7rDL1yFMPsZA8xNsCJYcXkhpIgQ', kind: 'k', bytes: 'AA==', address: 'a', expected: 'e', replyTo: 'r', device: 'A1', writer: 'A1@x' }
  const SKEY = { n: 0, nonce: 'AA==', anchor: 'anc', keyAgreement: 'ka', key: 'ctx', expiresAt: T0, state: 'active' }
  const CARD = { anchor: 'anc', keyAgreement: 'ka' }
  const ACT = { id: 'act', mediator: 'rel', own: 'anc', voucher: { anchor: 'v', keyAgreement: 'vk', name: 'V' }, issuedAt: T0, expiresAt: T0, state: 'offered', pending: null, v: null, k: false, ownCard: null, ownCardKey: null, o: 'none', ownCardDigest: null, opened: null }
  const batch = (extra: Record<string, unknown>) => ({ b: Buffer.from(JSON.stringify({ writer: X, n: 1, deps: [], ops: [], intents: [], ...extra })).toString('base64') })
  /** Ein gültig self-signierter, versiegelter Journalrahmen an die eigene Adresse (wer den Seed hat). */
  async function selfFrame(w: Welt15, D: HolderDevice, payload: unknown): Promise<{ bytes: Uint8Array; digest: string; rkid: string }> {
    const k = await (D as unknown as { keysFor(c: string): Promise<{ anchor: string; rkid: string; ed: { priv: CryptoKey } }> }).keysFor(`self/${D.person}`)
    const doc = await diSign({ anchor: k.anchor, ed: { priv: k.ed.priv } }, { id: crypto.randomUUID(), type: TYPES.journal, issuer: k.anchor, recipient: k.anchor, replyTo: k.rkid, issuedAt: w.clock.now(), payload } as never, w.clock.now())
    const bytes = new TextEncoder().encode(jcs(await seal(doc as never, k.rkid)))
    return { bytes, digest: await digestBytes(new TextEncoder().encode(jcs(doc as never))), rkid: k.rkid }
  }
  /** Die Ablage liefert `name` vor dem ersten echten Eintrag einen zusätzlichen (die echten rücken eine Position weiter). */
  function insertFirst(w: Welt15, name: string, bytes: Uint8Array) {
    const take = w.carrier.takeLogAnswers.bind(w.carrier)
    const at: number[] = []
    w.carrier.takeLogAnswers = (n) =>
      take(n).map((a) => {
        if (n !== name) return a
        at.push(a.from)
        return { ...a, end: a.end + 1, entries: [{ pos: a.from, at: w.clock.now(), bytes }, ...a.entries.map((e) => ({ ...e, pos: e.pos + 1 }))] }
      })
    return { at, heal: () => void (w.carrier.takeLogAnswers = take) }
  }
  /** Wie `insertFirst`, mehrere Einträge vor dem ersten echten. */
  function insertMany(w: Welt15, name: string, list: Uint8Array[]) {
    const take = w.carrier.takeLogAnswers.bind(w.carrier)
    const at: number[] = []
    w.carrier.takeLogAnswers = (n) =>
      take(n).map((a) => {
        if (n !== name) return a
        at.push(a.from)
        return { ...a, end: a.end + list.length, entries: [...list.map((bytes, i) => ({ pos: a.from + i, at: w.clock.now(), bytes })), ...a.entries.map((e) => ({ ...e, pos: e.pos + list.length }))] }
      })
    return { at, heal: () => void (w.carrier.takeLogAnswers = take) }
  }
  const malformed = (rel: string): Array<[string, unknown]> => [
    ['payload: null', null],
    ['ops: null', batch({ ops: null })],
    ['deps kein Array', batch({ deps: 'A1@x#1' })],
    ['deps mit Nicht-String', batch({ deps: [7] })],
    ['writer kein String', batch({ writer: 7 })],
    ['intents kein Array', batch({ intents: {} })],
    ['unbekannte Op-Art', batch({ ops: [xop({ kind: 'bogus' })] })],
    ['Op ohne id', batch({ ops: [{ at: '2026-10-17T08:00:00.000Z', kind: 'finding', text: 'x' }] })],
    ['Faltung wirft (view mit kaputten Schlüsseln)', batch({ ops: [xop({ kind: 'view', rel, scope: 's', revision: 1, keys: [null, null] })] })],
    // Review 27 B2a: verschachtelte Werte, die Zustand würden (Astras drei Proben und weitere Formen).
    ['allocate.keys: [{}]', batch({ ops: [xop({ kind: 'allocate', rel, nonce: 'AA==', keys: [{}] })] })],
    ['view.keys: [7]', batch({ ops: [xop({ kind: 'view', rel, scope: 's', revision: 1, keys: [7] })] })],
    ['Intent bytes: "!!!"', batch({ intents: [{ ...INTENT, bytes: '!!!' }] })],
    ['NaN-Zeit (expiresAt)', batch({ ops: [xop({ kind: 'allocate', rel, nonce: 'AA==', keys: [{ ...SKEY, expiresAt: 'NaN' }] })] })],
    ['Op-Zeit unlesbar', batch({ ops: [{ ...xop({ kind: 'finding', text: 'x' }), at: 'gestern' }] })],
    ['negatives n', batch({ ops: [xop({ kind: 'allocate', rel, nonce: 'AA==', keys: [{ ...SKEY, n: -1 }] })] })],
    ['unbekannter Zustand (Enum)', batch({ ops: [xop({ kind: 'allocate', rel, nonce: 'AA==', keys: [{ ...SKEY, state: 'bogus' }] })] })],
    ['verschachteltes Nicht-Objekt (voucher: 7)', batch({ ops: [xop({ kind: 'ticket-accept', act: { ...ACT, voucher: 7 } })] })],
    ['Intent-Digest kein Digest', batch({ intents: [{ ...INTENT, digest: 'kein digest' }] })],
  ]

  it('13. Review 26 B2, Ablage: kaputte Form oder werfende Faltung ist ein Befund je Position, kein Abbruch; der Cursor bleibt, Backoff, die Sperre hält; der gültige Eintrag dahinter wird nicht gefaltet, solange der kaputte blockiert', async () => {
    for (const [what, payload] of [...malformed('REL'), ['eingespritzte Ausnahme in applyRemote', batch({ ops: [xop({ kind: 'finding', text: 'x' })] })] as [string, unknown]]) {
      const { w, A, B, act } = await restoredCounterRun(false)
      const rel = A.state.relationships[0]!.id
      const p = what.startsWith('Faltung') ? batch({ ops: [xop({ kind: 'view', rel, scope: 's', revision: 1, keys: [null, null] })] }) : payload
      if (what.startsWith('eingespritzte')) {
        const orig = A.applyRemote.bind(A)
        A.applyRemote = async (tx) => {
          if (tx.ops.some((o) => o.id.writer === X)) throw new TypeError('eingespritzt')
          return orig(tx)
        }
      }
      const { bytes } = await selfFrame(w, A, p)
      const ins = insertFirst(w, 'A1', bytes)
      const r0 = A.logRequests
      await w.rounds(20) // kein Abbruch
      const first = ins.at[0]!
      expect(A.logCorrupt, what).toBe(1)
      expect(A.dispositions.filter((d) => d === `finding(journal:corrupt-entry@${first})`).length, what).toBe(1)
      expect(A.snapshotState().logCursor, what).toBe(first)
      expect(A.logPending, what).toBe(true)
      expect(A.logRequests - r0, what).toBeLessThanOrEqual(5) // Backoff
      expect(M.act(A.state, act).o, what).toBe('handed') // die Ablehnung dahinter ist nicht gefaltet (Blockieren)
      expect(Object.keys(A.cand.heads!()).some((k) => k.startsWith('X@')), what).toBe(false) // nichts vom kaputten Batch im Journal
      expect(A.state.relationships.every((r) => Number.isInteger(r.nextN) && r.stock.every((k) => typeof k.anchor === 'string')), what).toBe(true)
      expect(A.state.relationships.every((r) => !r.view || r.view.keys.every((k) => typeof k === 'object' && k !== null)), what).toBe(true)
      expect(A.gated, what).toBe(true)
      expect(a1CardDeposits(A, act), what).toBe(0)
      ins.heal()
      expect(await w.until(() => !A.logPending, 20), what).toBeGreaterThan(0)
      expect(M.act(A.state, act).o, what).toBe('cancelled')
      expect(A.gated, what).toBe(true)
      expect(M.act(B.state, act).state).toBe('consented')
    }
  }, 900_000)

  it('14. Review 26 B2, Briefkasten (Default-K1a): derselbe kaputte Rahmen ist ein Befund je Digest, keine Quittung, keine Wirkung; die Runde läuft weiter und spätere Rahmen falten; nach Restore hält die Sperre', async () => {
    const p = await withA2(() => k1a())
    const { w, A, A2, act } = p
    const rel = A.state.relationships[0]!.id
    const frames: string[] = []
    for (const [what, payload] of malformed(rel)) {
      const f = await selfFrame(w, A2, payload)
      frames.push(f.digest)
      w.carrier.deposit(f.rkid, f.bytes)
      w.carrier.deposit(f.rkid, f.bytes) // zweimal: ein Befund
      const before = M.canonical(A.projection())
      const headsBefore = JSON.stringify(A.cand.heads!())
      await w.rounds(1)
      expect(A.dispositions.filter((d) => d === `finding(journal:corrupt-frame@${f.digest})`).length, what).toBe(1)
      expect(M.canonical(A.projection()), what).toBe(before)
      expect(JSON.stringify(A.cand.heads!()), what).toBe(headsBefore) // der Journalkopf wächst nicht
      expect(A.snapshotState().completed.includes(f.digest), what).toBe(false) // keine Quittung
    }
    expect(A.frameCorrupt).toBe(frames.length)
    expect(await A2.decline(act)).toBe('ok')
    expect(await w.until(() => M.act(A.state, act).state === 'declined', 5)).toBeGreaterThan(0) // spätere Rahmen falten
    // Restore mit verlorener Schwester: der kaputte Rahmen ändert nichts an der Sperre.
    const q = await restoredWithLostSibling(() => k1a())
    const f = await selfFrame(q.w, q.A, batch({ ops: null }))
    q.w.carrier.deposit(f.rkid, f.bytes)
    await q.w.rounds(10)
    expect(q.A.frameCorrupt).toBe(1)
    expect(q.A.gated).toBe(true)
    expect(a1CardDeposits(q.A, q.act)).toBe(0)
  }, 900_000)

  it('15. Review 26 B2, Enrollment aus der Ablage: ein kaputter erster Eintrag blockiert die Ablagespur (Befund, Cursor 0, kein Abbruch); Daten und Zeugnis kommen über die Schwesterspur von A1 (dieselbe Projektion); heil gelesen endet auch die Ablagespur', async () => {
    const { w, A } = await pair()
    await w.rounds(1)
    const { bytes } = await selfFrame(w, A, batch({ ops: null }))
    const take = w.carrier.takeLogAnswers.bind(w.carrier)
    let on = true
    w.carrier.takeLogAnswers = (n) => take(n).map((a) => (n === 'A2' && on ? { ...a, end: a.end + 1, entries: [{ pos: a.from, at: w.clock.now(), bytes }, ...a.entries.map((e) => ({ ...e, pos: e.pos + 1 }))] } : a))
    const A2 = await w.enrol(A, 'A2')
    await w.rounds(8)
    expect(A2.logCorrupt).toBe(1)
    expect(A2.dispositions).toContain('finding(journal:corrupt-entry@0)')
    expect(A2.snapshotState().logCursor).toBe(0)
    expect(A2.logPending).toBe(true) // die Ablage ist blockiert
    expect(M.canonical(A2.projection())).toBe(M.canonical(A.projection())) // die Schwester lieferte (Briefkasten an der Self-Adresse)
    expect(A2.gated).toBe(false) // Zeugnis von A1, nicht die Ablage
    on = false
    expect(await w.until(() => !A2.logPending, 20)).toBeGreaterThan(0)
    expect(A2.logCorrupt).toBe(1)
    expect(M.canonical(A2.projection())).toBe(M.canonical(A.projection()))
  }, 300_000)

  it('16. Formprüfung: Batch (K1a), Transaktion und Operation', () => {
    const ok = { writer: X, n: 1, deps: ['A1@x#1'], ops: [xop({ kind: 'finding', text: 'x' })], intents: [INTENT] }
    expect(batchProblem(ok)).toBeNull()
    for (const bad of [null, 7, [], { ...ok, writer: 7 }, { ...ok, n: 0 }, { ...ok, n: '1' }, { ...ok, deps: 'x' }, { ...ok, deps: [1] }, { ...ok, ops: null }, { ...ok, ops: {} }, { ...ok, intents: null }, { ...ok, intents: [{ ...ok.intents[0], bytes: 1 }] }, { ...ok, intents: [null] }])
      expect(batchProblem(bad), JSON.stringify(bad)).not.toBeNull()
    expect(transactionProblem({ ops: [], intents: [] })).toBeNull()
    for (const bad of [null, { ops: null, intents: [] }, { ops: [], intents: null }, { ops: [null], intents: [] }, { ops: [], intents: [{ digest: 'd' }] }, { ops: [], intents: [{ ...INTENT, bytes: new Uint8Array(1), digest: 7 }] }]) expect(transactionProblem(bad), JSON.stringify(bad)).not.toBeNull()
    expect(M.opProblem(xop({ kind: 'class', rel: 'r', on: true }))).toBeNull()
    const TUPLE = { id: 't', own: 'o', ownKey: 'ok', peer: 'p', peerKeyAgreement: 'pk', record: 'r', openedAt: T0, candidates: ['c'], deactivated: false }
    expect(M.opProblem(xop({ kind: 'open-tuple', rel: null, tuple: TUPLE, provenance: 'encounter', vouchedBy: null, act: null }))).toBeNull()
    // Review 27 B2a: die Formprüfung reicht in jeden Wert, der Zustand wird.
    for (const good of [
      xop({ kind: 'allocate', rel: 'r', nonce: 'AA==', keys: [SKEY] }),
      xop({ kind: 'view', rel: 'r', scope: 's', revision: 0, keys: [{ n: 1, anchor: 'a', keyAgreement: 'k', expiresAt: T0 }], clears: { w: 2 } }),
      xop({ kind: 'ticket-accept', act: ACT }),
      xop({ kind: 'ticket-accept', act: { ...ACT, pending: CARD, decisions: [{ kind: 'consent', op: 'o', at: T0 }], cards: { d: 'handed' }, consentOp: 'o' } }),
      xop({ kind: 'introduce', act: { id: 'm', a: { rel: 'r', key: 'k', keyAgreement: 'ka' }, b: { rel: 'r2', key: 'k2', keyAgreement: 'kb' }, issuedAt: T0, expiresAt: T0 } }),
      xop({ kind: 'consent', act: 'a', card: CARD, cardKey: 'k' }),
      xop({ kind: 'duty', pair: ['a', 'b'], state: 'hit', mappingDigest: null }),
    ])
      expect(M.opProblem(good), JSON.stringify(good)).toBeNull()
    for (const bad of [
      xop({ kind: 'open-tuple', rel: null, tuple: {}, provenance: 'encounter', vouchedBy: null, act: null }),
      xop({ kind: 'open-tuple', rel: null, tuple: { ...TUPLE, candidates: [1] }, provenance: 'encounter', vouchedBy: null, act: null }),
      xop({ kind: 'open-tuple', rel: null, tuple: TUPLE, provenance: 'zufall', vouchedBy: null, act: null }),
      xop({ kind: 'allocate', rel: 'r', nonce: 'AA==', keys: [{}] }),
      xop({ kind: 'allocate', rel: 'r', nonce: 'AA==', keys: [{ ...SKEY, n: 1.5 }] }),
      xop({ kind: 'allocate', rel: 'r', nonce: 'AA==', keys: [{ ...SKEY, extra: 1 }] }),
      xop({ kind: 'view', rel: 'r', scope: 's', revision: 1, keys: [7] }),
      xop({ kind: 'view', rel: 'r', scope: 's', revision: -1, keys: [] }),
      xop({ kind: 'view', rel: 'r', scope: 's', revision: 1, keys: [], clears: { w: 'x' } }),
      xop({ kind: 'ticket-accept', act: { ...ACT, state: 'bogus' } }),
      xop({ kind: 'ticket-accept', act: { ...ACT, pending: 7 } }),
      xop({ kind: 'ticket-accept', act: { ...ACT, cards: { d: 'bogus' } } }),
      xop({ kind: 'introduce', act: { id: 'm', a: [], b: { rel: 'r2', key: 'k2', keyAgreement: 'kb' }, issuedAt: T0, expiresAt: T0 } }),
      xop({ kind: 'hand-over', act: 'a', o: 'bogus' }),
      xop({ kind: 'duty', pair: ['a'], state: 'hit', mappingDigest: null }),
      xop({ kind: 'budget-confirm', rel: 'r', acts: [null] }),
      xop({ kind: 'withdraw', rel: 'r', anchors: [{}] }),
      { ...xop({ kind: 'finding', text: 'x' }), at: 'NaN' },
      { ...xop({ kind: 'finding', text: 'x' }), id: { writer: X, n: -1 } },
    ])
      expect(M.opProblem(bad), JSON.stringify(bad)).not.toBeNull()
    for (const bytes of ['!!!', 'AA=', 'A===', 'AAA', 'AA==\n']) expect(batchProblem({ ...ok, intents: [{ ...ok.intents[0], bytes }] }), bytes).not.toBeNull()
    expect(batchProblem({ ...ok, intents: [{ ...ok.intents[0], digest: 'zz' }] })).not.toBeNull()
    expect(batchProblem({ ...ok, extra: 1 })).not.toBeNull()
    for (const bad of [null, xop({ kind: 'bogus' }), { at: 'x', kind: 'finding', text: 'x' }, { id: { writer: X, n: '1' }, at: 'x', kind: 'finding', text: 'x' }, { ...xop({ kind: 'finding', text: 'x' }), at: 1 }, xop({ kind: 'class', rel: 'r', on: 'yes' }), xop({ kind: 'withdraw', rel: 'r', anchors: null }), xop({ kind: 'consent', act: 'a', cardKey: 'k' })])
      expect(M.opProblem(bad), JSON.stringify(bad)).not.toBeNull()
  })

  it('17. Review 27 B2b: eine Antwort der Ablage ist eine Einheit; wird Position p erst in einem späteren Durchgang beschädigt erkannt, bleibt keine Wirkung einer Position über p; eine heile Antwort faltet in einem Schritt', async () => {
    const frames = async (w: Welt15, D: HolderDevice) => [
      (await selfFrame(w, D, batch({ n: 2, deps: [`${X}#1`], ops: [xop({ id: { writer: X, n: 2 }, kind: 'finding', text: 'BOOM' })] }))).bytes, // zurückgestellt, dann wirft die Faltung
      (await selfFrame(w, D, batch({ ops: [xop({ kind: 'finding', text: 'P1' })] }))).bytes, // liefert den Vorgänger
      (await selfFrame(w, D, batch({ writer: 'Y@feed', ops: [xop({ id: { writer: 'Y@feed', n: 1 }, kind: 'finding', text: 'MARKER' })] }))).bytes, // unabhängig
    ]
    for (const boom of [true, false]) {
      const { w, A, act } = await restoredCounterRun(false)
      if (boom) {
        const orig = A.applyRemote.bind(A)
        A.applyRemote = async (tx) => {
          if (tx.ops.some((o) => o.kind === 'finding' && o.text === 'BOOM')) throw new TypeError('eingespritzt')
          return orig(tx)
        }
      }
      const ins = insertMany(w, 'A1', await frames(w, A))
      const before = M.canonical(A.projection())
      await w.rounds(boom ? 10 : 3)
      const first = ins.at[0]!
      if (boom) {
        expect(A.logCorrupt).toBe(1)
        expect(A.dispositions.filter((d) => d.startsWith('finding(journal:corrupt-entry@')).length).toBe(1)
        expect(A.dispositions).toContain(`finding(journal:corrupt-entry@${first})`)
        expect(A.snapshotState().logCursor).toBe(first)
        expect(A.state.findings.some((f) => f === 'MARKER' || f === 'P1')).toBe(false) // nichts von Position 1 und 2 bleibt
        expect(Object.keys(A.cand.heads!()).some((k) => k.startsWith('X@') || k.startsWith('Y@'))).toBe(false)
        expect(M.canonical(A.projection())).toBe(before)
        expect(M.act(A.state, act).o).toBe('handed')
        ins.heal()
        expect(await w.until(() => !A.logPending, 20)).toBeGreaterThan(0)
        expect(M.act(A.state, act).o).toBe('cancelled')
      } else {
        expect(A.logCorrupt).toBe(0)
        expect(A.logPending).toBe(false) // eine Antwort, ein Schritt
        expect(A.state.findings).toEqual(expect.arrayContaining(['BOOM', 'P1', 'MARKER']))
        expect(M.act(A.state, act).o).toBe('cancelled')
      }
    }
  }, 600_000)
})
