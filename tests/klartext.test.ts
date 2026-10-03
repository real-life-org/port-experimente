import { describe, expect, it } from 'vitest'
import { runAll } from '../src/lab/scenarios'
import { World } from '../src/lab/world'
import { klartext } from '../src/candidates/klartext'

// Der Klartext-Kandidat hat weder Krypto noch Rechteprüfung. Er beweist,
// dass der Prüfstand Fehler wirklich erkennt: Jedes „nicht bestanden“
// hier ist ein Szenario, das echte Kandidaten bestehen müssen.
describe('Prüfstand mit Klartext-Kandidat', () => {
  it('liefert die erwarteten Ergebnisse je Szenario', async () => {
    const results = await runAll(klartext)
    const byId = Object.fromEntries(results.map((r) => [r.scenario, r.outcome]))
    expect(byId).toEqual({
      S1: 'bestanden',
      S2: 'nicht bestanden', // Entfernte liest mit
      S3: 'bestanden',
      S4a: 'nicht bestanden', // Bob liest nach Entfernung weiter
      S4b: 'nicht bestanden', // Entfernte lesen weiter
      S4c: 'bestanden', // deterministisch, wenn auch ohne Rechteprüfung
      S4d: 'nicht bestanden', // Carol liest weiter
      S4e: 'nicht bestanden', // Ankunftsreihenfolge entscheidet → uneinig
      S4f: 'nicht bestanden', // Mallorys Kette bleibt
      S5: 'bestanden',
      S6: 'bestanden',
      S7: 'nicht bestanden', // Angreifer liest alles
      S8: 'nicht bestanden', // Dave liest weiter
    })
  })
})

describe('Netz des Prüfstands', () => {
  it('hält Nachrichten in der Partition zurück und reicht sie nach heal() nach', async () => {
    const w = new World(klartext())
    await w.device('alice', 'alice')
    await w.device('bob', 'bob')
    await w.createGroup('alice')
    await w.add('alice', 'bob')
    await w.flush()
    await w.partition(['alice'], ['bob'])
    await w.write('alice', 'getrennt')
    await w.flush()
    expect(w.read('bob')).toEqual([])
    await w.heal()
    await w.flush()
    expect(w.read('bob')).toEqual(['getrennt'])
  })

  it('stellt später hinzugekommenen Geräten die ganze Vergangenheit zu', async () => {
    const w = new World(klartext())
    await w.device('alice', 'alice')
    await w.createGroup('alice')
    await w.write('alice', 'frueh')
    await w.flush()
    await w.device('bob', 'bob')
    await w.flush()
    expect(w.read('bob')).toEqual(['frueh'])
  })
})
