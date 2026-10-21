// E11b step 1, offline: sender state on the positive ack path (draft 3 §4.4,
// review 3 C1), row predicates, aggregation, probe outcome, and the whole
// probe against an in-memory fake mediator.

import { describe, expect, it } from 'vitest'
import { diSign, receive, seal, type Json } from '@real-life/trust-protocol'
import { ACK_TYPE, DOC_TYPE, sealDoc } from '../src/lab/zustellung'
import {
  aggregate,
  Counters,
  evaluateRow,
  makeParty,
  OUTCOMES,
  parseEnv,
  probeOutcome,
  protocolJson,
  runProbe,
  SenderLedger,
  seededRand,
  stage1Needed,
  type AckCheck,
  type RecvEvent,
  type RowResult,
  type SendRecord,
  type TableRow,
} from '../src/lab/zustellung-live'
import { FAKE_DID, FakeMediator, fakeInfo, mediatorKeys, type FakeOptions } from './zustellung-live-fixtures'

const VERSIONS = { tsp: '0.3.0', didcomm: '0.12.0', trustProtocol: '0.3.2', node: 'v24' }
const T = '2026-10-21T00:00:00.000Z'

async function parties(seed = 1) {
  const rand = seededRand(seed)
  return { alice: await makeParty('A', rand), bob: await makeParty('B', rand), mallory: await makeParty('M', rand) }
}

/** An ack as Alice receives it: signed by `signer`, sealed to Alice, built by receive(). */
async function ackFor(p: Awaited<ReturnType<typeof parties>>, o: { ref: string; threadId: string; signer?: 'bob' | 'mallory'; type?: string }) {
  const s = p[o.signer ?? 'bob']
  const doc = await diSign({ anchor: s.anchor, ed: { priv: s.ed.priv } }, { id: crypto.randomUUID(), type: o.type ?? ACK_TYPE, issuer: p.bob.anchor, recipient: p.alice.anchor, threadId: o.threadId, issuedAt: T, payload: { ref: o.ref, meaning: 'received' } }, T)
  const env = await seal(doc as unknown as Json, p.alice.rkid)
  return receive(env, (rkid) => (rkid === p.alice.rkid ? p.alice.x.priv : undefined), new Set())
}

describe('E11b sender state: only a signed, valid, timely ack closes accepted → delivered', () => {
  it('counterproofs: receipt alone, pickup ack alone, invalid proof, wrong type, wrong ref, wrong thread do not close', async () => {
    const p = await parties()
    const { digest } = await sealDoc(p.alice, p.bob, { n: 1 }, 'th1')
    const L = new SenderLedger(p.bob.anchor, 1000)
    L.submit('row1', digest, 'th1')
    L.docReceived(digest, 100)
    expect(L.state('row1')).toBe('accepted') // receipt at Bob alone
    // A pickup ack is a socket message to the mediator; the ledger has no input for it.
    expect(L.state('row1')).toBe('accepted')
    const cases: Array<[Parameters<typeof ackFor>[1], AckCheck['reason']]> = [
      [{ ref: digest, threadId: 'th1', signer: 'mallory' }, 'proof-invalid'],
      [{ ref: digest, threadId: 'th1', type: DOC_TYPE }, 'wrong-type'],
      [{ ref: 'u-other', threadId: 'th1' }, 'ref-unknown'],
      [{ ref: digest, threadId: 'th-other' }, 'thread-mismatch'],
    ]
    for (const [o, reason] of cases) {
      const chk = await L.checkAck(await ackFor(p, o), 200)
      expect([chk.valid, chk.reason]).toEqual([false, reason])
      expect(L.state('row1')).toBe('accepted')
    }
    // A failed receive (not unique) is no ack either
    expect((await L.checkAck({ stages: [], disposition: 'failed(malformed)' }, 200)).reason).toBe('not-unique')
    const ok = await L.checkAck(await ackFor(p, { ref: digest, threadId: 'th1' }), 200)
    expect([ok.valid, ok.inTime, ok.rowId, L.state('row1')]).toEqual([true, true, 'row1', 'delivered'])
  })

  it('a valid ack to another submission closes only that one', async () => {
    const p = await parties(2)
    const a = await sealDoc(p.alice, p.bob, { n: 1 }, 'tA')
    const b = await sealDoc(p.alice, p.bob, { n: 2 }, 'tB')
    const L = new SenderLedger(p.bob.anchor, 1000)
    L.submit('rowA', a.digest, 'tA')
    L.submit('rowB', b.digest, 'tB')
    L.docReceived(a.digest, 0)
    L.docReceived(b.digest, 0)
    await L.checkAck(await ackFor(p, { ref: b.digest, threadId: 'tB' }), 10)
    expect([L.state('rowA'), L.state('rowB')]).toEqual(['accepted', 'delivered'])
  })

  it('late valid ack: ack-valid without ack-in-time, state stays accepted; the bound is inclusive', async () => {
    const p = await parties(3)
    const { digest } = await sealDoc(p.alice, p.bob, { n: 1 }, 'th')
    const L = new SenderLedger(p.bob.anchor, 1000)
    L.submit('r', digest, 'th')
    L.docReceived(digest, 0)
    const late = await L.checkAck(await ackFor(p, { ref: digest, threadId: 'th' }), 1001)
    expect([late.valid, late.inTime, L.state('r')]).toEqual([true, false, 'accepted'])
    const edge = await L.checkAck(await ackFor(p, { ref: digest, threadId: 'th' }), 1000)
    expect([edge.valid, edge.inTime, L.state('r')]).toEqual([true, true, 'delivered'])
  })

  it('observe-only checks never transition', async () => {
    const p = await parties(4)
    const { digest } = await sealDoc(p.alice, p.bob, { n: 1 }, 'th')
    const L = new SenderLedger(p.bob.anchor, 1000)
    L.submit('r', digest, 'th')
    L.docReceived(digest, 0)
    const c = await L.checkAck(await ackFor(p, { ref: digest, threadId: 'th' }), 5, true)
    expect([c.valid, c.inTime, L.state('r')]).toEqual([true, true, 'accepted'])
  })
})

