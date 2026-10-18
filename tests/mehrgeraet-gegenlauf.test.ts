import { describe, expect, it } from 'vitest'
import { seal, diSign, jcs, edFromSeed, rand, anchorOfEd } from '@real-life/trust-protocol'
import type { Json } from '@real-life/trust-protocol'
import { Welt15 } from '../src/lab/mehrgeraet/welt'
import { HolderDevice, TYPES, seedScheme, type CandidateDevice, type MultiDeviceCandidate, type Transaction } from '../src/lab/mehrgeraet/holder'
import { runX15 } from '../src/lab/mehrgeraet/scenarios'
import { k0 } from '../src/candidates/mehrgeraet-k0'
import * as M from '../src/lab/mehrgeraet/model'

// E15 Gegenläufe (Tor-Review 2, Loop-Review #55–#57): der Prüfstand muss
// falsche Erfolge abfangen und korrektes Verhalten durchlassen.
//   1. Fremd signierte Dokumente an eine unveränderte Adresse wirken nicht (#55).
//   2. Versand und Absturzstelle before-send liegen hinter dem Commit (#56).
//   3. Ein echter Neustart (neue Instanz aus dem Store) behält die Zuordnung der Quittungen (#57).
//   4. Orakel: korrektes Blockieren besteht X1; „nach neun alles verweigern“ fällt bei X2;
//      eine Zustimmung, die eine Ablehnung ohne eingereichte Karte überschreibt, wird bei X3 erkannt.
//   5. Die Commit-Grenze gilt auch für Zeitübergänge: der Träger sieht ein Dokument
//      erst, wenn der Zustand dazu im Store steht (#56, Loop-Review 3).
//   6. Eine Quittung gilt nur vom erwarteten Empfänger der konkreten Submission, für
//      jede quittierbare Submission, nicht nur Karte und Mapping (#55, Loop-Review 3).
//   7. Blockiert heißt nicht fehlerhaft, und zwar ganz: eine verweigerte Operation lässt
//      von der Nutzeraktion, vom Zeitübergang oder vom Empfang nichts zurück; die Runde
//      läuft weiter (CodeRabbit auf d9a1669).
//   8. Journalrahmen: an den Self-Anker gebunden, vom anderen Gerät quittiert, eigene
//      Rahmen auf der gemeinsamen Adresse übersprungen.
//   9. Ein Szenario, das mit einer Ausnahme abbricht, ist `crashed`, kein gemessener Verstoß.
//  10. Der Rollback stellt auch den Zustellerbericht wieder her: eine Quittung, deren
//      Wirkung blockiert wird, lässt die Submission nicht `delivered` (Tor-Review 3, B3).
//  11. Blockierte fällige Arbeit wird nicht vergessen: nach erneuter Freigabe füllt das
//      Gerät nach, ohne neue Alterung (B6).
//  12. Eine gepufferte Karte wird bei der Ticketannahme mit demselben Prüfsatz bewertet wie
//      bei direkter Ankunft: Akt-Id, Absender, Ablauf (B7).
//  13. Abgang: eine schon eingereichte Sendung bleibt bei Delivery und wird weiter wiederholt
//      (6845.7, Delivery 6.1); nur Neues geht nicht mehr hinaus (8475.S6) (Tor-Review 4, B4).
//  14. Empfang: eine zweite Revision gleicher Nummer mit gleichen Ankern, aber anderem Ablauf,
//      ist eine Equivokation (6270), keine Wiederholung (Tor-Review 5, R4-B2).
//  15. Nach dem Abgang quittiert das Gerät keinen neuen Rahmen des abgegangenen Kontakts mehr
//      (8475.S6); die Wiederholung einer schon gesendeten Quittung bleibt erlaubt (CodeRabbit auf #59).

const enc = new TextEncoder()
const byId = (rs: Awaited<ReturnType<typeof runX15>>) => Object.fromEntries(rs.map((r) => [r.scenario, r]))

/** K0 mit einem Haken: der Test entscheidet je Operation, ob sie erlaubt ist. */
function k0With(authorize: (device: string, op: M.Op, state: M.HolderState) => boolean): MultiDeviceCandidate {
  const base = k0()
  const wrap = (name: string, d: CandidateDevice): CandidateDevice => ({ ...d, authorize: (op, state) => authorize(name, op, state) })
  return {
    ...base,
    capabilities: new Set(['rights']),
    async first(person, device, seed) {
      return wrap(device, await base.first(person, device, seed))
    },
    async enrol(from, device) {
      const e = await base.enrol(from, device)
      return { cand: wrap(device, e.cand), state: e.state }
    },
  }
}

