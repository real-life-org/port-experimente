import type { Candidate, Capability, Device, EnforcingService, Msg, Person } from '../../lab/types'
import { AuthorityLog, Signer, promoteInPolicy, wellFormed, type AuthOp, type Policy } from './authority'
import { beekemPort, mlsPort, type KeyPeer, type KeyPort } from './keyport'
import { LogReplicaService, ViewService, signView, targetDigest, verifyTarget, viewHash, type Challenge, type ChallengeAnswer, type MRule, type Target, type ViewAck, type ViewProposal } from './service'
import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 as sha256Sync } from '@noble/hashes/sha2.js'

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
// E10: Versiegelte Rahmen. Alles, was über den Träger der Gruppe geht, ist
// ein Eintrag unter dem Epochenschlüssel (Replication „key-blind by
// construction“): Autoritätsoperationen, Widerrufe, Reparaturanfragen,
// Inhalte. Nur drei Dinge bleiben außen: BeeKEM-Operationen (selbst
// Chiffretext an die Blätter), das Willkommen an ein neues Gerät (an dessen
// Gerätschlüssel verschlüsselt, minimale Zustellung im Prüfstand) und die
// Karten, die über den Begegnungskanal gehen, nicht über den Träger.
// Port-Notizen: NOTES.md.

const enc = new TextEncoder()
const dec = new TextDecoder()
// Kodierungen: in Node über Buffer (die zeichenweisen Varianten waren im Profil der Lastmessung 40 % der Zeit), im Browser über atob/btoa.
const B = (globalThis as { Buffer?: { from(x: string | Uint8Array, enc?: string): { toString(enc: string): string; buffer: ArrayBuffer; byteOffset: number; byteLength: number } } }).Buffer
const hex = (b: Uint8Array) => (B ? B.from(b).toString('hex') : Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''))
const unhex = (h: string) => {
  if (B) {
    const x = B.from(h, 'hex')
    return new Uint8Array(x.buffer, x.byteOffset, x.byteLength).slice()
  }
  return Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)))
}
const b64 = (b: Uint8Array) => (B ? B.from(b).toString('base64') : btoa(String.fromCharCode(...b)))
const unb64 = (s: string) => {
  if (B) {
    const x = B.from(s, 'base64')
    return new Uint8Array(x.buffer, x.byteOffset, x.byteLength).slice()
  }
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b))

/** Vorgänger-Tabelle (je 32 B Referenz + 32 B Schlüssel) unter dem Eintragsschlüssel, AES-GCM. */
async function sealTable(key: Uint8Array, table: Uint8Array) {
  const k = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, table))
  return { iv, ct }
}

/**
 * Willkommen an ein Gerät: X25519 (flüchtiger Schlüssel gegen den
 * Willkommensschlüssel der Karte), HKDF-SHA256, AES-GCM. Die minimale
 * Zustellung des Prüfstands; E11 ersetzt sie durch den Zustellungs-Adapter.
 */
export async function sealTo(pub: Uint8Array, plain: Uint8Array) {
  const ephPriv = x25519.utils.randomSecretKey()
  const eph = x25519.getPublicKey(ephPriv)
  const shared = x25519.getSharedSecret(ephPriv, pub)
  const key = hkdf(sha256Sync, shared, new Uint8Array([...eph, ...pub]), enc.encode('rltp-welcome'), 32)
  const { iv, ct } = await sealTable(key, plain)
  return { eph, iv, ct }
}
export async function openFrom(priv: Uint8Array, eph: Uint8Array, iv: Uint8Array, ct: Uint8Array) {
  const pub = x25519.getPublicKey(priv)
  const shared = x25519.getSharedSecret(priv, eph)
  const key = hkdf(sha256Sync, shared, new Uint8Array([...eph, ...pub]), enc.encode('rltp-welcome'), 32)
  return openTable(key, iv, ct)
}
async function openTable(key: Uint8Array, iv: Uint8Array, ct: Uint8Array) {
  const k = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt'])
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k, ct))
}

type Wire =
  /** Karte eines Geräts; geht über den Begegnungskanal, nie über den Träger. `welcomeKey`: X25519 für das Willkommen. */
  | { t: 'card'; person: Person; id: string; shareKey: string; deviceKey: string; welcomeKey: string }
  | { t: 'auth'; op: AuthOp; group?: string; cgka: string[] }
  | { t: 'cgka'; op: string }
  /** Widerruf eines einzelnen Geräts (verloren); die Person bleibt. */
  | { t: 'revoke'; id: string }
  /** Inhalt (innen): ein Yjs-Update. */
  | { t: 'content'; u: string }
  /**
   * Versiegelter Eintrag: `c` ist ein innerer Rahmen unter dem Eintragsschlüssel
   * (BeeKEM), `tab` die Vorgänger-Tabelle. Umschlag im Klartext: `kind` (Art
   * des inneren Rahmens, für den Dienst), `heads` (Autoritätsköpfe des
   * Schreibers), `by` (sein Geräteschlüssel).
   */
  | { t: 'sealed'; kind: string; c: string; iv: string; tab: string; ref: string; heads: string[]; by: string; keyOp?: string; digest?: string }
  /** Willkommen an genau ein Gerät (`to` = sein Willkommensschlüssel): Gruppe und Aufnahme, an seinen Schlüssel verschlüsselt. */
  | { t: 'welcome'; to: string; eph: string; iv: string; c: string }
  /** An den Dienst: sein beglaubigtes Ziel (Replication §4.1) bzw. gespeicherte Einträge nach Referenz (I1, I12). Unversiegelt: nur IDs. */
  | { t: 'target-request'; nonce: string; since: number }
  | { t: 'fetch'; refs: string[] }
  | Target
  /**
   * Reparaturanfrage (Replication I12): adressiert an die Geräte `to`, mit
   * den fehlenden Vorgängern `missing`, dem Beleg `evidence` (die Einträge,
   * die sie nennen) und den eigenen Köpfen `have`, damit die Quelle nur den
   * Unterschied schickt.
   */
  | { t: 'repair'; from: string; to: string[]; missing: string[]; evidence: string[]; have: string[] }
  | ViewProposal
  | ViewAck
  | Challenge
  | ChallengeAnswer

interface KeyState {
  peer: KeyPeer
  /** Anwendungsschlüssel je Eintrag (hex der Referenz), aus BeeKEM oder aus der Kette. */
  keys: Map<string, Uint8Array>
  heads: Uint8Array[]
  pending: Wire[]
  /** Schlüsselgeneration: zählt hoch, wenn ein Schlüssel dazukommt (BeeKEM-Operation, Tabelle). Ein ungeöffneter Rahmen wird nur erneut versucht, wenn sich seitdem etwas geändert hat; sonst wären die Versuche quadratisch. */
  keyGen: number
  /**
   * Empfangsgrenze (Review zu #36, Runde 3). Drei Aussagen, drei Zustände:
   * `stored` = die Bytes eines Eintrags liegen hier, identifiziert durch den Digest der Bytes (verifiziert gespeichert,
   * unabhängig vom Schlüssel); `keys`/`heads` = entschlüsselt; die Autorität urteilt danach. Zielfortschritt kommt
   * nur aus `stored`; Entschlüsselung und ihr Versuchszähler liegen dahinter und entscheiden nichts darüber.
   */
  stored: Set<string>
  /** Je Rahmen (nach Digest der Bytes): Generation beim Eintreffen, Generation des letzten BeeKEM-Versuchs und Zahl der Versuche (höchstens MAX_DECRYPT_TRIES; danach öffnet ihn nur noch eine Tabelle). Eine andere Kopie derselben Referenz hat ihre eigenen Versuche. */
  tried: Map<string, { arrived: number; gen: number; n: number }>
  /** Umschläge geöffneter Einträge (Köpfe, Autor), bis alle genannten Köpfe im Log sind: der Beleg einer Lücke. Nur geöffnete Einträge belegen; ein Umschlag allein ist unverbürgt. */
  envelopes: Map<string, { heads: string[]; by: string }>
  /** Digests der BeeKEM-Operationen, die im Baum sind (keyOpDigest). Ein Rahmen, dessen `keyOp` fehlt, wird gar nicht erst mit BeeKEM versucht; nur die Tabelle kann ihn öffnen. */
  appliedOps: Set<string>
  lastKeyOp?: string
  notes: string[]
}

