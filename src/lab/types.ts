// Treiber-Schnittstelle des Prüfstands.
//
// Das ist NICHT der Port, den wir suchen. Sie ist so schmal wie nötig,
// damit dieselben Szenarien jeden Kandidaten bedienen können. Was ein
// Kandidat darüber hinaus von der App braucht (Ordnung, Speicher,
// Identität, Transport), notiert er in seiner NOTES.md. Die Schnittmenge
// dieser Notizen ist das Ergebnis (Plan: rltp/design/port-experimente-2026-10.md).

/** Logische Person. Eine Person kann mehrere Geräte haben (S5). */
export type Person = string
/** Ein Gerät = eine Replik. */
export type Device = string
export type Role = 'admin' | 'member'

/** Optionale Fähigkeiten. Fehlt eine, ist das Szenario „nicht abbildbar“. */
export type Capability =
  | 'roles' // Admin vs. Mitglied
  | 'rotate' // Rotation ohne Mitgliedschaftsänderung
  | 'policy' // Änderung der Gruppenregeln (S4e)
  | 'multi-device' // weiteres Gerät einer bestehenden Person (S5)
  | 'device-remove' // einzelnes Gerät einer Person entfernen, die Person bleibt (S5b)
  | 'steal' // Zustand eines Geräts für den PCS-Test entwenden (S7)
  | 'service' // durchsetzender, schlüsselblinder Dienst am Relay (S10, E8)

/** Eine Nachricht auf der Leitung. Der Prüfstand sieht nur Bytes. */
export interface Msg {
  readonly id: number
  readonly from: Device
  /** Nur zur Protokollierung, nie zur Auswertung. */
  readonly label: string
  readonly body: Uint8Array
}

export interface Received {
  /** Entschlüsselte Inhalts-Updates (hier: Yjs-Updates), in Anwendungsreihenfolge. */
  readonly content: Uint8Array[]
}

/**
 * Kandidaten mit eigenem Transport (z. B. WoT Gen 2 mit Relay, Inbox und
 * Log-Sync) laufen nicht über das Netz des Prüfstands. Sie verwalten ihre
 * Inhalte selbst; der Prüfstand schaltet Geräte nur online/offline.
 * Partition: Nur die erste Gruppe erreicht das Relay, alle anderen sind offline.
 */
export interface OwnTransport {
  setOnline(device: Device, online: boolean): Promise<void>
  /** Wartet, bis der Kandidat zur Ruhe gekommen ist, und aktualisiert members()/read(). */
  settle(): Promise<void>
  write(device: Device, text: string): Promise<void>
  read(device: Device): string[]
  /** Summe der Wartezeit beim Abfragen in settle(), in ms (für S9: aktive Zeit = gesamt − Leerlauf). */
  idleMs(): number
}

/**
 * E8: Ein durchsetzender Dienst am Relay des Prüfstands. Er sieht jeden
 * Rahmen, der über das Relay geht (nie Rahmen innerhalb einer Partition ohne
 * Relay), und entscheidet schlüsselblind: Er kennt Mitgliedschaft, keine
 * Schlüssel. Die Welt ruft `accept` je Rahmen genau einmal, in der
 * Reihenfolge, in der die Rahmen das Relay erreichen.
 */
export interface EnforcingService {
  /** weiter = zustellen; verwerfen = niemand bekommt ihn; behalten = nur der Dienst (an einen). */
  accept(msg: Msg): 'weiter' | 'verwerfen' | 'behalten'
  /** Verdrängung: Bedient der Dienst dieses Gerät noch? (Access §9.3) */
  serves(device: Device): boolean
  /** Rahmen des Dienstes an die Geräte (z. B. Bestätigungen). */
  takeOutgoing(): Array<{ label: string; body: Uint8Array }>
  status(): string
}

/** Ein Kandidat hinter dem Prüfstand. Eine Instanz = eine Gruppe. */
export interface Candidate {
  readonly id: string
  readonly capabilities: ReadonlySet<Capability>
  /** Gesetzt, wenn der Kandidat seinen eigenen Transport mitbringt. */
  readonly transport?: OwnTransport
  /** Gesetzt, wenn ein durchsetzender Dienst am Relay sitzt (Fähigkeit 'service'). */
  readonly service?: EnforcingService
  /** Räumt Timer und Verbindungen auf. */
  dispose?(): Promise<void>

  /** Legt ein Gerät an. Gehört die Person schon zur Gruppe, soll das Gerät nach Sync mitlesen (S5). */
  addDevice(person: Person, device: Device): Promise<void>
  createGroup(device: Device): Promise<void>
  addMember(by: Device, person: Person, role: Role): Promise<void>
  removeMember(by: Device, person: Person): Promise<void>
  rotate(by: Device): Promise<void>
  changePolicy(by: Device, tag: string): Promise<void>
  /** S5b: Entfernt ein einzelnes Gerät (verloren, erbeutet); die Person bleibt Mitglied. */
  removeDevice?(by: Device, device: Device): Promise<void>

  /** Verschlüsselt ein lokales Inhalts-Update und legt es in den Ausgang. */
  sealContent(device: Device, update: Uint8Array): Promise<void>
  /** Entnimmt alle ausgehenden Nachrichten eines Geräts. */
  takeOutgoing(device: Device): Array<{ label: string; body: Uint8Array }>
  receive(device: Device, msg: Msg): Promise<Received>

  /** Mitglieder (Personen), wie dieses Gerät sie sieht; sortiert. */
  members(device: Device): Person[]
  /** Freie Beschreibung des Gruppenzustands für das Protokoll, z. B. „forked“. */
  status(device: Device): string

  /** S7: Kopie des geheimen Zustands eines Geräts (Angreifer erbeutet das Gerät). */
  steal(device: Device): unknown | Promise<unknown>
  /**
   * S7: Ein passiver Angreifer mit dem erbeuteten Gerätezustand sieht allen
   * Verkehr (Nachrichten in Log-Reihenfolge). Liefert die Inhalts-Updates, die
   * er mit dieser Nachricht neu öffnen kann (auch zurückgehaltene ältere).
   */
  attackerOpen(stolen: unknown, msg: Msg): Uint8Array[] | Promise<Uint8Array[]>
}

/** Baut einen Kandidaten; darf asynchron sein (Node-only-Kandidaten werden erst beim Aufruf geladen). */
export type CandidateFactory = () => Candidate | Promise<Candidate>

export type Outcome = 'bestanden' | 'nicht bestanden' | 'nicht abbildbar'

export interface ScenarioResult {
  readonly scenario: string
  readonly title: string
  readonly outcome: Outcome
  /** Ebene Autorität: wer ist Mitglied, was gilt. */
  readonly authority: string
  /** Ebene Schlüssel: wer liest was. */
  readonly keys: string
  readonly ms: number
}