function rec(kind: 'probe' | 'doc', tSend = 0, id = 'row'): SendRecord {
  return { id, group: 'g', form: 'R-c', stage: 0, rel: 'AB', dir: 'x2y', run: 1, kind, payloadDigest: 'p', innerDigest: 'i', outerDigest: 'o', sizes: { payload: 1, inner: 2, outer: 3, wire: 3 }, tSend, receiverSocket: 'B.AB.conn' }
}
const ev = (o: Partial<RecvEvent> & Pick<RecvEvent, 'cls' | 't'>): RecvEvent => ({ recordId: 'row', socket: 'B.AB.conn', size: 10, fresh: false, ...o })
const opts = { timeoutMs: 100, closedAt: 1000 }
const okAck = (t: number, inTime = true): AckCheck => ({ rowId: 'row', valid: true, inTime, reason: 'ok', t })

describe('E11b row predicates (precedence, first successful receipt, inclusive bounds)', () => {
  it('no receipt: not shown, first failed = received', () => {
    const r = evaluateRow(rec('probe'), [], undefined, opts)
    expect([r.received, r.outcome, r.firstFailed, r.observedMs]).toEqual(['no', 'not-shown', 'received', 1000])
  })
  it('probe in window (bound inclusive) is positive; after the window it is late', () => {
    expect(evaluateRow(rec('probe'), [ev({ cls: 'probe', t: 100, layer: 'inner' })], undefined, opts)).toMatchObject({ received: 'in-window', outcome: 'positive', innerBytesEqual: true })
    expect(evaluateRow(rec('probe'), [ev({ cls: 'probe', t: 101 })], undefined, opts)).toMatchObject({ received: 'late', outcome: 'late', firstFailed: null })
  })
  it('unopened, wrong type and payload mismatch fail in order', () => {
    expect(evaluateRow(rec('probe'), [ev({ cls: 'unopenable/unlisted', t: 5, layer: 'outer' })], undefined, opts)).toMatchObject({ opened: false, firstFailed: 'opened', outerBytesEqual: true, outcome: 'not-shown' })
    expect(evaluateRow(rec('probe'), [ev({ cls: 'wrong-type/routed', t: 5, hopsLength: 1 })], undefined, opts)).toMatchObject({ opened: true, type: 'wrong-type/routed', firstFailed: 'type', hopsLength: 1 })
    expect(evaluateRow(rec('probe'), [ev({ cls: 'payload-not-json', t: 5 })], undefined, opts)).toMatchObject({ type: 'direct', payloadMatch: false, firstFailed: 'payload-match' })
  })
  it('the first successful receipt wins: a later duplicate does not replace unique, an earlier failure does not hide it', () => {
    const evs = [ev({ cls: 'unopenable/unlisted', t: 1 }), ev({ cls: 'doc', verdict: 'unique', t: 50 }), ev({ cls: 'doc', verdict: 'duplicate-known', t: 60 })]
    const r = evaluateRow(rec('doc'), evs, okAck(90), opts)
    expect([r.docVerdict, r.tRecvMs, r.outcome, r.events]).toEqual(['unique', 50, 'positive', 3])
  })
  it('doc: no ack, invalid ack, late ack', () => {
    const evs = [ev({ cls: 'doc', verdict: 'unique', t: 10 })]
    expect(evaluateRow(rec('doc'), evs, undefined, opts)).toMatchObject({ ackValid: false, ackReason: 'no-ack', firstFailed: 'ack-valid', outcome: 'not-shown' })
    expect(evaluateRow(rec('doc'), evs, { rowId: 'row', valid: false, inTime: false, reason: 'proof-invalid', t: 20 }, opts)).toMatchObject({ ackValid: false, ackReason: 'proof-invalid', outcome: 'not-shown' })
    expect(evaluateRow(rec('doc'), evs, okAck(500, false), opts)).toMatchObject({ ackValid: true, ackInTime: false, outcome: 'late' })
    expect(evaluateRow(rec('doc'), [ev({ cls: 'doc', verdict: 'failed(malformed)', t: 10 })], undefined, opts)).toMatchObject({ firstFailed: 'doc-verdict' })
  })
  it('events in the fresh delete-to-ack session never change the row', () => {
    expect(evaluateRow(rec('probe'), [ev({ cls: 'probe', t: 5, fresh: true })], undefined, opts)).toMatchObject({ received: 'no', outcome: 'not-shown', events: 0 })
  })
})

