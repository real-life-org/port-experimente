// E15 Mehrgerät: das Sollmodell als kleiner Zustandsautomat.
//
// Vereinfacht auf das, was die Szenarien X1–X23 brauchen, nach den
// gussreifen Inventaren (rltp/design/trust-0.32-regelinventar-8.md,
// -6a.md, -holder-state.md). Regel-IDs stehen an den Stellen, die sie
// umsetzen. Die unveränderte Lib ist NICHT das Soll (Plan E15, Abschnitt 3).
//
// Form: der Holder-Zustand ist ein Wert; jede Änderung ist eine Operation
// (`Op`), die `apply` deterministisch anwendet. Entscheidungen lesen den
// Zustand und liefern Operationen, nie Nebenwirkungen. So kann K0 die
// Operationen lokal anwenden und K1 sie über ein Journal vereinigen; der
// Zustand ist in beiden Fällen die Faltung der Operationen.
//
// Faltungsregeln (Tor-Review 2 B4, Tor-Review 3 B1/B2): eine Operation
// wird beim Anwenden geklont, nie verändert; sie wirkt ganz oder gar nicht
// (Anwendung auf einem Entwurf, Übernahme nur bei Erfolg); eine fehlende
// Voraussetzung (Beziehung, Akt, Tupel) ist `Missing`, nie eine
// Teilwirkung; Effekte haben eine fachliche Identität (Akt-Id, (Nonce, n),
// Paar), nicht nur eine Operations-ID; eine vereinigte Beziehung bleibt
// über einen Alias erreichbar. Wo zwei Geräte dieselbe Stelle ändern, gilt
// eine ausdrückliche Regel: die Sicht ist monoton in der Revision (8500,
// gleiche Revision mit anderen Schlüsseln = Equivokation 6270), die
// Budgetbestätigung benennt die bestätigten Akte (8515), ein Vorrats-
// Schlüssel heißt (Nonce, n) und ein zweiter Vorrat bleibt sichtbar
// (8435). Entscheidung und Übergabe (K1a Schritt 3, Anton 18.10., Linie
// „weich“: was die Gegenseite schon erreicht hat, gilt; was noch im eigenen
// Haus ist, darf die Faltung umentscheiden): (1) dieselbe Entscheidung von
// zwei Geräten ist eine Wirkung; (2) Zustimmung gegen Ablehnung: ist eine
// eigene Karte eingereicht (8325.0), gilt die Zustimmung und die Ablehnung
// ist ein Konfliktbefund, sonst gilt die Ablehnung und die nicht
// eingereichte Karte wird zurückgenommen (8232.2, 8765); (3) zwei
// Übergaben eines Akts: die kleinere Kennung gewinnt, die andere wird
// zurückgenommen, wenn sie nicht eingereicht ist (`resolveDecision`).

// ── Parameter (Profil, vereinfacht) ──────────────────────────────────────────

import { createHash } from 'node:crypto'
import { anchorOfEd, edRawOfAnchor, fromB64u, xRawOfMk } from '@real-life/trust-protocol'

export const PARAM = {
  /** 8510: zehn Annahmen je Mediatorbeziehung im Fenster. */
  budget: 10,
  /** 8510: P28D. */
  budgetWindowMs: 28 * 24 * 3600 * 1000,
  /** 8485: nachfüllen unter drei, auf fünf. */
  refillBelow: 3,
  refillTo: 5,
  /** 8465: prekey-lifetime = P180D. */
  prekeyLifetimeMs: 180 * 24 * 3600 * 1000,
  /** Akt-Lebensdauer (8110): P7D im Prüfstand. */
  actLifetimeMs: 7 * 24 * 3600 * 1000,
  /** 8155: Consent-Reserve vor dem Ablauf. */
  consentReserveMs: 24 * 3600 * 1000,
  /** act-skew (8110, 8640.2): eine Stunde im Prüfstand. */
  actSkewMs: 3600 * 1000,
  /** key-retention ≥ P90D (8235). */
  keyRetentionMs: 90 * 24 * 3600 * 1000,
} as const

// ── Kennungen ────────────────────────────────────────────────────────────────

/** Operations-ID = Schreiberinkarnation + Zähler (Plan K1a; Astra Befund 5). K0 nutzt sie nur lokal. */
export interface OpId {
  writer: string
  n: number
}
export const opKey = (id: OpId) => `${id.writer}#${id.n}`

export type Anchor = string
export type Rkid = string

// ── Schlüsseltabellen (Tor-Review 28) ────────────────────────────────────────
//
// Regel: keyed tables never carry a prototype; reads use own properties only. Jede Tabelle, deren Schlüssel aus Daten
// kommen (Schreiberkennungen, Beziehungs-Ids, Digests, Köpfe), ist ein Objekt ohne Prototyp (`table`), gelesen über
// `own` (nur eigene Eigenschaften), geschrieben über `put` (eigene Dateneigenschaft, auch für einen Namen wie
// `__proto__` nie ein Setter). Ein Abbild aus dem Store oder ein Klon (`structuredClone`, JSON) erhält wieder Objekte
// mit Prototyp; `fromJson` baut die Tabellen des Zustands neu ohne Prototyp auf, `cloneState` klont und baut neu. So ist
// die Klasse „ein String aus dem Journal trifft eine geerbte Eigenschaft“ durch Bauart geschlossen; die Formtabelle
// weist zusätzlich reservierte Namen und Kennungen außerhalb ihrer Grammatik ab (`RESERVED`, `GRAMMAR`).
export type Table<T> = Record<string, T>
/** Eine Schlüsseltabelle ohne Prototyp, optional aus Einträgen. */
export function table<T>(entries?: Iterable<[string, T]>): Table<T> {
  const t = Object.create(null) as Table<T>
  if (entries) for (const [k, v] of entries) put(t, k, v)
  return t
}
/** Lesen nur über eigene Eigenschaften (nie geerbt). */
export const own = <T>(t: Table<T> | null | undefined, k: string): T | undefined => (t != null && Object.hasOwn(t, k) ? t[k] : undefined)
/** Schreiben als eigene Dateneigenschaft (kein Setter, auch nicht `__proto__`). */
export function put<T>(t: Table<T>, k: string, v: T): void {
  Object.defineProperty(t, k, { value: v, writable: true, enumerable: true, configurable: true })
}
/** Kopie einer Tabelle ohne Prototyp (eigene Einträge). */
export const tableOf = <T>(t: Table<T> | null | undefined): Table<T> => table(t == null ? [] : Object.entries(t))

// ── Zustand ──────────────────────────────────────────────────────────────────

/** Ein Tupel: ein Paar (eigener Anker, Gegenanker) mit den Paar-Schlüsseln (privat nur als Kontextname, die Bytes hält der Schlüsseldienst). */
export interface Tuple {
  id: string
  own: Anchor
  ownKey: string // Kontextname des eigenen Paar-Schlüssels (Ableitung beim Kandidaten)
  peer: Anchor
  peerKeyAgreement: string // rkid der Gegenseite
  /** Record-Anker für die Kopfwahl (2280): der Kopf ist das Maximum. */
  record: string
  openedAt: string
  /** 6730: eingefrorene Kandidatenliste bei der Öffnung (Gegenanker aller damals gehaltenen Beziehungen). */
  candidates: Anchor[]
  deactivated: boolean
}

export type StockState = 'allocated' | 'registered' | 'active' | 'aging' | 'consumed' | 'withdrawn' | 'tombstoned'

/** 8475: eigener Vorrats-Schlüssel (Aussteller); Identität (Nonce, n) (8435, 8445). */
export interface StockKey {
  n: number
  nonce: string
  anchor: Anchor
  keyAgreement: string // rkid
  key: string // Kontextname (Ableitung beim Kandidaten)
  expiresAt: string
  state: StockState
  /** K2 Schritt 2: das Gerät, das den Schlüssel zugeteilt hat (nur es erzeugt die Karte, E2 (iv); Anteil je Gerät). Ohne Feld (K0, K1a): die Person. */
  by?: string
  /** K2 step 2b.1: the M device (its anchor in this relationship) the key is assigned to, immutable (draft 2 §3.2, MV-32). */
  for?: Anchor
  /** K2 step 2b.1: the allocator's incarnation tag in this relationship (`stock-revision@2` lists a key only under it). */
  inc?: string
}

export type ListedKey = { n: number; anchor: Anchor; keyAgreement: string; expiresAt: string }
/** A key of M's usable view: with `stock-revision@2` (K2 step 2b.1) it carries the M device it is assigned to. */
export type ViewKey = ListedKey & { for?: Anchor }

/**
 * K2 step 2b.1 (core draft 4 §3.1, [Vertrag]): one listed stock key of `stock-revision@2`, with the public signing part and
 * the proof of possession (`proof`, §3.2) over its immutable assignment.
 */
export interface RevKey {
  n: number
  nonce: string
  anchor: Anchor
  /** Public Ed25519 part of the stock key, base64url (32 bytes); `anchor = anchorOfEd(signing)`. */
  signing: string
  keyAgreement: string
  expiresAt: string
  /** The M device (its anchor in this relationship) the key is assigned to. */
  for: Anchor
  /** Ed25519 signature of the stock key over `proofContent` (64 bytes, base64url). */
  proof: string
}
/**
 * K2 step 2b.1: `stock-revision@2` (core draft 4 §3.1): the complete listing of one writer incarnation, the withdrawals of its
 * own anchors, the tombstones (`bury`, only with `classOff`, any anchor of the person, B6) and burnt incarnations (format
 * only in the core). Canonical: lists sorted (`keys` by anchor, `withdraw`/`bury` by anchor, `burn` by inc), optional fields
 * left out; two revisions are the same iff their JCS bytes are (`canonical`).
 */
export interface StockRevision {
  writer: string
  inc: string
  rev: number
  keys: RevKey[]
  withdraw: Anchor[]
  bury: Anchor[]
  burn: string[]
  classOff?: true
}

export interface StockView {
  scope: string
  revision: number
  /**
   * Die gelisteten Schlüssel mit ihrer Nummer (8445), wie die Faltung sie festhält (mit Schreibern: `viewKeys` ohne Wissen
   * über Widerrufe). Entscheidungen lesen nie dieses Feld, sondern `usableView` (Review 36 B7: eine Rechnung für Ms Sicht).
   */
  keys: ListedKey[]
  /**
   * K1a Schritt 4 (Anton 18.10., 3a): je pseudonymer Schreiberkennung die jüngste Revision dieses Schreibers im Scope.
   * Nummern sind je Schreiber monoton (6270 je Schreiber); ohne Feld (K0) gibt es einen Schreiber wie vorher.
   */
  writers?: Record<string, { revision: number; keys: ListedKey[] }>
  /**
   * Leere Revision bei Klasse aus (8535, 8475.S6) gilt über alle Schreiber: je Schreiber die höchste Revision, die eine
   * angenommene leere Revision (irgendeines Schreibers) aufgehoben hat. Ein Schreiber zählt zur Vereinigung nur mit einer
   * Revision darüber. Verband (Maximum je Schreiber): in jeder Faltungsreihenfolge dasselbe.
   */
  clears?: Record<string, number>
  /**
   * K2 step 2b.1: every folded `stock-revision@2` of this scope (MV-31: each folded revision is kept), canonical and without
   * duplicates. Bindings, conflict marks, withdrawals, tombstones, equivocation, the current listing and the class state are
   * functions of this set (`allocation`), never of the arrival order. Without the field (K0, K1a): the fields above.
   */
  revs?: StockRevision[]
}

/** Beziehung je Holder (eine je Gegenüber, 6975.5: Zusammenhangskomponente der Herkunftskanten). */
export interface Relationship {
  id: string
  tuples: Tuple[]
  provenance: 'encounter' | 'introduction'
  vouchedBy: string[]
  /** Klasse „darf mich vorstellen“ an diesen Kontakt (Aussteller). */
  classOn: boolean
  /** Vorrat (Aussteller gegenüber einem Mediator). */
  stock: StockKey[]
  nonce: string | null // Einführungs-Nonce (8430), base64
  nextN: number // 8445
  revision: number // 8500: höchste Revisionsnummer im Zustand
  /**
   * K1a Schritt 4: je eigener Schreiberkennung die höchste Revision im Zustand (8500 je Schreiber) und ob sie leer war
   * (Klasse aus, 8535). Ohne Feld (K0) zählt `revision` allein.
   */
  writers?: Record<string, { revision: number; empty: boolean }>
  /** 8510: Annahmen (Akt-Id, Zeit); die Bestätigung benennt die bestätigten Akte (8515). */
  accepted: Array<{ act: string; at: string }>
  confirmed: string[]
  confirmedAt: string | null
  departed: boolean
  /** Ms Sicht auf den Vorrat dieser Seite (8550 ff.); Marken 8570 holderweit in `consumed`. */
  view: StockView | null
}

export type ActState = 'offered' | 'declined' | 'consented' | 'connected' | 'expired'
/** 8326, vereinfacht: ohne Abfrage des Adapters; `cancelled` nach 8326.8/8232.2 (K1a Schritt 3: eine nie beim Träger angekommene Übergabe, lokal abgegrenzt). */
export type HandOver = 'none' | 'intent' | 'handed' | 'taken' | 'delivered' | 'given-up' | 'cancelled'
/** 8325.0: „the own card counts as submitted exactly at O ∈ {`taken`, `delivered`, `given-up`}“. */
export const SUBMITTED: ReadonlySet<HandOver> = new Set(['taken', 'delivered', 'given-up'])

export interface Card {
  anchor: Anchor
  keyAgreement: string
}

