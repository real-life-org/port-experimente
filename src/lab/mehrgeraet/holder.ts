// E15 Mehrgerät: das Holder-Gerät. Hält den Holder-Zustand (model.ts) über
// alle Beziehungen, verwendet Träger, Zusteller, Uhr und Store des
// E11-Prüfstands wieder (zustellung.ts), nicht dessen Device (Plan Runde 3,
// Abschnitt 2). Was ein Kandidat beisteuert: Schlüsselableitung je Gerät,
// die Freigabe von Operationen (Rechte) und die Art, wie Operationen
// zwischen eigenen Geräten geteilt werden (CandidateDevice).
//
// Commit-Grenze (Tor-Review 2 S8, #56): jedes Dokument wird mit dem
// Zustand aufgezeichnet und committet, bevor es das Gerät verlässt
// (HSC-110); `before-send` ist die Absturzstelle dazwischen. Das gilt für
// Nutzeraktionen, Empfang und Zeitübergänge gleichermaßen: der Zusteller
// liefert nur ein, was das Gerät nach dem Commit freigegeben hat.
// Quittungen gehen erst nach dem Commit der Wirkung hinaus (#54). Alles,
// was ein Neuaufbau braucht, steht im Store-Abbild (#57). Jede
// quittierbare Submission kennt ihren erwarteten Quittungs-Signierer;
// andere Quittungen wirken nicht (#55).
//
// Blockiert heißt nicht fehlerhaft, und zwar ganz: verweigert der Kandidat
// eine Operation, bleibt von der Nutzeraktion, vom empfangenen Rahmen oder
// vom Zeitübergang nichts zurück (Zustand, Submissions, Quittungen,
// Journal); der Rahmen wird nicht quittiert, die Gegenseite wiederholt ihn.
// Nicht zurückgenommen werden Schlüsselableitungen und Adressanmeldungen
// am Träger (`listen`): sie tragen keinen Zustand.

import { seal, receive, edFromSeed, xFromSeed, anchorOfEd, mkOfX, diSign, diVerify, jcs, digestBytes } from '@real-life/trust-protocol'
import type { Json, KeyPair } from '@real-life/trust-protocol'
import { createHash, createHmac } from 'node:crypto'
import { Carrier, Zusteller, realClock, type Clock, type Store, type Submission, Crashed, type CrashPoint } from '../zustellung'
import * as M from './model'

const enc = new TextEncoder()
const dec = new TextDecoder()

// ── Schlüssel ────────────────────────────────────────────────────────────────

export interface Keys {
  ed: KeyPair
  x: KeyPair
  anchor: string
  rkid: string
}

/** Schlüsselableitung für einen Kontextnamen; der Kandidat entscheidet, aus welchem Seed (one-seed oder je Gerät). */
export interface KeyScheme {
  pair(ctx: string): Promise<Keys>
}

export function derive(seed: Uint8Array, ctx: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(seed).update(ctx).digest())
}

/** Ein Seed, zustandslose Ableitung je Kontext (Schnitt one-seed, K0/K1). */
export function seedScheme(seed: Uint8Array): KeyScheme {
  const cache = new Map<string, Promise<Keys>>()
  return {
    pair(ctx) {
      let p = cache.get(ctx)
      if (!p) {
        p = (async () => {
          const ed = await edFromSeed(derive(seed, `ed/${ctx}`))
          const x = await xFromSeed(derive(seed, `x/${ctx}`))
          return { ed, x, anchor: anchorOfEd(ed.pubRaw), rkid: mkOfX(x.pubRaw) }
        })()
        cache.set(ctx, p)
      }
      return p
    },
  }
}

// ── Kandidaten-Schnittstelle ─────────────────────────────────────────────────

export interface OwnFrame {
  body: Uint8Array
}

/** Der Kandidat verweigert eine Operation (fehlendes Recht, K1a): die Nutzeraktion ist blockiert, nicht fehlerhaft. */
export class Blocked extends Error {}

/** Was ein Kandidat je Gerät beisteuert. Der Holder-Zustand gehört dem Gerät; der Kandidat sagt, was erlaubt ist und wie Operationen geteilt werden. */
export interface CandidateDevice {
  readonly keys: KeyScheme
  /** Schreiberinkarnation für Operations-IDs (wechselt bei Enrollment und Restore, Befund 5). */
  readonly writer: string
  /** Rechteprüfung VOR der Anwendung (B3): false = blockiert. Ohne Methode ist alles erlaubt. */
  authorize?(op: M.Op, state: M.HolderState): boolean
  /** Eine lokal entschiedene Operation ist angewandt; der Kandidat verbreitet sie (oder nicht). */
  record(op: M.Op): void
  /** Rahmen an die eigenen Geräte (Journal), an die eigene Adresse der Person (Plan Runde 3). */
  takeOwnFrames(): OwnFrame[]
  /** Ein Rahmen eines eigenen Geräts: liefert die Operationen, die das Gerät anwenden soll. */
  receiveOwnFrame(body: Uint8Array): M.Op[]
  /** Was der Kandidat dauerhaft hält (Journal); Teil des Store-Abbilds. */
  persist(): unknown
  /** Neuaufbau aus dem Store; ein Kandidat mit Inkarnationen wechselt hier die Inkarnation. */
  restore(data: unknown): void
}

export interface MultiDeviceCandidate {
  readonly id: string
  readonly title: string
  readonly capabilities: ReadonlySet<'journal' | 'rights' | 'device-keys' | 'restricted-app'>
  /** Erstes Gerät einer Person. */
  first(person: string, device: string, seed: Uint8Array): Promise<CandidateDevice>
  /** Weiteres Gerät: Enrollment aus einem bestehenden Gerät (X8). Liefert den Kandidatenteil und den Zustand, mit dem das neue Gerät beginnt. */
  enrol(from: HolderDevice, device: string): Promise<{ cand: CandidateDevice; state: M.HolderState }>
  /** Widerruf eines Geräts (X9, K2): was die übrigen Geräte und die Gegenseiten davon erfahren. Ohne Methode geschieht nichts. */
  revoke?(from: HolderDevice, device: string): Promise<void>
}

// ── Dokumente ────────────────────────────────────────────────────────────────

