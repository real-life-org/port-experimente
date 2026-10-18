import type { Candidate, Capability, Device, Msg, Person } from '../../lab/types'
import { mlsPort, mlsTiebreak, type KeyPeer } from '../rltp-beekem/keyport'
import { openFrom, sealTo } from '../rltp-beekem/index'
import { x25519 } from '@noble/curves/ed25519.js'

// E14b: Consensuals Raummodell nachgebaut, als Gegenstück zu rltp-mls. Kein
// Autoritätslog: die Mitgliedschaft IST der MLS-Baum, ein Blatt je Gerät.
// `any-staged`: jedes Mitglied committet selbst; bei gleichzeitigen Commits
// gewinnt der kleinste Hash, der Verlierer stellt seine Absicht auf der neuen
// Epoche neu ein. `owner`: nur der Gründer committet, Mitglieder schlagen vor
// (OpenVTC Rooms). Rollen gibt es nicht als Regel; `roles` ist nur deklariert,
// damit die Szenarien laufen (Consensual: `admins` leer, committer any-staged).
// Historie: Einträge sind unter dem Exporter ihrer Epoche versiegelt, ein
// Neuling liest nichts von davor (Consensual B23, kein KV4). Port-Notizen: NOTES.md.

export type Committer = 'any-staged' | 'owner'

interface Card {
  person: Person
  id: Uint8Array
  shareKey: Uint8Array
  welcomeKey: string
}

type Wire =
  | { t: 'card'; person: Person; id: string; shareKey: string; welcomeKey: string }
  | { t: 'commit'; op: string }
  | { t: 'welcome'; to: string; eph: string; iv: string; c: string }
  | { t: 'content'; c: string }
  | { t: 'propose'; kind: 'add' | 'remove' | 'remove-card'; person: Person; card?: string; by: string }

interface Intent {
  kind: 'add' | 'remove' | 'remove-card'
  person: Person
  /** Nur ein bestimmtes Gerät (S5b). */
  card?: string
}

/** Eine Absicht, die in einem eigenen Commit steckt: verliert der Commit den Tiebreak, wird sie neu eingestellt. */
interface Staged {
  intent: Intent
  /** Epoche, die der eigene Commit erzeugt hat. */
  epoch: number
}

interface DeviceState {
  person: Person
  peer: KeyPeer
  welcomePriv: Uint8Array
  cards: Map<string, Card>
  outgoing: Array<{ label: string; body: Uint8Array; direct?: boolean }>
  /** Commits, die noch nicht passen (Vorgänger fehlen, anderer Zweig). */
  pendingOps: string[]
  /** Einträge, die (noch) nicht zu öffnen sind. */
  pendingContent: string[]
  /** Absichten, die noch keinen Commit haben. */
  intents: Intent[]
  /** Absichten in eigenen Commits, solange ein Tiebreak sie noch zurückrollen kann (Consensual: der Verlierer stellt neu ein). */
  staged: Staged[]
  notes: string[]
  /** Zählt Änderungen am Baum; nur dann wird Wartendes erneut versucht. */
  gen: number
  triedAt: number
}

const enc = new TextEncoder()
const dec = new TextDecoder()
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const unhex = (h: string) => new Uint8Array((h.match(/.{2}/g) ?? []).map((x) => parseInt(x, 16)))
const uniq = (xs: string[]) => [...new Set(xs)].sort()
/** So weit kann der Port zurückfallen (rust/mls-wasm SNAPSHOT_DEPTH); älter ist ein eigener Commit endgültig. */
const SNAPSHOT_DEPTH = 8

