import type { Device, EnforcingService, Msg } from '../../lab/types'
import { AuthorityLog, Signer, type AuthOp } from './authority'
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'

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
  | { t: 'sealed'; kind: string; ref?: unknown }
  | { t: 'target-request'; nonce?: unknown; since?: unknown }
  | { t: 'fetch'; refs?: unknown }
  | ViewProposal
  | ChallengeAnswer
  | { t: string }

/**
 * Beglaubigtes Konvergenzziel eines Dienstes (Replication §4.1, Form 0.26, hier
 * ohne genesisDigest/session/registrationCore). Ein schlüsselblinder Dienst
 * beglaubigt `stored`, nie Zulässigkeit. `heads` sind die Referenzen aller
 * gespeicherten Einträge (der Prüfstand-Dienst sieht die Kette der Einträge
 * nicht, also keine echten Köpfe; Vereinfachung, grow-only wie verlangt).
 */
export interface Target {
  t: 'target'
  v: 'rltp-replication-target/0.26'
  source: string
  seq: number
  chain: string | null
  frontier: { scope: 'stored'; heads: string[] }
  prev: string | null
  attestationKey: string
  /** Nonce der Anfrage, die dieses Ziel beantwortet: Frische, signiert (Review zu #36). */
  echo: string
  /** Geräteschlüssel des Fragenden: Ziele sind adressiert, andere Geräte lassen sie liegen. */
  to: string
  sig: string
}
const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
export const targetInput = (t: Omit<Target, 'sig'>) => JSON.stringify([t.v, t.source, t.seq, t.chain, t.frontier.scope, t.frontier.heads, t.prev, t.attestationKey, t.echo, t.to])
export const targetDigest = (t: Omit<Target, 'sig'>) => hexOf(sha256(enc.encode(targetInput(t))))
export const verifyTarget = (t: Target) => {
  const { sig, ...rest } = t
  return verify(sig, targetInput(rest), t.attestationKey)
}

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
  /** Welches Gerät einen Schlüssel zuerst angekündigt hat: ein Schlüssel gehört genau einem Gerät. */
  private readonly deviceOfKey = new Map<string, Device>()
  /** Offene Challenges je Gerät; bewiesen = Eintrag gelöscht und Gerät in `authenticated`. */
  private readonly challenges = new Map<Device, string>()
  /** Besitz bewiesen, je GERÄT (nicht je Schlüssel): ein zweites Gerät erbt keinen Nachweis. */
  protected readonly authenticated = new Set<Device>()
  protected rejectedCards = 0
  protected readonly outgoing: Array<{ label: string; body: Uint8Array }> = []
  protected dropped = 0
  protected rejectedAnswers = 0
  /** Attestationsschlüssel des Dienstes (Replication §4.1: stabil über Sitzungen, damit Equivocation beweisbar ist). */
  private readonly attestation = Signer.generate('dienst')
  private targetSeq = 0
  private prevDigest: string | null = null
  private chain: string | null = null
  /** Gespeicherte Einträge nach Referenz: Quellenpflicht des Dienstes (I1, I12). */
  private readonly stored = new Map<string, Uint8Array>()
  /** Alle ausgestellten Ziele, in Kettenfolge: wer Zwischenziele verpasst hat, bekommt sie zur Kettenprüfung nachgereicht. */
  protected readonly issued: Target[] = []
  protected fetched = 0

  /** Ein neues Ziel: Kette seq+1, prev = Digest des vorigen, grow-only über `stored`, adressiert und mit Echo der Anfrage. */
  private attest(echo: string, to: string): Target {
    const seq = ++this.targetSeq
    const body: Omit<Target, 'sig'> = { t: 'target', v: 'rltp-replication-target/0.26', source: 'dienst', seq, chain: this.chain, frontier: { scope: 'stored', heads: [...this.stored.keys()].sort() }, prev: this.prevDigest, attestationKey: this.attestation.pub, echo, to }
    const sig = this.attestation.sign(targetInput(body))
    const digest = targetDigest(body)
    if (seq === 1) this.chain = digest
    this.prevDigest = digest
    const t = { ...body, sig }
    this.issued.push(t)
    return t
  }

  protected abstract allows(deviceKey: string | undefined): boolean
  protected abstract ingest(from: Device, m: ServiceWire): 'weiter' | 'verwerfen' | 'behalten' | undefined

  accept(msg: Msg) {
    const m = JSON.parse(dec.decode(msg.body)) as ServiceWire
    if (m.t === 'card') {
      const c = m as { id?: unknown; deviceKey?: unknown }
      if (typeof c.deviceKey !== 'string' || !c.deviceKey || typeof c.id !== 'string') return this.drop()
      // Erste Karte eines Geräts bindet es; ein anderer Schlüssel vom selben
      // Gerät, oder ein Schlüssel, den schon ein anderes Gerät angekündigt hat,
      // wird verworfen: ein Schlüssel gehört genau einem Gerät, und ein zweites
      // Gerät kann keinen fremden Besitznachweis erben.
      const known = this.keyOf.get(msg.from)
      if (known && known !== c.deviceKey) {
        this.rejectedCards++
        return this.drop()
      }
      const owner = this.deviceOfKey.get(c.deviceKey)
      if (owner && owner !== msg.from) {
        this.rejectedCards++
        return this.drop()
      }
      if (!known) {
        this.keyOf.set(msg.from, c.deviceKey)
        this.deviceOfKey.set(c.deviceKey, msg.from)
        this.idOf.set(msg.from, c.id)
        const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, '0')).join('')
        this.challenges.set(msg.from, nonce)
        const ch: Challenge = { t: 'challenge', to: c.deviceKey, nonce }
        this.outgoing.push({ label: 'challenge', body: enc.encode(JSON.stringify(ch)) })
      }
      return 'weiter'
    }
    if (m.t === 'challenge-answer') {
      const a = m as Partial<ChallengeAnswer>
      const key = this.keyOf.get(msg.from)
      const nonce = this.challenges.get(msg.from)
      if (!key || typeof a.signer !== 'string' || typeof a.nonce !== 'string' || typeof a.sig !== 'string' || key !== a.signer || !nonce || a.nonce !== nonce || !verify(a.sig, `challenge|${nonce}`, key)) {
        this.rejectedAnswers++
        return 'behalten'
      }
      this.challenges.delete(msg.from)
      this.authenticated.add(msg.from)
      return 'behalten'
    }
    // Ziel und Nachlieferung: nur für bewiesene, bediente Geräte (ein Lesen, I7).
    if (m.t === 'target-request' || m.t === 'fetch') {
      const key = this.keyOf.get(msg.from)
      if (!key || !this.authenticated.has(msg.from) || !this.allows(key)) return this.drop()
      if (m.t === 'target-request') {
        const { nonce, since } = m as { nonce?: unknown; since?: unknown }
        if (typeof nonce !== 'string' || !Number.isInteger(since)) return this.drop()
        // Erst die Zwischenziele seit dem letzten, das der Fragende kennt (Kettenprüfung), dann das frische.
        for (const t of this.issued) if (t.seq > (since as number)) this.outgoing.push({ label: 'target', body: enc.encode(JSON.stringify(t)) })
        this.outgoing.push({ label: 'target', body: enc.encode(JSON.stringify(this.attest(nonce, key))) })
      } else {
        const refs = (m as { refs?: unknown }).refs
        if (!Array.isArray(refs) || !refs.every((r) => typeof r === 'string')) return this.drop()
        for (const r of refs as string[]) {
          const body = this.stored.get(r)
          if (!body) continue
          this.outgoing.push({ label: 'fetch-answer', body })
          this.fetched++
        }
      }
      return 'behalten'
    }
    const special = this.ingest(msg.from, m)
    if (special) return special === 'verwerfen' ? this.drop() : special
    // Autoritätsoperationen sind Evidenz für die Konfliktmatrix (gleichzeitige
    // Entfernungen, Strong Removal) und gehen immer durch; ob sie gelten,
    // entscheidet jede Replik selbst (Access §9.3: Evidenztransport ist nie
    // gated). Gated sind Inhalt, Schlüsseloperationen und Widerrufe.
    // Ausnahmeweg, bewusst eng (#32): Autoritätsrahmen passieren ohne Mitgliedschaftsgate, weil sie Evidenz für die
    // Konfliktmatrix sind, aber nur von Geräten, die ihren Schlüssel einmal bewiesen haben. Der äußere `kind` ist
    // unverbürgt; was er behauptet, prüft der Empfänger gegen den Inhalt und verwirft Abweichungen.
    if (m.t === 'auth' || (m.t === 'sealed' && (m as { kind?: unknown }).kind === 'auth')) {
      if (!this.authenticated.has(msg.from)) return this.drop()
      this.store(m, msg)
      return 'weiter'
    }
    // Schreiben verlangt bewiesenen Besitz des Geräteschlüssels und Mitgliedschaft.
    const key = this.keyOf.get(msg.from)
    if (!key || !this.authenticated.has(msg.from) || !this.allows(key)) return this.drop()
    this.store(m, msg)
    return 'weiter'
  }
  /** Was durchgeht, hält der Dienst nach Referenz (versiegelte Einträge), damit er es beglaubigen und nachliefern kann. */
  private store(m: ServiceWire, msg: Msg) {
    if (m.t === 'sealed' && typeof (m as { ref?: unknown }).ref === 'string') this.stored.set((m as { ref: string }).ref, msg.body)
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
    if (!key || !this.authenticated.has(from)) return 'behalten'
    // Form zuerst: ein Rahmen von der Leitung ist Daten (vgl. #19).
    const isStr = (x: unknown): x is string => typeof x === 'string'
    const wellFormed =
      Number.isInteger(v.seq) && (v.prev === null || isStr(v.prev)) && Number.isInteger(v.m) &&
      Array.isArray(v.identities) && v.identities.every(isStr) &&
      Array.isArray(v.sigs) && v.sigs.every((x) => typeof x === 'object' && x !== null && isStr((x as { signer?: unknown }).signer) && isStr((x as { sig?: unknown }).sig))
    if (!wellFormed || v.seq !== this.accepted.seq + 1 || v.prev !== this.accepted.hash) {
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
    return `Sicht seq=${this.accepted.seq}, ${this.accepted.identities.size} Identitäten, m=${this.accepted.m} (${this.mRule}), offene Vorschläge=${this.proposals.size}, abgelehnte Sichten/Signaturen=${this.rejectedViews}, abgelehnte Antworten=${this.rejectedAnswers}, abgelehnte Karten=${this.rejectedCards}, verworfen=${this.dropped}, Ziele=${this.issued.length}, nachgeliefert=${this.fetched}`
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
    const verdict = super.accept(msg)
    // Die Person zu einem Schlüssel erst merken, wenn die Karte gebunden wurde
    // (#21): eine verworfene fremde Karte darf die Zuordnung eines legitimen
    // Geräts nicht überschreiben.
    if (m.t === 'card' && verdict === 'weiter') {
      const c = m as { person?: unknown; deviceKey: string }
      if (typeof c.person === 'string' && !this.personOf.has(c.deviceKey)) this.personOf.set(c.deviceKey, c.person)
    }
    return verdict
  }

  status() {
    return `Logreplik: ${this.auth.members().size} Mitglieder, abgelehnte Antworten=${this.rejectedAnswers}, verworfen=${this.dropped}`
  }
}
