import { describe, expect, it } from 'vitest'
import { runAll, runScenario, scenarios } from '../src/lab/scenarios'
import { runCarrier } from '../src/lab/traeger'
import { rltpBeekem } from '../src/candidates/rltp-beekem'
import { World } from '../src/lab/world'

// E13: dieselbe Autorität, dieselben Rahmen wie rltp-beekem, darunter MLS
// (OpenMLS 0.9.1 über rust/mls-wasm) statt BeeKEM. Erwartungen pinnen das
// Verhalten; Begründungen in src/candidates/rltp-mls/NOTES.md.
const mls = () => rltpBeekem({ keyPort: 'mls' })

describe('Kandidat RLTP-Autorität über MLS', () => {
  it('Basislinie je Szenario', async () => {
    const results = await runAll(mls)
    const byId = Object.fromEntries(results.map((r) => [r.scenario, r.outcome]))
    expect(byId, JSON.stringify(results, null, 1)).toEqual({
      S1: 'bestanden',
      S2: 'bestanden',
      S3: 'bestanden',
      S4a: 'bestanden',
      S4b: 'bestanden', // zwei Entfernungen gleichzeitig: ein Commit verliert den Tiebreak, der Heiler holt ihn nach (KV6 über Heilung)
      S4c: 'bestanden',
      S4c2: 'bestanden',
      S4d: 'bestanden',
      S4e: 'bestanden',
      S4j: 'bestanden', // Wiederaufnahme nach Entfernung: zweites Willkommen ersetzt die inaktive Gruppe
      S4f: 'bestanden',
      S5: 'bestanden', // zweites Gerät: die Person nimmt es selbst auf, das Willkommen reist im welcome-Rahmen
      S5b: 'bestanden',
      S5c: 'bestanden',
      S6: 'bestanden',
      S6b: 'bestanden',
      S7: 'bestanden', // PCS nur über die ausdrückliche Rotation; MLS rotiert beim Schreiben nicht
      S8: 'bestanden',
      S10a: 'nicht abbildbar',
      S10b: 'nicht abbildbar',
      S10c: 'nicht abbildbar',
      S11: 'bestanden', // KV3: das gefälschte Blatt (Commit auf die Epoche vor der Entfernung) gewinnt höchstens den Tiebreak, nie Zugang
    })
  }, 300_000)

  it('T-Szenarien über das Prüfstand-Relay', async () => {
    const results = await runCarrier(mls)
    const byId = Object.fromEntries(results.map((r) => [r.scenario, r.outcome]))
    expect(byId, JSON.stringify(results, null, 1)).toEqual({
      T1: 'bestanden',
      T2: 'bestanden', // Umordnung: Commits außer der Reihe warten in pendingCgka, veraltete werden verworfen
      T3: 'bestanden',
      T4: 'bestanden', // Wiederaufnahme nach Wiederholung: wie S4j
      T5: 'bestanden',
      T6: 'bestanden',
      T6b: 'nicht bestanden', // blind: wie bei BeeKEM (D5)
      T7: 'bestanden',
      T8: 'nicht abbildbar',
      T11: 'nicht abbildbar',
      T12: 'bestanden',
    })
  }, 300_000)

  it('S11 am MLS-Port: beide Zweige des Tiebreaks enden ohne Zugang (Issue #45)', async () => {
    const s11 = scenarios.find((s) => s.id === 'S11')!
    const seen = new Set<string>()
    for (let i = 0; i < 16 && seen.size < 2; i++) {
      const r = await runScenario(() => rltpBeekem({ keyPort: 'mls' }), s11)
      expect(r.outcome, `${r.authority} | ${r.keys}`).toBe('bestanden')
      expect(r.authority).toContain('gemeinsamer Vorgänger von Fälschung und Entfernung: ja')
      if (r.authority.includes('Fälschung gewann')) seen.add('gewann')
      if (r.authority.includes('Fälschung verlor')) seen.add('verlor')
    }
    expect([...seen].sort()).toEqual(['gewann', 'verlor'])
  }, 180_000)

  it('S11 am MLS-Port: eine wirkungslose Fälschung besteht nicht', async () => {
    const s11 = scenarios.find((s) => s.id === 'S11')!
    const noop = () => {
      const c = rltpBeekem({ keyPort: 'mls' })
      c.forgeKeyOp = async () => ({ frames: [{ label: 'cgka', body: new TextEncoder().encode(JSON.stringify({ t: 'cgka', op: '' })) }], works: false })
      return c
    }
    const r = await runScenario(noop, s11)
    expect(r.outcome, r.authority).toBe('nicht bestanden')
    expect(r.authority).toContain('wirkungslos')
  }, 60_000)

  it('Review #39: der Heiler ist das kleinste Mitglied mit Blatt, nicht das kleinste laut Log', async () => {
    // Alice gründet; Bob entfernt sie neben einer Regeländerung, der Fork verwirft die Entfernung: Alice ist laut
    // Log wieder Mitglied, hat aber kein Blatt. Wäre sie als kleinste Person der Heiler, zöge niemand sie nach.
    const c = rltpBeekem({ keyPort: 'mls' })
    const w = new World(c)
    for (const p of ['alice', 'bob', 'carol']) await w.device(p, p)
    await w.flush()
    await w.createGroup('alice')
    await w.add('alice', 'bob', 'admin')
    await w.add('alice', 'carol', 'admin')
    await w.flush()
    await w.partition(['alice', 'carol'], ['bob'])
    await c.changePolicy('carol', 'remove:threshold:2')
    await w.remove('bob', 'alice')
    await w.flush()
    await w.heal()
    await w.flush()
    expect(w.members('bob'), c.status('bob')).toEqual(['alice', 'bob', 'carol'])
    await w.write('alice', 'wieder-da')
    await w.flush()
    for (const d of ['alice', 'bob', 'carol']) expect(w.read(d), `${d}: ${c.status(d)}`).toContain('wieder-da')
    expect(c.status('alice')).toContain('schlüssel=ja')
  }, 120_000)

  it('mit Dienst der Klasse Sicht: S10 und das beglaubigte Ziel wie bei BeeKEM', async () => {
    const sichten = () => rltpBeekem({ keyPort: 'mls', dienst: 'sichten' })
    const by = async (id: string, make = sichten) => runScenario(make, scenarios.find((s) => s.id === id)!)
    for (const id of ['S10a', 'S10b']) {
      const r = await by(id)
      expect(r.outcome, `${id}: ${r.authority}`).toBe('bestanden')
    }
    // S10c wie bei BeeKEM: mit dem Quorum der Vorgängersicht (Access 0.56 §7.3) bleibt der Dienst auf der alten
    // Sicht (stated residual), mit m nach der neuen Sicht (mRule 'new') nicht.
    const c = await by('S10c')
    expect(c.outcome, c.authority).toBe('nicht bestanden')
    const c2 = await by('S10c', () => rltpBeekem({ keyPort: 'mls', dienst: 'sichten', mRule: 'new' }))
    expect(c2.outcome, c2.authority).toBe('bestanden')
    const results = await runCarrier(sichten)
    const byId = Object.fromEntries(results.map((r) => [r.scenario, r]))
    expect(byId.T6b!.outcome, byId.T6b!.authority).toBe('bestanden')
    expect(byId.T7!.authority).toContain('wird verweigert')
  }, 300_000)
})
