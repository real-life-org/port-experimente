# Port-Notizen: Keyhive (Lauf a, Automerge über ARK und Subduction)

Stand 03.10.2026. So, wie Keyhive gedacht ist: `@automerge/automerge-repo-keyhive`
(ARK) 0.6.0-alpha.1 mit dem automerge-repo-Fork 2.6.0-subduction.48,
`@automerge/automerge-subduction` 0.16.1, und ein echter Subduction-Server
(`subduction_cli` 0.18.0, Rust, Release-Binary) als Relay. Eigener Transport:
Der Prüfstand schaltet Geräte nur online/offline; Partition heißt, nur die
erste Gruppe erreicht den Server. Nur in Node und in der CI, der Browser kann
keinen Server starten. Ein Gerät je Person.

Aufbau wie in Lauf b: eine **Admin-Gruppe ist Miteigentümerin des Dokuments**,
Admins kommen in die Gruppe, Mitglieder direkt ans Dokument (siehe Befund 2).

## Ergebnisse

| | Ergebnis | Grund |
|---|---|---|
| S1–S3 | bestanden | |
| S4a | bestanden | Bobs gleichzeitiger Eintrag wird **verworfen** (Alice und Carol sehen ihn nicht), anders als in Lauf b: Der Server nimmt Bobs Blob nach dem Widerruf nicht mehr an |
| S4b | bestanden | gleichzeitige Entfernungen verschiedener Personen: niemand liest mit |
| S4c | nicht bestanden | Bob kann die Gründerin nicht entfernen (Wurzel der Delegationen, wie Lauf b). Dazu Befund 3: Carol sieht Bob weiter als Mitglied |
| S4d | bestanden | `forcePcsUpdate` neben einer Entfernung |
| S4e | nicht abbildbar | keine Gruppenregeln |
| S4f | nicht bestanden | ARK widerruft mit `retain_all_other_members = true`: Wer von Mallory eingeladen wurde, bleibt (x). Offline kann x niemanden einladen, weil x das Dokument nie bekam. Dazu Befund 3 |
| S5 | nicht abbildbar | Person als Gruppe ihrer Geräte, im Prüfstand nicht verdrahtet |
| S6 | bestanden | ARKs „nudge“: Nach jeder Aufnahme ein Edit unter dem neuen Schlüssel, damit das neue Mitglied die Historie lesen kann. Keine App-Kette nötig (Automerge liefert den Inhalts-DAG) |
| S6b | bestanden | |
| S7 | nicht abbildbar | ein Angreifer müsste Sedimentree-Blobs vom Server lesen; nicht verdrahtet |
| S8 | bestanden | Admin entfernt ohne die Gründerin |

Last (Node, inklusive Warten auf Ruhe, deshalb nur grob): S9 (30 Mitglieder,
500 Autoritätsoperationen) 153 s, davon 131 s Warten; läuft durch, anders als
p2panda. S9b (10 Mitglieder, 100 Einträge) 10,5 s, davon 10,1 s Warten. Die
Wartezeit ist durch den Server bestimmt (Keyhive-Zustand im 2-s-Takt), nicht
durch Rechenzeit.

## Befunde

1. **Der Weg zum Server ist unausgesprochen.** ARK braucht die Kontaktkarte
   des Servers vorab (`syncServer: {contactCardJson, peerId}`), der Server
   gibt sie aber nirgends aus: Er erzeugt sie bei jedem Start neu mit
   Zufall, die Ready-Datei enthält nur Port und Peer-ID, ein Entwicklungs-
   Seed ist nicht dokumentiert. Über die Leitung geht es: Ein Bootstrap-Hive
   mit `syncServer: "none"` fragt `RequestContactCard`, der Server antwortet
   mit angehängter Karte, und ARK nimmt sie mit `receiveContactCard` an.
   Der Kandidat fängt sie dort ab. Dazu zwei weitere Stolpersteine: Das
   Subduction-Wasm muss vor ARK initialisiert sein (`initSubduction()`), und
   der Server hasht seinen Socket-String als Service-Namen, der Client den
   Host der URL (Port 0 geht deshalb nicht).
