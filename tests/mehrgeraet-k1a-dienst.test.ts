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
//   Zurückhalten durch den Träger darf nie eine Freigabe bewirken). Seit MV-6 neu / MV-34 (Anton 20.10.) gibt es nach
//   einem Restore keine Freigabe-Sperre mehr, im Default wie hier: das Gerät handelt sofort aus dem erreichbaren Stand,
//   die Ablage liefert nur Daten (MV-35: Beschleunigung). Die Tests prüfen die Datenspur unverändert und die Freigabe neu.
//   2. Restore-Gegenlauf, Schwester verloren: gefaltet nach 2 Runden, keine Sperre; die Karte geht hinaus, Regel 2.
//   3. Schwester erreichbar: keine Sperre, im Default dasselbe.
//   4. B1: leere, verkürzte, umgeordnete Antwort faltet keine falschen Daten; ohne Daten bleibt die Verbindung offen.
//   5. B2: beschädigte Einträge: Befund, Cursor bleibt, Backoff.
//   6. Restore mit verlorener Schwester und gültiger Karte: keine Sperre, im Default dasselbe.
//   7. Bindung (MV-5). 8. Träger unerreichbar. 9. S2: verlorene Antwort, nächste Runde neu.
//   10. Enrollment aus der Ablage. 11. Alle Szenarien: dieselben Ausgänge wie K1a. 12. Was der Dienst lernt; Wachstum.
//   Review 26 B2 (Rest): 13. Ablage, 14. Briefkasten, 15. Enrollment aus der Ablage: kaputte Form oder werfende Faltung
//   ist ein Befund, kein Abbruch; 16. Formprüfung.
//   Review 27: B2a tiefe Formprüfung (13, 14, 16: verschachtelte Werte, beide Pfade); 17. B2b: eine Antwort ist eine Einheit.
//   Review 28 (Klasse): reservierte Namen als Schlüssel und Kennungen auf beiden Pfaden (13, 14); 18. Schlüsseltabellen
//   ohne Prototyp, Kennungsgrammatik, Eigenschaftstest; 19. Zufallsrahmen auf dem Briefkastenpfad; 20. Store-Abbild.
//   CodeRabbit #71: 21. die Antwort der Ablage gilt nur ab der angefragten Position; 22. eine Operation aus dem Dokument
//   eines Kontakts hat die Form des Journals (`emit` prüft wie `batchProblem`), sonst wird sie nie Zustand.

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
/** Hat das Gerät die Ablehnung von A2 gefaltet (Daten aus Ablage oder Schwester), unabhängig davon, was Regel 2 entscheidet? */
const declineFolded = (d: HolderDevice, act: string) => (M.act(d.state, act).decisions ?? []).some((x) => x.kind === 'decline')

