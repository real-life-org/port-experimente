import type { MultiDeviceCandidate } from '../lab/mehrgeraet/holder'
import { k0 } from './mehrgeraet-k0'
import { k1a } from './mehrgeraet-k1a'

/** Die Kandidaten des Mehrgeräte-Prüfstands (E15). Eine Fabrik je Kandidat, wie bei den Gruppen-Kandidaten. */
export const multiDeviceCandidates: Array<{ id: string; make: () => MultiDeviceCandidate }> = [
  { id: 'k0-one-seed', make: k0 },
  { id: 'k1a-static', make: () => k1a() },
  // Step 6 (variant, Anton 18.10.): the same K1a rules with the journal retained at the self address; an option under study, not the default.
  { id: 'k1a-journal-service', make: () => k1a({ journalAtService: true }) },
]
