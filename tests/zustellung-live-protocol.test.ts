// E11b step 1, offline: secret freedom of every output (draft 3 §9, review 3
// C6), env release one by one, the mediator document summary (C2/C5), and the
// byte balance base64url vs binary (C4).

import { execFile } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jwk, MediatorSession, multibase, pack as didcommPack } from '@openvtc/vti-didcomm-js'
import { pack } from '@openvtc/vti-tsp-js'
import {
  byteSink,
  Counters,
  deriveWireIdentity,
  didcommType,
  E11bError,
  envSummary,
  liveMediatorPort,
  parseEnv,
  problemCode,
  protocolJson,
  runProbe,
  ScopeCounters,
  seededRand,
  serialize,
  summarizeMediator,
  translate,
  ROW_SCHEMA,
  type MediatorPort,
  type ResolvedDoc,
} from '../src/lab/zustellung-live'
import { deferred, FAKE_DID, FakeMediator, fakeDoc, instrumentedPort, mediatorKeys, markerForms, markerRand } from './zustellung-live-fixtures'

const VERSIONS = { tsp: '0.3.0', didcomm: '0.12.0', trustProtocol: '0.3.2', node: 'v24.21.0' }
const MARKER = 'MRK_x7Q2_SEC'

function assertClean(text: string, marker = MARKER) {
  for (const f of markerForms(marker)) expect(text.includes(f), `marker form ${f}`).toBe(false)
}

// Capture every console channel and stderr writes.
let captured: string[] = []
const spies: Array<{ mockRestore(): void }> = []
beforeEach(() => {
  captured = []
  for (const k of ['log', 'warn', 'error', 'info', 'debug'] as const) spies.push(vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void captured.push(a.map(String).join(' '))))
  const orig = process.stderr.write.bind(process.stderr)
  spies.push(
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      captured.push(String(chunk))
      return orig(chunk as string, ...(rest as []))
    }) as typeof process.stderr.write),
  )
})
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore()
})

// ── fake network for the live port ───────────────────────────────────────────

class FakeWs {
  static instances: FakeWs[] = []
  static behaviour: 'open' | { close: number; reason: string } = 'open'
  readyState = 0
  sent: unknown[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  onerror: (() => void) | null = null
  private listeners: Array<(ev: { data: unknown }) => void> = []
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeWs.instances.push(this)
    const b = FakeWs.behaviour
    setTimeout(() => {
      if (b === 'open') {
        this.readyState = 1
        this.onopen?.()
      } else this.onclose?.({ code: b.close, reason: b.reason })
    }, 1)
  }
  addEventListener(_t: 'message', fn: (ev: { data: unknown }) => void) {
    this.listeners.push(fn)
  }
  send(d: unknown) {
    this.sent.push(d)
  }
  close() {
    this.readyState = 3
  }
  deliver(data: unknown) {
    for (const l of this.listeners) l({ data })
    this.onmessage?.({ data })
  }
}

function fakeFetch(mode: 'ok' | 'fail-500' | 'fail-401') {
  return (async (url: string | URL) => {
    const u = String(url)
    if (mode === 'fail-500') return new Response(`internal ${MARKER} trace`, { status: 500 })
    if (mode === 'fail-401' && !u.endsWith('/challenge')) return new Response(`{"error":"${MARKER}"}`, { status: 401 })
    if (u.endsWith('/challenge')) return new Response(JSON.stringify({ sessionId: 's', data: { challenge: `c-${MARKER}`, session_id: 's' } }), { status: 200 })
    return new Response(JSON.stringify({ sessionId: 's', data: { access_token: `eyJhbGciOiJ9.${Buffer.from(MARKER).toString('base64url')}.sig`, access_expires_at: 9999999999, refresh_token: MARKER, refresh_expires_at: 9999999999 } }), { status: 200 })
  }) as unknown as typeof fetch
}

async function livePort(mode: 'ok' | 'fail-500' | 'fail-401') {
  const info = await summarizeMediator(FAKE_DID, fakeDoc(), async () => {
    throw new Error('x')
  })
  const counters = new Counters()
  const port = liveMediatorPort(info, { counters, fetch: fakeFetch(mode), WebSocketImpl: FakeWs as never })
  const me = await deriveWireIdentity(seededRand(1)(32), FAKE_DID, seededRand(2)(32), 'connection')
  return { info, counters, port, me }
}