/**
 * Ein minimales Journal (Testskelett): jeder committete Schritt reist als ein Rahmen an die eigene Adresse; `deny` verweigert
 * einzelne Operationen je Gerät. `hack` darf den Zustand verbiegen (ein absichtlich kaputter Kandidat): bei jeder eigenen
 * Operation und beim Empfang eines Journalrahmens (mit dem zuletzt gesehenen Zustand des Geräts).
 */
function journal(hack?: (op: M.Op, state: M.HolderState) => void, deny?: (device: string, op: M.Op) => boolean): MultiDeviceCandidate {
  const seeds = new Map<string, Uint8Array>()
  const device = (person: string, name: string, seed: Uint8Array): CandidateDevice => {
    const out: Transaction[] = []
    const log: M.Op[] = []
    let last: M.HolderState | null = null
    return {
      keys: seedScheme(seed),
      writer: `${name}@1`,
      commit(tx) {
        log.push(...tx.ops)
        out.push(tx)
      },
      takeOwnFrames: () => out.splice(0).map((tx) => ({ body: enc.encode(JSON.stringify({ ops: tx.ops, intents: tx.intents.map((i) => ({ ...i, bytes: Buffer.from(i.bytes).toString('base64') })) })) })),
      receiveOwnFrame(body) {
        const raw = JSON.parse(new TextDecoder().decode(body)) as { ops: M.Op[]; intents: Array<Omit<Transaction['intents'][number], 'bytes'> & { bytes: string }> }
        log.push(...raw.ops)
        if (last) for (const op of raw.ops) hack?.(op, last)
        return { ops: raw.ops, intents: raw.intents.map((i) => ({ ...i, bytes: new Uint8Array(Buffer.from(i.bytes, 'base64')) })) }
      },
      persist: () => log,
      restore() {},
      authorize(op, state) {
        last = state
        hack?.(op, state)
        return !deny?.(name, op)
      },
    }
  }
  return {
    id: 'journal-test',
    title: 'Journal ohne Rechte (Testskelett)',
    capabilities: new Set(['journal']),
    async first(person, name, seed) {
      seeds.set(person, seed)
      return device(person, name, seed)
    },
    async enrol(from, name) {
      return { cand: device(from.person, name, seeds.get(from.person)!), state: structuredClone(from.state) }
    },
  }
}

