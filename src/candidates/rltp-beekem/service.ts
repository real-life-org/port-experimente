import type { Device, EnforcingService, Msg } from '../../lab/types'
import { AuthorityLog, Signer, type AuthOp } from './authority'
import { ed25519 } from '@noble/curves/ed25519.js'

// E8/E9: Zwei durchsetzende, schlüsselblinde Dienste am Relay des Prüfstands.
//
// „sichten“ folgt Access §7.3: Der Dienst kennt den Log nicht. Er lernt die
// Mitgliedschaft nur aus Autorisierungssichten (seq, Vorgänger, identities =
// Geräteschlüssel, m für die nächste Sicht), die von m Geräten SIGNIERT
// vorgeschlagen werden, die in alter UND neuer Sicht stehen. Er bestätigt
// jede angenommene Sicht an alle (ack), damit die Geräte seq und Vorgänger
// kennen. Seit E9 Schritt 2: echte Ed25519-Signaturen je Gerät, Bindung des
// Geräts an seinen Schlüssel über einen Besitznachweis (Challenge des
// Dienstes, 7.3 „proof of possession“), und das Quorum nach einer von zwei
// Regeln (unten).
//
// „logreplik“ ist die Kontrolle nach Art von Gen 2: Der Dienst führt eine
// Replik des Autoritätslogs und wertet sie selbst aus.

const enc = new TextEncoder()
const dec = new TextDecoder()
const unhex = (h: string) => Uint8Array.from(h.match(/../g)?.map((x) => parseInt(x, 16)) ?? [])

export interface ViewProposal {
  t: 'view'
  seq: number
  prev: string | null
  identities: string[]
  /** Quorum ab der nächsten Sicht. */
  m: number
  /** Signaturen über viewHash, je Gerät eine; der Dienst führt Kopien zusammen. */
  sigs: Array<{ signer: string; sig: string }>
}
export interface ViewAck {
  t: 'ack'
  seq: number
  hash: string
  identities: string[]
  m: number
}
/** Besitznachweis (7.3): der Dienst stellt je Gerät eine Challenge, das Gerät signiert sie. */
export interface Challenge {
  t: 'challenge'
  to: string
  nonce: string
}
export interface ChallengeAnswer {
  t: 'challenge-answer'
  signer: string
  nonce: string
  sig: string
}

/**
 * Quorumregel für eine Sicht n:
 * - 'parent' (Access 0.56 §7.3, wie geschrieben): die effektive Quorumgröße
 *   der Vorgängersicht; schrumpft `identities` darunter, ist die Sicht
 *   unannehmbar („stated residual“, die Gruppe senkt m vorher).
 * - 'new' (Guss-Plan 0.54, §7.3-Zeile): m_effective = min(m_parent,
 *   |identities_new|), damit gegenseitige Entfernung den Dienst nicht
 *   einfriert (E8 Befund 3).
 */
export type MRule = 'parent' | 'new'

type ServiceWire =
  | { t: 'card'; person: string; id: string; deviceKey: string }
  | { t: 'auth'; op: AuthOp }
  | ViewProposal
  | ChallengeAnswer
  | { t: string }

/** Inhalt einer Sicht ohne Signaturen, als stabiler Schlüssel und Signaturinput (7110). */
export const viewHash = (v: { seq: number; prev: string | null; identities: string[]; m: number }) =>
  JSON.stringify([v.seq, v.prev, [...v.identities].sort(), v.m])

export const signView = (v: { seq: number; prev: string | null; identities: string[]; m: number }, signer: Signer) => ({ signer: signer.pub, sig: signer.sign(viewHash(v)) })

function verify(sig: string, msg: string, pub: string): boolean {
  try {
    return ed25519.verify(unhex(sig), enc.encode(msg), unhex(pub))
  } catch {
    return false
  }
}

