// Zustellungs-Prüfstand (E11): Paar-Verkehr über einen Träger, der speichert
// und weiterleitet. Der Kandidat ist der Draht (wie ein versiegelter Umschlag
// adressiert und gerahmt wird: Prüfstand-Umschlag, TSP, DIDComm); der
// Zusteller (Sender-Trias nach Delivery §6.1, mindestens einmal nach §6.3) und
// der Empfänger (Dispositionen nach §6.2 über `receive` der lib) sind für
// alle Drähte gleich. So zeigt der Prüfstand, was der Port verlangt und was
// nur die Form eines Trägers ist. Horizonte sind Runden; die Uhr ist
// injizierbar (Default: echte Uhr), für E15 eine virtuelle.

import { seal, receive, xFromSeed, edFromSeed, mkOfX, anchorOfEd, diSign, diVerify, jcs, rand, digestBytes } from '@real-life/trust-protocol'
import type { Json, KeyPair } from '@real-life/trust-protocol'

const enc = new TextEncoder()
const dec = new TextDecoder()

// ── Uhr (E15, Befund 7): Zeit und Runden getrennt steuerbar ──────────────────

export interface Clock {
  /** Jetzt, als ISO-Zeitstempel. */
  now(): string
}

export const realClock: Clock = { now: () => new Date().toISOString() }

/** Virtuelle Uhr: schreitet nur auf Anweisung fort, unabhängig vom Rundenscheduler. */
export class VirtualClock implements Clock {
  private t: number
  constructor(start = '2026-01-01T00:00:00.000Z') {
    this.t = Date.parse(start)
  }
  now() {
    return new Date(this.t).toISOString()
  }
  advance(ms: number) {
    this.t += ms
  }
  /** Rückstellung oder Sprung. */
  set(iso: string) {
    this.t = Date.parse(iso)
  }
  /** Die Sicht eines Geräts, dessen Uhr um `ms` vor- oder nachgeht (Geräteversatz). */
  skewed(ms: number): Clock {
    return { now: () => new Date(this.t + ms).toISOString() }
  }
}

// ── Store (E15, Befund 8): dauerhafte Commits, Absturz, Backup ───────────────

/** Dauerhafter Speicher eines Geräts. Ein Commit ist die Grenze, hinter die ein Absturz nicht zurückfällt. */
export interface Store<S> {
  commit(state: S): void
  load(): S | undefined
}

export class MemoryStore<S> implements Store<S> {
  private state: S | undefined
  /** Beobachtbare Commit-Grenzen: wie oft gesichert wurde. */
  commits = 0
  commit(state: S) {
    this.state = structuredClone(state)
    this.commits++
  }
  load(): S | undefined {
    return this.state === undefined ? undefined : structuredClone(this.state)
  }
  /** Backup: der Stand von jetzt. */
  snapshot(): S | undefined {
    return this.load()
  }
  /** Ein alter Stand zurückgespielt (X6, X19). */
  restore(state: S | undefined) {
    this.state = state === undefined ? undefined : structuredClone(state)
  }
}

/** Eine Partei: Anker (signiert Quittungen) und Beziehungsschlüssel (rkid, Ziel des Siegels). */
export interface Party {
  name: string
  anchor: string
  ed: KeyPair
  x: KeyPair
  rkid: string
  /** Für den Draht: rohe Saaten, aus denen er seine Beziehungs-Identitäten ableitet. */
  seed: Uint8Array
}

export async function party(name: string): Promise<Party> {
  const edSeed = rand(32)
  const xSeed = rand(32)
  const ed = await edFromSeed(edSeed)
  const x = await xFromSeed(xSeed)
  return { name, anchor: anchorOfEd(ed.pubRaw), ed, x, rkid: mkOfX(x.pubRaw), seed: rand(32) }
}

/** Was der Träger aus einem Rahmen lesen kann, ohne Schlüssel. */
export type Observation = Record<string, string | number | boolean>

/** Ein Endpunkt einer Beziehung auf einem Draht: adressiert, rahmt, öffnet. */
export interface Endpoint {
  /** Die Adresse, auf die der Träger routet (sein Wissen über den Empfänger). */
  readonly address: string
  pack(payload: Uint8Array): Promise<Uint8Array>
  unpack(frame: Uint8Array): Promise<Uint8Array>
  observe(frame: Uint8Array): Observation
  /**
   * Wie `pack`, an denselben Empfängerschlüssel, aber mit den Beziehungsschlüsseln eines Dritten als Absender
   * (Z4: nur der Absender ist fremd, der Empfänger unverändert; Review zu #41, Issue #42).
   */
  forge(payload: Uint8Array, sender: Party): Promise<Uint8Array>
}

/** Der Draht: je Beziehung zwei Endpunkte aus den Beziehungsschlüsseln beider Seiten. */
export interface Wire {
  readonly id: string
  readonly title: string
  bind(a: Party, b: Party): Promise<{ a: Endpoint; b: Endpoint }>
}