describe('E15 Gegenläufe: Bindung, Commit-Grenze, Neustart', () => {
  it('#55: eine fremd signierte Revision an Ms unveränderte A-Adresse ändert Ms Sicht nicht', async () => {
    const w = new Welt15(k0())
    const A = await w.person('A', 'A1')
    const Mm = await w.person('M', 'M1')
    const am = await w.encounter(A, Mm)
    await w.rounds(2)
    await A.setClass(am.x.id, true)
    await w.rounds(3)
    const before = M.rel(Mm.state, am.y.id).view!
    expect(before.keys.length).toBe(5)
    // E signiert selbst, versiegelt an Ms Schlüssel des A–M-Tupels (die Adresse ist öffentlich).
    const e = await edFromSeed(rand(32))
    const anchor = anchorOfEd(e.pubRaw)
    const doc = await diSign({ anchor, ed: { priv: e.priv } }, { id: 'x', type: TYPES.revision, issuer: anchor, recipient: am.y.own, replyTo: 'nowhere', issuedAt: w.clock.now(), payload: { revision: 999, keys: [] } }, w.clock.now())
    const env = await seal(doc as unknown as Json, am.x.peerKeyAgreement)
    w.carrier.deposit(am.x.peerKeyAgreement, enc.encode(jcs(env)))
    await w.rounds(2)
    expect(M.rel(Mm.state, am.y.id).view).toEqual(before)
    expect(Mm.dispositions).toContain('failed(validation-failed)')
  }, 60_000)

  it('#56: before-send liegt hinter dem Commit; nach dem Neuaufbau geht die gesicherte Revision hinaus', async () => {
    const w = new Welt15(k0())
    const A = await w.person('A', 'A1')
    const Mm = await w.person('M', 'M1')
    const am = await w.encounter(A, Mm)
    await w.rounds(2)
    const carried = w.carrier.carried.length
    A.crashAt = 'before-send'
    expect(await A.setClass(am.x.id, true)).toBe('crashed')
    expect(A.crashes).toEqual(['before-send'])
    expect(w.carrier.carried.length).toBe(carried) // nichts hat das Gerät verlassen
    await w.rounds(2)
    expect(M.rel(Mm.state, am.y.id).view).toBeNull()
    await A.reload()
    await w.rounds(3)
    expect(M.rel(Mm.state, am.y.id).view?.keys.length).toBe(5) // die gesicherte Absicht ging nach dem Neuaufbau hinaus
    expect(M.rel(A.state, am.x.id).classOn).toBe(true)
  }, 60_000)

  it('#57: ein echter Neustart aus dem Store behält die Zuordnung der Kartenquittung (taken → delivered)', async () => {
    const w = new Welt15(k0())
    const A = await w.person('A', 'A1')
    const B = await w.person('B', 'B1')
    const Mm = await w.person('M', 'M1')
    const am = await w.encounter(A, Mm)
    const bm = await w.encounter(B, Mm)
    await w.rounds(2)
    await A.setClass(am.x.id, true)
    await B.setClass(bm.x.id, true)
    await w.rounds(3)
    const r = await Mm.introduce(am.y.id, bm.y.id)
    expect('act' in r).toBe(true)
    const actId = (r as { act: string }).act
    await w.until(() => A.state.acts.length === 1 && B.state.acts.length === 1)
    B.online = false
    await A.consent(actId)
    await w.rounds(1)
    expect(M.act(A.state, actId).o).toBe('taken')
    // Neue Instanz aus demselben Store, die alte ist weg.
    const A1b = new HolderDevice('A1', 'A', A.cand, w.carrier, w.clock, w.stores.get('A1'))
    await A1b.reload()
    w.devices.splice(w.devices.indexOf(A), 1, A1b)
    B.online = true
    const n = await w.until(() => M.act(A1b.state, actId).o === 'delivered')
    expect(n).toBeGreaterThan(0)
  }, 60_000)

  it('#56: zeitgesteuertes Nachfüllen: der Träger sieht die Revision erst, wenn sie im Store steht', async () => {
    const w = new Welt15(k0())
    const A = await w.person('A', 'A1')
    const Mm = await w.person('M', 'M1')
    const am = await w.encounter(A, Mm)
    await w.rounds(2)
    await A.setClass(am.x.id, true)
    await w.rounds(3)
    expect(M.rel(Mm.state, am.y.id).view?.revision).toBe(1)
    // Der Vorrat altert (8475.S5): 174 Tage später ist kein Schlüssel mehr benennbar, A füllt nach.
    w.clock.advance(174 * 24 * 3600 * 1000)
    const store = w.stores.get('A1')!
    const seen: Array<{ ram: number; store: number }> = []
    const deposit = w.carrier.deposit.bind(w.carrier)
    w.carrier.deposit = (address, bytes) => {
      if (address === am.x.peerKeyAgreement) seen.push({ ram: M.rel(A.state, am.x.id).revision, store: M.rel(store.load()!.holder, am.x.id).revision })
      deposit(address, bytes)
    }
    await A.round()
    w.carrier.deposit = deposit
    expect(seen.length).toBeGreaterThanOrEqual(1)
    for (const s of seen) expect(s.store, 'Revision im RAM über der im Store beim Deposit').toBe(s.ram)
    expect(M.rel(A.state, am.x.id).revision).toBe(2)
    await w.rounds(3)
    expect(M.rel(Mm.state, am.y.id).view?.revision).toBe(2)
  }, 60_000)

  it('#55: eine fremde Quittung auf As Revision markiert sie nicht als zugestellt; eine Quittung ohne Submission wird abgewiesen', async () => {
    const w = new Welt15(k0())
    const A = await w.person('A', 'A1')
    const Mm = await w.person('M', 'M1')
    const am = await w.encounter(A, Mm, 'am1')
    await w.rounds(2)
    Mm.online = false
    await A.setClass(am.x.id, true)
    const sub = [...A.zusteller.submissions.values()].find((s) => s.address === am.x.peerKeyAgreement)!
    expect(sub.report?.state).toBe('accepted')
    // E signiert selbst eine Quittung mit dem Digest von As Revision und versiegelt sie an As Adresse des A–M-Tupels.
    const e = await edFromSeed(rand(32))
    const anchor = anchorOfEd(e.pubRaw)
    const ackOf = async (ref: string) => {
      const doc = await diSign({ anchor, ed: { priv: e.priv } }, { id: crypto.randomUUID(), type: TYPES.ack, issuer: anchor, recipient: am.x.own, replyTo: '', issuedAt: w.clock.now(), payload: { ref, meaning: 'received' } }, w.clock.now())
      return enc.encode(jcs(await seal(doc as unknown as Json, (await A.encounterKeys('am1')).rkid)))
    }
    w.carrier.deposit((await A.encounterKeys('am1')).rkid, await ackOf(sub.digest))
    w.carrier.deposit((await A.encounterKeys('am1')).rkid, await ackOf('0'.repeat(64)))
    await A.round()
    expect(A.zusteller.report(sub.digest)?.state).toBe('accepted')
    expect(A.dispositions).toContain('failed(ack-from-unexpected-signer)')
    expect(A.dispositions).toContain('failed(ack-unbound)')
    // Die echte Quittung von M gilt.
    Mm.online = true
    const n = await w.until(() => A.zusteller.report(sub.digest)?.state === 'delivered')
    expect(n).toBeGreaterThan(0)
  }, 60_000)
})

