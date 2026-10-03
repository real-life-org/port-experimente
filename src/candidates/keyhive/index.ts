import {
  Access,
  Archive,
  ChangeId,
  CiphertextStore,
  ContactCard,
  DocumentId,
  Encrypted,
  GroupId,
  Identifier,
  Keyhive,
  MemberedId,
  Signer,
  symmetricDecrypt,
  symmetricEncrypt,
} from '@keyhive/keyhive/slim'
import type { Candidate, Capability, Device, Msg, Person } from '../../lab/types'
import { loadKeyhive } from './load'

// Keyhive (Ink & Switch) über @keyhive/keyhive 0.3.0-alpha.1, ohne Automerge:
// Inhalt bleibt Yjs. Der Prüfstand liefert Change-IDs (SHA-256 des Updates).
// Port-Notizen: NOTES.md.

interface DeviceState {
  person: Person
  kh: Keyhive
  signerSecret: Uint8Array
  outgoing: Array<{ label: string; body: Uint8Array }>
  members: Person[]
  /** Inhalte, die (noch) nicht entschlüsselt werden konnten. */
  pending: Uint8Array[]
  /** Während des Aufnehmens fremder Ereignisse nichts weiterleiten (wie ARK). */
  ingesting: boolean
  /**
   * Kausale Vorgänger für den nächsten Eintrag: alle seit dem letzten eigenen
   * Eintrag gesehenen Einträge. Keyhives kausale Verschlüsselung braucht
   * diesen Inhalts-DAG; Yjs liefert ihn nicht, der Kandidat baut ihn.
   */
  heads: Uint8Array[]
  /** Anwendungsschlüssel je Eintrag (hex der Change-ID), aus CGKA oder aus der Vorgänger-Kette. */
  keys: Map<string, Uint8Array>
}

// Hülle wie in ARK (blob-interceptor): [4] Länge innen (LE) · innen = Keyhive
// Encrypted · predsCipher = symmetricEncrypt(eigenerSchlüssel, je 32 B Change-ID
// + 32 B Schlüssel der Vorgänger). Wer einen Eintrag öffnen kann, kommt so an
// die Schlüssel der Vorgänger: die kausale Kette für die Historie (P3).
function envelope(inner: Uint8Array, preds: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + inner.length + preds.length)
  new DataView(out.buffer).setUint32(0, inner.length, true)
  out.set(inner, 4)
  out.set(preds, 4 + inner.length)
  return out
}
function unwrap(b: Uint8Array): { inner: Uint8Array; preds: Uint8Array } {
  const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, true)
  return { inner: b.subarray(4, 4 + n), preds: b.subarray(4 + n) }
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const enc = new TextEncoder()
const dec = new TextDecoder()

async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', b))
}

