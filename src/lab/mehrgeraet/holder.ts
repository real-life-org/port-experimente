// E15 Mehrgerät: das Holder-Gerät. Hält den Holder-Zustand (model.ts) über
// alle Beziehungen, verwendet Träger, Zusteller, Uhr und Store des
// E11-Prüfstands wieder (zustellung.ts), nicht dessen Device (Plan Runde 3,
// Abschnitt 2). Was ein Kandidat beisteuert: Schlüsselableitung je Gerät,
// die Freigabe von Operationen (Rechte) und die Art, wie Operationen
// zwischen eigenen Geräten geteilt werden (CandidateDevice).
//
// Commit-Grenze (Tor-Review 2 S8, #56): jedes Dokument wird mit dem
// Zustand aufgezeichnet und committet, bevor es das Gerät verlässt
// (HSC-110); `before-send` ist die Absturzstelle dazwischen. Das gilt für
// Nutzeraktionen, Empfang und Zeitübergänge gleichermaßen: der Zusteller
// liefert nur ein, was das Gerät nach dem Commit freigegeben hat.
// Quittungen gehen erst nach dem Commit der Wirkung hinaus (#54). Alles,
// was ein Neuaufbau braucht, steht im Store-Abbild (#57). Jede
// quittierbare Submission kennt ihren erwarteten Quittungs-Signierer;
// andere Quittungen wirken nicht (#55).
//
// Blockiert heißt nicht fehlerhaft, und zwar ganz: verweigert der Kandidat
// eine Operation, bleibt von der Nutzeraktion, vom empfangenen Rahmen oder
// vom Zeitübergang nichts zurück (Zustand, Submissions, Quittungen,
// Journal); der Rahmen wird nicht quittiert, die Gegenseite wiederholt ihn.
// Nicht zurückgenommen werden Schlüsselableitungen und Adressanmeldungen
// am Träger (`listen`): sie tragen keinen Zustand. Der Checkpoint ist tief
// (auch die Zustellerberichte, B3). Fehlt einem empfangenen Rahmen eine
// Voraussetzung im Zustand (`Missing`), wird er zurückgestellt, nicht
// quittiert; die Gegenseite wiederholt ihn. Fällige Arbeit (Nachfüllen)
// wird aus dem Zustand abgeleitet und in jedem Zeitübergang erneut
// geprüft, nicht nur beim Ereignis, das sie fällig machte (B6).

import { seal, receive, edFromSeed, xFromSeed, anchorOfEd, mkOfX, diSign, diVerify, jcs, digestBytes } from '@real-life/trust-protocol'
import type { Json, KeyPair } from '@real-life/trust-protocol'
import { createHash, createHmac } from 'node:crypto'
import { Carrier, Zusteller, realClock, type Clock, type Store, type Submission, Crashed, type CrashPoint, WireUnreachable, type LogAnswer } from '../zustellung'
import * as M from './model'

const enc = new TextEncoder()
const dec = new TextDecoder()
/** K2 Schritt 2: Vorrat öffentlicher Geräteschlüssel je Schwester (Prüfstandsparameter): unter zwei unbenutzten auf vier auffüllen. */
const POOL = { below: 2, to: 4 } as const
/** K2 Schritt 2: Form der Nutzlast von `device-set@1` (kumulativ: alle Nachweise der Wurzel, die der Signierer kennt). */
const SET_SHAPE: M.Shape = { object: { root: 'ident', rootKeyAgreement: 'ident', revision: 'nat', deps: { array: 'digest' }, entries: { array: M.SHAPES.cert } } }

// ── Schlüssel ────────────────────────────────────────────────────────────────

export interface Keys {
  ed: KeyPair
  x: KeyPair
  anchor: string
  rkid: string
}

/** Schlüsselableitung für einen Kontextnamen; der Kandidat entscheidet, aus welchem Seed (one-seed oder je Gerät). */
export interface KeyScheme {
  pair(ctx: string): Promise<Keys>
}

/** Kennung versiegelter Bytes für die Verkehrsmessung (X21): gleiche Bytes, gleiche Kennung, also auch jede Wiederholung. */
export const frameHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('base64')

export function derive(seed: Uint8Array, ctx: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(seed).update(ctx).digest())
}

/** Ein Seed, zustandslose Ableitung je Kontext (Schnitt one-seed, K0/K1). */
export function seedScheme(seed: Uint8Array): KeyScheme {
  const cache = new Map<string, Promise<Keys>>()
  return {
    pair(ctx) {
      let p = cache.get(ctx)
      if (!p) {
        p = (async () => {
          const ed = await edFromSeed(derive(seed, `ed/${ctx}`))
          const x = await xFromSeed(derive(seed, `x/${ctx}`))
          return { ed, x, anchor: anchorOfEd(ed.pubRaw), rkid: mkOfX(x.pubRaw) }
        })()
        cache.set(ctx, p)
      }
      return p
    },
  }
}

// ── Kandidaten-Schnittstelle ─────────────────────────────────────────────────

export interface OwnFrame {
  body: Uint8Array
}

/**
 * Produktionsabsicht (HSC-130, Tor-Review 3 B4): ein eigenes Dokument, das das Gerät eingeliefert hat oder einliefern
 * wird, mit allem, was ein Wiederanlauf oder ein anderes Gerät braucht, um dieselben Bytes fortzusetzen: Digest (die
 * Kennung bei Delivery), die versiegelten Bytes, Zieladresse, erwarteter Quittungs-Signierer, Antwortadresse, Art, und
 * das Gerät samt Inkarnation, das sie erzeugt hat (Ausführungszuständigkeit).
 */
export interface Intent {
  digest: string
  kind: string
  bytes: Uint8Array
  address: string
  expected: string
  replyTo: string
  device: string
  writer: string
  /**
   * K2 Schritt 1: weitere Kopien derselben Bytes je weiterem Gerät des Empfängers (Adresse und versiegelte Bytes, base64);
   * ein Wiederanlauf liefert sie mit dem Hauptrahmen ein. Ohne Feld: ein Rahmen (K0, K1a).
   */
  copies?: Array<{ address: string; bytes: string }>
}

/** Ein gelungener Schritt des Geräts als Einheit: die Operationen und die Absichten, die er erzeugt hat (Review 6: Batch statt einzelner `record`). */
export interface Transaction {
  ops: M.Op[]
  intents: Intent[]
}

/** Der Kandidat verweigert eine Operation (fehlendes Recht, K1a): die Nutzeraktion ist blockiert, nicht fehlerhaft. */
export class Blocked extends Error {}
/** Der Kandidat verweigert ein weiteres Gerät (feste Gerätezahl, K1a): das Szenario weicht auf ein vorhandenes aus. */
export class EnrolmentRefused extends Error {}
/**
 * Eine Operation, die das Gerät selbst erzeugen würde, hat nicht die Form, die das Journal annimmt (CodeRabbit #71): meist
 * Werte aus dem Dokument eines Kontakts (Ticket, Revision). Dieselbe Eingangsprüfung wie auf beiden Journalpfaden
 * (`M.opProblem`); der Schritt wird ganz zurückgenommen, keine Quittung, nie Zustand.
 */
export class InvalidInput extends Error {}
/**
 * Ein eigener Journalrahmen ist gültig signiert, aber nicht faltbar (Tor-Review 26 B2): kaputte Form (Payload, Batch,
 * Operationen, Absichten) oder eine Ausnahme der Faltung außer `Missing` (zurückgestellt) und `Blocked`. Der Schritt wird
 * ganz zurückgenommen (`guarded`); Ablage und Briefkasten verbuchen ihn als Befund, nie als gefaltet. `ref`: Digest des
 * Dokuments (Briefkasten).
 */
export class CorruptFrame extends Error {
  constructor(
    message: string,
    readonly ref?: string,
    /** K2 Schritt 1: `unknown-writer` = gültig gelesen, aber von keinem Gerät der aktuellen Gerätemenge geschrieben oder signiert. */
    readonly kind?: 'unknown-writer',
  ) {
    super(message)
  }
}
/**
 * K2 Schritt 1: ein Journalbatch (oder ein Journalrahmen), dessen Schreiber nicht in der aktuellen Gerätemenge der Person
 * ist oder dessen Signatur nicht vom Geräteschlüssel des Schreibers stammt. Befund `journal:unknown-writer`, nie Zustand.
 */
export class UnknownWriter extends Error {}
/**
 * Review 38 S8: Grenze des Prüfstands, ausdrücklich statt still. Ein Journalbatch reist base64 in einem Journaldokument,
 * das die Größengrenze von Delivery (Klartext ≤ 65 536 B) einhält; ein Batch über rund 3/4 davon (abzüglich des
 * Dokumentrahmens) passt nicht. Der Batch wird nicht auf mehrere Rahmen verteilt (Rahmengröße: Schritt 3, NOTES).
 */
export class JournalOversize extends Error {
  constructor(readonly bytes: number, readonly device: string) {
    super(`journal-oversize: Batch von ${device} mit ${bytes} B passt base64 nicht in ein Journaldokument (Delivery: Klartext ≤ 65 536 B)`)
  }
}
/** K2: der Schreiber einer Revision ist der signierende Geräteschlüssel (`M.signerId`). */
export const signerId = M.signerId
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
/**
 * Form einer Absicht ohne ihre Bytes (Review 27 B2a), für beide Journalpfade: der Batch trägt die Bytes als strenges base64
 * (`batchProblem` im Kandidaten), die Transaktion als Uint8Array (`transactionProblem`).
 */
export const INTENT_FIELDS = { digest: 'digest', kind: 'string', address: 'string', expected: 'string', replyTo: 'string', device: 'ident', writer: 'writer', copies: { optional: { array: { object: { address: 'string', bytes: 'base64' } } } } } as const satisfies Record<Exclude<keyof Intent, 'bytes'>, M.Shape>
/** Köpfe eines `journal-sync` (Review 28): Schreiberinkarnation → letzter Zähler. */
const HEADS_SHAPE: M.Shape = { record: 'nat', key: 'writer' }
const INTENT_SHAPE: M.Shape = { object: { ...INTENT_FIELDS, bytes: 'string' } } // `bytes` hier nur Platzhalter, geprüft unten
/** Form einer Transaktion aus `receiveOwnFrame` (Review 26 B2, Review 27 B2a), bevor das Gerät sie faltet: null oder was nicht stimmt. */
export function transactionProblem(tx: unknown): string | null {
  if (!isRecord(tx)) return 'transaction'
  if (!Array.isArray(tx.ops)) return 'ops'
  if (!Array.isArray(tx.intents)) return 'intents'
  for (const op of tx.ops) {
    const p = M.opProblem(op)
    if (p) return p
  }
  for (let k = 0; k < tx.intents.length; k++) {
    const i: unknown = tx.intents[k]
    if (!isRecord(i) || !(i.bytes instanceof Uint8Array)) return `intents[${k}]`
    const p = M.shapeProblem({ ...i, bytes: '' }, INTENT_SHAPE, `intents[${k}]`)
    if (p) return p
  }
  return null
}

/**
 * Was ein Kandidat je Gerät beisteuert. Der Holder-Zustand gehört dem Gerät; der Kandidat sagt, was erlaubt ist und wie
 * Schritte geteilt werden. Vertrag zum Alles-oder-nichts des Geräts (Tor-Review 3 B3, Review 6): `authorize` und
 * `receiveOwnFrame` sind rein (prüfen, dekodieren; kein Verbrauch, kein Journalwissen); Verbrauch von Rechten und
 * Journalwissen ändern sich nur in `commit`, das das Gerät genau einmal je gelungenem Schritt mit allen Operationen und
 * Absichten des Schritts aufruft. Ein Kandidat, der in `authorize` reserviert, wird bei einem Rollback nicht zurückgesetzt.
 */
export interface CandidateDevice {
  readonly keys: KeyScheme
  /** Schreiberinkarnation für Operations-IDs (wechselt bei Enrollment und Restore, Befund 5). */
  readonly writer: string
  /** Rechteprüfung VOR der Anwendung (B3): false = blockiert. Rein: ohne Nebenwirkung. Ohne Methode ist alles erlaubt. */
  authorize?(op: M.Op, state: M.HolderState): boolean
  /**
   * Darf dieses Gerät diesen fremden Vorrats-Schlüssel in einer Vorstellung benennen (K1a: vorab verteilte Schlüssel)? Rein.
   * Der Schlüssel kommt mit seinem kanonischen Wert aus `M.usableView` (Review 36 B7), nie aus einer Listung. Ohne Methode: alle.
   */
  mayName?(key: M.ListedKey): boolean
  /**
   * Darf dieses Gerät die Vorrats-Nummer n (8445) zuteilen (K1a, Tor-Review 21 B1)? Rein. Teilen sich Geräte eines Seeds
   * die Nummern, ergeben getrennte Zuteilungen derselben Nummer denselben Anker mit anderem Wert (Ablauf); mit Methode
   * überspringt das Nachfüllen jede Nummer, die nicht diesem Gerät gehört. Ohne Methode: alle.
   */
  mayAllocate?(n: number, rel: string, state: M.HolderState): boolean
  /** Ein Schritt ist gelungen und committet: der Kandidat zeichnet ihn als Einheit auf, verbreitet ihn (oder nicht) und verbraucht hier, was er kostet. */
  commit(tx: Transaction): void
  /** Rahmen an die eigenen Geräte (Journal), an die eigene Adresse der Person (Plan Runde 3). */
  takeOwnFrames(): OwnFrame[]
  /** Ein Rahmen eines eigenen Geräts: liefert den Schritt, den das Gerät anwenden soll. Rein: nur dekodieren; ein fehlender Vorgänger ist `M.Missing` (das Gerät stellt den Rahmen zurück). */
  receiveOwnFrame(body: Uint8Array): Transaction
  /** Der Schritt aus diesem Rahmen ist angewandt: der Kandidat merkt ihn sich (Dedupe, Vorgänger). Nach dem Gelingen gerufen. */
  applied?(body: Uint8Array): void
  /** Nachholen (HSC-440, X21): die bekannten Köpfe je Schreiber, und die Rahmen, die ein Gerät mit diesen Köpfen noch nicht hat. Ohne Methoden gibt es kein Nachholen. */
  heads?(): Record<string, number>
  batchesAfter?(heads: Record<string, number>): OwnFrame[]
  /** Die anderen eingeschriebenen Geräte der Person, die dieses Gerät aus dem Enrollment kennt (Teil von `persist`). Ohne Methode: nur aus dem Journal erkennbar. */
  siblings?(): string[]
  /** Flüchtiger Stand des Kandidaten für die Rücknahme eines Schritts (Tor-Review 7 B1): ohne Inkarnationswechsel, anders als `restore`. Ohne Methoden hält der Kandidat nichts Rücknehmbares. */
  snapshot?(): unknown
  rollback?(snapshot: unknown): void
  /**
   * Neuauswertung empfangener Proben (K1a Schritt 2): die Geräte lernen die Tupel ihrer Schwestergeräte (Journal), also
   * kann die eigene Tupelmenge nach dem Empfang einer Probe wachsen. Mit `true` behält das Gerät jede Probe der Gegenseite
   * mit ihren noch nicht getroffenen Einträgen und wertet sie neu aus, sobald ein gefalteter Batch neue eigene Tupel bringt
   * (`reevaluate` im Holder). Ohne Feld (K0, kein Journal) behält das Gerät nichts.
   */
  readonly reevaluateProbes?: boolean
  /**
   * Pseudonyme Schreiberkennung (K1a Schritt 4, Anton 18.10., 3a): je Gerät und Beziehung eine stabile Kennung, die die
   * Gegenseite nicht über Beziehungen verknüpfen kann. Mit Methode nummeriert das Gerät Revisionen je Kennung (8500 je
   * Schreiber) und trägt die Kennung in Revision, Probe und Mapping. Rein. Ohne Methode (K0) gibt es einen Schreiber.
   */
  writerTag?(relationship: string): string
  /**
   * K2 Schritt 2: Gerätemengen je Beziehung aus Nachweisen (`device-set@1`, Plan 6r). Mit `true` versiegelt das Gerät an
   * jedes Mitglied der Menge, die es für die Wurzel der Gegenseite aus empfangenen Nachweisen kennt (unbekannt: die Wurzel
   * allein; bekannt leer: ausdrücklicher Zustellfehler), nimmt eine Signatur nur eines Mitglieds an, veröffentlicht die
   * eigene Menge jeder Beziehung und weist Schwestergeräten einer neuen Beziehung Schlüssel aus ihrem Vorrat zu. Ohne Feld
   * (K0, K1a): ein Schlüssel je Kontext.
   */
  readonly deviceSets?: boolean
  /** K2 Schritt 2: hält dieses Gerät den privaten Teil des Vorrats-Schlüssels (strict: nur das zuteilende Gerät)? */
  holdsStock?(k: M.StockKey): boolean
  /** K2 Schritt 2: Nachfüllgrenzen für den eigenen Anteil am Vorrat (jedes Gerät hält seinen Anteil, 8485 je Gerät geteilt). */
  stockShare?(): { below: number; to: number }
  /** K2 Schritt 2: wie viele Annahmen dieses Gerät in der Mediatorbeziehung noch hat (MV-9); so viele Schlüssel listet es höchstens. */
  quotaLeft?(rel: string, state: M.HolderState, now: string): number
  /** K2 Schritt 2: Lebensdauer neuer Vorrats-Schlüssel (X23); ohne: 8465. */
  readonly stockLifetimeMs?: number
  /** K2 Schritt 2: der öffentliche Schlüssel Nummer `i` aus dem eigenen Vorrat für Schwestergeräte (Kontext `pool/<i>`). */
  poolKey?(i: number): Promise<Keys>
  /** K2 Schritt 2: die Namen der anderen Geräte der aktuellen eigenen Menge (Prüfstandsliste der eigenen Geräte bis Schritt 3). */
  siblingNames?(): string[]
  /** K2 Schritt 2, Gegenlauf: `false` = jedes zustimmende Gerät erzeugt eine Karte (ohne die Produzentenregel E2 (iv)). */
  readonly producerRule?: boolean
  /** K2 Schritt 2, Gegenlauf „nur Träger“: `false` = der Widerruf erreicht die Gegenseiten nicht (keine Mengenrevision). */
  readonly revocationToCounterparts?: boolean
  /** K2 Schritt 2: das Gerät, dessen Abbild dieser Kandidat trägt (ein Dieb mit dem Abbild von A2 hält A2s Schlüssel und Vorrat). */
  readonly owner?: string
  /** K2: die Self-Schlüssel der anderen Geräte der aktuellen Gerätemenge (an sie wird das Journal je Schwester versiegelt). */
  selfPeers?(): Promise<Array<{ anchor: string; rkid: string }>>
  /** K2: das Gerät der aktuellen Gerätemenge der eigenen Person, dessen Self-Anker das ist; null sonst (Befund `journal:unknown-writer`). */
  selfDevice?(anchor: string): Promise<string | null>
  /** K2: der Schreiber einer Revision ist der signierende Geräteschlüssel (8500/6270 je Signierer, `signerId`); keine Schreiberkennung im Dokument. */
  readonly signerWriters?: boolean
  /** K2: die Einführungs-Nonce dieses Geräts für eine Beziehung (8430/8445: jedes Gerät nummeriert seinen eigenen Vorrat unter eigener Nonce). */
  stockNonce?(relationship: string): string
  /** Was der Kandidat dauerhaft hält (Journal); Teil des Store-Abbilds. */
  persist(): unknown
  /** Neuaufbau aus dem Store; ein Kandidat mit Inkarnationen wechselt hier die Inkarnation. */
  restore(data: unknown): void
}

export interface MultiDeviceCandidate {
  readonly id: string
  readonly title: string
  readonly capabilities: ReadonlySet<'journal' | 'rights' | 'device-keys' | 'device-sets' | 'restricted-app' | 'writer-tags'>
  /** Erstes Gerät einer Person. */
  first(person: string, device: string, seed: Uint8Array): Promise<CandidateDevice>
  /** Eine Instanz, die kein Gerät der Person ist (Dieb aus einem Abbild, X9): unabhängig, ohne Eintrag in der Geräteliste des Kandidaten. Ohne Methode nimmt der Prüfstand `first`. */
  instance?(person: string, device: string, seed: Uint8Array): Promise<CandidateDevice>
  /** Weiteres Gerät: Enrollment aus einem bestehenden Gerät (X8). Liefert den Kandidatenteil, den Zustand und die Absichten, mit denen das neue Gerät beginnt (ohne Absichten produziert es offene Pflichten neu, K0). */
  enrol(from: HolderDevice, device: string, opts?: EnrolOptions): Promise<{ cand: CandidateDevice; state: M.HolderState; intents?: Intent[]; probes?: Array<[string, string[]]> }>
  /** Widerruf eines Geräts (X9, K2): was die übrigen Geräte und die Gegenseiten davon erfahren. Ohne Methode geschieht nichts. */
  revoke?(from: HolderDevice, device: string): Promise<void>
  /** Ein Enrollment ist nach `enrol` am Gerät gescheitert (kein Holder entstanden): der Kandidat gibt den Platz wieder frei. */
  release?(person: string, device: string): void
  /**
   * Prüfstandsoptionen der Welt, die diese Variante wählt (E15 Schritt 6): `selfLog` macht die Self-Adresse jeder Person
   * zur Ablage („Journal beim Dienst“). Dieselben Regeln, dieselben Szenarien; nur die Welt unterscheidet sich.
   */
  readonly bench?: {
    selfLog?: boolean
    /**
     * K2 Schritt 2a (Plan 6t): Personen, die der Prüfstand als Ein-Schreiber-Fixture führt (ein Gerät, kein zweites per
     * Enrollment im Szenarioaufbau). K2: M; verteilter M-Betrieb ist Schritt 2b.
     */
    singleDevice?: string[]
  }
}

/** Wie das neue Gerät seinen Stand bekommt (E15 Schritt 6): `fromLog` = aus der Ablage falten statt Zustandskopie vom alten Gerät. */
export interface EnrolOptions {
  fromLog?: boolean
}

// ── Dokumente ────────────────────────────────────────────────────────────────