describe('E11b secret freedom: errors leave only as stage and class', () => {
  it('login refused with a marker in err.body and the response: E11bError without cause, no marker anywhere', async () => {
    for (const [mode, cls] of [
      ['fail-500', 'http-5xx'],
      ['fail-401', 'auth-refused'],
    ] as const) {
      const { port, me, counters } = await livePort(mode)
      const err = await port.open(me, 'B.AB.conn', async () => {}).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(E11bError)
      expect([(err as E11bError).stage, (err as E11bError).cls]).toEqual(['login', cls])
      expect((err as Error).cause).toBeUndefined()
      assertClean(`${String(err)} ${(err as Error).stack} ${JSON.stringify(err)}`)
      expect(counters.total().logins).toEqual({ attempted: 1, ok: 0, failed: 1 })
    }
    assertClean(captured.join('\n'))
  })

  it('socket refused with a marker in the close reason and a JWT carrying the marker: class only', async () => {
    FakeWs.behaviour = { close: 1008, reason: `policy ${MARKER}` }
    const { port, me } = await livePort('ok')
    const err = await port.open(me, 'B.AB.conn', async () => {}).catch((e: unknown) => e)
    FakeWs.behaviour = 'open'
    expect([(err as E11bError).stage, (err as E11bError).cls]).toEqual(['socket', 'auth-refused'])
    assertClean(`${String(err)} ${(err as Error).stack}`)
    assertClean(captured.join('\n'))
  })

  it('open session: consumer exception recorded as class, frame errors go to our onError, nothing printed', async () => {
    FakeWs.instances = []
    const { port, me, counters, info } = await livePort('ok')
    let calls = 0
    const s = await port.open(me, 'B.AB.conn', async () => {
      calls++
      throw new Error(`consumer ${MARKER}`)
    })
    const ws = FakeWs.instances.at(-1)!
    // bearer subprotocol carries the JWT (the marker): it must never be logged
    expect(ws.protocols[0]!.startsWith('bearer.')).toBe(true)
    const keys = mediatorKeys()
    const frame = await pack(new TextEncoder().encode('x'), info.did, me.did, { senderSigningKey: keys.edSecret, receiverEncryptionKey: me.xPublic })
    ws.deliver(Buffer.from(frame.bytes).toString('base64url'))
    ws.deliver(`{"protected":"${MARKER}"}`)
    await new Promise((r) => setTimeout(r, 30))
    s.close()
    expect(calls).toBe(1)
    const total = counters.total()
    expect(total.consumerFailures).toEqual(['other'])
    expect(total.frameErrors.unpack).toEqual({ acked: 0, notAcked: 1 })
    expect(total.bytes.in.tspSocket).toBe(Buffer.from(frame.bytes).toString('base64url').length)
    expect(total.bytes.in.tspLogical).toBe(frame.bytes.length)
    expect(total.sockets).toMatchObject({ opened: 1, open: 0, maxConcurrent: 1 })
    assertClean(captured.join('\n'))
  })

  it('translate drops message, body and cause; the test failure path carries only stage and class', () => {
    const raw = Object.assign(new Error(`boom ${MARKER}`, { cause: new Error(MARKER) }), { body: MARKER, status: 503 })
    const e = translate(raw, 'login')
    expect([e.stage, e.cls, e.cause]).toEqual(['login', 'http-5xx', undefined])
    assertClean(`${e.message} ${e.stack} ${JSON.stringify(e)}`)
    let thrown: unknown
    try {
      throw translate(raw, 'probe')
    } catch (x) {
      thrown = x
    }
    assertClean(`${String(thrown)} ${(thrown as Error).stack}`)
    expect(translate(new Error('x'), 'socket').cls).toBe('ws-closed')
    expect(translate(Object.assign(new Error('x'), { code: 1008 }), 'socket').cls).toBe('auth-refused')
    expect(translate(new Error('no open/close within 15000ms'), 'socket').cls).toBe('timeout')
    expect(translate(new Error('x'), 'resolve').cls).toBe('resolve-failed')
  })

  it('DIDComm types and problem-report codes map onto fixed lists', () => {
    expect(didcommType(`https://evil.example/${MARKER}`)).toBe('other')
    expect(didcommType('other')).toBe('other')
    expect(didcommType('https://didcomm.org/report-problem/2.0/problem-report')).toBe('https://didcomm.org/report-problem/2.0/problem-report')
    expect(problemCode(`e.p.${MARKER}`)).toBe('e.p.other')
    expect(problemCode(MARKER)).toBe('other')
    expect(problemCode('e.p.message.expires_time.missing')).toBe('e.p.message.expires_time.missing')
  })

  it('whole probe with markers in roots, nonces, payloads, method fragments, metadata, URL path and output path: JSON and stderr clean', async () => {
    const keys = mediatorKeys(3)
    const doc = fakeDoc(keys, {
      versionId: `2-${MARKER}`,
      methods: [{ id: `${FAKE_DID}#${MARKER}`, type: `Type${MARKER}`, publicKeyMultibase: multibase.encodeMultikey(multibase.MULTICODEC.ED25519_PUB, mediatorKeys(4).edPublic) }],
      services: [
        { id: `${FAKE_DID}#${MARKER}`, type: 'TSPTransport', serviceEndpoint: `https://mediator.example.org/${MARKER}/tsp?x=${MARKER}` },
        { id: `${FAKE_DID}#service`, type: ['DIDCommMessaging'], serviceEndpoint: [{ uri: 'https://mediator.example.org/mediator/v1' }, { uri: 'wss://mediator.example.org/mediator/v1/ws' }] },
        { id: `${FAKE_DID}#auth`, type: [`X${MARKER}`, 'Authentication'], serviceEndpoint: `https://mediator.example.org/${MARKER}` },
      ],
    })
    const info = await summarizeMediator(FAKE_DID, doc, async () => {
      throw new Error(MARKER)
    })
    const counters = new Counters()
    const port = new FakeMediator(FAKE_DID, keys, { direct: 'socket-sender', routed: 'forward', invite: 'none' }, counters)
    const cfg = parseEnv({ E11B_RUNS: '1', E11B_TIMEOUT_MS: '300', E11B_FORMS: 'D-c,D-es,D-e,R-cc,R-c', E11B_PROTOCOL_OUT: `/tmp/${MARKER}/out.json`, RLTP_WIRE_DEBUG: '1' })
    const lines: string[] = []
    const r = await runProbe(cfg, { info, port, counters, versions: VERSIONS, rand: markerRand(MARKER), observeMs: 100, stderr: (l) => lines.push(l) })
    const json = protocolJson(r.protocol)
    assertClean(json)
    assertClean(lines.join('\n'))
    assertClean(captured.join('\n'))
    const p = JSON.parse(json)
    expect(lines.length).toBeGreaterThan(0)
    expect(p.head.versionId).toBe('invalid')
    expect(p.head.methods.map((m: { ref: string }) => m.ref)).toEqual(['key-0', 'key-1', 'm2'])
    expect(p.head.methods[2].type).toBe('other')
    expect(p.head.services.map((s: { ref: string; hosts: string[] }) => [s.ref, s.hosts])).toEqual([
      ['s0', ['mediator.example.org']],
      ['service', ['mediator.example.org']],
      ['auth', ['mediator.example.org']],
    ])
    expect(p.head.env.protocolOutSet).toBe(true)
    expect(p.head.routing.primeNote).toBe('no-own-target')
    expect(p.result.outcome).toBe('threshold-reached')
  }, 60_000)

  it('the schema drops unknown keys and replaces out-of-range values', () => {
    const v = serialize(ROW_SCHEMA, { id: `x y ${MARKER}`, form: MARKER, extra: MARKER, digests: { payload: 'abcdef0123', inner: 'abcdef01', outer: null } }) as Record<string, unknown>
    expect(v.extra).toBeUndefined()
    expect(v.id).toBe('invalid')
    expect(v.form).toBe('other')
    expect(v.digests).toEqual({ payload: 'invalid', inner: 'abcdef01', outer: null })
  })
})

