import { describe, expect, it } from 'vitest'
import { Signer } from '../src/candidates/rltp-beekem/authority'
import { ViewService, signView, viewHash, type ChallengeAnswer, type ViewProposal } from '../src/candidates/rltp-beekem/service'
import type { Msg } from '../src/lab/types'

// E9 Schritt 2, S10d: der Sichten-Dienst prüft Signaturen und Besitz, nicht
// Behauptungen. Direkt gegen den Dienst, ohne BeeKEM.
const enc = new TextEncoder()
const dec = new TextDecoder()
let nextId = 1
const frame = (from: string, body: unknown): Msg => ({ id: nextId++, from, label: 'x', body: enc.encode(JSON.stringify(body)) })

/** Registriert Geräte mit Karte und beantwortet ihre Challenge. */
function register(svc: ViewService, devices: Record<string, Signer>, answer: (d: string) => boolean = () => true) {
  for (const [d, k] of Object.entries(devices)) {
    expect(svc.accept(frame(d, { t: 'card', person: d, id: `id-${d}`, deviceKey: k.pub }))).toBe('weiter')
    const ch = svc.takeOutgoing().map((o) => JSON.parse(dec.decode(o.body)) as { t: string; to: string; nonce: string }).find((c) => c.t === 'challenge')!
    expect(ch.to).toBe(k.pub)
    if (!answer(d)) continue
    const a: ChallengeAnswer = { t: 'challenge-answer', signer: k.pub, nonce: ch.nonce, sig: k.sign(`challenge|${ch.nonce}`) }
    svc.accept(frame(d, a))
  }
}
const propose = (svc: ViewService, from: string, v: Omit<ViewProposal, 't'>) => svc.accept(frame(from, { t: 'view', ...v }))
const acks = (svc: ViewService) => svc.takeOutgoing().filter((o) => o.label === 'ack').map((o) => JSON.parse(dec.decode(o.body)) as { seq: number })