export const TYPES = {
  revision: 'https://real-life.org/rltp/e15/introduction-prekeys/0.1',
  ticket: 'https://real-life.org/rltp/e15/introduction-ticket/0.1',
  card: 'https://real-life.org/rltp/e15/introduction-card/0.1',
  probe: 'https://real-life.org/rltp/e15/continuity-probe/0.1',
  mapping: 'https://real-life.org/rltp/e15/continuity-mapping/0.1',
  journal: 'https://real-life.org/rltp/e15/journal/0.1',
  ack: 'https://real-life.org/trust-tasks/delivery-ack/0.1',
} as const

interface Doc {
  id: string
  type: string
  issuer: string
  recipient: string
  /** Antwortadresse des Absenders (rkid) für die Quittung. */
  replyTo: string
  issuedAt: string
  payload: Record<string, Json>
}

/** Eine Operation ohne Kennung und Zeit (verteilt über die Union). */
type OpBody = M.Op extends infer O ? (O extends M.Op ? Omit<O, 'id' | 'at'> : never) : never

/** Eigene Dokumente, deren Ausgang fachlich wirkt (Karte, Mapping), mit den Bytes für eine Wiederholung. */
interface Sent {
  kind: 'card' | 'mapping' | 'journal'
  act?: string
  pair?: [string, string]
  frame: Uint8Array
  address: string
}

export interface DeviceState {
  holder: M.HolderState
  submissions: Submission[]
  completed: string[]
  acks: Array<[string, { frame: Uint8Array; digest: string; address: string }]>
  dispositions: string[]
  counter: number
  candidate: unknown
  sent: Array<[string, Sent]>
  buffer: Array<[string, { card: M.Card; v: string }]>
  /** Digest → erwarteter Signierer der Quittung, für jede quittierbare Submission (#55). */
  expected: Array<[string, string]>
}

export interface Measures {
  framesOut: number
  bytesOut: number
  ownFramesOut: number
  ownBytesOut: number
  /** Vom Kandidaten blockierte Operationen (B1). */
  blocked: number
}

export type ActionResult = 'ok' | 'blocked' | 'crashed'

export class HolderDevice {
  state: M.HolderState
  readonly zusteller: Zusteller
  completed = new Set<string>()
  acks = new Map<string, { frame: Uint8Array; digest: string; address: string }>()
  dispositions: string[] = []
  /** Empfangene Dokumente (Typ, Absender) für die Auswertung. */
  readonly log: Array<{ type: string; from: string; at: string }> = []
  online = true
  crashAt: CrashPoint | null = null
  readonly crashes: CrashPoint[] = []
  measures: Measures = { framesOut: 0, bytesOut: 0, ownFramesOut: 0, ownBytesOut: 0, blocked: 0 }
  private down = false
  private counter = 0
  private sent = new Map<string, Sent>()
  private buffer = new Map<string, { card: M.Card; v: string }>()
  /** Digest → erwarteter Quittungs-Signierer je eigener Submission (#55); lesbar für Messungen. */
  expected = new Map<string, string>()
  /** Innerhalb eines `guarded`-Rahmens: Operationen, die der Kandidat erst nach dem Gelingen aufzeichnet. */
  private pending: M.Op[] | null = null
  /** Aufgezeichnet, noch nicht eingeliefert: geht nach dem nächsten Commit hinaus. */
  private held: string[] = []
  private readonly ctxOfRkid = new Map<string, string>()
  private readonly ctxOfAnchor = new Map<string, string>()
  private privOf = new Map<string, CryptoKey>()
  private ownRkid: string | null = null
  private carrierRef: Carrier
  constructor(
    readonly name: string,
    readonly person: string,
    public cand: CandidateDevice,
    carrier: Carrier,
    readonly clock: Clock = realClock,
    private readonly store?: Store<DeviceState>,
    state: M.HolderState = M.emptyState(person),
  ) {
    this.state = state
    this.carrierRef = carrier
    this.zusteller = new Zusteller(name, () => this.carrierRef, () => this.online && !this.down)
  }
  get carrier() {
    return this.carrierRef
  }
  rebind(carrier: Carrier) {
    this.carrierRef = carrier
    for (const a of this.ctxOfRkid.keys()) carrier.register(this.name, a)
  }

  // ── Adressen und Schlüssel ──
  /** Jeder eigene Empfangsschlüssel ist eine Adresse am Träger; beide Geräte einer Person registrieren dieselben (K0/K1). */
  async listen(ctx: string): Promise<Keys> {
    const k = await this.keysFor(ctx)
    if (!this.ctxOfRkid.has(k.rkid)) {
      this.ctxOfRkid.set(k.rkid, ctx)
      this.ctxOfAnchor.set(k.anchor, ctx)
      this.carrierRef.register(this.name, k.rkid)
    }
    return k
  }
  /** Nach Enrollment oder Neuaufbau: alle Adressen aus dem Zustand neu registrieren, offene Pflichten wieder aufnehmen. */
  async relisten(): Promise<void> {
    this.ownRkid = (await this.listen(`self/${this.person}`)).rkid
    for (const r of this.state.relationships) {
      for (const t of r.tuples) await this.listen(t.ownKey)
      for (const k of r.stock) await this.listen(k.key)
    }
    for (const a of this.state.acts) if (a.ownCardKey) await this.listen(a.ownCardKey)
    await this.resumeDuties()
  }
  private readonly resolve = (rkid: string): CryptoKey | undefined => this.privOf.get(rkid)
  private async keysFor(ctx: string): Promise<Keys> {
    const k = await this.cand.keys.pair(ctx)
    this.privOf.set(k.rkid, k.x.priv)
    return k
  }

  // ── Operationen ──
  private op(body: OpBody): M.Op {
    return { id: { writer: this.cand.writer, n: ++this.counter }, at: this.clock.now(), ...body } as unknown as M.Op
  }
  /** Entscheiden → freigeben (Kandidat) → anwenden → aufzeichnen. Wirft `Blocked`, wenn der Kandidat die Operation verweigert. */
  private emit(body: OpBody): M.Op {
    const op = this.op(body)
    if (this.cand.authorize && !this.cand.authorize(op, this.state)) {
      this.counter--
      this.measures.blocked++
      throw new Blocked(op.kind)
    }
    M.apply(this.state, op)
    if (this.pending) this.pending.push(op)
    else this.cand.record(op)
    return op
  }
  /** Operationen eines eigenen Geräts (Journal) anwenden. */
  async applyRemote(ops: M.Op[]): Promise<void> {
    for (const op of ops) M.apply(this.state, op)
    await this.relisten()
    await this.refillAll()
  }