describe('E15 Gegenläufe: Orakel', () => {
  it('X1: ein Kandidat, der M2 das Vorstellen verweigert (kein Verbrauchsrecht), besteht; blockiert wird gemessen', async () => {
    const c = k0With((device, op) => !(device === 'M2' && op.kind === 'introduce'))
    const r = byId(await runX15(c, false, ['X1']))
    expect(r.X1!.outcome, r.X1!.detail).toBe('bestanden')
    expect(r.X1!.measures.blockedOperations).toBeGreaterThanOrEqual(1)
    expect(r.X1!.measures.progressAfterHeal).toBe(2) // nach der Heilung über das Gerät mit dem Recht (M1)
  }, 300_000)

  it('X2: „nach neun alles verweigern“ fällt, weil die Person nur neun statt zehn annimmt', async () => {
    const c = k0With((_, op, state) => !(op.kind === 'ticket-accept' && state.relationships.some((r) => r.accepted.length >= 9)))
    const r = byId(await runX15(c, false, ['X2']))
    expect(r.X2!.outcome, r.X2!.detail).toBe('nicht bestanden')
    expect(r.X2!.crashed, r.X2!.detail).toBeFalsy()
    expect(r.X2!.measures.acceptedActs).toBe(9)
    expect(r.X2!.measures.budgetOverrun).toBe(0)
  }, 300_000)

  it('X3: ein Journal, in dem die Zustimmung eine Ablehnung ohne eingereichte Karte überschreibt, wird erkannt (Regel 2 verletzt, terminaler Zustand verlassen)', async () => {
    // Hack: sobald das Gerät ein Consent eines anderen Geräts für einen abgelehnten Akt kennt, vergisst es die Ablehnung und
    // öffnet ihn wieder als zugestimmt, gleich ob eine Karte eingereicht ist (gegen Regel 2, K1a Schritt 3).
    const seen = new Map<string, M.Op>()
    const c = journal((op, state) => {
      for (const o of seen.values()) {
        if (o.kind !== 'consent') continue
        const a = state.acts.find((x) => x.id === o.act)
        if (a && a.state === 'declined') {
          a.decisions = (a.decisions ?? []).filter((d) => d.kind !== 'decline')
          a.state = 'consented'
        }
      }
      if (op.kind === 'consent') seen.set(op.act, op)
    })
    const r = byId(await runX15(c, false, ['X3']))
    expect(r.X3!.outcome, r.X3!.detail).toBe('nicht bestanden')
    expect(r.X3!.crashed, r.X3!.detail).toBeFalsy()
    expect(r.X3!.measures.ruleKept, r.X3!.detail).toBe(0)
    expect(r.X3!.measures.leftTerminal, r.X3!.detail).toBe(1)
  }, 300_000)
})

