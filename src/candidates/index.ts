import type { Candidate } from '../lab/types'
import { klartext } from './klartext'

export interface CandidateEntry {
  readonly id: string
  readonly title: string
  readonly make: () => Candidate
}

export const candidates: CandidateEntry[] = [
  { id: 'klartext', title: 'Klartext (Null-Kandidat, zeigt nur, dass der Prüfstand Fehler erkennt)', make: klartext },
]
