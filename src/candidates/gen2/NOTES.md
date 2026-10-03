# Port-Notizen: WoT Gen 2

Stand 03.10.2026. `@web_of_trust/core` 0.6.0 und `@web_of_trust/adapter-yjs`
0.3.0 von npm, `InProcessLogBroker` als Relay im Prozess (Test-Broker,
weicht vom echten Relay ab, siehe unten), `OutboxMessagingAdapter` vor dem
Messaging wie im RLS. Ein Gerät je Person.

## Ergebnisse

| | Ergebnis | Grund |
|---|---|---|
| S1 | bestanden | |
| S2 | bestanden | Relay sperrt die alte Schlüsselgeneration; Carol liest nichts Neues |
| S3 | bestanden | Bob schreibt offline, der Edit wird nach dem Catch-up nachgereicht |
| S4a | bestanden | Bobs gleichzeitiger Eintrag trägt die alte Generation und wird verworfen |
| S4b | nicht bestanden | Bob ist befördert, aber `adapter-yjs` 0.3.0 sendet kein `admin-add` an den Broker; sein `space-rotate` wird nicht angenommen (siehe Befund 1) |
| S4c | bestanden, **formal** | aus demselben Grund kann Bob nicht durchsetzen; gleichzeitige Durchsetzung findet gar nicht statt. Bob selbst sieht danach eine veraltete Mitgliedschaft |
| S4d | nicht abbildbar | keine Rotation ohne Mitgliedschaftsänderung (privat) |
| S4e | nicht abbildbar | keine Gruppenregeln |
| S4f | bestanden, **formal** | Mallorys Kette entsteht offline gar nicht (ohne Relay keine Zustellung); die Entfernung wird nicht gegen eine bestehende Kette geprüft |
| S5 | nicht abbildbar | Zweitgeräte laufen über das PersonalDoc, das im Prozess ein Singleton ist. Speicher zu teilen hieße, genau diesen Weg zu umgehen |
| S6 | bestanden | Einladung trägt alle Generationsschlüssel und einen Snapshot |
| S7 | nicht abbildbar | keine öffentliche Rotation; Angreifer-Zugriff auf Inbox nicht verdrahtet |
| S8 | nicht bestanden | wie S4b: Das Relay erfährt nie von Bobs Beförderung; ohne Alice entfernt niemand wirksam, Dave liest weiter |

S9 (30 Mitglieder, 500 Operationen): Node 15,6 s, davon 7,2 s Warten auf
Ruhe; Headless Chrome 145 13,4 s, davon 7,2 s Warten. Aktive Zeit grob
6 bis 8 s, also etwa 12 bis 17 ms je Operation (Klartext: 0,04 bis 0,08 ms).
Untergrenze, weil auch während des Wartens gearbeitet wird.

## Befunde

1. **Befördete Admins können nicht durchsetzen: Lücke der Implementierung,
   nicht von Gen 2.** Sync 005 verlangt beim Befördern ein `admin-add` an
   den Broker, signiert mit einem bestehenden Admin-Schlüssel
   (`wot-spec/03-wot-sync/005-gruppen.md`, „Neue Admins hinzufügen“). Das
   echte `wot-relay` verarbeitet `admin-add`. `adapter-yjs` 0.3.0 sendet es
   bewusst nicht („KEIN admin-add-Broker-Send (Nicht-Ziel)“ in
   `promoteToAdmin`). Folge, auch im RLS: Nur die Gründerin kann wirksam
   entfernen. Der `InProcessLogBroker` hat zusätzlich keinen Handler für
   `admin-add`; der Prüfstand würde es also auch nach einer Korrektur im
   Adapter erst mit einem passenden Broker zeigen.
2. **Gleichzeitige Durchsetzung bildet der Prüfstand für Gen 2 nicht ab.**
   Gen 2 hat ein Relay; nach der Partition-Konvention bleibt nur eine Seite
   online. S4b und S4c sind deshalb einseitig. Selbst mit `admin-add`
   würde das Relay ordnen (streng `gen+1`, der zweite bekommt
   `GENERATION_TAKEN` und baut neu auf). Gleichzeitigkeit gibt es in Gen 2
   nur als „offline vorgemerkt, später seriell durchgesetzt“.
3. **Ohne Relay keine Gruppe.** Geräte, die nicht am Relay hängen, können
   nicht miteinander reden (kein P2P).
4. **Rotation hängt an der Mitgliedschaft.** Es gibt keine Rotation „einfach
   so“; PCS nach einem erbeuteten Gerät ist damit nicht herstellbar.

## Abweichungen des InProcessLogBroker vom echten Relay

Der Prüfstand nutzt den Test-Broker aus `@web_of_trust/core` 0.6.0, nicht
`wot-relay`. Bekannte Unterschiede:

- `present-capability` wird nicht kryptografisch geprüft, nur als Scope
  vermerkt.
- `admin-add` und andere unbekannte Frames werden ohne Wirkung mit leerem
  Receipt quittiert.
- Inbox-Store-and-Forward liegt im `InMemoryMessagingAdapter` (statische
  Warteschlange), nicht im Broker.

Ein Lauf gegen das echte Relay (`packages/e2e-log-sync`: `RelayServer` mit
`:memory:`-SQLite über WebSocket) wäre die nächste Stufe, wenn eine dieser
Stellen für die Port-Entscheidung wichtig wird.

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
  (Admin-Menge aus `space-register`, laut Spec erweitert per `admin-add`;
  Generations-Sperre). Keine Einhängestelle für fremde Regeln.
- **Schlüssel:** Admin erzeugt den neuen Gruppenschlüssel (AES-GCM) und
  verteilt ihn per ECIES an jedes verbleibende Mitglied; eigene Geräte
  über das PersonalDoc. Zweiphasig: vormerken, Relay bestätigt, dann
  festschreiben.
- **Historie:** Einladung trägt alle bisherigen Generationsschlüssel und
  einen verschlüsselten Snapshot; danach Catch-up über das Relay-Log.
