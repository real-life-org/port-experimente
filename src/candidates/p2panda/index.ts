import type { Candidate, Capability, Device, Person } from '../../lab/types'
import { loadWasm, P2pPeer } from './load'

// p2panda-spaces 0.7.1 als WebAssembly (rust/p2panda-wasm): Gruppen-CRDT mit
// Strong Removal (p2panda-auth), DCGKA (p2panda-encryption), alles über das
// Netz des Prüfstands, ohne Server. Port-Notizen: NOTES.md.

const SPACE = 'pruefstand'

interface DeviceState {
  person: Person
  peer: P2pPeer
  outgoing: Array<{ label: string; body: Uint8Array }>
  members: Person[]
}

export function p2panda(): Candidate {
  const devices = new Map<Device, DeviceState>()
  const idOf = new Map<Person, string>()
  const personOf = new Map<string, Person>()
  const notes: string[] = []

  const dev = (d: Device) => {
    const s = devices.get(d)
    if (!s) throw new Error(`unbekanntes Gerät ${d}`)
    return s
  }
  const id = (p: Person) => {
    const i = idOf.get(p)
    if (!i) throw new Error(`unbekannte Person ${p}`)
    return i
  }
  const send = (s: DeviceState, label: string, msgs: Uint8Array[]) => {
    for (const body of msgs) s.outgoing.push({ label, body })
  }
  async function refresh(s: DeviceState) {
    const m = (await s.peer.members(SPACE)) as Array<[string, string]>
    s.members = m.map(([i]) => personOf.get(i) ?? i).sort()
  }

  return {
    id: 'p2panda',
    // Kein 'rotate' (Space-Update in 0.7.1 nicht umgesetzt), keine Gruppenregeln,
    // kein 'multi-device' (verschachtelte Gruppen noch nicht verdrahtet), kein 'steal'.
    capabilities: new Set<Capability>(['roles']),

    async addDevice(person, device) {
      await loadWasm()
      if (idOf.has(person)) throw new Error('mehrere Geräte je Person noch nicht verdrahtet')
      const peer = new P2pPeer()
      const s: DeviceState = { person, peer, outgoing: [], members: [] }
      devices.set(device, s)
      idOf.set(person, peer.id)
      personOf.set(peer.id, person)
      // Key-Bundle veröffentlichen, damit andere dieses Gerät aufnehmen können.
      send(s, 'key-bundle', [await peer.keyBundle()])
    },
    async createGroup(d) {
      const s = dev(d)
      send(s, 'create', (await s.peer.createSpace(SPACE)) as Uint8Array[])
      await refresh(s)
    },
    async addMember(by, p, role) {
      const s = dev(by)
      send(s, 'add', (await s.peer.add(SPACE, id(p), role === 'admin' ? 'manage' : 'write')) as Uint8Array[])
      await refresh(s)
    },
    async removeMember(by, p) {
      const s = dev(by)
      try {
        send(s, 'remove', (await s.peer.remove(SPACE, id(p))) as Uint8Array[])
      } catch (e) {
        notes.push(`${by} entfernt ${p}: ${(e as Error).message}`)
      }
      await refresh(s)
    },
    async rotate() {
      throw new Error('p2panda-spaces 0.7.1: SpaceUpdate nicht umgesetzt')
    },
    async changePolicy() {
      throw new Error('keine Gruppenregeln')
    },
    async sealContent(d, update) {
      const s = dev(d)
      try {
        send(s, 'content', [await s.peer.publish(SPACE, update)])
      } catch (e) {
        notes.push(`${d} schreibt: ${(e as Error).message}`)
      }
    },
    takeOutgoing: (d) => dev(d).outgoing.splice(0),
    async receive(d, msg) {
      const s = dev(d)
      const r = (await s.peer.receive(msg.body)) as { application: Uint8Array[]; pending: number; errors: string[] }
      for (const e of r.errors) notes.push(`${d} verarbeitet ${msg.label}: ${e}`)
      await refresh(s)
      return { content: r.application }
    },
    members: (d) => dev(d).members,
    status: (d) => [`wartend=${devices.size ? '' : ''}`, ...notes.slice(0, 5)].filter(Boolean).join('; ') || `ok (${d})`,
    steal() {
      throw new Error('nicht abbildbar')
    },
    attackerOpen: () => [],
  }
}
