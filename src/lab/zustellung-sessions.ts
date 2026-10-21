// E11b step 2: sessions at the carrier. The bench `Carrier` routes by address and knows registrations (device,
// address); a "session" is the registration of an identity at the carrier by a device (its socket for that identity).
// `SessionCarrier` reproduces the outcome the live VTI mediator showed on 17 and 21 October (D-e: egress sender over
// the connection socket, nothing delivered; the cause is not established): it forwards a frame only if the
// device that deposits it holds a session for the frame's envelope sender, i.e. the sender is the identity of the
// socket the frame comes in on; otherwise the frame is dropped silently (the sender's socket send succeeds, nothing is
// delivered). A device with several sessions deposits on the one whose identity is the sender, if it holds one; a
// device without it could only use another socket, and then sender and socket differ. The core deposits by address
// without naming the device, so the depositing device comes from a per-device view of the carrier (`viewFor`), which
// `pairWithSessions` binds each device to. A deposit that names no device (tests depositing at `w.carrier` directly,
// as a third party would) keeps the weaker rule "some device holds a session for the sender". Subclass only: the
// shared core (`src/lab/zustellung.ts`, also the E15 foundation) is unchanged, its default carrier has no such rule.

import { decodeEnvelope } from '@openvtc/vti-tsp-js'
import { Carrier, Welt, party, type Device, type Endpoint, type Party, type Wire } from './zustellung'

/** The envelope sender of a TSP frame, as the carrier reads it without keys; undefined if the frame does not decode. */
export function tspSender(bytes: Uint8Array): string | undefined {
  try {
    return decodeEnvelope(bytes).envelope.sender
  } catch {
    return undefined
  }
}

export class SessionCarrier extends Carrier {
  /** Frames dropped by the session rule: address, the sender as read, size. Never delivered, never reported. */
  readonly refused: Array<{ address: string; sender: string; bytes: number }> = []
  private readonly held = new Set<string>()
  constructor(private readonly senderOf: (bytes: Uint8Array) => string | undefined) {
    super()
  }
  override register(device: string, address: string) {
    super.register(device, address)
    this.held.add(`${device}\u0000${address}`)
  }
  /** Sessions opened so far: distinct (device, identity) registrations. */
  sessions(): number {
    return this.held.size
  }
  override deposit(address: string, bytes: Uint8Array) {
    this.depositFrom(undefined, address, bytes)
  }
  /** The session rule: `device` holds a session for the frame's envelope sender; `undefined`: some device does (weaker rule, see top). */
  protected sessionHeld(device: string | undefined, bytes: Uint8Array): boolean {
    const sender = this.senderOf(bytes)
    const holders = sender === undefined ? [] : this.registeredAt(sender)
    return device === undefined ? holders.length > 0 : holders.includes(device)
  }
  /** A deposit by `device` (on its socket for the envelope sender); `undefined`: by no known device (weaker rule, see top). */
  depositFrom(device: string | undefined, address: string, bytes: Uint8Array) {
    if (!this.unreachable && !this.sessionHeld(device, bytes)) {
      this.refused.push({ address, sender: this.senderOf(bytes) ?? '?', bytes: bytes.length })
      return
    }
    super.deposit(address, bytes)
  }
  /** This carrier as `device` uses it: everything shared, but its deposits name the device. */
  viewFor(device: string): Carrier {
    return new Proxy(this, {
      get: (t, k) => {
        if (k === 'deposit') return (address: string, bytes: Uint8Array) => t.depositFrom(device, address, bytes)
        const v: unknown = Reflect.get(t, k, t)
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
      },
    })
  }
}

/** An endpoint that names the identities its side holds a session for (address first). Plain endpoints: the address only. */
export const sessionsOf = (e: Endpoint): readonly string[] => (e as Endpoint & { sessions?: readonly string[] }).sessions ?? [e.address]

/**
 * `Welt.pair`, then every device opens a session for each identity its own endpoint names (the address is already
 * registered); under a `SessionCarrier` each device is bound to its view, so its deposits name it.
 */
export async function pairWithSessions(w: Welt, a: Party, b: Party, extraB: string[] = []): Promise<{ A: Device; B: Device; more: Device[] }> {
  const out = await w.pair(a, b, extraB)
  const carrier = w.carrier
  for (const d of [out.A, out.B, ...out.more]) {
    for (const s of sessionsOf(d.endpoint)) carrier.register(d.name, s)
    if (carrier instanceof SessionCarrier) d.rebind(carrier.viewFor(d.name))
  }
  return out
}

/**
 * Carrier switch under the session rule: every device reopens a session for each identity its endpoint names at `next`
 * and is bound to its view there (`Device.rebind()` alone registers only the address). The caller sets `w.carrier`.
 */
export function rebindSessions(devices: readonly Device[], next: SessionCarrier) {
  for (const d of devices) {
    for (const s of sessionsOf(d.endpoint)) next.register(d.name, s)
    d.rebind(next.viewFor(d.name))
  }
}

/** One cell under the session rule: Alice sends one document to Bob, Bob's receipt comes back under the same rule. */
export interface SessionCellResult {
  delivered: boolean
  /** Alice's report at the end. */
  report: string
  /** Sessions opened at the carrier for this relationship (both sides). */
  sessions: number
  /** Frames the session rule dropped. */
  refused: number
  /** Size of the first document frame (carried or refused) and of the first receipt frame. */
  docBytes: number
  ackBytes: number
  /** Bob's dispositions: empty when nothing reached him. */
  receiverSaw: string[]
}

/** `setup` runs after pairing, before the document is sent (e.g. foreign devices opening sessions). */
export async function sessionCell(wire: Wire, rounds = 20, setup?: (carrier: SessionCarrier, A: Device, B: Device) => void): Promise<SessionCellResult> {
  const w = new Welt(wire)
  const carrier = new SessionCarrier(tspSender)
  w.carrier = carrier
  const { A, B } = await pairWithSessions(w, await party('alice'), await party('bob'))
  setup?.(carrier, A, B)
  const d = await A.send({ note: 'session' })
  await w.until(() => A.zusteller.report(d)?.state === 'delivered', rounds)
  const r = A.zusteller.report(d)
  const docs = carrier.carried.filter((f) => f.address === B.endpoint.address)
  const acks = carrier.carried.filter((f) => f.address === A.endpoint.address)
  return {
    delivered: r?.state === 'delivered',
    report: r === null ? 'none' : r.state === 'failed' ? `failed(${r.reason})` : r.state,
    sessions: carrier.sessions(),
    refused: carrier.refused.length,
    docBytes: docs[0]?.bytes.length ?? carrier.refused[0]?.bytes ?? 0,
    ackBytes: acks[0]?.bytes.length ?? 0,
    receiverSaw: B.dispositions.slice(),
  }
}
