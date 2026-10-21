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
  SendRegistry,
  seededRand,
  stage1Needed,
  type AckCheck,
  type RecvEvent,
  type RowResult,
  type SendRecord,
  type TableRow,
} from '../src/lab/zustellung-live'
import { deferred, FAKE_DID, FakeMediator, fakeInfo, instrumentedPort, mediatorKeys, type FakeOptions } from './zustellung-live-fixtures'

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

describe('E11b concurrent copies (review 1 C2)', () => {
  it('the send register refuses a second record with the same id instead of overwriting its index', () => {
    const r = new SendRegistry()
    r.add(rec('doc', 0, 'x/ack'))
    expect(() => r.add({ ...rec('doc', 1, 'x/ack'), innerDigest: 'other' })).toThrow()
    expect(r.all().length).toBe(1)
  })

  it('two copies of each frame arriving at once: one ack per document, unique ack ids, the second copy is duplicate-known', async () => {
    const keys = mediatorKeys()
    const info = await fakeInfo(keys)
    const counters = new Counters()
    const port = new FakeMediator(FAKE_DID, keys, { direct: 'socket-sender', routed: 'forward', invite: 'none', duplicate: true }, counters)
    const cfg = parseEnv({ E11B_RUNS: '1', E11B_TIMEOUT_MS: '400', E11B_FORMS: 'D-c' })
    const r = await runProbe(cfg, { info, port, counters, versions: VERSIONS, rand: seededRand(42), observeMs: 150 })
    expect(r.failures).toEqual([])
    const p = JSON.parse(protocolJson(r.protocol))
    const docs = p.rows.filter((x: { kind: string }) => x.kind === 'doc')
    expect(docs.length).toBe(4)
    expect(docs.every((x: { outcome: string }) => x.outcome === 'positive')).toBe(true)
    const ids = p.acks.map((a: { id: string }) => a.id)
    expect(ids.length).toBe(4)
    expect(new Set(ids).size).toBe(4)
    // the copies are counted as receipt events, the second one never as unique
    expect(docs.every((x: { events: number }) => x.events === 2)).toBe(true)
    // review 1 C3: every receipt is exported; the pick (first successful) is checkable from the JSON
    type Receipt = { tMs: number; cls: string; socket: string; verdict: string | null; counted: boolean; picked: boolean; check?: string | null }
    for (const d of docs as Array<{ receipts: Receipt[]; tRecvMs: number }>) {
      expect(d.receipts.length).toBe(2)
      expect(d.receipts.every((x) => x.counted && x.cls === 'doc' && x.socket.endsWith('.conn'))).toBe(true)
      expect(d.receipts.map((x) => x.verdict).sort()).toEqual(['duplicate-known', 'unique'])
      const picked = d.receipts.filter((x) => x.picked)
      expect(picked.length).toBe(1)
      expect([picked[0]!.verdict, picked[0]!.tMs]).toEqual(['unique', d.tRecvMs])
    }
    for (const a of p.acks as Array<{ receipts: Receipt[]; check: string }>) {
      expect(a.receipts.length).toBe(2)
      expect(a.receipts.map((x) => x.check).sort()).toEqual(['not-unique', 'ok'])
      expect(a.receipts.filter((x) => x.picked).map((x) => x.check)).toEqual(['ok'])
      expect(a.check).toBe('ok')
    }
  }, 60_000)
})

