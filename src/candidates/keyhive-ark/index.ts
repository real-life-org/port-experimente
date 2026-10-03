import { Repo, WebSocketEndpoint, initSubduction, type AutomergeUrl, type Chunk, type DocHandle, type ManagedTransport, type PeerId, type StorageAdapterInterface, type StorageKey, type WebSocketEndpointInterface } from '@automerge/automerge-repo'
import {
  Access,
  ContactCard,
  GroupId,
  Identifier,
  Keyhive,
  MemberedId,
  docIdFromAutomergeUrl,
  initializeAutomergeRepoKeyhive,
  setKeyhiveLogLevel,
  uint8ArrayToHex,
  type AutomergeRepoKeyhive,
} from '@automerge/automerge-repo-keyhive'
import type { Candidate, Capability, Device, Person } from '../../lab/types'
import { startSubduction, type RunningSubduction } from './server'

// Keyhive, Lauf a: so wie Keyhive gedacht ist. Automerge über ARK
// (@automerge/automerge-repo-keyhive) und einen echten Subduction-Server
// (Rust) als Relay. Eigener Transport: Der Prüfstand schaltet Geräte nur
// online/offline. Nur in Node, der Browser kann keinen Server starten.
// Port-Notizen: NOTES.md.

interface Doc {
  eintraege: string[]
  /** Eigener Platz für Rotations-Edits, damit Mitglieder den neuen Schlüssel lernen. */
  _rotation?: number
}

/** Speicher im Arbeitsspeicher für Repo und ARK (der Hilfs-Adapter des Pakets zieht dessen src/ in den Typcheck). */
class MemoryStorage implements StorageAdapterInterface {
  private readonly data = new Map<string, Uint8Array>()
  private static key(k: StorageKey) {
    return k.join('\u0000')
  }
  async load(key: StorageKey) {
    return this.data.get(MemoryStorage.key(key))
  }
  async save(key: StorageKey, binary: Uint8Array) {
    this.data.set(MemoryStorage.key(key), binary)
  }
  async remove(key: StorageKey) {
    this.data.delete(MemoryStorage.key(key))
  }
  async saveBatch(entries: Array<[StorageKey, Uint8Array]>) {
    for (const [key, data] of entries) this.data.set(MemoryStorage.key(key), data)
  }
  async loadRange(prefix: StorageKey): Promise<Chunk[]> {
    const p = MemoryStorage.key(prefix)
    const out: Chunk[] = []
    for (const [k, data] of this.data) {
      if (k === p || k.startsWith(p + '\u0000')) out.push({ key: k.split('\u0000'), data })
    }
    return out
  }
  async removeRange(prefix: StorageKey) {
    const p = MemoryStorage.key(prefix)
    for (const k of [...this.data.keys()]) if (k === p || k.startsWith(p + '\u0000')) this.data.delete(k)
  }
}

/** WebSocket-Endpunkt mit Schalter: offline heißt getrennt, und die Wiederverbindung wartet. */
class GatedEndpoint implements WebSocketEndpointInterface {
  private readonly inner: WebSocketEndpoint
  private online = true
  private waiters: Array<() => void> = []
  private readonly transports = new Set<ManagedTransport>()
  constructor(readonly url: string) {
    this.inner = new WebSocketEndpoint(url)
  }
  async connect(): Promise<ManagedTransport> {
    while (!this.online) await new Promise<void>((r) => this.waiters.push(r))
    const t = await this.inner.connect()
    this.transports.add(t)
    void t.closed().then(() => this.transports.delete(t))
    return t
  }
  async setOnline(online: boolean) {
    if (this.online === online) return
    this.online = online
    if (online) this.waiters.splice(0).forEach((w) => w())
    else for (const t of [...this.transports]) await t.disconnect().catch(() => {})
  }
}

interface DeviceState {
  person: Person
  hive: AutomergeRepoKeyhive
  repo: Repo
  endpoint: GatedEndpoint
  idHex: string
  handle?: DocHandle<Doc>
  members: Person[]
  items: string[]
  online: boolean
}

