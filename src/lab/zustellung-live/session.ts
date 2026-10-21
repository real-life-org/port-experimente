// Mediator access of the E11b live probe: the port interface, counters, and
// the live port over vti-didcomm-js 0.12.0. `ProbeMediatorSession` is the
// TypeScript take on `RltpMediatorSession` from `binding/vti-wire.mjs`: the
// TSP frame goes to the consumer, the pickup ack fires only when the consumer
// says so; unlike the template it neither swallows a consumer exception (it is
// recorded, the probe fails) nor prints raw error texts. No session keeps the
// default `onError` (review 3 C6). The injected resolver goes into every login.
// The whole processing of every inbound frame, DIDComm included, runs under the
// probe's lifecycle (`SessionLife`, gate review 3 C1).

import { authenticateToMediator, isTspFrameText, MediatorSession } from '@openvtc/vti-didcomm-js'
import { E11bError, translate, type ErrorClass } from './errors'
import type { WireIdentity } from './identities'
import type { MediatorInfo } from './mediator'
import { enc, sha256hex } from './util'

export type TspHandler = (qb2: Uint8Array, text: string) => Promise<void>

export interface PortSession {
  readonly label: string
  sendBinary(bytes: Uint8Array): void
  /** Pickup ack (delete-to-ack) for a received frame, by its text form. */
  ack(text: string): Promise<void>
  close(): void
}

/**
 * The probe's lifecycle, shared by every frame a session processes (gate review 3 C1). The
 * library's own processing (DIDComm unpack, `onMessage`, `onError`) runs outside the TSP handler;
 * it is registered here so the probe settles it like a TSP handler, and its counter changes stop
 * once the probe no longer accepts them.
 */
export interface SessionLife {
  /** Registers the whole processing of one inbound frame with the probe's settle. */
  track(p: Promise<void>): void
  /** False once the probe was cancelled or its snapshot taken: no session counter changes after that. */
  accepting(): boolean
}

export interface MediatorPort {
  /** ATM login as `id`, open the socket, enable live delivery. Throws `E11bError` (stage login or socket). */
  open(id: WireIdentity, label: string, onTsp: TspHandler, life?: SessionLife): Promise<PortSession>
}

// ── Counters (draft 3 §7 RT7, review 3 C4/H2) ────────────────────────────────

export const FRAME_ERROR_STAGES = ['decode-bytes', 'decode-tsp', 'unpack', 'refused-dropped', 'dispatch', 'dispatch-tsp', 'other'] as const
export type FrameErrorStage = (typeof FRAME_ERROR_STAGES)[number]
export const DIDCOMM_TYPES = [
  'https://didcomm.org/messagepickup/3.0/live-delivery-change',
  'https://didcomm.org/messagepickup/3.0/messages-received',
  'https://didcomm.org/messagepickup/3.0/status',
  'https://didcomm.org/report-problem/2.0/problem-report',
  'https://didcomm.org/routing/2.0/forward',
  'https://trusttasks.org/binding/didcomm/0.1/envelope',
  'https://affinidi.com/atm/1.0/authenticate',
  'other',
] as const
export const PROBLEM_CODES = ['e.p.message.expires_time.missing', 'e.p.other', 'e.m.other', 'w.other', 'other'] as const

export function didcommType(t: unknown): (typeof DIDCOMM_TYPES)[number] {
  return (DIDCOMM_TYPES as readonly unknown[]).includes(t) && t !== 'other' ? (t as (typeof DIDCOMM_TYPES)[number]) : 'other'
}

export function problemCode(c: unknown): (typeof PROBLEM_CODES)[number] {
  if (c === 'e.p.message.expires_time.missing') return c
  if (typeof c !== 'string') return 'other'
  if (c.startsWith('e.p.')) return 'e.p.other'
  if (c.startsWith('e.m.')) return 'e.m.other'
  if (c.startsWith('w.')) return 'w.other'
  return 'other'
}

export function frameErrorStage(stage: unknown): FrameErrorStage {
  switch (stage) {
    case 'decode inbound frame bytes':
      return 'decode-bytes'
    case 'decode inbound TSP frame':
      return 'decode-tsp'
    case 'unpack inbound frame':
      return 'unpack'
    case 'accept inbound frame (refused and dropped)':
      return 'refused-dropped'
    case 'dispatch inbound message':
      return 'dispatch'
    case 'dispatch inbound TSP frame':
      return 'dispatch-tsp'
    default:
      return 'other'
  }
}