describe('E11b end of observation (review 1 C1)', () => {
  it('a receipt one millisecond after closedAt is not counted; at closedAt it is (bound inclusive)', () => {
    const o = { timeoutMs: 2000, closedAt: 1000 }
    expect(evaluateRow(rec('probe'), [ev({ cls: 'probe', t: 1001 })], undefined, o)).toMatchObject({ received: 'no', outcome: 'not-shown', firstFailed: 'received', events: 0 })
    expect(evaluateRow(rec('probe'), [ev({ cls: 'probe', t: 1000 })], undefined, o)).toMatchObject({ received: 'in-window', outcome: 'positive', events: 1 })
    // an ack received after closedAt does not count either
    expect(evaluateRow(rec('doc'), [ev({ cls: 'doc', verdict: 'unique', t: 900 })], okAck(1001), o)).toMatchObject({ ackValid: false, ackReason: 'no-ack', outcome: 'not-shown' })
    // entered after the deadline was fixed, in the same millisecond (review 2 C1): listed, not counted
    const same = evaluateRow(rec('probe'), [ev({ cls: 'probe', t: 1000, afterClose: true })], undefined, o)
    expect(same).toMatchObject({ received: 'no', events: 0 })
    expect(same.receipts).toEqual([expect.objectContaining({ counted: false, picked: false })])
  })

  const setup = async (o: Partial<FakeOptions> = {}) => {
    const keys = mediatorKeys()
    const info = await fakeInfo(keys)
    const counters = new Counters()
    const base = new FakeMediator(FAKE_DID, keys, { direct: 'socket-sender', routed: 'forward', invite: 'none', ...o }, counters)
    return { info, counters, base }
  }

  type Receipt = { tMs: number; counted: boolean; picked: boolean; verdict: string | null }
  type Exported = { id: string; receipts: Receipt[] }
  /** Let the event loop run until `done()` holds; bounded by turns, not by time. */
  const drain = async (done: () => boolean, turns = 10_000) => {
    for (let i = 0; i < turns && !done(); i++) await new Promise<void>((r) => setImmediate(r))
    return done()
  }

  it('second copies released after the row evaluation of their pass (review 2 C2): listed in the row and ack receipts as not counted, and in afterClose; copies after the return change nothing', async () => {
    const { info, counters, base } = await setup({ duplicate: true })
    const seen = new Set<string>()
    // Hold the second copy of every frame, in a bucket named after the pass it belongs to.
    const inst = instrumentedPort(base, (_label, text) => {
      if (!seen.has(text)) {
        seen.add(text)
        return null
      }
      return counters.current
    })
    const cfg = parseEnv({ E11B_RUNS: '1', E11B_TIMEOUT_MS: '400', E11B_FORMS: 'D-c,R-cc' })
    let heldDc = 0
    const r = await runProbe(cfg, {
      info,
      port: inst.port,
      counters,
      versions: VERSIONS,
      rand: seededRand(42),
      observeMs: 50,
      hooks: {
        // D-c's rows are evaluated by now (its pass and fresh window are over); its copies enter while R-cc settles.
        settling: (phase, group) => {
          if (phase === 'pass' && group === 'R-cc/s0') {
            heldDc = inst.heldCount('D-c/s0')
            void inst.release('D-c/s0')
          }
        },
      },
    })
    expect(r.failures).toEqual([])
    expect(r.valid).toBe(true)
    expect(inst.active()).toBe(0)
    const at = protocolJson(r.protocol)
    const p = JSON.parse(at)
    // D-c: 8 rows (probe + doc per relationship and direction) and 4 acks, each copied once
    expect(heldDc).toBe(12)
    const late = (p.events.afterClose as Array<{ group: string; recordId: string | null; session: string }>).filter((e) => e.group === 'D-c/s0')
    expect(late.length).toBe(12)
    expect(late.every((e) => e.session === 'main' && e.recordId !== null)).toBe(true)
    const dcRows = (p.rows as Array<Exported & { form: string; outcome: string }>).filter((x) => x.form === 'D-c')
    const dcAcks = (p.acks as Array<Exported & { form: string }>).filter((x) => x.form === 'D-c')
    expect(dcRows.length).toBe(8)
    expect(dcAcks.length).toBe(4)
    for (const x of [...dcRows, ...dcAcks]) {
      expect(x.receipts.length).toBe(2)
      expect(x.receipts.filter((e) => e.counted && e.picked).length).toBe(1)
      expect(x.receipts.filter((e) => !e.counted && !e.picked).length).toBe(1)
    }
    expect(dcRows.every((x) => x.outcome === 'positive')).toBe(true)
    // R-cc copies reach the handler only after the probe returned: nothing changes
    const acks = inst.acks()
    expect(inst.heldCount('R-cc/s0')).toBe(12)
    await inst.release('R-cc/s0')
    expect(inst.active()).toBe(0)
    expect(inst.acks()).toBe(acks)
    expect(protocolJson(r.protocol)).toBe(at)
    expect(r.valid).toBe(true)
    expect((p.events.afterClose as Array<{ group: string }>).some((e) => e.group === 'R-cc/s0')).toBe(false)
  }, 60_000)

  it('a frame entering during the last event-loop turn of the settle (review 2 C1, counterproof 1): in the snapshot, no handler active at return', async () => {
    const { info, counters, base } = await setup({ redeliverOnClose: true })
    const inst = instrumentedPort(base)
    const cfg = parseEnv({ E11B_RUNS: '1', E11B_TIMEOUT_MS: '400', E11B_FORMS: 'R-cc' })
    const r = await runProbe(cfg, { info, port: inst.port, counters, versions: VERSIONS, rand: seededRand(42), observeMs: 50 })
    expect(inst.active()).toBe(0)
    expect(r.failures).toEqual([])
    expect(r.valid).toBe(true)
    const p = JSON.parse(protocolJson(r.protocol))
    // closing the four main sessions hands their last frame over again, after the pass settled
    const late = p.events.afterClose as Array<{ recordId: string | null }>
    expect(late.length).toBe(4)
    const exported = [...(p.rows as Exported[]), ...(p.acks as Exported[])]
    for (const e of late) {
      const x = exported.find((y) => y.id === e.recordId)!
      expect(x.receipts.some((y) => !y.counted && !y.picked)).toBe(true)
    }
  }, 60_000)

  for (const late of ['continues', 'fails'] as const) {
    it(`a handler beyond the settle timeout (review 2 C1, counterproofs 2 and 3, ${late}): run invalid with settle-timeout, then no pickup ack, no counter change, the late failure discarded`, async () => {
      const { info, counters, base } = await setup()
      const inst = instrumentedPort(base)
      const gate = deferred()
      let entered = 0
      const cfg = parseEnv({ E11B_RUNS: '1', E11B_TIMEOUT_MS: '100', E11B_FORMS: 'D-c' })
      const r = await runProbe(cfg, {
        info,
        port: inst.port,
        counters,
        versions: VERSIONS,
        rand: seededRand(42),
        observeMs: 50,
        hooks: {
          beforeAckCheck: async () => {
            entered++
            await gate.promise
            if (late === 'fails') throw new Error('late failure')
          },
        },
      })
      expect(entered).toBeGreaterThan(0)
      expect(inst.active()).toBeGreaterThan(0)
      expect(r.valid).toBe(false)
      expect(r.failures.map((f) => [f.stage, f.cls])).toContainEqual(['probe', 'settle-timeout'])
      const at = protocolJson(r.protocol)
      const p = JSON.parse(at)
      expect(p.result.valid).toBe(false)
      expect(p.result.error).toEqual({ stage: 'probe', cls: 'settle-timeout' })
      const acks = inst.acks()
      const total = JSON.stringify(counters.total())
      const failures = r.failures.length
      gate.resolve()
      expect(await drain(() => inst.active() === 0)).toBe(true)
      expect(inst.acks()).toBe(acks)
      expect(JSON.stringify(counters.total())).toBe(total)
      expect(inst.rejected()).toBe(0)
      expect(r.failures.length).toBe(failures)
      expect(protocolJson(r.protocol)).toBe(at)
    }, 60_000)
  }

  it('a settle timeout keeps the rows of its pass (review 3 C2): run invalid, one row per probe and document send, every ack reference resolves, no further pass', async () => {
    const { info, counters, base } = await setup()
    const inst = instrumentedPort(base)
    const gate = deferred()
    const cfg = parseEnv({ E11B_RUNS: '1', E11B_TIMEOUT_MS: '100', E11B_FORMS: 'D-c,D-es' })
    const r = await runProbe(cfg, {
      info,
      port: inst.port,
      counters,
      versions: VERSIONS,
      rand: seededRand(42),
      observeMs: 50,
      hooks: {
        // every ack check is held past the settle timeout
        beforeAckCheck: () => gate.promise,
      },
    })
    gate.resolve()
    expect(r.valid).toBe(false)
    expect(r.failures.map((f) => [f.stage, f.cls])).toEqual([['probe', 'settle-timeout']])
    const p = JSON.parse(protocolJson(r.protocol))
    expect(p.result.valid).toBe(false)
    expect(p.result.error).toEqual({ stage: 'probe', cls: 'settle-timeout' })
    const rows = p.rows as Array<{ id: string; kind: string; ackValid: boolean }>
    expect(rows.filter((x) => x.kind === 'probe').length).toBe(4)
    const docs = rows.filter((x) => x.kind === 'doc')
    expect(docs.length).toBe(4)
    expect(docs.every((x) => !x.ackValid)).toBe(true)
    const acks = p.acks as Array<{ docRow: string }>
    expect(acks.length).toBe(4)
    for (const a of acks) expect(docs.some((d) => d.id === a.docRow)).toBe(true)
    // sizes and rows agree: every probe and document send has its row
    const cost = (p.costs as Array<{ form: string; sizes: { probe: { n: number }; doc: { n: number } } }>).find((c) => c.form === 'D-c')!
    expect([cost.sizes.probe.n, cost.sizes.doc.n]).toEqual([4, 4])
    // the cancelled pass skips its fresh delete-to-ack session, and no later pass starts
    expect(p.events.fresh).toEqual([])
    expect((p.groups as Array<{ id: string }>).map((g) => g.id)).toEqual(['D-c/s0'])
    expect(rows.every((x) => x.id.startsWith('D-c/s0/'))).toBe(true)
  }, 60_000)

  it('a handler failing before the snapshot (review 2 C1, counterproof 3): the failure is in the snapshot', async () => {
    const { info, counters, base } = await setup()
    const inst = instrumentedPort(base)
    const cfg = parseEnv({ E11B_RUNS: '1', E11B_TIMEOUT_MS: '100', E11B_FORMS: 'D-c' })
    const r = await runProbe(cfg, {
      info,
      port: inst.port,
      counters,
      versions: VERSIONS,
      rand: seededRand(42),
      observeMs: 50,
      hooks: {
        beforeAckCheck: async () => {
          throw new Error('ack check failed')
        },
      },
    })
    expect(inst.active()).toBe(0)
    expect(inst.rejected()).toBeGreaterThan(0)
    expect(r.valid).toBe(false)
    expect(r.failures.some((f) => f.stage === 'consumer')).toBe(true)
    expect(JSON.parse(protocolJson(r.protocol)).result.valid).toBe(false)
  }, 60_000)

  it('a handler still verifying an ack when the pass settles is awaited before the result is frozen (barrier, review 2 H1)', async () => {
    const { info, counters, base } = await setup()
    const inst = instrumentedPort(base)
    const gate = deferred()
    let started = 0
    let finished = 0
    let settledWhileHeld = false
    const cfg = parseEnv({ E11B_RUNS: '1', E11B_TIMEOUT_MS: '1000', E11B_FORMS: 'D-c' })
    const r = await runProbe(cfg, {
      info,
      port: inst.port,
      counters,
      versions: VERSIONS,
      rand: seededRand(42),
      observeMs: 50,
      hooks: {
        // the last of the four acks is held until the pass settles
        beforeAckCheck: async () => {
          if (++started === 4) await gate.promise
          finished++
        },
        settling: (phase) => {
          if (phase === 'pass' && started === 4 && finished === 3) settledWhileHeld = true
          gate.resolve()
        },
      },
    })
    expect(settledWhileHeld).toBe(true)
    expect([started, finished]).toEqual([4, 4])
    expect(inst.active()).toBe(0)
    expect(r.failures).toEqual([])
    expect(r.valid).toBe(true)
    const p = JSON.parse(protocolJson(r.protocol))
    const docs = p.rows.filter((x: { kind: string }) => x.kind === 'doc')
    expect(docs.length).toBe(4)
    expect(docs.every((x: { ackValid: boolean }) => x.ackValid)).toBe(true)
  }, 60_000)
})

