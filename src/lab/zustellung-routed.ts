// E11b step 3: an intermediary in the delivery bench (draft rltp/design/port-experimente-e11b-step3-intermediary-
// entwurf-2026-10-21.md, with the build decisions C1–C6, H1 of design review 1). `RoutedIntermediary` rebuilds what the
// live run showed positively for TSP Rev 3 routed mode (vti-tsp-js 0.3.0): it opens the routing layer addressed to its
// own VID, takes the next hop from the library parser (`nextHop` on `m.hops`) and passes the inner `direct` on byte for
// byte to the pickup of the next hop. On the outer layer it applies the session rule of step 2 (`SessionCarrier`): the
// depositing device must hold a session for the outer sender. Everything beyond that is a bench assumption, named here:
//   - it never checks the inner frame (no signature, no match of `next` against the inner receiver): rejecting foreign
//     or altered inner frames is the receiver's (RT3, T5r);
//   - it forwards only to a next hop that holds a session with it (pin §5.3: no relationship to the next hop is an
//     error; class `no-session-next`, C3);
//   - every refusal is silent for the sender (its deposit succeeds, as live) and counted with a class from a closed list
//     (parser rule #95, MV-24), never forwarded, never reinterpreted as a payload.
// Opening is asynchronous (`unpack` is a promise) while the core dispatcher deposits synchronously (C1): a deposit runs
// the synchronous checks and puts the frame into the intermediary's own inbox (the deposit counts as `accepted`); the
// opening runs in the background and the scenario flow awaits `drain()` before every pickup (`RoutedWelt.rounds`).
// The shared core `src/lab/zustellung.ts` is unchanged.

import { decodeEnvelope, nextHop, unpack } from '@openvtc/vti-tsp-js'
import { multibase } from '@openvtc/vti-didcomm-js'
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { Carrier, Device, HORIZON, Welt, party, type Endpoint, type Party, type Report, type Wire } from './zustellung'
import { SessionCarrier, pairWithSessions, sessionsOf, tspSender } from './zustellung-sessions'
import { didKeyKeys } from './zustellung-live/identities'

const enc = new TextEncoder()
const dec = new TextDecoder()

// ── Identity of an intermediary ──────────────────────────────────────────────

/** The intermediary's VID (did:key, Ed25519 from a fixed seed per instance, X25519 derived as in `tsp.ts`). */
export interface HopIdentity {
  vid: string
  edSecret: Uint8Array
  edPublic: Uint8Array
  xSecret: Uint8Array
  xPublic: Uint8Array
}

export function hopIdentity(name: string): HopIdentity {
  const edSecret = sha256(enc.encode(`e11b-intermediary:${name}`))
  const edPublic = ed25519.getPublicKey(edSecret)
  const xSecret = ed25519.utils.toMontgomerySecret(edSecret)
  const xPublic = x25519.getPublicKey(xSecret)
  return { vid: `did:key:${multibase.encodeMultikey(multibase.MULTICODEC.ED25519_PUB, edPublic)}`, edSecret, edPublic, xSecret, xPublic }
}

// ── Classification (C2) ──────────────────────────────────────────────────────

/**
 * Refusal classes, in the order they are checked (C2). Before the inbox (synchronous): `foreign-address` (the deposit
 * is not addressed to this intermediary, e.g. a frame sealed for another one, RT5), `undecodable` (`decodeEnvelope`
 * fails), `session` (the depositing device holds no session for the outer sender), `wrong-receiver` (the outer receiver
 * is not this VID), `bad-vid` (the outer sender's key cannot be resolved from its did:key). After the inbox
 * (asynchronous): `unpack-failed`, `wrong-revision`, `type/<t>` (not `routed`), `multi-hop`, `deliver-to-self`,
 * `empty-inner`, `no-session-next`.
 */
export const REFUSAL_CLASSES = ['foreign-address', 'undecodable', 'session', 'wrong-receiver', 'bad-vid', 'unpack-failed', 'wrong-revision', 'type/direct', 'type/nested', 'type/control', 'type/padding', 'type/other', 'multi-hop', 'deliver-to-self', 'empty-inner', 'no-session-next'] as const
export type RefusalClass = (typeof REFUSAL_CLASSES)[number]

const TYPES = new Set(['direct', 'nested', 'control', 'padding'])

/** What the intermediary reads from a message the library constructed. */
export interface OpenedRouted {
  revision: string
  messageType: string
  hops: string[]
  payload: Uint8Array
}

export type RouteDecision = { kind: 'forward'; next: string; inner: Uint8Array } | { kind: 'refuse'; cls: RefusalClass }

/**
 * Steps (4) to (7) of C2 on an opened message: revision, type, next hop from the library parser, inner content, session
 * of the next hop. A pure function so the defensive guards (`wrong-revision`, `deliver-to-self`, `type/other`) are
 * tested on their own; on the wire vti-tsp-js 0.3.0 cannot produce them (Rev 2 is refused by `unpack` without the
 * sender's X25519 key, `packWithHops(…, 'routed', [])` opens as `nested`).
 */
