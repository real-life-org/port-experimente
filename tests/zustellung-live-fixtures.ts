// Offline fixtures for the E11b live probe tests: a synthetic mediator
// document and keys, hand-built TSP frames of types the library will not pack
// (padding, XCTL, unknown marker, Rev 2 header), and an in-memory fake
// mediator behind the `MediatorPort` interface. Not a test file itself.

import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { multibase } from '@openvtc/vti-didcomm-js'
import { decodeEnvelope, packAccept, unpack } from '@openvtc/vti-tsp-js'
import * as wire from '../node_modules/@openvtc/vti-tsp-js/dist/cesr/wire.js'
import * as hpke from '../node_modules/@openvtc/vti-tsp-js/dist/crypto/hpke.js'
import * as sign from '../node_modules/@openvtc/vti-tsp-js/dist/crypto/sign.js'
import { encodeFields, finalizeFrame } from '../node_modules/@openvtc/vti-tsp-js/dist/rev3/envelope.js'
import { encodeEmptyPadding, encodeSenderField } from '../node_modules/@openvtc/vti-tsp-js/dist/rev3/fields.js'
import { Counters, didKeyKeys, summarizeMediator, type MediatorInfo, type MediatorPort, type PortSession, type ResolvedDoc, type TspHandler, type WireIdentity } from '../src/lab/zustellung-live'

export const FAKE_DID = 'did:webvh:QmFakeMediatorScid1111111111111111111111111111:mediator.example.org:mediator'

export function mediatorKeys(seed = 7) {
  const edSecret = new Uint8Array(32).fill(seed)
  const edPublic = ed25519.getPublicKey(edSecret)
  const xSecret = ed25519.utils.toMontgomerySecret(edSecret)
  const xPublic = x25519.getPublicKey(xSecret)
  return { edSecret, edPublic, xSecret, xPublic }
}

export function fakeDoc(keys = mediatorKeys(), extra: { services?: object[]; methods?: object[]; versionId?: string } = {}): ResolvedDoc {
  return {
    didDocument: {
      id: FAKE_DID,
      verificationMethod: [
        { id: `${FAKE_DID}#key-0`, type: 'Multikey', controller: FAKE_DID, publicKeyMultibase: multibase.encodeMultikey(multibase.MULTICODEC.ED25519_PUB, keys.edPublic) },
        { id: `${FAKE_DID}#key-1`, type: 'Multikey', controller: FAKE_DID, publicKeyMultibase: multibase.encodeMultikey(multibase.MULTICODEC.X25519_PUB, keys.xPublic) },
        ...(extra.methods ?? []),
      ],
      keyAgreement: [`${FAKE_DID}#key-1`],
      authentication: [`${FAKE_DID}#key-0`],
      assertionMethod: [`${FAKE_DID}#key-0`],
      service: extra.services ?? [
        { id: `${FAKE_DID}#tsp`, type: 'TSPTransport', serviceEndpoint: 'https://mediator.example.org/mediator/v1' },
        { id: `${FAKE_DID}#service`, type: ['DIDCommMessaging'], serviceEndpoint: [{ uri: 'https://mediator.example.org/mediator/v1' }, { uri: 'wss://mediator.example.org/mediator/v1/ws' }] },
        { id: `${FAKE_DID}#auth`, type: ['Authentication'], serviceEndpoint: 'https://mediator.example.org/mediator/v1/authenticate' },
      ],
    },
    didDocumentMetadata: { versionId: extra.versionId ?? '2-QmZPSfHthrK9ec3TVbaBZZ7A7dHrgJBW72o1CAwzP2KTQF' },
  }
}

export async function fakeInfo(keys = mediatorKeys(), extra = {}): Promise<MediatorInfo> {
  return summarizeMediator(FAKE_DID, fakeDoc(keys, extra), async () => {
    throw new Error('no other DIDs')
  })
}

// ── Hand-built frames ────────────────────────────────────────────────────────

function sealBody(body: number[], sender: string, receiver: string, senderEd: Uint8Array, receiverX: Uint8Array): Promise<Uint8Array> {
  const out: number[] = []
  wire.encodeCount(wire.TSP_PAYLOAD, body.length / 3, out)
  out.push(...body)
  return sealFrame(new Uint8Array(out), sender, receiver, senderEd, receiverX)
}