export type WireFactory = () => Wire | Promise<Wire>

// ── Träger: speichert und leitet weiter, mit Fehlerinjektion ─────────────────

export interface Frame {
  id: number
  address: string
  bytes: Uint8Array
}

export class WireUnreachable extends Error {}

/**
 * Fehlerinjektion am Träger nach dem Muster von `CarrierFaults` (E10/E15):
 * jede Regel gilt ab dem Aufruf, bis `reset()`. Die Flags am Carrier
 * (`unreachable`, `offline`, `dropDeliveryTo`, `dropNextDeposit`) bleiben.
 */
export interface CarrierFaultRules {
  /** Rahmen, auf die `match` passt, werden getragen, aber nie zugestellt (still verloren). */
  drop(match: (f: Frame) => boolean): void
  /** Rahmen, auf die `match` passt, erreichen genau dieses Gerät nicht; sie bleiben liegen, bis die Regel fällt. */
  withhold(device: string, match: (f: Frame) => boolean): void
  /** Zustellung je Abholung in umgekehrter Reihenfolge. */
  reverse(on: boolean): void
  /** Jeden Rahmen zweimal zustellen. */
  duplicate(on: boolean): void
  reset(): void
}

export class Carrier {
  private queues = new Map<string, Frame[]>()
  private registered = new Map<string, Set<string>>() // address → Geräte
  private seq = 0
  readonly carried: Frame[] = []
  unreachable = false
  readonly offline = new Set<string>()
  /** Nächste Zustellung an diese Adresse geht verloren (einmal). */
  readonly dropDeliveryTo = new Set<string>()
  /** Nächste Einlieferung geht still verloren (einmal). */
  dropNextDeposit = false
  /** Rahmen, die eine drop-Regel verschluckt hat. */
  readonly swallowed: Frame[] = []
  private dropRules: Array<(f: Frame) => boolean> = []
  private withholdRules: Array<{ device: string; match: (f: Frame) => boolean }> = []
  private reverseOrder = false
  private duplicateAll = false

  readonly faults: CarrierFaultRules = {
    drop: (match) => void this.dropRules.push(match),
    withhold: (device, match) => void this.withholdRules.push({ device, match }),
    reverse: (on) => void (this.reverseOrder = on),
    duplicate: (on) => void (this.duplicateAll = on),
    reset: () => {
      this.dropRules = []
      this.withholdRules = []
      this.reverseOrder = false
      this.duplicateAll = false
    },
  }

  register(device: string, address: string) {
    if (!this.registered.has(address)) this.registered.set(address, new Set())
    this.registered.get(address)!.add(device)
  }
  /** Widerruf eines Geräts (X9/X20): es bekommt nichts mehr, und Rahmen, die nur noch auf es warteten, werden bereinigt. */
  unregister(device: string) {
    for (const devices of this.registered.values()) devices.delete(device)
    this.offline.delete(device)
    for (const [address, q] of this.queues) {
      const devices = this.registered.get(address) ?? new Set<string>()
      for (let i = q.length - 1; i >= 0; i--) {
        const done = this.concluded.get(q[i]!.id) ?? new Set<string>()
        if ([...devices].every((d) => done.has(d))) q.splice(i, 1)
      }
    }
  }
  /** Rahmen, die an dieser Adresse noch liegen (auf mindestens ein registriertes Gerät warten). */
  pending(address: string): number {
    return this.queues.get(address)?.length ?? 0
  }
  deposit(address: string, bytes: Uint8Array) {
    if (this.unreachable) throw new WireUnreachable('Träger unerreichbar')
    const f: Frame = { id: ++this.seq, address, bytes }
    this.carried.push(f)
    if (this.dropNextDeposit) {
      this.dropNextDeposit = false
      return
    }
    if (this.dropRules.some((r) => r(f))) {
      this.swallowed.push(f)
      return
    }
    if (!this.queues.has(address)) this.queues.set(address, [])
    this.queues.get(address)!.push(f)
  }
  /** Liefert einem Gerät, was für seine Adressen liegt; das Gerät bestätigt mit `conclude`. */
  collect(device: string): Frame[] {
    if (this.unreachable || this.offline.has(device)) return []
    let out: Frame[] = []
    for (const [address, devices] of this.registered) {
      if (!devices.has(device)) continue
      const q = this.queues.get(address) ?? []
      for (const f of q) {
        if (this.dropDeliveryTo.has(address)) {
          this.dropDeliveryTo.delete(address)
          q.splice(q.indexOf(f), 1)
          break
        }
        if (this.withholdRules.some((r) => r.device === device && r.match(f))) continue
        out.push(f)
      }
    }
    if (this.reverseOrder) out.reverse()
    if (this.duplicateAll) out = out.flatMap((f) => [f, f])
    return out
  }
  /** Mehrere Geräte einer Adresse: der Rahmen bleibt liegen, bis jedes registrierte Gerät ihn bestätigt hat. */
  private concluded = new Map<number, Set<string>>()
  conclude(device: string, ids: number[]) {
    for (const id of ids) {
      if (!this.concluded.has(id)) this.concluded.set(id, new Set())
      const done = this.concluded.get(id)!
      done.add(device)
      for (const [address, q] of this.queues) {
        const i = q.findIndex((f) => f.id === id)
        if (i < 0) continue
        const devices = this.registered.get(address) ?? new Set()
        if ([...devices].every((d) => done.has(d))) q.splice(i, 1)
      }
    }
  }
}