export function classifyOpened(m: OpenedRouted, hasSession: (vid: string) => boolean): RouteDecision {
  if (m.revision !== 'rev3') return { kind: 'refuse', cls: 'wrong-revision' }
  if (m.messageType !== 'routed') return { kind: 'refuse', cls: (TYPES.has(m.messageType) ? `type/${m.messageType}` : 'type/other') as RefusalClass }
  const step = nextHop(m.hops, m.payload)
  if (step.kind === 'deliver') return { kind: 'refuse', cls: 'deliver-to-self' }
  if (step.remaining.length > 0) return { kind: 'refuse', cls: 'multi-hop' }
  if (step.inner.length === 0) return { kind: 'refuse', cls: 'empty-inner' }
  if (!hasSession(step.next)) return { kind: 'refuse', cls: 'no-session-next' }
  return { kind: 'forward', next: step.next, inner: step.inner }
}

/** The Ed25519 key of a did:key VID; throws for anything else. */
function signingKeyOf(vid: string): Uint8Array {
  if (!vid.startsWith('did:key:')) throw new Error('not a did:key')
  return didKeyKeys(vid).signPub
}

// ── Faults of the intermediary (draft §2.4) ──────────────────────────────────

export type TamperRegion = 'inner-header' | 'inner-ciphertext' | 'inner-signature' | 'inner-garbage' | 'outer-header' | 'outer-ciphertext'
export const TAMPER_REGIONS: readonly TamperRegion[] = ['inner-header', 'inner-ciphertext', 'inner-signature', 'inner-garbage', 'outer-header', 'outer-ciphertext']
export type Times = 'once' | 'always'

/**
 * A changed copy (never in place: the dispatcher keeps the frame for its repetitions). Header: a byte inside the sender
 * VID (offset 20, after the version marker; decodes, names another sender); ciphertext: the middle between the header
 * and the end; signature: the last byte; garbage: the whole frame replaced by bytes of a fixed generator, same length.
 */
export function tampered(bytes: Uint8Array, region: TamperRegion): Uint8Array {
  const t = bytes.slice()
  if (region.endsWith('garbage')) {
    let n = 0x9e3779b9
    for (let i = 0; i < t.length; i++) {
      n = (Math.imul(n, 1664525) + 1013904223) >>> 0
      t[i] = n >>> 24
    }
    return t
  }
  const header = decodeEnvelope(bytes).headerLen
  const pos = region.endsWith('header') ? 20 : region.endsWith('signature') ? t.length - 1 : header + Math.floor((t.length - header) / 2)
  t[pos]! ^= 0x01
  return t
}

interface Rule {
  times: Times
  used: boolean
}

/** One forwarded frame as the intermediary saw it (Z1r: what the intermediary reads after opening). */
export interface OpenedRecord {
  device: string
  outerSender: string
  next: string
  outerBytes: number
  innerBytes: number
  /** Read from the inner envelope without keys (not checked); `?` if it does not decode (forwarded anyway). */
  innerSender: string
  innerReceiver: string
}

export interface RoutedRefusal {
  cls: RefusalClass
  device: string
  address: string
  bytes: number
}

export class RoutedIntermediary extends SessionCarrier {
  /** Refusals with their class: never forwarded, never reported to the sender. */
  readonly refusedRouted: RoutedRefusal[] = []
  /** Frames forwarded, with what the intermediary read. */
  readonly opened: OpenedRecord[] = []
  /** Every outer frame deposited here (before any check): device, address, bytes. */
  readonly inbound: Array<{ device: string; address: string; bytes: Uint8Array }> = []
  private readonly inflight = new Set<Promise<void>>()
  private readonly tamperRules: Array<Rule & { region: TamperRegion; outerSender: string; next: string }> = []
  private readonly misrouteRules: Array<Rule & { next: string; to: string }> = []
  private readonly duplicateRules: Array<{ next: string; delay: 0 | 1 }> = []
  private delayed: Array<{ address: string; bytes: Uint8Array }> = []

  constructor(readonly hop: HopIdentity) {
    super(tspSender)
  }

  /** The intermediary's own VID is not a pickup: registering it opens no session (devices register their sessions). */
  override register(device: string, address: string) {
    if (address === this.hop.vid) return
    super.register(device, address)
  }

  /** Change a frame before opening it (outer regions, matched by outer sender) or before forwarding (inner regions, matched by next hop). */
  tamper(region: TamperRegion, times: Times, match: { outerSender: string; next: string }) {
    this.tamperRules.push({ region, times, used: false, ...match })
  }
  /** Forward frames for `next` to the pickup `to` instead. */
  misroute(next: string, to: string, times: Times) {
    this.misrouteRules.push({ next, to, times, used: false })
  }
  /** Forward frames for `next` twice: the copy at once (`0`) or one round later (`1`). */
  duplicateForward(next: string, delay: 0 | 1) {
    this.duplicateRules.push({ next, delay })
  }

  private take<R extends Rule>(rules: R[], match: (r: R) => boolean): R | undefined {
    const r = rules.find((x) => match(x) && !(x.times === 'once' && x.used))
    if (r) r.used = true
    return r
  }
  private refuse(cls: RefusalClass, device: string | undefined, address: string, bytes: Uint8Array) {
    this.refusedRouted.push({ cls, device: device ?? '?', address, bytes: bytes.length })
  }

