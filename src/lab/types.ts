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
  | 'steal' // Zustand eines Geräts für den PCS-Test entwenden (S7)

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

/** Ein Kandidat hinter dem Prüfstand. Eine Instanz = eine Gruppe. */
export interface Candidate {
  readonly id: string
  readonly capabilities: ReadonlySet<Capability>
  /** Gesetzt, wenn der Kandidat seinen eigenen Transport mitbringt. */
  readonly transport?: OwnTransport
  /** Räumt Timer und Verbindungen auf. */
  dispose?(): Promise<void>

  /** Legt ein Gerät an. Gehört die Person schon zur Gruppe, soll das Gerät nach Sync mitlesen (S5). */
  addDevice(person: Person, device: Device): Promise<void>
  createGroup(device: Device): Promise<void>
  addMember(by: Device, person: Person, role: Role): Promise<void>
  removeMember(by: Device, person: Person): Promise<void>
  rotate(by: Device): Promise<void>
  changePolicy(by: Device, tag: string): Promise<void>

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
  steal(device: Device): unknown
  /** S7: Kann ein passiver Angreifer mit dem erbeuteten Zustand diese Nachricht entschlüsseln? */
  attackerOpen(stolen: unknown, msg: Msg): Uint8Array | null
}

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
