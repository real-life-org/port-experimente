import { describe, expect, it } from 'vitest'
import { Welt15 } from '../src/lab/mehrgeraet/welt'
import { HolderDevice } from '../src/lab/mehrgeraet/holder'
import { runX15 } from '../src/lab/mehrgeraet/scenarios'
import { k1a, K1aDevice } from '../src/candidates/mehrgeraet-k1a'
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