  override depositFrom(device: string | undefined, address: string, original: Uint8Array) {
    if (this.unreachable) {
      super.depositFrom(device, address, original) // throws `WireUnreachable` (T10)
      return
    }
    this.inbound.push({ device: device ?? '?', address, bytes: original })
    let bytes = original
    const sender0 = tspSender(original)
    const outerRule = this.take(this.tamperRules, (r) => r.region.startsWith('outer') && r.outerSender === sender0)
    if (outerRule) bytes = tampered(bytes, outerRule.region)
    // (0) the address of the deposit, (1) decode, (2) session, then receiver and the sender's key: all synchronous.
    if (address !== this.hop.vid) return this.refuse('foreign-address', device, address, bytes)
    let outer: { sender: string; receiver: string }
    try {
      outer = decodeEnvelope(bytes).envelope
    } catch {
      return this.refuse('undecodable', device, address, bytes)
    }
    if (!this.sessionHeld(device, bytes)) return this.refuse('session', device, address, bytes)
    if (outer.receiver !== this.hop.vid) return this.refuse('wrong-receiver', device, address, bytes)
    let senderKey: Uint8Array
    try {
      senderKey = signingKeyOf(outer.sender)
    } catch {
      return this.refuse('bad-vid', device, address, bytes)
    }
    // Into the inbox: the deposit is accepted; the opening runs asynchronously and never rejects.
    const p = this.open(device ?? '?', address, bytes, outer.sender, senderKey).catch(() => this.refuse('unpack-failed', device, address, bytes))
    this.inflight.add(p)
    void p.finally(() => this.inflight.delete(p))
  }

  private async open(device: string, address: string, bytes: Uint8Array, outerSender: string, senderKey: Uint8Array) {
    let m: OpenedRouted
    try {
      m = await unpack(bytes, { receiverDecryptionKey: this.hop.xSecret, senderSigningKey: senderKey })
    } catch {
      return this.refuse('unpack-failed', device, address, bytes)
    }
    const d = classifyOpened(m, (vid) => this.registeredAt(vid).length > 0)
    if (d.kind === 'refuse') return this.refuse(d.cls, device, address, bytes)
    let inner = new Uint8Array(d.inner)
    let innerSender = '?'
    let innerReceiver = '?'
    try {
      const e = decodeEnvelope(inner).envelope
      innerSender = e.sender
      innerReceiver = e.receiver
    } catch {
      // read for the measurement only; an undecodable inner frame is forwarded opaquely all the same
    }
    this.opened.push({ device, outerSender, next: d.next, outerBytes: bytes.length, innerBytes: inner.length, innerSender, innerReceiver })
    const innerRule = this.take(this.tamperRules, (r) => r.region.startsWith('inner') && r.next === d.next)
    if (innerRule) inner = tampered(inner, innerRule.region)
    const mis = this.take(this.misrouteRules, (r) => r.next === d.next)
    const to = mis ? mis.to : d.next
    this.forward(to, inner)
    for (const r of this.duplicateRules.filter((x) => x.next === d.next)) {
      if (r.delay === 0) this.forward(to, inner)
      else this.delayed.push({ address: to, bytes: inner })
    }
  }

  /**
   * The base deposit of `Carrier` (queue, `carried`, `dropNextDeposit`, `faults.drop`), not this class's override. The
   * frame was accepted before; forwarding inside the intermediary is not a deposit from outside and does not fail on
   * `unreachable` (pickup is blocked by it anyway).
   */
  private forward(address: string, bytes: Uint8Array) {
    const u = this.unreachable
    this.unreachable = false
    try {
      Carrier.prototype.deposit.call(this, address, bytes)
    } finally {
      this.unreachable = u
    }
  }

  /** The barrier (C1): wait until every opening in the inbox has finished (forwarded or refused). */
  async drain() {
    while (this.inflight.size > 0) await Promise.all([...this.inflight])
  }
  /** A new round: copies held back by `duplicateForward(…, 1)` are forwarded now. */
  tick() {
    const d = this.delayed
    this.delayed = []
    for (const f of d) this.forward(f.address, f.bytes)
  }
  /** Refusals per class. */
  refusals(): Partial<Record<RefusalClass, number>> {
    const out: Partial<Record<RefusalClass, number>> = {}
    for (const r of this.refusedRouted) out[r.cls] = (out[r.cls] ?? 0) + 1
    return out
  }
}

// ── The routed wire, as the scenarios need it ────────────────────────────────

/** An endpoint of the routed wire: deposits go to the intermediary (`address`), pickup is the account. */
export interface RoutedEndpoint extends Endpoint {
  /** The intermediary's VID this side's partner deposits to (changes with `rebindHop`). */
  readonly address: string
  /** This side's connection DID: its account at the intermediary and its pickup address. */
  readonly account: string
  /** The inner sender of frames this side sends (its egress identity). */
  readonly sender: string
  /** The outer sender of frames this side sends (R-c: the account; R-es and R-ce: the egress identity). */
  readonly outerSender: string
  /** Identities this side opens a session for at the intermediary (never the intermediary's VID). */
  readonly sessions: readonly string[]
  /** As `pack`, with the routing step `[next]` instead of this side's account (Z5r: a frame routed to another pickup). */
  packTo(payload: Uint8Array, next: string): Promise<Uint8Array>
  /** As `forge`, but the inner frame names `claimedSender` as its sender (signed with the third party's key, RT3b). */
  forgeAs(payload: Uint8Array, sender: Party, claimedSender: string): Promise<Uint8Array>
  /** New intermediary for future frames (RT5); frames packed before stay sealed to the old one. */
  rebindHop(hop: HopIdentity): void
}

