import {
  InMemoryCompactStore,
  InMemoryDocLogStore,
  InMemoryKeyManagementAdapter,
  InMemoryMessagingAdapter,
  InMemoryOutboxStore,
  InMemorySpaceMetadataStorage,
  OutboxMessagingAdapter,
  InProcessLogBroker,
} from '@web_of_trust/core/adapters'
import { IdentityWorkflow, type PublicIdentitySession } from '@web_of_trust/core/application'
import { resolveDidKey, x25519PublicKeyToMultibase } from '@web_of_trust/core/protocol'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import { YjsReplicationAdapter } from '@web_of_trust/adapter-yjs'
import type { SpaceHandle } from '@web_of_trust/core/ports'
import type { Candidate, Capability, Device, Person } from '../../lab/types'

// WoT Gen 2, wie es live läuft: YjsReplicationAdapter + LogSyncCoordinator,
// Relay im Prozess (InProcessLogBroker), Inbox über InMemoryMessagingAdapter.
// Port-Notizen: NOTES.md.

const crypto = new WebCryptoProtocolCryptoAdapter()
const BROKER_URLS = ['wss://relay.port-experimente.invalid']

interface Doc {
  items: Record<string, { title: string }>
}

interface PersonState {
  identity: PublicIdentitySession
  did: string
  encKey: Uint8Array
}

