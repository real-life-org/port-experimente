import type { Candidate, Capability, Device, EnforcingService, Msg, Person } from '../../lab/types'
import { AuthorityLog, Signer, promoteInPolicy, type AuthOp, type Policy } from './authority'
import { BeekemPeer, loadWasm } from './load'
import { LogReplicaService, ViewService, viewHash, type ViewAck, type ViewProposal } from './service'

// E6: BeeKEM pur als Schlüssel-Adapter. Die Mitgliedschaft entscheidet ein
// minimales Autoritätslog nach der Konfliktmatrix (authority.ts), BeeKEM
// (Keyhives CGKA, ohne Keyhives Delegationsketten) liefert die Schlüssel,
// Yjs die Inhalte, über das Netz des Prüfstands ohne Server.
// Historie wie bei Keyhive b: Jeder Eintrag trägt die Schlüssel seiner
// Vorgänger, verschlüsselt mit seinem eigenen.
// E7: Ein Blatt je Gerät. Das Autoritätslog kennt nur Personen; die Karte
// eines Geräts bindet es an seine Person, und die Geräte einer Person nehmen
// ihre eigenen neuen Blätter in den Baum auf.
// E8: Optional ein durchsetzender Dienst am Relay (service.ts). Mit Sichten
// schlägt jedes Mitgliedsgerät nach jeder Änderung die Sicht seines Stands
// vor (Access §7.3); der Dienst nimmt sie mit Quorum an und bestätigt.
// E9: Signaturen, Politik als Daten, Fork. Jede Person signiert mit einem
// Ed25519-Schlüssel (geteilt über ihre Geräte, wie heute der Seed); die
// Gruppe regiert sich über eine Politik nach Access §4, „Admin“ ist
// actors(k=1); policy.change neben Durchsetzung forkt (§3.6).
// Port-Notizen: NOTES.md.

const enc = new TextEncoder()
const dec = new TextDecoder()
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const unhex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)))
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b))

/** Vorgänger-Tabelle (je 32 B Referenz + 32 B Schlüssel) unter dem Eintragsschlüssel, AES-GCM. */
async function sealTable(key: Uint8Array, table: Uint8Array) {
  const k = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, table))
  return { iv, ct }
}
async function openTable(key: Uint8Array, iv: Uint8Array, ct: Uint8Array) {
  const k = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt'])
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k, ct))
}

type Wire =
  | { t: 'card'; person: Person; id: string; shareKey: string }
  | { t: 'auth'; op: AuthOp; group?: string; cgka: string[] }
  | { t: 'cgka'; op: string }
  /** Widerruf eines einzelnen Geräts (verloren); die Person bleibt. */
  | { t: 'revoke'; id: string }
  | { t: 'content'; c: string; iv: string; tab: string; ref: string }
  | ViewProposal
  | ViewAck

interface KeyState {
  peer: BeekemPeer
  /** Anwendungsschlüssel je Eintrag (hex der Referenz), aus BeeKEM oder aus der Kette. */
  keys: Map<string, Uint8Array>
  heads: Uint8Array[]
  pending: Wire[]
}

interface Card {
  person: Person
  id: Uint8Array
  shareKey: Uint8Array
}

interface DeviceState extends KeyState {
  person: Person
  auth: AuthorityLog
  /** Gerätekarten nach BeeKEM-ID (hex), wie dieses Gerät sie empfangen hat. Mehrere je Person. */
  cards: Map<string, Card>
  /** Widerrufene Geräte (hex der ID), wie dieses Gerät sie empfangen hat. */
  revoked: Set<string>
  /** E8 Sichten: letzte vom Dienst bestätigte Sicht und eigener letzter Vorschlag. */
  ack: { seq: number; hash: string | null; identities: string[] }
  proposed: string | null
  waitingAuth: Array<{ op: AuthOp; cgka: string[] }>
  /** BeeKEM-Anhänge, die schon in den Baum gingen (je Operation einmal). */
  appliedCgka: Set<string>
  outgoing: Array<{ label: string; body: Uint8Array }>
  joined: boolean
  notes: string[]
}

export type DienstVariante = 'sichten' | 'logreplik'