export interface RoutedWire extends Wire {
  /** `form`: R-c and R-es (all cells); `control`: R-ce (RT1-K only). */
  readonly role: 'form' | 'control'
  /** The intermediary the wire binds to. */
  readonly hop: HopIdentity
  bind(a: Party, b: Party): Promise<{ a: RoutedEndpoint; b: RoutedEndpoint }>
}

export type RoutedWireFactory = () => RoutedWire | Promise<RoutedWire>

// ── World with the barrier ───────────────────────────────────────────────────

/** `Welt` on a `RoutedIntermediary`: before every device's round all openings are awaited (C1). */
export class RoutedWelt extends Welt {
  constructor(
    wire: RoutedWire,
    public hop: RoutedIntermediary = new RoutedIntermediary(wire.hop),
  ) {
    super(wire)
    this.carrier = hop
  }
  override async rounds(n: number) {
    for (let i = 0; i < n; i++) {
      this.hop.tick()
      for (const d of this.devices) {
        await this.hop.drain()
        await d.round()
      }
      await this.hop.drain()
    }
  }
}

/** Pair under the session rule (sessions registered, devices bound to their views). */
export async function pairRouted(w: RoutedWelt, a: Party, b: Party, extraB: string[] = []) {
  const out = await pairWithSessions(w, a, b, extraB)
  return { ...out, a: out.A.endpoint as RoutedEndpoint, b: out.B.endpoint as RoutedEndpoint }
}

/** A further device bound to an existing relationship endpoint (e.g. Bob's Carol relationship), with its sessions. */
export function addDevice(w: RoutedWelt, name: string, self: Party, endpoint: RoutedEndpoint, peer: Party, peerEndpoint: RoutedEndpoint): Device {
  const d = new Device(name, self, endpoint, peer, peerEndpoint, w.carrier)
  for (const s of sessionsOf(endpoint)) w.carrier.register(name, s)
  if (w.carrier instanceof SessionCarrier) d.rebind(w.carrier.viewFor(name))
  w.devices.push(d)
  return d
}

/** Carrier change (H1): every device registers its sessions at the new intermediary and is bound to its view there. */
export function rebindWithSessions(w: RoutedWelt, next: RoutedIntermediary) {
  for (const d of w.devices) {
    for (const s of sessionsOf(d.endpoint)) next.register(d.name, s)
    d.rebind(next.viewFor(d.name))
  }
  w.carrier = next
  w.hop = next
}

// ── Scenarios ────────────────────────────────────────────────────────────────

export interface RoutedResult {
  outcome: 'bestanden' | 'nicht bestanden'
  detail: string
  /** Measurements for the NOTES table and the seed sweep. */
  measure?: Record<string, number | string>
}

export interface RoutedScenario {
  id: string
  title: string
  role: 'form' | 'control'
  run(wire: RoutedWire): Promise<RoutedResult>
}

const fmt = (r: Report | null) => (r === null ? 'kein Bericht' : r.state === 'awaiting-transport' ? `awaiting-transport(${r.reason})` : r.state === 'failed' ? `failed(${r.reason})` : r.state === 'delivered' ? `delivered${r.late ? ' (late)' : ''}` : r.state)
const same = (x: Uint8Array, y: Uint8Array) => x.length === y.length && x.every((v, i) => v === y[i])
const atWire = (d: Device) => d.dispositions.filter((x) => x.startsWith('failed(malformed): ')).length
const count = (xs: string[], v: string) => xs.filter((x) => x === v).length
const pass = (ok: boolean, detail: string, measure?: RoutedResult['measure']): RoutedResult => ({ outcome: ok ? 'bestanden' : 'nicht bestanden', detail, ...(measure ? { measure } : {}) })
/** Extra rounds after the first `delivered`, so delayed duplicates and repeated receipts are seen (C5). */
const SETTLE = HORIZON.ackWait + 2

async function world(wire: RoutedWire, extraB: string[] = []) {
  const w = new RoutedWelt(wire)
  const al = await party('alice')
  const bo = await party('bob')
  const p = await pairRouted(w, al, bo, extraB)
  return { w, al, bo, ...p }
}

/** Run until Alice's report for `d` is final; `failedAfter` = rounds since acceptance at the moment she gave up. */
async function settle(w: RoutedWelt, A: Device, d: string, max = HORIZON.giveUp + 8) {
  const n = await w.until(() => ['delivered', 'failed'].includes(A.zusteller.report(d)?.state ?? ''), max)
  const r = A.zusteller.report(d)
  const s = A.zusteller.submissions.get(d)!
  const failedAfter = r?.state === 'failed' ? s.sinceAccepted : null
  if (r?.state === 'delivered') await w.rounds(SETTLE)
  return { n, r: A.zusteller.report(d), s, failedAfter }
}