/** 8325: Akt je Seite. */
export interface Act {
  id: string
  mediator: string // Beziehungs-Id zu M (Alias-auflösbar)
  own: Anchor // eigener Vorrats-Schlüssel des Akts (8640.5)
  voucher: { anchor: Anchor; keyAgreement: string; name: string }
  issuedAt: string
  expiresAt: string
  state: ActState
  /** P: wartende Gegenkarte. */
  pending: Card | null
  /** V: Vergleichsdigest der ersten Gegenkarte (8910.0). */
  v: string | null
  /** K: Konfliktmarke (8910.8). */
  k: boolean
  /** Eigene frische Karte (8727) und ihr Übergabezustand O (8326). */
  ownCard: Card | null
  ownCardKey: string | null
  o: HandOver
  /** Digest des eigenen Kartendokuments (die Kennung der Übergabe); bei zwei Übergaben eines Akts die gewinnende (Regel 3). */
  ownCardDigest: string | null
  /** Beziehung, die 8905 geöffnet hat. */
  opened: string | null
  /**
   * K1a Schritt 3: Faltungsgedächtnis des Akts (nicht in der Projektion). `decisions`: jede Zustimmung und Ablehnung mit
   * Operations-Id, auch von anderen Geräten der Person; daraus folgt der Hauptzustand (`resolveDecision`). `cards`: O je
   * Übergabe (Digest des Kartendokuments), damit zwei Übergaben eines Akts einander nicht überschreiben; `o` ist daraus
   * abgeleitet. Ohne Felder (K0, ein Gerät) verhält sich der Akt wie vorher.
   */
  decisions?: Array<{ kind: 'consent' | 'decline'; op: string; at: string }>
  cards?: Record<string, HandOver>
  consentOp?: string
  /** K2 Schritt 2: die Kartenidentität (Nutzlastdigest über {act, card}, wie V bei der Gegenseite, 8910.0); eine Karte je Akt (E2 (iv)). */
  ownCardV?: string
}

/**
 * K2 Schritt 2: ein Mitgliedschaftsnachweis in einer Gerätemenge (`device-set@1`). `admit`: `by` nimmt den Geräteschlüssel
 * `anchor` (mit `keyAgreement`) in die Menge der Wurzel `root` auf; `revoke`: `by` widerruft `anchor` (endgültig). Jeder
 * Eintrag ist von `by` signiert (DI); die Wurzel ist der Anker, den die Gegenseite zuerst für diese Beziehung geprüft hat
 * (Begegnung: der Anker aus dem QR; Vorstellung: der Kartenanker, den der Voucher-Schlüssel signiert).
 */
export interface SetCert {
  root: Anchor
  kind: 'admit' | 'revoke'
  anchor: Anchor
  keyAgreement: string | null
  by: Anchor
  proof: { type: string; cryptosuite: string; created: string; verificationMethod: string; proofPurpose: string; proofValue: string }
}
/**
 * K2 Schritt 2: was ein Gerät über eine Gerätemenge weiß (eigene und fremde gleich): die Nachweise (Zwei-Phasen-Menge,
 * beide Teile wachsen nur), je Signierer die jüngste Revision (6270: nur Wiederholung und Equivokation), die gesehenen
 * Revisionsdigests (Mengenbezug der Karte) und, nur bei eigenen Mengen, welcher Anker zu welchem eigenen Gerät gehört.
 */
export interface DeviceSet {
  root: Anchor
  rootKeyAgreement: string
  certs: Record<string, SetCert>
  revs: Record<string, { n: number; digest: string | null; covered?: string[] }>
  /**
   * Revisionen, die dieses Gerät kennt: selbst empfangen oder durch die signierten `deps` einer gefalteten kumulativen
   * Revision gedeckt (Review 33 B2: der Kartenbezug löst gegen den gefalteten Stand, nicht gegen eine exakt gesehene Revision).
   */
  seen: string[]
  local?: Record<string, string>
  /** Review 33 B1: je Nachweisschlüssel mit widersprüchlichem Inhalt alle gesehenen Fassungen (kanonisch sortiert) für den Befund; der Zustand trägt die kanonisch kleinste. */
  equivocal?: Record<string, SetCert[]>
}
/** K2 Schritt 2: ein öffentlicher Geräteschlüssel aus dem Vorrat eines Geräts, den das Schwestergerät `for` einer neuen Beziehung zuweisen darf. */
export interface PoolKey {
  i: number
  for: string
  anchor: Anchor
  keyAgreement: string
  used: string | null
}
export const certKey = (c: Pick<SetCert, 'kind' | 'anchor' | 'by'>) => `${c.kind}|${c.anchor}|${c.by}`
/**
 * Die Menge aus den Nachweisen (rein, reihenfolgeunabhängig): zugelassen ist die Wurzel und jeder Anker, dessen Zulassung
 * über eine Kette signierter Zulassungen bis zur Wurzel reicht (`ever`); widerrufen ist jeder Anker mit einem Widerruf
 * eines je zugelassenen Ausstellers (endgültig, eine alte Liste bringt ihn nicht zurück); Mitglieder = zugelassen ohne
 * widerrufen, kanonisch nach Anker.
 */
export function setView(set: DeviceSet | undefined): { members: Array<{ anchor: Anchor; keyAgreement: string }>; revoked: Set<Anchor>; ever: Set<Anchor> } {
  if (!set) return { members: [], revoked: new Set(), ever: new Set() }
  const certs = Object.values(set.certs).sort((a, b) => certKey(a).localeCompare(certKey(b)))
  const ever = new Set<Anchor>([set.root])
  const ka = new Map<Anchor, string>([[set.root, set.rootKeyAgreement]])
  for (let grew = true; grew; ) {
    grew = false
    for (const c of certs) {
      if (c.kind !== 'admit' || !ever.has(c.by) || ever.has(c.anchor) || !c.keyAgreement) continue
      ever.add(c.anchor)
      ka.set(c.anchor, c.keyAgreement)
      grew = true
    }
  }
  const revoked = new Set(certs.filter((c) => c.kind === 'revoke' && ever.has(c.by)).map((c) => c.anchor))
  const members = [...ever].filter((a) => !revoked.has(a)).sort().map((anchor) => ({ anchor, keyAgreement: ka.get(anchor)! }))
  return { members, revoked, ever }
}

/** Ms Akt: nur Produktionsabsicht und Marken (8630). */
export interface MediatorAct {
  id: string
  a: { rel: string; key: Anchor; keyAgreement: string }
  b: { rel: string; key: Anchor; keyAgreement: string }
  issuedAt: string
  expiresAt: string
  /**
   * K2 step 2b.2 (core draft 4 §5.1, draft 3 §1.1 (3a), decision 11): acceptance knowledge per side, the digest of the
   * side's receipt for its ticket; set only by `ticket-ack@1` (written by the issuer, folded by its siblings). Absent = unknown.
   */
  known?: { a?: string; b?: string }
  /** K2 step 2b.2 (Opus-Review 54 B1): the issuing M device (its name), set by the issuer under the automaton; only it may write `ticket-ack`. */
  by?: string
}

/** 6845: eigene Mapping-Pflicht je Tupelpaar. */
export interface PairDuty {
  pair: [string, string] // Tupel-Ids, sortiert
  state: 'none' | 'hit' | 'sent' | 'united' | 'moot'
  mappingDigest: string | null
}

/**
 * Effekt-Ledger (Tor-Review 2, B5): jede endgültige Wirkung mit fachlicher
 * Identität, damit „doppelte endgültige Wirkung“ über alle Geräte einer
 * Person einheitlich gezählt werden kann: gleiche Effekt-Id aus
 * verschiedenen Operationen = Doppel; widersprüchliche Ids (consent und
 * decline desselben Akts) = Widerspruch.
 */
export interface Effect {
  id: string
  op: string // Operations-ID, die den Effekt erzeugt hat
  at: string
}

export interface HolderState {
  person: string
  relationships: Relationship[]
  /** Alias: Beziehungs-Id eines vereinigten Teils → Id der vereinigten Beziehung (6975.2, 2100). */
  aliases: Record<string, string>
  acts: Act[]
  mediatorActs: MediatorAct[]
  /** 8570.2 / 8562: holderweite Marken des Mediators (verbrauchte Vorrats-Anker). */
  consumed: Anchor[]
  /** 8287: holderweite Zuordnung Voucher → Akt (Seite). */
  voucherAssigned: Array<{ anchor: Anchor; act: string }>
  duties: PairDuty[]
  /** Verifizierte Herkunftskanten (2282): Paare eigener Tupel. */
  edges: Array<[string, string]>
  effects: Effect[]
  /** Protokoll fachlicher Befunde (8640.12 Konformitätsfehler des Mediators u. a.). */
  findings: string[]
  /** Angewandte Operationen (für Idempotenz und Journal). */
  applied: string[]
  /** K2 Schritt 2: Gerätemengen je Wurzelanker, eigene und die der Gegenseiten (nur aus Nachweisen). Ohne Feld (K0, K1a): keine. */
  sets?: Record<string, DeviceSet>
  /** K2 Schritt 2: öffentliche Geräteschlüssel je eigenem Gerät, die ein Schwestergerät einer neuen Beziehung zuweisen kann. */
  pools?: Record<string, PoolKey[]>
}

export function emptyState(person: string): HolderState {
  return { person, relationships: [], aliases: table(), acts: [], mediatorActs: [], consumed: [], voucherAssigned: [], duties: [], edges: [], effects: [], findings: [], applied: [] }
}

/**
 * Zustand aus einem Abbild (Store, Klon, JSON): die Schlüsseltabellen (`aliases`, `writers` je Beziehung, `writers` und
 * `clears` der Sicht, `cards` je Akt) werden ohne Prototyp neu aufgebaut. Verändert und liefert `s`.
 */
export function fromJson(s: HolderState): HolderState {
  s.aliases = tableOf(s.aliases)
  for (const r of s.relationships) {
    if (r.writers) r.writers = tableOf(r.writers)
    if (r.view?.writers) r.view.writers = tableOf(r.view.writers)
    if (r.view?.clears) r.view.clears = tableOf(r.view.clears)
  }
  for (const a of s.acts) if (a.cards) a.cards = tableOf(a.cards)
  if (s.sets) {
    s.sets = tableOf(s.sets)
    for (const set of Object.values(s.sets)) {
      set.certs = tableOf(set.certs)
      set.revs = tableOf(set.revs)
      if (set.local) set.local = tableOf(set.local)
      if (set.equivocal) set.equivocal = tableOf(set.equivocal)
    }
  }
  if (s.pools) s.pools = tableOf(s.pools)
  return s
}
/** Tiefer Klon des Zustands mit Tabellen ohne Prototyp. */
export const cloneState = (s: HolderState): HolderState => fromJson(structuredClone(s))

// ── Operationen ──────────────────────────────────────────────────────────────

export type Op = { id: OpId; at: string } & (
  | { kind: 'open-tuple'; rel: string | null; tuple: Tuple; provenance: 'encounter' | 'introduction'; vouchedBy: string | null; act: string | null }
  | { kind: 'class'; rel: string; on: boolean }
  | { kind: 'depart'; rel: string }
  | { kind: 'allocate'; rel: string; nonce: string; keys: StockKey[] } // 8445, 8475.S1–S3 in einem Schritt (Registrierung im Prüfstand sofort)
  | { kind: 'revision'; rel: string; revision: number; keys: ListedKey[]; writer?: string; inc?: string; classOff?: boolean } // 8500, je Schreiber (Schritt 4); K2 2b.1: je (Schreiber, Inkarnation), mit Klassenwert
  | { kind: 'retire'; rel: string; anchors: Anchor[] } // K2 2b.1: 8475.S8, eigener Schlüssel nach expiresAt + key-retention
  | { kind: 'withdraw'; rel: string; anchors: Anchor[] } // 8475.S6
  | { kind: 'age'; rel: string; anchors: Anchor[] } // 8475.S5
  | { kind: 'view'; rel: string; scope: string; revision: number; keys: ListedKey[]; writer?: string; clears?: Record<string, number> } // M: 8557/6270, je Schreiber (Schritt 4)
  | { kind: 'stock-revision'; rel: string; scope: string; revision: StockRevision } // M, K2 2b.1: a form-checked `stock-revision@2` (core draft 4 §3)
  | { kind: 'introduce'; act: MediatorAct } // M: 8605, 8570.2
  | { kind: 'ticket-ack'; act: string; side: 'a' | 'b'; receiptDigest: string } // M, K2 2b.2: `ticket-ack@1`, the side's receipt for its ticket (acceptance knowledge)
  | { kind: 'ticket-accept'; act: Act } // 8640.14
  | { kind: 'ticket-refuse-budget'; rel: string; own: Anchor } // 8640.13
  | { kind: 'finding'; text: string }
  | { kind: 'consent'; act: string; card: Card | null; cardKey: string | null } // 8325.A4; K2 Schritt 2: ohne Karte auf einem Gerät, das den Vorrats-Schlüssel nicht zugeteilt hat (E2 (iv))
  | { kind: 'produce'; act: string; card: Card; cardKey: string; v: string } // K2 Schritt 2: das zuteilende Gerät erzeugt die eine Karte (8727, E2 (iv))
  | { kind: 'device-set'; root: string; rootKeyAgreement: string; certs: SetCert[]; local?: Record<string, string>; rev?: { signer: string; n: number; digest: string | null; covered?: string[] }; seen?: string; deps?: string[] } // K2 Schritt 2: device-set@1; `deps` die signierten Vorgänger einer empfangenen Revision (Review 33 B2)
  | { kind: 'pool'; device: string; keys: Array<{ i: number; for: string; anchor: Anchor; keyAgreement: string }> } // K2 Schritt 2
  | { kind: 'pool-use'; device: string; i: number; root: string; ctx: string } // K2 Schritt 2: Schlüssel `i` des Vorrats von `device` ist dessen Schlüssel für den Kontext `ctx` der Wurzel `root`
  | { kind: 'decline'; act: string } // 8325.A3
  | { kind: 'hand-over'; act: string; o: HandOver; digest?: string } // 8326
  | { kind: 'card-pending'; act: string; card: Card; v: string } // 8910.4
  | { kind: 'card-refused'; act: string; v: string; k: boolean } // 8910.6, 8910.8
  | { kind: 'connect'; act: string; rel: string; tuple: Tuple } // 8905
  | { kind: 'expire'; act: string } // 8325.A7/A8
  | { kind: 'budget-confirm'; rel: string; acts: string[] } // 8515: die bestätigten Annahmen
  | { kind: 'duty'; pair: [string, string]; state: PairDuty['state']; mappingDigest: string | null } // 6845
  | { kind: 'union'; a: string; b: string; edge: [string, string] } // 6975.2
  | { kind: 'edge'; edge: [string, string] } // 6975.3
)