export const TYPES = {
  revision: 'https://real-life.org/rltp/e15/introduction-prekeys/0.1',
  ticket: 'https://real-life.org/rltp/e15/introduction-ticket/0.1',
  card: 'https://real-life.org/rltp/e15/introduction-card/0.1',
  probe: 'https://real-life.org/rltp/e15/continuity-probe/0.1',
  mapping: 'https://real-life.org/rltp/e15/continuity-mapping/0.1',
  journal: 'https://real-life.org/rltp/e15/journal/0.1',
  journalSync: 'https://real-life.org/rltp/e15/journal-sync/0.1',
  deviceSet: 'https://real-life.org/rltp/e15/device-set/0.1',
  ack: 'https://real-life.org/trust-tasks/delivery-ack/0.1',
} as const

interface Doc {
  id: string
  type: string
  issuer: string
  recipient: string
  /** Antwortadresse des Absenders (rkid) für die Quittung. */
  replyTo: string
  issuedAt: string
  payload: Record<string, Json>
}

/** Eine Operation ohne Kennung und Zeit (verteilt über die Union). */
type OpBody = M.Op extends infer O ? (O extends M.Op ? Omit<O, 'id' | 'at'> : never) : never

/** Eigene Dokumente, deren Ausgang fachlich wirkt (Karte, Mapping), mit den Bytes für eine Wiederholung. */
interface Sent {
  kind: 'card' | 'mapping' | 'journal'
  act?: string
  pair?: [string, string]
  frame: Uint8Array
  address: string
}

interface Buffered {
  act: string
  from: string
  expiresAt: string
  card: M.Card
  v: string
  /** K2 Schritt 2: der Mengenbezug der Karte (Digest der Revision von `device-set@1`, die die Wurzel `card.anchor` trägt). */
  set?: string
  /** Review 33 B3: die volle Schlüsselbindung der Karte; bei der Zuordnung prüft 8850.6 (d) wie bei direkter Ankunft. */
  fromKeyAgreement?: string
}

export interface DeviceState {
  holder: M.HolderState
  submissions: Submission[]
  completed: string[]
  acks: Array<[string, { frame: Uint8Array; digest: string; address: string }]>
  dispositions: string[]
  counter: number
  candidate: unknown
  sent: Array<[string, Sent]>
  /** Karten vor dem Ticket (8910.1–.3), mit der ganzen Nutzlast für den Prüfsatz bei der Zuordnung (B7). */
  buffer: Array<[string, Buffered]>
  /** Produktionsabsichten, eigene und aus dem Journal der eigenen Geräte (B4). */
  intents: Array<[string, Intent]>
  /** Behaltene Proben der Gegenseite je eigenem Ankunftstupel: die noch nicht getroffenen Einträge (K1a Schritt 2). */
  probes?: Array<[string, string[]]>
  /** Digest → erwarteter Signierer der Quittung, für jede quittierbare Submission (#55). */
  expected: Array<[string, string]>
  /** Geräte der Person, die dieses Gerät widerrufen hat (Review 19, Frage 3): sie antworten auf kein Nachholen mehr. */
  revoked?: string[]
  /** Beziehungen, deren Revision während der Enrollment-Zeremonie aus der Ablage fällig wurde (Schritt 4): sie geht erst danach mit der dann nächsten Nummer hinaus. */
  owed?: string[]
  /** Schritt 6 (Variante): bis zu welcher Position das Gerät die Ablage an der Self-Adresse gelesen und gefaltet hat. */
  logCursor?: number
  /** Schritt 6 (Variante): behaltene Proben aus der Enrollment-Zeremonie, übernommen, wenn das Falten der Ablage fertig ist. */
  deferredProbes?: Array<[string, string[]]>
  /**
   * Tor-Review 40 B2: das Enrollment aus der Ablage läuft noch (Live-Zeremonie, `startFromLog`). Ein Neuladen mitten in der
   * Zeremonie setzt sie fort (Warten auf das Zeugnis, danach `owed` und `deferredProbes`); nach einem Restore sonst nie.
   */
  ceremony?: boolean
}

export interface Measures {
  framesOut: number
  bytesOut: number
  ownFramesOut: number
  ownBytesOut: number
  /** Vom Kandidaten blockierte Operationen (B1). */
  blocked: number
  /** Quittungen ohne eigene Submission: auf einer geteilten Adresse (one-seed) die Quittungen für das Schwestergerät (Tor-Review 3, Nebenbefund a). */
  unboundAcks: number
}

export type ActionResult = 'ok' | 'blocked' | 'crashed'

/**
 * E15 K2 step 2b.0: the bench's observation seam for the outcome ledger (`buch.ts`). Pure observation: every call hands
 * out the device's own values (its committed image, the plaintext of a document it built, a document its parser admitted)
 * and nothing it returns is read; no decision of the device depends on it. Unset (`null`) everywhere but in ledger runs.
 * Fail-safe (Tor-Review 42 (a)): an exception in a hook is caught at the seam, handed to `failed` and the device goes on
 * exactly as without an observer.
 */
export interface HolderObserver {
  /** A successful store commit of this device; `image` is what the store now holds (the observer copies what it keeps). */
  committed(d: HolderDevice, image: DeviceState): void
  /** A document this device signed and sealed (its own plaintext), with every frame it sealed for it. */
  produced(d: HolderDevice, p: { digest: string; type: string; issuer: string; recipient: string; payload: Record<string, Json>; frames: Uint8Array[] }): void
  /** A document delivered to this device that passed its parser's form checks (MV-24), before the fold decides on it. */
  admitted(d: HolderDevice, a: { digest: string; type: string; issuer: string; address: string; payload: Record<string, unknown> }): void
  /** A hook above threw; the seam caught it (an exception here is swallowed too). */
  failed?(d: HolderDevice, hook: 'committed' | 'produced' | 'admitted', error: unknown): void
}

/**
 * Is `issuer` the signer the counterpart may show for the recorded key `recorded`? K0/K1a: exactly that key. K2 step 2: a
 * member of the device set this receiver knows for the root `recorded` from received proofs (without a proof the root
 * alone; a revoked device never: a known revocation beats). Pure over the receiver's state (`HolderDevice.isPeer`, and the
 * ticket predicate below).
 */
export function peerIn(state: M.HolderState, sets: boolean, issuer: string, recorded: string): boolean {
  if (!sets) return issuer === recorded
  const set = M.own(state.sets, recorded)
  if (!set) return issuer === recorded
  return M.setView(set).members.some((m) => m.anchor === issuer)
}

/** The ticket payload as sent (`issue`) and read by the side (8640). */
export interface TicketPayload {
  act: string
  issuedAt: string
  expiresAt: string
  own: string
  voucher: { anchor: string; keyAgreement: string; name: string }
}
/** What the ticket check (8640) reads of the receiving device: its state, whether it runs device sets, its time, its channel. */
export interface TicketReceiver {
  state: M.HolderState
  sets: boolean
  now: string
  /** 8640.2 channel: the own tuple behind the address (K2: the head of the relationship whose stock key the address is). */
  tupleAt(address: string): M.Tuple | undefined
}
/**
 * The receiver's state steps between the binding steps of 8640 (the holder on receipt passes them; the outcome ledger's
 * reference does not: they are state, not binding).
 */
export interface TicketStateSteps {
  /** 8640.4: the act is held already (a repetition: effect, no new act). */
  repeated(p: TicketPayload): boolean
  /** 8640.12 (single use as a rule), 8640.6 (key active or aging): false refuses. */
  usable(own: M.StockKey, p: TicketPayload): boolean
}
export type TicketVerdict =
  | { ok: true; repeated: true }
  | { ok: true; repeated: false; rel: M.Relationship; own: M.StockKey; p: TicketPayload }
  | { ok: false; step: '8640.2' | '8640.3' | '8640.5' | '8640.7' | '8640.8' | 'state'; reason: string; p?: TicketPayload }

/**
 * E15 2b.0 (Tor-Review 43): the side's ticket acceptance predicate (8640, up to the voucher check 8640.8), pure over the
 * receiver's context; the holder calls it on receipt, the outcome ledger as the reference of P-Commit, so the ledger never
 * re-implements a ticket rule. Steps in order: 8640.2 channel (an own relationship behind the address) and signer (a
 * counterpart on that relationship; K2: a member of its device set), 8640.3 times; [8640.4 repetition: state]; 8640.5 the
 * named key on this relationship (K2: the address is its key agreement); [8640.12, 8640.6: state]; 8640.7 the key outlives
 * the act; 8640.8 the voucher is no own stock key. It stops before 8640.9 (voucher assignment), 8640.13 (budget) and the
 * acceptance 8640.14: state, not binding. Tickets have no MV-24 form in 2a (`DOC_SHAPES`; 2b.2 adds it).
 */
export function ticketAcceptance(doc: { issuer: string; payload: unknown }, address: string, rx: TicketReceiver, steps?: TicketStateSteps): TicketVerdict {
  const t = rx.tupleAt(address)
  if (!t) return { ok: false, step: '8640.2', reason: `no own relationship behind address ${address.slice(-8)}` }
  const r = M.relOfTuple(rx.state, t.id)!
  const peer = rx.sets ? r.tuples.some((x) => peerIn(rx.state, true, doc.issuer, x.peer)) : peerIn(rx.state, false, doc.issuer, t.peer)
  if (!peer) return { ok: false, step: '8640.2', reason: `signer ${doc.issuer.slice(-8)} is no counterpart on this relationship` }
  const p = doc.payload as TicketPayload
  if (Date.parse(rx.now) > Date.parse(p.expiresAt) || Date.parse(p.issuedAt) > Date.parse(rx.now) + M.PARAM.actSkewMs) return { ok: false, step: '8640.3', reason: 'outside the act times', p } // 8110
  if (steps?.repeated(p)) return { ok: true, repeated: true }
  const own = r.stock.find((k) => k.anchor === p.own && (!rx.sets || k.keyAgreement === address))
  if (!own) return { ok: false, step: '8640.5', reason: `own ${p.own.slice(-8)} not on this relationship at address ${address.slice(-8)}`, p }
  if (steps && !steps.usable(own, p)) return { ok: false, step: 'state', reason: `own ${own.anchor.slice(-8)} in state ${own.state}`, p }
  if (Date.parse(own.expiresAt) < Date.parse(p.expiresAt) + M.PARAM.actSkewMs) return { ok: false, step: '8640.7', reason: `own ${own.anchor.slice(-8)} expires before the act`, p }
  if (r.stock.some((k) => k.anchor === p.voucher.anchor)) return { ok: false, step: '8640.8', reason: `voucher ${p.voucher.anchor.slice(-8)} is an own stock key`, p }
  return { ok: true, repeated: false, rel: r, own, p }
}

export class HolderDevice {
  state: M.HolderState
  readonly zusteller: Zusteller
  completed = new Set<string>()
  acks = new Map<string, { frame: Uint8Array; digest: string; address: string }>()
  dispositions: string[] = []
  /** Empfangene Dokumente (Typ, Absender) für die Auswertung. */
  readonly log: Array<{ type: string; from: string; at: string; writer?: string; rel?: string }> = []
  /** Messung (X23, Review 34 S4): jede Ankunft einer Karte an diesem Gerät mit Akt, Zeit und Ausgang (Grund). Nur lesend genutzt. */
  readonly cardLog: Array<{ act: string; at: string; outcome: string }> = []
  online = true
  crashAt: CrashPoint | null = null
  readonly crashes: CrashPoint[] = []
  /** E15 2b.0: observation seam for the outcome ledger (bench only, never read back). */
  observer: HolderObserver | null = null
  /** Exceptions observer hooks threw (caught at the seam, never read by the device). */
  observerFailures = 0
  measures: Measures = { framesOut: 0, bytesOut: 0, ownFramesOut: 0, ownBytesOut: 0, blocked: 0, unboundAcks: 0 }
  private down = false
  private counter = 0
  private sent = new Map<string, Sent>()
  /**
   * Behaltene Proben (K1a Schritt 2): eigenes Ankunftstupel → Einträge der Probe(n) der Gegenseite, die noch keinen
   * Treffer ergeben haben. Gerätelokal wie ein empfangener Rahmen (nicht im Journal); Teil von Checkpoint und Store-Abbild.
   */
  private probes = new Map<string, string[]>()
  /** Lesbar für Messungen: die behaltenen Proben je Ankunftstupel. */
  keptProbes(): ReadonlyMap<string, readonly string[]> {
    return this.probes
  }
  /**
   * Enrollment (Tor-Review 16 S2): das neue Gerät übernimmt die behaltenen Proben mit dem Abbild des Geräts, aus dem es
   * eingeschrieben wird, wie Zustand und Absichten; so kann es sie neu auswerten, auch wenn jenes Gerät danach fehlt.
   */
  adoptProbes(probes: Iterable<readonly [string, readonly string[]]>): void {
    for (const [id, entries] of probes) this.probes.set(id, [...entries])
    this.dropDeparted()
  }
  /**
   * Aufbewahrung endet mit dem Abgang (Tor-Review 16 B1): Proben auf Tupeln einer abgegangenen (oder unbekannten)
   * Beziehung fallen weg. Teil jedes Anwendens: lokaler Abgang, gefalteter Abgang eines Schwestergeräts, Neuaufbau.
   */
  private dropDeparted(): void {
    for (const id of [...this.probes.keys()]) {
      const r = M.relOfTuple(this.state, id)
      if (!r || r.departed) this.probes.delete(id)
    }
  }
  private buffer = new Map<string, Buffered>()
  /** Digest → erwarteter Quittungs-Signierer je eigener Submission (#55); lesbar für Messungen. */
  expected = new Map<string, string>()
  /** Innerhalb eines `guarded`-Rahmens: der Schritt, den der Kandidat erst nach dem Gelingen als Einheit committet. */
  private pending: Transaction | null = null
  /**
   * Nachholen (HSC-440, X21): `pending` bis ein Schwestergerät geantwortet hat und die eigenen Köpfe dessen Köpfe decken;
   * solange wird mit Backoff erneut angefragt (Anfrage, Antwort oder Quittung können verloren gehen, Review 9 B1).
   * `id`: Kennung der laufenden Anfrage, frisch je gesendeter Anfrage; nur eine Antwort, die sie nennt, kann das Nachholen
   * beenden (Tor-Review 19 B1a: eine alte, gültig signierte Antwort ist an keine laufende Anfrage gebunden).
   */
  private sync: { pending: boolean; wait: number; backoff: number; id: string | null } = { pending: false, wait: 0, backoff: 1, id: null }
  /** Anzahl gesendeter Nachhol-Anfragen (Messgröße des Reparaturverkehrs). */
  syncRequests = 0
  /** Nachhol-Antworten ohne die Kennung der laufenden Anfrage (alt, wiederholt oder fremd): verworfen (Review 19 B1a). */
  staleSyncAnswers = 0
  /** Runden, in denen das Gerät nichts an Gegenseiten freigab (Messung; seit MV-6 neu nur noch beim Enrollment aus der Ablage). */
  gatedRounds = 0
  /** Widerrufene Geräte der Person (Teil des Abbilds): zählen nicht als Schwester, die nachholen hilft (Review 19 Frage 3). */
  private revoked = new Set<string>()
  /**
   * Schritt 4: Revisionen, die während der Enrollment-Zeremonie aus der Ablage fällig wurden (nach Restore gibt es seit
   * MV-6 neu kein Vormerken mehr; die Nummer kann sich wiederholen, 6270-Befund, benannter Preis). Mit Schreiberkennung
   * nummeriert das Gerät erst, wenn es die Revisionen aus dem Journal kennt (sonst verwendete es eine Nummer wieder,
   * 8500/6270); die Revision geht nach der Zeremonie mit der dann nächsten Nummer hinaus. Teil des Abbilds.
   */
  private owed = new Set<string>()
  /**
   * E15 Schritt 6 (Variante „Journal beim Dienst“, Anton 18.10.: Option untersuchen, nicht festlegen; nach Tor-Review 25
   * Anton 18.10.: „das Log beim Dienst ist Beschleunigung, nie Freigabegrund“). Mit `selfLog` ist die Self-Adresse der
   * Person beim Träger eine Ablage (zustellung.ts `retain`). Zwei Spuren: die Daten holt das Gerät schnell aus der Ablage
   * ab der eigenen Position (`logCursor`, Spur `logSync`, an die Anfragekennung gebunden, MV-5). Nach Restore gibt es keine
   * Freigabe-Sperre (MV-6 neu, MV-34): beide Spuren bringen nur Daten. Eine Freigabe gibt es nur noch am Ende des
   * Enrollments aus der Ablage (`startFromLog`): mit der Antwort eines Schwestergeräts, deren Köpfe der eigene Stand deckt
   * (`journal-sync`, Spur `sync`), oder mit dem Widerruf aller Schwestern (`deviceRevoked`); die Antwort der Ablage allein
   * beendet sie nie (Replication D1: Zurückhalten durch den Träger darf nie eine Freigabe bewirken; der Dienst kann eine
   * leere, verkürzte oder umgeordnete Antwort liefern, das Gerät kann deren Vollständigkeit nicht prüfen). Ohne Journal
   * (K0) wirkungslos.
   */
  selfLog = false
  private logCursor = 0
  /**
   * Spur der Ablage (Schritt 6): `pending` bis eine Antwort auf die laufende Leseanfrage vollständig gefaltet ist;
   * `answered`: auf die laufende Anfrage kam eine Antwort (unvollständig: Backoff; keine: nächste Runde erneut, Review 25 S2).
   */
  private logSync: { pending: boolean; wait: number; backoff: number; id: string | null; answered: boolean; from: number } = { pending: false, wait: 0, backoff: 1, id: null, answered: false, from: 0 }
  /** Während eine Antwort der Ablage gefaltet wird: zurückgestellte Einträge stoßen kein neues Nachholen an (die Antwort entscheidet). */
  private readingLog = false
  /** Leseanfragen an die Ablage (Messung, getrennt von den Anfragen an Schwestern `syncRequests`). */
  logRequests = 0
  /** Unlesbare oder ungültige Einträge der Ablage (Review 25 B2): nie gefaltet gezählt, der Cursor bleibt davor; je Position ein Befund. */
  logCorrupt = 0
  private corruptSeen = new Set<number>()
  /** Briefkasten (Review 26 B2): gültig signierte, nicht faltbare eigene Journalrahmen; je Digest ein Befund `journal:corrupt-frame`. */
  frameCorrupt = 0
  private corruptFrames = new Set<string>()
  /** K2 Schritt 1: Journalrahmen oder -batches von einem Schreiber außerhalb der aktuellen Gerätemenge (Befund `journal:unknown-writer`), je Digest einmal. */
  unknownWriters = 0
  private unknownSeen = new Set<string>()
  private deferredProbes: Array<[string, string[]]> | null = null
  /** Messung (Schritt 6): Einträge und Bytes, die dieses Gerät aus der Ablage gelesen hat. */
  logEntriesRead = 0
  logBytesRead = 0
  /** Nachholen über die Ablage statt über Schwestergeräte (Schritt 6). */
  get logMode(): boolean {
    return this.selfLog && !!this.cand.heads
  }
  /** Steht noch Nachholarbeit aus (Messung, Review 11 B2)? Erst ohne sie ist eine Reparatur beendet, nicht schon, wenn das Gerät im Backoff schweigt. Mit Ablage: beide Spuren. */
  get syncPending(): boolean {
    return this.sync.pending || this.logSync.pending
  }
  /** Schritt 6: steht das Falten der Ablage noch aus (Daten), unabhängig von der Freigabe? */
  get logPending(): boolean {
    return this.logSync.pending
  }
  /** Schritt 6: wartet das Gerät noch auf das Zeugnis einer Schwester (Freigabe), unabhängig von der Ablage? */
  get witnessPending(): boolean {
    return this.sync.pending
  }
  /** Gibt das Gerät gerade nichts an Gegenseiten frei? Nur beim Enrollment aus der Ablage (Schritt 6); nach Restore nie (MV-6 neu). */
  get gated(): boolean {
    return this.catchUp
  }
  /**
   * Messung (X21, Plan Abschnitt 5): Art jedes Rahmens, den dieses Gerät erzeugt hat, je SHA-256 der versiegelten
   * Bytes; so ordnet die Welt jede Einlieferung am Träger samt Wiederholung einem Gerät und einer Art zu. Nur Messung:
   * nicht Teil des Zustands, kein Einfluss auf das Verhalten, übersteht den Neuaufbau derselben Instanz.
   */
  readonly produced = new Map<string, string>()
  /** Produktionsabsichten (B4): eigene und die der anderen eigenen Geräte aus dem Journal; lesbar für Messungen. */
  intents = new Map<string, Intent>()
  /** Aufgezeichnet, noch nicht eingeliefert: geht nach dem nächsten Commit hinaus. */
  private held: string[] = []
  /**
   * Keine Sperre nach Restore (MV-6 neu, MV-34, Anton 20.10.): ein aus dem Store neu aufgebautes Gerät wartet auf niemanden.
   * Es fragt nach (`requestSync`, Beschleunigung, HSC-440) und handelt sofort aus dem erreichbaren Stand; was es dabei
   * doppelt oder gegen eine inzwischen gefallene Entscheidung nach außen gibt, fängt die Gegenseite nach den Regeln ab
   * (Karte übergeben = verbunden, Regel 2; A hält den Einmalverbrauch, 8640.12 als Regel). Die frühere Sperre aus Tor-Review
   * 18 B1a (K1a Schritt 3), ihr Hybrid (Schritt 6) und die Ausgabesperre von M (Review 38/39) sind entfernt.
   *
   * Übrig bleibt nur das Enrollment aus der Ablage (Schritt 6, Variante `k1a-journal-service`, `startFromLog`): das neue
   * Gerät beginnt leer und gibt bis zum Zeugnis des einschreibenden Geräts nichts an Gegenseiten frei. Das ist eine
   * Live-Zeremonie mit dem alten Gerät (MV-34 erlaubt sie, Anton 20.10.: sie bleibt), kein Restore; sie übersteht ein
   * Neuladen des neuen Geräts (Abbildfeld `ceremony`, Tor-Review 40 B2).
   */
  private catchUp = false
  /** Während des Nachholens freigegeben, aber zurückgehalten (B1a); nach dem Nachholen geprüft und eingeliefert. */
  private parked: string[] = []
  private readonly ctxOfRkid = new Map<string, string>()
  private readonly ctxOfAnchor = new Map<string, string>()
  private privOf = new Map<string, CryptoKey>()
  private ownRkid: string | null = null
  private carrierRef: Carrier
  constructor(
    readonly name: string,
    readonly person: string,
    public cand: CandidateDevice,
    carrier: Carrier,
    readonly clock: Clock = realClock,
    private readonly store?: Store<DeviceState>,
    state: M.HolderState = M.emptyState(person),
  ) {
    this.state = M.fromJson(state) // Review 28: Tabellen ohne Prototyp, auch aus einem Enrollment
    this.carrierRef = carrier
    this.zusteller = new Zusteller(name, () => this.carrierRef, () => this.online && !this.down)
    this.zusteller.gate = (x) => this.catchUp && !this.ownTraffic(x.address) // B1a: Wiederholungen warten bis zum Ende der Enrollment-Zeremonie
  }
  get carrier() {
    return this.carrierRef
  }
  rebind(carrier: Carrier) {
    this.carrierRef = carrier
    for (const a of this.ctxOfRkid.keys()) carrier.register(this.name, a)
  }