describe('E11b ack times (review 1 C4)', () => {
  it('ack received and ack verified are separate; the round trip document → ack verified includes the verification', async () => {
    const keys = mediatorKeys()
    const info = await fakeInfo(keys)
    const counters = new Counters()
    const port = new FakeMediator(FAKE_DID, keys, { direct: 'socket-sender', routed: 'forward', invite: 'none' }, counters)
    const cfg = parseEnv({ E11B_RUNS: '1', E11B_TIMEOUT_MS: '400', E11B_FORMS: 'D-c' })
    const slow = () => new Promise<void>((res) => setTimeout(res, 80))
    const r = await runProbe(cfg, { info, port, counters, versions: VERSIONS, rand: seededRand(42), observeMs: 150, hooks: { beforeAckCheck: slow } })
    expect(r.failures).toEqual([])
    expect(r.valid).toBe(true)
    const p = JSON.parse(protocolJson(r.protocol))
    const docs = p.rows.filter((x: { kind: string; ackValid: boolean }) => x.kind === 'doc' && x.ackValid)
    expect(docs.length).toBe(4)
    for (const d of docs) {
      expect(d.tAckReceivedMs).toBeTypeOf('number')
      expect(d.tAckVerifiedMs - d.tAckReceivedMs).toBeGreaterThanOrEqual(79)
    }
    const cost = p.costs[0]
    expect(cost.roundTripMs.n).toBe(4)
    expect(cost.ackReceivedMs.n).toBe(4)
    expect(cost.roundTripMs.median - cost.ackReceivedMs.median).toBeGreaterThanOrEqual(79)
  }, 60_000)
})

