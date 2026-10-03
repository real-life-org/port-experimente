# Port-Notizen: WoT Gen 2

Stand 03.10.2026. `@web_of_trust/core` 0.6.0 und `@web_of_trust/adapter-yjs`
0.3.0 von npm, `InProcessLogBroker` als Relay im Prozess,
`OutboxMessagingAdapter` vor dem Messaging wie im RLS.

## Ergebnisse

| | Ergebnis | Grund |
|---|---|---|
| S1 | bestanden | |
| S2 | bestanden | Relay sperrt die alte Schlüsselgeneration; Carol liest nichts Neues |
| S3 | bestanden | Offline-Edit wird nach dem Catch-up nachgereicht |
| S4a | bestanden | Bobs gleichzeitiger Eintrag trägt die alte Generation und wird verworfen |
| S4b | nicht bestanden | **Befördeter Admin kann nicht durchsetzen**: `promoteToAdmin` wirkt nur im Client („KEIN admin-add-Broker-Send“); das Relay kennt nur den Gründer, Bobs `space-rotate` bleibt vorgemerkt |
| S4c | bestanden | aus demselben Grund: nur Alice (Gründerin) kann durchsetzen, Bobs Entfernung bleibt vorgemerkt; Bob selbst sieht danach eine veraltete Mitgliedschaft |
| S4d | nicht abbildbar | keine Rotation ohne Mitgliedschaftsänderung (privat) |
| S4e | nicht abbildbar | keine Gruppenregeln |
| S4f | bestanden | ohne Relay erreicht Mallorys Einladung niemanden; x kann y nicht einladen |
| S5 | bestanden | PersonalDoc-Sync hier durch geteilten Schlüssel- und Metadatenspeicher ersetzt |
| S6 | bestanden | Einladung trägt alle Generationsschlüssel und einen Snapshot |
| S7 | nicht abbildbar | keine öffentliche Rotation; Angreifer-Zugriff auf Inbox nicht verdrahtet |
| S8 | nicht bestanden | ohne Gründerin kann niemand wirksam entfernen; Dave liest weiter |

S9 (30 Mitglieder, 500 Operationen): Node 15,6 s, davon 7,2 s Warten auf
Ruhe; Headless Chrome 145 13,4 s, davon 7,2 s Warten. Aktive Zeit grob
6 bis 8 s, also etwa 12 bis 17 ms je Operation (Klartext: 0,04 bis 0,08 ms).
Untergrenze, weil auch während des Wartens gearbeitet wird.

## Strukturelle Befunde

1. **Gleichzeitige Durchsetzung entsteht gar nicht.** Das Relay nimmt
   `space-rotate` nur von den beim `space-register` festgelegten Admins
   (= Gründer) an, streng `gen+1`. Durchsetzung ist damit eine Spur mit
   einem Schreiber, genau wie `single-partition` in Gen 3, nur ohne dass es
   jemand so entschieden hätte.
2. **Ohne Relay keine Gruppe.** Geräte, die nicht am Relay hängen, können
   nicht miteinander reden (kein P2P). Eine Partition hat immer genau eine
   Seite mit Relay.
3. **Rotation hängt an der Mitgliedschaft.** Es gibt keine Rotation „einfach
   so“; PCS nach einem erbeuteten Gerät ist damit nicht herstellbar.
4. **Mehrere Geräte über das PersonalDoc**, im Prozess ein Singleton. Für
   den Prüfstand durch geteilten Speicher ersetzt.

## Antworten auf die sieben Fragen

- **Ordnung:** Das Relay ordnet Rotationen total (`gen+1`), Inhalte laufen
  als Log-Einträge je Gerät mit `seq`; der Adapter puffert selbst
  (blocked-by-key, Catch-up).
- **Speicher:** DocLogStore (Log, deviceId, vorgemerkte Entfernungen),
  CompactStore (Snapshots, nicht geloggte Edits), KeyManagement
  (Generationsschlüssel), Metadaten. Vier Speicher je Gerät.
- **Identität:** did:key (Ed25519), X25519 für ECIES; DID-Resolver für
  keyAgreement anderer Mitglieder.
- **Transport:** zwei Wege. Inbox (space-invite, key-rotation,
  member-update; ECIES je Empfänger) und Log-Sync über das Relay
  (log-entry, sync-request, space-register, space-rotate,
  present-capability).
- **Autorität:** Regeln im Client (`_members`-Ereignisse, höhere Generation
  gewinnt, bei Gleichstand `removed`), Durchsetzung beim Relay
  (Admin-Menge aus `space-register`, Generations-Sperre). Keine
  Einhängestelle für fremde Regeln.
- **Schlüssel:** Admin erzeugt den neuen Gruppenschlüssel (AES-GCM) und
  verteilt ihn per ECIES an jedes verbleibende Mitglied; eigene Geräte
  über das PersonalDoc. Zweiphasig: vormerken, Relay bestätigt, dann
  festschreiben.
- **Historie:** Einladung trägt alle bisherigen Generationsschlüssel und
  einen verschlüsselten Snapshot; danach Catch-up über das Relay-Log.