export interface DirBytes {
  /** All socket payload bytes in this direction (text as UTF-8, binary as is). */
  socket: number
  /** Socket bytes of TSP frames as transported (outbound binary, inbound base64url text). */
  tspSocket: number
  /** Logical (binary) size of those TSP frames. */
  tspLogical: number
}

export class ScopeCounters {
  logins = { attempted: 0, ok: 0, failed: 0 }
  sockets = { opened: 0, open: 0, maxConcurrent: 0 }
  bytes: { out: DirBytes; in: DirBytes } = { out: { socket: 0, tspSocket: 0, tspLogical: 0 }, in: { socket: 0, tspSocket: 0, tspLogical: 0 } }
  frameErrors: Record<string, { acked: number; notAcked: number }> = {}
  didcomm: Record<string, number> = {}
  problemCodes: Record<string, number> = {}
  consumerFailures: ErrorClass[] = []
}

export class Counters {
  readonly scopes = new Map<string, ScopeCounters>()
  current = 'setup'
  scope(name = this.current): ScopeCounters {
    let s = this.scopes.get(name)
    if (!s) this.scopes.set(name, (s = new ScopeCounters()))
    return s
  }
  /** Sum over all scopes. */
  total(): ScopeCounters {
    const t = new ScopeCounters()
    for (const s of this.scopes.values()) {
      t.logins.attempted += s.logins.attempted
      t.logins.ok += s.logins.ok
      t.logins.failed += s.logins.failed
      t.sockets.opened += s.sockets.opened
      t.sockets.maxConcurrent = Math.max(t.sockets.maxConcurrent, s.sockets.maxConcurrent)
      for (const d of ['out', 'in'] as const) for (const k of ['socket', 'tspSocket', 'tspLogical'] as const) t.bytes[d][k] += s.bytes[d][k]
      for (const [k, v] of Object.entries(s.frameErrors)) {
        const e = (t.frameErrors[k] ??= { acked: 0, notAcked: 0 })
        e.acked += v.acked
        e.notAcked += v.notAcked
      }
      for (const [k, v] of Object.entries(s.didcomm)) t.didcomm[k] = (t.didcomm[k] ?? 0) + v
      for (const [k, v] of Object.entries(s.problemCodes)) t.problemCodes[k] = (t.problemCodes[k] ?? 0) + v
      t.consumerFailures.push(...s.consumerFailures)
    }
    return t
  }
}

/** Byte accounting of one socket, attributed to the scope the session was opened in; counts only while `accepting()`. */
export function byteSink(c: ScopeCounters, accepting: () => boolean = () => true) {
  return {
    outbound(data: unknown) {
      if (!accepting()) return
      if (typeof data === 'string') c.bytes.out.socket += enc.encode(data).length
      else if (data instanceof Uint8Array) {
        // Only TSP goes out as binary (sendBinary).
        c.bytes.out.socket += data.length
        c.bytes.out.tspSocket += data.length
        c.bytes.out.tspLogical += data.length
      } else if (data instanceof ArrayBuffer) c.bytes.out.socket += data.byteLength
    },
    inbound(data: unknown) {
      if (!accepting()) return
      if (typeof data === 'string') {
        const n = enc.encode(data).length
        c.bytes.in.socket += n
        if (isTspFrameText(data)) {
          c.bytes.in.tspSocket += n
          c.bytes.in.tspLogical += Math.floor((data.length * 3) / 4)
        }
      } else if (data instanceof ArrayBuffer) c.bytes.in.socket += data.byteLength
      else if (data instanceof Uint8Array) c.bytes.in.socket += data.length
      else if (typeof data === 'object' && data !== null && typeof (data as { size?: unknown }).size === 'number') c.bytes.in.socket += (data as { size: number }).size
    },
  }
}

type WsCtor = new (url: string, protocols?: string | string[]) => WebSocket

/** A WebSocket class that counts payload bytes per direction. */
export function countingWebSocket(Base: WsCtor, sink: ReturnType<typeof byteSink>): WsCtor {
  return class extends Base {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols)
      this.addEventListener('message', (ev: MessageEvent) => sink.inbound(ev.data))
    }
    override send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      sink.outbound(data)
      super.send(data as string)
    }
  }
}