/**
 * Eingangsvertrag der Faltung (Tor-Review 26 B2, Tor-Review 27 B2a): die Form jeder Operation, bis in jeden Wert, der
 * Zustand wird. Eine Tabelle von Formen (`Shape`), verschachtelt; dieselbe Prüfung gilt für beide Journalpfade (Ablage
 * und Briefkasten: `batchProblem` im Kandidaten, `transactionProblem` im Holder). Was nicht passt, ist ein Befund, nie
 * Zustand. Grundformen: `string`; `boolean`; `nat` = ganze Zahl ≥ 0; `time` = Zeitstempel als String, den `Date.parse`
 * lesen kann (Zahlen nie NaN oder unendlich); `base64` = streng (Länge, Alphabet, Auffüllung: der Rundlauf ergibt
 * denselben String); `digest` = Dokumentdigest des Prüfstands. Zusammengesetzt: `enum`, `array` (jedes Element), `tuple` (feste Länge), `object` (genau diese
 * Felder, keine weiteren), `record` (jeder Wert; jeder Schlüssel nach `key`, ohne Angabe `ident`). `nullable` = vorhanden,
 * Wert oder null; `optional` = darf fehlen.
 * Kennungen (Tor-Review 28): jede Kennung und jeder Tabellenschlüssel hat eine Grammatik (`GRAMMAR`), und kein reservierter
 * Name (`RESERVED`: die Eigenschaften von `Object.prototype` wie `__proto__`, `constructor`, `toString`, dazu `prototype`)
 * ist je eine Kennung oder ein Schlüssel, in keiner Tiefe. `ident` = allgemeine Kennung des Prüfstands (Beziehungs-,
 * Tupel-, Akt-Ids, Anker, rkids, Kontextnamen: Buchstabe oder Ziffer, dann Buchstaben, Ziffern und `._:@#+/=~-`, höchstens
 * 512 Zeichen); `tag` = Schreiberkennung (base64url von 12 Bytes, 16 Zeichen); `writer` = Schreiberinkarnation
 * `<Gerät>@<Inkarnation>`; `opWriter` = Schreiber einer Operation (`writer`, im Konfliktbefund mit `#conflict`); `dep` =
 * Batchschlüssel `<writer>#<n>`. Rückgabe von `shapeProblem`: null oder der Pfad, der nicht stimmt.
 */
export type Shape =
  | 'string'
  | 'boolean'
  | 'nat'
  | 'time'
  | 'base64'
  | 'digest'
  | 'ident'
  | 'tag'
  | 'writer'
  | 'opWriter'
  | 'dep'
  | { enum: readonly string[] }
  /** K2 2b.1: base64url (no padding) of exactly this many bytes, round trip equal. */
  | { b64u: number }
  | { array: Shape }
  | { tuple: readonly Shape[] }
  | { object: { readonly [field: string]: Shape } }
  | { record: Shape; key?: Shape }
  | { nullable: Shape }
  | { optional: Shape }
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
/** Strenges base64 (Review 27 B2a): nur Alphabet und Auffüllung an der richtigen Stelle, Länge ein Vielfaches von 4, der Rundlauf ergibt denselben String. */
export const isBase64 = (x: unknown): x is string => typeof x === 'string' && x.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(x) && Buffer.from(x, 'base64').toString('base64') === x
/** Dokumentdigest wie im Prüfstand (`digestBytes`): multibase base64url (`u`) eines sha2-256-Multihash (34 Bytes, Präfix 0x12 0x20). */
export const isDigest = (x: unknown): x is string => typeof x === 'string' && /^uEi[A-D][A-Za-z0-9_-]{43}$/.test(x)
/** Reservierte Namen (Tor-Review 28): nie Kennung, nie Tabellenschlüssel. */
export const RESERVED: ReadonlySet<string> = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype'])
const NAME = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}'
/** Grammatik der Kennungen (Tor-Review 28), siehe `Shape`. */
export const GRAMMAR = {
  ident: /^[A-Za-z0-9][A-Za-z0-9._:@#+/=~-]{0,511}$/,
  tag: /^[A-Za-z0-9_-]{16}$/,
  writer: new RegExp(`^${NAME}@${NAME}$`),
  opWriter: new RegExp(`^${NAME}@${NAME}(#conflict)?$`),
  dep: new RegExp(`^${NAME}@${NAME}#[1-9][0-9]{0,15}$`),
} as const
const isName = (x: unknown, g: RegExp): x is string => typeof x === 'string' && g.test(x) && !RESERVED.has(x)
export function shapeProblem(x: unknown, s: Shape, path: string): string | null {
  if (typeof s === 'string') {
    if (s === 'string') return typeof x === 'string' ? null : path
    if (s === 'boolean') return typeof x === 'boolean' ? null : path
    if (s === 'nat') return Number.isSafeInteger(x) && (x as number) >= 0 ? null : path
    if (s === 'time') return typeof x === 'string' && Number.isFinite(Date.parse(x)) ? null : path
    if (s === 'base64') return isBase64(x) ? null : path
    if (s === 'digest') return isDigest(x) ? null : path
    return isName(x, GRAMMAR[s]) ? null : path
  }
  if ('enum' in s) return typeof x === 'string' && s.enum.includes(x) ? null : path
  if ('b64u' in s) return typeof x === 'string' && /^[A-Za-z0-9_-]*$/.test(x) && Buffer.from(x, 'base64url').length === s.b64u && Buffer.from(x, 'base64url').toString('base64url') === x ? null : path
  if ('nullable' in s) return x === null ? null : shapeProblem(x, s.nullable, path)
  if ('optional' in s) return x === undefined ? null : shapeProblem(x, s.optional, path)
  if ('array' in s) {
    if (!Array.isArray(x)) return path
    for (let i = 0; i < x.length; i++) {
      const p = shapeProblem(x[i], s.array, `${path}[${i}]`)
      if (p) return p
    }
    return null
  }
  if ('tuple' in s) {
    if (!Array.isArray(x) || x.length !== s.tuple.length) return path
    for (let i = 0; i < x.length; i++) {
      const p = shapeProblem(x[i], s.tuple[i]!, `${path}[${i}]`)
      if (p) return p
    }
    return null
  }
  if (!isObj(x)) return path
  if ('record' in s) {
    for (const [k, v] of Object.entries(x)) {
      if (shapeProblem(k, s.key ?? 'ident', path) || RESERVED.has(k)) return `${path}[${JSON.stringify(k)}]`
      const p = shapeProblem(v, s.record, `${path}.${k}`)
      if (p) return p
    }
    return null
  }
  for (const k of Object.keys(x)) if (!Object.hasOwn(s.object, k)) return `${path}.${k}`
  for (const [k, f] of Object.entries(s.object)) {
    const p = shapeProblem(Object.hasOwn(x, k) ? x[k] : undefined, f, `${path}.${k}`)
    if (p) return p
  }
  return null
}

const str = 'string' as const
const id = 'ident' as const
const pair: Shape = { tuple: [id, id] }
const handOver: Shape = { enum: ['none', 'intent', 'handed', 'taken', 'delivered', 'given-up', 'cancelled'] satisfies HandOver[] }
/** Die Formen der Werte, die Zustand werden (Review 27 B2a), nach den Typen oben; Kennungen nach ihrer Grammatik (Review 28). */
export const SHAPES = {
  tuple: { object: { id, own: id, ownKey: id, peer: id, peerKeyAgreement: id, record: id, openedAt: 'time', candidates: { array: id }, deactivated: 'boolean' } },
  stockKey: {
    object: { n: 'nat', nonce: 'base64', anchor: id, keyAgreement: id, key: id, expiresAt: 'time', state: { enum: ['allocated', 'registered', 'active', 'aging', 'consumed', 'withdrawn', 'tombstoned'] satisfies StockState[] }, by: { optional: id }, for: { optional: id }, inc: { optional: 'tag' } },
  },
  listedKey: { object: { n: 'nat', anchor: id, keyAgreement: id, expiresAt: 'time' } },
  revKey: { object: { n: 'nat', nonce: 'base64', anchor: id, signing: { b64u: 32 }, keyAgreement: id, expiresAt: 'time', for: id, proof: { b64u: 64 } } },
  stockRevision: {
    object: {
      writer: 'tag',
      inc: 'tag',
      rev: 'nat',
      keys: { array: { object: { n: 'nat', nonce: 'base64', anchor: id, signing: { b64u: 32 }, keyAgreement: id, expiresAt: 'time', for: id, proof: { b64u: 64 } } } },
      withdraw: { array: id },
      bury: { array: id },
      burn: { array: 'tag' },
      classOff: { optional: 'boolean' }, // only `true` is canonical (`revisionFormProblem`)
    },
  },
  card: { object: { anchor: id, keyAgreement: id } },
  cert: {
    object: {
      root: id,
      kind: { enum: ['admit', 'revoke'] },
      anchor: id,
      keyAgreement: { nullable: id },
      by: id,
      proof: { object: { type: str, cryptosuite: str, created: 'time', verificationMethod: str, proofPurpose: str, proofValue: str } },
    },
  },
  act: {
    object: {
      id,
      mediator: id,
      own: id,
      voucher: { object: { anchor: id, keyAgreement: id, name: str } },
      issuedAt: 'time',
      expiresAt: 'time',
      state: { enum: ['offered', 'declined', 'consented', 'connected', 'expired'] satisfies ActState[] },
      pending: { nullable: { object: { anchor: id, keyAgreement: id } } },
      v: { nullable: str },
      k: 'boolean',
      ownCard: { nullable: { object: { anchor: id, keyAgreement: id } } },
      ownCardKey: { nullable: id },
      o: handOver,
      ownCardDigest: { nullable: 'digest' },
      opened: { nullable: id },
      ownCardV: { optional: str },
      decisions: { optional: { array: { object: { kind: { enum: ['consent', 'decline'] }, op: id, at: 'time' } } } },
      cards: { optional: { record: handOver, key: 'digest' } },
      consentOp: { optional: id },
    },
  },
  mediatorAct: {
    object: { id, a: { object: { rel: id, key: id, keyAgreement: id } }, b: { object: { rel: id, key: id, keyAgreement: id } }, issuedAt: 'time', expiresAt: 'time', known: { optional: { object: { a: { optional: 'digest' }, b: { optional: 'digest' } } } }, by: { optional: id } },
  },
} satisfies Record<string, Shape>
/**
 * Formtabelle der empfangenen Dokumente (MV-24, Tor-Review 40 B1): die Nutzlast eines Kontakts wird vor jedem Feldzugriff
 * gegen ihre Form geprüft; ein unvollständiges oder überzähliges Dokument ist ein Formfehler (Befund, keine Quittung, keine
 * Wirkung), nie eine Ausnahme in der Runde. Felder wie beim Versand (`sendRevision`, `handOverCard`); `clears` und `writer`
 * bleiben in der Form, ihre Bedeutung prüft der Empfangszweig (K2: Formfehler mit eigenem Befund).
 */
export const DOC_SHAPES = {
  revision: { object: { revision: 'nat', keys: { array: SHAPES.listedKey }, writer: { optional: 'tag' }, clears: { optional: { record: 'nat', key: 'tag' } } } },
  stockRevision: SHAPES.stockRevision,
  card: { object: { act: id, expiresAt: 'time', from: id, fromKeyAgreement: { optional: id }, to: id, card: SHAPES.card, set: { optional: str } } },
  /** K2 step 2b.2 (MV-24): the ticket as `introduce` sends it (`TicketPayload` in the holder). */
  ticket: { object: { act: id, issuedAt: 'time', expiresAt: 'time', own: id, voucher: { object: { anchor: id, keyAgreement: id, name: str } } } },
} satisfies Record<string, Shape>
/** Je Art die Felder neben `id`, `at`, `kind` (Review 26 B2: bekannte Art; Review 27 B2a: jedes Feld bis in die Elemente; Review 28: Kennungen). */
const OP_FIELDS: { [K in Op['kind']]: { [field: string]: Shape } } = {
  'open-tuple': { rel: { nullable: id }, tuple: SHAPES.tuple, provenance: { enum: ['encounter', 'introduction'] }, vouchedBy: { nullable: id }, act: { nullable: id } },
  class: { rel: id, on: 'boolean' },
  depart: { rel: id },
  allocate: { rel: id, nonce: 'base64', keys: { array: SHAPES.stockKey } },
  revision: { rel: id, revision: 'nat', keys: { array: SHAPES.listedKey }, writer: { optional: 'tag' }, inc: { optional: 'tag' }, classOff: { optional: 'boolean' } },
  retire: { rel: id, anchors: { array: id } },
  withdraw: { rel: id, anchors: { array: id } },
  age: { rel: id, anchors: { array: id } },
  view: { rel: id, scope: id, revision: 'nat', keys: { array: SHAPES.listedKey }, writer: { optional: 'tag' }, clears: { optional: { record: 'nat', key: 'tag' } } },
  'stock-revision': { rel: id, scope: id, revision: SHAPES.stockRevision },
  introduce: { act: SHAPES.mediatorAct },
  'ticket-ack': { act: id, side: { enum: ['a', 'b'] }, receiptDigest: 'digest' },
  'ticket-accept': { act: SHAPES.act },
  'ticket-refuse-budget': { rel: id, own: id },
  finding: { text: str },
  consent: { act: id, card: { nullable: SHAPES.card }, cardKey: { nullable: id } },
  produce: { act: id, card: SHAPES.card, cardKey: id, v: str },
  'device-set': { root: id, rootKeyAgreement: id, certs: { array: SHAPES.cert }, local: { optional: { record: id } }, rev: { optional: { object: { signer: 'tag', n: 'nat', digest: { nullable: 'digest' }, covered: { optional: { array: str } } } } }, seen: { optional: 'digest' }, deps: { optional: { array: 'digest' } } },
  pool: { device: id, keys: { array: { object: { i: 'nat', for: id, anchor: id, keyAgreement: id } } } },
  'pool-use': { device: id, i: 'nat', root: id, ctx: id },
  decline: { act: id },
  'hand-over': { act: id, o: handOver, digest: { optional: 'digest' } },
  'card-pending': { act: id, card: SHAPES.card, v: str },
  'card-refused': { act: id, v: str, k: 'boolean' },
  connect: { act: id, rel: id, tuple: SHAPES.tuple },
  expire: { act: id },
  'budget-confirm': { rel: id, acts: { array: id } },
  duty: { pair, state: { enum: ['none', 'hit', 'sent', 'united', 'moot'] satisfies PairDuty['state'][] }, mappingDigest: { nullable: 'digest' } },
  union: { a: id, b: id, edge: pair },
  edge: { edge: pair },
}
const OP_SHAPES: Record<string, Shape> = Object.fromEntries(
  Object.entries(OP_FIELDS).map(([kind, fields]): [string, Shape] => [kind, { object: { id: { object: { writer: 'opWriter', n: 'nat' } }, at: 'time', kind: { enum: [kind] }, ...fields } }]),
)
/** Form einer Operation (Review 26 B2, Review 27 B2a): null oder der Pfad, der nicht stimmt. */
export function opProblem(op: unknown): string | null {
  if (!isObj(op)) return 'op'
  if (typeof op.kind !== 'string' || !Object.hasOwn(OP_SHAPES, op.kind)) return `op.kind(${String(op.kind)})`
  return shapeProblem(op, OP_SHAPES[op.kind]!, `op.${op.kind}`)
}

// ── Hilfen ───────────────────────────────────────────────────────────────────

export const pairKey = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a])