const row = (outcome: RowResult['outcome']) => ({ outcome, rel: 'AB', dir: 'x2y', run: 1 }) as RowResult

describe('E11b aggregation and probe outcome', () => {
  it('empty never carries; all positive carries; mixed is partial with counts; none is not shown', () => {
    expect(aggregate([])).toMatchObject({ outcome: 'not-shown', rows: 0 })
    expect(aggregate([row('positive'), row('positive')]).outcome).toBe('carries')
    expect(aggregate([row('positive'), row('late'), row('not-shown')])).toMatchObject({ outcome: 'partial', positive: 1, late: 1, notShown: 1 })
    expect(aggregate([row('late')]).outcome).toBe('partial')
    expect(aggregate([row('not-shown')]).outcome).toBe('not-shown')
  })

  it('every situation yields exactly one outcome, the first branch in the fixed order', () => {
    const agg = (o: 'carries' | 'partial' | 'not-shown') => ({ ...aggregate([]), outcome: o })
    const all = ['D-c', 'D-es', 'D-e', 'R-cc', 'R-c', "R-c'", 'R-es', 'R-ce']
    let n = 0
    for (const pre of [true, false])
      for (const forms of [all, all.filter((f) => f !== 'D-e')])
        for (const s0 of ['carries', 'partial', 'not-shown'] as const)
          for (const c0 of ['carries', 'not-shown'] as const)
            for (const s1 of ['carries', 'not-shown', null] as const) {
              const table: TableRow[] = [{ form: 'R-c', stage: 0, transport: agg(s0), contract: agg(c0) }]
              if (s1) table.push({ form: 'R-c', stage: 1, transport: agg(s1), contract: agg(s1) })
              const o = probeOutcome({ preconditionFailed: pre, forms, table })
              expect(OUTCOMES).toContain(o)
              const expected = pre ? 'precondition-failed' : forms.length < all.length ? 'incomplete' : s0 === 'carries' && c0 === 'carries' ? 'threshold-reached' : s1 === 'carries' ? 'stage1-only' : 'threshold-not-reached'
              expect(o).toBe(expected)
              n++
            }
    expect(n).toBe(72)
  })

  it('stage 1 runs only when no routed form carries in the stage-0 transport', () => {
    const agg = (o: 'carries' | 'not-shown') => ({ ...aggregate([]), outcome: o })
    expect(stage1Needed([{ form: 'D-c', stage: 0, transport: agg('carries'), contract: agg('carries') }])).toBe(true)
    expect(stage1Needed([{ form: 'R-cc', stage: 0, transport: agg('carries'), contract: agg('not-shown') }])).toBe(false)
  })
})