describe('E11b env: each value released on its own', () => {
  it('validates E11B_RUNS ≥ 1, timeouts and forms; errors name the variable, not the value', () => {
    for (const bad of ['0', '-1', 'abc', '1.5', `${MARKER}`]) {
      let msg = ''
      try {
        parseEnv({ E11B_RUNS: bad })
      } catch (e) {
        msg = (e as Error).message
      }
      expect(msg).toContain('E11B_RUNS')
      assertClean(msg)
    }
    // switches: only `1` enables (CodeRabbit); `0`, `false` or any other value keeps them off
    for (const v of ['0', 'false', 'no', 'true', ' 1']) {
      const c0 = parseEnv({ MEDIATOR_ALLOW_INSECURE: v, RLTP_WIRE_DEBUG: v })
      expect([c0.allowInsecure, c0.debug]).toEqual([false, false])
    }
    const c1 = parseEnv({ MEDIATOR_ALLOW_INSECURE: '1', RLTP_WIRE_DEBUG: '1' })
    expect([c1.allowInsecure, c1.debug]).toEqual([true, true])
    expect(() => parseEnv({ E11B_TIMEOUT_MS: '0' })).toThrow(/E11B_TIMEOUT_MS/)
    expect(() => parseEnv({ E11B_FORMS: `D-c,${MARKER}` })).toThrow(/E11B_FORMS/)
    expect(() => parseEnv({ MEDIATOR_DID: `not a did ${MARKER}` })).toThrow(/MEDIATOR_DID/)
    const c = parseEnv({ E11B_FORMS: 'R-c,D-c', RLTP_LIVE_MEDIATOR: '1', E11B_PROTOCOL_OUT: MARKER })
    expect(c.forms).toEqual(['D-c', 'R-c'])
    expect([c.runs, c.timeoutMs, c.live]).toEqual([3, 20000, true])
    const s = envSummary(c)
    expect(s).toEqual({ liveMediator: true, mediatorDidSet: false, allowInsecure: false, wireDebug: false, forms: ['D-c', 'R-c'], runs: 3, timeoutMs: 20000, protocolOutSet: true })
    assertClean(JSON.stringify(s))
  })
})

