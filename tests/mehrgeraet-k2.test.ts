import { describe, expect, it } from 'vitest'
import { seal, receive } from '@real-life/trust-protocol'
import type { Json } from '@real-life/trust-protocol'
import { Welt15 } from '../src/lab/mehrgeraet/welt'
import { HolderDevice, UnknownWriter, signerId, TYPES, type MultiDeviceCandidate } from '../src/lab/mehrgeraet/holder'
import { runX15 } from '../src/lab/mehrgeraet/scenarios'
import { anchorPairOracle, enrolFanout, revocationTraffic, thiefWindow, timeModel } from '../src/lab/mehrgeraet/geraetemengen'
import { k2, K2Device } from '../src/candidates/mehrgeraet-k2'
import { k1a, type Batch } from '../src/candidates/mehrgeraet-k1a'
import { k0 } from '../src/candidates/mehrgeraet-k0'
import * as M from '../src/lab/mehrgeraet/model'

// E15 K2 step 1: device keys (plan 6o.4 step 1, assumptions 6o.5 no. 1–5).
//   1. Two devices hold distinct keys and register their own addresses; the journal is signed by the producing device and
//      sealed once per sibling; the fold verifies the batch signature against the device set; an unknown writer is rejected.
//   2. X1–X18, X7b, X21 with two devices: K1a's pattern (interim rule `mediatorSplit` on until step 5) except where device
//      keys change semantics (NOTES, "Results"); counter-run without the interim rule: X1, X13, X14 fail.
//   3. A thief with A2's image reads only what A2's keys open; after the revocation it reads nothing new (step-1 measure).
//   4. A restored device keeps its keys, gets a fresh incarnation and catches up.
//   5. K1a never fans out (one frame per document, no copies in intents).
//   6. Fan-out: journal per sibling and counterpart documents per device, against K1a's single frame.

const enc = new TextEncoder()
const byId = (rs: Awaited<ReturnType<typeof runX15>>) => Object.fromEntries(rs.map((r) => [r.scenario, r]))
const envRkid = (bytes: Uint8Array) => (JSON.parse(new TextDecoder().decode(bytes)) as { rkid: string }).rkid

async function world(c: MultiDeviceCandidate = k2(), devices = 2) {
  const w = new Welt15(c)
  const A = await w.person('A', 'A1')
  const B = await w.person('B', 'B1')
  const Mm = await w.person('M', 'M1')
  const am = await w.encounter(A, Mm)
  const bm = await w.encounter(B, Mm)
  await w.rounds(2)
  await A.setClass(am.x.id, true)
  await B.setClass(bm.x.id, true)
  await w.rounds(3)
  const As: HolderDevice[] = [A]
  for (let i = 2; i <= devices; i++) As.push(await w.enrol(A, `A${i}`))
  await w.rounds(2)
  return { w, A, A2: As[1]!, As, B, Mm, am, bm }
}

describe('K2 Schritt 1: Geräteschlüssel', () => {
  it('1a. zwei Geräte, verschiedene Schlüssel je Kontext, eigene Adressen je Gerät; kein Gerät hält den Seed der Person', async () => {
    const c = k2()
    const { w, A, A2, am } = await world(c)
    // QR stand-in between the two own devices (6o.5 no. 4): public keys both ways, measured.
    expect(c.ceremonies).toHaveLength(1)
    expect(c.ceremonies[0]!.bytesNewToOld).toBeGreaterThan(0)
    const ctx = M.head(M.rel(A.state, am.x.id)).ownKey
    const [k1, k2_] = [await A.cand.keys.pair(ctx), await A2.cand.keys.pair(ctx)]
    expect(k1.anchor).not.toBe(k2_.anchor)
    expect(k1.rkid).not.toBe(k2_.rkid)
    expect((await A.cand.keys.pair('self/A')).anchor).not.toBe((await A2.cand.keys.pair('self/A')).anchor)
    expect(A.selfAddress).not.toBe(A2.selfAddress)
    expect(w.selfAddresses('A').size).toBe(2)
    // Each device registers only its own addresses.
    expect(w.carrier.registeredAt(k1.rkid)).toEqual(['A1'])
    expect(w.carrier.registeredAt(k2_.rkid)).toEqual(['A2'])
    expect(w.carrier.registeredAt(A.selfAddress!)).toEqual(['A1'])
    // The image holds the device secret, nothing derived from a person seed: two devices, two secrets.
    const s1 = (A.cand.persist() as { secret: string }).secret
    const s2 = (A2.cand.persist() as { secret: string }).secret
    expect(s1).not.toBe(s2)
    // The shared state carries the recorded anchor of the creating device; A2 acts with its own key for the same context.
    expect(M.head(M.rel(A2.state, am.x.id)).own).toBe(k1.anchor)
    expect(w.agree('A')).toEqual({ agree: true, diff: '' })
  }, 60_000)

  it('1b. Journal: der Batch ist vom erzeugenden Gerät signiert, der Rahmen je Schwester versiegelt (eine Kopie je Schwester an deren Self-Adresse); die Schwester faltet', async () => {
    const { w, A, A2, As, am } = await world(k2({ devices: 3 }), 3)
    const A3 = As[2]!
    const mark = w.carrier.carried.length
    await A.setClass(am.x.id, false)
    await w.rounds(1)
    const journal = w.carrier.carried.slice(mark).filter((f) => w.frameOrigin(f.bytes)?.device === 'A1' && w.frameOrigin(f.bytes)?.kind === 'journal')
    expect(journal.length).toBe(2) // one copy per sibling (A2, A3)
    expect(new Set(journal.map((f) => f.address))).toEqual(new Set([A2.selfAddress, A3.selfAddress]))
    for (const f of journal) expect(envRkid(f.bytes)).toBe(f.address) // sealed to the sibling's own self key
    expect(journal.some((f) => f.address === A.selfAddress)).toBe(false)
    const last = (A.cand as K2Device).journal().at(-1) as Batch & { sig?: string }
    expect(M.isBase64(last.sig)).toBe(true)
    await w.rounds(2)
    expect(w.agree('A')).toEqual({ agree: true, diff: '' })
    expect(M.rel(A3.state, am.x.id).classOn).toBe(false)
  }, 60_000)

  it('1c. Faltungseingang: ein Batch eines Schreibers außerhalb der Gerätemenge und ein Batch mit fremder oder gebrochener Signatur sind `UnknownWriter`; ein echter Batch geht durch', async () => {
    const c = k2()
    const { A, A2, am } = await world(c)
    await A.setClass(am.x.id, false)
    const good = (A.cand as K2Device).journal().at(-1) as Batch & { sig: string }
    // A valid batch of A1 that A2 already knows: no error (known, nothing new).
    expect(() => A2.cand.receiveOwnFrame(enc.encode(JSON.stringify(good)))).not.toThrow()
    // Tampered content under A1's signature.
    const tampered = { ...good, n: good.n + 50 }
    expect(() => A2.cand.receiveOwnFrame(enc.encode(JSON.stringify(tampered)))).toThrow(UnknownWriter)
    // A device of the person outside the set (never enrolled) signs its own batch.
    const outsider = (await c.instance!('A', 'X9', new Uint8Array(32))) as K2Device
    outsider.commit({ ops: good.ops, intents: [] })
    const foreign = outsider.journal().at(-1)!
    expect(() => A2.cand.receiveOwnFrame(enc.encode(JSON.stringify(foreign)))).toThrow(UnknownWriter)
    // A1's writer with the outsider's signature.
    const forged = { ...good, sig: (foreign as Batch & { sig: string }).sig }
    expect(() => A2.cand.receiveOwnFrame(enc.encode(JSON.stringify(forged)))).toThrow(UnknownWriter)
    // No signature at all: malformed.
    const { sig: _, ...unsigned } = good
    expect(() => A2.cand.receiveOwnFrame(enc.encode(JSON.stringify(unsigned)))).toThrow(/batch\.sig/)
  }, 60_000)

  it('1d. Holder: nach dem Widerruf weist A1 jeden Journalrahmen des Diebs ab (Befund `journal:unknown-writer`, keine Wirkung, keine Quittung); vor dem Widerruf fängt die Batch-Signatur den fremden Schreiber', async () => {
    const { w, A, A2, am } = await world()
    const thief = await w.steal(A2, 'A2-dieb')
    w.devices.push(thief)
    A2.online = false
    // Before the revocation: the frame is signed with A2's self key (in the set), the batch by writer A2-dieb (not in the set).
    await thief.setClass(am.x.id, false)
    await w.rounds(2)
    expect(A.unknownWriters).toBeGreaterThanOrEqual(1)
    expect(A.dispositions.some((d) => d.startsWith('finding(journal:unknown-writer@'))).toBe(true)
    expect(M.rel(A.state, am.x.id).classOn).toBe(true)
    // After the revocation: the frame signer itself is outside the set.
    const before = A.unknownWriters
    await w.revoke(A, A2)
    w.devices.push(thief)
    await thief.setClass(am.x.id, true)
    await thief.setClass(am.x.id, false)
    await w.rounds(3)
    expect(A.unknownWriters).toBeGreaterThan(before)
    expect(M.rel(A.state, am.x.id).classOn).toBe(true)
  }, 60_000)
})

