# Port-Notizen: Consensuals Raummodell nachgebaut (E14b)

Stand 15.10.2026. Gegenstück zu `rltp-mls`: dieselbe MLS-Hülle
(`rust/mls-wasm`, OpenMLS 0.9.1, Ciphersuite 0x0001), aber **kein
Autoritätslog**. Die Mitgliedschaft ist der Baum, ein Blatt je Gerät, so wie
Consensual/Geb einen Raum führt (Quelle: `rltp/design/mls-abgleich-consensual-2026-10.md`,
Abschnitte 2, 4.1, 5). Zwei Committer-Modi, wie ihre Raumpolitik sie kennt:

- **`any-staged`** (`consensual-mls-any-staged`): jedes Mitglied committet
  selbst. Bei gleichzeitigen Commits gewinnt der kleinste Hash (Vertrag aus
  E13, derselbe Tiebreak wie bei ihnen), der Verlierer stellt seine Absicht
  auf der neuen Epoche neu ein (`intents`, `restage`). Kein Zeitfenster: der
  Prüfstand hat keine Uhr; was bei ihnen nach dem Fenster ein Fork wäre, löst
  hier der Rückfall des E13-Vertrags auf.
- **`owner`** (`consensual-mls-owner`): nur der Gründer committet; Mitglieder
  schicken Vorschläge (`propose`), der Gründer setzt sie um, nie gegen sich
  selbst. Das ist das Modell der OpenVTC Rooms und der Registry
  (`rooms/*`: Owner als einziger Committer).

Was dieses Modell **nicht** hat, absichtlich: Politik (kein `policy`), Rollen
als Regel (`roles` ist nur deklariert, damit die Szenarien laufen; Consensual
mit leerer `admins`-Liste), Historie für Neue (Einträge sind unter dem
Exporter ihrer Epoche versiegelt, ein Neuling liest nichts von davor,
Consensual B23), Dienst, Lückenreparatur, Fork-Erkennung als Zustand.

## Ergebnisse

Drei Läufe je Modus (15.10.). „hashabhängig“: das Ergebnis wechselt von Lauf
zu Lauf, weil der kleinste Hash entscheidet. Zum Vergleich `rltp-mls`
(Log + MLS): alle S/T bestanden außer S10 blind, T6b blind, T8/T11.

| | any-staged | owner | rltp-mls | Grund |
|---|---|---|---|---|
| S1–S3 | bestanden | bestanden | bestanden | |
| S4a | bestanden | bestanden | bestanden | Entfernter liest nach dem Zusammenführen nichts |
| S4b | bestanden | bestanden | bestanden | zwei Entfernungen: Verlierer stellt neu ein |
| S4c | bestanden (einer bleibt, Hash entscheidet) | bestanden (Gründer bleibt) | bestanden (beide raus) | A4a verlangt nur Einigkeit |
| S4c2 | nicht bestanden | nicht bestanden | bestanden | Gewinner liest Carols gleichzeitigen Eintrag (LECK) |
| S4d | bestanden | bestanden | bestanden | |
| S4e, S4j | nicht abbildbar | nicht abbildbar | bestanden | keine Gruppenregeln |
| S4f | **hashabhängig** | bestanden | bestanden | ob Mallorys Kette (x, y) bleibt, entscheidet der Hash; im Owner-Modus zählen ihre Vorschläge nicht |
| S5 | nicht bestanden | nicht bestanden | bestanden | zweites Gerät liest weder alt noch neu (Befund „ohne Historie kein CRDT“) |
| S5b, S5c | bestanden | bestanden | bestanden | |
| S6, S6b | nicht bestanden | nicht bestanden | bestanden | keine Historie (B23); auch der nächste Eintrag bleibt unlesbar |
| S7 | bestanden | bestanden | bestanden | PCS über Rotation |
| S8 | bestanden | nicht bestanden | bestanden | ohne Gründer keine Entfernung, Dave liest weiter |
| S10a–c | nicht abbildbar | nicht abbildbar | mit Sicht | kein Dienst |
| S11 | nicht abbildbar | nicht abbildbar | nicht abbildbar | |
| T1 | nicht bestanden | nicht bestanden | bestanden | verschluckter Commit bleibt Lücke, keine Reparatur |
| T2 | **hashabhängig** | bestanden | bestanden | verliert Alices Aufnahme, ist ihr Eintrag für Bob verloren |
| T3, T4, T7, T12 | bestanden | bestanden | bestanden | |
| T5 | nicht bestanden | nicht bestanden | bestanden | beschädigter Rahmen wird verworfen, nicht repariert |
| T6, T6b | nicht bestanden | nicht bestanden | T6 bestanden, T6b mit Sicht | Zurückhalten wird nicht bemerkt |
| T8, T11 | nicht abbildbar | nicht abbildbar | nicht abbildbar | |

