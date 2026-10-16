// Zustellungs-Prüfstand (E11): Paar-Verkehr über einen Träger, der speichert
// und weiterleitet. Der Kandidat ist der Draht (wie ein versiegelter Umschlag
// adressiert und gerahmt wird: Prüfstand-Umschlag, TSP, DIDComm); der
// Zusteller (Sender-Trias nach Delivery §6.1, mindestens einmal nach §6.3) und
// der Empfänger (Dispositionen nach §6.2 über `receive` der lib) sind für
// alle Drähte gleich. So zeigt der Prüfstand, was der Port verlangt und was
// nur die Form eines Trägers ist. Keine Uhr: Horizonte sind Runden.

import { seal, receive, xFromSeed, edFromSeed, mkOfX, anchorOfEd, diSign, diVerify, jcs, rand, digestBytes } from '@real-life/trust-protocol'
import type { Json, KeyPair } from '@real-life/trust-protocol'

const enc = new TextEncoder()
const dec = new TextDecoder()

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

  register(device: string, address: string) {
    if (!this.registered.has(address)) this.registered.set(address, new Set())
    this.registered.get(address)!.add(device)
  }
  deposit(address: string, bytes: Uint8Array) {
    if (this.unreachable) throw new WireUnreachable('Träger unerreichbar')
    const f: Frame = { id: ++this.seq, address, bytes }
    this.carried.push(f)
    if (this.dropNextDeposit) {
      this.dropNextDeposit = false
      return
    }
    if (!this.queues.has(address)) this.queues.set(address, [])
    this.queues.get(address)!.push(f)
  }
  /** Liefert einem Gerät, was für seine Adressen liegt; das Gerät bestätigt mit `conclude`. */
  collect(device: string): Frame[] {
    if (this.unreachable || this.offline.has(device)) return []
    const out: Frame[] = []
    for (const [address, devices] of this.registered) {
      if (!devices.has(device)) continue
      const q = this.queues.get(address) ?? []
      for (const f of q) {
        if (this.dropDeliveryTo.has(address)) {
          this.dropDeliveryTo.delete(address)
          q.splice(q.indexOf(f), 1)
          break
        }
        out.push(f)
      }
    }
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

interface Submission {
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
    const s: Submission = { digest, frame, address, report: null, transport: 'ok', rounds: 0, sinceAccepted: null, sinceDeposit: 0, deposits: 0 }
    this.submissions.set(digest, s)
    this.tryDeposit(s)
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
      s.rounds++
      s.sinceDeposit++
      if (s.sinceAccepted !== null) s.sinceAccepted++
      if (s.report?.state === 'delivered' || s.report?.state === 'failed') continue
      if (s.sinceAccepted !== null && s.sinceAccepted >= HORIZON.giveUp) {
        s.report = { state: 'failed', reason: 'expired-by-adapter-policy' }
        this.notes.push(`${s.digest.slice(0, 8)} aufgegeben ${s.sinceAccepted} Runden nach der Annahme (zuletzt ${s.transport})`)
        continue
      }
      if (s.report === null || s.report.state === 'awaiting-transport') {
        this.tryDeposit(s)
        continue
      }
      // Mindestens einmal: ohne Quittung noch einmal dieselben Bytes (der Empfänger dedupliziert, §6.3).
      if (s.sinceDeposit >= HORIZON.ackWait) this.tryDeposit(s)
    }
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

export class Device {
  readonly zusteller: Zusteller
  readonly completed = new Set<string>()
  /** Quittungen, byte-identisch aufbewahrt, je Digest des quittierten Dokuments (§6.2 Stufe 4). */
  readonly acks = new Map<string, { frame: Uint8Array; digest: string }>()
  readonly received: Array<{ digest: string; doc: Record<string, unknown> }> = []
  readonly dispositions: string[] = []
  online = true
  private carrierRef: Carrier
  constructor(
    readonly name: string,
    readonly party: Party,
    readonly endpoint: Endpoint,
    readonly peer: Party,
    readonly peerEndpoint: Endpoint,
    carrier: Carrier,
  ) {
    this.carrierRef = carrier
    this.zusteller = new Zusteller(name, () => this.carrierRef, () => this.online)
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

  /** Ein Dokument an den Partner versiegeln und einliefern; liefert den Digest (die Kennung der Einlieferung). */
  async send(payload: Record<string, Json>, threadId = crypto.randomUUID()): Promise<string> {
    const { digest, bytes } = await this.sealed(this.party, payload, threadId)
    const frame = await this.peerEndpoint.pack(bytes)
    this.zusteller.submit(digest, frame, this.peerEndpoint.address)
    return digest
  }

  /** Ein Dokument unter dem Anker des Ausstellers signieren und an den Partner versiegeln (Delivery §4, §5). */
  async sealed(issuer: Party, payload: Record<string, Json>, threadId = crypto.randomUUID()) {
    return sealDoc(issuer, this.peer, payload, threadId)
  }
  /** Ein Dokument eines Dritten an DIESES Gerät versiegelt (Angreifer-Sicht: Mallory an Bob). */
  async sealedFor(issuer: Party, payload: Record<string, Json>, threadId = crypto.randomUUID()) {
    return sealDoc(issuer, this.party, payload, threadId)
  }

  /** Eine Runde: abholen, öffnen, quittieren; Quittungen verbuchen; Wartendes vorantreiben. */
  async round() {
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
      if (frames.length) this.carrier.conclude(this.name, frames.map((f) => f.id))
    }
    this.zusteller.advance()
  }

  private async handle(payload: Uint8Array) {
    let env: unknown
    try {
      env = JSON.parse(dec.decode(payload))
    } catch {
      this.dispositions.push('failed(malformed)')
      return
    }
    const v = await receive(env, (rkid) => (rkid === this.party.rkid ? this.party.x.priv : undefined), this.completed)
    this.dispositions.push(v.disposition)
    if (v.disposition === 'duplicate-known') {
      // Die aufbewahrte Quittung noch einmal, byte-identisch (§6.2 Stufe 4).
      const ack = this.acks.get(v.digest!)
      if (ack) this.zusteller.submit(ack.digest, ack.frame, this.peerEndpoint.address)
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
      { id: crypto.randomUUID(), type: ACK_TYPE, issuer: this.party.anchor, recipient: this.peer.anchor, threadId: doc.threadId as string, issuedAt: new Date().toISOString(), payload: { ref: v.digest!, meaning: 'received' } },
      new Date().toISOString(),
    )
    const ackEnv = await seal(ackDoc as unknown as Json, this.peer.rkid)
    const ackBytes = enc.encode(jcs(ackEnv))
    const ackDigest = await digestBytes(enc.encode(jcs(ackDoc)))
    const ackFrame = await this.peerEndpoint.pack(ackBytes)
    this.acks.set(v.digest!, { frame: ackFrame, digest: ackDigest })
    this.completed.add(v.digest!)
    this.zusteller.submit(ackDigest, ackFrame, this.peerEndpoint.address)
  }
}

async function sealDoc(issuer: Party, recipient: Party, payload: Record<string, Json>, threadId: string) {
  const unsigned = { id: crypto.randomUUID(), type: DOC_TYPE, issuer: issuer.anchor, recipient: recipient.anchor, threadId, issuedAt: new Date().toISOString(), payload }
  const doc = await diSign({ anchor: issuer.anchor, ed: { priv: issuer.ed.priv } }, unsigned, new Date().toISOString())
  const env = await seal(doc as unknown as Json, recipient.rkid)
  return { digest: await digestBytes(enc.encode(jcs(doc))), bytes: enc.encode(jcs(env)) }
}

// ── Welt: zwei Parteien, ein Träger, Runden ──────────────────────────────────

export class Welt {
  carrier = new Carrier()
  readonly devices: Device[] = []
  constructor(readonly wire: Wire) {}
  async pair(a: Party, b: Party, extraB: string[] = []) {
    const e = await this.wire.bind(a, b)
    const A = new Device(a.name, a, e.a, b, e.b, this.carrier)
    const B = new Device(b.name, b, e.b, a, e.a, this.carrier)
    this.devices.push(A, B)
    const more = extraB.map((n) => new Device(n, b, e.b, a, e.a, this.carrier))
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
