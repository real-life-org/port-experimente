// E15 K2 Schritt 2 (Plan 6r): Orakel und Messungen für Gerätemengen (`device-set@1`). Das Ankerpaar-Orakel für X18 (Astra,
// Design-Review 6q, 5a), das Zeitmodell X23, das Diebesfenster X9, der Rotationsverkehr beim Widerruf und der Fan-out des
// Enrollments. Alle Messungen laufen über die gemeinsame Welt (welt.ts) und lesen nur Zustand, Protokolle und den Träger.

import { digestBytes, jcs, receive, seal } from '@real-life/trust-protocol'
import type { Json } from '@real-life/trust-protocol'
import type { HolderDevice, MultiDeviceCandidate } from './holder'
import * as M from './model'
import { Welt15 } from './welt'

const enc = new TextEncoder()
const DAY = 24 * 3600 * 1000

/** Die Tupel einer Person für einen Akt, je Gerät (8905: `<Person>:act:<Akt>`). */
const actTuples = (w: Welt15, person: string, act: string) => w.of(person).map((d) => ({ d, t: d.state.relationships.flatMap((r) => r.tuples).find((x) => x.id === `${person}:act:${act}`) }))

/**
 * Ankerpaar-Orakel (X18, Design-Review 6q 5a): (1) alle ehrlichen Geräte einer Person halten dasselbe Tupel des Akts; As
 * eigener Anker ist Bs Gegenanker und umgekehrt, samt Vereinbarungsschlüsseln (die Karten beider Seiten); (2) jedes Mitglied,
 * an das die Gegenseite für diese Wurzel versiegelt (ohne Nachweis die Wurzel allein), öffnet einen tatsächlich versiegelten
 * Rahmen auf einem Gerät der Person, das den privaten Schlüssel hält; (3) die Kartenidentität: V der Gegenseite ist der
 * Nutzlastdigest der eigenen Karte (8910.0).
 */
export async function anchorPairOracle(w: Welt15, pa: string, pb: string, act: string): Promise<{ pairsAgree: boolean; decrypt: boolean; cardIdentity: boolean }> {
  const A = actTuples(w, pa, act)
  const B = actTuples(w, pb, act)
  const same = (xs: typeof A) => xs.every(({ t }) => t && M.canonical({ own: t.own, peer: t.peer, ka: t.peerKeyAgreement, ownKey: t.ownKey }) === M.canonical({ own: xs[0]!.t!.own, peer: xs[0]!.t!.peer, ka: xs[0]!.t!.peerKeyAgreement, ownKey: xs[0]!.t!.ownKey }))
  if (!A.length || !B.length || !same(A) || !same(B)) return { pairsAgree: false, decrypt: false, cardIdentity: false }
  const ta = A[0]!.t!
  const tb = B[0]!.t!
  const ca = M.act(A[0]!.d.state, act).ownCard
  const cb = M.act(B[0]!.d.state, act).ownCard
  const pairsAgree = !!ca && !!cb && ta.own === tb.peer && tb.own === ta.peer && ta.own === ca.anchor && tb.own === cb.anchor && ta.peerKeyAgreement === cb.keyAgreement && tb.peerKeyAgreement === ca.keyAgreement
  const opens = async (viewer: HolderDevice, root: string, rootKa: string, owners: HolderDevice[], ctx: string) => {
    const set = viewer.setOf(root)
    const targets = set ? M.setView(set).members.map((m) => m.keyAgreement) : [rootKa]
    if (!targets.length) return false
    for (const rkid of targets) {
      const env = await seal({ id: crypto.randomUUID(), type: 'probe' } as unknown as Json, rkid)
      let opened = false
      for (const d of owners) {
        const k = await d.cand.keys.pair(ctx)
        if (k.rkid !== rkid) continue
        const v = await receive(env, (x: string) => (x === k.rkid ? k.x.priv : undefined), new Set())
        if (v.disposition === 'unique') opened = true
      }
      if (!opened) return false
    }
    return true
  }
  const decrypt = (await opens(B[0]!.d, tb.peer, tb.peerKeyAgreement, w.of(pa), ta.ownKey)) && (await opens(A[0]!.d, ta.peer, ta.peerKeyAgreement, w.of(pb), tb.ownKey))
  const v = async (card: M.Card) => digestBytes(enc.encode(jcs({ act, card })))
  const cardIdentity = !!ca && !!cb && M.act(B[0]!.d.state, act).v === (await v(ca)) && M.act(A[0]!.d.state, act).v === (await v(cb))
  return { pairsAgree, decrypt, cardIdentity }
}

