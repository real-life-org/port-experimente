import { describe, expect, it } from 'vitest'
import { pack, packInvite, packNested, packRouted, packWithHops } from '@openvtc/vti-tsp-js'
import { HORIZON, WireUnreachable, party } from '../src/lab/zustellung'
import { tspSender } from '../src/lab/zustellung-sessions'
import { REFUSAL_CLASSES, RoutedIntermediary, RoutedWelt, classifyOpened, hopIdentity, pairRouted, routedDeliveryScenarios, runRouted, tampered, type RefusalClass, type RoutedWire } from '../src/lab/zustellung-routed'
import { routedWires } from '../src/candidates/zustellung'
import { tspRoutedControlWire, tspRoutedEgressSessionWire, tspRoutedWire } from '../src/candidates/zustellung/tsp-routed'
import { relationshipIdentities } from '../src/candidates/zustellung/tsp-direct'

// E11b step 3: the routed intermediary in the delivery bench and the wire `tsp-routed` (draft rltp/design/port-
// experimente-e11b-step3-intermediary-entwurf-2026-10-21.md, build decisions C1–C6, H1). Findings: NOTES section
// "E11b step 3: routed intermediary".

const enc = new TextEncoder()
const DOC = enc.encode('{"x":1}')

describe('E11b step 3: wires', () => {
  it('routedWires lists R-c and R-es (forms); R-ce is a control and not registered', () => {
    expect(routedWires.map((w) => w.id)).toEqual(['tsp-routed', 'tsp-routed-egress-session'])
    expect(tspRoutedControlWire().role).toBe('control')
  })

  it('sessions per side and outer senders: R-c [conn] and conn outside, R-es [conn, egress] and egress outside, R-ce [conn] and egress outside', async () => {
    const al = await party('alice')
    const bo = await party('bob')
    const ids = await relationshipIdentities(al, bo)
    const c = (await tspRoutedWire().bind(al, bo)).a
    const es = (await tspRoutedEgressSessionWire().bind(al, bo)).a
    const ce = (await tspRoutedControlWire().bind(al, bo)).a
    expect([c.sessions, c.outerSender, c.sender, c.account]).toEqual([[ids.conn.did], ids.conn.did, ids.egress.did, ids.conn.did])
    expect([es.sessions, es.outerSender, es.sender]).toEqual([[ids.conn.did, ids.egress.did], ids.egress.did, ids.egress.did])
    expect([ce.sessions, ce.outerSender]).toEqual([[ids.conn.did], ids.egress.did])
    expect(c.address).toBe(tspRoutedWire().hop.vid)
  })
})

/** A paired world on R-c plus the raw material to build frames by hand. */
async function bench(wire: RoutedWire = tspRoutedWire()) {
  const w = new RoutedWelt(wire)
  const al = await party('alice')
  const bo = await party('bob')
  const p = await pairRouted(w, al, bo)
  const ia = await relationshipIdentities(al, bo)
  const ib = await relationshipIdentities(bo, al)
  const hop = wire.hop
  const keys = { senderSigningKey: ia.conn.edSecret, receiverEncryptionKey: hop.xPublic }
  const inner = async () => (await pack(DOC, ia.egress.did, ib.conn.did, { senderSigningKey: ia.egress.edSecret, receiverEncryptionKey: ib.conn.xPublic })).bytes
  return { w, al, bo, ...p, ia, ib, hop, keys, inner }
}

