import * as Y from 'yjs'
import type { Candidate, CarrierFaults, Device, Msg, Person, Role } from './types'

const LOCAL = Symbol('local')

/**
 * Die simulierte Welt: Geräte mit je einem Y.Doc, ein Store-and-Forward-
 * Netz mit Partitionen, und der Kandidat dazwischen.
 *
 * Netzmodell: Jede Nachricht geht an jedes andere Gerät, auch an entfernte
 * Mitglieder (ein entfernter Mitleser am Relay ist der Normalfall, nicht die
 * Ausnahme). Solange eine Partition gilt, sehen nur Geräte derselben
 * Partition die Nachricht; nach `heal()` wird alles nachgereicht.
 */
/** Absender der Dienst-Rahmen. Kein Gerät. */
export const DIENST = 'dienst'

export class World {
  readonly docs = new Map<Device, Y.Doc>()
  readonly log: Array<Msg & { partition: number }> = []
  /** Urteil des Dienstes je Rahmen, sobald er das Relay erreicht hat. */
  readonly verdicts = new Map<number, 'weiter' | 'verwerfen' | 'behalten'>()
  private readonly delivered = new Map<Device, Set<number>>()
  private partitionOf = new Map<Device, number>()
  private nextId = 1

  constructor(readonly candidate: Candidate) {}

  // ── Fehlerinjektion am Prüfstand-Relay (E10) ──────────────────────────
  private dropRules: Array<(m: Msg) => boolean> = []
  private withholdRules: Array<{ device: Device; match: (m: Msg) => boolean }> = []
  private reverseOrder = false
  private duplicateAll = false
  private tamperRules: Array<{ match: (m: Msg) => boolean; mutate: (b: Uint8Array) => Uint8Array }> = []
  /** Rahmen, die eine Regel verschluckt hat (zur Auswertung). */
  readonly swallowed: Msg[] = []
  /** Urteil je Rahmen, einmal gefällt: eine Verlust- oder Veränderungsregel trifft alle Empfänger gleich (wie bei einem echten Träger). */
  private readonly dropDecided = new Map<number, boolean>()
  private readonly tampered = new Map<number, Uint8Array>()

  /** Der Träger dieses Laufs: das Prüfstand-Relay, oder der eigene Transport des Kandidaten, sofern er Fehler bietet. */
  carrier(): CarrierFaults | undefined {
    if (this.own) return this.own.faults
    const w = this
    return {
      drop: (match) => void w.dropRules.push(match),
      withhold: (device, match) => void w.withholdRules.push({ device, match }),
      reverse: (on) => void (w.reverseOrder = on),
      duplicate: (on) => void (w.duplicateAll = on),
      tamper: (match, mutate) => void w.tamperRules.push({ match, mutate }),
      async replay(match) {
        let n = 0
        for (const m of w.log) {
          if (!match(m)) continue
          n++
          for (const seen of w.delivered.values()) seen.delete(m.id)
        }
        return n
      },
      carried: () => w.log.slice(),
      reset() {
        w.dropRules = []
        w.withholdRules = []
        w.reverseOrder = false
        w.duplicateAll = false
        w.tamperRules = []
      },
    }
  }

  /** Geräte, die im Modus „eigener Transport“ gerade offline geschaltet sind. */
  private offline = new Set<Device>()

  private get own() {
    return this.candidate.transport
  }