/** Gemeinsame kleine Welt: A (zwei Geräte), M (zwei Geräte), Klasse an; dazu `thirds` Gegenpersonen mit Beziehung zu M. */
async function base(candidate: MultiDeviceCandidate, thirds: string[] = [], stepMs = 0) {
  const w = new Welt15(candidate)
  const A = await w.person('A', 'A1')
  const Mm = await w.person('M', 'M1')
  const am = await w.encounter(A, Mm)
  await w.rounds(2)
  await A.setClass(am.x.id, true)
  await w.rounds(2)
  const cs: Array<{ C: HolderDevice; cm: string; mc: string }> = []
  for (const n of thirds) {
    const C = await w.person(n, `${n}1`)
    const cm = await w.encounter(C, Mm)
    await w.rounds(1)
    await C.setClass(cm.x.id, true)
    await w.rounds(2)
    cs.push({ C, cm: cm.x.id, mc: cm.y.id })
  }
  const A2 = await w.enrol(A, 'A2')
  const M2 = await w.enrol(Mm, 'M2')
  for (let i = 0; i < 3; i++) {
    if (stepMs) w.clock.advance(stepMs)
    await w.rounds(1)
  }
  const introduce = async (other: string) => {
    const r = await Mm.introduce(am.y.id, other)
    return 'act' in r ? r : M2.introduce(am.y.id, other)
  }
  return { w, A, A2, Mm, M2, am, cs, introduce }
}

/** Ursache einer verlorenen Vorstellung in X23, aus Messungen (Review 33 S2), nie aus dem Ergebnis erschlossen. */
export type X23Cause = 'expired-unseen-8155' | 'card-not-produced-8110.5' | 'card-produced-not-connected'
/** Beleg je verlorener Vorstellung (Tage seit Beginn; Online-Schritte = Schritte, in denen das Gerät online war). */
export interface X23Loss {
  act: string
  cause: X23Cause
  /** Gerät, dessen Vorrats-Schlüssel M benannt hat (K2: Zuteiler und, strict, einziger Halter); K1a: die Person. */
  holder: string
  issuedDay: number
  /** Consent-Schnitt 8155 (Aktablauf − Reserve) und Annahmeende 8110.5 (Aktablauf). */
  cutoffDay: number
  expiresDay: number
  /** Erstes Gerät der Person, das den Akt vor dem Schnitt hielt, und wann; null = nie. */
  seenDay: number | null
  consentedDay: number | null
  /** Wann der Zuteiler die Karte erzeugte (eigene Karte im Zustand des Zuteilers); null = nie. */
  producedDay: number | null
  /** Schritte zwischen Ausstellung und Schnitt, in denen der Halter online war und ein in dieser Runde empfangenes Ticket vor dem Schnitt noch hätte zeigen können (8155-Beleg). */
  holderOnlineStepsBeforeCutoff: number
  /** Schritte zwischen Zustimmung und Annahmeende, in denen der Zuteiler online war (8110.5-Beleg). */
  allocatorOnlineStepsBeforeExpiry: number
  /** Gemessene Offline-Fenster des Halters (Tage). */
  holderOffline: Array<[number, number | null]>
}
/** Beleg je Verweigerung durch M: Grund und Ms Vorrat je Seite und M-Gerät in dem Moment (`stockAt`). */
export interface X23Refusal {
  day: number
  reason: string
  stock: Record<'A' | 'C', Record<string, { listed: number; usable: number; unconsumed: number; nameable: number }>>
}