export const routedDeliveryScenarios: RoutedScenario[] = [
  {
    id: 'RT1-K',
    title: 'Kontrolle Sessionregel: äußere Hülle vom Egress ohne eigene Session wird am Intermediär verworfen',
    role: 'control',
    async run(wire) {
      const { w, A, B } = await world(wire)
      const d = await A.send({ note: 'kontrolle' })
      const { r, failedAfter } = await settle(w, A, d)
      const ref = w.hop.refusals()
      const ok = r?.state === 'failed' && failedAfter === HORIZON.giveUp && B.dispositions.length === 0 && (ref.session ?? 0) > 0 && Object.keys(ref).every((k) => k === 'session') && w.hop.opened.length === 0
      return pass(ok, `Alice: ${fmt(r)} nach ${failedAfter} Runden ab Annahme; Bob: ${B.dispositions.length} Dispositionen; Intermediär: ${JSON.stringify(ref)}, weitergereicht ${w.hop.opened.length}`, { sessions: w.hop.sessions() })
    },
  },
  {
    id: 'RT4a',
    title: 'T9 routed: Quittung geht verloren, Sender wiederholt, Empfänger dedupliziert und quittiert byte-identisch (außen und innen)',
    role: 'form',
    async run(wire) {
      const { w, A, B, a } = await world(wire)
      const d = await A.send({ note: 'eins' })
      w.hop.dropDeliveryTo.add(a.account)
      const { n, r, s } = await settle(w, A, d)
      const outerAcks = w.hop.inbound.filter((f) => f.device === B.name).map((f) => f.bytes)
      const innerAcks = w.hop.carried.filter((f) => f.address === a.account).map((f) => f.bytes)
      const idOuter = outerAcks.length >= 2 && outerAcks.every((x) => same(x, outerAcks[0]!))
      const idInner = innerAcks.length >= 2 && innerAcks.every((x) => same(x, innerAcks[0]!))
      const ok = r?.state === 'delivered' && !r.late && B.received.length === 1 && s.deposits === 2 && B.dispositions.includes('duplicate-known') && idOuter && idInner && w.hop.refusedRouted.length === 0
      return pass(ok, `Alice: ${fmt(r)} nach ${n} Runden, ${s.deposits} Einlieferungen; Bob: Wirkung ${B.received.length}, ${B.dispositions.join(',')}; Quittungen außen ${outerAcks.length} gleich ${idOuter ? 'ja' : 'nein'}, innen ${innerAcks.length} gleich ${idInner ? 'ja' : 'nein'}`)
    },
  },
  {
    id: 'RT4b',
    title: 'T10 routed: Gerät offline, Intermediär unerreichbar, Empfänger offline: Bericht je Runde, nie Schweigen',
    role: 'form',
    async run(wire) {
      const { w, A, B } = await world(wire)
      A.online = false
      const d = await A.send({ note: 'zwei' })
      await w.rounds(HORIZON.status)
      const r1 = A.zusteller.report(d)
      A.online = true
      w.hop.unreachable = true
      await w.rounds(HORIZON.status)
      const r2 = A.zusteller.report(d)
      w.hop.unreachable = false
      B.online = false
      await w.rounds(HORIZON.status)
      const r3 = A.zusteller.report(d)
      B.online = true
      const n = await w.until(() => A.zusteller.report(d)?.state === 'delivered')
      const r4 = A.zusteller.report(d)
      const ok = r1?.state === 'awaiting-transport' && r1.reason === 'offline' && r2?.state === 'awaiting-transport' && r2.reason === 'transport-unreachable' && r3?.state === 'accepted' && r4?.state === 'delivered' && B.received.length === 1
      return pass(ok, `offline: ${fmt(r1)}; Intermediär weg: ${fmt(r2)}; Bob offline: ${fmt(r3)}; danach ${fmt(r4)} nach ${n} Runden`)
    },
  },
  {
    id: 'Z1r',
    title: 'Was Intermediär und Partner lernen: Konto, Egress, Empfängeradresse; nie Inhalt, Anker oder Name',
    role: 'form',
    async run(wire) {
      const { w, al, bo, A, B, a, b } = await world(wire)
      const d = await A.send({ note: 'geheim-drei' })
      await settle(w, A, d)
      const outerDoc = w.hop.inbound.find((f) => f.device === A.name)!.bytes
      const innerDoc = w.hop.carried.find((f) => f.address === b.account)!.bytes
      const leaks = [outerDoc, innerDoc].flatMap((f) => {
        const t = dec.decode(f)
        return [t.includes('geheim-drei') ? 'Inhalt' : '', t.includes(al.anchor) || t.includes(bo.anchor) ? 'Anker' : '', t.includes(al.name) ? 'Name' : ''].filter(Boolean)
      })
      const docSeen = w.hop.opened.find((o) => o.next === b.account)!
      const ackSeen = w.hop.opened.find((o) => o.next === a.account)!
      const label = (did: string) => (did === a.account ? 'Konto(alice)' : did === a.sender ? 'Egress(alice)' : did === b.account ? 'Konto(bob)' : did === b.sender ? 'Egress(bob)' : did)
      const obs = B.endpoint.observe(innerDoc)
      const accountInInner = dec.decode(innerDoc).includes(a.account)
      // Alice's two relationships share no DID.
      const other = await wire.bind(al, await party('carol'))
      const mine = new Set([a.account, a.sender, a.outerSender])
      const shared = [other.a.account, other.a.sender, other.a.outerSender].some((x) => mine.has(x))
      const overhead = w.hop.opened.map((o) => o.outerBytes - o.innerBytes)
      const ok = leaks.length === 0 && B.received.length === 1 && !accountInInner && ackSeen.next === a.account && !shared && docSeen.innerSender === a.sender && docSeen.innerReceiver === b.account
      const intermediary = `außen ${label(docSeen.outerSender)}, next ${label(docSeen.next)}, innen ${label(docSeen.innerSender)} → ${label(docSeen.innerReceiver)}`
      return pass(
        ok,
        `Rahmen innen ${innerDoc.length} B, außen ${outerDoc.length} B; Intermediär liest ${intermediary}; Partner sieht ${Object.entries(obs).map(([k, v]) => `${k}=${v}`).join(', ')}; Alices Konto im inneren Rahmen: ${accountInInner ? 'ja' : 'nein'}; Bobs Quittungen an ${label(ackSeen.next)}; Beziehungen teilen DID: ${shared ? 'ja' : 'nein'}; Hülle +${[...new Set(overhead)].join('/')} B; Lecks: ${leaks.length ? leaks.join(',') : 'keine'}`,
        { innerDoc: innerDoc.length, outerDoc: outerDoc.length, sessions: w.hop.sessions(), overhead: [...new Set(overhead)].join('/'), outerSender: label(docSeen.outerSender), intermediary },
      )
    },
  },
  {
    id: 'Z2r',
    title: 'Neue Instanz des Intermediärs mit gleicher VID und Schlüssel: Wartendes geht hinaus',
    role: 'form',
    async run(wire) {
      const { w, A, B } = await world(wire)
      const d1 = await A.send({ note: 'vorher' })
      await w.until(() => A.zusteller.report(d1)?.state === 'delivered')
      w.hop.unreachable = true
      const d2 = await A.send({ note: 'während' })
      await w.rounds(HORIZON.status)
      const r = A.zusteller.report(d2)
      const neu = new RoutedIntermediary(wire.hop)
      rebindWithSessions(w, neu)
      const n = await w.until(() => A.zusteller.report(d2)?.state === 'delivered')
      const ok = r?.state === 'awaiting-transport' && A.zusteller.report(d2)?.state === 'delivered' && B.received.length === 2 && neu.opened.length > 0
      return pass(ok, `vor dem Wechsel ${fmt(r)}, danach ${fmt(A.zusteller.report(d2))} nach ${n} Runden; Bob hat ${B.received.length} Dokumente; neue Instanz reichte ${neu.opened.length} Rahmen weiter, ${neu.sessions()} Sessions`)
    },
  },
  {
    id: 'Z3r',
    title: 'Zwei Geräte Bobs mit Session am selben Konto: beide erhalten, Alice wird einmal bestätigt',
    role: 'form',
    async run(wire) {
      const { w, A, B, more } = await world(wire, ['bob-2'])
      const B2 = more[0]!
      const d = await A.send({ note: 'an-beide' })
      const n = await w.until(() => A.zusteller.report(d)?.state === 'delivered' && B.received.length === 1 && B2.received.length === 1)
      const ok = n > 0 && A.zusteller.report(d)?.state === 'delivered' && !(A.zusteller.report(d) as { late: boolean }).late
      return pass(ok, `Alice: ${fmt(A.zusteller.report(d))} nach ${n} Runden; bob: ${B.received.length}, bob-2: ${B2.received.length}`)
    },
  },
  {
    id: 'RT3a',
    title: 'Z4 routed: fremder innerer Sender (Mallory mit eigener Session); der Intermediär reicht weiter, Bob weist am Draht ab',
    role: 'form',
    async run(wire) {
      const { w, B, b } = await world(wire)
      const m = await party('mallory')
      const forged = await B.sealedFor(m, { note: 'von-mallory' })
      const frame = await b.forge(forged.bytes, m)
      w.hop.register('mallory', tspSender(frame)!)
      w.hop.depositFrom('mallory', b.address, frame)
      await w.rounds(2)
      const fwd = w.hop.opened.filter((o) => o.device === 'mallory').length
      const ok = fwd === 1 && atWire(B) > 0 && B.received.length === 0
      return pass(ok, `weitergereicht ${fwd}; Bob: ${B.dispositions.join(',')}; Wirkung ${B.received.length}`)
    },
  },
  {
    id: 'RT3b',
    title: 'Absendername gefälscht: innere Hülle nennt Alices Egress, signiert mit Mallorys Schlüssel; Bob weist am Draht ab',
    role: 'form',
    async run(wire) {
      const { w, B, a, b } = await world(wire)
      const m = await party('mallory')
      const forged = await B.sealedFor(m, { note: 'als-alice' })
      const frame = await b.forgeAs(forged.bytes, m, a.sender)
      w.hop.register('mallory', tspSender(frame)!)
      w.hop.depositFrom('mallory', b.address, frame)
      await w.rounds(2)
      const seen = w.hop.opened.filter((o) => o.device === 'mallory')
      const ok = seen.length === 1 && seen[0]!.innerSender === a.sender && atWire(B) > 0 && B.dispositions.some((x) => x.includes('signature')) && B.received.length === 0
      return pass(ok, `weitergereicht ${seen.length} (innen als ${seen[0]?.innerSender === a.sender ? 'Egress(alice)' : '?'}); Bob: ${B.dispositions.join(',')}; Wirkung ${B.received.length}`)
    },
  },
  {
    id: 'Z5r',
    title: 'Falscher Empfängerschlüssel: Carol routet an Bobs Alice-Konto, innen an Bobs Carol-Konto; Bob weist am Draht ab',
    role: 'form',
    async run(wire) {
      const { w, B, b } = await world(wire)
      const c = await party('carol')
      const other = await wire.bind(c, B.party)
      const doc = await B.sealedFor(c, { note: 'von-carol' })
      const frame = await other.b.packTo(doc.bytes, b.account)
      w.hop.register('carol', other.a.outerSender)
      w.hop.depositFrom('carol', b.address, frame)
      await w.rounds(2)
      const seen = w.hop.opened.filter((o) => o.device === 'carol')
      const ok = seen.length === 1 && seen[0]!.next === b.account && seen[0]!.innerReceiver === other.b.account && atWire(B) > 0 && B.received.length === 0
      return pass(ok, `weitergereicht an Bobs Alice-Konto: ${seen.length}; Bob: ${B.dispositions.join(',')}; Wirkung ${B.received.length}`)
    },
  },
  {
    id: 'RT5',
    title: 'Intermediär-Neubindung bei unveränderten Endpunkten: Wartendes für I1 strandet an I2, nie still',
    role: 'form',
    async run(wire) {
      const { w, A, B, a, b } = await world(wire)
      const d1 = await A.send({ note: 'eins' })
      await w.until(() => A.zusteller.report(d1)?.state === 'delivered')
      w.hop.unreachable = true
      const d2 = await A.send({ note: 'zwei' })
      await w.rounds(HORIZON.status + 2)
      const r2before = A.zusteller.report(d2)
      const i2 = hopIdentity('i2')
      a.rebindHop(i2)
      b.rebindHop(i2)
      const hop2 = new RoutedIntermediary(i2)
      rebindWithSessions(w, hop2)
      const d3 = await A.send({ note: 'drei' })
      const n = await w.until(() => A.zusteller.report(d3)?.state === 'delivered' && A.zusteller.report(d2)?.state === 'failed', HORIZON.giveUp + 8)
      const s2 = A.zusteller.submissions.get(d2)!
      const ref = hop2.refusals()
      const ok = A.zusteller.report(d1)?.state === 'delivered' && A.zusteller.report(d3)?.state === 'delivered' && r2before?.state === 'awaiting-transport' && A.zusteller.report(d2)?.state === 'failed' && s2.sinceAccepted === HORIZON.giveUp && (ref['foreign-address'] ?? 0) > 0 && Object.keys(ref).every((k) => k === 'foreign-address') && B.received.length === 2
      return pass(ok, `d1 ${fmt(A.zusteller.report(d1))}; d2 vor der Neubindung ${fmt(r2before)}, danach ${fmt(A.zusteller.report(d2))} ${s2.sinceAccepted} Runden ab Annahme an I2; d3 ${fmt(A.zusteller.report(d3))}; I2: ${JSON.stringify(ref)}, ${hop2.sessions()} Sessions; Bob ${B.received.length} Dokumente; ${n} Runden`, { sessionsI2: hop2.sessions() })
    },
  },
]

