import type { WireFactory } from '../../lab/zustellung'
import { labWire } from './lab'
import { tspWire } from './tsp'
import { didcommWire } from './didcomm'
import { tspDirectConnectionWire } from './tsp-direct-connection'
import { tspDirectEgressSessionWire } from './tsp-direct-egress-session'
import type { RoutedWireFactory } from '../../lab/zustellung-routed'
import { tspRoutedEgressSessionWire, tspRoutedWire } from './tsp-routed'

/** Die Drähte des Zustellungs-Prüfstands (E11; E11b Schritt 2: die direkten Sendeformen (b) und (a)). */
export const wires: Array<{ id: string; make: WireFactory }> = [
  { id: 'lab', make: labWire },
  { id: 'tsp', make: tspWire },
  { id: 'tsp-direct-connection', make: tspDirectConnectionWire },
  { id: 'tsp-direct-egress-session', make: tspDirectEgressSessionWire },
  { id: 'didcomm-authcrypt', make: () => didcommWire('authcrypt') },
  { id: 'didcomm-anoncrypt', make: () => didcommWire('anoncrypt') },
]

/**
 * E11b step 3: the routed form (c) and its variant. A list of its own, not in `wires`: the core scenarios take
 * `endpoint.address` as the pickup, on the routed wire it is the intermediary's VID; the routed cells run through
 * `runRouted` (src/lab/zustellung-routed.ts). The control R-ce is not registered.
 */
export const routedWires: Array<{ id: string; make: RoutedWireFactory }> = [
  { id: 'tsp-routed', make: tspRoutedWire },
  { id: 'tsp-routed-egress-session', make: tspRoutedEgressSessionWire },
]