/** Alias-Auflösung (6975.2): die Id eines vereinigten Teils führt zur vereinigten Beziehung. */
export function resolveId(s: HolderState, id: string): string {
  let cur = id
  for (let i = 0, next = own(s.aliases, cur); i < 64 && next; i++, next = own(s.aliases, cur)) cur = next
  return cur
}

export function findRel(s: HolderState, id: string): Relationship | undefined {
  const rid = resolveId(s, id)
  return s.relationships.find((x) => x.id === rid)
}

/** Eine Voraussetzung fehlt im Zustand (Beziehung, Akt, Tupel): ein Journal stellt die Operation zurück, ein Empfang quittiert nicht. */
export class Missing extends Error {
  constructor(
    readonly what: 'relationship' | 'act' | 'tuple' | 'batch' | 'device-set' | 'pool',
    readonly ref: string,
    person: string,
  ) {
    super(`${person}: ${what === 'relationship' ? 'unbekannte Beziehung' : what === 'act' ? 'unbekannter Akt' : what === 'batch' ? 'unbekannter Journal-Vorgänger' : what === 'device-set' ? 'unbekannter Mengennachweis' : what === 'pool' ? 'unbekannter Geräteschlüssel im Vorrat' : 'unbekanntes Tupel'} ${ref}`)
  }
}

export function rel(s: HolderState, id: string): Relationship {
  const r = findRel(s, id)
  if (!r) throw new Missing('relationship', id, s.person)
  return r
}

export function act(s: HolderState, id: string): Act {
  const a = s.acts.find((x) => x.id === id)
  if (!a) throw new Missing('act', id, s.person)
  return a
}

/** 2280: der aktive Kopf ist das Tupel mit dem größten Record-Anker unter den nicht deaktivierten. */
export function head(r: Relationship): Tuple {
  const live = r.tuples.filter((t) => !t.deactivated)
  const pool = live.length ? live : r.tuples
  return pool.reduce((m, t) => (t.record > m.record ? t : m))
}

export function relOfTuple(s: HolderState, tupleId: string): Relationship | undefined {
  return s.relationships.find((r) => r.tuples.some((t) => t.id === tupleId))
}

export function tuple(s: HolderState, tupleId: string): Tuple {
  for (const r of s.relationships) for (const t of r.tuples) if (t.id === tupleId) return t
  throw new Missing('tuple', tupleId, s.person)
}

/** 8470: nutzbar, solange now + act-lifetime + act-skew ≤ expiresAt. */
export const usable = (expiresAt: string, now: string) => Date.parse(now) + PARAM.actLifetimeMs + PARAM.actSkewMs <= Date.parse(expiresAt)

/** 8510: unbestätigte Annahmen im Fenster (die Bestätigung benennt Akte, nicht einen Zeitpunkt oder Zähler: reihenfolgeunabhängig). */
export function budgetUsed(r: Relationship, now: string): number {
  const since = Date.parse(now) - PARAM.budgetWindowMs
  return r.accepted.filter((e) => !r.confirmed.includes(e.act) && Date.parse(e.at) > since).length
}
export const budgetExhausted = (r: Relationship, now: string) => budgetUsed(r, now) >= PARAM.budget

const effect = (s: HolderState, op: Op, id: string) => {
  if (!s.effects.some((e) => e.id === id && e.op === opKey(op.id))) s.effects.push({ id, op: opKey(op.id), at: op.at })
}

/**
 * Eine Wirkung, die zwei Geräte einer Person mit je eigener Operation erreichen können (Regel 1, wie 6230 für die
 * Vereinigung): die Wirkung ist eine, sie trägt in jeder Reihenfolge die kanonisch kleinste Operation.
 */
const effectMin = (s: HolderState, op: Op, id: string) => {
  const e = s.effects.find((x) => x.id === id)
  if (!e) s.effects.push({ id, op: opKey(op.id), at: op.at })
  else if (FOLD.sameDecision && opKey(op.id) < e.op) Object.assign(e, { op: opKey(op.id), at: op.at })
  else if (!FOLD.sameDecision && e.op !== opKey(op.id) && !s.effects.some((x) => x.id === id && x.op === opKey(op.id))) s.effects.push({ id, op: opKey(op.id), at: op.at })
}

/**
 * Schalter für Gegenläufe (Tests): jede Regel von K1a Schritt 3 lässt sich einzeln abschalten, damit ein Test zeigt,
 * dass das Orakel ohne sie fällt. Im Prüfstand immer an.
 */
export const FOLD = { sameDecision: true, consentVsDecline: true, handOver: true }

/** Rangfolge für O über mehrere Übergaben eines Akts: das weiteste Fortkommen einer eigenen Karte zählt. */
const RANK: Record<HandOver, number> = { none: 0, cancelled: 1, intent: 2, handed: 3, taken: 4, 'given-up': 5, delivered: 6 }

/**
 * K1a Schritt 3 (Anton 18.10.2026, Fragenkatalog Klasse 2, Entscheidung 1b und 2a): der Hauptzustand eines Akts folgt aus
 * der Menge seiner Entscheidungen und dem Übergabezustand seiner eigenen Karten, nicht aus der Ankunftsreihenfolge.
 *
 *   8325.0  „Main states `offered`, `declined`, `consented`, `connected`, `expired`, of which exactly `declined`,
 *           `connected` and `expired` are terminal. […] the own card counts as submitted exactly at O ∈ {`taken`,
 *           `delivered`, `given-up`}.“
 *   8325.A3 `offered` → the user refuses → `declined`: „P discarded; V kept (8913); nothing sent (8765)“.
 *   8325.A4 `offered` → the user consents → `consented`: „in one transaction: consent, fresh pair context (8725), fresh
 *           card (8727), card artifact and document as production intent (ENG-INTENT-1); O = `intent`“.
 *   8232.2  card: „Unless submitted or currently undecided (8232.0), the registration and the document are cancelled
 *           and the fresh pair context is discarded (8326.8, 8326.9).“
 *   8765    „A side that declines MUST send nothing about the act to the other side, the mediator or anyone.“
 *
 * Regel 1: zwei Zustimmungen (oder zwei Ablehnungen) derselben Person sind eine Entscheidung und eine Wirkung; die
 * Wirkung trägt die kleinste Operation. Regel 2: Zustimmung gegen Ablehnung. Ist eine eigene Karte eingereicht (8325.0)
 * oder der Akt schon verbunden, gilt die Zustimmung, die Ablehnung steht als Konflikt `conflict:decline:<akt>` im Ledger
 * und als Befund (kein Widerspruch); sonst gilt die Ablehnung, die Zustimmung steht als `conflict:consent:<akt>`, und das
 * Gerät, das die Karte erzeugt hat, nimmt sie zurück, solange sie den Träger nicht erreicht hat (Holder,
 * `withdrawLosingCards`; 8232.2, 8765). Damit gilt die Terminalität von 8325 für die Person erst, wenn ihre Geräte
 * vereinigt sind: das ist eine geänderte Zusage („Zusage geändert“ in der Matrix).
 * P bleibt im Zustand eines abgelehnten Akts erhalten und ist nur verdeckt (Projektion): entscheidet die Faltung später
 * für die Zustimmung, wird die wartende Gegenkarte wieder ausgewertet (8325.A5c).
 */
function resolveDecision(s: HolderState, a: Act): void {
  const ds = a.decisions ?? []
  const consents = ds.filter((d) => d.kind === 'consent').sort((x, y) => (x.op < y.op ? -1 : 1))
  const declines = ds.filter((d) => d.kind === 'decline').sort((x, y) => (x.op < y.op ? -1 : 1))
  if (!consents.length && !declines.length) return
  const submitted = SUBMITTED.has(a.o) || a.opened !== null
  // Ohne Regel 2 (Gegenlauf): der erste terminale Zustand des Geräts bleibt, wie vor Schritt 3.
  const consentHolds = FOLD.consentVsDecline ? consents.length > 0 && (submitted || declines.length === 0) : a.state !== 'declined' && consents.length > 0
  if (a.state !== 'expired') {
    if (consentHolds) {
      if (a.state === 'offered' || a.state === 'declined') a.state = a.opened ? 'connected' : 'consented'
    } else if (a.state !== 'connected') a.state = 'declined'
  }
  const ids = [`consent:${a.id}`, `decline:${a.id}`, `conflict:consent:${a.id}`, `conflict:decline:${a.id}`]
  const keep = s.effects.filter((e) => !ids.includes(e.id))
  const push = (id: string, list: typeof ds) => {
    if (!list.length) return
    if (FOLD.sameDecision) keep.push({ id, op: list[0]!.op, at: list[0]!.at })
    else for (const d of list) keep.push({ id, op: d.op, at: d.at })
  }
  if (consentHolds) {
    push(`consent:${a.id}`, consents)
    push(`conflict:decline:${a.id}`, declines)
  } else {
    push(`decline:${a.id}`, declines)
    push(`conflict:consent:${a.id}`, consents)
  }
  s.effects = keep
  if (consents.length && declines.length) {
    const text = consentHolds
      ? `decline auf ${a.id} gegen eine eingereichte eigene Karte: Konflikt, die Zustimmung gilt (Regel 2; 8325.0, 8326.3)`
      : `consent auf ${a.id} gegen eine Ablehnung ohne eingereichte eigene Karte: Konflikt, die Ablehnung gilt, die Karte wird zurückgenommen (Regel 2; 8232.2, 8765)`
    s.findings = s.findings.filter((f) => !f.startsWith(`decline auf ${a.id} gegen`) && !f.startsWith(`consent auf ${a.id} gegen`))
    s.findings.push(text)
  }
}

/** O des Akts aus den Übergaben seiner Karten (Regel 3): je Übergabe ein eigener Zustand, der Akt trägt das weiteste Fortkommen. */
/**
 * Tor-Review 18 B1b: Rang je Übergabe (ein Digest). Der Zustand einer Übergabe faltet als Verband, nicht nach
 * Ankunftsreihenfolge: von zwei Werten für denselben Digest gilt der mit dem höheren Rang, auf jedem Gerät gleich.
 *
 *   8326.8  eine nie genommene Übergabe wird lokal abgegrenzt (`cancelled`, wie `not-taken`); das schlägt die Zustände vor
 *           dem Träger (`none`, `intent`, `handed`): eine Rücknahme, die gegolten hat, kehrt nicht zu `handed` zurück.
 *   8326.9  eine Übergabe, die der Träger genommen hat, wird nicht aufgehoben: `taken`, `given-up` und `delivered` schlagen
 *           `cancelled` (was den Träger erreicht hat, gilt; Linie Anton 18.10., wie Regel 2).
 *   8326.10 `delivered` ist der letzte Zustand, auch nach `given-up` (späte Quittung).
 */
const HAND_OVER_RANK: Record<HandOver, number> = { none: 0, intent: 1, handed: 2, cancelled: 3, taken: 4, 'given-up': 5, delivered: 6 }
const higher = (x: HandOver | undefined, y: HandOver): HandOver => (x !== undefined && HAND_OVER_RANK[x] >= HAND_OVER_RANK[y] ? x : y)

function aggregateO(a: Act): void {
  const os = Object.values(a.cards ?? {})
  if (!os.length) return
  a.o = os.reduce((m, o) => (RANK[o] > RANK[m] ? o : m), 'none' as HandOver)
}

/**
 * K1a Schritt 4 (Anton 18.10., Fragenkatalog Klasse 2, 3a): Ms Sicht liest mehrere Schreiber einer Seite.
 *
 *   8500 (0.32) „A sender MUST number each revision of a relationship one above the highest revision of that relationship
 *               its persistent state holds.“ (hier: je Schreiberkennung)
 *   6270        generischer Revisionsvertrag: höher ersetzt, gleich und gleich ignoriert, gleich und abweichend
 *               Equivokation, niedriger abgewiesen (hier: je Schreiber im Scope 6280).
 *   8535        „On a withdrawal by the class turning off (8475.S6), the sender MUST send a revision with an empty `keys`
 *               list on the relationship, whether or not it lags.“
 *
 * Regel: je Schreiber die jüngste Revision (die höhere ersetzt die frühere dieses Schreibers ganz); die geltende Sicht ist
 * die Vereinigung der Schlüssel aller Schreiber, deren jüngste Revision über ihrer Aufhebungsmarke liegt (`clears`). Eine
 * leere Revision eines Schreibers hebt die Schlüssel aller Schreiber auf, die das empfangende Gerät bis dahin hielt (die
 * Operation trägt diese Marken); die Marken falten als Maximum. Neuer Scope (8557): die Sicht beginnt neu.
 */