// T3r: duplicates (draft §4.4, C4, C5).
const T3_BRANCHES: Array<{ id: string; target: 'doc' | 'ack' | 'both'; set: (w: RoutedWelt, a: RoutedEndpoint, b: RoutedEndpoint) => void }> = [
  { id: 'pickup-duplicate', target: 'both', set: (w) => w.hop.faults.duplicate(true) },
  ...(['doc', 'ack'] as const).flatMap((target) =>
    ([0, 1] as const).map((delay) => ({ id: `forward-${target}-delay${delay}`, target, set: (w: RoutedWelt, a: RoutedEndpoint, b: RoutedEndpoint) => w.hop.duplicateForward(target === 'doc' ? b.account : a.account, delay) })),
  ),
]

for (const br of T3_BRANCHES) {
  routedDeliveryScenarios.push({
    id: `T3r/${br.id}`,
    title: `Duplikat (${br.id}): Wirkung 1, aufbewahrte Quittung byte-identisch, Alice genau einmal bestätigt`,
    role: 'form',
    async run(wire) {
      const { w, A, B, a, b } = await world(wire)
      br.set(w, a, b)
      const d = await A.send({ note: 'doppelt' })
      const { r } = await settle(w, A, d)
      const bobDup = B.dispositions.includes('duplicate-known')
      const outerAcks = w.hop.inbound.filter((f) => f.device === B.name).map((f) => f.bytes)
      const acksSame = outerAcks.every((x) => same(x, outerAcks[0]!))
      const aliceUnique = count(A.dispositions, 'unique')
      const aliceDup = A.dispositions.includes('duplicate-known')
      const ok =
        r?.state === 'delivered' &&
        !r.late &&
        B.received.length === 1 &&
        bobDup === (br.target !== 'ack') &&
        (br.target === 'ack' || outerAcks.length >= 2) &&
        acksSame &&
        aliceUnique === 1 &&
        aliceDup &&
        atWire(A) + atWire(B) === 0
      return pass(ok, `Alice: ${fmt(r)}, ${A.dispositions.join(',')}; Bob: Wirkung ${B.received.length}, ${B.dispositions.join(',')}; Quittungen außen ${outerAcks.length}, gleich ${acksSame ? 'ja' : 'nein'}`)
    },
  })
}

