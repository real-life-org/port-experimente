import { describe, expect, it } from 'vitest'
import { runAll } from '../src/lab/scenarios'
import { World } from '../src/lab/world'
import { runCarrier } from '../src/lab/traeger'
import { writeFileSync } from 'node:fs'

// E12 Variante (a): PWS als blinder Speicher einer Gruppe. Nur Node ≥ 24
// (Vorgabe von was-teaching-server und @interop/was-client).
const major = Number(process.versions.node.split('.')[0])
const d = describe.skipIf(major < 24)

d('E12: RLTP über BeeKEM auf Portable Web Spaces', () => {
  it('Basislinie je Szenario', async () => {
    const { rltpBeekemPws } = await import('../src/candidates/pws')
    const results = await runAll(rltpBeekemPws)
    const byId = Object.fromEntries(results.map((r) => [r.scenario, r.outcome]))
    expect(byId, JSON.stringify(results, null, 1)).toEqual({
      S1: 'bestanden',
      S2: 'bestanden',
      S3: 'bestanden',
      S4a: 'bestanden',
      S4b: 'bestanden',
      S4c: 'bestanden',
      S4d: 'bestanden',
      S4e: 'bestanden',
      S4f: 'bestanden',
      S4j: 'bestanden',
      S5: 'bestanden',
      S5b: 'nicht abbildbar', // kein Diebstahl über den Feed (der Prüfstand sieht die Rahmen nicht)
      S5c: 'bestanden',
      S6: 'nicht bestanden', // wie ohne Server: Historie erst über die Kette
      S6b: 'bestanden',
      S7: 'nicht abbildbar',
      S8: 'bestanden',
      S10a: 'nicht abbildbar', // der Server ist blind: kein durchsetzender Dienst
      S10b: 'nicht abbildbar',
      S10c: 'nicht abbildbar',
    })
  }, 600_000)

  it('Träger-Prüfstand: T-Szenarien über den echten Server', async () => {
    const { rltpBeekemPws } = await import('../src/candidates/pws')
    const results = await runCarrier(rltpBeekemPws)
    const byId = Object.fromEntries(results.map((r) => [r.scenario, r.outcome]))
    expect(byId, JSON.stringify(results, null, 1)).toEqual({
      T1: 'nicht bestanden', // kein Reparaturmechanismus (I12); der Put kam beim Server nie an, der Sender merkte nichts
      T2: 'bestanden',
      T3: 'bestanden',
      T4: 'bestanden',
      T5: 'bestanden',
      T6: 'nicht bestanden', // blind: der Feed ist nicht beglaubigt (D5)
      T12: 'nicht bestanden', // Rahmen im Klartext (#24)
    })
  }, 600_000)

  it('Serverfehler: ein abgewiesener Put bleibt im Ausgang und wird in der nächsten Runde zugestellt', async () => {
    const { rltpBeekemPws } = await import('../src/candidates/pws')
    const c = await rltpBeekemPws()
    const w = new World(c)
    try {
      for (const p of ['alice', 'bob']) await w.device(p, p)
      await w.flush()
      await w.createGroup('alice')
      await w.add('alice', 'bob')
      await w.flush()
      c.pws.faults.refuseNextPut(400) // kein Status aus der Retry-Liste des Clients, damit der Fehler bei uns ankommt
      await w.write('alice', 'erst-abgewiesen')
      // Der Put ist gescheitert: der Rahmen liegt im Ausgang, der Sender weiß es.
      expect(c.status('alice')).toContain('awaiting-transport')
      await w.flush()
      expect(w.read('bob')).toEqual(['erst-abgewiesen'])
      expect(c.status('alice')).not.toContain('ausgang=')
    } finally {
      await c.dispose?.()
    }
  }, 120_000)

  it('Prüfpunkt 3 und 4: was der Server hält, und der Umzug per Export/Import', async () => {
    const { rltpBeekemPws } = await import('../src/candidates/pws')
    const c = await rltpBeekemPws()
    const w = new World(c)
    try {
      for (const p of ['alice', 'bob', 'carol']) await w.device(p, p)
      await w.flush()
      await w.createGroup('alice')
      await w.add('alice', 'bob')
      await w.add('alice', 'carol')
      await w.flush()
      await w.write('alice', 'vor-umzug')
      await w.flush()
      const inv = await c.pws.inventory()
      expect(inv.resources.length).toBeGreaterThan(5)
      // #24: Der Server liest die Rahmen. Personen und Autoritätsoperationen stehen im Klartext; nur Inhalt ist versiegelt.
      const vis = await c.pws.visible()
      expect(vis.persons).toEqual(['alice', 'bob', 'carol', 'group']) // 'group' = Mitsignierer der Genesis
      expect(vis.fields.auth).toContain('op')
      expect(vis.fields.card).toContain('person')
      expect(vis.fields.content).toEqual(['c', 'iv', 'ref', 't', 'tab'])
      expect(inv.resources.every((r) => /^[a-z]+-\d{6}$/.test(r))).toBe(true)
      const moved = await c.pws.moveToNewServer()
      expect(moved.resourcesCreated).toBe(inv.resources.length)
      // Ein neues Gerät liest die Historie vom neuen Server; Schreiben geht weiter.
      await w.device('dave', 'dave')
      await w.flush()
      await w.add('alice', 'dave')
      await w.flush()
      await w.write('bob', 'nach-umzug')
      await w.flush()
      expect(w.read('dave')).toContain('nach-umzug')
      expect(w.read('carol')).toEqual(['nach-umzug', 'vor-umzug'])
      expect(w.members('dave')).toEqual(['alice', 'bob', 'carol', 'dave'])
      if (process.env.PWS_OUT) writeFileSync(process.env.PWS_OUT, JSON.stringify({ inventory: inv, visible: vis, moved, stats: c.pws.stats }, null, 1))
    } finally {
      await c.dispose?.()
    }
  }, 120_000)
})
