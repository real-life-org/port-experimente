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
// Faltungsregeln (Tor-Review 2, B4): eine Operation wird beim Anwenden
// geklont, nie verändert; eine Operation gilt erst nach erfolgreicher
// Anwendung als angewandt; Effekte haben eine fachliche Identität (Akt-Id,
// (Beziehung, n), Paar), nicht nur eine Operations-ID; eine vereinigte
// Beziehung bleibt über einen Alias erreichbar.

// ── Parameter (Profil, vereinfacht) ──────────────────────────────────────────

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

/** 8475: eigener Vorrats-Schlüssel (Aussteller). */
export interface StockKey {
  n: number
  anchor: Anchor
  keyAgreement: string // rkid
  key: string // Kontextname (Ableitung beim Kandidaten)
  expiresAt: string
  state: StockState
}

export interface StockView {
  scope: string
  revision: number
  keys: Array<{ anchor: Anchor; keyAgreement: string; expiresAt: string }>
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
  /** 8510: Annahmen (Akt-Id, Zeit); die Bestätigung merkt sich den Zähler (8515). */
  accepted: Array<{ act: string; at: string }>
  confirmedIndex: number
  confirmedAt: string | null
  departed: boolean
  /** Ms Sicht auf den Vorrat dieser Seite (8550 ff.); Marken 8570 holderweit in `consumed`. */
  view: StockView | null
}

export type ActState = 'offered' | 'declined' | 'consented' | 'connected' | 'expired'
/** 8326, vereinfacht: ohne Abfrage/Abgrenzung des Adapters. */
export type HandOver = 'none' | 'intent' | 'handed' | 'taken' | 'delivered' | 'given-up'

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
  /** Digest des eigenen Kartendokuments (die Kennung der Übergabe), gesetzt bei der Übergabe. */
  ownCardDigest: string | null
  /** Beziehung, die 8905 geöffnet hat. */
  opened: string | null
}

/** Ms Akt: nur Produktionsabsicht und Marken (8630). */
export interface MediatorAct {
  id: string
  a: { rel: string; key: Anchor; keyAgreement: string }
  b: { rel: string; key: Anchor; keyAgreement: string }
  issuedAt: string
  expiresAt: string
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
}

export function emptyState(person: string): HolderState {
  return { person, relationships: [], aliases: {}, acts: [], mediatorActs: [], consumed: [], voucherAssigned: [], duties: [], edges: [], effects: [], findings: [], applied: [] }
}

// ── Operationen ──────────────────────────────────────────────────────────────

export type Op = { id: OpId; at: string } & (
  | { kind: 'open-tuple'; rel: string | null; tuple: Tuple; provenance: 'encounter' | 'introduction'; vouchedBy: string | null; act: string | null }
  | { kind: 'class'; rel: string; on: boolean }
  | { kind: 'depart'; rel: string }
  | { kind: 'allocate'; rel: string; nonce: string; keys: StockKey[] } // 8445, 8475.S1–S3 in einem Schritt (Registrierung im Prüfstand sofort)
  | { kind: 'revision'; rel: string; revision: number; keys: Array<{ anchor: Anchor; keyAgreement: string; expiresAt: string }> } // 8500
  | { kind: 'withdraw'; rel: string; anchors: Anchor[] } // 8475.S6
  | { kind: 'age'; rel: string; anchors: Anchor[] } // 8475.S5
  | { kind: 'view'; rel: string; scope: string; revision: number; keys: Array<{ anchor: Anchor; keyAgreement: string; expiresAt: string }> } // M: 8557/6270
  | { kind: 'introduce'; act: MediatorAct } // M: 8605, 8570.2
  | { kind: 'ticket-accept'; act: Act } // 8640.14
  | { kind: 'ticket-refuse-budget'; rel: string; own: Anchor } // 8640.13
  | { kind: 'finding'; text: string }
  | { kind: 'consent'; act: string; card: Card; cardKey: string } // 8325.A4
  | { kind: 'decline'; act: string } // 8325.A3
  | { kind: 'hand-over'; act: string; o: HandOver; digest?: string } // 8326
  | { kind: 'card-pending'; act: string; card: Card; v: string } // 8910.4
  | { kind: 'card-refused'; act: string; v: string; k: boolean } // 8910.6, 8910.8
  | { kind: 'connect'; act: string; rel: string; tuple: Tuple } // 8905
  | { kind: 'expire'; act: string } // 8325.A7/A8
  | { kind: 'budget-confirm'; rel: string } // 8515
  | { kind: 'duty'; pair: [string, string]; state: PairDuty['state']; mappingDigest: string | null } // 6845
  | { kind: 'union'; a: string; b: string; edge: [string, string] } // 6975.2
  | { kind: 'edge'; edge: [string, string] } // 6975.3
)

// ── Hilfen ───────────────────────────────────────────────────────────────────

export const pairKey = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a])