interface Card {
  person: Person
  id: Uint8Array
  shareKey: Uint8Array
  /** Ed25519-Schlüssel des Geräts (hex): seine Identität gegenüber dem Dienst (Sichten, Besitznachweis). */
  deviceKey: string
  /** X25519-Schlüssel des Geräts (hex) für das Willkommen. */
  welcomeKey: string
}

interface DeviceState extends KeyState {
  person: Person
  auth: AuthorityLog
  /** Geräteschlüssel; signiert Sichtvorschläge und die Challenge des Dienstes. */
  deviceSigner: Signer
  /** Geheimer Willkommensschlüssel (X25519). */
  welcomePriv: Uint8Array
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
  /** Lose BeeKEM-Operationen, die der Baum noch nicht annimmt (Vorgänger fehlen): bei jeder Reparatur erneut versuchen (I2). */
  pendingCgka: string[]
  /** Autoritätsrahmen, wie gesendet oder empfangen, nach Operations-ID: Quellenpflicht (I12, Antwort). */
  authFrames: Map<string, { op: AuthOp; cgka: string[]; group?: string; label: string }>
  /** Reparaturläufe nach fehlender ID (I12): abfragbar zwischen den Läufen, nie still. `attempts` zählt die Anfragen je Lauf. */
  repairs: Map<string, { evidence: Set<string>; to: Set<string>; outcome: 'awaiting-source' | 'repaired'; attempts: number }>
  outgoing: Array<{ label: string; body: Uint8Array; direct?: boolean }>
  /**
   * Beglaubigtes Ziel des Dienstes (D5). `nonce`: die offene Anfrage, nur ein Ziel mit diesem Echo beantwortet sie
   * (Frische: ein altes, gültig signiertes Ziel beantwortet nichts). `digest`/`chain`: Kette, ein neues Ziel muss
   * seq+1 tragen, prev = digest, chain = chain. `missing`: die Referenzen des Ziels, die hier fehlen; nur ein
   * Eintrag mit genau dieser Referenz trägt sie aus (Review zu #36).
   */
  target: { asked: number; answered: number; nonce: string | null; seq: number | null; digest: string | null; chain: string | null; missing: Set<string>; fetched: number; key?: string }
  /** Rahmen, die noch versiegelt hinaus müssen: aus synchronen Pfaden (repair()) oder weil das Gerät gerade keinen Schlüssel hat (Schreiben wartet, ein Mitglied heilt). */
  queued: Array<{ inner: Wire; label: string; heads: string[] }>
  /**
   * Linearer Port: eigene versiegelte Rahmen der letzten Epochen (so weit der Port zurückfallen kann). Verfällt
   * eine Epoche (Tiebreak verloren, oder die eigene Gruppe stand auf einem verfallenen Zweig), sind die darunter
   * versiegelten Rahmen für alle anderen unlesbar: sie wandern nach `stranded` und gehen neu versiegelt hinaus.
   */
  sealed: Array<{ inner: Wire; label: string; heads: string[]; epoch: number }>
  stranded: Array<{ inner: Wire; label: string; heads: string[] }>
  /** Generation beim letzten Durchlauf von retryPendingCgka. */
  retriedAt: number
  joined: boolean
  notes: string[]
}

/** Wie viele Epochen der lineare Port zurückfallen kann (rust/mls-wasm SNAPSHOT_DEPTH). */
const SNAPSHOT_DEPTH = 8

export type DienstVariante = 'sichten' | 'logreplik'

/** Politik, in der die Genannten allein aufnehmen, entfernen und Regeln ändern (strongest = die stärkste davon). */
const adminPolicy = (admins: Person[]): Policy => ({
  'member.add': { type: 'actors', actors: admins, k: 1 },
  'member.remove': { type: 'actors', actors: admins, k: 1 },
  'policy.change': { type: 'strongest' },
})

/**
 * `klartext`: Autoritätsoperationen, Widerrufe und Reparaturen gehen
 * unversiegelt (Inhalte sind immer versiegelt). Nötig für den Dienst der
 * Klasse Log, der das Autoritätslog liest (Access §9.3); sonst aus.
 */
