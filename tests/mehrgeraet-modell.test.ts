import { describe, expect, it } from 'vitest'
import * as M from '../src/lab/mehrgeraet/model'

// E15 Sollmodell: die Faltung als Wert (Tor-Review 3, B1, B2, B5).
//   B1 Eine Operation wirkt ganz oder gar nicht; eine fehlende Voraussetzung ist
//      `Missing`, der Zustand bleibt unberührt, die Operation gilt nicht als angewandt.
//   B2 Reihenfolgeunabhängig, wo zulässig; sonst sichtbarer Konflikt:
//      Sicht monoton (8500), Budgetbestätigung mit Akt-Ids (8515), Schlüsselidentität
//      (Nonce, n) mit Finding „zweiter Vorrat“ (8435), Zustimmung gegen Ablehnung als
//      Finding und Widerspruch im Ledger (8325.A3/A4), Vereinigung führt Bestätigungen zusammen.
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

  it('Zustimmung gegen Ablehnung: der terminale Zustand bleibt, der Widerspruch steht im Ledger und als Finding (8325.A3/A4)', () => {
    const run = (first: 'consent' | 'decline') => {
      const s = withRel()
      M.apply(s, op({ kind: 'allocate', rel: 'A:e1', nonce: 'n1', keys: [key('n1', 1)] }))
      M.apply(s, op({ kind: 'ticket-accept', act: actOf('act1', 'A:e1', 'n1-1') }))
      const c = op({ kind: 'consent', act: 'act1', card: { anchor: 'c', keyAgreement: 'rc' }, cardKey: 'card/act1/A' }, 'A1@1')
      const d = op({ kind: 'decline', act: 'act1' }, 'A2@1')
      M.apply(s, first === 'consent' ? c : d)
      M.apply(s, first === 'consent' ? d : c)
      return s
    }
    const x = run('consent')
    expect(M.act(x, 'act1').state).toBe('consented')
    expect(x.effects.some((e) => e.id === 'decline:act1')).toBe(true)
    expect(x.findings.some((f) => f.includes('8325'))).toBe(true)
    const y = run('decline')
    expect(M.act(y, 'act1').state).toBe('declined')
    expect(y.effects.some((e) => e.id === 'consent:act1')).toBe(true)
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