2. **„Admin“ heißt in Keyhive nicht „darf jeden entfernen“.** Ein direkt am
   Dokument eingesetzter Admin darf nur Delegationen widerrufen, die von ihm
   selbst abstammen (`keyhive_core`, `revoke_member`: Nachweis über die
   eigene Delegationskette oder über eine Gruppe, in der man ist). ARKs
   `addMemberToDoc(…, Access.admin())` reicht daher für S4b und S8 nicht
   („keyhive rejected this“). Mit der Admin-Gruppe als Miteigentümerin
   (`generateGroup`, `keyhive.addMember(group, doc, admin)`) bestehen beide.
   Die Gründerin bleibt trotzdem unentfernbar (S4c).
3. **Nicht-Admins sehen Änderungen der Admin-Gruppe nicht.** Wird ein Admin
   aus der Gruppe entfernt (S4c Bob, S4f Mallory), listen die übrigen
   Mitglieder ihn weiter, auch nach 6 s Ruhe. Entfernungen am Dokument (S2,
   S8) kommen bei allen an. Vermutung: Für ein Mitglied, das nicht in der
   Gruppe ist, sind deren Ereignisse in Keyhive nicht „erreichbar“, der
   Server reicht sie ihm nicht weiter. Ob der Entfernte danach noch
   mitlesen kann, prüft S4c nicht; offen.
4. **ARK behält Einladungen eines Entfernten** (`retain_all_other_members =
   true`, S4f). Das ist eine Produktentscheidung von ARK, keine Grenze von
   Keyhive.

## Vergleich der beiden Keyhive-Läufe

| | Lauf a (Automerge, ARK, Subduction) | Lauf b (Yjs, `@keyhive/keyhive`, Prüfstand-Netz) |
|---|---|---|
| S4a Eintrag eines gleichzeitig Entfernten | verworfen (Server) | bleibt sichtbar |
| S4c gegenseitige Entfernung | ✗ (Sicht der Nicht-Admins veraltet) | ✓ |
| S6 Historie direkt nach Aufnahme | ✓ (Nudge) | ✗ (erst nach nächstem Eintrag) |
| S7 PCS | nicht abbildbar | ✓ |
| Historie | Automerge-Commits plus ARK-Hülle | eigene Vorgänger-Kette für Yjs |
| Server | unverzichtbar (Relay, ordnet nicht) | keiner |

Was ein Adapter für Yjs ersetzen muss, zeigt die Differenz: den Inhalts-DAG
für die Vorgänger-Kette (Lauf b baut ihn selbst) und den Nudge nach der
Aufnahme. Alles andere ist in beiden Läufen gleich: Delegationsketten,
BeeKEM, Seniorität der Gründerin.

## Antworten auf die sieben Fragen

- **Ordnung:** Subduction (Sedimentree) ordnet Blobs kausal, Keyhive puffert
  Ereignisse mit fehlenden Abhängigkeiten. Die App muss nichts ordnen.
- **Speicher:** `StorageAdapterInterface` für Repo und ARK (Blobs, Keyhive-
  Archiv und -Ereignisse, Pre-Key-Geheimnisse, PCS-Schlüssel-Hashes).
- **Identität:** Ed25519 je Peer (WebCrypto oder Speicher), Kontaktkarte mit
  Pre-Keys; Karten werden außerhalb des Bandes getauscht.
- **Transport:** ein WebSocket zum Subduction-Server; darüber Blobs
  (Sedimentree) und Keyhive-Ereignisse (SUK-Rahmen). Kein P2P.
- **Autorität:** Delegationsketten, Konflikte nach Seniorität, Kausaltiefe,
  Digest. Der Server prüft Zugriff mit seinem eigenen Keyhive, bevor er
  Blobs annimmt oder herausgibt (S4a). Keine Einhängestelle für eigene Regeln.
- **Schlüssel:** BeeKEM; ARK dreht nach eigenen Aufnahmen (`forcePcsUpdate`
  plus Nudge), nach Widerrufen verlässt es sich auf CGKA.
- **Historie:** Automerge-Commits tragen die Vorgänger, ARK hängt je Blob die
  Schlüssel der Vorgänger an (`blob-interceptor`); ein neues Mitglied liest
  die Historie nach dem Nudge sofort.