  // ── Adressen und Schlüssel ──
  /** K2 Schritt 1: die Self-Adressen der Schwestergeräte der aktuellen Menge (Journal, Nachholen, Quittungen darauf); abgeleitet, nicht im Abbild. */
  private siblingSelves = new Set<string>()
  private async refreshSiblings(): Promise<void> {
    if (this.cand.selfPeers) this.siblingSelves = new Set((await this.cand.selfPeers()).map((k) => k.rkid))
  }
  /** Verkehr zwischen eigenen Geräten (die Enrollment-Zeremonie hält ihn nicht zurück, B1a): K0/K1a die gemeinsame Self-Adresse, K2 zusätzlich die der Schwestern. */
  private ownTraffic(address: string | undefined): boolean {
    return address === this.ownRkid || (address !== undefined && this.siblingSelves.has(address))
  }
  /** Die Self-Adresse dieses Geräts (K0/K1a: die gemeinsame der Person; K2: je Gerät). */
  get selfAddress(): string | null {
    return this.ownRkid
  }
  /** K2 Schritt 2: das Gerät, dessen Schlüssel und Vorrat dieser Holder führt (ein Dieb mit dem Abbild: das bestohlene). */
  private get me(): string {
    return this.cand.owner ?? this.name
  }
  /** K2 Schritt 2: Gerätemengen je Beziehung aus Nachweisen (`device-set@1`), eigene Schlüssel je Gerät. */
  private get sets(): boolean {
    return !!this.cand.deviceSets
  }
  /** Was dieses Gerät über die Gerätemenge der Wurzel `root` weiß (eigene oder fremde), aus Nachweisen. */
  setOf(root: string): M.DeviceSet | undefined {
    return M.own(this.state.sets, root)
  }
  /**
   * K2 Schritt 2: an wen ein Dokument für die Wurzel `root` geht. Null = unbekannte Mitgliedschaft (kein Nachweis: der
   * genannte Schlüssel allein); leer = bekannt leere Menge (alle widerrufen: ausdrücklicher Zustellfehler, nie ein Rahmen an
   * einen aufgezeichneten Schlüssel, Tor-Review 31 S1).
   */
  private recipientsOf(root: string): Array<{ anchor: string; rkid: string }> | null {
    const set = this.setOf(root)
    if (!set) return null
    return M.setView(set).members.map((m) => ({ anchor: m.anchor, rkid: m.keyAgreement }))
  }
  /** K2 Schritt 2: Dokumente, die an einer bekannt leeren Gerätemenge scheiterten (ausdrücklicher Zustellfehler, kein Rahmen). */
  emptySetFailures = 0
  /** K2 Schritt 2: Karten, die vor ihrem Mengennachweis ankamen (zurückgestellt, kein V, kein K, keine Quittung). */
  deferredCards = 0
  /** Eigene Karten, die Regel 3 als verlierende Übergabe zurücknahm (K1a); unter E2 (iv) gibt es keine Verliererin (Messung). */
  losingCardsWithdrawn = 0
  /** Nummeriert das Gerät Revisionen je Schreiber (K1a Schritt 4: Kennung; K2: Geräteschlüssel)? */
  private get perWriter(): boolean {
    return !!(this.cand.writerTag || this.cand.signerWriters)
  }
  /**
   * Ist `issuer` der Signierer, den das Gegenüber für den aufgezeichneten Schlüssel `recorded` zeigen darf? K0/K1a: genau
   * dieser. K2 Schritt 2: ein Mitglied der Gerätemenge, die dieses Gerät für die Wurzel `recorded` aus empfangenen
   * Nachweisen kennt (ohne Nachweis die Wurzel allein; ein widerrufenes Gerät nie: ein bekannter Widerruf schlägt).
   */
  private async isPeer(issuer: string, recorded: string): Promise<boolean> {
    return peerIn(this.state, this.sets, issuer, recorded)
  }
  /** K2: der Kontext eines aufgezeichneten eigenen Ankers (der des Geräts, das ihn erzeugt hat): Tupel, Vorrat, Karte. */
  private recordedCtx(anchor: string): string | undefined {
    for (const r of this.state.relationships) {
      for (const t of r.tuples) if (t.own === anchor) return t.ownKey
      for (const k of r.stock) if (k.anchor === anchor) return k.key
    }
    for (const a of this.state.acts) if (a.ownCard?.anchor === anchor && a.ownCardKey) return a.ownCardKey
    return undefined
  }
  /** Schreiber dieses Geräts in einer Beziehung: K1a die Kennung, K2 der signierende Geräteschlüssel (Kopf), K0 keiner. */
  private async writerOf(relId: string): Promise<string | undefined> {
    if (this.cand.writerTag) return this.cand.writerTag(relId)
    if (!this.cand.signerWriters) return undefined
    return signerId((await this.keysFor(M.head(M.rel(this.state, relId)).ownKey)).anchor)
  }
  /** Journalrahmen und Nachholen nur von einem eigenen Gerät (K0/K1a: der gemeinsame Self-Anker; K2: ein Gerät der aktuellen Menge). */
  private async fromOwnDevice(issuer: string): Promise<boolean> {
    if (this.cand.selfDevice) return (await this.cand.selfDevice(issuer)) !== null
    return issuer === (await this.keysFor(`self/${this.person}`)).anchor
  }
  private ownSignerRejected(issuer: string, digest: string): void {
    if (!this.cand.selfDevice) {
      this.dispositions.push('failed(journal-from-unexpected-signer)')
      return
    }
    if (this.unknownSeen.has(digest)) return
    this.unknownSeen.add(digest)
    this.unknownWriters++
    this.dispositions.push(`finding(journal:unknown-writer@${issuer.slice(-8)})`)
  }
  /** Jeder eigene Empfangsschlüssel ist eine Adresse am Träger; beide Geräte einer Person registrieren dieselben (K0/K1). */
  async listen(ctx: string): Promise<Keys> {
    const k = await this.keysFor(ctx)
    if (!this.ctxOfRkid.has(k.rkid)) {
      this.ctxOfRkid.set(k.rkid, ctx)
      this.ctxOfAnchor.set(k.anchor, ctx)
      this.carrierRef.register(this.name, k.rkid)
    }
    return k
  }
  /** Nach Enrollment oder Neuaufbau: alle Adressen aus dem Zustand neu registrieren, offene Pflichten wieder aufnehmen. */
  async relisten(): Promise<void> {
    this.ownRkid = (await this.listen(`self/${this.person}`)).rkid
    await this.refreshSiblings()
    if (this.selfLog) this.carrierRef.retain(this.ownRkid) // Schritt 6: die Self-Adresse ist eine Ablage
    for (const r of this.state.relationships) {
      for (const t of r.tuples) await this.listen(t.ownKey)
      for (const k of r.stock) if (!this.cand.holdsStock || this.cand.holdsStock(k)) await this.listen(k.key) // K2 Schritt 2: nur, wer den privaten Teil hält
    }
    for (const a of this.state.acts) if (a.ownCardKey) await this.listen(a.ownCardKey)
    await this.resumeDuties()
  }
  private readonly resolve = (rkid: string): CryptoKey | undefined => this.privOf.get(rkid)
  /**
   * E15 2b.0 (Tor-Review 44, 47): bench only. Every private key agreement this device's resolver hands `receive` (key id →
   * key), for the outcome ledger's own copy: it opens every frame as this device would, with the same resolver. A read: the
   * device never reads what the ledger does with it, and nothing here changes the device (a copy of the map).
   */
  receiverKeys(): Array<[string, CryptoKey]> {
    return [...this.privOf]
  }
  private async keysFor(ctx: string): Promise<Keys> {
    const k = await this.cand.keys.pair(ctx)
    this.privOf.set(k.rkid, k.x.priv)
    return k
  }

  // ── Operationen ──
  private op(body: OpBody): M.Op {
    return { id: { writer: this.cand.writer, n: ++this.counter }, at: this.clock.now(), ...body } as unknown as M.Op
  }
  /** Entscheiden → freigeben (Kandidat) → anwenden → aufzeichnen. Wirft `Blocked`, wenn der Kandidat die Operation verweigert. */
  private emit(body: OpBody): M.Op {
    const op = this.op(body)
    const problem = M.opProblem(op) // CodeRabbit #71: lokal und im Journal dieselbe Form, sonst divergiert die Schwester
    if (problem) {
      this.counter--
      throw new InvalidInput(`${op.kind}: ${problem}`)
    }
    if (this.cand.authorize && !this.cand.authorize(op, this.state)) {
      this.counter--
      this.measures.blocked++
      throw new Blocked(op.kind)
    }
    M.apply(this.state, op)
    if (this.pending) this.pending.ops.push(op)
    else this.cand.commit({ ops: [op], intents: [] })
    return op
  }
  /** Ein Schritt eines eigenen Geräts (Journal) anwenden: Operationen falten, Absichten merken; die Zuständigkeit bleibt beim erzeugenden Gerät. */
  async applyRemote(tx: Transaction): Promise<void> {
    const known = this.tupleIds()
    for (const op of tx.ops) M.apply(this.state, op)
    this.dropDeparted() // ein gefalteter Abgang beendet die Aufbewahrung wie ein lokaler (Tor-Review 16 B1)
    for (const i of tx.intents) if (!this.intents.has(i.digest)) this.intents.set(i.digest, i)
    await this.withdrawLosingCards()
    await this.relisten()
    await this.produceOwed() // K2 Schritt 2, E2 (iv): eine Zustimmung aus dem Journal; das zuteilende Gerät erzeugt die Karte
    await this.connectOwed() // 8325.A5c: eine wartende Gegenkarte aus dem Journal beim Gerät mit der eingereichten Karte neu prüfen
    if ([...this.tupleIds()].some((id) => !known.has(id))) await this.reevaluate() // die eigene Tupelmenge ist gewachsen
    await this.refillAll()
  }

  // ── Alles oder nichts ──
  private checkpoint() {
    return {
      holder: M.cloneState(this.state),
      submissions: structuredClone([...this.zusteller.submissions.values()]), // tief: auch die Berichte (B3)
      completed: new Set(this.completed),
      acks: new Map(this.acks),
      counter: this.counter,
      sent: new Map(this.sent),
      buffer: new Map(this.buffer),
      expected: new Map(this.expected),
      intents: new Map(this.intents),
      probes: new Map(this.probes),
      owed: new Set(this.owed),
      cand: this.cand.snapshot?.(),
      held: this.held.slice(),
      framesOut: this.measures.framesOut,
      bytesOut: this.measures.bytesOut,
    }
  }
  private rollback(c: ReturnType<HolderDevice['checkpoint']>) {
    this.state = c.holder
    this.zusteller.restore(c.submissions)
    this.completed = c.completed
    this.acks = c.acks
    this.counter = c.counter
    this.sent = c.sent
    this.buffer = c.buffer
    this.expected = c.expected
    this.intents = c.intents
    this.probes = c.probes
    this.owed = c.owed
    this.cand.rollback?.(c.cand)
    this.held = c.held
    this.measures.framesOut = c.framesOut
    this.measures.bytesOut = c.bytesOut
  }
  /**
   * Ein Schritt ganz oder gar nicht: scheitert er, wird alles seit dem Beginn zurückgenommen und der Kandidat hat
   * nichts aufgezeichnet. Verweigert der Kandidat eine Operation (`Blocked`): Disposition `blocked(<op>)`, false.
   * Fehlt einem empfangenen Rahmen eine Voraussetzung (`Missing`, nur mit `defer`): `deferred(<was>)`, false; die
   * Gegenseite wiederholt den Rahmen. Absturz und andere Fehler gehen nach dem Rollback durch (das Szenario ist
   * dann `crashed`; ein Prüfstandfehler wird nie als Eingangsfehler verbucht, B1).
   */
  private async guarded(f: () => Promise<void>, defer = false): Promise<boolean> {
    const c = this.checkpoint()
    const outer = this.pending
    this.pending = { ops: [], intents: [] }
    try {
      await f()
      const tx = this.pending
      this.pending = outer
      if (outer) {
        outer.ops.push(...tx.ops)
        outer.intents.push(...tx.intents)
      } else if (tx.ops.length || tx.intents.length) this.cand.commit(tx)
      return true
    } catch (e) {
      this.pending = outer
      this.rollback(c)
      if (e instanceof Blocked) {
        this.dispositions.push(`blocked(${e.message})`)
        return false
      }
      if (e instanceof InvalidInput) {
        this.dispositions.push(`failed(invalid-input): ${e.message}`)
        return false
      }
      if (defer && e instanceof M.Missing) {
        this.dispositions.push(`deferred(${e.what}:${e.ref})`)
        if (e.what === 'batch' && !this.sync.pending && !this.readingLog) this.requestSync() // der Vorgänger fehlt: nachholen lassen
        return false
      }
      throw e
    }
  }

  // ── Store, Commit-Grenze, Absturz ──
  snapshotState(): DeviceState {
    return {
      holder: M.cloneState(this.state),
      submissions: [...this.zusteller.submissions.values()],
      completed: [...this.completed],
      acks: [...this.acks],
      dispositions: this.dispositions.slice(),
      counter: this.counter,
      candidate: this.cand.persist(),
      sent: [...this.sent],
      buffer: [...this.buffer],
      expected: [...this.expected],
      intents: [...this.intents],
      probes: [...this.probes],
      ...(this.revoked.size ? { revoked: [...this.revoked] } : {}),
      ...(this.owed.size ? { owed: [...this.owed] } : {}),
      ...(this.logMode ? { logCursor: this.logCursor } : {}),
      ...(this.deferredProbes ? { deferredProbes: this.deferredProbes.map(([id, e]): [string, string[]] => [id, [...e]]) } : {}),
      ...(this.catchUp ? { ceremony: true } : {}),
    }
  }
  commit() {
    if (!this.store) return
    const image = this.snapshotState()
    this.store.commit(image)
    this.observe('committed', (o) => o.committed(this, image))
  }
  /** The fail-safe observation seam: a hook that throws changes nothing in what the device does next (Tor-Review 42 (a)). */
  private observe(hook: 'committed' | 'produced' | 'admitted', f: (o: HolderObserver) => void): void {
    const o = this.observer
    if (!o) return
    try {
      f(o)
    } catch (e) {
      this.observerFailures++
      try {
        o.failed?.(this, hook, e)
      } catch {
        // the report of a failed hook may fail too; the device goes on
      }
    }
  }
  /** Neuaufbau aus dem Store (#57): alles Flüchtige wird aus dem Abbild ersetzt, nichts bleibt aus dem alten Lauf. */
  async reload(): Promise<void> {
    const s = this.store?.load()
    this.state = s?.holder ? M.fromJson(s.holder) : M.emptyState(this.person) // Review 28: Tabellen ohne Prototyp
    this.zusteller.restore(s?.submissions ?? [])
    this.completed = new Set(s?.completed ?? [])
    this.acks = new Map(s?.acks ?? [])
    this.dispositions = s?.dispositions.slice() ?? []
    this.counter = s?.counter ?? 0
    this.sent = new Map(s?.sent ?? [])
    this.buffer = new Map(s?.buffer ?? [])
    this.expected = new Map(s?.expected ?? [])
    this.intents = new Map(s?.intents ?? [])
    this.probes = new Map(s?.probes ?? [])
    this.revoked = new Set(s?.revoked ?? [])
    this.owed = new Set(s?.owed ?? [])
    this.logCursor = s?.logCursor ?? 0
    this.deferredProbes = s?.deferredProbes ?? null
    this.dropDeparted()
    // Was im Store steht, ist committet: vorgemerkte, nie freigegebene Submissions gehen nach dem nächsten Commit hinaus.
    this.held = this.zusteller.unreleased()
    this.cand.restore(s?.candidate ?? null)
    this.down = false
    this.parked = []
    await this.relisten()
    // MV-6 neu / MV-34: keine Sperre; nachgeholt wird als Beschleunigung (Schwester oder Ablage, MV-35), gehandelt sofort.
    // Ausnahme (Tor-Review 40 B2): lief beim Commit das Enrollment aus der Ablage, setzt das Gerät diese eigene Zeremonie
    // fort (kein Warten auf einen anderen, Anton 20.10.); `owed` und `deferredProbes` werden an ihrem Ende abgearbeitet.
    this.catchUp = !!s?.ceremony
    this.requestSync()
  }
  /**
   * Hat die Person ein anderes Gerät, das auf `journal-sync` antworten kann? Ein Gerät aus dem Enrollment (`siblings`)
   * oder ein Schreiber im eigenen Journal, der nicht eine Inkarnation dieses Geräts ist (Schreiber `<Gerät>@<Inkarnation>`). Ohne Journal (K0) oder ohne Schwester
   * antwortet niemand: dann hält das Gerät nichts zurück (sonst bliebe es für immer stumm).
   */
  private hasSibling(): boolean {
    const heads = this.cand.heads?.()
    if (!heads || !this.ownRkid) return false
    const other = (d: string) => d !== this.name && !this.revoked.has(d)
    return (this.cand.siblings?.() ?? []).some(other) || Object.keys(heads).some((w) => other(w.split('@')[0]!))
  }
  /**
   * Ein Gerät der Person ist von diesem Gerät aus widerrufen (Review 19, Frage 3): es antwortet auf kein Nachholen mehr.
   * Wartet ein Gerät beim Enrollment aus der Ablage nur noch auf widerrufene Schwestern, endet das Warten.
   */
  deviceRevoked(device: string): void {
    this.revoked.add(device)
    // Schritt 6 (Hybrid): mit Ablage genauso; die Ablage faltet weiter (Daten), die Freigabe hängt nicht an ihr.
    if (this.catchUp && !this.hasSibling()) this.sync = { pending: false, wait: 0, backoff: 1, id: null }
    this.commit()
  }
  /** Freigeben (nach dem Commit): beim Enrollment aus der Ablage bis zum Zeugnis nur Verkehr an die eigene Adresse. */
  private release(ds: string[]): void {
    let out = 0
    for (const d of ds) {
      if (this.catchUp && !this.ownTraffic(this.zusteller.submissions.get(d)?.address)) {
        if (!this.parked.includes(d)) this.parked.push(d)
      } else {
        // E15 K2 2b.0: crash point between two releases (both tickets of an issuance): the first is at the carrier, the
        // rest is committed and goes out after the rebuild (`unreleased`).
        if (out++ > 0) this.crash('between-sends')
        this.zusteller.deposit(d)
      }
    }
  }
  /**
   * Enrollment aus der Ablage (Schritt 6): das neue Gerät beginnt leer und faltet die Ablage ab Position 0 (kein
   * Schnappschuss, keine Kompaktierung); bis zum Zeugnis gibt es nichts an Gegenseiten frei (Live-Zeremonie) und teilt
   * nichts zu. Die behaltenen Proben (Gerätezustand, nicht Journal, MV-18) kommen aus der Zeremonie und werden übernommen,
   * wenn das Falten fertig ist (vorher kennt das Gerät ihre Tupel nicht).
   */
  startFromLog(probes: Array<[string, string[]]>): void {
    this.catchUp = true
    this.logCursor = 0
    this.deferredProbes = probes.length ? probes.map(([id, e]): [string, string[]] => [id, [...e]]) : null
    this.requestSync()
  }
  /**
   * Nachholen anstoßen: nach Neuaufbau, Enrollment oder wenn ein Rahmen zurückgestellt wurde (HSC-440). Schritt 6
   * (Hybrid): zuerst liest das Gerät die Ablage; die Anfrage an die Schwestern geht eine Runde später mit den dann
   * gefalteten Köpfen hinaus (die Schwester liefert nur, was die Ablage nicht brachte, und bezeugt den Stand).
   */
  requestSync() {
    this.sync = { pending: true, wait: this.logMode ? 1 : 0, backoff: 1, id: null } // keine Anfrage läuft: keine Antwort beendet das Nachholen
    if (this.logMode) this.logSync = { pending: true, wait: 0, backoff: 1, id: null, answered: false, from: 0 }
  }
  private crash(point: CrashPoint) {
    if (this.crashAt !== point) return
    this.crashAt = null
    this.down = true
    this.crashes.push(point)
    throw new Crashed(point)
  }
  /**
   * Commit-Grenze einer Nutzeraktion: Zustand und versandfertige Bytes
   * sichern, dann freigeben. `before-send` liegt zwischen Commit und Freigabe
   * (HSC-110, #56). Ein Absturz dort lässt das Gerät aus; die Submissions
   * stehen im Store und gehen nach dem Neuaufbau hinaus.
   */
  private async flush(): Promise<void> {
    this.crash('before-commit')
    this.commit()
    this.crash('before-send')
    this.release(this.held.splice(0))
  }
  /** Eine Nutzeraktion: blockiert (ganz zurückgenommen) oder abgestürzt heißt nicht fehlerhaft. */
  private async action(f: () => Promise<void>): Promise<ActionResult> {
    if (this.down) return 'crashed'
    try {
      if (!(await this.guarded(f))) return 'blocked'
      await this.flush()
      return 'ok'
    } catch (e) {
      if (e instanceof Crashed) return 'crashed'
      throw e
    }
  }