// ── Zusteller: die Sender-Trias (§6.1) und mindestens einmal (§6.3) ───────────

export type Report =
  | { state: 'awaiting-transport'; reason: 'offline' | 'transport-unreachable' }
  | { state: 'accepted' }
  | { state: 'delivered'; late: boolean }
  | { state: 'failed'; reason: 'expired-by-adapter-policy' }

/** Horizonte in Runden: Bericht spätestens nach einer Runde; erneut senden nach ACK_WAIT; aufgeben nach GIVE_UP. */
export const HORIZON = { status: 1, ackWait: 3, giveUp: 12 } as const

export interface Submission {
  digest: string
  frame: Uint8Array
  address: string
  report: Report | null
  /** Verfügbarkeit des Transports beim letzten Versuch, getrennt vom Trias-Zustand (Issue #43). */
  transport: 'ok' | 'offline' | 'unreachable'
  rounds: number
  /** Runden seit der Annahme (`accepted`); die Aufgabegrenze zählt erst ab hier (§6.1: vor der Trias gibt es kein Aufgeben, nur den Bericht). */
  sinceAccepted: number | null
  sinceDeposit: number
  deposits: number
}

export class Zusteller {
  readonly submissions = new Map<string, Submission>()
  readonly notes: string[] = []
  constructor(
    readonly device: string,
    private readonly carrier: () => Carrier,
    private readonly online: () => boolean,
  ) {}

  /** Einliefern: Bericht sofort, wenn der Träger oder das Gerät nicht da sind; sonst `accepted`. */
  submit(digest: string, frame: Uint8Array, address: string): void {
    this.record(digest, frame, address)
    this.deposit(digest)
  }
  /**
   * Vormerken ohne Einlieferung (Commit-Grenze vor dem Versand, E15): die Submission ist bis zur Freigabe
   * (`deposit`) nicht freigegeben; `advance` rührt sie nicht an (#56). Freigeben darf das Gerät erst nach dem Commit.
   */
  record(digest: string, frame: Uint8Array, address: string): void {
    this.submissions.set(digest, { digest, frame, address, report: null, transport: 'ok', rounds: 0, sinceAccepted: null, sinceDeposit: 0, deposits: 0 })
  }
  /** Freigabe: ab jetzt liefert der Zusteller ein und wiederholt. */
  deposit(digest: string): void {
    const s = this.submissions.get(digest)
    if (s) this.tryDeposit(s)
  }
  /** Vorgemerkt, nie freigegeben. Nach einem Neuaufbau aus dem Store sind das die committeten Absichten, die noch hinaus müssen. */
  unreleased(): string[] {
    return [...this.submissions.values()].filter((s) => s.report === null).map((s) => s.digest)
  }
  /** Neuaufbau aus dem Store (E15). */
  restore(subs: Submission[]) {
    this.submissions.clear()
    for (const s of subs) this.submissions.set(s.digest, s)
  }
  /**
   * Einliefern. Der Bericht `awaiting-transport` gibt es nur VOR der Trias (§6.1): eine Störung nach `accepted`
   * ändert den Trias-Zustand nicht, sie steht in `transport` (Issue #43).
   */
  private tryDeposit(s: Submission) {
    const before = s.report === null || s.report.state === 'awaiting-transport'
    if (!this.online()) {
      s.transport = 'offline'
      if (before) s.report = { state: 'awaiting-transport', reason: 'offline' }
      return
    }
    try {
      this.carrier().deposit(s.address, s.frame)
      s.transport = 'ok'
      s.deposits++
      s.sinceDeposit = 0
      if (before) {
        s.report = { state: 'accepted' }
        s.sinceAccepted = 0
      }
    } catch (e) {
      if (!(e instanceof WireUnreachable)) throw e
      s.transport = 'unreachable'
      if (before) s.report = { state: 'awaiting-transport', reason: 'transport-unreachable' }
    }
  }
  /**
   * Eine Runde: Wartendes erneut einliefern, Unbestätigtes nach ACK_WAIT wiederholen. Zwei Fristen, sauber getrennt
   * (Issue #43): vor der Annahme gibt es kein Aufgeben, nur den ehrlichen Bericht je Runde (§6.1, die Einlieferung
   * ist noch beim Adapter); ab der Annahme zählt die erklärte Aufgabegrenze, auch bei späterer Störung.
   */
  advance() {
    for (const s of this.submissions.values()) {
      if (s.report === null) continue // vorgemerkt, nicht freigegeben: liegt vor der Commit-Grenze des Geräts (#56)
      s.rounds++
      s.sinceDeposit++
      if (s.sinceAccepted !== null) s.sinceAccepted++
      if (s.report?.state === 'delivered' || s.report?.state === 'failed') continue
      if (s.sinceAccepted !== null && s.sinceAccepted >= HORIZON.giveUp) {
        s.report = { state: 'failed', reason: 'expired-by-adapter-policy' }
        this.notes.push(`${s.digest.slice(0, 8)} aufgegeben ${s.sinceAccepted} Runden nach der Annahme (zuletzt ${s.transport})`)
        continue
      }
      if (s.report.state === 'awaiting-transport') {
        this.tryDeposit(s)
        continue
      }
      // Mindestens einmal: ohne Quittung noch einmal dieselben Bytes (der Empfänger dedupliziert, §6.3).
      if (s.sinceDeposit >= HORIZON.ackWait) this.tryDeposit(s)
    }
  }
  /**
   * Verwerfen, was nie freigegeben wurde (E15, Abgang 8475.S6): eine vorgemerkte Submission ist noch nicht bei
   * Delivery und darf entfallen. Eine eingereichte bleibt bei Delivery, mit Wiederholung und Bericht (6845.7, §6.1).
   */
  discard(digest: string): void {
    const s = this.submissions.get(digest)
    if (s && s.report === null) this.submissions.delete(digest)
  }
  transport(digest: string) {
    return this.submissions.get(digest)?.transport
  }
  acknowledged(digest: string) {
    const s = this.submissions.get(digest)
    if (!s) return
    const late = s.report?.state === 'failed'
    s.report = { state: 'delivered', late }
  }
  report(digest: string): Report | null {
    return this.submissions.get(digest)?.report ?? null
  }
}