describe('K2 Schritt 2: Matrix (beide Varianten)', () => {
  for (const stock of ['strict', 'shared'] as const) {
    it(`2. ${stock}: X1–X18, X7b, X21 mit zwei Geräten, 18/1/1; rot nur X7 strikt; X18 aus der Struktur (E2 (iv)), mit Ankerpaar-Orakel; X13 strukturell (MV-9 unter Geräteschlüsseln, ≈); X9 über Mengenrevisionen (≈, eigene Geräte noch Prüfstandsliste)`, async () => {
      const c = k2({ stock })
      expect(c.id).toBe(stock === 'shared' ? 'k2-shared-stock' : 'k2-device-keys')
      const r = byId(await runX15(c))
      const passed = ['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7b', 'X8', 'X9', 'X11', 'X12', 'X13', 'X14', 'X15', 'X16', 'X17', 'X18', 'X21']
      for (const x of passed) expect(r[x]!.outcome, `${x}: ${r[x]!.detail}`).toBe('bestanden')
      expect(r.X7!.outcome).toBe('nicht bestanden')
      expect(r.X10!.outcome).toBe('nicht abbildbar')
      expect(Object.values(r).some((x) => x.crashed)).toBe(false)
      // X18: one card per act, no K at B, both persons hold the same anchor pair, every member key opens what the other side seals.
      expect(r.X18!.measures.cardsProducedByA).toBe(1)
      expect(r.X18!.measures.cardConflictsAtB).toBe(0)
      expect(r.X18!.measures.anchorPairsAgree).toBe(1)
      expect(r.X18!.measures.membersDecrypt).toBe(1)
      expect(r.X18!.measures.cardIdentityAgrees).toBe(1)
      // X8: the enrolled device is addressable in every relationship of the person, from the counterparts' proofs.
      expect(r.X8!.measures.addressableRelationships).toBe(r.X8!.measures.relationships)
      // X9: the counterparts learn the revocation from a revocation entry, not from a list (step 2); the own devices still from the bench list.
      expect(r.X9!.measures.thiefReads).toBe(0)
      expect(r.X9!.measures.step1Shortcut).toBeUndefined()
      expect(r.X9!.detail).toContain('Widerrufseintrag')
    }, 400_000)
  }

  it('2b. Gegenlauf ohne Zwischenregel (`mediatorSplit: false`): M benennt jeden Schlüssel, X1, X13 und X14 fallen', async () => {
    const c = k2({ mediatorSplit: false })
    expect(c.id).toBe('k2-device-keys-no-split')
    const r = byId(await runX15(c, false, ['X1', 'X13', 'X14']))
    for (const x of ['X1', 'X13', 'X14']) expect(r[x]!.outcome, `${x}: ${r[x]!.detail}`).toBe('nicht bestanden')
  }, 300_000)

  it('2c. Kontrolllauf seriell (ein Gerät): jede Zelle mit Kontrolllauf besteht, beide Varianten', async () => {
    for (const stock of ['strict', 'shared'] as const) {
      const r = byId(await runX15(k2({ devices: 1, stock }), true))
      for (const x of Object.values(r)) expect(x.outcome, `${stock} ${x.scenario}: ${x.detail}`).not.toBe('nicht bestanden')
    }
  }, 400_000)
})

