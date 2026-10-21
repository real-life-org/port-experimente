// E11b step 1, offline: secret freedom of every output (draft 3 §9, review 3
// C6), env release one by one, the mediator document summary (C2/C5), and the
// byte balance base64url vs binary (C4).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { multibase } from '@openvtc/vti-didcomm-js'
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
  type ResolvedDoc,
} from '../src/lab/zustellung-live'
import { FAKE_DID, FakeMediator, fakeDoc, mediatorKeys, markerForms, markerRand } from './zustellung-live-fixtures'

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
