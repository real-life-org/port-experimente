// E15 Mehrgerät: Szenarien X1–X23 (Plan Abschnitt 4). Jedes Szenario läuft
// gegen jeden Kandidaten; `serial` lässt nur ein Gerät je Person handeln
// (Kontrolllauf: so muss auch K0 bestehen, sonst stimmt der Prüfstand nicht).
// Ergebnis je Zelle ✓/✗/– wie in der Konformitätsmatrix, dazu Messgrößen
// (Abschnitt 5): doppelte endgültige Wirkungen, Doppel in der Liste,
// Budgetüberschreitung, Runden bis Konvergenz, Verkehr.

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
}

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
}

/**
 * Gemeinsame Welt: A, B, M mit je zwei Geräten; Begegnungen A–M und B–M,
 * Klasse an, Vorrat bei M; dann Enrollment der zweiten Geräte (sie starten
 * mit einer Kopie). Im seriellen Lauf gibt es die zweiten Geräte nicht.
 */
async function setup(candidate: MultiDeviceCandidate, serial: boolean, thirds: string[] = []): Promise<Setup & { thirds: Record<string, { C: HolderDevice; cm: string; mc: string }> }> {
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
  const base: Setup = { w, A, A2: A, B, B2: B, Mm, M2: Mm, am: am.x.id, ma: am.y.id, bm: bm.x.id, mb: bm.y.id }
  // Weitere Gegenpersonen vor dem Enrollment, damit beide M-Geräte sie kennen.
  const t: Record<string, { C: HolderDevice; cm: string; mc: string }> = {}
  for (const name of thirds) t[name] = await third(base, name)
  const A2 = serial ? A : await w.enrol(A, 'A2')
  const B2 = serial ? B : await w.enrol(B, 'B2')
  const M2 = serial ? Mm : await w.enrol(Mm, 'M2')
  return { ...base, A2, B2, M2, thirds: t }
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

/** Doppelverbrauch beim Mediator: ein Vorrats-Anker in mehr als einem Akt, über alle M-Geräte (8570.1). */
function doubleConsumption(w: Welt15, person: string): number {
  const acts = new Map<string, Set<string>>()
  for (const d of w.of(person)) for (const a of d.state.mediatorActs) for (const k of [a.a.key, a.b.key]) {
    if (!acts.has(k)) acts.set(k, new Set())
    acts.get(k)!.add(a.id)
  }
  return [...acts.values()].filter((s) => s.size > 1).length
}

/** Angenommene Akte einer Person über alle Geräte (verschiedene Akt-Ids). */
function acceptedActs(w: Welt15, person: string): Set<string> {
  const ids = new Set<string>()
  for (const d of w.of(person)) for (const a of d.state.acts) ids.add(a.id)
  return ids
}

export const x15: Array<{ id: string; title: string; run: (c: MultiDeviceCandidate, serial: boolean) => Promise<Omit<X15Result, 'scenario' | 'title'>> }> = [
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
      const n = await s.w.until(() => acceptedActs(s.w, 'A').size >= 1 && s.w.of('A').every((d) => d.dispositions.length >= 2), 20)
      await s.w.rounds(3)
      const dbl = doubleConsumption(s.w, 'M')
      const conformance = s.w.of('A').flatMap((d) => d.state.findings).filter((f) => f.includes('8640.12')).length
      const ok = dbl === 0 && conformance === 0 && 'act' in r1 && 'act' in r2
      return { outcome: mark(ok), detail: `Vorstellungen: ${['act' in r1, 'act' in r2].filter(Boolean).length}; doppelt benannte Schlüssel bei M: ${dbl}; Konformitätsfehler bei A: ${conformance}; Runden: ${n}`, measures: { doubleFinalEffects: dbl, mediatorConformanceFailures: conformance, rounds: n } }
    },
  },
  {
    id: 'X2',
    title: 'Budget bei 9; A1 und A2 nehmen offline je ein zehntes Ticket an (harte Grenze 8510)',
    async run(c, serial) {
      const s = await setup(c, serial)
      // Neun Annahmen, bevor die zweiten Geräte abweichen können: alle Geräte sehen dieselben Tickets.
      const cs: string[] = []
      for (let i = 0; i < 11; i++) cs.push((await third(s, `C${i}`)).mc)
      for (let i = 0; i < 9; i++) {
        await s.Mm.introduce(s.ma, cs[i]!)
        await s.w.rounds(3)
      }
      const before = acceptedActs(s.w, 'A').size
      // Zwei weitere Tickets: das zehnte sieht nur A1, das elfte nur A2 (gezieltes Zurückhalten).
      const aAddr = M.head(M.rel(s.A.state, s.am)).ownKey
      const rkidA = (await s.A.cand.keys.pair(aAddr)).rkid
      const mark10 = s.w.carrier.carried.length
      await s.Mm.introduce(s.ma, cs[9]!)
      const t10 = s.w.carrier.carried.slice(mark10).filter((f) => f.address === rkidA).map((f) => f.id)
      const mark11 = s.w.carrier.carried.length
      await s.Mm.introduce(s.ma, cs[10]!)
      const t11 = s.w.carrier.carried.slice(mark11).filter((f) => f.address === rkidA).map((f) => f.id)
      if (!serial) {
        s.w.carrier.faults.withhold(s.A2.name, (f) => t10.includes(f.id))
        s.w.carrier.faults.withhold(s.A.name, (f) => t11.includes(f.id))
      }
      await s.w.rounds(4)
      s.w.carrier.faults.reset()
      await s.w.rounds(4)
      const accepted = acceptedActs(s.w, 'A').size
      const over = Math.max(0, accepted - M.PARAM.budget)
      const perDevice = s.w.of('A').map((d) => `${d.name}: ${M.budgetUsed(M.rel(d.state, s.am), s.w.clock.now())}`)
      return { outcome: mark(over === 0 && before === 9), detail: `vorher ${before}; angenommene Akte der Person: ${accepted} (Budget ${M.PARAM.budget}); je Gerät ${perDevice.join(', ')}`, measures: { budgetOverrun: over, acceptedActs: accepted } }
    },
  },
  {
    id: 'X3',
    title: 'A1 stimmt einer Vorstellung zu, A2 lehnt dieselbe ab (beide offline): Terminalität 8325, was B und M sehen',
    async run(c, serial) {
      const s = await setup(c, serial)
      const r = await s.Mm.introduce(s.ma, s.mb)
      if (!('act' in r)) return { outcome: 'nicht bestanden' as Outcome, detail: r.refused, measures: {} as Record<string, number | string> }
      await s.w.until(() => s.w.of('A').every((d) => d.state.acts.length === 1) && s.B.state.acts.length === 1)
      s.A.online = false
      s.A2.online = false
      await s.A.consent(r.act)
      if (!serial) s.A2.decline(r.act)
      await s.B.consent(r.act)
      s.A.online = true
      s.A2.online = true
      await s.w.rounds(6)
      const states = s.w.of('A').map((d) => `${d.name}: ${M.act(d.state, r.act).state}`)
      const bState = M.act(s.B.state, r.act).state
      const agree = s.w.agree('A')
      // Soll: Zustimmung oder Ablehnung, aber ein Zustand je Person; B sieht nichts, was A als Ganzes nicht trägt.
      const contradiction = !serial && s.w.of('A').some((d) => M.act(d.state, r.act).state === 'declined') && bState === 'connected'
      const ok = agree.agree && !contradiction
      return { outcome: mark(ok), detail: `A: ${states.join(', ')}; B: ${bState}; Projektion gleich: ${agree.agree ? 'ja' : 'nein (' + agree.diff + ')'}`, measures: { doubleFinalEffects: contradiction ? 1 : 0, projectionAgrees: agree.agree ? 1 : 0 } }
    },
  },
  {
    id: 'X7',
    title: 'A1 trifft B1, A2 trifft B2, kein Gerät hat gemeinsame Kandidaten: Kontinuität über Geräte (I-6, 2300)',
    async run(c, serial) {
      const s = await setup(c, serial)
      await s.w.encounter(s.A, s.B)
      await s.w.rounds(3)
      await s.w.encounter(s.A2, s.B2)
      const n = await s.w.until(() => s.w.of('A').every((d) => d.state.duties.every((x) => x.state === 'united' || x.state === 'moot')) && s.w.duplicates('A') === 0, 20)
      await s.w.rounds(3)
      const dA = s.w.duplicates('A')
      const dB = s.w.duplicates('B')
      const rels = s.w.of('A').map((d) => `${d.name}: ${d.state.relationships.filter((r) => s.w.personOf(M.head(r).peer) === 'B').length} Beziehung(en) zu B`)
      return { outcome: mark(dA === 0 && dB === 0), detail: `${rels.join(', ')}; Doppel A ${dA}, B ${dB}; Runden ${n}`, measures: { duplicates: dA + dB, rounds: n } }
    },
  },
]