  // ── Senden ──
  /** Dokument signieren, versiegeln, aufzeichnen; eingeliefert wird nach dem nächsten Commit (`flush`, Rundenende). `recipient` ist der Anker, von dem die Quittung erwartet wird (#55). */
  /**
   * K2: `fan` (oder, für Gegenseiten, die Gerätemenge der Wurzel `recipient` aus Nachweisen, Schritt 2) nennt die
   * Geräteschlüssel, an die dasselbe signierte Dokument je einmal versiegelt wird (eine Kopie je Gerät an dessen eigene
   * Adresse, eine Submission). Der aufgezeichnete Schlüssel geht zuerst, wenn er noch zur Menge gehört. Ohne Menge (K0,
   * K1a): ein Rahmen an `toRkid`. Ist die Menge bekannt leer (Schritt 2), entsteht kein Rahmen: null, ausdrücklicher
   * Zustellfehler (`failed(empty-device-set)`), nie ein Rahmen an den aufgezeichneten Schlüssel (Tor-Review 31 S1).
   */
  private async sendDoc(type: string, issuerCtx: string, recipient: string, toRkid: string, replyTo: string, payload: Record<string, Json>, fan?: Array<{ anchor: string; rkid: string }>): Promise<{ digest: string; bytes: Uint8Array; address: string; frames: number; total: number } | null> {
    const set = fan ?? (this.sets ? this.recipientsOf(recipient) : null)
    if (set && !set.length) {
      this.emptySetFailures++
      this.dispositions.push(`failed(empty-device-set): ${type.split('/').slice(-2)[0] ?? type} an ${recipient.slice(-8)}`)
      return null
    }
    const k = await this.keysFor(issuerCtx)
    const unsigned: Doc = { id: crypto.randomUUID(), type, issuer: k.anchor, recipient, replyTo, issuedAt: this.clock.now(), payload }
    const doc = await diSign({ anchor: k.anchor, ed: { priv: k.ed.priv } }, unsigned as unknown as Record<string, Json>, this.clock.now())
    const to = set?.length ? [...set.filter((x) => x.rkid === toRkid), ...set.filter((x) => x.rkid !== toRkid)] : [{ anchor: recipient, rkid: toRkid }]
    const frames: Array<{ address: string; frame: Uint8Array }> = []
    for (const r of to) frames.push({ address: r.rkid, frame: enc.encode(jcs(await seal(doc as unknown as Json, r.rkid))) })
    const { address, frame: bytes } = frames[0]!
    const extra = frames.slice(1)
    const digest = await digestBytes(enc.encode(jcs(doc)))
    const kind = type === TYPES.journalSync ? (payload.reply ? 'journal-sync-reply' : 'journal-sync') : (type.split('/').slice(-2)[0] ?? type)
    for (const f of frames) this.produced.set(frameHash(f.frame), kind)
    this.observe('produced', (o) => o.produced(this, { digest, type, issuer: k.anchor, recipient, payload, frames: frames.map((f) => f.frame) }))
    this.zusteller.record(digest, bytes, address, extra.length ? extra : undefined)
    this.held.push(digest)
    this.expected.set(digest, recipient)
    if (type !== TYPES.journal && type !== TYPES.journalSync) {
      const intent: Intent = { digest, kind: type, bytes, address, expected: recipient, replyTo, device: this.name, writer: this.cand.writer, ...(extra.length ? { copies: extra.map((x) => ({ address: x.address, bytes: Buffer.from(x.frame).toString('base64') })) } : {}) }
      this.intents.set(digest, intent)
      this.pending?.intents.push(intent)
    }
    const total = frames.reduce((n, f) => n + f.frame.length, 0)
    this.measures.framesOut += frames.length
    this.measures.bytesOut += total
    return { digest, bytes, address, frames: frames.length, total }
  }

  // ── Nutzeraktionen und Fachlogik ──

  /** Schlüssel für eine Begegnung (bevor das Tupel geöffnet ist): die Gegenseite braucht Anker und rkid. */
  async encounterKeys(id: string): Promise<Keys> {
    return this.listen(`enc/${id}/${this.person}`)
  }
  /** Begegnung: eigenes Tupel zu einer Gegenseite öffnen (Encounter, vereinfacht). `id` ist je Begegnung gleich für beide Seiten (Prüfstand). */
  async openEncounter(id: string, peer: { anchor: string; rkid: string }): Promise<M.Tuple> {
    const ctx = `enc/${id}/${this.person}`
    const k = await this.listen(ctx)
    const t: M.Tuple = { id: `${this.person}:${id}`, own: k.anchor, ownKey: ctx, peer: peer.anchor, peerKeyAgreement: peer.rkid, record: `${id}:${k.anchor}`, openedAt: this.clock.now(), candidates: this.candidates(), deactivated: false }
    await this.action(async () => {
      this.emit({ kind: 'open-tuple', rel: null, tuple: t, provenance: 'encounter', vouchedBy: null, act: null })
      await this.admitSiblings(k.anchor, ctx, k.rkid) // K2 Schritt 2: die eigene Menge der neuen Beziehung, Wurzel = dieser Anker
      await this.publishSets(k.anchor)
      await this.sendProbe(t)
    })
    return t
  }

  // ── K2 Schritt 2: Gerätemengen (`device-set@1`) und der Vorrat öffentlicher Geräteschlüssel ──

  /** Ein Mengennachweis, signiert mit dem Schlüssel dieses Geräts für den Kontext `ctx` (DI über {root, kind, anchor, keyAgreement, by}). */
  private async cert(ctx: string, c: { root: string; kind: 'admit' | 'revoke'; anchor: string; keyAgreement: string | null }): Promise<M.SetCert> {
    const k = await this.keysFor(ctx)
    const body = { root: c.root, kind: c.kind, anchor: c.anchor, keyAgreement: c.keyAgreement, by: k.anchor }
    return (await diSign({ anchor: k.anchor, ed: { priv: k.ed.priv } }, body as unknown as Record<string, Json>, this.clock.now())) as unknown as M.SetCert
  }
  /** Form, Wurzelbindung und Signatur eines empfangenen Nachweises (vor jeder Faltung). */
  private async certValid(c: unknown, root: string): Promise<boolean> {
    if (M.shapeProblem(c, M.SHAPES.cert, 'cert')) return false
    const x = c as M.SetCert
    if (x.root !== root) return false
    try {
      return await diVerify(x as unknown as Doc & { proof: unknown }, x.by)
    } catch {
      return false
    }
  }
  /**
   * Der eigene Kontext einer eigenen Wurzel und wohin ihre Revision geht: ein eigenes Tupel (an die Wurzel der Gegenseite)
   * oder eine noch nicht verbundene eigene Karte (an den Voucher der Gegenseite, mit der Karte). Undefined: keine eigene Wurzel.
   */
  private rootCtx(root: string): { ctx: string; to: { anchor: string; rkid: string } | null; departed: boolean } | undefined {
    for (const r of this.state.relationships) for (const t of r.tuples) if (t.own === root) return { ctx: t.ownKey, to: { anchor: t.peer, rkid: t.peerKeyAgreement }, departed: r.departed }
    for (const a of this.state.acts) if (a.ownCard?.anchor === root && a.ownCardKey) return { ctx: a.ownCardKey, to: a.opened || a.state === 'declined' || a.state === 'expired' ? null : { anchor: a.voucher.anchor, rkid: a.voucher.keyAgreement }, departed: false }
    return undefined
  }
  /** Ist der Schlüssel dieses Geräts für eine eigene Wurzel Mitglied ihrer Menge? */
  private async memberOf(set: M.DeviceSet, ctx: string): Promise<string | null> {
    const me = (await this.keysFor(ctx)).anchor
    return M.setView(set).members.some((m) => m.anchor === me) ? me : null
  }
  /**
   * Schwestergeräte in die eigene Menge einer Wurzel aufnehmen, die dieses Gerät geöffnet hat (Plan 6o.2): je Schwester der
   * kleinste unbenutzte Schlüssel ihres Vorrats, den sie diesem Gerät bestimmt hat (`pool-use`: ab jetzt ihr Schlüssel für
   * den Kontext). Ohne Vorrat bleibt die Schwester draußen, bis einer ankommt (`admitPending`, gemessene Lücke).
   */
  private async admitSiblings(root: string, ctx: string, rootKa: string): Promise<void> {
    if (!this.sets) return
    const local = this.setOf(root)?.local
    const have = new Set(Object.values(local ?? {}))
    const certs: M.SetCert[] = []
    const names: Record<string, string> = M.table([[root, this.me]])
    for (const sib of this.cand.siblingNames?.() ?? []) {
      if (have.has(sib)) continue
      const pk = (M.own(this.state.pools, sib) ?? []).find((k) => k.for === this.me && k.used === null)
      if (!pk) continue
      certs.push(await this.cert(ctx, { root, kind: 'admit', anchor: pk.anchor, keyAgreement: pk.keyAgreement }))
      M.put(names, pk.anchor, sib)
      this.emit({ kind: 'pool-use', device: sib, i: pk.i, root, ctx })
    }
    if (!local || certs.length) this.emit({ kind: 'device-set', root, rootKeyAgreement: rootKa, certs, local: names })
  }
  /**
   * Fällige Arbeit (B6): das öffnende Gerät nimmt Schwestern nach, für die bei der Öffnung kein Vorratsschlüssel da war.
   * Nur das öffnende Gerät (eine Zuweisung je Schwester und Wurzel, keine zwei Schlüssel eines Geräts für einen Kontext).
   */
  private async admitPending(): Promise<void> {
    if (!this.sets || this.catchUp) return
    for (const set of Object.values(this.state.sets ?? {})) {
      if (M.own(set.local, set.root) !== this.me) continue
      const rc = this.rootCtx(set.root)
      if (!rc || rc.departed || !M.setView(set).members.some((m) => m.anchor === set.root)) continue
      const have = new Set(Object.values(set.local ?? {}))
      const open = (this.cand.siblingNames?.() ?? []).some((sib) => !have.has(sib) && (M.own(this.state.pools, sib) ?? []).some((k) => k.for === this.me && k.used === null))
      if (open) await this.guarded(() => this.admitSiblings(set.root, rc.ctx, set.rootKeyAgreement))
    }
  }
  /** Fällige Arbeit (B6): der eigene Vorrat öffentlicher Geräteschlüssel je Schwester, unter zwei unbenutzten auf vier aufgefüllt. */
  private async refillPools(): Promise<void> {
    if (!this.sets || this.catchUp || !this.cand.poolKey) return
    const mine = M.own(this.state.pools, this.me) ?? []
    let next = Math.max(-1, ...mine.map((k) => k.i)) + 1
    const keys: Array<{ i: number; for: string; anchor: string; keyAgreement: string }> = []
    for (const sib of this.cand.siblingNames?.() ?? []) {
      const free = mine.filter((k) => k.for === sib && k.used === null).length
      if (free >= POOL.below) continue
      for (let j = free; j < POOL.to; j++, next++) {
        const k = await this.cand.poolKey(next)
        keys.push({ i: next, for: sib, anchor: k.anchor, keyAgreement: k.rkid })
      }
    }
    if (keys.length) await this.guarded(async () => void this.emit({ kind: 'pool', device: this.me, keys }))
  }
  /**
   * Die eigene Menge jeder eigenen Wurzel veröffentlichen (fällige Arbeit, B6): ein Gerät sendet eine Revision (kumulativ:
   * alle Nachweise der Wurzel; 6270 je Signierer nur Wiederholung und Equivokation), wenn es Nachweise signiert hat, die
   * seine letzte Revision nicht trug, oder wenn es die Wurzel ist und noch keine sandte. Nur Mitglieder; während der
   * Enrollment-Zeremonie aus der Ablage nicht (Nummern wie MV-7).
   */
  private async publishSets(only?: string): Promise<void> {
    if (!this.sets || this.catchUp) return
    for (const set of Object.values(this.state.sets ?? {})) {
      if (only !== undefined && set.root !== only) continue
      const rc = this.rootCtx(set.root)
      if (!rc || rc.departed || !rc.to) continue
      const me = await this.memberOf(set, rc.ctx)
      if (!me) continue
      const held = M.own(set.revs, signerId(me))
      const covered = new Set(held?.covered ?? [])
      const mine = Object.values(set.certs).filter((c) => c.by === me)
      if (held && mine.every((c) => covered.has(M.certKey(c)))) continue
      if (!held && me !== set.root && !mine.length) continue
      const entries = Object.values(set.certs).sort((x, y) => M.certKey(x).localeCompare(M.certKey(y)))
      const n = (held?.n ?? 0) + 1
      const payload = { root: set.root, rootKeyAgreement: set.rootKeyAgreement, revision: n, deps: [...set.seen].sort(), entries } as unknown as Record<string, Json>
      const sent = await this.sendDoc(TYPES.deviceSet, rc.ctx, rc.to.anchor, rc.to.rkid, (await this.keysFor(rc.ctx)).rkid, payload)
      // Bekannt leer (kein Rahmen, ausdrücklicher Zustellfehler): nichts ging hinaus, also nichts veröffentlicht (CodeRabbit #74).
      if (!sent) continue
      this.emit({ kind: 'device-set', root: set.root, rootKeyAgreement: set.rootKeyAgreement, certs: [], rev: { signer: signerId(me), n, digest: sent.digest, covered: entries.map(M.certKey) }, seen: sent.digest })
    }
  }
  /**
   * Enrollment (Plan 6o.2, Zeremonie QR): das einschreibende Gerät nimmt das neue Gerät in jede eigene Menge auf, in der es
   * selbst Mitglied ist (dessen Schlüssel je Kontext zeigt das neue Gerät in der Zeremonie), übernimmt den Vorrat
   * öffentlicher Schlüssel des neuen Geräts ins Journal und sendet je Wurzel eine Revision an die Gegenseite (Fan-out =
   * Zahl der Beziehungen). Wo es nicht Mitglied ist, nimmt das öffnende Gerät nach (`admitPending`).
   */
  async enrolMember(device: string, entries: Array<{ root: string; anchor: string; keyAgreement: string }>, pool: Array<{ i: number; for: string; anchor: string; keyAgreement: string }>): Promise<ActionResult> {
    if (!this.sets) return 'ok'
    // Ein Schritt je Wurzel (Zulassung und Revision in einem Batch), damit kein Journalrahmen die Grenze von 64 KiB sprengt.
    let result: ActionResult = await this.action(async () => {
      if (pool.length) this.emit({ kind: 'pool', device, keys: pool })
    })
    for (const e of entries) {
      const r = await this.action(async () => {
        const rc = this.rootCtx(e.root)
        const set = this.setOf(e.root)
        if (!rc || !set || !(await this.memberOf(set, rc.ctx))) return
        const cert = await this.cert(rc.ctx, { root: e.root, kind: 'admit', anchor: e.anchor, keyAgreement: e.keyAgreement })
        this.emit({ kind: 'device-set', root: e.root, rootKeyAgreement: set.rootKeyAgreement, certs: [cert], local: M.table([[e.anchor, device]]) })
        await this.publishSets(e.root)
      })
      if (r !== 'ok') result = r
    }
    return result
  }
  /**
   * Widerruf in den Mengen (K2 Schritt 2): dieses Gerät widerruft `device` in jeder eigenen Menge, in der es Mitglied ist
   * (Widerrufseintrag, endgültig), und veröffentlicht die Revision an jede Gegenseite. Rotation des Vorrats: die Schlüssel
   * des widerrufenen Geräts werden zurückgezogen (ihr privater Teil lag nur dort; M schließt sie über den Widerruf ihres
   * Signierers aus). Gegenlauf `revocationToCounterparts: false`: nichts davon (nur der Träger).
   */
  async revokeInSets(device: string): Promise<ActionResult | null> {
    if (!this.sets || this.cand.revocationToCounterparts === false) return null
    let result: ActionResult = 'ok'
    // Ein Schritt je Wurzel (Widerrufseintrag und Revision in einem Batch), wie beim Enrollment.
    for (const root of Object.keys(this.state.sets ?? {})) {
      const r = await this.action(async () => {
        const set = this.setOf(root)!
        const rc = this.rootCtx(root)
        if (!rc) return
        const targets = Object.entries(set.local ?? {}).filter(([, d]) => d === device).map(([a]) => a)
        if (!targets.length || !(await this.memberOf(set, rc.ctx))) return
        const view = M.setView(set)
        const certs: M.SetCert[] = []
        for (const a of targets) if (!view.revoked.has(a)) certs.push(await this.cert(rc.ctx, { root, kind: 'revoke', anchor: a, keyAgreement: null }))
        if (!certs.length) return
        this.emit({ kind: 'device-set', root, rootKeyAgreement: set.rootKeyAgreement, certs })
        await this.publishSets(root)
      })
      if (r !== 'ok') result = r
    }
    const rot = await this.action(async () => {
      for (const r of this.state.relationships) {
        if (r.departed) continue
        const drop = r.stock.filter((k) => (k.state === 'active' || k.state === 'aging' || k.state === 'allocated' || k.state === 'registered') && k.by === device).map((k) => k.anchor)
        if (drop.length) this.emit({ kind: 'withdraw', rel: r.id, anchors: drop })
      }
    })
    return rot !== 'ok' ? rot : result
  }
  /** Das allozierende Gerät des Vorrats-Schlüssels eines Akts (E2 (iv)): nur es erzeugt die Karte. */
  private allocated(a: M.Act): boolean {
    const k = M.findRel(this.state, a.mediator)?.stock.find((x) => x.anchor === a.own)
    return !!k && k.by === this.me
  }
  /**
   * 8725/8727 unter E2 (iv): das Gerät, das den benannten Vorrats-Schlüssel zugeteilt hat, erzeugt die eine Karte des
   * Akts (frischer Kartenkontext, Schwestern über ihren Vorrat in die Menge der neuen Wurzel aufgenommen, Revision mit
   * der Karte an den Voucher), sobald eine Zustimmung der Person vorliegt (eigene oder aus dem Journal). Ein anderes Gerät
   * zeichnet nur die Zustimmung auf. Nicht nach dem Ablauf des Akts, nicht während der Enrollment-Zeremonie aus der Ablage
   * (sonst erzeugte eine frühere Inkarnation vielleicht schon eine Karte: zwei Karten desselben Geräts). `force` nur im
   * Gegenlauf ohne Produzentenregel.
   */
  private async produce(actId: string, force = false): Promise<void> {
    const a = M.act(this.state, actId)
    if (a.ownCard || a.state !== 'consented' || this.catchUp) return
    if (!force && !this.allocated(a)) return
    if (Date.parse(this.clock.now()) > Date.parse(a.expiresAt)) return
    const ctx = `card/${actId}/${this.person}`
    const k = await this.listen(ctx)
    const card = { anchor: k.anchor, keyAgreement: k.rkid }
    const v = await digestBytes(enc.encode(jcs({ act: actId, card })))
    await this.admitSiblings(k.anchor, ctx, k.rkid)
    this.emit({ kind: 'produce', act: actId, card, cardKey: ctx, v })
    await this.publishSets(k.anchor)
    await this.handOverCard(actId)
  }
  /** Fällige Produktion (B6): ein Akt mit Zustimmung ohne Karte, dessen Vorrats-Schlüssel dieses Gerät zugeteilt hat. */
  private async produceOwed(): Promise<void> {
    if (!this.sets || this.catchUp || this.cand.producerRule === false) return
    for (const a of this.state.acts.slice()) if (a.state === 'consented' && !a.ownCard && this.allocated(a)) await this.guarded(() => this.produce(a.id))
  }
  /**
   * 8325.A5c unter E2 (iv): kam die Gegenkarte zuerst auf einem Schwestergerät an, das die Zustimmung noch nicht kannte
   * (P nach 8910.4), und faltet der Produzent dieses P erst, nachdem seine eigene Karte eingereicht ist, prüft er hier neu;
   * seine eigene Kopie der Gegenkarte ist dann eine Wiederholung (8910.7, V schon bekannt) und verbindet nicht. Nur der
   * Produzent (er hält die Einreichung), so verbindet die Person genau einmal.
   */
  private async connectOwed(): Promise<void> {
    if (this.catchUp) return
    if (this.sets) {
      for (const a of this.state.acts.slice()) if (a.state === 'consented' && a.pending && !a.opened && a.ownCardV && this.submitted(a) && this.allocated(a)) await this.guarded(() => this.evaluatePending(a.id))
      return
    }
    // K1a (MV-6 neu, Gegenlauf Review 18): ein Gerät aus einem alten Abbild hat seine Karte wieder übergeben, die Faltung
    // entscheidet danach nach Regel 2 für die Zustimmung, und die Gegenkarte kam vorher als verdecktes P eines abgelehnten
    // Akts (8910.6, MV-31). Neu geprüft wird nur auf dem Gerät, dessen eigene Karte eingereicht ist (es hält die Übergabe).
    for (const a of this.state.acts.slice()) {
      if (a.state !== 'consented' || !a.pending || a.opened || !this.submitted(a)) continue
      if (![...this.sent.values()].some((x) => x.kind === 'card' && x.act === a.id)) continue
      await this.guarded(() => this.evaluatePending(a.id))
    }
  }
  /** K2 Schritt 2: das eigene Tupel (Kopf) der Beziehung, deren Vorrats-Schlüssel diese Adresse ist (Ticket, Mengennachweis einer Vorstellung). */
  private tupleOfStock(address: string): M.Tuple | undefined {
    const ctx = this.ctxOfRkid.get(address)
    if (!ctx) return undefined
    const r = this.state.relationships.find((x) => !x.departed && x.stock.some((k) => k.key === ctx))
    return r ? M.head(r) : undefined
  }
  /** The context of the ticket predicate on this device (8640.2 channel: K2 by stock address, K0/K1a by tuple address). */
  private ticketReceiver(now: string): TicketReceiver {
    return { state: this.state, sets: this.sets, now, tupleAt: (a) => (this.sets ? this.tupleOfStock(a) : this.tupleOfAddress(a)) }
  }
  /**
   * Arrival of a card under device sets (E1 (a), E3 (a)): the card names the revision of `device-set@1` that carries its
   * root (the card anchor). Without that proof the card waits (`Missing`: no V, no K, no receipt; the sender repeats); a
   * known revocation of the root beats the older reference (refused, no K).
   */
  private cardSetProblem(root: string, ref: string | undefined): string | null {
    const set = this.setOf(root)
    if (!ref || !set || !set.seen.includes(ref)) {
      this.deferredCards++
      throw new M.Missing('device-set', (ref ?? '?').slice(-8), this.person)
    }
    if (M.setView(set).revoked.has(root)) return `karte von ${root.slice(-8)}: Wurzel widerrufen, ein bekannter Widerruf schlägt den älteren Bezug (E1 (a)): abgewiesen ohne K (E3 (a))`
    return null
  }
  /** 2300/6730: eingefrorene Kandidatenliste = Gegenanker aller gehaltenen Beziehungen. */
  private candidates(): string[] {
    return [...new Set(this.state.relationships.filter((r) => !r.departed).flatMap((r) => r.tuples.map((t) => t.peer)))].sort()
  }