function applyWriterView(s: HolderState, r: Relationship, op: Op & { kind: 'view' }, keys: ListedKey[]): void {
  const w = op.writer!
  let v = r.view
  if (!v || v.scope !== op.scope || !v.writers) v = { scope: op.scope, revision: 0, keys: [], writers: table(), clears: table() }
  const writers = tableOf(v.writers)
  const clears = tableOf(v.clears)
  for (const [x, n] of Object.entries(op.clears ?? {})) put(clears, x, Math.max(own(clears, x) ?? 0, n))
  const held = own(writers, w)
  let take = !held || op.revision > held.revision
  if (held && op.revision === held.revision && canonical(keys) !== canonical(held.keys)) {
    const text = `view auf ${r.id}: Schreiber ${w.slice(0, 8)} Revision ${op.revision} zweimal mit anderen Schlüsseln: Equivokation (6270)`
    if (!s.findings.includes(text)) s.findings.push(text) // einmal je Equivokation, auch wenn Duplikate die Faltung erreichen (Review 33)
    take = canonical(keys) < canonical(held.keys) // in jeder Reihenfolge dasselbe
  }
  if (take) put(writers, w, { revision: op.revision, keys })
  const next: StockView = { scope: op.scope, revision: Math.max(0, ...Object.values(writers).map((x) => x.revision)), keys: [], writers, clears }
  const v2 = viewKeys(writers, clears)
  for (const anchor of v2.conflicts) keyValueConflict(s, anchor)
  next.keys = v2.keys
  r.view = next
}

/**
 * Die geltende Sicht über Schreiber: Vereinigung (nach Anker) der Schreiber mit einer Revision über ihrer Aufhebungsmarke.
 * Review 21 B1: listen zwei Schreiber denselben Anker mit anderem Wert (Ablauf, Vereinbarung, Nummer), gilt der kanonisch
 * kleinste Wert (in jeder Reihenfolge derselbe) und der Anker steht in `conflicts` (Befund, nie still). Mit der Aufteilung
 * der Nummern je Restklasse (K1a) kommt das nicht vor.
 */
export function viewKeys(writers: Record<string, { revision: number; keys: ListedKey[] }>, clears: Record<string, number>): { keys: ListedKey[]; conflicts: string[] } {
  const m = new Map<string, ListedKey>()
  const conflicts = new Set<string>()
  for (const w of Object.keys(writers).sort()) {
    const x = own(writers, w)!
    if (x.revision <= (own(clears, w) ?? 0)) continue
    for (const k of x.keys) {
      const held = m.get(k.anchor)
      if (!held) m.set(k.anchor, k)
      else if (canonical(held) !== canonical(k)) {
        conflicts.add(k.anchor)
        if (canonical(k) < canonical(held)) m.set(k.anchor, k)
      }
    }
  }
  return { keys: sortKeys([...m.values()]), conflicts: [...conflicts].sort() }
}

/**
 * K2: der Schreiber einer Revision ist der signierende Geräteschlüssel der Beziehung (8500/6270 je Signierer). Als
 * Tabellenschlüssel (Form `tag`, 16 Zeichen base64url) dient ein Hash des Ankers; die Gegenseite bildet ihn aus dem
 * Signierer (K2 2b.1: `stock-revision@2` trägt ihn als `writer`, der Parser prüft ihn gegen den Signierer).
 */
export const signerId = (anchor: string) => createHash('sha256').update(`signer|${anchor}`).digest().subarray(0, 12).toString('base64url')

// ── K2 step 2b.1: allocation per M device by A (`stock-revision@2`; core draft 4 §3, §4) ─────────────────────────────

/** §3.2: the purpose inside the signed object of `proof`. */
export const PROOF_PURPOSE = 'rltp/stock-revision@2/proof'
/** §3.1 [Prüfstand]: list bounds and integer ranges of the form check. */
export const REVISION_LIMITS = { keys: 64, withdraw: 256, bury: 512, burn: 16, n: 2 ** 32 - 1, rev: 2 ** 32 - 1 } as const

/**
 * §3.2: what `proof` signs, as bytes: the JCS-canonical object (as every signature of the bench, `canonical`) with the
 * purpose, the writer and its incarnation and the immutable assignment of the key (`n` as a number). Not a concatenation,
 * which would be ambiguous for fields of variable length (Q7).
 */
export const proofContent = (writer: string, inc: string, k: Pick<RevKey, 'for' | 'n' | 'nonce' | 'anchor' | 'keyAgreement' | 'expiresAt'>): Uint8Array =>
  new TextEncoder().encode(canonical({ purpose: PROOF_PURPOSE, writer, inc, for: k.for, n: k.n, nonce: k.nonce, anchor: k.anchor, keyAgreement: k.keyAgreement, expiresAt: k.expiresAt }))

/** The canonical order of `stock-revision@2` lists: by UTF-16 code units (as JCS sorts), never by locale. */
export const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
/** Strictly increasing = sorted and without duplicates (the canonical form of every list of `stock-revision@2`). */
const increasing = (xs: readonly string[]) => xs.every((x, i) => i === 0 || xs[i - 1]! < x)
const sigAnchor = (signing: string): string | null => {
  try {
    return anchorOfEd(fromB64u(signing))
  } catch {
    return null
  }
}

/**
 * §3.1 (MV-24): the form of one `stock-revision@2`, checked without history: the shape; `writer` = the authenticated signer
 * (`signer`, its `signerId`); `rev` and every `n` integers in range; the bounds; every list sorted and unique (canonical
 * bytes) and `n` unique; `classOff` only `true` when present; `bury` only with `classOff`; `burn` never the running `inc`;
 * per key the same `nonce` across this revision, `anchor = anchorOfEd(signing)`, `keyAgreement` a valid X25519 key, `for` a
 * syntactically valid anchor (membership is set knowledge of the M device, not form, Q4). The signature of `proof` is the
 * receiver's (`holder.ts`, asynchronous); everything that needs history (nonce across revisions, binding, equivocation) is
 * a set rule (`allocFold`), not form (D5). Returns null or the path that is wrong.
 */
export function revisionFormProblem(p: unknown, signer: string): string | null {
  const bad = shapeProblem(p, SHAPES.stockRevision, 'stock-revision')
  if (bad) return bad
  const r = p as StockRevision
  const L = REVISION_LIMITS
  if (r.writer !== signer) return 'stock-revision.writer'
  if (r.rev < 1 || r.rev > L.rev) return 'stock-revision.rev'
  if (r.keys.length > L.keys) return 'stock-revision.keys'
  if (r.withdraw.length > L.withdraw) return 'stock-revision.withdraw'
  if (r.bury.length > L.bury) return 'stock-revision.bury'
  if (r.burn.length > L.burn) return 'stock-revision.burn'
  if (!increasing(r.keys.map((k) => k.anchor)) || new Set(r.keys.map((k) => k.n)).size !== r.keys.length) return 'stock-revision.keys(order)'
  if (!increasing(r.withdraw)) return 'stock-revision.withdraw(order)'
  if (!increasing(r.bury)) return 'stock-revision.bury(order)'
  if (!increasing(r.burn)) return 'stock-revision.burn(order)'
  if (r.classOff !== undefined && r.classOff !== true) return 'stock-revision.classOff'
  if (r.bury.length && !r.classOff) return 'stock-revision.bury(classOff)'
  if (r.burn.includes(r.inc)) return 'stock-revision.burn(inc)'
  for (let i = 0; i < r.keys.length; i++) {
    const k = r.keys[i]!
    const at = `stock-revision.keys[${i}]`
    if (k.n > L.n) return `${at}.n`
    if (k.nonce !== r.keys[0]!.nonce) return `${at}.nonce`
    if (sigAnchor(k.signing) !== k.anchor) return `${at}.anchor`
    if (!xRawOfMk(k.keyAgreement)) return `${at}.keyAgreement`
    if (!edRawOfAnchor(k.for)) return `${at}.for`
  }
  return null
}

const wi = (writer: string, inc: string) => `${writer}|${inc}`
/** The immutable assignment of a listed key (§3.3 row 2, `inc` included, E3). */
const assignment = (writer: string, inc: string, k: RevKey) => canonical({ writer, inc, n: k.n, nonce: k.nonce, keyAgreement: k.keyAgreement, expiresAt: k.expiresAt, for: k.for })

/** The history part of the fold (§3.3): a pure function of the folded set of revisions, independent of revocation. */
export interface AllocFold {
  /** Per anchor: the writers and (writer, inc)s that listed it with a proof, and its distinct assignments. */
  bound: Map<Anchor, { writers: Set<string>; incs: Set<string>; values: Set<string> }>
  /** `conflict:assignment:<anchor>`: differing immutable field or two writers; for ever, beats every higher listing. */
  conflicts: Set<Anchor>
  /** `doppelte-bindung`: two writers bound the anchor (only with a shared private part, faulty A). */
  doubles: Set<Anchor>
  /** `conflict:nonce:<writer>:<inc>`: two nonces within one (writer, inc); no listing of it usable. */
  nonceConflicts: Set<string>
  /** Per (writer, inc) the equivocated `rev`s (same rev, other bytes). */
  equivocated: Map<string, number[]>
  /** Per (writer, inc) the current listing: the highest non-equivocated rev; absent when every rev is equivocated. */
  current: Map<string, StockRevision>
  /** Withdrawals by the bound writer (effective, also when they arrived before the binding). */
  withdrawn: Set<Anchor>
  /** Withdrawals of an anchor bound to another writer: `[writer, anchor]`, ineffective, kept. */
  foreign: Array<[string, Anchor]>
  /** Tombstones per anchor with their issuers: `bury[]` of an off revision and the own anchors of its lower revs. */
  tombs: Map<Anchor, Set<string>>
  /** Burnt (writer, inc)s. */
  burned: Set<string>
}

export function allocFold(revs: readonly StockRevision[]): AllocFold {
  const byInc = new Map<string, StockRevision[]>()
  for (const r of revs) {
    const k = wi(r.writer, r.inc)
    if (!byInc.has(k)) byInc.set(k, [])
    byInc.get(k)!.push(r)
  }
  const equivocated = new Map<string, number[]>()
  const current = new Map<string, StockRevision>()
  const nonceConflicts = new Set<string>()
  for (const [k, list] of byInc) {
    const versions = new Map<number, Set<string>>()
    for (const r of list) {
      if (!versions.has(r.rev)) versions.set(r.rev, new Set())
      versions.get(r.rev)!.add(canonical(r))
    }
    const eq = [...versions].filter(([, v]) => v.size > 1).map(([rev]) => rev).sort((a, b) => a - b)
    if (eq.length) equivocated.set(k, eq)
    const best = list.filter((r) => !eq.includes(r.rev)).sort((a, b) => b.rev - a.rev)[0]
    if (best) current.set(k, best)
    if (new Set(list.flatMap((r) => r.keys.map((x) => x.nonce))).size > 1) nonceConflicts.add(k)
  }
  const bound = new Map<Anchor, { writers: Set<string>; incs: Set<string>; values: Set<string> }>()
  for (const r of revs)
    for (const key of r.keys) {
      if (!bound.has(key.anchor)) bound.set(key.anchor, { writers: new Set(), incs: new Set(), values: new Set() })
      const b = bound.get(key.anchor)!
      b.writers.add(r.writer)
      b.incs.add(wi(r.writer, r.inc))
      b.values.add(assignment(r.writer, r.inc, key))
    }
  const conflicts = new Set([...bound].filter(([, b]) => b.values.size > 1).map(([a]) => a))
  const doubles = new Set([...bound].filter(([, b]) => b.writers.size > 1).map(([a]) => a))
  const withdrawn = new Set<Anchor>()
  const foreign = new Map<string, [string, Anchor]>()
  const tombs = new Map<Anchor, Set<string>>()
  const burned = new Set<string>()
  const tomb = (a: Anchor, w: string) => {
    if (!tombs.has(a)) tombs.set(a, new Set())
    tombs.get(a)!.add(w)
  }
  for (const r of revs) {
    for (const a of r.withdraw) {
      const b = bound.get(a)
      if (b?.writers.has(r.writer)) withdrawn.add(a)
      else if (b) foreign.set(`${r.writer}|${a}`, [r.writer, a])
    }
    if (r.classOff) {
      for (const a of r.bury) tomb(a, r.writer)
      for (const lower of byInc.get(wi(r.writer, r.inc)) ?? []) if (lower.rev < r.rev) for (const k of lower.keys) tomb(k.anchor, r.writer)
    }
    for (const inc of r.burn) burned.add(wi(r.writer, inc))
  }
  // Withdrawn wins over foreign once the anchor is bound to the withdrawing writer too (it is then a conflict anyway).
  for (const [k, [w, a]] of foreign) if (bound.get(a)?.writers.has(w)) foreign.delete(k)
  return { bound, conflicts, doubles, nonceConflicts, equivocated, current, withdrawn, foreign: [...foreign.values()], tombs, burned }
}

/**
 * The findings of the fold, one per mark. Historical diagnostics (Tor-Review 46 S1): the holder appends them when a fold
 * shows them and never removes one, so the list can depend on the arrival order (a `fremder-anker` can vanish from the set
 * computation when the anchor later binds to the withdrawing writer too). No decision and no oracle reads them; usability
 * and evidence (`allocation`, `evidence`) are the order-independent functions of the set.
 */
export function allocFindings(f: AllocFold): string[] {
  const out: string[] = []
  for (const a of f.conflicts) out.push(`conflict:assignment:${a}`)
  for (const a of f.doubles) out.push(`doppelte-bindung:${a}`)
  for (const k of f.nonceConflicts) out.push(`conflict:nonce:${k.replace('|', ':')}`)
  for (const [k, revs] of f.equivocated) for (const rev of revs) out.push(`equivocation:${k.replace('|', ':')}:${rev}`)
  for (const [w, a] of f.foreign) out.push(`fremder-anker:${w}:${a}`)
  return out.sort()
}

/** The evidence state of an anchor at one M device (core draft 4 §3.3, §5.1): a function of the folded set, not a latch. */
export interface Evidence {
  state: 'unknown' | 'listed' | 'unlisted' | 'withdrawn'
  /** A conflict mark on the anchor or a nonce conflict of its (writer, inc): unusable whatever the state. */
  conflict: boolean
}
/** What M knows besides the revisions: revoked writers of the counterpart's set, members of its own set (`for`). */
export interface AllocContext {
  revoked: ReadonlySet<string>
  members: ReadonlySet<Anchor>
}

