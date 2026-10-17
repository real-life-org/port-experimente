import { describe, expect, it, vi } from 'vitest'
import { Welt15 } from '../src/lab/mehrgeraet/welt'
import { frameHash, HolderDevice } from '../src/lab/mehrgeraet/holder'
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

  it('X18: A1 und A2 stimmen getrennt demselben Akt zu und produzieren je eine Karte: B sieht eine Verbindung, A bleibt uneins über die Übergabe', async () => {
    const two = byId(await runX15(k1a(), false, ['X18'])).X18!
    expect(two.crashed, two.detail).toBeFalsy()
    expect(two.measures.cardsProducedByA).toBe(2) // zwei Karten-Dokumente eines Akts
    expect(two.measures.connectsAtB).toBe(1)
    // Ein Seed: beide Karten tragen denselben Kartenschlüssel, B sieht eine Wiederholung (8910.7), keinen Konflikt (8910.8).
    expect(two.measures.cardConflictsAtB).toBe(0)
    // Die Faltung hat keine Regel für zwei Übergaben eines Akts: jedes Gerät behält eine andere (Digest, O), die Projektionen bleiben verschieden.
    expect(two.measures.handOverDigestsOnA).toBe(2)
    expect(two.measures.projectionAgrees).toBe(0)
    // Review 11 B1: das Ledger-Orakel zählt die Endwirkungen beider Personen; A hat Zustimmung und Verbindung je aus zwei Operationen.
    expect(two.measures.doubleFinalEffectsA).toBe(2)
    expect(two.measures.doubleFinalEffectsB).toBe(0)
    expect(two.measures.doubleFinalEffects).toBe(2)
    expect(two.measures.doubleEffectKindsA).toBe('connect, consent')
    expect(two.detail).toMatch(/doppelte Endwirkungen bei A: 2/)
    expect(two.outcome, two.detail).toBe('nicht bestanden')
    const one = byId(await runX15(k1a({ devices: 1 }), true, ['X18'])).X18!
    expect(one.crashed, one.detail).toBeFalsy()
    expect(one.outcome, one.detail).toBe('bestanden')
    expect(one.measures.cardsProducedByA).toBe(1)
    expect(one.measures.doubleFinalEffects).toBe(0)
  }, 600_000)

  it('X18 Gegenlauf (Review 11 B1): ohne den Übergabe-Digest in der Projektion sind As Geräte gleich; das Orakel fängt As doppelte Endwirkungen trotzdem', async () => {
    const proto = HolderDevice.prototype as unknown as { projection: () => M.Projection }
    const projection = proto.projection
    const spy = vi.spyOn(proto, 'projection').mockImplementation(function (this: HolderDevice) {
      const p = projection.call(this)
      for (const a of Object.values(p.acts)) a.ownCardDigest = null
      return p
    })
    try {
      const x = byId(await runX15(k1a(), false, ['X18'])).X18!
      expect(x.crashed, x.detail).toBeFalsy()
      expect(x.measures.projectionAgrees, x.detail).toBe(1) // die Digest-Divergenz ist ausgeblendet
      expect(x.measures.doubleFinalEffectsA, x.detail).toBe(2)
      expect(x.outcome, x.detail).toBe('nicht bestanden')
    } finally {
      spy.mockRestore()
    }
  }, 600_000)
})

// K1a Schritt 2 (Anton 18.10.): Vereinigung eigener Tupel. Zwei Geräte derselben Person öffnen nebenläufig je ein Tupel
// zur selben Gegenperson; das Journal teilt die Tupel, aber keine Probe hat das andere Tupel geprüft (2300 ist je Gerät
// eingefroren). Das Gerät, das zwei nebenläufige eigene Tupel hält, ergänzt die Kandidatenliste des später geöffneten
// Tupels (`openedAt`) um das frühere und probt nach; die Gegenseite trifft, mappt, und die Vereinigung entsteht wie
// immer aus einem verifizierten Mapping (6975.1, 6975.2), als Operation im Journal.
//   1. X7 besteht mit zwei Geräten.
//   2. X14 besteht mit zwei Geräten.
//   3. Alle übrigen Szenarien wie in NOTES (X15 besteht weiter).
//   4. Beide Geräte vereinigen getrennt voneinander: nach der Heilung ein Eintrag, eine Vereinigungswirkung je Kante.
//   5. Doppelte und umgeordnete Batches: genau eine Wirkung, gleiche Projektion.
//   6. K0 verfehlt X7 mit zwei Geräten weiter (Eichung).
//   Tor-Review 13:
//   7. B2: eine einseitige späte Probe, die über die Aufgabegrenze verloren geht, wird mit denselben Bytes wiederholt;
//      danach ein Eintrag je Gerät.
//   8. B1 (Anton 18.10. Option (i')): nur das später geöffnete Tupel trägt nach und probt, das frühere nie (6750), auch wenn
//      die Record-Anker umgekehrt liegen.
//   8b. Gleichstand (gleiches `openedAt`): kein Nachtrag, keine späte Probe (Prüfstandsannahme, NOTES).

