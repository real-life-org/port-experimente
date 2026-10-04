import type { CandidateFactory } from '../lab/types'
import { klartext } from './klartext'
import { gen2 } from './gen2'
import { p2panda } from './p2panda'
import { keyhive } from './keyhive'

export type TransportClass = 'prüfstand-relay' | 'eigener-server'

export const transportLabel: Record<TransportClass, string> = {
  'prüfstand-relay': 'Prüfstand-Relay (blind, setzt nichts durch)',
  'eigener-server': 'eigener Server (kennt Mitgliedschaft, setzt durch)',
}

export interface CandidateEntry {
  readonly id: string
  readonly title: string
  /** Fehlt bei Node-only-Kandidaten in dieser Browser-Registry (Code in node-only.ts). */
  readonly make?: CandidateFactory
  /** Gesetzt, wenn der Kandidat nur in Node läuft (Grund für die Seite). */
  readonly nodeOnly?: string
  /** Läufe für den S9-Median; Kandidaten mit eigenem Transport warten auf Ruhe und sind langsam. */
  readonly loadRuns: number
  /**
   * Transportklasse. Laufzeiten sind nur innerhalb derselben Klasse
   * vergleichbar: Beim eigenen Server steckt in S9 fast nur Warten auf ihn.
   */
  readonly transport: TransportClass
}

export const candidates: CandidateEntry[] = [
  { id: 'gen2', title: 'WoT Gen 2 (@web_of_trust/core 0.6.0, adapter-yjs 0.3.0, Relay im Prozess)', make: gen2, loadRuns: 1, transport: 'eigener-server' },
  { id: 'p2panda', title: 'p2panda-spaces 0.7.1 (WebAssembly, ohne Server)', make: p2panda, loadRuns: 3, transport: 'prüfstand-relay' },
  { id: 'keyhive', title: 'Keyhive 0.3.0-alpha.1 (WebAssembly, Inhalt Yjs, ohne Server)', make: keyhive, loadRuns: 3, transport: 'prüfstand-relay' },
  // Nur Metadaten: Der Code (Automerge-Wasm, Node-Prozesse) bleibt aus dem
  // Browser-Build heraus; die Tests laden ihn über node-only.ts.
  {
    id: 'keyhive-ark',
    title: 'Keyhive über ARK 0.6.0-alpha.1 (Automerge, Subduction-Server 0.18.0 als Relay)',
    loadRuns: 1,
    transport: 'eigener-server',
    nodeOnly: 'braucht einen lokalen Subduction-Server (Rust); läuft in Node und in der CI, nicht im Browser',
  },
  { id: 'klartext', title: 'Klartext (Null-Kandidat, zeigt nur, dass der Prüfstand Fehler erkennt)', make: klartext, loadRuns: 5, transport: 'prüfstand-relay' },
]
