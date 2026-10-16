import type { WireFactory } from '../../lab/zustellung'
import { labWire } from './lab'
import { tspWire } from './tsp'
import { didcommWire } from './didcomm'

/** Die Drähte des Zustellungs-Prüfstands (E11). */
export const wires: Array<{ id: string; make: WireFactory }> = [
  { id: 'lab', make: labWire },
  { id: 'tsp', make: tspWire },
  { id: 'didcomm-authcrypt', make: () => didcommWire('authcrypt') },
  { id: 'didcomm-anoncrypt', make: () => didcommWire('anoncrypt') },
]
