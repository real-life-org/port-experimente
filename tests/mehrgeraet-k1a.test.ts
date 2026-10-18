import { describe, expect, it, vi } from 'vitest'
import { Welt15 } from '../src/lab/mehrgeraet/welt'
import { HolderDevice } from '../src/lab/mehrgeraet/holder'
import { runX15 } from '../src/lab/mehrgeraet/scenarios'
import { k1a, K1aDevice } from '../src/candidates/mehrgeraet-k1a'
import { k0 } from '../src/candidates/mehrgeraet-k0'
import * as M from '../src/lab/mehrgeraet/model'

// E15 K1a Schritt 1: der Abnahmelauf aus Tor-Review 6 (Plan 6e).
//   1. Ohne Recht ganz blockiert: das Gerät ohne Annahmekontingent nimmt kein Ticket an, das andere schon;
//      ein Mediatorgerät benennt nur die ihm zugeteilten Schlüssel.
//   2. Autorisiert → Commit: der Schritt steht als ein Batch im Journal, mit Operationen und Absichten.
//   3. Absturz vor Versand → neue Instanz mit neuer Inkarnation → dieselben Bytes gehen hinaus.
//   4. Dupliziertes, umgeordnetes, unvollständiges Journal → genau eine Wirkung, gleiche vollständige Projektion.
//   5. Eine Absicht des anderen Geräts wird nicht neu produziert (X5 besteht).
//   Schritt 1b (Tor-Review 7):
//   6. Journal und Holder bleiben zusammen: scheitert der Schritt nach dem Anwenden eines Rahmens, kennt der
//      Kandidat den Batch nicht, der Rahmen wird wiederholt, die Geräte konvergieren (B1).
//   7. Zweimal dasselbe Backup wiederhergestellt ergibt zwei verschiedene Inkarnationen (B2).
//   8. Die Gerätezahl ist fest: ein weiteres Enrollment wird verweigert (B4).
//   9. Das Annahmekontingent zählt im 28-Tage-Fenster (S1).

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
    await w.rounds(4) // der Nachhol-Abgleich des Enrollments ist durch
    const self = (await A.cand.keys.pair('self/A')).rkid
    // Erst wird A1s Journalrahmen des nächsten Schritts für A2 zurückgehalten, dann doppelt und umgekehrt geliefert.
    const mark = w.carrier.carried.length
    await A.setClass(am.x.id, false)
    await A.round() // A1 liefert seinen Journalrahmen ein; A2 war noch nicht dran
    const held = w.carrier.carried.slice(mark).find((f) => f.address === self && [...A.zusteller.submissions.values()].some((x) => Buffer.compare(x.frame, f.bytes) === 0))!.bytes
    w.carrier.faults.withhold('A2', (f) => Buffer.compare(held, f.bytes) === 0)
    expect(M.rel(A2.state, am.x.id).classOn).toBe(true)
    await A.setClass(am.x.id, true)
    await w.rounds(1)
    w.carrier.faults.duplicate(true)
    w.carrier.faults.reverse(true)
    await w.rounds(3)
    expect(A2.dispositions.some((d) => d.startsWith('deferred(batch:'))).toBe(true)
    // Der zurückgehaltene Rahmen bleibt zurückgehalten; A2 holt den fehlenden Batch über die Self-Adresse nach (Schritt 1c).
    const n = await w.until(() => w.agree('A').agree, 15)
    expect(n).toBeGreaterThan(0)
    w.carrier.faults.reset()
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

  it('6. B1: scheitert ein Schritt nach dem Anwenden eines Journalrahmens, bleibt der Batch dem Kandidaten unbekannt; Wiederholung heilt', async () => {
    const { w, A, am } = await pair()
    const A2 = await w.enrol(A, 'A2')
    await w.rounds(4) // der Nachhol-Abgleich des Enrollments ist durch
    // Einmal scheitert bei A2 die Quittungsbildung nach dem Anwenden (fehlende Voraussetzung → zurückgestellt).
    const inner = A2.cand.keys
    const before = (A2.cand as K1aDevice).persist().batches.length
    let fail = 1
    // Scheitert genau bei der Quittungsbildung, also nachdem der Kandidat den neuen Batch kennt (`applied`).
    ;(A2.cand as { keys: typeof inner }).keys = { pair: async (ctx) => { if (fail && ctx === 'self/A' && (A2.cand as K1aDevice).persist().batches.length > before) { fail = 0; throw new M.Missing('tuple', 'injected', 'A') } return inner.pair(ctx) } }
    await A.setClass(am.x.id, false)
    await w.rounds(1)
    expect(A2.dispositions.some((d) => d.startsWith('deferred(tuple:injected'))).toBe(true)
    expect(M.rel(A2.state, am.x.id).classOn).toBe(true) // zurückgenommen
    expect((A2.cand as K1aDevice).persist().batches.length).toBe(before) // Journal ebenfalls
    const n = await w.until(() => w.agree('A').agree && !M.rel(A2.state, am.x.id).classOn, 12)
    expect(n).toBeGreaterThan(0)
    expect((A2.cand as K1aDevice).persist().batches.length).toBe(before + 1)
  }, 60_000)

  it('7. B2: zweimal dasselbe Backup wiederhergestellt ergibt verschiedene Inkarnationen; beide Schritte kommen beim Schwestergerät an', async () => {
    const { w, A, am } = await pair()
    const A2 = await w.enrol(A, 'A2')
    await w.rounds(2)
    const backup = w.stores.get('A1')!.snapshot()
    const w1 = A.cand.writer
    w.stores.get('A1')!.restore(backup)
    await A.reload()
    const w2 = A.cand.writer
    await A.setClass(am.x.id, false)
    await w.rounds(2)
    w.stores.get('A1')!.restore(backup)
    await A.reload()
    const w3 = A.cand.writer
    await A.setClass(am.x.id, true) // anderer Schritt unter der dritten Inkarnation
    await w.rounds(3)
    expect(new Set([w1, w2, w3]).size).toBe(3)
    const seen = (A2.cand as K1aDevice).persist().batches.map((b) => b.writer)
    expect(seen).toContain(w2)
    expect(seen).toContain(w3)
  }, 60_000)

  it('8. B4: die Gerätezahl ist fest; ein drittes Gerät wird verweigert, die Plätze der ersten beiden bleiben', async () => {
    const { w, A } = await pair()
    const A2 = await w.enrol(A, 'A2')
    expect((A.cand as K1aDevice).slots).toBe(2)
    expect((A2.cand as K1aDevice).slots).toBe(2)
    await expect(w.enrol(A, 'A3')).rejects.toThrow(/fest|fixed/)
    expect((A.cand as K1aDevice).slots).toBe(2)
  }, 60_000)

  it('8c. B4: scheitert das Enrollment am Gerät, wird der Platz wieder frei (CodeRabbit auf #63)', async () => {
    const { w, A } = await pair()
    const broken = w.candidate.enrol.bind(w.candidate)
    // Der Kandidat liefert einen Platz, aber das Gerät kommt nicht zustande (Schlüsseldienst wirft beim Anmelden).
    w.candidate.enrol = async (from, name) => {
      const r = await broken(from, name)
      const cand = Object.create(r.cand) as typeof r.cand
      Object.defineProperty(cand, 'keys', { value: { pair: async () => { throw new Error('kein Schlüsseldienst') } } })
      return { ...r, cand }
    }
    await expect(w.enrol(A, 'A2')).rejects.toThrow(/Schlüsseldienst/)
    w.candidate.enrol = broken
    const A2 = await w.enrol(A, 'A2') // der Platz ist wieder frei
    expect((A2.cand as K1aDevice).index).toBe(1)
  }, 60_000)

  it('9. S1: eine eigene Annahme außerhalb des 28-Tage-Fensters zählt nicht mehr gegen das Kontingent', async () => {
    const d = new K1aDevice('A', 'A1', new Uint8Array(32), 0, 1, 1)
    const s = M.emptyState('A')
    const t = (iso: string) => iso
    const tuple: M.Tuple = { id: 'A:e1', own: 'a', ownKey: 'k/a', peer: 'm', peerKeyAgreement: 'rk/m', record: 'r', openedAt: t('2026-08-01T00:00:00.000Z'), candidates: [], deactivated: false }
    M.apply(s, { id: { writer: 'A1@1', n: 1 }, at: t('2026-08-01T00:00:00.000Z'), kind: 'open-tuple', rel: null, tuple, provenance: 'encounter', vouchedBy: null, act: null })
    const actOf = (id: string, own: string): M.Act => ({ id, mediator: 'A:e1', own, voucher: { anchor: 'V', keyAgreement: 'rk/V', name: 'B' }, issuedAt: t('2026-08-01T00:00:00.000Z'), expiresAt: t('2026-08-08T00:00:00.000Z'), state: 'offered', pending: null, v: null, k: false, ownCard: null, ownCardKey: null, o: 'none', ownCardDigest: null, opened: null })
    const old: M.Op = { id: { writer: 'A1@1', n: 2 }, at: t('2026-08-01T00:00:00.000Z'), kind: 'ticket-accept', act: actOf('old', 'k1') }
    expect(d.authorize(old, s)).toBe(true)
    M.apply(s, old)
    d.commit({ ops: [old], intents: [] })
    const fresh: M.Op = { id: { writer: 'A1@1', n: 3 }, at: t('2026-10-17T00:00:00.000Z'), kind: 'ticket-accept', act: actOf('new', 'k2') }
    expect(d.authorize(fresh, s)).toBe(true) // die alte Annahme liegt außerhalb des Fensters
    const soon: M.Op = { ...fresh, at: t('2026-08-10T00:00:00.000Z') }
    expect(d.authorize(soon, s)).toBe(false) // innerhalb des Fensters zählt sie
  })

  // Schritt 1c (Tor-Review 7 B3): Abhängigkeiten als Vektor der Köpfe, Nachholen über die Self-Adresse (HSC-440, X21).
  it('10. B3: eine kausale Folge über zwei Geräte bleibt in jeder Reihenfolge dieselbe (Q liest Ps Schritt, dann Qs Schritt)', async () => {
    const { w, A, am } = await pair()
    const A2 = await w.enrol(A, 'A2')
    await w.rounds(2)
    const self = (await A.cand.keys.pair('self/A')).rkid
    const old = w.stores.get('A1')!.snapshot() // vor P
    // A1 setzt die Klasse aus (P), A2 liest das und setzt sie wieder an (Q): Qs Batch hängt von Ps Batch ab.
    await A.setClass(am.x.id, false)
    await w.rounds(2)
    expect(M.rel(A2.state, am.x.id).classOn).toBe(false)
    const held = new Set<string>()
    // A1 aus einem Abbild von vor P, das Q vor P bekommt: Q hängt an P und wartet.
    await A2.setClass(am.x.id, true)
    w.stores.get('A1')!.restore(old)
    await A.reload()
    expect(M.rel(A.state, am.x.id).classOn).toBe(true) // altes Abbild: vor P
    w.carrier.faults.reverse(true)
    await w.rounds(3)
    w.carrier.faults.reset()
    expect(A.dispositions.some((d) => d.startsWith('deferred(batch:'))).toBe(true) // Q wartete auf P
    const n = await w.until(() => w.agree('A').agree, 15)
    expect(n).toBeGreaterThan(0)
    expect(M.rel(A.state, am.x.id).classOn).toBe(true) // P dann Q, nie Q dann P
    expect(M.rel(A2.state, am.x.id).classOn).toBe(true)
    void self
    void held
  }, 90_000)

  it('11. B3: ein Batch nur mit Absichten ist ein Vorgänger; der nächste wird ohne ihn zurückgestellt', () => {
    const seed = new Uint8Array(32)
    const a = new K1aDevice('A', 'A1', seed, 0, 2, 10)
    const b = new K1aDevice('A', 'A2', seed, 1, 2, 10)
    const intent = { digest: 'd1', kind: 'x', bytes: new Uint8Array([1]), address: 'adr', expected: 'e', replyTo: 'r', device: 'A1', writer: a.writer }
    a.commit({ ops: [], intents: [intent] }) // Batch 1: keine Operation, eine Absicht
    const op: M.Op = { id: { writer: a.writer, n: 1 }, at: '2026-10-17T00:00:00.000Z', kind: 'finding', text: 't' }
    a.commit({ ops: [op], intents: [] }) // Batch 2 hängt an Batch 1
    const [f1, f2] = a.takeOwnFrames()
    const b1 = JSON.parse(new TextDecoder().decode(f1!.body)) as { ops: unknown[]; deps: string[] }
    const b2 = JSON.parse(new TextDecoder().decode(f2!.body)) as { deps: string[] }
    expect(b1.ops).toEqual([])
    expect(b2.deps).toContain(`${a.writer}#1`)
    expect(() => b.receiveOwnFrame(f2!.body)).toThrow(M.Missing) // ohne Batch 1 zurückgestellt
    const tx1 = b.receiveOwnFrame(f1!.body)
    expect(tx1.intents.length).toBe(1)
    b.applied(f1!.body)
    expect(b.receiveOwnFrame(f2!.body).ops.length).toBe(1)
  })

  it('11b. B1 (Review 9): verlorene Nachhol-Anfragen oder -Antworten beenden das Nachholen nicht; es konvergiert ohne weitere Nutzeraktion', async () => {
    for (const variant of ['requests', 'answers'] as const) {
      const { w, A, am } = await pair()
      const A2 = await w.enrol(A, 'A2')
      await w.rounds(2)
      const backup = w.stores.get('A2')!.snapshot()
      await A.setClass(am.x.id, false)
      await w.rounds(3)
      expect(M.rel(A2.state, am.x.id).classOn).toBe(false)
      w.stores.get('A2')!.restore(backup)
      await A2.reload()
      expect(M.rel(A2.state, am.x.id).classOn).toBe(true) // altes Abbild
      const self = (await A.cand.keys.pair('self/A')).rkid
      // 15 Runden lang gehen auf der Self-Adresse entweder die Anfragen (alles, was A2 einliefert) oder die Antworten (alles, was A1 einliefert) verloren; die Rahmen sind versiegelt, erkannt wird der Absender über seine Submissions.
      const from = (d: typeof A) => (f: { bytes: Uint8Array }) => [...d.zusteller.submissions.values()].some((x) => Buffer.compare(x.frame, f.bytes) === 0)
      w.carrier.faults.drop((f) => f.address === self && (variant === 'requests' ? from(A2)(f) : from(A)(f)))
      await w.rounds(15)
      expect(M.rel(A2.state, am.x.id).classOn, variant).toBe(true)
      w.carrier.faults.reset()
      const n = await w.until(() => w.agree('A').agree && !M.rel(A2.state, am.x.id).classOn, 30)
      expect(n, `${variant}: Konvergenz ohne requestSync`).toBeGreaterThan(0)
      expect(A2.syncRequests).toBeGreaterThan(1)
    }
  }, 180_000)

  it('12. B3/X6: ein Gerät aus einem alten Backup holt über die Self-Adresse nach, auch seine eigene frühere Inkarnation; X6 besteht', async () => {
    const r = byId(await runX15(k1a(), false, ['X6']))
    expect(r.X6!.crashed).toBeFalsy()
    expect(r.X6!.outcome, r.X6!.detail).toBe('bestanden')
  }, 300_000)
})