describe('K1a Schritt 6 (Variante): Journal beim Dienst', () => {
  it('Variante als zweiter Kandidateneintrag mit derselben Fabrik und der Prüfstandsoption selfLog', () => {
    const ids = multiDeviceCandidates.map((c) => c.id)
    expect(ids).toEqual(['k0-one-seed', 'k1a-static', 'k1a-journal-service', 'k2-device-keys'])
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

  it('2. Hybrid unter MV-6 neu: A2 verloren und nicht widerrufen; die Ablage bringt die Ablehnung schnell (gefaltet in 2 Runden); keine Sperre: die Karte des Abbilds geht sofort hinaus, die Faltung entscheidet nach Regel 2 für die Zustimmung, A1 verbindet mit der verdeckt gehaltenen Gegenkarte aus der Ablage (sichtbares Restore-Artefakt, konsistent)', async () => {
    const { w, A, B, act } = await restoredCounterRun(false)
    const g0 = A.gatedRounds
    const folded = await w.until(() => !A.logPending && declineFolded(A, act), 5)
    expect(folded).toBe(2) // Leseanfrage in Runde 1, Antwort gelesen und gefaltet in Runde 2
    expect(A.gated).toBe(false)
    expect(a1CardDeposits(A, act)).toBe(1)
    expect(await w.until(() => M.act(A.state, act).state === 'connected' && M.act(B.state, act).state === 'connected', 20)).toBeGreaterThan(0)
    expect(A.witnessPending).toBe(true) // die Schwester antwortet nie; das hält nichts auf
    expect(A.gatedRounds - g0).toBe(0)
    expect(A.state.findings.some((f) => f.includes(act) && f.includes('Regel 2') && f.includes('Zustimmung gilt'))).toBe(true)
  }, 300_000)

  it('3. Hybrid mit erreichbarer Schwester: keine Sperre, die Karte geht in beiden Varianten sofort hinaus; die Daten kommen aus der Ablage (2 Runden), das Zeugnis der Schwester ist nur noch Daten; im Default dasselbe Ergebnis', async () => {
    const { w, A, B, act } = await restoredCounterRun(true)
    const folded = await w.until(() => !A.logPending, 5)
    expect(folded).toBe(2)
    expect(declineFolded(A, act)).toBe(true)
    expect(A.gated).toBe(false)
    expect(a1CardDeposits(A, act)).toBe(1)
    expect(await w.until(() => w.of('A').every((d) => M.act(d.state, act).state === 'connected') && M.act(B.state, act).state === 'connected' && w.agree('A').agree, 20)).toBeGreaterThan(0)
    // Gegenprobe Default (Briefkasten): derselbe Ablauf, dasselbe Ergebnis.
    const mb = await restoredCounterRun(true, () => k1a())
    expect(mb.A.gated).toBe(false)
    expect(await mb.w.until(() => mb.w.of('A').every((d) => M.act(d.state, mb.act).state === 'connected') && M.act(mb.B.state, mb.act).state === 'connected' && mb.w.agree('A').agree, 20)).toBeGreaterThan(0)
    expect(a1CardDeposits(mb.A, mb.act)).toBe(1)
    expect([A.gatedRounds, mb.A.gatedRounds]).toEqual([0, 0])
  }, 300_000)

  for (const mode of ['empty', 'truncated', 'reverse'] as const)
    it(`4. Review 25 B1 (${mode}): eine leere, verkürzte oder umgeordnete Antwort der Ablage faltet keine falschen Daten; keine Sperre (MV-6 neu), die Karte geht hinaus; hält der Dienst alles zurück und ist die Schwester verloren, bleibt die Verbindung bei A offen, bis Daten kommen (benannter Preis, MV-35)`, async () => {
      for (const live of [false, true]) {
        const { w, A, B, act } = await restoredCounterRun(live)
        tamper(w, mode)
        await w.rounds(25)
        expect(A.gated, `live=${live}`).toBe(false)
        expect(a1CardDeposits(A, act), `live=${live}`).toBe(1)
        expect(M.act(B.state, act).state, `live=${live}`).toBe('connected')
        if (live || mode !== 'empty') {
          expect(declineFolded(A, act), `live=${live}`).toBe(true)
          expect(M.act(A.state, act).state, `live=${live}`).toBe('connected')
        } else {
          // Der Dienst hielt alles zurück, die Schwester ist verloren: A1 kennt weder die Ablehnung noch Bs Gegenkarte.
          expect(declineFolded(A, act)).toBe(false)
          expect(M.act(A.state, act).state).toBe('consented')
        }
      }
    }, 300_000)

  it('5. Review 25 B2: beschädigte Einträge zählen nie als gefaltet; Befund journal:corrupt-entry je Position, der Cursor bleibt davor, erneut mit Backoff; keine Sperre (MV-6 neu); heil gelesen geht es weiter', async () => {
    const { w, A, B, act } = await restoredCounterRun(false)
    const heal = tamper(w, 'corrupt')
    const r0 = A.logRequests
    await w.rounds(20)
    expect(A.logPending).toBe(true)
    expect(A.snapshotState().logCursor).toBe(0)
    expect(A.logCorrupt).toBeGreaterThan(0)
    expect(A.dispositions.filter((d) => d.startsWith('finding(journal:corrupt-entry@')).length).toBe(A.logCorrupt) // je Position einmal
    expect(A.logRequests - r0).toBeLessThanOrEqual(5) // Backoff 1, 2, 4, 8 statt jede Runde
    expect(A.gated).toBe(false)
    expect(a1CardDeposits(A, act)).toBe(1)
    expect(declineFolded(A, act)).toBe(false) // nichts aus der beschädigten Antwort gefaltet
    heal()
    expect(await w.until(() => !A.logPending, 20)).toBeGreaterThan(0)
    expect(declineFolded(A, act)).toBe(true)
    expect(await w.until(() => M.act(A.state, act).state === 'connected' && M.act(B.state, act).state === 'connected', 20)).toBeGreaterThan(0)
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

  it('6. Restore mit verlorener Schwester und gültiger Karte: gefaltet und einig nach 2 Runden; keine Sperre (MV-6 neu), die Karte geht sofort hinaus, ohne Widerruf; im Default dasselbe', async () => {
    const { w, A, B, act } = await restoredWithLostSibling()
    expect(await w.until(() => !A.logPending, 5)).toBe(2)
    expect(await w.until(() => a1CardDeposits(A, act) === 1 && M.act(B.state, act).state === 'connected', 20)).toBeGreaterThan(0)
    expect(A.gatedRounds).toBe(0)
    const mb = await restoredWithLostSibling(() => k1a())
    expect(await mb.w.until(() => a1CardDeposits(mb.A, mb.act) === 1 && M.act(mb.B.state, mb.act).state === 'connected', 20)).toBeGreaterThan(0)
    expect(mb.A.gatedRounds).toBe(0)
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
    expect(A.gated).toBe(false)
    void act
    expect(await w.until(() => !A.logPending, 5)).toBeGreaterThan(0)
  }, 300_000)

  it('8. Träger unerreichbar: Leseanfragen mit Backoff, nichts kommt an; danach gefaltet; keine Sperre (MV-6 neu), die Karte geht hinaus, sobald der Träger erreichbar ist', async () => {
    const { w, A, act } = await restoredWithLostSibling()
    w.carrier.unreachable = true
    await w.rounds(6)
    expect(A.logPending).toBe(true)
    expect(A.logRequests).toBeLessThanOrEqual(3) // 1, 2, 4
    expect(a1CardDeposits(A, act)).toBe(0) // der Träger nimmt nichts an
    w.carrier.unreachable = false
    expect(await w.until(() => !A.logPending, 20)).toBeGreaterThan(0)
    expect(A.gated).toBe(false)
    expect(await w.until(() => a1CardDeposits(A, act) === 1, 20)).toBeGreaterThan(0)
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
  const TAG = 'AAAAAAAAAAAAAAAA' // Schreiberkennung in Prüfstandsform (16 Zeichen base64url)
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
    // Review 28: reservierte Namen als Schlüssel und als Kennungen, die Schlüssel werden, in jeder Tiefe (Astras Probe zuerst).
    ['view.clears: {"constructor": 1}', batch({ ops: [xop({ kind: 'view', rel, scope: 's', revision: 1, keys: [], writer: TAG, clears: { constructor: 1 } })] })],
    ['view.clears: {"__proto__": 1}', batch({ ops: [xop({ kind: 'view', rel, scope: 's', revision: 1, keys: [], writer: TAG, clears: { ['__proto__']: 1 } })] })],
    ['view.clears: {"toString": 1}', batch({ ops: [xop({ kind: 'view', rel, scope: 's', revision: 1, keys: [], writer: TAG, clears: { toString: 1 } })] })],
    ['view.writer: "constructor"', batch({ ops: [xop({ kind: 'view', rel, scope: 's', revision: 1, keys: [], writer: 'constructor' })] })],
    ['view mit writers: {"__proto__": …}', batch({ ops: [xop({ kind: 'view', rel, scope: 's', revision: 1, keys: [], writer: TAG, writers: { ['__proto__']: { revision: 9, keys: [] } } })] })],
    ['revision.writer: "__proto__"', batch({ ops: [xop({ kind: 'revision', rel, revision: 1, keys: [], writer: '__proto__' })] })],
    ['Alias-Schlüssel "constructor" (union)', batch({ ops: [xop({ kind: 'union', a: 'constructor', b: rel, edge: ['constructor', rel] })] })],
    ['rel: "constructor"', batch({ ops: [xop({ kind: 'class', rel: 'constructor', on: true })] })],
    ['cards: {"prototype": …}', batch({ ops: [xop({ kind: 'ticket-accept', act: { ...ACT, cards: { prototype: 'handed' } } })] })],
    ['hand-over.digest: "prototype"', batch({ ops: [xop({ kind: 'hand-over', act: 'act', o: 'handed', digest: 'prototype' })] })],
    ['voucher mit "__proto__"', batch({ ops: [xop({ kind: 'ticket-accept', act: { ...ACT, voucher: { ...ACT.voucher, ['__proto__']: { name: 'x' } } } })] })],
    ['Akt-Id "hasOwnProperty"', batch({ ops: [xop({ kind: 'ticket-accept', act: { ...ACT, id: 'hasOwnProperty' } })] })],
    ['deps mit "__proto__"-Schreiber', batch({ deps: ['__proto__@feed#1'] })],
    ['deps mit "constructor"', batch({ deps: ['constructor'] })],
    ['Batch-Schreiber "constructor"', batch({ writer: 'constructor' })],
    ['Op-Schreiber "__proto__"', batch({ ops: [{ ...xop({ kind: 'finding', text: 'x' }), id: { writer: '__proto__', n: 1 } }] })],
    ['Intent-Gerät "constructor"', batch({ intents: [{ ...INTENT, device: 'constructor' }] })],
    ['Batch mit "__proto__"-Feld', batch({ ['__proto__']: { n: 99 } })],
  ]

  it('13. Review 26 B2, Ablage: kaputte Form oder werfende Faltung ist ein Befund je Position, kein Abbruch; der Cursor bleibt, Backoff; der gültige Eintrag dahinter wird nicht gefaltet, solange der kaputte blockiert (keine Sperre, MV-6 neu)', async () => {
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
      expect(declineFolded(A, act), what).toBe(false) // die Ablehnung dahinter ist nicht gefaltet (Blockieren)
      expect(Object.keys(A.cand.heads!()).some((k) => k.startsWith('X@')), what).toBe(false) // nichts vom kaputten Batch im Journal
      expect(A.state.relationships.every((r) => Number.isInteger(r.nextN) && r.stock.every((k) => typeof k.anchor === 'string')), what).toBe(true)
      expect(A.state.relationships.every((r) => !r.view || r.view.keys.every((k) => typeof k === 'object' && k !== null)), what).toBe(true)
      expect(A.state.relationships.every((r) => Number.isFinite(r.view?.revision ?? 0) && Object.values(r.view?.clears ?? {}).every(Number.isFinite)), what).toBe(true) // Review 28: nie NaN
      expect(A.gated, what).toBe(false)
      expect(a1CardDeposits(A, act), what).toBe(1)
      ins.heal()
      expect(await w.until(() => !A.logPending, 20), what).toBeGreaterThan(0)
      expect(declineFolded(A, act), what).toBe(true)
      expect(M.act(B.state, act).state, what).toBe('connected')
    }
  }, 900_000)

  it('14. Review 26 B2, Briefkasten (Default-K1a): derselbe kaputte Rahmen ist ein Befund je Digest, keine Quittung, keine Wirkung; die Runde läuft weiter und spätere Rahmen falten; nach Restore ändert er nichts (keine Sperre, MV-6 neu)', async () => {
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
    // Restore mit verlorener Schwester: der kaputte Rahmen ist ein Befund und hält nichts auf.
    const q = await restoredWithLostSibling(() => k1a())
    const f = await selfFrame(q.w, q.A, batch({ ops: null }))
    q.w.carrier.deposit(f.rkid, f.bytes)
    await q.w.rounds(10)
    expect(q.A.frameCorrupt).toBe(1)
    expect(q.A.gated).toBe(false)
    expect(a1CardDeposits(q.A, q.act)).toBe(1)
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
      xop({ kind: 'view', rel: 'r', scope: 's', revision: 0, keys: [{ n: 1, anchor: 'a', keyAgreement: 'k', expiresAt: T0 }], writer: TAG, clears: { [TAG]: 2 } }),
      xop({ kind: 'ticket-accept', act: ACT }),
      xop({ kind: 'ticket-accept', act: { ...ACT, pending: CARD, decisions: [{ kind: 'consent', op: 'o', at: T0 }], cards: { [INTENT.digest]: 'handed' }, consentOp: 'o' } }),
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
      xop({ kind: 'view', rel: 'r', scope: 's', revision: 1, keys: [], clears: { [TAG]: 'x' } }),
      xop({ kind: 'view', rel: 'r', scope: 's', revision: 1, keys: [], clears: { w: 1 } }), // Review 28: Schlüssel keine Schreiberkennung
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
        expect(declineFolded(A, act)).toBe(false)
        ins.heal()
        expect(await w.until(() => !A.logPending, 20)).toBeGreaterThan(0)
        expect(declineFolded(A, act)).toBe(true)
      } else {
        expect(A.logCorrupt).toBe(0)
        expect(A.logPending).toBe(false) // eine Antwort, ein Schritt
        expect(A.state.findings).toEqual(expect.arrayContaining(['BOOM', 'P1', 'MARKER']))
        expect(declineFolded(A, act)).toBe(true)
      }
    }
  }, 600_000)

  // ── Review 28 (Klasse): ein String aus dem Journal traf als Schlüssel eines einfachen Objekts eine geerbte Eigenschaft
  // (`clears: {"constructor": 1}` → NaN im Zustand). Jetzt: Schlüsseltabellen ohne Prototyp, Lesen nur über eigene
  // Eigenschaften (model.ts `table`/`own`/`put`/`fromJson`), und die Formtabelle weist reservierte Namen und Kennungen
  // außerhalb ihrer Grammatik ab (`RESERVED`, `GRAMMAR`).
  const RES = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__']
  /** Kleiner Zufall mit Saat (mulberry32), damit der Eigenschaftstest wiederholbar ist. */
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const TUPLE28 = { id: 't', own: 'o', ownKey: 'ok', peer: 'p', peerKeyAgreement: 'pk', record: 'r', openedAt: T0, candidates: ['c'], deactivated: false }
  const ACT28 = { ...ACT, mediator: 't' }
  const GOOD28 = () => [
    xop({ kind: 'open-tuple', rel: null, tuple: TUPLE28, provenance: 'encounter', vouchedBy: null, act: null }),
    xop({ kind: 'allocate', rel: 't', nonce: 'AA==', keys: [SKEY] }),
    xop({ kind: 'view', rel: 't', scope: 't', revision: 1, keys: [{ n: 1, anchor: 'a', keyAgreement: 'k', expiresAt: T0 }], writer: TAG, clears: { [TAG]: 0 } }),
    xop({ kind: 'revision', rel: 't', revision: 1, keys: [{ n: 1, anchor: 'a', keyAgreement: 'k', expiresAt: T0 }], writer: TAG }),
    xop({ kind: 'ticket-accept', act: { ...ACT28, decisions: [{ kind: 'consent', op: 'o', at: T0 }], cards: { [INTENT.digest]: 'handed' }, consentOp: 'o' } }),
    xop({ kind: 'introduce', act: { id: 'm', a: { rel: 't', key: 'k', keyAgreement: 'ka' }, b: { rel: 't', key: 'k2', keyAgreement: 'kb' }, issuedAt: T0, expiresAt: T0 } }),
    xop({ kind: 'hand-over', act: 'act', o: 'handed', digest: INTENT.digest }),
    xop({ kind: 'duty', pair: ['a', 'b'], state: 'hit', mappingDigest: null }),
    xop({ kind: 'union', a: 't', b: 'u', edge: ['t', 'u'] }),
    xop({ kind: 'budget-confirm', rel: 't', acts: ['act'] }),
  ]
  /** Alle Objekte (Knoten) eines JSON-Werts mit ihren Pfaden, und alle String-Blätter. */
  function nodes(v: unknown, objs: Array<Record<string, unknown>> = [], leaves: Array<[Record<string, unknown> | unknown[], string | number]> = []) {
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'string' ? leaves.push([v, i]) : nodes(x, objs, leaves)))
    else if (v && typeof v === 'object') {
      objs.push(v as Record<string, unknown>)
      for (const [k, x] of Object.entries(v)) if (typeof x === 'string') leaves.push([v as Record<string, unknown>, k])
      else nodes(x, objs, leaves)
    }
    return { objs, leaves }
  }
  /** Freitext, der nie Schlüssel oder Kennung wird (bleibt beim Ersetzen aus). */
  const FREE = new Set(['text', 'name', 'v'])
  /** Ein gültiger Op mit einem reservierten Namen an einer zufälligen Stelle: als Schlüssel eines beliebigen Objekts oder als Wert eines Kennungsfelds. */
  function poisoned(r: () => number) {
    const ops = GOOD28()
    const op = JSON.parse(JSON.stringify(ops[Math.floor(r() * ops.length)])) as Record<string, unknown>
    const name = RES[Math.floor(r() * RES.length)]!
    const { objs, leaves } = nodes(op)
    const ids = leaves.filter(([o, k]) => !(typeof k === 'string' && FREE.has(k)) && !(Array.isArray(o) === false && k === 'kind' && o === op))
    if (r() < 0.5 || !ids.length) {
      const o = objs[Math.floor(r() * objs.length)]!
      Object.defineProperty(o, name, { value: r() < 0.5 ? 1 : { revision: 1, keys: [] }, enumerable: true, writable: true, configurable: true })
    } else {
      const [o, k] = ids[Math.floor(r() * ids.length)]!
      ;(o as Record<string | number, unknown>)[k] = name
    }
    return { op: JSON.parse(JSON.stringify(op)) as unknown, name }
  }

  it('18. Review 28: Schlüsseltabellen ohne Prototyp (die Faltung liest nur eigene Eigenschaften, auch ohne Formprüfung), Kennungsgrammatik, Eigenschaftstest', () => {
    // a) Bauart: die Faltung selbst, an der Formprüfung vorbei (JSON wie aus dem Journal).
    const s = M.emptyState('M')
    expect(Object.getPrototypeOf(s.aliases)).toBeNull()
    for (const o of GOOD28().slice(0, 1)) M.apply(s, o as M.Op)
    expect(M.resolveId(s, 'constructor')).toBe('constructor') // nie die geerbte Funktion
    expect(M.findRel(s, 'toString')).toBeUndefined()
    const view = JSON.parse(`{"id":{"writer":"X@feed","n":2},"at":"${T0}","kind":"view","rel":"t","scope":"t","revision":1,"keys":[],"writer":"${TAG}","clears":{"constructor":1,"__proto__":2,"${TAG}":0}}`) as M.Op
    M.apply(s, view)
    const r = s.relationships[0]!
    expect(Object.getPrototypeOf(r.view!.clears)).toBeNull()
    expect(Object.getPrototypeOf(r.view!.writers)).toBeNull()
    expect(M.own(r.view!.clears, 'constructor')).toBe(1)
    expect(M.own(r.view!.clears, '__proto__')).toBe(2)
    expect(Object.values(r.view!.clears!).every(Number.isFinite)).toBe(true)
    expect(Number.isFinite(r.view!.revision)).toBe(true)
    M.apply(s, JSON.parse(`{"id":{"writer":"X@feed","n":3},"at":"${T0}","kind":"view","rel":"t","scope":"t","revision":2,"keys":[],"writer":"constructor"}`) as M.Op)
    expect(M.own(r.view!.writers, 'constructor')).toBeUndefined() // r ist der alte Entwurf; der Zustand hat die neue Beziehung
    const r2 = s.relationships[0]!
    expect(M.own(r2.view!.writers, 'constructor')?.revision).toBe(2)
    expect(r2.view!.revision).toBe(2)
    M.apply(s, JSON.parse(`{"id":{"writer":"X@feed","n":4},"at":"${T0}","kind":"revision","rel":"t","revision":1,"keys":[],"writer":"__proto__"}`) as M.Op)
    expect(Object.getPrototypeOf(s.relationships[0]!.writers)).toBeNull()
    expect(M.own(s.relationships[0]!.writers, '__proto__')?.revision).toBe(1)
    M.apply(s, xop({ id: { writer: X, n: 5 }, kind: 'ticket-accept', act: ACT28 }) as M.Op)
    M.apply(s, JSON.parse(`{"id":{"writer":"X@feed","n":6},"at":"${T0}","kind":"hand-over","act":"act","o":"handed","digest":"__proto__"}`) as M.Op)
    const a = M.act(s, 'act')
    expect(Object.getPrototypeOf(a.cards)).toBeNull()
    expect(M.own(a.cards, '__proto__')).toBe('handed')
    expect(a.o).toBe('handed')
    expect(() => M.canonical(M.project(s, T0))).not.toThrow()
    // b) Grammatik der Kennungen.
    for (const n of RES) {
      for (const g of ['ident', 'tag', 'writer', 'opWriter', 'dep'] as const) expect(M.shapeProblem(n, g, 'k'), `${g}:${n}`).not.toBeNull()
      expect(M.shapeProblem({ [n]: 1 }, { record: 'nat' }, 'k'), n).not.toBeNull()
      expect(M.shapeProblem(JSON.parse(`{"${n}":1}`), { record: 'nat', key: 'writer' }, 'k'), n).not.toBeNull()
    }
    for (const [g, ok, bad] of [
      ['tag', TAG, ['AAAA', 'AAAAAAAAAAAAAAA=', 'AAAAAAAAAAAAAAA/']],
      ['writer', 'A1@3f2a9c01', ['A1', '@x', 'A1@x@y', 'A 1@x']],
      ['opWriter', 'A1@x#conflict', ['A1@x#other']],
      ['dep', 'A1@x#12', ['A1@x', 'A1@x#0', 'A1@x#-1']],
      ['ident', 'introduction/AA+/=/3', ['', '_x', 'a b', 'x'.repeat(513)]],
    ] as const) {
      expect(M.shapeProblem(ok, g, 'k'), `${g}:${ok}`).toBeNull()
      for (const b of bad) expect(M.shapeProblem(b, g, 'k'), `${g}:${b}`).not.toBeNull()
    }
    // c) Eigenschaft: jeder gültige Op, vergiftet mit einem reservierten Namen an zufälliger Stelle (Schlüssel in jeder
    // Tiefe oder Kennungswert), wird abgewiesen; die Projektion einer Faltung mit Formprüfung bleibt dieselbe.
    for (const o of GOOD28()) expect(M.opProblem(o), JSON.stringify(o)).toBeNull()
    const r0 = rng(28)
    const base = M.emptyState('A')
    for (const o of GOOD28().slice(0, 5)) M.apply(base, o as M.Op)
    const before = M.canonical(M.project(base, T0))
    for (let i = 0; i < 400; i++) {
      const { op } = poisoned(r0)
      expect(M.opProblem(op), JSON.stringify(op)).not.toBeNull()
      expect(batchProblem({ writer: X, n: 1, deps: [], ops: [op], intents: [] }), JSON.stringify(op)).not.toBeNull()
      const st = M.cloneState(base)
      if (!M.opProblem(op)) M.apply(st, op as M.Op)
      expect(M.canonical(M.project(st, T0))).toBe(before)
    }
  })

  it('19. Review 28, Briefkasten: zufällig vergiftete, gültig self-signierte Rahmen ändern weder Projektion noch Kopf; jeder ist ein Befund', async () => {
    const { w, A, A2 } = await withA2(() => k1a())
    const r0 = rng(2828)
    for (let i = 0; i < 12; i++) {
      const { op } = poisoned(r0)
      const f = await selfFrame(w, A2, batch({ n: 1 + i, ops: [op] }))
      w.carrier.deposit(f.rkid, f.bytes)
      const before = M.canonical(A.projection())
      const headsBefore = JSON.stringify(A.cand.heads!())
      await w.rounds(1)
      expect(A.dispositions.filter((d) => d === `finding(journal:corrupt-frame@${f.digest})`).length, JSON.stringify(op)).toBe(1)
      expect(M.canonical(A.projection()), JSON.stringify(op)).toBe(before)
      expect(JSON.stringify(A.cand.heads!())).toBe(headsBefore)
    }
  }, 300_000)

  it('20. Review 28: das Store-Abbild behält die Tabellen; nach reload() sind sie wieder ohne Prototyp, Projektion und Köpfe gleich', async () => {
    const { w, A, A2, Mm, act } = await withA2(() => k1a())
    expect(await A.consent(act)).toBe('ok')
    await w.rounds(4)
    const tables = (d: HolderDevice) => [
      d.state.aliases,
      ...d.state.relationships.flatMap((r) => [r.writers, r.view?.writers, r.view?.clears]),
      ...d.state.acts.map((a) => a.cards),
    ].filter((t) => t !== undefined)
    expect(tables(Mm).length).toBeGreaterThan(1) // Ms Sicht mit Schreibern und Aufhebungsmarken
    expect(A.state.acts.some((a) => a.cards)).toBe(true) // Übergaben je Digest
    for (const d of [A, A2, Mm]) {
      const proj = M.canonical(d.projection())
      const heads = M.canonical(d.cand.heads?.() ?? {})
      d.commit()
      await d.reload()
      expect(tables(d).every((t) => Object.getPrototypeOf(t) === null), d.name).toBe(true)
      expect(Object.getPrototypeOf(d.cand.heads?.() ?? Object.create(null))).toBeNull()
      expect(M.canonical(d.projection()), d.name).toBe(proj)
      expect(M.canonical(d.cand.heads?.() ?? {}), d.name).toBe(heads)
    }
    await w.rounds(4)
    expect(states(w, act).every((x) => x.startsWith('consented/'))).toBe(true)
  }, 300_000)

  it('21. CodeRabbit #71: die Antwort der Ablage gilt nur ab der angefragten Position; ein Träger, der ein späteres `from` meldet, bewegt den Cursor nicht und beendet die Ablagespur nicht', async () => {
    const { w, A } = await restoredWithLostSibling()
    const take = w.carrier.takeLogAnswers.bind(w.carrier)
    w.carrier.takeLogAnswers = (name) => take(name).map((a) => (name === 'A1' ? { ...a, from: a.end + 3, end: a.end + 3, entries: [] } : a))
    const cursor = A.snapshotState().logCursor
    const stale = A.staleSyncAnswers
    await w.rounds(3)
    expect(A.staleSyncAnswers).toBeGreaterThan(stale)
    expect(A.snapshotState().logCursor).toBe(cursor)
    expect(A.logPending).toBe(true)
    let end = -1
    w.carrier.takeLogAnswers = (name) => take(name).map((a) => (name === 'A1' && (end = a.end), a))
    expect(await w.until(() => !A.logPending, 5)).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(cursor!)
    expect(A.snapshotState().logCursor).toBe(end) // heil gelesen: bis zum Ende der echten Antwort
  }, 300_000)

  it('22. CodeRabbit #71: eine Operation aus dem Dokument eines Kontakts mit kaputter Form (Ticket mit voucher.name als Zahl) wird nie Zustand: zurückgenommen, keine Quittung, die Schwester divergiert nicht', async () => {
    const p = await pair(() => k1a())
    const A2 = await p.w.enrol(p.A, 'A2')
    await p.w.rounds(3)
    const r = await p.Mm.introduce(p.am.y.id, p.bm.y.id, 'A', 42 as unknown as string) // das Ticket an A trägt nameB
    if (!('act' in r)) throw new Error(r.refused)
    await p.w.until(() => p.B.state.acts.some((a) => a.id === r.act))
    await p.w.rounds(4)
    expect(p.A.dispositions.some((d) => d.startsWith('failed(invalid-input): ticket-accept: op.ticket-accept.act.voucher.name'))).toBe(true)
    for (const d of [p.A, A2]) {
      expect(d.state.acts.some((a) => a.id === r.act), d.name).toBe(false)
      expect(d.dispositions.filter((x) => x.includes('corrupt')), d.name).toEqual([])
    }
    expect(M.canonical(A2.projection())).toBe(M.canonical(p.A.projection()))
    expect(M.canonical(A2.cand.heads!())).toBe(M.canonical(p.A.cand.heads!()))
  }, 300_000)
})

