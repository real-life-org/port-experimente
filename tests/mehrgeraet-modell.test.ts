import { describe, expect, it } from 'vitest'
import * as M from '../src/lab/mehrgeraet/model'

// E15 Sollmodell: die Faltung als Wert (Tor-Review 3, B1, B2, B5).
//   B1 Eine Operation wirkt ganz oder gar nicht; eine fehlende Voraussetzung ist
//      `Missing`, der Zustand bleibt unberührt, die Operation gilt nicht als angewandt.
//   B2 Reihenfolgeunabhängig, wo zulässig; sonst sichtbarer Konflikt:
//      Sicht monoton (8500), Budgetbestätigung mit Akt-Ids (8515), Schlüsselidentität
//      (Nonce, n) mit Finding „zweiter Vorrat“ (8435), Vereinigung führt Bestätigungen zusammen.
//      Entscheidung und Übergabe: K1a Schritt 3 (unten), Regeln 1–3 nach Anton 18.10.2026.
//   B5 Die Projektion unterscheidet, was handlungsrelevant ist (Schlüsselinhalt der Sicht).

const t0 = '2026-10-17T08:00:00.000Z'
let n = 0
type OpBody = M.Op extends infer O ? (O extends M.Op ? Omit<O, 'id' | 'at'> : never) : never
const op = (body: OpBody, writer = 'w'): M.Op => ({ id: { writer, n: ++n }, at: t0, ...body }) as unknown as M.Op

const tuple = (id: string, own: string, peer: string): M.Tuple => ({ id, own, ownKey: `k/${own}`, peer, peerKeyAgreement: `rk/${peer}`, record: `${id}:${own}`, openedAt: t0, candidates: [], deactivated: false })
const key = (nonce: string, i: number, anchor = `${nonce}-${i}`): M.StockKey => ({ n: i, nonce, anchor, keyAgreement: `rk/${anchor}`, key: `introduction/${nonce}/${i}`, expiresAt: '2027-04-15T08:00:00.000Z', state: 'active' })
const actOf = (id: string, mediator: string, own: string): M.Act => ({ id, mediator, own, voucher: { anchor: 'V', keyAgreement: 'rk/V', name: 'B' }, issuedAt: t0, expiresAt: '2026-10-24T08:00:00.000Z', state: 'offered', pending: null, v: null, k: false, ownCard: null, ownCardKey: null, o: 'none', ownCardDigest: null, opened: null })

function withRel(): M.HolderState {
  const s = M.emptyState('A')
  M.apply(s, op({ kind: 'open-tuple', rel: null, tuple: tuple('A:e1', 'a1', 'm1'), provenance: 'encounter', vouchedBy: null, act: null }))
  return s
}

describe('B1: ganz oder gar nicht', () => {
  it('ticket-accept auf eine unbekannte Beziehung wirft Missing, lässt den Zustand unberührt und gilt nicht als angewandt; nach open-tuple wirkt dieselbe Operation vollständig', () => {
    const s = M.emptyState('A')
    const accept = op({ kind: 'ticket-accept', act: actOf('act1', 'A:e1', 'a1-1') })
    const before = structuredClone(s)
    expect(() => M.apply(s, accept)).toThrow(M.Missing)
    expect(s).toEqual(before)
    expect(s.acts).toEqual([])
    M.apply(s, op({ kind: 'open-tuple', rel: null, tuple: tuple('A:e1', 'a1', 'm1'), provenance: 'encounter', vouchedBy: null, act: null }))
    M.apply(s, op({ kind: 'allocate', rel: 'A:e1', nonce: 'n1', keys: [key('n1', 1, 'a1-1')] }))
    M.apply(s, accept)
    expect(s.acts.length).toBe(1)
    expect(M.rel(s, 'A:e1').accepted.map((e) => e.act)).toEqual(['act1'])
    expect(M.rel(s, 'A:e1').stock[0]!.state).toBe('consumed')
    expect(s.effects.some((e) => e.id === 'accept:act1')).toBe(true)
  })

  it('open-tuple mit Akt-Bezug auf einen unbekannten Akt fügt auch das Tupel nicht ein', () => {
    const s = M.emptyState('A')
    expect(() => M.apply(s, op({ kind: 'open-tuple', rel: null, tuple: tuple('A:x', 'a9', 'b9'), provenance: 'introduction', vouchedBy: null, act: 'nope' }))).toThrow(M.Missing)
    expect(s.relationships).toEqual([])
    expect(s.applied).toEqual([])
  })
})

