import { describe, expect, it } from 'vitest'
import { runX15 } from '../src/lab/mehrgeraet/scenarios'
import { k0 } from '../src/candidates/mehrgeraet-k0'

// E15, Eichung (Plan Abschnitt 4): K0 muss X1, X2, X3 und X7 sichtbar
// verletzen; seriell (ein Gerät je Person) muss K0 dieselben Szenarien
// bestehen, sonst stimmt der Prüfstand nicht.

const byId = (rs: Awaited<ReturnType<typeof runX15>>) => Object.fromEntries(rs.map((r) => [r.scenario, r]))

describe('E15 K0 one-seed: Eichung', () => {
  it('seriell bestehen X1–X5, X7, X12, X13–X18; X6, X8–X11, X21 sind seriell nicht abbildbar', async () => {
    const r = byId(await runX15(k0(), true))
    for (const x of Object.values(r)) expect(x.crashed, x.detail).toBeFalsy()
    for (const id of ['X1', 'X2', 'X3', 'X4', 'X5', 'X7', 'X12', 'X13', 'X14', 'X15', 'X16', 'X17', 'X18']) expect(r[id]!.outcome, `${id}: ${r[id]!.detail}`).toBe('bestanden')
    for (const id of ['X6', 'X8', 'X9', 'X10', 'X11', 'X21']) expect(r[id]!.outcome, `${id}: ${r[id]!.detail}`).toBe('nicht abbildbar')
  }, 600_000)

  it('mit zwei Geräten verletzt K0 X1 (Doppelverbrauch), X2 (Budget 11), X3 (Consent ∥ Ablehnung), X7 (Doppel in der Liste)', async () => {
    const r = byId(await runX15(k0(), false, ['X1', 'X2', 'X3', 'X7']))
    for (const x of Object.values(r)) expect(x.crashed, x.detail).toBeFalsy()
    expect(r.X1!.outcome, r.X1!.detail).toBe('nicht bestanden')
    expect(r.X1!.measures.doubleFinalEffects).toBe(1)
    expect(r.X2!.outcome, r.X2!.detail).toBe('nicht bestanden')
    expect(r.X2!.measures.budgetOverrun).toBe(1)
    expect(r.X3!.outcome, r.X3!.detail).toBe('nicht bestanden')
    expect(r.X7!.outcome, r.X7!.detail).toBe('nicht bestanden')
    expect(r.X7!.measures.duplicates).toBeGreaterThan(0)
  }, 300_000)

  it('X4–X6, X8–X12 mit zwei Geräten: K0 verfehlt X4, X5, X6, X9, X11, X12 (A2 bleibt zurück); besteht X8 (Kopie); X10 nicht abbildbar', async () => {
    const r = byId(await runX15(k0(), false, ['X4', 'X5', 'X6', 'X8', 'X9', 'X10', 'X11', 'X12']))
    for (const x of Object.values(r)) expect(x.crashed, x.detail).toBeFalsy()
    for (const id of ['X4', 'X5', 'X6', 'X9', 'X11', 'X12']) expect(r[id]!.outcome, `${id}: ${r[id]!.detail}`).toBe('nicht bestanden')
    expect(r.X8!.outcome, r.X8!.detail).toBe('bestanden')
    expect(r.X10!.outcome).toBe('nicht abbildbar')
    expect(r.X9!.measures.thiefReads).toBeGreaterThan(0)
    expect(r.X11!.measures.roundsToConverge).toBe(-1)
    expect(r.X12!.measures.doubleFinalEffects).toBe(0) // die Zustellung selbst stimmt; nur A2 bleibt zurück
  }, 600_000)
})
