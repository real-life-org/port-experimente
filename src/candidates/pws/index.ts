import * as Y from 'yjs'
import { openTempBackend, startTestServer } from 'was-teaching-server/testing'
import { WasClient } from '@interop/was-client'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import type { Candidate, Capability, Device, Msg, Person } from '../../lab/types'
import { rltpBeekem } from '../rltp-beekem'

// E12 Variante (a): Portable Web Spaces (ex Wallet Attached Storage) als
// BLINDER Speicher einer Gruppe. Der BeeKEM-Kandidat bleibt unverändert; nur
// der Transport wechselt: statt des Prüfstand-Relays schreibt jedes Gerät
// seine Rahmen als Resources in EINE Collection eines Spaces auf einem echten
// WAS-Server (was-teaching-server, im Prozess) und liest die der anderen über
// den changes-Feed, je Gerät mit eigenem Checkpoint. Der Server sieht die
// Rahmen im Klartext (nur Base64): Karten mit Personennamen, Autoritäts-
// operationen mit Subjekt, Signierern, Politik und Schlüsseln, BeeKEM-
// Operationen. Verschlüsselt ist nur der Inhalt (`content`). Die Spec
// versiegelt alle Einträge; der Prüfstand-Kandidat tut es nicht (#24).
//
// Controller des Spaces ist EIN Gruppenschlüssel (did:key), den alle Geräte
// halten und mit dem sie signieren: die Gruppe als ein Controller, wie WAS
// ihn kennt. Wer den Schlüssel hat, kann lesen und schreiben; Mitgliedschaft
// kennt der Server nicht (Variante a). Nur Node ≥ 24 (Vorgabe der Pakete).
// Port-Notizen: NOTES.md.

const enc = new TextEncoder()
const dec = new TextDecoder()
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))

interface Frame {
  [k: string]: string
  from: Device
  label: string
  b: string
}

interface DeviceState {
  person: Person
  online: boolean
  doc: Y.Doc
  /** Rahmen, die noch nicht beim Server sind (offline oder noch nicht gepusht). */
  outbox: Array<{ label: string; body: Uint8Array }>
  /** Laufende Nummer je Gerät, für eindeutige Resource-IDs. */
  seq: number
  checkpoint: string | undefined
  /** Resource-IDs, die dieses Gerät schon verarbeitet hat. */
  seen: Set<string>
  was?: WasClient
}

const LOCAL = Symbol('local')

export interface PwsOptions {
  /** Zweiter Server, auf den die Gruppe per Export/Import umzieht (Prüfpunkt 4). */
  readonly label?: string
}

