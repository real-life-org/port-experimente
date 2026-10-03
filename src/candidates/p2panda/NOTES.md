# Port-Notizen: p2panda

Stand 03.10.2026. `p2panda-spaces` 0.7.1 (mit `p2panda-auth`,
`p2panda-encryption`, `p2panda-core`) als WebAssembly über
`rust/p2panda-wasm`. Gepatchte Kopien unter `rust/p2panda-wasm/vendor/`
(nur Feature-Definitionen und `web-time` statt `std::time`, siehe dort).
Ohne Server: alle Nachrichten gehen über das Netz des Prüfstands an alle.
Ein Gerät je Person.

## Ergebnisse

| | Ergebnis | Grund |
|---|---|---|
| S1 | bestanden | |
| S2 | bestanden | Entfernen erzeugt ein neues Geheimnis; Carol liest nichts Neues |
| S3 | bestanden | |
| S4a | bestanden | Bobs gleichzeitiger Eintrag bleibt für Alice und Carol **sichtbar**: Strong Removal betrifft Gruppenoperationen, nicht Inhalte, die mit dem alten Geheimnis verschlüsselt sind (wie die „content residual“ in RLTP Gen 3) |
| S4b | nicht bestanden | **Befund 1**: nach gleichzeitigen Entfernungen liest einer der Entfernten mit |
| S4c | bestanden | gegenseitige Entfernung: beide raus, alle einig |
| S4d | nicht abbildbar | keine Rotation ohne Mitgliedschaftsänderung (`SpaceUpdate` in 0.7.1 nicht umgesetzt) |
| S4e | nicht abbildbar | keine Gruppenregeln (feste Stufen Pull/Read/Write/Manage) |
| S4f | bestanden | Mallorys Kette (x, y) wird transitiv ungültig |
| S5 | nicht abbildbar | Geräte als verschachtelte Gruppen gibt es, im Prüfstand noch nicht verdrahtet |
| S6 | bestanden | Willkommensnachricht trägt die bisherigen Geheimnisse (siehe Befund 2) |
| S7 | nicht abbildbar | keine Rotation, kein Angreifer-Zugriff verdrahtet |
| S8 | bestanden | ein Admin entfernt ohne die Gründerin |

S9 (30 Mitglieder, 500 Autoritätsoperationen) bricht ab, sobald der Space
vier Entfernungen hinter sich hat (Befund 2). Bis dahin 70 bis 100 ms je
Operation (Node, Headless Chrome 145).

S9b (10 Mitglieder, 100 verschlüsselte Einträge): 7,5 s in Node, also
**8,3 ms je Gerät und empfangener Nachricht** (Klartext 0,06 ms). Die
Kosten je Gerät wachsen etwa linear mit der Gruppengröße (5 Mitglieder
4,5 ms, 10: 6,7 ms, 20: 16 ms je Gerät und Nachricht). Vermutung, nicht
profiliert: Nach jeder Nachricht wird der ganze Space-Zustand serialisiert
und gespeichert (so auch der SQLite-Speicher von p2panda).

## Befunde

1. **Gleichzeitige Entfernungen verschiedener Personen lassen einen
   Entfernten mitlesen.** Alice entfernt Carol, Bob entfernt gleichzeitig
   Dave. Jeder verteilt ein neues Geheimnis an die Mitglieder aus seiner
   Sicht, also auch an die Person, die der andere entfernt. Nach dem
   Zusammenführen stimmt die Mitgliedschaft ({Alice, Bob}), aber die Gruppe
   verschlüsselt weiter mit einem Geheimnis, das Carol oder Dave kennt
   (welche von beiden, wechselt zwischen Läufen). Eine Reparatur verlangt
   p2panda nicht. Aufnehmen heilt es nicht (kein neues Geheimnis), erst die
   nächste Entfernung. Nativ nachgestellt:
   `rust/p2panda-wasm/tests/peer.rs`,
   `befund_gleichzeitige_entfernungen_einer_liest_mit`.
2. **Nach vier Entfernungen kann der Space niemanden mehr aufnehmen.** Die
   Willkommensnachricht an ein neues Mitglied trägt alle bisherigen
   Gruppengeheimnisse (für die Historie); jede Entfernung fügt eines hinzu
   (+ etwa 150 Bytes). `p2panda-core` dekodiert Header aber nur mit
   Byte-Folgen bis 512 Bytes (`operation/any.rs`, `length_limit(512)`).
   Ab der vierten Entfernung lehnt das neue Mitglied die eigene
   Aufnahme-Nachricht ab. Gilt auch für die Wiederaufnahme. Offen: ob
   Apps durch Löschen alter Schlüssel (laut README für Forward Secrecy
   vorgesehen) darunter bleiben. Nativ: `befund_aufnahme_scheitert_nach_mehreren_entfernungen`.
3. **Im Browser fehlte nur wenig.** Speicher-Traits ohne SQLite (Features)
   und `web-time` statt `std::time`. Danach läuft `p2panda-spaces`
   unverändert in WebAssembly.

Beide Befunde gehen an p2panda erst nach Antons Entscheidung.

## Antworten auf die sieben Fragen

- **Ordnung:** Die App muss liefern. `Manager::process` erwartet
  Nachrichten „signature-checked, dependency-checked & partially ordered“.
  Die Hülle prüft die Signatur, legt ab und hält Nachrichten zurück, bis
  ihre Abhängigkeiten (`auth_dependencies`, `space_dependencies`,
  `auth_message_id`) verarbeitet sind. Im vollen Stack macht das
  `p2panda-stream`.
- **Speicher:** fünf Traits (Spaces, Spaces-Nachrichten, Gruppen,
  Key-Registry, Key-Secrets) plus `Transaction`. Die App speichert die
  Zustände, die `create_space`, `add`, `remove`, `publish` und `process`
  zurückgeben, selbst und hält damit die Transaktionsgrenze.
- **Identität:** Ed25519-Schlüssel je Peer (Akteurs-ID = öffentlicher
  Schlüssel), dazu X25519-Pre-Keys. Abbildung auf did:key: noch offen.
- **Transport:** eine Nachrichtenart, signierte p2panda-Operationen
  (Header mit Spaces-Argumenten). Alle Nachrichten an alle; Key-Bundles
  müssen vor der Aufnahme vorliegen.
- **Autorität:** Gruppen-CRDT mit festen Stufen; Konfliktauflösung über
  einen austauschbaren Resolver (`StrongRemoveResolver`). Befördern kennt
  `p2panda-auth` (`Promote`), `p2panda-spaces` bietet es nicht an; die
  Rolle wird beim Aufnehmen vergeben.
- **Schlüssel:** DCGKA im Data Scheme: neues Geheimnis bei jeder
  Entfernung, Verteilung per Direktnachrichten in der
  Mitgliedschaftsnachricht. Kein Rotieren ohne Mitgliedschaftsänderung.
- **Historie:** über die Willkommensnachricht (alle Geheimnisse), nicht
  über die Replik. Das ist genau der Punkt, den Access §9.7 für P3
  verschieben wollte, und die Ursache von Befund 2.
