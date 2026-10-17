// E15 Mehrgerät: Szenarien X1–X23 (Plan Abschnitt 4). Jedes Szenario läuft
// gegen jeden Kandidaten; `serial` lässt nur ein Gerät je Person handeln
// (Kontrolllauf: so muss auch K0 bestehen, sonst stimmt der Prüfstand nicht).
// Ergebnis je Zelle ✓/✗/– wie in der Konformitätsmatrix, dazu Messgrößen
// (Abschnitt 5) aus dem Effekt-Ledger (model.ts, Tor-Review 2 B5):
// doppelte endgültige Wirkungen, Widersprüche, Doppel in der Liste,
// Budgetüberschreitung als Maximum im Verlauf, blockierte Operationen,
// Runden bis zur stabilen Konvergenz, Verkehr. Eine Messung, die ein
// Szenario nicht erhebt, fehlt im Ergebnis (nie 0).

import type { Outcome } from '../types'
import { HolderDevice, type MultiDeviceCandidate } from './holder'
import * as M from './model'
import { Welt15 } from './welt'

export interface X15Result {
  scenario: string
  title: string
  outcome: Outcome
  detail: string
  measures: Record<string, number | string>
  /** Plan Abschnitt 4: ein ✓ unter einer Ersatzregel (K3) ist „Zusage geändert“, nie Erfüllung der alten. */
  promiseChanged?: boolean
  /** Das Szenario ist mit einer Ausnahme abgebrochen: kein gemessener Verstoß, ein Fehler im Prüfstand oder Kandidaten. */
  crashed?: boolean
}

type Body = Omit<X15Result, 'scenario' | 'title'>

interface Setup {
  w: Welt15
  A: HolderDevice
  A2: HolderDevice
  B: HolderDevice
  B2: HolderDevice
  Mm: HolderDevice
  M2: HolderDevice
  /** Beziehungs-Ids: Seite → M und M → Seite. */
  am: string
  ma: string
  bm: string
  mb: string
  thirds: Record<string, { C: HolderDevice; cm: string; mc: string }>
}

/**
 * Gemeinsame Welt: A, B, M mit je zwei Geräten; Begegnungen A–M und B–M,
 * Klasse an, Vorrat bei M; weitere Gegenpersonen; dann Enrollment der
 * zweiten Geräte (sie starten mit dem Stand des ersten). Im seriellen Lauf
 * gibt es die zweiten Geräte nicht.
 */
async function setup(candidate: MultiDeviceCandidate, serial: boolean, thirds: string[] = []): Promise<Setup> {
  const w = new Welt15(candidate)
  const A = await w.person('A', 'A1')
  const B = await w.person('B', 'B1')
  const Mm = await w.person('M', 'M1')
  const am = await w.encounter(A, Mm)
  const bm = await w.encounter(B, Mm)
  await w.rounds(2)
  await A.setClass(am.x.id, true)
  await B.setClass(bm.x.id, true)
  await w.rounds(3)
  const base: Setup = { w, A, A2: A, B, B2: B, Mm, M2: Mm, am: am.x.id, ma: am.y.id, bm: bm.x.id, mb: bm.y.id, thirds: {} }
  for (const name of thirds) base.thirds[name] = await third(base, name)
  const A2 = serial ? A : await w.enrol(A, 'A2')
  const B2 = serial ? B : await w.enrol(B, 'B2')
  const M2 = serial ? Mm : await w.enrol(Mm, 'M2')
  await w.rounds(2)
  return { ...base, A2, B2, M2 }
}

/** Eine weitere Gegenperson C mit Beziehung zu M (ein Gerät). */
async function third(s: Setup, name: string): Promise<{ C: HolderDevice; cm: string; mc: string }> {
  const C = await s.w.person(name, `${name}1`)
  const cm = await s.w.encounter(C, s.Mm)
  await s.w.rounds(1)
  await C.setClass(cm.x.id, true)
  await s.w.rounds(3)
  return { C, cm: cm.x.id, mc: cm.y.id }
}

const mark = (ok: boolean): Outcome => (ok ? 'bestanden' : 'nicht bestanden')
const na = (detail: string): Body => ({ outcome: 'nicht abbildbar', detail, measures: {} })
const fail = (detail: string): Body => ({ outcome: 'nicht bestanden', detail, measures: {} })

// ── Messungen aus dem Effekt-Ledger ─────────────────────────────────────────

