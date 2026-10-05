import type { Device, EnforcingService, Msg } from '../../lab/types'
import { AuthorityLog, type AuthOp } from './authority'

// E8: Zwei durchsetzende, schlüsselblinde Dienste am Relay des Prüfstands.
//
// „sichten“ folgt Access §7.3: Der Dienst kennt den Log nicht. Er lernt die
// Mitgliedschaft nur aus Autorisierungssichten (seq, Vorgänger, identities =
// Geräte-IDs, m für die nächste Sicht), die von m Geräten gleichlautend
// vorgeschlagen werden, die in alter UND neuer Sicht stehen. Er bestätigt
// jede angenommene Sicht an alle (ack), damit die Geräte seq und Vorgänger
// kennen.
//
// „logreplik“ ist die Kontrolle nach Art von Gen 2: Der Dienst führt eine
// Replik des Autoritätslogs und wertet sie selbst aus.
//
// Beide binden ein Gerät an seine BeeKEM-ID über die Karte, die es selbst
// sendet (im Experiment ohne Besitznachweis; §7.3 verlangt eine Challenge).
// Ohne Signaturen: Fälschung ist nicht Thema dieses Experiments.

const enc = new TextEncoder()
const dec = new TextDecoder()

export interface ViewProposal {
  t: 'view'
  seq: number
  prev: string | null
  identities: string[]
  /** Quorum ab der nächsten Sicht. */
  m: number
  signer: string
}
export interface ViewAck {
  t: 'ack'
  seq: number
  hash: string
  identities: string[]
  m: number
}

type ServiceWire =
  | { t: 'card'; person: string; id: string }
  | { t: 'auth'; op: AuthOp }
  | ViewProposal
  | { t: string }

/** Inhalt einer Sicht ohne Signierer, als stabiler Schlüssel. */
export const viewHash = (v: { seq: number; prev: string | null; identities: string[]; m: number }) =>
  JSON.stringify([v.seq, v.prev, [...v.identities].sort(), v.m])

abstract class Base implements EnforcingService {
  protected readonly idOf = new Map<Device, string>()
  protected readonly outgoing: Array<{ label: string; body: Uint8Array }> = []
  protected dropped = 0

  protected abstract allows(id: string | undefined): boolean
  protected abstract ingest(from: Device, m: ServiceWire): 'weiter' | 'verwerfen' | 'behalten' | undefined

  accept(msg: Msg) {
    const m = JSON.parse(dec.decode(msg.body)) as ServiceWire
    if (m.t === 'card') {
      const c = m as { id: string }
      // Erste Karte eines Geräts bindet es; eine andere ID vom selben Gerät wird verworfen.
      const known = this.idOf.get(msg.from)
      if (known && known !== c.id) return this.drop()
      this.idOf.set(msg.from, c.id)
      return 'weiter'
    }
    const special = this.ingest(msg.from, m)
    if (special) return special === 'verwerfen' ? this.drop() : special
    // Autoritätsoperationen sind Evidenz für die Konfliktmatrix (gleichzeitige
    // Entfernungen, Strong Removal) und gehen immer durch; ob sie gelten,
    // entscheidet jede Replik selbst (Access §9.3: Evidenztransport ist nie
    // gated). Gated sind Inhalt, Schlüsseloperationen und Widerrufe.
    if (m.t === 'auth') return 'weiter'
    if (!this.allows(this.idOf.get(msg.from))) return this.drop()
    return 'weiter'
  }
  protected drop() {
    this.dropped++
    return 'verwerfen' as const
  }
  serves(device: Device) {
    return this.allows(this.idOf.get(device))
  }
  takeOutgoing() {
    return this.outgoing.splice(0)
  }
  abstract status(): string
}