/** Alias-Auflösung (6975.2): die Id eines vereinigten Teils führt zur vereinigten Beziehung. */
export function resolveId(s: HolderState, id: string): string {
  let cur = id
  for (let i = 0; i < 64 && s.aliases[cur]; i++) cur = s.aliases[cur]!
  return cur
}

export function findRel(s: HolderState, id: string): Relationship | undefined {
  const rid = resolveId(s, id)
  return s.relationships.find((x) => x.id === rid)
}

export function rel(s: HolderState, id: string): Relationship {
  const r = findRel(s, id)
  if (!r) throw new Error(`${s.person}: unbekannte Beziehung ${id}`)
  return r
}

export function act(s: HolderState, id: string): Act {
  const a = s.acts.find((x) => x.id === id)
  if (!a) throw new Error(`${s.person}: unbekannter Akt ${id}`)
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
  throw new Error(`${s.person}: unbekanntes Tupel ${tupleId}`)
}

/** 8470: nutzbar, solange now + act-lifetime + act-skew ≤ expiresAt. */
export const usable = (expiresAt: string, now: string) => Date.parse(now) + PARAM.actLifetimeMs + PARAM.actSkewMs <= Date.parse(expiresAt)

/** 8510: Annahmen im Fenster nach der letzten Bestätigung (die Bestätigung merkt sich den Zähler: Ereignisordnung statt Zeitvergleich). */
export function budgetUsed(r: Relationship, now: string): number {
  const since = Date.parse(now) - PARAM.budgetWindowMs
  return r.accepted.slice(r.confirmedIndex).filter((e) => Date.parse(e.at) > since).length
}
export const budgetExhausted = (r: Relationship, now: string) => budgetUsed(r, now) >= PARAM.budget

const effect = (s: HolderState, op: Op, id: string) => {
  if (!s.effects.some((e) => e.id === id && e.op === opKey(op.id))) s.effects.push({ id, op: opKey(op.id), at: op.at })
}

// ── Anwenden (deterministisch, idempotent je Operations-ID und je Effekt) ───

export function apply(s: HolderState, original: Op): void {
  const key = opKey(original.id)
  if (s.applied.includes(key)) return
  const op = structuredClone(original)
  applyBody(s, op)
  s.applied.push(key) // erst nach erfolgreicher Anwendung
}