abstract class Base implements EnforcingService {
  /** Geräteschlüssel (hex) je Gerät, aus seiner Karte. */
  protected readonly keyOf = new Map<Device, string>()
  /** BeeKEM-ID je Gerät, aus seiner Karte. */
  protected readonly idOf = new Map<Device, string>()
  /** Offene Challenges je Geräteschlüssel; bewiesen = Eintrag gelöscht und in `authenticated`. */
  private readonly challenges = new Map<string, string>()
  protected readonly authenticated = new Set<string>()
  protected readonly outgoing: Array<{ label: string; body: Uint8Array }> = []
  protected dropped = 0
  protected rejectedAnswers = 0

  protected abstract allows(deviceKey: string | undefined): boolean
  protected abstract ingest(from: Device, m: ServiceWire): 'weiter' | 'verwerfen' | 'behalten' | undefined

  accept(msg: Msg) {
    const m = JSON.parse(dec.decode(msg.body)) as ServiceWire
    if (m.t === 'card') {
      const c = m as { id: string; deviceKey: string }
      // Erste Karte eines Geräts bindet es; eine andere ID oder ein anderer Schlüssel vom selben Gerät wird verworfen.
      const known = this.keyOf.get(msg.from)
      if (known && known !== c.deviceKey) return this.drop()
      if (!known) {
        this.keyOf.set(msg.from, c.deviceKey)
        this.idOf.set(msg.from, c.id)
        const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, '0')).join('')
        this.challenges.set(c.deviceKey, nonce)
        const ch: Challenge = { t: 'challenge', to: c.deviceKey, nonce }
        this.outgoing.push({ label: 'challenge', body: enc.encode(JSON.stringify(ch)) })
      }
      return 'weiter'
    }
    if (m.t === 'challenge-answer') {
      const a = m as ChallengeAnswer
      const key = this.keyOf.get(msg.from)
      const nonce = key && this.challenges.get(key)
      if (!key || key !== a.signer || !nonce || a.nonce !== nonce || !verify(a.sig, `challenge|${nonce}`, key)) {
        this.rejectedAnswers++
        return 'behalten'
      }
      this.challenges.delete(key)
      this.authenticated.add(key)
      return 'behalten'
    }
    const special = this.ingest(msg.from, m)
    if (special) return special === 'verwerfen' ? this.drop() : special
    // Autoritätsoperationen sind Evidenz für die Konfliktmatrix (gleichzeitige
    // Entfernungen, Strong Removal) und gehen immer durch; ob sie gelten,
    // entscheidet jede Replik selbst (Access §9.3: Evidenztransport ist nie
    // gated). Gated sind Inhalt, Schlüsseloperationen und Widerrufe.
    if (m.t === 'auth') return 'weiter'
    // Schreiben verlangt bewiesenen Besitz des Geräteschlüssels und Mitgliedschaft.
    const key = this.keyOf.get(msg.from)
    if (!key || !this.authenticated.has(key) || !this.allows(key)) return this.drop()
    return 'weiter'
  }
  protected drop() {
    this.dropped++
    return 'verwerfen' as const
  }
  /**
   * Verdrängung: laut Sicht bzw. Log Mitglied. Der Besitznachweis gilt hier
   * nur für Schreiben und Vorschläge; Lesen (Zustellung an das Gerät) ist
   * im Prüfstand nicht an ihn gebunden, weil die Challenge selbst das
   * Gerät erreichen muss (Grenze des Harness, nicht der Spec: dort läuft
   * Lesen über eine authentisierte Session).
   */
  serves(device: Device) {
    return this.allows(this.keyOf.get(device))
  }
  takeOutgoing() {
    return this.outgoing.splice(0)
  }
  abstract status(): string
}

/** Variante 1: Dienst mit Autorisierungssichten (Access §7.3). */
export class ViewService extends Base {
  private accepted: { seq: number; hash: string | null; identities: Set<string>; m: number } = { seq: 0, hash: null, identities: new Set(), m: 1 }
  /** Geprüfte Signierer je Sichtinhalt (Kopien werden zusammengeführt). */
  private proposals = new Map<string, Set<string>>()
  private rejectedViews = 0