/**
 * X23 Zeitmodell (Plan 6r): ein ruhendes Gerät (A2, offline an den Tagen `dormant`, Vorgabe Tag 8 bis 22: 14 von 30), M
 * stellt A täglich jemandem vor, der Nutzer stimmt auf dem ersten Gerät zu, das den Akt zeigt, die Gegenperson sofort. Die
 * Lebensdauer der Vorrats-Schlüssel ist das Benennfenster `lifetimeDays` jenseits der Aktdauer (8470 verlangt, dass ein
 * Schlüssel beim Benennen noch die ganze Aktdauer gilt; expiresAt = Zuteilung + act-lifetime + act-skew + Fenster). Gezählt
 * je Vorstellung: ungesehen (kein Gerät von A hielt den Akt vor dem Consent-Schnitt 8155), zugestimmt ohne Verbindung,
 * verbunden, sonst; dazu Vorstellungen, die M mangels benennbaren Schlüssels nicht ausstellen konnte. Review 33 S2: die
 * Ursache jedes Verlusts ist ein Beleg aus Messungen je Schritt (Online-Schritte des Halters vor dem Schnitt, des Zuteilers
 * vor dem Annahmeende, Erzeugungszeitpunkt der Karte), jede Verweigerung trägt Ms Vorrat in dem Moment. Der Nutzer
 * bestätigt das Annahmebudget täglich (8515), der Geräteanteil ist aufgehoben (1000): gemessen wird nur die Zeit.
 */