  // ── Alles oder nichts ──
  private checkpoint() {
    return {
      holder: structuredClone(this.state),
      submissions: [...this.zusteller.submissions.values()],
      completed: new Set(this.completed),
      acks: new Map(this.acks),
      counter: this.counter,
      sent: new Map(this.sent),
      buffer: new Map(this.buffer),
      expected: new Map(this.expected),
      held: this.held.slice(),
      framesOut: this.measures.framesOut,
      bytesOut: this.measures.bytesOut,
    }
  }
  private rollback(c: ReturnType<HolderDevice['checkpoint']>) {
    this.state = c.holder
    this.zusteller.restore(c.submissions)
    this.completed = c.completed
    this.acks = c.acks
    this.counter = c.counter
    this.sent = c.sent
    this.buffer = c.buffer
    this.expected = c.expected
    this.held = c.held
    this.measures.framesOut = c.framesOut
    this.measures.bytesOut = c.bytesOut
  }
  /**
   * Ein Schritt ganz oder gar nicht: verweigert der Kandidat eine Operation (`Blocked`), wird alles seit dem
   * Beginn zurückgenommen, der Kandidat hat nichts aufgezeichnet, die Disposition `blocked(<op>)` bleibt.
   * Liefert false, wenn blockiert. Absturz und andere Fehler gehen durch.
   */
  private async guarded(f: () => Promise<void>): Promise<boolean> {
    const c = this.checkpoint()
    const outer = this.pending
    this.pending = []
    try {
      await f()
      const ops = this.pending
      this.pending = outer
      if (outer) outer.push(...ops)
      else for (const op of ops) this.cand.record(op)
      return true
    } catch (e) {
      this.pending = outer
      if (!(e instanceof Blocked)) throw e
      this.rollback(c)
      this.dispositions.push(`blocked(${e.message})`)
      return false
    }
  }

  // ── Store, Commit-Grenze, Absturz ──
  snapshotState(): DeviceState {
    return {
      holder: structuredClone(this.state),
      submissions: [...this.zusteller.submissions.values()],
      completed: [...this.completed],
      acks: [...this.acks],
      dispositions: this.dispositions.slice(),
      counter: this.counter,
      candidate: this.cand.persist(),
      sent: [...this.sent],
      buffer: [...this.buffer],
      expected: [...this.expected],
    }
  }
  commit() {
    this.store?.commit(this.snapshotState())
  }
  /** Neuaufbau aus dem Store (#57): alles Flüchtige wird aus dem Abbild ersetzt, nichts bleibt aus dem alten Lauf. */
  async reload(): Promise<void> {
    const s = this.store?.load()
    this.state = s?.holder ?? M.emptyState(this.person)
    this.zusteller.restore(s?.submissions ?? [])
    this.completed = new Set(s?.completed ?? [])
    this.acks = new Map(s?.acks ?? [])
    this.dispositions = s?.dispositions.slice() ?? []
    this.counter = s?.counter ?? 0
    this.sent = new Map(s?.sent ?? [])
    this.buffer = new Map(s?.buffer ?? [])
    this.expected = new Map(s?.expected ?? [])
    // Was im Store steht, ist committet: vorgemerkte, nie freigegebene Submissions gehen nach dem nächsten Commit hinaus.
    this.held = this.zusteller.unreleased()
    this.cand.restore(s?.candidate ?? null)
    this.down = false
    await this.relisten()
  }
  private crash(point: CrashPoint) {
    if (this.crashAt !== point) return
    this.crashAt = null
    this.down = true
    this.crashes.push(point)
    throw new Crashed(point)
  }
  /**
   * Commit-Grenze einer Nutzeraktion: Zustand und versandfertige Bytes
   * sichern, dann freigeben. `before-send` liegt zwischen Commit und Freigabe
   * (HSC-110, #56). Ein Absturz dort lässt das Gerät aus; die Submissions
   * stehen im Store und gehen nach dem Neuaufbau hinaus.
   */
  private async flush(): Promise<void> {
    this.crash('before-commit')
    this.commit()
    this.crash('before-send')
    for (const d of this.held.splice(0)) this.zusteller.deposit(d)
  }
  /** Eine Nutzeraktion: blockiert (ganz zurückgenommen) oder abgestürzt heißt nicht fehlerhaft. */
  private async action(f: () => Promise<void>): Promise<ActionResult> {
    if (this.down) return 'crashed'
    try {
      if (!(await this.guarded(f))) return 'blocked'
      await this.flush()
      return 'ok'
    } catch (e) {
      if (e instanceof Crashed) return 'crashed'
      throw e
    }
  }

  // ── Senden ──
  /** Dokument signieren, versiegeln, aufzeichnen; eingeliefert wird nach dem nächsten Commit (`flush`, Rundenende). `recipient` ist der Anker, von dem die Quittung erwartet wird (#55). */
  private async sendDoc(type: string, issuerCtx: string, recipient: string, toRkid: string, replyTo: string, payload: Record<string, Json>): Promise<{ digest: string; bytes: Uint8Array }> {
    const k = await this.keysFor(issuerCtx)
    const unsigned: Doc = { id: crypto.randomUUID(), type, issuer: k.anchor, recipient, replyTo, issuedAt: this.clock.now(), payload }
    const doc = await diSign({ anchor: k.anchor, ed: { priv: k.ed.priv } }, unsigned as unknown as Record<string, Json>, this.clock.now())
    const env = await seal(doc as unknown as Json, toRkid)
    const bytes = enc.encode(jcs(env))
    const digest = await digestBytes(enc.encode(jcs(doc)))
    this.zusteller.record(digest, bytes, toRkid)
    this.held.push(digest)
    this.expected.set(digest, recipient)
    this.measures.framesOut++
    this.measures.bytesOut += bytes.length
    return { digest, bytes }
  }

  // ── Nutzeraktionen und Fachlogik ──