// Breite K1a-Matrix (Plan Abschnitt 4, Review-9-Schluss): X13–X18 und X21, je mit zwei Geräten und seriell.
// Seriell heißt für K1a ein Gerät je Person mit ungeteilten Rechten (`devices: 1`); mit der festen Zahl 2 hätte das
// einzige Gerät nur die Hälfte des Budgets und der Schlüssel, der Kontrolllauf prüfte dann die Aufteilung, nicht den Prüfstand.
describe('K1a breite Matrix', () => {
  it('X21: Journal nach altem und doppeltem Restore unter Umordnung, Duplikaten, gleichzeitigen Anfragen; Verlust von Anfrage, Antwort, Quittung je über 12 Runden', async () => {
    const r = byId(await runX15(k1a(), false, ['X21']))
    const x = r.X21!
    expect(x.crashed, x.detail).toBeFalsy()
    expect(x.outcome, x.detail).toBe('bestanden')
    expect(x.measures.missingBatches).toBe(0)
    expect(x.measures.doubleFinalEffects).toBe(0)
    expect(x.measures.remainingConflicts).toBe(0)
    // Jede Verlustphase hat das Gerät wirklich hinter sich gelassen (sonst prüft sie nichts), und danach konvergiert es.
    for (const k of ['RequestLoss', 'AnswerLoss']) {
      expect(x.measures[`behindAfter${k}`], k).toBe(1)
      expect(x.measures[`repairRounds${k}`] as number, k).toBeGreaterThan(0)
    }
    expect(x.measures.repairRoundsRestore as number).toBeGreaterThan(0)
    expect(x.measures.repairRoundsReceiptLoss as number).toBeGreaterThan(0)
    // Voller Reparaturverkehr gemessen, nicht erfunden: Einlieferungen samt Wiederholungen, Antworten, Quittungen, Bytes.
    for (const k of ['ownFrames', 'ownBytes', 'journalFrames', 'journalBytes', 'syncRequestFrames', 'syncReplyFrames', 'ackFrames', 'repeatedDeposits', 'syncRequests', 'journalBatchesBefore', 'journalBatchesAfter']) expect(typeof x.measures[k], k).toBe('number')
    expect(x.measures.repeatedDeposits as number).toBeGreaterThan(0)
    expect(x.measures.journalBatchesAfter).toBe(x.measures.journalBatchesBefore) // keine neue Fachoperation: das Journal wächst nicht
    // Review 11 S1: Wiederholungen nach Zielseite getrennt; die Summe ist die Gesamtzahl.
    expect(typeof x.measures.repeatedDepositsOwn).toBe('number')
    expect(typeof x.measures.repeatedDepositsToCounterpart).toBe('number')
    expect((x.measures.repeatedDepositsOwn as number) + (x.measures.repeatedDepositsToCounterpart as number)).toBe(x.measures.repeatedDeposits)
    expect(x.measures.repeatedDepositsOwn as number).toBeLessThanOrEqual(x.measures.ownFrames as number)
    // Review 11 S2: nur die benötigten Journal-Batches gehen verloren, Antwortkopf und Quittungen passieren.
    expect(x.measures.behindAfterJournalLoss).toBe(1)
    expect(x.measures.repairRoundsJournalLoss as number).toBeGreaterThan(0)
    // Je Phase nach der Reparatur: alle Batch-Schlüssel da, Referenzprojektion auf jedem Gerät.
    for (const k of ['Restore', 'RequestLoss', 'AnswerLoss', 'JournalLoss', 'ReceiptLoss']) {
      expect(x.measures[`missingBatchesAfter${k}`], k).toBe(0)
      expect(x.measures[`lostStateAfter${k}`], k).toBe(0)
    }
    // Review 11 B2: Reparaturende = kein Gerät mit ausstehendem Nachholen und ein Ruhefenster über dem größten Wiederanfrageabstand.
    expect(x.measures.devicesPendingSync).toBe(0)
    expect(x.measures.quietWindow as number).toBeGreaterThan(16)
    expect(byId(await runX15(k1a(), true, ['X21'])).X21!.outcome).toBe('nicht abbildbar')
  }, 600_000)

  it('X21 Gegenlauf (Review 11 B2): beantwortet A2s Kopfvergleich nach jedem Restore immer mit „nicht gedeckt“, endet die Reparatur nie; X21 besteht nicht', async () => {
    const proto = HolderDevice.prototype as unknown as { reload: () => Promise<void> }
    const reload = proto.reload
    const spy = vi.spyOn(proto, 'reload').mockImplementation(async function (this: HolderDevice) {
      await reload.call(this)
      if (this.name === 'A2') (this as unknown as { covers: () => boolean }).covers = () => false
    })
    try {
      const x = byId(await runX15(k1a(), false, ['X21'])).X21!
      expect(x.crashed, x.detail).toBeFalsy()
      expect(x.outcome, x.detail).toBe('nicht bestanden')
      expect(x.measures.devicesPendingSync as number, x.detail).toBeGreaterThan(0)
      expect(x.detail).toMatch(/A2/)
      expect(x.detail).toMatch(/ausstehend/)
    } finally {
      spy.mockRestore()
    }
  }, 600_000)

  it('X13: M1 und M2 stellen getrennt je eine Vorstellung gegen As gemeinsames Budget bei 9 aus: zehn Annahmen, keine Überschreitung', async () => {
    for (const serial of [false, true]) {
      const x = byId(await runX15(serial ? k1a({ devices: 1 }) : k1a(), serial, ['X13'])).X13!
      expect(x.crashed, x.detail).toBeFalsy()
      expect(x.outcome, `${serial ? 'seriell' : 'zwei Geräte'}: ${x.detail}`).toBe('bestanden')
      expect(x.measures.budgetOverrun).toBe(0)
      expect(x.measures.acceptedActs).toBe(10)
      expect(x.measures.doubleFinalEffects).toBe(0)
      expect(x.measures.issuedOffline).toBe(2)
    }
  }, 600_000)

  it('X15: Vereinigung zweier Beziehungen zu M auf A2, während auf A1 ein Akt läuft (consented, Karte unterwegs): die Vereinigung trägt die Gegenseite M', async () => {
    const two = byId(await runX15(k1a(), false, ['X15'])).X15!
    expect(two.crashed, two.detail).toBeFalsy()
    // Die Vereinigung entsteht aus Ms Mapping auf A2s neuem Tupel und wandert als Operation durchs Journal.
    expect(two.outcome, two.detail).toBe('bestanden')
    expect(two.measures.entriesToMediator).toBe(1)
    expect(two.measures.actsConnected).toBe(2)
    expect(two.measures.mediatorResolved).toBe(2)
    expect(two.measures.doubleFinalEffects).toBe(0)
    const one = byId(await runX15(k1a({ devices: 1 }), true, ['X15'])).X15!
    expect(one.crashed, one.detail).toBeFalsy()
    expect(one.outcome, one.detail).toBe('bestanden')
  }, 600_000)

  it('X16: A1 widerruft die Klasse, A2 hält getrennt den alten Vorrat und nimmt noch ein Ticket an (der Widerruf ist in K1a kein Recht)', async () => {
    const two = byId(await runX15(k1a(), false, ['X16'])).X16!
    expect(two.crashed, two.detail).toBeFalsy()
    expect(two.outcome, two.detail).toBe('nicht bestanden')
    expect(two.measures.acceptedAfterRevocation).toBe(1)
    const one = byId(await runX15(k1a({ devices: 1 }), true, ['X16'])).X16!
    expect(one.crashed, one.detail).toBeFalsy()
    expect(one.outcome, one.detail).toBe('bestanden')
    expect(one.measures.acceptedAfterRevocation).toBe(0)
  }, 600_000)

  it('X17: A1 und A2 füllen getrennt nach und senden je eine Revision mit derselben Nummer: Equivokation bei M (8500, 6270)', async () => {
    const two = byId(await runX15(k1a(), false, ['X17'])).X17!
    expect(two.crashed, two.detail).toBeFalsy()
    expect(two.outcome, two.detail).toBe('nicht bestanden')
    expect(two.measures.revisionNumbersReused as number).toBeGreaterThan(0)
    const one = byId(await runX15(k1a({ devices: 1 }), true, ['X17'])).X17!
    expect(one.crashed, one.detail).toBeFalsy()
    expect(one.outcome, one.detail).toBe('bestanden')
    expect(one.measures.revisionNumbersReused).toBe(0)
  }, 600_000)

  it('X18 (Schritt 3, Regeln 1 und 3): A1 und A2 stimmen getrennt zu und produzieren je eine Karte: eine Zustimmung, eine Verbindung, ein Übergabedigest; B verbindet einmal; Zusage geändert', async () => {
    const two = byId(await runX15(k1a(), false, ['X18'])).X18!
    expect(two.crashed, two.detail).toBeFalsy()
    expect(two.outcome, two.detail).toBe('bestanden')
    expect(two.promiseChanged, two.detail).toBe(true)
    expect(two.measures.consentWriters).toBe(2) // zwei Geräte haben zugestimmt
    expect(two.measures.cardsProducedByA).toBe(2) // zwei Karten-Dokumente eines Akts, beide eingereicht (getrennt, nichts zurückzunehmen)
    expect(two.measures.cardFramesToB).toBe(2) // gemessen: B erhält zwei Karten-Dokumente
    // Ein Seed: beide Karten tragen denselben Kartenschlüssel und dieselbe Nutzlast; B sieht eine Wiederholung (8910.7), keinen Konflikt (8910.8).
    expect(two.measures.connectsAtB).toBe(1)
    expect(two.measures.cardConflictsAtB).toBe(0)
    // Regel 1: As Ledger trägt eine Zustimmung und eine Verbindung; Regel 3: beide Geräte halten dieselbe Übergabe.
    expect(two.measures.consentOperations).toBe(1)
    expect(two.measures.connectOperationsA).toBe(1)
    expect(two.measures.doubleFinalEffects).toBe(0)
    expect(two.measures.handOverDigestsOnA).toBe(1)
    expect(two.measures.projectionAgrees).toBe(1)
    expect(two.detail).toMatch(/Regeln 1 und 3/)
    const one = byId(await runX15(k1a({ devices: 1 }), true, ['X18'])).X18!
    expect(one.crashed, one.detail).toBeFalsy()
    expect(one.outcome, one.detail).toBe('bestanden')
    expect(one.promiseChanged).toBeFalsy()
    expect(one.measures.cardsProducedByA).toBe(1)
    expect(one.measures.doubleFinalEffects).toBe(0)
  }, 600_000)

  it('X18 Gegenlauf (Review 11 B1, Schritt 3): ohne Regel 1 fängt das Orakel As doppelte Endwirkungen, auch wenn die Projektion den Übergabedigest ausblendet; ohne Regel 3 bleiben die Digests verschieden', async () => {
    const proto = HolderDevice.prototype as unknown as { projection: () => M.Projection }
    const projection = proto.projection
    const spy = vi.spyOn(proto, 'projection').mockImplementation(function (this: HolderDevice) {
      const p = projection.call(this)
      for (const a of Object.values(p.acts)) a.ownCardDigest = null
      return p
    })
    try {
      M.FOLD.sameDecision = false
      const x = byId(await runX15(k1a(), false, ['X18'])).X18!
      expect(x.crashed, x.detail).toBeFalsy()
      expect(x.measures.projectionAgrees, x.detail).toBe(1)
      expect(x.measures.doubleFinalEffectsA, x.detail).toBe(2)
      expect(x.measures.doubleEffectKindsA, x.detail).toBe('connect, consent')
      expect(x.outcome, x.detail).toBe('nicht bestanden')
    } finally {
      spy.mockRestore()
      M.FOLD.sameDecision = true
    }
    try {
      M.FOLD.handOver = false
      const y = byId(await runX15(k1a(), false, ['X18'])).X18!
      expect(y.crashed, y.detail).toBeFalsy()
      expect(y.measures.handOverDigestsOnA, y.detail).toBe(2)
      expect(y.measures.projectionAgrees, y.detail).toBe(0)
      expect(y.outcome, y.detail).toBe('nicht bestanden')
    } finally {
      M.FOLD.handOver = true
    }
  }, 600_000)
})