function applyBody(s: HolderState, op: Op): void {
  switch (op.kind) {
    case 'open-tuple': {
      if (s.relationships.some((r) => r.tuples.some((t) => t.id === op.tuple.id))) return // Effekt-Identität: das Tupel
      if (op.rel) {
        rel(s, op.rel).tuples.push(op.tuple)
      } else {
        s.relationships.push({ id: op.tuple.id, tuples: [op.tuple], provenance: op.provenance, vouchedBy: op.vouchedBy ? [op.vouchedBy] : [], classOn: false, stock: [], nonce: null, nextN: 1, revision: 0, accepted: [], confirmedIndex: 0, confirmedAt: null, departed: false, view: null })
      }
      if (op.act) {
        const a = act(s, op.act)
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
      if (!r.nonce) r.nonce = op.nonce // 8435
      for (const k of op.keys) {
        if (r.stock.some((x) => x.n === k.n || x.anchor === k.anchor)) continue // Effekt-Identität: (Beziehung, n)
        r.stock.push({ ...k, state: 'active' }) // Vorbereitung sofort bestätigt (Prüfstand); 8475.S3 mit der Revision
        r.nextN = Math.max(r.nextN, k.n + 1)
      }
      return
    }
    case 'revision': {
      const r = rel(s, op.rel)
      r.revision = Math.max(r.revision, op.revision) // 8500: Nummern bleiben verbraucht
      effect(s, op, `revision:${r.id}:${op.revision}`)
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
    case 'view': {
      const r = rel(s, op.rel)
      r.view = { scope: op.scope, revision: op.revision, keys: op.keys }
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
      if (s.acts.some((x) => x.id === a.id)) return // Effekt-Identität: der Akt
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
      const a = act(s, op.act)
      if (a.state !== 'offered') return // 8325.A4 nur aus offered; eine Journal-Wiederholung ändert nichts
      a.state = 'consented'
      a.ownCard = op.card
      a.ownCardKey = op.cardKey
      a.o = 'intent'
      effect(s, op, `consent:${a.id}`)
      return
    }
    case 'decline': {
      const a = act(s, op.act)
      if (a.state !== 'offered') return // 8325.A3 nur aus offered
      a.state = 'declined'
      a.pending = null
      effect(s, op, `decline:${a.id}`)
      return
    }
    case 'hand-over': {
      const a = act(s, op.act)
      a.o = op.o
      if (op.digest) a.ownCardDigest = op.digest
      if (op.o === 'taken' && a.ownCard) effect(s, op, `card:${a.id}:${a.ownCard.anchor}`)
      return
    }
    case 'card-pending': {
      const a = act(s, op.act)
      a.pending = op.card
      if (!a.v) a.v = op.v
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
      if (a.opened || s.relationships.some((r) => r.tuples.some((t) => t.id === op.tuple.id))) return // Effekt-Identität: der Akt
      s.relationships.push({ id: op.rel, tuples: [op.tuple], provenance: 'introduction', vouchedBy: [a.mediator], classOn: false, stock: [], nonce: null, nextN: 1, revision: 0, accepted: [], confirmedIndex: 0, confirmedAt: null, departed: false, view: null })
      a.state = 'connected'
      a.opened = op.rel
      a.pending = null
      effect(s, op, `connect:${a.id}`)
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
      const r = rel(s, op.rel)
      r.confirmedAt = op.at
      r.confirmedIndex = r.accepted.length // 8515: Ereignisordnung, nicht Zeitvergleich
      return
    }
    case 'duty': {
      const d = s.duties.find((x) => x.pair[0] === op.pair[0] && x.pair[1] === op.pair[1])
      if (d) {
        if (d.state === 'united' || d.state === 'moot') return // 6845.9: final
        d.state = op.state
        if (op.mappingDigest) d.mappingDigest = op.mappingDigest
      } else s.duties.push({ pair: op.pair, state: op.state, mappingDigest: op.mappingDigest })
      if (op.state === 'sent' && op.mappingDigest) effect(s, op, `mapping:${op.pair.join('+')}:${op.mappingDigest}`)
      return
    }
    case 'union': {
      // 6975.2: Mengenvereinigung; die Identität folgt dem Kopfteil; der andere Teil bleibt als Alias.
      const ra = findRel(s, op.a)
      const rb = findRel(s, op.b)
      if (!s.edges.some((e) => e[0] === op.edge[0] && e[1] === op.edge[1])) s.edges.push(op.edge)
      if (!ra || !rb || ra === rb || ra.departed || rb.departed) return // keine Vereinigung über einen Abgang
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
      for (const e of other.accepted) if (!keep.accepted.some((x) => x.act === e.act)) keep.accepted.push(e) // 6987.6
      keep.confirmedAt = [keep.confirmedAt, other.confirmedAt].filter(Boolean).sort().pop() ?? null
      keep.classOn = keep.classOn && other.classOn // 2160: aus gewinnt
      // 6987.8: Ms Sicht ist die des Kopfteils, sonst keine.
      keep.view = keep === ra ? (headA.record > headB.record ? ra.view : null) : headB.record > headA.record ? rb.view : null
      s.aliases[other.id] = keep.id
      for (const a of s.acts) if (a.mediator === other.id) a.mediator = keep.id // 6987.10
      for (const r of s.relationships) r.vouchedBy = r.vouchedBy.map((v) => (v === other.id ? keep.id : v))
      s.relationships = s.relationships.filter((r) => r !== other)
      effect(s, op, `union:${op.edge.join('+')}`)
      return
    }
    case 'edge': {
      if (!s.edges.some((e) => e[0] === op.edge[0] && e[1] === op.edge[1])) s.edges.push(op.edge)
      const r = relOfTuple(s, op.edge[0])
      if (r) {
        const h = head(r)
        for (const t of r.tuples) t.deactivated = t.id !== h.id
      }
      return
    }
  }
}

// ── Fachliche Projektion (Messgröße, Plan Abschnitt 5; kanonisch, B5) ──────

export interface Projection {
  /** Kontakte: je Beziehung Gegenanker (sortiert), Kopf, Klasse, Abgang, Ms Sicht (Scope, Revision, Schlüsselzahl). */
  contacts: Array<{ peers: string[]; head: string; classOn: boolean; departed: boolean; view: string | null; stock: Record<string, StockState>; budget: number }>
  /** Akte: Id → Hauptzustand und Nebenzustände P, V, K, O. */
  acts: Record<string, { state: ActState; pending: string | null; v: string | null; k: boolean; o: HandOver }>
  /** Marken des Mediators. */
  consumed: string[]
  /** Pflichten je Paar. */
  duties: Record<string, string>
}

export function project(s: HolderState, now: string): Projection {
  const contacts = s.relationships
    .map((r) => ({
      peers: [...new Set(r.tuples.map((t) => t.peer))].sort(),
      head: head(r).id,
      classOn: r.classOn,
      departed: r.departed,
      view: r.view ? `${r.view.scope}@${r.view.revision}:${r.view.keys.length}` : null,
      stock: Object.fromEntries(r.stock.map((k) => [k.anchor, k.state]).sort()),
      budget: budgetUsed(r, now),
    }))
    .sort((a, b) => a.peers.join().localeCompare(b.peers.join()))
  const acts: Projection['acts'] = {}
  for (const a of [...s.acts].sort((x, y) => x.id.localeCompare(y.id))) acts[a.id] = { state: a.state, pending: a.pending?.anchor ?? null, v: a.v, k: a.k, o: a.o }
  const duties: Record<string, string> = {}
  for (const d of [...s.duties].sort((x, y) => x.pair.join().localeCompare(y.pair.join()))) duties[d.pair.join('|')] = d.state
  return { contacts, acts, consumed: [...s.consumed].sort(), duties }
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