/** Variante 1: Dienst mit Autorisierungssichten (Access §7.3). */
export class ViewService extends Base {
  private accepted: { seq: number; hash: string | null; identities: Set<string>; m: number } = { seq: 0, hash: null, identities: new Set(), m: 1 }
  /** Vorschläge je Inhalt: Signierer. */
  private proposals = new Map<string, Set<string>>()
  private rejectedViews = 0

  protected allows(id: string | undefined) {
    // Vor der ersten Sicht: Registrierung, alles geht durch (TOFU wie §7.3 „trust-on-first-use“).
    if (this.accepted.seq === 0) return true
    return !!id && this.accepted.identities.has(id)
  }

  protected ingest(from: Device, m: ServiceWire) {
    if (m.t !== 'view') return undefined
    const v = m as ViewProposal
    const signer = this.idOf.get(from)
    // Ein Vorschlag geht an den Dienst, nicht an die anderen Geräte.
    if (!signer || signer !== v.signer) return 'behalten'
    if (v.seq !== this.accepted.seq + 1 || v.prev !== this.accepted.hash) {
      this.rejectedViews++
      return 'behalten'
    }
    // Signierer muss in alter und neuer Sicht stehen (alte Sicht leer = Registrierung).
    const inOld = this.accepted.seq === 0 || this.accepted.identities.has(signer)
    if (!inOld || !v.identities.includes(signer)) {
      this.rejectedViews++
      return 'behalten'
    }
    // 1 ≤ m ≤ |identities| für die angekündigte Quorumgröße.
    if (v.m < 1 || v.m > v.identities.length) {
      this.rejectedViews++
      return 'behalten'
    }
    const h = viewHash(v)
    const signers = this.proposals.get(h) ?? new Set()
    signers.add(signer)
    this.proposals.set(h, signers)
    if (signers.size >= this.accepted.m) {
      this.accepted = { seq: v.seq, hash: h, identities: new Set(v.identities), m: v.m }
      this.proposals.clear()
      const ack: ViewAck = { t: 'ack', seq: v.seq, hash: h, identities: [...v.identities].sort(), m: v.m }
      this.outgoing.push({ label: 'ack', body: enc.encode(JSON.stringify(ack)) })
    }
    return 'behalten'
  }

  status() {
    return `Sicht seq=${this.accepted.seq}, ${this.accepted.identities.size} Identitäten, m=${this.accepted.m}, offene Vorschläge=${this.proposals.size}, abgelehnte Sichten=${this.rejectedViews}, verworfen=${this.dropped}`
  }
}

/** Variante 2 (Kontrolle): Dienst mit Replik des Autoritätslogs. */
export class LogReplicaService extends Base {
  private readonly auth = new AuthorityLog()
  private readonly personOf = new Map<string, string>()
  private waiting: AuthOp[] = []

  protected allows(id: string | undefined) {
    if (this.auth.heads().length === 0) return true // vor der Gründung
    const person = id && this.personOf.get(id)
    return !!person && this.auth.members().has(person)
  }

  protected ingest(from: Device, m: ServiceWire) {
    if (m.t === 'card') return undefined
    if (m.t !== 'auth') return undefined
    const op = (m as { op: AuthOp }).op
    void from
    if (this.auth.add(op) === 'wartet') this.waiting.push(op)
    let progress = true
    while (progress) {
      progress = false
      const rest: AuthOp[] = []
      for (const w of this.waiting) {
        if (w.preds.every((p) => this.auth.has(p))) progress = this.auth.add(w) !== 'wartet' || progress
        else rest.push(w)
      }
      this.waiting = rest
    }
    return 'weiter'
  }

  override accept(msg: Msg) {
    const m = JSON.parse(dec.decode(msg.body)) as ServiceWire
    if (m.t === 'card') {
      const c = m as { person: string; id: string }
      this.personOf.set(c.id, c.person)
    }
    return super.accept(msg)
  }

  status() {
    return `Logreplik: ${this.auth.members().size} Mitglieder, verworfen=${this.dropped}`
  }
}