// T5r: tampering and misrouting (draft §4.4 with C4: expectations per direction; outer header: class from a set).
const OUTER_HEADER = new Set<RefusalClass>(['undecodable', 'session', 'wrong-receiver', 'bad-vid', 'unpack-failed'])

for (const region of TAMPER_REGIONS) {
  for (const target of ['doc', 'ack'] as const) {
    for (const times of ['once', 'always'] as const) {
      routedDeliveryScenarios.push({
        id: `T5r/${region}/${target}/${times}`,
        title: `Manipulation ${region} an ${target === 'doc' ? 'Dokument' : 'Quittung'}, ${times}: nie still, nie Wirkung aus verändertem Rahmen`,
        role: 'form',
        run: (wire) => t5(wire, { kind: 'tamper', region }, target, times),
      })
    }
  }
}
for (const target of ['doc', 'ack'] as const) {
  for (const times of ['once', 'always'] as const) {
    routedDeliveryScenarios.push({
      id: `T5r/misroute/${target}/${times}`,
      title: `Fehlleitung der ${target === 'doc' ? 'Dokument' : 'Quittung'}-Hülle an Bobs Carol-Abholung, ${times}`,
      role: 'form',
      run: (wire) => t5(wire, { kind: 'misroute' }, target, times),
    })
  }
}