describe('E11b mediator document: routing variants (review 3 C2)', () => {
  const keys = mediatorKeys(5)
  const other = mediatorKeys(6)
  const svc = (endpoint: string) => [
    { id: `${FAKE_DID}#tsp`, type: 'TSPTransport', serviceEndpoint: endpoint },
    { id: `${FAKE_DID}#service`, type: ['DIDCommMessaging'], serviceEndpoint: [{ uri: 'https://mediator.example.org/v1' }, { uri: 'wss://mediator.example.org/v1/ws' }] },
  ]
  const x2 = { id: `${FAKE_DID}#key-2`, type: 'Multikey', publicKeyMultibase: multibase.encodeMultikey(multibase.MULTICODEC.X25519_PUB, other.xPublic) }
  const none = async (): Promise<ResolvedDoc> => {
    throw new Error('unresolved')
  }

  it('default variant: mediator DID, ka[0], document version; injected resolver knows only this document', async () => {
    const info = await summarizeMediator(FAKE_DID, fakeDoc(keys), none)
    expect([info.routing.firstHopVid, info.routing.methodRef, info.routing.sourceDocVersion]).toEqual([FAKE_DID, 'key-1', '2-QmZPSfHt'])
    expect(Buffer.from(info.routing.x25519)).toEqual(Buffer.from(keys.xPublic))
    expect(info.edCandidates.map((c) => c.ref)).toEqual(['key-0'])
    expect(info.methods.map((m) => [m.ref, m.keyAgreement, m.authentication, m.assertionMethod])).toEqual([
      ['key-0', false, true, true],
      ['key-1', true, false, false],
    ])
    await expect(info.resolver(FAKE_DID)).resolves.toHaveProperty('didDocument')
    await expect(info.resolver('did:web:other')).rejects.toThrow()
  })

  it("R-c' only for an own did:webvh target or another keyAgreement key; otherwise not measured with a reason", async () => {
    const doc = (endpoint: string, extra: object[] = [], ka: string[] = [`${FAKE_DID}#key-1`]) => {
      const d = fakeDoc(keys, { services: svc(endpoint), methods: extra })
      ;(d.didDocument as { keyAgreement: string[] }).keyAgreement = ka
      return d
    }
    expect((await summarizeMediator(FAKE_DID, doc('https://mediator.example.org/tsp'), none)).primeNote).toBe('no-own-target')
    expect((await summarizeMediator(FAKE_DID, doc('#key-1'), none)).primeNote).toBe('same-as-default')
    expect((await summarizeMediator(FAKE_DID, doc('#key-2', [x2]), none)).primeNote).toBe('target-no-x25519') // not in keyAgreement
    const own = await summarizeMediator(FAKE_DID, doc('#key-2', [x2], [`${FAKE_DID}#key-1`, `${FAKE_DID}#key-2`]), none)
    expect([own.primeNote, own.prime?.firstHopVid, own.prime?.methodRef]).toEqual(['measured', FAKE_DID, 'key-2'])
    expect((await summarizeMediator(FAKE_DID, doc('did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH'), none)).primeNote).toBe('non-webvh-target')
    expect((await summarizeMediator(FAKE_DID, doc('did:webvh:QmOther:tsp.example.org:x'), none)).primeNote).toBe('target-unresolved')
    const target = 'did:webvh:QmOther:tsp.example.org:x'
    const resolveOther = async (d: string): Promise<ResolvedDoc> => {
      expect(d).toBe(target)
      return {
        didDocument: { id: target, verificationMethod: [{ id: `${target}#key-1`, type: 'Multikey', publicKeyMultibase: multibase.encodeMultikey(multibase.MULTICODEC.X25519_PUB, other.xPublic) }], keyAgreement: [`${target}#key-1`] },
        didDocumentMetadata: { versionId: '5-QmAbcdefghijkmnopqrstuvwxyz' },
      }
    }
    const webvh = await summarizeMediator(FAKE_DID, doc(target), resolveOther)
    expect([webvh.primeNote, webvh.prime?.firstHopVid, webvh.prime?.methodRef, webvh.prime?.sourceDocVersion]).toEqual(['measured', target, 'key-1', '5-QmAbcdef'])
  })
})

