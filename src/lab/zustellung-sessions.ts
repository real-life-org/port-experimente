// E11b step 2: sessions at the carrier. The bench `Carrier` routes by address and knows registrations (device,
// address); a "session" is the registration of an identity at the carrier. `SessionCarrier` adds the rule the live
// VTI mediator showed on 17 and 21 October: it forwards a frame only if the frame's envelope sender holds a session
// there; otherwise the frame is dropped silently (the sender's socket send succeeds, nothing is delivered). The bench
// has no socket per deposit (the dispatcher deposits by address), so the rule reads "the envelope sender holds a
// session at this carrier"; for every form modelled here that is the same as "the envelope sender is the socket's
// identity" (a sender either sends on its own session or has none). Subclass only: the shared core
// (`src/lab/zustellung.ts`, also the E15 foundation) is unchanged, its default carrier has no such rule.

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
    if (!this.unreachable) {
      const sender = this.senderOf(bytes)
      if (sender === undefined || this.registeredAt(sender).length === 0) {
        this.refused.push({ address, sender: sender ?? '?', bytes: bytes.length })
        return
      }
    }
    super.deposit(address, bytes)
  }
}

/** An endpoint that names the identities its side holds a session for (address first). Plain endpoints: the address only. */
export const sessionsOf = (e: Endpoint): readonly string[] => (e as Endpoint & { sessions?: readonly string[] }).sessions ?? [e.address]

/** `Welt.pair`, then every device opens a session for each identity its own endpoint names (the address is already registered). */
export async function pairWithSessions(w: Welt, a: Party, b: Party, extraB: string[] = []): Promise<{ A: Device; B: Device; more: Device[] }> {
  const out = await w.pair(a, b, extraB)
  for (const d of [out.A, out.B, ...out.more]) for (const s of sessionsOf(d.endpoint)) w.carrier.register(d.name, s)
  return out
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

export async function sessionCell(wire: Wire, rounds = 20): Promise<SessionCellResult> {
  const w = new Welt(wire)
  const carrier = new SessionCarrier(tspSender)
  w.carrier = carrier
  const { A, B } = await pairWithSessions(w, await party('alice'), await party('bob'))
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
