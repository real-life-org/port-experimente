import { describe, expect, it } from 'vitest'
import { HORIZON, Welt, party, runDelivery } from '../src/lab/zustellung'
import { wires } from '../src/candidates/zustellung'
import { labWire } from '../src/candidates/zustellung/lab'

// E11: Zustellungs-Prüfstand. Der Zusteller (Trias §6.1, mindestens einmal §6.3) und der Empfänger (Dispositionen
// §6.2 über die lib) sind für alle Drähte gleich; die Drähte unterscheiden sich darin, was der Träger lernt und wo
// ein fremder Absender abgewiesen wird. Begründungen: src/candidates/zustellung/NOTES.md.

const expectAll = (results: Awaited<ReturnType<typeof runDelivery>>) => {
  const byId = Object.fromEntries(results.map((r) => [r.scenario, r.outcome]))
  expect(byId, JSON.stringify(results, null, 1)).toEqual({ T9: 'bestanden', T10: 'bestanden', Z1: 'bestanden', Z2: 'bestanden', Z3: 'bestanden', Z4: 'bestanden', Z5: 'bestanden' })
  return Object.fromEntries(results.map((r) => [r.scenario, r.detail]))
}

describe('Zustellung über den Prüfstand-Umschlag (lab)', () => {
  it('T9, T10, Z1–Z4', async () => {
    const d = expectAll(await runDelivery(wires.find((w) => w.id === 'lab')!.make))
    expect(d.Z1).toContain('absender=keiner')
    expect(d.Z4).toContain('am Dokument')
    expect(d.Z5).toContain('am Dokument') // der lib-Umschlag an einen anderen rkid: Stufe 2, rkid unbekannt
  }, 120_000)
})

describe('Zustellung über TSP Rev 3', () => {
  it('T9, T10, Z1–Z4', async () => {
    const d = expectAll(await runDelivery(wires.find((w) => w.id === 'tsp')!.make))
    expect(d.Z1).toContain('absender=VID(alice)')
    expect(d.Z4).toContain('am Draht') // Außensignatur: Bobs Endpunkt kennt nur Alices Signaturschlüssel
    expect(d.Z5).toContain('am Draht')
  }, 120_000)
})

describe('Zustellung über DIDComm v2', () => {
  it('authcrypt: T9, T10, Z1–Z4', async () => {
    const d = expectAll(await runDelivery(wires.find((w) => w.id === 'didcomm-authcrypt')!.make))
    expect(d.Z1).toContain('absender=kid(alice)')
    expect(d.Z4).toContain('am Draht') // ECDH-1PU: der Schlüssel hängt am Absender, Bob rechnet mit Alices
    expect(d.Z5).toContain('am Draht')
  }, 120_000)
  it('anoncrypt: T9, T10, Z1–Z4', async () => {
    const d = expectAll(await runDelivery(wires.find((w) => w.id === 'didcomm-anoncrypt')!.make))
    expect(d.Z1).toContain('absender=keiner')
    expect(d.Z4).toContain('am Dokument') // anoncrypt prüft keinen Absender: der Rahmen öffnet sich, der Beweis fällt
    expect(d.Z5).toContain('am Draht')
  }, 120_000)
})

describe('Zusteller: Trias und Aufgabegrenze (Issue #43)', () => {
  it('eine Störung nach accepted nimmt accepted nicht zurück; die Aufgabegrenze gilt trotzdem; eine späte Quittung heißt late', async () => {
    const w = new Welt(labWire())
    const { A, B } = await w.pair(await party('alice'), await party('bob'))
    B.online = false
    const d = await A.send({ note: 'spät' })
    expect(A.zusteller.report(d)).toEqual({ state: 'accepted' })
    w.carrier.unreachable = true
    for (let i = 1; i < HORIZON.giveUp; i++) {
      await w.rounds(1)
      expect(A.zusteller.report(d), `Runde ${i}`).toEqual({ state: 'accepted' })
    }
    expect(A.zusteller.transport(d)).toBe('unreachable')
    await w.rounds(1)
    expect(A.zusteller.report(d)).toEqual({ state: 'failed', reason: 'expired-by-adapter-policy' })
    // Der Träger hält den Rahmen noch; kommt die Quittung doch, ist sie spät, aber gültig (§6.1).
    w.carrier.unreachable = false
    B.online = true
    const n = await w.until(() => A.zusteller.report(d)?.state === 'delivered')
    expect(n).toBeGreaterThan(0)
    expect(A.zusteller.report(d)).toEqual({ state: 'delivered', late: true })
  }, 60_000)

  it('Sender offline nach accepted: accepted bleibt, Aufgabe nach der Grenze', async () => {
    const w = new Welt(labWire())
    const { A, B } = await w.pair(await party('alice'), await party('bob'))
    B.online = false
    const d = await A.send({ note: 'offline-danach' })
    expect(A.zusteller.report(d)).toEqual({ state: 'accepted' })
    A.online = false
    await w.rounds(HORIZON.giveUp - 1)
    expect(A.zusteller.report(d)).toEqual({ state: 'accepted' })
    expect(A.zusteller.transport(d)).toBe('offline')
    await w.rounds(1)
    expect(A.zusteller.report(d)).toEqual({ state: 'failed', reason: 'expired-by-adapter-policy' })
  }, 60_000)
})