export async function timeModel(factory: (o: { stockLifetimeMs: number; budget: number }) => MultiDeviceCandidate, opts: { lifetimeDays: number; days?: number; dormant?: Array<[number, number]>; stepHours?: number; everyDays?: number }) {
  const days = opts.days ?? 30
  const dormant = opts.dormant ?? [[8, 22]]
  const stepMs = (opts.stepHours ?? 6) * 3600 * 1000
  const every = Math.round(((opts.everyDays ?? 1) * DAY) / stepMs)
  const lifetime = M.PARAM.actLifetimeMs + M.PARAM.actSkewMs + opts.lifetimeDays * DAY
  const names = ['C0', 'C1', 'C2', 'C3']
  const s = await base(factory({ stockLifetimeMs: lifetime, budget: 1000 }), names, stepMs)
  const start = Date.parse(s.w.clock.now())
  const dayOf = (t: number) => (t - start) / DAY
  type Track = { C: HolderDevice; holder: string; issued: number; cutoff: number; expires: number; seenAt: number | null; consentedAt: number | null; producedAt: number | null; holderOnline: number; allocatorOnline: number; dormantKey: boolean; exposed: boolean }
  const acts = new Map<string, Track>()
  const refusals: X23Refusal[] = []
  // Gemessene Offline-Fenster je Gerät von A (aus den Umschaltungen, nicht aus der Vorgabe).
  const offline = new Map<string, Array<[number, number | null]>>(s.w.of('A').map((d) => [d.name, []]))
  const steps = Math.round((days * DAY) / stepMs)
  const tail = Math.round((M.PARAM.actLifetimeMs + 2 * DAY) / stepMs)
  let k = 0
  let refused = 0
  const deviceOf = (name: string) => s.w.of('A').find((d) => d.name === name)
  for (let i = 1; i <= steps + tail; i++) {
    s.w.clock.advance(stepMs)
    const day = (Date.parse(s.w.clock.now()) - start) / DAY
    const was = s.A2.online
    s.A2.online = !dormant.some(([a, b]) => day >= a && day < b)
    if (was !== s.A2.online) {
      const w = offline.get(s.A2.name)!
      if (!s.A2.online) w.push([day, null])
      else if (w.length) w[w.length - 1]![1] = day
    }
    if (i % every === 0) {
      // 8515: der Nutzer bestätigt täglich die Annahmen, die er sieht (auf einem Gerät, das gerade da ist); so bindet die
      // harte Grenze 8510 nicht, gemessen wird die Zeit.
      const d = s.w.of('A').find((x) => x.online)
      if (d) await d.confirmBudget(s.am.x.id)
      for (const c of s.cs) await c.C.confirmBudget(c.cm)
    }
    if (i <= steps && i % every === 0) {
      const c = s.cs[k++ % s.cs.length]!
      const stock = { A: { [s.Mm.name]: s.Mm.stockAt(s.am.y.id), [s.M2.name]: s.M2.stockAt(s.am.y.id) }, C: { [s.Mm.name]: s.Mm.stockAt(c.mc), [s.M2.name]: s.M2.stockAt(c.mc) } }
      const r = await s.introduce(c.mc)
      if (!('act' in r)) {
        refused++
        refusals.push({ day, reason: r.refused, stock })
      }
      if ('act' in r) {
        const ma = s.Mm.state.mediatorActs.find((x) => x.id === r.act) ?? s.M2.state.mediatorActs.find((x) => x.id === r.act)!
        const key = [...s.A.state.relationships, ...s.A2.state.relationships].flatMap((x) => x.stock).find((x) => x.anchor === ma.a.key)
        const holder = key?.by ?? s.A.person
        acts.set(r.act, { C: c.C, holder, issued: Date.parse(ma.issuedAt), cutoff: Date.parse(ma.expiresAt) - M.PARAM.consentReserveMs, expires: Date.parse(ma.expiresAt), seenAt: null, consentedAt: null, producedAt: null, holderOnline: 0, allocatorOnline: 0, dormantKey: key?.by === s.A2.name, exposed: key?.by === s.A2.name && !s.A2.online })
      }
    }
    const now = Date.parse(s.w.clock.now())
    for (const [id, x] of acts) {
      const online = s.w.of('A').filter((d) => d.online && d.state.acts.some((a) => a.id === id))
      // Belege je Schritt: der Halter (K1a: irgendein Gerät der Person) online vor dem Schnitt; der Zuteiler online nach
      // der Zustimmung bis zum Annahmeende; die Karte im Zustand des Zuteilers.
      const holderDevs = deviceOf(x.holder) ? [deviceOf(x.holder)!] : s.w.of('A')
      // Ein Ticket, das in der Runde dieses Schritts ankommt, sieht der Nutzer im nächsten Schritt: es zählt nur ein Schritt,
      // nach dem der Schnitt noch nicht vorbei ist (Raster `stepHours`).
      if (now + stepMs <= x.cutoff && holderDevs.some((d) => d.online)) x.holderOnline++
      if (x.consentedAt !== null && now <= x.expires && holderDevs.some((d) => d.online)) x.allocatorOnline++
      if (x.producedAt === null && holderDevs.some((d) => d.state.acts.some((a) => a.id === id && a.ownCard))) x.producedAt = now
      if (x.seenAt === null && online.length && now <= x.cutoff) x.seenAt = now
      if (x.seenAt !== null && x.consentedAt === null && now <= x.cutoff) {
        const d = online.find((y) => M.act(y.state, id).state === 'offered')
        if (d && (await d.consent(id)) === 'ok' && M.act(d.state, id).state === 'consented') x.consentedAt = now
      }
      if (x.C.state.acts.some((a) => a.id === id && a.state === 'offered')) await x.C.consent(id)
    }
    await s.w.rounds(1)
  }
  if (!s.A2.online) offline.get(s.A2.name)!.at(-1)![1] = (Date.parse(s.w.clock.now()) - start) / DAY
  s.A2.online = true
  await s.w.rounds(3)
  let expiredUnseen = 0
  let missedCards = 0
  let connected = 0
  let other = 0
  let onDormant = 0
  let exposed = 0
  const losses: X23Loss[] = []
  const causes: Partial<Record<X23Cause, number>> = {}
  for (const [id, x] of acts) {
    if (x.dormantKey) onDormant++
    if (x.exposed) exposed++
    const c = x.C.state.acts.find((a) => a.id === id)
    if (x.seenAt === null) expiredUnseen++
    else if (c?.state === 'connected') connected++
    else if (x.consentedAt !== null) missedCards++
    else other++
    if (c?.state === 'connected') continue
    // Ursache aus den Belegen: ungesehen vor dem Schnitt (8155); zugestimmt, aber der Zuteiler erzeugte bis zum
    // Annahmeende keine Karte (8110.5); sonst erzeugt und nicht verbunden.
    const cause: X23Cause = x.seenAt === null ? 'expired-unseen-8155' : x.producedAt === null || x.producedAt > x.expires ? 'card-not-produced-8110.5' : 'card-produced-not-connected'
    causes[cause] = (causes[cause] ?? 0) + 1
    losses.push({ act: id.slice(0, 8), cause, holder: x.holder, issuedDay: dayOf(x.issued), cutoffDay: dayOf(x.cutoff), expiresDay: dayOf(x.expires), seenDay: x.seenAt === null ? null : dayOf(x.seenAt), consentedDay: x.consentedAt === null ? null : dayOf(x.consentedAt), producedDay: x.producedAt === null ? null : dayOf(x.producedAt), holderOnlineStepsBeforeCutoff: x.holderOnline, allocatorOnlineStepsBeforeExpiry: x.allocatorOnline, holderOffline: offline.get(x.holder) ?? [] })
  }
  return { introductions: acts.size + refused, refused, issued: acts.size, onDormantKey: onDormant, onDormantKeyWhileAsleep: exposed, expiredUnseen, missedCards, connected, other, causes, losses, refusals, lifetimeDays: opts.lifetimeDays, dormantDays: dormant.reduce((n, [a, b]) => n + (b - a), 0), days }
}