describe('Tor-Review 40 B2: das Enrollment aus der Ablage überlebt ein Neuladen mitten in der Zeremonie', () => {
  const relsTo = (w: Welt15, d: HolderDevice, other: string) => d.state.relationships.filter((r) => !r.departed && r.tuples.some((t) => w.personOf(t.peer) === other))
  const isProbeOf = (w: Welt15, person: string) => (f: { bytes: Uint8Array }) => {
    const o = w.frameOrigin(f.bytes)
    return o?.kind === 'continuity-probe' && w.of(person).some((d) => d.name === o.device)
  }
  // Astras Ablauf: A2 behält Bs Probe auf dem zweiten Tupel, A3 wird aus A2 über die Ablage eingeschrieben (die Probe
  // reist als `deferredProbes` mit der Zeremonie), A2 geht offline. Ohne Neuladen vereinigt A3; mit sofortigem Neuladen
  // muss die Zeremonie (das Warten auf das Zeugnis, `owed`, `deferredProbes`) aus dem Abbild weiterlaufen.
  async function flow(reload: boolean) {
    const w = new Welt15(k1a({ journalAtService: true, devices: 3 }))
    const A = await w.person('A', 'A1')
    const B = await w.person('B', 'B1')
    const Mm = await w.person('M', 'M1')
    await w.encounter(A, Mm)
    await w.encounter(B, Mm)
    await w.rounds(2)
    const A2 = await w.enrol(A, 'A2')
    await w.until(() => !A2.gated, 10)
    await w.rounds(2)
    const selfA = (await A.cand.keys.pair('self/A')).rkid
    w.carrier.faults.drop(isProbeOf(w, 'A'))
    for (const d of w.of('A')) w.carrier.faults.withhold(d.name, (f) => f.address === selfA)
    await w.encounter(A, B)
    const second = await w.encounter(A2, B)
    await w.rounds(3)
    expect(A2.keptProbes().get(second.x.id), 'A2 behält Bs Probe auf dem zweiten Tupel').toHaveLength(2)
    w.carrier.faults.reset()
    w.carrier.faults.drop(isProbeOf(w, 'A'))
    const A3 = await w.enrol(A2, 'A3')
    expect(A3.gated, 'Zeremonie läuft').toBe(true)
    A2.online = false
    if (reload) {
      await A3.reload()
      expect(A3.gated, 'die Zeremonie überlebt das Neuladen').toBe(true)
    }
    for (let i = 0; i < 35 && !(relsTo(w, A, 'B').length === 1 && relsTo(w, A3, 'B').length === 1 && relsTo(w, B, 'A').length === 1); i++) await w.rounds(1)
    return { w, A, A3, B }
  }
  for (const reload of [false, true]) {
    it(`B2 ${reload ? 'mit Neuladen' : 'ohne Neuladen (Kontrolle)'}: A3 übernimmt die Probe der Zeremonie und vereinigt; nach der Heilung je eine Beziehung bei A1, A3 und B`, async () => {
      const { w, A, A3, B } = await flow(reload)
      expect(A3.gated).toBe(false)
      expect(A3.syncPending).toBe(false)
      for (const d of [A, A3]) expect(relsTo(w, d, 'B').map((r) => r.tuples.length), d.name).toEqual([2])
      expect(relsTo(w, B, 'A').map((r) => r.tuples.length), 'B1').toEqual([2])
    }, 180_000)
  }
})