export function rltpBeekem(options: { dienst?: DienstVariante; mRule?: MRule; klartext?: boolean; keyPort?: 'beekem' | 'mls' } = {}): Candidate {
  const klartext = options.klartext ?? options.dienst === 'logreplik'
  const port: KeyPort = options.keyPort === 'mls' ? mlsPort : beekemPort
  const devices = new Map<Device, DeviceState>()
  // Ein Signierschlüssel je Person, über ihre Geräte geteilt (wie heute der Seed).
  const persons = new Map<Person, Signer>()
  const signerOf = (p: Person) => {
    let k = persons.get(p)
    if (!k) persons.set(p, (k = Signer.generate(p)))
    return k
  }
  const service: EnforcingService | undefined =
    options.dienst === 'sichten' ? new ViewService(options.mRule) : options.dienst === 'logreplik' ? new LogReplicaService() : undefined
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
  const send = (s: DeviceState, msg: Wire, label: string = msg.t, direct = false) => {
    if (msg.t === 'cgka') noteOp(s, unb64(msg.op))
    s.outgoing.push({ label, body: enc.encode(JSON.stringify(msg)), direct })
  }
  /**
   * Eine Schlüsseloperation ist im Baum (eigene oder empfangene): Digest merken, Generation erhöhen. Idempotent:
   * eine schon verbuchte Operation (Echo, Wiederholung am Träger, Reparaturantwort) ändert weder die Generation
   * noch `lastKeyOp`; sonst trüge der nächste Rahmen eine alte Operation als Schlüsselstand, und ein Neuling, der
   * sie nie angewandt hat, versuchte ihn nie zu öffnen.
   */
  const noteOp = (s: KeyState, op: Uint8Array) => {
    const d = hex(sha256Sync(op))
    if (s.appliedOps.has(d)) return
    s.appliedOps.add(d)
    s.lastKeyOp = d
    s.keyGen++
  }

  /**
   * Ein Eintrag über den Träger: der innere Rahmen unter dem Eintragsschlüssel
   * (BeeKEM encrypt, wie bisher nur der Inhalt), dazu die Vorgänger-Tabelle,
   * damit spätere Leser die Schlüssel der Vorgänger bekommen (Historie ab
   * Genesis, auch für Neulinge). Ohne gemeinsamen Schlüssel erst rotieren.
   */
  async function sendSealed(s: DeviceState, inner: Wire, label: string = inner.t, heads: string[] = s.auth.heads()): Promise<boolean> {
    const built = await buildSealed(s, inner, label, heads)
    if (built) s.outgoing.push(built)
    return !!built
  }

  /**
   * Den versiegelten Rahmen bauen, ohne ihn zu senden: für Entfernungen, die
   * unter dem Schlüssel vor der Entfernung versiegelt werden (der Entfernte
   * muss sie noch öffnen können, Access §10.2) und erst nach den
   * BeeKEM-Anhängen hinausgehen.
   */
  async function buildSealed(s: DeviceState, inner: Wire, label: string, heads: string[]): Promise<{ label: string; body: Uint8Array } | undefined> {
    try {
      if (!s.peer.hasKey()) {
        const op = (await s.peer.rotate()) as Uint8Array
        send(s, { t: 'cgka', op: b64(op) }, 'seal-rotate')
      }
      // Die Empfängermenge eines Eintrags ist der Baum nach der Rotation; eine Rotation führt gleichzeitige
      // Baumänderungen zusammen (KV6), erst danach stehen etwa die Blätter aus einem verfallenen Zweig im Baum.
      // Vor dem Verschlüsseln deshalb immer heilen, auch wenn diese Replik zurückliegt: Vertraulichkeit geht
      // vor Angleichungsruhe (ein zu früh entferntes Blatt zieht ein Mitglied auf dem Stand nach; ein Eintrag
      // an ein Nicht-Mitglied ist nicht rückholbar; #33, S4f). Fremde Blätter nachziehen nur auf dem Stand.
      // Eine Entfernung ist die Ausnahme: sie wird unter dem Schlüssel versiegelt, den der Entfernte noch hat
      // (Access §10.2), sein Blatt bleibt für diesen einen Eintrag Empfänger; alle anderen Fremden nicht.
      const exempt = new Set(inner.t === 'auth' && inner.op.kind === 'remove' && inner.op.subject ? cardsOf(s, inner.op.subject).map((c) => hex(c.id)) : [])
      await heal(s, exempt)
      if (!authInTransit(s)) await ensureMemberLeaves(s)
    } catch {
      // Kein Schlüssel und keine Rotation möglich (das eigene Blatt fehlt im Baum, etwa nach einer
      // gleichzeitigen Entfernung, die später verfällt): der Rahmen wartet, bis ein Mitglied das Blatt
      // nachzieht (I4) und der nächste Rahmen den Schlüssel bringt.
      s.queued.push({ inner, label, heads })
      return undefined
    }
    // Erst wenn jedes Blatt im Baum zu einem Mitglied laut Log gehört, geht ein Eintrag hinaus (#33): nicht
    // allein auf hasKey oder einen vorher passenden Baum vertrauen. Sonst wartet der Rahmen; nur eine
    // Reparaturanfrage geht dann unversiegelt (sie trägt keine Geheimnisse, nur IDs), damit die
    // Lückenreparatur nie an der Vertraulichkeitsregel hängt.
    if (!treeSafe(s, inner)) {
      if (inner.t === 'repair') send(s, inner, label)
      else {
        s.queued.push({ inner, label, heads })
        s.notes.push('schreiben wartet: Blätter im Baum ohne Mitgliedschaft')
      }
      return undefined
    }
    const plain = enc.encode(JSON.stringify(inner))
    // Referenz = Hash über Zufall und Klartext: eindeutig auch für gleichlautende Rahmen (eine erneut
    // gesendete Operation, zwei gleiche Reparaturanfragen), sonst kollidierten ihre Eintragsschlüssel.
    const ref = await sha256(new Uint8Array([...crypto.getRandomValues(new Uint8Array(16)), ...plain]))
    let r: { ciphertext: Uint8Array; updateOp: Uint8Array | null; appKey: Uint8Array }
    try {
      r = (await s.peer.encrypt(ref, s.heads, plain)) as typeof r
    } catch {
      s.queued.push({ inner, label, heads })
      return undefined
    }
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
    const frame: Wire = { t: 'sealed', kind: inner.t, c: b64(r.ciphertext), iv: b64(iv), tab: b64(ct), ref: hex(ref), heads, by: s.deviceSigner.pub, keyOp: s.lastKeyOp }
    if (port.linear) {
      const epoch = s.peer.epoch()
      s.sealed = s.sealed.filter((f) => f.epoch + SNAPSHOT_DEPTH > epoch)
      s.sealed.push({ inner, label, heads, epoch })
    }
    return { label, body: enc.encode(JSON.stringify(frame)) }
  }

  /**
   * Autoritätsoperation hinaus: ihre BeeKEM-Anhänge gehen als eigene
   * Rahmen voraus (sie sind selbst Chiffretext an die Blätter und müssen
   * auch ohne Eintragsschlüssel in den Baum, etwa beim Neuling), die
   * Operation versiegelt hinterher; im Klartextmodus wie früher in einem Rahmen.
   */
  async function sendAuth(s: DeviceState, op: AuthOp, cgka: string[], group?: string, label = 'auth', prebuilt?: { label: string; body: Uint8Array }) {
    s.authFrames.set(op.id, { op, cgka, group, label })
    if (klartext) {
      send(s, { t: 'auth', op, group, cgka }, label)
      return
    }
    for (const c of cgka) send(s, { t: 'cgka', op: c }, 'auth-cgka')
    if (prebuilt) s.outgoing.push(prebuilt)
    else await sendSealed(s, { t: 'auth', op, group, cgka: [] }, label, [...op.preds])
  }

  /** Gehört jedes Blatt im Baum zu einem Mitglied laut Log? Die Empfängermenge eines Eintrags; bei einer Entfernung darf der Entfernte noch dabei sein. */
  const treeSafe = (s: DeviceState, inner: Wire) => {
    const persons = [...s.auth.members()]
    if (inner.t === 'auth' && inner.op.kind === 'remove' && inner.op.subject) persons.push(inner.op.subject)
    const allowed = new Set(persons.flatMap((p) => cardsOf(s, p).map((c) => hex(c.id))))
    return (s.peer.members() as Uint8Array[]).every((id) => allowed.has(hex(id)))
  }

  /** Eine Entfernung wird vor dem Eingriff in den Baum versiegelt (unter dem Schlüssel, den der Entfernte noch hat). */
  const sealBeforeTree = (s: DeviceState, op: AuthOp) => (klartext ? Promise.resolve(undefined) : buildSealed(s, { t: 'auth', op, cgka: [] }, 'auth', [...op.preds]))

  /** Willkommen an ein Gerät: die Gruppe (und die Aufnahme), an seinen Willkommensschlüssel verschlüsselt. */
  async function sendWelcome(s: DeviceState, card: Card, op?: AuthOp, keyWelcome?: { welcome: Uint8Array; commit: string }) {
    if (!groupId) return
    // MLS: das Willkommen des Schlüssel-Ports reist im selben Rahmen (`key`), dazu der Digest genau des Commits, der
    // dieses Gerät aufgenommen hat (`commit`; je Karte ein eigener, nicht der letzte): er kommt für das Gerät nicht
    // mehr anwendbar über die Leitung, gilt aber als sein Schlüsselstand (keyOp der nächsten Rahmen, Öffnungs-Gate
    // der anderen). BeeKEM braucht beides nicht.
    const plain = enc.encode(JSON.stringify({ group: hex(groupId), op, key: keyWelcome ? b64(keyWelcome.welcome) : undefined, commit: keyWelcome?.commit }))
    const { eph, iv, ct } = await sealTo(unhex(card.welcomeKey), plain)
    send(s, { t: 'welcome', to: card.welcomeKey, eph: hex(eph), iv: b64(iv), c: b64(ct) })
  }

  function ensureJoined(s: DeviceState) {
    if (!s.joined && groupId) {
      s.peer.join(groupId)
      s.joined = true
      s.keyGen++
    }
  }

  const MAX_DECRYPT_TRIES = 3
  /**
   * Sperre nur für die Baumangleichung, nie für die Lückenreparatur (Review zu #31, Runde 3: beides an einer
   * Bedingung war ein Zirkel, warten auf Vollständigkeit und zugleich den Weg dorthin sperren).
   *
   * Ein ungeöffneter Autoritätsrahmen heißt: diese Replik weiß, dass ihr Log hinter dem liegt, was im Umlauf
   * ist. Ob der Rahmen noch aufgeht (Schlüssel unterwegs), nie aufgeht (Epoche ohne uns, bis die Tabelle eines
   * späteren Eintrags ihn bringt) oder beschädigt ist, kann sie nicht unterscheiden; der Umschlag ist
   * unverbürgt. In allen drei Fällen gilt dasselbe: Eine Replik, die weiß, dass sie zurückliegt, fasst die
   * Blätter anderer nicht an: kein Entfernen (Heilung) und kein Nachziehen fremder Blätter, sonst nähme sie
   * etwa das Blatt eines eben Aufgenommenen wieder heraus oder das eines eben Entfernten wieder hinein (T2).
   * Das tun die Mitglieder, die auf dem Stand sind (I4: jedes Mitglied mit Schlüssel). Die eigenen Geräte
   * zieht sie weiter nach (ensureOwnLeaves): dafür bürgt der Baum selbst, ohne Schlüssel geht es nicht.
   *
   * Gezielt (Review zu #31, Runde 4): Ein Rahmen zählt nur, wenn seine Schlüsseloperation im Baum ist,
   * also aus einer Epoche stammt, in der diese Replik dabei ist. Ein Rahmen mit unbekannter oder fehlender
   * `keyOp` sagt nichts über dieses Log aus und hält nichts auf. Lesen, Schreiben, eigene Geräte und die
   * Lückenreparatur laufen in jedem Fall weiter.
   */
  const authInTransit = (s: DeviceState) => s.pending.some((m) => m.t === 'sealed' && m.kind === 'auth' && !!m.keyOp && s.appliedOps.has(m.keyOp))
  /** Versiegelte Einträge öffnen: bekannter Schlüssel, Kette, oder BeeKEM; wiederholen bis Fixpunkt. Inhalte als Bytes, andere innere Rahmen zur Verarbeitung. */
  async function drain(s: KeyState): Promise<{ content: Uint8Array[]; inner: Wire[] }> {
    const out: Uint8Array[] = []
    const inner: Wire[] = []
    let progress = true
    while (progress && s.pending.length) {
      progress = false
      const still: Wire[] = []
      for (const m of s.pending) {
        if (m.t !== 'sealed') continue
        let plain: Uint8Array | undefined
        let key = s.keys.get(m.ref)
        // Ohne bekannten Schlüssel nur mit BeeKEM versuchen, wenn die Schlüsseloperation des Schreibers im
        // Baum ist, sich seit dem letzten Versuch etwas geändert hat und die Versuche nicht erschöpft sind.
        // Ein BeeKEM-Versuch kostet bei 30 Mitgliedern über 10 ms (Serialisierung und Hashing des Baums),
        // und ein Rahmen aus einer Epoche ohne uns öffnet sich nie: danach nur noch über die Tabelle eines
        // späteren Eintrags (die Kette reicht bis zur Genesis).
        const id = m.digest ?? m.ref
        if (!key) {
          const t = s.tried.get(id)
          // Kein Gate auf hasKey: ohne aktuellen Schlüssel öffnet BeeKEM noch Einträge früherer Epochen (eine
          // Entfernung ist unter dem Schlüssel davor versiegelt und kommt nach ihrer Baumoperation an).
          if ((m.keyOp && !s.appliedOps.has(m.keyOp)) || (t && (t.gen === s.keyGen || t.n >= MAX_DECRYPT_TRIES))) {
            still.push(m)
            continue
          }
          s.tried.set(id, { arrived: t?.arrived ?? s.keyGen, gen: s.keyGen, n: (t?.n ?? 0) + 1 })
        }
        const ct = unb64(m.c)
        try {
          if (key) {
            plain = s.peer.decryptWithKey(ct, key)
          } else {
            const r = s.peer.decrypt(ct) as { plaintext: Uint8Array; appKey: Uint8Array }
            plain = r.plaintext
            key = r.appKey
          }
        } catch {
          // Schlüssel bekannt und trotzdem nicht zu öffnen: der Eintrag ist beschädigt (Träger, T5). Er fliegt
          // raus und wird notiert; was er enthielt, holt die Lückenreparatur über den Beleg späterer Einträge.
          if (key) s.notes.push(`verworfen: Eintrag ${m.ref.slice(0, 8)} beschädigt`)
          else still.push(m)
          continue
        }
        s.keys.set(m.ref, key)
        s.tried.delete(id)
        try {
          const table = await openTable(key, unb64(m.iv), unb64(m.tab))
          for (let i = 0; i + 64 <= table.length; i += 64) {
            const ref = hex(table.subarray(i, i + 32))
            if (!s.keys.has(ref)) {
              s.keys.set(ref, table.slice(i + 32, i + 64))
              s.keyGen++
            }
          }
        } catch {}
        s.heads.push(unhex(m.ref))
        progress = true
        let w: Wire
        try {
          w = JSON.parse(dec.decode(plain)) as Wire
        } catch {
          continue
        }
        // Der Umschlag ist Klartext und unverbürgt: Was er behauptet (`kind`), muss der Inhalt einlösen. Sonst
        // könnte ein entferntes Gerät mit altem Schlüssel Inhalt als Autoritätsoperation deklarieren und am
        // Dienst vorbei zustellen (#32).
        if (w.t !== m.kind) {
          s.notes.push(`verworfen: Eintrag ${m.ref.slice(0, 8)} behauptet ${m.kind}, enthält ${w.t}`)
          continue
        }
        // Ein geöffneter Eintrag belegt seine Köpfe (Lückenreparatur, I12): der Schreiber hatte den Schlüssel.
        if (m.heads.length) s.envelopes.set(m.ref, { heads: m.heads, by: m.by })
        if (w.t === 'content') out.push(unb64(w.u))
        else inner.push(w)
      }
      s.pending = still
    }
    return { content: out, inner }
  }

  /**
   * Versiegelte Rahmen öffnen und die inneren verarbeiten, bis nichts mehr
   * aufgeht; danach erst die Lückenprüfung (sonst fragte eine Replik nach
   * Operationen, die noch ungeöffnet bei ihr liegen). `fromKeys`: Geräte,
   * von denen Rahmen kamen (offene Anfragen an sie wiederholen).
   */
  async function drainAll(s: DeviceState, fromKeys: string[] = []): Promise<Uint8Array[]> {
    const out: Uint8Array[] = []
    const from = new Set(fromKeys)
    for (;;) {
      const { content, inner } = await drain(s)
      out.push(...content)
      if (!inner.length) break
      for (const w of inner) for (const k of await handleInner(s, w)) from.add(k)
    }
    repair(s, [...from])
    await flushQueued(s)
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
        noteOp(s, unb64(c))
      } catch {
        s.pendingCgka.push(c)
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
    retryPendingCgka(s)
    // Der Baum folgt dem Log; fremde Blätter fasst nur an, wer auf dem Stand ist (s. authInTransit).
    if (!authInTransit(s)) {
      await heal(s)
      await ensureMemberLeaves(s)
    }
    await ensureOwnLeaves(s)
    if (s.stranded.length) await resealStranded(s)
  }

  /**
   * Ergebnis einer eingespielten Schlüsseloperation verbuchen. `lost`: der Port ist auf die Epoche vor dem
   * verlorenen Commit zurückgefallen; alles, was seither versiegelt wurde, ist für die anderen unlesbar und geht
   * nach der Angleichung neu versiegelt hinaus (resealStranded). `stale`: nie mehr anwendbar, nicht verbuchen.
   */
  function noteKeyResult(s: DeviceState, r: 'ok' | 'own' | 'lost' | 'stale' | 'reset' | 'proposal', op: Uint8Array) {
    if (r === 'proposal') return // kein Baumstand: dieser Kandidat arbeitet ohne Vorschläge (Räume mit einem Committer: E14b)
    if (r === 'lost') {
      const parent = s.peer.epoch() - 1
      const lost = s.sealed.filter((f) => f.epoch > parent)
      s.sealed = s.sealed.filter((f) => f.epoch <= parent)
      s.stranded.push(...lost)
      s.notes.push(`Tiebreak verloren: eigener Commit zurückgerollt${lost.length ? `, ${lost.length} Rahmen neu versiegelt` : ''}`)
    }
    if (r !== 'stale') noteOp(s, op)
  }

  /** Gestrandete Rahmen (verfallene Epoche) unter dem jetzigen Schlüssel noch einmal hinaus. */
  async function resealStranded(s: DeviceState) {
    for (const f of s.stranded.splice(0)) {
      if (f.inner.t === 'repair' && f.inner.missing.every((id) => s.auth.has(id))) continue
      await sendSealed(s, f.inner, f.label, f.heads)
    }
  }

  /**
   * Wartende Schlüsseloperationen nachziehen, bis nichts mehr durchgeht. Nur, wenn sich seit dem letzten Versuch
   * etwas geändert hat (Generation): ein Commit von einem anderen Zweig wartet, bis sein Vorgänger den Tiebreak
   * entscheidet, und jeder Versuch kostet beim linearen Port eine probeweise Anwendung.
   */
  function retryPendingCgka(s: DeviceState) {
    if (s.retriedAt === s.keyGen) return
    s.retriedAt = s.keyGen
    let progress = true
    while (progress && s.pendingCgka.length) {
      progress = false
      const rest: string[] = []
      for (const c of s.pendingCgka) {
        try {
          noteKeyResult(s, s.peer.receive(unb64(c)), unb64(c))
          progress = true
        } catch {
          rest.push(c)
        }
      }
      s.pendingCgka = rest
    }
  }

  /** Wartende Rahmen hinaus, soweit jetzt ein Schlüssel da ist; ein Durchgang, Rest bleibt stehen. */
  async function flushQueued(s: DeviceState) {
    const batch = s.queued.splice(0)
    for (const q of batch) {
      // Eine Anfrage, deren Lücke sich inzwischen geschlossen hat, geht nicht mehr hinaus.
      if (q.inner.t === 'repair' && q.inner.missing.every((id) => s.auth.has(id))) continue
      await sendSealed(s, q.inner, q.label, q.heads)
    }
  }

  /**
   * Lückenreparatur (Replication I12). Eine Lücke ist ein Vorgänger, den ein
   * gehaltener Eintrag nennt (Autoritätsoperation: `preds`; Inhalt: `heads`)
   * und den das Log nicht hält. Die Anfrage geht an die Geräte des Autors
   * des Belegs, trägt den Beleg und die eigenen Köpfe. Ein Lauf endet, wenn
   * der Vorgänger eintrifft (`repaired`); bis dahin ist er `awaiting-source`
   * und im Status sichtbar. Die Belege hängen an den Autoritätsabhängigkeiten
   * (Umschläge, wartende Operationen), nicht am Schlüsselbaum: ein Inhalt
   * kann zu öffnen sein und trotzdem eine Lücke belegen (Review zu #27).
   *
   * Wiederholung: Ein neuer Beleg löst eine neue Anfrage aus. Geht die
   * Anfrage selbst verloren, wiederholt sie die Replik, sobald ein Rahmen
   * eines adressierten Geräts eintrifft (`fromKeys`: die Quelle ist
   * erreichbar, hat aber nicht geantwortet), höchstens `MAX_ATTEMPTS` je
   * Lauf. So gibt es keine Schleife: Anfragen gehen nur auf Verkehr hin
   * hinaus. Ein erschöpfter Lauf bleibt sichtbar offen, bis der Adapter ihn
   * neu startet (`rerunRepair`, etwa nach Netzheilung; #30). Ein Zeithorizont
   * ist im Prüfstand nicht modelliert (keine Uhr).
   */
  const MAX_ATTEMPTS = 3
  function repair(s: DeviceState, fromKeys: string[] = []) {
    for (const [id, r] of s.repairs) if (r.outcome === 'awaiting-source' && s.auth.has(id)) r.outcome = 'repaired'
    // Vor dem Willkommen kann ein Gerät nichts öffnen und nichts belegen: keine Anfragen (sie kämen ohnehin nicht versiegelt hinaus).
    if (!s.joined) return
    // Keine Sperre: Belege kommen nur aus geöffneten Einträgen und wartenden Operationen, die sind verbürgt.
    // Ungeöffnete Rahmen belegen nichts und halten nichts auf (Review zu #31, Runde 3).
    for (const [ref, e] of s.envelopes) if (e.heads.every((h) => s.auth.has(h))) s.envelopes.delete(ref)
    const found = new Map<string, { evidence: string; to: string[] }>()
    const note = (missing: string, evidence: string, to: string[]) => {
      if (!s.auth.has(missing) && !found.has(missing)) found.set(missing, { evidence, to })
    }
    for (const w of s.waitingAuth) {
      const to = w.op.sigs.flatMap((sig) => cardsOf(s, sig.signer).map((c) => c.deviceKey))
      for (const p of w.op.preds) note(p, w.op.id, to)
    }
    for (const [ref, e] of s.envelopes) for (const h of e.heads) note(h, ref, [e.by])
    const ask = new Set<string>()
    const evidence = new Set<string>()
    const to = new Set<string>()
    const issue = (missing: string, r: NonNullable<ReturnType<typeof s.repairs.get>>) => {
      if (r.attempts >= MAX_ATTEMPTS) return
      ask.add(missing)
      for (const e of r.evidence) evidence.add(e)
      for (const d of r.to) to.add(d)
      r.attempts++
    }
    for (const [missing, f] of found) {
      let r = s.repairs.get(missing)
      if (!r) s.repairs.set(missing, (r = { evidence: new Set(), to: new Set(), outcome: 'awaiting-source', attempts: 0 }))
      if (r.evidence.has(f.evidence)) continue
      r.evidence.add(f.evidence)
      for (const d of f.to) r.to.add(d)
      issue(missing, r)
    }
    for (const [missing, r] of s.repairs) {
      if (r.outcome !== 'awaiting-source' || ask.has(missing)) continue
      if (fromKeys.some((k) => r.to.has(k))) issue(missing, r)
    }
    if (ask.size && to.size) {
      const req: Wire = { t: 'repair', from: s.deviceSigner.pub, to: [...to], missing: [...ask], evidence: [...evidence], have: s.auth.heads() }
      if (klartext) send(s, req)
      else s.queued.push({ inner: req, label: 'repair', heads: s.auth.heads() })
    }
  }

  const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every((y) => typeof y === 'string')

  /**
   * Quellenpflicht (I12): Eine adressierte, belegte Anfrage beantwortet das
   * Gerät mit dem Abschluss der fehlenden Operationen ohne den Abschluss der
   * Köpfe des Fragenden, in kausaler Reihenfolge, als die ursprünglichen Rahmen.
   */
  async function answerRepair(s: DeviceState, m: Extract<Wire, { t: 'repair' }>) {
    if (!m.to.includes(s.deviceSigner.pub)) return
    if (!m.evidence.length) return
    const closure = (roots: string[]) => {
      const seen = new Set<string>()
      const order: string[] = []
      const visit = (id: string) => {
        if (seen.has(id)) return
        seen.add(id)
        const f = s.authFrames.get(id)
        if (!f) return
        for (const p of f.op.preds) visit(p)
        for (const d of f.op.dependsOn ?? []) visit(d)
        order.push(id)
      }
      roots.forEach(visit)
      return { seen, order }
    }
    const have = closure(m.have).seen
    const { order } = closure(m.missing)
    let sent = 0
    for (const id of order) {
      if (have.has(id)) continue
      const f = s.authFrames.get(id)
      if (!f) continue
      await sendAuth(s, f.op, f.cgka, f.group, f.label)
      sent++
    }
    if (sent) s.notes.push(`reparatur beantwortet: ${sent} Rahmen`)
  }

  /**
   * Die andere Richtung der Heilung: Fehlt das Blatt eines Mitglieds im Baum
   * (eine Entfernung ist nachträglich verfallen, oder eine Aufnahme wurde erst
   * durch eine andere Operation gültig, nachdem ihre Anhänge nicht mehr
   * passten), nimmt jedes Gerät mit Schlüssel es auf. Gleichzeitige
   * Aufnahmen desselben Blatts führt BeeKEM zusammen (KV6).
   */
  /**
   * Bei einem linearen Schlüssel-Port (MLS) heilt nicht jedes Mitglied, sondern das eine mit der kleinsten
   * Personenkennung unter denen, die laut Log Mitglied sind **und ein Blatt im Baum haben**: gleichzeitige Commits
   * verlören sonst den Tiebreak gegeneinander (KV6 über Heilung, wie bei linear/0.1). Wer kein Blatt hat, kann
   * nicht heilen, auch nicht sich selbst (CodeRabbit zu #39: Alice, laut Log wieder Mitglied, nachdem der Fork
   * ihre Entfernung verwarf, stand ohne Blatt da, und niemand sonst zog sie nach).
   */
  const healer = (s: DeviceState) => {
    if (!port.linear) return true
    const inTree = new Set((s.peer.members() as Uint8Array[]).map(hex))
    const withLeaf = [...s.auth.members()].filter((p) => cardsOf(s, p).some((c) => inTree.has(hex(c.id))))
    return withLeaf.sort()[0] === s.person
  }

  async function ensureMemberLeaves(s: DeviceState) {
    if (!s.auth.members().has(s.person) || !healer(s)) return
    const inTree = new Set((s.peer.members() as Uint8Array[]).map(hex))
    const me = hex(s.peer.id)
    if (!inTree.has(me)) return
    // Bei einem linearen Port zieht jede Person ihre eigenen weiteren Geräte selbst nach (ensureOwnLeaves); der Heiler
    // nimmt nur Personen auf, von denen gar kein Blatt im Baum steht, sonst kollidierten zwei Commits.
    const hasLeaf = (p: Person) => cardsOf(s, p).some((c) => inTree.has(hex(c.id)))
    const missing = [...s.auth.members()].filter((p) => !(port.linear && p !== s.person && hasLeaf(p))).flatMap((p) => cardsOf(s, p).filter((c) => !inTree.has(hex(c.id))))
    if (!missing.length) return
    // Ohne gemeinsamen Schlüssel (nach gleichzeitigen Strukturänderungen zeigt
    // BeeKEM bis zur nächsten eigenen Operation den alten Stand) erst
    // rotieren; sonst bliebe die Reparatur bis zum nächsten Schreiben liegen,
    // und dieser Eintrag ginge am fehlenden Mitglied vorbei.
    if (!s.peer.hasKey()) {
      try {
        const op = (await s.peer.rotate()) as Uint8Array
        send(s, { t: 'cgka', op: b64(op) }, 'heal-rotate')
        // Die Rotation führt gleichzeitige Änderungen zusammen; Blätter von Nicht-Mitgliedern erst wieder heraus (#33).
        await heal(s)
      } catch (e) {
        s.notes.push(`Reparatur-Rotation: ${(e as Error).message}`)
        return
      }
    }
    for (const p of s.auth.members()) {
      for (const c of cardsOf(s, p)) {
        if (inTree.has(hex(c.id))) continue
        try {
          const r = await s.peer.add(c.id, c.shareKey)
          if (r.op) send(s, { t: 'cgka', op: b64(r.op) }, 'heal-add')
          await sendWelcome(s, c, undefined, r.welcome && r.op ? { welcome: r.welcome, commit: hex(sha256Sync(r.op)) } : undefined)
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
    const me = hex(s.peer.id)
    if (!inTree.has(me)) return
    for (const c of cardsOf(s, s.person)) {
      if (inTree.has(hex(c.id)) || hex(c.id) === me) continue
      try {
        const r = await s.peer.add(c.id, c.shareKey)
        if (r.op) send(s, { t: 'cgka', op: b64(r.op) }, 'device-add')
        await sendWelcome(s, c, undefined, r.welcome && r.op ? { welcome: r.welcome, commit: hex(sha256Sync(r.op)) } : undefined)
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
  async function heal(s: DeviceState, exempt: Set<string> = new Set()) {
    const members = s.auth.members()
    if (!members.has(s.person) || !s.peer.hasKey() || !healer(s)) return
    const allowed = new Set([...members.keys()].flatMap((p) => cardsOf(s, p).map((c) => hex(c.id))))
    for (const idBytes of s.peer.members() as Uint8Array[]) {
      if (allowed.has(hex(idBytes)) || exempt.has(hex(idBytes))) continue
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
    // identities = Geräteschlüssel aller Geräte der Mitglieder (7.3: eine Identität je Gerät).
    const identities = [...members.keys()].flatMap((p) => cardsOf(s, p).map((c) => c.deviceKey)).sort()
    const me = s.deviceSigner.pub
    if (!identities.includes(me)) return
    if (JSON.stringify(identities) === JSON.stringify(s.ack.identities)) return
    const body = { seq: s.ack.seq + 1, prev: s.ack.hash, identities, m: Math.min(2, identities.length) }
    const h = viewHash(body)
    if (h === s.proposed) return
    s.proposed = h
    const v: ViewProposal = { t: 'view', ...body, sigs: [signView(body, s.deviceSigner)] }
    send(s, v)
  }

  function personMembers(s: DeviceState): Person[] {
    return [...s.auth.members().keys()].sort()
  }

  async function handle(s: DeviceState, m: Wire, body: Uint8Array): Promise<{ content: Uint8Array[] }> {
    switch (m.t) {
      case 'card':
        if (typeof m.welcomeKey !== 'string') throw new Error('Karte ohne Willkommensschlüssel')
        s.cards.set(m.id, { person: m.person, id: unhex(m.id), shareKey: unhex(m.shareKey), deviceKey: m.deviceKey, welcomeKey: m.welcomeKey })
        await reconcile(s)
        return { content: [] }
      case 'challenge':
        // Besitznachweis gegenüber dem Dienst (7.3): nur die eigene Challenge beantworten.
        if (m.to === s.deviceSigner.pub) {
          const a: ChallengeAnswer = { t: 'challenge-answer', signer: s.deviceSigner.pub, nonce: m.nonce, sig: s.deviceSigner.sign(`challenge|${m.nonce}`) }
          send(s, a)
        }
        return { content: [] }
      case 'challenge-answer':
        return { content: [] } // Antworten anderer gehen an den Dienst
      case 'view':
      case 'target-request':
      case 'fetch':
        return { content: [] } // Vorschläge und Anfragen anderer gehen an den Dienst
      case 'target': {
        // Beglaubigtes Ziel des Dienstes (D5). Drei getrennte Prüfungen (Review zu #36): Signatur unter dem beim
        // ersten Ziel gesehenen Schlüssel (TOFU, wie §7.3); Frische: nur das Echo der offenen Anfrage beantwortet sie;
        // Kette: seq+1, prev = Digest des angenommenen Vorgängers, chain = Kettenidentität. Was das Ziel nennt und
        // hier fehlt, holt das Gerät beim Dienst (I12 gegen den Dienst als Quelle), referenzgenau.
        if (!strings(m.frontier?.heads) || typeof m.sig !== 'string' || typeof m.attestationKey !== 'string' || !Number.isInteger(m.seq) || typeof m.echo !== 'string' || typeof m.to !== 'string' || (m.prev !== null && typeof m.prev !== 'string') || (m.chain !== null && typeof m.chain !== 'string')) throw new Error('Ziel missgebildet')
        if (s.target.key && s.target.key !== m.attestationKey) throw new Error('Ziel unter fremdem Schlüssel')
        if (!verifyTarget(m)) throw new Error('Ziel: Signatur ungültig')
        const t = s.target
        // Ein Ziel, das die Kette fortsetzt, wird als Glied angenommen, gleich an wen es ging (der Dienst stellt
        // jedes Ziel allen zu bzw. reicht Zwischenziele nach). Eine Wiederholung (seq nicht größer) liegt still.
        if (t.seq !== null && m.seq <= t.seq) return { content: [] }
        if (t.seq === null) {
          if (m.seq !== 1 || m.prev !== null || m.chain !== null) throw new Error(`Ziel: Kette beginnt nicht bei 1 (seq ${m.seq})`)
        } else {
          if (m.seq !== t.seq + 1) throw new Error(`Ziel: Kette unterbrochen (seq ${t.seq + 1} erwartet, ${m.seq} erhalten)`)
          if (m.prev !== t.digest || m.chain !== t.chain) throw new Error('Ziel: prev oder chain passen nicht zum angenommenen Vorgänger')
        }
        const { sig: _sig, ...body } = m
        const digest = targetDigest(body)
        t.key ??= m.attestationKey
        // Die offene Anfrage beantwortet nur ein Ziel mit ihrem Echo und an dieses Gerät (Frische); ein Glied allein nicht.
        if (m.echo === t.nonce && m.to === s.deviceSigner.pub) {
          t.answered = t.asked
          t.nonce = null
        }
        t.seq = m.seq
        t.digest = digest
        t.chain = m.seq === 1 ? digest : m.chain
        // Fehlbestand = Digests des Ziels, deren Bytes nicht hier liegen. Eine beschädigte Kopie hat einen anderen
        // Digest und zählt nicht; ob ein gespeicherter Eintrag zu öffnen ist, ist eine andere Frage (dahinter).
        t.missing = new Set(m.frontier.heads.filter((d) => !s.stored.has(d)))
        if (t.missing.size) send(s, { t: 'fetch', refs: [...t.missing] })
        return { content: [] }
      }
      case 'ack':
        s.ack = { seq: m.seq, hash: m.hash, identities: m.identities }
        s.proposed = null
        return { content: [] }
      case 'auth':
      case 'repair':
      case 'revoke':
        // Klartextmodus (Dienst der Klasse Log) oder ein Rahmen, der versiegelt hätte kommen müssen: Form prüfen, dann wie ein geöffneter.
        return { content: await drainAll(s, await handleInner(s, m)) }
      case 'cgka':
        ensureJoined(s)
        try {
          noteKeyResult(s, s.peer.receive(unb64(m.op)), unb64(m.op))
        } catch {
          // Vorgänger fehlen (Umordnung am Träger) oder schon bekannt: aufheben, reconcile() versucht es wieder.
          s.pendingCgka.push(m.op)
        }
        // Eine Schlüsseloperation ändert das Log nicht: nur Wartendes nachziehen; angeglichen wird nach Autoritätsoperationen und vor dem Schreiben.
        retryPendingCgka(s)
        // Linearer Port: ein Commit kann den Baum vom Log wegbewegen (verlorener Tiebreak, fremder Commit); der Heiler
        // gleicht dann an, sonst wartete ein Schreiben am treeSafe-Gate, bis zufällig eine Autoritätsoperation kommt.
        if (port.linear) await reconcile(s)
        return { content: await drainAll(s) }
      case 'welcome': {
        if (m.to !== hex(x25519.getPublicKey(s.welcomePriv))) return { content: [] } // an ein anderes Gerät
        if (typeof m.eph !== 'string' || typeof m.iv !== 'string' || typeof m.c !== 'string') throw new Error('Willkommen missgebildet')
        const w = JSON.parse(dec.decode(await openFrom(s.welcomePriv, unhex(m.eph), unb64(m.iv), unb64(m.c)))) as { group?: string; op?: AuthOp; key?: string; commit?: string }
        if (typeof w.group !== 'string') throw new Error('Willkommen ohne Gruppe')
        if (!groupId) groupId = unhex(w.group)
        if (typeof w.key === 'string' && s.peer.welcome) {
          // MLS: erst mit dem Willkommen gibt es die Gruppe. Ein zweites Willkommen nimmt wieder auf (Gruppe
          // inaktiv nach Entfernung) oder ersetzt eine Gruppe auf einem verfallenen Zweig (`reset`): dann ist
          // alles seit dem Beitritt Versiegelte für die anderen unlesbar und geht neu hinaus.
          try {
            const r = s.peer.welcome(unb64(w.key))
            if (r === 'reset') {
              const lost = s.sealed.splice(0)
              s.stranded.push(...lost)
              s.notes.push(`Willkommen ersetzt verfallenen Zweig${lost.length ? `, ${lost.length} Rahmen neu versiegelt` : ''}`)
            } else if (r === 'ok') s.sealed = []
            if (r !== 'own') {
              s.keyGen++
              if (typeof w.commit === 'string') {
                s.appliedOps.add(w.commit)
                s.lastKeyOp = w.commit
              }
            }
          } catch (e) {
            s.notes.push(`Willkommen: ${(e as Error).message ?? String(e)}`)
          }
        }
        ensureJoined(s)
        await reconcile(s)
        // Erst öffnen, was schon da liegt (die Aufnahme kam meist versiegelt voraus), dann die Aufnahme aus dem Willkommen.
        const out = await drainAll(s)
        if (w.op) out.push(...(await drainAll(s, await handleInner(s, { t: 'auth', op: w.op, cgka: [] }))))
        return { content: out }
      }
      case 'sealed': {
        if (typeof m.kind !== 'string' || !strings(m.heads) || typeof m.by !== 'string' || typeof m.ref !== 'string' || typeof m.c !== 'string' || (m.keyOp !== undefined && typeof m.keyOp !== 'string')) throw new Error('Eintrag ohne Umschlag')
        // Verifiziert gespeichert: die Bytes, identifiziert durch ihren Digest (der Dienst beglaubigt dieselben Digests).
        const digest = hex(sha256Sync(body))
        if (s.stored.has(digest)) return { content: [] } // dieselben Bytes schon da (T3)
        s.stored.add(digest)
        if (s.target.missing.delete(digest)) s.target.fetched++
        m.digest = digest
        s.tried.set(digest, { arrived: s.keyGen, gen: -1, n: 0 })
        s.pending.push(m)
        return { content: await drainAll(s, [m.by]) }
      }
      case 'content':
        throw new Error('Inhalt außerhalb eines Eintrags')
    }
  }

  /** Ein innerer Rahmen (geöffnet, aus dem Willkommen, oder im Klartextmodus). Gibt die Geräteschlüssel des Absenders zurück, soweit bekannt. */
  async function handleInner(s: DeviceState, m: Wire): Promise<string[]> {
    switch (m.t) {
      case 'auth':
        if (!wellFormed(m.op)) throw new Error('Autoritätsoperation missgebildet')
        if (!Array.isArray(m.cgka) || !m.cgka.every((c) => typeof c === 'string')) throw new Error('Anhänge missgebildet')
        if (m.group && !groupId) groupId = unhex(m.group)
        ensureJoined(s)
        if (!s.authFrames.has(m.op.id)) s.authFrames.set(m.op.id, { op: m.op, cgka: m.cgka, group: m.group, label: m.op.kind === 'policy' ? 'policy' : 'auth' })
        await processAuth(s, m.op, m.cgka)
        return m.op.sigs.flatMap((sig) => cardsOf(s, sig.signer).map((c) => c.deviceKey))
      case 'repair':
        if (!strings(m.to) || !strings(m.missing) || !strings(m.evidence) || !strings(m.have)) throw new Error('Reparaturanfrage missgebildet')
        await answerRepair(s, m)
        return [m.from]
      case 'revoke':
        if (typeof m.id !== 'string') throw new Error('Widerruf missgebildet')
        s.revoked.add(m.id)
        await reconcile(s)
        return []
      default:
        throw new Error(`innerer Rahmen ${m.t} unerwartet`)
    }
  }

  return {
    id: options.dienst ? `rltp-beekem-${options.dienst}${options.mRule === 'new' ? '-m-neu' : ''}` : 'rltp-beekem',
    capabilities: new Set<Capability>(['roles', 'policy', 'rotate', 'steal', 'forge-key-op', 'multi-device', 'device-remove', ...(service ? (['service'] as Capability[]) : [])]),
    service,

    async addDevice(person, device) {
      await port.load()
      signerOf(person)
      const peer = port.peer()
      const deviceSigner = Signer.generate(device)
      const welcomePriv = x25519.utils.randomSecretKey()
      const card: Card = { person, id: peer.id, shareKey: peer.shareKey, deviceKey: deviceSigner.pub, welcomeKey: hex(x25519.getPublicKey(welcomePriv)) }
      const s: DeviceState = { person, peer, auth: new AuthorityLog(), deviceSigner, welcomePriv, cards: new Map([[hex(card.id), card]]), revoked: new Set(), ack: { seq: 0, hash: null, identities: [] }, proposed: null, waitingAuth: [], appliedCgka: new Set(), pendingCgka: [], authFrames: new Map(), envelopes: new Map(), repairs: new Map(), keys: new Map(), heads: [], pending: [], keyGen: 0, stored: new Set(), tried: new Map(), appliedOps: new Set(), outgoing: [], queued: [], sealed: [], stranded: [], retriedAt: -1, joined: false, notes: [], target: { asked: 0, answered: 0, nonce: null, seq: null, digest: null, chain: null, missing: new Set(), fetched: 0 } }
      devices.set(device, s)
      // Die Karte geht über den Begegnungskanal, nicht über den Träger der Gruppe; mit Prüfstand-Dienst über
      // den Dienst, weil der die Gerätebindung aus der Karte lernt (in der Spec aus der Sicht).
      send(s, { t: 'card', person, id: hex(card.id), shareKey: hex(card.shareKey), deviceKey: card.deviceKey, welcomeKey: card.welcomeKey }, 'card', !service)
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
      await sendAuth(s, op, ops.map(b64), hex(groupId))
      proposeView(s)
    },

    async addMember(by, p, role) {
      const s = dev(by)
      const known = cardsOf(s, p)
      if (!known.length) throw new Error(`unbekannte Person ${p}`)
      const op = s.auth.make({ kind: 'add', subject: p, key: signerOf(p).pub }, [signerOf(s.person)])
      s.auth.add(op)
      const cgka: string[] = []
      const keyWelcomes = new Map<string, { welcome: Uint8Array; commit: string }>()
      if (s.auth.isValid(op.id)) {
        // Alle bekannten Geräte der Person; spätere Geräte nimmt die Person selbst auf.
        for (const card of known) {
          const r = await s.peer.add(card.id, card.shareKey)
          if (r.op) cgka.push(b64(r.op))
          if (r.welcome && r.op) keyWelcomes.set(card.deviceKey, { welcome: r.welcome, commit: hex(sha256Sync(r.op)) })
        }
      }
      s.appliedCgka.add(op.id)
      await sendAuth(s, op, cgka)
      // Willkommen an jedes bekannte Gerät der Person: Gruppe und Aufnahme, nur für dieses Gerät lesbar.
      if (s.auth.isValid(op.id)) for (const card of known) await sendWelcome(s, card, op, keyWelcomes.get(card.deviceKey))
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
          await sendAuth(s, change, [], undefined, 'policy')
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
      const prebuilt = await sealBeforeTree(s, op)
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
      await sendAuth(s, op, cgka, undefined, 'auth', prebuilt)
      proposeView(s)
    },

    async removeDevice(by, device) {
      const s = dev(by)
      const target = dev(device)
      const id = target.peer.id
      const admin = s.auth.may(s.person, 'member.remove')
      if (target.person !== s.person && !admin) throw new Error(`${by} darf ${device} nicht entfernen`)
      s.revoked.add(hex(id))
      if (klartext) send(s, { t: 'revoke', id: hex(id) })
      else await sendSealed(s, { t: 'revoke', id: hex(id) })
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
      await sendAuth(s, op, [], undefined, 'policy')
      proposeView(s)
    },

    async sealContent(d, update) {
      const s = dev(d)
      // Erst der Baum zum Zustand, dann verschlüsseln (I4).
      await reconcile(s)
      try {
        await sendSealed(s, { t: 'content', u: b64(update) }, 'content')
      } catch (e) {
        notes.push(`${d} schreibt: ${(e as Error).message}`)
      }
    },
    takeOutgoing: (d) => dev(d).outgoing.splice(0),
    poll(d) {
      // Sync-Tick: mit Dienst nach dem beglaubigten Ziel fragen (D5). Ohne Dienst gibt es kein Ziel: Klasse blind.
      if (!service) return
      const s = dev(d)
      if (!s.joined) return
      s.target.asked++
      s.target.nonce = hex(crypto.getRandomValues(new Uint8Array(16)))
      send(s, { t: 'target-request', nonce: s.target.nonce, since: s.target.seq ?? 0 })
    },
    async rerunRepair(d) {
      const s = dev(d)
      const to = new Set<string>()
      for (const r of s.repairs.values()) {
        if (r.outcome !== 'awaiting-source') continue
        r.attempts = 0
        for (const k of r.to) to.add(k)
      }
      // Neuer Lauf: eine frische Anfrage an alle Quellen der offenen Läufe.
      repair(s, [...to])
      return flushQueued(s)
    },

    async receive(d, msg: Msg) {
      const s = dev(d)
      // Ein Rahmen von der Leitung ist Daten: was sich nicht lesen lässt, wird
      // verworfen und notiert, nie geworfen (T5, Träger-Prüfstand).
      let m: Wire
      try {
        m = JSON.parse(dec.decode(msg.body)) as Wire
        if (!m || typeof m !== 'object' || typeof m.t !== 'string') throw new Error('kein Rahmen')
      } catch (e) {
        s.notes.push(`verworfen: ${(e as Error).message}`)
        return { content: [] }
      }
      try {
        return await handle(s, m, msg.body)
      } catch (e) {
        s.notes.push(`verworfen (${m.t}): ${(e as Error).message}`)
        return { content: [] }
      } finally {
        proposeView(s)
      }
    },
    members: (d) => personMembers(dev(d)),
    status: (d) => {
      const s = dev(d)
      return [`baum=${(s.peer.members() as Uint8Array[]).length}`, ...(port.linear ? [`epoche=${s.peer.epoch()}`] : []), `schlüssel=${s.peer.hasKey() ? 'ja' : 'nein'}`, `fork=${s.auth.forked() ? 'ja' : 'nein'}`, `regeln=v${s.auth.policyVersion()}`, ...(s.pendingCgka.length ? [`wartende-cgka=${s.pendingCgka.length}`] : []), ...(s.waitingAuth.length ? [`wartende-auth=${s.waitingAuth.length}`] : []), ...(s.pending.length ? [`ungeöffnet=${s.pending.length}`] : []), ...(service && s.target.asked ? [s.target.answered < s.target.asked ? `ziel=angefragt, keine Antwort${s.target.seq === null ? '' : ` (zuletzt seq ${s.target.seq})`}` : `ziel=seq ${s.target.seq} (${s.target.missing.size} fehlen, ${s.target.fetched} geholt)`] : []), ...(s.repairs.size ? [`lücke=${[...s.repairs.values()].filter((r) => r.outcome === 'awaiting-source').length} (${[...s.repairs.values()].some((r) => r.outcome === 'awaiting-source') ? 'awaiting-source' : `repariert ${[...s.repairs.values()].filter((r) => r.outcome === 'repaired').length}`})`, `anfragen=${[...s.repairs.values()].reduce((n, r) => n + r.attempts, 0)}`] : []), ...s.notes.slice(0, 3), ...notes.slice(0, 2)].join('; ')
    },

    async steal(d) {
      const s = dev(d)
      return { state: new Uint8Array(s.peer.exportState()), keys: new Map([...s.keys].map(([k, v]) => [k, v.slice()] as const)), appliedOps: new Set(s.appliedOps) }
    },
    async attackerOpen(stolen, msg: Msg, via = 'stolen') {
      // Passiver Angreifer mit Bobs Zustand: nimmt alle Schlüsseloperationen auf, öffnet Inhalte wie ein ehrliches
      // Gerät. Ein gefälschtes Blatt (S11) nimmt denselben Verkehr auf; gelesen wird aber nur über das eine, nach
      // dem gefragt ist: `via: 'forged'` liefert ausschließlich, was das Blatt öffnet, nie den Altzustand (Review zu
      // #37: sonst bewiese die Positivkontrolle nichts über das Blatt).
      const st = stolen as { state: Uint8Array; keys: Map<string, Uint8Array>; appliedOps: Set<string>; ks?: KeyState; forged?: KeyState }
      st.ks ??= { peer: port.fromState(st.state), keys: st.keys, heads: [], pending: [], keyGen: 0, stored: new Set(), tried: new Map(), envelopes: new Map(), appliedOps: st.appliedOps, notes: [] }
      const m = JSON.parse(dec.decode(msg.body)) as Wire
      const ops = m.t === 'cgka' ? [m.op] : m.t === 'auth' ? m.cgka : []
      const out: Uint8Array[] = []
      for (const [name, ks] of [['stolen', st.ks] as const, ...(st.forged ? [['forged', st.forged] as const] : [])]) {
        for (const op of ops) {
          try {
            ks.peer.receive(unb64(op))
            noteOp(ks, unb64(op))
          } catch {}
        }
        if (m.t === 'sealed') ks.pending.push({ ...m, digest: hex(sha256Sync(msg.body)) })
        const content = (await drain(ks)).content
        if (name === via) out.push(...content)
      }
      return out
    },
    async forgeKeyOp(stolen) {
      // Aktiver Angreifer (S11, KV3): aus dem erbeuteten Zustand ein neues Blatt für sich in den Baum nehmen,
      // ohne dass ein Logeintrag es deckt. Das neue Blatt ist sein Lesegerät.
      await port.load()
      const st = stolen as { state: Uint8Array; keys: Map<string, Uint8Array>; appliedOps: Set<string>; ks?: KeyState; forged?: KeyState }
      st.ks ??= { peer: port.fromState(st.state), keys: st.keys, heads: [], pending: [], keyGen: 0, stored: new Set(), tried: new Map(), envelopes: new Map(), appliedOps: st.appliedOps, notes: [] }
      // Die Fälschung geht von einer Kopie des mitlesenden Zustands aus, so weit er dem Verkehr bis jetzt gefolgt
      // ist (seine eigene Entfernung spielt der Angreifer nicht ein, s. S11). Bei MLS ist das ein Commit auf die
      // Epoche, auf der der Angreifer steht, bei BeeKEM eine nebenläufige Aufnahme. `epoch` nennt den Vorgänger.
      const forger = port.fromState(st.ks.peer.exportState())
      const leaf = port.peer()
      if (groupId) leaf.join(groupId)
      st.forged = { peer: leaf, keys: new Map(), heads: [], pending: [], keyGen: 0, stored: new Set(), tried: new Map(), envelopes: new Map(), appliedOps: new Set(), notes: [] }
      let added: { op: Uint8Array | null; welcome?: Uint8Array }
      try {
        added = await forger.add(leaf.id, leaf.shareKey)
      } catch (e) {
        notes.push(`Fälschung: ${(e as Error).message}`)
        return { frames: [], works: false }
      }
      const op = added.op
      if (!op) return { frames: [], works: false }
      noteOp(st.ks, op)
      // Ab jetzt ist der Fälscher der Zustand des Angreifers: die Kopie davor könnte den Commit ihres eigenen Blatts
      // nicht verarbeiten (OpenMLS nimmt keine Nachricht vom eigenen Blatt an) und bliebe stehen, wie Mallorys
      // echtes Gerät. Der Angreifer folgt dem Verkehr mit dem Zustand weiter, der committet hat.
      st.ks.peer = forger
      // Nachweis, dass das Blatt wirkt: es öffnet, was der erbeutete Zustand unter dem Geheimnis nach der
      // Aufnahme versiegelt (sonst bewiese das Szenario nichts über den Angriff, Review zu #37).
      let works = false
      try {
        if (added.welcome && leaf.welcome) {
          // MLS: das Blatt tritt über das Willkommen bei, das der erbeutete Zustand selbst ausstellt.
          leaf.welcome(added.welcome)
        } else {
          // BeeKEM: das Blatt braucht die Historie des Baums wie jedes neue Gerät; der erbeutete Zustand trägt sie.
          for (const h of forger.history?.() ?? []) {
            leaf.receive(h)
            noteOp(st.forged, h)
          }
          leaf.receive(op)
        }
        noteOp(st.forged, op)
        const probe = enc.encode('probe')
        const r = await forger.encrypt(crypto.getRandomValues(new Uint8Array(32)), [], probe)
        if (r.updateOp) leaf.receive(r.updateOp)
        works = dec.decode(leaf.decrypt(r.ciphertext).plaintext) === 'probe'
      } catch {}
      return { frames: [{ label: 'cgka', body: enc.encode(JSON.stringify({ t: 'cgka', op: b64(op) } satisfies Wire)) }], works, epoch: port.linear ? forger.epoch() - 1 : undefined }
    },
  }
}
