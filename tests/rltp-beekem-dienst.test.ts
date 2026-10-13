import { describe, expect, it } from 'vitest'
import { runAll } from '../src/lab/scenarios'
import { rltpBeekem } from '../src/candidates/rltp-beekem'
import { BeekemPeer, loadWasm } from '../src/candidates/rltp-beekem/load'
import { Signer } from '../src/candidates/rltp-beekem/authority'
import { targetDigest, targetInput, type Target } from '../src/candidates/rltp-beekem/service'
import { sha256 } from '@noble/hashes/sha2.js'
import { World } from '../src/lab/world'
import type { Msg } from '../src/lab/types'

// E8: durchsetzender, schlüsselblinder Dienst am Relay des Prüfstands, in
// zwei Varianten gegen denselben BeeKEM-Kandidaten. Begründungen in
// src/candidates/rltp-beekem/NOTES.md, Abschnitt E8.
const gemeinsam = {
  S1: 'bestanden',
  S2: 'bestanden',
  S3: 'bestanden',
  S4a: 'bestanden',
  S4b: 'bestanden',
  S4c: 'bestanden',
  S4c2: 'bestanden',
  S4d: 'bestanden',
  S4e: 'bestanden',
  S4j: 'bestanden',
  S4f: 'bestanden',
  S5: 'bestanden',
  S5b: 'bestanden',
  S5c: 'bestanden',
  S6: 'bestanden', // E10: Historie über die Tabellen der versiegelten Autoritätsrahmen
  S6b: 'bestanden',
  S7: 'bestanden',
  S8: 'bestanden',
  S10a: 'bestanden', // Relay verwirft den gleichzeitigen Eintrag des Entfernten: kein Residual
  S10b: 'bestanden', // Sicht veraltet, bis die Entfernung das Relay erreicht; danach verworfen
}

