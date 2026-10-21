import type { WireFactory } from '../../lab/zustellung'
import { labWire } from './lab'
import { tspWire } from './tsp'
import { didcommWire } from './didcomm'
import { tspDirectConnectionWire } from './tsp-direct-connection'
import { tspDirectEgressSessionWire } from './tsp-direct-egress-session'

/** Die Drähte des Zustellungs-Prüfstands (E11; E11b Schritt 2: die direkten Sendeformen (b) und (a)). */
export const wires: Array<{ id: string; make: WireFactory }> = [
  { id: 'lab', make: labWire },
  { id: 'tsp', make: tspWire },
  { id: 'tsp-direct-connection', make: tspDirectConnectionWire },
  { id: 'tsp-direct-egress-session', make: tspDirectEgressSessionWire },
  { id: 'didcomm-authcrypt', make: () => didcommWire('authcrypt') },
  { id: 'didcomm-anoncrypt', make: () => didcommWire('anoncrypt') },
]
