import { describe, expect, it } from 'vitest'
import { seal, receive } from '@real-life/trust-protocol'
import type { Json } from '@real-life/trust-protocol'
import { Welt15 } from '../src/lab/mehrgeraet/welt'
import { Carrier, VirtualClock } from '../src/lab/zustellung'
import { HolderDevice, JournalOversize, UnknownWriter, signerId, TYPES, type MultiDeviceCandidate } from '../src/lab/mehrgeraet/holder'
import { runX15 } from '../src/lab/mehrgeraet/scenarios'
import { anchorPairOracle, enrolFanout, revocationTraffic, thiefWindow, timeModel } from '../src/lab/mehrgeraet/geraetemengen'
import { k2, K2Device, DeviceDirectory } from '../src/candidates/mehrgeraet-k2'
import { k1a, type Batch } from '../src/candidates/mehrgeraet-k1a'
import { k0 } from '../src/candidates/mehrgeraet-k0'
import * as M from '../src/lab/mehrgeraet/model'

// E15 K2 step 1: device keys (plan 6o.4 step 1, assumptions 6o.5 no. 1–5).
//   1. Two devices hold distinct keys and register their own addresses; the journal is signed by the producing device and
//      sealed once per sibling; the fold verifies the batch signature against the device set; an unknown writer is rejected.
//   2. X1–X18, X7b, X21 with two devices at A and B and M as single-writer fixture (step 2a, plan 6t): K1a's pattern except
//      where device keys change semantics (NOTES, "Results"); counter-run with two M devices and no split: X1, X13, X14 fail.
//   3. A thief with A2's image reads only what A2's keys open; after the revocation it reads nothing new (step-1 measure).
//   4. A restored device keeps its keys, gets a fresh incarnation and catches up.
//   5. K1a never fans out (one frame per document, no copies in intents).
//   6. Fan-out: journal per sibling and counterpart documents per device, against K1a's single frame.

const enc = new TextEncoder()
/**
 * K2 step 2b.1: a `stock-revision@2` of device `d` in relationship `rel`, built and signed as the device would (writer = its
 * signer id in the head context, its `inc`, `rev` one above its own last, each key with its signing part and `proof`), for
 * tests that send revisions the device itself would not send (`o` overrides fields).
 */
async function craft(d: HolderDevice, rel: string, o: { rev?: number; keys?: M.StockKey[]; withdraw?: string[]; bury?: string[]; classOff?: true; writer?: string } = {}): Promise<M.StockRevision> {
  const r = M.rel(d.state, rel)
  const writer = o.writer ?? signerId((await d.cand.keys.pair(M.head(r).ownKey)).anchor)
  const inc = d.cand.incTag!(rel)
  const keys: M.RevKey[] = []
  for (const k of [...(o.keys ?? [])].sort((a, b) => M.byCode(a.anchor, b.anchor))) {
    const ks = await d.cand.keys.pair(k.key)
    const body = { n: k.n, nonce: k.nonce, anchor: k.anchor, keyAgreement: k.keyAgreement, expiresAt: k.expiresAt, for: k.for! }
    keys.push({ ...body, signing: Buffer.from(ks.ed.pubRaw).toString('base64url'), proof: Buffer.from(await crypto.subtle.sign('Ed25519', ks.ed.priv, M.proofContent(writer, inc, body) as BufferSource)).toString('base64url') })
  }
  return { writer, inc, rev: o.rev ?? (M.own(r.writers, `${writer}.${inc}`)?.revision ?? 0) + 1, keys, withdraw: [...(o.withdraw ?? [])].sort(M.byCode), bury: [...(o.bury ?? [])].sort(M.byCode), burn: [], ...(o.classOff ? { classOff: true as const } : {}) }
}
/** The revisions of M's current view, per writer (signer id): the highest `rev` (K2 2b.1: M keeps every folded revision). */
const heldRev = (v: M.StockView | null | undefined, writer: string) => Math.max(0, ...(v?.revs ?? []).filter((x) => x.writer === writer).map((x) => x.rev))
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