async function sealFrame(frame: Uint8Array, sender: string, receiver: string, senderEd: Uint8Array, receiverX: Uint8Array): Promise<Uint8Array> {
  const fields = encodeFields(sender, receiver)
  const sealed = await hpke.sealBase(frame, fields, receiverX, wire.TSP_INFO)
  const ct = new Uint8Array(sealed.enc.length + sealed.ciphertext.length)
  ct.set(sealed.enc, 0)
  ct.set(sealed.ciphertext, sealed.enc.length)
  const field: number[] = []
  wire.encodeVariableData(wire.TSP_HPKE_BASE_CIPHERTEXT, ct, field)
  const bytes = finalizeFrame(fields, new Uint8Array(field))
  const sig = sign.sign(bytes, senderEd)
  const out = Array.from(bytes)
  wire.encodeCount(wire.TSP_ATTACH_GRP, 23, out)
  wire.encodeCount(wire.TSP_INDEX_SIG_GRP, 22, out)
  wire.encodeIndexedEd25519Signature(0, sig, out)
  return new Uint8Array(out)
}

/** Padding-only message (XPAD). */
export function paddingFrame(sender: string, receiver: string, senderEd: Uint8Array, receiverX: Uint8Array) {
  const body: number[] = [...wire.XPAD]
  encodeSenderField(sender, body)
  encodeEmptyPadding(body)
  return sealBody(body, sender, receiver, senderEd, receiverX)
}

/** Upper-layer control payload (XCTL): `messageType = control` without a `control` object. */
export function xctlFrame(sender: string, receiver: string, senderEd: Uint8Array, receiverX: Uint8Array, payload: Uint8Array) {
  const body: number[] = [...wire.XCTL]
  encodeSenderField(sender, body)
  encodeEmptyPadding(body)
  const stream: number[] = []
  wire.encodeVariableData(wire.TSP_PLAINTEXT, payload, stream)
  wire.encodeCount(wire.TSP_GENERIC_STREAM, stream.length / 3, body)
  body.push(...stream)
  return sealBody(body, sender, receiver, senderEd, receiverX)
}

/** A payload frame with an unsupported type marker (the version genus as type). */
export function unknownMarkerFrame(sender: string, receiver: string, senderEd: Uint8Array, receiverX: Uint8Array) {
  const body: number[] = [...wire.YTSP]
  encodeSenderField(sender, body)
  encodeEmptyPadding(body)
  return sealBody(body, sender, receiver, senderEd, receiverX)
}

/** A Rev 3 frame whose version count is patched to Rev 2 (minor 1). */
export function rev2Patched(frame: Uint8Array): Uint8Array {
  const out = frame.slice()
  if (out[8] !== 2) throw new Error('fixture: unexpected version layout')
  out[8] = 1
  return out
}

// ── Fake mediator ────────────────────────────────────────────────────────────

export interface FakeOptions {
  /** Direct frames: relayed only when the envelope sender is the socket DID (observed 17 October), or always. */
  direct: 'socket-sender' | 'any'
  /** Routed frames to the mediator: open and forward the inner frame to hops[0] (only when the outer sender is the socket DID), or drop. */
  routed: 'forward' | 'drop'
  /** Answer an XRFI with an XRFA, or stay silent. */
  invite: 'accept' | 'none'
  /** Queue, but push only when a session opens (delete-to-ack observation tests). */
  holdLive?: boolean
  /** Push every frame twice at once (concurrent copies, review 1 C2). */
  duplicate?: boolean
  /** On `close()`, hand the last frame of that session to the handler once more via `setImmediate` (review 2 C1). */
  redeliverOnClose?: boolean
}

interface Queued {
  text: string
  bytes: Uint8Array
  acked: boolean
}

interface Sub {
  onTsp: TspHandler
  scope: Counters
  last?: Queued
}

export class FakeMediator implements MediatorPort {
  readonly queues = new Map<string, Queued[]>()
  private readonly subs = new Map<string, Set<Sub>>()
  readonly delivered: string[] = []
  constructor(
    readonly did: string,
    private readonly keys: ReturnType<typeof mediatorKeys>,
    private readonly opts: FakeOptions,
    private readonly counters: Counters,
  ) {}

  async open(id: WireIdentity, label: string, onTsp: TspHandler): Promise<PortSession> {
    const scope = this.counters.scope()
    scope.logins.attempted++
    scope.logins.ok++
    scope.sockets.opened++
    scope.sockets.open++
    scope.sockets.maxConcurrent = Math.max(scope.sockets.maxConcurrent, scope.sockets.open)
    const sub: Sub = { onTsp, scope: this.counters }
    let set = this.subs.get(id.did)
    if (!set) this.subs.set(id.did, (set = new Set()))
    set.add(sub)
    for (const q of this.queues.get(id.did) ?? []) if (!q.acked) this.push(sub, q, true)
    let closed = false
    return {
      label,
      sendBinary: (bytes) => {
        scope.bytes.out.socket += bytes.length
        scope.bytes.out.tspSocket += bytes.length
        scope.bytes.out.tspLogical += bytes.length
        void this.inbound(id.did, bytes)
      },
      ack: async (text) => {
        for (const q of this.queues.get(id.did) ?? []) if (q.text === text) q.acked = true
      },
      close: () => {
        if (closed) return
        closed = true
        scope.sockets.open--
        set!.delete(sub)
        const last = sub.last
        if (this.opts.redeliverOnClose && last) setImmediate(() => void sub.onTsp(last.bytes, last.text).catch(() => sub.scope.scope().consumerFailures.push('other')))
      },
    }
  }

