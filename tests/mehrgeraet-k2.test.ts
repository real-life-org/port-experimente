import { describe, expect, it } from 'vitest'
import { Welt15 } from '../src/lab/mehrgeraet/welt'
import { HolderDevice, UnknownWriter, type MultiDeviceCandidate } from '../src/lab/mehrgeraet/holder'
import { runX15 } from '../src/lab/mehrgeraet/scenarios'
import { k2, K2Device } from '../src/candidates/mehrgeraet-k2'
import { k1a, type Batch } from '../src/candidates/mehrgeraet-k1a'
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

describe('K2 Schritt 1: Matrix', () => {
  it('2. X1–X18, X7b, X21 mit zwei Geräten: Zwischenregel `mediatorSplit` an (K1as Benennungsteilung bis Schritt 5), 17/2/1; rot X7 und X18 (Gerätekarten verschieden, 8910.8, Schritt 2); X9 bestanden unter der Schritt-1-Vereinfachung', async () => {
    const c = k2()
    expect(c.id).toBe('k2-device-keys')
    const r = byId(await runX15(c))
    const passed = ['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7b', 'X8', 'X9', 'X11', 'X12', 'X13', 'X14', 'X15', 'X16', 'X17', 'X21']
    for (const x of passed) expect(r[x]!.outcome, `${x}: ${r[x]!.detail}`).toBe('bestanden')
    for (const x of ['X7', 'X18']) expect(r[x]!.outcome, `${x}: ${r[x]!.detail}`).toBe('nicht bestanden')
    expect(r.X10!.outcome).toBe('nicht abbildbar')
    expect(Object.values(r).some((x) => x.crashed)).toBe(false)
    const n = (o: string) => Object.values(r).filter((x) => x.outcome === o).length
    expect([n('bestanden'), n('nicht bestanden'), n('nicht abbildbar')]).toEqual([17, 2, 1])
    // X3 promise changed (rule 2, as K1a); X9 passes only under the step-1 simplification (never a silent pass).
    expect(r.X3!.promiseChanged).toBe(true)
    expect(r.X9!.promiseChanged).toBe(true)
    expect(r.X9!.detail).toContain('Schritt-1-Vereinfachung')
    expect(r.X9!.measures.thiefReads).toBe(0)
    // Why X18 fails: two cards of one act from two devices differ (8910.8), B marks K; no double effect (decision 6o.5 no. 7 is step 2).
    expect(r.X18!.measures.cardConflictsAtB).toBeGreaterThan(0)
    expect(r.X18!.measures.doubleFinalEffects).toBe(0)
    // Writers are the signing device keys: M takes both, no 6270, not linkable across relationships.
    expect(r.X17!.measures.writersAcceptedByM).toBe(2)
    expect(r.X17!.measures.writerTagsLinkedAcrossRelationships).toBe(0)
  }, 300_000)

  it('2b. Gegenlauf ohne Zwischenregel (`mediatorSplit: false`): M benennt jeden Schlüssel, X1, X13 und X14 fallen; 14/5/1', async () => {
    const c = k2({ mediatorSplit: false })
    expect(c.id).toBe('k2-device-keys-no-split')
    const r = byId(await runX15(c))
    for (const x of ['X1', 'X7', 'X13', 'X14', 'X18']) expect(r[x]!.outcome, `${x}: ${r[x]!.detail}`).toBe('nicht bestanden')
    const n = (o: string) => Object.values(r).filter((x) => x.outcome === o).length
    expect([n('bestanden'), n('nicht bestanden'), n('nicht abbildbar')]).toEqual([14, 5, 1])
    // Why X1/X13 fail: a key named twice by the mediator devices (no `n mod devices` split).
    expect(r.X1!.measures.doubleFinalEffects).toBeGreaterThan(0)
    expect(r.X13!.measures.doubleFinalEffects).toBeGreaterThan(0)
  }, 300_000)

  it('2c. Kontrolllauf seriell (ein Gerät, ungeteilte Rechte): jede Zelle mit Kontrolllauf besteht, wie K1a', async () => {
    const r = byId(await runX15(k2({ devices: 1 }), true))
    for (const x of Object.values(r)) expect(x.outcome, `${x.scenario}: ${x.detail}`).not.toBe('nicht bestanden')
  }, 300_000)
})

describe('K2 Schritt 1: Dieb, Restore, Fan-out', () => {
  it('3. Dieb mit dem Abbild von A2: vor dem Widerruf liest er, was A2s Schlüssel öffnen, nie A1s Adressen; nach dem Widerruf 0 neue Dokumente; Gegenlauf nur Träger: er liest weiter', async () => {
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
      const mark = thief.log.length
      const r = await Mm.introduce(am.y.id, bm.y.id) // M → A: ticket
      expect('act' in r).toBe(true)
      await B.setClass(ab.y.id, false) // B → A: empty revision
      await w.rounds(4)
      const after = thief.log.slice(mark).filter((e) => e.type !== 'delivery-ack').length
      if (counterpartRevocation) expect(after).toBe(0)
      else expect(after).toBeGreaterThan(0) // carrier only: B and M keep sealing to A2's keys
      expect(A.state.acts.length).toBe(1) // A1 still receives
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

  it('6. Fan-out mit drei Geräten: ein Journalbatch geht als zwei Kopien (je Schwester) statt eines Rahmens; ein Dokument an A als drei Kopien (je Gerät) statt eines', async () => {
    const out: Record<string, { journal: number; journalBytes: number; ticket: number; ticketBytes: number }> = {}
    for (const [id, c] of [['k1a', k1a({ devices: 3 })], ['k2', k2({ devices: 3 })]] as const) {
      const { w, A, Mm, am, bm } = await world(c, 3)
      let mark = w.carrier.carried.length
      await A.setClass(am.x.id, false)
      await w.rounds(1)
      const journal = w.carrier.carried.slice(mark).filter((f) => w.frameOrigin(f.bytes)?.device === 'A1' && w.frameOrigin(f.bytes)?.kind === 'journal')
      await A.setClass(am.x.id, true)
      await w.rounds(3)
      mark = w.carrier.carried.length
      const r = await Mm.introduce(am.y.id, bm.y.id)
      expect('act' in r).toBe(true)
      await w.rounds(1)
      const tickets = w.carrier.carried.slice(mark).filter((f) => w.frameOrigin(f.bytes)?.kind === 'introduction-ticket' && w.personOf(M.act(A.state, (r as { act: string }).act).own) === 'A')
      const toA = new Set<string>()
      for (const d of w.of('A')) toA.add((await d.cand.keys.pair(M.head(M.rel(A.state, am.x.id)).ownKey)).rkid)
      const ticketsToA = tickets.filter((f) => toA.has(f.address))
      out[id] = { journal: journal.length, journalBytes: journal.reduce((n, f) => n + f.bytes.length, 0), ticket: ticketsToA.length, ticketBytes: ticketsToA.reduce((n, f) => n + f.bytes.length, 0) }
    }
    expect(out.k1a!.journal).toBe(1)
    expect(out.k2!.journal).toBe(2)
    expect(out.k1a!.ticket).toBe(1)
    expect(out.k2!.ticket).toBe(3)
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
})