// ── Gerät: Partei auf einem Endpunkt, mit Zusteller und Empfänger ─────────────

export const ACK_TYPE = 'https://real-life.org/trust-tasks/delivery-ack/0.1'
export const DOC_TYPE = 'https://real-life.org/trust-tasks/encounter-bundle/0.1'

/** Löst einen rkid auf den privaten Beziehungsschlüssel auf (Signatur wie der Resolver von `receive` in der lib). */
export type Resolver = Parameters<typeof receive>[1]

/** Was ein Gerät dauerhaft hält (Store-Abbild). */
export interface DeviceState {
  completed: string[]
  acks: Array<[string, { frame: Uint8Array; digest: string }]>
  received: Array<{ digest: string; doc: Record<string, unknown> }>
  dispositions: string[]
  submissions: Submission[]
}

export interface DeviceOptions {
  clock?: Clock
  store?: Store<DeviceState>
  /** Schlüsselauflösung je Gerät (E15, K2): welcher private Beziehungsschlüssel zu einem rkid gehört. Default: der eine der Partei. */
  resolve?: Resolver
}

/** Absturzstellen (E15, Befund 8): vor dem Commit, nach dem Commit (vor der Bestätigung am Träger), vor dem Versand. */
export type CrashPoint = 'before-commit' | 'after-commit' | 'before-send'

export class Crashed extends Error {}

export class Device {
  readonly zusteller: Zusteller
  completed = new Set<string>()
  /** Quittungen, byte-identisch aufbewahrt, je Digest des quittierten Dokuments (§6.2 Stufe 4). */
  acks = new Map<string, { frame: Uint8Array; digest: string }>()
  received: Array<{ digest: string; doc: Record<string, unknown> }> = []
  dispositions: string[] = []
  online = true
  /** Einmaliger Absturz an dieser Stelle (Test-Haken); danach ist das Gerät aus, bis `reload()`. */
  crashAt: CrashPoint | null = null
  readonly crashes: CrashPoint[] = []
  private down = false
  private carrierRef: Carrier
  private readonly clock: Clock
  private readonly store: Store<DeviceState> | undefined
  private readonly resolve: Resolver
  constructor(
    readonly name: string,
    readonly party: Party,
    readonly endpoint: Endpoint,
    readonly peer: Party,
    readonly peerEndpoint: Endpoint,
    carrier: Carrier,
    opts: DeviceOptions = {},
  ) {
    this.carrierRef = carrier
    this.clock = opts.clock ?? realClock
    this.store = opts.store
    this.resolve = opts.resolve ?? ((rkid) => (rkid === this.party.rkid ? this.party.x.priv : undefined))
    this.zusteller = new Zusteller(name, () => this.carrierRef, () => this.online && !this.down)
    carrier.register(name, endpoint.address)
  }
  get carrier() {
    return this.carrierRef
  }
  /** Trägerwechsel: neu registrieren; der Zusteller liefert Wartendes auf dem neuen Träger ein. */
  rebind(carrier: Carrier) {
    this.carrierRef = carrier
    carrier.register(this.name, this.endpoint.address)
  }

