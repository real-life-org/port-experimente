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
import { EnrolmentRefused, frameHash, HolderDevice, type MultiDeviceCandidate } from './holder'
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
 * gibt es die zweiten Geräte nicht. `pre` läuft vor dem Enrollment.
 */
async function setup(candidate: MultiDeviceCandidate, serial: boolean, thirds: string[] = [], pre?: (base: Setup) => Promise<void>): Promise<Setup> {
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
  await pre?.(base) // weitere Begegnungen vor dem Enrollment: auch ein Gerät ohne Journal (K0) kennt sie
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

/**
 * Die Adressen einer Person für einen Kontext über ihre Geräte (Störregeln, Messung): K0/K1a eine (ein Seed, alle Geräte
 * dieselbe), K2 eine je Gerät (eigene Schlüssel je Gerät, Schritt 1).
 */
async function addressesFor(w: Welt15, person: string, ctx: string): Promise<ReadonlySet<string>> {
  const out = new Set<string>()
  for (const d of w.of(person)) out.add((await d.cand.keys.pair(ctx)).rkid)
  return out
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
  // Review 21 B2: auf der Seite des Vorrats-Inhabers entstehen `accept:<Akt>`-Effekte; der Schlüssel ist der eigene Anker des
  // Akts. Verbrauch je Schlüssel über alle Akt-Ids der Person, nicht je Akt.
  for (const d of w.of(person)) for (const a of d.state.acts) {
    if (!l.has(`accept:${a.id}`)) continue
    if (!keyActs.has(a.own)) keyActs.set(a.own, new Set())
    keyActs.get(a.own)!.add(a.id)
  }
  const doubleConsumption = [...keyActs.values()].filter((s) => s.size > 1).length
  const contradictions = [...l.keys()].filter((id) => id.startsWith('decline:') && l.has(`consent:${id.slice(8)}`)).length
  return { doubles: doubles.length, doubleIds: doubles, doubleConsumption, contradictions, total: doubles.length + doubleConsumption + contradictions }
}

/**
 * Karten-Dokumente eines Akts, die den Träger erreicht haben (K1a Schritt 3): je Gerät der Person die eigenen
 * Kartenabsichten an die Adresse des Gegenübers, deren Einlieferung mindestens einmal gelungen ist. Eine zurückgenommene
 * Karte (lokal abgegrenzt, `Zusteller.demarcate`) zählt nicht; Wiederholungen derselben Bytes zählen einmal.
 */
function cardFramesOut(w: Welt15, person: string, actId: string): number {
  const out = new Set<string>()
  for (const d of w.of(person)) {
    const a = d.state.acts.find((x) => x.id === actId)
    if (!a) continue
    for (const [digest, i] of d.intents) if (i.device === d.name && i.kind.includes('introduction-card') && i.address === a.voucher.keyAgreement && (d.zusteller.submissions.get(digest)?.deposits ?? 0) > 0) out.add(digest)
  }
  return out.size
}

/**
 * Was eine Gegenperson über die Schreiber einer anderen lernt (K1a Schritt 4, Plan Abschnitt 5 „was M lernt“): je eigener
 * Beziehung der Gegenperson die verschiedenen Schreiberkennungen in empfangenen Revisionen, Proben und Mappings (aus dem
 * Empfangsprotokoll aller ihrer Geräte), und wie viele Kennungen in mehr als einer Beziehung auftauchen (verknüpfbar).
 */
function writerTagsSeen(w: Welt15, observer: string): { perRelationship: Map<string, Set<string>>; linked: number } {
  const per = new Map<string, Set<string>>()
  for (const d of w.of(observer)) {
    for (const e of d.log) {
      if (!e.writer) continue
      // K2: ein Schwestergerät der Gegenperson signiert unter seinem eigenen Anker; die Beziehung kommt dann aus der Empfangsadresse.
      const r = d.state.relationships.find((x) => x.tuples.some((t) => t.peer === e.from)) ?? (e.rel ? M.findRel(d.state, e.rel) : undefined)
      if (!r) continue
      const id = M.resolveId(d.state, r.id)
      if (!per.has(id)) per.set(id, new Set())
      per.get(id)!.add(e.writer)
    }
  }
  const where = new Map<string, number>()
  for (const tags of per.values()) for (const t of tags) where.set(t, (where.get(t) ?? 0) + 1)
  return { perRelationship: per, linked: [...where.values()].filter((n) => n > 1).length }
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

/** Vorstellung über den autorisierten Pfad (B6): darf M1 keinen Schlüssel benennen (K1a teilt sie), stellt M2 vor. */
async function introduceAny(s: Setup, relA: string, relB: string, serial: boolean): Promise<{ act: string } | { refused: string }> {
  const r = await s.Mm.introduce(relA, relB)
  if ('act' in r || serial) return r
  return s.M2.introduce(relA, relB)
}

/** Die Rahmen einer Vorstellung: was die Mediatorgeräte dabei erzeugt haben (versiegelt; zugeordnet über `produced`). */
async function framesOf(s: Setup, f: () => Promise<{ act: string } | { refused: string }>) {
  const known = new Set(s.w.of('M').flatMap((d) => [...d.produced.keys()]))
  const r = await f()
  return { r, frames: new Set(s.w.of('M').flatMap((d) => [...d.produced.keys()]).filter((h) => !known.has(h))) }
}

/** Alle Geräte einer Person kennen den Akt (sonst wäre eine Entscheidung darauf ein Fehler im Szenario, kein Messwert). */
const knowsAct = (w: Welt15, person: string, act: string) => w.of(person).every((d) => d.state.acts.some((a) => a.id === act))

/** Journal je Gerät (X11, X21): Batches und Bytes, die das Gerät kennt; ohne Nachholen (K0) nicht messbar. */
function journalOf(d: HolderDevice): { batches: number; bytes: number } | null {
  const all = d.cand.batchesAfter?.({})
  return all ? { batches: all.length, bytes: all.reduce((n, f) => n + f.body.length, 0) } : null
}

/** Batches, die ein Gerät einer Person nicht kennt, ein Schwestergerät aber schon (über die Köpfe); null ohne Köpfe. */
function missingBatches(w: Welt15, person: string): number | null {
  const ds = w.of(person)
  if (ds.some((d) => !d.cand.heads || !d.cand.batchesAfter)) return null
  let n = 0
  for (const d of ds) for (const e of ds) if (d !== e) n += e.cand.batchesAfter!(d.cand.heads!()).length
  return n
}

/** Größter Abstand zwischen zwei Nachhol-Anfragen eines Geräts (Backoff 1, 2, 4, … 16 Runden). */
const MAX_REREQUEST = 16

/**
 * Reparaturende (Review 11 B2): kein Gerät der Person hat noch Nachholarbeit (`syncPending`) UND über ein Fenster,
 * das länger ist als der größte Wiederanfrageabstand, wird nichts an der Self-Adresse eingeliefert. Ein Gerät, das im
 * Backoff schweigt, aber noch wartet, ist nicht fertig. Ergebnis: erste Runde des Ruhefensters (−1 bei Grenze), die
 * am Ende noch wartenden Geräte und die Self-Rahmen während des Wartens.
 */
async function untilRepaired(w: Welt15, person: string, self: ReadonlySet<string>, quiet = MAX_REREQUEST + 1, max = 60): Promise<{ rounds: number; window: number; pending: string[]; selfFrames: number }> {
  let still = 0
  let selfFrames = 0
  const pending = () => w.of(person).filter((d) => d.syncPending).map((d) => d.name)
  for (let i = 1; i <= max; i++) {
    const mark = w.carrier.carried.length
    await w.rounds(1)
    const n = w.carrier.carried.slice(mark).filter((f) => self.has(f.address)).length
    selfFrames += n
    still = n === 0 && pending().length === 0 ? still + 1 : 0
    if (still >= quiet) return { rounds: i - quiet, window: still, pending: [], selfFrames }
  }
  return { rounds: -1, window: still, pending: pending(), selfFrames }
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
      // Fortschritt nach der Heilung: eine offline blockierte Vorstellung darf jetzt gelingen (B1); hat M2 das Recht nicht, stellt M1 vor (autorisierter Pfad, B6).
      const attempts = [r1, r2]
      let retry = 'act' in r2 ? r2 : await s.M2.introduce(s.ma, mc)
      if (!('act' in r2)) attempts.push(retry)
      if (!('act' in retry)) {
        retry = await s.Mm.introduce(s.ma, mc)
        attempts.push(retry)
      }
      await s.w.rounds(4)
      const fe = finalEffects(s.w, 'M')
      const conformance = s.w.of('A').flatMap((d) => d.state.findings).filter((f) => f.includes('8640.12')).length
      const progress = ['act' in r1, 'act' in retry].filter(Boolean).length
      // Rechtebedingte Verweigerung vor der Operation (kein benennbarer Schlüssel) zählt eigens (Review 7 S3); Fortschritt nach der Heilung gehört zur Zusage.
      const keyRefusals = attempts.filter((r) => 'refused' in r).length // jede Verweigerung zählt, auch die vor dem Ausweichen auf M1 (Review 8)
      const ok = fe.doubleConsumption === 0 && conformance === 0 && progress === 2
      return { outcome: mark(ok), detail: `offline ausgestellt: ${['act' in r1, 'act' in r2].filter(Boolean).length} von 2, blockiert: ${blocked(s.w, 'M')}, verweigert (Schlüssel): ${keyRefusals}; nach der Heilung gelungen: ${progress} von 2; doppelt benannte Schlüssel bei M: ${fe.doubleConsumption}; Konformitätsfehler bei A: ${conformance}`, measures: { doubleFinalEffects: fe.doubleConsumption, mediatorConformanceFailures: conformance, blockedOperations: blocked(s.w, 'M'), keyRefusals, progressAfterHeal: progress } }
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
      const rkidA = await addressesFor(s.w, 'A', M.head(M.rel(s.A.state, s.am)).ownKey)
      // Zehntes Ticket: nur A1 ist da; A2 bekommt es nie (für A2 verworfen). Dann ist nur A2 da und bekommt das elfte.
      s.A2.online = false
      const mark10 = s.w.carrier.carried.length
      await s.Mm.introduce(s.ma, cs[9]!)
      const t10 = s.w.carrier.carried.slice(mark10).filter((f) => rkidA.has(f.address)).map((f) => f.id)
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
      // Heilung: A2 kommt eine Runde vor A1 zurück, so faltet A1 die Ablehnung, bevor seine Karte den Träger erreicht (der
      // Zweig „keine Karte eingereicht“ von Regel 2; der andere Zweig ist der Gegenlauf in tests/mehrgeraet-k1a.test.ts).
      s.A2.online = true
      await s.w.rounds(1)
      s.A.online = true
      const n = await untilStable(s.w, 'A')
      const l = ledger(s.w, 'A')
      const decisions = ['consent', 'decline'].filter((k) => l.has(`${k}:${r.act}`) || l.has(`conflict:${k}:${r.act}`))
      const states = s.w.of('A').map((d) => M.act(d.state, r.act).state)
      const bState = M.act(s.B.state, r.act).state
      const agree = s.w.agree('A')
      // Regel 2 (Anton 18.10.2026, Linie „weich“): ist eine eigene Karte eingereicht (8325.0: O ∈ {taken, delivered,
      // given-up}), gilt die Zustimmung und der Akt endet connected; sonst gilt die Ablehnung (8325.A3, 8232.2, 8765).
      const pa = M.act(s.A.state, r.act)
      const submitted = M.SUBMITTED.has(pa.o)
      const expected = submitted ? 'connected' : 'declined'
      const ruleKept = states.every((x) => x === expected)
      // Geänderte Zusage (8325): ein Gerät, das selbst entschieden hat, endet im anderen Zustand. A2 hat abgelehnt, A1 zugestimmt.
      const leftTerminal = !serial && M.act(s.A2.state, r.act).state !== 'declined'
      const consentUndone = !serial && M.act(s.A.state, r.act).state === 'declined'
      // Widerspruch: B hält eine Karte oder ist verbunden, während A als Ganzes abgelehnt hat (8765).
      const contradiction = states.some((x) => x === 'declined') && (bState === 'connected' || M.act(s.B.state, r.act).v !== null)
      const progress = states.every((x) => x !== 'offered')
      const mArtifacts = s.w.of('M').flatMap((d) => d.log).filter((e) => e.type === 'introduction-card').length // 8765/8920
      const cardsOut = cardFramesOut(s.w, 'A', r.act)
      const conflicts = s.w.of('A')[0]!.state.findings.filter((f) => f.includes(r.act) && f.includes('Regel 2')).length
      const ok = agree.agree && ruleKept && !contradiction && progress && mArtifacts === 0
      const promiseChanged = ok && (leftTerminal || consentUndone)
      const rule = serial
        ? 'eine Entscheidung'
        : !agree.agree
          ? 'keine gemeinsame Entscheidung: die Geräte von A bleiben uneins'
          : submitted
          ? `Regel 2: eine eigene Karte eingereicht (O = ${pa.o}), die Zustimmung gilt, die Ablehnung ist ein Konfliktbefund`
          : `Regel 2: keine eigene Karte eingereicht (O = ${pa.o}), die Ablehnung gilt, die Karte ist zurückgenommen (8232.2), nichts an B (8765)`
      return { outcome: mark(ok), promiseChanged, detail: `${rule}; Entscheidungen: ${decisions.join('+') || 'keine'}; A: ${s.w.of('A').map((d, i) => `${d.name}: ${states[i]}`).join(', ')}; B: ${bState}; Karten-Dokumente von A beim Träger: ${cardsOut}; Projektion gleich nach ${n} Runden: ${agree.agree ? 'ja' : 'nein (' + agree.diff + ')'}; Regel eingehalten: ${ruleKept ? 'ja' : 'nein'}; terminaler Zustand verlassen: ${leftTerminal ? 'ja' : 'nein'}, Zustimmung zurückgenommen: ${consentUndone ? 'ja' : 'nein'}; Widerspruch bei B: ${contradiction ? 'ja' : 'nein'}`, measures: { doubleFinalEffects: finalEffects(s.w, 'A').contradictions, projectionAgrees: agree.agree ? 1 : 0, roundsToConverge: n, leftTerminal: leftTerminal ? 1 : 0, consentUndone: consentUndone ? 1 : 0, ruleKept: ruleKept ? 1 : 0, cardSubmitted: submitted ? 1 : 0, cardFramesToCarrier: cardsOut, conflictFindings: conflicts, contradictionAtB: contradiction ? 1 : 0, promiseChanged: promiseChanged ? 1 : 0 } }
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
      const rkid2 = await addressesFor(s.w, 'A', e2.x.ownKey)
      const rkid1 = await addressesFor(s.w, 'A', e1.x.ownKey)
      for (const d of s.w.of('A')) s.w.carrier.faults.withhold(d.name, (f) => rkid2.has(f.address) || rkid1.has(f.address))
      await s.w.rounds(3)
      // Ein Gerät, das die offene Pflicht kennt: frisch aufgenommen (Zustandskopie) oder, wenn der Kandidat die Gerätezahl festhält, das vorhandene zweite (es kennt die Pflicht über das Journal).
      const A2 = serial ? s.A : await s.w.enrol(s.A, 'A2b').catch((e: unknown) => { if (e instanceof EnrolmentRefused) return s.A2; throw e })
      if (!serial) A2.online = false
      const mappingsBefore = [...ledger(s.w, 'A').keys()].filter((id) => id.startsWith('mapping:')).length
      // Der Nutzer beendet den Kontakt B: jeden Eintrag, den A1 zu B hält (vor der Vereinigung können es zwei sein).
      for (const r of s.A.state.relationships.filter((r) => r.tuples.some((t) => t.peer === e1.x.peer || t.peer === e2.x.peer))) await s.A.depart(r.id)
      s.w.carrier.faults.reset()
      const toB = new Set([e1.x.peerKeyAgreement, e2.x.peerKeyAgreement, ...(await addressesFor(s.w, 'B', e1.y.ownKey)), ...(await addressesFor(s.w, 'B', e2.y.ownKey))])
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
      // Grenze (Anton 18.10., Option 2): öffnen beide Personen nebenläufig auf je zwei Geräten, trägt keine eingefrorene Probe
      // das andere Tupel (2300, 6750), auch die Neuauswertung findet nichts; das Doppel heilt erst bei der nächsten Begegnung.
      const heal = duplicates > 0 ? '; das Doppel heilt bei der nächsten Begegnung (X7b)' : ''
      return { outcome: mark(ok), detail: `${per.map(({ d, r }) => `${d.name}: ${r.entries} Eintrag/Einträge mit ${r.tuples} Tupel(n)`).join('; ')}; stabil nach ${n} Runden${heal}`, measures: { duplicates, devicesWithoutContact: missing, roundsToConverge: n } }
    },
  },
  {
    id: 'X7b',
    title: 'Dritte Begegnung nach dem symmetrischen nebenläufigen Paar (X7): beide Geräte abgeglichen, A1 trifft B1 erneut; Einträge je Gerät vorher/nachher, Runden bis zu einem Eintrag mit drei Tupeln, keine Doppelwirkung (2300, 6806, 6975)',
    async run(c, serial) {
      const s = await setup(c, serial)
      // Wie X7: beide Begegnungen vor jeder Runde, dann Abgleich der Geräte.
      await s.w.encounter(s.A, s.B)
      await s.w.encounter(s.A2, s.B2)
      await untilStable(s.w, 'A')
      await untilStable(s.w, 'B')
      const count = (person: string, other: string) => s.w.of(person).map((d) => relationshipsTo(s.w, d, other))
      const before = [...count('A', 'B'), ...count('B', 'A')]
      const entriesBefore = Math.max(...before.map((r) => r.entries))
      // Die dritte Begegnung: die frische Probe trägt beide alten Tupel als Kandidaten (2300), die Gegenseite trifft beide.
      await s.w.encounter(s.A, s.B)
      const one = () => [...count('A', 'B'), ...count('B', 'A')].every((r) => r.entries === 1 && r.tuples === 3)
      let rounds = -1
      for (let i = 1; i <= 30; i++) {
        await s.w.rounds(1)
        if (one()) {
          rounds = i
          break
        }
      }
      const n = Math.max(await untilStable(s.w, 'A'), await untilStable(s.w, 'B'))
      const after = [...count('A', 'B'), ...count('B', 'A')]
      const duplicates = Math.max(0, entriesAcross(s.w, 'A', 'B') - 1) + Math.max(0, entriesAcross(s.w, 'B', 'A') - 1)
      const feA = finalEffects(s.w, 'A')
      const feB = finalEffects(s.w, 'B')
      const doubles = feA.total + feB.total
      const ok = rounds > 0 && n >= 0 && duplicates === 0 && doubles === 0 && one()
      const names = [...s.w.of('A'), ...s.w.of('B')].map((d) => d.name)
      return {
        outcome: mark(ok),
        detail: `vorher ${before.map((r, i) => `${names[i]}: ${r.entries}`).join(', ')} Einträge; nachher ${after.map((r, i) => `${names[i]}: ${r.entries} mit ${r.tuples} Tupeln`).join(', ')}; ein Eintrag mit drei Tupeln nach ${rounds} Runden; Doppel in der Liste ${duplicates}; doppelte Wirkungen ${doubles}`,
        measures: { entriesBefore, entriesAfter: Math.max(...after.map((r) => r.entries)), tuplesAfter: Math.min(...after.map((r) => r.tuples)), roundsToOneEntry: rounds, duplicates, doubleFinalEffects: doubles, roundsToConverge: n },
      }
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
      // Schritt 6: mit Ablage beginnt A2 leer und faltet die Ablage ab Beginn; „sofort“ heißt dann: nach der Antwort des Dienstes.
      // Die Freigabe (Hybrid, Review 25 B1) bezeugt die Schwester: gezählt getrennt, bis A2 nicht mehr gesperrt ist.
      const g0 = s.w.selfLog ? A2.gatedRounds : 0
      const fold = s.w.selfLog ? await s.w.until(() => !A2.logPending, 10) : 0
      if (s.w.selfLog) await s.w.until(() => !A2.gated, 10)
      const gated = s.w.selfLog ? A2.gatedRounds - g0 : 0
      const bytes = Buffer.byteLength(JSON.stringify(A2.state), 'utf8') // Größe der Zustandskopie; K0 kennt keinen Enrollment-Verkehr
      const same = M.canonical(A2.projection()) === M.canonical(s.A.projection())
      await A2.consent(r.act)
      await s.B.consent(r.act)
      const n = await s.w.until(() => M.act(A2.state, r.act).state === 'connected' && M.act(s.B.state, r.act).state === 'connected')
      const ok = same && n > 0 && fold >= 0
      if (s.w.selfLog) return { outcome: mark(ok), detail: `aus der Ablage gefaltet nach ${fold} Runde(n): ${A2.logEntriesRead} Einträge, ${A2.logBytesRead} B gelesen (keine Zustandskopie; Zustand danach ${bytes} B UTF-8); Freigabe nach dem Zeugnis von A1: ${gated} Runde(n) gesperrt; Projektion gleich: ${same ? 'ja' : 'nein'}; A2 verbunden nach ${n} Runden`, measures: { enrolRounds: fold, enrolGatedRounds: gated, enrolLogEntries: A2.logEntriesRead, enrolLogBytes: A2.logBytesRead, stateBytes: bytes, rounds: n } }
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
      // K2 Schritt 1: die Gegenseiten lesen die Gerätemenge aus der Prüfstandsliste, der Widerruf wirkt dort sofort. Ein ✓
      // gilt nur unter dieser Vereinfachung (Ersatz für die Mengenrevision an jede Gegenseite, Schritt 3), nie als Erfüllung.
      const shortcut = c.capabilities.has('device-keys')
      const promiseChanged = ok && shortcut
      const note = promiseChanged ? `; Schritt-1-Vereinfachung: B und M erfahren den Widerruf über die Prüfstandsliste der Gerätemenge, nicht über eine Mengenrevision (Schritt 3); der Dieb hält nur die Schlüssel von A2, versiegelt wird nach dem Widerruf an A1 allein` : ''
      return { outcome: mark(ok), ...(shortcut ? { promiseChanged } : {}), detail: `Vorstellung ${'act' in r ? 'ausgegeben' : 'verweigert'}; A1 erhält ${legit} Ticket(s) und ${legitFromB} Revision(en) von B; der Dieb liest ${reads} Dokument(e) und hält ${thief.state.acts.length} Akt(e)${note}`, measures: { thiefReads: reads, legitimateDelivery: legit, legitimateDeliveryFromPeer: legitFromB, ...(shortcut ? { step1Shortcut: 1 } : {}) } }
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
  {
    id: 'X13',
    title: 'M1 und M2 stellen getrennt je eine Vorstellung an A aus, As gemeinsames Budget je Mediatorbeziehung steht bei 9; A1 sieht nur die eine, A2 nur die andere (Mediatorgeräte gegen das gemeinsame Budget, 8510, 8640.10)',
    async run(c, serial) {
      // Die Gegenpersonen vor dem Enrollment: auch ein Mediatorgerät ohne Journal (K0) kennt jede Beziehung.
      const names = Array.from({ length: 11 }, (_, i) => `C${i}`)
      const s = await setup(c, serial, names)
      const cs = names.map((n) => s.thirds[n]!.mc)
      let overrun = 0
      const sample = () => (overrun = Math.max(overrun, acceptedActs(s.w, 'A').size - M.PARAM.budget))
      const rounds = (n: number) => s.w.rounds(n, sample)
      for (let i = 0; i < 9; i++) {
        await introduceAny(s, s.ma, cs[i]!, serial)
        await rounds(3)
      }
      const before = acceptedActs(s.w, 'A').size
      // Beide Mediatorgeräte getrennt: jedes stellt A eine weitere Person vor (zehnte und elfte Vorstellung).
      s.Mm.online = false
      s.M2.online = false
      const x1 = await framesOf(s, () => s.Mm.introduce(s.ma, cs[9]!))
      const x2 = await framesOf(s, () => s.M2.introduce(s.ma, cs[10]!))
      const offline = [x1, x2].filter((x) => 'act' in x.r).length
      s.Mm.online = true
      s.M2.online = true
      // Ein Mediatorgerät ohne benennbaren Schlüssel (K1a) wird nach der Heilung vom anderen vertreten (autorisierter Pfad, B6).
      const xs = [x1, x2]
      for (let i = 0; i < 2; i++) if (!('act' in xs[i]!.r)) xs[i] = await framesOf(s, () => introduceAny(s, s.ma, cs[9 + i]!, serial))
      const issued = xs.filter((x) => 'act' in x.r).length
      // Die Seite ist getrennt: die zehnte erreicht nur A1, die elfte nur A2; danach sehen beide alles.
      const hash = (f: { bytes: Uint8Array }) => frameHash(f.bytes)
      if (!serial) {
        s.w.carrier.faults.withhold(s.A2.name, (f) => xs[0]!.frames.has(hash(f)))
        s.w.carrier.faults.withhold(s.A.name, (f) => xs[1]!.frames.has(hash(f)))
      }
      await rounds(6)
      s.w.carrier.faults.reset()
      await rounds(6)
      const accepted = acceptedActs(s.w, 'A').size
      const fe = finalEffects(s.w, 'M')
      const agree = s.w.agree('A')
      const perDevice = s.w.of('A').map((d) => `${d.name}: ${M.budgetUsed(M.rel(d.state, s.am), s.w.clock.now())}`)
      const ok = overrun === 0 && before === 9 && issued === 2 && accepted === M.PARAM.budget && fe.doubleConsumption === 0 && agree.agree
      return { outcome: mark(ok), detail: `vorher ${before}; offline ausgestellt ${offline} von 2, insgesamt ${issued}; angenommene Akte der Person: ${accepted} (Budget ${M.PARAM.budget}), Überschreitung im Verlauf höchstens ${overrun}; je Gerät ${perDevice.join(', ')}; blockiert: ${blocked(s.w, 'A')}; doppelt benannte Schlüssel bei M: ${fe.doubleConsumption}; A-Geräte gleich: ${agree.agree ? 'ja' : 'nein'}`, measures: { budgetOverrun: overrun, acceptedActs: accepted, issuedOffline: offline, issued, blockedOperations: blocked(s.w, 'A'), doubleFinalEffects: fe.doubleConsumption, projectionAgrees: agree.agree ? 1 : 0 } }
    },
  },
  {
    id: 'X14',
    title: 'A1 und A2 stellen B getrennt dieselbe Person C vor (zwei Akte, ein Zweck); B1 und B2 stimmen getrennt je einem zu: doppelte Vorstellung, Vereinigung der Akte bei B und C (6975, I-6)',
    async run(c, serial) {
      // A ist hier der Mediator: B und C erlauben A, sie vorzustellen (Klasse an, Vorrat bei A). C hat ein Gerät.
      let C!: HolderDevice
      let ab!: { x: M.Tuple; y: M.Tuple }
      let ac!: { x: M.Tuple; y: M.Tuple }
      const s = await setup(c, serial, [], async (b) => {
        C = await b.w.person('C', 'C1')
        ab = await b.w.encounter(b.A, b.B)
        ac = await b.w.encounter(b.A, C)
        await b.w.rounds(3)
        await b.B.setClass(ab.y.id, true)
        await C.setClass(ac.y.id, true)
        await b.w.rounds(4)
      })
      s.A.online = false
      s.A2.online = false
      const r1 = await s.A.introduce(ab.x.id, ac.x.id, 'B', 'C')
      const r2 = await s.A2.introduce(ab.x.id, ac.x.id, 'B', 'C')
      const offline = [r1, r2].filter((r) => 'act' in r).length
      s.A.online = true
      s.A2.online = true
      // Ein Gerät ohne benennbaren Schlüssel (K1a) wird nach der Heilung vom anderen vertreten (B6): der Nutzer stellt dennoch zweimal vor.
      const rs = [r1, r2]
      for (let i = 0; i < 2; i++) if (!('act' in rs[i]!)) {
        await s.w.rounds(2)
        rs[i] = await s.A.introduce(ab.x.id, ac.x.id, 'B', 'C')
        if (!('act' in rs[i]!) && !serial) rs[i] = await s.A2.introduce(ab.x.id, ac.x.id, 'B', 'C')
      }
      const acts = rs.filter((r): r is { act: string } => 'act' in r).map((r) => r.act)
      if (acts.length !== 2) return fail(`nur ${acts.length} Vorstellung(en) ausgestellt: ${rs.map((r) => ('refused' in r ? r.refused : 'ok')).join(', ')}`)
      if ((await s.w.until(() => acts.every((a) => knowsAct(s.w, 'B', a) && knowsAct(s.w, 'C', a)), 15)) < 0) {
        // Gemessen, was ankam: ein doppelt benannter Schlüssel wird bei B oder C abgewiesen (8640.12).
        const fa = finalEffects(s.w, 'A')
        const known = acts.filter((a) => knowsAct(s.w, 'B', a) && knowsAct(s.w, 'C', a)).length
        const conformance = [...s.w.of('B'), C].flatMap((d) => d.state.findings).filter((f) => f.includes('8640.12')).length
        return { outcome: 'nicht bestanden', detail: `offline ausgestellt ${offline} von 2; bei B und C angekommen: ${known} von 2; doppelt benannte Schlüssel bei A: ${fa.doubleConsumption}; Konformitätsfehler bei B/C: ${conformance}`, measures: { actsIssued: acts.length, issuedOffline: offline, actsArrived: known, doubleFinalEffects: fa.doubleConsumption, mediatorConformanceFailures: conformance } }
      }
      // Zwei Geräte: B1 stimmt dem ersten Akt zu, B2 zugleich dem zweiten. Seriell: B nacheinander, der zweite nach der ersten Verbindung.
      const connected = (a: string) => [...s.w.of('B'), C].every((d) => M.act(d.state, a).state === 'connected')
      if (serial) {
        for (const a of acts) {
          await s.B.consent(a)
          await C.consent(a)
          await s.w.until(() => connected(a), 15)
        }
      } else {
        // B1 und B2 sind dabei voneinander getrennt (das Journal zwischen ihnen bleibt aus, bis beide Verbindungen und die Proben durch sind):
        // so entscheidet nicht der Zufall der Reihenfolge, ob ein Gerät eine Probe mit dem ganzen Wissen der Person prüft.
        const selfB = s.w.selfAddresses('B')
        for (const d of s.w.of('B')) s.w.carrier.faults.withhold(d.name, (f) => selfB.has(f.address))
        await s.B.consent(acts[0]!)
        await s.B2.consent(acts[1]!)
        await C.consent(acts[0]!)
        await C.consent(acts[1]!)
        await s.w.until(() => M.act(s.B.state, acts[0]!).state === 'connected' && M.act(s.B2.state, acts[1]!).state === 'connected' && acts.every((a) => M.act(C.state, a).state === 'connected'), 15)
        await s.w.rounds(4)
        s.w.carrier.faults.reset()
      }
      await s.w.until(() => acts.every(connected), 15)
      const n = Math.max(await untilStable(s.w, 'B'), await untilStable(s.w, 'C'))
      const per = [...s.w.of('B').map((d) => ({ d, r: relationshipsTo(s.w, d, 'C') })), { d: C, r: relationshipsTo(s.w, C, 'B') }]
      const duplicates = Math.max(0, entriesAcross(s.w, 'B', 'C') - 1) + Math.max(0, entriesAcross(s.w, 'C', 'B') - 1)
      const issued = new Set(s.w.of('A').flatMap((d) => d.state.mediatorActs.map((a) => a.id))).size
      const feA = finalEffects(s.w, 'A')
      const feB = finalEffects(s.w, 'B')
      const feC = finalEffects(s.w, 'C')
      const doubles = feA.doubleConsumption + feB.doubles + feC.doubles
      const states = acts.map((a) => s.w.of('B').map((d) => M.act(d.state, a).state).join('/'))
      const ok = n > 0 && duplicates === 0 && doubles === 0 && acts.every(connected) && per.every(({ r }) => r.entries === 1)
      return { outcome: mark(ok), detail: `offline ausgestellt ${offline} von 2, Akte bei A ${issued}; B: Akte ${states.join(', ')}; ${per.map(({ d, r }) => `${d.name}: ${r.entries} Eintrag/Einträge mit ${r.tuples} Tupel(n)`).join('; ')}; Doppel in der Liste ${duplicates}; doppelte Wirkungen ${doubles}; stabil nach ${n} Runden`, measures: { actsIssued: issued, issuedOffline: offline, duplicates, doubleFinalEffects: doubles, devicesWithoutUnion: per.filter(({ r }) => r.entries !== 1).length, roundsToConverge: n } }
    },
  },
  {
    id: 'X15',
    title: 'Vereinigung zweier Beziehungen zu M (6975), während auf einer ein Akt läuft (consented, Karte unterwegs): A1 stimmt zu, A2 trifft getrennt davon M erneut und vereinigt (6987.5/.6/.10/.12/.14)',
    async run(c, serial) {
      const s = await setup(c, serial)
      const r = await introduceAny(s, s.ma, s.mb, serial)
      if (!('act' in r)) return fail(`Vorstellung verweigert: ${r.refused}`)
      if ((await s.w.until(() => knowsAct(s.w, 'A', r.act) && knowsAct(s.w, 'B', r.act), 10)) < 0) return fail('Akt nicht bei A und B')
      // B ist weg: As Karte bleibt unterwegs (consented, nicht verbunden), während A eine zweite Beziehung zu M öffnet.
      // A1 und A2 sind dabei voneinander getrennt (kein Journal): die Zustimmung auf A1 und die Vereinigung auf A2 laufen nebeneinander.
      for (const d of s.w.of('B')) d.online = false
      const selfA = s.w.selfAddresses('A')
      if (!serial) for (const d of s.w.of('A')) s.w.carrier.faults.withhold(d.name, (f) => selfA.has(f.address))
      await s.A.consent(r.act)
      await s.w.rounds(1)
      const e2 = await s.w.encounter(s.A2, s.Mm) // A2 trifft M1 erneut; seriell trifft A1 M1
      const nUnion = await s.w.until(() => relationshipsTo(s.w, s.A2, 'M').entries === 1, 15)
      const midState = s.w.of('A').map((d) => M.act(d.state, r.act).state)
      s.w.carrier.faults.reset()
      for (const d of s.w.of('B')) d.online = true
      await s.B.consent(r.act)
      await s.w.until(() => [...s.w.of('A'), ...s.w.of('B')].every((d) => M.act(d.state, r.act).state === 'connected'), 15)
      const n = Math.max(await untilStable(s.w, 'A'), await untilStable(s.w, 'M'))
      // Gemessen je Gerät: Einträge zu M (Soll einer mit beiden Tupeln), der Akt verbunden, seine Mediatorbeziehung aufgelöst auf die vereinigte (6987.10), die Annahme im Budget der vereinigten (6987.6).
      const per = s.w.of('A').map((d) => {
        const rels = relationshipsTo(s.w, d, 'M')
        const a = d.state.acts.find((x) => x.id === r.act)
        const rel = a ? M.findRel(d.state, a.mediator) : undefined
        const resolved = !!rel && !rel.departed && rel.tuples.some((t) => t.id === e2.x.id) && rel.tuples.some((t) => t.id === M.tuple(d.state, M.head(M.rel(d.state, s.am)).id).id)
        return { d, rels, state: a?.state ?? '–', resolved, budget: !!rel && rel.accepted.some((e) => e.act === r.act) }
      })
      const entries = Math.max(entriesAcross(s.w, 'A', 'M'), entriesAcross(s.w, 'M', 'A'))
      const mPer = s.w.of('M').map((d) => ({ d, rels: relationshipsTo(s.w, d, 'A') }))
      const equivocation = s.w.of('M').flatMap((d) => d.state.findings).filter((f) => f.includes('Equivokation')).length
      // 6987.5/6987.14: nach der Vereinigung hält M die Sicht auf dem Kopf der vereinigten Beziehung.
      const viewOnHead = s.w.of('M').filter((d) => { const rel = M.rel(d.state, s.ma); return rel.view?.scope === M.head(rel).id }).length
      const fe = finalEffects(s.w, 'A')
      const connectsAtB = ledger(s.w, 'B').get(`connect:${r.act}`)?.size ?? 0
      const agree = s.w.agree('A')
      const connected = per.filter((x) => x.state === 'connected').length
      const ok = nUnion > 0 && n > 0 && entries === 1 && per.every((x) => x.rels.entries === 1 && x.rels.tuples === 2 && x.state === 'connected' && x.resolved && x.budget) && mPer.every((x) => x.rels.entries === 1) && viewOnHead === mPer.length && equivocation === 0 && fe.total === 0 && connectsAtB === 1 && agree.agree
      return {
        outcome: mark(ok),
        detail: `vereinigt nach ${nUnion} Runden (Akt dabei ${midState.join('/')}); ${per.map((x) => `${x.d.name}: ${x.rels.entries} Eintrag/Einträge zu M mit ${x.rels.tuples} Tupel(n), Akt ${x.state}, Mediatorbeziehung ${x.resolved ? 'vereinigt' : 'nicht die vereinigte'}, Annahme im Budget ${x.budget ? 'ja' : 'nein'}`).join('; ')}; ${mPer.map((x) => `${x.d.name}: ${x.rels.entries} Eintrag/Einträge zu A`).join(', ')}; Ms Sicht auf dem Kopf: ${viewOnHead} von ${mPer.length}; B verbunden ${connectsAtB}×; Equivokationen ${equivocation}; doppelte Wirkungen ${fe.total}; stabil nach ${n} Runden`,
        measures: { roundsToUnion: nUnion, entriesToMediator: entries, actsConnected: connected, mediatorResolved: per.filter((x) => x.resolved).length, acceptanceInBudget: per.filter((x) => x.budget).length, mediatorViewOnHead: viewOnHead, connectsAtB, equivocations: equivocation, doubleFinalEffects: fe.total + Math.max(0, connectsAtB - 1), roundsToConverge: n },
      }
    },
  },
  {
    id: 'X16',
    title: 'A1 widerruft die Klasse, A2 hält getrennt den alten Vorrat; ein Mediatorgerät mit alter Sicht stellt noch vor, A2 nimmt das Ticket an: nach Entscheidung 4a gilt das Ticket, der Widerruf wirkt ab Ankunft der leeren Revision; nach der Heilung einig, Schlüssel einmal verbraucht, Ms Sicht leer (8535, 8475.S6, 8640.6)',
    async run(c, serial) {
      const s = await setup(c, serial)
      // Die Mediatorgeräte sind weg, bevor die leere Revision ankommt: sie halten die alte Sicht. A2 ist von A1 getrennt (kein Journal).
      for (const d of s.w.of('M')) d.online = false
      const selfA = s.w.selfAddresses('A')
      if (!serial) for (const d of s.w.of('A')) s.w.carrier.faults.withhold(d.name, (f) => selfA.has(f.address))
      await s.A.setClass(s.am, false)
      await s.w.rounds(2)
      const stale = s.w.of('A').map((d) => M.rel(d.state, s.am).stock.filter((k) => k.state === 'active').length)
      // Vorstellung mit alter Sicht (offline): zuerst M2, dann M1 (K1a: jedes Gerät benennt nur seine Schlüssel).
      let r = await s.M2.introduce(s.ma, s.mb)
      if (!('act' in r)) r = await s.Mm.introduce(s.ma, s.mb)
      if (!('act' in r)) return fail(`keine Vorstellung mit alter Sicht: ${r.refused}`)
      const act = r.act
      const named = s.w.of('M').flatMap((d) => d.state.mediatorActs).find((a) => a.id === act)!.a.key
      for (const d of s.w.of('M')) d.online = true
      await s.w.rounds(4)
      const accepted = s.w.of('A').filter((d) => d.state.acts.some((a) => a.id === act)).map((d) => d.name)
      s.w.carrier.faults.reset()
      const n = await untilStable(s.w, 'A')
      // Orakel nach Entscheidung 4a (Anton 18.10.2026): ein Ticket auf einen inzwischen zurückgezogenen Schlüssel gilt; der
      // Widerruf wirkt ab Ankunft der leeren Revision bei M (8535). Nach der Heilung: (a) die A-Geräte einig, (b) der Schlüssel
      // über die Person höchstens einmal verbraucht (genau einmal, wenn ein Gerät das Ticket annahm), (c) der Akt gehört der
      // Person (auf allen Geräten, wenn eines ihn annahm, sonst auf keinem), (d) Ms Sicht auf allen M-Geräten leer (Klasse
      // aus), (e) keine doppelte endgültige Wirkung, (f) keine Equivokation bei M. Die Annahme selbst ist Information.
      const holding = s.w.of('A').filter((d) => d.state.acts.some((a) => a.id === act)).length
      const devices = s.w.of('A').length
      const keyStates = s.w.of('A').map((d) => M.rel(d.state, s.am).stock.find((k) => k.anchor === named)?.state ?? '–')
      const keyState = s.w.of('A').map((d, i) => `${d.name}: ${keyStates[i]}`)
      // Review 21 B2: Annahme-Operationen auf den benannten Schlüssel über alle Akt-Ids (nicht nur die des Akts).
      const ownActs = new Set(s.w.of('A').flatMap((d) => d.state.acts.filter((a) => a.own === named).map((a) => a.id)))
      const acceptLedger = ledger(s.w, 'A')
      const acceptOps = [...ownActs].reduce((sum, id) => sum + (acceptLedger.get(`accept:${id}`)?.size ?? 0), 0)
      const viewKeys = s.w.of('M').map((d) => M.rel(d.state, s.ma).view?.keys.length ?? 0)
      const equivocation = s.w.of('M').flatMap((d) => d.state.findings).filter((f) => f.includes('Equivokation')).length
      const classOn = s.w.of('A').filter((d) => M.rel(d.state, s.am).classOn).length
      const agree = s.w.agree('A')
      const fe = finalEffects(s.w, 'A')
      const acceptedAfterRevocation = accepted.length || holding ? 1 : 0
      const held = holding === devices && acceptOps === 1 && keyStates.every((k) => k === 'consumed')
      const absent = holding === 0 && acceptOps === 0 && keyStates.every((k) => k === 'withdrawn')
      const ok = agree.agree && n > 0 && (held || absent) && viewKeys.every((k) => k === 0) && classOn === 0 && fe.total === 0 && equivocation === 0
      return { outcome: mark(ok), detail: `aktive Schlüssel nach dem Widerruf je Gerät ${stale.join('/')}; Ticket auf den zurückgezogenen Schlüssel angenommen von ${accepted.join(', ') || 'keinem Gerät'} (gilt nach 4a), nach der Heilung auf ${holding} von ${devices} Gerät(en), Annahme-Operationen ${acceptOps}; Schlüssel ${keyState.join(', ')}; Ms Sicht (Schlüssel) ${viewKeys.join('/')}; Klasse an auf ${classOn} Gerät(en); doppelte Wirkungen ${fe.total}; Equivokationen ${equivocation}; Projektion gleich nach ${n} Runden: ${agree.agree ? 'ja' : 'nein'}`, measures: { acceptedAfterRevocation, devicesWithAct: holding, acceptOperations: acceptOps, mediatorViewKeys: Math.max(...viewKeys), equivocations: equivocation, devicesWithClassOn: classOn, doubleFinalEffects: fe.total, projectionAgrees: agree.agree ? 1 : 0, roundsToConverge: n } }
    },
  },
  {
    id: 'X17',
    title: 'A1 und A2 produzieren getrennt je eine Revision (jedes nimmt ein anderes Ticket an und füllt nach): parallele Produktion; mit Schreiberkennung je Beziehung nimmt M beide an, der Vorrat ist die Vereinigung (8500 und 6270 je Schreiber, Entscheidung 3a); gemessen, was M über die Geräte lernt; Probe-Sequenz 6680 nicht modelliert',
    async run(c, serial) {
      const s = await setup(c, serial, ['C'])
      const { mc } = s.thirds.C!
      // Zwei gemeinsame Vorstellungen: drei aktive Schlüssel, die nächste Annahme löst das Nachfüllen aus (8485).
      for (let i = 0; i < 2; i++) {
        await introduceAny(s, s.ma, mc, serial)
        await s.w.rounds(3)
      }
      const rev0 = M.rel(s.A.state, s.am).revision
      // A1 und A2 getrennt; je eine weitere Vorstellung erreicht nur eines der beiden Geräte (seriell beide A1).
      const selfA = s.w.selfAddresses('A')
      const x1 = await framesOf(s, () => introduceAny(s, s.ma, mc, serial))
      const x2 = await framesOf(s, () => introduceAny(s, s.ma, mc, serial))
      if (!('act' in x1.r) || !('act' in x2.r)) return fail('keine zwei weiteren Vorstellungen')
      const hash = (f: { bytes: Uint8Array }) => frameHash(f.bytes)
      if (!serial) {
        for (const d of s.w.of('A')) s.w.carrier.faults.withhold(d.name, (f) => selfA.has(f.address))
        s.w.carrier.faults.withhold(s.A2.name, (f) => x1.frames.has(hash(f)))
        s.w.carrier.faults.withhold(s.A.name, (f) => x2.frames.has(hash(f)))
      }
      await s.w.rounds(4)
      const revs = s.w.of('A').map((d) => M.rel(d.state, s.am).revision)
      s.w.carrier.faults.reset()
      const n = await untilStable(s.w, 'A')
      // Gemessen: eine Revisionsnummer, die mehr als eine Operation der Person erzeugt hat (8500), und was M daraus macht (6270).
      const reused = [...ledger(s.w, 'A').entries()].filter(([id, ops]) => id.startsWith('revision:') && ops.size > 1).length
      const equivocation = s.w.of('M').flatMap((d) => d.state.findings).filter((f) => f.includes('Equivokation') || f.includes('6270')).length
      const secondStock = s.w.of('A').flatMap((d) => d.state.findings).filter((f) => f.includes('8435')).length
      // Review 21 B1: gleicher Anker mit anderem Schlüsselwert, bei A (Vorrat) oder M (Sicht über Schreiber).
      const keyValueConflicts = [...s.w.of('A'), ...s.w.of('M')].flatMap((d) => d.state.findings).filter((f) => f.startsWith('conflict:key-value:')).length
      // Fortschritt danach: eine weitere Vorstellung muss angenommen werden (Ms Sicht darf keinen verbrauchten Schlüssel enthalten).
      const r = await introduceAny(s, s.ma, mc, serial)
      await s.w.rounds(4)
      const progress = 'act' in r && s.w.of('A').every((d) => d.state.acts.some((a) => a.id === r.act)) ? 1 : 0
      const conformance = s.w.of('A').flatMap((d) => d.state.findings).filter((f) => f.includes('8640.12')).length
      const agree = s.w.agree('A')
      const mAgree = s.w.agree('M')
      // Schritt 4: As Schreiber (Kennung → höchste Revision im Zustand) gegen das, was Ms Sicht je Schreiber hält.
      const aWriters = new Map<string, number>()
      for (const d of s.w.of('A')) for (const [t, x] of Object.entries(M.rel(d.state, s.am).writers ?? {})) aWriters.set(t, Math.max(aWriters.get(t) ?? 0, x.revision))
      const mViews = s.w.of('M').map((d) => M.rel(d.state, s.ma).view)
      const accepted = [...aWriters].filter(([t, rev]) => mViews.every((v) => v?.writers?.[t]?.revision === rev)).length
      const seen = writerTagsSeen(s.w, 'M')
      const tagsAtM = seen.perRelationship.get(M.resolveId(s.Mm.state, s.ma))?.size ?? 0
      const tagged = aWriters.size > 0
      const ok = reused === 0 && equivocation === 0 && keyValueConflicts === 0 && progress === 1 && conformance === 0 && agree.agree && mAgree.agree && n > 0 && (!tagged || (accepted === aWriters.size && seen.linked === 0))
      const tagDetail = tagged ? `; Schreiber bei A ${aWriters.size}, davon mit ihrer letzten Revision in Ms Sicht (alle M-Geräte) ${accepted}; Ms Sicht ${mViews.map((v) => `${Object.keys(v?.writers ?? {}).length} Schreiber/${v?.keys.length ?? 0} Schlüssel`).join(', ')}; was M lernt: ${tagsAtM} Schreiberkennung(en) auf der Beziehung zu A, ${[...seen.perRelationship.values()].map((x) => x.size).join('/')} je Beziehung von M, über Beziehungen verknüpfbar ${seen.linked}` : ''
      return { outcome: mark(ok), detail: `Revision vorher ${rev0}, getrennt je Gerät ${revs.join('/')}; Revisionsnummern mit mehr als einer Operation: ${reused}; Befunde 6270 bei M: ${equivocation}; zweiter Vorrat (8435) bei A: ${secondStock}; gleicher Anker mit anderem Wert: ${keyValueConflicts}; nächste Vorstellung ${'act' in r ? (progress ? 'angenommen' : 'nicht angenommen') : 'verweigert'}, Konformitätsfehler bei A: ${conformance}; Projektion gleich nach ${n} Runden: ${agree.agree ? 'ja' : 'nein'}, M-Geräte gleich: ${mAgree.agree ? 'ja' : 'nein'}${tagDetail}; Probe-Sequenz (6680) und Mapping-Revision sind im Prüfstand nicht modelliert`, measures: { revisionNumbersReused: reused, equivocations: equivocation, secondStockFindings: secondStock, keyValueConflicts, progressAfterHeal: progress, mediatorConformanceFailures: conformance, projectionAgrees: agree.agree ? 1 : 0, mediatorDevicesAgree: mAgree.agree ? 1 : 0, roundsToConverge: n, ...(tagged ? { writersAtA: aWriters.size, writersAcceptedByM: accepted, writerTagsSeenByM: tagsAtM, writerTagsLinkedAcrossRelationships: seen.linked } : {}) } }
    },
  },
  {
    id: 'X18',
    title: 'A1 und A2 stimmen getrennt demselben Akt zu und produzieren unabhängig je eine Karte: zwei Karten eines Akts, was B sieht (8325.A4, 8910.7, 8910.8)',
    async run(c, serial) {
      const s = await setup(c, serial)
      const r = await introduceAny(s, s.ma, s.mb, serial)
      if (!('act' in r)) return fail(`Vorstellung verweigert: ${r.refused}`)
      if ((await s.w.until(() => knowsAct(s.w, 'A', r.act) && knowsAct(s.w, 'B', r.act), 10)) < 0) return fail('Akt nicht bei A und B')
      // A1 und A2 getrennt (kein Journal): beide stimmen zu, jedes produziert seine Karte; seriell stimmt A1 zweimal zu (das zweite Mal ein Befund, keine Karte).
      const selfA = s.w.selfAddresses('A')
      if (!serial) for (const d of s.w.of('A')) s.w.carrier.faults.withhold(d.name, (f) => selfA.has(f.address))
      await s.A.consent(r.act)
      await s.A2.consent(r.act)
      await s.B.consent(r.act)
      await s.w.rounds(4)
      s.w.carrier.faults.reset()
      await s.w.until(() => [...s.w.of('A'), ...s.w.of('B')].every((d) => M.act(d.state, r.act).state === 'connected'), 15)
      const nA = await untilStable(s.w, 'A')
      const nB = await untilStable(s.w, 'B')
      // A: Karten-Dokumente des Akts (eigene Absichten je Gerät), Zustimmungen; B: Verbindungen, Kartenwerte, Konfliktmarke K.
      const cards = new Set(s.w.of('A').flatMap((d) => [...d.intents.values()]).filter((i) => i.kind.includes('introduction-card') && s.w.of('A').some((d) => d.state.acts.some((a) => a.id === r.act && a.voucher.keyAgreement === i.address))).map((i) => i.digest)).size
      const cardKeys = new Set(s.w.of('A').map((d) => M.act(d.state, r.act).ownCard?.anchor).filter(Boolean)).size
      const consents = ledger(s.w, 'A').get(`consent:${r.act}`)?.size ?? 0
      const connectsA = ledger(s.w, 'A').get(`connect:${r.act}`)?.size ?? 0
      const connectsAtB = ledger(s.w, 'B').get(`connect:${r.act}`)?.size ?? 0
      const conflicts = s.w.of('B').filter((d) => M.act(d.state, r.act).k).length
      const cardsAtB = s.w.of('B').map((d) => d.log.filter((e) => e.type === 'introduction-card').length)
      const tuplesAtB = s.w.of('B').map((d) => d.state.relationships.filter((x) => x.tuples.some((t) => t.id.includes(r.act))).length)
      const agree = s.w.agree('A')
      // Welche Übergabe der Akt trägt (8326: der Digest des Kartendokuments): verschiedene Digests heißen, die Geräte sind uneins.
      const handOvers = new Set(s.w.of('A').map((d) => M.act(d.state, r.act).ownCardDigest)).size
      const states = [...s.w.of('A'), ...s.w.of('B')].map((d) => `${d.name}: ${M.act(d.state, r.act).state}`)
      // Endwirkungen beider Personen über das gemeinsame Ledger-Orakel (Review 11 B1): eine Effekt-Id aus mehr als einer Operation ist doppelt, unabhängig davon, ob die Projektionen gleich sind.
      const feA = finalEffects(s.w, 'A')
      const feB = finalEffects(s.w, 'B')
      const kindsA = [...new Set(feA.doubleIds.map((id) => id.split(':')[0]!))].sort().join(', ')
      const doubles = feA.total + feB.total
      const ok = nA > 0 && nB > 0 && doubles === 0 && connectsAtB === 1 && conflicts === 0 && tuplesAtB.every((x) => x === 1) && agree.agree && states.every((x) => x.endsWith('connected'))
      // K1a Schritt 3: zwei Geräte haben je zugestimmt (Zustimmungen von zwei Schreibern im Akt). Dass das eine Wirkung ist
      // (Regel 1) und die kleinere Übergabe gewinnt (Regel 3), ist eine Ersatzregel für 8325.A4: „Zusage geändert“.
      const writers = new Set((M.act(s.A.state, r.act).decisions ?? []).filter((d) => d.kind === 'consent').map((d) => d.op.split('#')[0])).size
      const promiseChanged = ok && writers > 1
      const cardsOut = cardFramesOut(s.w, 'A', r.act)
      const reasons = [doubles > 0 ? `doppelte Endwirkungen (A ${feA.total}${kindsA ? `: ${kindsA}` : ''}, B ${feB.total})` : '', !agree.agree ? 'die Projektionen von A bleiben verschieden' : ''].filter(Boolean)
      return { outcome: mark(ok), promiseChanged, detail: `${writers > 1 ? 'Regeln 1 und 3: zwei Zustimmungen, eine Wirkung, die kleinere Übergabe gewinnt; ' : ''}${states.join(', ')}; A: ${cards} Karten-Dokument(e), davon ${cardsOut} beim Träger, ${cardKeys} Kartenschlüssel, Zustimmung aus ${consents} Operation(en) von ${writers} Gerät(en), Verbindung aus ${connectsA} Operation(en); doppelte Endwirkungen bei A: ${feA.total}${kindsA ? ` (${kindsA} je aus zwei Operationen)` : ''}, bei B: ${feB.total}; B: Karten empfangen ${cardsAtB.join('/')}, verbunden ${connectsAtB}×, Konfliktmarke K auf ${conflicts} Gerät(en), Tupel des Akts je Gerät ${tuplesAtB.join('/')}; Übergabe-Digests des Akts auf den A-Geräten: ${handOvers}; A stabil gleich nach ${nA} Runden: ${agree.agree ? 'ja' : 'nein'}, B nach ${nB}${reasons.length ? `; nicht bestanden wegen: ${reasons.join('; ')}` : ''}`, measures: { cardsProducedByA: cards, cardFramesToB: cardsOut, consentWriters: writers, promiseChanged: promiseChanged ? 1 : 0, cardKeys, consentOperations: consents, connectOperationsA: connectsA, connectsAtB, cardConflictsAtB: conflicts, doubleFinalEffects: doubles, doubleFinalEffectsA: feA.total, doubleFinalEffectsB: feB.total, doubleEffectKindsA: kindsA || '–', handOverDigestsOnA: handOvers, projectionAgrees: agree.agree ? 1 : 0, roundsToConverge: nA } }
    },
  },
  {
    id: 'X21',
    title: 'Journal doppelt, umgeordnet, unvollständig: abgeschlossene Batches nach altem und doppeltem Restore, gleichzeitige Anfragen, Absturz vor und nach dem Commit; Verlust von Anfrage, Antwort, Batches allein (Antwortkopf zugestellt) und Quittung je über 12 Runden; Ende erst ohne ausstehendes Nachholen (HSC-440, Reviews 9 und 11)',
    async run(c, serial) {
      if (serial) return na('ein Gerät: kein Journal zwischen Geräten')
      const s = await setup(c, serial, ['C'])
      const { C, mc } = s.thirds.C!
      const self = (await s.A.cand.keys.pair('self/A')).rkid // die Ablage (Schritt 6) liegt an dieser Adresse
      const selves = s.w.selfAddresses('A') // K2: eine Self-Adresse je Gerät
      const oldA2 = s.w.stores.get('A2')!.snapshot() // A2 vor beiden Akten
      // Fachlicher Verlauf: ein Akt mit Zustimmung auf A1, einer mit Zustimmung auf A2 (A2s eigene Batches stehen danach nur noch in A1s Journal).
      const acts: string[] = []
      for (const [other, dev, peer] of [[mc, s.A, C], [s.mb, s.A2, s.B]] as const) {
        const r = await introduceAny(s, s.ma, other, serial)
        if (!('act' in r)) return fail(`Vorstellung verweigert: ${r.refused}`)
        acts.push(r.act)
        if ((await s.w.until(() => knowsAct(s.w, 'A', r.act), 10)) < 0) return fail('Akt nicht auf beiden Geräten')
        await dev.consent(r.act)
        await peer.consent(r.act)
        await s.w.until(() => s.w.of('A').every((d) => M.act(d.state, r.act).state === 'connected'), 15)
      }
      await s.w.rounds(4)
      const ref = M.canonical(s.A.projection())
      const before = s.w.of('A').map(journalOf)
      const start = s.w.carrier.carried.length
      const reads0 = s.w.carrier.logReads.length
      const req0 = s.w.of('A').reduce((n, d) => n + d.syncRequests, 0)
      const lreq0 = s.w.of('A').reduce((n, d) => n + d.logRequests, 0)
      const restoreA2 = async () => {
        s.w.stores.get('A2')!.restore(oldA2)
        await s.A2.reload()
      }
      const behind = () => (missingBatches(s.w, 'A') ?? 0) > 0 || M.canonical(s.A2.projection()) !== ref ? 1 : 0
      // Phase 1: A2 aus dem alten Abbild, A1 startet zugleich neu (zwei gleichzeitige Anfragen), Umordnung und Duplikate an;
      // nach zwei Runden A2 noch einmal aus demselben Abbild (doppelter Restore), dann stürzen A2 vor und A1 nach dem Commit je einmal ab.
      s.w.carrier.faults.reverse(true)
      s.w.carrier.faults.duplicate(true)
      await restoreA2()
      await s.A.reload()
      await s.w.rounds(2)
      await restoreA2()
      s.A2.crashAt = 'before-commit'
      s.A.crashAt = 'after-commit' // A1 hat die Rahmen der Runde angewandt und committet, aber am Träger nicht bestätigt
      await s.w.rounds(1)
      const crashed = s.A2.crashes.length + s.A.crashes.length
      if (s.A2.crashes.length) await s.A2.reload()
      if (s.A.crashes.length) await s.A.reload()
      // Je Phase nach der Reparatur (Review 11 S2): fehlende Batch-Schlüssel und Geräte, deren Projektion nicht die Referenz ist.
      const settled = () => ({ missing: missingBatches(s.w, 'A') ?? -1, lost: s.w.of('A').filter((d) => M.canonical(d.projection()) !== ref).length })
      const restore = await untilStable(s.w, 'A', 40)
      const afterRestore = settled()
      s.w.carrier.faults.reset()
      // Phasen 2–5: je ein frischer Restore von A2, dann 15 Runden Verlust einer Art auf der Self-Adresse, dann ohne Fachoperation weiter.
      // Schritt 6 (Ablage an der Self-Adresse): Anfrage und Antwort gehen an den Träger, nicht als Rahmen an die Schwester;
      // die Verlustphasen treffen dort dieselben Dinge (Anfrage, ganze Antwort, nur die Batches bei zugestellter Antwort).
      const loss = async (match: (o: { device: string; kind: string }) => boolean, log?: () => void) => {
        await restoreA2()
        s.w.carrier.faults.drop((f) => {
          const o = selves.has(f.address) ? s.w.frameOrigin(f.bytes) : undefined
          return !!o && match(o)
        })
        if (s.w.selfLog) log?.()
        await s.w.rounds(15)
        const b = behind()
        s.w.carrier.faults.reset()
        const rounds = await untilStable(s.w, 'A', 40)
        return { behind: b, rounds, ...settled() }
      }
      const lf = s.w.carrier.logFaults
      const requests = await loss((o) => o.device === 'A2' && o.kind === 'journal-sync', () => lf.dropRequest((d) => d === 'A2'))
      const answers = await loss((o) => o.device !== 'A2' && (o.kind === 'journal' || o.kind === 'journal-sync-reply'), () => lf.dropAnswer((d) => d === 'A2'))
      // Nur die benötigten Batches gehen verloren (A1s Journalrahmen an A2); Antwortkopf und Quittungen passieren (Review 11 S2).
      const batches = await loss((o) => o.device !== 'A2' && o.kind === 'journal', () => lf.dropEntries((d, e) => d === 'A2' && s.w.frameOrigin(e.bytes)?.kind === 'journal' && s.w.frameOrigin(e.bytes)?.device !== 'A2'))
      const receipts = await loss((o) => o.kind === 'delivery-ack')
      const repair = await untilRepaired(s.w, 'A', selves)
      const quiet = repair.rounds
      // Messung: Endstand und der ganze Reparaturverkehr seit dem ersten Restore.
      const missing = missingBatches(s.w, 'A')
      const lostState = s.w.of('A').filter((d) => M.canonical(d.projection()) !== ref).length
      const fe = finalEffects(s.w, 'A')
      const journalConflicts = s.w.of('A').flatMap((d) => d.state.findings).filter((f) => f.includes('Journal-Konflikt')).length
      const t = s.w.deposits('A', selves, start)
      const k = (kind: string) => t.byKind[`own:${kind}`] ?? { frames: 0, bytes: 0 }
      const answersBy = (d: string) => (t.byDevice[d]?.['journal'] ?? 0) + (t.byDevice[d]?.['journal-sync-reply'] ?? 0)
      const after = s.w.of('A').map(journalOf)
      const phases = [restore, requests.rounds, answers.rounds, batches.rounds, receipts.rounds]
      const perPhase = { Restore: afterRestore, RequestLoss: requests, AnswerLoss: answers, JournalLoss: batches, ReceiptLoss: receipts }
      const measures: Record<string, number> = {
        repairRoundsRestore: restore,
        repairRoundsRequestLoss: requests.rounds,
        repairRoundsAnswerLoss: answers.rounds,
        repairRoundsJournalLoss: batches.rounds,
        repairRoundsReceiptLoss: receipts.rounds,
        behindAfterRequestLoss: requests.behind,
        behindAfterAnswerLoss: answers.behind,
        behindAfterJournalLoss: batches.behind,
        behindAfterReceiptLoss: receipts.behind,
        roundsUntilQuiet: quiet,
        quietWindow: repair.window,
        devicesPendingSync: repair.pending.length,
        selfFramesUntilQuiet: repair.selfFrames,
        devicesWithLostState: lostState,
        doubleFinalEffects: fe.doubles + fe.doubleConsumption,
        remainingConflicts: fe.contradictions + journalConflicts,
        ownFrames: t.own.frames,
        ownBytes: t.own.bytes,
        journalFrames: k('journal').frames,
        journalBytes: k('journal').bytes,
        syncRequestFrames: k('journal-sync').frames,
        syncReplyFrames: k('journal-sync-reply').frames,
        ackFrames: k('delivery-ack').frames,
        repeatedDeposits: t.repeats,
        repeatedDepositsOwn: t.repeatsOwn,
        repeatedDepositsToCounterpart: t.repeatsToPeer,
        answersA1: answersBy('A1'),
        answersA2: answersBy('A2'),
        framesToCounterpart: t.toPeer.frames,
        bytesToCounterpart: t.toPeer.bytes,
        syncRequests: s.w.of('A').reduce((n, d) => n + d.syncRequests, 0) - req0,
        crashes: crashed,
      }
      if (missing !== null) measures.missingBatches = missing
      // Schritt 6: Leseanfragen der A-Geräte an den Dienst seit dem ersten Restore (gesendet), davon beim Träger
      // angekommen; was der Träger abgeschickt hat und was beim Gerät ankam, samt Anfrage- und Kopfbytes (Review 25 S3).
      if (s.w.selfLog) {
        const reads = s.w.carrier.logReads.slice(reads0).filter((r) => r.address === self)
        measures.logRequests = s.w.of('A').reduce((n, d) => n + d.logRequests, 0) - lreq0
        measures.answersService = reads.length
        measures.serviceEntriesSent = reads.reduce((n, r) => n + r.entries, 0)
        measures.serviceBytesSent = reads.reduce((n, r) => n + r.bytes, 0)
        measures.serviceEntriesServed = reads.reduce((n, r) => n + r.servedEntries, 0)
        measures.serviceBytesServed = reads.reduce((n, r) => n + r.servedBytes, 0)
        measures.serviceRequestBytes = reads.reduce((n, r) => n + r.requestBytes, 0)
        measures.serviceHeadBytes = reads.reduce((n, r) => n + r.headBytes, 0)
        measures.logEntries = s.w.carrier.log(self).length
        measures.logBytes = s.w.carrier.log(self).reduce((n, e) => n + e.bytes.length, 0)
      }
      for (const [k, v] of Object.entries(perPhase)) {
        measures[`missingBatchesAfter${k}`] = v.missing
        measures[`lostStateAfter${k}`] = v.lost
      }
      const phasesClean = Object.values(perPhase).every((v) => v.missing === 0 && v.lost === 0)
      if (before.every(Boolean) && after.every(Boolean)) {
        measures.journalBatchesBefore = Math.max(...before.map((j) => j!.batches))
        measures.journalBatchesAfter = Math.max(...after.map((j) => j!.batches))
        measures.journalBytesBefore = Math.max(...before.map((j) => j!.bytes))
        measures.journalBytesAfter = Math.max(...after.map((j) => j!.bytes))
      }
      const repaired = quiet >= 0 && repair.pending.length === 0 && repair.window > MAX_REREQUEST
      const ok = missing === 0 && phasesClean && phases.every((n) => n > 0) && requests.behind === 1 && answers.behind === 1 && batches.behind === 1 && lostState === 0 && measures.doubleFinalEffects === 0 && measures.remainingConflicts === 0 && repaired
      const end = repaired
        ? `Reparatur beendet: kein Gerät mit ausstehendem Nachholen, still ab Runde ${quiet} über ${repair.window} Runden (größter Wiederanfrageabstand ${MAX_REREQUEST})`
        : `Reparatur nicht beendet: nach 60 Runden Nachholen ausstehend auf ${repair.pending.join(', ') || 'keinem Gerät'}, ${repair.selfFrames} Self-Rahmen in dieser Zeit, zuletzt still über ${repair.window} Runden`
      return {
        outcome: mark(ok),
        detail: `Reparatur in Runden: Restore ${restore}, Anfrageverlust ${requests.rounds}, Antwortverlust ${answers.rounds}, Batchverlust bei zugestelltem Antwortkopf ${batches.rounds}, Quittungsverlust ${receipts.rounds} (zurück nach dem Verlust: ${[requests.behind, answers.behind, batches.behind, receipts.behind].join('/')}); je Phase danach fehlende Batches ${Object.values(perPhase).map((v) => v.missing).join('/')}, Geräte nicht auf der Referenz ${Object.values(perPhase).map((v) => v.lost).join('/')}; ${end}; fehlende Batches ${missing ?? 'nicht messbar (kein Nachholen)'}; Geräte mit anderem Stand als vorher ${lostState}; doppelte Wirkungen ${measures.doubleFinalEffects}, Konflikte ${measures.remainingConflicts}; Self-Adresse ${t.own.frames} Rahmen / ${t.own.bytes} B (Journal ${k('journal').frames}/${k('journal').bytes} B, Anfragen ${k('journal-sync').frames}, Antworten ${k('journal-sync-reply').frames}, Quittungen ${k('delivery-ack').frames}); Wiederholungen ${t.repeats}: ${t.repeatsOwn} auf der Self-Adresse, ${t.repeatsToPeer} an Gegenseiten; Antworten A1 ${answersBy('A1')}, A2 ${answersBy('A2')}${s.w.selfLog ? `, Dienst: ${measures.logRequests} Leseanfragen, ${measures.answersService} beim Träger, abgeschickt ${measures.serviceEntriesSent} Einträge / ${measures.serviceBytesSent} B, angekommen ${measures.serviceEntriesServed} / ${measures.serviceBytesServed} B, Anfragen ${measures.serviceRequestBytes} B, Köpfe ${measures.serviceHeadBytes} B; Ablage ${measures.logEntries} Einträge, ${measures.logBytes} B` : ''}; an Gegenseiten ${t.toPeer.frames} Rahmen; Journal ${measures.journalBatchesBefore ?? '–'} → ${measures.journalBatchesAfter ?? '–'} Batches`,
        measures,
      }
    },
  },
]

// ── Schritt 6 (Variante „Journal beim Dienst“): Messungen außerhalb der Matrix ──────────────────────────────

/**
 * Was der Dienst an einer Ablage lernt (Plan Abschnitt 5, „was der Träger lernt“; Review 25 (f)): Zahl und Größen der
 * behaltenen Einträge samt Größenmuster (häufigste Größen), ihre Einlieferungszeiten, wer abholt (registrierte Geräte),
 * und je Leser: Leseanfragen, gelesene Positionen (Cursor), Lesezeitpunkte und Rückstand beim Lesen (Einträge ab dem
 * Cursor). Getrennt: abgeschickt, angekommen, Anfrage- und Kopfbytes (S3). Der Dienst sieht nur versiegelte Bytes; Art
 * (Journal, Quittung) unterscheidet er nicht, die Spalte `kinds` ist Weltwissen.
 */
export function serviceLearns(w: Welt15, address: string) {
  const log = w.carrier.log(address)
  const sizes = log.map((e) => e.bytes.length).sort((a, b) => a - b)
  const reads = w.carrier.logReads.filter((r) => r.address === address)
  const kinds: Record<string, { entries: number; bytes: number }> = {}
  for (const e of log) {
    const k = (kinds[w.frameOrigin(e.bytes)?.kind ?? 'unknown'] ??= { entries: 0, bytes: 0 })
    k.entries++
    k.bytes += e.bytes.length
  }
  return {
    entries: log.length,
    bytes: sizes.reduce((n, x) => n + x, 0),
    sizeMin: sizes[0] ?? 0,
    sizeMedian: sizes[Math.floor(sizes.length / 2)] ?? 0,
    sizeMax: sizes[sizes.length - 1] ?? 0,
    distinctTimes: new Set(log.map((e) => e.at)).size,
    firstAt: log[0]?.at ?? '',
    lastAt: log[log.length - 1]?.at ?? '',
    reads: reads.length,
    readers: [...new Set(reads.map((r) => r.device))].sort(),
    entriesSent: reads.reduce((n, r) => n + r.entries, 0),
    bytesSent: reads.reduce((n, r) => n + r.bytes, 0),
    entriesServed: reads.reduce((n, r) => n + r.servedEntries, 0),
    bytesServed: reads.reduce((n, r) => n + r.servedBytes, 0),
    requestBytes: reads.reduce((n, r) => n + r.requestBytes, 0),
    headBytes: reads.reduce((n, r) => n + r.headBytes, 0),
    perReader: Object.fromEntries(
      [...new Set(reads.map((r) => r.device))].sort().map((d) => {
        const rs = reads.filter((r) => r.device === d)
        return [d, { reads: rs.length, cursors: rs.map((r) => r.from), times: rs.map((r) => r.at), backlog: rs.map((r) => r.entries) }]
      }),
    ),
    sizePattern: (() => {
      const c = new Map<number, number>()
      for (const x of sizes) c.set(x, (c.get(x) ?? 0) + 1)
      return { distinct: c.size, top: [...c.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 5) }
    })(),
    collectors: w.carrier.registeredAt(address),
    kinds,
  }
}

interface JournalBatch {
  writer: string
  n: number
  ops: Array<{ at: string }>
  intents: Array<{ digest: string; kind: string }>
}

/**
 * Wachstum (Schritt 6, nur Zahlen, keine Kompaktierung): Langlauf mit periodischen Akten. A, B, M mit je zwei Geräten,
 * vier weitere Gegenpersonen C0–C3 an M; jede Runde rückt die Uhr um `stepMs` vor; alle `every` Runden stellt M A einer
 * Gegenperson vor (reihum), ein A-Gerät (abwechselnd) und die Gegenperson stimmen zu, sobald beide den Akt kennen; alle
 * 50 Runden bestätigt A1 das Budget (8515). Gemessen: Journal (Batches, Bytes, davon Operationen und Absichten) und
 * Ablage (Einträge, Bytes) über die Zeit, und was davon entfernbar wäre: Absichten zugestellter oder zurückgenommener
 * Dokumente, Batches, die jedes Gerät der Person kennt (unter dem kleinsten Kopf), Batches älter als das längste Fenster
 * (28 Tage, 8510).
 */
export async function journalGrowth(candidate: MultiDeviceCandidate, opts: { rounds?: number; every?: number; stepMs?: number; sample?: number; lose?: { round: number } } = {}) {
  const rounds = opts.rounds ?? 200
  const every = opts.every ?? 10
  const stepMs = opts.stepMs ?? 4 * 3600 * 1000
  const sample = opts.sample ?? 20
  const names = ['C0', 'C1', 'C2', 'C3']
  const s = await setup(candidate, false, names)
  const self = (await s.A.cand.keys.pair('self/A')).rkid
  const open: Array<{ act: string; C: HolderDevice; dev: HolderDevice }> = []
  let issued = 0
  let connected = 0
  const journal = (d: HolderDevice) => ((d.cand as { journal?: () => JournalBatch[] }).journal?.() ?? []) as JournalBatch[]
  const size = (x: unknown) => Buffer.byteLength(JSON.stringify(x), 'utf8')
  const series: Array<{ round: number; at: string; batches: number; journalBytes: number; logEntries: number; logBytes: number }> = []
  const acts: string[] = []
  for (let i = 1; i <= rounds; i++) {
    s.w.clock.advance(stepMs)
    if (opts.lose && i === opts.lose.round) s.A2.online = false // A2 verloren: offline, nicht widerrufen (Review 25 S1)
    if (i % every === 0) {
      const k = (i / every) % names.length
      const c = s.thirds[names[k]!]!
      const r = await introduceAny(s, s.ma, c.mc, false)
      if ('act' in r) {
        issued++
        acts.push(r.act)
        open.push({ act: r.act, C: c.C, dev: (i / every) % 2 || !s.A2.online ? s.A : s.A2 })
      }
    }
    if (i % 50 === 0) await s.A.confirmBudget(s.am)
    for (const o of open.slice()) {
      if (!s.w.of('A').filter((d) => d.online).every((d) => d.state.acts.some((a) => a.id === o.act)) || !o.C.state.acts.some((a) => a.id === o.act)) continue
      await o.dev.consent(o.act)
      await o.C.consent(o.act)
      open.splice(open.indexOf(o), 1)
    }
    await s.w.rounds(1)
    if (i % sample === 0) {
      const j = journal(s.A)
      const log = s.w.carrier.log(self)
      series.push({ round: i, at: s.w.clock.now(), batches: j.length, journalBytes: j.reduce((n, b) => n + size(b), 0), logEntries: log.length, logBytes: log.reduce((n, e) => n + e.bytes.length, 0) })
    }
  }
  await s.w.rounds(5)
  for (const a of acts) if (s.w.of('A').filter((d) => d.online).every((d) => d.state.acts.find((x) => x.id === a)?.state === 'connected')) connected++
  const ds = s.w.of('A')
  const j = journal(s.A)
  const heads = ds.map((d) => d.cand.heads?.() ?? {})
  const now = Date.parse(s.w.clock.now())
  const window = M.PARAM.budgetWindowMs
  /**
   * Review 25 S1: entfernbar ist eine Absicht nur, wenn sie erledigt ist UND jedes Gerät der festen Geräteliste ihren
   * Batch gefaltet hat (kleinster Kopf über alle Geräte). Ein verlorenes, nicht widerrufenes Gerät blockiert: „jetzt“
   * zählt es mit, „wenn widerrufen“ ohne die verlorenen (offline) Geräte.
   */
  const live = ds.filter((d) => d.online)
  const liveHeads = live.map((d) => d.cand.heads?.() ?? {})
  const foldedBy = (hs: Array<Record<string, number>>, b: JournalBatch) => hs.every((h) => (h[b.writer] ?? 0) >= b.n)
  /** Erledigt: zugestellt (Quittung) auf einem Gerät, Karte zurückgenommen oder zugestellt, Mapping vereinigt. */
  const done = (digest: string) => {
    for (const d of ds) {
      if (d.zusteller.report(digest)?.state === 'delivered') return true
      for (const a of d.state.acts) {
        const o = a.cards?.[digest]
        if (o === 'delivered' || o === 'cancelled') return true
      }
      if (d.state.duties.some((x) => x.mappingDigest === digest && x.state === 'united')) return true
    }
    return false
  }
  let ops = 0
  let intents = 0
  let total = 0
  let removableIntents = 0
  let removableIntentCount = 0
  let doneIntents = 0
  let removableIfRevoked = 0
  let removableIfRevokedBytes = 0
  let belowLive = 0
  let belowLiveBytes = 0
  let belowMin = 0
  let belowMinBytes = 0
  let old = 0
  let oldBytes = 0
  let intentCount = 0
  for (const b of j) {
    const sz = size(b)
    total += sz
    ops += size(b.ops)
    intents += size(b.intents)
    for (const it of b.intents) {
      intentCount++
      if (!done(it.digest)) continue
      doneIntents++
      if (foldedBy(heads, b)) {
        removableIntentCount++
        removableIntents += size(it)
      }
      if (foldedBy(liveHeads, b)) {
        removableIfRevoked++
        removableIfRevokedBytes += size(it)
      }
    }
    if (foldedBy(heads, b)) {
      belowMin++
      belowMinBytes += sz
    }
    if (foldedBy(liveHeads, b)) {
      belowLive++
      belowLiveBytes += sz
    }
    const at = Math.max(0, ...b.ops.map((o) => Date.parse(o.at)))
    if (at > 0 && at < now - window) {
      old++
      oldBytes += sz
    }
  }
  const log = s.w.carrier.log(self)
  return {
    rounds,
    days: (rounds * stepMs) / (24 * 3600 * 1000),
    issued,
    connected,
    blocked: ds.reduce((n, d) => n + d.measures.blocked, 0),
    agree: s.w.agree('A').agree,
    batches: j.length,
    journalBytes: total,
    opsBytes: ops,
    intentBytes: intents,
    intents: intentCount,
    devices: ds.map((d) => d.name),
    lost: ds.filter((d) => !d.online).map((d) => d.name),
    doneIntents,
    removableIntents: removableIntentCount,
    removableIntentBytes: removableIntents,
    removableIntentsIfLostRevoked: removableIfRevoked,
    removableIntentBytesIfLostRevoked: removableIfRevokedBytes,
    batchesBelowLiveHead: belowLive,
    bytesBelowLiveHead: belowLiveBytes,
    batchesBelowMinHead: belowMin,
    bytesBelowMinHead: belowMinBytes,
    batchesOlderThanWindow: old,
    bytesOlderThanWindow: oldBytes,
    logEntries: log.length,
    logBytes: log.reduce((n, e) => n + e.bytes.length, 0),
    service: serviceLearns(s.w, self),
    series,
  }
}

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