/**
 * The present of the allocation at one M device (§3.3, §4): "currently lists" = the anchor is in the current listing of a
 * non-revoked writer, independent of conflict marks; a tombstone of a non-revoked issuer is final, one of a revoked issuer
 * counts only while no non-revoked writer currently lists the anchor (revocation exception, B6, D4); the class is off while
 * the current listing of some non-revoked (writer, inc) carries `classOff` ("aus gewinnt", 4.10; all equivocated: no
 * value). Usable for an M device: currently listed, no conflict, not withdrawn, not buried, not burnt, `for` a member known
 * here and one of the device's own anchors, class on.
 */
export function allocation(revs: readonly StockRevision[], ctx: AllocContext) {
  const fold = allocFold(revs)
  const live = [...fold.current].filter(([k]) => !ctx.revoked.has(k.split('|')[0]!))
  const listedBy = new Map<Anchor, { key: RevKey; inc: string }>()
  for (const [k, r] of live) for (const key of r.keys) if (!listedBy.has(key.anchor)) listedBy.set(key.anchor, { key, inc: k })
  const buried = (a: Anchor) => [...(fold.tombs.get(a) ?? [])].some((w) => !ctx.revoked.has(w) || !listedBy.has(a))
  const classOff = live.some(([, r]) => r.classOff === true)
  const evidence = (a: Anchor): Evidence => {
    const b = fold.bound.get(a)
    if (!b) return { state: 'unknown', conflict: false }
    const conflict = fold.conflicts.has(a) || [...b.incs].some((k) => fold.nonceConflicts.has(k))
    const gone = fold.withdrawn.has(a) || buried(a) || [...b.incs].some((k) => fold.burned.has(k)) || [...b.writers].every((w) => ctx.revoked.has(w))
    return { state: gone ? 'withdrawn' : listedBy.has(a) ? 'listed' : 'unlisted', conflict }
  }
  const usable = (mine?: ReadonlySet<Anchor>): ViewKey[] => {
    if (classOff) return []
    const out: ViewKey[] = []
    for (const [a, { key, inc }] of listedBy) {
      if (fold.burned.has(inc) || fold.nonceConflicts.has(inc)) continue
      const e = evidence(a)
      if (e.state !== 'listed' || e.conflict) continue
      if (!ctx.members.has(key.for) || (mine && !mine.has(key.for))) continue
      out.push({ n: key.n, anchor: a, keyAgreement: key.keyAgreement, expiresAt: key.expiresAt, for: key.for })
    }
    return out.sort((x, y) => byCode(x.anchor, y.anchor)) // K2 2b.2 decision 16: one order, code units
  }
  return { fold, classOff, evidence, usable, buried }
}

/** Ms nutzbare Sicht auf den Vorrat einer Seite in einem Moment (`usableView`): jede Stufe eine Teilmenge der vorigen. */
export interface UsableView {
  /** Geltende Schlüssel: je Anker der kanonische Wert über die nicht widerrufenen Schreiber (K2 2b.1: nach den Mengenregeln, je `for`). */
  listed: ViewKey[]
  /** Davon noch lang genug gültig (8470). */
  usable: ViewKey[]
  /** Davon nicht verbraucht (8570.2). */
  unconsumed: ViewKey[]
}

/** K2: the revoked writers (signer ids) of a relationship: every anchor revoked in the set of one of its peer roots. */
function revokedWriters(s: HolderState, r: Relationship): Set<string> {
  const revoked = new Set<string>()
  for (const t of r.tuples) for (const a of setView(own(s.sets, t.peer)).revoked) revoked.add(signerId(a))
  return revoked
}
/** K2 2b.1: the members of the holder's own sets of this relationship (one per own tuple root): the known `for` values. */
function ownMembers(s: HolderState, r: Relationship): Set<Anchor> {
  return new Set(r.tuples.flatMap((t) => setView(own(s.sets, t.own)).members.map((m) => m.anchor)))
}
function allocOf(s: HolderState, relId: string) {
  const r = findRel(s, relId)
  return r?.view?.revs ? allocation(r.view.revs, { revoked: revokedWriters(s, r), members: ownMembers(s, r) }) : null
}
/** K2 2b.1: the evidence state of an anchor at this holder (§3.3); `unknown` without a `stock-revision@2` view. */
export function evidence(s: HolderState, relId: string, anchor: Anchor): Evidence {
  return allocOf(s, relId)?.evidence(anchor) ?? { state: 'unknown', conflict: false }
}
/** K2 2b.1: is the class of the counterpart off for this holder (§4: last value per (writer, inc), "aus gewinnt")? */
export function classOff(s: HolderState, relId: string): boolean {
  return allocOf(s, relId)?.classOff ?? false
}

/**
 * Review 36 B7 (Vertrag statt Patch-Kaskade): die eine Rechnung für Ms Sicht auf den Vorrat einer Seite. Jeder Verbraucher
 * liest aus ihr: die Wahl des Schlüssels in einer Vorstellung, die Rechteprüfung der Vorstellung (`authorize`), die Zählung
 * des Vorrats (`stockAt`, X23) und die Messungen der Szenarien. Rein, eine Funktion des gefalteten Zustands und der Zeit;
 * damit in jeder Empfangsreihenfolge dieselbe.
 *
 * K2 step 2b.1: with `stock-revision@2` (`view.revs`) the listing follows the set rules (`allocation`); `mine` = the own
 * anchors of the M device in this relationship (`for` filter, MV-32): without it, the keys of every known member (a
 * measurement of M's view, never a choice). Without revisions of version 2 (K0, K1a): je Anker der kanonisch kleinste
 * Wert über die nicht widerrufenen Schreiber (Review 21 B1, `viewKeys`). Dann Ablauf (8470) und Verbrauch (8570.2).
 */
export function usableView(s: HolderState, relId: string, now: string, mine?: ReadonlySet<Anchor>): UsableView {
  const r = findRel(s, relId)
  const v = r?.view
  if (!r || !v) return { listed: [], usable: [], unconsumed: [] }
  let listed: ViewKey[] = v.keys
  if (v.revs) listed = allocOf(s, relId)!.usable(mine)
  else if (v.writers) {
    const revoked = revokedWriters(s, r)
    listed = viewKeys(table(Object.entries(v.writers).filter(([w]) => !revoked.has(w))), tableOf(v.clears)).keys
  }
  const fresh = listed.filter((k) => usable(k.expiresAt, now))
  return { listed, usable: fresh, unconsumed: fresh.filter((k) => !s.consumed.includes(k.anchor)) }
}

/**
 * K2 step 2b.2 (core draft 4 §5.1, §1.4; decisions 2, 9, 10, 13): may the issuing M device submit (or resubmit) its ticket
 * intent for side `side` of act `actId` now? The one computation the holder's release, its resumption and the outcome
 * ledger's P-Produktion share (no second projection). In this order:
 *   `accepted`  the side's receipt is known (decision 13: omitted, saves transport, 8640.4);
 *   `deadline`  `now > expiresAt − consent-reserve` (8155, equality still admissible; decision 9);
 *   `departed`  the addressee relationship departed, or the other one departed while the other ticket was not submitted
 *               (8232.1: before either is submitted both are cancelled; after the other one, the one on the departed);
 *   `withdrawn` the named key's evidence is `withdrawn` (withdrawn, buried, burnt, revoked writer: §3.3; decision 10).
 * `null` = admissible. `otherSubmitted` / `selfSubmitted`: the device knows the other ticket / this one at the carrier.
 * Order (Opus-Review 54 S3): `deadline` before `accepted`.
 */
export type TicketGate = 'accepted' | 'deadline' | 'departed' | 'withdrawn' | 'unknown-act'
export function ticketGate(s: HolderState, actId: string, side: 'a' | 'b', now: string, otherSubmitted: boolean, selfSubmitted = false): TicketGate | null {
  const a = s.mediatorActs.find((x) => x.id === actId)
  if (!a) return 'unknown-act'
  // Opus-Review 54 S3: the deadline first, so `TB` always ends a submission (also one with the receipt known).
  if (Date.parse(now) > Date.parse(a.expiresAt) - PARAM.consentReserveMs) return 'deadline'
  if (a.known?.[side]) return 'accepted'
  const other = side === 'a' ? 'b' : 'a'
  const gone = (x: MediatorAct['a']) => findRel(s, x.rel)?.departed !== false
  // Opus-Review 54 S1 (8232.0/8232.1): a submitted ticket is out and is never cancelled; the gate applies to unsubmitted ones.
  if (!selfSubmitted && (gone(a[side]) || (gone(a[other]) && !otherSubmitted))) return 'departed'
  if (evidence(s, a[side].rel, a[side].key).state === 'withdrawn') return 'withdrawn'
  return null
}

/** Review 21 B1: gleicher Anker, anderer Schlüsselwert; einmal je Anker als Befund festgehalten (reihenfolgeunabhängig). */
function keyValueConflict(s: HolderState, anchor: string): void {
  const prefix = `conflict:key-value:${anchor}`
  if (!s.findings.some((f) => f.startsWith(prefix))) s.findings.push(`${prefix}: gleicher Anker mit anderem Schlüsselwert (8445); der kanonisch kleinste gilt`)
}

// ── Anwenden (deterministisch, idempotent je Operations-ID und je Effekt) ───

export function apply(s: HolderState, original: Op): void {
  const key = opKey(original.id)
  if (s.applied.includes(key)) return
  const op = structuredClone(original)
  if (op.kind === 'view' && op.clears) op.clears = tableOf(op.clears) // Review 28: Tabellen ohne Prototyp
  // Ganz oder gar nicht (B1): auf einem Entwurf anwenden, erst bei Erfolg übernehmen. `s` behält seine Identität.
  const draft = cloneState(s)
  applyBody(draft, op)
  draft.applied.push(key)
  Object.assign(s, draft)
}

const emptyRel = (id: string, t: Tuple, provenance: Relationship['provenance'], vouchedBy: string[]): Relationship => ({ id, tuples: [t], provenance, vouchedBy, classOn: false, stock: [], nonce: null, nextN: 1, revision: 0, accepted: [], confirmed: [], confirmedAt: null, departed: false, view: null })