export function keyhive(): Candidate {
  const devices = new Map<Device, DeviceState>()
  const idOf = new Map<Person, Uint8Array>()
  const personOf = new Map<string, Person>()
  const notes: string[] = []
  let docIdBytes: Uint8Array | undefined
  let groupIdBytes: Uint8Array | undefined

  const dev = (d: Device) => {
    const s = devices.get(d)
    if (!s) throw new Error(`unbekanntes Gerät ${d}`)
    return s
  }
  const docId = () => {
    if (!docIdBytes) throw new Error('kein Dokument')
    return new DocumentId(docIdBytes)
  }
  const membered = () => MemberedId.document(docId())
  const adminGroup = () => {
    if (!groupIdBytes) throw new Error('keine Admin-Gruppe')
    return MemberedId.group(new GroupId(groupIdBytes))
  }

  async function refresh(s: DeviceState) {
    if (!docIdBytes || !(await s.kh.hasDocument(docId()))) {
      s.members = []
      return
    }
    // Transitiv: direkte Mitglieder des Dokuments und Mitglieder der Admin-Gruppe.
    const caps = await s.kh.docMemberCapabilities(docId())
    const people = new Set<Person>()
    for (const c of caps) {
      const p = personOf.get(hex(c.who.id.toBytes()))
      if (p) people.add(p)
    }
    s.members = [...people].sort()
  }

  /**
   * Versucht zurückgehaltene Inhalte erneut, bis sich nichts mehr bewegt:
   * Ein neuer Eintrag kann die Schlüssel älterer Einträge mitbringen
   * (kausale Verschlüsselung).
   */
  async function drain(s: Pick<DeviceState, 'kh' | 'pending' | 'keys' | 'heads'>): Promise<Uint8Array[]> {
    const out: Uint8Array[] = []
    if (!docIdBytes) return out
    let progress = true
    while (progress && s.pending.length) {
      progress = false
      const still: Uint8Array[] = []
      for (const b of s.pending) {
        const { inner, preds } = unwrap(b)
        const e = Encrypted.fromBytes(inner)
        const ref = e.contentRef()
        let plain: Uint8Array | undefined
        let key = s.keys.get(hex(ref))
        try {
          if (key) {
            plain = e.decryptWithKey(key) // über die Kette eines Nachfolgers
          } else {
            const r = await s.kh.tryDecryptKeyed(docId(), e) // über CGKA
            plain = r.plaintext()
            key = r.applicationSecret
          }
        } catch {
          still.push(b)
          continue
        }
        s.keys.set(hex(ref), key)
        const table = symmetricDecrypt(key, preds)
        for (let i = 0; i + 64 <= table.length; i += 64) {
          const id = hex(table.subarray(i, i + 32))
          if (!s.keys.has(id)) s.keys.set(id, table.slice(i + 32, i + 64))
        }
        s.heads.push(ref)
        out.push(plain)
        progress = true
      }
      s.pending = still
    }
    return out
  }

  return {
    id: 'keyhive',
    capabilities: new Set<Capability>(['roles', 'rotate', 'steal']),

    async addDevice(person, device) {
      await loadKeyhive()
      if (idOf.has(person)) throw new Error('mehrere Geräte je Person noch nicht verdrahtet')
      const signerSecret = crypto.getRandomValues(new Uint8Array(32))
      const outgoing: DeviceState['outgoing'] = []
      const holder: { s?: DeviceState } = {}
      const kh = await Keyhive.init(Signer.memorySignerFromBytes(signerSecret), CiphertextStore.newInMemory(), (event: { toBytes(): Uint8Array }) => {
        if (holder.s?.ingesting) return
        outgoing.push({ label: 'event', body: event.toBytes() })
      })
      const s: DeviceState = { person, kh, signerSecret, outgoing, members: [], pending: [], ingesting: false, heads: [], keys: new Map() }
      holder.s = s
      devices.set(device, s)
      const id = kh.id.toBytes()
      idOf.set(person, id)
      personOf.set(hex(id), person)
      // Kontaktkarte veröffentlichen (enthält Pre-Keys), damit andere einladen können.
      outgoing.push({ label: 'card', body: enc.encode((await kh.contactCard()).toJson()) })
    },

    // Wie in der README/ARK: Eine Admin-Gruppe ist Miteigentümerin des Dokuments.
    // Admins kommen in die Gruppe, Mitglieder direkt ans Dokument. Nur so darf ein
    // Admin auch Delegationen widerrufen, die er nicht selbst ausgestellt hat.
    async createGroup(d) {
      const s = dev(d)
      const group = await s.kh.generateGroup([])
      groupIdBytes = group.toBytes()
      const head = new ChangeId(await sha256(enc.encode('pruefstand-start')))
      const doc = await s.kh.generateDocument([group.toIdentifier()], head, [])
      docIdBytes = doc.toBytes()
      await refresh(s)
    },
    async addMember(by, p, role) {
      const s = dev(by)
      const id = idOf.get(p)
      if (!id) throw new Error(`unbekannte Person ${p}`)
      if (role === 'admin') await s.kh.addMember(new Identifier(id), adminGroup(), Access.admin(), [docId()])
      else await s.kh.addMember(new Identifier(id), membered(), Access.edit(), [])
      await refresh(s)
    },
    async removeMember(by, p) {
      const s = dev(by)
      const who = new Identifier(idOf.get(p)!)
      // retain_all_other_members = false: Keyhives Kaskade; wer über die
      // entfernte Person eingeladen wurde, fällt mit heraus (vgl. Regel (d)).
      for (const target of [adminGroup(), membered()]) {
        try {
          await s.kh.revokeMember(who, false, target)
        } catch (e) {
          const msg = String((e as Error).message ?? e)
          if (!/not found|NotFound/i.test(msg)) notes.push(`${by} entfernt ${p}: ${msg}`)
        }
      }
      await refresh(s)
    },
    async rotate(by) {
      await dev(by).kh.forcePcsUpdate(docId())
    },
    async changePolicy() {
      throw new Error('keine Gruppenregeln')
    },

    async sealContent(d, update) {
      const s = dev(d)
      try {
        const refBytes = await sha256(update)
        // Wie ARK: Keyhive ohne Vorgänger aufrufen, die Kette läuft außen herum.
        const res = await s.kh.tryEncryptKeyed(docId(), new ChangeId(refBytes), [], update)
        const selfKey = res.applicationSecret
        const entries = s.heads.flatMap((h) => {
          const k = s.keys.get(hex(h))
          return k ? [h, k] : []
        })
        const table = new Uint8Array(entries.reduce((n, x) => n + x.length, 0))
        let off = 0
        for (const x of entries) {
          table.set(x, off)
          off += x.length
        }
        const preds = symmetricEncrypt(selfKey, table, refBytes)
        s.keys.set(hex(refBytes), selfKey)
        s.heads = [refBytes]
        s.outgoing.push({ label: 'content', body: envelope(res.encryptedContent().toBytes(), preds) })
      } catch (e) {
        notes.push(`${d} schreibt: ${(e as Error).message ?? e}`)
      }
    },
    takeOutgoing: (d) => dev(d).outgoing.splice(0),

    async receive(d, msg) {
      const s = dev(d)
      if (msg.label === 'card') {
        await s.kh.receiveContactCard(ContactCard.fromJson(dec.decode(msg.body)))
        return { content: [] }
      }
      if (msg.label === 'event') {
        s.ingesting = true
        try {
          await s.kh.ingestEventsBytes([msg.body])
        } catch (e) {
          notes.push(`${d} nimmt Ereignis auf: ${(e as Error).message ?? e}`)
        } finally {
          s.ingesting = false
        }
        await refresh(s)
        return { content: await drain(s) }
      }
      // Inhalt: vormerken und alles Vorgemerkte versuchen.
      s.pending.push(msg.body)
      return { content: await drain(s) }
    },

    members: (d) => dev(d).members,
    status: (d) => [`ausstehend=${dev(d).pending.length}`, ...notes.slice(0, 4)].join('; '),

    async steal(d) {
      // Ganzer Gerätezustand: Keyhive-Archiv, Signierschlüssel und die
      // Schlüsseltabelle der App (Vorgänger-Kette).
      const s = dev(d)
      return {
        archive: (await s.kh.toArchive()).toBytes(),
        secret: s.signerSecret.slice(),
        keys: new Map([...s.keys].map(([k, v]) => [k, v.slice()] as const)),
      }
    },
    async attackerOpen(stolen, msg: Msg) {
      // Der Angreifer wertet Nachrichten mit derselben Logik aus wie ein
      // ehrliches Gerät: Ereignisse aufnehmen, Inhalte über bekannte Schlüssel,
      // Vorgänger-Kette oder CGKA öffnen, mit Wiederholung.
      const st = stolen as {
        archive: Uint8Array
        secret: Uint8Array
        keys: Map<string, Uint8Array>
        state?: Pick<DeviceState, 'kh' | 'pending' | 'keys' | 'heads'>
      }
      st.state ??= {
        kh: await new Archive(st.archive).tryToKeyhive(CiphertextStore.newInMemory(), Signer.memorySignerFromBytes(st.secret), () => {}),
        pending: [],
        keys: st.keys,
        heads: [],
      }
      if (msg.label === 'event') {
        await st.state.kh.ingestEventsBytes([msg.body]).catch(() => {})
        return drain(st.state)
      }
      if (msg.label !== 'content') return []
      st.state.pending.push(msg.body)
      return drain(st.state)
    },
  }
}