  // ── Store: Commit-Grenzen, Absturz, Neuaufbau ──
  state(): DeviceState {
    return { completed: [...this.completed], acks: [...this.acks], received: this.received.slice(), dispositions: this.dispositions.slice(), submissions: [...this.zusteller.submissions.values()] }
  }
  /** Sichert den Zustand; ohne Store ein Leerlauf. */
  commit() {
    this.store?.commit(this.state())
  }
  /** Neuaufbau aus dem Store: alles seit dem letzten Commit ist weg (Absturz) oder der Stand ist ein zurückgespieltes Backup. */
  reload() {
    const s = this.store?.load()
    this.completed = new Set(s?.completed ?? [])
    this.acks = new Map(s?.acks ?? [])
    this.received = s?.received.slice() ?? []
    this.dispositions = s?.dispositions.slice() ?? []
    this.zusteller.restore(s?.submissions ?? [])
    // Was im Store steht, ist committet: vorgemerkte, nie freigegebene Submissions gehen nach dem nächsten Commit hinaus.
    this.held = this.zusteller.unreleased()
    this.down = false
  }
  /** Quittungen, die mit der Wirkung aufgezeichnet sind und nach dem Commit der Runde eingeliefert werden. */
  private held: string[] = []
  private release(digest: string, frame: Uint8Array, address: string) {
    this.zusteller.record(digest, frame, address)
    this.held.push(digest)
  }
  private crash(point: CrashPoint) {
    if (this.crashAt !== point) return
    this.crashAt = null
    this.down = true
    this.crashes.push(point)
    throw new Crashed(point)
  }

  /** Ein Dokument an den Partner versiegeln und einliefern; liefert den Digest (die Kennung der Einlieferung). */
  async send(payload: Record<string, Json>, threadId = crypto.randomUUID()): Promise<string> {
    const { digest, bytes } = await this.sealed(this.party, payload, threadId)
    const frame = await this.peerEndpoint.pack(bytes)
    this.zusteller.record(digest, frame, this.peerEndpoint.address)
    this.commit()
    try {
      this.crash('before-send')
    } catch (e) {
      if (e instanceof Crashed) return digest
      throw e
    }
    this.zusteller.deposit(digest)
    return digest
  }

  /** Ein Dokument unter dem Anker des Ausstellers signieren und an den Partner versiegeln (Delivery §4, §5). */
  async sealed(issuer: Party, payload: Record<string, Json>, threadId = crypto.randomUUID()) {
    return sealDoc(issuer, this.peer, payload, threadId, this.clock)
  }
  /** Ein Dokument eines Dritten an DIESES Gerät versiegelt (Angreifer-Sicht: Mallory an Bob). */
  async sealedFor(issuer: Party, payload: Record<string, Json>, threadId = crypto.randomUUID()) {
    return sealDoc(issuer, this.party, payload, threadId, this.clock)
  }

  /** Eine Runde: abholen, öffnen, quittieren, sichern, bestätigen; Wartendes vorantreiben. Ein abgestürztes Gerät tut nichts. */
  async round() {
    if (this.down) return
    try {
      if (this.online) {
        const frames = this.carrier.collect(this.name)
        for (const f of frames) {
          try {
            const payload = await this.endpoint.unpack(f.bytes)
            await this.handle(payload)
          } catch (e) {
            this.dispositions.push(`failed(malformed): ${(e as Error).message}`)
          }
        }
        this.crash('before-commit')
        this.commit()
        this.crash('after-commit')
        // Quittungen verlassen das Gerät erst nach dem Commit der Wirkung (#54, HSC-110).
        for (const d of this.held.splice(0)) this.zusteller.deposit(d)
        if (frames.length) this.carrier.conclude(this.name, frames.map((f) => f.id))
      }
      this.zusteller.advance()
      this.commit()
    } catch (e) {
      if (!(e instanceof Crashed)) throw e
    }
  }