// K1a Schritt 3 (Anton 18.10.2026, Fragenkatalog Klasse 2, Linie „weich“: was die Gegenseite schon erreicht hat, gilt;
// was noch im eigenen Haus ist, darf die Faltung umentscheiden). Faltungsregeln des Modells (model.ts, `resolveDecision`):
//   Regel 1: dieselbe Entscheidung von zwei Geräten ist eine Wirkung.
//   Regel 2: Zustimmung gegen Ablehnung: eingereichte eigene Karte → Zustimmung gilt, Ablehnung ist Konfliktbefund; sonst
//            gilt die Ablehnung, das erzeugende Gerät nimmt seine nicht eingereichte Karte zurück (8232.2, 8765).
//   Regel 3: zwei Übergaben eines Akts: die kleinere Kennung gewinnt, die andere wird zurückgenommen, wenn sie den Träger
//            nicht erreicht hat.
//   1. X3: A1 stimmt zu, A2 lehnt ab (beide offline, A2 kommt zuerst zurück): die Ablehnung gilt, A1s Karte geht nie hinaus,
//      B bleibt ohne Karte; bestanden mit „Zusage geändert“; seriell unverändert.
//   2. Gegenlauf zu X3: A1s Karte ist schon `taken`, als A2 offline ablehnt: nach der Heilung connected, Konfliktbefund,
//      kein Rahmen an B, der etwas zurücknimmt.
//   3. Regel 3 am Gerät: A2 stimmt zu, während A1s Karte offline beim Adapter liegt; die größere Übergabe wird
//      zurückgenommen, B erhält ein Karten-Dokument.
describe('K1a Schritt 3: Entscheidung und Übergabe', () => {
  async function withA2() {
    const p = await pair()
    const A2 = await p.w.enrol(p.A, 'A2')
    await p.w.rounds(3)
    const r = await p.Mm.introduce(p.am.y.id, p.bm.y.id)
    if (!('act' in r)) throw new Error(r.refused)
    await p.w.until(() => [p.A, A2, p.B].every((d) => d.state.acts.some((a) => a.id === r.act)))
    return { ...p, A2, act: r.act }
  }
  const cardDocs = (w: Welt15, act: string) => {
    const out = new Set<string>()
    for (const d of w.of('A')) {
      const a = M.act(d.state, act)
      for (const [digest, i] of d.intents) if (i.device === d.name && i.kind.includes('introduction-card') && i.address === a.voucher.keyAgreement && (d.zusteller.submissions.get(digest)?.deposits ?? 0) > 0) out.add(digest)
    }
    return out.size
  }

  it('1. X3: die Ablehnung gilt, wenn A1s Karte den Träger nicht erreicht hat; bestanden mit „Zusage geändert“, seriell unverändert', async () => {
    const two = byId(await runX15(k1a(), false, ['X3'])).X3!
    expect(two.crashed, two.detail).toBeFalsy()
    expect(two.outcome, two.detail).toBe('bestanden')
    expect(two.promiseChanged, two.detail).toBe(true)
    expect(two.detail).toMatch(/Regel 2: keine eigene Karte eingereicht \(O = cancelled\), die Ablehnung gilt/)
    expect(two.measures.consentUndone).toBe(1) // A1 hat zugestimmt und endet abgelehnt
    expect(two.measures.leftTerminal).toBe(0)
    expect(two.measures.cardFramesToCarrier).toBe(0) // 8765: nichts an B
    expect(two.measures.contradictionAtB).toBe(0)
    expect(two.measures.conflictFindings).toBe(1)
    expect(two.measures.doubleFinalEffects).toBe(0) // kein Widerspruch im Ledger, nur ein Konflikt
    const one = byId(await runX15(k1a({ devices: 1 }), true, ['X3'])).X3!
    expect(one.crashed, one.detail).toBeFalsy()
    expect(one.outcome, one.detail).toBe('bestanden')
    expect(one.promiseChanged).toBeFalsy()
  }, 600_000)

  it('2. Gegenlauf: A1s Karte ist schon taken, A2 lehnt offline ab; nach der Heilung connected, Konfliktbefund, kein Rahmen an B, der etwas zurücknimmt', async () => {
    const { w, A, A2, B, act } = await withA2()
    A2.online = false
    expect(await A.consent(act)).toBe('ok')
    expect(await w.until(() => M.SUBMITTED.has(M.act(A.state, act).o), 5)).toBeGreaterThan(0)
    expect(await A2.decline(act)).toBe('ok')
    expect(M.act(A2.state, act).state).toBe('declined')
    const before = new Set(A2.produced.keys())
    expect(await B.consent(act)).toBe('ok')
    A2.online = true
    expect(await w.until(() => w.of('A').every((d) => M.act(d.state, act).state === 'connected') && w.agree('A').agree, 20)).toBeGreaterThan(0)
    await w.rounds(3)
    expect(w.agree('A').agree).toBe(true)
    expect(M.act(B.state, act).state).toBe('connected')
    const l = ledgerOf(w, 'A')
    expect(l.get(`consent:${act}`)?.size).toBe(1)
    expect(l.get(`conflict:decline:${act}`)?.size).toBe(1)
    expect(l.has(`decline:${act}`)).toBe(false)
    expect(doubles(w, 'A')).toEqual([])
    for (const d of w.of('A')) expect(d.state.findings.some((f) => f.includes(act) && f.includes('Regel 2') && f.includes('Zustimmung gilt'))).toBe(true)
    // Kein Rahmen von A2 an B außer Quittungen und Journal; A hat genau ein Karten-Dokument eingereicht.
    const kinds = [...A2.produced.entries()].filter(([h]) => !before.has(h)).map(([, k]) => k)
    expect(kinds.filter((k) => !['journal', 'journal-sync', 'journal-sync-reply', 'delivery-ack'].includes(k))).toEqual([])
    expect(cardDocs(w, act)).toBe(1)
    expect(ledgerOf(w, 'B').get(`connect:${act}`)?.size).toBe(1)
  }, 300_000)

  it('3. Regel 3 am Gerät: A1s Karte liegt offline beim Adapter, A2 stimmt verbunden zu; nach der Heilung eine Übergabe, die andere zurückgenommen, B verbindet einmal', async () => {
    const { w, A, A2, B, act } = await withA2()
    const selfA = (await A.cand.keys.pair('self/A')).rkid
    // A1 offline (Karte bleibt beim Adapter), A2 sieht A1s Zustimmung nicht (Journal zurückgehalten) und stimmt selbst zu.
    A.online = false
    expect(await A.consent(act)).toBe('ok')
    w.carrier.faults.withhold('A2', (f) => f.address === selfA)
    expect(await A2.consent(act)).toBe('ok')
    await w.rounds(2)
    expect(M.SUBMITTED.has(M.act(A2.state, act).o)).toBe(true)
    w.carrier.faults.reset()
    expect(await B.consent(act)).toBe('ok')
    A.online = true
    expect(await w.until(() => [...w.of('A'), B].every((d) => M.act(d.state, act).state === 'connected') && w.agree('A').agree, 25)).toBeGreaterThan(0)
    const digests = new Set(w.of('A').map((d) => M.act(d.state, act).ownCardDigest))
    expect(digests.size).toBe(1)
    const cards = M.act(A.state, act).cards!
    expect(Object.keys(cards).length).toBe(2)
    expect(doubles(w, 'A')).toEqual([])
    expect(ledgerOf(w, 'B').get(`connect:${act}`)?.size).toBe(1)
    // Welche Karte zurückgenommen wurde, hängt am Digest (Regel 3): ist A1s die größere, ist sie `cancelled` und nie beim Träger.
    const a1 = Object.entries(cards).find(([d]) => A.intents.get(d)?.device === 'A1')!
    const winner = [...digests][0]!
    if (a1[0] !== winner) {
      expect(a1[1]).toBe('cancelled')
      expect(cardDocs(w, act)).toBe(1)
    } else expect(cardDocs(w, act)).toBe(2) // A1s Karte gewinnt, A2s war schon eingereicht: beide hinaus, B sieht eine Wiederholung
  }, 300_000)
})