  /** Schlüssel für eine Begegnung (bevor das Tupel geöffnet ist): die Gegenseite braucht Anker und rkid. */
  async encounterKeys(id: string): Promise<Keys> {
    return this.listen(`enc/${id}/${this.person}`)
  }
  /** Begegnung: eigenes Tupel zu einer Gegenseite öffnen (Encounter, vereinfacht). `id` ist je Begegnung gleich für beide Seiten (Prüfstand). */
  async openEncounter(id: string, peer: { anchor: string; rkid: string }): Promise<M.Tuple> {
    const ctx = `enc/${id}/${this.person}`
    const k = await this.listen(ctx)
    const t: M.Tuple = { id: `${this.person}:${id}`, own: k.anchor, ownKey: ctx, peer: peer.anchor, peerKeyAgreement: peer.rkid, record: `${id}:${k.anchor}`, openedAt: this.clock.now(), candidates: this.candidates(), deactivated: false }
    await this.action(async () => {
      this.emit({ kind: 'open-tuple', rel: null, tuple: t, provenance: 'encounter', vouchedBy: null, act: null })
      await this.sendProbe(t)
    })
    return t
  }
  /** 2300/6730: eingefrorene Kandidatenliste = Gegenanker aller gehaltenen Beziehungen. */
  private candidates(): string[] {
    return [...new Set(this.state.relationships.filter((r) => !r.departed).flatMap((r) => r.tuples.map((t) => t.peer)))].sort()
  }

  /** Klasse „darf mich vorstellen“ an diesen Kontakt ein-/ausschalten (Aussteller); ein: nachfüllen (8485); aus: Widerruf und leere Revision (8535). */
  async setClass(relId: string, on: boolean): Promise<ActionResult> {
    return this.action(async () => {
      this.emit({ kind: 'class', rel: relId, on })
      if (on) await this.refill(relId)
      else {
        const r = M.rel(this.state, relId)
        const anchors = r.stock.filter((k) => k.state === 'active' || k.state === 'aging').map((k) => k.anchor)
        this.emit({ kind: 'withdraw', rel: relId, anchors }) // 8475.S6
        await this.sendRevision(relId)
      }
    })
  }

  /** Abgang einer Beziehung (Section 2): Vorrat withdrawn, nichts gesendet, Pflichten moot. */
  async depart(relId: string): Promise<ActionResult> {
    return this.action(async () => {
      this.emit({ kind: 'depart', rel: relId })
    })
  }

  /** 8515: der Nutzer bestätigt ein neues Budget. */
  async confirmBudget(relId: string): Promise<ActionResult> {
    return this.action(async () => {
      this.emit({ kind: 'budget-confirm', rel: relId })
      await this.refill(relId)
    })
  }

  /** 8485: unter drei aktiven auf fünf nachfüllen, Revision senden; nur bei Klasse an und Budget nicht erschöpft (8512). */
  private async refill(relId: string): Promise<void> {
    const r = M.rel(this.state, relId)
    if (!r.classOn || r.departed || M.budgetExhausted(r, this.clock.now())) return
    const active = r.stock.filter((k) => k.state === 'active')
    if (active.length >= M.PARAM.refillBelow) return
    const nonce = r.nonce ?? Buffer.from(derive(enc.encode(`${this.person}/${r.id}/${this.cand.writer}/${this.counter}`), 'nonce')).toString('base64')
    const keys: M.StockKey[] = []
    for (let n = r.nextN; keys.length < M.PARAM.refillTo - active.length; n++) {
      const ctx = `introduction/${nonce}/${n}`
      const k = await this.listen(ctx)
      keys.push({ n, anchor: k.anchor, keyAgreement: k.rkid, key: ctx, expiresAt: new Date(Date.parse(this.clock.now()) + M.PARAM.prekeyLifetimeMs).toISOString(), state: 'active' })
    }
    this.emit({ kind: 'allocate', rel: r.id, nonce, keys })
    await this.sendRevision(r.id)
  }
  private async refillAll(): Promise<void> {
    for (const r of this.state.relationships) if (r.classOn && !r.departed) await this.guarded(() => this.refill(r.id))
  }

  /** 8495/8500: Revision des aktuellen Zustands auf dem Kopf an den Mediator. */
  private async sendRevision(relId: string): Promise<void> {
    const r = M.rel(this.state, relId)
    if (r.departed) return
    const h = M.head(r)
    const revision = r.revision + 1
    const keys = r.stock.filter((k) => k.state === 'active').map((k) => ({ anchor: k.anchor, keyAgreement: k.keyAgreement, expiresAt: k.expiresAt }))
    this.emit({ kind: 'revision', rel: r.id, revision, keys })
    await this.sendDoc(TYPES.revision, h.ownKey, h.peer, h.peerKeyAgreement, (await this.keysFor(h.ownKey)).rkid, { revision, keys })
  }

  /** M: zwei Seiten vorstellen (8605, 8570). Liefert die Akt-Id oder den Grund, warum nichts ging. */
  async introduce(relA: string, relB: string, nameA = 'A', nameB = 'B'): Promise<{ act: string } | { refused: string }> {
    const now = this.clock.now()
    const pick = (relId: string) => {
      const r = M.rel(this.state, relId)
      if (!r.view) return null
      return r.view.keys.find((k) => M.usable(k.expiresAt, now) && !this.state.consumed.includes(k.anchor)) ?? null // 8570.4
    }
    const ka = pick(relA)
    const kb = pick(relB)
    if (!ka || !kb) return { refused: `kein benennbarer Schlüssel (${ka ? '' : relA} ${kb ? '' : relB})`.trim() }
    const act: M.MediatorAct = { id: crypto.randomUUID(), a: { rel: M.resolveId(this.state, relA), key: ka.anchor, keyAgreement: ka.keyAgreement }, b: { rel: M.resolveId(this.state, relB), key: kb.anchor, keyAgreement: kb.keyAgreement }, issuedAt: now, expiresAt: new Date(Date.parse(now) + M.PARAM.actLifetimeMs).toISOString() }
    const r = await this.action(async () => {
      this.emit({ kind: 'introduce', act })
      const send = async (relId: string, own: { key: string; keyAgreement: string }, voucher: { key: string; keyAgreement: string }, name: string) => {
        const h = M.head(M.rel(this.state, relId))
        await this.sendDoc(TYPES.ticket, h.ownKey, h.peer, h.peerKeyAgreement, (await this.keysFor(h.ownKey)).rkid, { act: act.id, issuedAt: act.issuedAt, expiresAt: act.expiresAt, own: own.key, voucher: { anchor: voucher.key, keyAgreement: voucher.keyAgreement, name } })
      }
      await send(relA, act.a, act.b, nameB)
      await send(relB, act.b, act.a, nameA)
    })
    return r === 'ok' ? { act: act.id } : { refused: r }
  }