describe('E15 Gegenläufe: Blockieren, Journal, Absturz', () => {
  it('Blocked ist atomar: ein verweigertes hand-over lässt Zustand, Versand und Journal der Nutzeraktion unberührt', async () => {
    const w = new Welt15(journal(undefined, (device, op) => device === 'A1' && op.kind === 'hand-over'))
    const A = await w.person('A', 'A1')
    const B = await w.person('B', 'B1')
    const Mm = await w.person('M', 'M1')
    const am = await w.encounter(A, Mm)
    const bm = await w.encounter(B, Mm)
    await w.rounds(2)
    await A.setClass(am.x.id, true)
    await B.setClass(bm.x.id, true)
    await w.rounds(3)
    const r = await Mm.introduce(am.y.id, bm.y.id)
    const actId = (r as { act: string }).act
    await w.until(() => A.state.acts.length === 1)
    await w.rounds(1) // Journalrahmen der Annahme sind hinaus
    expect(A.cand.takeOwnFrames()).toEqual([])
    const before = structuredClone(A.state)
    const subs = A.zusteller.submissions.size
    const carried = w.carrier.carried.length
    expect(await A.consent(actId)).toBe('blocked')
    expect(A.state).toEqual(before)
    expect(M.act(A.state, actId).state).toBe('offered')
    expect(A.zusteller.submissions.size).toBe(subs)
    expect(A.cand.takeOwnFrames()).toEqual([])
    expect(A.measures.blocked).toBe(1)
    await w.rounds(2)
    // Keine Karte an Bs Adresse; der übrige Verkehr (Quittungen, Journal) läuft weiter.
    expect(w.carrier.carried.slice(carried).filter((f) => f.address === M.act(A.state, actId).voucher.keyAgreement)).toEqual([])
    expect(B.state.acts.find((a) => a.id === actId)?.pending).toBeNull()
  }, 60_000)

  it('Blocked im Zeitübergang: ein verweigertes allocate beim Nachfüllen bricht die Runde nicht ab; die Alterung bleibt, nichts geht hinaus', async () => {
    let deny = false
    const w = new Welt15(k0With((device, op) => !(deny && device === 'A1' && op.kind === 'allocate')))
    const A = await w.person('A', 'A1')
    const Mm = await w.person('M', 'M1')
    const am = await w.encounter(A, Mm)
    await w.rounds(2)
    await A.setClass(am.x.id, true)
    await w.rounds(3)
    deny = true
    w.clock.advance(174 * 24 * 3600 * 1000)
    const carried = w.carrier.carried.length
    await A.round()
    expect(A.dispositions).toContain('blocked(allocate)')
    expect(A.measures.blocked).toBe(1)
    const rel = M.rel(A.state, am.x.id)
    expect(rel.stock.filter((k) => k.state === 'aging').length).toBe(5)
    expect(rel.stock.length).toBe(5)
    expect(rel.revision).toBe(1)
    expect(w.carrier.carried.length).toBe(carried)
    // B6: die fällige Arbeit bleibt fällig; mit dem Recht füllt das Gerät nach, ohne neue Alterung.
    deny = false
    await w.rounds(2)
    const after = M.rel(A.state, am.x.id)
    expect(after.stock.filter((k) => k.state === 'active').length).toBe(5)
    expect(after.revision).toBe(2)
    await w.rounds(3)
    expect(M.rel(Mm.state, am.y.id).view?.revision).toBe(2)
  }, 60_000)

  it('Blocked beim Empfang: ein verweigertes view wirkt nicht und wird nicht quittiert; mit Recht wirkt die Wiederholung', async () => {
    let deny = true
    const w = new Welt15(k0With((device, op) => !(deny && device === 'M1' && op.kind === 'view')))
    const A = await w.person('A', 'A1')
    const Mm = await w.person('M', 'M1')
    const am = await w.encounter(A, Mm)
    await w.rounds(2)
    await A.setClass(am.x.id, true)
    const sub = [...A.zusteller.submissions.values()].find((s) => s.address === am.x.peerKeyAgreement)!
    await w.rounds(2)
    expect(Mm.dispositions).toContain('blocked(view)')
    expect(Mm.dispositions).not.toContain('failed(malformed): view')
    expect(M.rel(Mm.state, am.y.id).view).toBeNull()
    expect(A.zusteller.report(sub.digest)?.state).toBe('accepted')
    deny = false
    const n = await w.until(() => M.rel(Mm.state, am.y.id).view !== null)
    expect(n).toBeGreaterThan(0)
    await w.rounds(2)
    expect(A.zusteller.report(sub.digest)?.state).toBe('delivered')
  }, 60_000)

  it('Journal: das andere Gerät bindet den Rahmen an den Self-Anker und quittiert; eigene Rahmen werden übersprungen; fremde wirken nicht', async () => {
    const w = new Welt15(journal())
    const A1 = await w.person('A', 'A1')
    const A2 = await w.enrol(A1, 'A2')
    const Mm = await w.person('M', 'M1')
    const am = await w.encounter(A1, Mm)
    await w.rounds(2)
    await A1.setClass(am.x.id, true)
    await w.rounds(4)
    const self = await A1.cand.keys.pair('self/A')
    // Eigene Dokumente an die Self-Adresse (nicht die Quittungen, die A1 selbst dorthin schickt: Quittungen werden nie quittiert).
    const journalSubs = [...A1.zusteller.submissions.values()].filter((s) => s.address === self.rkid && A1.expected.has(s.digest))
    expect(journalSubs.length).toBeGreaterThan(0)
    for (const s of journalSubs) expect(s.report?.state, s.digest).toBe('delivered')
    expect(M.rel(A2.state, am.x.id).classOn).toBe(true)
    expect(M.rel(A2.state, am.x.id).stock.length).toBe(5)
    expect(A2.expected.size).toBe(0) // A2 hat nichts selbst gesendet: keine zweite Nachfüllung, keine zweite Revision
    // Auf geteilten Adressen liest jedes Gerät auch Ms Quittungen für das andere Gerät; die bleiben ungebunden, sonst nichts.
    for (const d of [A1, A2]) expect(d.dispositions.filter((x) => x.startsWith('failed') && x !== 'failed(ack-unbound)')).toEqual([])
    // E signiert einen Journalrahmen und versiegelt ihn an die Self-Adresse.
    const e = await edFromSeed(rand(32))
    const anchor = anchorOfEd(e.pubRaw)
    const op: M.Op = { id: { writer: 'E@1', n: 1 }, at: w.clock.now(), kind: 'class', rel: am.x.id, on: false } as M.Op
    const doc = await diSign({ anchor, ed: { priv: e.priv } }, { id: crypto.randomUUID(), type: TYPES.journal, issuer: anchor, recipient: self.anchor, replyTo: self.rkid, issuedAt: w.clock.now(), payload: { b: Buffer.from(JSON.stringify(op)).toString('base64') } }, w.clock.now())
    w.carrier.deposit(self.rkid, enc.encode(jcs(await seal(doc as unknown as Json, self.rkid))))
    await w.rounds(2)
    for (const d of [A1, A2]) {
      expect(d.dispositions).toContain('failed(journal-from-unexpected-signer)')
      expect(M.rel(d.state, am.x.id).classOn).toBe(true)
    }
  }, 60_000)

  it('crashed: ein Szenario, das mit einer Ausnahme abbricht, ist markiert und kein gemessener Verstoß', async () => {
    const base = k0()
    const c: MultiDeviceCandidate = {
      ...base,
      async first(person, device, seed) {
        const d = await base.first(person, device, seed)
        return { ...d, authorize: () => { throw new Error('boom') } }
      },
    }
    const r = byId(await runX15(c, false, ['X1']))
    expect(r.X1!.outcome).toBe('nicht bestanden')
    expect(r.X1!.crashed).toBe(true)
    expect(r.X1!.detail).toContain('boom')
  }, 60_000)
})

