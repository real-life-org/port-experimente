import { tspDirectWire, type SessionWire } from './tsp-direct'

/** Form (a), E11b step 2: the egress identity is the sender and holds a session of its own; two sessions per relationship and side. */
export function tspDirectEgressSessionWire(): SessionWire {
  return tspDirectWire('egress-session', 'tsp-direct-egress-session', 'TSP Rev 3 direkt, Form (a): Egress-Identität als Absender mit eigener Session, zwei Sessions je Beziehung und Seite')
}

/**
 * Control, not a registered wire: the spec form (adapter spec §5a.10), the egress identity as the sender without a
 * session of its own. Under `SessionCarrier` it is dropped silently (the outcome of D-e live); under the default
 * carrier it would pass, so it is not part of `wires`.
 */
export function tspDirectEgressSpecWire(): SessionWire {
  return tspDirectWire('egress-spec', 'tsp-direct-egress-spec', 'TSP Rev 3 direkt, Spec-Form (Kontrolle): Egress-Identität als Absender ohne eigene Session')
}