  /** 8325.A4: Consent, frische Karte, Übergabe. */
  async consent(actId: string): Promise<ActionResult> {
    return this.action(async () => {
      const a = M.act(this.state, actId)
      if (a.state !== 'offered') {
        this.emit({ kind: 'finding', text: `consent auf ${actId} im Zustand ${a.state}` })
        return
      }
      if (Date.parse(this.clock.now()) > Date.parse(a.expiresAt) - M.PARAM.consentReserveMs) return // 8155
      const ctx = `card/${actId}/${this.person}`
      const k = await this.listen(ctx)
      this.emit({ kind: 'consent', act: actId, card: { anchor: k.anchor, keyAgreement: k.rkid }, cardKey: ctx })
      await this.handOverCard(actId)
    })
  }
  /** 8760: die Karte geht hinaus, sobald sie darf; der Digest der Übergabe wird im Akt gehalten. */
  private async handOverCard(actId: string): Promise<void> {
    const a = M.act(this.state, actId)
    if (!a.ownCard || !a.ownCardKey) return
    const ownCtx = this.ctxOfAnchor.get(a.own)
    if (!ownCtx) return
    const own = await this.keysFor(ownCtx)
    const { digest, bytes } = await this.sendDoc(TYPES.card, ownCtx, a.voucher.anchor, a.voucher.keyAgreement, own.rkid, { act: actId, expiresAt: a.expiresAt, from: a.own, fromKeyAgreement: own.rkid, to: a.voucher.anchor, card: { anchor: a.ownCard.anchor, keyAgreement: a.ownCard.keyAgreement } })
    this.sent.set(digest, { kind: 'card', act: actId, frame: bytes, address: a.voucher.keyAgreement })
    this.emit({ kind: 'hand-over', act: actId, o: 'handed', digest })
  }

  /** 8325.A3: Ablehnung, nichts gesendet (8765). */
  async decline(actId: string): Promise<ActionResult> {
    return this.action(async () => {
      const a = M.act(this.state, actId)
      if (a.state !== 'offered') {
        this.emit({ kind: 'finding', text: `decline auf ${actId} im Zustand ${a.state}` })
        return
      }
      this.emit({ kind: 'decline', act: actId })
    })
  }

  private submitted(a: M.Act) {
    return a.o === 'taken' || a.o === 'delivered' || a.o === 'given-up'
  }
  /** 8325.A5c: eine wartende Gegenkarte nach der Einreichung der eigenen Karte neu prüfen. */
  private async evaluatePending(actId: string): Promise<void> {
    const a = M.act(this.state, actId)
    if (a.state !== 'consented' || !this.submitted(a) || !a.pending) return
    await this.connect(a, a.pending)
  }
  /** 8905: Tupel öffnen, Akt connected, Probe. */
  private async connect(a: M.Act, card: M.Card): Promise<void> {
    if (!a.ownCard || !a.ownCardKey) return
    const t: M.Tuple = { id: `${this.person}:act:${a.id}`, own: a.ownCard.anchor, ownKey: a.ownCardKey, peer: card.anchor, peerKeyAgreement: card.keyAgreement, record: `${a.id}:${a.ownCard.anchor}`, openedAt: this.clock.now(), candidates: this.candidates(), deactivated: false }
    this.emit({ kind: 'connect', act: a.id, rel: t.id, tuple: t })
    await this.sendProbe(t)
  }

  // ── Kontinuität (6a, vereinfacht) ──
  private pairKeyOf(t: M.Tuple): Buffer {
    return createHash('sha256').update([t.own, t.peer].sort().join('|')).digest()
  }
  private blind(t: M.Tuple, anchor: string): string {
    return createHmac('sha256', this.pairKeyOf(t)).update(anchor).digest('base64')
  }
  /** Probe auf dem neuen Tupel: geblendete Kandidaten (die Gegenanker aller anderen gehaltenen Tupel, eingefroren bei der Öffnung). */
  private async sendProbe(t: M.Tuple): Promise<void> {
    const entries = t.candidates.filter((c) => c !== t.peer).map((c) => this.blind(t, c))
    if (!entries.length) return
    await this.sendDoc(TYPES.probe, t.ownKey, t.peer, t.peerKeyAgreement, (await this.keysFor(t.ownKey)).rkid, { entries })
  }
  private async sendMapping(arrival: M.Tuple, other: M.Tuple): Promise<void> {
    const pair = M.pairKey(arrival.id, other.id)
    const { digest, bytes } = await this.sendDoc(TYPES.mapping, arrival.ownKey, arrival.peer, arrival.peerKeyAgreement, (await this.keysFor(arrival.ownKey)).rkid, { entry: this.blind(arrival, other.own) })
    this.sent.set(digest, { kind: 'mapping', pair, frame: bytes, address: arrival.peerKeyAgreement })
    this.emit({ kind: 'duty', pair, state: 'hit', mappingDigest: digest })
  }
  /** 6845.10: offene Mapping-Pflichten (hit, sent) ohne lokale Übergabe werden wieder aufgenommen. Vereinfachung: das Mapping wird neu produziert, nicht aus gespeicherten Bytes fortgesetzt. */
  private async resumeDuties(): Promise<void> {
    for (const d of this.state.duties) {
      if (d.state !== 'hit' && d.state !== 'sent') continue
      if ([...this.sent.values()].some((x) => x.kind === 'mapping' && x.pair && x.pair[0] === d.pair[0] && x.pair[1] === d.pair[1])) continue
      const ta = this.state.relationships.flatMap((r) => r.tuples).find((t) => t.id === d.pair[0])
      const tb = this.state.relationships.flatMap((r) => r.tuples).find((t) => t.id === d.pair[1])
      if (!ta || !tb) continue
      if (M.relOfTuple(this.state, ta.id)?.departed) continue // 6845.7
      const [arrival, other] = ta.record > tb.record ? [ta, tb] : [tb, ta]
      await this.guarded(() => this.sendMapping(arrival, other))
    }
  }