/** Alle Effekte einer Person über ihre Geräte, je Effekt-Id die Menge der erzeugenden Operationen. */
function ledger(w: Welt15, person: string): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>()
  for (const d of w.of(person)) for (const e of d.state.effects) {
    if (!m.has(e.id)) m.set(e.id, new Set())
    m.get(e.id)!.add(e.op)
  }
  return m
}

/** Doppelte endgültige Wirkungen (B5): dieselbe Effekt-Id aus mehr als einer Operation, ein Vorrats-Schlüssel in mehr als einem Akt, Zustimmung und Ablehnung desselben Akts. */
function finalEffects(w: Welt15, person: string) {
  const l = ledger(w, person)
  const doubles = [...l.entries()].filter(([, ops]) => ops.size > 1).map(([id]) => id)
  const keyActs = new Map<string, Set<string>>()
  for (const id of l.keys()) {
    const m = /^ticket:([^:]+):(.+)$/.exec(id)
    if (!m) continue
    if (!keyActs.has(m[2]!)) keyActs.set(m[2]!, new Set())
    keyActs.get(m[2]!)!.add(m[1]!)
  }
  const doubleConsumption = [...keyActs.values()].filter((s) => s.size > 1).length
  const contradictions = [...l.keys()].filter((id) => id.startsWith('decline:') && l.has(`consent:${id.slice(8)}`)).length
  return { doubles: doubles.length, doubleConsumption, contradictions, total: doubles.length + doubleConsumption + contradictions }
}

/** Angenommene Akte einer Person über alle Geräte (verschiedene Akt-Ids). */
function acceptedActs(w: Welt15, person: string): Set<string> {
  const ids = new Set<string>()
  for (const d of w.of(person)) for (const a of d.state.acts) ids.add(a.id)
  return ids
}

const blocked = (w: Welt15, person: string) => w.of(person).reduce((n, d) => n + d.measures.blocked, 0)

/**
 * Runden, bis die Geräte einer Person gleich UND die Projektion drei Runden lang unverändert ist (stabile
 * Konvergenz, B5: gegenseitige Gleichheit allein ist keine Stabilität); Ergebnis = erste Runde der stabilen
 * Strecke, −1 bei Grenze.
 */
async function untilStable(w: Welt15, person: string, max = 20): Promise<number> {
  let stable = 0
  let last: string | null = null
  for (let i = 1; i <= max; i++) {
    await w.rounds(1)
    const cur = M.canonical(w.of(person)[0]?.projection() ?? null)
    stable = w.agree(person).agree && cur === last ? stable + 1 : 0
    last = cur
    if (stable >= 2) return i - 2
  }
  return -1
}

/** Beziehungen eines Geräts zu einer Gegenperson: Einträge und Tupel je Eintrag (B5: je Gerät geprüft). */
function relationshipsTo(w: Welt15, d: HolderDevice, other: string): { entries: number; tuples: number } {
  const rs = d.state.relationships.filter((r) => !r.departed && r.tuples.some((t) => w.personOf(t.peer) === other))
  return { entries: rs.length, tuples: Math.max(0, ...rs.map((r) => r.tuples.length)) }
}
/** Verschiedene Einträge einer Person zu einer Gegenperson über alle Geräte (Tupelmenge): mehr als einer ist ein Doppel (I-6). */
function entriesAcross(w: Welt15, person: string, other: string): number {
  const keys = new Set<string>()
  for (const d of w.of(person)) for (const r of d.state.relationships) if (!r.departed && r.tuples.some((t) => w.personOf(t.peer) === other)) keys.add(r.tuples.map((t) => t.id).sort().join('+'))
  return keys.size
}

// ── Szenarien ────────────────────────────────────────────────────────────────