async function twoByTwo() {
  const w = new Welt15(k1a())
  const A = await w.person('A', 'A1')
  const B = await w.person('B', 'B1')
  const Mm = await w.person('M', 'M1')
  await w.encounter(A, Mm)
  await w.encounter(B, Mm)
  await w.rounds(2)
  const A2 = await w.enrol(A, 'A2')
  const B2 = await w.enrol(B, 'B2')
  await w.rounds(3)
  return { w, A, A2, B, B2 }
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

describe('K1a Schritt 2: Vereinigung eigener Tupel', () => {
  it('1. X7: A1 trifft B1, A2 trifft B2 in derselben Runde: jedes Gerät hält einen Eintrag mit beiden Tupeln (zwei Geräte und seriell)', async () => {
    const two = byId(await runX15(k1a(), false, ['X7'])).X7!
    expect(two.crashed, two.detail).toBeFalsy()
    expect(two.outcome, two.detail).toBe('bestanden')
    expect(two.measures.duplicates).toBe(0)
    const one = byId(await runX15(k1a({ devices: 1 }), true, ['X7'])).X7!
    expect(one.crashed, one.detail).toBeFalsy()
    expect(one.outcome, one.detail).toBe('bestanden')
  }, 600_000)

  it('1b. Gegenlauf: K1a ohne späte Probe (`lateProbes` aus) verfehlt X7 wie vor Schritt 2', async () => {
    const base = k1a()
    const off = <T extends object>(d: T): T => Object.assign(d, { lateProbes: false })
    const without = { ...base, first: async (...a: Parameters<typeof base.first>) => off(await base.first(...a)), enrol: async (...a: Parameters<typeof base.enrol>) => { const r = await base.enrol(...a); off(r.cand); return r } }
    const x = byId(await runX15(without, false, ['X7'])).X7!
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

  it('3. alle Szenarien mit zwei Geräten: nur X7 und X14 wechseln auf bestanden, der Rest wie in NOTES', async () => {
    const r = byId(await runX15(k1a(), false))
    for (const x of Object.values(r)) expect(x.crashed, `${x.scenario}: ${x.detail}`).toBeFalsy()
    const want: Record<string, string> = {
      X1: 'bestanden', X2: 'bestanden', X3: 'nicht bestanden', X4: 'bestanden', X5: 'bestanden', X6: 'bestanden', X7: 'bestanden', X8: 'bestanden', X9: 'nicht bestanden', X10: 'nicht abbildbar', X11: 'bestanden', X12: 'bestanden',
      X13: 'bestanden', X14: 'bestanden', X15: 'bestanden', X16: 'nicht bestanden', X17: 'nicht bestanden', X18: 'nicht bestanden', X21: 'bestanden',
    }
    for (const [id, outcome] of Object.entries(want)) expect(r[id]?.outcome, `${id}: ${r[id]?.detail}`).toBe(outcome)
  }, 1_800_000)

  it('4. A1 und A2 vereinigen getrennt voneinander (Journal zurückgehalten): nach der Heilung ein Eintrag, eine Vereinigungswirkung je Kante, Ledger sauber', async () => {
    const { w, A, A2, B, B2 } = await twoByTwo()
    const selfA = (await A.cand.keys.pair('self/A')).rkid
    await w.encounter(A, B)
    w.clock.advance(1000) // zwei Begegnungen, nicht in derselben Millisekunde (Gleichstand: Test 8b)
    await w.encounter(A2, B2)
    // Sobald beide A-Geräte beide Tupel zu B kennen, sind sie voneinander getrennt: jedes vereinigt für sich.
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
    // Jedes Gerät hat aus eigener Operation vereinigt.
    const own = (d: HolderDevice) => d.state.effects.filter((e) => e.id.startsWith('union:') && e.op.startsWith(`${d.name}@`)).length
    expect(own(A), 'A1 vereinigt selbst').toBeGreaterThan(0)
    expect(own(A2), 'A2 vereinigt selbst').toBeGreaterThan(0)
    w.carrier.faults.reset()
    let stable = 0
    for (let i = 0; i < 30 && stable < 3; i++) {
      await w.rounds(1)
      stable = w.agree('A').agree && w.agree('B').agree ? stable + 1 : 0
    }
    expect(w.agree('A')).toEqual({ agree: true, diff: '' })
    expect(w.agree('B')).toEqual({ agree: true, diff: '' })
    for (const d of [A, A2]) expect(relsTo(w, d, 'B').map((r) => r.tuples.length)).toEqual([2])
    for (const d of [B, B2]) expect(relsTo(w, d, 'A').map((r) => r.tuples.length)).toEqual([2])
    expect(unions(w, 'A').length).toBe(1)
    expect(doubles(w, 'A')).toEqual([])
    expect(doubles(w, 'B')).toEqual([])
    for (const d of [...w.of('A'), ...w.of('B')]) expect(d.state.applied.filter((k, i, a) => a.indexOf(k) !== i), d.name).toEqual([])
  }, 180_000)

  it('5. doppelte und umgeordnete Batches: genau eine Vereinigungswirkung, gleiche Projektion', async () => {
    const { w, A, A2, B, B2 } = await twoByTwo()
    w.carrier.faults.duplicate(true)
    w.carrier.faults.reverse(true)
    await w.encounter(A, B)
    w.clock.advance(1000)
    await w.encounter(A2, B2)
    let stable = 0
    for (let i = 0; i < 40 && stable < 3; i++) {
      await w.rounds(1)
      const united = [A, A2].every((d) => relsTo(w, d, 'B').length === 1) && [B, B2].every((d) => relsTo(w, d, 'A').length === 1)
      stable = united && w.agree('A').agree && w.agree('B').agree ? stable + 1 : 0
    }
    w.carrier.faults.reset()
    expect(stable).toBe(3)
    expect(M.canonical(A2.projection())).toBe(M.canonical(A.projection()))
    expect(M.canonical(B2.projection())).toBe(M.canonical(B.projection()))
    for (const d of [A, A2, B, B2]) {
      expect(d.state.applied.filter((k, i, a) => a.indexOf(k) !== i), d.name).toEqual([])
      const ids = d.state.effects.map((e) => e.id).filter((id) => id.startsWith('union:'))
      expect(new Set(ids).size, d.name).toBe(ids.length)
    }
    expect(unions(w, 'A').length).toBe(1)
    expect(unions(w, 'B').length).toBe(1)
    expect(doubles(w, 'A')).toEqual([])
    expect(doubles(w, 'B')).toEqual([])
    // Ein bekannter Vereinigungsbatch ein weiteres Mal geliefert: nichts Neues.
    const batch = (A.cand as K1aDevice).journal().find((b) => b.ops.some((o) => o.kind === 'union'))!
    expect((A2.cand as K1aDevice).receiveOwnFrame(new TextEncoder().encode(JSON.stringify(batch)))).toEqual({ ops: [], intents: [] })
  }, 180_000)

  it('7. Tor-Review 13 B2: einseitige späte Probe geht verloren (A-Probes 20 Runden verworfen): die Pflicht bleibt offen, nach der Störung ein Eintrag je Gerät', async () => {
    // Astras Gegenlauf: A1 und A2 öffnen getrennt (Journal zurückgehalten) je ein Tupel zu B1; B1 öffnet seriell, seine
    // ursprüngliche Probe trifft bei A2 nichts, weil A2 A1s Tupel noch nicht kennt. B1 hat kein nebenläufiges Paar und
    // probt nie spät; die Vereinigung hängt allein an As später Probe. Die geht 20 Runden lang verloren (über die
    // Aufgabegrenze der Zustellung hinaus), dann 40 störungsfreie Runden.
    const w = new Welt15(k1a())
    const A = await w.person('A', 'A1')
    const B = await w.person('B', 'B1')
    const Mm = await w.person('M', 'M1')
    await w.encounter(A, Mm)
    await w.encounter(B, Mm)
    await w.rounds(2)
    const A2 = await w.enrol(A, 'A2')
    await w.rounds(3)
    const selfA = (await A.cand.keys.pair('self/A')).rkid
    for (const d of w.of('A')) w.carrier.faults.withhold(d.name, (f) => f.address === selfA)
    await w.encounter(A, B)
    w.clock.advance(1000)
    await w.encounter(A2, B)
    await w.rounds(3)
    expect(relsTo(w, B, 'A').length, 'B1s ursprüngliche Probe hat bei A2 nichts getroffen').toBe(2)
    w.carrier.faults.reset()
    const isAProbe = (f: { bytes: Uint8Array }) => {
      const o = w.frameOrigin(f.bytes)
      return o?.kind === 'continuity-probe' && (o.device === 'A1' || o.device === 'A2')
    }
    const from = w.carrier.carried.length
    w.carrier.faults.drop(isAProbe)
    await w.rounds(20)
    expect(tuplesTo(w, A, 'B').length, 'A1 kennt beide Tupel').toBe(2)
    expect(tuplesTo(w, A2, 'B').length, 'A2 kennt beide Tupel').toBe(2)
    expect(relsTo(w, A, 'B').length, 'während der Störung noch zwei Einträge').toBe(2)
    w.carrier.faults.reset()
    await w.rounds(40)
    expect(w.agree('A')).toEqual({ agree: true, diff: '' })
    for (const d of [A, A2]) expect(relsTo(w, d, 'B').map((r) => r.tuples.length), d.name).toEqual([2])
    expect(relsTo(w, B, 'A').map((r) => r.tuples.length), 'B1').toEqual([2])
    expect(doubles(w, 'A')).toEqual([])
    expect(doubles(w, 'B')).toEqual([])
    // Die späte Probe ging erneut hinaus: dieselben Bytes nach der Aufgabe, keine neue Produktion. Lernen A1 und A2 das
    // andere Tupel in derselben Runde, probt jedes Gerät einmal (nebenläufig dasselbe, siehe `lateProbes`).
    const late = w.carrier.carried.slice(from).filter(isAProbe)
    const byHash = new Map<string, { device: string; n: number }>()
    for (const f of late) {
      const h = frameHash(f.bytes)
      const e = byHash.get(h) ?? { device: w.frameOrigin(f.bytes)!.device, n: 0 }
      e.n++
      byHash.set(h, e)
    }
    const producers = [...byHash.values()].map((e) => e.device)
    expect(new Set(producers).size, 'höchstens eine späte Probe je Gerät').toBe(producers.length)
    expect(Math.max(...[...byHash.values()].map((e) => e.n)), 'nach der Aufgabe erneut eingeliefert').toBeGreaterThan(1)
  }, 180_000)

  it('8. Tor-Review 13 B1 (Gegenlauf): nur das später geöffnete Tupel erhält den späten Kandidaten und probt; das frühere nie', async () => {
    // Tor-Review 13 B1, Anton 18.10. Option (i'): A1 öffnet `z-first` zu B; eine Sekunde später öffnet A2 ohne
    // Journalaustausch `a-second` zu C. Der Record-Anker ist umgekehrt zur Öffnungszeit (`z-first:…` > `a-second:…`), die
    // Richtung folgt aber `openedAt`: das spätere Tupel `a-second` hätte `z-first` im Schnappschuss gehabt, wäre das
    // Journal da gewesen (2300 über Geräte), und erhält Bs Anker; das frühere erhält Cs Anker nie (6750).
    const w = new Welt15(k1a())
    const A = await w.person('A', 'A1')
    const B = await w.person('B', 'B1')
    const C = await w.person('C', 'C1')
    await w.rounds(2)
    const A2 = await w.enrol(A, 'A2')
    await w.rounds(3)
    const selfA = (await A.cand.keys.pair('self/A')).rkid
    for (const d of w.of('A')) w.carrier.faults.withhold(d.name, (f) => f.address === selfA)
    const first = await w.encounter(A, B, 'z-first')
    w.clock.advance(1000)
    const second = await w.encounter(A2, C, 'a-second')
    await w.rounds(3)
    expect(first.x.openedAt < second.x.openedAt).toBe(true)
    expect(first.x.record > second.x.record, 'Record-Anker umgekehrt zur Öffnungszeit').toBe(true)
    expect(M.tuple(A.state, first.x.id).candidates).not.toContain(second.x.peer)
    const from = w.carrier.carried.length
    w.carrier.faults.reset()
    await w.rounds(10)
    for (const d of [A, A2]) {
      expect(M.tuple(d.state, first.x.id).candidates, `${d.name}: das frühere Tupel bleibt ohne Cs Anker`).not.toContain(second.x.peer)
      expect(M.tuple(d.state, second.x.id).candidates, `${d.name}: das spätere Tupel trägt Bs Anker nach`).toContain(first.x.peer)
    }
    const probesTo = (address: string) => w.carrier.carried.slice(from).filter((f) => f.address === address && w.frameOrigin(f.bytes)?.kind === 'continuity-probe')
    expect(probesTo(first.x.peerKeyAgreement).length, 'keine späte Probe an B auf `z-first`').toBe(0)
    expect(probesTo(second.x.peerKeyAgreement).length, 'späte Probe an C auf `a-second`').toBeGreaterThan(0)
    // Kein Treffer: B und C sind verschiedene Personen, nichts wird vereinigt; beide A-Geräte sind sich einig.
    for (const d of [A, A2]) expect(relsTo(w, d, 'B').length + relsTo(w, d, 'C').length, d.name).toBe(2)
    expect(w.agree('A')).toEqual({ agree: true, diff: '' })
  }, 120_000)

  it('8b. Gleichstand: zwei nebenläufige Tupel mit gleichem `openedAt` erhalten keinen späten Kandidaten, keine späte Probe', async () => {
    // Prüfstandsannahme (NOTES): bei gleicher Öffnungszeit ist keines der beiden Tupel später; strikt nach 6750 trägt keines
    // nach. Die Vereinigung bleibt dann aus (wie ohne späte Probe), bis eine neue Begegnung sie trägt.
    const { w, A, A2, B, B2 } = await twoByTwo()
    const selfA = (await A.cand.keys.pair('self/A')).rkid
    const selfB = (await B.cand.keys.pair('self/B')).rkid
    for (const d of [...w.of('A'), ...w.of('B')]) w.carrier.faults.withhold(d.name, (f) => f.address === selfA || f.address === selfB)
    const x = await w.encounter(A, B)
    const y = await w.encounter(A2, B2)
    expect(x.x.openedAt).toBe(y.x.openedAt)
    await w.rounds(3)
    w.carrier.faults.reset()
    await w.rounds(10)
    for (const d of [A, A2]) {
      expect(M.tuple(d.state, x.x.id).candidates, d.name).not.toContain(y.x.peer)
      expect(M.tuple(d.state, y.x.id).candidates, d.name).not.toContain(x.x.peer)
    }
    for (const d of [B, B2]) {
      expect(M.tuple(d.state, x.y.id).candidates, d.name).not.toContain(y.y.peer)
      expect(M.tuple(d.state, y.y.id).candidates, d.name).not.toContain(x.y.peer)
    }
    for (const d of [A, A2, B, B2]) expect(d.state.effects.filter((e) => e.id.startsWith('union:')), d.name).toEqual([])
    for (const d of [A, A2]) expect(relsTo(w, d, 'B').length, d.name).toBe(2)
  }, 120_000)

  it('6. Eichung: K0 verfehlt X7 mit zwei Geräten weiter', async () => {
    const x = byId(await runX15(k0(), false, ['X7'])).X7!
    expect(x.crashed, x.detail).toBeFalsy()
    expect(x.outcome, x.detail).toBe('nicht bestanden')
    expect(x.measures.duplicates as number).toBeGreaterThan(0)
  }, 300_000)
})