  // ── Runde ──
  async round(): Promise<void> {
    if (this.down) return
    try {
      if (this.online) {
        const frames = this.carrier.collect(this.name)
        for (const f of frames) {
          try {
            await this.guarded(() => this.handle(f.bytes, f.address))
          } catch (e) {
            if (e instanceof Crashed) throw e
            this.dispositions.push(`failed(malformed): ${(e as Error).message}`)
          }
        }
        await this.journalOut()
        this.crash('before-commit')
        this.commit()
        this.crash('after-commit')
        // Quittungen und Folgedokumente verlassen das Gerät erst nach dem Commit der Wirkung (#54, #56).
        for (const d of this.held.splice(0)) this.zusteller.deposit(d)
        if (frames.length) this.carrier.conclude(this.name, frames.map((f) => f.id))
      }
      await this.tick()
      this.zusteller.advance()
      await this.reports()
      await this.flush()
    } catch (e) {
      if (!(e instanceof Crashed)) throw e
    }
  }

  /** Journalrahmen des Kandidaten an die eigene Adresse der Person (B3; K0: keine). */
  private async journalOut(): Promise<void> {
    const frames = this.cand.takeOwnFrames()
    if (!frames.length || !this.ownRkid) return
    const ctx = `self/${this.person}`
    const self = (await this.keysFor(ctx)).anchor // das andere eigene Gerät quittiert unter demselben Anker (one-seed; K2 entscheidet neu)
    for (const f of frames) {
      const { bytes } = await this.sendDoc(TYPES.journal, ctx, self, this.ownRkid, this.ownRkid, { b: Buffer.from(f.body).toString('base64') })
      this.measures.ownFramesOut++
      this.measures.ownBytesOut += bytes.length
      this.measures.framesOut--
      this.measures.bytesOut -= bytes.length
    }
  }

  /** 8110.7: Zeitübergänge. */
  private async tick(): Promise<void> {
    const now = this.clock.now()
    for (const a of this.state.acts.slice()) {
      if (a.state === 'offered' && Date.parse(now) > Date.parse(a.expiresAt) - M.PARAM.consentReserveMs) await this.guarded(async () => void this.emit({ kind: 'expire', act: a.id })) // 8325.A7
      else if (a.state === 'consented' && Date.parse(now) > Date.parse(a.expiresAt)) await this.guarded(async () => void this.emit({ kind: 'expire', act: a.id })) // 8325.A8
    }
    for (const r of this.state.relationships.slice()) {
      const aging = r.stock.filter((k) => k.state === 'active' && !M.usable(k.expiresAt, now)).map((k) => k.anchor)
      if (aging.length) {
        await this.guarded(async () => void this.emit({ kind: 'age', rel: r.id, anchors: aging })) // 8475.S5
        await this.guarded(() => this.refill(r.id))
      }
    }
  }

  /** Zustellerberichte in Fachwirkung: Karte taken/given-up (8326), Mapping sent, Wiederholung nach `failed` (6845.4). */
  private async reports(): Promise<void> {
    for (const [d, x] of [...this.sent]) await this.guarded(() => this.reportOne(d, x))
  }
  private async reportOne(d: string, x: Sent): Promise<void> {
    {
      const r = this.zusteller.report(d)
      if (!r) return
      if (x.kind === 'card' && x.act) {
        const a = this.state.acts.find((y) => y.id === x.act)
        if (!a) return
        if (a.o === 'handed' && r.state === 'accepted') {
          this.emit({ kind: 'hand-over', act: x.act, o: 'taken', digest: d })
          await this.evaluatePending(x.act)
        } else if (a.o === 'taken' && r.state === 'failed') this.emit({ kind: 'hand-over', act: x.act, o: 'given-up' })
      }
      if (x.kind === 'mapping' && x.pair) {
        const duty = this.state.duties.find((y) => y.pair[0] === x.pair![0] && y.pair[1] === x.pair![1])
        if (!duty) return
        if (duty.state === 'hit' && r.state === 'accepted') this.emit({ kind: 'duty', pair: x.pair, state: 'sent', mappingDigest: d })
        if ((duty.state === 'sent' || duty.state === 'hit') && r.state === 'failed') {
          // 6845.4: dieselben Bytes in einer neuen Übergabe.
          this.zusteller.record(d, x.frame, x.address)
          this.held.push(d)
          this.emit({ kind: 'duty', pair: x.pair, state: 'hit', mappingDigest: d })
        }
      }
    }
  }

