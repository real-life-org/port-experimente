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
export class World {
  readonly docs = new Map<Device, Y.Doc>()
  readonly log: Array<Msg & { partition: number }> = []
  private readonly delivered = new Map<Device, Set<number>>()
  private partitionOf = new Map<Device, number>()
  private nextId = 1

  constructor(readonly candidate: Candidate) {}

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

  /** Schreibt einen Eintrag ins Y.Doc des Geräts; der Kandidat versiegelt das Update. */
  async write(device: Device, text: string): Promise<void> {
    const doc = this.doc(device)
    doc.transact(() => doc.getArray<string>('eintraege').push([text]), LOCAL)
    const sealing = this.pendingSeal.splice(0)
    for (const s of sealing) await this.candidate.sealContent(s.device, s.update)
  }

  read(device: Device): string[] {
    return this.doc(device).getArray<string>('eintraege').toArray().slice().sort()
  }

  members(device: Device): string[] {
    return this.candidate.members(device)
  }

  /** Teilt die Welt; nicht genannte Geräte landen in der letzten Gruppe. */
  partition(...groups: Device[][]): void {
    const all = [...this.docs.keys()]
    groups.forEach((g, i) => g.forEach((d) => this.partitionOf.set(d, i + 1)))
    const rest = groups.length + 1
    for (const d of all) if (!groups.some((g) => g.includes(d))) this.partitionOf.set(d, rest)
  }

  heal(): void {
    for (const d of this.docs.keys()) this.partitionOf.set(d, 0)
  }

  /** Stellt so lange zu, bis niemand mehr etwas zu senden oder zu empfangen hat. */
  async flush(maxRounds = 50): Promise<void> {
    for (let round = 0; round < maxRounds; round++) {
      let moved = false
      for (const d of this.docs.keys()) {
        for (const out of this.candidate.takeOutgoing(d)) {
          this.log.push({ id: this.nextId++, from: d, label: out.label, body: out.body, partition: this.partitionOf.get(d)! })
          moved = true
        }
      }
      for (const msg of this.log) {
        for (const d of this.docs.keys()) {
          if (d === msg.from) continue
          const seen = this.delivered.get(d)!
          if (seen.has(msg.id)) continue
          const p = this.partitionOf.get(d)!
          if (p !== 0 && p !== msg.partition) continue
          if (p === 0 && msg.partition !== 0 && this.partitionOf.get(msg.from) !== 0) continue
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

  /** Alle Nachrichten ab einer Log-Position (für den Angreifer in S7). */
  messagesSince(position: number): Msg[] {
    return this.log.slice(position)
  }

  private doc(device: Device): Y.Doc {
    const doc = this.docs.get(device)
    if (!doc) throw new Error(`unbekanntes Gerät ${device}`)
    return doc
  }
}
