import type { Endpoint, Observation, Party, Wire } from '../../lab/zustellung'

// Draht „Prüfstand“: der versiegelte lib-Umschlag geht unverändert über den
// Träger; Adresse = der Beziehungsschlüssel des Empfängers (rkid), sonst
// nichts (Einlieferung ohne Absender, Delivery §5a.4).
const dec = new TextDecoder()

export function labWire(): Wire {
  const endpoint = (self: Party): Endpoint => ({
    address: self.rkid,
    async pack(payload) {
      return payload
    },
    async unpack(frame) {
      return frame
    },
    async forge(payload) {
      return payload // kein Absender im Rahmen: der Draht kann ihn nicht prüfen, das Dokument muss es
    },
    observe(frame): Observation {
      try {
        const env = JSON.parse(dec.decode(frame)) as { rkid?: string }
        return { empfaenger: env.rkid ?? '?', absender: 'keiner', groesse: frame.length }
      } catch {
        return { groesse: frame.length }
      }
    },
  })
  return {
    id: 'lab',
    title: 'Prüfstand-Umschlag (lib seal, Adresse = rkid, kein Absender)',
    async bind(a, b) {
      return { a: endpoint(a), b: endpoint(b) }
    },
  }
}
