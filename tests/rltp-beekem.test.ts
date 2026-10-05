import { describe, expect, it } from 'vitest'
import { runAll } from '../src/lab/scenarios'
import { rltpBeekem } from '../src/candidates/rltp-beekem'
import { World } from '../src/lab/world'

// E6: Autoritätslog nach der Konfliktmatrix entscheidet die Mitgliedschaft,
// BeeKEM 0.4.0 (rust/beekem-wasm) liefert die Schlüssel, Inhalt Yjs.
// Erwartungen halten das Verhalten fest; Begründungen in
// src/candidates/rltp-beekem/NOTES.md.
describe('Kandidat RLTP-Autorität über BeeKEM', () => {
  it('Basislinie je Szenario', async () => {
    const results = await runAll(rltpBeekem)
    const byId = Object.fromEntries(results.map((r) => [r.scenario, r.outcome]))
    expect(byId, JSON.stringify(results, null, 1)).toEqual({
      S1: 'bestanden',
      S2: 'bestanden',
      S3: 'bestanden',
      S4a: 'bestanden', // Bobs Eintrag unter altem Schlüssel bleibt lesbar (content residual), Bob liest nichts Neues
      S4b: 'bestanden', // zwei Entfernungen gleichzeitig: beide gelten, niemand liest mit (KV2, KV6)
      S4c: 'bestanden', // gegenseitige Entfernung: beide raus (Matrix-Entscheidung 2)
      S4d: 'bestanden', // Rotation neben Entfernung (KV5, KV6)
      S4e: 'nicht abbildbar', // keine Gruppenregeln im Experiment
      S4f: 'bestanden', // Strong Removal transitiv: Mallorys Kette ungültig, Baum geheilt
      S5: 'bestanden', // E7: ein Blatt je Gerät, Person bleibt Subjekt im Log
      S5b: 'bestanden', // E7: eigenes Gerät entfernen = neues Geheimnis ohne dessen Blatt (KV1), Person bleibt
      S5c: 'bestanden', // E7: Entfernen der Person entfernt alle ihre Blätter
      S6: 'nicht bestanden', // Historie erst über die Kette des nächsten Eintrags (wie Keyhive b)
      S6b: 'bestanden',
      S7: 'bestanden', // PCS: passiver Dieb liest nach der Rotation nichts mehr (KV5)
      S8: 'bestanden', // Gründerin ohne Sonderrolle
    })
  }, 120_000)
})

// Regressionen aus dem Review zu PR #12 (Issues #13, #14).
describe('E7: Geräte und Personen', () => {
  async function gruppe(carolRole: 'admin' | 'member' = 'member') {
    const c = rltpBeekem()
    const w = new World(c)
    for (const p of ['alice', 'bob', 'carol']) await w.device(p, p)
    await w.flush()
    await w.createGroup('alice')
    await w.add('alice', 'bob')
    await w.add('alice', 'carol', carolRole)
    await w.flush()
    return { c, w }
  }

  it('Review #11: unberechtigte Entfernung in einer Partition schließt niemanden von einer gültigen Aufnahme aus', async () => {
    const c = rltpBeekem()
    const w = new World(c)
    for (const p of ['alice', 'carol', 'eve']) await w.device(p, p)
    await w.flush()
    await w.createGroup('alice')
    await w.add('alice', 'carol', 'member')
    await w.flush()
    await w.partition(['alice', 'eve'], ['carol'])
    await w.add('alice', 'eve', 'member')
    await w.remove('carol', 'alice') // Carol ist kein Admin
    await w.flush()
    await w.heal()
    await w.flush()
    for (const d of ['alice', 'carol', 'eve']) expect(w.members(d), d).toEqual(['alice', 'carol', 'eve'])
    await w.write('alice', 'mit-eve')
    await w.flush()
    expect(w.read('eve')).toEqual(['mit-eve'])
    expect(w.read('carol')).toEqual(['mit-eve'])
  })

  it('#13: Person lässt sich nach Widerruf ihres letzten Geräts entfernen', async () => {
    const { w } = await gruppe()
    await w.removeDevice('alice', 'bob')
    await w.flush()
    expect(w.members('carol')).toEqual(['alice', 'bob', 'carol'])
    await w.remove('alice', 'bob')
    await w.flush()
    expect(w.members('carol')).toEqual(['alice', 'carol'])
    await w.write('carol', 'ohne-bob')
    await w.flush()
    expect(w.read('carol')).toEqual(['ohne-bob'])
    expect(w.read('bob')).toEqual([])
  })

  it('#14: Widerruf wirkt erst, wenn der Rahmen zugestellt ist', async () => {
    const { c, w } = await gruppe('admin')
    await w.device('bob', 'bob-2')
    await w.flush()
    await w.write('alice', 'vorher')
    await w.flush()
    await w.partition(['alice'], ['bob', 'bob-2', 'carol'])
    await w.removeDevice('alice', 'bob-2')
    await w.flush()
    // Eine ungültige Autoritätsoperation in Carols Partition löst dort Heilen aus (Repro des Reviews).
    await w.add('bob', 'carol')
    await w.flush()
    // Carols Seite weiß nichts: kein Heilen, bob-2 liest weiter.
    await w.write('carol', 'in-der-partition')
    await w.flush()
    expect(w.read('bob-2')).toEqual(['in-der-partition', 'vorher'])
    expect(w.log.filter((m) => m.from === 'carol' && m.label === 'heal')).toHaveLength(0)
    expect(c.status('carol')).toContain('baum=4')
    // Nach der Zustellung konvergieren alle: bob-2 ist raus und liest Neues nicht.
    await w.heal()
    await w.flush()
    await w.write('carol', 'nachher')
    await w.flush()
    expect(w.read('bob-2')).not.toContain('nachher')
    expect(w.read('bob')).toContain('nachher')
    expect(w.read('alice')).toContain('nachher')
    for (const d of ['alice', 'bob', 'carol']) expect(c.status(d)).toContain('baum=3')
  })
})
