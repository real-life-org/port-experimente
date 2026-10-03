import type { Candidate } from '../lab/types'
import { klartext } from './klartext'
import { gen2 } from './gen2'

export interface CandidateEntry {
  readonly id: string
  readonly title: string
  readonly make: () => Candidate
  /** Läufe für den S9-Median; Kandidaten mit eigenem Transport warten auf Ruhe und sind langsam. */
  readonly loadRuns: number
}

export const candidates: CandidateEntry[] = [
  { id: 'gen2', title: 'WoT Gen 2 (@web_of_trust/core 0.6.0, adapter-yjs 0.3.0, Relay im Prozess)', make: gen2, loadRuns: 1 },
  { id: 'klartext', title: 'Klartext (Null-Kandidat, zeigt nur, dass der Prüfstand Fehler erkennt)', make: klartext, loadRuns: 5 },
]