describe('B1 (Review 4): Vereinigung und Kante ohne Vorgänger', () => {
  it('union auf unbekannte Beziehungen wirft Missing und gilt nicht als angewandt; nach beiden open-tuple vereinigt dieselbe Operation', () => {
    const s = M.emptyState('A')
    const u = op({ kind: 'union', a: 'A:e1', b: 'A:e2', edge: ['A:e1', 'A:e2'] })
    expect(() => M.apply(s, u)).toThrow(M.Missing)
    expect(s.edges).toEqual([])
    expect(s.applied).toEqual([])
    M.apply(s, op({ kind: 'open-tuple', rel: null, tuple: tuple('A:e1', 'a1', 'b1'), provenance: 'encounter', vouchedBy: null, act: null }))
    expect(() => M.apply(s, u)).toThrow(M.Missing)
    M.apply(s, op({ kind: 'open-tuple', rel: null, tuple: tuple('A:e2', 'a2', 'b2'), provenance: 'encounter', vouchedBy: null, act: null }))
    M.apply(s, u)
    expect(s.relationships.length).toBe(1)
    expect(s.edges).toEqual([['A:e1', 'A:e2']])
    // Wiederholung unter neuer Operations-ID: schon vereinigt, kein Fehler, nichts Neues.
    M.apply(s, op({ kind: 'union', a: 'A:e1', b: 'A:e2', edge: ['A:e1', 'A:e2'] }, 'other'))
    expect(s.relationships.length).toBe(1)
  })
  it('edge auf ein unbekanntes Tupel wirft Missing, auch wenn nur das zweite fehlt', () => {
    const s = M.emptyState('A')
    expect(() => M.apply(s, op({ kind: 'edge', edge: ['A:x', 'A:y'] }))).toThrow(M.Missing)
    expect(s.edges).toEqual([])
    M.apply(s, op({ kind: 'open-tuple', rel: null, tuple: tuple('A:x', 'ax', 'bx'), provenance: 'encounter', vouchedBy: null, act: null }))
    expect(() => M.apply(s, op({ kind: 'edge', edge: ['A:x', 'A:y'] }))).toThrow(M.Missing)
    expect(s.edges).toEqual([])
    expect(s.applied.length).toBe(1)
  })
})