export function consensualMls(options: { committer?: Committer } = {}): Candidate {
  const mode: Committer = options.committer ?? 'any-staged'
  const port = mlsPort
  const devices = new Map<Device, DeviceState>()
  const notes: string[] = []
  let groupId: Uint8Array | undefined
  let owner: Person | undefined

  const dev = (d: Device) => {
    const s = devices.get(d)
    if (!s) throw new Error(`unbekanntes Gerät ${d}`)
    return s
  }
  const send = (s: DeviceState, m: Wire, label: string = m.t, direct = false) => s.outgoing.push({ label, body: enc.encode(JSON.stringify(m)), direct })
  const inTree = (s: DeviceState) => new Set((s.peer.members() as Uint8Array[]).map(hex))
  const me = (s: DeviceState) => hex(s.peer.id)
  const isMember = (s: DeviceState) => s.peer.hasKey() && inTree(s).has(me(s))
  const cardsOf = (s: DeviceState, p: Person) => [...s.cards.values()].filter((c) => c.person === p)
  const commits = (s: DeviceState) => mode === 'any-staged' || s.person === owner

  async function sendWelcome(s: DeviceState, card: Card, welcome: Uint8Array) {
    const plain = enc.encode(JSON.stringify({ key: hex(welcome) }))
    const { eph, iv, ct } = await sealTo(unhex(card.welcomeKey), plain)
    send(s, { t: 'welcome', to: card.welcomeKey, eph: hex(eph), iv: hex(iv), c: hex(ct) })
  }

  /**
   * Absichten in Commits umsetzen (Consensual „staging“): jede Absicht genau einmal, als eigener Commit; sie
   * wandert nach `staged`, bis kein Tiebreak sie mehr zurückrollen kann. Ohne Mitgliedschaft verfällt sie.
   * Die Rahmen heißen `auth`, weil der Commit in diesem Modell die Autorität ist (der Träger-Prüfstand greift so zu).
   */
  async function restage(s: DeviceState) {
    const intents = s.intents.splice(0)
    if (!isMember(s)) return
    const tree = inTree(s)
    for (const it of intents) {
      try {
        let committed = false
        if (it.kind === 'add') {
          for (const c of cardsOf(s, it.person)) {
            if (tree.has(hex(c.id))) continue
            const r = await s.peer.add(c.id, c.shareKey)
            if (r.op) send(s, { t: 'commit', op: hex(r.op) }, 'auth')
            if (r.welcome) await sendWelcome(s, c, r.welcome)
            committed = true
          }
        } else {
          const targets = it.kind === 'remove' ? cardsOf(s, it.person).map((c) => hex(c.id)) : [it.card!]
          for (const id of targets) {
            if (!tree.has(id)) continue
            const op = await s.peer.remove(unhex(id))
            if (op) send(s, { t: 'commit', op: hex(op) }, 'auth')
            committed = true
          }
        }
        if (committed) s.staged.push({ intent: it, epoch: s.peer.epoch() })
      } catch (e) {
        s.notes.push(`${it.kind} ${it.person}: ${(e as Error).message}`)
      }
    }
  }

  /** Nach einem Rückfall: Absichten aus zurückgerollten Commits neu einstellen; Erledigtes vergessen. */
  function reconcileStaged(s: DeviceState, lost: boolean) {
    const epoch = s.peer.epoch()
    if (lost) {
      // Zurückgerollt ist alles, was auf oder über der jetzigen Epoche stand (der fremde Commit hat sie neu erzeugt).
      const back = s.staged.filter((x) => x.epoch >= epoch)
      s.staged = s.staged.filter((x) => x.epoch < epoch)
      s.intents.push(...back.map((x) => x.intent))
      if (back.length) s.notes.push(`${back.length} Absicht(en) neu eingestellt`)
    }
    s.staged = s.staged.filter((x) => epoch < x.epoch + SNAPSHOT_DEPTH)
  }

  function noteResult(s: DeviceState, r: string) {
    if (r === 'lost') s.notes.push('Tiebreak verloren: eigener Commit zurückgerollt')
    if (r !== 'stale') s.gen++
    if (r === 'lost' || r === 'reset') reconcileStaged(s, true)
  }

  /** Wartende Commits und Einträge erneut versuchen, bis nichts mehr geht; danach Absichten neu einstellen. */
  async function settle(s: DeviceState): Promise<Uint8Array[]> {
    let progress = true
    while (progress && s.pendingOps.length && s.triedAt !== s.gen) {
      s.triedAt = s.gen
      progress = false
      const rest: string[] = []
      for (const op of s.pendingOps) {
        try {
          noteResult(s, s.peer.receive(unhex(op)))
          progress = true
        } catch {
          rest.push(op)
        }
      }
      s.pendingOps = rest
    }
    reconcileStaged(s, false)
    await restage(s)
    const out: Uint8Array[] = []
    const still: string[] = []
    for (const c of s.pendingContent) {
      try {
        out.push(s.peer.decrypt(unhex(c)).plaintext)
      } catch {
        still.push(c)
      }
    }
    s.pendingContent = still
    return out
  }

  async function intend(by: Device, it: Intent) {
    const s = dev(by)
    if (commits(s)) {
      s.intents.push(it)
      await restage(s)
    } else {
      // Owner-Modus: Mitglieder schlagen vor, der Gründer committet.
      send(s, { t: 'propose', kind: it.kind, person: it.person, card: it.card, by: me(s) })
    }
  }

  return {
    id: `consensual-mls-${mode}`,
    capabilities: new Set<Capability>(['roles', 'rotate', 'steal', 'multi-device', 'device-remove']),
    // Wer bei gleichzeitigen Commits gewinnt, ist ein Münzwurf (kleinster Hash); der Prüfstand läuft jede Seite.
    branches: mlsTiebreak,

    async addDevice(person, device) {
      await port.load()
      const peer = port.peer()
      const welcomePriv = x25519.utils.randomSecretKey()
      const card: Card = { person, id: peer.id, shareKey: peer.shareKey, welcomeKey: hex(x25519.getPublicKey(welcomePriv)) }
      const s: DeviceState = { person, peer, welcomePriv, cards: new Map([[hex(card.id), card]]), outgoing: [], pendingOps: [], pendingContent: [], intents: [], staged: [], notes: [], gen: 0, triedAt: -1 }
      devices.set(device, s)
      send(s, { t: 'card', person, id: hex(card.id), shareKey: hex(card.shareKey), welcomeKey: card.welcomeKey }, 'card', true)
    },
    async createGroup(d) {
      const s = dev(d)
      groupId = crypto.getRandomValues(new Uint8Array(32))
      await s.peer.create(groupId)
      owner = s.person
      s.gen++
    },
    addMember: (by, p) => intend(by, { kind: 'add', person: p }),
    removeMember: (by, p) => intend(by, { kind: 'remove', person: p }),
    async removeDevice(by, device) {
      const target = dev(device)
      await intend(by, { kind: 'remove-card', person: target.person, card: me(target) })
    },
    async rotate(by) {
      const s = dev(by)
      if (!isMember(s)) return
      if (commits(s)) {
        const op = await s.peer.rotate()
        send(s, { t: 'commit', op: hex(op) }, 'auth')
        return
      }
      // Owner-Modus: ein Mitglied erneuert sein Blatt als Update-Vorschlag (RFC 9420), der Gründer committet ihn.
      // Nur so bleibt PCS für das Mitglied erreichbar, ohne dass es selbst committet (Review zu #40).
      send(s, { t: 'commit', op: hex(s.peer.proposeUpdate!()) }, 'proposal')
    },
    async changePolicy() {
      throw new Error('keine Gruppenregeln')
    },

    async sealContent(d, update) {
      const s = dev(d)
      if (!isMember(s)) {
        s.notes.push('schreiben ohne Mitgliedschaft')
        return
      }
      const r = await s.peer.encrypt(crypto.getRandomValues(new Uint8Array(32)), [], update)
      send(s, { t: 'content', c: hex(r.ciphertext) }, 'content')
    },
    takeOutgoing: (d) => dev(d).outgoing.splice(0),

    async receive(d, msg) {
      const s = dev(d)
      let m: Wire
      try {
        m = JSON.parse(dec.decode(msg.body)) as Wire
      } catch {
        // Beschädigter Rahmen (T5): weg damit; was er trug, kommt in diesem Modell nicht wieder.
        s.notes.push('verworfen: Rahmen beschädigt')
        return { content: [] }
      }
      switch (m.t) {
        case 'card': {
          const card: Card = { person: m.person, id: unhex(m.id), shareKey: unhex(m.shareKey), welcomeKey: m.welcomeKey }
          s.cards.set(m.id, card)
          // Eigenes weiteres Gerät: nimmt die Person selbst auf (Consensual: Same-Person-Statement); im Owner-Modus
          // schlägt sie es dem Gründer vor.
          if (card.person === s.person && isMember(s) && m.id !== me(s)) await intend(d, { kind: 'add', person: s.person })
          return { content: await settle(s) }
        }
        case 'commit': {
          let r: string | undefined
          try {
            r = s.peer.receive(unhex(m.op))
            noteResult(s, r)
          } catch {
            s.pendingOps.push(m.op)
          }
          // Owner-Modus: ein Vorschlag liegt vor, der Gründer committet ihn.
          if (r === 'proposal' && commits(s)) {
            const op = s.peer.commitPending!()
            if (op) send(s, { t: 'commit', op: hex(op) }, 'auth')
          }
          return { content: await settle(s) }
        }
        case 'welcome': {
          if (m.to !== hex(x25519.getPublicKey(s.welcomePriv))) return { content: [] }
          try {
            const w = JSON.parse(dec.decode(await openFrom(s.welcomePriv, unhex(m.eph), unhex(m.iv), unhex(m.c)))) as { key: string }
            const r = s.peer.welcome!(unhex(w.key))
            if (r !== 'own') s.gen++
            if (r === 'reset') {
              s.notes.push('Willkommen ersetzt verfallenen Zweig')
              reconcileStaged(s, true)
            }
          } catch (e) {
            s.notes.push(`Willkommen: ${(e as Error).message}`)
          }
          return { content: await settle(s) }
        }
        case 'content':
          s.pendingContent.push(m.c)
          return { content: await settle(s) }
        case 'propose': {
          // Owner-Modus: nur der Gründer handelt, nur auf Vorschlag eines Mitglieds, nie gegen sich selbst.
          if (!commits(s) || mode !== 'owner') return { content: [] }
          if (!inTree(s).has(m.by)) return { content: [] }
          if (m.kind !== 'add' && m.person === owner) return { content: [] }
          s.intents.push({ kind: m.kind, person: m.person, card: m.card })
          return { content: await settle(s) }
        }
      }
    },

    members(d) {
      const s = dev(d)
      if (!s.peer.hasKey()) return []
      return uniq([...inTree(s)].map((id) => s.cards.get(id)?.person ?? '?'))
    },
    status(d) {
      const s = dev(d)
      return [`epoche=${s.peer.epoch()}`, `baum=${inTree(s).size}`, `schlüssel=${s.peer.hasKey() ? 'ja' : 'nein'}`, ...(s.intents.length ? [`absichten=${s.intents.length}`] : []), ...(s.staged.length ? [`eingestellt=${s.staged.length}`] : []), ...(s.pendingOps.length ? [`wartende-commits=${s.pendingOps.length}`] : []), ...(s.pendingContent.length ? [`ungeöffnet=${s.pendingContent.length}`] : []), ...s.notes.slice(0, 3), ...notes.slice(0, 2)].join('; ')
    },

    async steal(d) {
      const s = dev(d)
      return { state: s.peer.exportState(), welcomePriv: s.welcomePriv.slice() }
    },
    async attackerOpen(stolen, msg: Msg) {
      const st = stolen as { state: Uint8Array; welcomePriv: Uint8Array; peer?: KeyPeer; pending?: string[] }
      st.peer ??= port.fromState(st.state)
      st.pending ??= []
      const m = JSON.parse(dec.decode(msg.body)) as Wire
      if (m.t === 'commit') {
        try {
          st.peer.receive(unhex(m.op))
        } catch {}
      }
      if (m.t === 'content') st.pending.push(m.c)
      const out: Uint8Array[] = []
      const still: string[] = []
      for (const c of st.pending) {
        try {
          out.push(st.peer.decrypt(unhex(c)).plaintext)
        } catch {
          still.push(c)
        }
      }
      st.pending = still
      return out
    },
  }
}