/** `RltpMediatorSession` in TypeScript: hand-off without auto-ack, consumer exceptions recorded, not swallowed. */
export class ProbeMediatorSession extends MediatorSession {
  handler: TspHandler | null = null
  failures: ErrorClass[] = []
  life: SessionLife | null = null
  /** Every inbound frame, TSP or DIDComm, is registered with the probe's settle when it arrives (gate review 3 C1). */
  override _onFrame(data: unknown): Promise<void> {
    const p = super._onFrame(data)
    this.life?.track(p)
    return p
  }
  override async _dispatchTspFrame(qb2: Uint8Array, text: string): Promise<void> {
    if (!this.handler) return
    try {
      await this.handler(qb2, text)
    } catch (e) {
      if (this.life && !this.life.accepting()) return
      this.failures.push(translate(e, 'consumer').cls)
    }
  }
  ackTsp(ids: string[]) {
    return this._ackReceived(ids)
  }
}

export interface LivePortOptions {
  netPolicy?: { allowInsecure: boolean; allowPrivate: boolean }
  counters: Counters
  fetch?: typeof fetch
  WebSocketImpl?: WsCtor
}

export function liveMediatorPort(info: MediatorInfo, opts: LivePortOptions): MediatorPort {
  const Base: WsCtor = opts.WebSocketImpl ?? (globalThis.WebSocket as unknown as WsCtor)
  return {
    async open(id, label, onTsp, life) {
      const scope = opts.counters.scope()
      const accepting = () => life?.accepting() ?? true
      scope.logins.attempted++
      let auth: Awaited<ReturnType<typeof authenticateToMediator>>
      try {
        auth = await authenticateToMediator({
          mediatorDid: info.did,
          clientDid: id.did,
          clientX25519Private: id.xSecret,
          clientX25519Public: id.xPublic,
          resolve: info.resolver as never,
          ...(opts.netPolicy ? { netPolicy: opts.netPolicy } : {}),
          ...(opts.fetch ? { fetch: opts.fetch } : {}),
        })
      } catch (e) {
        scope.logins.failed++
        throw translate(e, 'login')
      }
      scope.logins.ok++
      const session = new ProbeMediatorSession({
        mediator: auth.mediator,
        mediatorJwt: auth.accessToken,
        client: { did: id.did, kid: id.kid, privateKey: id.xSecret, publicKey: id.xPublic },
        WebSocketImpl: countingWebSocket(Base, byteSink(scope, accepting)),
        ...(opts.netPolicy ? { netPolicy: opts.netPolicy } : {}),
        onTspFrame: () => {},
        onError: (_err: unknown, ctx?: { stage?: unknown }) => {
          if (!accepting()) return
          const st = frameErrorStage(ctx?.stage)
          const e = (scope.frameErrors[st] ??= { acked: 0, notAcked: 0 })
          if (st === 'refused-dropped') e.acked++
          else e.notAcked++
        },
        onMessage: (m: { type?: unknown; body?: { code?: unknown } }) => {
          if (!accepting()) return
          const t = didcommType(m?.type)
          scope.didcomm[t] = (scope.didcomm[t] ?? 0) + 1
          if (t === 'https://didcomm.org/report-problem/2.0/problem-report') {
            const c = problemCode(m?.body?.code)
            scope.problemCodes[c] = (scope.problemCodes[c] ?? 0) + 1
          }
        },
      } as never)
      session.onMediatorMessage = session.onMessage
      session.handler = onTsp
      session.life = life ?? null
      try {
        await session.connect()
      } catch (e) {
        try {
          session.close()
        } catch {
          /* teardown */
        }
        throw translate(e, 'socket')
      }
      scope.sockets.opened++
      scope.sockets.open++
      scope.sockets.maxConcurrent = Math.max(scope.sockets.maxConcurrent, scope.sockets.open)
      let closed = false
      return {
        label,
        sendBinary(bytes) {
          try {
            session.sendBinary(bytes)
          } catch (e) {
            throw translate(e, 'send')
          }
        },
        async ack(text) {
          await session.ackTsp([sha256hex(enc.encode(text))])
        },
        close() {
          if (closed) return
          closed = true
          scope.consumerFailures.push(...session.failures)
          scope.sockets.open--
          try {
            session.close()
          } catch {
            /* teardown */
          }
        },
      }
    },
  }
}

export { E11bError }