// K1a Schritt 2 (Anton 18.10., Optionen 1+2): Vereinigung eigener Tupel durch Neuauswertung empfangener Proben. Ein
// Gerät behält die Probe der Gegenseite je eigenem Ankunftstupel, solange Einträge darin nichts getroffen haben. Wächst
// die eigene Tupelmenge durch das Journal (ein Schwestergerät hat ein Tupel geöffnet), wertet es die behaltenen Proben
// gegen die nun größere Menge eigener Paar-Anker neu aus (6960/6806). Ein Treffer verpflichtet zum eigenen Mapping
// (6845.1) wie bei der ersten Auswertung; vereinigt wird nur auf das verifizierte Mapping der Gegenseite (6975.1/.2).
// Kein neuer Rahmen, kein neuer Kandidat, 6750 unberührt, keine Uhr. Grenze (Option 2): öffnen beide Personen auf je zwei
// Geräten nebenläufig (X7 streng), enthält keine eingefrorene Probe das andere Tupel; das Doppel heilt bei der nächsten
// Begegnung (X7b).
//   1. X7 streng: nicht bestanden, das Doppel heilt bei der nächsten Begegnung; seriell bestanden.
//   1b. X7b: dritte Begegnung nach dem symmetrischen Paar: ein Eintrag mit drei Tupeln je Gerät, keine Doppelwirkung.
//   1c. Gegenlauf: K1a ohne Neuauswertung verfehlt X14 und den asymmetrischen Fall.
//   2. X14 besteht mit zwei Geräten und seriell.
//   3. Alle Szenarien mit zwei Geräten wie in NOTES.
//   4. Asymmetrisch (Tor-Review 13): nur A hat zwei Geräte; Bs Probe auf dem zweiten Tupel trägt das erste; A2 behält sie
//      und trifft nach dem Journal, ohne jede Probe von A.
//   5. A1 und A2 vereinigen getrennt voneinander (A2 aus der Neuauswertung, A1 auf Bs Antwort): nach der Heilung ein
//      Eintrag, eine Vereinigungswirkung, Ledger sauber.
//   6. Doppelte und umgeordnete Batches: genau eine Vereinigungswirkung, gleiche Projektion.
//   7. Aufbewahrung: getroffene Einträge fallen weg; beim Abgang der Beziehung fällt die Probe weg.
//   7b. Tor-Review 16 B1: auch ein Abgang aus dem Journal löscht die behaltene Probe (Faltung, nicht nur `depart()`).
//   7c. Tor-Review 16 B2: je Ankunftstupel nur die jüngste Probe (aus 6750: eine Wiederholung zeigt nichts Neues).
//   7d. Tor-Review 16 S2: behaltene Proben reisen mit dem Enrollment-Abbild.
//   8. Eichung: K0 verfehlt X7 und X14 mit zwei Geräten weiter (kein Journal, keine Neuauswertung).