// Eingehende Kontaktkarten mitschreiben: So lernt ein Bootstrap-Hive die Karte des
// Servers, die ARK vorab braucht, der Server aber nirgends ausgibt (er beantwortet
// RequestContactCard mit angehängter Karte, ARK nimmt sie mit receiveContactCard an).
const seenCards = new Map<string, string>()
let patched = false
function patchCardCapture() {
  if (patched) return
  patched = true
  const proto = Keyhive.prototype as unknown as { receiveContactCard: (c: ContactCard) => Promise<unknown> }
  const orig = proto.receiveContactCard
  proto.receiveContactCard = function (this: Keyhive, card: ContactCard) {
    try {
      seenCards.set(uint8ArrayToHex(card.id.toBytes()), card.toJson())
    } catch {}
    return orig.call(this, card)
  }
}

const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)))
const hexToBase64 = (hex: string) => btoa(String.fromCharCode(...hex.match(/../g)!.map((h) => parseInt(h, 16))))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function keyhiveArk(): Candidate {
  const devices = new Map<Device, DeviceState>()
  const cards = new Map<Person, ContactCard>()
  const personOf = new Map<string, Person>()
  const notes: string[] = []
  let server: RunningSubduction | undefined
  let serverIdentity: { contactCardJson: string; peerId: PeerId } | undefined
  let docUrl: AutomergeUrl | undefined
  /** Admin-Gruppe als Miteigentümerin des Dokuments: Nur so darf ein Admin
   *  Delegationen widerrufen, die er nicht selbst ausgestellt hat (wie in Lauf b). */
  let groupIdBytes: Uint8Array | undefined
  let lastOnlineChange = 0
  let idle = 0

  const dev = (d: Device) => {
    const s = devices.get(d)
    if (!s) throw new Error(`unbekanntes Gerät ${d}`)
    return s
  }

  async function makeHive(suffix: string, syncServer: 'none' | { contactCardJson: string; peerId: PeerId }, remotePeerId: PeerId) {
    const endpoint = new GatedEndpoint(server!.url)
    const { hive, repo } = await initializeAutomergeRepoKeyhive({
      storage: new MemoryStorage(),
      peerIdSuffix: suffix,
      syncServer,
      remotePeerId,
      syncRequestInterval: 200,
      shareConfigDebounceMs: 50,
      createRepo: (cfg) => new Repo({ ...cfg, storage: new MemoryStorage(), subductionWebsocketEndpoints: [endpoint] }),
    })
    return { hive, repo, endpoint }
  }

  async function ensureServer() {
    if (serverIdentity) return
    setKeyhiveLogLevel('warn')
    patchCardCapture()
    await initSubduction() // ARK baut den Subduction-Signer vor dem Repo
    server = await startSubduction()
    const remote = hexToBase64(server.peerIdHex) as PeerId
    const boot = await makeHive('boot', 'none', remote)
    for (let i = 0; i < 100 && !seenCards.has(server.peerIdHex); i++) await sleep(100)
    boot.hive.close()
    await boot.repo.shutdown().catch(() => {})
    const contactCardJson = seenCards.get(server.peerIdHex)
    if (!contactCardJson) throw new Error('Kontaktkarte des Servers nicht erhalten')
    serverIdentity = { contactCardJson, peerId: remote }
  }

  /** ARK-intern (im Typ geschützt, in JS öffentlich): dreht den PCS-Schlüssel und schreibt den Nudge. */
  function noteMembershipChange(s: DeviceState) {
    if (docUrl) (s.hive as unknown as { noteLocalMembershipChange(u: AutomergeUrl): void }).noteLocalMembershipChange(docUrl)
  }

  async function ensureHandle(s: DeviceState, timeoutMs: number): Promise<DocHandle<Doc> | undefined> {
    if (s.handle) return s.handle
    if (!docUrl) return undefined
    try {
      s.handle = await s.repo.find<Doc>(docUrl, { signal: AbortSignal.timeout(timeoutMs) })
    } catch {
      return undefined
    }
    return s.handle
  }

  async function observe(s: DeviceState) {
    if (!docUrl) return { members: [] as Person[], items: [] as string[] }
    const h = await ensureHandle(s, 400)
    const doc = h?.doc()
    const items = doc?.eintraege ? [...doc.eintraege].sort() : []
    const members = new Set<Person>()
    try {
      for (const m of await s.hive.listMembers(docUrl)) {
        if (m.isSyncServer || m.isPublic) continue
        const p = personOf.get(m.id)
        if (p) {
          members.add(p)
          continue
        }
        // Gruppe: Mitglieder transitiv auflösen.
        const g = await s.hive.keyhive.getGroup(new GroupId(hexToBytes(m.id)))
        if (!g) continue
        for (const tm of await g.transitiveMembers()) {
          const tp = personOf.get(uint8ArrayToHex(tm.who.id.toBytes()))
          if (tp) members.add(tp)
        }
      }
    } catch {}
    return { members: [...members].sort(), items }
  }

  /**
   * Ruhe heißt hier: Die Sichten aller Geräte ändern sich nicht mehr, und jedes
   * Online-Gerät, das laut irgendeiner Sicht Mitglied ist, hält das Dokument.
   * ARK braucht nach einer Aufnahme einige Sekunden, bis der Server das
   * Dokument an das neue Mitglied gibt. Nach 20 s wird der Stand genommen,
   * wie er ist (Szenarien melden dann „hat das Dokument nicht“).
   */
  async function settle() {
    const start = Date.now()
    const deadline = start + 25_000
    // Der Server reicht Keyhive-Zustand im 2-s-Takt weiter (keyhive-cache-refresh);
    // Ruhe gilt erst nach 2,5 s ohne Änderung und frühestens 2,5 s nach Beginn.
    const quietMs = Number(globalThis.process?.env?.ARK_QUIET_MS ?? 2_500) // für Timing-Experimente
    const minUntil = Math.max(lastOnlineChange + 1_500, start + quietMs)
    let last = ''
    let stable = 0
    while (Date.now() < deadline) {
      const t = performance.now()
      await sleep(100)
      idle += performance.now() - t
      const views: Array<[Device, { members: Person[]; items: string[] }]> = []
      for (const [d, s] of devices) views.push([d, await observe(s)])
      const expected = new Set(views.flatMap(([, v]) => v.members))
      const missing = [...devices].filter(([, s]) => s.online && expected.has(s.person) && !s.handle)
      const fp = JSON.stringify(views)
      stable = fp === last ? stable + 1 : 0
      last = fp
      if (stable >= quietMs / 100 && missing.length === 0 && Date.now() >= minUntil) {
        for (const [d, v] of views) Object.assign(dev(d), v)
        return
      }
    }
    for (const [d, s] of devices) Object.assign(s, await observe(s)), void d
  }

  return {
    id: 'keyhive-ark',
    // Kein 'steal': Ein Angreifer müsste Sedimentree-Blobs vom Server lesen; nicht verdrahtet.
    capabilities: new Set<Capability>(['roles', 'rotate']),

    transport: {
      async setOnline(d, online) {
        const s = dev(d)
        if (s.online === online) return
        s.online = online
        lastOnlineChange = Date.now()
        await s.endpoint.setOnline(online)
      },
      settle,
      async write(d, text) {
        const s = dev(d)
        const h = await ensureHandle(s, 3000)
        if (!h) throw new Error(`${d} hat das Dokument nicht`)
        h.change((doc) => {
          doc.eintraege.push(text)
        })
      },
      read: (d) => dev(d).items,
      idleMs: () => idle,
    },

    async addDevice(person, device) {
      await ensureServer()
      if (cards.has(person)) throw new Error('mehrere Geräte je Person noch nicht verdrahtet')
      const { hive, repo, endpoint } = await makeHive(device, serverIdentity!, serverIdentity!.peerId)
      const card = hive.active.contactCard
      const idHex = uint8ArrayToHex(card.id.toBytes())
      // Karten außerhalb des Bandes an alle: Ein Admin kann nur entfernen, wen sein
      // Keyhive als Agent kennt (entspricht dem Key-Bundle-Tausch der anderen Kandidaten).
      for (const other of devices.values()) {
        await other.hive.receiveContactCard(ContactCard.fromJson(card.toJson()))
        await hive.receiveContactCard(ContactCard.fromJson(other.hive.active.contactCard.toJson()))
      }
      cards.set(person, card)
      personOf.set(idHex, person)
      devices.set(device, { person, hive, repo, endpoint, idHex, members: [], items: [], online: true })
    },

    async createGroup(d) {
      const s = dev(d)
      const group = await s.hive.generateGroup() // gibt dem Server Relay auf die Gruppe
      groupIdBytes = group.toBytes()
      s.handle = await s.repo.create2<Doc>({ eintraege: [] })
      docUrl = s.handle.url
      // Wie in der ARK-Demo: Der Server braucht je Dokument Relay-Zugriff.
      await s.hive.addSyncServerRelayToDoc(docUrl)
      await s.hive.keyhive.addMember(group.toIdentifier(), MemberedId.document(docIdFromAutomergeUrl(docUrl)), Access.admin(), [])
      noteMembershipChange(s)
    },
    async addMember(by, p, role) {
      if (!docUrl) throw new Error('kein Dokument')
      const s = dev(by)
      const card = cards.get(p)
      if (!card) throw new Error(`unbekannte Person ${p}`)
      if (role === 'admin') {
        await s.hive.keyhive.addMember(card.id, MemberedId.group(new GroupId(groupIdBytes!)), Access.admin(), [docIdFromAutomergeUrl(docUrl)])
        noteMembershipChange(s) // Rotation und Nudge wie bei ARKs addMemberToDoc
      } else {
        await s.hive.addMemberToDoc(docUrl, card, Access.edit())
      }
    },
    async removeMember(by, p) {
      if (!docUrl) throw new Error('kein Dokument')
      const s = dev(by)
      const idHex = uint8ArrayToHex(cards.get(p)!.id.toBytes())
      const errors: string[] = []
      try {
        await s.hive.revokeMemberFromDoc(docUrl, idHex)
      } catch (e) {
        errors.push(`Dokument: ${(e as Error).message ?? e}`)
      }
      try {
        // Wie ARK (retain_all_other_members = true): Einladungen des Entfernten bleiben.
        await s.hive.keyhive.revokeMember(new Identifier(hexToBytes(idHex)), true, MemberedId.group(new GroupId(groupIdBytes!)))
      } catch (e) {
        errors.push(`Gruppe: ${(e as Error).message ?? e}`)
      }
      if (errors.length === 2) notes.push(`${by} entfernt ${p}: ${errors.join(' / ')}`)
    },
    async rotate(by) {
      if (!docUrl) throw new Error('kein Dokument')
      const s = dev(by)
      await s.hive.keyhive.forcePcsUpdate(docIdFromAutomergeUrl(docUrl))
      // Ein Edit unter dem neuen Schlüssel, damit die anderen ihn lernen (wie ARKs „nudge“).
      const h = await ensureHandle(s, 3000)
      h?.change((doc) => {
        doc._rotation = Date.now()
      })
    },
    async changePolicy() {
      throw new Error('keine Gruppenregeln')
    },

    async sealContent() {},
    takeOutgoing: () => [],
    async receive() {
      return { content: [] }
    },

    members: (d) => dev(d).members,
    status: (d) => [dev(d).handle ? 'dokument' : 'kein-dokument', ...notes.slice(0, 4)].join('; '),

    steal() {
      throw new Error('nicht abbildbar')
    },
    attackerOpen: () => [],

    async dispose() {
      for (const s of devices.values()) {
        s.hive.close()
        await s.repo.shutdown().catch(() => {})
      }
      await server?.stop()
    },
  }
}
