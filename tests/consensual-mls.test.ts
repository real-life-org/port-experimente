import { describe, expect, it } from 'vitest'
import { runAll } from '../src/lab/scenarios'
import { runCarrier } from '../src/lab/traeger'
import { consensualMls } from '../src/candidates/consensual-mls'
import { World } from '../src/lab/world'

// E14b: Consensuals Raummodell (MLS ohne Autoritätslog) gegen dieselben Szenarien wie rltp-mls. Die Pins halten
// Befunde fest, nicht Erfolge; wo der kleinste Hash entscheidet, sind beide Ausgänge zulässig und werden benannt.
// Begründungen: src/candidates/consensual-mls/NOTES.md.

const hashDependent = (outcome: string) => expect(['bestanden', 'nicht bestanden']).toContain(outcome)

describe('Raummodell any-staged (jedes Mitglied committet)', () => {
  it('S-Szenarien', async () => {
    const results = await runAll(() => consensualMls({ committer: 'any-staged' }))
    const byId = Object.fromEntries(results.map((r) => [r.scenario, r]))
    const outcomes = Object.fromEntries(results.filter((r) => !['S4f'].includes(r.scenario)).map((r) => [r.scenario, r.outcome]))
    expect(outcomes, JSON.stringify(results, null, 1)).toEqual({
      S1: 'bestanden',
      S2: 'bestanden',
      S3: 'bestanden',
      S4a: 'bestanden',
      S4b: 'bestanden',
      S4c: 'bestanden', // einer bleibt, welcher, entscheidet der Hash; A4a verlangt nur Einigkeit
      S4c2: 'nicht bestanden', // der Gewinner liest Carols gleichzeitigen Eintrag
      S4d: 'bestanden',
      S4e: 'nicht abbildbar',
      S4j: 'nicht abbildbar',
      S5: 'nicht bestanden', // zweites Gerät liest weder alt noch neu: ohne Historie kein CRDT
      S5b: 'bestanden',
      S5c: 'bestanden',
      S6: 'nicht bestanden', // keine Historie (B23)
      S6b: 'nicht bestanden', // auch der nächste Eintrag bleibt unlesbar
      S7: 'bestanden',
      S8: 'bestanden',
      S10a: 'nicht abbildbar',
      S10b: 'nicht abbildbar',
      S10c: 'nicht abbildbar',
      S11: 'nicht abbildbar',
    })
    // Ob Mallorys Kette bleibt, entscheidet der Hash.
    hashDependent(byId.S4f!.outcome)
    expect(byId.S4f!.keys).toMatch(/LECK: x,y lesen neuen Inhalt|nur bei Mitgliedern: ja/)
  }, 300_000)

  it('T-Szenarien', async () => {
    const results = await runCarrier(() => consensualMls({ committer: 'any-staged' }))
    const byId = Object.fromEntries(results.map((r) => [r.scenario, r]))
    const outcomes = Object.fromEntries(results.filter((r) => r.scenario !== 'T2').map((r) => [r.scenario, r.outcome]))
    expect(outcomes, JSON.stringify(results, null, 1)).toEqual({
      T1: 'nicht bestanden', // verschluckter Commit bleibt Lücke
      T3: 'bestanden',
      T4: 'bestanden',
      T5: 'nicht bestanden', // beschädigter Rahmen wird verworfen, nicht repariert
      T6: 'nicht bestanden', // Zurückhalten unbemerkt
      T6b: 'nicht bestanden',
      T7: 'bestanden',
      T8: 'nicht abbildbar',
      T11: 'nicht abbildbar',
      T12: 'bestanden',
    })
    // Verliert Alices Aufnahme den Tiebreak, ist ihr Eintrag für Bob verloren.
    hashDependent(byId.T2!.outcome)
  }, 300_000)
})

describe('Raummodell owner (nur der Gründer committet)', () => {
  it('Review #40: ein Mitglied committet auch bei der Rotation nicht selbst, es schlägt vor', async () => {
    const c = consensualMls({ committer: 'owner' })
    const w = new World(c)
    for (const p of ['alice', 'bob']) await w.device(p, p)
    await w.flush()
    await w.createGroup('alice')
    await w.add('alice', 'bob', 'member')
    await w.flush()
    const before = c.status('bob')
    await c.rotate('bob')
    const frames = c.takeOutgoing('bob')
    expect(frames.map((f) => f.label)).toEqual(['proposal'])
    expect(c.status('bob'), 'ein Vorschlag ist kein Commit').toBe(before)
    // Zustellen: der Gründer committet den Vorschlag, beide stehen eine Epoche weiter.
    for (const f of frames) for (const d of ['alice', 'bob']) await c.receive(d, { id: 9000, from: 'bob', label: f.label, body: f.body })
    const commits = c.takeOutgoing('alice')
    expect(commits.map((f) => f.label)).toEqual(['auth'])
    expect(c.takeOutgoing('bob')).toEqual([])
    for (const f of commits) for (const d of ['alice', 'bob']) await c.receive(d, { id: 9001, from: 'alice', label: f.label, body: f.body })
    expect(c.status('alice')).toContain('epoche=2')
    expect(c.status('bob')).toContain('epoche=2')
  }, 60_000)

  it('S-Szenarien', async () => {
    const results = await runAll(() => consensualMls({ committer: 'owner' }))
    const byId = Object.fromEntries(results.map((r) => [r.scenario, r.outcome]))
    expect(byId, JSON.stringify(results, null, 1)).toEqual({
      S1: 'bestanden',
      S2: 'bestanden',
      S3: 'bestanden',
      S4a: 'bestanden',
      S4b: 'bestanden',
      S4c: 'bestanden', // der Gründer bleibt
      S4c2: 'nicht bestanden',
      S4d: 'bestanden',
      S4e: 'nicht abbildbar',
      S4j: 'nicht abbildbar',
      S4f: 'bestanden', // Vorschläge der Entfernten zählen nicht
      S5: 'nicht bestanden',
      S5b: 'bestanden',
      S5c: 'bestanden',
      S6: 'nicht bestanden',
      S6b: 'nicht bestanden',
      S7: 'bestanden',
      S8: 'nicht bestanden', // ohne Gründer keine Entfernung
      S10a: 'nicht abbildbar',
      S10b: 'nicht abbildbar',
      S10c: 'nicht abbildbar',
      S11: 'nicht abbildbar',
    })
  }, 300_000)

  it('T-Szenarien', async () => {
    const results = await runCarrier(() => consensualMls({ committer: 'owner' }))
    const byId = Object.fromEntries(results.map((r) => [r.scenario, r.outcome]))
    expect(byId, JSON.stringify(results, null, 1)).toEqual({
      T1: 'nicht bestanden',
      T2: 'bestanden',
      T3: 'bestanden',
      T4: 'bestanden',
      T5: 'nicht bestanden',
      T6: 'nicht bestanden',
      T6b: 'nicht bestanden',
      T7: 'bestanden',
      T8: 'nicht abbildbar',
      T11: 'nicht abbildbar',
      T12: 'bestanden',
    })
  }, 300_000)
})