  constructor(private readonly mRule: MRule = 'parent') {
    super()
  }

  protected allows(key: string | undefined) {
    // Vor der ersten Sicht: Registrierung, alles geht durch (TOFU wie §7.3 „trust-on-first-use“).
    if (this.accepted.seq === 0) return true
    return !!key && this.accepted.identities.has(key)
  }

  /** Quorum, das die nächste Sicht erfüllen muss. */
  private quorumFor(v: ViewProposal): number {
    if (this.accepted.seq === 0) return 1
    return this.mRule === 'parent' ? this.accepted.m : Math.min(this.accepted.m, v.identities.length)
  }

  protected ingest(from: Device, m: ServiceWire) {
    if (m.t !== 'view') return undefined
    const v = m as ViewProposal
    const key = this.keyOf.get(from)
    // Ein Vorschlag geht an den Dienst, nicht an die anderen Geräte; nur von bewiesenen Geräten.
    if (!key || !this.authenticated.has(key)) return 'behalten'
    if (!Array.isArray(v.identities) || !Array.isArray(v.sigs) || v.seq !== this.accepted.seq + 1 || v.prev !== this.accepted.hash) {
      this.rejectedViews++
      return 'behalten'
    }
    // 1 ≤ m ≤ |identities| für die angekündigte Quorumgröße; die Sicht muss ihr eigenes Quorum tragen können.
    const need = this.quorumFor(v)
    if (v.m < 1 || v.m > v.identities.length || v.identities.length < need) {
      this.rejectedViews++
      return 'behalten'
    }
    const h = viewHash(v)
    const signers = this.proposals.get(h) ?? new Set()
    for (const s of v.sigs) {
      // Signierer muss in alter und neuer Sicht stehen (alte Sicht leer = Registrierung) und seine Signatur muss prüfen.
      const inOld = this.accepted.seq === 0 || this.accepted.identities.has(s.signer)
      if (!inOld || !v.identities.includes(s.signer) || !verify(s.sig, h, s.signer)) {
        this.rejectedViews++
        continue
      }
      signers.add(s.signer)
    }
    this.proposals.set(h, signers)
    if (signers.size >= need) {
      this.accepted = { seq: v.seq, hash: h, identities: new Set(v.identities), m: v.m }
      this.proposals.clear()
      const ack: ViewAck = { t: 'ack', seq: v.seq, hash: h, identities: [...v.identities].sort(), m: v.m }
      this.outgoing.push({ label: 'ack', body: enc.encode(JSON.stringify(ack)) })
    }
    return 'behalten'
  }

  status() {
    return `Sicht seq=${this.accepted.seq}, ${this.accepted.identities.size} Identitäten, m=${this.accepted.m} (${this.mRule}), offene Vorschläge=${this.proposals.size}, abgelehnte Sichten/Signaturen=${this.rejectedViews}, abgelehnte Antworten=${this.rejectedAnswers}, verworfen=${this.dropped}`
  }
}

/** Variante 2 (Kontrolle): Dienst mit Replik des Autoritätslogs. */
export class LogReplicaService extends Base {
  private readonly auth = new AuthorityLog()
  private readonly personOf = new Map<string, string>()
  private waiting: AuthOp[] = []

  protected allows(key: string | undefined) {
    if (this.auth.heads().length === 0) return true // vor der Gründung
    const person = key && this.personOf.get(key)
    return !!person && this.auth.members().has(person)
  }

  protected ingest(from: Device, m: ServiceWire) {
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
      const c = m as { person: string; deviceKey: string }
      this.personOf.set(c.deviceKey, c.person)
    }
    return super.accept(msg)
  }

  status() {
    return `Logreplik: ${this.auth.members().size} Mitglieder, abgelehnte Antworten=${this.rejectedAnswers}, verworfen=${this.dropped}`
  }
}