describe('C1: asynchronous opening behind a barrier', () => {
  it('a deposited frame is accepted at once, not collectable before drain, forwarded after drain', async () => {
    const { w, A, B, b } = await bench()
    const d = await A.send({ note: 'c1' })
    expect(A.zusteller.report(d)?.state).toBe('accepted')
    expect(w.hop.collect(B.name)).toEqual([])
    expect(w.hop.pending(b.account)).toBe(0)
    await w.hop.drain()
    expect(w.hop.pending(b.account)).toBe(1)
    expect(w.hop.collect(B.name).length).toBe(1)
  }, 30_000)

  it('an opening that fails is counted as a refusal, never an unhandled rejection', async () => {
    const { w, ia, hop, inner } = await bench()
    const frame = (await packRouted(await inner(), [ia.conn.did], ia.conn.did, hop.vid, { senderSigningKey: ia.conn.edSecret, receiverEncryptionKey: hopIdentity('other').xPublic })).bytes
    w.hop.depositFrom('alice', hop.vid, frame)
    expect(w.hop.refusedRouted).toEqual([])
    await w.hop.drain()
    expect(w.hop.refusals()).toEqual({ 'unpack-failed': 1 })
  }, 30_000)

  it('unreachable: the deposit throws WireUnreachable (T10), nothing enters the inbox', async () => {
    const { w, hop, ia, keys, inner } = await bench()
    w.hop.unreachable = true
    const frame = (await packRouted(await inner(), [ia.conn.did], ia.conn.did, hop.vid, keys)).bytes
    expect(() => w.hop.depositFrom('alice', hop.vid, frame)).toThrow(WireUnreachable)
    await w.hop.drain()
    expect(w.hop.inbound.length).toBe(0)
  }, 30_000)
})

describe('C2: refusal classes, reachable on the wire (one real frame each)', () => {
  type Bench = Awaited<ReturnType<typeof bench>>
  type Case = { frame: Uint8Array; device?: string; address?: string; session?: string }
  const H = tspRoutedWire().hop
  const cases: Array<[RefusalClass, (b: Bench) => Promise<Case>]> = [
    ['foreign-address', async ({ ia, ib, keys, inner }) => ({ frame: (await packRouted(await inner(), [ib.conn.did], ia.conn.did, H.vid, keys)).bytes, address: hopIdentity('i2').vid })],
    ['undecodable', async () => ({ frame: new Uint8Array(300).fill(9) })],
    ['session', async ({ ia, ib, keys, inner }) => ({ frame: (await packRouted(await inner(), [ib.conn.did], ia.conn.did, H.vid, keys)).bytes, device: 'mallory' })],
    ['wrong-receiver', async ({ ia, ib, keys, inner }) => ({ frame: (await packRouted(await inner(), [ib.conn.did], ia.conn.did, hopIdentity('i2').vid, keys)).bytes })],
    ['bad-vid', async ({ ib, keys, inner }) => ({ frame: (await packRouted(await inner(), [ib.conn.did], 'did:web:example.org', H.vid, keys)).bytes, device: 'web', session: 'did:web:example.org' })],
    ['unpack-failed', async ({ ia, ib, inner }) => ({ frame: (await packRouted(await inner(), [ib.conn.did], ia.conn.did, H.vid, { senderSigningKey: ia.egress.edSecret, receiverEncryptionKey: H.xPublic })).bytes })],
    ['type/direct', async ({ ia, keys }) => ({ frame: (await pack(DOC, ia.conn.did, H.vid, keys)).bytes })],
    ['type/nested', async ({ ia, keys, inner }) => ({ frame: (await packNested(await inner(), ia.conn.did, H.vid, keys)).bytes })],
    ['type/control', async ({ ia, keys }) => ({ frame: (await packInvite(ia.conn.did, H.vid, keys)).bytes })],
    ['multi-hop', async ({ ia, ib, keys, inner }) => ({ frame: (await packRouted(await inner(), [ib.conn.did, ia.conn.did], ia.conn.did, H.vid, keys)).bytes })],
    ['empty-inner', async ({ ia, ib, keys }) => ({ frame: (await packRouted(new Uint8Array(0), [ib.conn.did], ia.conn.did, H.vid, keys)).bytes })],
    ['no-session-next', async ({ ia, keys, inner }) => ({ frame: (await packRouted(await inner(), [(await relationshipIdentities(await party('x'), await party('y'))).conn.did], ia.conn.did, H.vid, keys)).bytes })],
  ]
  /** Deposit the case's frame as its device (default Alice) at its address (default the intermediary), drain, return the classes. */
  const run = async (make: (b: Bench) => Promise<Case>) => {
    const b = await bench()
    const c = await make(b)
    if (c.session) b.w.hop.register(c.device ?? 'x', c.session)
    b.w.hop.depositFrom(c.device ?? 'alice', c.address ?? b.hop.vid, c.frame)
    await b.w.hop.drain()
    return { refused: b.w.hop.refusedRouted.map((r) => r.cls), forwarded: b.w.hop.opened.length }
  }
  for (const [cls, make] of cases) {
    it(`${cls}: refused with exactly this class, nothing forwarded`, async () => {
      const r = await run(make)
      expect(r).toEqual({ refused: [cls], forwarded: 0 })
    }, 30_000)
  }

  it('a correct frame is forwarded (control for the cases above)', async () => {
    const { w, ia, ib, hop, keys, inner } = await bench()
    const i = await inner()
    w.hop.depositFrom('alice', hop.vid, (await packRouted(i, [ib.conn.did], ia.conn.did, hop.vid, keys)).bytes)
    await w.hop.drain()
    expect(w.hop.refusedRouted).toEqual([])
    expect(w.hop.carried.at(-1)!.bytes).toEqual(i)
    expect(w.hop.opened[0]!.outerBytes - w.hop.opened[0]!.innerBytes).toBe(384)
  }, 30_000)

  it('every class of the closed list is covered here or by a guard test', () => {
    const wire = cases.map(([c]) => c)
    const guards: RefusalClass[] = ['wrong-revision', 'deliver-to-self', 'type/padding', 'type/other']
    expect([...wire, ...guards].sort()).toEqual([...REFUSAL_CLASSES].sort())
  })
})

