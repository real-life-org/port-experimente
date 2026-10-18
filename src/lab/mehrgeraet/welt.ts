// E15 Mehrgerät: die Welt. Personen mit mehreren Geräten auf dem E11-Träger,
// virtuelle Uhr, Store je Gerät, Begegnungen als Begegnungskanal.

import { Carrier, MemoryStore, VirtualClock } from '../zustellung'
import { frameHash, HolderDevice, type DeviceState, type MultiDeviceCandidate } from './holder'
import * as M from './model'
import { rand } from '@real-life/trust-protocol'

export interface Welt15Options {
  clock?: VirtualClock
  /** Store je Gerät (Commit-Grenzen, Absturz, Backup). Default an. */
  stores?: boolean
}

export class Welt15 {
  carrier = new Carrier()
  readonly clock: VirtualClock
  readonly devices: HolderDevice[] = []
  readonly stores = new Map<string, MemoryStore<DeviceState>>()
  private readonly seeds = new Map<string, Uint8Array>()
  private readonly withStores: boolean
  constructor(
    readonly candidate: MultiDeviceCandidate,
    opts: Welt15Options = {},
  ) {
    this.clock = opts.clock ?? new VirtualClock('2026-10-17T08:00:00.000Z')
    this.withStores = opts.stores ?? true
  }

  private store(name: string) {
    if (!this.withStores) return undefined
    const s = new MemoryStore<DeviceState>()
    this.stores.set(name, s)
    return s
  }

  /** Erstes Gerät einer Person. */
  async person(person: string, device: string): Promise<HolderDevice> {
    const seed = rand(32)
    this.seeds.set(person, seed)
    const cand = await this.candidate.first(person, device, seed)
    const d = new HolderDevice(device, person, cand, this.carrier, this.clock, this.store(device))
    await d.relisten()
    d.commit()
    this.devices.push(d)
    return d
  }

  /** Weiteres Gerät: Enrollment aus einem bestehenden (X8). */
  async enrol(from: HolderDevice, device: string): Promise<HolderDevice> {
    const { cand, state, intents, probes } = await this.candidate.enrol(from, device)
    const d = new HolderDevice(device, from.person, cand, this.carrier, this.clock, this.store(device), state)
    for (const i of intents ?? []) d.intents.set(i.digest, i)
    if (probes) d.adoptProbes(probes) // behaltene Proben aus dem Abbild (Tor-Review 16 S2)
    try {
      await d.relisten()
      d.requestSync() // was seit der Kopie geschah, holt das neue Gerät nach
      d.commit()
    } catch (e) {
      this.candidate.release?.(from.person, device) // der Platz bleibt nicht belegt, wenn das Gerät nie entstand
      throw e
    }
    this.devices.push(d)
    return d
  }

  /** Widerruf eines Geräts (X9) von einem anderen Gerät der Person aus: am Träger abgemeldet; was B und M davon erfahren, entscheidet der Kandidat (`revoke`). */
  async revoke(by: HolderDevice, device: HolderDevice): Promise<void> {
    this.carrier.unregister(device.name)
    device.online = false
    const i = this.devices.indexOf(device)
    if (i >= 0) this.devices.splice(i, 1)
    await this.candidate.revoke?.(by, device.name)
  }

  device(name: string): HolderDevice {
    const d = this.devices.find((x) => x.name === name)
    if (!d) throw new Error(`unbekanntes Gerät ${name}`)
    return d
  }
  of(person: string): HolderDevice[] {
    return this.devices.filter((d) => d.person === person)
  }

  /** Begegnung zweier Geräte: Karten tauschen, beide öffnen ein Tupel. Liefert beide Tupel. */
  async encounter(x: HolderDevice, y: HolderDevice, id = crypto.randomUUID().slice(0, 8)): Promise<{ x: M.Tuple; y: M.Tuple }> {
    const kx = await x.encounterKeys(id)
    const ky = await y.encounterKeys(id)
    const tx = await x.openEncounter(id, { anchor: ky.anchor, rkid: ky.rkid })
    const ty = await y.openEncounter(id, { anchor: kx.anchor, rkid: kx.rkid })
    return { x: tx, y: ty }
  }

  /** `after` läuft nach jedem Geräteübergang (Abtastung je Übergang, nicht je Weltrunde; Review 4 S2). */
  async rounds(n: number, after?: (d: HolderDevice) => void): Promise<void> {
    for (let i = 0; i < n; i++) {
      for (const d of this.devices) {
        await d.round()
        after?.(d)
      }
    }
  }
  /**
   * Was ein Dieb hat (X9, Review 4 S1): das Store-Abbild des Geräts und, was der Kandidat je Gerät daraus wiederherstellt,
   * als unabhängige Instanz (eigene Schlüssel-Closures, eigener Kandidatenzustand); kein lebender Verweis auf das Opfer.
   */
  async steal(victim: HolderDevice, name: string): Promise<HolderDevice> {
    const image = this.stores.get(victim.name)!.snapshot()
    const store = new MemoryStore<DeviceState>()
    store.restore(image)
    const seed = this.seeds.get(victim.person)!
    const cand = await (this.candidate.instance ?? this.candidate.first).call(this.candidate, victim.person, name, seed)
    const d = new HolderDevice(name, victim.person, cand, this.carrier, this.clock, store)
    await d.reload()
    return d
  }
  async until(pred: () => boolean, max = 30): Promise<number> {
    for (let i = 1; i <= max; i++) {
      await this.rounds(1)
      if (pred()) return i
    }
    return -1
  }

