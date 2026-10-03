# Port-Notizen: Keyhive (Lauf b, Yjs)

Stand 03.10.2026. `@keyhive/keyhive` 0.3.0-alpha.1 (Tag `next`), die
WebAssembly-Bindings des Rust-Kerns, ohne Automerge. Inhalt bleibt Yjs. Ohne
Server: alle Nachrichten gehen über das Netz des Prüfstands an alle. Ein Gerät
je Person. Lauf a (Automerge über ARK) folgt getrennt.

Aufbau wie in der README und in ARK: eine **Admin-Gruppe ist Miteigentümerin
des Dokuments**. Admins kommen in die Gruppe, Mitglieder direkt ans Dokument.
Nur so darf ein Admin auch Delegationen widerrufen, die er nicht selbst
ausgestellt hat (sonst „Proof missing to authorize revocation“).

## Ergebnisse

| | Ergebnis | Grund |
|---|---|---|
| S1–S3 | bestanden | |
| S4a | bestanden | Bobs gleichzeitiger Eintrag bleibt für Alice und Carol sichtbar (wie bei p2panda) |
| S4b | bestanden | **gleichzeitige Entfernungen: niemand liest mit** (anders als p2panda) |
| S4c | bestanden | Bob kann die Gründerin nicht entfernen: Sie ist Wurzel aller Delegationen (Seniorität). Alice entfernt Bob |
| S4d | bestanden | `forcePcsUpdate` neben einer Entfernung |
| S4e | nicht abbildbar | keine Gruppenregeln (feste Stufen Relay/Read/Edit/Admin) |
| S4f | nicht bestanden | Mallorys Kette (x, y) bleibt, siehe offene Beobachtung |
| S5 | nicht abbildbar | Person als Gruppe ihrer Geräte gibt es, im Prüfstand noch nicht verdrahtet |
| S6 | nicht bestanden | direkt nach der Aufnahme keine Historie |
| S6b | bestanden | nach dem nächsten Eintrag die ganze Historie, über die Vorgänger-Kette |
| S7 | bestanden | **PCS**: Nach `forcePcsUpdate` öffnet ein Angreifer mit erbeutetem Gerät (Archiv + Signierschlüssel) und vollem Mitlesen nichts mehr. Kein anderer Kandidat kann S7 abbilden |
| S8 | bestanden | ein Admin entfernt ohne die Gründerin |

Last (Node): S9 (30 Mitglieder, 500 Autoritätsoperationen) 25,6 s, 51 ms je
Operation; Headless Chrome 145 im Median 13 s, 26 ms. S9b (10 Mitglieder,
100 Einträge) **0,46 ms je Gerät und Nachricht** (p2panda 8,3 ms, Klartext
0,06 ms).

## Befunde

1. **Historie ist Sache der App.** Keyhive selbst gibt einem neuen Mitglied
   keinen Zugang zu alten Einträgen. ARK baut dafür eine Hülle um jeden
   Eintrag: die Schlüssel der Vorgänger, verschlüsselt mit dem eigenen
   Schlüssel des Eintrags (`blob-interceptor.js`). Die Vorgänger kommen aus
   den Abhängigkeiten der Automerge-Commits. Für Yjs baut der Kandidat diese
   Hülle nach; die Vorgänger sind die seit dem letzten eigenen Eintrag
   gesehenen Einträge. Folge: Historie erst ab dem nächsten Eintrag (S6 ✗,
   S6b ✓). Für unseren Port heißt das: P3 braucht einen **Inhalts-DAG**, den
   bei Yjs der Adapter (oder unser Log) liefern muss.
2. **Gründerin ist nicht entfernbar.** Andere Admins können die Wurzel der
   Delegationen nicht widerrufen (S4c). Das ist Keyhives Seniorität; für
   „die Gruppe gehört sich selbst“ (K9) ist die Gründerin damit dauerhaft
   besonders.
3. **Offene Beobachtung zu Kaskaden.** In unserem Aufbau bleiben Personen,
   die eine später entfernte Admin eingeladen hat, Mitglied und lesen weiter,
   auch ohne Gleichzeitigkeit und mit `retain_all_other_members = false`.
   Die Design-Doku verspricht eine Kaskade. Ob das ein Fehler ist oder am
   verschachtelten Aufbau (Gruppe als Miteigentümerin) liegt, ist nicht
   geklärt.

## Antworten auf die sieben Fragen

- **Ordnung:** Keyhive puffert selbst. `ingestEventsBytes` hält Ereignisse
  mit fehlenden Abhängigkeiten zurück. Inhalte puffert der Kandidat, bis sie
  sich entschlüsseln lassen. Ereignisse, die beim Aufnehmen fremder
  Ereignisse entstehen, werden nicht weitergeleitet (wie ARK, sonst Echo).
- **Speicher:** Keyhive-Archiv (`toArchive`), Ciphertext-Store, Pre-Key-
  Geheimnisse; dazu beim Kandidaten die Schlüsseltabelle der Einträge.
- **Identität:** Ed25519-Signierschlüssel je Peer; Kontaktkarte (mit
  Pre-Keys) muss vor der Einladung vorliegen. Abbildung auf did:key: offen
  (beides Ed25519).
- **Transport:** drei Arten: Kontaktkarten, Keyhive-Ereignisse
  (Delegationen, Widerrufe, CGKA-Operationen, Pre-Keys) und Inhalte in der
  Hülle. Alle an alle.
- **Autorität:** Delegationsketten (convergent capabilities), Konflikte nach
  Seniorität, Kausaltiefe, Digest. Keine Einhängestelle für eigene Regeln.
- **Schlüssel:** BeeKEM. Neuer Schlüssel bei Entfernung, `forcePcsUpdate`
  für Rotation ohne Mitgliedschaftsänderung, PCS nachgewiesen (S7).
- **Historie:** über die Vorgänger-Kette in der Replik, nicht über die
  Einladung. Das ist die Form, die Access §9.4 („causal encryption“) als P3
  vorsieht, nur dass die Kette außerhalb von Keyhive gebaut werden muss.