export const x15: Array<{ id: string; title: string; run: (c: MultiDeviceCandidate, serial: boolean) => Promise<Body> }> = [
  {
    id: 'X1',
    title: 'M1 und M2 wählen offline denselben Vorrats-Schlüssel von A für zwei Vorstellungen (Einmalverbrauch 8570.1)',
    async run(c, serial) {
      const s = await setup(c, serial, ['C'])
      const { mc } = s.thirds.C!
      s.Mm.online = false
      s.M2.online = false
      const r1 = await s.Mm.introduce(s.ma, s.mb)
      const r2 = await s.M2.introduce(s.ma, mc)
      s.Mm.online = true
      s.M2.online = true
      await s.w.rounds(6)
      // Fortschritt nach der Heilung: eine offline blockierte Vorstellung darf jetzt gelingen (B1).
      const retry = 'act' in r2 ? r2 : await s.M2.introduce(s.ma, mc)
      await s.w.rounds(4)
      const fe = finalEffects(s.w, 'M')
      const conformance = s.w.of('A').flatMap((d) => d.state.findings).filter((f) => f.includes('8640.12')).length
      const progress = ['act' in r1, 'act' in retry].filter(Boolean).length
      const ok = fe.doubleConsumption === 0 && conformance === 0
      return { outcome: mark(ok), detail: `offline ausgestellt: ${['act' in r1, 'act' in r2].filter(Boolean).length} von 2, blockiert: ${blocked(s.w, 'M')}; nach der Heilung gelungen: ${progress} von 2; doppelt benannte Schlüssel bei M: ${fe.doubleConsumption}; Konformitätsfehler bei A: ${conformance}`, measures: { doubleFinalEffects: fe.doubleConsumption, mediatorConformanceFailures: conformance, blockedOperations: blocked(s.w, 'M'), progressAfterHeal: progress } }
    },
  },
  {
    id: 'X2',
    title: 'Budget bei 9; A1 und A2 nehmen getrennt je ein zehntes Ticket an (harte Grenze 8510)',
    async run(c, serial) {
      const s = await setup(c, serial)
      const cs: string[] = []
      for (let i = 0; i < 11; i++) cs.push((await third(s, `C${i}`)).mc)
      await s.w.rounds(2)
      let overrun = 0
      const sample = () => (overrun = Math.max(overrun, acceptedActs(s.w, 'A').size - M.PARAM.budget))
      // Maximum nach jedem Geräteübergang (S2).
      const rounds = (n: number) => s.w.rounds(n, sample)
      for (let i = 0; i < 9; i++) {
        // Autorisierter Pfad (B6): darf M1 keinen Schlüssel benennen (K1a teilt sie), stellt M2 vor.
        const r = await s.Mm.introduce(s.ma, cs[i]!)
        if (!('act' in r) && !serial) await s.M2.introduce(s.ma, cs[i]!)
        await rounds(3)
      }
      const before = acceptedActs(s.w, 'A').size
      const rkidA = (await s.A.cand.keys.pair(M.head(M.rel(s.A.state, s.am)).ownKey)).rkid
      // Zehntes Ticket: nur A1 ist da; A2 bekommt es nie (für A2 verworfen). Dann ist nur A2 da und bekommt das elfte.
      s.A2.online = false
      const mark10 = s.w.carrier.carried.length
      await s.Mm.introduce(s.ma, cs[9]!)
      const t10 = s.w.carrier.carried.slice(mark10).filter((f) => f.address === rkidA).map((f) => f.id)
      if (!serial) s.w.carrier.faults.withhold(s.A2.name, (f) => t10.includes(f.id))
      await rounds(3)
      if (!serial) {
        s.A.online = false
        s.A2.online = true
      }
      await s.Mm.introduce(s.ma, cs[10]!)
      await rounds(3)
      s.A.online = true
      await rounds(6)
      const accepted = acceptedActs(s.w, 'A').size
      const perDevice = s.w.of('A').map((d) => `${d.name}: ${M.budgetUsed(M.rel(d.state, s.am), s.w.clock.now())}`)
      const ok = overrun === 0 && before === 9 && accepted === M.PARAM.budget
      return { outcome: mark(ok), detail: `vorher ${before}; angenommene Akte der Person: ${accepted} (Budget ${M.PARAM.budget}), Überschreitung im Verlauf höchstens ${overrun}; je Gerät ${perDevice.join(', ')}; blockiert: ${blocked(s.w, 'A')}`, measures: { budgetOverrun: overrun, acceptedActs: accepted, blockedOperations: blocked(s.w, 'A') } }
    },
  },
  {
    id: 'X3',
    title: 'A1 stimmt einer Vorstellung zu, A2 lehnt dieselbe ab (beide offline): Terminalität 8325, was B und M sehen',
    async run(c, serial) {
      const s = await setup(c, serial)
      const r = await s.Mm.introduce(s.ma, s.mb)
      if (!('act' in r)) return fail(r.refused)
      await s.w.until(() => s.w.of('A').every((d) => d.state.acts.length === 1) && s.B.state.acts.length === 1)
      s.A.online = false
      s.A2.online = false
      await s.A.consent(r.act)
      if (!serial) await s.A2.decline(r.act)
      await s.B.consent(r.act)
      s.A.online = true
      s.A2.online = true
      const n = await untilStable(s.w, 'A')
      const l = ledger(s.w, 'A')
      const decisions = ['consent', 'decline'].filter((k) => l.has(`${k}:${r.act}`))
      const states = s.w.of('A').map((d) => M.act(d.state, r.act).state)
      const bState = M.act(s.B.state, r.act).state
      const agree = s.w.agree('A')
      // Terminalität (8325.A3): das Gerät, das selbst abgelehnt hat, verlässt `declined` nie; wird es dennoch connected, ist die Zusage geändert.
      // (Mit Journal trägt jedes Gerät beide Effekte im Ledger; es zählt die eigene Entscheidung, erkennbar am Schreiber der Operation.)
      const leftTerminal = s.w.of('A').some((d) => d.state.effects.some((e) => e.id === `decline:${r.act}` && e.op.startsWith(`${d.name}@`)) && M.act(d.state, r.act).state !== 'declined')
      // Widerspruch: B hält eine Karte oder ist verbunden, während A als Ganzes abgelehnt hat.
      const contradiction = states.some((x) => x === 'declined') && (bState === 'connected' || M.act(s.B.state, r.act).v !== null)
      const progress = states.every((x) => x !== 'offered')
      const mArtifacts = s.w.of('M').flatMap((d) => d.log).filter((e) => e.type === 'introduction-card').length // 8765/8920
      const ok = agree.agree && !contradiction && progress && mArtifacts === 0 && !leftTerminal
      const promiseChanged = agree.agree && !contradiction && progress && leftTerminal
      return { outcome: mark(ok), promiseChanged, detail: `Entscheidungen: ${decisions.join('+') || 'keine'}; A: ${s.w.of('A').map((d, i) => `${d.name}: ${states[i]}`).join(', ')}; B: ${bState}; Projektion gleich nach ${n} Runden: ${agree.agree ? 'ja' : 'nein (' + agree.diff + ')'}; terminaler Zustand verlassen: ${leftTerminal ? 'ja' : 'nein'}; Widerspruch bei B: ${contradiction ? 'ja' : 'nein'}`, measures: { doubleFinalEffects: finalEffects(s.w, 'A').contradictions, projectionAgrees: agree.agree ? 1 : 0, roundsToConverge: n, leftTerminal: leftTerminal ? 1 : 0, contradictionAtB: contradiction ? 1 : 0, promiseChanged: promiseChanged ? 1 : 0 } }
    },
  },
  {
    id: 'X4',
    title: 'A1 schaltet die Klasse aus, A2 hat gerade eine Karte versandt und füllt nach (Widerruf ∥ Versand, 8232.2, 8535, 6270)',
    async run(c, serial) {
      const s = await setup(c, serial, ['C'])
      const { C, mc } = s.thirds.C!
      const acts: string[] = []
      for (let i = 0; i < 3; i++) {
        const r = await s.Mm.introduce(s.ma, i === 0 ? s.mb : mc)
        if ('act' in r) acts.push(r.act)
        await s.w.rounds(3)
      }
      const lastAct = acts[acts.length - 1]!
      s.A2.online = false
      s.M2.online = false
      await s.A.setClass(s.am, false) // A1: Klasse aus, leere Revision an M1
      await s.w.rounds(3)
      const offline = await s.A2.consent(lastAct) // A2 getrennt: Karte versandfertig, Klasse bei A2 noch an
      await C.consent(lastAct)
      const r4 = await s.M2.introduce(s.ma, mc) // M2 hält die alte Sicht und benennt einen Schlüssel, den A1 zurückgezogen hat
      s.A2.online = true
      s.M2.online = true
      // B6: korrektes Begrenzen wird nicht bestraft; nach der Heilung handelt das Gerät mit dem Recht.
      if (offline === 'blocked') await s.w.rounds(1), await s.A.consent(lastAct)
      const n = await untilStable(s.w, 'A')
      const equivocation = s.w.of('M').flatMap((d) => d.state.findings).filter((f) => f.includes('Equivokation')).length
      const viewKeys = s.w.of('M').map((d) => `${d.name}: ${M.rel(d.state, s.ma).view?.keys.length ?? 0}`)
      const act4 = 'act' in r4 ? s.w.of('A').map((d) => `${d.name}: ${d.state.acts.find((a) => a.id === r4.act)?.state ?? 'abgewiesen'}`) : ['keine vierte Vorstellung']
      const cont = s.w.of('A').map((d) => M.act(d.state, lastAct).state)
      const agree = s.w.agree('A')
      const ok = equivocation === 0 && agree.agree && s.w.of('M').every((d) => (M.rel(d.state, s.ma).view?.keys.length ?? 0) === 0) && cont.every((x) => x === 'connected') // 8232.2, 8925: der laufende Akt läuft weiter
      return { outcome: mark(ok), detail: `Equivokationen bei M: ${equivocation}; Ms Sicht auf A (Schlüssel): ${viewKeys.join(', ')}; vierte Vorstellung: ${act4.join(', ')}; Akt mit Karte: ${cont.join('/')}; Zustimmung offline ${offline}; Projektion gleich nach ${n} Runden: ${agree.agree ? 'ja' : 'nein'}`, measures: { equivocations: equivocation, projectionAgrees: agree.agree ? 1 : 0, roundsToConverge: n, offlineBlocked: offline === 'blocked' ? 1 : 0 } }
    },
  },
  {
    id: 'X5',
    title: 'A1 beendet die Beziehung zu B, A2 spielt eine alte Mapping-Pflicht nach (Abgang ∥ Replay, 6845.7, 6845.10)',
    async run(c, serial) {
      const s = await setup(c, serial)
      const e1 = await s.w.encounter(s.A, s.B)
      await s.w.rounds(3)
      // Zweite Begegnung: sobald As Mapping unterwegs ist (Pflicht `sent`), bleiben Rahmen an A aus; die Quittung kommt nie an.
      const e2 = await s.w.encounter(s.A, s.B)
      const n = await s.w.until(() => s.A.state.duties.some((d) => d.state === 'sent'), 10)
      const rkid2 = (await s.A.cand.keys.pair(e2.x.ownKey)).rkid
      const rkid1 = (await s.A.cand.keys.pair(e1.x.ownKey)).rkid
      for (const d of s.w.of('A')) s.w.carrier.faults.withhold(d.name, (f) => f.address === rkid2 || f.address === rkid1)
      await s.w.rounds(3)
      const A2 = serial ? s.A : await s.w.enrol(s.A, 'A2b') // Enrollment mit der offenen Pflicht im Zustand
      if (!serial) A2.online = false
      const mappingsBefore = [...ledger(s.w, 'A').keys()].filter((id) => id.startsWith('mapping:')).length
      // Der Nutzer beendet den Kontakt B: jeden Eintrag, den A1 zu B hält (vor der Vereinigung können es zwei sein).
      for (const r of s.A.state.relationships.filter((r) => r.tuples.some((t) => t.peer === e1.x.peer || t.peer === e2.x.peer))) await s.A.depart(r.id)
      s.w.carrier.faults.reset()
      const toB = new Set([e1.x.peerKeyAgreement, e2.x.peerKeyAgreement])
      const mark0 = s.w.carrier.carried.length
      await s.w.rounds(2)
      A2.online = true
      await s.w.rounds(8)
      // Wiederbelebt (6845.7, 6845.9): eine Mapping-Wirkung nach dem Abgang; `united` als Endzustand einer vor dem Abgang erledigten Pflicht zählt nicht.
      const mappingsAfter = [...ledger(s.w, 'A').keys()].filter((id) => id.startsWith('mapping:')).length
      const revived = mappingsAfter - mappingsBefore
      // S1 (Review 4 B4): eine vor dem Abgang eingereichte Sendung bleibt bei Delivery, ihre Wiederholung ist erlaubt (6845.7);
      // neue Bytes an B nach dem Abgang sind Wiederbelebung oder Neuproduktion (8475.S6) und verboten.
      const before = new Set(s.w.carrier.carried.slice(0, mark0).filter((f) => toB.has(f.address)).map((f) => Buffer.from(f.bytes).toString('base64')))
      const after = s.w.carrier.carried.slice(mark0).filter((f) => toB.has(f.address))
      const repeats = after.filter((f) => before.has(Buffer.from(f.bytes).toString('base64'))).length
      const fresh = after.length - repeats
      const departedEverywhere = s.w.of('A').every((d) => d.state.relationships.filter((r) => r.tuples.some((t) => s.w.personOf(t.peer) === 'B')).every((r) => r.departed))
      const ok = n > 0 && departedEverywhere && revived === 0 && fresh === 0
      return { outcome: mark(ok), detail: `Pflicht sent nach ${n} Runden; Mapping-Wirkungen nach dem Abgang: ${revived}; Rahmen an B nach dem Abgang: ${fresh} neue, ${repeats} Wiederholungen; B überall abgegangen: ${departedEverywhere ? 'ja' : 'nein'}`, measures: { revivedDuties: revived, newFramesToPeerAfterDeparture: fresh, repeatedFramesToPeerAfterDeparture: repeats, departedEverywhere: departedEverywhere ? 1 : 0 } }
    },
  },
  {
    id: 'X6',
    title: 'A2 wird aus einem alten Backup wiederhergestellt: Nummernwiederverwendung, Vorratszustand, Inkarnation (8500, 8315, Befund 5)',
    async run(c, serial) {
      if (serial) return na('ein Gerät: kein zweites, das aus einem Backup zurückkommt')
      const s = await setup(c, serial, ['C'])
      const { mc } = s.thirds.C!
      const backup = s.w.stores.get('A2')!.snapshot()
      const writerBefore = s.A2.cand.writer
      // Drei Vorstellungen; beide A-Geräte nehmen an und bestätigen dem Träger, der nichts mehr nachliefert.
      for (let i = 0; i < 3; i++) {
        await s.Mm.introduce(s.ma, mc)
        await s.w.rounds(3)
      }
      const mView = M.rel(s.Mm.state, s.ma).view!
      s.w.stores.get('A2')!.restore(backup)
      await s.A2.reload()
      const n = await untilStable(s.w, 'A')
      const incarnationChanged = s.A2.cand.writer !== writerBefore
      const behind = M.rel(s.A2.state, s.am).revision < mView.revision ? 1 : 0
      const stale = M.rel(s.A2.state, s.am).stock.filter((k) => k.state === 'active' && s.Mm.state.consumed.includes(k.anchor)).length
      const ids1 = new Set(s.A.state.acts.map((a) => a.id))
      const lostActs = [...ids1].filter((id) => !s.A2.state.acts.some((a) => a.id === id)).length
      const r = await s.Mm.introduce(s.ma, mc)
      await s.w.rounds(4)
      const unknownOwn = s.A2.state.findings.filter((f) => f.includes('8640.5')).length
      const reuse = s.w.of('M').flatMap((d) => d.state.findings).filter((f) => f.includes('6270')).length
      const ok = n > 0 && behind === 0 && stale === 0 && lostActs === 0 && unknownOwn === 0 && reuse === 0 && incarnationChanged
      return { outcome: mark(ok), detail: `Konvergenz nach ${n} Runden; A2 Revision ${M.rel(s.A2.state, s.am).revision}, M hält ${mView.revision}; bei A2 aktive Schlüssel, die M als verbraucht markiert: ${stale}; A2 fehlen ${lostActs} Akte; Ticket ${'act' in r ? 'ausgegeben' : 'verweigert'}, bei A2 unbekannter eigener Schlüssel: ${unknownOwn}; Nummernkonflikte bei M: ${reuse}; Inkarnation gewechselt: ${incarnationChanged ? 'ja' : 'nein'}`, measures: { roundsToConverge: n, revisionBehind: behind, staleActiveKeys: stale, lostActs, unknownOwnKey: unknownOwn, numberReuse: reuse, incarnationChanged: incarnationChanged ? 1 : 0 } }
    },
  },
  {
    id: 'X7',
    title: 'A1 trifft B1, A2 trifft B2 in derselben Runde, kein Gerät hat gemeinsame Kandidaten: Kontinuität über Geräte (I-6, 2300)',
    async run(c, serial) {
      const s = await setup(c, serial)
      // Beide Begegnungen vor jeder Runde: kein Journal kann die erste vor der zweiten übertragen.
      await s.w.encounter(s.A, s.B)
      await s.w.encounter(s.A2, s.B2)
      const n = await untilStable(s.w, 'A')
      // Soll (B5, je Gerät): jedes Gerät hält genau einen Eintrag zu der anderen Person, und der trägt beide Tupel (nichts gelöscht).
      const per = [...s.w.of('A').map((d) => ({ d, r: relationshipsTo(s.w, d, 'B') })), ...s.w.of('B').map((d) => ({ d, r: relationshipsTo(s.w, d, 'A') }))]
      const duplicates = Math.max(0, entriesAcross(s.w, 'A', 'B') - 1) + Math.max(0, entriesAcross(s.w, 'B', 'A') - 1)
      const missing = per.filter(({ r }) => r.entries === 0).length
      const ok = n > 0 && duplicates === 0 && per.every(({ r }) => r.entries === 1 && r.tuples === 2)
      return { outcome: mark(ok), detail: `${per.map(({ d, r }) => `${d.name}: ${r.entries} Eintrag/Einträge mit ${r.tuples} Tupel(n)`).join('; ')}; stabil nach ${n} Runden`, measures: { duplicates, devicesWithoutContact: missing, roundsToConverge: n } }
    },
  },
  {
    id: 'X8',
    title: 'A nimmt A2 neu auf: A2 sieht alles und handelt sofort; Verkehr des Enrollments',
    async run(c, serial) {
      if (serial) return na('ein Gerät: kein Enrollment')
      const s = await setup(c, true)
      const r = await s.Mm.introduce(s.ma, s.mb)
      if (!('act' in r)) return fail(r.refused)
      await s.w.until(() => s.A.state.acts.length === 1 && s.B.state.acts.length === 1)
      const A2 = await s.w.enrol(s.A, 'A2')
      const bytes = Buffer.byteLength(JSON.stringify(A2.state), 'utf8') // Größe der Zustandskopie; K0 kennt keinen Enrollment-Verkehr
      const same = M.canonical(A2.projection()) === M.canonical(s.A.projection())
      await A2.consent(r.act)
      await s.B.consent(r.act)
      const n = await s.w.until(() => M.act(A2.state, r.act).state === 'connected' && M.act(s.B.state, r.act).state === 'connected')
      const ok = same && n > 0
      return { outcome: mark(ok), detail: `Projektion nach Enrollment gleich: ${same ? 'ja' : 'nein'}; A2 verbunden nach ${n} Runden; Zustandskopie ${bytes} B UTF-8 (K0: Kopie, kein gemessener Enrollment-Verkehr)`, measures: { stateCopyBytes: bytes, rounds: n } }
    },
  },
  {
    id: 'X9',
    title: 'A verliert A2 und widerruft es: B und M dürfen A2 nicht mehr erreichen, A1 schon',
    async run(c, serial) {
      if (serial) return na('ein Gerät: kein zweites, das widerrufen würde')
      const s = await setup(c, serial, ['C'])
      const { mc } = s.thirds.C!
      const ab = await s.w.encounter(s.A, s.B)
      await s.w.rounds(3)
      // Was der Dieb hat: das Store-Abbild von A2 vor dem Widerruf, als unabhängige Instanz (Review 4 S1: kein lebender Verweis auf A2).
      const thief = await s.w.steal(s.A2, 'A2-dieb')
      await s.w.revoke(s.A, s.A2)
      await s.w.rounds(2)
      s.w.devices.push(thief)
      const before = s.A.state.acts.length
      const r = await s.Mm.introduce(s.ma, mc) // M → A
      await s.B.setClass(ab.y.id, true) // B → A: Revision an As Adresse des A–B-Tupels
      await s.w.rounds(4)
      const reads = thief.log.filter((e) => e.type !== 'delivery-ack').length
      const legit = s.A.state.acts.length - before
      const legitFromB = M.rel(s.A.state, ab.x.id).view ? 1 : 0
      const ok = 'act' in r && legit === 1 && legitFromB === 1 && reads === 0
      return { outcome: mark(ok), detail: `Vorstellung ${'act' in r ? 'ausgegeben' : 'verweigert'}; A1 erhält ${legit} Ticket(s) und ${legitFromB} Revision(en) von B; der Dieb liest ${reads} Dokument(e) und hält ${thief.state.acts.length} Akt(e)`, measures: { thiefReads: reads, legitimateDelivery: legit, legitimateDeliveryFromPeer: legitFromB } }
    },
  },
  {
    id: 'X10',
    title: 'Eine zweite App von A als weiteres Gerät mit eingeschränktem Recht (nur lesen)',
    async run(c) {
      if (!c.capabilities.has('restricted-app')) return na('der Kandidat kennt keine Rechte je Gerät')
      return na('noch nicht gebaut')
    },
  },
  {
    id: 'X11',
    title: 'Lange Trennung (30 Runden), beide Geräte handeln, dann Vereinigung: stabile Konvergenz, Größe des Journals',
    async run(c, serial) {
      if (serial) return na('ein Gerät: keine Trennung')
      const s = await setup(c, serial, ['C'])
      const { C, mc } = s.thirds.C!
      const acts: string[] = []
      for (const other of [s.mb, mc]) {
        const r = await s.Mm.introduce(s.ma, other)
        if ('act' in r) acts.push(r.act)
        await s.w.rounds(3)
      }
      if (acts.length !== 2) return fail('keine zwei Vorstellungen')
      s.A2.online = false
      await s.A.consent(acts[0]!) // A1 handelt auf dem ersten Akt
      const offline = await s.A2.consent(acts[1]!) // A2 handelt getrennt auf dem zweiten
      await s.B.consent(acts[0]!)
      await C.consent(acts[1]!)
      await s.w.rounds(30)
      const a1 = acts.map((a) => M.act(s.A.state, a).state)
      s.A2.online = true
      if (offline === 'blocked') await s.w.rounds(1), await s.A.consent(acts[1]!) // B6: nach der Heilung mit dem Recht
      const n = await untilStable(s.w, 'A')
      const journal = JSON.stringify(s.A2.cand.persist() ?? null).length
      const a2 = acts.map((a) => s.A2.state.acts.find((x) => x.id === a)?.state ?? '–')
      const fe = finalEffects(s.w, 'A')
      return { outcome: mark(n > 0 && fe.total === 0), detail: `A1: ${a1.join('/')}; A2 nach Wiederverbindung: ${a2.join('/')}; Zustimmung offline ${offline}; stabile Konvergenz nach ${n} Runden; doppelte Wirkungen ${fe.total}; Journal ${journal} B`, measures: { roundsToConverge: n, journalBytes: journal, doubleFinalEffects: fe.total, offlineBlocked: offline === 'blocked' ? 1 : 0 } }
    },
  },
  {
    id: 'X12',
    title: 'Verlorene Quittung und unerreichbarer Träger je Gerät (T9/T10 bei Mehrgerät): Wirkung einmal, beide Geräte danach gleich',
    async run(c, serial) {
      const s = await setup(c, serial)
      const r = await s.Mm.introduce(s.ma, s.mb)
      if (!('act' in r)) return fail(r.refused)
      await s.w.until(() => s.w.of('A').every((d) => d.state.acts.length === 1) && s.B.state.acts.length === 1)
      await s.B.consent(r.act)
      await s.w.rounds(3)
      const act = M.act(s.A.state, r.act)
      const ownRkid = (await s.A.cand.keys.pair(M.rel(s.A.state, s.am).stock.find((k) => k.anchor === act.own)!.key)).rkid
      s.w.carrier.dropDeliveryTo.add(ownRkid) // die erste Quittung an A geht verloren
      if (!serial) s.A2.online = false
      await s.A.consent(r.act)
      await s.w.rounds(1)
      s.w.carrier.unreachable = true
      await s.w.rounds(2)
      s.w.carrier.unreachable = false
      const n = await s.w.until(() => M.act(s.A.state, r.act).o === 'delivered' && M.act(s.A.state, r.act).state === 'connected')
      if (!serial) s.A2.online = true
      const m = await untilStable(s.w, 'A')
      const connectsAtB = ledger(s.w, 'B').get(`connect:${r.act}`)?.size ?? 0
      const dup = s.B.dispositions.filter((d) => d === 'duplicate-known').length
      const ok = n > 0 && connectsAtB === 1 && dup >= 1 && m > 0
      return { outcome: mark(ok), detail: `A1: Karte ${M.act(s.A.state, r.act).o} nach ${n} Runden; B: Verbindung ${connectsAtB}×, ${dup}× duplicate-known; A-Geräte gleich nach ${m} Runden`, measures: { rounds: n, duplicateKnownAtB: dup, doubleFinalEffects: Math.max(0, connectsAtB - 1), roundsToConverge: m } }
    },
  },
]

export async function runX15(candidate: MultiDeviceCandidate, serial = false, only?: string[]): Promise<X15Result[]> {
  const out: X15Result[] = []
  for (const s of x15) {
    if (only && !only.includes(s.id)) continue
    try {
      out.push({ scenario: s.id, title: s.title, ...(await s.run(candidate, serial)) })
    } catch (e) {
      out.push({ scenario: s.id, title: s.title, outcome: 'nicht bestanden', crashed: true, detail: `Fehler: ${(e as Error).stack ?? (e as Error).message}`, measures: {} })
    }
  }
  return out
}