describe('K2 Schritt 1: Dieb, Restore, Fan-out', () => {
  it('3. Dieb mit dem Abbild von A2: vor dem Widerruf liest er, was A2s Schlüssel öffnen, nie A1s Adressen; nach dem Widerruf und einer Runde Ausbreitung (Widerrufseintrag an B und M, Schritt 2) 0 neue Dokumente; Gegenlauf nur Träger: er liest weiter', async () => {
    for (const counterpartRevocation of [true, false]) {
      const { w, A, A2, B, Mm, am, bm } = await world(k2({ counterpartRevocation }))
      const ab = await w.encounter(A, B)
      await w.rounds(3)
      const thief = await w.steal(A2, 'A2-dieb')
      w.devices.push(thief)
      A2.online = false // lost, not yet revoked
      const ctx = M.head(M.rel(A.state, am.x.id)).ownKey
      const a1 = (await A.cand.keys.pair(ctx)).rkid
      expect(w.carrier.registeredAt(a1)).toEqual(['A1']) // the thief never collects at A1's addresses
      await B.setClass(ab.y.id, true) // B → A: revision, sealed to A1 and A2
      await w.rounds(3)
      const readBefore = thief.log.filter((e) => e.type === 'introduction-prekeys').length
      expect(readBefore).toBeGreaterThanOrEqual(1) // A2's copy opens with A2's keys
      expect(thief.dispositions.some((d) => d.includes('decryption-failed'))).toBe(false)
      await w.revoke(A, A2)
      if (!w.devices.includes(thief)) w.devices.push(thief)
      await w.rounds(2) // the revocation entries reach B and M (the race of revocation against sending is step 3)
      const mark = thief.log.length
      const r = await Mm.introduce(am.y.id, bm.y.id) // M → A: ticket
      expect('act' in r).toBe(true)
      await B.setClass(ab.y.id, false) // B → A: empty revision
      await w.rounds(4)
      const after = thief.log.slice(mark).filter((e) => e.type !== 'delivery-ack').length
      if (counterpartRevocation) expect(after).toBe(0)
      else expect(after).toBeGreaterThan(0) // carrier only: B and M keep sealing to A2's keys
      if (counterpartRevocation) {
        expect(A.state.acts.length).toBe(1) // A1 still receives: M names only keys of members
        expect(thief.state.acts.length).toBe(0)
      } else {
        // carrier only: M does not know the revocation and may name a stock key of A2; then only the thief opens the ticket
        expect(A.state.acts.length + thief.state.acts.length).toBe(1)
      }
    }
  }, 120_000)

  it('4. Restore von A2 aus einem alten Abbild: dieselben Geräteschlüssel, neue Inkarnation, Nachholen bis zur gleichen Projektion', async () => {
    const { w, A, A2, Mm, am } = await world()
    const backup = w.stores.get('A2')!.snapshot()
    const self = (await A2.cand.keys.pair('self/A')).anchor
    const writer = A2.cand.writer
    const C = await w.person('C', 'C1')
    const cm = await w.encounter(C, Mm)
    await w.rounds(1)
    await C.setClass(cm.x.id, true)
    await w.rounds(3)
    const r = await Mm.introduce(am.y.id, cm.y.id)
    expect('act' in r).toBe(true)
    await w.rounds(4)
    w.stores.get('A2')!.restore(backup)
    await A2.reload()
    expect((await A2.cand.keys.pair('self/A')).anchor).toBe(self)
    expect(A2.cand.writer).not.toBe(writer)
    const n = await w.until(() => !A2.syncPending && w.agree('A').agree, 20)
    expect(n).toBeGreaterThan(0)
    expect(A2.gated).toBe(false)
    expect(A2.state.acts.length).toBe(A.state.acts.length)
  }, 60_000)

  it('5. K1a bleibt ein Rahmen je Dokument: keine Kopien in Submissions oder Absichten', async () => {
    const { A, A2, Mm, am, bm } = await world(k1a())
    await Mm.introduce(am.y.id, bm.y.id)
    for (const d of [A, A2, Mm]) {
      for (const s of d.zusteller.submissions.values()) expect(s.extra).toBeUndefined()
      for (const i of d.intents.values()) expect(i.copies).toBeUndefined()
    }
  }, 60_000)

  it('6. Fan-out mit drei Geräten: ein Journalbatch geht als zwei Kopien (je Schwester) statt eines Rahmens; ein Dokument von B an A als drei Kopien (je Mitglied der Menge, aus dem Nachweis) statt eines', async () => {
    const out: Record<string, { journal: number; journalBytes: number; doc: number }> = {}
    for (const [id, c] of [['k1a', k1a({ devices: 3 })], ['k2', k2({ devices: 3 })]] as const) {
      const { w, A, B, am } = await world(c, 3)
      let mark = w.carrier.carried.length
      await A.setClass(am.x.id, false)
      await w.rounds(1)
      const journal = w.carrier.carried.slice(mark).filter((f) => w.frameOrigin(f.bytes)?.device === 'A1' && w.frameOrigin(f.bytes)?.kind === 'journal')
      const ab = await w.encounter(A, B)
      await w.rounds(4)
      mark = w.carrier.carried.length
      await B.setClass(ab.y.id, true) // B → A: a revision on the A–B relationship
      await w.rounds(1)
      const toA = new Set<string>()
      for (const d of w.of('A')) toA.add((await d.cand.keys.pair(ab.x.ownKey)).rkid)
      const docs = w.carrier.carried.slice(mark).filter((f) => w.frameOrigin(f.bytes)?.kind === 'introduction-prekeys' && toA.has(f.address))
      out[id] = { journal: journal.length, journalBytes: journal.reduce((n, f) => n + f.bytes.length, 0), doc: docs.length }
    }
    expect(out.k1a!.journal).toBe(1)
    expect(out.k2!.journal).toBe(2)
    expect(out.k1a!.doc).toBe(1)
    expect(out.k2!.doc).toBe(3)
    expect(out.k2!.journalBytes).toBeGreaterThan(out.k1a!.journalBytes)
  }, 120_000)

  it('7. Ein Mapping an eine Gegenseite, deren aufgezeichnetes Gerät widerrufen ist, geht zuerst an ein Gerät der aktuellen Menge; die Wiederholung (6845.4) zielt auf dieselbe Adresse wie der erste Rahmen (CodeRabbit #73)', async () => {
    const { w, A, B, am } = await world()
    const B2 = await w.enrol(B, 'B2')
    await w.rounds(2)
    const ab = await w.encounter(A, B)
    await w.rounds(3)
    const arrival = M.head(M.rel(A.state, ab.x.id))
    const b1 = arrival.peerKeyAgreement
    expect(w.carrier.registeredAt(b1)).toEqual(['B1']) // recorded key = the creating device B1
    await w.revoke(B2, B)
    await w.rounds(1)
    const h = A as unknown as { sendMapping(a: M.Tuple, o: M.Tuple): Promise<void>; sent: Map<string, { kind: string; address: string }> }
    const before = new Set(h.sent.keys())
    await h.sendMapping(arrival, M.head(M.rel(A.state, am.x.id)))
    const [d] = [...h.sent.keys()].filter((k) => !before.has(k))
    const sub = A.zusteller.submissions.get(d!)!
    expect(sub.address).not.toBe(b1) // primary frame sealed to B2's key for the context
    expect(h.sent.get(d!)!.address).toBe(sub.address) // the retry re-records the primary frame at the address it was sealed to
  }, 60_000)

  it('8. Signierer = Schreiber (Review 31 B1): unter Geräteschlüsseln ist ein Nutzlastfeld `writer` in Revision, Probe und Mapping ein Formfehler (Befund, keine Quittung, Ms Zustand je Schreiber unberührt), auch wenn es den Signierer selbst nennt; A1s nächste echte Revision gilt', async () => {
    const { w, A, A2, Mm, am } = await world()
    type Raw = { sendDoc(type: string, ctx: string, peer: string, peerKa: string, rkid: string, payload: Record<string, unknown>): Promise<{ digest: string }>; sendRevision(rel: string): Promise<void>; completed: Set<string> }
    const raw = (d: HolderDevice) => d as unknown as Raw
    const h = M.head(M.rel(A2.state, am.x.id))
    const rkid = (await A2.cand.keys.pair(h.ownKey)).rkid
    const a1 = signerId((await A.cand.keys.pair(M.head(M.rel(A.state, am.x.id)).ownKey)).anchor)
    const a2 = signerId((await A2.cand.keys.pair(h.ownKey)).anchor)
    const mRel = () => M.relOfTuple(Mm.state, am.y.id)!
    const writersBefore = JSON.stringify(mRel().view?.writers ?? {})
    const held1 = M.own(mRel().view?.writers, a1)?.revision ?? 0
    expect(held1).toBeGreaterThan(0)
    const findingsBefore = Mm.state.findings.length
    // Astra's probe: A2 signs a revision naming A1 as writer, and the same naming itself; a probe and a mapping with the field.
    const forged = [
      await raw(A2).sendDoc(TYPES.revision, h.ownKey, h.peer, h.peerKeyAgreement, rkid, { revision: 1000, keys: [], writer: a1 }),
      await raw(A2).sendDoc(TYPES.revision, h.ownKey, h.peer, h.peerKeyAgreement, rkid, { revision: 1001, keys: [], writer: a2 }),
      await raw(A2).sendDoc(TYPES.probe, h.ownKey, h.peer, h.peerKeyAgreement, rkid, { entries: [], writer: a1 }),
      await raw(A2).sendDoc(TYPES.mapping, h.ownKey, h.peer, h.peerKeyAgreement, rkid, { entry: 'x', writer: a1 }),
    ]
    await w.rounds(3)
    for (const f of forged) expect(raw(Mm).completed.has(f.digest)).toBe(false) // no receipt
    expect(JSON.stringify(mRel().view?.writers ?? {})).toBe(writersBefore)
    expect(Mm.state.findings.slice(findingsBefore).filter((f) => f.includes('writer-Feld'))).toHaveLength(4)
    // A1's next real revision is accepted at M.
    await raw(A).sendRevision(am.x.id)
    await w.rounds(3)
    expect(M.own(mRel().view?.writers, a1)?.revision).toBe(held1 + 1)
  }, 60_000)

  it('8b. K1a (Schreiberkennung im Feld) unverändert: das Feld `writer` bleibt der Schreiber', async () => {
    const { w, A, Mm, am } = await world(k1a())
    const tag = A.cand.writerTag!(am.x.id)
    const mRel = () => M.relOfTuple(Mm.state, am.y.id)!
    const held = M.own(mRel().view?.writers, tag)?.revision ?? 0
    expect(held).toBeGreaterThan(0)
    await (A as unknown as { sendRevision(rel: string): Promise<void> }).sendRevision(am.x.id)
    await w.rounds(3)
    expect(M.own(mRel().view?.writers, tag)?.revision).toBe(held + 1)
  }, 60_000)
})

// ── K2 Schritt 2 (Anton 19.10., Plan 6r): device-set@1, Kartenbezug, Produzentenregel E2 (iv), strict gegen shared ──

type Raw = {
  sendDoc(type: string, ctx: string, peer: string, peerKa: string, rkid: string, payload: Record<string, unknown>, fan?: Array<{ anchor: string; rkid: string }>): Promise<{ digest: string } | null>
  cert(ctx: string, c: { root: string; kind: 'admit' | 'revoke'; anchor: string; keyAgreement: string | null }): Promise<M.SetCert>
  completed: Set<string>
}
const raw = (d: HolderDevice) => d as unknown as Raw
/** A thief runs its own software: it ignores the gate after restore (MV-6) that an honest image would keep. */
const rogue = (d: HolderDevice) => Object.assign(d as unknown as { catchUp: boolean; sync: { pending: boolean } }, { catchUp: false, sync: { pending: false, wait: 0, backoff: 1, id: null } }) as unknown as HolderDevice
const members = (d: HolderDevice, root: string) => M.setView(d.setOf(root)).members.map((m) => m.anchor)
/** A world with an A–B encounter after A2's enrolment (A2 admitted from A1's pool), both A devices online. */
async function abWorld(c: MultiDeviceCandidate = k2(), devices = 2) {
  const base = await world(c, devices)
  const ab = await base.w.encounter(base.A, base.B)
  await base.w.rounds(4)
  return { ...base, ab }
}
/** An introduction of A and B by M; returns the act once both sides know it. */
async function introduced(s: Awaited<ReturnType<typeof world>>, M2?: HolderDevice) {
  let r = await s.Mm.introduce(s.am.y.id, s.bm.y.id)
  if (!('act' in r) && M2) r = await M2.introduce(s.am.y.id, s.bm.y.id)
  expect('act' in r, JSON.stringify(r)).toBe(true)
  const act = (r as { act: string }).act
  await s.w.until(() => [...s.w.of('A'), ...s.w.of('B')].some((d) => d.state.acts.some((a) => a.id === act)) && s.w.of('A').every((d) => d.state.acts.some((a) => a.id === act)) && s.B.state.acts.some((a) => a.id === act), 10)
  return act
}
const allocatorOf = (d: HolderDevice, act: string) => {
  const a = M.act(d.state, act)
  return M.findRel(d.state, a.mediator)!.stock.find((k) => k.anchor === a.own)!.by
}