/**
 * X9 Diebesfenster (Plan 6r): der Dieb hält das Abbild von A2 (A2 verloren); vor dem Widerruf stellen M und B je zweimal
 * etwas zu (Ticket, Revision), dann widerruft A1 A2, nach drei Runden Ausbreitung noch einmal. Gezählt: Dokumente (ohne
 * Quittungen), die der Dieb davor und danach liest, Tickets darunter; Runden, bis B und M den Widerruf kennen.
 */
export async function thiefWindow(candidate: MultiDeviceCandidate) {
  const s = await base(candidate, ['B', 'C'])
  const B = s.cs[0]!.C
  const ab = await s.w.encounter(s.A, B)
  await s.w.rounds(4)
  const thief = await s.w.steal(s.A2, 'A2-dieb')
  s.A2.online = false
  s.w.devices.push(thief)
  const activity = async () => {
    for (const c of s.cs) await s.introduce(c.mc)
    await B.setClass(ab.y.id, !M.rel(B.state, ab.y.id).classOn)
    await s.w.rounds(4)
  }
  const reads = (from: number) => thief.log.slice(from).filter((e) => e.type !== 'delivery-ack')
  await activity()
  const before = reads(0)
  await s.w.revoke(s.A, s.A2)
  if (!s.w.devices.includes(thief)) s.w.devices.push(thief)
  const a2 = async (d: HolderDevice, root: string) => (await s.A2.cand.keys.pair(s.A.state.relationships.flatMap((r) => r.tuples).find((t) => t.own === root)!.ownKey)).anchor
  const knows = async (d: HolderDevice, root: string) => M.setView(d.setOf(root)).revoked.has(await a2(d, root))
  let roundsToB = -1
  let roundsToM = -1
  for (let i = 1; i <= 6; i++) {
    await s.w.rounds(1)
    if (roundsToB < 0 && (await knows(B, ab.x.own))) roundsToB = i
    if (roundsToM < 0 && (await knows(s.Mm, s.am.x.own))) roundsToM = i
  }
  const mark = thief.log.length
  await activity()
  await activity()
  const after = reads(mark)
  return { readsBefore: before.length, ticketsBefore: before.filter((e) => e.type === 'introduction-ticket').length, readsAfter: after.length, ticketsAfter: after.filter((e) => e.type === 'introduction-ticket').length, roundsToB, roundsToM, kindsBefore: [...new Set(before.map((e) => e.type))].sort().join(',') }
}