## Befunde

- **Ohne Historie kein CRDT.** Ein Neuling (S5 zweites Gerät, S6/S6b) liest
  nicht nur die alten Einträge nicht (das ist Consensuals B23, erwartet),
  sondern auch **keinen neuen**: Yjs-Updates verweisen auf den Eintrag
  davor (Einfügen „nach“ einem Element), und das Element fehlt ihm. Er
  entschlüsselt den neuen Eintrag, kann ihn aber nicht einbauen. Für Zeilen,
  die unabhängig voneinander sind (Consensuals Chat), fällt das nicht auf;
  für einen gemeinsamen Zustand (Karte, Kalender, Board) ist KV4 keine
  Komfortfrage, sondern Voraussetzung. Consensual nennt „CRDT over MLS“ als
  geplante Schicht; ohne Epochen-Kette (OpenVTC `rooms/epoch/chain`, unsere
  Vorgänger-Tabelle) kann sie nicht funktionieren.
- **Verfallene Epoche, verlorener Inhalt.** Verliert ein Commit den Tiebreak,
  sind Einträge, die unter seiner Epoche versiegelt waren, für alle anderen
  unlesbar (T2: Bob liest Alices Eintrag nie). `rltp-mls` versiegelt sie
  neu; dieses Modell hat dafür keinen Ort, Consensual nach unserem Stand
  auch nicht (Zeilen werden nach Zeilen-ID gemischt, nicht neu versiegelt).
- **Der Hash entscheidet über Macht.** S4c (gegenseitige Entfernung): einer
  bleibt, welcher, entscheidet der Hash. S4f (Entfernte lädt gleichzeitig
  ein): ob die Kette der Entfernten bleibt, entscheidet der Hash; das
  Ergebnis wechselt von Lauf zu Lauf. Bei uns entscheidet die Matrix, gleich
  in jedem Lauf.
- **Vertraulichkeit nach Entfernung (S4c2).** Wer die gegenseitige
  Entfernung gewinnt, liest den gleichzeitigen Eintrag des Dritten; bei uns
  liest ihn keiner der beiden.
- **Owner-Modus.** Ohne den Gründer passiert nichts (S8: Alice offline,
  Daves Entfernung bleibt liegen, Dave liest weiter). Ein Mitglied kann
  nicht einmal sein eigenes Gerät nachziehen, es muss vorschlagen. Das ist
  das Modell der OpenVTC Rooms (Owner mit Always-on-VTA).
- **Keine Reparatur, keine Beglaubigung.** Ein verschluckter Commit (T1)
  bleibt eine Lücke, ein zurückgehaltener Eintrag (T6, T6b) wird nicht
  bemerkt. Das sind Dienstfragen, die Consensual an sein Relay delegiert.
- **Was gleich gut läuft:** S1–S3, S4a (Entfernter liest nach dem
  Zusammenführen nichts), S4b, S4d, S5b/S5c im any-staged-Modus, S7 (PCS
  über Rotation), T3 (Doppelzustellung), T4 (Wiederholung), T7, T12.

## Was das Experiment belegen soll

Nicht, dass das Modell schlecht ist, sondern **wo genau** es sich von einem
Log-geführten Raum unterscheidet, Szenario für Szenario. Die Tabelle ist die
Grundlage für die gemeinsame Forschung mit Consensual („was Gruppen und Räume
wirklich brauchen“, Antwort an Day 15.10.).