  async device(person: Person, device: Device): Promise<void> {
    const doc = new Y.Doc()
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === LOCAL) this.pendingSeal.push({ device, update })
    })
    this.docs.set(device, doc)
    this.delivered.set(device, new Set())
    this.partitionOf.set(device, 0)
    await this.candidate.addDevice(person, device)
  }

  private pendingSeal: Array<{ device: Device; update: Uint8Array }> = []
  /** Begegnungskanal: Rahmen, die nicht über den Träger gehen (Karten). Zugestellt, sobald Absender und Empfänger dieselbe Partition teilen. */
  private readonly direct: Array<{ msg: Msg; delivered: Set<Device> }> = []

  private async deliverDirect(): Promise<boolean> {
    let moved = false
    for (const e of this.direct) {
      for (const d of this.docs.keys()) {
        if (d === e.msg.from || e.delivered.has(d)) continue
        if (this.partitionOf.get(d) !== this.partitionOf.get(e.msg.from)) continue
        e.delivered.add(d)
        moved = true
        const { content } = await this.candidate.receive(d, e.msg)
        const doc = this.doc(d)
        for (const u of content) Y.applyUpdate(doc, u, 'remote')
      }
    }
    return moved
  }

  async createGroup(device: Device) {
    await this.candidate.createGroup(device)
  }
  async add(by: Device, person: Person, role: Role = 'member') {
    await this.candidate.addMember(by, person, role)
  }
  async remove(by: Device, person: Person) {
    await this.candidate.removeMember(by, person)
  }
  async removeDevice(by: Device, device: Device) {
    if (!this.candidate.removeDevice) throw new Error('Kandidat kennt kein Entfernen einzelner Geräte')
    await this.candidate.removeDevice(by, device)
  }

  /** Schreibt einen Eintrag ins Y.Doc des Geräts; der Kandidat versiegelt das Update. */
  async write(device: Device, text: string): Promise<void> {
    if (this.own) return this.own.write(device, text)
    const doc = this.doc(device)
    doc.transact(() => doc.getArray<string>('eintraege').push([text]), LOCAL)
    const sealing = this.pendingSeal.splice(0)
    for (const s of sealing) await this.candidate.sealContent(s.device, s.update)
  }

  read(device: Device): string[] {
    if (this.own) return this.own.read(device).slice().sort()
    return this.doc(device).getArray<string>('eintraege').toArray().slice().sort()
  }

  members(device: Device): string[] {
    return this.candidate.members(device)
  }

  /**
   * Teilt die Welt; nicht genannte Geräte landen in einer eigenen Gruppe.
   * Konvention: Die erste Gruppe ist die Seite mit dem Relay. Bei Kandidaten
   * mit eigenem Transport bleibt nur sie online, alle anderen gehen offline.
   * Szenarien nennen deshalb die Seite, die online bleiben soll, zuerst.
   */
  async partition(...groups: Device[][]): Promise<void> {
    if (this.own) {
      // Nur die erste Gruppe erreicht das Relay; alle anderen sind offline.
      for (const d of this.docs.keys()) {
        if (groups[0]?.includes(d)) continue
        this.offline.add(d)
        await this.own.setOnline(d, false)
      }
      return
    }
    const all = [...this.docs.keys()]
    groups.forEach((g, i) => g.forEach((d) => this.partitionOf.set(d, i + 1)))
    const rest = groups.length + 1
    for (const d of all) if (!groups.some((g) => g.includes(d))) this.partitionOf.set(d, rest)
  }

  async heal(): Promise<void> {
    if (this.own) {
      for (const d of this.offline) await this.own.setOnline(d, true)
      this.offline.clear()
      return
    }
    for (const d of this.docs.keys()) this.partitionOf.set(d, 0)
  }

  /** Partition 0 (ganz) und die erste Gruppe erreichen das Relay. */
  private relaySide(partition: number) {
    return partition <= 1
  }

  /**
   * Mit Dienst: Ein Rahmen, der das Relay erreicht, bekommt dort genau ein
   * Urteil (Reihenfolge = Ankunft am Relay). Rahmen des Dienstes landen im
   * Log wie die der Geräte, Absender `dienst`.
   */
  private judge(msg: Msg & { partition: number }) {
    const service = this.candidate.service
    if (!service || this.verdicts.has(msg.id)) return
    this.verdicts.set(msg.id, msg.from === DIENST ? 'weiter' : service.accept(msg))
    for (const out of service.takeOutgoing()) {
      this.log.push({ id: this.nextId++, from: DIENST, label: out.label, body: out.body, partition: 0 })
    }
  }

  /**
   * Darf `d` den Rahmen jetzt bekommen? Ohne Dienst: Store-and-Forward mit
   * Partitionen. Mit Dienst: innerhalb einer Partition ohne Relay direkt
   * (Mesh); alles andere über das Relay, also nur mit Urteil „weiter“ und
   * nur, wenn der Dienst das Gerät noch bedient.
   */
  private deliverable(msg: Msg & { partition: number }, d: Device): boolean {
    const p = this.partitionOf.get(d)!
    const senderNow = msg.from === DIENST ? 0 : this.partitionOf.get(msg.from)!
    const sameMesh = p !== 0 && p === msg.partition
    if (!this.candidate.service) {
      if (sameMesh) return true
      if (p !== 0) return false
      return msg.partition === 0 || senderNow === 0
    }
    if (sameMesh && !this.relaySide(p)) return true
    // Über das Relay: Empfänger und Absender müssen es erreichen.
    if (!this.relaySide(p) || !this.relaySide(senderNow)) return false
    this.judge(msg)
    return this.verdicts.get(msg.id) === 'weiter' && this.candidate.service.serves(d)
  }

  /** Stellt so lange zu, bis niemand mehr etwas zu senden oder zu empfangen hat. */
  async flush(maxRounds = 50): Promise<void> {
    if (this.own) return this.own.settle()
    for (let round = 0; round < maxRounds; round++) {
      let moved = false
      for (const d of this.docs.keys()) {
        for (const out of this.candidate.takeOutgoing(d)) {
          const msg = { id: this.nextId++, from: d, label: out.label, body: out.body, partition: this.partitionOf.get(d)! }
          if (out.direct) {
            this.direct.push({ msg, delivered: new Set() })
            moved = true
            continue
          }
          this.log.push(msg)
          if (this.candidate.service && this.relaySide(msg.partition)) this.judge(msg)
          moved = true
        }
      }
      if (await this.deliverDirect()) moved = true
      const order = this.reverseOrder ? [...this.log].reverse() : this.log
      for (const msg of order) {
        for (const d of this.docs.keys()) {
          if (d === msg.from) continue
          const seen = this.delivered.get(d)!
          if (seen.has(msg.id)) continue
          if (!this.deliverable(msg, d)) continue
          // Zurückhalten je Gerät: der Rahmen bleibt ungesehen und zählt nicht als Fortschritt;
          // fällt die Regel, wird er zugestellt.
          if (this.withholdRules.some((r) => r.device === d && r.match(msg))) continue
          seen.add(msg.id)
          moved = true
          let dropped = this.dropDecided.get(msg.id)
          if (dropped === undefined) this.dropDecided.set(msg.id, (dropped = this.dropRules.some((r) => r(msg))))
          if (dropped) {
            if (!this.swallowed.includes(msg)) this.swallowed.push(msg)
            continue
          }
          let body = this.tampered.get(msg.id)
          if (!body) {
            body = msg.body
            for (const r of this.tamperRules) if (r.match(msg)) body = r.mutate(body)
            this.tampered.set(msg.id, body)
          }
          const toDeliver = body === msg.body ? msg : { ...msg, body }
          const times = this.duplicateAll ? 2 : 1
          for (let k = 0; k < times; k++) {
            const { content } = await this.candidate.receive(d, toDeliver)
            const doc = this.doc(d)
            for (const u of content) Y.applyUpdate(doc, u, 'remote')
          }
        }
      }
      if (!moved) return
    }
    throw new Error(`flush: nach ${maxRounds} Runden nicht ruhig`)
  }

  private doc(device: Device): Y.Doc {
    const doc = this.docs.get(device)
    if (!doc) throw new Error(`unbekanntes Gerät ${device}`)
    return doc
  }
}