  /** Klasse „darf mich vorstellen“ an diesen Kontakt ein-/ausschalten (Aussteller); ein: nachfüllen (8485); aus: Widerruf und leere Revision (8535). */
  async setClass(relId: string, on: boolean): Promise<ActionResult> {
    return this.action(async () => {
      this.emit({ kind: 'class', rel: relId, on })
      if (on) await this.refill(relId)
      else {
        const r = M.rel(this.state, relId)
        const anchors = r.stock.filter((k) => k.state === 'active' || k.state === 'aging').map((k) => k.anchor)
        this.emit({ kind: 'withdraw', rel: relId, anchors }) // 8475.S6
        await this.sendRevision(relId)
      }
    })
  }

  /** Abgang einer Beziehung (Section 2): Vorrat withdrawn, nichts gesendet, Pflichten moot. */
  async depart(relId: string): Promise<ActionResult> {
    return this.action(async () => {
      const peers = new Set(M.rel(this.state, relId).tuples.map((t) => t.peerKeyAgreement))
      this.emit({ kind: 'depart', rel: relId })
      this.dropDeparted() // Aufbewahrung endet mit dem Abgang (derselbe Weg wie beim gefalteten Abgang)
      // 8475.S6: Neues geht nicht mehr an diesen Kontakt; was nie freigegeben war, entfällt. Eine eingereichte Sendung
      // bleibt bei Delivery und wird weiter wiederholt (6845.7, Delivery 6.1; Tor-Review 4 B4).
      for (const d of this.held.filter((d) => peers.has(this.zusteller.submissions.get(d)?.address ?? ''))) this.zusteller.discard(d)
      this.held = this.held.filter((d) => this.zusteller.submissions.has(d))
    })
  }

  /** 8515: der Nutzer bestätigt die Annahmen, die er sieht (benannt, nicht gezählt: reihenfolgeunabhängig, B2). */
  async confirmBudget(relId: string): Promise<ActionResult> {
    return this.action(async () => {
      this.emit({ kind: 'budget-confirm', rel: relId, acts: M.rel(this.state, relId).accepted.map((e) => e.act) })
      await this.refill(relId)
    })
  }

  /** 8485: unter drei aktiven auf fünf nachfüllen, Revision senden; nur bei Klasse an und Budget nicht erschöpft (8512). */
  private async refill(relId: string): Promise<void> {
    // Schritt 4: mit Schreiberkennung teilt ein Gerät während der Enrollment-Zeremonie aus der Ablage nichts zu und nummeriert
    // nichts (Schlüsselnummern 8445 und Revisionsnummern 8500 seiner früheren Inkarnationen kennt es erst danach); das
    // Nachfüllen ist fällige Arbeit aus dem Zustand (B6) und läuft in der ersten Runde nach dem Nachholen.
    if (this.perWriter && this.catchUp) return
    const r = M.rel(this.state, relId)
    if (!r.classOn || r.departed || M.budgetExhausted(r, this.clock.now())) return
    // K2 Schritt 2: jedes Gerät hält seinen eigenen Anteil am Vorrat bei M (Schlüssel je Gerät, 6o.2 (a)); K0/K1a: die Person.
    const share = this.cand.stockShare?.()
    const active = r.stock.filter((k) => k.state === 'active' && (!share || k.by === this.me))
    if (active.length >= (share?.below ?? M.PARAM.refillBelow)) return
    const nonce = this.cand.stockNonce?.(r.id) ?? r.nonce ?? Buffer.from(derive(enc.encode(`${this.person}/${r.id}/${this.cand.writer}/${this.counter}`), 'nonce')).toString('base64')
    const keys: M.StockKey[] = []
    // Das Ziel zählt die aktiven Schlüssel der Person (alle Geräte, über das Journal), nicht je Restklasse: ein Gerät allein
    // hält M aus seinen eigenen Nummern versorgt (Review 21 B1).
    // K2 Schritt 2: ein Gerät listet nur so viele eigene Schlüssel, wie es noch annehmen kann (strict: nur der Halter öffnet
    // das Ticket; ein Schlüssel eines Geräts ohne Kontingent wäre bei M ein toter Schlüssel, MV-9).
    const cap = Math.min(share?.to ?? M.PARAM.refillTo, this.cand.quotaLeft?.(r.id, this.state, this.clock.now()) ?? Infinity)
    for (let n = r.nextN; keys.length < cap - active.length; n++) {
      if (this.cand.mayAllocate && !this.cand.mayAllocate(n, r.id, this.state)) continue
      const ctx = `introduction/${nonce}/${n}`
      const k = await this.listen(ctx)
      keys.push({ n, nonce, anchor: k.anchor, keyAgreement: k.rkid, key: ctx, expiresAt: new Date(Date.parse(this.clock.now()) + (this.cand.stockLifetimeMs ?? M.PARAM.prekeyLifetimeMs)).toISOString(), state: 'active', ...(share ? { by: this.me } : {}) })
    }
    if (!keys.length) return
    this.emit({ kind: 'allocate', rel: r.id, nonce, keys })
    await this.sendRevision(r.id)
  }
  private async refillAll(): Promise<void> {
    for (const r of this.state.relationships) if (r.classOn && !r.departed) await this.guarded(() => this.refill(r.id))
    await this.withdrawAfterClassOff()
  }
  /**
   * Schritt 4, Klasse aus über Schreiber (8475.S6, 8535): faltet ein Gerät die Klasse-aus eines Schwestergeräts, zieht es
   * zurück, was in seinem Zustand noch aktiv ist (Schlüssel, die es selbst getrennt zugeteilt hat und die der Widerruf des
   * anderen Geräts nicht nannte), und sendet unter der eigenen Kennung eine leere Revision, wenn seine eigene jüngste
   * Revision Schlüssel listet: M hebt mit jeder leeren Revision die Schlüssel aller Schreiber auf, die es hält, aber eine
   * Revision dieses Schreibers, die M erst danach erreicht, gälte wieder. Fällige Arbeit aus dem Zustand (B6). Nur mit
   * Schreiberkennung; ohne (K0) bleibt alles wie vorher.
   */
  private async withdrawAfterClassOff(): Promise<void> {
    if (!this.perWriter) return
    for (const r of this.state.relationships) {
      if (r.classOn || r.departed) continue
      const live = r.stock.filter((k) => k.state === 'active' || k.state === 'aging' || k.state === 'allocated' || k.state === 'registered').map((k) => k.anchor)
      const own = M.own(r.writers, (await this.writerOf(r.id))!)
      if (!live.length && !(own && !own.empty)) continue
      await this.guarded(async () => {
        if (live.length) this.emit({ kind: 'withdraw', rel: r.id, anchors: live })
        if (own && !own.empty) await this.sendRevision(r.id)
      })
    }
  }

  /**
   * 8495/8500: Revision des aktuellen Zustands auf dem Kopf an den Mediator. Mit Schreiberkennung (Schritt 4): die Nummer
   * ist eins über der höchsten Revision dieses Schreibers im Zustand (8500 je Schreiber), die Kennung reist im Dokument;
   * während der Enrollment-Zeremonie aus der Ablage wird nicht nummeriert, sondern vorgemerkt (`owed`).
   */
  private async sendRevision(relId: string): Promise<void> {
    const r = M.rel(this.state, relId)
    if (r.departed) return
    // K2 Schritt 2: jeder Schreiber listet nur seinen Anteil; eine leere Liste hiebe bei M die Schlüssel aller Schreiber auf
    // (8535, MV-12). Sie geht nur bei Klasse aus; sonst keine Revision.
    if (this.cand.stockShare && r.classOn && !r.stock.some((k) => k.state === 'active' && k.by === this.me)) return
    const tag = await this.writerOf(r.id)
    if (tag && this.catchUp) {
      this.owed.add(r.id)
      return
    }
    const h = M.head(r)
    const revision = tag ? (M.own(r.writers, tag)?.revision ?? 0) + 1 : r.revision + 1
    // K2 Schritt 2: jeder Schreiber listet seinen eigenen Anteil (der Signierer bürgt für die Schlüssel, die er hält); M vereinigt.
    const share = !!this.cand.stockShare
    const keys = r.stock.filter((k) => k.state === 'active' && (!share || k.by === this.me)).map((k) => ({ n: k.n, anchor: k.anchor, keyAgreement: k.keyAgreement, expiresAt: k.expiresAt }))
    // K2, Review 34 B5 / Review 35 B6: eine leere Revision nennt die konkreten Anker, die sie zurückzieht (Grabstein je Anker,
    // keine Nummernmarken). Klasse aus ist Sache der Person (Entscheidung 1b, Vertrag 4.10): dann nennt sie in beiden
    // jeden Anker der Person, den der Aussteller kennt (eigene und die der Schwestern aus dem Journal). Eine leere Revision
    // bei eingeschalteter Klasse nennt nur die eigenen. Verbrauchte nicht (8570.2 markiert sie bei M schon).
    const personWide = !r.classOn
    const tombstones = this.cand.signerWriters && tag && !keys.length ? r.stock.filter((k) => k.state !== 'consumed' && (personWide || k.by === this.me)).map((k) => k.anchor).sort() : undefined
    this.emit({ kind: 'revision', rel: r.id, revision, keys, ...(tag ? { writer: tag } : {}) })
    await this.sendDoc(TYPES.revision, h.ownKey, h.peer, h.peerKeyAgreement, (await this.keysFor(h.ownKey)).rkid, { revision, keys, ...(tag && this.cand.writerTag ? { writer: tag } : {}), ...(tombstones ? { tombstones } : {}) }) // K2: der Schreiber ist der Signierer, kein Feld
  }
  /** Die Schreiberkennung dieses Geräts für die Beziehung eines Tupels (Schritt 4), als Nutzlastfeld; ohne Kennung leer. */
  private tagField(tupleId: string): { writer?: string } {
    const r = M.relOfTuple(this.state, tupleId)
    const tag = r ? this.cand.writerTag?.(r.id) : undefined
    return tag ? { writer: tag } : {}
  }

  /**
   * Ms benennbare Schlüssel für eine Seite: aus der einen Rechnung (`M.usableView`, Review 36 B7), davon diesem Gerät
   * zugeteilt (`mayName` auf dem kanonischen Wert, K1a; K2 Schritt 2a: M ist ein Gerät, alle).
   */
  private nameable(relId: string): { view: M.UsableView; nameable: M.ListedKey[] } {
    M.rel(this.state, relId) // unbekannte Beziehung: Missing wie bisher, nie eine stille leere Sicht
    const view = M.usableView(this.state, relId, this.clock.now())
    return { view, nameable: view.unconsumed.filter((k) => this.cand.mayName?.(k) ?? true) }
  }
  /**
   * Messung (X23, Review 33 S2): Ms Vorrat für eine Seite in diesem Moment, aus derselben Rechnung wie die Wahl in
   * `introduce`: gelistet, davon noch lang genug gültig (8470), davon nicht verbraucht (8570.2), davon diesem Gerät
   * zugeteilt = benennbar. Nur lesend.
   */
  stockAt(relId: string): { listed: number; usable: number; unconsumed: number; nameable: number } {
    const { view, nameable } = this.nameable(relId)
    return { listed: view.listed.length, usable: view.usable.length, unconsumed: view.unconsumed.length, nameable: nameable.length }
  }
  /** M: zwei Seiten vorstellen (8605, 8570). Liefert die Akt-Id oder den Grund, warum nichts ging. */
  async introduce(relA: string, relB: string, nameA = 'A', nameB = 'B'): Promise<{ act: string } | { refused: string }> {
    const now = this.clock.now()
    // 8570.4; kanonische Wahl (kleinster Anker), damit die Ankunftsreihenfolge nicht entscheidet (Review 4 B2).
    const pick = (relId: string) => [...this.nameable(relId).nameable].sort((a, b) => a.anchor.localeCompare(b.anchor))[0] ?? null
    const ka = pick(relA)
    const kb = pick(relB)
    if (!ka || !kb) return { refused: `kein benennbarer Schlüssel (${ka ? '' : relA} ${kb ? '' : relB})`.trim() }
    const act: M.MediatorAct = { id: crypto.randomUUID(), a: { rel: M.resolveId(this.state, relA), key: ka.anchor, keyAgreement: ka.keyAgreement }, b: { rel: M.resolveId(this.state, relB), key: kb.anchor, keyAgreement: kb.keyAgreement }, issuedAt: now, expiresAt: new Date(Date.parse(now) + M.PARAM.actLifetimeMs).toISOString() }
    // MV-30 (Anton 20.10.): beide Schlüssel gegen denselben Zustand geprüft und erworben; Verbrauch (`introduce`) und beide
    // vollständigen Ticketbytes (Absichten) sind ein Schritt: ein Journalbatch, lokal committet (`flush`), bevor ein Ticket
    // das Gerät verlässt (HSC-110, 8570.2, 8605). Kein Warten auf eine Schwester (MV-34): nach einem Restore aus einem alten
    // Abbild benennt M aus dem erreichbaren Stand; einen doppelt benannten Schlüssel weist A ab (8640.12 als Regel, MV-6).
    const r = await this.action(async () => {
      this.emit({ kind: 'introduce', act })
      const send = async (relId: string, own: { key: string; keyAgreement: string }, voucher: { key: string; keyAgreement: string }, name: string) => {
        const h = M.head(M.rel(this.state, relId))
        // K2 Schritt 2 (6o.2): das Ticket öffnet nur, wer den privaten Teil des benannten Vorrats-Schlüssels hält; es ist an
        // diesen versiegelt (das zuteilende Gerät) und von ihm quittiert.
        const fan = this.sets ? [{ anchor: own.key, rkid: own.keyAgreement }] : undefined
        await this.sendDoc(TYPES.ticket, h.ownKey, fan ? own.key : h.peer, fan ? own.keyAgreement : h.peerKeyAgreement, (await this.keysFor(h.ownKey)).rkid, { act: act.id, issuedAt: act.issuedAt, expiresAt: act.expiresAt, own: own.key, voucher: { anchor: voucher.key, keyAgreement: voucher.keyAgreement, name } }, fan)
      }
      await send(relA, act.a, act.b, nameB)
      await send(relB, act.b, act.a, nameA)
    })
    return r === 'ok' ? { act: act.id } : { refused: r }
  }

  /** 8325.A4: Consent, frische Karte, Übergabe. */
  async consent(actId: string): Promise<ActionResult> {
    return this.action(async () => {
      const a = M.act(this.state, actId)
      if (a.state !== 'offered') {
        this.emit({ kind: 'finding', text: `consent auf ${actId} im Zustand ${a.state}` })
        return
      }
      if (Date.parse(this.clock.now()) > Date.parse(a.expiresAt) - M.PARAM.consentReserveMs) return // 8155
      if (this.sets) {
        // K2 Schritt 2, E2 (iv): die Zustimmung gilt für die Person (Journal); die eine Karte erzeugt das Gerät, das den
        // benannten Vorrats-Schlüssel zugeteilt hat, jetzt oder sobald es die Zustimmung faltet. Gegenlauf ohne
        // Produzentenregel: jedes zustimmende Gerät erzeugt eine Karte.
        this.emit({ kind: 'consent', act: actId, card: null, cardKey: null })
        await this.produce(actId, this.cand.producerRule === false)
        return
      }
      const ctx = `card/${actId}/${this.person}`
      const k = await this.listen(ctx)
      this.emit({ kind: 'consent', act: actId, card: { anchor: k.anchor, keyAgreement: k.rkid }, cardKey: ctx })
      await this.handOverCard(actId)
    })
  }
  /** 8760: die Karte geht hinaus, sobald sie darf; der Digest der Übergabe wird im Akt gehalten. */
  private async handOverCard(actId: string): Promise<void> {
    const a = M.act(this.state, actId)
    if (!a.ownCard || !a.ownCardKey) return
    // K2: der Vorrats-Schlüssel kann von einem Schwestergerät zugeteilt sein (aufgezeichneter Anker); dieses Gerät signiert mit seinem eigenen Schlüssel desselben Kontexts.
    // K2 Schritt 2: der Produzent hat den Vorrats-Schlüssel zugeteilt (E2 (iv)) und signiert mit ihm selbst; im Gegenlauf ohne
    // Produzentenregel signiert ein anderes Gerät (strict) mit seinem eigenen Schlüssel desselben Kontexts.
    const ownCtx = this.ctxOfAnchor.get(a.own) ?? (this.sets ? this.recordedCtx(a.own) : undefined)
    if (!ownCtx) return
    const own = await this.keysFor(ownCtx)
    // K2 Schritt 2 (E1 (a)): die Karte trägt den signierten Bezug auf die Revision von `device-set@1` ihrer Wurzel.
    const set = this.sets ? M.own(this.setOf(a.ownCard.anchor)?.revs, signerId(a.ownCard.anchor))?.digest : undefined
    const sent = await this.sendDoc(TYPES.card, ownCtx, a.voucher.anchor, a.voucher.keyAgreement, own.rkid, { act: actId, expiresAt: a.expiresAt, from: a.own, fromKeyAgreement: own.rkid, to: a.voucher.anchor, card: { anchor: a.ownCard.anchor, keyAgreement: a.ownCard.keyAgreement }, ...(set ? { set } : {}) })
    if (!sent) return
    const { digest, bytes, address } = sent
    this.sent.set(digest, { kind: 'card', act: actId, frame: bytes, address }) // the address the primary frame is sealed to (K2: may differ from the recorded key)
    this.emit({ kind: 'hand-over', act: actId, o: 'handed', digest })
  }

  /** 8325.A3: Ablehnung, nichts gesendet (8765). */
  async decline(actId: string): Promise<ActionResult> {
    return this.action(async () => {
      const a = M.act(this.state, actId)
      if (a.state !== 'offered') {
        this.emit({ kind: 'finding', text: `decline auf ${actId} im Zustand ${a.state}` })
        return
      }
      this.emit({ kind: 'decline', act: actId })
    })
  }

  private submitted(a: M.Act) {
    return M.SUBMITTED.has(a.o)
  }
  /**
   * K1a Schritt 3, Regeln 2 und 3 (Anton 18.10.2026), auf dem Gerät, das die Karte erzeugt hat: nach dem Falten eines
   * Batches eines Schwestergeräts nimmt es seine eigene Karte zurück, wenn die Faltung gegen sie entschieden hat (der Akt
   * ist abgelehnt, Regel 2, oder eine andere Übergabe desselben Akts gewinnt, Regel 3) und die Karte nicht eingereicht
   * ist (8232.2: „Unless submitted or currently undecided (8232.0), the registration and the document are cancelled“;
   * 8765: wer ablehnt, sendet nichts). Zurückgenommen wird nur, was den Träger nie erreicht hat (`Zusteller.demarcate`,
   * wie 8326.4/8326.8); hat der Träger die Karte schon, bleibt sie (8326.9), wird `taken` und entscheidet Regel 2 dann für
   * die Zustimmung: was die Gegenseite erreicht hat, gilt. Die Rücknahme ist eine Operation im selben Schritt (Journal).
   */
  private async withdrawLosingCards(): Promise<void> {
    const drop = (d: string) => {
      this.sent.delete(d)
      this.held = this.held.filter((h) => h !== d)
      this.parked = this.parked.filter((h) => h !== d)
      this.expected.delete(d)
    }
    for (const [d, x] of [...this.sent]) {
      if (x.kind !== 'card' || !x.act) continue
      const a = this.state.acts.find((y) => y.id === x.act)
      if (!a) continue
      const o = M.own(a.cards, d) ?? a.o
      // B1a: die Faltung kennt die Rücknahme schon (aus dem Journal, etwa einer früheren Inkarnation vor einem Restore),
      // der Adapter hält die Karte aber noch: abgrenzen, ohne neue Operation. Hat sie den Träger erreicht, bleibt sie und
      // schlägt die Rücknahme (B1b, Rang je Übergabe).
      if (o === 'cancelled') {
        if (this.zusteller.demarcate(d)) drop(d)
        continue
      }
      if (o !== 'handed') continue
      const declined = a.state === 'declined'
      // K2 Schritt 2 (E2 (iv)): eine Karte je Akt, keine vorläufige Wahl zwischen Übergaben; zurückgenommen wird nur nach Regel 2
      // (Ablehnung), nie aus einem Digestvergleich (Design-Review 6q 3c). K1a: Regel 3 wie bisher.
      const loses = !this.sets && a.ownCardDigest !== null && a.ownCardDigest !== d
      if (!declined && !loses) continue
      if (!this.zusteller.demarcate(d)) continue
      drop(d)
      if (loses) this.losingCardsWithdrawn++
      this.emit({ kind: 'hand-over', act: a.id, o: 'cancelled', digest: d })
    }
  }
  /** 8325.A5c: eine wartende Gegenkarte nach der Einreichung der eigenen Karte neu prüfen. */
  private async evaluatePending(actId: string): Promise<void> {
    const a = M.act(this.state, actId)
    if (a.state !== 'consented' || !this.submitted(a) || !a.pending) return
    // K2 Schritt 2 (8325.A5c unter Mengen): ein bekannter Widerruf der Wurzel der wartenden Karte schlägt (E1 (a)).
    if (this.sets && M.setView(this.setOf(a.pending.anchor)).revoked.has(a.pending.anchor)) {
      this.emit({ kind: 'finding', text: `pending auf ${a.id}: Wurzel ${a.pending.anchor.slice(-8)} widerrufen (E1 (a)): nicht verbunden` })
      return
    }
    await this.connect(a, a.pending)
  }
  /** 8905: Tupel öffnen, Akt connected, Probe. */
  private async connect(a: M.Act, card: M.Card): Promise<void> {
    if (!a.ownCard || !a.ownCardKey) return
    const t: M.Tuple = { id: `${this.person}:act:${a.id}`, own: a.ownCard.anchor, ownKey: a.ownCardKey, peer: card.anchor, peerKeyAgreement: card.keyAgreement, record: `${a.id}:${a.ownCard.anchor}`, openedAt: this.clock.now(), candidates: this.candidates(), deactivated: false }
    this.emit({ kind: 'connect', act: a.id, rel: t.id, tuple: t })
    await this.sendProbe(t)
  }