function applyBody(s: HolderState, op: Op): void {
  switch (op.kind) {
    case 'open-tuple': {
      if (s.relationships.some((r) => r.tuples.some((t) => t.id === op.tuple.id))) return // Effekt-Identität: das Tupel
      const a = op.act ? act(s, op.act) : null
      if (op.rel) rel(s, op.rel).tuples.push(op.tuple)
      else s.relationships.push(emptyRel(op.tuple.id, op.tuple, op.provenance, op.vouchedBy ? [op.vouchedBy] : []))
      if (a) {
        a.state = 'connected'
        a.opened = op.rel ?? op.tuple.id
        a.pending = null
      }
      return
    }
    case 'class': {
      const r = rel(s, op.rel)
      r.classOn = op.on
      effect(s, op, `class:${r.id}:${op.on ? 'on' : 'off'}`)
      return
    }
    case 'depart': {
      const r = rel(s, op.rel)
      if (r.departed) return
      r.departed = true
      r.classOn = false
      for (const k of r.stock) if (k.state !== 'consumed' && k.state !== 'tombstoned') k.state = 'withdrawn' // 8475.S6
      for (const d of s.duties) if (r.tuples.some((t) => t.id === d.pair[0] || t.id === d.pair[1]) && (d.state === 'hit' || d.state === 'sent' || d.state === 'none')) d.state = 'moot' // 6845.7
      effect(s, op, `depart:${r.id}`)
      return
    }
    case 'allocate': {
      const r = rel(s, op.rel)
      if (!r.nonce) r.nonce = op.nonce // 8435: die erste Nonce der Beziehung
      else if (r.nonce !== op.nonce && !r.stock.some((x) => x.nonce === op.nonce)) s.findings.push(`allocate auf ${r.id}: zweiter Vorrat unter Nonce ${op.nonce.slice(0, 8)} neben ${r.nonce.slice(0, 8)} (8435): zwei Geräte haben getrennt zugeteilt`)
      for (const k of op.keys) {
        const held = r.stock.find((x) => x.anchor === k.anchor) ?? r.stock.find((x) => x.nonce === k.nonce && x.n === k.n)
        if (held) {
          // Effekt-Identität: (Nonce, n) bzw. der Anker. Review 21 B1: gleicher Anker mit anderem Wert (zwei Geräte haben dieselbe
          // Nummer getrennt zugeteilt) faltet auf den kanonisch kleinsten Wert und wird als Befund festgehalten, nie still.
          const value = (x: StockKey) => canonical({ n: x.n, nonce: x.nonce ?? op.nonce, anchor: x.anchor, keyAgreement: x.keyAgreement, key: x.key, expiresAt: x.expiresAt })
          if (value(held) !== value(k)) {
            keyValueConflict(s, held.anchor)
            if (value(k) < value(held)) Object.assign(held, { n: k.n, nonce: k.nonce ?? op.nonce, anchor: k.anchor, keyAgreement: k.keyAgreement, key: k.key, expiresAt: k.expiresAt })
          }
          continue
        }
        r.stock.push({ ...k, nonce: k.nonce ?? op.nonce, state: 'active' }) // Vorbereitung sofort bestätigt (Prüfstand); 8475.S3 mit der Revision
        r.nextN = Math.max(r.nextN, k.n + 1)
      }
      return
    }
    case 'revision': {
      const r = rel(s, op.rel)
      r.revision = Math.max(r.revision, op.revision) // 8500: Nummern bleiben verbraucht
      if (op.writer) {
        // Schritt 4: 8500 je Schreiber; die höchste Revision des Schreibers zählt, gleich in welcher Reihenfolge gefaltet.
        // K2 2b.1 (`stock-revision@2`): je (Schreiber, Inkarnation); `empty` hält dort den Klassenwert der Revision (`classOff`).
        const key = op.inc ? `${op.writer}.${op.inc}` : op.writer
        const w = own(r.writers, key)
        if (!w || op.revision > w.revision) {
          const ws = tableOf(r.writers)
          put(ws, key, { revision: op.revision, empty: op.inc ? op.classOff === true : op.keys.length === 0 })
          r.writers = ws
        }
        effect(s, op, `revision:${r.id}:${key}:${op.revision}`)
      } else effect(s, op, `revision:${r.id}:${op.revision}`)
      return
    }
    case 'withdraw': {
      const r = rel(s, op.rel)
      for (const k of r.stock) if (op.anchors.includes(k.anchor) && (k.state === 'active' || k.state === 'aging' || k.state === 'allocated' || k.state === 'registered')) k.state = 'withdrawn'
      return
    }
    case 'age': {
      const r = rel(s, op.rel)
      for (const k of r.stock) if (op.anchors.includes(k.anchor) && k.state === 'active') k.state = 'aging'
      return
    }
    case 'retire': {
      // K2 2b.1, 8475.S8: a key past `expiresAt + key-retention` ends as tombstone at its allocator (no longer a reservation,
      // which already ended at `expiresAt`, core draft 4 §2.1).
      const r = rel(s, op.rel)
      for (const k of r.stock) if (op.anchors.includes(k.anchor) && (k.state === 'active' || k.state === 'aging')) k.state = 'tombstoned'
      return
    }
    case 'stock-revision': {
      // K2 2b.1 (core draft 4 §3.3, MV-31): every form-checked revision of the scope is kept, canonical, once; all rules are
      // functions of this set (`allocation`). A new scope (8557, newer head) starts the view anew, as for version 1.
      const r = rel(s, op.rel)
      const v = r.view && r.view.scope === op.scope && r.view.revs ? r.view : { scope: op.scope, revision: 0, keys: [], revs: [] as StockRevision[] }
      const c = canonical(op.revision)
      const revs = v.revs!.some((x) => canonical(x) === c) ? v.revs! : [...v.revs!, op.revision].sort((a, b) => (canonical(a) < canonical(b) ? -1 : 1))
      r.view = { scope: op.scope, revision: Math.max(0, ...revs.map((x) => x.rev)), keys: [], revs }
      for (const f of allocFindings(allocFold(revs))) if (!s.findings.includes(f)) s.findings.push(f) // diagnostics only, see `allocFindings`
      return
    }
    case 'view': {
      // 8500/6270: in einem Scope ist die Sicht monoton in der Revision; gleiche Revision mit anderen Schlüsseln ist eine
      // Equivokation, das Ergebnis ist in jeder Reihenfolge dasselbe (kanonisch kleinere Schlüsselmenge).
      const r = rel(s, op.rel)
      const v = r.view
      const keys = sortKeys(op.keys) // kanonisch gehalten: die Ankunftsreihenfolge ist nicht handlungswirksam (Review 4 B2)
      if (op.writer) {
        applyWriterView(s, r, op as Op & { kind: 'view' }, keys)
        return
      }
      if (v && v.scope === op.scope) {
        if (op.revision < v.revision) return
        if (op.revision === v.revision) {
          const same = canonical(keys) === canonical(v.keys) // der ganze Schlüsselwert zählt (Anker, Vereinbarung, Ablauf)
          if (same) return
          s.findings.push(`view auf ${r.id}: Revision ${op.revision} zweimal mit anderen Schlüsseln: Equivokation (6270)`)
          if (canonical(keys) > canonical(v.keys)) return
        }
      }
      r.view = { scope: op.scope, revision: op.revision, keys }
      return
    }
    case 'ticket-ack': {
      // K2 2b.2: acceptance knowledge, `unknown → accepted` the only transition (draft 3 §1.1); the first receipt stays.
      const a = s.mediatorActs.find((x) => x.id === op.act)
      if (!a) throw new Missing('act', op.act, s.person)
      // Opus-Review 54 B1 (decision 11 as a rule of the fold): only the issuing device writes acceptance knowledge; a
      // `ticket-ack` of any other writer is a finding, never state.
      const writer = op.id.writer.split('@')[0]!
      if (a.by !== undefined && writer !== a.by) {
        const text = `ticket-ack:foreign-writer:${op.act}:${op.side}: ${writer} is not the issuer ${a.by}`
        if (!s.findings.includes(text)) s.findings.push(text)
        return
      }
      a.known ??= {}
      a.known[op.side] ??= op.receiptDigest
      return
    }
    case 'introduce': {
      if (s.mediatorActs.some((a) => a.id === op.act.id)) return // Effekt-Identität: der Akt
      s.mediatorActs.push(op.act)
      s.consumed.push(op.act.a.key, op.act.b.key) // 8570.2
      effect(s, op, `ticket:${op.act.id}:${op.act.a.key}`)
      effect(s, op, `ticket:${op.act.id}:${op.act.b.key}`)
      return
    }
    case 'ticket-accept': {
      const a = op.act
      if (s.acts.some((x) => x.id === a.id)) {
        // Effekt-Identität: der Akt. Regel 1: nehmen zwei Geräte derselben Person dasselbe Ticket je für sich an (K2-shared:
        // jedes Gerät öffnet es), ist das eine Annahme; die Wirkung trägt die kleinste Operation.
        if (s.effects.some((e) => e.id === `accept:${a.id}`)) effectMin(s, op, `accept:${a.id}`)
        return
      }
      // Tor-Review 40 B3: zwei angenommene Akte auf einem Vorrats-Schlüssel (A und M je aus einem alten Abbild, ein zweiter
      // Akt erreicht A vor dem Nachholen) sind sichtbar, nicht stumm: ein Befund je Schlüssel, in jeder Faltungsreihenfolge
      // derselbe. Benannter Preis in 2a (Restore-Artefakt); 2b schließt ihn mit D1 (b) (Restore verbrennt den alten Vorrat).
      if (s.acts.some((x) => x.own === a.own)) {
        const text = `consumption:double-accept:${a.own}: zwei angenommene Akte auf einem Vorrats-Schlüssel (Restore-Artefakt, benannter Preis 2a)`
        if (!s.findings.includes(text)) s.findings.push(text)
      }
      s.acts.push({ ...a, mediator: resolveId(s, a.mediator) })
      const r = rel(s, a.mediator)
      const k = r.stock.find((x) => x.anchor === a.own)
      if (k) k.state = 'consumed' // 8475.S4
      if (!r.accepted.some((e) => e.act === a.id)) r.accepted.push({ act: a.id, at: op.at }) // 8510
      if (!s.voucherAssigned.some((v) => v.anchor === a.voucher.anchor)) s.voucherAssigned.push({ anchor: a.voucher.anchor, act: a.id }) // 8287.2
      effect(s, op, `accept:${a.id}`)
      return
    }
    case 'ticket-refuse-budget': {
      const k = rel(s, op.rel).stock.find((x) => x.anchor === op.own)
      if (k) k.state = 'consumed' // 8640.13
      return
    }
    case 'finding':
      s.findings.push(op.text)
      return
    case 'consent': {
      // 8325.A4; Regel 1 und 2 (K1a Schritt 3): jede Zustimmung wird gemerkt, der Zustand folgt aus allen Entscheidungen.
      const a = act(s, op.act)
      if (a.state === 'expired') return // 8280: nach einem terminalen Ablauf keine Produktion
      const key = opKey(op.id)
      a.decisions = [...(a.decisions ?? []).filter((d) => d.op !== key), { kind: 'consent', op: key, at: op.at }]
      // Ein Seed: beide Geräte leiten denselben Kartenschlüssel ab; die Karte der kleinsten Zustimmung gilt (deterministisch).
      // K2 Schritt 2 (E2 (iv)): eine Zustimmung ohne Karte (das Gerät hat den Vorrats-Schlüssel nicht zugeteilt) wählt nichts.
      if (op.card && op.cardKey && (!a.consentOp || (FOLD.sameDecision ? key < a.consentOp : false))) {
        a.consentOp = key
        a.ownCard = op.card
        a.ownCardKey = op.cardKey
      }
      if (a.o === 'none') a.o = 'intent'
      resolveDecision(s, a)
      return
    }
    case 'produce': {
      // K2 Schritt 2 (E2 (iv)): nur das zuteilende Gerät erzeugt die Karte, eine je Akt; es gibt nichts zu wählen. Eine
      // zweite, andere Karte desselben Akts kommt strukturell nicht vor; käme sie doch, ist das ein Befund, der Akt behält die erste.
      const a = act(s, op.act)
      if (a.state === 'expired') return
      if (a.ownCard && (a.ownCard.anchor !== op.card.anchor || a.ownCardV !== op.v)) {
        s.findings.push(`produce auf ${a.id}: zweite Karte ${op.card.anchor.slice(-8)} neben ${a.ownCard.anchor.slice(-8)} (E2 (iv)): Equivokation desselben Holders`)
        return
      }
      a.ownCard = op.card
      a.ownCardKey = op.cardKey
      a.ownCardV = op.v
      if (a.o === 'none') a.o = 'intent'
      return
    }
    case 'device-set': {
      // K2 Schritt 2: Nachweise wachsen nur (Zwei-Phasen-Menge, `setView`); 6270 je Signierer nur für Wiederholung und
      // Equivokation (gleiche Nummer, anderer Inhalt: Befund, kein K eines Akts).
      const sets = tableOf(s.sets)
      const prev = own(sets, op.root)
      const set: DeviceSet = prev ? { ...prev, certs: tableOf(prev.certs), revs: tableOf(prev.revs), seen: [...prev.seen], ...(prev.local ? { local: tableOf(prev.local) } : {}), ...(prev.equivocal ? { equivocal: tableOf(prev.equivocal) } : {}) } : { root: op.root, rootKeyAgreement: op.rootKeyAgreement, certs: table(), revs: table(), seen: [] }
      // Widersprüchliche Werte (CodeRabbit #74): in jeder Reihenfolge bleibt der kanonisch kleinere, je Konflikt ein Befund.
      const conflict = (text: string) => {
        if (!s.findings.includes(text)) s.findings.push(text)
      }
      if (prev && op.rootKeyAgreement !== set.rootKeyAgreement) {
        conflict(`device-set auf ${op.root.slice(-8)}: zwei Vereinbarungsschlüssel der Wurzel`)
        if (op.rootKeyAgreement < set.rootKeyAgreement) set.rootKeyAgreement = op.rootKeyAgreement
      }
      for (const c of op.certs) {
        if (c.root !== op.root) continue
        const held = own(set.certs, certKey(c))
        if (!held) put(set.certs, certKey(c), c)
        else if (canonical(held) !== canonical(c)) {
          conflict(`device-set auf ${op.root.slice(-8)}: Nachweis ${c.kind} ${c.anchor.slice(-8)} von ${c.by.slice(-8)} zweimal mit anderem Inhalt`)
          if (canonical(c) < canonical(held)) put(set.certs, certKey(c), c)
          // Review 33 B1: beide Fassungen bleiben für den Befund (Menge, kanonisch sortiert: in jeder Reihenfolge dieselbe).
          const eq = tableOf(set.equivocal)
          const all = new Map([...(own(eq, certKey(c)) ?? []), held, c].map((x) => [canonical(x), x]))
          put(eq, certKey(c), [...all.keys()].sort().map((k) => all.get(k)!))
          set.equivocal = eq
        }
      }
      if (op.local) {
        const local = tableOf(set.local)
        for (const [anchor, device] of Object.entries(op.local)) if (!own(local, anchor)) put(local, anchor, device)
        set.local = local
      }
      if (op.rev) {
        const held = own(set.revs, op.rev.signer)
        if (held && held.n === op.rev.n && held.digest !== op.rev.digest) {
          const text = `device-set auf ${op.root.slice(-8)}: Signierer ${op.rev.signer.slice(0, 8)} Revision ${op.rev.n} zweimal mit anderem Inhalt: Equivokation (6270)`
          if (!s.findings.includes(text)) s.findings.push(text)
          if ((op.rev.digest ?? '') < (held.digest ?? '')) put(set.revs, op.rev.signer, { n: op.rev.n, digest: op.rev.digest, ...(op.rev.covered ? { covered: op.rev.covered } : {}) }) // in jeder Reihenfolge dieselbe
        } else if (!held || op.rev.n > held.n) put(set.revs, op.rev.signer, { n: op.rev.n, digest: op.rev.digest, ...(op.rev.covered ? { covered: op.rev.covered } : {}) })
      }
      if (op.seen && !set.seen.includes(op.seen)) set.seen.push(op.seen)
      // Review 33 B2: was eine kumulative Revision signiert als Vorgänger nennt, ist gedeckt (wächst nur, reihenfolgefrei).
      for (const d of op.deps ?? []) if (!set.seen.includes(d)) set.seen.push(d)
      put(sets, op.root, set)
      s.sets = sets
      return
    }
    case 'pool': {
      const pools = tableOf(s.pools)
      const held = [...(own(pools, op.device) ?? [])]
      for (const k of op.keys) if (!held.some((x) => x.i === k.i)) held.push({ ...k, used: null })
      held.sort((x, y) => x.i - y.i)
      put(pools, op.device, held)
      s.pools = pools
      return
    }
    case 'pool-use': {
      const pools = tableOf(s.pools)
      const held = (own(pools, op.device) ?? []).map((k) => ({ ...k }))
      const k = held.find((x) => x.i === op.i)
      if (!k) throw new Missing('pool', `${op.device}#${op.i}`, s.person)
      if (k.used && k.used !== op.root) {
        const text = `pool-use: Schlüssel ${op.device}#${op.i} zwei Beziehungen zugewiesen`
        if (!s.findings.includes(text)) s.findings.push(text)
        if (op.root < k.used) k.used = op.root
      } else k.used = op.root
      put(pools, op.device, held)
      s.pools = pools
      return
    }
    case 'decline': {
      // 8325.A3; Regel 1 und 2: gemerkt, der Zustand folgt aus allen Entscheidungen; P wird verdeckt, nicht gelöscht.
      const a = act(s, op.act)
      if (a.state === 'expired') return
      const key = opKey(op.id)
      a.decisions = [...(a.decisions ?? []).filter((d) => d.op !== key), { kind: 'decline', op: key, at: op.at }]
      resolveDecision(s, a)
      return
    }
    case 'hand-over': {
      // 8326; Regel 3: O je Übergabe (Digest), die gewinnende Übergabe ist die mit der kleineren Kennung. Zwei Übergaben
      // eines Akts sind immer nebenläufig (ein Gerät, das die Zustimmung des anderen kennt, stimmt nicht zu und produziert
      // keine Karte); „erste in Journalordnung“ ist damit für sie nicht definiert, es gilt der Gleichstand: kleinerer Digest.
      const a = act(s, op.act)
      if (op.digest) {
        const cards = tableOf(a.cards)
        put(cards, op.digest, FOLD.handOver ? higher(own(a.cards, op.digest), op.o) : op.o) // B1b: Rang je Übergabe
        a.cards = cards
        if (!a.ownCardDigest || (FOLD.handOver ? op.digest < a.ownCardDigest : true)) a.ownCardDigest = op.digest
        if (FOLD.handOver) aggregateO(a)
        else a.o = op.o
      } else a.o = op.o
      if (op.o === 'taken' && a.ownCard) effectMin(s, op, `card:${a.id}:${a.ownCard.anchor}`)
      resolveDecision(s, a) // eine eingereichte Karte entscheidet Regel 2 für die Zustimmung
      return
    }
    case 'card-pending': {
      const a = act(s, op.act)
      if (!a.v) a.v = op.v
      // 8905 verbraucht P: nach der Verbindung (hier oder auf einem Schwestergerät gefaltet) setzt eine wartende Karte P nicht
      // neu, sonst hinge der Zustand von der Faltungsreihenfolge ab (K2 Schritt 2: der Vorrats-Schlüssel der Menge, beide
      // Geräte empfangen die Gegenkarte, eines verbindet, das andere stellt sie nach 8910.4 zurück). Nur für Akte mit einer
      // Karte aus der Produzentenregel (`ownCardV`, E2 (iv)); K1a behält seine Faltung unverändert (Prüfstandsgleichheit).
      if (a.opened && a.ownCardV) return
      a.pending = op.card
      return
    }
    case 'card-refused': {
      const a = act(s, op.act)
      if (!a.v) a.v = op.v
      if (op.k) a.k = true
      return
    }
    case 'connect': {
      // 8905: Tupel öffnen als neue Beziehung, Akt connected.
      const a = act(s, op.act)
      if (a.opened || s.relationships.some((r) => r.tuples.some((t) => t.id === op.tuple.id))) {
        // Effekt-Identität: der Akt. Regel 1: verbinden zwei Geräte derselben Person je für sich (beide halten die
        // Gegenkarte, ein Seed), ist das eine Verbindung; die Wirkung trägt die kleinste Operation.
        if (a.opened && s.effects.some((e) => e.id === `connect:${a.id}`)) effectMin(s, op, `connect:${a.id}`)
        return
      }
      if (a.state === 'declined') {
        // 8325.A3: eine Ablehnung ist terminal, auch gegen eine Verbindung vom anderen Gerät; der abgewiesene Versuch ist ein Konflikt, keine ausgeführte Verbindung (Review 7 S3).
        s.findings.push(`connect auf ${a.id} nach decline: Widerspruch (8325.A3)`)
        effect(s, op, `conflict:connect:${a.id}`)
        return
      }
      s.relationships.push(emptyRel(op.rel, op.tuple, 'introduction', [a.mediator]))
      a.state = 'connected'
      a.opened = op.rel
      a.pending = null
      effectMin(s, op, `connect:${a.id}`)
      return
    }
    case 'expire': {
      const a = act(s, op.act)
      if (a.state === 'offered' || a.state === 'consented') {
        a.state = 'expired'
        a.pending = null
      }
      return
    }
    case 'budget-confirm': {
      // 8515: die Bestätigung benennt die Akte, die der Nutzer gesehen hat; reihenfolgeunabhängig gegen spätere Annahmen.
      const r = rel(s, op.rel)
      r.confirmedAt = [r.confirmedAt, op.at].filter(Boolean).sort().pop() ?? op.at
      for (const id of op.acts) if (!r.confirmed.includes(id)) r.confirmed.push(id)
      return
    }
    case 'duty': {
      const d = s.duties.find((x) => x.pair[0] === op.pair[0] && x.pair[1] === op.pair[1])
      if (d) {
        if (d.state === 'united' || d.state === 'moot') {
          // 6845.9: final. Erreichen zwei Geräte einer Person denselben Endzustand mit je eigenem Mapping (nebenläufige
          // Vereinigung, K1a Schritt 2), hält jedes Gerät den kanonisch kleinsten Digest, in jeder Reihenfolge.
          if (op.state === d.state && op.mappingDigest && d.mappingDigest && op.mappingDigest < d.mappingDigest) d.mappingDigest = op.mappingDigest
          return
        }
        d.state = op.state
        if (op.mappingDigest) d.mappingDigest = op.mappingDigest
      } else s.duties.push({ pair: op.pair, state: op.state, mappingDigest: op.mappingDigest })
      if (op.state === 'sent' && op.mappingDigest) effect(s, op, `mapping:${op.pair.join('+')}:${op.mappingDigest}`)
      return
    }
    case 'union': {
      // 6975.2: Mengenvereinigung; die Identität folgt dem Kopfteil; der andere Teil bleibt als Alias.
      const ra = rel(s, op.a) // unbekannt = Missing (Review 4 B1): „noch nicht bekannt“ ist nie „schon vereinigt“
      const rb = rel(s, op.b)
      if (!s.edges.some((e) => e[0] === op.edge[0] && e[1] === op.edge[1])) s.edges.push(op.edge)
      if (ra === rb) {
        // 6230: „Processing a union more than once MUST be idempotent“. Zwei Geräte einer Person, die über dieselbe Kante
        // nebenläufig vereinigen, haben eine Vereinigung vollzogen, nicht zwei (K1a Schritt 2): die Wirkung behält die
        // kanonisch kleinste Operation, in jeder Reihenfolge; die Mengenvereinigung selbst ist schon geschehen.
        const e = s.effects.find((x) => x.id === `union:${op.edge.join('+')}`)
        if (e && opKey(op.id) < e.op) Object.assign(e, { op: opKey(op.id), at: op.at })
        return
      }
      if (ra.departed || rb.departed) return // keine Vereinigung über einen Abgang
      const headA = head(ra)
      const headB = head(rb)
      const [keep, other] = headA.record > headB.record ? [ra, rb] : [rb, ra]
      const unitedHead = headA.record > headB.record ? headA : headB
      keep.tuples.push(...other.tuples)
      for (const t of keep.tuples) t.deactivated = t.id !== unitedHead.id // 6220
      keep.vouchedBy = [...new Set([...keep.vouchedBy, ...other.vouchedBy])] // 6987.10
      keep.provenance = keep.provenance === 'encounter' || other.provenance === 'encounter' ? 'encounter' : 'introduction' // 6987.11
      for (const k of other.stock) if (!keep.stock.some((x) => x.anchor === k.anchor)) keep.stock.push(k) // 6987.1
      keep.nonce = keep.nonce ?? other.nonce // 6987.3
      keep.nextN = Math.max(keep.nextN, other.nextN)
      keep.revision = Math.max(keep.revision, other.revision) // 6987.4
      if (keep.writers || other.writers) {
        const ws = tableOf(keep.writers)
        for (const [w, x] of Object.entries(other.writers ?? {})) if (!own(ws, w) || x.revision > own(ws, w)!.revision) put(ws, w, x)
        keep.writers = ws // 6987.4 je Schreiber
      }
      for (const e of other.accepted) if (!keep.accepted.some((x) => x.act === e.act)) keep.accepted.push(e) // 6987.6
      for (const id of other.confirmed) if (!keep.confirmed.includes(id)) keep.confirmed.push(id)
      keep.confirmedAt = [keep.confirmedAt, other.confirmedAt].filter(Boolean).sort().pop() ?? null
      keep.classOn = keep.classOn && other.classOn // 2160: aus gewinnt
      // 6987.8: Ms Sicht ist die des Kopfteils, sonst keine.
      keep.view = keep === ra ? (headA.record > headB.record ? ra.view : null) : headB.record > headA.record ? rb.view : null
      put(s.aliases, other.id, keep.id)
      for (const a of s.acts) if (a.mediator === other.id) a.mediator = keep.id // 6987.10
      for (const r of s.relationships) r.vouchedBy = r.vouchedBy.map((v) => (v === other.id ? keep.id : v))
      s.relationships = s.relationships.filter((r) => r !== other)
      effect(s, op, `union:${op.edge.join('+')}`)
      return
    }
    case 'edge': {
      if (!s.edges.some((e) => e[0] === op.edge[0] && e[1] === op.edge[1])) s.edges.push(op.edge)
      const r = relOfTuple(s, op.edge[0])
      if (!r) throw new Missing('tuple', op.edge[0], s.person)
      tuple(s, op.edge[1]) // beide Enden müssen bekannt sein (Review 5)
      const h = head(r)
      for (const t of r.tuples) t.deactivated = t.id !== h.id
      return
    }
  }
}