async function t5(wire: RoutedWire, fault: { kind: 'tamper'; region: TamperRegion } | { kind: 'misroute' }, target: 'doc' | 'ack', times: Times): Promise<RoutedResult> {
  const { w, A, B, a, b } = await world(wire)
  const c = await party('carol')
  const cb = await wire.bind(c, B.party)
  const BC = addDevice(w, 'bob-carol', B.party, cb.b, c, cb.a)
  const next = target === 'doc' ? b.account : a.account
  const outerSender = target === 'doc' ? a.outerSender : b.outerSender
  const receiver = target === 'doc' ? B : A
  const outer = fault.kind === 'tamper' && fault.region.startsWith('outer')
  if (fault.kind === 'tamper') w.hop.tamper(fault.region, times, { outerSender, next })
  else w.hop.misroute(next, cb.b.account, times)
  const d = await A.send({ note: 'manipuliert' })
  const { r, failedAfter } = await settle(w, A, d)
  const ref = w.hop.refusedRouted
  const refusedOk = outer ? ref.length > 0 && ref.every((x) => (fault.region === 'outer-ciphertext' ? x.cls === 'unpack-failed' : OUTER_HEADER.has(x.cls))) : ref.length === 0
  const wireRejects = fault.kind === 'misroute' ? atWire(BC) : atWire(receiver)
  // Never delivered without a valid signed receipt: a delivered report needs a receipt Alice accepted.
  const signed = r?.state !== 'delivered' || count(A.dispositions, 'unique') >= 1
  const effect = B.received.length
  let ok = signed && effect <= 1 && refusedOk && BC.received.length === 0
  if (times === 'once') {
    ok &&= r?.state === 'delivered' && !r.late && effect === 1
    if (!outer) ok &&= wireRejects >= 1
    if (target === 'ack') ok &&= B.dispositions.includes('duplicate-known')
  } else {
    ok &&= r?.state === 'failed' && failedAfter === HORIZON.giveUp && effect === (target === 'doc' ? 0 : 1)
    if (!outer) ok &&= wireRejects >= 1
    if (outer && target === 'doc') ok &&= B.dispositions.length === 0
  }
  return pass(ok, `Alice: ${fmt(r)}${failedAfter !== null ? ` nach ${failedAfter} Runden ab Annahme` : ''}; Bob: Wirkung ${effect}, ${B.dispositions.join(',') || '-'}; bob-carol: ${BC.dispositions.join(',') || '-'}; am Draht abgewiesen ${wireRejects}; Intermediär: ${JSON.stringify(w.hop.refusals())}`)
}

export async function runRouted(make: RoutedWireFactory): Promise<Array<{ scenario: string; title: string } & RoutedResult>> {
  const out: Array<{ scenario: string; title: string } & RoutedResult> = []
  const probe = await make()
  for (const s of routedDeliveryScenarios.filter((x) => x.role === probe.role)) {
    const wire = await make()
    try {
      out.push({ scenario: s.id, title: s.title, ...(await s.run(wire)) })
    } catch (e) {
      out.push({ scenario: s.id, title: s.title, outcome: 'nicht bestanden', detail: `Fehler: ${(e as Error).message}` })
    }
  }
  return out
}