  // ── Kontinuität (6a, vereinfacht) ──
  private pairKeyOf(t: M.Tuple): Buffer {
    return createHash('sha256').update([t.own, t.peer].sort().join('|')).digest()
  }
  private blind(t: M.Tuple, anchor: string): string {
    return createHmac('sha256', this.pairKeyOf(t)).update(anchor).digest('base64')
  }
  /** Probe auf dem neuen Tupel: geblendete Kandidaten (die Gegenanker aller anderen gehaltenen Tupel, eingefroren bei der Öffnung). */
  private async sendProbe(t: M.Tuple): Promise<void> {
    const entries = t.candidates.filter((c) => c !== t.peer).map((c) => this.blind(t, c))
    if (!entries.length) return
    await this.sendDoc(TYPES.probe, t.ownKey, t.peer, t.peerKeyAgreement, (await this.keysFor(t.ownKey)).rkid, { entries, ...this.tagField(t.id) })
  }
  /**
   * 6800/6806: eine Probe auf dem eigenen Tupel `t` auswerten. Jeder Eintrag, der `HMAC(k_p, a)` über den eigenen Paar-Anker
   * `a` eines anderen gehaltenen Tupels gleicht, ist ein Treffer auf dem Paar (6806, jeder Treffer, nicht nur der erste);
   * ein Treffer verpflichtet zum eigenen Mapping auf `t` (6845.1, 6840), es sei denn, die Pflicht über das Paar besteht
   * schon (auch aus dem Journal eines Schwestergeräts). Vereinigt wird hier nichts (6804). Liefert die Einträge ohne Treffer.
   */
  private async evaluateProbe(t: M.Tuple, entries: string[]): Promise<string[]> {
    const open = new Set(entries)
    for (const r of this.state.relationships) {
      if (r.departed) continue // Tupel abgegangener Beziehungen zählen nicht (6845.7)
      for (const other of r.tuples) {
        if (other.id === t.id) continue
        const e = this.blind(t, other.own)
        if (!open.has(e)) continue
        open.delete(e)
        const pair = M.pairKey(t.id, other.id)
        const duty = this.state.duties.find((d) => d.pair[0] === pair[0] && d.pair[1] === pair[1])
        if (!duty || duty.state === 'none') await this.sendMapping(t, other) // 6845.1
      }
    }
    return [...open].sort()
  }
  private tupleIds(): Set<string> {
    return new Set(this.state.relationships.flatMap((r) => r.tuples.map((t) => t.id)))
  }
  /**
   * Neuauswertung (K1a Schritt 2, Anton 18.10. Option 1). Ein gefalteter Batch eines Schwestergeräts hat die eigene
   * Tupelmenge vergrößert: jede behaltene Probe wird gegen die nun größere Menge eigener Paar-Anker neu ausgewertet,
   * genau wie bei ihrer Ankunft (`evaluateProbe`: 6960/6806 über die Tupel aller Geräte der Person). Ein Treffer schuldet
   * das eigene Mapping auf dem Ankunftstupel (6845.1); vereinigt wird erst auf das verifizierte Mapping der Gegenseite
   * (6900, 6975.1/.2). Die Probe selbst ist die eingefrorene der Gegenseite (2300, 6750 auf ihrer Seite unberührt); kein
   * neuer Rahmen außer dem geschuldeten Mapping, kein neuer Kandidat, keine Uhr.
   * Läuft im Schritt, der den Batch faltet: Pflicht-Operation und Mapping-Absicht gehen mit dessen Commit ins Journal.
   * Nur das Gerät, das die Probe empfangen hat, hält sie (empfangene Rahmen reisen nicht im Journal); das Schwestergerät
   * erfährt die Pflicht aus dem Journal und mappt nicht noch einmal (`duty` besteht). Haben beide Geräte die Probe
   * empfangen und werten getrennt voneinander aus, entstehen zwei Mappings über dasselbe Paar: die Gegenseite vereinigt
   * einmal und hält für das zweite nur die Kante (6975.3); der Fold hält je Pflicht den kleinsten Digest und je Kante die
   * kleinste Vereinigungsoperation (model.ts, `duty` und `union`).
   * Aufbewahrung: je eigenem Ankunftstupel die Einträge ohne Treffer; ein getroffener Eintrag fällt weg (ein Paar-Anker
   * trifft genau ein Tupel), die Probe fällt weg, wenn nichts offen ist oder die Beziehung des Ankunftstupels abgeht
   * (`dropDeparted`, auch beim gefalteten Abgang); je Ankunftstupel gilt nur die jüngste Probe (Ankunft, `TYPES.probe`).
   */
  private async reevaluate(): Promise<void> {
    if (!this.cand.reevaluateProbes) return
    this.dropDeparted()
    for (const [id, entries] of [...this.probes]) {
      const open = await this.evaluateProbe(M.tuple(this.state, id), entries)
      if (open.length) this.probes.set(id, open)
      else this.probes.delete(id)
    }
  }
  private async sendMapping(arrival: M.Tuple, other: M.Tuple): Promise<void> {
    const pair = M.pairKey(arrival.id, other.id)
    const sent = await this.sendDoc(TYPES.mapping, arrival.ownKey, arrival.peer, arrival.peerKeyAgreement, (await this.keysFor(arrival.ownKey)).rkid, { entry: this.blind(arrival, other.own), ...this.tagField(arrival.id) })
    if (!sent) return
    const { digest, bytes, address } = sent
    this.sent.set(digest, { kind: 'mapping', pair, frame: bytes, address }) // 6845.4 retries the primary frame at the address it is sealed to
    this.emit({ kind: 'duty', pair, state: 'hit', mappingDigest: digest })
  }
  /**
   * 6845.10: offene Mapping-Pflichten (hit, sent) ohne lokale Übergabe werden wieder aufgenommen. Kennt das Gerät die
   * Absicht dazu (HSC-120, B4): dieselben Bytes, wenn es sie selbst erzeugt hat (Wiederanlauf, neue Inkarnation); eine
   * Absicht eines anderen eigenen Geräts bleibt bei dem (keine Neuproduktion, keine stille Übernahme). Ohne Absicht
   * (K0, Zustandskopie) wird das Mapping neu produziert.
   */
  private async resumeDuties(): Promise<void> {
    for (const d of this.state.duties) {
      if (d.state !== 'hit' && d.state !== 'sent') continue
      if ([...this.sent.values()].some((x) => x.kind === 'mapping' && x.pair && x.pair[0] === d.pair[0] && x.pair[1] === d.pair[1])) continue
      const intent = d.mappingDigest ? this.intents.get(d.mappingDigest) : undefined
      if (intent) {
        if (intent.device !== this.name || this.zusteller.submissions.has(intent.digest)) continue
        this.zusteller.record(intent.digest, intent.bytes, intent.address, intent.copies?.map((c) => ({ address: c.address, frame: new Uint8Array(Buffer.from(c.bytes, 'base64')) })))
        this.expected.set(intent.digest, intent.expected)
        this.sent.set(intent.digest, { kind: 'mapping', pair: d.pair, frame: intent.bytes, address: intent.address })
        this.held.push(intent.digest)
        continue
      }
      const ta = this.state.relationships.flatMap((r) => r.tuples).find((t) => t.id === d.pair[0])
      const tb = this.state.relationships.flatMap((r) => r.tuples).find((t) => t.id === d.pair[1])
      if (!ta || !tb) continue
      if (M.relOfTuple(this.state, ta.id)?.departed) continue // 6845.7
      const [arrival, other] = ta.record > tb.record ? [ta, tb] : [tb, ta]
      await this.guarded(() => this.sendMapping(arrival, other))
    }
  }

  // ── Runde ──
  async round(): Promise<void> {
    if (this.down) return
    try {
      if (this.online) {
        await this.refreshSiblings() // K2: die Gerätemenge kann sich geändert haben (Enrollment, Widerruf)
        const frames = this.carrier.collect(this.name)
        for (const f of frames) {
          try {
            await this.guarded(() => this.handle(f.bytes, f.address), true)
          } catch (e) {
            // Review 26 B2: ein nicht faltbarer eigener Journalrahmen ist zurückgenommen (`guarded`), ein Befund je Digest,
            // keine Quittung; die Runde läuft weiter.
            if (!(e instanceof CorruptFrame)) throw e
            this.corruptFrame(e)
          }
        }
        if (this.logMode) for (const a of this.carrier.takeLogAnswers(this.name)) await this.readLogAnswer(a)
        // B1a: das Nachholen ist abgeschlossen; die Faltung entscheidet, was von dem Zurückgehaltenen noch gilt (eine
        // zurückgenommene Karte bleibt zurückgenommen), der Rest geht nach dem Commit dieser Runde hinaus.
        if (this.catchUp && !this.sync.pending && (await this.guarded(() => this.withdrawLosingCards()))) {
          this.catchUp = false
          for (const d of this.parked.splice(0)) if (this.zusteller.submissions.has(d) && !this.held.includes(d)) this.held.push(d)
        }
        // Tor-Review 40 B2: die Nacharbeit hängt am Ende der Zeremonie, nicht am Übergang in dieser Runde; was ein Neuladen
        // aus dem Abbild mitbringt, wird in der ersten Runde ohne Zeremonie abgearbeitet.
        if (!this.catchUp && (this.owed.size || this.deferredProbes)) {
          // Schritt 4: jetzt kennt das Gerät die Revisionen seiner früheren Inkarnationen; die vorgemerkten gehen mit der nächsten Nummer hinaus.
          for (const id of [...this.owed]) {
            this.owed.delete(id)
            if (M.findRel(this.state, id)) await this.guarded(() => this.sendRevision(id))
          }
          // Schritt 6, Enrollment aus der Ablage: jetzt kennt das Gerät die Tupel, die Proben der Zeremonie gelten.
          if (this.deferredProbes) {
            this.adoptProbes(this.deferredProbes)
            this.deferredProbes = null
            await this.guarded(() => this.reevaluate())
          }
        }
        if (this.catchUp) this.gatedRounds++
        await this.journalOut()
        await this.syncOut()
        this.crash('before-commit')
        this.commit()
        this.crash('after-commit')
        // Quittungen und Folgedokumente verlassen das Gerät erst nach dem Commit der Wirkung (#54, #56).
        this.release(this.held.splice(0))
        if (frames.length) this.carrier.conclude(this.name, frames.map((f) => f.id))
      }
      await this.tick()
      this.zusteller.advance()
      await this.reports()
      await this.flush()
    } catch (e) {
      if (!(e instanceof Crashed)) throw e
    }
  }

  /** Journalrahmen des Kandidaten an die eigene Adresse der Person (B3; K0: keine). */
  private async journalOut(): Promise<string[]> {
    const frames = this.cand.takeOwnFrames()
    if (!frames.length || !this.ownRkid) return []
    const out: string[] = []
    for (const f of frames) {
      const d = await this.sendJournal(f.body)
      if (d) out.push(d)
    }
    return out
  }
  /** Ein Journalbatch an die Schwestern (oder an `to`); zu groß für ein Journaldokument: `JournalOversize` (S8), nie still. */
  private async sendJournal(body: Uint8Array, to?: Array<{ anchor: string; rkid: string }>): Promise<string | null> {
    try {
      return await this.sendSelf(TYPES.journal, { b: Buffer.from(body).toString('base64') }, to)
    } catch (e) {
      if (e instanceof Error && e.message === 'oversize') throw new JournalOversize(body.length, this.name)
      throw e
    }
  }