describe('B2: Reihenfolge und Konflikte', () => {
  const views = (order: number[]) => {
    const s = withRel()
    const v1 = op({ kind: 'view', rel: 'A:e1', scope: 'A:e1', revision: 1, keys: [{ n: 1, anchor: 'k1', keyAgreement: 'r1', expiresAt: t0 }] })
    const v2 = op({ kind: 'view', rel: 'A:e1', scope: 'A:e1', revision: 2, keys: [{ n: 1, anchor: 'k2', keyAgreement: 'r2', expiresAt: t0 }] })
    for (const i of order) M.apply(s, i === 1 ? v1 : v2)
    return M.rel(s, 'A:e1').view!
  }
  it('Sicht: die höhere Revision gewinnt in jeder Reihenfolge (8500)', () => {
    expect(views([1, 2]).revision).toBe(2)
    expect(views([2, 1]).revision).toBe(2)
    expect(views([2, 1]).keys[0]!.anchor).toBe('k2')
  })
  it('Sicht: gleiche Revision, andere Schlüssel ist eine Equivokation (6270): Finding, deterministisches Ergebnis in beiden Reihenfolgen', () => {
    const run = (order: number[]) => {
      const s = withRel()
      const a = op({ kind: 'view', rel: 'A:e1', scope: 'A:e1', revision: 3, keys: [{ n: 1, anchor: 'ka', keyAgreement: 'ra', expiresAt: t0 }] })
      const b = op({ kind: 'view', rel: 'A:e1', scope: 'A:e1', revision: 3, keys: [{ n: 1, anchor: 'kb', keyAgreement: 'rb', expiresAt: t0 }] })
      for (const i of order) M.apply(s, i === 1 ? a : b)
      return s
    }
    const x = run([1, 2])
    const y = run([2, 1])
    expect(x.findings.some((f) => f.includes('6270'))).toBe(true)
    expect(M.canonical(M.rel(x, 'A:e1').view)).toBe(M.canonical(M.rel(y, 'A:e1').view))
  })

  it('Sicht: die Schlüsselmenge wird kanonisch gehalten, die Ankunftsreihenfolge der Schlüssel ist nicht handlungswirksam', () => {
    const run = (anchors: string[]) => {
      const s = withRel()
      M.apply(s, op({ kind: 'view', rel: 'A:e1', scope: 'A:e1', revision: 1, keys: anchors.map((a) => ({ n: a === 'ka' ? 1 : 2, anchor: a, keyAgreement: `r${a}`, expiresAt: t0 })) }))
      return M.rel(s, 'A:e1').view!
    }
    expect(run(['kb', 'ka']).keys.map((k) => k.anchor)).toEqual(['ka', 'kb'])
    expect(M.canonical(run(['kb', 'ka']))).toBe(M.canonical(run(['ka', 'kb'])))
  })
  it('Sicht: gleiche Anker, anderer Ablauf ist eine andere Sicht (Equivokation, nicht Wiederholung)', () => {
    const s = withRel()
    M.apply(s, op({ kind: 'view', rel: 'A:e1', scope: 'A:e1', revision: 1, keys: [{ n: 1, anchor: 'ka', keyAgreement: 'ra', expiresAt: '2026-10-18T08:00:00.000Z' }] }))
    M.apply(s, op({ kind: 'view', rel: 'A:e1', scope: 'A:e1', revision: 1, keys: [{ n: 1, anchor: 'ka', keyAgreement: 'ra', expiresAt: '2027-01-01T08:00:00.000Z' }] }))
    expect(s.findings.some((f) => f.includes('6270'))).toBe(true)
  })

  it('Budgetbestätigung trägt die bestätigten Akt-Ids: eine spätere Annahme zählt in jeder Reihenfolge (8515)', () => {
    const run = (order: string[]) => {
      const s = withRel()
      M.apply(s, op({ kind: 'allocate', rel: 'A:e1', nonce: 'n1', keys: [key('n1', 1), key('n1', 2)] }))
      const ops: Record<string, M.Op> = {
        a1: op({ kind: 'ticket-accept', act: actOf('act1', 'A:e1', 'n1-1') }),
        confirm: op({ kind: 'budget-confirm', rel: 'A:e1', acts: ['act1'] }),
        a2: op({ kind: 'ticket-accept', act: actOf('act2', 'A:e1', 'n1-2') }),
      }
      for (const k of order) M.apply(s, ops[k]!)
      return M.budgetUsed(M.rel(s, 'A:e1'), t0)
    }
    expect(run(['a1', 'confirm', 'a2'])).toBe(1)
    expect(run(['a1', 'a2', 'confirm'])).toBe(1)
    expect(run(['confirm', 'a1', 'a2'])).toBe(1)
  })

  it('Schlüsselidentität ist (Nonce, n): ein zweiter Vorrat mit anderer Nonce bleibt sichtbar und wird gemeldet (8435)', () => {
    const s = withRel()
    M.apply(s, op({ kind: 'allocate', rel: 'A:e1', nonce: 'n1', keys: [key('n1', 1), key('n1', 2)] }, 'A1@1'))
    M.apply(s, op({ kind: 'allocate', rel: 'A:e1', nonce: 'n2', keys: [key('n2', 1), key('n2', 2)] }, 'A2@1'))
    const r = M.rel(s, 'A:e1')
    expect(r.stock.length).toBe(4)
    expect(r.nonce).toBe('n1')
    expect(s.findings.some((f) => f.includes('8435'))).toBe(true)
    // Dieselbe Zuteilung noch einmal (Journal-Wiederholung unter anderer Operations-ID): nichts Neues.
    M.apply(s, op({ kind: 'allocate', rel: 'A:e1', nonce: 'n1', keys: [key('n1', 1), key('n1', 2)] }, 'A1@2'))
    expect(r.stock.length).toBe(4)
  })

  it('Verbindung nach Ablehnung: der terminale Zustand bleibt, der Widerspruch steht im Ledger (8325.A3, K1a X3)', () => {
    const s = withRel()
    M.apply(s, op({ kind: 'allocate', rel: 'A:e1', nonce: 'n1', keys: [key('n1', 1)] }))
    M.apply(s, op({ kind: 'ticket-accept', act: actOf('act1', 'A:e1', 'n1-1') }))
    M.apply(s, op({ kind: 'decline', act: 'act1' }, 'A2@1'))
    M.apply(s, op({ kind: 'connect', act: 'act1', rel: 'A:act:act1', tuple: tuple('A:act:act1', 'c', 'v') }, 'A1@1'))
    expect(M.act(s, 'act1').state).toBe('declined')
    expect(s.relationships.length).toBe(1)
    expect(s.effects.some((e) => e.id === 'conflict:connect:act1')).toBe(true)
    expect(s.effects.some((e) => e.id === 'connect:act1')).toBe(false)
    expect(s.findings.some((f) => f.includes('8325.A3'))).toBe(true)
  })

  it('Vereinigung führt die bestätigten Annahmen beider Teile zusammen', () => {
    const s = M.emptyState('A')
    M.apply(s, op({ kind: 'open-tuple', rel: null, tuple: tuple('A:e1', 'a1', 'm1'), provenance: 'encounter', vouchedBy: null, act: null }))
    M.apply(s, op({ kind: 'open-tuple', rel: null, tuple: tuple('A:e2', 'a2', 'm2'), provenance: 'encounter', vouchedBy: null, act: null }))
    M.apply(s, op({ kind: 'allocate', rel: 'A:e1', nonce: 'n1', keys: [key('n1', 1)] }))
    M.apply(s, op({ kind: 'allocate', rel: 'A:e2', nonce: 'n2', keys: [key('n2', 1)] }))
    M.apply(s, op({ kind: 'ticket-accept', act: actOf('act1', 'A:e1', 'n1-1') }))
    M.apply(s, op({ kind: 'ticket-accept', act: actOf('act2', 'A:e2', 'n2-1') }))
    M.apply(s, op({ kind: 'budget-confirm', rel: 'A:e1', acts: ['act1'] }))
    M.apply(s, op({ kind: 'budget-confirm', rel: 'A:e2', acts: ['act2'] }))
    M.apply(s, op({ kind: 'union', a: 'A:e1', b: 'A:e2', edge: ['A:e1', 'A:e2'] }))
    expect(s.relationships.length).toBe(1)
    const r = s.relationships[0]!
    expect([...r.confirmed].sort()).toEqual(['act1', 'act2'])
    expect(M.budgetUsed(r, t0)).toBe(0)
  })
})