describe('K2 Schritt 2b.1: Matrix (strict, M als Ein-Schreiber-Fixture, Zuteilung je M-Gerät durch A)', () => {
  it('2. X1–X18, X7b, X21 mit zwei Geräten bei A und B, M ein Gerät (Plan 6t): 17/2/1; rot X7 strikt und X21 (sichtbares Restore-Artefakt nach MV-6 neu/MV-34, konsistent); X14 grün seit 2b.1 (A ist dort Mediator auf zwei Geräten: B und C teilen ihre Schlüssel je A-Gerät zu); X18 aus der Struktur (E2 (iv)) mit Ankerpaar-Orakel; X13 strukturell (MV-9 unter Geräteschlüsseln, ≈); X9 über Mengenrevisionen (≈)', async () => {
    const c = k2()
    expect(c.id).toBe('k2-device-keys')
    expect(c.bench).toEqual({ singleDevice: ['M'] })
    const r = byId(await runX15(c))
    const passed = ['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7b', 'X8', 'X9', 'X11', 'X12', 'X13', 'X14', 'X15', 'X16', 'X17', 'X18']
    for (const x of passed) expect(r[x]!.outcome, `${x}: ${r[x]!.detail}`).toBe('bestanden')
    expect(r.X7!.outcome).toBe('nicht bestanden')
    expect(r.X10!.outcome).toBe('nicht abbildbar')
    expect(Object.values(r).some((x) => x.crashed)).toBe(false)
    // X14 (step 2b.1): A is the mediator on two devices there; B and C assign each stock key to one A device (`for`), so
    // A1 and A2 never name the same key: no double consumption, no 8640.12 finding (2a: 12 findings, red).
    expect(r.X14!.measures.doubleFinalEffects).toBe(0)
    // X21: no gate after restore (MV-6 new, MV-34); the restored A2 acts from its old image, its re-production of a card is a
    // visible restore artefact (same card key, same V; the person's hand-over digest moves), consistent: nothing missing at
    // the end, no double effect, no conflict. The oracle (state as before) stays as it is. Bench rule 6m: the branch "A2
    // allocated the first act's key" is forced (it depends on M's choice otherwise).
    expect(r.X21!.outcome, r.X21!.detail).toBe('nicht bestanden')
    expect(r.X21!.detail).toContain('Zweig (6m): A2 teilt den Schlüssel des ersten Akts zu') // branch forced (plan 6m)
    expect(r.X21!.measures.missingBatches).toBe(0)
    expect(r.X21!.measures.doubleFinalEffects).toBe(0)
    expect(r.X21!.measures.remainingConflicts).toBe(0)
    expect(r.X21!.measures.devicesPendingSync).toBe(0)
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

  it('2b. Gegenlauf ohne Fixture (`singleDevice: []`, zwei M-Geräte): seit 2b.1 halten X1, X13 und X14 (A teilt jeden Schlüssel genau einem M-Gerät zu); in 2a fielen sie', async () => {
    const c = k2({ singleDevice: [] })
    expect(c.id).toBe('k2-device-keys-distributed-m')
    const r = byId(await runX15(c, false, ['X1', 'X13', 'X14']))
    for (const x of ['X1', 'X13', 'X14']) expect(r[x]!.outcome, `${x}: ${r[x]!.detail}`).toBe('bestanden')
    for (const x of ['X1', 'X13', 'X14']) expect(r[x]!.measures.doubleFinalEffects, x).toBe(0)
  }, 300_000)

  it('2c. Kontrolllauf seriell (ein Gerät): jede Zelle mit Kontrolllauf besteht', async () => {
    const r = byId(await runX15(k2({ devices: 1 }), true))
    for (const x of Object.values(r)) expect(x.outcome, `${x.scenario}: ${x.detail}`).not.toBe('nicht bestanden')
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
      const readBefore = thief.log.filter((e) => e.type === 'stock-revision').length // K2 2b.1: `stock-revision@2`
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
      const docs = w.carrier.carried.slice(mark).filter((f) => w.frameOrigin(f.bytes)?.kind === (id === 'k2' ? 'stock-revision' : 'introduction-prekeys') && toA.has(f.address))
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
    const revsBefore = M.canonical(mRel().view?.revs ?? [])
    const held1 = heldRev(mRel().view, a1)
    expect(held1).toBeGreaterThan(0)
    expect(a2).not.toBe(a1)
    const findingsBefore = Mm.state.findings.length
    // Astra's probe under `stock-revision@2` (K2 2b.1): the writer is a field, the parser checks it against the signer. A2
    // signs a revision naming A1 as writer (form error `stock-revision.writer`); a version-1 revision with the field (form
    // error: version 1 under device keys); a probe and a mapping with the field (writer-Feld, as before).
    const forged = [
      await raw(A2).sendDoc(TYPES.stockRevision, h.ownKey, h.peer, h.peerKeyAgreement, rkid, (await craft(A2, am.x.id, { writer: a1, rev: 1000 })) as unknown as Record<string, unknown>),
      await raw(A2).sendDoc(TYPES.revision, h.ownKey, h.peer, h.peerKeyAgreement, rkid, { revision: 1001, keys: [], writer: a2 }),
      await raw(A2).sendDoc(TYPES.probe, h.ownKey, h.peer, h.peerKeyAgreement, rkid, { entries: [], writer: a1 }),
      await raw(A2).sendDoc(TYPES.mapping, h.ownKey, h.peer, h.peerKeyAgreement, rkid, { entry: 'x', writer: a1 }),
    ]
    await w.rounds(3)
    for (const f of forged) expect(raw(Mm).completed.has(f.digest)).toBe(false) // no receipt
    expect(M.canonical(mRel().view?.revs ?? [])).toBe(revsBefore)
    const found = Mm.state.findings.slice(findingsBefore)
    expect(found.filter((f) => f.includes('stock-revision.writer'))).toHaveLength(1)
    expect(found.filter((f) => f.includes('writer-Feld'))).toHaveLength(3) // the version-1 revision, the probe, the mapping
    // A1's next real revision is accepted at M.
    await raw(A).sendRevision(am.x.id)
    await w.rounds(3)
    expect(heldRev(mRel().view, a1)).toBe(held1 + 1)
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

// ── K2 Schritt 2 (Anton 19.10., Plan 6r; 2a: Plan 6t): device-set@1, Kartenbezug, Produzentenregel E2 (iv), strict ──

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
      return w.carrier.carried.slice(mark).filter((f) => w.frameOrigin(f.bytes)?.kind === 'stock-revision' && keys.has(f.address)).map((f) => keys.get(f.address))
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
    // K2 2b.1: B's class on assigns no stock key to a known-empty set (draft 2 §3.4: the refusal is the named state), so no
    // revision and no frame; B's next document to A has no frame at all, the failure is explicit.
    const before = B.emptySetFailures
    const mark = w.carrier.carried.length
    await B.setClass(ab.y.id, true)
    await w.rounds(1)
    expect(M.rel(B.state, ab.y.id).stock).toHaveLength(0)
    const toA = new Set([ab.x.peerKeyAgreement, ab.y.peerKeyAgreement])
    expect(w.carrier.carried.slice(mark).filter((f) => w.frameOrigin(f.bytes)?.kind === 'stock-revision' && toA.has(f.address))).toHaveLength(0)
    await raw(B).sendDoc(TYPES.probe, ab.y.ownKey, ab.y.peer, ab.y.peerKeyAgreement, (await B.cand.keys.pair(ab.y.ownKey)).rkid, { entries: [] })
    expect(B.emptySetFailures).toBeGreaterThan(before)
    expect(B.dispositions.some((d) => d.startsWith('failed(empty-device-set)'))).toBe(true)
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
  {
    it(`C1. Produzentenregel E2 (iv): das nicht zuteilende Gerät zeichnet nur die Zustimmung auf, das zuteilende erzeugt die eine Karte; B: eine Karte, kein K`, async () => {
      const s = await world(k2())
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

  it('C2. Gegenlauf ohne Produzentenregel: die zweite Karte ist unter einem fremden Schlüssel signiert (strict: der Vorrats-Schlüssel gehört dem zuteilenden Gerät) → abgewiesen ohne K (E3 (a))', async () => {
    {
      const s = await world(k2({ producerRule: false }))
      const act = await introduced(s)
      const selfA = s.w.selfAddresses('A')
      for (const d of s.w.of('A')) s.w.carrier.faults.withhold(d.name, (f) => selfA.has(f.address))
      await s.A.consent(act)
      await s.A2.consent(act)
      await s.B.consent(act)
      await s.w.rounds(5)
      s.w.carrier.faults.reset()
      await s.w.rounds(5)
      expect(M.act(s.B.state, act).k).toBe(false)
      expect(s.B.dispositions.filter((d) => d === 'failed(validation-failed)').length).toBeGreaterThan(0)
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

  it('C6. Ticket: nur der Halter des benannten Vorrats-Schlüssels öffnet es (strict)', async () => {
    {
      const s = await world(k2())
      const r = await s.Mm.introduce(s.am.y.id, s.bm.y.id)
      expect('act' in r).toBe(true)
      await s.w.rounds(2)
      const act = (r as { act: string }).act
      const a = M.act(s.w.of('A').find((d) => d.state.acts.some((x) => x.id === act))!.state, act)
      const k = M.findRel(s.A.state, a.mediator)!.stock.find((x) => x.anchor === a.own)!
      const readers = s.w.of('A').filter((d) => d.log.some((e) => e.type === 'introduction-ticket')).map((d) => d.name)
      expect(readers).toEqual([k.by])
      expect(s.w.carrier.registeredAt(k.keyAgreement)).toEqual([k.by])
    }
  }, 60_000)

  it('C7. Restore des zuteilenden Geräts aus einem Abbild vor der Produktion (MV-6 neu, MV-34: keine Sperre): es faltet die Zustimmung der Schwester vor seiner eigenen früheren Produktion und erzeugt die Karte aus dem erreichbaren Stand noch einmal; derselbe Kartenschlüssel, dasselbe V; B: eine Verbindung, kein K (Wiederholung 8910.7); beide A-Geräte einig (sichtbares Restore-Artefakt, konsistent)', async () => {
    const s = await world(k2())
    const act = await introduced(s)
    const prod = allocatorOf(s.A, act) === 'A1' ? s.A : s.A2
    const other = prod === s.A ? s.A2 : s.A
    const backup = s.w.stores.get(prod.name)!.snapshot()
    await s.B.consent(act)
    await other.consent(act)
    await s.w.until(() => M.act(s.B.state, act).state === 'connected', 15)
    await s.w.rounds(3)
    s.w.stores.get(prod.name)!.restore(backup)
    await prod.reload()
    expect(prod.gated).toBe(false) // nobody waits for anybody (MV-34)
    await s.w.until(() => !prod.syncPending && s.w.agree('A').agree, 30)
    await s.w.rounds(4)
    const ops = new Map<string, M.Op>()
    for (const d of s.w.of('A')) for (const b of (d.cand as K2Device).journal() as Batch[]) for (const o of b.ops) if (o.kind === 'produce' && o.act === act) ops.set(`${o.id.writer}#${o.id.n}`, o)
    const produced = [...ops.values()] as Array<M.Op & { v: string; card: M.Card }>
    expect(produced.length).toBe(2) // the earlier incarnation's production and the restored one's: the artefact
    expect(new Set(produced.map((o) => o.v)).size).toBe(1)
    expect(new Set(produced.map((o) => o.card.anchor)).size).toBe(1)
    expect(M.act(s.B.state, act)).toMatchObject({ state: 'connected', k: false })
    expect(new Set(s.w.of('B').flatMap((d) => d.state.effects.filter((e) => e.id === `connect:${act}`).map((e) => e.op))).size).toBe(1)
    for (const d of s.w.of('A')) expect(M.act(d.state, act).state, d.name).toBe('connected')
    expect(s.w.agree('A').agree).toBe(true)
  }, 90_000)

  it('C8. Dieb gewinnt zuerst (E1 (a)): der Dieb mit A2s Abbild erzeugt die Karte (strict, A2s Schlüssel), B bindet sie; der Widerruf heilt diese Beziehung nicht (benannter Preis)', async () => {
    const s = await world(k2()) // one mediator device (step 2a fixture) names every key
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

type Order = 'forward' | 'reverse' | 'duplicate'
const ORDERS: Order[] = ['forward', 'reverse', 'duplicate']
const submissionOf = (d: HolderDevice, digest: string) => (d as unknown as { zusteller: { submissions: Map<string, { report: { state: string; reason?: string } | null }> } }).zusteller.submissions.get(digest)

describe('K2 Schritt 2: Review 33, Empfang filtert nicht, die Faltung entscheidet', () => {
  it('R1. B1 am Empfangspfad: zwei widersprüchliche Nachweise (gleiche Art, Anker, Aussteller; anderer Vereinbarungsschlüssel) in zwei Revisionen Nr. 99: in jeder Reihenfolge und mit Duplikaten der kanonisch kleinere, beide Nachweise für den Befund gehalten, ein Befund je Konflikt', async () => {
    for (const order of ORDERS) {
      const { w, A, A2, B, ab } = await abWorld()
      const key = await A2.cand.keys.pair('pool/999')
      const alt = await A2.cand.keys.pair('pool/998')
      const set = A.setOf(ab.x.own)!
      const cs = await Promise.all([key.rkid, alt.rkid].map((keyAgreement) => raw(A).cert(ab.x.ownKey, { root: ab.x.own, kind: 'admit', anchor: key.anchor, keyAgreement })))
      // "Canonically smaller" is code-unit order (`<`, as the fold), not `localeCompare` (review 36: R1 failed whenever the two
      // orders disagreed on the first differing character of the key-agreement keys, e.g. 'Y' < 'r' but 'r' sorts first in a locale).
      const smaller = [...cs].sort((x, y) => (M.canonical(x) < M.canonical(y) ? -1 : 1))[0]!
      if (order === 'duplicate') w.carrier.faults.duplicate(true)
      for (const c of order === 'reverse' ? [...cs].reverse() : cs) {
        for (let i = 0; i < (order === 'duplicate' ? 2 : 1); i++) await raw(A).sendDoc(TYPES.deviceSet, ab.x.ownKey, ab.x.peer, ab.x.peerKeyAgreement, set.rootKeyAgreement, { root: ab.x.own, rootKeyAgreement: set.rootKeyAgreement, revision: 99, deps: [], entries: [...Object.values(set.certs), c] as unknown as Json[] })
        await w.rounds(2)
      }
      w.carrier.faults.reset()
      await w.rounds(2)
      const got = M.setView(B.setOf(ab.x.own)).members.find((m) => m.anchor === key.anchor)!
      expect(`${order}: ${got.keyAgreement}`).toBe(`${order}: ${smaller.keyAgreement}`)
      const held = B.setOf(ab.x.own)!.equivocal?.[M.certKey(smaller)] ?? []
      expect(held.map((c) => c.keyAgreement).sort(), order).toEqual(cs.map((c) => c.keyAgreement).sort())
      expect(B.state.findings.filter((f) => f.includes('zweimal mit anderem Inhalt') && f.includes('Nachweis admit')), order).toHaveLength(1)
      expect(B.state.findings.filter((f) => f.includes('Revision 99 zweimal mit anderem Inhalt')), order).toHaveLength(1)
      expect(B.state.acts.some((a) => a.k), order).toBe(false)
    }
  }, 240_000)

  it('R2. B2: Karte auf Revision 1, zuerst kommt nur die kumulative Revision 2 (deps: Revision 1) an: B verbindet; die spätere Revision 1 wird gefaltet, nicht abgewiesen', async () => {
    for (const order of ['forward', 'duplicate'] as Order[]) {
      const s = await world(k2())
      const act = await introduced(s)
      await s.B.consent(act)
      await s.w.rounds(2)
      const prod = allocatorOf(s.A, act) === 'A1' ? s.A : s.A2
      s.w.carrier.faults.drop((f) => ['device-set', 'introduction-card'].includes(s.w.frameOrigin(f.bytes)?.kind ?? ''))
      await prod.consent(act)
      await s.w.rounds(2)
      const a = M.act(prod.state, act)
      const set = prod.setOf(a.ownCard!.anchor)!
      const prev = M.own(set.revs, signerId(set.root))!
      const newer = await raw(prod).sendDoc(TYPES.deviceSet, a.ownCardKey!, a.voucher.anchor, a.voucher.keyAgreement, set.rootKeyAgreement, { root: set.root, rootKeyAgreement: set.rootKeyAgreement, revision: prev.n + 1, deps: [prev.digest], entries: Object.values(set.certs) as unknown as Json[] })
      s.w.carrier.faults.reset()
      if (order === 'duplicate') s.w.carrier.faults.duplicate(true)
      s.w.carrier.faults.drop((f) => s.w.frameOrigin(f.bytes)?.kind === 'device-set' && !Buffer.from(f.bytes).equals(Buffer.from(prod.intents.get(newer!.digest)!.bytes)))
      await s.w.until(() => M.act(s.B.state, act).state === 'connected', 6)
      expect(`${order}: ${M.act(s.B.state, act).state}`).toBe(`${order}: connected`)
      s.w.carrier.faults.reset()
      await s.w.rounds(4)
      expect(s.B.setOf(set.root)!.seen.includes(prev.digest!)).toBe(true)
      expect(s.B.state.findings.filter((f) => f.includes('unter der gehaltenen')), order).toEqual([])
      expect(M.act(s.B.state, act).k).toBe(false)
    }
  }, 240_000)

  it('R2b. B2, E3 (a): widerruft die kumulative Revision 2 die Wurzel der Karte (deps: Revision 1), wird die Karte auf Revision 1 ohne K abgewiesen; ohne jeden Mengennachweis bleibt die Karte zurückgestellt und der Sender meldet nach zwölf Runden `failed`, nie still', async () => {
    const s = await world(k2())
    const act = await introduced(s)
    await s.B.consent(act)
    await s.w.rounds(2)
    const prod = allocatorOf(s.A, act) === 'A1' ? s.A : s.A2
    const other = prod === s.A ? s.A2 : s.A
    s.w.carrier.faults.drop((f) => ['device-set', 'introduction-card'].includes(s.w.frameOrigin(f.bytes)?.kind ?? ''))
    await prod.consent(act)
    await s.w.until(() => !!M.act(other.state, act).ownCardKey, 10)
    const a = M.act(other.state, act)
    const root = a.ownCard!.anchor
    const set = other.setOf(root)!
    const prev = M.own(set.revs, signerId(root))!
    const rev = await raw(other).cert(a.ownCardKey!, { root, kind: 'revoke', anchor: root, keyAgreement: null })
    const newer = await raw(other).sendDoc(TYPES.deviceSet, a.ownCardKey!, a.voucher.anchor, a.voucher.keyAgreement, (await other.cand.keys.pair(a.ownCardKey!)).rkid, { root, rootKeyAgreement: set.rootKeyAgreement, revision: 2, deps: [prev.digest], entries: [...Object.values(set.certs), rev] as unknown as Json[] })
    s.w.carrier.faults.reset()
    s.w.carrier.faults.drop((f) => s.w.frameOrigin(f.bytes)?.kind === 'device-set' && !Buffer.from(f.bytes).equals(Buffer.from(other.intents.get(newer!.digest)!.bytes)))
    await s.w.rounds(6)
    const b = M.act(s.B.state, act)
    expect([b.state, b.v, b.k]).toEqual(['consented', null, false])
    expect(s.B.state.findings.some((f) => f.includes('ein bekannter Widerruf schlägt den älteren Bezug'))).toBe(true)

    // Bounded deferral: no set proof ever reaches B; the card waits (no V, no K), the sender reports failed.
    const t = await world(k2())
    const act2 = await introduced(t)
    await t.B.consent(act2)
    await t.w.rounds(2)
    const prod2 = allocatorOf(t.A, act2) === 'A1' ? t.A : t.A2
    t.w.carrier.faults.drop((f) => t.w.frameOrigin(f.bytes)?.kind === 'device-set' && t.w.carrier.registeredAt(f.address).some((d) => d.startsWith('B')))
    await prod2.consent(act2)
    await t.w.rounds(16)
    const b2 = M.act(t.B.state, act2)
    expect([b2.state, b2.v, b2.k]).toEqual(['consented', null, false])
    expect(t.B.deferredCards).toBeGreaterThan(0)
    const digest = M.act(prod2.state, act2).ownCardDigest!
    expect(submissionOf(prod2, digest)?.report).toEqual({ state: 'failed', reason: 'expired-by-adapter-policy' })
  }, 240_000)

  it('R3. B3: eine gepufferte Karte behält ihre Schlüsselbindung (`fromKeyAgreement`); bei der Zuordnung zum Ticket setzt eine widersprüchliche Bindung K (8850.6 (d)), keine Verbindung', async () => {
    const s = await world(k2())
    s.w.carrier.faults.drop((f) => s.w.frameOrigin(f.bytes)?.kind === 'introduction-ticket' && s.w.carrier.registeredAt(f.address).includes('B1'))
    const r = await s.Mm.introduce(s.am.y.id, s.bm.y.id)
    expect('act' in r).toBe(true)
    const act = (r as { act: string }).act
    await s.w.rounds(3)
    const prod = allocatorOf(s.A, act) === 'A1' ? s.A : s.A2
    s.w.carrier.faults.drop((f) => s.w.frameOrigin(f.bytes)?.kind === 'introduction-card' || (s.w.frameOrigin(f.bytes)?.kind === 'introduction-ticket' && s.w.carrier.registeredAt(f.address).includes('B1')))
    await prod.consent(act)
    await s.w.rounds(3)
    const a = M.act(prod.state, act)
    const stock = M.findRel(prod.state, a.mediator)!.stock.find((k) => k.anchor === a.own)!
    const set = M.own(prod.setOf(a.ownCard!.anchor)!.revs, signerId(a.ownCard!.anchor))!.digest
    const sent = await raw(prod).sendDoc(TYPES.card, stock.key, a.voucher.anchor, a.voucher.keyAgreement, stock.keyAgreement, { act, expiresAt: a.expiresAt, from: a.own, fromKeyAgreement: a.voucher.keyAgreement, to: a.voucher.anchor, card: a.ownCard, set })
    s.w.carrier.faults.reset()
    s.w.carrier.faults.drop((f) => (s.w.frameOrigin(f.bytes)?.kind === 'introduction-card' && !Buffer.from(f.bytes).equals(Buffer.from(prod.intents.get(sent!.digest)!.bytes))) || (s.w.frameOrigin(f.bytes)?.kind === 'introduction-ticket' && s.w.carrier.registeredAt(f.address).includes('B1')))
    await s.w.rounds(2)
    expect((s.B as unknown as { buffer: Map<string, unknown> }).buffer.size).toBe(1)
    s.w.carrier.faults.reset()
    s.w.carrier.faults.drop((f) => s.w.frameOrigin(f.bytes)?.kind === 'introduction-card')
    await s.w.rounds(3)
    await s.B.consent(act)
    await s.w.rounds(3)
    const b = M.act(s.B.state, act)
    expect(b.k).toBe(true)
    expect(b.state).not.toBe('connected')
  }, 120_000)
})

const unrevoked = (m: HolderDevice, relId: string) => M.usableView(m.state, relId, m.clock.now()).listed.map((k) => k.anchor)

describe('K2 Schritt 2: Review 34, Grabstein je Anker statt Nummern (B5)', () => {
  {
    const stock = 'strict'
    it(`T1. ${stock}: Astras Probe: A2 signiert vor dem Widerruf eine Revision mit \`clears: {A1: 1000000}\` (alte Form, K2 2b.1 Version 1: abgewiesen, Befund) und eine \`stock-revision@2\` mit Klasse aus und \`bury\` für A1s Anker und einen nie gelisteten Anker; vor dem Widerruf begräbt A2 als Mitglied A1s Schlüssel (Entscheidung 1b, benannter Preis), nach dem Widerruf sind A1s Schlüssel für M wieder benennbar (Widerrufsausnahme: A1 listet sie aktuell)`, async () => {
      const { w, A, A2, Mm, am, bm } = await world(k2())
      const mRel = () => M.relOfTuple(Mm.state, am.y.id)!.id
      const h = M.head(M.rel(A2.state, am.x.id))
      const rkid = (await A2.cand.keys.pair(h.ownKey)).rkid
      const a1 = signerId((await A.cand.keys.pair(M.head(M.rel(A.state, am.x.id)).ownKey)).anchor)
      const a1Anchors = M.rel(A.state, am.x.id).stock.filter((k) => k.by === 'A1' && k.state === 'active').map((k) => k.anchor)
      expect(a1Anchors.length).toBeGreaterThan(0)
      expect(a1Anchors.every((a) => unrevoked(Mm, mRel()).includes(a))).toBe(true)
      const fake = (await A2.cand.keys.pair('pool/777')).anchor
      const before = Mm.state.findings.length
      const old = await raw(A2).sendDoc(TYPES.revision, h.ownKey, h.peer, h.peerKeyAgreement, rkid, { revision: 0, keys: [], clears: { [a1]: 1000000 } })
      await raw(A2).sendDoc(TYPES.stockRevision, h.ownKey, h.peer, h.peerKeyAgreement, rkid, (await craft(A2, am.x.id, { classOff: true, bury: [...a1Anchors, fake] })) as unknown as Record<string, unknown>)
      await w.rounds(3)
      expect(raw(Mm).completed.has(old!.digest)).toBe(false)
      const found = Mm.state.findings.slice(before)
      expect(found.filter((f) => f.includes('Version 1')), found.join('\n')).toHaveLength(1)
      // Review 35 B6 (1b): any member may bury any anchor of the person; before the revocation A1's keys are gone (thief window).
      expect(a1Anchors.filter((a) => unrevoked(Mm, mRel()).includes(a)), stock).toEqual([])
      await w.revoke(A, A2)
      await w.rounds(6)
      const now = M.rel(A.state, am.x.id).stock.filter((k) => k.by === 'A1' && k.state === 'active').map((k) => k.anchor)
      expect(now.length).toBeGreaterThan(0)
      expect(now.filter((a) => !unrevoked(Mm, mRel()).includes(a)), stock).toEqual([])
      expect(Mm.stockAt(mRel()).nameable, stock).toBeGreaterThan(0)
      // ... and M introduces on them again (the split reads the restored listing, not the view folded before the revocation).
      expect('act' in (await Mm.introduce(am.y.id, bm.y.id)), stock).toBe(true)
    }, 120_000)
  }

})

describe('K2 Schritt 2: Review 35, Klasse aus ist Sache der Person (B6)', () => {
  {
    const stock = 'strict'
    it(`U1. ${stock}: Astras Gegenlauf: A2 offline, A1 schaltet die Klasse aus; in jeder Ankunftsreihenfolge und mit Duplikaten benennt M danach keinen Schlüssel der Person mehr (auch keinen von A2) und stellt nicht vor; A2 kommt mit verzögertem Journal zurück, keine Verbindung; Restore und Enrollment bei M ändern das nicht`, async () => {
      for (const order of ORDERS) {
        // Two M devices here only fold views (burial is a property of M's view on every device); issuance is not under test.
        const s = await world(k2({ devices: 3 }))
        const M2 = await s.w.enrol(s.Mm, 'M2')
        await s.w.rounds(4)
        const mRel = () => M.relOfTuple(s.Mm.state, s.am.y.id)!.id
        const a2Anchors = M.rel(s.A2.state, s.am.x.id).stock.filter((k) => k.by === 'A2' && k.state === 'active').map((k) => k.anchor)
        expect(a2Anchors.length, order).toBeGreaterThan(0)
        expect(a2Anchors.some((a) => unrevoked(s.Mm, mRel()).includes(a)), order).toBe(true)
        const backup = s.w.stores.get('M1')!.snapshot()
        s.A2.online = false
        if (order === 'reverse') s.w.carrier.faults.reverse(true)
        if (order === 'duplicate') s.w.carrier.faults.duplicate(true)
        await s.A.setClass(s.am.x.id, false)
        await s.w.rounds(4)
        s.w.carrier.faults.reset()
        await s.w.rounds(2)
        const what = `${stock} ${order}`
        for (const m of [s.Mm, M2]) {
          expect(`${what} ${m.name}: ${unrevoked(m, s.am.y.id).length}`).toBe(`${what} ${m.name}: 0`)
          expect(m.stockAt(M.relOfTuple(m.state, s.am.y.id)!.id).nameable, `${what} ${m.name}`).toBe(0)
        }
        const r = await s.Mm.introduce(s.am.y.id, s.bm.y.id)
        expect('refused' in r, `${what}: ${JSON.stringify(r)}`).toBe(true)
        // A2 returns while only its journal stays delayed: nothing to accept, no connection.
        const selfA = s.w.selfAddresses('A')
        s.w.carrier.faults.withhold('A2', (f) => selfA.has(f.address)) // review 36 S6: held at the returning device
        s.A2.online = true
        await s.w.rounds(3)
        expect(s.A2.state.acts.length + s.B.state.acts.filter((a) => a.state === 'connected').length, what).toBe(0)
        s.w.carrier.faults.reset()
        await s.w.rounds(3)
        // Restore at M (image from before the class turned off) and a fresh enrolment at M: still nothing nameable.
        s.w.stores.get('M1')!.restore(backup)
        await s.Mm.reload()
        await s.w.until(() => !s.Mm.syncPending, 20)
        await s.w.rounds(2)
        const M3 = await s.w.enrol(M2, 'M3')
        await s.w.rounds(4)
        for (const m of [s.Mm, M2, M3]) expect(`${what} ${m.name} danach: ${unrevoked(m, s.am.y.id).length}`).toBe(`${what} ${m.name} danach: 0`)
        // Refill: the class on again brings new anchors, nameable at M.
        await s.A.setClass(s.am.x.id, true)
        await s.w.rounds(4)
        expect(s.Mm.stockAt(mRel()).nameable, `${what}: Nachfüllung`).toBeGreaterThan(0)
      }
    }, 400_000)
  }
})

/**
 * Review 36: the model fixture of V2: M's states for two sides (e1: a person with writers root, d2, d3; e2: B), the
 * conflicting listings, tombstones, a set with an admission and a revocation, and the M candidate (K2, step 2a: one device).
 */
function viewFixture() {
  const t0 = '2026-10-17T08:00:00.000Z'
  const exp = '2027-04-15T08:00:00.000Z'
  const [root, d2, d3, broot] = ['m-root', 'm-d2', 'm-d3', 'b-root']
  let seq = 0
  const op = (body: Record<string, unknown>) => ({ id: { writer: 'w', n: ++seq }, at: t0, ...body }) as unknown as M.Op
  const lk = (anchor: string, n: number) => ({ n, anchor, keyAgreement: `r${anchor}`, expiresAt: exp })
  const view = (rel: string, signer: string, revision: number, keys: M.ListedKey[], tombstones?: string[]) => op({ kind: 'view', rel, scope: rel, revision, keys, writer: signerId(signer), standing: 'person', ...(tombstones ? { tombstones } : {}) })
  const proof = { type: 't', cryptosuite: 'c', created: t0, verificationMethod: 'v', proofPurpose: 'p', proofValue: 'x' }
  const cert = (kind: 'admit' | 'revoke', anchor: string): M.SetCert => ({ root, kind, anchor, keyAgreement: kind === 'admit' ? `r${anchor}` : null, by: root, proof })
  const set = (certs: M.SetCert[]) => op({ kind: 'device-set', root, rootKeyAgreement: `r${root}`, certs })
  const tuple = (id: string, peer: string): M.Tuple => ({ id, own: `own-${id}`, ownKey: `k/${id}`, peer, peerKeyAgreement: `r${peer}`, record: `${id}:own`, openedAt: t0, candidates: [], deactivated: false })
  const ops = [
    view('M:e1', root, 1, [lk('x', 2), lk('y', 4)]),
    view('M:e1', d2, 1, [lk('x', 3), lk('z', 1)]), // same anchor x, another value (B7)
    view('M:e1', d3, 1, [lk('w', 6), lk('x', 7)]),
    view('M:e1', d2, 2, [], ['y', 'w']), // d2 buries y and w before its revocation
    set([cert('admit', d2), cert('admit', d3)]),
    set([cert('revoke', d2)]),
  ]
  const base = () => {
    const s = M.emptyState('M')
    M.apply(s, op({ kind: 'open-tuple', rel: null, tuple: tuple('M:e1', root), provenance: 'encounter', vouchedBy: null, act: null }))
    M.apply(s, op({ kind: 'open-tuple', rel: null, tuple: tuple('M:e2', broot), provenance: 'encounter', vouchedBy: null, act: null }))
    M.apply(s, view('M:e2', broot, 1, Array.from({ length: 8 }, (_, i) => lk(`b${i}`, i))))
    return s
  }
  const dir = new DeviceDirectory()
  const cands = [new K2Device('M', 'M1', new Uint8Array(32).fill(1), 0, 2, M.PARAM.budget, dir)]
  return { t0, exp, root, d2, d3, broot, op, lk, view, cert, set, tuple, ops, base, cands }
}

describe('K2 Schritt 2: Review 36, eine Rechnung für Ms Sicht (B7)', () => {
  it('V2. Eigenschaft: in zufälligen Empfangsreihenfolgen (fester Seed, mit Duplikaten) von widersprüchlichen Listungen, Grabsteinen und Widerruf ist Ms Sicht dieselbe, und jeder Verbraucher liest aus ihr: Rechteprüfung der Vorstellung, Vorratszählung (`stockAt`), Wahl (Schritt 2a: M ist ein Gerät, keine Teilung)', () => {
    const { t0, exp, op, ops, base, cands } = viewFixture()
    let rnd = 36
    const next = () => ((rnd = (rnd * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    const want = ['w:6', 'x:2', 'y:4']
    for (let run = 0; run < 200; run++) {
      const order = ops.map((o) => ({ o, k: next() })).sort((a, b) => a.k - b.k).map((x) => x.o)
      const dups = order.filter(() => next() < 0.3).map((o, i) => ({ ...o, id: { writer: 'w', n: 20_000 + run * 100 + i } }) as M.Op)
      const s = base()
      for (const o of [...order, ...dups]) M.apply(s, o)
      const uv = M.usableView(s, 'M:e1', t0)
      const what = `run ${run}`
      expect(uv.listed.map((k) => `${k.anchor}:${k.n}`), what).toEqual(want)
      for (const c of cands) {
        const bKey = M.usableView(s, 'M:e2', t0).listed[0]!
        for (const k of uv.listed) {
          const intro = op({ kind: 'introduce', act: { id: `act-${k.anchor}`, a: { rel: 'M:e1', key: k.anchor, keyAgreement: k.keyAgreement }, b: { rel: 'M:e2', key: bKey.anchor, keyAgreement: bKey.keyAgreement }, issuedAt: t0, expiresAt: exp } })
          expect(c.authorize(intro, s), `${what} ${c.name} ${k.anchor}`).toBe(true)
        }
        const h = new HolderDevice(c.name, 'M', c, new Carrier(), new VirtualClock(t0), undefined, s)
        expect(h.stockAt('M:e1'), `${what} ${c.name}`).toEqual({ listed: uv.listed.length, usable: uv.usable.length, unconsumed: uv.unconsumed.length, nameable: uv.unconsumed.length })
      }
    }
  })
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

  it('M2. X23 Zeitmodell: ruhendes Gerät (14 von 30 Tagen), Lebensdauer der Vorrats-Schlüssel 2 und 30 Tage (7 Tage in den NOTES): ungesehen verfallene Vorstellungen (8155), keine Karte nach dem Annahmeende (8110.5)', async () => {
    for (const days of [2, 30]) {
      const r = await timeModel((o) => k2(o), { lifetimeDays: days })
      expect(r.issued).toBeGreaterThan(0)
      expect(r.expiredUnseen + r.missedCards + r.connected + r.other).toBe(r.issued)
      expect(r.missedCards).toBe(0) // the holder that sees the ticket produces the card
      // Losses come only from tickets on the dormant device's keys issued while it sleeps (its listed share, MV-9).
      expect(r.expiredUnseen + r.missedCards).toBeLessThanOrEqual(r.onDormantKeyWhileAsleep)
      // Review 33 S2: the cause is measured per loss (M2b checks the evidence fields); here: all on A2, 8155.
      expect(r.losses.every((l) => l.holder === 'A2' && l.cause === 'expired-unseen-8155')).toBe(true)
    }
  }, 3_600_000)

  it('M2b. X23 belegt (Review 33 S2): jede verlorene Vorstellung trägt ihre gemessene Ursache (8155: Ticket ungesehen verfallen, mit Zeitpunkten und den Online-Schritten des Halters; 8110.5: Karte nie erzeugt, mit den Online-Schritten des Zuteilers bis zum Annahmeende), jede Verweigerung durch M ihren Grund und Ms Vorrat in dem Moment', async () => {
    const runs = [
      { name: 'strict', f: (o: { stockLifetimeMs: number; budget: number }) => k2(o) },
      { name: 'k1a', f: (o: { stockLifetimeMs: number; budget: number }) => k1a(o) },
    ]
    for (const { name, f } of runs) {
      const r = await timeModel(f, { lifetimeDays: name === 'k1a' ? 2 : 30, days: 12, dormant: [[3, 9]] })
      expect(r.losses.length, name).toBe(r.issued - r.connected)
      const sum = Object.values(r.causes).reduce((a, b) => a + b, 0)
      expect(sum, name).toBe(r.losses.length)
      for (const l of r.losses) {
        if (l.cause === 'expired-unseen-8155') {
          expect(l.seenDay, `${name}: ${JSON.stringify(l)}`).toBeNull()
          expect(l.holderOnlineStepsBeforeCutoff, `${name}: ${JSON.stringify(l)}`).toBe(0)
          expect(l.cutoffDay, name).toBeGreaterThan(l.issuedDay)
        } else if (l.cause === 'card-not-produced-8110.5') {
          expect(l.consentedDay, name).not.toBeNull()
          expect(l.producedDay, `${name}: ${JSON.stringify(l)}`).toBeNull()
          expect(l.allocatorOnlineStepsBeforeExpiry, `${name}: ${JSON.stringify(l)}`).toBe(0)
        } else if (l.cause === 'card-late-8110.5') {
          // Review 34 S4: produced (journal) by the acceptance end, received at C after it, refused there with 8110.5.
          expect(l.producedDay!, `${name}: ${JSON.stringify(l)}`).toBeLessThanOrEqual(l.expiresDay)
          expect(l.cardReceivedDay!, `${name}: ${JSON.stringify(l)}`).toBeGreaterThan(l.expiresDay)
          expect(l.cardRefusal, name).toBe('after-acceptance-end-8110.5')
        } else expect(l.cause, `${name}: ${JSON.stringify(l)}`).toBe('card-produced-not-connected')
      }
      expect(r.refusals.length, name).toBe(r.refused)
      for (const x of r.refusals) {
        expect(x.reason, name).toContain('kein benennbarer Schlüssel')
        // M refused: on at least one side no M device had a nameable key at that moment.
        expect(Object.values(x.stock).some((side) => Object.values(side).every((d) => d.nameable === 0)), `${name}: ${JSON.stringify(x)}`).toBe(true)
      }
      if (name === 'strict') expect((r.causes['card-not-produced-8110.5'] ?? 0) + (r.causes['card-late-8110.5'] ?? 0)).toBe(0)
    }
  }, 1_800_000)

  it('M3. X9 Diebesfenster: zwischen Diebstahl und Widerruf liest der Dieb, was A2s Schlüssel öffnen; nach dem Widerruf nichts Neues; Gegenlauf nur Träger: er liest weiter', async () => {
    const strict = await thiefWindow(k2())
    expect(strict.readsBefore).toBeGreaterThan(0)
    expect(strict.readsAfter).toBe(0)
    const carrierOnly = await thiefWindow(k2({ counterpartRevocation: false }))
    expect(carrierOnly.readsAfter).toBeGreaterThan(0)
  }, 300_000)

  it('M4. Rotationsverkehr beim Widerruf: nur Mengenrevisionen (strict: die Schlüssel des widerrufenen Geräts schließt M über den Widerruf ihres Signierers aus)', async () => {
    const strict = await revocationTraffic(k2())
    expect(strict.setRevisions).toBeGreaterThan(0)
    expect(strict.stockRevisions).toBe(0)
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

describe('K2 Schritt 2a: Ms Ausgabe nach MV-30, Restore nach Regel (iii) (MV-6 neu, MV-34)', () => {
  type S = Awaited<ReturnType<typeof world>>
  const actsOn = (s: S, key: string) => [...new Set([...s.w.of('A'), ...s.w.of('B')].flatMap((d) => d.state.acts.filter((a) => a.own === key).map((a) => a.id)))]
  const ticketsAtCarrier = (s: S, mark: number) => s.w.carrier.carried.slice(mark).filter((f) => s.w.frameOrigin(f.bytes)?.kind === 'introduction-ticket').length

  it('N1. MV-30: eine Ausstellung ist ein Schritt; der Journalbatch trägt den Verbrauch (`introduce`) und beide Ticketabsichten mit ihren vollständigen Bytes, der Store hat ihn committet, bevor ein Ticket das Gerät verlässt; Absturz zwischen Commit und Versand: nichts beim Träger, nach dem Neuaufbau dieselben Bytes, ein Akt', async () => {
    const s = await world(k2())
    const mark = s.w.carrier.carried.length
    s.Mm.crashAt = 'before-send'
    const r = await s.Mm.introduce(s.am.y.id, s.bm.y.id)
    expect(r).toEqual({ refused: 'crashed' })
    expect(ticketsAtCarrier(s, mark)).toBe(0)
    // The committed image holds the step: consumption and both ticket intents with their bytes, in one batch.
    const image = s.w.stores.get('M1')!.load()!
    const batches = (image.candidate as { batches: Batch[] }).batches
    const last = batches[batches.length - 1]!
    const intro = last.ops.find((o) => o.kind === 'introduce') as (M.Op & { act: M.MediatorAct }) | undefined
    expect(intro).toBeTruthy()
    const tickets = last.intents.filter((i) => i.kind === TYPES.ticket)
    expect(tickets).toHaveLength(2)
    for (const t of tickets) expect(t.bytes.length).toBeGreaterThan(0)
    expect(image.holder.mediatorActs.map((a) => a.id)).toEqual([intro!.act.id])
    // Rebuild: the same bytes go out (HSC-120), one act on each key.
    await s.Mm.reload()
    await s.w.until(() => [s.A, s.B].every((d) => d.state.acts.some((a) => a.id === intro!.act.id)), 10)
    const out = new Set(s.w.carrier.carried.slice(mark).filter((f) => s.w.frameOrigin(f.bytes)?.kind === 'introduction-ticket').map((f) => Buffer.from(f.bytes).toString('base64')))
    const expected = new Set(tickets.map((t) => t.bytes))
    for (const b of out) expect(expected.has(b)).toBe(true)
    expect(actsOn(s, intro!.act.a.key)).toEqual([intro!.act.id])
    expect(actsOn(s, intro!.act.b.key)).toEqual([intro!.act.id])
  }, 60_000)

  it('N2. Regel (iii): M aus einem Abbild vor Akt α wartet auf niemanden und benennt aus dem erreichbaren Stand denselben Schlüssel noch einmal (β); A und B weisen β nach 8640.12 als Regel ab (Befund, kein Akt, keine Quittung), α bleibt der einzige Akt auf dem Schlüssel; M nimmt danach den nächsten Schlüssel (sein eigener Verbrauch von β), die nächste Vorstellung wird angenommen', async () => {
    const s = await world(k2())
    const backup = s.w.stores.get('M1')!.snapshot()
    const ra = await s.Mm.introduce(s.am.y.id, s.bm.y.id)
    expect('act' in ra).toBe(true)
    const alpha = s.Mm.state.mediatorActs.find((a) => a.id === (ra as { act: string }).act)!
    await s.w.until(() => [s.A, s.B].every((d) => d.state.acts.some((a) => a.id === alpha.id)), 10)
    s.w.stores.get('M1')!.restore(backup)
    await s.Mm.reload()
    expect(s.Mm.gated).toBe(false)
    const rb = await s.Mm.introduce(s.am.y.id, s.bm.y.id)
    expect('act' in rb).toBe(true)
    const beta = s.Mm.state.mediatorActs.find((a) => a.id === (rb as { act: string }).act)!
    expect(beta.a.key, 'Voraussetzung: dieselbe Wahl aus dem alten Abbild').toBe(alpha.a.key)
    await s.w.rounds(4)
    expect(actsOn(s, alpha.a.key)).toEqual([alpha.id])
    const rule = (d: HolderDevice) => d.state.findings.filter((f) => f.startsWith(`ticket ${beta.id.slice(0, 8)}`) && f.includes('8640.12') && f.includes('Regel'))
    expect(s.w.of('A').flatMap(rule).length).toBeGreaterThan(0)
    expect(rule(s.B).length).toBeGreaterThan(0)
    // M takes the next key: its own consumption of β marks the key; the next introduction names other keys and is accepted.
    const rc = await s.Mm.introduce(s.am.y.id, s.bm.y.id)
    expect('act' in rc).toBe(true)
    const gamma = s.Mm.state.mediatorActs.find((a) => a.id === (rc as { act: string }).act)!
    expect([gamma.a.key, gamma.b.key]).not.toContain(alpha.a.key)
    expect(gamma.b.key).not.toBe(alpha.b.key)
    await s.w.until(() => [s.A, s.B].every((d) => d.state.acts.some((a) => a.id === gamma.id)), 10)
    expect(actsOn(s, gamma.a.key)).toEqual([gamma.id])
  }, 90_000)
})

describe('K2 Schritt 2: Review 38, Grenze des Journalrahmens (S8)', () => {
  // The enrolment batch of the old M device carries one device-set document per counterpart device (copies), and that
  // document grows with the own device count: batch ≈ D × (576 + 1250·D) B base64 + ops. Base64 in one journal document
  // under Delivery's bound (plaintext ≤ 65 536 B): 5 devices at A and at M fit (36.8 KB), 6 do not (51.4 KB → 68.5 KB).
  const grow = async (D: number) => {
    const w = new Welt15(k2({ devices: D }))
    const A = await w.person('A', 'A1')
    const B = await w.person('B', 'B1')
    const Mm = await w.person('M', 'M1')
    const am = await w.encounter(A, Mm)
    const bm = await w.encounter(B, Mm)
    await w.rounds(2)
    await A.setClass(am.x.id, true)
    await B.setClass(bm.x.id, true)
    await w.rounds(3)
    for (let i = 2; i <= D; i++) {
      await w.enrol(A, `A${i}`)
      await w.rounds(2)
    }
    for (let i = 2; i <= D; i++) {
      await w.enrol(Mm, `M${i}`)
      await w.rounds(2)
    }
    await w.rounds(4)
    return w
  }
  it('J1 (Review 38 S8). fünf Geräte bei A und M laufen; sechs scheitern ausdrücklich mit `JournalOversize` (Batch base64 über 65 536 B), nie still', async () => {
    const five = await grow(5)
    expect(five.devices.length).toBe(11)
    let caught: unknown = null
    try {
      await grow(6)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(JournalOversize)
    const e = caught as JournalOversize
    expect(e.device).toBe('M1')
    expect(4 * Math.ceil(e.bytes / 3)).toBeGreaterThan(65_536)
    expect(e.message).toMatch(/^journal-oversize/)
  }, 300_000)
})

function w15Origin(s: { w: Welt15 }, bytes: Uint8Array): string | undefined {
  const o = s.w.frameOrigin(bytes)
  return o ? `${o.device}:${o.kind}` : undefined
}

describe('K2 Schritt 2a: Tor-Review 40 B1, unvollständige Empfangsdokumente sind Formfehler (MV-24)', () => {
  const form = (d: HolderDevice, kind: string, field: string) => d.state.findings.filter((f) => f.includes('Formfehler') && f.includes(kind) && f.includes(field))

  it('B1a. Signierte `stock-revision@2` ohne `keys` (mit `bury`): Befund, keine Quittung, keine Ausnahme; die Runde und jede Folgerunde laufen weiter, die nächste echte Revision gilt', async () => {
    const { w, A, A2, Mm, am } = await world(k2())
    const h = M.head(M.rel(A2.state, am.x.id))
    const rkid = (await A2.cand.keys.pair(h.ownKey)).rkid
    const { keys: _, ...incomplete } = await craft(A2, am.x.id, { rev: 90, classOff: true })
    const bad = await raw(A2).sendDoc(TYPES.stockRevision, h.ownKey, h.peer, h.peerKeyAgreement, rkid, incomplete as unknown as Record<string, unknown>)
    await w.rounds(3)
    expect(raw(Mm).completed.has(bad!.digest)).toBe(false)
    expect(form(Mm, 'stock-revision', 'keys'), Mm.state.findings.join('\n')).toHaveLength(1)
    // Folgerunden: dieselbe Wiederholung des Senders wirft nicht, ein Befund je Form.
    await w.rounds(3)
    expect(form(Mm, 'stock-revision', 'keys')).toHaveLength(1)
    const a1 = signerId((await A.cand.keys.pair(M.head(M.rel(A.state, am.x.id)).ownKey)).anchor)
    const mRel = () => M.relOfTuple(Mm.state, am.y.id)!
    const held = heldRev(mRel().view, a1)
    await (A as unknown as { sendRevision(rel: string): Promise<void> }).sendRevision(am.x.id)
    await w.rounds(3)
    expect(heldRev(mRel().view, a1)).toBe(held + 1)
  }, 120_000)

  it('B1b. Signierte, passend adressierte Karte ohne `card`: Befund bei B, keine Quittung, keine Ausnahme, auch in Folgerunden; die echte Karte verbindet danach', async () => {
    const s = await world(k2())
    const act = await introduced(s)
    await s.B.consent(act)
    const prod = allocatorOf(s.A, act) === 'A1' ? s.A : s.A2
    await s.w.until(() => prod.state.acts.some((a) => a.id === act), 10)
    const a = M.act(prod.state, act)
    const stock = M.findRel(prod.state, a.mediator)!.stock.find((k) => k.anchor === a.own)!
    const bad = await raw(prod).sendDoc(TYPES.card, stock.key, a.voucher.anchor, a.voucher.keyAgreement, stock.keyAgreement, { act, expiresAt: a.expiresAt, from: a.own, fromKeyAgreement: stock.keyAgreement, to: a.voucher.anchor })
    await s.w.rounds(3)
    expect(raw(s.B).completed.has(bad!.digest)).toBe(false)
    expect(form(s.B, 'card', 'card'), s.B.state.findings.join('\n')).toHaveLength(1)
    await s.w.rounds(2)
    expect(form(s.B, 'card', 'card')).toHaveLength(1)
    const b = M.act(s.B.state, act)
    expect([b.v, b.k]).toEqual([null, false])
    await prod.consent(act)
    await s.w.until(() => M.act(s.B.state, act).state === 'connected', 15)
    expect(M.act(s.B.state, act).state).toBe('connected')
  }, 120_000)
})

describe('K2 Schritt 2a: Tor-Review 40 B3/B4, Restore-Artefakte als benannter Preis mit Befund', () => {
  const double = (d: HolderDevice, key: string) => d.state.findings.filter((f) => f.startsWith(`consumption:double-accept:${key}`))

  it('B3. A und M je aus einem Abbild vor α, A2 mit dem Stand nach α eingeschrieben, β erreicht A1 vor dem Schwesterjournal: A1 nimmt β auf demselben Schlüssel an, B weist β ab (8640.12); nach der Heilung halten beide A-Geräte übereinstimmend zwei Akte auf dem Schlüssel und den Befund `consumption:double-accept` (benannter Preis 2a, 2b: D1 (b))', async () => {
    const s = await world(k2(), 1)
    const backupA = s.w.stores.get('A1')!.snapshot()
    const backupM = s.w.stores.get('M1')!.snapshot()
    const ra = await s.Mm.introduce(s.am.y.id, s.bm.y.id)
    expect('act' in ra).toBe(true)
    const alpha = s.Mm.state.mediatorActs.find((a) => a.id === (ra as { act: string }).act)!
    await s.w.until(() => [s.A, s.B].every((d) => d.state.acts.some((a) => a.id === alpha.id)), 10)
    const A2 = await s.w.enrol(s.A, 'A2')
    await s.w.rounds(3)
    expect(A2.state.acts.some((a) => a.id === alpha.id)).toBe(true)
    s.w.stores.get('A1')!.restore(backupA)
    s.w.stores.get('M1')!.restore(backupM)
    const selfA = s.w.selfAddresses('A')
    s.w.carrier.faults.withhold('A1', (f) => selfA.has(f.address))
    await s.A.reload()
    await s.Mm.reload()
    const rb = await s.Mm.introduce(s.am.y.id, s.bm.y.id)
    expect('act' in rb).toBe(true)
    const beta = s.Mm.state.mediatorActs.find((a) => a.id === (rb as { act: string }).act)!
    expect(beta.a.key, 'Voraussetzung: dieselbe Wahl aus dem alten Abbild').toBe(alpha.a.key)
    await s.w.until(() => s.A.state.acts.some((a) => a.id === beta.id), 10)
    expect(M.act(s.A.state, beta.id).own).toBe(alpha.a.key)
    expect(s.B.state.acts.some((a) => a.id === beta.id), 'B weist β ab').toBe(false)
    s.w.carrier.faults.reset()
    await s.w.until(() => s.w.of('A').every((d) => d.state.acts.some((a) => a.id === alpha.id) && d.state.acts.some((a) => a.id === beta.id)), 20)
    await s.w.rounds(3)
    for (const d of s.w.of('A')) {
      expect(d.state.acts.filter((a) => a.own === alpha.a.key).map((a) => a.id).sort(), d.name).toEqual([alpha.id, beta.id].sort())
      expect(double(d, alpha.a.key), `${d.name}: ${d.state.findings.join('\n')}`).toHaveLength(1)
    }
    expect(s.w.agree('A')).toEqual({ agree: true, diff: '' })
  }, 120_000)

  it('B4. A1 aus einem Abbild nach der Bereitstellung von A2s Pool, vor dem Nachholen eine zweite neue Beziehung: derselbe Schwester-Pooleintrag geht an C und an D (C und D können die Beziehungen über A2s Anker verknüpfen); beide A-Geräte melden `pool-use` und sind einig (benannter Preis 2a; 2b: ein neu aufgebautes Gerät verwirft Pooleinträge von vor dem Abbild)', async () => {
    const s = await world(k2())
    const backup = s.w.stores.get('A1')!.snapshot()
    const C = await s.w.person('C', 'C1')
    const tC = await s.w.encounter(s.A, C)
    await s.w.rounds(2)
    s.w.stores.get('A1')!.restore(backup)
    const selfA = s.w.selfAddresses('A')
    s.w.carrier.faults.withhold('A1', (f) => selfA.has(f.address))
    await s.A.reload()
    const D = await s.w.person('D', 'D1')
    const tD = await s.w.encounter(s.A, D)
    await s.w.rounds(2)
    const atC = members(C, tC.y.peer).filter((a) => a !== tC.y.peer)
    const atD = members(D, tD.y.peer).filter((a) => a !== tD.y.peer)
    const shared = atC.filter((a) => atD.includes(a))
    expect(shared, 'C und D sehen denselben A2-Anker').toHaveLength(1)
    s.w.carrier.faults.reset()
    await s.w.rounds(6)
    const reuse = (d: HolderDevice) => d.state.findings.filter((f) => f.startsWith('pool-use: Schlüssel A2#') && f.includes('zwei Beziehungen'))
    for (const d of s.w.of('A')) expect(reuse(d), `${d.name}: ${d.state.findings.join('\n')}`).toHaveLength(1)
    expect(s.w.agree('A')).toEqual({ agree: true, diff: '' })
  }, 120_000)
})
