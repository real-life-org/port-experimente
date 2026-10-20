import type { MultiDeviceCandidate } from '../lab/mehrgeraet/holder'
import { k0 } from './mehrgeraet-k0'
import { k1a } from './mehrgeraet-k1a'
import { k2 } from './mehrgeraet-k2'

/** Die Kandidaten des Mehrgeräte-Prüfstands (E15). Eine Fabrik je Kandidat, wie bei den Gruppen-Kandidaten. */
export const multiDeviceCandidates: Array<{ id: string; make: () => MultiDeviceCandidate }> = [
  { id: 'k0-one-seed', make: k0 },
  { id: 'k1a-static', make: () => k1a() },
  // Step 6 (variant, Anton 18.10.): the same K1a rules with the journal retained at the self address; an option under study, not the default.
  { id: 'k1a-journal-service', make: () => k1a({ journalAtService: true }) },
  // K2 step 2a (Anton 18.10./19.10./20.10., plan 6o.5, 6r, 6t): device keys, device-set@1 from proofs, one card per act from
  // the allocating device (E2 (iv)), stock keys per device (strict); M runs as a single-writer fixture (one device).
  { id: 'k2-device-keys', make: () => k2() },
]