  // ── Empfang ──
  private async handle(bytes: Uint8Array, address: string): Promise<void> {
    let env: unknown
    try {
      env = JSON.parse(dec.decode(bytes))
    } catch {
      this.dispositions.push('failed(malformed)')
      return
    }
    const ctx = this.ctxOfRkid.get(address)
    if (ctx) await this.keysFor(ctx)
    const v = await receive(env, this.resolve, this.completed)
    this.dispositions.push(v.disposition)
    if (v.disposition === 'duplicate-known') {
      const ack = this.acks.get(v.digest!)
      if (ack) {
        this.zusteller.record(ack.digest, ack.frame, ack.address)
        this.held.push(ack.digest)
      }
      return
    }
    if (v.disposition !== 'unique') return
    if (this.zusteller.submissions.has(v.digest!)) {
      // Auf der gemeinsamen Adresse der Person liest jedes Gerät auch, was es selbst eingeliefert hat.
      this.dispositions.push('skipped(own-frame)')
      return
    }
    const doc = v.document as unknown as Doc & { proof: unknown }
    if (!(await diVerify(doc, doc.issuer))) {
      this.dispositions.push('failed(proof-invalid)')
      return
    }
    this.log.push({ type: doc.type.split('/').slice(-2)[0] ?? doc.type, from: doc.issuer, at: this.clock.now() })
    if (doc.type === TYPES.ack) {
      const p = doc.payload as { ref?: string }
      if (typeof p.ref !== 'string') return
      // #55: die Quittung gilt nur vom erwarteten Empfänger der konkreten Submission; ohne Submission gilt sie nicht.
      const want = this.expected.get(p.ref)
      if (!want) {
        this.dispositions.push('failed(ack-unbound)')
        return
      }
      if (want !== doc.issuer) {
        this.dispositions.push('failed(ack-from-unexpected-signer)')
        return
      }
      this.completed.add(v.digest!)
      this.zusteller.acknowledged(p.ref)
      await this.onAck(p.ref)
      return
    }
    let effect: boolean
    if (doc.type === TYPES.journal) {
      // Journalrahmen: nur auf der eigenen Adresse und nur vom eigenen Self-Anker (one-seed: auf allen Geräten derselbe).
      if (address !== this.ownRkid) return
      if (doc.issuer !== (await this.keysFor(`self/${this.person}`)).anchor) {
        this.dispositions.push('failed(journal-from-unexpected-signer)')
        return
      }
      const b = (doc.payload as { b?: string }).b
      if (typeof b === 'string') await this.applyRemote(this.cand.receiveOwnFrame(new Uint8Array(Buffer.from(b, 'base64'))))
      effect = true
    } else effect = await this.dispatch(doc, address)
    if (!effect) {
      this.dispositions.push('failed(validation-failed)')
      return
    }
    this.completed.add(v.digest!)
    // Quittung an die Antwortadresse, byte-identisch aufbewahrt (§6.2 Stufe 4); eingeliefert nach dem Commit.
    const k = await this.keysFor(ctx ?? '')
    const ackDoc = await diSign({ anchor: k.anchor, ed: { priv: k.ed.priv } }, { id: crypto.randomUUID(), type: TYPES.ack, issuer: k.anchor, recipient: doc.issuer, replyTo: '', issuedAt: this.clock.now(), payload: { ref: v.digest!, meaning: 'received' } }, this.clock.now())
    const ackEnv = await seal(ackDoc as unknown as Json, doc.replyTo)
    const ackBytes = enc.encode(jcs(ackEnv))
    const ackDigest = await digestBytes(enc.encode(jcs(ackDoc)))
    this.acks.set(v.digest!, { frame: ackBytes, digest: ackDigest, address: doc.replyTo })
    this.zusteller.record(ackDigest, ackBytes, doc.replyTo)
    this.held.push(ackDigest)
  }

  /** Quittung auf ein eigenes Dokument: Karte delivered (8326.10), Mapping united (6845.3) mit Nachlieferung (6987.14 light). */
  private async onAck(ref: string): Promise<void> {
    const x = this.sent.get(ref)
    if (!x) return
    if (x.kind === 'card' && x.act) {
      const a = M.act(this.state, x.act)
      if (a.o === 'taken' || a.o === 'given-up' || a.o === 'handed') {
        this.emit({ kind: 'hand-over', act: x.act, o: 'delivered', digest: ref })
        await this.evaluatePending(x.act)
      }
      return
    }
    if (x.kind === 'mapping' && x.pair) {
      const before = this.state.duties.find((d) => d.pair[0] === x.pair![0] && d.pair[1] === x.pair![1])?.state
      this.emit({ kind: 'duty', pair: x.pair, state: 'united', mappingDigest: ref })
      if (before !== 'united') {
        const r = M.relOfTuple(this.state, x.pair[0])
        if (r && r.stock.length && !r.departed) await this.sendRevision(r.id) // 6987.14: nach bestätigter Vereinigung eine frische Revision
      }
    }
  }

  private tupleOfAddress(address: string): M.Tuple | undefined {
    const ctx = this.ctxOfRkid.get(address)
    if (!ctx) return undefined
    for (const r of this.state.relationships) for (const t of r.tuples) if (t.ownKey === ctx) return t
    return undefined
  }