  /**
   * Nachholen: die eigenen Köpfe an die eigenen Geräte; wer mehr weiß, liefert die fehlenden Batches und antwortet mit
   * seinen Köpfen (HSC-440, X21). Erneut angefragt wird mit Backoff (1, 2, 4, … höchstens 16 Runden), bis eine Antwort
   * zeigt, dass die eigenen Köpfe die des Antwortenden decken.
   */
  private async syncOut(): Promise<void> {
    if (this.logMode) this.logOut()
    if (!this.sync.pending || !this.ownRkid || !this.cand.heads) return
    if (this.sync.wait > 0) {
      this.sync.wait--
      return
    }
    this.sync.wait = this.sync.backoff
    this.sync.backoff = Math.min(16, this.sync.backoff * 2)
    this.syncRequests++
    this.sync.id = crypto.randomUUID() // frisch je Anfrage: nur die Antwort darauf zählt (Review 19 B1a)
    await this.sendSelf(TYPES.journalSync, { heads: this.cand.heads(), reply: false, req: this.sync.id })
  }
  /**
   * Schritt 6: Leseanfrage an die Ablage ab der eigenen Position. Die Antwort liegt mit der nächsten Abholung bereit; kam
   * auf die laufende Anfrage bis dahin keine (Anfrage oder Antwort verloren), fragt das Gerät in dieser Runde erneut
   * (Review 25 S2: höchstens eine Leseanfrage je Runde, keine an die Self-Adresse). Kam eine unvollständige Antwort
   * (Lücke, ungültiger Eintrag) oder ist der Träger unerreichbar, wartet es mit Backoff (1, 2, 4, … höchstens 16 Runden).
   */
  private logOut(): void {
    const l = this.logSync
    if (!l.pending || !this.ownRkid) return
    if (l.wait > 0) {
      l.wait--
      return
    }
    this.logRequests++
    l.id = crypto.randomUUID()
    l.answered = false
    l.from = this.logCursor
    try {
      this.carrier.readLog(this.name, this.ownRkid, l.from, l.id)
      l.wait = 0
    } catch (e) {
      if (!(e instanceof WireUnreachable)) throw e
      l.wait = l.backoff
      l.backoff = Math.min(16, l.backoff * 2)
    }
  }
  /** Ein Dokument an die eigene Adresse der Person (Journal, Nachholen), gezählt als eigener Verkehr. */
  /**
   * K0/K1a: an die gemeinsame Self-Adresse, quittiert unter demselben Anker (one-seed). K2 Schritt 1: dasselbe signierte
   * Dokument je Schwester der aktuellen Gerätemenge versiegelt, an deren eigene Self-Adresse (`to`: nur diese, etwa der
   * Anfragende einer Nachholantwort); ohne Schwester geht nichts hinaus.
   */
  private async sendSelf(type: string, payload: Record<string, Json>, to?: Array<{ anchor: string; rkid: string }>): Promise<string | null> {
    const ctx = `self/${this.person}`
    const peers = to ?? (this.cand.selfPeers ? await this.cand.selfPeers() : undefined)
    if (peers && !peers.length) return null
    const self = peers ? peers[0]!.anchor : (await this.keysFor(ctx)).anchor
    const sent = await this.sendDoc(type, ctx, self, peers ? peers[0]!.rkid : this.ownRkid!, this.ownRkid!, payload, peers)
    if (!sent) return null
    const { frames, total } = sent
    this.measures.ownFramesOut += frames
    this.measures.ownBytesOut += total
    this.measures.framesOut -= frames
    this.measures.bytesOut -= total
    return sent.digest
  }
  /**
   * Schritt 6: eine Antwort der Ablage lesen. Nur die Antwort auf die laufende Leseanfrage zählt (MV-5); jeder Eintrag wird
   * wie ein Journalrahmen gefaltet (dieselbe Faltung, `replay`), in Durchgängen, bis nichts mehr zurückgestellt wird
   * (Umordnung). Die Position rückt bis zur ersten Lücke vor: fehlend, zurückgestellt oder ungültig (Review 25 B2: ein
   * unlesbarer oder ungültiger Eintrag zählt nie als gefaltet, er ist ein Befund `journal:corrupt-entry`, die nächste
   * Leseanfrage beginnt bei ihm). Vollständig heißt nur: die Ablage hat nichts mehr, was das Gerät noch nicht hat; die
   * Freigabe entscheidet diese Antwort nicht (Review 25 B1: der Dienst bestimmt `end` und die Einträge ungesichert).
   */
  private async readLogAnswer(a: LogAnswer): Promise<void> {
    this.logEntriesRead += a.entries.length
    this.logBytesRead += a.entries.reduce((n, e) => n + e.bytes.length, 0)
    if (a.req !== this.logSync.id) {
      this.staleSyncAnswers++
      return
    }
    if (!this.logSync.pending) return
    // CodeRabbit #71: die Antwort gilt nur ab der angefragten Position; ein anderes `from` des Trägers ist wie eine
    // fremde Antwort (der Cursor darf nicht an Einträgen vorbei springen, die nie gefaltet wurden).
    if (a.from !== this.logSync.from) {
      this.staleSyncAnswers++
      return
    }
    this.logSync.answered = true
    const byPos = new Map<number, Uint8Array>()
    for (const e of a.entries) if (e.pos >= a.from && e.pos < a.end && !byPos.has(e.pos)) byPos.set(e.pos, e.bytes)
    const bad = new Set<number>()
    const corrupt = (pos: number) => {
      bad.add(pos)
      if (this.corruptSeen.has(pos)) return
      this.corruptSeen.add(pos)
      this.logCorrupt++
      this.dispositions.push(`finding(journal:corrupt-entry@${pos})`)
    }
    const sorted = [...byPos.entries()].sort((x, y) => x[0] - y[0])
    // Review 26 B2: ab der ersten beschädigten Position faltet diese Antwort nichts weiter (Blockieren, die Reihenfolge der
    // Ablage zählt); die nächste Leseanfrage beginnt bei ihr.
    let stop = Infinity
    let rest: typeof sorted = []
    this.readingLog = true
    try {
      // Review 27 B2b, (1) Form vorab: jeder Eintrag wird geöffnet und seine Form geprüft, bevor einer gefaltet wird.
      for (const [pos, bytes] of sorted) {
        const problem = await this.entryProblem(bytes)
        if (problem === null) continue
        this.dispositions.push(`failed(journal-corrupt): ${problem}`)
        corrupt(pos)
        stop = pos
        break
      }
      // (2) Die Antwort ist eine Einheit: erkennt ein späterer Durchgang eine beschädigte Position p (die Faltung wirft),
      // nachdem schon ein Eintrag über p gefaltet war, wird die ganze Antwort zurückgenommen und nur unter p neu gefaltet.
      for (;;) {
        const c = this.checkpoint()
        const logLength = this.log.length
        let late = false
        const folded: number[] = []
        rest = sorted.filter(([p]) => p < stop)
        while (rest.length) {
          const next: typeof rest = []
          let progress = false
          for (const [pos, bytes] of rest) {
            if (pos > stop) continue
            const st = await this.replayStep(bytes)
            if (st === 'deferred') {
              next.push([pos, bytes])
              continue
            }
            progress = true
            if (st !== 'corrupt') {
              folded.push(pos)
              continue
            }
            if (!bad.has(pos)) corrupt(pos)
            stop = Math.min(stop, pos)
            if (folded.some((q) => q > pos)) late = true
          }
          if (late) break
          rest = next.filter(([p]) => p < stop)
          if (!progress) break
        }
        if (!late) break
        this.rollback(c)
        this.log.length = logLength
        this.dispositions.push(`rolled-back(journal-answer@${stop})`)
      }
    } finally {
      this.readingLog = false
    }
    let gap = a.end
    for (let p = a.from; p < a.end; p++)
      if (!byPos.has(p) || bad.has(p)) {
        gap = p
        break
      }
    if (rest.length) gap = Math.min(gap, rest[0]![0])
    this.logCursor = Math.max(this.logCursor, gap)
    if (gap === a.end) this.logSync = { pending: false, wait: 0, backoff: 1, id: this.logSync.id, answered: true, from: this.logSync.from }
    else {
      // Unvollständig: erneut ab der Lücke, mit Backoff (nicht jede Runde).
      this.logSync.wait = this.logSync.backoff
      this.logSync.backoff = Math.min(16, this.logSync.backoff * 2)
    }
  }
  /**
   * Ein Eintrag der Ablage als Schritt (alles oder nichts): `deferred` = Vorgänger fehlt oder blockiert (später erneut);
   * `corrupt` auch, wenn die Faltung nicht faltbar war (Review 26 B2, `CorruptFrame`: zurückgenommen, nie gefaltet).
   */
  private async replayStep(bytes: Uint8Array): Promise<'folded' | 'skip' | 'corrupt' | 'deferred'> {
    const r: { st: 'folded' | 'skip' | 'corrupt' } = { st: 'skip' }
    try {
      return (await this.guarded(async () => void (r.st = await this.replay(bytes)), true)) ? r.st : 'deferred'
    } catch (e) {
      if (!(e instanceof CorruptFrame)) throw e
      this.dispositions.push(`failed(journal-corrupt): ${e.message}`)
      return 'corrupt'
    }
  }
  /**
   * Einen eigenen Journalrahmen falten (Ablage und Briefkasten gleich, Review 26 B2): zuerst die Form (Payload mit `b`,
   * Batch im Kandidaten, Transaktion: `transactionProblem`), dann `applyRemote`. Wirft `CorruptFrame` für kaputte Form und
   * jede Ausnahme der Faltung außer `Missing` (zurückgestellt) und `Blocked`; der umgebende Schritt (`guarded`) nimmt alles
   * zurück. Ein Prüfstandfehler in der Faltung erscheint damit als Befund mit seiner Meldung, nicht als Absturz.
   */
  private async foldOwn(payload: unknown): Promise<void> {
    const { body, tx } = this.ownTx(payload)
    try {
      await this.applyRemote(tx)
      this.cand.applied?.(body)
    } catch (e) {
      if (e instanceof M.Missing || e instanceof Blocked || e instanceof Crashed || e instanceof CorruptFrame) throw e
      throw new CorruptFrame(`fold: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  /**
   * Eingangsvertrag (Review 26 B2, Review 27 B2a): Payload mit `b` als strengem base64, Batch im Kandidaten
   * (`receiveOwnFrame`, `batchProblem`, tief), Transaktion (`transactionProblem`, tief). Ohne Faltung; wirft
   * `CorruptFrame` für kaputte Form, `Missing` für einen fehlenden Vorgänger.
   */
  private ownTx(payload: unknown): { body: Uint8Array; tx: Transaction } {
    const b = isRecord(payload) ? payload.b : undefined
    if (!M.isBase64(b)) throw new CorruptFrame('payload')
    const body = new Uint8Array(Buffer.from(b, 'base64'))
    let tx: Transaction
    try {
      tx = this.cand.receiveOwnFrame(body)
    } catch (e) {
      if (e instanceof M.Missing) throw e // zurückgestellt (guarded, defer)
      if (e instanceof UnknownWriter) throw new CorruptFrame(`frame: ${e.message}`, undefined, 'unknown-writer') // K2 Schritt 1
      throw new CorruptFrame(`frame: ${e instanceof Error ? e.message : String(e)}`)
    }
    const problem = transactionProblem(tx)
    if (problem) throw new CorruptFrame(`transaction: ${problem}`)
    return { body, tx }
  }
  /**
   * Review 27 B2b: die Form eines Eintrags der Ablage, ohne zu falten (öffnen, Signatur, Signierer, Eingangsvertrag). Null
   * = faltbar der Form nach (auch: kein Journalrahmen, schon bekannt, Vorgänger fehlt); sonst was nicht stimmt.
   */
  private async entryProblem(bytes: Uint8Array): Promise<string | null> {
    const o = await this.openEntry(bytes)
    if (o === 'skip') return null
    if (o === 'corrupt') return 'entry'
    try {
      this.ownTx(o.payload)
      return null
    } catch (e) {
      if (e instanceof M.Missing) return null
      if (e instanceof CorruptFrame) return e.message
      throw e
    }
  }
  /** Briefkasten (Review 26 B2): Befund je Digest, einmal; keine Quittung (der Schritt ist zurückgenommen). */
  private corruptFrame(e: CorruptFrame): void {
    const ref = e.ref ?? '?'
    if (e.kind === 'unknown-writer') {
      // K2 Schritt 1: ein Batch, dessen Schreiber nicht zur aktuellen Gerätemenge gehört (oder nicht von ihm signiert ist).
      if (this.unknownSeen.has(ref)) return
      this.unknownSeen.add(ref)
      this.unknownWriters++
      this.dispositions.push(`failed(journal-unknown-writer): ${e.message}`)
      this.dispositions.push(`finding(journal:unknown-writer@${ref})`)
      return
    }
    if (this.corruptFrames.has(ref)) return
    this.corruptFrames.add(ref)
    this.frameCorrupt++
    this.dispositions.push(`failed(journal-corrupt): ${e.message}`)
    this.dispositions.push(`finding(journal:corrupt-frame@${ref})`)
  }
  /** Signaturprüfung, die bei kaputter Dokumentform nicht wirft (Review 26 B2): ungültig. */
  private async verified(doc: Doc & { proof: unknown }): Promise<boolean> {
    try {
      return await diVerify(doc, doc.issuer)
    } catch {
      return false
    }
  }
  /**
   * Ein Eintrag der Ablage: ein versiegelter Rahmen an die Self-Adresse. Journalrahmen vom eigenen Self-Anker werden
   * gefaltet wie bei der Zustellung (`receiveOwnFrame`, `applyRemote`, `applied`). Rückgabe (Review 25 B2): `folded`;
   * `skip` = geprüft und ohne Wirkung (eigener oder schon bekannter Rahmen, Quittung oder anderer gültiger Verkehr an der
   * Self-Adresse, den der Träger nicht unterscheidet); `corrupt` = nicht lesbar, nicht zu öffnen, ungültig signiert, fremder
   * Signierer oder kaputter Journalinhalt (Review 26 B2: `foldOwn` wirft `CorruptFrame`, `replayStep` verbucht ihn). Ein
   * fehlender Vorgänger wirft `Missing` (zurückgestellt). Lesen ist keine
   * Zustellung: keine Quittung, kein `completed`.
   */
  private async replay(bytes: Uint8Array): Promise<'folded' | 'skip' | 'corrupt'> {
    const o = await this.openEntry(bytes)
    if (typeof o === 'string') return o
    await this.foldOwn(o.payload) // CorruptFrame: `replayStep`
    this.log.push({ type: o.type.split('/').slice(-2)[0] ?? o.type, from: o.issuer, at: this.clock.now() })
    return 'folded'
  }
  /** Einen Eintrag der Ablage öffnen und prüfen (ohne Wirkung): `skip`, `corrupt` oder das Journaldokument vom eigenen Self-Anker. */
  private async openEntry(bytes: Uint8Array): Promise<'skip' | 'corrupt' | { type: string; issuer: string; payload: unknown }> {
    let env: unknown
    try {
      env = JSON.parse(dec.decode(bytes))
    } catch {
      return 'corrupt'
    }
    const ctx = `self/${this.person}`
    const self = (await this.keysFor(ctx)).anchor
    let v: Awaited<ReturnType<typeof receive>>
    try {
      v = await receive(env, this.resolve, this.completed)
    } catch {
      return 'corrupt'
    }
    if (v.disposition !== 'unique') return v.disposition === 'duplicate-known' ? 'skip' : 'corrupt'
    if (this.zusteller.submissions.has(v.digest!)) return 'skip'
    const doc = v.document as unknown as Doc & { proof: unknown }
    if (!(await this.verified(doc))) return 'corrupt'
    if (doc.type !== TYPES.journal) return 'skip'
    if (doc.issuer !== self) {
      this.dispositions.push('failed(journal-from-unexpected-signer)')
      return 'corrupt'
    }
    return { type: doc.type, issuer: doc.issuer, payload: doc.payload }
  }
  /** Deckt der eigene Stand die genannten Köpfe? */
  private covers(heads: Record<string, number>): boolean {
    const mine = this.cand.heads?.() ?? {}
    return Object.entries(heads).every(([w, n]) => (M.own(mine, w) ?? 0) >= n)
  }

  /** 8110.7: Zeitübergänge. */
  private async tick(): Promise<void> {
    const now = this.clock.now()
    for (const a of this.state.acts.slice()) {
      if (a.state === 'offered' && Date.parse(now) > Date.parse(a.expiresAt) - M.PARAM.consentReserveMs) await this.guarded(async () => void this.emit({ kind: 'expire', act: a.id })) // 8325.A7
      else if (a.state === 'consented' && Date.parse(now) > Date.parse(a.expiresAt)) await this.guarded(async () => void this.emit({ kind: 'expire', act: a.id })) // 8325.A8
    }
    for (const r of this.state.relationships.slice()) {
      const aging = r.stock.filter((k) => k.state === 'active' && !M.usable(k.expiresAt, now)).map((k) => k.anchor)
      if (aging.length) await this.guarded(async () => void this.emit({ kind: 'age', rel: r.id, anchors: aging })) // 8475.S5
    }
    // B6: fällige Arbeit folgt aus dem Zustand, nicht aus dem Ereignis; `refill` ist leer, wenn nichts fehlt.
    await this.refillAll()
    if (this.sets) {
      // K2 Schritt 2: fällige Produktion (E2 (iv)), eigener Vorrat öffentlicher Geräteschlüssel, nachzuholende Aufnahmen, Revisionen.
      await this.produceOwed()
      await this.refillPools()
      await this.admitPending()
      // Je Wurzel ein eigener Schritt (ein Batch je Revision: die Absicht trägt die versiegelten Bytes, Grenze 64 KiB je Rahmen).
      for (const root of Object.keys(this.state.sets ?? {})) await this.guarded(() => this.publishSets(root))
    }
  }

  /** Zustellerberichte in Fachwirkung: Karte taken/given-up (8326), Mapping sent, Wiederholung nach `failed` (6845.4). */
  private async reports(): Promise<void> {
    for (const [d, x] of [...this.sent]) await this.guarded(() => this.reportOne(d, x))
  }
  private async reportOne(d: string, x: Sent): Promise<void> {
    {
      const r = this.zusteller.report(d)
      if (!r) return
      if (x.kind === 'card' && x.act) {
        const a = this.state.acts.find((y) => y.id === x.act)
        if (!a) return
        // O je Übergabe (Regel 3): die Karte des Schwestergeräts ändert nichts am Bericht dieser Karte.
        const o = M.own(a.cards, d) ?? a.o
        if (o === 'handed' && r.state === 'accepted') {
          this.emit({ kind: 'hand-over', act: x.act, o: 'taken', digest: d })
          await this.evaluatePending(x.act)
        } else if (o === 'taken' && r.state === 'failed') this.emit({ kind: 'hand-over', act: x.act, o: 'given-up', digest: d })
      }
      if (x.kind === 'mapping' && x.pair) {
        const duty = this.state.duties.find((y) => y.pair[0] === x.pair![0] && y.pair[1] === x.pair![1])
        if (!duty) return
        if (duty.state === 'hit' && r.state === 'accepted') this.emit({ kind: 'duty', pair: x.pair, state: 'sent', mappingDigest: d })
        if ((duty.state === 'sent' || duty.state === 'hit') && r.state === 'failed') {
          // 6845.4: dieselben Bytes in einer neuen Übergabe.
          this.zusteller.record(d, x.frame, x.address, this.zusteller.submissions.get(d)?.extra)
          this.held.push(d)
          this.emit({ kind: 'duty', pair: x.pair, state: 'hit', mappingDigest: d })
        }
      }
    }
  }

  // ── Empfang ──
  private async handle(bytes: Uint8Array, address: string): Promise<void> {
    let env: unknown
    try {
      env = JSON.parse(dec.decode(bytes))
    } catch {
      this.dispositions.push('failed(malformed)')
      return
    }
    const ctx = this.ctxOfRkid.get(address)
    if (ctx) await this.keysFor(ctx)
    let v: Awaited<ReturnType<typeof receive>>
    try {
      v = await receive(env, this.resolve, this.completed)
    } catch (e) {
      this.dispositions.push(`failed(malformed): ${(e as Error).message}`)
      return
    }
    this.dispositions.push(v.disposition)
    if (v.disposition === 'duplicate-known') {
      const ack = this.acks.get(v.digest!)
      if (ack) {
        this.zusteller.record(ack.digest, ack.frame, ack.address)
        this.held.push(ack.digest)
      }
      return
    }
    if (v.disposition !== 'unique') return
    if (this.zusteller.submissions.has(v.digest!)) {
      // Auf der gemeinsamen Adresse der Person liest jedes Gerät auch, was es selbst eingeliefert hat.
      this.dispositions.push('skipped(own-frame)')
      return
    }
    const doc = v.document as unknown as Doc & { proof: unknown }
    if (!(await this.verified(doc))) {
      this.dispositions.push('failed(proof-invalid)')
      return
    }
    const payload = isRecord(doc.payload) ? doc.payload : null
    const writer = payload?.writer
    // K2 Schritt 1: der Schreiber ist der Signierer (Revision, Probe, Mapping); die Beziehung kommt aus der Empfangsadresse, weil ein Schwestergerät der Gegenperson unter einem anderen Anker signiert als dem aufgezeichneten.
    const signed = this.cand.signerWriters && (doc.type === TYPES.revision || doc.type === TYPES.probe || doc.type === TYPES.mapping)
    const via = signed ? this.tupleOfAddress(address) : undefined
    const viaRel = via ? M.relOfTuple(this.state, via.id) : undefined
    this.log.push({ type: doc.type.split('/').slice(-2)[0] ?? doc.type, from: doc.issuer, at: this.clock.now(), ...(signed ? { writer: signerId(doc.issuer) } : typeof writer === 'string' ? { writer } : {}), ...(viaRel ? { rel: M.resolveId(this.state, viaRel.id) } : {}) })
    // Review 26 B2: ohne Objekt als Payload ist kein Dokument lesbar (Journalrahmen: Befund im Journalzweig).
    if (!payload && doc.type !== TYPES.journal) {
      this.dispositions.push('failed(malformed-payload)')
      return
    }
    // Review 31 B1: unter Geräteschlüsseln bestimmt nur der Signierer den Schreiber (8500/6270); ein Nutzlastfeld `writer`
    // ist ein Formfehler, auch wenn es den Signierer nennt: Befund, keine Wirkung, keine Quittung.
    if (signed && payload && Object.hasOwn(payload, 'writer')) {
      this.emit({ kind: 'finding', text: `${doc.type.split('/').slice(-2)[0] ?? doc.type} von ${doc.issuer.slice(-8)}: writer-Feld unter Geräteschlüsseln (Schreiber = Signierer): Formfehler` })
      this.dispositions.push('failed(malformed-payload)')
      return
    }
    if (doc.type === TYPES.ack) {
      const p = doc.payload as { ref?: string }
      if (typeof p.ref !== 'string') return
      // #55: die Quittung gilt nur vom erwarteten Empfänger der konkreten Submission; ohne Submission gilt sie nicht.
      const want = this.expected.get(p.ref)
      if (!want) {
        this.dispositions.push('failed(ack-unbound)')
        this.measures.unboundAcks++
        return
      }
      if (want !== doc.issuer && !(this.sets && (await this.isPeer(doc.issuer, want)))) {
        this.dispositions.push('failed(ack-from-unexpected-signer)')
        return
      }
      this.completed.add(v.digest!)
      this.zusteller.acknowledged(p.ref)
      await this.onAck(p.ref)
      return
    }
    let effect: boolean
    if (doc.type === TYPES.journalSync) {
      // Ein eigenes Gerät nennt seine Köpfe: was es nicht hat, geht ihm als Journalrahmen zu (Nachholen, X21).
      if (address !== this.ownRkid) return
      if (!(await this.fromOwnDevice(doc.issuer))) {
        this.ownSignerRejected(doc.issuer, v.digest!)
        return
      }
      const p = doc.payload as { heads?: Record<string, number>; reply?: boolean; req?: string }
      // Review 26 B2: Köpfe sind ein Objekt aus Zahlen; sonst ist die Anfrage oder Antwort nicht lesbar. Review 28: jeder
      // Schlüssel ist eine Schreiberinkarnation nach ihrer Grammatik (nie ein reservierter Name), jeder Wert ganz ≥ 0.
      if (p.heads !== undefined && M.shapeProblem(p.heads, HEADS_SHAPE, 'heads')) {
        this.dispositions.push('failed(malformed-payload)')
        return
      }
      const heads = p.heads ?? {}
      if (p.reply) {
        // Antwort eines Schwestergeräts: nur auf die laufende Anfrage (Kennung, Review 19 B1a). Decken die eigenen Köpfe
        // seine, ist das Nachholen abgeschlossen; sonst weiter anfragen. Eine alte, wiederholte oder fremde Antwort zählt
        // nicht; dieselbe Antwort ein zweites Mal ändert nichts (das Nachholen ist schon beendet).
        if (typeof p.req !== 'string' || p.req !== this.sync.id) this.staleSyncAnswers++
        else if (this.sync.pending && this.covers(heads)) this.sync = { ...this.sync, pending: false, wait: 0, backoff: 1 }
      } else {
        // K2 Schritt 1: die Antwort geht nur an das anfragende Gerät (versiegelt an dessen Self-Schlüssel), nicht an jede Schwester.
        const asker = this.cand.selfPeers ? (await this.cand.selfPeers()).filter((k) => k.anchor === doc.issuer) : undefined
        for (const f of this.cand.batchesAfter?.(heads) ?? []) await this.sendJournal(f.body, asker)
        if (this.cand.heads) await this.sendSelf(TYPES.journalSync, { heads: this.cand.heads(), reply: true, ...(typeof p.req === 'string' ? { req: p.req } : {}) }, asker)
        // Weiß der Anfragende mehr als wir, holen wir selbst nach.
        if (!this.covers(heads) && !this.sync.pending) this.requestSync()
      }
      effect = true
    } else if (doc.type === TYPES.journal) {
      // Journalrahmen: nur auf der eigenen Adresse und nur vom eigenen Self-Anker (one-seed: auf allen Geräten derselbe).
      if (address !== this.ownRkid) return
      if (!(await this.fromOwnDevice(doc.issuer))) {
        this.ownSignerRejected(doc.issuer, v.digest!)
        return
      }
      // Review 26 B2: Form vor dem Falten; nicht faltbar → CorruptFrame mit Digest (`round`: Befund, keine Quittung).
      // Missing → zurückgestellt (guarded, defer).
      try {
        await this.foldOwn(doc.payload)
      } catch (e) {
        if (e instanceof CorruptFrame) throw new CorruptFrame(e.message, v.digest!, e.kind)
        throw e
      }
      effect = true
    } else effect = await this.dispatch(doc, address, v.digest!)
    if (!effect) {
      this.dispositions.push('failed(validation-failed)')
      return
    }
    this.completed.add(v.digest!)
    // Quittung an die Antwortadresse, byte-identisch aufbewahrt (§6.2 Stufe 4); eingeliefert nach dem Commit.
    const k = await this.keysFor(ctx ?? '')
    const ackDoc = await diSign({ anchor: k.anchor, ed: { priv: k.ed.priv } }, { id: crypto.randomUUID(), type: TYPES.ack, issuer: k.anchor, recipient: doc.issuer, replyTo: '', issuedAt: this.clock.now(), payload: { ref: v.digest!, meaning: 'received' } }, this.clock.now())
    const ackEnv = await seal(ackDoc as unknown as Json, doc.replyTo)
    const ackBytes = enc.encode(jcs(ackEnv))
    const ackDigest = await digestBytes(enc.encode(jcs(ackDoc)))
    this.produced.set(frameHash(ackBytes), 'delivery-ack')
    this.observe('produced', (o) => o.produced(this, { digest: ackDigest, type: TYPES.ack, issuer: k.anchor, recipient: doc.issuer, payload: { ref: v.digest!, meaning: 'received' }, frames: [ackBytes] }))
    this.acks.set(v.digest!, { frame: ackBytes, digest: ackDigest, address: doc.replyTo })
    this.zusteller.record(ackDigest, ackBytes, doc.replyTo)
    this.held.push(ackDigest)
  }

  /** Quittung auf ein eigenes Dokument: Karte delivered (8326.10), Mapping united (6845.3) mit Nachlieferung (6987.14 light). */
  private async onAck(ref: string): Promise<void> {
    const x = this.sent.get(ref)
    if (!x) return
    if (x.kind === 'card' && x.act) {
      const a = M.act(this.state, x.act)
      const o = M.own(a.cards, ref) ?? a.o
      if (o === 'taken' || o === 'given-up' || o === 'handed') {
        this.emit({ kind: 'hand-over', act: x.act, o: 'delivered', digest: ref })
        await this.evaluatePending(x.act)
      }
      return
    }
    if (x.kind === 'mapping' && x.pair) {
      const before = this.state.duties.find((d) => d.pair[0] === x.pair![0] && d.pair[1] === x.pair![1])?.state
      this.emit({ kind: 'duty', pair: x.pair, state: 'united', mappingDigest: ref })
      if (before !== 'united') {
        const r = M.relOfTuple(this.state, x.pair[0])
        if (r && r.stock.length && !r.departed) await this.sendRevision(r.id) // 6987.14: nach bestätigter Vereinigung eine frische Revision
      }
    }
  }

  /** Das eigene Tupel hinter einer Empfangsadresse; nach dem Abgang der Beziehung keines mehr (8475.S6: kein neuer Rahmen des Kontakts wirkt oder wird quittiert). */
  private tupleOfAddress(address: string): M.Tuple | undefined {
    const ctx = this.ctxOfRkid.get(address)
    if (!ctx) return undefined
    for (const r of this.state.relationships) if (!r.departed) for (const t of r.tuples) if (t.ownKey === ctx) return t
    return undefined
  }

  /** E15 2b.0: a document that passed its form checks, for the outcome ledger (observation only). */
  private admitted(doc: Doc, address: string, digest: string): void {
    this.observe('admitted', (o) => o.admitted(this, { digest, type: doc.type, issuer: doc.issuer, address, payload: doc.payload as Record<string, unknown> }))
  }

  /** Fachliche Auswertung je Typ; true = Wirkung (quittieren), false = abgewiesen (keine Quittung). Jeder Zweig bindet das Dokument an den erwarteten Signierer (#55). */
  private async dispatch(doc: Doc, address: string, digest: string): Promise<boolean> {
    const now = this.clock.now()
    // Tor-Review 40 B1 (MV-24): Form vor jedem Feldzugriff; ein unvollständiges Dokument ist ein Formfehler, keine Ausnahme.
    const shape = doc.type === TYPES.revision ? M.DOC_SHAPES.revision : doc.type === TYPES.card ? M.DOC_SHAPES.card : undefined
    const kind = doc.type === TYPES.revision ? 'revision' : 'card'
    const bad = shape ? M.shapeProblem(doc.payload, shape, kind) : null
    if (bad) {
      const text = `${kind} von ${doc.issuer.slice(-8)}: Form ${bad} (MV-24): Formfehler, abgewiesen`
      if (!this.state.findings.includes(text)) this.emit({ kind: 'finding', text })
      return false
    }
    if (doc.type !== TYPES.revision) this.admitted(doc, address, digest) // a revision after its own form rules (below)
    switch (doc.type) {
      case TYPES.revision: {
        // M: 8550/8557/6270, vereinfacht.
        const t = this.tupleOfAddress(address)
        if (!t || !(await this.isPeer(doc.issuer, t.peer))) return false
        const r = M.relOfTuple(this.state, t.id)!
        const p = doc.payload as unknown as { revision: number; keys: Array<{ n: number; anchor: string; keyAgreement: string; expiresAt: string }>; writer?: string; clears?: Record<string, number>; tombstones?: string[] }
        if (this.cand.signerWriters) {
          // K2: 6270 je Signierer; nur der Signierer (Review 31 B1). Review 34 B5: eine Rückzugsrevision nennt konkrete Anker
          // (`tombstones`, nur bei leerer Liste); Nummernmarken (`clears`) gibt es unter Geräteschlüsseln nicht: Formfehler.
          if (Object.hasOwn(p, 'clears')) {
            const text = `revision ${String(p.revision)} von ${doc.issuer.slice(-8)}: clears unter Geräteschlüsseln (Aufhebung nur als Grabstein je Anker, Review 34): Formfehler`
            if (!this.state.findings.includes(text)) this.emit({ kind: 'finding', text })
            return false
          }
          if (p.tombstones !== undefined && (p.keys.length !== 0 || M.shapeProblem(p.tombstones, { array: 'ident' }, 'tombstones'))) return false
          this.admitted(doc, address, digest)
          return this.foldSignerRevision(r, t, { revision: p.revision, keys: p.keys, writer: signerId(doc.issuer), tombstones: p.tombstones })
        }
        if (p.writer !== undefined && M.shapeProblem(p.writer, 'tag', 'writer')) return false // Review 28: Schreiberkennung nach ihrer Grammatik, sonst abgewiesen
        this.admitted(doc, address, digest)
        if (typeof p.writer === 'string') return this.acceptWriterRevision(r, t, doc.issuer, p as typeof p & { writer: string })
        if (r.view && r.view.scope === t.id && p.revision <= r.view.revision) {
          const same = p.revision === r.view.revision
          // Wiederholung nur bei gleichem ganzen Schlüsselwert (Anker, Vereinbarung, Ablauf); sonst Equivokation (6270; Review 5).
          const whole = (ks: typeof p.keys) => M.canonical([...ks].sort((a, b) => a.anchor.localeCompare(b.anchor)))
          const sameKeys = same && whole(p.keys) === whole(r.view.keys)
          if (same && sameKeys) return true
          this.emit({ kind: 'finding', text: same ? `revision ${p.revision} von ${doc.issuer.slice(-8)}: gleiche Nummer, andere Schlüssel: Equivokation (6270)` : `revision ${p.revision} von ${doc.issuer.slice(-8)} unter der gehaltenen ${r.view.revision}: abgewiesen (6270)` })
          return false
        }
        if (r.view && r.view.scope !== t.id && t.record < M.tuple(this.state, r.view.scope).record) return false // älterer Kopf
        this.emit({ kind: 'view', rel: r.id, scope: t.id, revision: p.revision, keys: p.keys })
        return true
      }
      case TYPES.ticket: {
        // Seite: 8640. K2 Schritt 2: das Ticket ist an den benannten Vorrats-Schlüssel versiegelt (nur sein Halter öffnet es);
        // Kanal ist dessen Beziehung, der Signierer ein Mitglied von Ms Menge auf einem ihrer Tupel.
        // E15 2b.0 (Tor-Review 43): 8640.2–8640.8 as one predicate (`ticketAcceptance`), the same the outcome ledger applies
        // as reference; the state steps 8640.4, 8640.12, 8640.6 come in here, in their place.
        const v = ticketAcceptance(doc, address, this.ticketReceiver(now), {
          repeated: (p) => this.state.acts.some((a) => a.id === p.act), // 8640.4: Wiederholung
          usable: (own, p) => {
            if (own.state === 'consumed') {
              // 8640.12 als Regel (MV-6 neu, Anton 20.10.): A hält den Einmalverbrauch. Ein zweiter Akt auf einem verbrauchten
              // Schlüssel ist abgewiesen, gleich ob der Mediator nach einem Restore aus dem erreichbaren Stand benannt hat
              // (benannter Preis) oder fehlerhaft ist; kein Akt, keine Quittung. M nimmt danach den nächsten Schlüssel.
              this.emit({ kind: 'finding', text: `ticket ${p.act.slice(0, 8)}: own ${p.own.slice(-8)} schon verbraucht: abgewiesen nach Regel 8640.12 (Einmalverbrauch bei A; Restore-Artefakt oder Konformitätsfehler des Mediators)` })
              return false
            }
            return own.state === 'active' || own.state === 'aging' // 8640.6
          },
        })
        if (!v.ok) {
          if (v.step === '8640.5') this.emit({ kind: 'finding', text: `ticket ${v.p!.act.slice(0, 8)}: own ${v.p!.own.slice(-8)} nicht auf dieser Beziehung (8640.5)` })
          return false
        }
        if (v.repeated) return true
        const { rel: r, own, p } = v
        const assigned = this.state.voucherAssigned.find((x) => x.anchor === p.voucher.anchor)
        if (assigned && assigned.act !== p.act) {
          this.emit({ kind: 'finding', text: `ticket ${p.act.slice(0, 8)}: voucher schon einem anderen Akt zugeordnet (8640.9, 8640.12)` })
          return false
        }
        if (M.budgetExhausted(r, now)) {
          this.emit({ kind: 'ticket-refuse-budget', rel: r.id, own: own.anchor }) // 8640.13
          this.emit({ kind: 'finding', text: `ticket ${p.act.slice(0, 8)}: Budget erschöpft (8640.10)` })
          return false
        }
        const a: M.Act = { id: p.act, mediator: r.id, own: own.anchor, voucher: p.voucher, issuedAt: p.issuedAt, expiresAt: p.expiresAt, state: 'offered', pending: null, v: null, k: false, ownCard: null, ownCardKey: null, o: 'none', ownCardDigest: null, opened: null }
        this.emit({ kind: 'ticket-accept', act: a }) // 8640.14; K1a ohne Annahmerecht: Blocked, der Rahmen wird ganz zurückgenommen und nicht quittiert
        // 8640.15 mit demselben Prüfsatz wie bei direkter Ankunft (8850.6, B7): Akt, Absender, Ablauf müssen passen.
        const bkey = `${own.anchor}|${p.voucher.anchor}|${p.act}`
        const buffered = this.buffer.get(bkey)
        // K2 Schritt 2: ein bekannter Widerruf der Wurzel der gepufferten Karte schlägt auch in der Pufferauswahl (E1 (a)).
        const revokedRoot = !!buffered && this.sets && M.setView(this.setOf(buffered.card.anchor)).revoked.has(buffered.card.anchor)
        if (buffered && revokedRoot) this.buffer.delete(bkey)
        else if (buffered && buffered.from === a.voucher.anchor && buffered.expiresAt === a.expiresAt) {
          this.buffer.delete(bkey)
          // Review 33 B3: jeder Eintrittspfad prüft wie der direkte; 8850.6 (d) unter dem richtigen `from` setzt K (E3).
          if (this.sets && buffered.fromKeyAgreement !== a.voucher.keyAgreement) this.emit({ kind: 'card-refused', act: a.id, v: buffered.v, k: true })
          else this.emit({ kind: 'card-pending', act: a.id, card: buffered.card, v: buffered.v })
        }
        await this.refill(r.id)
        return true
      }
      case TYPES.card: {
        // Seite: 8850/8910, vereinfacht.
        const ctx = this.ctxOfRkid.get(address)
        const own = ctx ? await this.keysFor(ctx) : undefined
        if (!own) return false
        const p = doc.payload as unknown as { act: string; expiresAt: string; from: string; fromKeyAgreement: string; to: string; card: M.Card; set?: string }
        const to = own.anchor
        // Messung (X23, Review 34 S4): jede Ankunft einer Karte mit ihrem Ausgang an diesem Gerät; ändert nichts am Verhalten.
        const note = <T,>(outcome: string, result: T): T => (this.cardLog.push({ act: String(p.act), at: now, outcome }), result)
        if (this.sets) {
          // K2 Schritt 2, E2 (iv): die Karte erzeugt das Gerät, das den Vorrats-Schlüssel zugeteilt hat, und signiert mit ihm
          // selbst; eine Karte unter einem anderen Schlüssel kommt von außerhalb der Menge: abgewiesen ohne K (E3 (a), 8850.2 (b)).
          if (p.to !== to || doc.issuer !== p.from) return note('binding-8850.2', false)
          // E1 (a): ohne den Mengennachweis wartet die Karte (kein V, kein K); ein bekannter Widerruf schlägt den älteren Bezug.
          const problem = this.cardSetProblem(p.card.anchor, typeof p.set === 'string' ? p.set : undefined)
          if (problem) {
            this.emit({ kind: 'finding', text: problem })
            return note('set-proof', false)
          }
          if (p.card.keyAgreement !== this.setOf(p.card.anchor)!.rootKeyAgreement) return note('set-root', false) // die Menge gehört zu dieser Karte
        } else if (p.to !== to || !(await this.isPeer(doc.issuer, p.from))) return note('binding-8850.2', false) // 8850.2 (b)
        const v = await digestBytes(enc.encode(jcs({ act: p.act, card: p.card })))
        const a = this.state.acts.find((x) => x.own === to)
        if (!a) {
          // Pufferzweig (8910.1–.3): die ganze Nutzlast, geprüft wird bei der Zuordnung (B7).
          const key = `${to}|${p.from}|${p.act}`
          const b = this.buffer.get(key)
          if (!b) this.buffer.set(key, { act: p.act, from: p.from, expiresAt: p.expiresAt, card: p.card, v, ...(this.sets && p.set ? { set: p.set } : {}), ...(this.sets ? { fromKeyAgreement: p.fromKeyAgreement } : {}) })
          else if (b.v !== v) return note('buffer-conflict', false)
          return note('buffered', true)
        }
        if (a.id !== p.act || p.from !== a.voucher.anchor || p.expiresAt !== a.expiresAt) return note('binding-8850.6', false) // 8850.6
        if (this.sets && p.fromKeyAgreement !== a.voucher.keyAgreement) {
          this.emit({ kind: 'card-refused', act: a.id, v, k: true }) // 8850.6 (d): widersprüchliche Schlüsselbindung unter dem richtigen `from` (E3)
          return note('binding-8850.6d', false)
        }
        if (Date.parse(now) > Date.parse(a.expiresAt) + M.PARAM.actSkewMs) return note('after-acceptance-end-8110.5', false) // 8110.5: Annahmeende
        if (a.v && a.v !== v) {
          this.emit({ kind: 'card-refused', act: a.id, v, k: true }) // 8910.8
          return note('conflict-8910.8', false)
        }
        // 8910.7: Wiederholung. Prüfstandregel für zwei Übergaben eines Akts (K1a Schritt 3, Regel 3; Spec-Folgepunkt
        // 8326/8910): mit einem Seed tragen beide Karten denselben Kartenschlüssel und dieselbe Nutzlast, also denselben
        // Vergleichsdigest V (8910.0 über die Nutzlast, 8913 unabhängig von den Dokumentbytes). B behält die erste geprüfte
        // Karte; die zweite ist eine Wiederholung des Akts: Quittung, keine zweite Verbindung, keine Konfliktmarke K.
        // Unterscheidet sich der Karteninhalt (Schlüssel je Gerät, K2), greift 8910.8: abgewiesen, K := yes.
        if (a.v === v) return note('repeat-8910.7', true)
        if (a.state === 'declined' || a.state === 'expired') {
          this.emit({ kind: 'card-refused', act: a.id, v, k: false }) // 8910.6
          // MV-31 / MV-6 neu: eine Ablehnung kann die Faltung noch umentscheiden (Regel 2: eine eingereichte eigene Karte,
          // etwa von einem Gerät aus einem alten Abbild, das auf niemanden wartet). Die geprüfte Gegenkarte bleibt als
          // verdecktes P erhalten (die Projektion zeigt P eines abgelehnten Akts nicht, 8325.A3); entscheidet die Faltung für
          // die Zustimmung, verbindet das Gerät mit der eingereichten Karte (`connectOwed`, 8325.A5c).
          if (a.state === 'declined' && !a.pending) this.emit({ kind: 'card-pending', act: a.id, card: p.card, v })
          return note(`refused-${a.state}-8910.6`, true)
        }
        if (a.state === 'consented' && this.submitted(a)) {
          this.emit({ kind: 'card-pending', act: a.id, card: p.card, v })
          await this.connect(a, p.card) // 8910.5
          return note('connected-8910.5', true)
        }
        this.emit({ kind: 'card-pending', act: a.id, card: p.card, v }) // 8910.4
        return note('pending-8910.4', true)
      }
      case TYPES.probe: {
        const t = this.tupleOfAddress(address)
        if (!t || !(await this.isPeer(doc.issuer, t.peer))) return false
        const p = doc.payload as unknown as { entries: string[] }
        const open = await this.evaluateProbe(t, p.entries)
        // Aufbewahrung (Tor-Review 16 B2): nur die jüngste Probe je Ankunftstupel, ihre offenen Einträge ersetzen die der
        // früheren, nie vereinigt. Aus 6750: eine wiederholte Probe zeigt nichts, was die erste nicht zeigte; die Grenze ist
        // damit die Größe einer Probe (die Kandidatenliste der Gegenseite), gleich wie viele Proben kommen.
        if (this.cand.reevaluateProbes) {
          if (open.length) this.probes.set(t.id, open)
          else this.probes.delete(t.id)
        }
        return true // Wirkung „geprüft“, quittiert, mit oder ohne Treffer
      }
      case TYPES.mapping: {
        const t = this.tupleOfAddress(address)
        if (!t || !(await this.isPeer(doc.issuer, t.peer))) return false
        const p = doc.payload as unknown as { entry: string }
        const matches: M.Tuple[] = []
        for (const r of this.state.relationships) if (!r.departed) for (const other of r.tuples) if (other.id !== t.id && this.blind(t, other.peer) === p.entry) matches.push(other)
        if (matches.length !== 1) return false // 6960/6945; Tupel abgegangener Beziehungen zählen nicht (6845.7)
        if (M.relOfTuple(this.state, t.id)?.departed) return false
        const other = matches[0]!
        const ra = M.relOfTuple(this.state, t.id)!
        const rb = M.relOfTuple(this.state, other.id)!
        const edge = M.pairKey(t.id, other.id)
        if (ra.id !== rb.id) {
          this.emit({ kind: 'union', a: ra.id, b: rb.id, edge }) // 6975.2
          const united = M.relOfTuple(this.state, t.id)!
          if (united.stock.length) await this.sendRevision(united.id) // 6987.5: Revision auf dem Kopf nach der Vereinigung
        } else this.emit({ kind: 'edge', edge }) // 6975.3
        const duty = this.state.duties.find((d) => d.pair[0] === edge[0] && d.pair[1] === edge[1])
        if (!duty || duty.state === 'none') await this.sendMapping(t, other) // 6845.1 zweiter Auslöser
        return true
      }
      case TYPES.deviceSet: {
        // K2 Schritt 2: `device-set@1` (Revisionstyp der 6270-Liste). Die Wahrheit sind die signierten Nachweise (Zugänge,
        // Widerrufe); die Revision ist kumulativ und je Signierer nummeriert (6270 nur Wiederholung und Equivokation).
        if (!this.sets) return false
        const p = doc.payload as unknown as { root: string; rootKeyAgreement: string; revision: number; deps: string[]; entries: unknown[] }
        if (M.shapeProblem(p, SET_SHAPE, 'device-set')) return false
        // Auf einem Tupel: nur für dessen Wurzel (der Anker, den dieses Gerät für die Gegenseite zuerst geprüft hat). An einem
        // eigenen Vorrats-Schlüssel: die Menge einer neuen Beziehung aus einer Vorstellung, mit der Karte (Wurzel = Kartenanker).
        const t = this.tupleOfAddress(address)
        if (t ? t.peer !== p.root || t.peerKeyAgreement !== p.rootKeyAgreement : !this.tupleOfStock(address)) return false
        const held = this.setOf(p.root)
        for (const c of p.entries) {
          if (await this.certValid(c, p.root)) continue
          this.emit({ kind: 'finding', text: `device-set auf ${p.root.slice(-8)} von ${doc.issuer.slice(-8)}: ungültiger Nachweis, nichts gefaltet` })
          return false
        }
        const entries = p.entries as M.SetCert[]
        const merged: M.DeviceSet = { root: p.root, rootKeyAgreement: held?.rootKeyAgreement ?? p.rootKeyAgreement, certs: M.tableOf(held?.certs), revs: M.table(), seen: [] }
        for (const c of entries) M.put(merged.certs, M.certKey(c), c)
        // Signierer: die Wurzel oder ein Gerät, dessen Zugang eine signierte Kette bis zur Wurzel trägt (nie „gerade in meiner Liste“).
        if (!M.setView(merged).ever.has(doc.issuer)) {
          this.emit({ kind: 'finding', text: `device-set auf ${p.root.slice(-8)}: Signierer ${doc.issuer.slice(-8)} ohne Zugang: abgewiesen` })
          return false
        }
        // Ein bekannter Widerruf schlägt: eine Revision eines widerrufenen Geräts wirkt nicht mehr (E1 (a)).
        if (held && M.setView(held).revoked.has(doc.issuer)) {
          this.emit({ kind: 'finding', text: `device-set auf ${p.root.slice(-8)}: Signierer ${doc.issuer.slice(-8)} widerrufen: abgewiesen` })
          return false
        }
        // Review 33 (B1, B2): der Empfang filtert nicht und verwirft nichts als „älter“. Jede gültige Revision erreicht die
        // Faltung mit allen Nachweisen, ihrer Nummer und ihren signierten Vorgängern; die Faltung entscheidet reihenfolgefrei
        // (Zwei-Phasen-Menge; bei widersprüchlichen Fassungen die kanonisch kleinste, beide für den Befund gehalten; je
        // Signierer die höchste Nummer, gleiche Nummer mit anderem Inhalt Equivokation; `deps` decken frühere Revisionen).
        this.emit({ kind: 'device-set', root: p.root, rootKeyAgreement: p.rootKeyAgreement, certs: entries, rev: { signer: signerId(doc.issuer), n: p.revision, digest }, seen: digest, deps: p.deps })
        return true
      }
      default:
        return false
    }
  }

  /**
   * M liest mehrere Schreiber (Schritt 4): 6270 je Schreiberkennung im Scope des Tupels (6280). Höher als die gehaltene
   * Revision dieses Schreibers: angenommen (Lücken sind erlaubt, 8500: Nummern aufgehobener Revisionen bleiben verbraucht);
   * gleich und gleich: Wiederholung; gleich und abweichend: Equivokation; niedriger: abgewiesen. Eine leere Revision
   * (8535) trägt als Aufhebungsmarke die jüngste Revision jedes Schreibers, die dieses Gerät hält.
   */
  private acceptWriterRevision(r: M.Relationship, t: M.Tuple, issuer: string, p: { revision: number; keys: M.ListedKey[]; writer: string }): boolean {
    const same = r.view && r.view.scope === t.id ? r.view : null
    const held = M.own(same?.writers, p.writer)
    if (held && p.revision <= held.revision) {
      const whole = (ks: M.ListedKey[]) => M.canonical([...ks].sort((a, b) => a.anchor.localeCompare(b.anchor)))
      if (p.revision === held.revision && whole(p.keys) === whole(held.keys)) return true
      this.emit({ kind: 'finding', text: p.revision === held.revision ? `revision ${p.revision} von ${issuer.slice(-8)} (Schreiber ${p.writer.slice(0, 8)}): gleiche Nummer, andere Schlüssel: Equivokation (6270)` : `revision ${p.revision} von ${issuer.slice(-8)} (Schreiber ${p.writer.slice(0, 8)}) unter der gehaltenen ${held.revision}: abgewiesen (6270)` })
      return false
    }
    if (r.view && r.view.scope !== t.id && t.record < M.tuple(this.state, r.view.scope).record) return false // älterer Kopf
    const clears = p.keys.length === 0 && same?.writers ? Object.fromEntries(Object.entries(same.writers).map(([w, x]) => [w, x.revision])) : undefined
    this.emit({ kind: 'view', rel: r.id, scope: t.id, revision: p.revision, keys: p.keys, writer: p.writer, ...(clears ? { clears } : {}) })
    return true
  }

  /**
   * K2, Review 33 B4 / Review 34 B5: M faltet jede Revision eines Signierers (Vertrag wie die Mengen: der Empfang filtert
   * nicht, die Faltung entscheidet). Je Schreiber zählt die höchste Revision, gleiche Nummer mit anderen Schlüsseln ist eine
   * Equivokation (kanonisch kleinere, Befund), eine niedrigere ändert die Schlüssel nicht. Eine Rückzugsrevision (8535)
   * nennt die Anker, die sie zurückzieht; die Faltung hält je Anker einen Grabstein (wächst nur, reihenfolgefrei), der
   * jede Listung des Ankers dominiert. Klasse aus ist Sache der Person (Review 35 B6, Entscheidung 1b, Vertrag 4.10): der
   * Grabstein jedes Mitglieds zählt für jeden Anker der Person, in beiden Varianten; ein widerrufener Signierer nur für Anker,
   * für die kein verbliebenes Gerät bürgt (`M.buried`). Nur ein älterer Kopf wird abgewiesen (8557: neuer Scope).
   */
  private foldSignerRevision(r: M.Relationship, t: M.Tuple, p: { revision: number; keys: M.ListedKey[]; writer: string; tombstones?: string[] }): boolean {
    if (r.view && r.view.scope !== t.id && t.record < M.tuple(this.state, r.view.scope).record) return false // älterer Kopf
    const same = r.view && r.view.scope === t.id ? r.view : null
    const held = M.own(same?.writers, p.writer)
    const whole = (ks: M.ListedKey[]) => M.canonical([...ks].sort((a, b) => a.anchor.localeCompare(b.anchor)))
    const tombs = [...new Set(p.tombstones ?? [])].sort()
    const newTombs = tombs.some((a) => !(M.own(same?.tombstones, a) ?? []).includes(p.writer))
    if (held && p.revision === held.revision && whole(p.keys) === whole(held.keys) && !newTombs) return true // Wiederholung
    this.emit({ kind: 'view', rel: r.id, scope: t.id, revision: p.revision, keys: p.keys, writer: p.writer, standing: 'person', tombstones: tombs })
    return true
  }

  // ── Sicht ──
  projection(): M.Projection {
    return M.project(this.state, this.clock.now())
  }
  relationshipWith(peerAnchors: string[]): M.Relationship | undefined {
    return this.state.relationships.find((r) => !r.departed && r.tuples.some((t) => peerAnchors.includes(t.peer)))
  }
}