  private async handle(payload: Uint8Array) {
    let env: unknown
    try {
      env = JSON.parse(dec.decode(payload))
    } catch {
      this.dispositions.push('failed(malformed)')
      return
    }
    const v = await receive(env, this.resolve, this.completed)
    this.dispositions.push(v.disposition)
    if (v.disposition === 'duplicate-known') {
      // Die aufbewahrte Quittung noch einmal, byte-identisch (§6.2 Stufe 4).
      const ack = this.acks.get(v.digest!)
      if (ack) this.release(ack.digest, ack.frame, this.peerEndpoint.address)
      return
    }
    if (v.disposition !== 'unique') return
    const doc = v.document as Record<string, unknown>
    // Absender: nur das Dokument beweist ihn (Beweis unter dem Anker des Partners), nie der Träger (§5a.4).
    if (!(await diVerify(doc, this.peer.anchor))) {
      this.dispositions.push('failed(proof-invalid)')
      return
    }
    if (doc.type === ACK_TYPE) {
      // Quittung: Beweis unter dem Anker des Partners, Bezug auf unser Dokument.
      const p = doc.payload as { ref?: string }
      if (typeof p?.ref === 'string') {
        this.completed.add(v.digest!)
        this.zusteller.acknowledged(p.ref)
      }
      return
    }
    // Wirkung und Quittung in einem Schritt: erst danach gilt der Digest als erledigt.
    this.received.push({ digest: v.digest!, doc })
    const ackDoc = await diSign(
      { anchor: this.party.anchor, ed: { priv: this.party.ed.priv } },
      { id: crypto.randomUUID(), type: ACK_TYPE, issuer: this.party.anchor, recipient: this.peer.anchor, threadId: doc.threadId as string, issuedAt: this.clock.now(), payload: { ref: v.digest!, meaning: 'received' } },
      this.clock.now(),
    )
    const ackEnv = await seal(ackDoc as unknown as Json, this.peer.rkid)
    const ackBytes = enc.encode(jcs(ackEnv))
    const ackDigest = await digestBytes(enc.encode(jcs(ackDoc)))
    const ackFrame = await this.peerEndpoint.pack(ackBytes)
    this.acks.set(v.digest!, { frame: ackFrame, digest: ackDigest })
    this.completed.add(v.digest!)
    this.release(ackDigest, ackFrame, this.peerEndpoint.address)
  }
}

/** Ein Dokument unter dem Anker des Ausstellers signiert und an den Beziehungsschlüssel des Empfängers versiegelt. */
export async function sealDoc(issuer: Party, recipient: Party, payload: Record<string, Json>, threadId: string, clock: Clock = realClock) {
  const unsigned = { id: crypto.randomUUID(), type: DOC_TYPE, issuer: issuer.anchor, recipient: recipient.anchor, threadId, issuedAt: clock.now(), payload }
  const doc = await diSign({ anchor: issuer.anchor, ed: { priv: issuer.ed.priv } }, unsigned, clock.now())
  const env = await seal(doc as unknown as Json, recipient.rkid)
  return { digest: await digestBytes(enc.encode(jcs(doc))), bytes: enc.encode(jcs(env)) }
}

// ── Welt: zwei Parteien, ein Träger, Runden ──────────────────────────────────

export interface WeltOptions {
  clock?: Clock
  /** Ein Store je Gerät; ohne Store hält das Gerät nur Speicher (wie E11). */
  store?: (device: string) => Store<DeviceState>
}

export class Welt {
  carrier = new Carrier()
  readonly devices: Device[] = []
  readonly clock: Clock
  constructor(
    readonly wire: Wire,
    private readonly opts: WeltOptions = {},
  ) {
    this.clock = opts.clock ?? realClock
  }
  private deviceOptions(name: string): DeviceOptions {
    return { clock: this.clock, store: this.opts.store?.(name) }
  }
  async pair(a: Party, b: Party, extraB: string[] = []) {
    const e = await this.wire.bind(a, b)
    const A = new Device(a.name, a, e.a, b, e.b, this.carrier, this.deviceOptions(a.name))
    const B = new Device(b.name, b, e.b, a, e.a, this.carrier, this.deviceOptions(b.name))
    this.devices.push(A, B)
    const more = extraB.map((n) => new Device(n, b, e.b, a, e.a, this.carrier, this.deviceOptions(n)))
    this.devices.push(...more)
    return { A, B, more }
  }
  async rounds(n: number) {
    for (let i = 0; i < n; i++) for (const d of this.devices) await d.round()
  }
  /** Runden, bis die Bedingung gilt oder `max` erreicht ist; liefert die gebrauchten Runden. */
  async until(pred: () => boolean, max = 20): Promise<number> {
    for (let i = 1; i <= max; i++) {
      await this.rounds(1)
      if (pred()) return i
    }
    return -1
  }
}

// ── Szenarien ────────────────────────────────────────────────────────────────

export interface DeliveryResult {
  scenario: string
  title: string
  outcome: 'bestanden' | 'nicht bestanden'
  detail: string
}

const fmtReport = (r: Report | null) => (r === null ? 'kein Bericht' : r.state === 'awaiting-transport' ? `awaiting-transport(${r.reason})` : r.state === 'failed' ? `failed(${r.reason})` : r.state === 'delivered' ? `delivered${r.late ? ' (late)' : ''}` : r.state)