// Review 3 C1: the library's own frame processing (DIDComm unpack, `onMessage`, `onError`) runs
// under the same settle as the TSP handlers. A correctly encrypted mediator status and an
// unparsable frame arrive while a pass settles; a barrier holds the frame processing before the
// unpack (decryption). Released within the settle: both are counted in the snapshot. Held past
// the settle timeout: the run is invalid and releasing them afterwards changes no counter.
describe('E11b session-wide settle (review 3 C1)', () => {
  const STATUS = 'https://didcomm.org/messagepickup/3.0/status'
  async function sessionProbe(timeoutMs: number, release: 'during-settle' | 'after-return') {
    const keys = mediatorKeys()
    const { info, counters, port: base } = await livePort('ok')
    FakeWs.instances = []
    const frames: Array<{ ws: FakeWs; status: string }> = []
    // Every session gets a status packed by the mediator to its own client key.
    const port: MediatorPort = {
      open: async (...args: Parameters<MediatorPort['open']>) => {
        const s = await base.open(...args)
        const id = args[0]
        const status = await didcommPack({
          message: { id: crypto.randomUUID(), type: STATUS, from: info.did, to: [id.did], created_time: Math.floor(Date.now() / 1000), body: { message_count: 0 } },
          sender: { kid: `${info.did}#key-1`, privateJwk: jwk.privateJwk('X25519', keys.xSecret, keys.xPublic) },
          recipient: { kid: id.kid, publicJwk: jwk.publicJwk('X25519', id.xPublic) },
        })
        frames.push({ ws: FakeWs.instances.at(-1)!, status })
        return s
      },
    }
    const garbage = '{"protected":"held"}'
    const targets = new Set<string>([garbage])
    const gate = deferred()
    let processed = 0
    const orig = MediatorSession.prototype._onFrame
    const spy = vi.spyOn(MediatorSession.prototype, '_onFrame').mockImplementation(async function (this: MediatorSession, data: unknown) {
      if (!targets.has(data as string)) return orig.call(this, data)
      await gate.promise
      await orig.call(this, data)
      processed++
    })
    let delivered = false
    const cfg = parseEnv({ E11B_RUNS: '1', E11B_TIMEOUT_MS: String(timeoutMs), E11B_FORMS: 'D-es' })
    try {
      const r = await runProbe(cfg, {
        info,
        port,
        counters,
        versions: VERSIONS,
        rand: seededRand(42),
        observeMs: 50,
        hooks: {
          settling: (phase) => {
            if (phase !== 'pass' || delivered) return
            delivered = true
            const last = frames.at(-1)!
            targets.add(last.status)
            last.ws.deliver(last.status)
            last.ws.deliver(garbage)
            if (release === 'during-settle') setTimeout(() => gate.resolve(), 30)
          },
        },
      })
      return { r, counters, gate, processed: () => processed, delivered: () => delivered }
    } finally {
      // Restoring does not touch invocations already waiting at the barrier.
      spy.mockRestore()
    }
  }
  const drain = async (done: () => boolean, turns = 10_000) => {
    for (let i = 0; i < turns && !done(); i++) await new Promise<void>((r) => setImmediate(r))
    return done()
  }

  it('DIDComm status and frame error held across the settle start, released within it: both in the snapshot, run valid', async () => {
    const { r, delivered, processed } = await sessionProbe(400, 'during-settle')
    expect(delivered()).toBe(true)
    expect(processed()).toBe(2)
    expect(r.failures).toEqual([])
    expect(r.valid).toBe(true)
    const p = JSON.parse(protocolJson(r.protocol))
    expect(p.counters.total.didcomm[STATUS]).toBe(1)
    expect(p.counters.total.frameErrors.unpack).toEqual({ acked: 0, notAcked: 1 })
  }, 60_000)

  it('held beyond the settle timeout: run invalid with settle-timeout; released after the return, no counter changes', async () => {
    const { r, counters, gate, processed } = await sessionProbe(100, 'after-return')
    expect(r.valid).toBe(false)
    expect(r.failures.map((f) => [f.stage, f.cls])).toContainEqual(['probe', 'settle-timeout'])
    const at = protocolJson(r.protocol)
    const total = JSON.stringify(counters.total())
    expect(total.includes(STATUS)).toBe(false)
    gate.resolve()
    expect(await drain(() => processed() === 2)).toBe(true)
    expect(JSON.stringify(counters.total())).toBe(total)
    expect(protocolJson(r.protocol)).toBe(at)
  }, 60_000)
})