/**
 * Rotationsverkehr beim Widerruf (Plan 6r): A mit zwei Geräten, Beziehungen zu M, B und C; A1 widerruft A2. Gezählt bis zur
 * Ruhe: Rahmen und Bytes, die As Geräte an Gegenseiten einliefern (nicht an eigene Geräte), getrennt nach
 * Mengenrevisionen (`device-set`) und Vorratsrevisionen an M (`introduction-prekeys`), und wie viele Gegenseiten sie erreichen.
 */
export async function revocationTraffic(candidate: MultiDeviceCandidate) {
  const s = await base(candidate, ['B', 'C'])
  for (const c of s.cs) await s.w.encounter(s.A, c.C)
  await s.w.rounds(5)
  const selves = new Set(s.w.selfAddresses('A'))
  const from = s.w.carrier.carried.length
  await s.w.revoke(s.A, s.A2)
  await s.w.rounds(6)
  const own = new Set(selves)
  const out = { setRevisions: 0, stockRevisions: 0, frames: 0, bytes: 0, counterparts: 0 }
  const reached = new Set<string>()
  for (const f of s.w.carrier.carried.slice(from)) {
    const o = s.w.frameOrigin(f.bytes)
    if (!o || !o.device.startsWith('A') || own.has(f.address) || o.kind === 'delivery-ack' || o.kind.startsWith('journal')) continue
    out.frames++
    out.bytes += f.bytes.length
    if (o.kind === 'device-set') out.setRevisions++
    if (o.kind === 'introduction-prekeys') out.stockRevisions++
    for (const d of s.w.devices) if (s.w.carrier.registeredAt(f.address).includes(d.name)) reached.add(d.person)
  }
  out.counterparts = reached.size
  return out
}

/**
 * Enrollment-Fan-out (Plan 6r, Bauliste 2): A mit einem Gerät, Beziehung zu M und `n` Begegnungen; dann Enrollment von A2.
 * Gezählt: Mengenrevisionen, die A1 dabei an Gegenseiten sendet, Bytes, Bytes der Zeremonie, und Runden, bis jede
 * Gegenseite A2 in ihrer Menge für As Wurzel hält (adressierbar).
 */
export async function enrolFanout(candidate: MultiDeviceCandidate, n: number) {
  const w = new Welt15(candidate)
  const A = await w.person('A', 'A1')
  const Mm = await w.person('M', 'M1')
  const roots: Array<{ peer: HolderDevice; root: string; ctx: string; key?: string }> = []
  const am = await w.encounter(A, Mm)
  roots.push({ peer: Mm, root: am.x.own, ctx: am.x.ownKey })
  for (let i = 0; i < n; i++) {
    const C = await w.person(`C${i}`, `C${i}1`)
    const t = await w.encounter(A, C)
    roots.push({ peer: C, root: t.x.own, ctx: t.x.ownKey })
  }
  await w.rounds(3)
  const from = w.carrier.carried.length
  const A2 = await w.enrol(A, 'A2')
  const sets = w.carrier.carried.slice(from).filter((f) => w.frameOrigin(f.bytes)?.kind === 'device-set')
  const addressable = async () => {
    let k = 0
    for (const r of roots) if (M.setView(r.peer.setOf(r.root)).members.some((m) => m.anchor === r.key)) k++
    return k
  }
  for (const r of roots) r.key = (await A2.cand.keys.pair(r.ctx)).anchor
  let rounds = -1
  for (let i = 1; i <= 10; i++) {
    await w.rounds(1)
    if ((await addressable()) === roots.length) {
      rounds = i
      break
    }
  }
  const c = candidate as MultiDeviceCandidate & { ceremonies?: Array<{ bytesNewToOld: number; bytesOldToNew: number }> }
  const cer = c.ceremonies?.at(-1)
  return { relationships: roots.length, setRevisions: sets.length, setBytes: sets.reduce((k, f) => k + f.bytes.length, 0), addressable: await addressable(), rounds, ceremonyBytes: cer ? cer.bytesNewToOld + cer.bytesOldToNew : 0 }
}