describe('B5: Projektion', () => {
  it('zwei Sichten mit gleicher Revision und Schlüsselzahl, aber anderen Schlüsseln, sind verschieden', () => {
    const a = withRel()
    const b = withRel()
    M.apply(a, op({ kind: 'view', rel: 'A:e1', scope: 'A:e1', revision: 1, keys: [{ n: 1, anchor: 'ka', keyAgreement: 'ra', expiresAt: t0 }] }))
    M.apply(b, op({ kind: 'view', rel: 'A:e1', scope: 'A:e1', revision: 1, keys: [{ n: 1, anchor: 'kb', keyAgreement: 'rb', expiresAt: t0 }] }))
    expect(M.canonical(M.project(a, t0))).not.toBe(M.canonical(M.project(b, t0)))
  })
  it('zwei Sichten mit gleichen Ankern, aber anderem Ablauf, sind verschieden (nutzbar heute: nein/ja)', () => {
    const a = withRel()
    const b = withRel()
    M.apply(a, op({ kind: 'view', rel: 'A:e1', scope: 'A:e1', revision: 1, keys: [{ n: 1, anchor: 'ka', keyAgreement: 'ra', expiresAt: '2026-10-18T08:00:00.000Z' }] }))
    M.apply(b, op({ kind: 'view', rel: 'A:e1', scope: 'A:e1', revision: 1, keys: [{ n: 1, anchor: 'ka', keyAgreement: 'ra', expiresAt: '2027-01-01T08:00:00.000Z' }] }))
    expect(M.usable('2026-10-18T08:00:00.000Z', t0)).toBe(false)
    expect(M.usable('2027-01-01T08:00:00.000Z', t0)).toBe(true)
    expect(M.canonical(M.project(a, t0))).not.toBe(M.canonical(M.project(b, t0)))
  })
  it('Nonce, Nummernstand, Annahmen und Bestätigungen sind Teil der Projektion', () => {
    const a = withRel()
    const b = withRel()
    M.apply(a, op({ kind: 'allocate', rel: 'A:e1', nonce: 'n1', keys: [key('n1', 1)] }))
    M.apply(b, op({ kind: 'allocate', rel: 'A:e1', nonce: 'n1', keys: [key('n1', 1)] }))
    expect(M.canonical(M.project(a, t0))).toBe(M.canonical(M.project(b, t0)))
    M.apply(b, op({ kind: 'ticket-accept', act: actOf('act1', 'A:e1', 'n1-1') }))
    M.apply(b, op({ kind: 'budget-confirm', rel: 'A:e1', acts: ['act1'] }))
    M.apply(a, op({ kind: 'ticket-accept', act: actOf('act1', 'A:e1', 'n1-1') }))
    expect(M.budgetUsed(M.rel(a, 'A:e1'), t0)).toBe(1)
    expect(M.budgetUsed(M.rel(b, 'A:e1'), t0)).toBe(0)
    expect(M.canonical(M.project(a, t0))).not.toBe(M.canonical(M.project(b, t0)))
  })
})