describe('E15 Gegenläufe: Rollback-Tiefe, fällige Arbeit, Kartenpuffer', () => {
  it('B3: eine Quittung, deren Wirkung blockiert wird, lässt die Submission nicht delivered; mit Recht wirkt die Wiederholung', async () => {
    let deny = false
    const w = new Welt15(k0With((device, op) => !(deny && device === 'A1' && op.kind === 'hand-over' && op.o === 'delivered')))
    const A = await w.person('A', 'A1')
    const B = await w.person('B', 'B1')
    const Mm = await w.person('M', 'M1')
    const am = await w.encounter(A, Mm)
    const bm = await w.encounter(B, Mm)
    await w.rounds(2)
    await A.setClass(am.x.id, true)
    await B.setClass(bm.x.id, true)
    await w.rounds(3)
    const r = await Mm.introduce(am.y.id, bm.y.id)
    const actId = (r as { act: string }).act
    await w.until(() => A.state.acts.length === 1 && B.state.acts.length === 1)
    B.online = false
    await A.consent(actId)
    await w.rounds(1)
    expect(M.act(A.state, actId).o).toBe('taken')
    const digest = M.act(A.state, actId).ownCardDigest!
    deny = true
    B.online = true
    await w.rounds(2)
    expect(A.dispositions).toContain('blocked(hand-over)')
    expect(M.act(A.state, actId).o).toBe('taken')
    expect(A.zusteller.report(digest)?.state).toBe('accepted')
    deny = false
    const n = await w.until(() => M.act(A.state, actId).o === 'delivered')
    expect(n).toBeGreaterThan(0)
    expect(A.zusteller.report(digest)?.state).toBe('delivered')
  }, 60_000)

  it('B7: eine vor dem Ticket gepufferte Karte wird bei der Zuordnung geprüft wie bei direkter Ankunft (Akt-Id, Absender, Ablauf)', async () => {
    const w = new Welt15(k0())
    const A = await w.person('A', 'A1')
    const B = await w.person('B', 'B1')
    const Mm = await w.person('M', 'M1')
    const am = await w.encounter(A, Mm)
    const bm = await w.encounter(B, Mm)
    await w.rounds(2)
    await A.setClass(am.x.id, true)
    await B.setClass(bm.x.id, true)
    await w.rounds(3)
    const rkidA = (await A.cand.keys.pair(M.head(M.rel(A.state, am.x.id)).ownKey)).rkid
    // M benennt denselben Schlüssel von A in zwei Akten (Fehlverhalten des Mediators, 8570); A bekommt das erste Ticket erst später.
    const mark = w.carrier.carried.length
    const r1 = await Mm.introduce(am.y.id, bm.y.id)
    const act1 = (r1 as { act: string }).act
    // Zurückgehalten wird nach Inhalt: Ms Zusteller wiederholt dieselben Bytes als neuen Rahmen.
    const same = (xs: Uint8Array[]) => (f: { bytes: Uint8Array }) => xs.some((b) => Buffer.compare(b, f.bytes) === 0)
    const t1 = w.carrier.carried.slice(mark).filter((f) => f.address === rkidA).map((f) => f.bytes)
    const key1 = Mm.state.mediatorActs.find((a) => a.id === act1)!.a.key
    Mm.state.consumed = Mm.state.consumed.filter((k) => k !== key1)
    const mark2 = w.carrier.carried.length
    const r2 = await Mm.introduce(am.y.id, bm.y.id)
    const act2 = (r2 as { act: string }).act
    const t2 = w.carrier.carried.slice(mark2).filter((f) => f.address === rkidA).map((f) => f.bytes)
    expect(Mm.state.mediatorActs.find((a) => a.id === act2)!.a.key).toBe(key1)
    w.carrier.faults.withhold('A1', same([...t1, ...t2]))
    await w.until(() => B.state.acts.length === 2)
    await B.consent(act1) // Bs Karte für act1 geht an As Schlüssel, bevor A ein Ticket dazu hat: A puffert (8910.1)
    await w.rounds(3)
    expect(A.state.acts.length).toBe(0)
    // Ticket 2 (anderer Akt, gleicher Schlüssel, gleicher Absender) kommt zuerst: die gepufferte Karte gehört nicht dazu.
    w.carrier.faults.reset()
    w.carrier.faults.withhold('A1', same(t1))
    await w.until(() => A.state.acts.length === 1)
    expect(A.state.acts[0]!.id).toBe(act2)
    await w.rounds(2)
    expect(M.act(A.state, act2).pending).toBeNull()
    w.carrier.faults.reset()
    await w.rounds(3)
    // Ticket 1 benennt einen bei A schon verbrauchten Schlüssel: Konformitätsfehler des Mediators (8640.12); act1 entsteht nicht, die Karte bleibt ohne Akt.
    expect(A.state.acts.map((a) => a.id)).toEqual([act2])
    expect(A.state.findings.some((f) => f.includes('8640.12'))).toBe(true)
    expect(A.state.acts.every((a) => a.pending === null)).toBe(true)
  }, 60_000)

  it('Abgang: eine eingereichte, unquittierte Revision an M bleibt bei Delivery und wird wiederholt; der Abgang erzeugt nichts Neues', async () => {
    const w = new Welt15(k0())
    const A = await w.person('A', 'A1')
    const Mm = await w.person('M', 'M1')
    const am = await w.encounter(A, Mm)
    await w.rounds(2)
    Mm.online = false
    await A.setClass(am.x.id, true)
    const sub = [...A.zusteller.submissions.values()].find((s) => s.address === am.x.peerKeyAgreement)!
    expect(sub.report?.state).toBe('accepted')
    const carried = w.carrier.carried.length
    expect(await A.depart(am.x.id)).toBe('ok')
    expect(w.carrier.carried.length).toBe(carried) // der Abgang sendet nichts (8475.S6)
    await w.rounds(4)
    expect(A.zusteller.report(sub.digest)?.state).toBe('accepted') // nicht zurückgezogen (6845.7)
    expect(A.zusteller.submissions.get(sub.digest)!.deposits).toBeGreaterThanOrEqual(2) // wiederholt
    // Alles, was nach dem Abgang an M ging, sind Wiederholungen derselben Bytes.
    const after = w.carrier.carried.slice(carried).filter((f) => f.address === am.x.peerKeyAgreement)
    expect(after.length).toBeGreaterThanOrEqual(1)
    expect(after.every((f) => Buffer.compare(f.bytes, sub.frame) === 0)).toBe(true)
  }, 60_000)

  it('Empfang: Revision 1 noch einmal mit gleichen Ankern und anderem Ablauf: M weist ab und hält ein 6270-Finding', async () => {
    const w = new Welt15(k0())
    const A = await w.person('A', 'A1')
    const Mm = await w.person('M', 'M1')
    const am = await w.encounter(A, Mm)
    await w.rounds(2)
    await A.setClass(am.x.id, true)
    await w.rounds(3)
    const view = M.rel(Mm.state, am.y.id).view!
    expect(view.revision).toBe(1)
    // A1 selbst (mit seinem Schlüssel) sendet Revision 1 erneut, gleiche Anker, Ablauf ein Jahr später.
    const h = M.head(M.rel(A.state, am.x.id))
    const k = await A.cand.keys.pair(h.ownKey)
    const keys = view.keys.map((x) => ({ ...x, expiresAt: '2028-01-01T00:00:00.000Z' }))
    const doc = await diSign({ anchor: k.anchor, ed: { priv: k.ed.priv } }, { id: crypto.randomUUID(), type: TYPES.revision, issuer: k.anchor, recipient: h.peer, replyTo: k.rkid, issuedAt: w.clock.now(), payload: { revision: 1, keys } }, w.clock.now())
    w.carrier.deposit(h.peerKeyAgreement, enc.encode(jcs(await seal(doc as unknown as Json, h.peerKeyAgreement))))
    await w.rounds(2)
    expect(M.rel(Mm.state, am.y.id).view).toEqual(view)
    expect(Mm.state.findings.some((f) => f.includes('6270'))).toBe(true)
    expect(Mm.dispositions).toContain('failed(validation-failed)')
  }, 60_000)

  it('Abgang: eine neue Probe von B auf dem abgegangenen Tupel wird nicht quittiert; die Wiederholung einer alten Quittung schon', async () => {
    const w = new Welt15(k0())
    const A = await w.person('A', 'A1')
    const B = await w.person('B', 'B1')
    const Mm = await w.person('M', 'M1')
    await w.encounter(A, Mm)
    const ab = await w.encounter(A, B)
    await w.rounds(3)
    // B schickt A etwas, das A quittiert (eine Revision auf dem A–B-Tupel), damit es eine gespeicherte Quittung gibt.
    await B.setClass(ab.y.id, true)
    await w.rounds(3)
    // Bs eigenes Dokument an A (nicht Bs Quittung auf As Probe: Quittungen werden nie quittiert).
    const revB = [...B.zusteller.submissions.values()].find((s) => s.address === ab.y.peerKeyAgreement && B.expected.has(s.digest))!
    expect(revB.report?.state).toBe('delivered')
    expect(await A.depart(ab.x.id)).toBe('ok')
    const mark = w.carrier.carried.length
    const toB = ab.x.peerKeyAgreement
    // (1) Wiederholung: B liefert dieselbe Revision noch einmal ein; A antwortet mit der aufbewahrten Quittung (gleiche Bytes wie zuvor).
    const ackBefore = w.carrier.carried.filter((f) => f.address === toB).map((f) => Buffer.from(f.bytes).toString('base64'))
    w.carrier.deposit(revB.address, revB.frame)
    await w.rounds(2)
    const repeats = w.carrier.carried.slice(mark).filter((f) => f.address === toB)
    expect(repeats.length).toBe(1)
    expect(ackBefore).toContain(Buffer.from(repeats[0]!.bytes).toString('base64'))
    // (2) Neu: eine Probe von B auf dem abgegangenen Tupel; A quittiert nicht.
    const mark2 = w.carrier.carried.length
    const kb = await B.cand.keys.pair(ab.y.ownKey)
    const doc = await diSign({ anchor: kb.anchor, ed: { priv: kb.ed.priv } }, { id: crypto.randomUUID(), type: TYPES.probe, issuer: kb.anchor, recipient: ab.y.peer, replyTo: kb.rkid, issuedAt: w.clock.now(), payload: { entries: ['x'] } }, w.clock.now())
    w.carrier.deposit((await A.cand.keys.pair(ab.x.ownKey)).rkid, enc.encode(jcs(await seal(doc as unknown as Json, (await A.cand.keys.pair(ab.x.ownKey)).rkid))))
    await w.rounds(2)
    expect(A.dispositions).toContain('failed(validation-failed)')
    // Nichts Neues an B: alles, was noch hinausgeht, sind Wiederholungen früherer Bytes (die Quittung aus (1) nach ACK_WAIT).
    const known = new Set(w.carrier.carried.slice(0, mark2).filter((f) => f.address === toB).map((f) => Buffer.from(f.bytes).toString('base64')))
    expect(w.carrier.carried.slice(mark2).filter((f) => f.address === toB && !known.has(Buffer.from(f.bytes).toString('base64')))).toEqual([])
  }, 60_000)
})