describe('E8: Dienst am Relay', () => {
  it('Variante 1: Sichten (Access 0.56 §7.3, Quorum der Vorgängersicht)', async () => {
    const results = await runAll(() => rltpBeekem({ dienst: 'sichten' }))
    const byId = Object.fromEntries(results.map((r) => [r.scenario, r.outcome]))
    expect(byId, JSON.stringify(results, null, 1)).toEqual({
      ...gemeinsam,
      // Gegenseitige Entfernung lässt nur Carol: m=2 aus der alten Sicht ist nicht mehr
      // erfüllbar, der Dienst bleibt auf der alten Sicht. Das ist der „stated residual“
      // von Access 0.56 §7.3, wie geschrieben (E9 Schritt 2: S10c').
      S10c: 'nicht bestanden',
    })
  }, 120_000)

  it("Variante 1b: Sichten, m folgt der neuen Sicht (Guss-Plan 0.54; S10c')", async () => {
    const results = await runAll(() => rltpBeekem({ dienst: 'sichten', mRule: 'new' }))
    const byId = Object.fromEntries(results.map((r) => [r.scenario, r.outcome]))
    expect(byId, JSON.stringify(results, null, 1)).toEqual({
      ...gemeinsam,
      S10c: 'bestanden',
    })
  }, 120_000)

  it('Variante 2: Log-Replik (Kontrolle)', async () => {
    const results = await runAll(() => rltpBeekem({ dienst: 'logreplik' }))
    const byId = Object.fromEntries(results.map((r) => [r.scenario, r.outcome]))
    expect(byId, JSON.stringify(results, null, 1)).toEqual({
      ...gemeinsam,
      S6: 'nicht bestanden', // Klartextmodus (der Dienst liest das Log): keine Tabellen an den Autoritätsrahmen, Historie erst über die Kette
      S10c: 'bestanden',
    })
  }, 120_000)

  it('#32: Inhalt eines entfernten Geräts, außen als auth deklariert, wirkt beim Empfänger nicht', async () => {
    await loadWasm()
    const c = rltpBeekem({ dienst: 'sichten' })
    const w = new World(c)
    for (const p of ['alice', 'bob', 'carol']) await w.device(p, p)
    await w.flush()
    await w.createGroup('alice')
    await w.add('alice', 'bob')
    await w.add('alice', 'carol')
    await w.flush()
    await w.write('alice', 'vorher')
    await w.flush()
    // Carol sichert ihren Zustand, wird entfernt, und baut mit dem alten Zustand einen frischen Inhalt,
    // außen als Autoritätsrahmen deklariert (der Ausnahmeweg des Dienstes).
    const stolen = (await c.steal('carol')) as { state: Uint8Array }
    await w.remove('alice', 'carol')
    await w.flush()
    expect(c.service!.serves('carol')).toBe(false)
    const peer = BeekemPeer.fromState(stolen.state)
    const enc = new TextEncoder()
    const dec = new TextDecoder()
    const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
    const plain = enc.encode(JSON.stringify({ t: 'content', u: b64(new Uint8Array([1, 2, 3])) }))
    const ref = crypto.getRandomValues(new Uint8Array(32))
    const r = (await peer.encrypt(ref, [], plain)) as { ciphertext: Uint8Array }
    const frame = { t: 'sealed', kind: 'auth', c: b64(r.ciphertext), iv: b64(new Uint8Array(12)), tab: '', ref: Buffer.from(ref).toString('hex'), heads: [], by: 'x' }
    const msg: Msg = { id: 99999, from: 'carol', label: 'auth', body: enc.encode(JSON.stringify(frame)) }
    // Der Dienst lässt Autoritätsrahmen bewiesener Geräte durch (Evidenz); der Empfänger prüft die Art gegen den Inhalt.
    expect(c.service!.accept(msg)).toBe('weiter')
    const before = w.read('alice').length
    const { content } = await c.receive('alice', msg)
    expect(content).toEqual([])
    expect(c.status('alice')).toContain('behauptet auth, enthält content')
    expect(w.read('alice').length).toBe(before)
    void dec
  })

  // Review zu #36: Frische, referenzgenauer Fehlbestand, Kettenprüfung, je als Gegenprobe mit gefälschten Zielen.
  describe('beglaubigtes Ziel: Frische, Fehlbestand, Kette', () => {
    const enc = new TextEncoder()
    const dec = new TextDecoder()
    async function device() {
      await loadWasm()
      const c = rltpBeekem({ dienst: 'sichten' })
      await c.addDevice('carol', 'carol')
      const card = JSON.parse(dec.decode(c.takeOutgoing('carol')[0]!.body)) as { deviceKey: string }
      await c.createGroup('carol')
      c.takeOutgoing('carol')
      const dienst = Signer.generate('dienst')
      let id = 1
      const poll = () => {
        c.poll!('carol')
        const req = c.takeOutgoing('carol').map((o) => JSON.parse(dec.decode(o.body)) as { t: string; nonce?: string }).find((m) => m.t === 'target-request')!
        return req.nonce!
      }
      const target = (fields: Partial<Omit<Target, 'sig'>> & { seq: number; echo: string }): Target => {
        const body: Omit<Target, 'sig'> = { t: 'target', v: 'rltp-replication-target/0.26', source: 'dienst', chain: null, frontier: { scope: 'stored', heads: [] }, prev: null, attestationKey: dienst.pub, to: card.deviceKey, ...fields }
        return { ...body, sig: dienst.sign(targetInput(body)) }
      }
      const bytes = (m: unknown) => enc.encode(JSON.stringify(m))
      const digest = (m: unknown) => Array.from(sha256(bytes(m)), (x) => x.toString(16).padStart(2, '0')).join('')
      const deliver = (m: unknown) => c.receive('carol', { id: id++, from: 'dienst', label: 'target', body: bytes(m) })
      return { c, poll, target, deliver, digest }
    }

    it('ein altes, gültig signiertes Ziel beantwortet keine neue Anfrage (Wiederholung)', async () => {
      const { c, poll, target, deliver } = await device()
      const t1 = target({ seq: 1, echo: poll() })
      await deliver(t1)
      expect(c.status('carol')).toContain('ziel=seq 1 (0 fehlen, 0 geholt)')
      poll()
      expect(c.status('carol')).toContain('ziel=angefragt, keine Antwort (zuletzt seq 1)')
      await deliver(t1)
      expect(c.status('carol')).toContain('ziel=angefragt, keine Antwort (zuletzt seq 1)')
    })

    it('nur die byte-identische Kopie eines Eintrags des Ziels trägt den Fehlbestand aus; Entschlüsselung entscheidet nichts darüber', async () => {
      const { c, poll, target, deliver, digest } = await device()
      // Ein Eintrag, dessen Bytes der Dienst beglaubigt (Digest der Bytes), hier Carols eigener.
      await c.sealContent('carol', new Uint8Array([1, 2, 3]))
      const real = c.takeOutgoing('carol').map((o) => JSON.parse(dec.decode(o.body)) as { t: string; ref?: string }).find((m) => m.t === 'sealed')!
      await deliver(target({ seq: 1, echo: poll(), frontier: { scope: 'stored', heads: [digest(real)] } }))
      expect(c.status('carol')).toContain('ziel=seq 1 (1 fehlen, 0 geholt)')
      // Fremder Verkehr zählt nicht, und eine beschädigte Kopie mit derselben Referenz hat andere Bytes: zählt nicht.
      await deliver({ t: 'sealed', kind: 'content', c: 'AAAA', iv: 'AAAAAAAAAAAAAAAA', tab: '', ref: 'other', heads: [], by: 'x' })
      await deliver({ ...real, c: 'AAAA' })
      expect(c.status('carol')).toContain('ziel=seq 1 (1 fehlen, 0 geholt)')
      await deliver(real)
      expect(c.status('carol')).toContain('ziel=seq 1 (0 fehlen, 1 geholt)')
    })

    it('eine beschädigte Kopie gilt nicht als nachgeliefert; der nächste Tick holt erneut, und die richtige Kopie wird trotz der beschädigten geöffnet', async () => {
      const { c, poll, target, deliver, digest } = await device()
      await c.sealContent('carol', new Uint8Array([4, 5, 6]))
      const real = c.takeOutgoing('carol').map((o) => JSON.parse(dec.decode(o.body)) as { t: string; ref?: string; c: string }).find((m) => m.t === 'sealed')!
      const wanted = digest(real)
      const t1 = target({ seq: 1, echo: poll(), frontier: { scope: 'stored', heads: [wanted] } })
      await deliver(t1)
      expect(c.status('carol')).toContain('ziel=seq 1 (1 fehlen, 0 geholt)')
      await deliver({ ...real, c: 'AAAA' + real.c.slice(4) })
      expect(c.status('carol')).toContain('ziel=seq 1 (1 fehlen, 0 geholt)')
      const { sig: _s, ...body1 } = t1
      const d1 = targetDigest(body1)
      const n2 = poll()
      await deliver(target({ seq: 2, echo: n2, prev: d1, chain: d1, frontier: { scope: 'stored', heads: [wanted] } }))
      expect(c.status('carol')).toContain('ziel=seq 2 (1 fehlen, 0 geholt)')
      const fetch = c.takeOutgoing('carol').map((o) => JSON.parse(dec.decode(o.body)) as { t: string; refs?: string[] }).find((m) => m.t === 'fetch')
      expect(fetch?.refs).toEqual([wanted])
      // Die richtige Kopie wird geöffnet, obwohl die beschädigte mit derselben Referenz vorher kam.
      const { content } = await deliver(real)
      expect(content.length).toBe(1)
      expect(c.status('carol')).toContain('ziel=seq 2 (0 fehlen, 1 geholt)')
    })

    it('durchgängig: vorgehalten, beschädigt geliefert, richtig nachgeliefert, wiederhergestellt', async () => {
      const c = rltpBeekem({ dienst: 'sichten' })
      const w = new World(c)
      for (const p of ['alice', 'bob', 'carol']) await w.device(p, p)
      await w.flush()
      await w.createGroup('alice')
      await w.add('alice', 'bob')
      await w.add('alice', 'carol')
      await w.flush()
      const k = w.carrier()!
      // Der Träger hält Carol Alices Inhalt und jede Nachlieferung des Dienstes vor und liefert ihr stattdessen eine beschädigte Kopie.
      k.withhold('carol', (m) => (m.from === 'alice' && m.label === 'content') || m.label === 'fetch-answer')
      await w.write('alice', 'wichtig')
      await w.flush()
      const frame = w.log.find((m) => m.from === 'alice' && m.label === 'content')!
      const damaged = JSON.parse(new TextDecoder().decode(frame.body)) as { c: string }
      damaged.c = 'AAAA' + damaged.c.slice(4)
      await c.receive('carol', { id: 99999, from: 'alice', label: 'content', body: new TextEncoder().encode(JSON.stringify(damaged)) })
      expect(w.read('carol')).toEqual([])
      // Zustellung wiederhergestellt: der nächste Tick fragt das Ziel, der Dienst liefert die richtigen Bytes.
      k.reset()
      await w.flush()
      expect(w.read('carol')).toEqual(['wichtig'])
      expect(c.status('carol')).toMatch(/ziel=seq \d+ \(0 fehlen, [1-9]\d* geholt\)/)
    })

    it('ein Ziel mit falschem prev oder chain wird nicht als nächstes Glied angenommen', async () => {
      const { c, poll, target, deliver } = await device()
      const t1 = target({ seq: 1, echo: poll() })
      await deliver(t1)
      const { sig: _s, ...body1 } = t1
      const d1 = targetDigest(body1)
      const n2 = poll()
      await deliver(target({ seq: 2, echo: n2, prev: 'wrong-prev', chain: 'wrong-chain' }))
      expect(c.status('carol')).toContain('ziel=angefragt, keine Antwort (zuletzt seq 1)')
      expect(c.status('carol')).toContain('prev oder chain passen nicht')
      await deliver(target({ seq: 3, echo: n2, prev: d1, chain: d1 }))
      expect(c.status('carol')).toContain('Kette unterbrochen')
      await deliver(target({ seq: 2, echo: n2, prev: d1, chain: d1 }))
      expect(c.status('carol')).toContain('ziel=seq 2 (0 fehlen, 0 geholt)')
    })
  })
})
