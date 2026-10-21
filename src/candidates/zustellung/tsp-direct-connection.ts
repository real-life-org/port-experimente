import { tspDirectWire, type SessionWire } from './tsp-direct'

/** Form (b), E11b step 2: the connection DID (the account at the carrier) is the sender; one session per relationship and side. */
export function tspDirectConnectionWire(): SessionWire {
  return tspDirectWire('connection', 'tsp-direct-connection', 'TSP Rev 3 direkt, Form (b): Connection-DID (Konto beim Träger) als Absender, eine Session je Beziehung und Seite')
}