async function twoByOne(opts: Parameters<typeof k1a>[0] = {}) {
  const w = new Welt15(k1a(opts))
  const A = await w.person('A', 'A1')
  const B = await w.person('B', 'B1')
  const Mm = await w.person('M', 'M1')
  await w.encounter(A, Mm)
  await w.encounter(B, Mm)
  await w.rounds(2)
  const A2 = await w.enrol(A, 'A2')
  await w.rounds(3)
  const selfA = (await A.cand.keys.pair('self/A')).rkid
  return { w, A, A2, B, selfA }
}
const relsTo = (w: Welt15, d: HolderDevice, other: string) => d.state.relationships.filter((r) => !r.departed && r.tuples.some((t) => w.personOf(t.peer) === other))
const tuplesTo = (w: Welt15, d: HolderDevice, other: string) => relsTo(w, d, other).flatMap((r) => r.tuples)
/** Effekt-Id → erzeugende Operationen über alle Geräte einer Person (wie das Ledger-Orakel der Szenarien). */
function ledgerOf(w: Welt15, person: string) {
  const m = new Map<string, Set<string>>()
  for (const d of w.of(person)) for (const e of d.state.effects) {
    if (!m.has(e.id)) m.set(e.id, new Set())
    m.get(e.id)!.add(e.op)
  }
  return m
}
const doubles = (w: Welt15, person: string) => [...ledgerOf(w, person).entries()].filter(([, ops]) => ops.size > 1).map(([id]) => id)
const unions = (w: Welt15, person: string) => [...ledgerOf(w, person).keys()].filter((id) => id.startsWith('union:'))
const isProbeOf = (w: Welt15, person: string) => (f: { bytes: Uint8Array }) => {
  const o = w.frameOrigin(f.bytes)
  return o?.kind === 'continuity-probe' && w.of(person).some((d) => d.name === o.device)
}
/** K1a ohne Neuauswertung (Gegenlauf). */
function withoutReevaluation() {
  const base = k1a()
  const off = <T extends object>(d: T): T => Object.assign(d, { reevaluateProbes: false })
  return { ...base, first: async (...a: Parameters<typeof base.first>) => off(await base.first(...a)), enrol: async (...a: Parameters<typeof base.enrol>) => { const r = await base.enrol(...a); off(r.cand); return r } }
}