describe('K1a Schritt 2: nebenläufige Vereinigung über eigene Tupel', () => {
  const base = () => {
    const s = M.emptyState('A')
    M.apply(s, op({ kind: 'open-tuple', rel: null, tuple: tuple('A:e1', 'a1', 'b1'), provenance: 'encounter', vouchedBy: null, act: null }, 'A1@x'))
    M.apply(s, op({ kind: 'open-tuple', rel: null, tuple: tuple('A:e2', 'a2', 'b2'), provenance: 'encounter', vouchedBy: null, act: null }, 'A2@y'))
    return s
  }
  it('zwei Geräte vereinigen über dieselbe Kante: eine Vereinigung, die Wirkung trägt in jeder Reihenfolge die kanonisch kleinste Operation (6230)', () => {
    const u1 = op({ kind: 'union', a: 'A:e1', b: 'A:e2', edge: ['A:e1', 'A:e2'] }, 'A1@x')
    const u2 = op({ kind: 'union', a: 'A:e2', b: 'A:e1', edge: ['A:e1', 'A:e2'] }, 'A2@y')
    const s1 = base()
    const s2 = base()
    M.apply(s1, u1)
    M.apply(s1, u2)
    M.apply(s2, u2)
    M.apply(s2, u1)
    for (const s of [s1, s2]) {
      expect(s.relationships.length).toBe(1)
      expect(s.effects.filter((e) => e.id.startsWith('union:'))).toEqual([{ id: 'union:A:e1+A:e2', op: M.opKey(u1.id), at: t0 }])
    }
    expect(M.canonical(M.project(s1, t0))).toBe(M.canonical(M.project(s2, t0)))
  })
  it('zwei Geräte erreichen dieselbe Pflicht `united` mit je eigenem Mapping: der Digest ist in jeder Reihenfolge der kleinste (6845.9 bleibt final)', () => {
    const pair: [string, string] = ['A:e1', 'A:e2']
    const d1 = op({ kind: 'duty', pair, state: 'united', mappingDigest: 'd-b' }, 'A1@x')
    const d2 = op({ kind: 'duty', pair, state: 'united', mappingDigest: 'd-a' }, 'A2@y')
    const late = op({ kind: 'duty', pair, state: 'hit', mappingDigest: 'd-0' }, 'A2@y')
    const s1 = base()
    const s2 = base()
    for (const o of [d1, d2, late]) M.apply(s1, o)
    for (const o of [late, d2, d1]) M.apply(s2, o)
    for (const s of [s1, s2]) expect(M.project(s, t0).duties['A:e1|A:e2']).toEqual({ state: 'united', mappingDigest: 'd-a' })
  })
})