export const deliveryScenarios: Array<{ id: string; title: string; run: (wire: Wire) => Promise<Omit<DeliveryResult, 'scenario' | 'title'>> }> = [
  {
    id: 'T9',
    title: 'Quittung geht verloren: Sender wiederholt, Empfänger dedupliziert und quittiert byte-identisch',
    async run(wire) {
      const w = new Welt(wire)
      const { A, B } = await w.pair(await party('alice'), await party('bob'))
      const d = await A.send({ note: 'eins' })
      w.carrier.dropDeliveryTo.add(A.endpoint.address) // die erste Quittung erreicht Alice nie
      const n = await w.until(() => A.zusteller.report(d)?.state === 'delivered')
      const r = A.zusteller.report(d)
      const sub = A.zusteller.submissions.get(d)!
      const ackFrames = w.carrier.carried.filter((f) => f.address === A.endpoint.address)
      const identical = ackFrames.length >= 2 && ackFrames.every((f) => f.bytes.length === ackFrames[0]!.bytes.length && f.bytes.every((x, i) => x === ackFrames[0]!.bytes[i]))
      const ok = r?.state === 'delivered' && !r.late && B.received.length === 1 && sub.deposits === 2 && B.dispositions.includes('duplicate-known') && identical
      return { outcome: ok ? 'bestanden' : 'nicht bestanden', detail: `Alice: ${fmtReport(r)} nach ${n} Runden, ${sub.deposits} Einlieferungen; Bob: Wirkung ${B.received.length}×, Dispositionen ${B.dispositions.join(',')}; Quittungen ${ackFrames.length}, byte-identisch: ${identical ? 'ja' : 'nein'}` }
    },
  },
  {
    id: 'T10',
    title: 'Gerät offline, Träger unerreichbar: der Zusteller berichtet innerhalb des Horizonts, nie Schweigen',
    async run(wire) {
      const w = new Welt(wire)
      const { A, B } = await w.pair(await party('alice'), await party('bob'))
      A.online = false
      const d = await A.send({ note: 'zwei' })
      await w.rounds(HORIZON.status)
      const r1 = A.zusteller.report(d)
      A.online = true
      w.carrier.unreachable = true
      await w.rounds(HORIZON.status)
      const r2 = A.zusteller.report(d)
      w.carrier.unreachable = false
      B.online = false
      await w.rounds(HORIZON.status)
      const r3 = A.zusteller.report(d)
      B.online = true
      const n = await w.until(() => A.zusteller.report(d)?.state === 'delivered')
      const r4 = A.zusteller.report(d)
      const ok = r1?.state === 'awaiting-transport' && r1.reason === 'offline' && r2?.state === 'awaiting-transport' && r2.reason === 'transport-unreachable' && r3?.state === 'accepted' && r4?.state === 'delivered' && B.received.length === 1
      return { outcome: ok ? 'bestanden' : 'nicht bestanden', detail: `offline: ${fmtReport(r1)}; Träger weg: ${fmtReport(r2)}; Bob offline: ${fmtReport(r3)}; danach ${fmtReport(r4)} nach ${n} Runden` }
    },
  },
  {
    id: 'Z1',
    title: 'Was der Träger lernt: Adresse, Identitäten, Größen; nie Inhalt oder Anker',
    async run(wire) {
      const w = new Welt(wire)
      const a = await party('alice')
      const b = await party('bob')
      const { A, B } = await w.pair(a, b)
      const d = await A.send({ note: 'geheim-drei' })
      await w.until(() => A.zusteller.report(d)?.state === 'delivered')
      const doc = w.carrier.carried.find((f) => f.address === B.endpoint.address)!
      const obs = B.endpoint.observe(doc.bytes)
      const text = dec.decode(doc.bytes)
      const leaks = [
        text.includes('geheim-drei') ? 'Inhalt' : '',
        text.includes(a.anchor) || text.includes(b.anchor) ? 'Anker' : '',
        text.includes(a.name) || text.includes('alice') ? 'Name' : '',
      ].filter(Boolean)
      const ok = leaks.length === 0 && B.received.length === 1
      return { outcome: ok ? 'bestanden' : 'nicht bestanden', detail: `Rahmen ${doc.bytes.length} B; Träger sieht ${Object.entries(obs).map(([k, v]) => `${k}=${v}`).join(', ')}; Lecks: ${leaks.length ? leaks.join(',') : 'keine'}` }
    },
  },
  {
    id: 'Z2',
    title: 'Trägerwechsel mitten in der Zustellung: die Beziehung bleibt, Wartendes geht auf dem neuen Träger hinaus',
    async run(wire) {
      const w = new Welt(wire)
      const { A, B } = await w.pair(await party('alice'), await party('bob'))
      const d1 = await A.send({ note: 'vorher' })
      await w.until(() => A.zusteller.report(d1)?.state === 'delivered')
      w.carrier.unreachable = true
      const d2 = await A.send({ note: 'während' })
      await w.rounds(HORIZON.status)
      const r = A.zusteller.report(d2)
      const neu = new Carrier()
      for (const dev of w.devices) dev.rebind(neu)
      w.carrier = neu
      const n = await w.until(() => A.zusteller.report(d2)?.state === 'delivered')
      const ok = r?.state === 'awaiting-transport' && A.zusteller.report(d2)?.state === 'delivered' && B.received.length === 2 && neu.carried.length > 0
      return { outcome: ok ? 'bestanden' : 'nicht bestanden', detail: `vor dem Wechsel ${fmtReport(r)}, nach dem Wechsel ${fmtReport(A.zusteller.report(d2))} nach ${n} Runden; Bob hat ${B.received.length} Dokumente; neuer Träger trug ${neu.carried.length} Rahmen` }
    },
  },
  {
    id: 'Z3',
    title: 'Mehrgerät: zwei Geräte des Empfängers unter einer Adresse, beide erhalten das Dokument, der Sender wird einmal bestätigt',
    async run(wire) {
      const w = new Welt(wire)
      const { A, B, more } = await w.pair(await party('alice'), await party('bob'), ['bob-2'])
      const B2 = more[0]!
      const d = await A.send({ note: 'an-beide' })
      const n = await w.until(() => A.zusteller.report(d)?.state === 'delivered' && B.received.length === 1 && B2.received.length === 1)
      const ok = n > 0 && A.zusteller.report(d)?.state === 'delivered'
      return { outcome: ok ? 'bestanden' : 'nicht bestanden', detail: `Alice: ${fmtReport(A.zusteller.report(d))} nach ${n} Runden; bob: ${B.received.length}, bob-2: ${B2.received.length}; Quittungen an Alice: ${w.carrier.carried.filter((f) => f.address === A.endpoint.address).length}` }
    },
  },
]