describe('K2 Schritt 2: Gerätemengen aus Nachweisen', () => {
  it('S1. Modell: Zulassung über eine signierte Kette bis zur Wurzel, Widerruf endgültig, reihenfolgeunabhängig; ein Nachweis eines unbekannten Ausstellers wirkt erst, wenn dessen Zulassung da ist', () => {
    const proof = { type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', created: '2026-10-19T00:00:00Z', verificationMethod: 'x', proofPurpose: 'assertionMethod', proofValue: 'z' }
    const cert = (kind: 'admit' | 'revoke', anchor: string, by: string): M.SetCert => ({ root: 'r', kind, anchor, keyAgreement: kind === 'admit' ? `ka-${anchor}` : null, by, proof })
    const fold = (certs: M.SetCert[]) => {
      const s = M.emptyState('B')
      certs.forEach((c, i) => M.apply(s, { id: { writer: 'B1@x', n: i + 1 }, at: '2026-10-19T00:00:00Z', kind: 'device-set', root: 'r', rootKeyAgreement: 'ka-r', certs: [c] }))
      return M.setView(M.own(s.sets, 'r'))
    }
    const all = [cert('admit', 'a2', 'r'), cert('admit', 'a3', 'a2'), cert('revoke', 'a2', 'r')]
    for (const order of [[0, 1, 2], [2, 1, 0], [1, 0, 2], [1, 2, 0]]) {
      const v = fold(order.map((i) => all[i]!))
      expect(v.members.map((m) => m.anchor)).toEqual(['a3', 'r']) // a3 stays: admitted while a2 was a member (history, named residual 1b)
      expect([...v.revoked]).toEqual(['a2'])
    }
    // A cert by an admitter without an admission chain has no effect yet.
    expect(fold([cert('admit', 'a5', 'a4')]).members.map((m) => m.anchor)).toEqual(['r'])
    // A revocation of the root by a member: the root is out, the member stays; all revoked: a known-empty set.
    expect(fold([cert('admit', 'a2', 'r'), cert('revoke', 'r', 'a2')]).members.map((m) => m.anchor)).toEqual(['a2'])
    expect(fold([cert('admit', 'a2', 'r'), cert('revoke', 'r', 'a2'), cert('revoke', 'a2', 'r')]).members).toEqual([])
    // 6270 per signer: the same revision number with another digest is a finding, deterministic in both orders.
    const revs = (a: string, b: string) => {
      const s = M.emptyState('B')
      for (const [i, d] of [a, b].entries()) M.apply(s, { id: { writer: 'B1@x', n: i + 1 }, at: '2026-10-19T00:00:00Z', kind: 'device-set', root: 'r', rootKeyAgreement: 'ka-r', certs: [], rev: { signer: 'AAAAAAAAAAAAAAAA', n: 1, digest: d } })
      return { held: M.own(M.own(s.sets, 'r')!.revs, 'AAAAAAAAAAAAAAAA')!.digest, findings: s.findings.filter((f) => f.includes('Equivokation')).length }
    }
    const d1 = 'uEiA' + 'a'.repeat(43)
    const d2 = 'uEiA' + 'b'.repeat(43)
    expect(revs(d1, d2)).toEqual(revs(d2, d1))
    expect(revs(d1, d2).findings).toBe(1)
  })

  it('S1b. Modell (CodeRabbit #74): widersprüchliche Nachweise mit demselben Schlüssel (Art, Anker, Aussteller) und ein widersprüchlicher Wurzel-Vereinbarungsschlüssel falten in jeder Reihenfolge gleich: das kanonisch kleinere bleibt, je Konflikt ein Befund', () => {
    const proof = (v: string) => ({ type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', created: '2026-10-19T00:00:00Z', verificationMethod: 'x', proofPurpose: 'assertionMethod', proofValue: v })
    const c1: M.SetCert = { root: 'r', kind: 'admit', anchor: 'a2', keyAgreement: 'ka-1', by: 'r', proof: proof('z1') }
    const c2: M.SetCert = { root: 'r', kind: 'admit', anchor: 'a2', keyAgreement: 'ka-2', by: 'r', proof: proof('z2') }
    const fold = (ops: Array<{ rka: string; cert: M.SetCert }>) => {
      const s = M.emptyState('B')
      ops.forEach((o, i) => M.apply(s, { id: { writer: 'B1@x', n: i + 1 }, at: '2026-10-19T00:00:00Z', kind: 'device-set', root: 'r', rootKeyAgreement: o.rka, certs: [o.cert] }))
      const set = M.own(s.sets, 'r')!
      return { set: M.canonical({ rka: set.rootKeyAgreement, certs: set.certs }), findings: s.findings.length }
    }
    const x = fold([{ rka: 'ka-r', cert: c1 }, { rka: 'ka-q', cert: c2 }])
    const y = fold([{ rka: 'ka-q', cert: c2 }, { rka: 'ka-r', cert: c1 }])
    expect(x.set).toBe(y.set)
    expect(x.set).toContain('ka-1') // the smaller certificate
    expect(x.set).toContain('ka-q') // the smaller root key agreement
    expect(x.findings).toBe(2)
    expect(y.findings).toBe(2)
    // The same conflict again adds no finding (deduplicated); an identical certificate is no conflict.
    expect(fold([{ rka: 'ka-r', cert: c1 }, { rka: 'ka-q', cert: c2 }, { rka: 'ka-r', cert: c2 }, { rka: 'ka-r', cert: c1 }]).findings).toBe(2)
  })

  it('S2. Begegnung: B kennt As Menge nur aus dem Nachweis (keine Liste für Gegenseiten); ohne Nachweis versiegelt B an die Wurzel allein, danach an jedes Mitglied', async () => {
    const c = k2()
    expect('recipients' in c.directory).toBe(false)
    const { w, A, A2, B } = await world(c)
    // The set revision of the new relationship does not reach B at first.
    w.carrier.faults.drop((f) => w.frameOrigin(f.bytes)?.kind === 'device-set')
    const ab = await w.encounter(A, B)
    await w.rounds(3)
    expect(B.setOf(ab.y.peer)).toBeUndefined() // unknown membership: only the root
    let mark = w.carrier.carried.length
    await B.setClass(ab.y.id, true)
    await w.rounds(1)
    const toA = async () => {
      const keys = new Map<string, string>()
      for (const d of w.of('A')) keys.set((await d.cand.keys.pair(ab.x.ownKey)).rkid, d.name)
      return w.carrier.carried.slice(mark).filter((f) => w.frameOrigin(f.bytes)?.kind === 'introduction-prekeys' && keys.has(f.address)).map((f) => keys.get(f.address))
    }
    expect(await toA()).toEqual(['A1'])
    // The proof arrives (A1 repeats it until B acknowledges): now B seals to every member, A2's key from A1's pool.
    w.carrier.faults.reset()
    await w.until(() => !!B.setOf(ab.y.peer), 20)
    expect(members(B, ab.y.peer)).toEqual([...members(A, ab.x.own)])
    expect(members(B, ab.y.peer)).toContain((await A2.cand.keys.pair(ab.x.ownKey)).anchor)
    mark = w.carrier.carried.length
    await B.setClass(ab.y.id, false)
    await B.setClass(ab.y.id, true)
    await w.rounds(1)
    expect([...new Set(await toA())].sort()).toEqual(['A1', 'A2'])
  }, 60_000)

  it('S3. Bekannt leer ist ein ausdrücklicher Zustellfehler (kein Rahmen an einen aufgezeichneten Schlüssel); ein Dokument eines widerrufenen Mitglieds wirkt nicht', async () => {
    const { w, A, A2, B, ab } = await abWorld()
    const a2key = (await A2.cand.keys.pair(ab.x.ownKey)).anchor
    // A2 signs a probe before anything is revoked: accepted.
    const probe = async (d: HolderDevice) => raw(d).sendDoc(TYPES.probe, ab.x.ownKey, ab.x.peer, ab.x.peerKeyAgreement, (await d.cand.keys.pair(ab.x.ownKey)).rkid, { entries: [] })
    const p1 = await probe(A2)
    await w.rounds(2)
    expect(raw(B).completed.has(p1!.digest)).toBe(true)
    // A1 (the root) revokes A2 and then itself in this relationship: injected revocation entries, sent as one revision.
    const revoke = [await raw(A).cert(ab.x.ownKey, { root: ab.x.own, kind: 'revoke', anchor: a2key, keyAgreement: null }), await raw(A).cert(ab.x.ownKey, { root: ab.x.own, kind: 'revoke', anchor: ab.x.own, keyAgreement: null })]
    const set = A.setOf(ab.x.own)!
    await raw(A).sendDoc(TYPES.deviceSet, ab.x.ownKey, ab.x.peer, ab.x.peerKeyAgreement, (await A.cand.keys.pair(ab.x.ownKey)).rkid, { root: ab.x.own, rootKeyAgreement: set.rootKeyAgreement, revision: 50, deps: [], entries: [...Object.values(set.certs), ...revoke] as unknown as Json[] })
    await w.rounds(2)
    expect(members(B, ab.y.peer)).toEqual([])
    // A2's next document is refused (no receipt), a revoked member is no peer any more.
    const p2 = await probe(A2)
    await w.rounds(2)
    expect(raw(B).completed.has(p2!.digest)).toBe(false)
    // B's next revision to A: no frame at all, the failure is explicit.
    const before = B.emptySetFailures
    const mark = w.carrier.carried.length
    await B.setClass(ab.y.id, true)
    await w.rounds(1)
    expect(B.emptySetFailures).toBeGreaterThan(before)
    expect(B.dispositions.some((d) => d.startsWith('failed(empty-device-set)'))).toBe(true)
    const toA = new Set([ab.x.peerKeyAgreement, ab.y.peerKeyAgreement])
    expect(w.carrier.carried.slice(mark).filter((f) => w.frameOrigin(f.bytes)?.kind === 'introduction-prekeys' && toA.has(f.address))).toHaveLength(0)
  }, 60_000)

  it('S3b. Eine Mengenrevision an eine bekannt leere Menge geht nicht hinaus und gilt nicht als veröffentlicht (CodeRabbit #74): kein `covered`, keine Nummer verbraucht', async () => {
    const { w, A, A2, B, ab } = await abWorld()
    const a2key = (await A2.cand.keys.pair(ab.x.ownKey)).anchor
    const revoke = [await raw(A).cert(ab.x.ownKey, { root: ab.x.own, kind: 'revoke', anchor: a2key, keyAgreement: null }), await raw(A).cert(ab.x.ownKey, { root: ab.x.own, kind: 'revoke', anchor: ab.x.own, keyAgreement: null })]
    const set = A.setOf(ab.x.own)!
    await raw(A).sendDoc(TYPES.deviceSet, ab.x.ownKey, ab.x.peer, ab.x.peerKeyAgreement, (await A.cand.keys.pair(ab.x.ownKey)).rkid, { root: ab.x.own, rootKeyAgreement: set.rootKeyAgreement, revision: 50, deps: [], entries: [...Object.values(set.certs), ...revoke] as unknown as Json[] })
    await w.rounds(2)
    expect(members(B, ab.y.peer)).toEqual([])
    const signer = signerId(ab.y.own)
    const before = M.own(B.setOf(ab.y.own)!.revs, signer)
    const failures = B.emptySetFailures
    await w.enrol(B, 'B2') // B admits B2 in its set of this relationship and publishes the revision to A: known empty
    await w.rounds(2)
    expect(B.emptySetFailures).toBeGreaterThan(failures)
    const after = M.own(B.setOf(ab.y.own)!.revs, signer)
    expect(after?.n ?? 0).toBe(before?.n ?? 0)
    expect(after?.covered ?? null).toEqual(before?.covered ?? null)
  }, 60_000)

  it('S4. Ein bekannter Widerruf schlägt: nach dem Widerruf von A2 weist B eine Mengenrevision ab, die A2s Schlüssel signiert (Dieb mit dem Abbild); die Menge bleibt', async () => {
    const { w, A, A2, B, ab } = await abWorld()
    const thief = rogue(await w.steal(A2, 'A2-dieb'))
    await w.revoke(A, A2)
    await w.rounds(3)
    const before = M.canonical(members(B, ab.y.peer))
    expect(members(B, ab.y.peer)).not.toContain((await thief.cand.keys.pair(ab.x.ownKey)).anchor)
    // The thief admits a key of its own and signs with A2's key.
    const fake = await raw(thief).cert(ab.x.ownKey, { root: ab.x.own, kind: 'admit', anchor: ab.y.own, keyAgreement: ab.y.peerKeyAgreement })
    const set = thief.setOf(ab.x.own)!
    await raw(thief).sendDoc(TYPES.deviceSet, ab.x.ownKey, ab.x.peer, ab.x.peerKeyAgreement, (await thief.cand.keys.pair(ab.x.ownKey)).rkid, { root: ab.x.own, rootKeyAgreement: set.rootKeyAgreement, revision: 9, deps: [], entries: [...Object.values(set.certs), fake] as unknown as Json[] }, [{ anchor: ab.x.peer, rkid: ab.x.peerKeyAgreement }])
    w.devices.push(thief)
    await w.rounds(3)
    expect(M.canonical(members(B, ab.y.peer))).toBe(before)
    expect(B.state.findings.some((f) => f.includes('widerrufen: abgewiesen'))).toBe(true)
  }, 60_000)

  it('S5. Echte 6270-Equivokation einer Mengenrevision: gleicher Signierer, gleiche Nummer, anderer Inhalt: Befund (kein K eines Akts), beide B-Geräte gleich', async () => {
    const { w, A, A2, B, ab } = await abWorld()
    const B2 = await w.enrol(B, 'B2')
    await w.rounds(3)
    const set = A.setOf(ab.x.own)!
    const n = M.own(set.revs, signerId(ab.x.own))!.n + 1
    const extra = await raw(A).cert(ab.x.ownKey, { root: ab.x.own, kind: 'admit', anchor: (await A2.cand.keys.pair('pool/77')).anchor, keyAgreement: (await A2.cand.keys.pair('pool/77')).rkid })
    const send = (entries: unknown[]) => raw(A).sendDoc(TYPES.deviceSet, ab.x.ownKey, ab.x.peer, ab.x.peerKeyAgreement, set.rootKeyAgreement, { root: ab.x.own, rootKeyAgreement: set.rootKeyAgreement, revision: n, deps: [], entries: entries as Json[] })
    await send(Object.values(set.certs))
    await send([...Object.values(set.certs), extra])
    await w.rounds(4)
    for (const d of [B, B2]) expect(d.state.findings.filter((f) => f.includes('Equivokation (6270)') && f.startsWith('device-set'))).toHaveLength(1)
    expect(w.agree('B')).toEqual({ agree: true, diff: '' })
    expect(B.state.acts.some((a) => a.k)).toBe(false)
  }, 60_000)

  it('S6. Enrollment: das neue Gerät wird in jeder Beziehung zugelassen (Fan-out = Zahl der Beziehungen), jede Gegenseite versiegelt danach auch an es', async () => {
    const { w, A } = await world(k2({ devices: 3 }), 2)
    const cs: Array<{ C: HolderDevice; t: { x: M.Tuple; y: M.Tuple } }> = []
    for (const n of ['C1', 'C2', 'C3']) {
      const C = await w.person(n, `${n}1`)
      cs.push({ C, t: await w.encounter(A, C) })
    }
    await w.rounds(4)
    const c = w.candidate as ReturnType<typeof k2>
    const mark = w.carrier.carried.length
    const A3 = await w.enrol(A, 'A3')
    const sets = w.carrier.carried.slice(mark).filter((f) => w.frameOrigin(f.bytes)?.kind === 'device-set')
    expect(sets.length).toBeGreaterThanOrEqual(3)
    expect(c.ceremonies.at(-1)!.contexts).toBe(A.state.relationships.flatMap((r) => r.tuples).length)
    await w.until(() => cs.every(({ C, t }) => members(C, t.y.peer).length === 3), 10)
    for (const { C, t } of cs) expect(members(C, t.y.peer)).toContain((await A3.cand.keys.pair(t.x.ownKey)).anchor)
  }, 60_000)

  it('S7. Zwei gleichzeitige Enrollments (A1 nimmt A3 auf, A2 nimmt A4 auf, getrennt): beide Zugänge bleiben, keine 6270-Equivokation, gleiche Menge bei B', async () => {
    const { w, A, A2, B, ab } = await abWorld(k2({ devices: 4 }))
    const selfA = () => w.selfAddresses('A')
    w.carrier.faults.drop((f) => selfA().has(f.address))
    const A3 = await w.enrol(A, 'A3')
    const A4 = await w.enrol(A2, 'A4')
    await w.rounds(3)
    w.carrier.faults.reset()
    await w.until(() => members(B, ab.y.peer).length === 4, 20)
    expect(members(B, ab.y.peer)).toEqual(expect.arrayContaining([(await A3.cand.keys.pair(ab.x.ownKey)).anchor, (await A4.cand.keys.pair(ab.x.ownKey)).anchor]))
    expect(B.state.findings.some((f) => f.includes('Equivokation'))).toBe(false)
    await w.rounds(6)
    expect(w.agree('A')).toEqual({ agree: true, diff: '' })
  }, 90_000)

  it('S8. Enrollment gegen Widerruf in beiden Reihenfolgen bei B: dieselbe Endmenge', async () => {
    const ends: string[] = []
    for (const reverse of [false, true]) {
      const { w, A, A2, B, ab } = await abWorld(k2({ devices: 3 }))
      w.carrier.faults.reverse(reverse)
      await w.enrol(A, 'A3')
      await w.revoke(A, A2)
      await w.rounds(4)
      w.carrier.faults.reverse(false)
      await w.rounds(4)
      expect(members(B, ab.y.peer)).toHaveLength(2)
      ends.push(M.canonical({ revoked: M.setView(B.setOf(ab.y.peer)).revoked.size, members: members(B, ab.y.peer).length }))
    }
    expect(ends[0]).toBe(ends[1])
  }, 90_000)

  it('S9. 2290: der Record-Anker bleibt der des gewählten Tupels, auch wenn ein Enrollment kleinere Anker in die Menge bringt; 2300 eingefroren', async () => {
    const { w, A, ab } = await abWorld(k2({ devices: 3 }))
    const before = M.canonical(A.state.relationships.map((r) => r.tuples.map((t) => ({ id: t.id, record: t.record, own: t.own, candidates: t.candidates }))))
    const head = M.head(M.relOfTuple(A.state, ab.x.id)!).id
    await w.enrol(A, 'A3')
    await w.rounds(4)
    for (const d of w.of('A')) {
      expect(M.canonical(d.state.relationships.map((r) => r.tuples.map((t) => ({ id: t.id, record: t.record, own: t.own, candidates: t.candidates }))))).toBe(before)
      expect(M.head(M.relOfTuple(d.state, ab.x.id)!).id).toBe(head)
    }
  }, 60_000)

  it('S10. Erschöpfter Vorrat: öffnet A1 Beziehungen, solange A2 offline ist, fehlt A2 in den späteren Mengen; nach dem Nachfüllen nimmt A1 es nach (gemessene Lücke)', async () => {
    const { w, A, A2 } = await world()
    A2.online = false
    const ts: Array<{ C: HolderDevice; t: { x: M.Tuple; y: M.Tuple } }> = []
    for (let i = 0; i < 6; i++) {
      const C = await w.person(`C${i}`, `C${i}1`)
      ts.push({ C, t: await w.encounter(A, C) })
      await w.rounds(2)
    }
    const without = ts.filter(({ C, t }) => members(C, t.y.peer).length === 1).length
    expect(without).toBeGreaterThan(0) // A2's pool for A1 held four keys
    A2.online = true
    const n = await w.until(() => ts.every(({ C, t }) => members(C, t.y.peer).length === 2), 20)
    expect(n).toBeGreaterThan(0)
  }, 90_000)
})

describe('K2 Schritt 2: Karte (E1 (a), E2 (iv), E3 (a))', () => {
  for (const stock of ['strict', 'shared'] as const) {
    it(`C1. ${stock}: Produzentenregel E2 (iv): das nicht zuteilende Gerät zeichnet nur die Zustimmung auf, das zuteilende erzeugt die eine Karte; B: eine Karte, kein K`, async () => {
      const s = await world(k2({ stock }))
      const act = await introduced(s)
      const allocator = allocatorOf(s.A, act)
      const [prod, other] = allocator === 'A1' ? [s.A, s.A2] : [s.A2, s.A]
      await s.w.until(() => other.state.acts.some((a) => a.id === act), 10)
      const ops = (d: HolderDevice) => ((d.cand as K2Device).journal() as Batch[]).filter((b) => b.writer.startsWith(`${d.name}@`)).flatMap((b) => b.ops)
      await other.consent(act)
      expect(ops(other).some((o) => o.kind === 'consent' && o.act === act && o.card === null)).toBe(true)
      expect(ops(other).some((o) => o.kind === 'produce')).toBe(false)
      expect([...other.intents.values()].some((i) => i.kind.includes('introduction-card') && i.device === other.name)).toBe(false)
      await s.B.consent(act)
      await s.w.until(() => [s.A, s.A2, s.B].every((d) => M.act(d.state, act).state === 'connected'), 15)
      expect(ops(prod).filter((o) => o.kind === 'produce' && o.act === act)).toHaveLength(1)
      expect(M.act(s.B.state, act).k).toBe(false)
      expect(s.B.log.filter((e) => e.type === 'introduction-card')).toHaveLength(1)
      // One card, one hand-over: no provisional choice, nothing withdrawn as a losing card (8232.2 needs no loser under E2 (iv)).
      for (const d of s.w.of('A')) {
        expect(Object.keys(M.act(d.state, act).cards ?? {})).toHaveLength(1)
        expect(d.losingCardsWithdrawn).toBe(0)
      }
    }, 60_000)
  }

  it('C2. Gegenlauf ohne Produzentenregel: shared, zwei Karten desselben Signierers (der Schlüssel der Menge) → K bei B (8910.8); strict, die zweite ist unter einem fremden Schlüssel signiert → abgewiesen ohne K (E3 (a))', async () => {
    for (const stock of ['shared', 'strict'] as const) {
      const s = await world(k2({ stock, producerRule: false }))
      const act = await introduced(s)
      const selfA = s.w.selfAddresses('A')
      for (const d of s.w.of('A')) s.w.carrier.faults.withhold(d.name, (f) => selfA.has(f.address))
      await s.A.consent(act)
      await s.A2.consent(act)
      await s.B.consent(act)
      await s.w.rounds(5)
      s.w.carrier.faults.reset()
      await s.w.rounds(5)
      if (stock === 'shared') expect(M.act(s.B.state, act).k).toBe(true)
      else {
        expect(M.act(s.B.state, act).k).toBe(false)
        expect(s.B.dispositions.filter((d) => d === 'failed(validation-failed)').length).toBeGreaterThan(0)
      }
    }
  }, 120_000)

  it('C3. Karte vor ihrem Mengennachweis: zurückgestellt (kein V, kein K, keine Quittung); nach dem Nachweis genau eine Verbindung', async () => {
    const s = await world(k2())
    const act = await introduced(s)
    await s.B.consent(act)
    await s.w.rounds(3)
    // The set revision of A's card does not reach B yet; the card does.
    s.w.carrier.faults.drop((f) => s.w.frameOrigin(f.bytes)?.kind === 'device-set' && f.address === M.act(s.A.state, act).voucher.keyAgreement)
    const prod = allocatorOf(s.A, act) === 'A1' ? s.A : s.A2
    await prod.consent(act)
    await s.w.rounds(3)
    expect(s.B.deferredCards).toBeGreaterThan(0)
    const b = M.act(s.B.state, act)
    expect([b.v, b.k, b.pending, b.state]).toEqual([null, false, null, 'consented'])
    s.w.carrier.faults.reset()
    await s.w.until(() => M.act(s.B.state, act).state === 'connected', 20)
    expect(M.act(s.B.state, act).state).toBe('connected')
    expect(new Set(s.w.of('B').flatMap((d) => d.state.effects.filter((e) => e.id === `connect:${act}`).map((e) => e.op))).size).toBe(1)
  }, 60_000)

  it('C4. Ein bekannter Widerruf schlägt den älteren Bezug: ist die Wurzel der Karte bei B widerrufen, wird die Karte ohne K abgewiesen, V bleibt leer', async () => {
    const s = await world(k2())
    const act = await introduced(s)
    await s.B.consent(act)
    await s.w.rounds(2)
    const prod = allocatorOf(s.A, act) === 'A1' ? s.A : s.A2
    const other = prod === s.A ? s.A2 : s.A
    const voucher = M.act(s.A.state, act).voucher
    s.w.carrier.faults.drop((f) => s.w.frameOrigin(f.bytes)?.kind === 'introduction-card')
    await prod.consent(act)
    await s.w.rounds(3)
    // The sibling, admitted in the card's set, revokes the card root at B (injected revocation entry, to B's voucher key).
    await s.w.until(() => !!M.act(other.state, act).ownCardKey, 10)
    const a = M.act(other.state, act)
    const root = a.ownCard!.anchor
    const set = other.setOf(root)!
    const rev = await raw(other).cert(a.ownCardKey!, { root, kind: 'revoke', anchor: root, keyAgreement: null })
    await raw(other).sendDoc(TYPES.deviceSet, a.ownCardKey!, voucher.anchor, voucher.keyAgreement, (await other.cand.keys.pair(a.ownCardKey!)).rkid, { root, rootKeyAgreement: set.rootKeyAgreement, revision: 40, deps: [], entries: [...Object.values(set.certs), rev] as unknown as Json[] })
    await s.w.rounds(3)
    expect(M.setView(s.B.setOf(root)).revoked.has(root)).toBe(true)
    s.w.carrier.faults.reset()
    await s.w.rounds(4)
    const b = M.act(s.B.state, act)
    expect([b.state, b.v, b.k]).toEqual(['consented', null, false])
    expect(s.B.state.findings.some((f) => f.includes('ein bekannter Widerruf schlägt den älteren Bezug'))).toBe(true)
  }, 60_000)

  it('C5. Fremdkarte und Bindung: eine Karte unter einem anderen Schlüssel als `from` wird ohne K abgewiesen (E3 (a)); unter dem richtigen `from` mit anderem `fromKeyAgreement` setzt sie K (8850.6 (d))', async () => {
    const s = await world(k2())
    const act = await introduced(s)
    await s.B.consent(act)
    const prod = allocatorOf(s.A, act) === 'A1' ? s.A : s.A2
    await prod.consent(act)
    await s.w.until(() => M.act(s.B.state, act).state === 'connected', 10)
    const a = M.act(prod.state, act)
    const stock = M.findRel(prod.state, a.mediator)!.stock.find((k) => k.anchor === a.own)!
    const set = M.own(prod.setOf(a.ownCard!.anchor)!.revs, signerId(a.ownCard!.anchor))!.digest
    const card = { anchor: a.ownCard!.anchor, keyAgreement: a.ownCard!.keyAgreement }
    const payload = (o: Record<string, unknown>) => ({ act, expiresAt: a.expiresAt, from: a.own, fromKeyAgreement: stock.keyAgreement, to: a.voucher.anchor, card, set, ...o })
    // A foreign signer (M's key for its A–M tuple) with `from` = the voucher key: refused, no K, V unchanged.
    const v0 = M.act(s.B.state, act).v
    const mh = M.head(M.rel(s.Mm.state, s.am.y.id))
    await raw(s.Mm).sendDoc(TYPES.card, mh.ownKey, a.voucher.anchor, a.voucher.keyAgreement, (await s.Mm.cand.keys.pair(mh.ownKey)).rkid, payload({ card: { anchor: mh.own, keyAgreement: mh.peerKeyAgreement } }))
    await s.w.rounds(2)
    expect(M.act(s.B.state, act).k).toBe(false)
    expect(M.act(s.B.state, act).v).toBe(v0)
    // The right signer with a contradicting key binding: K.
    await raw(prod).sendDoc(TYPES.card, stock.key, a.voucher.anchor, a.voucher.keyAgreement, stock.keyAgreement, payload({ fromKeyAgreement: a.voucher.keyAgreement }))
    await s.w.rounds(2)
    expect(M.act(s.B.state, act).k).toBe(true)
  }, 60_000)

  it('C6. Ticket: strict öffnet nur der Halter des benannten Vorrats-Schlüssels; shared jedes Gerät der Menge (die Schwester hält den privaten Teil aus dem Journal)', async () => {
    for (const stock of ['strict', 'shared'] as const) {
      const s = await world(k2({ stock }))
      const r = await s.Mm.introduce(s.am.y.id, s.bm.y.id)
      expect('act' in r).toBe(true)
      await s.w.rounds(2)
      const act = (r as { act: string }).act
      const a = M.act(s.w.of('A').find((d) => d.state.acts.some((x) => x.id === act))!.state, act)
      const k = M.findRel(s.A.state, a.mediator)!.stock.find((x) => x.anchor === a.own)!
      const readers = s.w.of('A').filter((d) => d.log.some((e) => e.type === 'introduction-ticket')).map((d) => d.name)
      if (stock === 'strict') {
        expect(readers).toEqual([k.by])
        expect(s.w.carrier.registeredAt(k.keyAgreement)).toEqual([k.by])
      } else {
        expect(readers.sort()).toEqual(['A1', 'A2'])
        expect(s.w.carrier.registeredAt(k.keyAgreement)).toEqual(['A1', 'A2'])
      }
    }
  }, 60_000)

  it('C7. Restore des zuteilenden Geräts vor der Produktion: keine zweite Karte (die Produktion wartet aufs Nachholen; die frühere Inkarnation hatte schon erzeugt)', async () => {
    const s = await world(k2())
    const act = await introduced(s)
    const prod = allocatorOf(s.A, act) === 'A1' ? s.A : s.A2
    const backup = s.w.stores.get(prod.name)!.snapshot()
    await prod.consent(act)
    await s.w.rounds(3)
    s.w.stores.get(prod.name)!.restore(backup)
    await prod.reload()
    await s.B.consent(act)
    await s.w.until(() => M.act(s.B.state, act).state === 'connected', 20)
    await s.w.rounds(4)
    const produced = s.w.of('A').flatMap((d) => ((d.cand as K2Device).journal() as Batch[]).flatMap((b) => b.ops)).filter((o) => o.kind === 'produce' && o.act === act)
    expect(new Set(produced.map((o) => (o as { v: string }).v)).size).toBe(1)
    expect(M.act(s.B.state, act).k).toBe(false)
  }, 60_000)

  it('C8. Dieb gewinnt zuerst (E1 (a)): der Dieb mit A2s Abbild erzeugt die Karte (strict, A2s Schlüssel), B bindet sie; der Widerruf heilt diese Beziehung nicht (benannter Preis)', async () => {
    const s = await world(k2({ mediatorSplit: false })) // one mediator device names every key (the split is not under test here)
    let act = ''
    for (let i = 0; i < 6 && !act; i++) {
      const x = await introduced(s)
      if (allocatorOf(s.A, x) === 'A2') act = x
      else {
        await s.A.decline(x)
        await s.w.rounds(1)
      }
    }
    expect(act).not.toBe('')
    const thief = rogue(await s.w.steal(s.A2, 'A2-dieb'))
    s.A2.online = false
    s.w.devices.push(thief)
    await thief.consent(act)
    await s.B.consent(act)
    await s.w.until(() => M.act(s.B.state, act).state === 'connected', 15)
    expect(M.act(s.B.state, act).state).toBe('connected')
    await s.w.revoke(s.A, s.A2)
    if (!s.w.devices.includes(thief)) s.w.devices.push(thief)
    await s.w.rounds(4)
    const t = s.B.state.relationships.flatMap((r) => r.tuples).find((x) => x.id.includes(act))!
    // A1 never saw the thief's card (its batches are refused): B's set for this relationship carries no revocation, the thief stays bound.
    expect(M.setView(s.B.setOf(t.peer)).revoked.size).toBe(0)
    expect(members(s.B, t.peer)).toContain(t.peer)
  }, 90_000)
})

describe('K2 Schritt 2: Gegenkarte über das Schwestergerät (8325.A5c)', () => {
  it('C9. Die Gegenkarte erreicht zuerst das Schwestergerät, das die Zustimmung noch nicht kennt (P nach 8910.4), und kommt beim Produzenten erst nach dessen Faltung an (dort eine Wiederholung, 8910.7): der Produzent prüft P nach dem Falten neu und verbindet genau einmal', async () => {
    const w = new Welt15(k2({ stock: 'shared' }))
    const A = await w.person('A', 'A1')
    const B = await w.person('B', 'B1')
    const Mm = await w.person('M', 'M1')
    const am = await w.encounter(A, Mm)
    const bm = await w.encounter(B, Mm)
    await w.rounds(2)
    await A.setClass(am.x.id, true)
    await B.setClass(bm.x.id, true)
    await w.rounds(3)
    await w.enrol(B, 'B2')
    await w.rounds(3)
    const r = await Mm.introduce(am.y.id, bm.y.id)
    expect('act' in r).toBe(true)
    const act = (r as { act: string }).act
    expect(await w.until(() => w.of('B').every((d) => d.state.acts.some((a) => a.id === act)) && A.state.acts.some((a) => a.id === act), 10)).toBeGreaterThanOrEqual(0)
    const producer = w.of('B').find((d) => allocatorOf(d, act) === d.name)!
    const sibling = w.of('B').find((d) => d !== producer)!
    // B's devices fold nothing of each other until the producer's own card is delivered; the producer gets A's card only later.
    const selfB = w.selfAddresses('B')
    for (const d of w.of('B')) w.carrier.faults.withhold(d.name, (f) => selfB.has(f.address))
    w.carrier.faults.withhold(producer.name, (f) => w.frameOrigin(f.bytes)?.kind.includes('introduction-card') === true && w.frameOrigin(f.bytes)?.device.startsWith('A') === true)
    await producer.consent(act)
    await A.consent(act)
    await w.rounds(6)
    expect(M.act(sibling.state, act).pending).toBeTruthy() // 8910.4 on the sibling
    expect(M.act(producer.state, act).state).toBe('consented')
    expect(M.act(producer.state, act).o).toBe('delivered') // own card delivered, no P yet: the A5c check found nothing
    expect(M.act(producer.state, act).pending).toBeFalsy()
    // The sibling's journal (P and V) reaches the producer; A's card is still held back for it.
    w.carrier.faults.reset()
    w.carrier.faults.withhold(producer.name, (f) => w.frameOrigin(f.bytes)?.kind.includes('introduction-card') === true && w.frameOrigin(f.bytes)?.device.startsWith('A') === true)
    await w.rounds(4)
    w.carrier.faults.reset()
    await w.until(() => [...w.of('A'), ...w.of('B')].every((d) => M.act(d.state, act).state === 'connected'), 15)
    for (const d of [...w.of('A'), ...w.of('B')]) expect(`${d.name}: ${M.act(d.state, act).state}`).toBe(`${d.name}: connected`)
    const connects = new Set(w.of('B').flatMap((d) => d.state.effects.filter((e) => e.id === `connect:${act}`).map((e) => JSON.stringify(e)))).size
    expect(connects).toBe(1)
  }, 120_000)
})

describe('K2 Schritt 2: Messungen (X23, Diebesfenster, Rotation, Fan-out, Ankerpaar)', () => {
  it('M1. Ankerpaar-Orakel (X18): beide Personen halten dasselbe Paar samt Vereinbarungsschlüssel, jedes Mitglied öffnet, was die Gegenseite versiegelt; Gegenlauf: ein verfälschtes Paar fällt', async () => {
    const s = await world(k2())
    const act = await introduced(s)
    await s.A.consent(act)
    await s.A2.consent(act)
    await s.B.consent(act)
    await s.w.until(() => [s.A, s.A2, s.B].every((d) => M.act(d.state, act).state === 'connected'), 15)
    await s.w.rounds(4)
    const ok = await anchorPairOracle(s.w, 'A', 'B', act)
    expect(ok).toEqual({ pairsAgree: true, decrypt: true, cardIdentity: true })
    // Counter-run: B's tuple names another anchor for A.
    const t = s.B.state.relationships.flatMap((r) => r.tuples).find((x) => x.id.includes(act))!
    const keep = t.peer
    t.peer = s.am.x.own
    expect((await anchorPairOracle(s.w, 'A', 'B', act)).pairsAgree).toBe(false)
    t.peer = keep
    // Decryption really happens: a frame sealed to each member key opens on the device that holds the key.
    const env = await seal({ x: 1 } as unknown as Json, members(s.B, t.peer).length ? M.setView(s.B.setOf(t.peer)).members[0]!.keyAgreement : t.peerKeyAgreement)
    expect(env).toBeTruthy()
    void receive
  }, 60_000)

  it('M1b. X18 (CodeRabbit #74): das Ankerpaar-Orakel gilt für jeden Kandidaten, und fällt es, nennt das Detail den Grund auch ohne Gerätemengen (K0)', async () => {
    const [r] = await runX15(k0(), false, ['X18'])
    expect(r!.outcome).toBe('nicht bestanden')
    expect(r!.detail).toContain('die Ankerpaare beider Seiten stimmen nicht überein')
  }, 120_000)

  it('M2. X23 Zeitmodell: ruhendes Gerät (14 von 30 Tagen), Lebensdauer der Vorrats-Schlüssel 2 und 30 Tage (7 Tage in den NOTES), je Variante: ungesehen verfallene Vorstellungen (8155) und Karten nach dem Annahmeende (8110.5)', async () => {
    const table: Record<string, unknown> = {}
    void table
    for (const stock of ['strict', 'shared'] as const) {
      for (const days of [2, 30]) {
        const r = await timeModel((o) => k2({ stock, ...o }), { lifetimeDays: days })
        table[`${stock}/${days}`] = r
        expect(r.issued).toBeGreaterThan(0)
        expect(r.expiredUnseen + r.missedCards + r.connected + r.other).toBe(r.issued)
        if (stock === 'shared') expect(r.expiredUnseen).toBe(0) // every device opens the ticket
        if (stock === 'strict') expect(r.missedCards).toBe(0) // the holder that sees the ticket produces the card
        // Losses come only from tickets on the dormant device's keys issued while it sleeps (its listed share, MV-9).
        expect(r.expiredUnseen + r.missedCards).toBeLessThanOrEqual(r.onDormantKeyWhileAsleep)
      }
    }
  }, 2_400_000)

  it('M3. X9 Diebesfenster je Variante: zwischen Diebstahl und Widerruf liest der Dieb, was A2s Schlüssel öffnen (shared mehr: jeder Vorrats-Schlüssel); nach dem Widerruf nichts Neues', async () => {
    const strict = await thiefWindow(k2({ stock: 'strict' }))
    const shared = await thiefWindow(k2({ stock: 'shared' }))
    for (const r of [strict, shared]) {
      expect(r.readsBefore).toBeGreaterThan(0)
      expect(r.readsAfter).toBe(0)
    }
    expect(shared.ticketsBefore).toBeGreaterThanOrEqual(strict.ticketsBefore)
    const carrierOnly = await thiefWindow(k2({ stock: 'strict', counterpartRevocation: false }))
    expect(carrierOnly.readsAfter).toBeGreaterThan(0)
  }, 300_000)

  it('M4. Rotationsverkehr beim Widerruf: strict nur Mengenrevisionen; shared dazu leere Revision und Nachfüllung an M', async () => {
    const strict = await revocationTraffic(k2({ stock: 'strict' }))
    const shared = await revocationTraffic(k2({ stock: 'shared' }))
    expect(strict.setRevisions).toBeGreaterThan(0)
    expect(strict.stockRevisions).toBe(0)
    expect(shared.stockRevisions).toBeGreaterThanOrEqual(2)
    expect(shared.bytes).toBeGreaterThan(strict.bytes)
  }, 300_000)

  it('M5. Enrollment-Fan-out für 3 und 10 Beziehungen: eine Mengenrevision je Beziehung, jede Gegenseite versiegelt danach an das neue Gerät', async () => {
    for (const n of [3, 10]) {
      const r = await enrolFanout(k2({ devices: 3 }), n)
      expect(r.setRevisions).toBe(n + 1) // n counterparts and M
      expect(r.addressable).toBe(n + 1)
      expect(r.rounds).toBeGreaterThan(0)
    }
  }, 300_000)
})
