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
      S4e: 'bestanden', // E9: zwei policy.change gleichzeitig → Fork, alle einig
      S4j: 'bestanden', // E9: policy.change neben Entfernung → Fork, Entfernung verfällt; Ende durch policy.change auf beide
      S4f: 'bestanden', // Strong Removal transitiv: Mallorys Kette ungültig, Baum geheilt
      S5: 'bestanden', // E7: ein Blatt je Gerät, Person bleibt Subjekt im Log
      S5b: 'bestanden', // E7: eigenes Gerät entfernen = neues Geheimnis ohne dessen Blatt (KV1), Person bleibt
      S5c: 'bestanden', // E7: Entfernen der Person entfernt alle ihre Blätter
      S6: 'nicht bestanden', // Historie erst über die Kette des nächsten Eintrags (wie Keyhive b)
      S6b: 'bestanden',
      S7: 'bestanden', // PCS: passiver Dieb liest nach der Rotation nichts mehr (KV5)
      S8: 'bestanden', // Gründerin ohne Sonderrolle
      S10a: 'nicht abbildbar',
      S10b: 'nicht abbildbar',
      S10c: 'nicht abbildbar',
    })
  }, 120_000)
})

// Regressionen aus dem Review zu PR #16 (E9).
describe('E9: Politik am Kandidaten', () => {
  it('#18: eine fehlgeschlagene Admin-Aufnahme hinterlässt keine Rechte', async () => {
    const c = rltpBeekem()
    const w = new World(c)
    for (const p of ['alice', 'bob', 'carol']) await w.device(p, p)
    await w.flush()
    await w.createGroup('alice')
    await w.add('alice', 'carol')
    await w.flush()
    await c.changePolicy('alice', 'add:vouch:1')
    await w.flush()
    // Ohne Bürgschaft ungültig; die Beförderung hängt an dieser Aufnahme.
    await w.add('alice', 'bob', 'admin')
    await w.flush()
    expect(w.members('carol')).toEqual(['alice', 'carol'])
    await c.changePolicy('alice', 'add:any-member')
    await w.add('alice', 'bob', 'member')
    await w.flush()
    expect(w.members('carol')).toEqual(['alice', 'bob', 'carol'])
    await w.remove('bob', 'alice')
    await w.flush()
    expect(w.members('carol')).toEqual(['alice', 'bob', 'carol'])
    expect(w.members('bob')).toEqual(['alice', 'bob', 'carol'])
  })
})

