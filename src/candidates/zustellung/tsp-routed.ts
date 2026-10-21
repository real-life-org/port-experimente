import { decodeEnvelope, pack, packRouted, unpack } from '@openvtc/vti-tsp-js'
import type { Observation, Party } from '../../lab/zustellung'
import { hopIdentity, type HopIdentity, type RoutedEndpoint, type RoutedWire } from '../../lab/zustellung-routed'
import { admitDirect, relationshipIdentities, type SideIdentities } from './tsp-direct'

// E11b step 3: the routed send form (c) of the plan (§2) as a wire of the bench. Per relationship and side the
// identities of step 2 (connection DID = account, egress identity; carrier-scoped, `relationshipIdentities`). A frame
// is TSP Rev 3 routed (vti-tsp-js 0.3.0): the inner `direct` from the sender's egress identity to the partner's
// connection DID, sealed end to end; the outer layer `packRouted(inner, [partner account], outerSender, hop)` to the
// intermediary's VID. The intermediary (`RoutedIntermediary`, src/lab/zustellung-routed.ts) opens the outer layer and
// forwards the inner frame byte for byte to the partner's account (its pickup). The forms differ in the outer sender:
//   R-c  `tsp-routed`: outer sender = the connection DID (the account, its one session); default.
//   R-es `tsp-routed-egress-session`: outer sender = the egress identity, which holds a session of its own.
//   R-ce (control, not registered): outer sender = the egress identity without a session; dropped by the session rule.

export type RoutedForm = 'c' | 'es' | 'ce'

/** The default intermediary of the bench (fixed seed). */
export const BENCH_HOP = hopIdentity('i1')

const outerOf = (form: RoutedForm, s: SideIdentities) => (form === 'c' ? s.conn : s.egress)
const sessionsOf = (form: RoutedForm, s: SideIdentities) => (form === 'es' ? [s.conn.did, s.egress.did] : [s.conn.did])

export function tspRoutedForm(form: RoutedForm, id: string, title: string, hop0: HopIdentity = BENCH_HOP): RoutedWire {
  return {
    id,
    title,
    role: form === 'ce' ? 'control' : 'form',
    hop: hop0,
    async bind(a, b) {
      const ia = await relationshipIdentities(a, b)
      const ib = await relationshipIdentities(b, a)
      const endpoint = (self: SideIdentities, peer: SideIdentities, who: Party, peerName: string): RoutedEndpoint => {
        let hop = hop0
        // The partner packs to me: inner from its egress identity, outer from its outer identity.
        const wrap = async (inner: Uint8Array, next: string, outer: SideIdentities['conn']) => (await packRouted(inner, [next], outer.did, hop.vid, { senderSigningKey: outer.edSecret, receiverEncryptionKey: hop.xPublic })).bytes
        const innerFrom = async (payload: Uint8Array, sender: SideIdentities['egress'], claimed = sender.did) => (await pack(payload, claimed, self.conn.did, { senderSigningKey: sender.edSecret, receiverEncryptionKey: self.conn.xPublic })).bytes
        return {
          get address() {
            return hop.vid
          },
          account: self.conn.did,
          sender: self.egress.did,
          outerSender: outerOf(form, self).did,
          sessions: sessionsOf(form, self),
          async pack(payload) {
            return wrap(await innerFrom(payload, peer.egress), self.conn.did, outerOf(form, peer))
          },
          async packTo(payload, next) {
            return wrap(await innerFrom(payload, peer.egress), next, outerOf(form, peer))
          },
          async unpack(frame) {
            // The forwarded inner frame, opened only with the expected pair's keys, then the parser rule of step 2
            // (`admitDirect`: revision, sender, receiver, type `direct`, a payload). A routed frame passed through
            // unopened fails at the key already: a rejection at the wire.
            const m = await unpack(frame, { receiverDecryptionKey: self.conn.xSecret, senderSigningKey: peer.egress.edPublic })
            return admitDirect(m, peer.egress.did, self.conn.did)
          },
          async forge(payload, sender) {
            const im = await relationshipIdentities(sender, who)
            return wrap(await innerFrom(payload, im.egress), self.conn.did, outerOf(form, im))
          },
          async forgeAs(payload, sender, claimedSender) {
            const im = await relationshipIdentities(sender, who)
            return wrap(await innerFrom(payload, im.egress, claimedSender), self.conn.did, outerOf(form, im))
          },
          observe(frame): Observation {
            // The receiver's view of the inner frame it collects (the intermediary's view: `RoutedIntermediary.opened`).
            const e = decodeEnvelope(frame)
            const s = e.envelope.sender
            const r = e.envelope.receiver
            const label = (did: string, side: SideIdentities, name: string) => (did === side.conn.did ? `Konto(${name})` : did === side.egress.did ? `Egress(${name})` : did)
            const konto = s === peer.conn.did || r === peer.conn.did || new TextDecoder().decode(frame).includes(peer.conn.did)
            return { absender: label(s, peer, peerName), empfaenger: label(r, self, who.name), konto: konto ? 'sichtbar' : 'verdeckt', revision: String(e.revision), groesse: frame.length }
          },
          rebindHop(next) {
            hop = next
          },
        }
      }
      return { a: endpoint(ia, ib, a, b.name), b: endpoint(ib, ia, b, a.name) }
    },
  }
}

/** Form (c), R-c: outer sender = the connection DID (the account); one session per relationship and side. Default. */
export function tspRoutedWire(): RoutedWire {
  return tspRoutedForm('c', 'tsp-routed', 'TSP Rev 3 routed, Form (c) R-c: innen Egress → Konto des Partners, außen Konto → Intermediär, eine Session je Seite')
}

/** Variant R-es: outer sender = the egress identity with a session of its own; two sessions per side. */
export function tspRoutedEgressSessionWire(): RoutedWire {
  return tspRoutedForm('es', 'tsp-routed-egress-session', 'TSP Rev 3 routed, Variante R-es: außen Egress mit eigener Session, zwei Sessions je Seite')
}

/** Control R-ce (not registered): outer sender = the egress identity without a session; the session rule drops it. */
export function tspRoutedControlWire(): RoutedWire {
  return tspRoutedForm('ce', 'tsp-routed-control', 'TSP Rev 3 routed, Kontrolle R-ce: außen Egress ohne eigene Session')
}