const na = (detail: string): Omit<X15Result, 'scenario' | 'title'> => ({ outcome: 'nicht abbildbar', detail, measures: {} })

x15.push(
  {
    id: 'X4',
    title: 'A1 schaltet die Klasse aus, A2 hat gerade eine Karte versandt und füllt nach (Widerruf ∥ Versand, 8232.2, 8535, 6270)',
    async run(c, serial) {
      const s = await setup(c, serial, ['C'])
      const { mc } = s.thirds.C!
      // Drei Vorstellungen verbrauchen drei Schlüssel: beide A-Geräte füllen nach (gleiche Nonce, gleiche Nummern).
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
      await s.A2.consent(lastAct) // A2 offline: Karte versandfertig, Klasse bei A2 noch an
      const r4 = await s.M2.introduce(s.ma, mc) // M2 hält die alte Sicht und benennt einen Schlüssel, den A1 zurückgezogen hat
      s.A2.online = true
      s.M2.online = true
      await s.w.rounds(8)
      const equivocation = s.w.of('M').flatMap((d) => d.state.findings).filter((f) => f.includes('Equivokation')).length
      const viewKeys = s.w.of('M').map((d) => `${d.name}: ${M.rel(d.state, s.ma).view?.keys.length ?? 0}`)
      const act4 = 'act' in r4 ? s.w.of('A').map((d) => `${d.name}: ${d.state.acts.find((a) => a.id === r4.act)?.state ?? 'abgewiesen'}`) : ['keine vierte Vorstellung']
      const cont = s.w.of('A').map((d) => M.act(d.state, lastAct).state)
      const agree = s.w.agree('A')
      const ok = equivocation === 0 && agree.agree && s.w.of('M').every((d) => (M.rel(d.state, s.ma).view?.keys.length ?? 0) === 0)
      return { outcome: mark(ok), detail: `Equivokationen bei M: ${equivocation}; Ms Sicht auf A (Schlüssel): ${viewKeys.join(', ')}; vierte Vorstellung: ${act4.join(', ')}; Akt mit Karte: ${cont.join('/')}; Projektion gleich: ${agree.agree ? 'ja' : 'nein'}`, measures: { equivocations: equivocation, projectionAgrees: agree.agree ? 1 : 0 } }
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
      // Der Nutzer beendet den Kontakt B: jeden Eintrag, den A1 zu B hält (vor der Vereinigung können es zwei sein).
      for (const r of s.A.state.relationships.filter((r) => r.tuples.some((t) => t.peer === e1.x.peer || t.peer === e2.x.peer))) s.A.depart(r.id)
      s.w.carrier.faults.reset()
      await s.w.rounds(2)
      const before = s.w.traffic('A').framesOut
      A2.online = true
      await s.w.rounds(6)
      const replayed = s.w.traffic('A').framesOut - before
      const departedEverywhere = s.w.of('A').every((d) => d.state.relationships.filter((r) => r.tuples.some((t) => s.w.personOf(t.peer) === 'B')).every((r) => r.departed))
      const revived = s.w.of('A').flatMap((d) => d.state.duties).filter((d) => d.state === 'united' || d.state === 'sent' || d.state === 'hit').length
      const ok = n > 0 && departedEverywhere && revived === 0
      return { outcome: mark(ok), detail: `Pflicht sent nach ${n} Runden; nach dem Abgang gesendete Rahmen von A: ${replayed}; B überall abgegangen: ${departedEverywhere ? 'ja' : 'nein'}; lebende Pflichten: ${revived}`, measures: { framesAfterDeparture: replayed, revivedDuties: revived } }
    },
  },
  {
    id: 'X6',
    title: 'A2 wird aus einem alten Backup wiederhergestellt: Nummernwiederverwendung, Vorratszustand (8500, 8315)',
    async run(c, serial) {
      if (serial) return na('ein Gerät: kein zweites, das aus einem Backup zurückkommt')
      const s = await setup(c, serial, ['C'])
      const { mc } = s.thirds.C!
      const backup = s.w.stores.get('A2')!.snapshot()
      // Drei Vorstellungen; beide A-Geräte nehmen an und bestätigen dem Träger, der nichts mehr nachliefert.
      for (let i = 0; i < 3; i++) {
        await s.Mm.introduce(s.ma, mc)
        await s.w.rounds(3)
      }
      const mView = M.rel(s.Mm.state, s.ma).view!
      s.w.stores.get('A2')!.restore(backup)
      await s.A2.reload()
      await s.w.rounds(2)
      const behind = M.rel(s.A2.state, s.am).revision < mView.revision ? 1 : 0
      const stale = M.rel(s.A2.state, s.am).stock.filter((k) => k.state === 'active' && s.Mm.state.consumed.includes(k.anchor)).length
      const lostActs = s.A.state.acts.length - s.A2.state.acts.length
      // Eine weitere Vorstellung: M benennt einen frischen Schlüssel (nach As Revision 2), den das alte Backup nicht kennt.
      const r = await s.Mm.introduce(s.ma, mc)
      await s.w.rounds(4)
      const unknownOwn = s.A2.state.findings.filter((f) => f.includes('8640.5')).length
      const ok = behind === 0 && stale === 0 && lostActs === 0 && unknownOwn === 0
      return { outcome: mark(ok), detail: `A2 Revision ${M.rel(s.A2.state, s.am).revision}, M hält ${mView.revision}; bei A2 aktive Schlüssel, die M als verbraucht markiert: ${stale}; A2 fehlen ${lostActs} Akte; Ticket ${'act' in r ? 'ausgegeben' : 'verweigert'}, bei A2 unbekannter eigener Schlüssel: ${unknownOwn}`, measures: { revisionBehind: behind, staleActiveKeys: stale, lostActs, unknownOwnKey: unknownOwn } }
    },
  },
  {
    id: 'X8',
    title: 'A nimmt A2 neu auf: A2 sieht alles und handelt sofort; Verkehr des Enrollments',
    async run(c, serial) {
      if (serial) return na('ein Gerät: kein Enrollment')
      const s = await setup(c, true)
      const r = await s.Mm.introduce(s.ma, s.mb)
      if (!('act' in r)) return { outcome: 'nicht bestanden' as Outcome, detail: r.refused, measures: {} as Record<string, number | string> }
      await s.w.until(() => s.A.state.acts.length === 1 && s.B.state.acts.length === 1)
      const A2 = await s.w.enrol(s.A, 'A2')
      const bytes = JSON.stringify(A2.state).length
      const same = JSON.stringify(A2.projection()) === JSON.stringify(s.A.projection())
      await A2.consent(r.act)
      await s.B.consent(r.act)
      const n = await s.w.until(() => M.act(A2.state, r.act).state === 'connected' && M.act(s.B.state, r.act).state === 'connected')
      const ok = same && n > 0
      return { outcome: mark(ok), detail: `Projektion nach Enrollment gleich: ${same ? 'ja' : 'nein'}; A2 verbunden nach ${n} Runden; Zustandskopie ${bytes} B`, measures: { enrolBytes: bytes, rounds: n } }
    },
  },
  {
    id: 'X9',
    title: 'A verliert A2 und widerruft es: B und M dürfen A2 nicht mehr erreichen',
    async run(c, serial) {
      if (serial) return na('ein Gerät: kein zweites, das widerrufen würde')
      const s = await setup(c, serial, ['C'])
      const { mc } = s.thirds.C!
      const stolen = { cand: s.A2.cand, state: structuredClone(s.A2.state) }
      s.w.revoke(s.A2)
      await s.w.rounds(1)
      // Der Dieb meldet sich mit A2s Schlüsseln und Zustand wieder am Träger an.
      const thief = new HolderDevice('A2-dieb', 'A', stolen.cand, s.w.carrier, s.w.clock, undefined, stolen.state)
      await thief.relisten()
      s.w.devices.push(thief)
      const r = await s.Mm.introduce(s.ma, mc)
      await s.w.rounds(4)
      const reads = thief.log.length
      const acts = thief.state.acts.length
      return { outcome: mark(reads === 0 && acts === 0), detail: `Vorstellung ${'act' in r ? 'ausgegeben' : 'verweigert'}; der Dieb liest ${reads} Dokument(e) und hält ${acts} Akt(e)`, measures: { thiefReads: reads } }
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
    title: 'Lange Trennung (30 Runden), beide Geräte handeln, dann Vereinigung: Konvergenz, Größe des Journals',
    async run(c, serial) {
      if (serial) return na('ein Gerät: keine Trennung')
      const s = await setup(c, serial, ['C'])
      const { mc } = s.thirds.C!
      s.A2.online = false
      const acts: string[] = []
      for (const other of [s.mb, mc]) {
        const r = await s.Mm.introduce(s.ma, other)
        if ('act' in r) acts.push(r.act)
        await s.w.rounds(2)
      }
      for (const a of acts) await s.A.consent(a)
      await s.B.consent(acts[0]!)
      await s.w.rounds(30)
      const a1 = acts.map((a) => M.act(s.A.state, a).state)
      s.A2.online = true
      const n = await s.w.until(() => s.w.agree('A').agree, 20)
      const journal = JSON.stringify(s.A2.cand.persist() ?? null).length
      const a2 = acts.map((a) => s.A2.state.acts.find((x) => x.id === a)?.state ?? '–')
      return { outcome: mark(n > 0), detail: `A1: ${a1.join('/')}; A2 nach Wiederverbindung: ${a2.join('/')}; Runden bis gleiche Projektion: ${n}; Journal ${journal} B`, measures: { roundsToConverge: n, journalBytes: journal } }
    },
  },
  {
    id: 'X12',
    title: 'Verlorene Quittung und unerreichbarer Träger je Gerät (T9/T10 bei Mehrgerät)',
    async run(c, serial) {
      const s = await setup(c, serial)
      const r = await s.Mm.introduce(s.ma, s.mb)
      if (!('act' in r)) return { outcome: 'nicht bestanden' as Outcome, detail: r.refused, measures: {} as Record<string, number | string> }
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
      await s.w.rounds(4)
      const cardsAtB = s.B.log.filter((l) => l.type === 'introduction-card').length
      const effectsAtB = s.B.state.acts[0]?.state === 'connected' ? 1 : 0
      const dup = s.B.dispositions.filter((d) => d === 'duplicate-known').length
      const ok = n > 0 && effectsAtB === 1 && dup >= 1
      return { outcome: mark(ok), detail: `A1: Karte ${M.act(s.A.state, r.act).o} nach ${n} Runden; B: ${cardsAtB} Kartenankünfte, ${dup}× duplicate-known, Wirkung ${effectsAtB}×`, measures: { rounds: n, duplicateKnownAtB: dup } }
    },
  },
)

export async function runX15(candidate: MultiDeviceCandidate, serial = false, only?: string[]): Promise<X15Result[]> {
  const out: X15Result[] = []
  for (const s of x15) {
    if (only && !only.includes(s.id)) continue
    try {
      out.push({ scenario: s.id, title: s.title, ...(await s.run(candidate, serial)) })
    } catch (e) {
      out.push({ scenario: s.id, title: s.title, outcome: 'nicht bestanden', detail: `Fehler: ${(e as Error).stack ?? (e as Error).message}`, measures: {} })
    }
  }
  return out
}