describe('C2: defensive guards (the classification function on its own)', () => {
  const ok = () => true
  const m = (over: Partial<Parameters<typeof classifyOpened>[0]>) => ({ revision: 'rev3', messageType: 'routed', hops: ['did:key:zNext'], payload: new Uint8Array([1, 2, 3, 4]), ...over })
  it('wrong-revision, deliver-to-self, type/padding, type/other', () => {
    expect(classifyOpened(m({ revision: 'rev2' }), ok)).toEqual({ kind: 'refuse', cls: 'wrong-revision' })
    expect(classifyOpened(m({ hops: [] }), ok)).toEqual({ kind: 'refuse', cls: 'deliver-to-self' })
    expect(classifyOpened(m({ messageType: 'padding' }), ok)).toEqual({ kind: 'refuse', cls: 'type/padding' })
    expect(classifyOpened(m({ messageType: 'weird' }), ok)).toEqual({ kind: 'refuse', cls: 'type/other' })
  })
  it('the wire-reachable classes of the function, and forward', () => {
    expect(classifyOpened(m({ messageType: 'direct' }), ok)).toEqual({ kind: 'refuse', cls: 'type/direct' })
    expect(classifyOpened(m({ hops: ['a', 'b'] }), ok)).toEqual({ kind: 'refuse', cls: 'multi-hop' })
    expect(classifyOpened(m({ payload: new Uint8Array(0) }), ok)).toEqual({ kind: 'refuse', cls: 'empty-inner' })
    expect(classifyOpened(m({}), () => false)).toEqual({ kind: 'refuse', cls: 'no-session-next' })
    expect(classifyOpened(m({}), ok)).toMatchObject({ kind: 'forward', next: 'did:key:zNext' })
  })
  it('packWithHops(…, routed, []) opens as nested on the wire, so deliver-to-self is a guard only', async () => {
    const { w, ia, hop, keys, inner } = await bench()
    w.hop.depositFrom('alice', hop.vid, (await packWithHops(await inner(), 'routed', [], ia.conn.did, hop.vid, keys)).bytes)
    await w.hop.drain()
    expect(w.hop.refusals()).toEqual({ 'type/nested': 1 })
  }, 30_000)
})

describe('C3: next hop without a session at the intermediary', () => {
  it('a partner without a session: frames refused as no-session-next and counted; Alice gives up after 12 rounds', async () => {
    const wire = tspRoutedWire()
    const w = new RoutedWelt(wire)
    const al = await party('alice')
    const bo = await party('bob')
    const { A, b } = await pairRouted(w, al, bo)
    // Bob closes his session (the pickup at his account is gone at this intermediary).
    w.hop.unregister('bob')
    const d = await A.send({ note: 'c3' })
    await w.until(() => A.zusteller.report(d)?.state === 'failed', HORIZON.giveUp + 4)
    expect(A.zusteller.report(d)?.state).toBe('failed')
    expect(Object.keys(w.hop.refusals())).toEqual(['no-session-next'])
    expect(w.hop.pending(b.account)).toBe(0)
  }, 60_000)
})