/** Politik, in der die Genannten allein aufnehmen, entfernen und Regeln ändern (strongest = die stärkste davon). */
const adminPolicy = (admins: Person[]): Policy => ({
  'member.add': { type: 'actors', actors: admins, k: 1 },
  'member.remove': { type: 'actors', actors: admins, k: 1 },
  'policy.change': { type: 'strongest' },
})

export function rltpBeekem(options: { dienst?: DienstVariante } = {}): Candidate {
  const devices = new Map<Device, DeviceState>()
  // Ein Signierschlüssel je Person, über ihre Geräte geteilt (wie heute der Seed).
  const persons = new Map<Person, Signer>()
  const signerOf = (p: Person) => {
    let k = persons.get(p)
    if (!k) persons.set(p, (k = Signer.generate(p)))
    return k
  }
  const service: EnforcingService | undefined =
    options.dienst === 'sichten' ? new ViewService() : options.dienst === 'logreplik' ? new LogReplicaService() : undefined
  // Karten und Widerrufe leben je Replika und ändern sich nur durch
  // empfangene Rahmen; sonst wüssten getrennte Repliken Dinge, die das
  // Netz noch nicht zugestellt hat (Review zu PR #12, Issue #14).
  const cardsOf = (s: DeviceState, p: Person) => [...s.cards.values()].filter((c) => c.person === p && !s.revoked.has(hex(c.id)))
  let groupId: Uint8Array | undefined
  const notes: string[] = []

  const dev = (d: Device) => {
    const s = devices.get(d)
    if (!s) throw new Error(`unbekanntes Gerät ${d}`)
    return s
  }
  const send = (s: DeviceState, msg: Wire, label: string = msg.t) => s.outgoing.push({ label, body: enc.encode(JSON.stringify(msg)) })

  function ensureJoined(s: DeviceState) {
    if (!s.joined && groupId) {
      s.peer.join(groupId)
      s.joined = true
    }
  }

  /** Inhalte öffnen: bekannter Schlüssel, Kette, oder BeeKEM; wiederholen bis Fixpunkt. */
  async function drain(s: KeyState): Promise<Uint8Array[]> {
    const out: Uint8Array[] = []
    let progress = true
    while (progress && s.pending.length) {
      progress = false
      const still: Wire[] = []
      for (const m of s.pending) {
        if (m.t !== 'content') continue
        const ct = unb64(m.c)
        let plain: Uint8Array | undefined
        let key = s.keys.get(m.ref)
        try {
          if (key) {
            plain = BeekemPeer.decryptWithKey(ct, key)
          } else {
            const r = s.peer.decrypt(ct) as { plaintext: Uint8Array; appKey: Uint8Array }
            plain = r.plaintext
            key = r.appKey
          }
        } catch {
          still.push(m)
          continue
        }
        s.keys.set(m.ref, key)
        try {
          const table = await openTable(key, unb64(m.iv), unb64(m.tab))
          for (let i = 0; i + 64 <= table.length; i += 64) {
            const ref = hex(table.subarray(i, i + 32))
            if (!s.keys.has(ref)) s.keys.set(ref, table.slice(i + 32, i + 64))
          }
        } catch {}
        s.heads.push(unhex(m.ref))
        out.push(plain)
        progress = true
      }
      s.pending = still
    }
    return out
  }

  /**
   * Autoritätsoperation ins Log; ihre BeeKEM-Anhänge gehen in den Baum, ob
   * die Operation gilt oder nicht (I4, Schritt 1b). Der Baum hat seine eigene
   * kausale Geschichte: Spielt eine Replik einen Anhang nicht ein, kann sie
   * keine Operation mehr einspielen, die darauf aufbaut (etwa die Rotation
   * eines Schreibers), und die Repliken laufen auseinander. Autorität wirkt
   * deshalb nicht als Tor vor dem Baum, sondern als Reparatur danach:
   * reconcile() gleicht den Baum nach jeder Faltung mit dem Zustand ab.
   */
  function applyAuth(s: DeviceState, op: AuthOp, cgka: string[]) {
    const r = s.auth.add(op)
    if (r === 'wartet') {
      s.waitingAuth.push({ op, cgka })
      return
    }
    if (s.appliedCgka.has(op.id)) return
    s.appliedCgka.add(op.id)
    for (const c of cgka) {
      try {
        s.peer.receive(unb64(c))
      } catch (e) {
        s.notes.push(`cgka: ${(e as Error).message}`)
      }
    }
  }

  /**
   * Der Schlüsselbaum folgt dem Zustand, nie umgekehrt (I4): Blätter von
   * Nicht-Mitgliedern entfernen, fehlende Blätter von Mitgliedern nachziehen,
   * eigene Geräte nachziehen. Jedes Gerät mit Schlüssel repariert; die
   * Reihenfolge Reparatur vor Verschlüsseln hält KV1, und gleichzeitige
   * Reparaturen führt BeeKEM zusammen (KV6).
   */
  async function reconcile(s: DeviceState) {
    await heal(s)
    await ensureMemberLeaves(s)
    await ensureOwnLeaves(s)
  }

  /**
   * Die andere Richtung der Heilung: Fehlt das Blatt eines Mitglieds im Baum
   * (eine Entfernung ist nachträglich verfallen, oder eine Aufnahme wurde erst
   * durch eine andere Operation gültig, nachdem ihre Anhänge nicht mehr
   * passten), nimmt jedes Gerät mit Schlüssel es auf. Gleichzeitige
   * Aufnahmen desselben Blatts führt BeeKEM zusammen (KV6).
   */
  async function ensureMemberLeaves(s: DeviceState) {
    if (!s.auth.members().has(s.person)) return
    const inTree = new Set((s.peer.members() as Uint8Array[]).map(hex))
    const me = hex(new Uint8Array(s.peer.id))
    if (!inTree.has(me)) return
    const missing = [...s.auth.members()].flatMap((p) => cardsOf(s, p).filter((c) => !inTree.has(hex(c.id))))
    if (!missing.length) return
    // Ohne gemeinsamen Schlüssel (nach gleichzeitigen Strukturänderungen zeigt
    // BeeKEM bis zur nächsten eigenen Operation den alten Stand) erst
    // rotieren; sonst bliebe die Reparatur bis zum nächsten Schreiben liegen,
    // und dieser Eintrag ginge am fehlenden Mitglied vorbei.
    if (!s.peer.hasKey()) {
      try {
        const op = (await s.peer.rotate()) as Uint8Array
        send(s, { t: 'cgka', op: b64(op) }, 'heal-rotate')
      } catch (e) {
        s.notes.push(`Reparatur-Rotation: ${(e as Error).message}`)
        return
      }
    }
    for (const p of s.auth.members()) {
      for (const c of cardsOf(s, p)) {
        if (inTree.has(hex(c.id))) continue
        try {
          const op = (await s.peer.add(c.id, c.shareKey)) as Uint8Array | null
          if (op) send(s, { t: 'cgka', op: b64(op) }, 'heal-add')
        } catch (e) {
          s.notes.push(`Blatt nachziehen: ${(e as Error).message}`)
        }
      }
    }
  }

  async function processAuth(s: DeviceState, op: AuthOp, cgka: string[]) {
    applyAuth(s, op, cgka)
    // Wartende nachziehen.
    let progress = true
    while (progress) {
      progress = false
      const rest: typeof s.waitingAuth = []
      for (const w of s.waitingAuth) {
        if (w.op.preds.every((p) => s.auth.has(p))) {
          applyAuth(s, w.op, w.cgka)
          progress = true
        } else rest.push(w)
      }
      s.waitingAuth = rest
    }
    await reconcile(s)
  }

  /**
   * Geräte einer Person: Wer selbst Mitglied ist und den Schlüssel hält, nimmt
   * die noch fehlenden Blätter der eigenen Geräte in den Baum auf. Das Log
   * kennt nur die Person; die Bindung Gerät→Person kommt aus der Karte.
   */
  async function ensureOwnLeaves(s: DeviceState) {
    if (!s.auth.members().has(s.person)) return
    const inTree = new Set((s.peer.members() as Uint8Array[]).map(hex))
    const me = hex(new Uint8Array(s.peer.id))
    if (!inTree.has(me)) return
    for (const c of cardsOf(s, s.person)) {
      if (inTree.has(hex(c.id)) || hex(c.id) === me) continue
      try {
        const op = (await s.peer.add(c.id, c.shareKey)) as Uint8Array | null
        if (op) send(s, { t: 'cgka', op: b64(op) }, 'device-add')
      } catch (e) {
        s.notes.push(`eigenes Gerät: ${(e as Error).message}`)
      }
    }
  }

  /**
   * Heilung: Steht jemand im Schlüsselbaum, der laut Log nicht Mitglied ist
   * (Aufnahme ungültig, Entfernung ohne Autorität eingespielt), entfernt ihn
   * jedes Mitglied mit Schlüssel aus BeeKEM. Das ist keine
   * Mitgliedschaftsentscheidung (die trifft das Log), sondern das Angleichen
   * des Baums; deshalb kein Politik-Quorum. Doppelte Entfernungen sind No-ops.
   */
  async function heal(s: DeviceState) {
    const members = s.auth.members()
    if (!members.has(s.person) || !s.peer.hasKey()) return
    const allowed = new Set([...members.keys()].flatMap((p) => cardsOf(s, p).map((c) => hex(c.id))))
    for (const idBytes of s.peer.members() as Uint8Array[]) {
      if (allowed.has(hex(idBytes))) continue
      try {
        const op = (await s.peer.remove(idBytes)) as Uint8Array | null
        if (op) send(s, { t: 'cgka', op: b64(op) }, 'heal')
      } catch (e) {
        s.notes.push(`heilen: ${(e as Error).message}`)
      }
    }
  }

  /**
   * E8 Sichten: Weicht der eigene Stand von der zuletzt bestätigten Sicht ab,
   * schlägt das Gerät die Sicht seines Stands vor (seq+1, Vorgänger = Hash
   * der bestätigten). Alle Mitgliedsgeräte tun das; der Dienst zählt
   * gleichlautende Vorschläge als Unterschriften. m für die nächste Sicht:
   * 2, sobald zwei Identitäten da sind (Empfehlung in §7.3).
   */
  function proposeView(s: DeviceState) {
    if (options.dienst !== 'sichten') return
    const members = s.auth.members()
    if (!members.has(s.person)) return
    const identities = [...members.keys()].flatMap((p) => cardsOf(s, p).map((c) => hex(c.id))).sort()
    const me = hex(new Uint8Array(s.peer.id))
    if (!identities.includes(me)) return
    if (JSON.stringify(identities) === JSON.stringify(s.ack.identities)) return
    const v: ViewProposal = { t: 'view', seq: s.ack.seq + 1, prev: s.ack.hash, identities, m: Math.min(2, identities.length), signer: me }
    const h = viewHash(v)
    if (h === s.proposed) return
    s.proposed = h
    send(s, v)
  }

  function personMembers(s: DeviceState): Person[] {
    return [...s.auth.members().keys()].sort()
  }

  async function handle(s: DeviceState, m: Wire): Promise<{ content: Uint8Array[] }> {
    switch (m.t) {
      case 'card':
        s.cards.set(m.id, { person: m.person, id: unhex(m.id), shareKey: unhex(m.shareKey) })
        await reconcile(s)
        return { content: [] }
      case 'revoke':
        s.revoked.add(m.id)
        await reconcile(s)
        return { content: [] }
      case 'view':
        return { content: [] } // Vorschläge anderer gehen an den Dienst
      case 'ack':
        s.ack = { seq: m.seq, hash: m.hash, identities: m.identities }
        s.proposed = null
        return { content: [] }
      case 'auth':
        if (m.group && !groupId) groupId = unhex(m.group)
        ensureJoined(s)
        await processAuth(s, m.op, m.cgka)
        return { content: await drain(s) }
      case 'cgka':
        ensureJoined(s)
        try {
          s.peer.receive(unb64(m.op))
        } catch (e) {
          s.notes.push(`cgka: ${(e as Error).message}`)
        }
        await reconcile(s)
        return { content: await drain(s) }
      case 'content':
        s.pending.push(m)
        return { content: await drain(s) }
    }
  }

  return {
    id: options.dienst ? `rltp-beekem-${options.dienst}` : 'rltp-beekem',
    capabilities: new Set<Capability>(['roles', 'policy', 'rotate', 'steal', 'multi-device', 'device-remove', ...(service ? (['service'] as Capability[]) : [])]),
    service,

    async addDevice(person, device) {
      await loadWasm()
      signerOf(person)
      const peer = new BeekemPeer()
      const card: Card = { person, id: new Uint8Array(peer.id), shareKey: new Uint8Array(peer.shareKey) }
      const s: DeviceState = { person, peer, auth: new AuthorityLog(), cards: new Map([[hex(card.id), card]]), revoked: new Set(), ack: { seq: 0, hash: null, identities: [] }, proposed: null, waitingAuth: [], appliedCgka: new Set(), keys: new Map(), heads: [], pending: [], outgoing: [], joined: false, notes: [] }
      devices.set(device, s)
      send(s, { t: 'card', person, id: hex(card.id), shareKey: hex(card.shareKey) })
    },

    async createGroup(d) {
      const s = dev(d)
      // Gruppen-DID: ein Ed25519-Schlüssel, der die Genesis mitsigniert und danach verworfen wird (RLTP-ACC-3060).
      const group = Signer.generate('group')
      groupId = unhex(group.pub)
      const ops = (await s.peer.create(groupId)) as Uint8Array[]
      s.joined = true
      const op = s.auth.make({ kind: 'create', subject: s.person, key: signerOf(s.person).pub, policy: adminPolicy([s.person]), group: group.pub }, [signerOf(s.person), group])
      s.auth.add(op)
      s.appliedCgka.add(op.id)
      send(s, { t: 'auth', op, group: hex(groupId), cgka: ops.map(b64) })
      proposeView(s)
    },

    async addMember(by, p, role) {
      const s = dev(by)
      const known = cardsOf(s, p)
      if (!known.length) throw new Error(`unbekannte Person ${p}`)
      const op = s.auth.make({ kind: 'add', subject: p, key: signerOf(p).pub }, [signerOf(s.person)])
      s.auth.add(op)
      const cgka: string[] = []
      if (s.auth.isValid(op.id)) {
        // Alle bekannten Geräte der Person; spätere Geräte nimmt die Person selbst auf.
        for (const card of known) {
          const c = (await s.peer.add(card.id, card.shareKey)) as Uint8Array | null
          if (c) cgka.push(b64(c))
        }
      }
      s.appliedCgka.add(op.id)
      send(s, { t: 'auth', op, cgka })
      // „Admin“ ist kein Rollen-Flag, sondern ein Eintrag in den actors der
      // Politik. Die Beförderung gilt nur, solange diese Aufnahme gilt (#18):
      // sonst bliebe eine verwaiste Beförderung liegen und würde bei einer
      // späteren gewöhnlichen Aufnahme wirksam.
      if (role === 'admin') {
        const current = s.auth.policy()
        const next = promoteInPolicy(current, p)
        if (JSON.stringify(next) !== JSON.stringify(current)) {
          const change = s.auth.make({ kind: 'policy', policy: next, dependsOn: [op.id] }, [signerOf(s.person)])
          s.auth.add(change)
          send(s, { t: 'auth', op: change, cgka: [] }, 'policy')
        }
      }
      proposeView(s)
    },

    async removeMember(by, p) {
      const s = dev(by)
      // Ob p entfernt werden kann, entscheidet das Log, nicht die Kartentabelle:
      // Nach Widerruf des letzten Geräts hat p keine Karte mehr, ist aber Mitglied (Issue #13).
      const op = s.auth.make({ kind: 'remove', subject: p }, [signerOf(s.person)])
      s.auth.add(op)
      const cgka: string[] = []
      if (s.auth.isValid(op.id)) {
        // Die Person geht, also jedes ihrer Blätter.
        const inTree = new Set((s.peer.members() as Uint8Array[]).map(hex))
        for (const card of cardsOf(s, p)) {
          if (!inTree.has(hex(card.id))) continue
          try {
            const c = (await s.peer.remove(card.id)) as Uint8Array | null
            if (c) cgka.push(b64(c))
          } catch (e) {
            notes.push(`${by} entfernt ${p}: ${(e as Error).message}`)
          }
        }
      }
      s.appliedCgka.add(op.id)
      send(s, { t: 'auth', op, cgka })
      proposeView(s)
    },

    async removeDevice(by, device) {
      const s = dev(by)
      const target = dev(device)
      const id = new Uint8Array(target.peer.id)
      const admin = s.auth.may(s.person, 'member.remove')
      if (target.person !== s.person && !admin) throw new Error(`${by} darf ${device} nicht entfernen`)
      s.revoked.add(hex(id))
      send(s, { t: 'revoke', id: hex(id) })
      try {
        const c = (await s.peer.remove(id)) as Uint8Array | null
        if (c) send(s, { t: 'cgka', op: b64(c) }, 'device-remove')
      } catch (e) {
        notes.push(`${by} entfernt Gerät ${device}: ${(e as Error).message}`)
      }
      proposeView(s)
    },

    async rotate(by) {
      const s = dev(by)
      const op = (await s.peer.rotate()) as Uint8Array
      send(s, { t: 'cgka', op: b64(op) }, 'rotate')
    },
    /**
     * Regeländerung als policy.change. Der Tag wählt die Regel:
     * remove:threshold:N · remove:any-member · add:vouch:N · sonst dieselben
     * Regeln neu beschlossen (eine Änderung muss nichts ändern).
     */
    async changePolicy(by, tag) {
      const s = dev(by)
      const current = s.auth.policy()
      const next: Policy = { ...current }
      const m = /^(remove|add):(threshold|vouch|any-member)(?::(\d+))?$/.exec(tag)
      if (m) {
        const key = m[1] === 'remove' ? 'member.remove' : 'member.add'
        const n = Number(m[3] ?? 1)
        next[key] = m[2] === 'threshold' ? { type: 'threshold', k: n } : m[2] === 'any-member' ? { type: 'any-member' } : { type: 'all', of: [next[key], { type: 'vouch', count: n }] }
      }
      const op = s.auth.make({ kind: 'policy', policy: next }, [signerOf(s.person)])
      s.auth.add(op)
      send(s, { t: 'auth', op, cgka: [] }, 'policy')
      proposeView(s)
    },

    async sealContent(d, update) {
      const s = dev(d)
      // Erst der Baum zum Zustand, dann verschlüsseln (I4).
      await reconcile(s)
      try {
        const ref = await sha256(update)
        const r = (await s.peer.encrypt(ref, s.heads, update)) as { ciphertext: Uint8Array; updateOp: Uint8Array | null; appKey: Uint8Array }
        if (r.updateOp) send(s, { t: 'cgka', op: b64(r.updateOp) }, 'update')
        const entries = s.heads.flatMap((h) => {
          const k = s.keys.get(hex(h))
          return k ? [h, k] : []
        })
        const table = new Uint8Array(entries.length * 32)
        entries.forEach((x, i) => table.set(x, i * 32))
        const { iv, ct } = await sealTable(r.appKey, table)
        s.keys.set(hex(ref), r.appKey)
        s.heads = [ref]
        send(s, { t: 'content', c: b64(r.ciphertext), iv: b64(iv), tab: b64(ct), ref: hex(ref) })
      } catch (e) {
        notes.push(`${d} schreibt: ${(e as Error).message}`)
      }
    },
    takeOutgoing: (d) => dev(d).outgoing.splice(0),

    async receive(d, msg: Msg) {
      const s = dev(d)
      const m = JSON.parse(dec.decode(msg.body)) as Wire
      try {
        return await handle(s, m)
      } finally {
        proposeView(s)
      }
    },
    members: (d) => personMembers(dev(d)),
    status: (d) => {
      const s = dev(d)
      return [`baum=${(s.peer.members() as Uint8Array[]).length}`, `schlüssel=${s.peer.hasKey() ? 'ja' : 'nein'}`, `fork=${s.auth.forked() ? 'ja' : 'nein'}`, `regeln=v${s.auth.policyVersion()}`, ...s.notes.slice(0, 3), ...notes.slice(0, 2)].join('; ')
    },

    async steal(d) {
      const s = dev(d)
      return { state: new Uint8Array(s.peer.exportState()), keys: new Map([...s.keys].map(([k, v]) => [k, v.slice()] as const)) }
    },
    async attackerOpen(stolen, msg: Msg) {
      // Passiver Angreifer mit Bobs Zustand: nimmt alle BeeKEM-Operationen auf,
      // öffnet Inhalte wie ein ehrliches Gerät.
      const st = stolen as { state: Uint8Array; keys: Map<string, Uint8Array>; ks?: KeyState }
      st.ks ??= { peer: BeekemPeer.fromState(st.state), keys: st.keys, heads: [], pending: [] }
      const m = JSON.parse(dec.decode(msg.body)) as Wire
      const ops = m.t === 'cgka' ? [m.op] : m.t === 'auth' ? m.cgka : []
      for (const op of ops) {
        try {
          st.ks.peer.receive(unb64(op))
        } catch {}
      }
      if (m.t === 'content') st.ks.pending.push(m)
      return drain(st.ks)
    },
  }
}