interface DeviceState {
  person: Person
  // Wie produktiv (RLS): Outbox puffert Nachrichten, solange das Gerät offline ist.
  messaging: OutboxMessagingAdapter
  adapter: YjsReplicationAdapter
  keyManagement: InMemoryKeyManagementAdapter
  handle?: SpaceHandle<Doc>
  online: boolean
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function gen2(): Candidate {
  InMemoryMessagingAdapter.resetAll()
  const broker = new InProcessLogBroker()
  const people = new Map<Person, PersonState>()
  const devices = new Map<Device, DeviceState>()
  const byDid = new Map<string, Person>()
  let spaceId: string | undefined
  let lastOnlineChange = 0
  let idle = 0
  const snapshot = new Map<Device, { members: Person[]; items: string[]; status: string }>()
  const notes: string[] = []

  const dev = (d: Device) => {
    const s = devices.get(d)
    if (!s) throw new Error(`unbekanntes Gerät ${d}`)
    return s
  }

  async function person(p: Person): Promise<PersonState> {
    const known = people.get(p)
    if (known) return known
    const { identity } = await new IdentityWorkflow({ crypto }).createIdentity({ passphrase: `pw-${p}`, storeSeed: false })
    const state: PersonState = {
      identity,
      did: identity.getDid(),
      encKey: await identity.getEncryptionPublicKeyBytes(),
    }
    people.set(p, state)
    byDid.set(state.did, p)
    return state
  }

  async function handle(d: Device): Promise<SpaceHandle<Doc> | undefined> {
    const s = dev(d)
    if (s.handle) return s.handle
    if (!spaceId) return undefined
    if (!(await s.adapter.getSpace(spaceId))) return undefined
    try {
      s.handle = await s.adapter.openSpace<Doc>(spaceId)
    } catch {
      return undefined
    }
    return s.handle
  }

  async function observe(d: Device) {
    const s = dev(d)
    const info = spaceId ? await s.adapter.getSpace(spaceId) : null
    const h = info ? await handle(d) : undefined
    const items = h ? Object.values(h.getDoc().items ?? {}).map((i) => i.title) : []
    const members = (info?.members ?? []).map((did) => byDid.get(did) ?? did).sort()
    const gen = spaceId ? await s.keyManagement.getCurrentGeneration(spaceId).catch(() => -1) : -1
    return { members, items: items.sort(), status: `gen=${gen}` }
  }

  async function settle() {
    const deadline = Date.now() + 30_000
    // Nach einem Reconnect wartet der Adapter 2 s (Debounce), dann folgt der Catch-up.
    const minUntil = lastOnlineChange + 2_600
    let last = ''
    let stable = 0
    while (Date.now() < deadline) {
      const t = performance.now()
      await sleep(100)
      idle += performance.now() - t
      const views: Array<[Device, Awaited<ReturnType<typeof observe>>]> = []
      for (const d of devices.keys()) views.push([d, await observe(d)])
      const fp = JSON.stringify(views)
      stable = fp === last ? stable + 1 : 0
      last = fp
      if (stable >= 5 && Date.now() >= minUntil) {
        for (const [d, v] of views) snapshot.set(d, v)
        return
      }
    }
    throw new Error('Gen 2 kommt nicht zur Ruhe (30 s)')
  }

  const view = (d: Device) => snapshot.get(d) ?? { members: [], items: [], status: 'unbekannt' }

  return {
    id: 'gen2',
    // Kein 'multi-device': Zweitgeräte laufen produktiv über das PersonalDoc,
    // das im Prozess ein Singleton ist. Speicher zu teilen hieße, den Weg zu
    // umgehen, den S5 prüfen soll.
    capabilities: new Set<Capability>(['roles']),

    transport: {
      async setOnline(d, online) {
        const s = dev(d)
        if (s.online === online) return
        s.online = online
        lastOnlineChange = Date.now()
        if (online) await s.messaging.connect((await person(s.person)).did)
        else await s.messaging.disconnect()
      },
      settle,
      async write(d, text) {
        const h = await handle(d)
        if (!h) throw new Error(`${d} hat den Space nicht`)
        h.transact((doc) => {
          doc.items[globalThis.crypto.randomUUID()] = { title: text }
        })
      },
      read: (d) => view(d).items,
      idleMs: () => idle,
    },

    async addDevice(p, d) {
      const ps = await person(p)
      const messaging = new OutboxMessagingAdapter(new InMemoryMessagingAdapter({ broker, socketId: d }), new InMemoryOutboxStore())
      await messaging.connect(ps.did)
      const docLogStore = new InMemoryDocLogStore()
      await docLogStore.init()
      const deviceId = globalThis.crypto.randomUUID()
      const keyManagement = new InMemoryKeyManagementAdapter()
      await docLogStore.setDeviceId(deviceId)
      const adapter = new YjsReplicationAdapter({
        identity: ps.identity,
        messaging,
        brokerUrls: BROKER_URLS,
        keyManagement,
        metadataStorage: new InMemorySpaceMetadataStorage(),
        compactStore: new InMemoryCompactStore(),
        docLogStore,
        deviceId,
        flushPersonalDoc: async () => {},
        didResolver: {
          resolve: async (did: string) => {
            const who = byDid.get(did)
            const known = who ? people.get(who) : undefined
            if (!known) return resolveDidKey(did)
            return resolveDidKey(did, {
              keyAgreement: [{
                id: `${did}#enc-0`, type: 'X25519KeyAgreementKey2020', controller: did,
                publicKeyMultibase: x25519PublicKeyToMultibase(known.encKey),
              }],
            })
          },
        },
      })
      await adapter.start()
      devices.set(d, { person: p, messaging, adapter, keyManagement, online: true })
    },

    async createGroup(d) {
      const info = await dev(d).adapter.createSpace<Doc>('shared', { items: {} }, { name: 'Prüfstand' })
      spaceId = info.id
    },

    async addMember(by, p, role) {
      if (!spaceId) throw new Error('kein Space')
      const ps = await person(p)
      const a = dev(by).adapter
      await a.addMember(spaceId, ps.did, ps.encKey)
      if (role === 'admin') await a.promoteToAdmin(spaceId, ps.did)
    },

    async removeMember(by, p) {
      if (!spaceId) throw new Error('kein Space')
      try {
        await dev(by).adapter.removeMember(spaceId, (await person(p)).did)
      } catch (e) {
        // Offline: zweiphasiges Entfernen bleibt vorgemerkt, bis das Relay erreichbar ist.
        notes.push(`${by} entfernt ${p}: ${(e as Error).name}: ${(e as Error).message}`)
      }
    },

    async rotate() {
      throw new Error('Gen 2 hat keine öffentliche Rotation ohne Mitgliedschaftsänderung')
    },
    async changePolicy() {
      throw new Error('Gen 2 hat keine Gruppenregeln')
    },

    async sealContent() {},
    takeOutgoing: () => [],
    async receive() {
      return { content: [] }
    },

    members: (d) => view(d).members,
    status: (d) => [view(d).status, ...notes].join('; '),

    steal() {
      throw new Error('nicht abbildbar')
    },
    attackerOpen: () => null,

    async dispose() {
      for (const s of devices.values()) {
        s.handle?.close()
        await s.adapter.stop().catch(() => {})
      }
      InMemoryMessagingAdapter.resetAll()
    },
  }
}