describe('intermediary faults', () => {
  it('tampered() changes a copy, never the frame the dispatcher keeps', async () => {
    const { inner } = await bench()
    const i = await inner()
    const keep = i.slice()
    for (const r of ['inner-header', 'inner-ciphertext', 'inner-signature', 'inner-garbage'] as const) {
      const t = tampered(i, r)
      expect(t.length).toBe(i.length)
      expect(t).not.toEqual(i)
    }
    expect(i).toEqual(keep)
  }, 30_000)

  it('register of the own VID opens no session', () => {
    const h = new RoutedIntermediary(hopIdentity('i1'))
    h.register('alice', h.hop.vid)
    expect(h.sessions()).toBe(0)
  })

  it('outer header tampered: the sender read differs, refused before opening', async () => {
    const { ia, ib, hop, keys, inner } = await bench()
    const frame = (await packRouted(await inner(), [ib.conn.did], ia.conn.did, hop.vid, keys)).bytes
    expect(tspSender(tampered(frame, 'outer-header'))).not.toBe(ia.conn.did)
  }, 30_000)
})

const PASS = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, 'bestanden']))

describe('E11b step 3: every cell on R-c and R-es, R-ce in the control', () => {
  const formCells = routedDeliveryScenarios.filter((s) => s.role === 'form').map((s) => s.id)

  it('cell list: RT4a/b, Z1r–Z3r, RT3a/b, Z5r, RT5, T3r (5 branches), T5r (28 branches)', () => {
    expect(formCells.filter((id) => !id.includes('/'))).toEqual(['RT4a', 'RT4b', 'Z1r', 'Z2r', 'Z3r', 'RT3a', 'RT3b', 'Z5r', 'RT5'])
    expect(formCells.filter((id) => id.startsWith('T3r/')).length).toBe(5)
    expect(formCells.filter((id) => id.startsWith('T5r/')).length).toBe(28)
  })

  for (const w of routedWires) {
    it(`${w.id}: all cells pass`, async () => {
      const results = await runRouted(w.make)
      const failed = results.filter((r) => r.outcome !== 'bestanden')
      expect(failed, JSON.stringify(failed, null, 1)).toEqual([])
      expect(Object.fromEntries(results.map((r) => [r.scenario, r.outcome]))).toEqual(PASS(formCells))
    }, 600_000)
  }

  it('R-ce (control): RT1-K, the outer layer is dropped by the session rule', async () => {
    const results = await runRouted(tspRoutedControlWire)
    expect(results.map((r) => [r.scenario, r.outcome])).toEqual([['RT1-K', 'bestanden']])
    expect(results[0]!.detail).toContain('"session"')
  }, 120_000)
})

describe('Z1r measurement per form', () => {
  const z1 = async (make: () => RoutedWire) => (await routedDeliveryScenarios.find((s) => s.id === 'Z1r')!.run(make()))
  it('R-c: outer sender is the account; 2 sessions; +384 B', async () => {
    const r = await z1(tspRoutedWire)
    expect(r.outcome).toBe('bestanden')
    expect(r.measure).toMatchObject({ sessions: 2, overhead: '384', outerSender: 'Konto(alice)' })
    expect(r.detail).toContain('Alices Konto im inneren Rahmen: nein')
    expect(r.detail).toContain('Bobs Quittungen an Konto(alice)')
    expect(r.detail).toContain('innen Egress(alice) → Konto(bob)')
  }, 60_000)
  it('R-es: outer sender is the egress identity; 4 sessions; +384 B', async () => {
    const r = await z1(tspRoutedEgressSessionWire)
    expect(r.outcome).toBe('bestanden')
    expect(r.measure).toMatchObject({ sessions: 4, overhead: '384', outerSender: 'Egress(alice)' })
    expect(r.detail).toContain('Bobs Quittungen an Konto(alice)')
  }, 60_000)
})