// Review 3 (d): a handler that fails after the cancel with a marker in its error. The failure is
// discarded: neither the result JSON, nor the debug lines, nor any console or stderr channel, nor
// an unhandled rejection carries the marker.
describe('E11b discarded late failure (review 3 d)', () => {
  it('a late failure carrying a marker after the settle timeout leaves no trace', async () => {
    const keys = mediatorKeys()
    const info = await summarizeMediator(FAKE_DID, fakeDoc(keys), async () => {
      throw new Error('x')
    })
    const counters = new Counters()
    const inst = instrumentedPort(new FakeMediator(FAKE_DID, keys, { direct: 'socket-sender', routed: 'forward', invite: 'none' }, counters))
    const gate = deferred()
    const rejections: unknown[] = []
    const onRejection = (e: unknown) => void rejections.push(e)
    process.on('unhandledRejection', onRejection)
    const lines: string[] = []
    try {
      const cfg = parseEnv({ E11B_RUNS: '1', E11B_TIMEOUT_MS: '100', E11B_FORMS: 'D-c', RLTP_WIRE_DEBUG: '1' })
      const r = await runProbe(cfg, {
        info,
        port: inst.port,
        counters,
        versions: VERSIONS,
        rand: seededRand(42),
        observeMs: 50,
        stderr: (l) => lines.push(l),
        hooks: {
          beforeAckCheck: async () => {
            await gate.promise
            throw new Error(`late ${MARKER}`, { cause: new Error(MARKER) })
          },
        },
      })
      expect(r.valid).toBe(false)
      gate.resolve()
      for (let i = 0; i < 10_000 && inst.active() > 0; i++) await new Promise<void>((res) => setImmediate(res))
      await new Promise((res) => setTimeout(res, 20))
      expect(inst.active()).toBe(0)
      expect(inst.rejected()).toBe(0)
      const json = protocolJson(r.protocol)
      assertClean(json)
      assertClean(JSON.stringify(r.failures.map((f) => [f.stage, f.cls, String(f), f.stack])))
      assertClean(lines.join('\n'))
      assertClean(captured.join('\n'))
      assertClean(rejections.map((e) => `${String(e)} ${(e as Error)?.stack}`).join('\n'))
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  }, 60_000)
})

describe('E11b byte balance (review 3 C4)', () => {
  it('inbound TSP counts base64url text on the socket and binary size as logical; the rest is DIDComm', async () => {
    const c = new ScopeCounters()
    const sink = byteSink(c)
    const a = await deriveWireIdentity(seededRand(7)(32), FAKE_DID, seededRand(8)(32), 'connection')
    const frame = (await pack(new Uint8Array(1), a.did, a.did, { senderSigningKey: a.edSecret, receiverEncryptionKey: a.xPublic })).bytes
    const text = Buffer.from(frame).toString('base64url')
    expect(text.length).toBe((frame.length * 4) / 3) // frames are quadlet aligned
    sink.inbound(text)
    sink.inbound('{"protected":"abc"}')
    expect(c.bytes.in).toEqual({ socket: text.length + 19, tspSocket: text.length, tspLogical: frame.length })
    // subtracting the binary size would book (text - binary) bytes as control traffic
    expect(c.bytes.in.socket - c.bytes.in.tspSocket).toBe(19)
    sink.outbound(frame)
    sink.outbound('{"a":1}')
    expect(c.bytes.out).toEqual({ socket: frame.length + 7, tspSocket: frame.length, tspLogical: frame.length })
  })
})

// Review 1 C5: the real reporter path. A throwaway Vitest run in a subprocess fails on purpose
// with a translated error built from an exception full of the marker; stdout and stderr of the
// reporter must not contain it. A second failing test throws the raw exception as a positive
// control (the capture does see a marker when one is printed). The marker reaches the
// subprocess only through the environment, so no code frame can show it from the source.
// Takes a few seconds (one Vitest start).
describe('E11b test reporter (review 1 C5)', () => {
  it('a failing test with a translated error prints no marker; the untranslated control does', async () => {
    const root = resolve('.cache', `e11b-reporter-${process.pid}-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    try {
      const lib = resolve('src/lab/zustellung-live')
      writeFileSync(join(root, 'vitest.config.mts'), "export default { test: { include: ['*.test.ts'] } }\n")
      writeFileSync(
        join(root, 'marker.test.ts'),
        [
          "import { it } from 'vitest'",
          `import { translate } from ${JSON.stringify(lib)}`,
          'const m = process.env.E11B_REPORTER_MARKER!',
          'const c = process.env.E11B_REPORTER_CONTROL!',
          'const raw = () => Object.assign(new Error(`boom ${m}`), { body: m, cause: new Error(m), status: 503 })',
          "it('translated', () => { throw translate(raw(), 'login') })",
          "it('translated async', async () => { await Promise.reject(translate(raw(), 'probe')) })",
          "it('control', () => { throw new Error(`control ${c}`) })",
          '',
        ].join('\n'),
      )
      const bin = resolve('node_modules/vitest/vitest.mjs')
      const control = 'CTL_r4P9_VIS'
      const out = await promisify(execFile)(process.execPath, [bin, 'run', '--root', root, '--config', join(root, 'vitest.config.mts')], {
        env: { ...process.env, E11B_REPORTER_MARKER: MARKER, E11B_REPORTER_CONTROL: control, NO_COLOR: '1', CI: '1' },
        maxBuffer: 1 << 24,
      }).then(
        (r) => ({ code: 0, text: `${r.stdout}\n${r.stderr}` }),
        (e: { code?: number; stdout?: string; stderr?: string }) => ({ code: e.code ?? -1, text: `${e.stdout ?? ''}\n${e.stderr ?? ''}` }),
      )
      expect(out.code).not.toBe(0)
      expect(out.text).toContain('3 failed')
      expect(out.text).toContain('e11b login: http-5xx')
      expect(out.text).toContain('e11b probe: http-5xx')
      expect(out.text).toContain(control)
      assertClean(out.text)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})
