import * as Y from 'yjs'
import type { Candidate, Device, Msg, Person, Role } from './types'

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
          this.log.push(msg)
          if (this.candidate.service && this.relaySide(msg.partition)) this.judge(msg)
          moved = true
        }
      }
      for (let i = 0; i < this.log.length; i++) {
        const msg = this.log[i]!
        for (const d of this.docs.keys()) {
          if (d === msg.from) continue
          const seen = this.delivered.get(d)!
          if (seen.has(msg.id)) continue
          if (!this.deliverable(msg, d)) continue
          seen.add(msg.id)
          moved = true
          const { content } = await this.candidate.receive(d, msg)
          const doc = this.doc(d)
          for (const u of content) Y.applyUpdate(doc, u, 'remote')
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