// K1a Schritt 3 (Anton 18.10.2026, Linie „weich“): Faltungsregeln für Entscheidung und Übergabe.
//   Regel 1: dieselbe Entscheidung von zwei Geräten ist eine Wirkung (kleinste Operation).
//   Regel 2: Zustimmung gegen Ablehnung: eingereichte eigene Karte (8325.0) → Zustimmung gilt, Ablehnung ist Konflikt;
//            sonst gilt die Ablehnung, die Zustimmung ist Konflikt (8232.2, 8765).
//   Regel 3: zwei Übergaben eines Akts: die kleinere Kennung gewinnt; O je Übergabe.
// Jede Reihenfolge, die die Ordnung je Schreiber wahrt (das Journal sichert sie über die Köpfe), ergibt dieselbe
// Projektion und dieselben Wirkungen; doppelt angewandte Operationen ändern nichts.
describe('K1a Schritt 3: Entscheidung und Übergabe', () => {
  const card = { anchor: 'card-a', keyAgreement: 'rk/card-a' }
  const base = () => {
    const s = withRel()
    M.apply(s, op({ kind: 'allocate', rel: 'A:e1', nonce: 'n1', keys: [key('n1', 1)] }, 'A0@0'))
    M.apply(s, op({ kind: 'ticket-accept', act: actOf('act1', 'A:e1', 'n1-1') }, 'A0@0'))
    return s
  }
  const consent = (w: string) => op({ kind: 'consent', act: 'act1', card, cardKey: 'card/act1/A' }, w)
  const decline = (w: string) => op({ kind: 'decline', act: 'act1' }, w)
  const handOver = (w: string, o: M.HandOver, digest: string) => op({ kind: 'hand-over', act: 'act1', o, digest }, w)
  /** Alle Verschränkungen zweier Folgen, die die Reihenfolge innerhalb jeder Folge wahren. */
  const interleavings = (a: M.Op[], b: M.Op[]): M.Op[][] => (!a.length ? [b] : !b.length ? [a] : [...interleavings(a.slice(1), b).map((r) => [a[0]!, ...r]), ...interleavings(a, b.slice(1)).map((r) => [b[0]!, ...r])])
  const fold = (ops: M.Op[], twice = false) => {
    const s = base()
    for (const o of ops) {
      M.apply(s, o)
      if (twice) M.apply(s, o) // Duplikat derselben Operation
    }
    return s
  }
  const actEffects = (s: M.HolderState) => s.effects.filter((e) => e.id.includes('act1') && !e.id.startsWith('accept:')).map((e) => `${e.id}@${e.op}`).sort()
  /** Faltet jede Verschränkung (einfach und mit Duplikaten), prüft gleiche Projektion und gleiche Wirkungen, liefert eine. */
  const allOrders = (a: M.Op[], b: M.Op[]) => {
    const runs = interleavings(a, b).flatMap((o) => [fold(o), fold(o, true), fold([...o, ...o])])
    const p0 = M.canonical(M.project(runs[0]!, t0))
    const e0 = actEffects(runs[0]!)
    for (const s of runs) {
      expect(M.canonical(M.project(s, t0))).toBe(p0)
      expect(actEffects(s)).toEqual(e0)
    }
    expect(runs.length).toBeGreaterThan(3)
    return runs[0]!
  }

  it('Regel 1: zwei Zustimmungen sind eine Entscheidung und eine Wirkung (kleinste Operation), in jeder Reihenfolge', () => {
    const c1 = consent('A1@x')
    const c2 = consent('A2@y')
    const s = allOrders([c1], [c2])
    expect(M.act(s, 'act1').state).toBe('consented')
    expect(actEffects(s)).toEqual([`consent:act1@${M.opKey(c1.id)}`])
    expect(M.act(s, 'act1').o).toBe('intent')
  })
  it('Regel 1: zwei Ablehnungen sind eine Entscheidung und eine Wirkung, in jeder Reihenfolge; nichts gesendet, P verdeckt', () => {
    const d1 = decline('A1@x')
    const d2 = decline('A2@y')
    const s = allOrders([d1], [d2])
    expect(M.act(s, 'act1').state).toBe('declined')
    expect(actEffects(s)).toEqual([`decline:act1@${M.opKey(d1.id)}`])
    expect(M.project(s, t0).acts.act1!.pending).toBeNull()
  })
  it('Regel 2: Zustimmung mit übergebener, nicht eingereichter Karte gegen Ablehnung: die Ablehnung gilt, die Zustimmung ist Konflikt, in jeder Reihenfolge', () => {
    const c1 = consent('A1@x')
    const h1 = handOver('A1@x', 'handed', 'dA')
    const d2 = decline('A2@y')
    const s = allOrders([c1, h1], [d2])
    expect(M.act(s, 'act1').state).toBe('declined')
    expect(actEffects(s)).toEqual([`conflict:consent:act1@${M.opKey(c1.id)}`, `decline:act1@${M.opKey(d2.id)}`])
    expect(s.findings.filter((f) => f.includes('Regel 2') && f.includes('Ablehnung gilt')).length).toBe(1)
    // Die Rücknahme der Karte (Holder, nach dem Falten der Ablehnung) ist eine weitere Operation des erzeugenden Geräts.
    const x1 = handOver('A1@x', 'cancelled', 'dA')
    const t = allOrders([c1, h1, x1], [d2])
    expect(M.project(t, t0).acts.act1).toMatchObject({ state: 'declined', o: 'cancelled', ownCardDigest: 'dA' })
  })
  it('Regel 2: Zustimmung mit eingereichter Karte (O = taken) gegen Ablehnung: die Zustimmung gilt, die Ablehnung ist Konflikt, in jeder Reihenfolge', () => {
    const c1 = consent('A1@x')
    const h1 = handOver('A1@x', 'handed', 'dA')
    const t1 = handOver('A1@x', 'taken', 'dA')
    const d2 = decline('A2@y')
    const s = allOrders([c1, h1, t1], [d2])
    expect(M.act(s, 'act1').state).toBe('consented')
    expect(actEffects(s)).toEqual([`card:act1:card-a@${M.opKey(t1.id)}`, `conflict:decline:act1@${M.opKey(d2.id)}`, `consent:act1@${M.opKey(c1.id)}`])
    expect(s.findings.filter((f) => f.includes('Regel 2') && f.includes('Zustimmung gilt')).length).toBe(1)
    // Ausdrücklich: erst die Ablehnung, dann Zustimmung und Einreichung (die Faltung verlässt `declined`).
    const late = fold([d2, c1, h1, t1])
    expect(M.act(late, 'act1').state).toBe('consented')
    // Dieselben Operationen ohne Einreichung: die Ablehnung gilt.
    expect(M.act(fold([d2, c1, h1]), 'act1').state).toBe('declined')
  })
  it('Regel 2: eine wartende Gegenkarte bleibt unter einer vorläufigen Ablehnung erhalten und gilt wieder, wenn die Einreichung die Zustimmung entscheidet (8325.A5c)', () => {
    const c1 = consent('A1@x')
    const p1 = op({ kind: 'card-pending', act: 'act1', card: { anchor: 'cb', keyAgreement: 'rk/cb' }, v: 'v1' }, 'A1@x')
    const h1 = handOver('A1@x', 'handed', 'dA')
    const t1 = handOver('A1@x', 'taken', 'dA')
    const d2 = decline('A2@y')
    const s = fold([c1, p1, h1, d2])
    expect(M.project(s, t0).acts.act1!.pending).toBeNull()
    M.apply(s, t1)
    expect(M.project(s, t0).acts.act1).toMatchObject({ state: 'consented', pending: { anchor: 'cb' }, o: 'taken' })
  })
  it('Regel 3: zwei Übergaben eines Akts: die kleinere Kennung gewinnt auf jedem Gerät, O je Übergabe, eine Kartenwirkung, in jeder Reihenfolge', () => {
    const c1 = consent('A1@x')
    const h1 = handOver('A1@x', 'handed', 'dB')
    const c2 = consent('A2@y')
    const h2 = handOver('A2@y', 'handed', 'dA')
    const s = allOrders([c1, h1], [c2, h2])
    expect(M.project(s, t0).acts.act1).toMatchObject({ state: 'consented', o: 'handed', ownCardDigest: 'dA' })
    expect(M.act(s, 'act1').cards).toEqual({ dA: 'handed', dB: 'handed' })
    // Die verlierende Übergabe wird zurückgenommen (nicht eingereicht): der Akt trägt die gewinnende.
    const x1 = handOver('A1@x', 'cancelled', 'dB')
    expect(M.project(allOrders([c1, h1, x1], [c2, h2]), t0).acts.act1).toMatchObject({ o: 'handed', ownCardDigest: 'dA' })
    // Beide schon eingereicht: beide Karten gehen hinaus, eine Kartenwirkung (kleinste Operation), eine Zustimmung.
    const t1 = handOver('A1@x', 'taken', 'dB')
    const t2 = handOver('A2@y', 'taken', 'dA')
    const b = allOrders([c1, h1, t1], [c2, h2, t2])
    expect(M.project(b, t0).acts.act1).toMatchObject({ state: 'consented', o: 'taken', ownCardDigest: 'dA' })
    expect(actEffects(b)).toEqual([`card:act1:card-a@${M.opKey(t1.id)}`, `consent:act1@${M.opKey(c1.id)}`])
  })
  it('Regel 1 für die Verbindung: verbinden beide Geräte den Akt je für sich, ist das eine Verbindung (kleinste Operation), in jeder Reihenfolge', () => {
    const c1 = consent('A1@x')
    const h1 = handOver('A1@x', 'taken', 'dA')
    const k1 = op({ kind: 'connect', act: 'act1', rel: 'A:act:act1', tuple: tuple('A:act:act1', 'card-a', 'cb') }, 'A1@x')
    const c2 = consent('A2@y')
    const h2 = handOver('A2@y', 'taken', 'dB')
    const k2 = op({ kind: 'connect', act: 'act1', rel: 'A:act:act1', tuple: tuple('A:act:act1', 'card-a', 'cb') }, 'A2@y')
    const s = allOrders([c1, h1, k1], [c2, h2, k2])
    expect(M.act(s, 'act1').state).toBe('connected')
    expect(s.relationships.length).toBe(2)
    expect(actEffects(s).filter((e) => e.startsWith('connect:'))).toEqual([`connect:act1@${M.opKey(k1.id)}`])
  })
  it('Gegenlauf: ohne Regel 1 tragen Zustimmung und Verbindung zwei Operationen; ohne Regel 3 hängt der Übergabedigest an der Reihenfolge; ohne Regel 2 bleibt jedes Gerät bei seinem ersten Zustand', () => {
    const c1 = consent('A1@x')
    const c2 = consent('A2@y')
    const h1 = handOver('A1@x', 'handed', 'dB')
    const h2 = handOver('A2@y', 'handed', 'dA')
    const d2 = decline('A2@y')
    try {
      M.FOLD.sameDecision = false
      expect(fold([c1, c2]).effects.filter((e) => e.id === 'consent:act1').length).toBe(2)
      M.FOLD.sameDecision = true
      M.FOLD.handOver = false
      expect(M.act(fold([c1, h1, c2, h2]), 'act1').ownCardDigest).not.toBe(M.act(fold([c2, h2, c1, h1]), 'act1').ownCardDigest)
      M.FOLD.handOver = true
      M.FOLD.consentVsDecline = false
      expect(M.act(fold([c1, h1, d2]), 'act1').state).not.toBe(M.act(fold([d2, c1, h1]), 'act1').state)
    } finally {
      Object.assign(M.FOLD, { sameDecision: true, consentVsDecline: true, handOver: true })
    }
  })
})