  /** Fachliche Auswertung je Typ; true = Wirkung (quittieren), false = abgewiesen (keine Quittung). Jeder Zweig bindet das Dokument an den erwarteten Signierer (#55). */
  private async dispatch(doc: Doc, address: string): Promise<boolean> {
    const now = this.clock.now()
    switch (doc.type) {
      case TYPES.revision: {
        // M: 8550/8557/6270, vereinfacht.
        const t = this.tupleOfAddress(address)
        if (!t || doc.issuer !== t.peer) return false
        const r = M.relOfTuple(this.state, t.id)!
        const p = doc.payload as unknown as { revision: number; keys: Array<{ anchor: string; keyAgreement: string; expiresAt: string }> }
        if (r.view && r.view.scope === t.id && p.revision <= r.view.revision) {
          const same = p.revision === r.view.revision
          const sameKeys = same && JSON.stringify(p.keys.map((k) => k.anchor).sort()) === JSON.stringify(r.view.keys.map((k) => k.anchor).sort())
          if (same && sameKeys) return true
          this.emit({ kind: 'finding', text: same ? `revision ${p.revision} von ${doc.issuer.slice(-8)}: gleiche Nummer, andere Schlüssel: Equivokation (6270)` : `revision ${p.revision} von ${doc.issuer.slice(-8)} unter der gehaltenen ${r.view.revision}: abgewiesen (6270)` })
          return false
        }
        if (r.view && r.view.scope !== t.id && t.record < M.tuple(this.state, r.view.scope).record) return false // älterer Kopf
        this.emit({ kind: 'view', rel: r.id, scope: t.id, revision: p.revision, keys: p.keys })
        return true
      }
      case TYPES.ticket: {
        // Seite: 8640.
        const t = this.tupleOfAddress(address)
        if (!t || doc.issuer !== t.peer) return false // 8640.2: Kanal und Signierer
        const r = M.relOfTuple(this.state, t.id)!
        const p = doc.payload as unknown as { act: string; issuedAt: string; expiresAt: string; own: string; voucher: { anchor: string; keyAgreement: string; name: string } }
        if (Date.parse(now) > Date.parse(p.expiresAt) || Date.parse(p.issuedAt) > Date.parse(now) + M.PARAM.actSkewMs) return false // 8640.3 / 8110
        if (this.state.acts.some((a) => a.id === p.act)) return true // 8640.4: Wiederholung
        const own = r.stock.find((k) => k.anchor === p.own)
        if (!own) {
          this.emit({ kind: 'finding', text: `ticket ${p.act.slice(0, 8)}: own ${p.own.slice(-8)} nicht auf dieser Beziehung (8640.5)` })
          return false
        }
        if (own.state === 'consumed') {
          this.emit({ kind: 'finding', text: `ticket ${p.act.slice(0, 8)}: own ${p.own.slice(-8)} schon verbraucht: Konformitätsfehler des Mediators (8640.12)` })
          return false
        }
        if (own.state !== 'active' && own.state !== 'aging') return false // 8640.6
        if (Date.parse(own.expiresAt) < Date.parse(p.expiresAt) + M.PARAM.actSkewMs) return false // 8640.7
        if (r.stock.some((k) => k.anchor === p.voucher.anchor)) return false // 8640.8
        const assigned = this.state.voucherAssigned.find((x) => x.anchor === p.voucher.anchor)
        if (assigned && assigned.act !== p.act) {
          this.emit({ kind: 'finding', text: `ticket ${p.act.slice(0, 8)}: voucher schon einem anderen Akt zugeordnet (8640.9, 8640.12)` })
          return false
        }
        if (M.budgetExhausted(r, now)) {
          this.emit({ kind: 'ticket-refuse-budget', rel: r.id, own: own.anchor }) // 8640.13
          this.emit({ kind: 'finding', text: `ticket ${p.act.slice(0, 8)}: Budget erschöpft (8640.10)` })
          return false
        }
        const a: M.Act = { id: p.act, mediator: r.id, own: own.anchor, voucher: p.voucher, issuedAt: p.issuedAt, expiresAt: p.expiresAt, state: 'offered', pending: null, v: null, k: false, ownCard: null, ownCardKey: null, o: 'none', ownCardDigest: null, opened: null }
        this.emit({ kind: 'ticket-accept', act: a }) // 8640.14; K1a ohne Annahmerecht: Blocked, der Rahmen wird ganz zurückgenommen und nicht quittiert
        const buffered = this.buffer.get(`${own.anchor}|${p.voucher.anchor}`)
        if (buffered) {
          this.buffer.delete(`${own.anchor}|${p.voucher.anchor}`)
          this.emit({ kind: 'card-pending', act: a.id, card: buffered.card, v: buffered.v }) // 8640.15
        }
        await this.refill(r.id)
        return true
      }
      case TYPES.card: {
        // Seite: 8850/8910, vereinfacht.
        const ctx = this.ctxOfRkid.get(address)
        const own = ctx ? await this.keysFor(ctx) : undefined
        if (!own) return false
        const p = doc.payload as unknown as { act: string; expiresAt: string; from: string; fromKeyAgreement: string; to: string; card: M.Card }
        if (p.to !== own.anchor || doc.issuer !== p.from) return false // 8850.2 (b)
        const v = await digestBytes(enc.encode(jcs({ act: p.act, card: p.card })))
        const a = this.state.acts.find((x) => x.own === own.anchor)
        if (!a) {
          // Pufferzweig (8910.1–.3)
          const key = `${own.anchor}|${p.from}`
          const b = this.buffer.get(key)
          if (!b) this.buffer.set(key, { card: p.card, v })
          else if (b.v !== v) return false
          return true
        }
        if (a.id !== p.act || p.from !== a.voucher.anchor || p.expiresAt !== a.expiresAt) return false // 8850.6
        if (Date.parse(now) > Date.parse(a.expiresAt) + M.PARAM.actSkewMs) return false // 8110.5: Annahmeende
        if (a.v && a.v !== v) {
          this.emit({ kind: 'card-refused', act: a.id, v, k: true }) // 8910.8
          return false
        }
        if (a.v === v) return true // 8910.7: Wiederholung
        if (a.state === 'declined' || a.state === 'expired') {
          this.emit({ kind: 'card-refused', act: a.id, v, k: false }) // 8910.6
          return true
        }
        if (a.state === 'consented' && this.submitted(a)) {
          this.emit({ kind: 'card-pending', act: a.id, card: p.card, v })
          await this.connect(a, p.card) // 8910.5
          return true
        }
        this.emit({ kind: 'card-pending', act: a.id, card: p.card, v }) // 8910.4
        return true
      }
      case TYPES.probe: {
        const t = this.tupleOfAddress(address)
        if (!t || doc.issuer !== t.peer) return false
        const p = doc.payload as unknown as { entries: string[] }
        for (const r of this.state.relationships) {
          if (r.departed) continue
          for (const other of r.tuples) {
            if (other.id === t.id) continue
            if (p.entries.includes(this.blind(t, other.own))) {
              const pair = M.pairKey(t.id, other.id)
              const duty = this.state.duties.find((d) => d.pair[0] === pair[0] && d.pair[1] === pair[1])
              if (!duty || duty.state === 'none') await this.sendMapping(t, other) // 6845.1
              return true
            }
          }
        }
        return true // kein Treffer: Wirkung „geprüft“, quittiert
      }
      case TYPES.mapping: {
        const t = this.tupleOfAddress(address)
        if (!t || doc.issuer !== t.peer) return false
        const p = doc.payload as unknown as { entry: string }
        const matches: M.Tuple[] = []
        for (const r of this.state.relationships) if (!r.departed) for (const other of r.tuples) if (other.id !== t.id && this.blind(t, other.peer) === p.entry) matches.push(other)
        if (matches.length !== 1) return false // 6960/6945; Tupel abgegangener Beziehungen zählen nicht (6845.7)
        if (M.relOfTuple(this.state, t.id)?.departed) return false
        const other = matches[0]!
        const ra = M.relOfTuple(this.state, t.id)!
        const rb = M.relOfTuple(this.state, other.id)!
        const edge = M.pairKey(t.id, other.id)
        if (ra.id !== rb.id) {
          this.emit({ kind: 'union', a: ra.id, b: rb.id, edge }) // 6975.2
          const united = M.relOfTuple(this.state, t.id)!
          if (united.stock.length) await this.sendRevision(united.id) // 6987.5: Revision auf dem Kopf nach der Vereinigung
        } else this.emit({ kind: 'edge', edge }) // 6975.3
        const duty = this.state.duties.find((d) => d.pair[0] === edge[0] && d.pair[1] === edge[1])
        if (!duty || duty.state === 'none') await this.sendMapping(t, other) // 6845.1 zweiter Auslöser
        return true
      }
      default:
        return false
    }
  }

  // ── Sicht ──
  projection(): M.Projection {
    return M.project(this.state, this.clock.now())
  }
  relationshipWith(peerAnchors: string[]): M.Relationship | undefined {
    return this.state.relationships.find((r) => !r.departed && r.tuples.some((t) => peerAnchors.includes(t.peer)))
  }
}
