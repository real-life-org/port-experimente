import type { Candidate, Capability, Device, Msg, Person, Received, Role } from '../../lab/types'

// Null-Kandidat: keine Krypto, keine Rechteprüfung, Operationen wirken in
// Ankunftsreihenfolge. Er dient nur dazu zu zeigen, dass der Prüfstand
// Fehler erkennt.

type Op =
  | { t: 'create'; by: Person }
  | { t: 'add'; person: Person; role: Role }
  | { t: 'remove'; person: Person }
  | { t: 'rotate' }
  | { t: 'policy'; tag: string }
  | { t: 'content'; u: number[] }

interface Replica {
  person: Person
  members: Set<Person>
  policy: string
  outgoing: Array<{ label: string; body: Uint8Array }>
}

const enc = new TextEncoder()
const dec = new TextDecoder()
const encode = (op: Op) => enc.encode(JSON.stringify(op))
const decode = (body: Uint8Array) => JSON.parse(dec.decode(body)) as Op

export function klartext(): Candidate {
  const replicas = new Map<Device, Replica>()
  const replica = (d: Device) => {
    const r = replicas.get(d)
    if (!r) throw new Error(`unbekanntes Gerät ${d}`)
    return r
  }

  function apply(r: Replica, op: Op): Uint8Array[] {
    switch (op.t) {
      case 'create': r.members.add(op.by); return []
      case 'add': r.members.add(op.person); return []
      case 'remove': r.members.delete(op.person); return []
      case 'policy': r.policy = op.tag; return []
      case 'rotate': return []
      case 'content': return [Uint8Array.from(op.u)]
    }
  }

  function emit(by: Device, op: Op) {
    const r = replica(by)
    apply(r, op)
    r.outgoing.push({ label: op.t, body: encode(op) })
  }

  return {
    id: 'klartext',
    capabilities: new Set<Capability>(['roles', 'rotate', 'policy', 'multi-device', 'steal']),
    async addDevice(person, device) {
      replicas.set(device, { person, members: new Set(), policy: 'default', outgoing: [] })
    },
    async createGroup(device) { emit(device, { t: 'create', by: replica(device).person }) },
    async addMember(by, person, role) { emit(by, { t: 'add', person, role }) },
    async removeMember(by, person) { emit(by, { t: 'remove', person }) },
    async rotate(by) { emit(by, { t: 'rotate' }) },
    async changePolicy(by, tag) { emit(by, { t: 'policy', tag }) },
    async sealContent(device, update) {
      replica(device).outgoing.push({ label: 'content', body: encode({ t: 'content', u: [...update] }) })
    },
    takeOutgoing(device) { return replica(device).outgoing.splice(0) },
    async receive(device, msg: Msg): Promise<Received> {
      return { content: apply(replica(device), decode(msg.body)) }
    },
    members(device) { return [...replica(device).members].sort() },
    status(device) { return `policy=${replica(device).policy}` },
    steal() { return {} },
    attackerOpen(_stolen, msg) {
      const op = decode(msg.body)
      return op.t === 'content' ? Uint8Array.from(op.u) : null
    },
  }
}