describe('E11b cost sizes (review 1 H1)', () => {
  it('sizes per kind are min / median / max over all sends of the pass, not the first send', async () => {
    const keys = mediatorKeys()
    const info = await fakeInfo(keys)
    const counters = new Counters()
    const port = new FakeMediator(FAKE_DID, keys, { direct: 'socket-sender', routed: 'forward', invite: 'none' }, counters)
    const cfg = parseEnv({ E11B_RUNS: '2', E11B_TIMEOUT_MS: '400', E11B_FORMS: 'R-cc' })
    const r = await runProbe(cfg, { info, port, counters, versions: VERSIONS, rand: seededRand(42), observeMs: 100 })
    const p = JSON.parse(protocolJson(r.protocol))
    const stat = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b)
      const m = Math.floor(s.length / 2)
      return { min: s[0], median: s.length % 2 ? s[m] : Math.round((s[m - 1]! + s[m]!) / 2), max: s.at(-1) }
    }
    const acks = p.acks as Array<{ bytes: { inner: number; outer: number } }>
    expect(acks.length).toBe(8)
    const size = p.costs[0].sizes.ack
    expect(size.n).toBe(8)
    expect(size.inner).toEqual(stat(acks.map((a) => a.bytes.inner)))
    expect(size.outer).toEqual(stat(acks.map((a) => a.bytes.outer)))
    expect(p.costs[0].sizes.probe.n).toBe(8)
    expect(p.costs[0].sizes.doc.inner.min).toBeLessThanOrEqual(p.costs[0].sizes.doc.inner.max)
  }, 60_000)
})