export async function rltpBeekemPws(options: PwsOptions = {}): Promise<Candidate & { pws: PwsHandle }> {
  const inner = rltpBeekem()
  // Eigener Temp-Speicher je Server: der Default-Backend läge im Paket und wäre allen Servern gemeinsam.
  const { fastify, serverUrl } = await startTestServer({ backend: await openTempBackend() })
  // Der Gruppenschlüssel: ein did:key, von allen Geräten gehalten.
  const groupKey = await Ed25519VerificationKey.generate()
  groupKey.controller = `did:key:${groupKey.fingerprint()}`
  groupKey.id = `${groupKey.controller}#${groupKey.fingerprint()}`
  const devices = new Map<Device, DeviceState>()
  let space: { id: string } | undefined
  let active = { serverUrl, fastify }
  let idle = 0
  const stats = { puts: 0, pulls: 0, pulledDocs: 0, bytesUp: 0 }
  const notes: string[] = []

  const dev = (d: Device) => {
    const s = devices.get(d)
    if (!s) throw new Error(`unbekanntes Gerät ${d}`)
    return s
  }
  const client = (s: DeviceState) => (s.was ??= WasClient.fromSigner({ serverUrl: active.serverUrl, signer: groupKey.signer() }))
  const collection = (s: DeviceState) => client(s).space(space!.id).collection('frames')

  async function timed<T>(f: () => Promise<T>): Promise<T> {
    const t = performance.now()
    try {
      return await f()
    } finally {
      idle += performance.now() - t
    }
  }

  async function ensureSpace(s: DeviceState) {
    if (space) return
    const sp = await timed(() => client(s).createSpace({ name: 'gruppe' }))
    space = { id: sp.id }
    await timed(() => sp.createCollection({ name: 'frames', id: 'frames' }))
  }

  /** Alle ausstehenden Rahmen eines Geräts zum Server. */
  async function push(s: DeviceState, d: Device): Promise<number> {
    s.outbox.push(...inner.takeOutgoing(d))
    if (!s.online || !space) return 0
    const col = collection(s)
    let n = 0
    while (s.outbox.length) {
      const { label, body } = s.outbox[0]!
      const id = `${d}-${String(s.seq).padStart(6, '0')}`
      const frame: Frame = { from: d, label, b: b64(body) }
      await timed(() => col.put(id, frame))
      stats.puts++
      stats.bytesUp += body.length
      s.seq++
      s.outbox.shift()
      s.seen.add(id)
      n++
    }
    return n
  }

  /** Den Feed ab dem eigenen Checkpoint lesen und fremde Rahmen dem Kandidaten zustellen. */
  async function pull(s: DeviceState, d: Device): Promise<number> {
    if (!s.online || !space) return 0
    const col = collection(s)
    let n = 0
    for (;;) {
      const page = await timed(() => col.changes({ checkpoint: s.checkpoint, limit: 200 }))
      stats.pulls++
      for (const doc of page.documents as Array<{ id: string; kind?: string; deleted?: boolean; data?: Frame }>) {
        if (doc.kind !== 'resource' || doc.deleted || !doc.data || s.seen.has(doc.id)) continue
        s.seen.add(doc.id)
        const f = doc.data
        if (f.from === d) continue
        stats.pulledDocs++
        const msg: Msg = { id: stats.pulledDocs, from: f.from, label: f.label, body: unb64(f.b) }
        const { content } = await inner.receive(d, msg)
        for (const u of content) Y.applyUpdate(s.doc, u, 'remote')
        n++
      }
      if (!page.checkpoint || page.documents.length === 0) break
      s.checkpoint = page.checkpoint
    }
    return n
  }

  async function settle() {
    for (let round = 0; round < 60; round++) {
      let moved = 0
      for (const [d, s] of devices) moved += await push(s, d)
      for (const [d, s] of devices) moved += await pull(s, d)
      // Zustellungen lösen neue Rahmen aus (Reparatur, Sichten): noch eine Runde.
      for (const [d, s] of devices) moved += await push(s, d)
      if (moved === 0) return
    }
    throw new Error('PWS: nach 60 Runden nicht ruhig')
  }

  const pws: PwsHandle = {
    serverUrl: () => active.serverUrl,
    controller: groupKey.controller!,
    stats,
    /** Was der Server über die Gruppe hält: Resource-IDs und Größen, aus Sicht eines Clients mit dem Gruppenschlüssel. */
    async inventory() {
      const s = devices.values().next().value as DeviceState
      const listing = await collection(s).list()
      return { controller: groupKey.controller!, spaceId: space?.id, resources: listing?.items.map((i: { id: string }) => i.id) ?? [] }
    },
    /** Prüfpunkt 4: Umzug auf einen neuen Server per Export/Import; danach lesen alle von dort. */
    async moveToNewServer() {
      const s = devices.values().next().value as DeviceState
      const archive = await client(s).space(space!.id).exportBlob()
      const next = await startTestServer({ backend: await openTempBackend() })
      let imported: { resourcesCreated: number; resourcesSkipped: number }
      try {
        const was = WasClient.fromSigner({ serverUrl: next.serverUrl, signer: groupKey.signer() })
        const sp = await was.createSpace({ name: 'gruppe', id: space!.id })
        imported = (await sp.import(archive)) as typeof imported
      } catch (e) {
        // Misslingt der Umzug, bleibt der alte Server aktiv und der neue wird geschlossen (#25).
        await next.fastify.close().catch(() => {})
        throw e
      }
      const old = active
      active = { serverUrl: next.serverUrl, fastify: next.fastify }
      for (const st of devices.values()) {
        st.was = undefined
        st.checkpoint = undefined // der Checkpoint ist Fakt des alten Servers; der Feed wird neu gelesen, `seen` filtert
      }
      await old.fastify.close()
      return imported
    },
    /** Prüfpunkt 3: was ein Server aus den Rahmen liest, ohne Schlüssel. Je Label die Felder, die im Klartext stehen. */
    async visible() {
      const s = devices.values().next().value as DeviceState
      const col = collection(s)
      const out: Record<string, Set<string>> = {}
      const persons = new Set<string>()
      for await (const item of col.listItems()) {
        const f = (await col.get(item.id)) as Frame | null
        if (!f) continue
        const wire = JSON.parse(dec.decode(unb64(f.b))) as Record<string, unknown>
        const keys = (out[f.label] ??= new Set())
        for (const k of Object.keys(wire)) keys.add(k)
        if (typeof wire.person === 'string') persons.add(wire.person)
        const op = wire.op as { subject?: string; sigs?: Array<{ signer: string }> } | undefined
        if (op?.subject) persons.add(op.subject)
        for (const sg of op?.sigs ?? []) persons.add(sg.signer)
      }
      return { fields: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()])), persons: [...persons].sort() }
    },
  }

  return {
    id: options.label ?? 'rltp-beekem-pws',
    capabilities: new Set<Capability>([...inner.capabilities].filter((c) => c !== 'service' && c !== 'steal') as Capability[]),
    pws,
    transport: {
      async setOnline(d, online) {
        dev(d).online = online
      },
      settle,
      async write(d, text) {
        const s = dev(d)
        const updates: Uint8Array[] = []
        const onUpdate = (u: Uint8Array, origin: unknown) => {
          if (origin === LOCAL) updates.push(u)
        }
        s.doc.on('update', onUpdate)
        s.doc.transact(() => s.doc.getArray<string>('eintraege').push([text]), LOCAL)
        s.doc.off('update', onUpdate)
        for (const u of updates) await inner.sealContent(d, u)
        await push(s, d)
      },
      read: (d) => dev(d).doc.getArray<string>('eintraege').toArray().slice().sort(),
      idleMs: () => idle,
    },
    async dispose() {
      await active.fastify.close()
    },

    async addDevice(p, d) {
      await inner.addDevice(p, d)
      const s: DeviceState = { person: p, online: true, doc: new Y.Doc(), outbox: [], seq: 0, checkpoint: undefined, seen: new Set(), was: undefined }
      devices.set(d, s)
      await ensureSpace(s)
      await push(s, d)
    },
    async createGroup(d) {
      await inner.createGroup(d)
      await push(dev(d), d)
    },
    async addMember(by, p, role) {
      await inner.addMember(by, p, role)
      await push(dev(by), by)
    },
    async removeMember(by, p) {
      await inner.removeMember(by, p)
      await push(dev(by), by)
    },
    async rotate(by) {
      await inner.rotate(by)
      await push(dev(by), by)
    },
    async changePolicy(by, tag) {
      await inner.changePolicy(by, tag)
      await push(dev(by), by)
    },
    async removeDevice(by, device) {
      await inner.removeDevice!(by, device)
      await push(dev(by), by)
    },
    sealContent: (d, u) => inner.sealContent(d, u),
    takeOutgoing: () => [],
    receive: (d, m) => inner.receive(d, m),
    members: (d) => inner.members(d),
    status: (d) => `${inner.status(d)}; pws puts=${stats.puts} pulls=${stats.pulls}${notes.length ? '; ' + notes.slice(0, 2).join('; ') : ''}`,
    steal: (d) => inner.steal(d),
    attackerOpen: (st, m) => inner.attackerOpen(st, m),
  }
}

export interface PwsHandle {
  serverUrl(): string
  readonly controller: string
  readonly stats: { puts: number; pulls: number; pulledDocs: number; bytesUp: number }
  inventory(): Promise<{ controller: string; spaceId: string | undefined; resources: string[] }>
  moveToNewServer(): Promise<{ resourcesCreated: number; resourcesSkipped: number }>
  visible(): Promise<{ fields: Record<string, string[]>; persons: string[] }>
}