  // ── Messungen ──

  /** Person hinter einem Anker (Weltwissen): aus den Zuständen aller Geräte. */
  personOf(anchor: string): string | undefined {
    for (const d of this.devices) {
      for (const r of d.state.relationships) {
        if (r.tuples.some((t) => t.own === anchor)) return d.person
        if (r.stock.some((k) => k.anchor === anchor)) return d.person
      }
      for (const a of d.state.acts) if (a.ownCard?.anchor === anchor) return d.person
    }
    return undefined
  }

  /** Doppel in der Kontaktliste einer Person über alle ihre Geräte: eine Gegenperson in mehr als einem Beziehungseintrag (I-6). */
  duplicates(person: string): number {
    const entries = new Map<string, Set<string>>() // Gegenperson → Menge der Beziehungs-Einträge (Gerät:Tupelmenge)
    for (const d of this.of(person)) {
      for (const r of d.state.relationships) {
        if (r.departed) continue
        const key = r.tuples
          .map((t) => t.id)
          .sort()
          .join('+')
        for (const peer of new Set(r.tuples.map((t) => this.personOf(t.peer) ?? t.peer))) {
          if (!entries.has(peer)) entries.set(peer, new Set())
          entries.get(peer)!.add(key)
        }
      }
    }
    return [...entries.values()].filter((s) => s.size > 1).length
  }

  /** Gleiche fachliche Projektion aller Geräte einer Person? */
  agree(person: string): { agree: boolean; diff: string } {
    const ps = this.of(person).map((d) => ({ name: d.name, p: M.canonical(d.projection()) }))
    const first = ps[0]
    if (!first) return { agree: true, diff: '' }
    const other = ps.find((x) => x.p !== first.p)
    return other ? { agree: false, diff: `${first.name} ≠ ${other.name}` } : { agree: true, diff: '' }
  }

  /**
   * Tatsächliche Einlieferungen am Träger ab `from` (Index in `carrier.carried`), einschließlich jeder Wiederholung
   * (Plan Abschnitt 5, Tor-Review 9 zu X21): Rahmen und Bytes der Geräte einer Person, getrennt „zwischen eigenen
   * Geräten“ (Self-Adresse) und „zu Gegenseite/M“, je Art (`own:<art>` / `peer:<art>`) und je erzeugendem Gerät; `repeats` sind Einlieferungen
   * derselben Bytes, die schon einmal eingeliefert waren (auch vor `from`), getrennt nach Zielseite in `repeatsOwn` und
   * `repeatsToPeer` (Review 11 S1). Zugeordnet wird über `produced` der Geräte.
   */
  deposits(person: string, selfRkid: string, from = 0) {
    const origin = new Map<string, { device: string; kind: string }>()
    for (const d of this.devices) if (d.person === person) for (const [h, kind] of d.produced) origin.set(h, { device: d.name, kind })
    const seen = new Set<string>()
    const out = { own: { frames: 0, bytes: 0 }, toPeer: { frames: 0, bytes: 0 }, repeats: 0, repeatsOwn: 0, repeatsToPeer: 0, byKind: {} as Record<string, { frames: number; bytes: number }>, byDevice: {} as Record<string, Record<string, number>> }
    this.carrier.carried.forEach((f, i) => {
      const h = frameHash(f.bytes)
      const o = origin.get(h)
      const repeat = seen.has(h)
      seen.add(h)
      if (i < from || !o) return
      const isOwn = f.address === selfRkid
      const side = isOwn ? out.own : out.toPeer
      side.frames++
      side.bytes += f.bytes.length
      if (repeat) {
        out.repeats++
        if (isOwn) out.repeatsOwn++
        else out.repeatsToPeer++
      }
      const k = (out.byKind[`${f.address === selfRkid ? 'own' : 'peer'}:${o.kind}`] ??= { frames: 0, bytes: 0 })
      k.frames++
      k.bytes += f.bytes.length
      const dv = (out.byDevice[o.device] ??= {})
      dv[o.kind] = (dv[o.kind] ?? 0) + 1
    })
    return out
  }
  /** Art eines Rahmens am Träger (Messung, für Störregeln je Art): erzeugendes Gerät und Art, sonst undefined. */
  frameOrigin(bytes: Uint8Array): { device: string; kind: string } | undefined {
    const h = frameHash(bytes)
    for (const d of this.devices) {
      const kind = d.produced.get(h)
      if (kind) return { device: d.name, kind }
    }
    return undefined
  }

  /** Verkehr über alle Geräte einer Person. */
  traffic(person: string) {
    const m = { framesOut: 0, bytesOut: 0, ownFramesOut: 0, ownBytesOut: 0 }
    for (const d of this.of(person)) for (const k of Object.keys(m) as Array<keyof typeof m>) m[k] += d.measures[k]
    return m
  }
}
