import { describe, expect, it } from 'vitest'
import { runDelivery } from '../src/lab/zustellung'
import { wires } from '../src/candidates/zustellung'

// E11: Zustellungs-Prüfstand. Der Zusteller (Trias §6.1, mindestens einmal §6.3) und der Empfänger (Dispositionen
// §6.2 über die lib) sind für alle Drähte gleich; die Drähte unterscheiden sich darin, was der Träger lernt und wo
// ein fremder Absender abgewiesen wird. Begründungen: src/candidates/zustellung/NOTES.md.

const expectAll = (results: Awaited<ReturnType<typeof runDelivery>>) => {
  const byId = Object.fromEntries(results.map((r) => [r.scenario, r.outcome]))
  expect(byId, JSON.stringify(results, null, 1)).toEqual({ T9: 'bestanden', T10: 'bestanden', Z1: 'bestanden', Z2: 'bestanden', Z3: 'bestanden', Z4: 'bestanden' })
  return Object.fromEntries(results.map((r) => [r.scenario, r.detail]))
}

describe('Zustellung über den Prüfstand-Umschlag (lab)', () => {
  it('T9, T10, Z1–Z4', async () => {
    const d = expectAll(await runDelivery(wires.find((w) => w.id === 'lab')!.make))
    expect(d.Z1).toContain('absender=keiner')
    expect(d.Z4).toContain('am Dokument')
  }, 120_000)
})

describe('Zustellung über TSP Rev 3', () => {
  it('T9, T10, Z1–Z4', async () => {
    const d = expectAll(await runDelivery(wires.find((w) => w.id === 'tsp')!.make))
    expect(d.Z1).toContain('absender=VID(alice)')
    expect(d.Z4).toContain('am Draht')
  }, 120_000)
})

describe('Zustellung über DIDComm v2', () => {
  it('authcrypt: T9, T10, Z1–Z4', async () => {
    const d = expectAll(await runDelivery(wires.find((w) => w.id === 'didcomm-authcrypt')!.make))
    expect(d.Z1).toContain('absender=kid(alice)')
    expect(d.Z4).toContain('am Draht')
  }, 120_000)
  it('anoncrypt: T9, T10, Z1–Z4', async () => {
    const d = expectAll(await runDelivery(wires.find((w) => w.id === 'didcomm-anoncrypt')!.make))
    expect(d.Z1).toContain('absender=keiner')
    expect(d.Z4).toContain('am Draht')
  }, 120_000)
})