describe('K1a Schritt 2: Vereinigung eigener Tupel durch Neuauswertung empfangener Proben', () => {
  it('1. X7 streng: A1 trifft B1, A2 trifft B2 nebenläufig: nicht bestanden, das Doppel heilt bei der nächsten Begegnung; seriell bestanden', async () => {
    const two = byId(await runX15(k1a(), false, ['X7'])).X7!
    expect(two.crashed, two.detail).toBeFalsy()
    expect(two.outcome, two.detail).toBe('nicht bestanden')
    expect(two.measures.duplicates as number).toBeGreaterThan(0)
    expect(two.detail).toMatch(/heilt bei der nächsten Begegnung \(X7b\)/)
    const one = byId(await runX15(k1a({ devices: 1 }), true, ['X7'])).X7!
    expect(one.crashed, one.detail).toBeFalsy()
    expect(one.outcome, one.detail).toBe('bestanden')
  }, 600_000)

  it('1b. X7b: dritte Begegnung nach dem symmetrischen Paar: ein Eintrag mit drei Tupeln je Gerät, keine Doppelwirkung (zwei Geräte und seriell)', async () => {
    const two = byId(await runX15(k1a(), false, ['X7b'])).X7b!
    expect(two.crashed, two.detail).toBeFalsy()
    expect(two.measures.entriesBefore, two.detail).toBe(2)
    expect(two.measures.entriesAfter, two.detail).toBe(1)
    expect(two.measures.tuplesAfter, two.detail).toBe(3)
    expect(two.measures.doubleFinalEffects, two.detail).toBe(0)
    expect(two.measures.roundsToOneEntry as number, two.detail).toBeGreaterThan(0)
    expect(two.outcome, two.detail).toBe('bestanden')
    const one = byId(await runX15(k1a({ devices: 1 }), true, ['X7b'])).X7b!
    expect(one.crashed, one.detail).toBeFalsy()
    expect(one.outcome, one.detail).toBe('bestanden')
  }, 600_000)

  it('1c. Gegenlauf: K1a ohne Neuauswertung (`reevaluateProbes` aus) verfehlt X14 wie vor Schritt 2', async () => {
    const x = byId(await runX15(withoutReevaluation(), false, ['X14'])).X14!
    expect(x.crashed, x.detail).toBeFalsy()
    expect(x.outcome, x.detail).toBe('nicht bestanden')
    expect(x.measures.duplicates as number).toBeGreaterThan(0)
  }, 300_000)

  it('2. X14: zwei Vorstellungen derselben Person C, B1 und B2 stimmen getrennt zu: B und C vereinigen (zwei Geräte und seriell)', async () => {
    const two = byId(await runX15(k1a(), false, ['X14'])).X14!
    expect(two.crashed, two.detail).toBeFalsy()
    expect(two.measures.actsIssued, two.detail).toBe(2)
    expect(two.measures.duplicates, two.detail).toBe(0)
    expect(two.measures.doubleFinalEffects, two.detail).toBe(0)
    expect(two.outcome, two.detail).toBe('bestanden')
    const one = byId(await runX15(k1a({ devices: 1 }), true, ['X14'])).X14!
    expect(one.crashed, one.detail).toBeFalsy()
    expect(one.outcome, one.detail).toBe('bestanden')
  }, 600_000)

  it('3. alle Szenarien mit zwei Geräten: X14 und X7b bestanden, X7 streng nicht, X3 und X18 bestanden mit „Zusage geändert“ (Schritt 3), der Rest wie in NOTES', async () => {
    const r = byId(await runX15(k1a(), false))
    for (const x of Object.values(r)) expect(x.crashed, `${x.scenario}: ${x.detail}`).toBeFalsy()
    const want: Record<string, string> = {
      X1: 'bestanden', X2: 'bestanden', X3: 'bestanden', X4: 'bestanden', X5: 'bestanden', X6: 'bestanden', X7: 'nicht bestanden', X7b: 'bestanden', X8: 'bestanden', X9: 'nicht bestanden', X10: 'nicht abbildbar', X11: 'bestanden', X12: 'bestanden',
      X13: 'bestanden', X14: 'bestanden', X15: 'bestanden', X16: 'nicht bestanden', X17: 'nicht bestanden', X18: 'bestanden', X21: 'bestanden',
    }
    for (const [id, outcome] of Object.entries(want)) expect(r[id]?.outcome, `${id}: ${r[id]?.detail}`).toBe(outcome)
    // Zusage geändert (Schritt 3) genau bei X3 und X18; jede andere Zelle unverändert ohne Marke.
    expect(Object.values(r).filter((x) => x.promiseChanged).map((x) => x.scenario).sort()).toEqual(['X18', 'X3'])
  }, 1_800_000)

  it('4. Tor-Review 13, asymmetrisch: nur A hat zwei Geräte; A2 behält Bs Probe und trifft nach dem Journal, ohne jede Probe von A', async () => {
    const { w, A, A2, B, selfA } = await twoByOne()
    // Keine Probe von A erreicht B, über den ganzen Lauf; das Journal zwischen A1 und A2 bleibt aus, bis Bs Proben ausgewertet sind.
    const from = w.carrier.carried.length
    w.carrier.faults.drop(isProbeOf(w, 'A'))
    for (const d of w.of('A')) w.carrier.faults.withhold(d.name, (f) => f.address === selfA)
    const first = await w.encounter(A, B)
    const second = await w.encounter(A2, B)
    // B hat ein Gerät: sein zweites Tupel trägt das erste als Kandidaten (2300), die Probe darauf geht an A2.
    expect(M.tuple(B.state, second.y.id).candidates).toContain(first.x.own)
    await w.rounds(3)
    expect(relsTo(w, B, 'A').length, 'Bs Probe hat bei A2 nichts getroffen').toBe(2)
    // Bs Probe auf dem zweiten Tupel trägt zwei Einträge: Bs Beziehung zu M (trifft bei A nie) und das erste Tupel.
    expect(A2.keptProbes().get(second.x.id)?.length, 'A2 behält Bs Probe auf dem zweiten Tupel').toBe(2)
    w.carrier.faults.reset()
    w.carrier.faults.drop(isProbeOf(w, 'A'))
    await w.rounds(20)
    for (const d of [A, A2]) expect(relsTo(w, d, 'B').map((r) => r.tuples.length), d.name).toEqual([2])
    expect(relsTo(w, B, 'A').map((r) => r.tuples.length), 'B1').toEqual([2])
    expect(w.agree('A')).toEqual({ agree: true, diff: '' })
    expect(doubles(w, 'A')).toEqual([])
    expect(doubles(w, 'B')).toEqual([])
    expect(A2.keptProbes().get(second.x.id)?.length, 'der getroffene Eintrag fällt weg, der für Bs Beziehung zu M bleibt').toBe(1)
    // Kein Rahmen von A außer den Mappings, die der Treffer und die Antwortpflicht schulden.
    const fromA = w.carrier.carried.slice(from).map((f) => w.frameOrigin(f.bytes)).filter((o) => o && w.of('A').some((d) => d.name === o.device) && o.kind.startsWith('continuity'))
    const aProbes = w.carrier.carried.slice(from).filter(isProbeOf(w, 'A'))
    expect(aProbes.length, 'A hat geprobt (Proben auf den neuen Tupeln)').toBeGreaterThan(0)
    expect(aProbes.every((f) => w.carrier.swallowed.includes(f)), 'keine Probe von A kam an').toBe(true)
    const mappings = fromA.filter((o) => o!.kind === 'continuity-mapping')
    expect(mappings.length, 'ein Mapping von A (A2, aus der Neuauswertung)').toBeGreaterThan(0)
    expect(new Set(mappings.map((o) => o!.device))).toContain('A2')
  }, 180_000)

  it('5. A1 und A2 vereinigen getrennt voneinander (Journal zurückgehalten): nach der Heilung ein Eintrag, eine Vereinigungswirkung, Ledger sauber', async () => {
    const { w, A, A2, B, selfA } = await twoByOne()
    for (const d of w.of('A')) w.carrier.faults.withhold(d.name, (f) => f.address === selfA)
    await w.encounter(A, B)
    await w.encounter(A2, B)
    await w.rounds(3)
    expect(A2.keptProbes().size).toBe(1)
    w.carrier.faults.reset()
    // Sobald beide A-Geräte beide Tupel zu B kennen, sind sie voneinander getrennt: A2 trifft aus der Neuauswertung, A1
    // vereinigt auf Bs Antwort-Mapping, ohne von A2s Pflicht zu wissen.
    let separated = false
    const separate = () => {
      if (separated || tuplesTo(w, A, 'B').length !== 2 || tuplesTo(w, A2, 'B').length !== 2) return
      separated = true
      for (const d of w.of('A')) w.carrier.faults.withhold(d.name, (f) => f.address === selfA)
    }
    const united = (d: HolderDevice) => relsTo(w, d, 'B').map((r) => r.tuples.length).join() === '2'
    for (let i = 0; i < 20 && !(united(A) && united(A2)); i++) await w.rounds(1, separate)
    expect(separated).toBe(true)
    expect(united(A), 'A1 hält einen Eintrag mit beiden Tupeln').toBe(true)
    expect(united(A2), 'A2 hält einen Eintrag mit beiden Tupeln').toBe(true)
    const own = (d: HolderDevice) => d.state.effects.filter((e) => e.id.startsWith('union:') && e.op.startsWith(`${d.name}@`)).length
    expect(own(A), 'A1 vereinigt selbst').toBeGreaterThan(0)
    expect(own(A2), 'A2 vereinigt selbst').toBeGreaterThan(0)
    w.carrier.faults.reset()
    let stable = 0
    for (let i = 0; i < 30 && stable < 3; i++) {
      await w.rounds(1)
      stable = w.agree('A').agree ? stable + 1 : 0
    }
    expect(w.agree('A')).toEqual({ agree: true, diff: '' })
    for (const d of [A, A2]) expect(relsTo(w, d, 'B').map((r) => r.tuples.length)).toEqual([2])
    expect(relsTo(w, B, 'A').map((r) => r.tuples.length)).toEqual([2])
    expect(unions(w, 'A').length).toBe(1)
    expect(doubles(w, 'A')).toEqual([])
    expect(doubles(w, 'B')).toEqual([])
    for (const d of [...w.of('A'), B]) expect(d.state.applied.filter((k, i, a) => a.indexOf(k) !== i), d.name).toEqual([])
  }, 180_000)

  it('6. doppelte und umgeordnete Batches: genau eine Vereinigungswirkung, gleiche Projektion', async () => {
    const { w, A, A2, B, selfA } = await twoByOne()
    for (const d of w.of('A')) w.carrier.faults.withhold(d.name, (f) => f.address === selfA)
    await w.encounter(A, B)
    await w.encounter(A2, B)
    await w.rounds(3)
    w.carrier.faults.reset()
    w.carrier.faults.duplicate(true)
    w.carrier.faults.reverse(true)
    let stable = 0
    for (let i = 0; i < 40 && stable < 3; i++) {
      await w.rounds(1)
      const united = [A, A2].every((d) => relsTo(w, d, 'B').length === 1) && relsTo(w, B, 'A').length === 1
      stable = united && w.agree('A').agree ? stable + 1 : 0
    }
    w.carrier.faults.reset()
    expect(stable).toBe(3)
    expect(M.canonical(A2.projection())).toBe(M.canonical(A.projection()))
    for (const d of [A, A2, B]) {
      expect(d.state.applied.filter((k, i, a) => a.indexOf(k) !== i), d.name).toEqual([])
      const ids = d.state.effects.map((e) => e.id).filter((id) => id.startsWith('union:'))
      expect(new Set(ids).size, d.name).toBe(ids.length)
    }
    expect(unions(w, 'A').length).toBe(1)
    expect(unions(w, 'B').length).toBe(1)
    expect(doubles(w, 'A')).toEqual([])
    expect(doubles(w, 'B')).toEqual([])
    // Ein bekannter Vereinigungsbatch ein weiteres Mal geliefert: nichts Neues.
    const batch = [A, A2].flatMap((d) => (d.cand as K1aDevice).journal()).find((b) => b.ops.some((o) => o.kind === 'union'))!
    for (const d of [A, A2]) expect((d.cand as K1aDevice).receiveOwnFrame(new TextEncoder().encode(JSON.stringify(batch)))).toEqual({ ops: [], intents: [] })
  }, 180_000)

  it('7. Aufbewahrung: die Probe wird je Ankunftstupel gehalten, bis ihre Einträge getroffen haben oder die Beziehung abgeht', async () => {
    const { w, A, A2, B, selfA } = await twoByOne()
    for (const d of w.of('A')) w.carrier.faults.withhold(d.name, (f) => f.address === selfA)
    await w.encounter(A, B)
    const second = await w.encounter(A2, B)
    await w.rounds(3)
    expect(A2.keptProbes().get(second.x.id), 'zwei offene Einträge: Bs Beziehung zu M und Bs erstes Tupel').toHaveLength(2)
    // Die Probe übersteht einen Neuaufbau aus dem Store (Teil des Geräteabbilds).
    const kept = A2.keptProbes().get(second.x.id)!.slice()
    await A2.reload()
    expect(A2.keptProbes().get(second.x.id)).toEqual(kept)
    expect(await A2.depart(M.relOfTuple(A2.state, second.x.id)!.id)).toBe('ok')
    expect(A2.keptProbes().has(second.x.id), 'Abgang: die Probe fällt weg').toBe(false)
    w.carrier.faults.reset()
    await w.rounds(10)
    expect(A2.state.effects.filter((e) => e.id.startsWith('union:'))).toEqual([])
  }, 120_000)

  it('7b. Tor-Review 16 B1: ein Abgang aus dem Journal löscht die behaltene Probe der Beziehung wie ein lokaler, auch im Store-Abbild', async () => {
    const { w, A, A2, B } = await twoByOne()
    const t = await w.encounter(A, B)
    await w.rounds(3)
    // Bs Probe trägt nur Bs Beziehung zu M: trifft bei A nie und bleibt beim empfangenden Gerät.
    const holder = [A, A2].find((d) => d.keptProbes().has(t.x.id))
    expect(holder, 'ein A-Gerät behält Bs Probe').toBeDefined()
    const other = holder === A ? A2 : A
    await w.rounds(3)
    const rel = M.relOfTuple(other.state, t.x.id)
    expect(rel, 'das andere Gerät kennt die Beziehung aus dem Journal').toBeDefined()
    expect(await other.depart(rel!.id)).toBe('ok')
    for (let i = 0; i < 8 && !M.relOfTuple(holder!.state, t.x.id)?.departed; i++) await w.rounds(1)
    expect(M.relOfTuple(holder!.state, t.x.id)?.departed, 'der Abgang ist gefaltet').toBe(true)
    expect(holder!.keptProbes().has(t.x.id), 'gefalteter Abgang: die Probe fällt weg').toBe(false)
    await holder!.reload()
    expect(holder!.keptProbes().has(t.x.id), 'auch im Store-Abbild').toBe(false)
  }, 120_000)

  it('7c. Tor-Review 16 B2: je Ankunftstupel nur die jüngste Probe; vier Proben mit disjunkten Einträgen: es bleiben die der letzten', async () => {
    const w = new Welt15(k1a())
    const A = await w.person('A', 'A1')
    const B = await w.person('B', 'B1')
    const t = await w.encounter(A, B) // B hat keine weitere Beziehung: keine eigene Probe
    await w.rounds(2)
    expect(A.keptProbes().size).toBe(0)
    const sendProbe = (B as unknown as { sendProbe(t: M.Tuple): Promise<void> }).sendProbe.bind(B)
    const kept: string[][] = []
    for (let i = 0; i < 4; i++) {
      // Signierte, verschlüsselte Probe der Gegenseite mit einem anderen Eintrag (Gegenlauf Astra).
      await sendProbe({ ...M.tuple(B.state, t.y.id), candidates: [`fremd-${i}`] })
      await w.rounds(2)
      kept.push([...(A.keptProbes().get(t.x.id) ?? [])])
    }
    for (const k of kept) expect(k).toHaveLength(1)
    expect(new Set(kept.map((k) => k[0])).size, 'vier verschiedene Einträge').toBe(4)
    expect(A.keptProbes().get(t.x.id), 'nur die Einträge der letzten Probe').toEqual(kept[3])
  }, 120_000)

  it('7d. Tor-Review 16 S2: ein eingeschriebenes Gerät übernimmt die behaltenen Proben; A3 aus A2, A2 offline, A3 wertet aus und vereinigt', async () => {
    const { w, A, A2, B, selfA } = await twoByOne({ devices: 3 })
    w.carrier.faults.drop(isProbeOf(w, 'A'))
    for (const d of w.of('A')) w.carrier.faults.withhold(d.name, (f) => f.address === selfA)
    await w.encounter(A, B)
    const second = await w.encounter(A2, B)
    await w.rounds(3)
    expect(A2.keptProbes().get(second.x.id), 'A2 behält Bs Probe auf dem zweiten Tupel').toHaveLength(2)
    const A3 = await w.enrol(A2, 'A3')
    expect(A3.keptProbes().get(second.x.id), 'die Probe reist mit dem Enrollment-Abbild').toEqual(A2.keptProbes().get(second.x.id))
    A2.online = false
    w.carrier.faults.reset()
    w.carrier.faults.drop(isProbeOf(w, 'A'))
    const from = w.carrier.carried.length
    for (let i = 0; i < 20 && !(relsTo(w, A, 'B').length === 1 && relsTo(w, A3, 'B').length === 1 && relsTo(w, B, 'A').length === 1); i++) await w.rounds(1)
    for (const d of [A, A3]) expect(relsTo(w, d, 'B').map((r) => r.tuples.length), d.name).toEqual([2])
    expect(relsTo(w, B, 'A').map((r) => r.tuples.length), 'B1').toEqual([2])
    const mappings = w.carrier.carried.slice(from).map((f) => w.frameOrigin(f.bytes)).filter((o) => o?.kind === 'continuity-mapping' && o.device.startsWith('A'))
    expect(new Set(mappings.map((o) => o!.device)), 'A3 mappt aus der Neuauswertung, ohne A2').toContain('A3')
    expect(doubles(w, 'B')).toEqual([])
  }, 180_000)

  it('8. Eichung: K0 verfehlt X7 und X14 mit zwei Geräten weiter', async () => {
    const r = byId(await runX15(k0(), false, ['X7', 'X14']))
    for (const x of Object.values(r)) expect(x.crashed, x.detail).toBeFalsy()
    expect(r.X7!.outcome, r.X7!.detail).toBe('nicht bestanden')
    expect(r.X7!.measures.duplicates as number).toBeGreaterThan(0)
    expect(r.X14!.outcome, r.X14!.detail).toBe('nicht bestanden')
  }, 600_000)
})