describe('E11b probe against a fake mediator (offline)', () => {
  const run = async (o: FakeOptions, env: Record<string, string> = {}) => {
    const keys = mediatorKeys()
    const info = await fakeInfo(keys)
    const counters = new Counters()
    const port = new FakeMediator(FAKE_DID, keys, o, counters)
    const cfg = parseEnv({ E11B_RUNS: '1', E11B_TIMEOUT_MS: '400', ...env })
    return runProbe(cfg, { info, port, counters, versions: VERSIONS, rand: seededRand(42), observeMs: 150 })
  }
  const cell = (p: Record<string, unknown>, form: string, stage = 0) => (p.result as { table: TableRow[] }).table.find((r) => r.form === form && r.stage === stage)

  it('mediator relaying only socket-sender frames and forwarding routed: controls as in the binding, threshold reached', async () => {
    const r = await run({ direct: 'socket-sender', routed: 'forward', invite: 'none' })
    expect(r.failures).toEqual([])
    const p = r.protocol
    const outcome = (f: string) => [cell(p, f)?.transport.outcome, cell(p, f)?.contract.outcome]
    expect(outcome('D-c')).toEqual(['carries', 'carries'])
    expect(outcome('D-es')).toEqual(['carries', 'carries'])
    expect(outcome('D-e')).toEqual(['not-shown', 'not-shown'])
    expect(outcome('R-cc')).toEqual(['carries', 'carries'])
    expect(outcome('R-c')).toEqual(['carries', 'carries'])
    expect(outcome('R-es')).toEqual(['carries', 'carries'])
    expect(outcome('R-ce')).toEqual(['not-shown', 'not-shown'])
    expect(cell(p, "R-c'")).toBeUndefined()
    const res = p.result as { outcome: string; notes: Array<{ kind: string; cls: string | null }>; baseline: unknown[] }
    expect(res.outcome).toBe('threshold-reached')
    expect(res.notes).toContainEqual({ kind: 'prime-not-measured', form: "R-c'", cls: 'no-own-target' })
    expect(res.notes).toContainEqual({ kind: 'stage1-not-needed', form: null, cls: null })
    // 7 forms × 4 connection logins + 2 × 4 egress + 3 delete-to-ack forms × 4 fresh = 48 (draft 3 §7)
    const total = (p.counters as { total: { logins: { attempted: number } } }).total
    expect(total.logins.attempted).toBe(48)
    // every row has exactly one outcome; JSON passes the schema
    const rows = p.rows as Array<{ outcome: string; kind: string }>
    expect(rows.length).toBe(7 * 2 * 2 * 2)
    for (const x of rows) expect(['positive', 'late', 'not-shown']).toContain(x.outcome)
    const json = JSON.parse(protocolJson(p))
    expect(json.result.outcome).toBe('threshold-reached')
    expect(json.head.keyBinding).toBe('confirmed')
    // RT6-G: the partner of R-c never sees the connection DID; of D-c it does
    const groups = json.groups as Array<{ form: string; peerSees: Array<{ includesConnection: boolean }>; linkableAcrossRelationships: boolean }>
    expect(groups.find((g) => g.form === 'R-c')!.peerSees.every((s) => !s.includesConnection)).toBe(true)
    expect(groups.find((g) => g.form === 'D-c')!.peerSees.every((s) => s.includesConnection)).toBe(true)
    expect(groups.every((g) => !g.linkableAcrossRelationships)).toBe(true)
    // delete-to-ack: everything acked, nothing redelivered in the fresh sessions
    expect(json.events.fresh).toEqual([])
  }, 60_000)

  it('mediator dropping routed frames: stage 1 runs for R-c and R-cc, XRFA correlated; threshold not reached; key binding unclear', async () => {
    const r = await run({ direct: 'socket-sender', routed: 'drop', invite: 'accept' }, { E11B_FORMS: 'D-c,D-es,D-e,R-cc,R-c' })
    const p = JSON.parse(protocolJson(r.protocol))
    expect(p.result.outcome).toBe('threshold-not-reached')
    expect(p.result.notes).toContainEqual({ kind: 'stage1-run', form: null, cls: null })
    expect(p.result.notes).toContainEqual({ kind: 'key-binding-unclear', form: null, cls: null })
    expect(p.result.table.filter((t: { stage: number }) => t.stage === 1).map((t: { form: string }) => t.form)).toEqual(['R-c', 'R-cc'])
    expect(p.controls.length).toBe(8)
    expect(p.controls.every((c: { controlType: string; correlation: string; signatureMethod: string }) => c.controlType === 'accept' && c.correlation === 'own-xrfi' && c.signatureMethod === 'key-0')).toBe(true)
    expect(p.xrfi.length).toBe(8)
  }, 60_000)

  it('a missing mandatory control makes the outcome incomplete', async () => {
    const r = await run({ direct: 'socket-sender', routed: 'forward', invite: 'none' }, { E11B_FORMS: 'D-c,R-c' })
    expect((r.protocol.result as { outcome: string }).outcome).toBe('incomplete')
  }, 60_000)

  it('delete-to-ack: frames never pushed live show up as first-in-fresh and do not change rows', async () => {
    const r = await run({ direct: 'socket-sender', routed: 'forward', invite: 'none', holdLive: true }, { E11B_FORMS: 'D-c' })
    const p = JSON.parse(protocolJson(r.protocol))
    expect(p.result.table[0].transport.outcome).toBe('not-shown')
    expect(p.rows.every((x: { received: string }) => x.received === 'no')).toBe(true)
    // 1 run × 2 relationships × 2 directions × (probe + doc); no acks, since no doc was received in the main sessions
    expect(p.events.fresh.length).toBe(8)
    expect(p.events.fresh.every((e: { kind: string }) => e.kind === 'first-in-fresh')).toBe(true)
    expect(p.acks).toEqual([])
  }, 60_000)
})
