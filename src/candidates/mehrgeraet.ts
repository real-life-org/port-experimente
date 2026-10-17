import type { MultiDeviceCandidate } from '../lab/mehrgeraet/holder'
import { k0 } from './mehrgeraet-k0'

/** Die Kandidaten des Mehrgeräte-Prüfstands (E15). Eine Fabrik je Kandidat, wie bei den Gruppen-Kandidaten. */
export const multiDeviceCandidates: Array<{ id: string; make: () => MultiDeviceCandidate }> = [{ id: 'k0-one-seed', make: k0 }]