describe('E9 Schritt 1b: der Baum folgt dem Zustand', () => {
  it('eine Aufnahme, die erst durch eine spätere Operation gültig wird, kommt in den Baum', async () => {
    const c = rltpBeekem()
    const w = new World(c)
    for (const p of ['alice', 'bob', 'carol', 'dave', 'x']) await w.device(p, p)
    await w.flush()
    await w.createGroup('alice')
    await w.add('alice', 'bob', 'admin')
    await w.add('alice', 'carol', 'admin')
    await w.add('alice', 'dave')
    await w.flush()
    // Drei Partitionen: Alice entfernt Bob; Bob nimmt x auf; Carol ändert die
    // Regeln. Dave sieht erst Alices Entfernung von Bob, dann Bobs Aufnahme
    // von x als unterdrückt; erst Carols Regeländerung (Fork mit der
    // Entfernung, beide verfallen) macht die Aufnahme nachträglich gültig.
    await w.partition(['alice', 'dave'], ['bob', 'x'], ['carol'])
    await w.remove('alice', 'bob')
    await w.flush()
    await w.add('bob', 'x')
    await c.changePolicy('carol', 'regel-c')
    await w.flush()
    await w.heal()
    await w.flush()
    const all = ['alice', 'bob', 'carol', 'dave', 'x']
    for (const d of all) expect(w.members(d), d).toEqual(all)
    for (const d of all) expect(c.status(d), d).toContain('fork=ja')
    await w.write('dave', 'nachher')
    await w.flush()
    for (const d of ['alice', 'carol', 'dave', 'x']) expect(w.read(d), d).toContain('nachher')
    // Bob ist wieder Mitglied, aber sein Blatt wurde durch die (später
    // verfallene) Entfernung aus dem Baum genommen; die Wiederaufnahme unter
    // demselben Share-Key gibt ihm keinen Schlüssel zurück. Er braucht eine
    // frische Karte (Befund 8 in NOTES.md). Festgehalten, nicht gelöst.
    expect(w.read('bob')).toEqual([])
  })
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

// E10: Lückenreparatur (Replication I12). Ein Eintrag nennt die
// Autoritätsköpfe seines Schreibers; wer einen Kopf nicht hält, fordert ihn
// adressiert und mit Beleg nach. Zwischen den Läufen ist der Zustand
// abfragbar (awaiting-source), nie still.
describe('E10: Lückenreparatur', () => {
  it('eine still verlorene Aufnahme wird beim Autor nachgefordert; offline bleibt sie sichtbar offen', async () => {
    const c = rltpBeekem()
    const w = new World(c)
    for (const p of ['alice', 'bob', 'carol', 'dave']) await w.device(p, p)
    await w.flush()
    await w.createGroup('alice')
    await w.add('alice', 'bob')
    await w.add('alice', 'carol')
    await w.flush()
    const k = w.carrier()!
    let dropped = false
    k.drop((m) => (!dropped && m.from === 'alice' && m.label === 'auth' ? (dropped = true) : false))
    await w.add('alice', 'dave')
    await w.flush()
    k.reset()
    expect(w.members('bob')).toEqual(['alice', 'bob', 'carol'])
    // Alice schreibt; die Nachfragen erreichen sie vorerst nicht.
    k.withhold('alice', (m) => m.label === 'repair')
    await w.write('alice', 'danach')
    await w.flush()
    expect(c.status('bob')).toContain('lücke=1 (awaiting-source)')
    expect(c.status('carol')).toContain('lücke=1 (awaiting-source)')
    expect(w.read('bob')).toEqual([])
    // Nur die adressierte Quelle antwortet: Bob und Carol halten die Aufnahme nicht.
    k.reset()
    await w.flush()
    for (const d of ['alice', 'bob', 'carol', 'dave']) expect(w.members(d), d).toEqual(['alice', 'bob', 'carol', 'dave'])
    for (const d of ['bob', 'carol', 'dave']) expect(w.read(d), d).toEqual(['danach'])
    expect(c.status('bob')).toContain('lücke=0 (repariert 1)')
  })

  it('eine verlorene Regeländerung wird belegt, obwohl der Inhalt zu öffnen ist (Review zu #27)', async () => {
    const c = rltpBeekem()
    const w = new World(c)
    for (const p of ['alice', 'bob']) await w.device(p, p)
    await w.flush()
    await w.createGroup('alice')
    await w.add('alice', 'bob')
    await w.flush()
    const k = w.carrier()!
    let dropped = false
    k.drop((m) => (!dropped && m.from === 'alice' && m.label === 'policy' ? (dropped = true) : false))
    await c.changePolicy('alice', 'remove:any-member')
    await w.flush()
    k.reset()
    expect(c.status('bob')).toContain('regeln=v1')
    // Der Inhalt ändert am Baum nichts; Bob kann ihn öffnen. Der Umschlag belegt die Lücke trotzdem.
    await w.write('alice', 'nach-der-regel')
    await w.flush()
    expect(w.read('bob')).toEqual(['nach-der-regel'])
    expect(c.status('bob')).toContain('regeln=v2')
    expect(c.status('bob')).toContain('lücke=0 (repariert 1)')
  })

  it('geht die Anfrage verloren, wiederholt die Replik sie beim nächsten Rahmen der Quelle, höchstens dreimal', async () => {
    const c = rltpBeekem()
    const w = new World(c)
    for (const p of ['alice', 'bob']) await w.device(p, p)
    await w.flush()
    await w.createGroup('alice')
    await w.add('alice', 'bob')
    await w.flush()
    const k = w.carrier()!
    let dropped = false
    k.drop((m) => (!dropped && m.from === 'alice' && m.label === 'policy' ? (dropped = true) : false))
    await c.changePolicy('alice', 'remove:any-member')
    await w.flush()
    k.reset()
    // Alle Anfragen von Bob gehen verloren; Alice schreibt viermal, Bob fragt dreimal, dann nicht mehr.
    k.drop((m) => m.from === 'bob' && m.label === 'repair')
    for (const t of ['eins', 'zwei', 'drei', 'vier']) {
      await w.write('alice', t)
      await w.flush()
    }
    expect(c.status('bob')).toContain('lücke=1 (awaiting-source)')
    expect(c.status('bob')).toContain('anfragen=3')
    expect(w.swallowed.filter((m) => m.label === 'repair')).toHaveLength(3)
    // Die Leitung wird frei: der Lauf hat seine Höchstzahl erreicht und bleibt sichtbar offen; ein neuer Beleg startet keinen neuen Lauf.
    k.reset()
    await w.write('alice', 'fünf')
    await w.flush()
    expect(c.status('bob')).toContain('lücke=1 (awaiting-source)')
    expect(c.status('bob')).toContain('regeln=v1')
  })
})
