# Port-Notizen: Zustellung (E11, 16.10.2026)

Der Zustellungs-Prüfstand (`src/lab/zustellung.ts`) prüft Paar-Verkehr:
ein versiegeltes Dokument von Alice an Bob über einen Träger, der speichert
und weiterleitet. Der Kandidat ist der **Draht**: wie der versiegelte
Umschlag adressiert und gerahmt wird. Der **Zusteller** (Sender-Trias nach
Delivery §6.1, mindestens einmal nach §6.3, Bericht vor der Trias) und der
**Empfänger** (Dispositionen nach §6.2 über `receive` der lib, Quittung
`delivery-ack/0.1` signiert und byte-identisch aufbewahrt) sind für alle
Drähte derselbe Code. Keine Uhr: Horizonte sind Runden
(`HORIZON`: Bericht nach 1, Wiederholung nach 3, Aufgeben nach 12).

Drähte:

| Draht | Rahmen | Adresse | Absender für den Träger |
|---|---|---|---|
| `lab` | der lib-Umschlag (`seal`, AES-256-GCM an den rkid) unverändert | rkid des Empfängers | keiner (Einlieferung ohne Absender, §5a.4) |
| `tsp` | TSP Rev 3 direkt (vti-tsp-js 0.3.0): HPKE, Außensignatur | VID des Empfängers (did:key je Beziehung und Seite) | VID des Senders im Klartext-Umschlag |
| `didcomm-authcrypt` | DIDComm v2 JWE, ECDH-1PU+A256KW (vti-didcomm-js 0.12.0) | kid des Empfängers (did:key je Beziehung und Seite) | `skid` im geschützten Header |
| `didcomm-anoncrypt` | DIDComm v2 JWE, ECDH-ES+A256KW | kid des Empfängers | keiner |

Die Identitäten je Beziehung und Seite leiten sich aus einer Saat ab, wie in
`trust-protocol/binding/vti-wire.mjs`; die lib selbst (0.3.2) exportiert
ihren Mediator-Adapter nicht, deshalb ist der Zusteller hier neu geschrieben,
auf die Zusagen hin, die der Port verlangt, nicht auf die Form von 0.79.

## Ergebnisse (16.10., alle Drähte gleich, wo nicht anders vermerkt)

| | Ergebnis | Befund |
|---|---|---|
| T9 Quittung verloren | bestanden | Sender wiederholt dieselben Bytes nach `ackWait`; Empfänger `duplicate-known`, Wirkung einmal, Quittung byte-identisch erneut; `delivered`, nicht `late` |
| T10 Gerät offline, Träger unerreichbar | bestanden | Bericht nach einer Runde: `awaiting-transport(offline)`, dann `(transport-unreachable)`; Empfänger offline ist für den Sender `accepted` (der Träger hat es); danach `delivered` |
| Z1 Was der Träger lernt | bestanden | kein Inhalt, kein Anker, kein Name. lab: rkid, 668 B. TSP: Sender- und Empfänger-VID, 996 B. DIDComm authcrypt: `skid` und kid, 2562 B; anoncrypt: nur kid, 2209 B |
| Z2 Trägerwechsel | bestanden | Wartendes (`awaiting-transport`) geht auf dem neuen Träger hinaus; die Beziehung (rkid, Anker) bleibt; der Draht braucht keine Neuverhandlung |
| Z3 Mehrgerät | bestanden | zwei Geräte unter einer Adresse: der Träger hält den Rahmen, bis jedes registrierte Gerät ihn bestätigt hat; beide quittieren, der Sender nimmt die erste |
| Z4 Fremder Absender | bestanden | lab und anoncrypt: der Rahmen öffnet sich, das Dokument fällt am Beweis (`failed(proof-invalid)`); TSP und authcrypt: der Rahmen öffnet sich nicht (`signature verification failed`, `no recipients[] entry for kid`) |

## Was das Experiment belegt

1. **Die Trias ist Sache des Zustellers, nicht des Trägers (Frage 2).**
   Kein Draht spricht `accepted`, `delivered` oder `awaiting-transport`;
   alle vier liefern dieselbe Zeile, weil der Zusteller sie spricht: aus
   „Träger hat es genommen“ (accepted), aus der verifizierten Quittung
   (delivered), aus dem eigenen Zustand (Bericht). Ein Träger ohne
   speichernden Dritten (direkt, Iroh) änderte daran nichts, nur `accepted`
   fiele mit `delivered` zusammen.
2. **Inbox je Beziehung ist Form, nicht Zusage (Frage 1).** Die Adresse ist
   je Beziehung (rkid, VID, kid), aber der Träger braucht keine Inbox je
   Beziehung: er braucht „Rahmen an eine Adresse halten, bis jedes
   registrierte Gerät bestätigt“. Mehrgerät (Z3) ist eine Eigenschaft der
   Registrierung, nicht der Adresse.
3. **Was der Träger lernt, entscheidet der Draht (Frage 3).** Der
   lib-Umschlag und anoncrypt zeigen nur den Empfänger; TSP und authcrypt
   zeigen auch den Absender, und zwar als Beziehungs-Identität, nicht als
   Anker. Das ist DV4/DV6 am Draht gemessen: verknüpfbar ist je Beziehung
   genau eine Identität, über Beziehungen hinweg keine. Der Preis des
   Absenders im Rahmen: Z4.
4. **Absenderprüfung: am Draht oder am Dokument (Frage neu).** TSP und
   authcrypt weisen einen fremden Absender ab, bevor das Dokument gesehen
   wird; lab und anoncrypt erst am Beweis des Dokuments. Beides hält, aber
   nur die zweite Stufe ist bei uns Pflicht (§5a.4: Einlieferung ohne
   Absender; der Beweis unter dem Anker ist die Absenderprüfung). Ein Port
   darf die Drahtprüfung nicht voraussetzen.
5. **Trägerwechsel ohne Beziehungsverlust (Frage 4)** ist beim Zusteller
   billig, weil nichts an der Beziehung am Träger hängt: Registrierung neu,
   Wartendes neu einliefern.
6. **Größe.** Der Umschlag der lib ist 668 B für ein Dokument von rund 300 B;
   TSP legt 50 % drauf, DIDComm das Dreifache (JSON-JWE, base64url). Alle
   weit unter MT-2240 (16 KB).

## Nicht geprüft, bewusst

- Ein echter Mediator oder Intermediär (VTI-Mediator, DIDComm-Mediator mit
  Pickup): der Träger hier ist das Modell „speichern und weiterleiten mit
  Registrierung“, dasselbe für alle Drähte. Die Live-Probe in
  `trust-protocol/binding` hat den VTI-Mediator am 04.09. bestanden; was ein
  Mediator zusätzlich lernt (Verbindungs-DID, Zeiten), steht in
  `spec/adapter-vti-mediator.md` §9.
- TSP geroutet (Intermediär im Pfad, `packRouted`) und DIDComm `forward`:
  erst, wenn ein Intermediär im Prüfstand sitzt.
- Aufgeben (`failed(expired-by-adapter-policy)`) und späte Quittung
  (`late`): gebaut, nicht als Szenario gepinnt.