describe('S10d: Sichten-Dienst prüft Signaturen und Besitz', () => {
  const keys = () => ({ a: Signer.generate('a'), b: Signer.generate('b'), c: Signer.generate('c') })

  it('ohne beantwortete Challenge wird ein Gerät nicht bedient und sein Vorschlag nicht gezählt', () => {
    const svc = new ViewService()
    const k = keys()
    register(svc, k, (d) => d !== 'b')
    const v1 = { seq: 1, prev: null, identities: [k.a.pub, k.b.pub].sort(), m: 2 }
    propose(svc, 'b', { ...v1, sigs: [signView(v1, k.b)] })
    expect(acks(svc)).toHaveLength(0)
    // Auch Schreiben ohne Besitznachweis wird verworfen.
    expect(svc.accept(frame('b', { t: 'content', c: '' }))).toBe('verwerfen')
    expect(svc.accept(frame('a', { t: 'content', c: '' }))).toBe('weiter')
    propose(svc, 'a', { ...v1, sigs: [signView(v1, k.a)] })
    expect(acks(svc).map((x) => x.seq)).toEqual([1])
  })

  it('eine gefälschte Signatur zählt nicht, eine fremde unter eigenem Namen auch nicht', () => {
    const svc = new ViewService()
    const k = keys()
    register(svc, k)
    const v1 = { seq: 1, prev: null, identities: [k.a.pub, k.b.pub].sort(), m: 2 }
    propose(svc, 'a', { ...v1, sigs: [signView(v1, k.a)] })
    expect(acks(svc).map((x) => x.seq)).toEqual([1])
    const v2 = { seq: 2, prev: viewHash(v1), identities: [k.a.pub, k.b.pub, k.c.pub].sort(), m: 2 }
    const good = signView(v2, k.a)
    propose(svc, 'a', { ...v2, sigs: [{ signer: k.a.pub, sig: good.sig.slice(0, -2) + (good.sig.endsWith('00') ? '01' : '00') }] })
    propose(svc, 'b', { ...v2, sigs: [{ signer: k.b.pub, sig: signView(v2, k.c).sig }] })
    expect(acks(svc)).toHaveLength(0)
    expect(svc.status()).toContain('abgelehnte Sichten/Signaturen=2')
    propose(svc, 'a', { ...v2, sigs: [good] })
    propose(svc, 'b', { ...v2, sigs: [signView(v2, k.b)] })
    expect(acks(svc).map((x) => x.seq)).toEqual([2])
  })

  it('Signierer, die nicht in der alten Sicht stehen, zählen nicht (7180); ein Vorschlag kann die alte Sicht nicht überspringen', () => {
    const svc = new ViewService()
    const k = keys()
    register(svc, k)
    const v1 = { seq: 1, prev: null, identities: [k.a.pub, k.b.pub].sort(), m: 2 }
    propose(svc, 'a', { ...v1, sigs: [signView(v1, k.a)] })
    acks(svc)
    // c steht nicht in Sicht 1 und kann Sicht 2 nicht mitsignieren, auch nicht mit korrekter Signatur.
    const v2 = { seq: 2, prev: viewHash(v1), identities: [k.a.pub, k.b.pub, k.c.pub].sort(), m: 2 }
    propose(svc, 'c', { ...v2, sigs: [signView(v2, k.c)] })
    propose(svc, 'a', { ...v2, sigs: [signView(v2, k.a)] })
    expect(acks(svc)).toHaveLength(0)
    // Replay: Sicht 1 noch einmal, oder eine Sicht mit falschem Vorgänger.
    propose(svc, 'a', { ...v1, sigs: [signView(v1, k.a)] })
    propose(svc, 'b', { ...v2, prev: 'falsch', sigs: [signView({ ...v2, prev: 'falsch' }, k.b)] })
    expect(acks(svc)).toHaveLength(0)
    propose(svc, 'b', { ...v2, sigs: [signView(v2, k.b)] })
    expect(acks(svc).map((x) => x.seq)).toEqual([2])
  })

  it('ein zweites Gerät erbt keinen Besitznachweis: derselbe Schlüssel von einem anderen Gerät wird verworfen', () => {
    const svc = new ViewService()
    const k = keys()
    register(svc, k)
    // Gerät "a2" kündigt a's Schlüssel an.
    expect(svc.accept(frame('a2', { t: 'card', person: 'a', id: 'id-a2', deviceKey: k.a.pub }))).toBe('verwerfen')
    expect(svc.takeOutgoing()).toHaveLength(0)
    expect(svc.accept(frame('a2', { t: 'content', c: '' }))).toBe('verwerfen')
    const v1 = { seq: 1, prev: null, identities: [k.a.pub, k.b.pub].sort(), m: 2 }
    propose(svc, 'a2', { ...v1, sigs: [signView(v1, k.a)] })
    expect(acks(svc)).toHaveLength(0)
    expect(svc.status()).toContain('abgelehnte Karten=1')
    // Das echte Gerät a schreibt und schlägt weiter vor.
    expect(svc.accept(frame('a', { t: 'content', c: '' }))).toBe('weiter')
    propose(svc, 'a', { ...v1, sigs: [signView(v1, k.a)] })
    expect(acks(svc).map((x) => x.seq)).toEqual([1])
  })

  it('missgebildete Vorschläge und Antworten werden abgelehnt, nie geworfen', () => {
    const svc = new ViewService()
    const k = keys()
    register(svc, k)
    const v1 = { seq: 1, prev: null, identities: [k.a.pub, k.b.pub].sort(), m: 2 }
    for (const bad of [
      { ...v1, sigs: [null] },
      { ...v1, sigs: [{ signer: k.a.pub }] },
      { ...v1, sigs: 'x' },
      { ...v1, identities: [1, 2] },
      { ...v1, identities: 'x' },
      { ...v1, seq: '1' },
      { ...v1, prev: 5 },
      { ...v1, m: 'zwei' },
    ]) {
      expect(() => propose(svc, 'a', bad as unknown as Omit<ViewProposal, 't'>)).not.toThrow()
      expect(acks(svc)).toHaveLength(0)
    }
    for (const bad of [{ t: 'challenge-answer' }, { t: 'challenge-answer', signer: 1, nonce: null, sig: {} }, { t: 'card' }, { t: 'card', deviceKey: 7 }]) {
      expect(() => svc.accept(frame('z', bad))).not.toThrow()
    }
    propose(svc, 'a', { ...v1, sigs: [signView(v1, k.a)] })
    expect(acks(svc).map((x) => x.seq)).toEqual([1])
  })

  it("S10c': Schrumpfen unter das Quorum — Vorgänger-m friert ein, m der neuen Sicht nicht", () => {
    for (const [rule, expectAck] of [['parent', 0], ['new', 1]] as const) {
      const svc = new ViewService(rule)
      const k = keys()
      register(svc, k)
      const v1 = { seq: 1, prev: null, identities: [k.a.pub, k.b.pub, k.c.pub].sort(), m: 2 }
      propose(svc, 'a', { ...v1, sigs: [signView(v1, k.a)] })
      acks(svc)
      // a und b entfernen sich gegenseitig; nur c bleibt und kann allein signieren.
      const v2 = { seq: 2, prev: viewHash(v1), identities: [k.c.pub], m: 1 }
      propose(svc, 'c', { ...v2, sigs: [signView(v2, k.c)] })
      expect(acks(svc), rule).toHaveLength(expectAck)
      expect(svc.serves('a'), rule).toBe(expectAck === 0)
    }
  })
})