/** Wo ein Rahmen abgewiesen wurde: am Draht (der Rahmen öffnet sich nicht; Meldung des Drahts) oder am Dokument (Stufen der lib: Umschlag, Beweis). */
const rejectedWhere = (B: Device) => {
  const atWire = B.dispositions.some((d) => d.startsWith('failed(malformed): '))
  const atEnvelope = B.dispositions.includes('failed(malformed)') || B.dispositions.includes('failed(decryption-failed)')
  const atProof = B.dispositions.includes('failed(proof-invalid)')
  const where = atWire ? 'am Draht (Rahmen nicht zu öffnen)' : atEnvelope ? 'am Dokument (Umschlag: rkid unbekannt oder nicht zu öffnen)' : atProof ? 'am Dokument (Beweis gilt nicht für Alices Anker)' : 'NICHT'
  return { ok: B.received.length === 0 && (atWire || atEnvelope || atProof), where }
}

deliveryScenarios.push(
  {
    id: 'Z4',
    title: 'Fremder Absender: Mallory liefert ein Dokument „von Alice“ an Bobs unveränderten Empfängerschlüssel; wo wird es abgewiesen?',
    async run(wire) {
      const w = new Welt(wire)
      const a = await party('alice')
      const b = await party('bob')
      const m = await party('mallory')
      const { B } = await w.pair(a, b)
      // Mallory kennt Bobs Adresse und seinen öffentlichen Beziehungsschlüssel zu Alice (der Träger sieht die Adresse,
      // der Schlüssel ist öffentlich); sie hat Alices Anker und Alices Beziehungsschlüssel nicht. Nur der Absender ist
      // fremd, der Empfängerschlüssel ist der echte (Issue #42).
      const forged = await B.sealedFor(m, { note: 'von-mallory' })
      const frame = await B.endpoint.forge(forged.bytes, m)
      w.carrier.deposit(B.endpoint.address, frame)
      await w.rounds(2)
      const r = rejectedWhere(B)
      return { outcome: r.ok ? 'bestanden' : 'nicht bestanden', detail: `abgewiesen ${r.where}; Dispositionen ${B.dispositions.join(',')}` }
    },
  },
  {
    id: 'Z5',
    title: 'Falscher Empfängerschlüssel: ein Rahmen an eine andere Beziehung Bobs landet an Bobs Adresse',
    async run(wire) {
      const w = new Welt(wire)
      const a = await party('alice')
      const b = await party('bob')
      const c = await party('carol')
      const { A, B } = await w.pair(a, b)
      // Carol packt korrekt an ihre eigene Beziehung zu Bob (anderer Endpunkt, anderer Schlüssel); der Träger
      // liefert den Rahmen an Bobs Alice-Adresse. Bobs Alice-Endpunkt muss ihn abweisen, nie öffnen.
      const other = await wire.bind(c, b)
      const doc = await B.sealedFor(c, { note: 'von-carol' })
      const frame = await other.b.pack(doc.bytes)
      w.carrier.deposit(B.endpoint.address, frame)
      await w.rounds(2)
      const r = rejectedWhere(B)
      return { outcome: r.ok ? 'bestanden' : 'nicht bestanden', detail: `abgewiesen ${r.where}; Dispositionen ${B.dispositions.join(',')}; Adressen verschieden: ${other.b.address !== B.endpoint.address ? 'ja' : 'nein'}` }
    },
  },
)

export async function runDelivery(make: WireFactory): Promise<DeliveryResult[]> {
  const out: DeliveryResult[] = []
  for (const s of deliveryScenarios) {
    const wire = await make()
    try {
      out.push({ scenario: s.id, title: s.title, ...(await s.run(wire)) })
    } catch (e) {
      out.push({ scenario: s.id, title: s.title, outcome: 'nicht bestanden', detail: `Fehler: ${(e as Error).message}` })
    }
  }
  return out
}