  private push(sub: Sub, q: Queued, onOpen = false) {
    if (this.opts.holdLive && !onOpen) return
    sub.last = q
    for (let i = 0; i < (this.opts.duplicate ? 2 : 1); i++)
      setTimeout(() => {
        sub.onTsp(q.bytes, q.text).catch(() => sub.scope.scope().consumerFailures.push('other'))
      }, 1)
  }

  private store(did: string, bytes: Uint8Array) {
    const q: Queued = { text: Buffer.from(bytes).toString('base64url'), bytes, acked: false }
    let list = this.queues.get(did)
    if (!list) this.queues.set(did, (list = []))
    list.push(q)
    this.delivered.push(did)
    for (const sub of this.subs.get(did) ?? []) this.push(sub, q)
  }

  private async inbound(socketDid: string, bytes: Uint8Array) {
    const { envelope } = decodeEnvelope(bytes)
    if (envelope.receiver !== this.did) {
      if (this.opts.direct === 'any' || envelope.sender === socketDid) this.store(envelope.receiver, bytes)
      return
    }
    const m = await unpack(bytes, { receiverDecryptionKey: this.keys.xSecret, senderSigningKey: didKeyKeys(envelope.sender).signPub })
    if (m.messageType === 'routed') {
      if (this.opts.routed === 'forward' && envelope.sender === socketDid && m.hops[0]) this.store(m.hops[0], new Uint8Array(m.payload))
      return
    }
    if (m.messageType === 'control' && m.control?.controlType === 'invite' && this.opts.invite === 'accept') {
      const acc = await packAccept(m.threadDigest, this.did, envelope.sender, { senderSigningKey: this.keys.edSecret, receiverEncryptionKey: didKeyKeys(envelope.sender).encPub })
      this.store(envelope.sender, acc.bytes)
    }
  }
}

/** A promise resolved from outside: an ordering barrier for the tests (review 2 H1). */
export function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * A port that observes the probe's handlers and can hold frames back (review 2 C1/C2/H1):
 * `active()` handlers in flight, `acks()` pickup-ack calls, `rejected()` handler promises that
 * rejected. `hold(label, text)` returns a bucket name to keep a frame back, or null to pass it on;
 * `release(bucket)` hands the held frames to the handler and resolves when they all settled.
 * Held frames reach the handler also after the session was closed, like a late callback.
 */
export function instrumentedPort(base: MediatorPort, hold: (label: string, text: string) => string | null = () => null) {
  let active = 0
  let acks = 0
  let rejected = 0
  const held = new Map<string, Array<() => Promise<void>>>()
  const run = (onTsp: TspHandler, qb2: Uint8Array, text: string) => {
    active++
    return onTsp(qb2, text).then(
      () => void active--,
      (e) => {
        active--
        rejected++
        throw e
      },
    )
  }
  const port: MediatorPort = {
    open: async (id, label, onTsp) => {
      const s = await base.open(id, label, (qb2, text) => {
        const bucket = hold(label, text)
        if (bucket === null) return run(onTsp, qb2, text)
        let list = held.get(bucket)
        if (!list) held.set(bucket, (list = []))
        list.push(() => run(onTsp, qb2, text))
        return Promise.resolve()
      })
      return {
        label: s.label,
        sendBinary: (b) => s.sendBinary(b),
        ack: (text) => {
          acks++
          return s.ack(text)
        },
        close: () => s.close(),
      }
    },
  }
  return {
    port,
    active: () => active,
    acks: () => acks,
    rejected: () => rejected,
    heldCount: (bucket: string) => held.get(bucket)?.length ?? 0,
    release: async (bucket: string) => {
      const list = held.get(bucket) ?? []
      held.delete(bucket)
      await Promise.allSettled(list.map((f) => f()))
    },
  }
}

/** Entropy that plants a marker: every draw starts with the marker bytes, then a counter. */
export function markerRand(marker: string) {
  let n = 0
  const m = new TextEncoder().encode(marker)
  return (len: number) => {
    const out = new Uint8Array(len)
    out.set(m.subarray(0, Math.min(m.length, len)))
    const c = new TextEncoder().encode(String(n++).padStart(8, '0'))
    if (len > m.length) out.set(c.subarray(0, Math.min(c.length, len - m.length)), Math.min(m.length, len))
    return out
  }
}

/** All spellings of a marker that must not appear anywhere. */
export function markerForms(marker: string): string[] {
  const b = Buffer.from(marker)
  return [marker, b.toString('hex'), b.toString('base64url'), b.toString('base64').replace(/=+$/, '')]
}