// ── Fachliche Projektion (Messgröße, Plan Abschnitt 5; kanonisch, B5) ──────

export interface Projection {
  /** Kontakte: je Beziehung alles, was eine spätere Entscheidung trägt (B5, Review 4 B3: ganze Schlüsselwerte mit Ablauf): Gegenanker, Kopf, Klasse, Abgang, Ms Sicht, Vorrat je Schlüssel, Nonce und Nummernstand, Revision, Annahmen mit Zeit, Bestätigungen, Budget. */
  contacts: Array<{ peers: string[]; head: string; classOn: boolean; departed: boolean; view: StockView | null; stock: Record<string, { n: number; nonce: string; state: StockState; keyAgreement: string; expiresAt: string }>; nonce: string | null; nextN: number; revision: number; writers?: Record<string, { revision: number; empty: boolean }>; accepted: Array<{ act: string; at: string }>; confirmed: string[]; budget: number }>
  /** Akte: Id → Hauptzustand, Nebenzustände P, V, K, O mit Kartenwerten, eigene Karte und Übergabedigest, Ablauf, geöffnete Beziehung. */
  acts: Record<string, { state: ActState; pending: Card | null; v: string | null; k: boolean; o: HandOver; ownCard: Card | null; ownCardDigest: string | null; expiresAt: string; opened: string | null }>
  /** Marken des Mediators. */
  consumed: string[]
  /** Pflichten je Paar mit Mapping-Digest. */
  duties: Record<string, { state: string; mappingDigest: string | null }>
  /** K2 Schritt 2: Gerätemengen je Wurzel (Mitglieder und Widerrufene); ohne Mengen (K0, K1a) fehlt das Feld. */
  sets?: Record<string, { members: string[]; revoked: string[]; revs: Record<string, { n: number; digest: string | null }> }>
  /** K2 Schritt 2: der Vorrat öffentlicher Geräteschlüssel je Gerät (Nummer, Empfänger, Zuweisung). */
  pools?: Record<string, Array<{ i: number; for: string; used: string | null }>>
}

const sortKeys = (keys: StockView['keys']) => [...keys].sort((a, b) => a.anchor.localeCompare(b.anchor))

export function project(s: HolderState, now: string): Projection {
  const contacts = s.relationships
    .map((r) => ({
      peers: [...new Set(r.tuples.map((t) => t.peer))].sort(),
      head: head(r).id,
      classOn: r.classOn,
      departed: r.departed,
      view: r.view ? { scope: r.view.scope, revision: r.view.revision, keys: sortKeys(r.view.keys), ...(r.view.writers ? { writers: { ...r.view.writers }, clears: { ...(r.view.clears ?? {}) } } : {}), ...(r.view.revs ? { revs: r.view.revs } : {}) } : null,
      stock: Object.fromEntries(r.stock.map((k) => [k.anchor, { n: k.n, nonce: k.nonce, state: k.state, keyAgreement: k.keyAgreement, expiresAt: k.expiresAt }]).sort(([a], [b]) => (a as string).localeCompare(b as string))),
      nonce: r.nonce,
      nextN: r.nextN,
      revision: r.revision,
      ...(r.writers ? { writers: { ...r.writers } } : {}),
      accepted: [...r.accepted].sort((x, y) => x.act.localeCompare(y.act)),
      confirmed: [...r.confirmed].sort(),
      budget: budgetUsed(r, now),
    }))
    .sort((a, b) => a.peers.join().localeCompare(b.peers.join()))
  const acts: Projection['acts'] = {}
  // P eines abgelehnten Akts ist verdeckt (8325.A3 „P discarded“), bleibt aber im Zustand, falls Regel 2 später für die Zustimmung entscheidet.
  for (const a of [...s.acts].sort((x, y) => x.id.localeCompare(y.id))) put(acts, a.id, { state: a.state, pending: a.state === 'declined' ? null : a.pending, v: a.v, k: a.k, o: a.o, ownCard: a.ownCard, ownCardDigest: a.ownCardDigest, expiresAt: a.expiresAt, opened: a.opened })
  const duties: Projection['duties'] = {}
  for (const d of [...s.duties].sort((x, y) => x.pair.join().localeCompare(y.pair.join()))) put<Projection['duties'][string]>(duties, d.pair.join('|'), { state: d.state, mappingDigest: d.mappingDigest })
  const out: Projection = { contacts, acts, consumed: [...s.consumed].sort(), duties }
  if (s.sets) {
    const sets: NonNullable<Projection['sets']> = {}
    for (const root of Object.keys(s.sets).sort()) {
      const v = setView(own(s.sets, root))
      const set = own(s.sets, root)!
      const revs: Record<string, { n: number; digest: string | null }> = {}
      for (const w of Object.keys(set.revs).sort()) put(revs, w, { n: own(set.revs, w)!.n, digest: own(set.revs, w)!.digest })
      put(sets, root, { members: v.members.map((m) => m.anchor), revoked: [...v.revoked].sort(), revs })
    }
    out.sets = sets
  }
  if (s.pools) {
    const pools: NonNullable<Projection['pools']> = {}
    for (const d of Object.keys(s.pools).sort()) put(pools, d, own(s.pools, d)!.map((k) => ({ i: k.i, for: k.for, used: k.used })))
    out.pools = pools
  }
  return out
}

/** Kanonische Serialisierung (sortierte Schlüssel), damit Gleichheit nicht von der Einfügereihenfolge abhängt. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v)
}

/** Doppel in der Kontaktliste: zwei Beziehungen mit demselben Gegenanker (I-6). */
export function duplicateContacts(s: HolderState): number {
  const seen = new Map<string, number>()
  for (const r of s.relationships) if (!r.departed) for (const peer of new Set(r.tuples.map((t) => t.peer))) seen.set(peer, (seen.get(peer) ?? 0) + 1)
  return [...seen.values()].filter((n) => n > 1).length
}
