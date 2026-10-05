# Port-Notizen: RLTP-Autorität über BeeKEM (E6, E7)

Stand 05.10.2026. Das Experiment zum Schnitt aus der Synthese: **Autorität
bei uns, Schlüsselvereinbarung als Adapter.** Ein minimales Autoritätslog
nach der Konfliktmatrix (`authority.ts`) entscheidet die Mitgliedschaft;
BeeKEM 0.4.0 (Keyhives CGKA als eigene Crate, ohne Keyhives
Delegationsketten) liefert die Schlüssel, über `rust/beekem-wasm`; Yjs die
Inhalte; Historie über die Vorgänger-Kette wie bei Keyhive b. Über das Netz
des Prüfstands, ohne Server. Seit E7 mehrere Geräte je Person: ein
BeeKEM-Blatt je Gerät, das Log kennt nur Personen.

## Ergebnisse

| | Ergebnis | Grund |
|---|---|---|
| S1–S3 | bestanden | |
| S4a | bestanden | Bobs Eintrag unter dem alten Schlüssel bleibt lesbar („content residual“), Bob liest nichts Neues |
| S4b | bestanden | zwei Entfernungen gleichzeitig: beide gelten, **niemand liest mit** (KV2, KV6) |
| S4c | bestanden | gegenseitige Entfernung: **beide raus**, alle einig (Entscheidung 2 der Synthese) |
| S4d | bestanden | Rotation neben Entfernung (KV5, KV6) |
| S4e | nicht abbildbar | keine Gruppenregeln im Experiment |
| S4f | bestanden | Strong Removal transitiv: Mallorys Kette ungültig; der Schlüsselbaum wird geheilt |
| S5 | bestanden | zweites Gerät: die Person nimmt ihr eigenes Blatt auf, liest alt (Kette) und neu; die Mitgliederliste zeigt weiter nur Personen |
| S5b | bestanden | Geräteverlust: die Person entfernt ihr Gerät, der Finder liest nach dem Entfernen nichts mehr (KV1), die Person bleibt Mitglied |
| S5c | bestanden | Entfernen der Person entfernt alle ihre Blätter, keines liest Neues |
| S6 | nicht bestanden | Historie erst über die Kette des nächsten Eintrags (wie Keyhive b) |
| S6b | bestanden | |
| S7 | bestanden | passiver Dieb (ganzer Zustand, voller Mitleser) liest nach der Rotation nichts mehr (KV5) |
| S8 | bestanden | Gründerin ohne Sonderrolle |

Last (Node): S9b 0,67 ms je Gerät und empfangener Nachricht (Keyhive b
0,46, p2panda 8,3, Klartext 0,06). S9 (30 Mitglieder, 500 Operationen)
183 ms je Operation, Median aus 3. Das ist langsamer als Keyhive b (51 ms),
und der Grund liegt nicht in BeeKEM: Das Autoritätslog rechnet bei jeder
Operation den Fixpunkt über alle Operationen neu (quadratisch), es ist
nicht optimiert.

## Was das Experiment belegt

Der Schnitt trägt. Mit der Mitgliedschaft von außen und BeeKEM nur für die
Schlüssel besteht der Kandidat alles, was die Pflichtzeile der Matrix
verlangt, einschließlich der drei Punkte, an denen alle anderen Kandidaten
irgendwo scheitern: gleichzeitige Entfernungen (K10), kein Eigentümer (K9),
PCS nach erbeutetem Gerät (K4). Die sechs Invarianten des Schlüssel-Ports
sind damit nicht nur am Kern (`rust/beekem-wasm/tests/peer.rs`), sondern
im Zusammenspiel mit Autoritätsentscheidungen belegt.

Was ein echter Adapter zusätzlich klären muss:

1. **Die Bindung im Log (KV3).** Hier reist die BeeKEM-Operation als Anhang
   der Autoritätsoperation (`cgka` im `auth`-Rahmen), ohne Digest in der
   Operation selbst. Im Guss gehört der Digest in die Durchsetzungsoperation,
   wie heute `contentKeyCommitment`.
2. **Heilung.** Wird eine Aufnahme nachträglich ungültig (Strong Removal),
   steht ihr Blatt schon im Baum. Hier entfernt es jeder Admin, der die
   Abweichung sieht; doppelte Entfernungen sind in BeeKEM No-ops. Im Guss
   ist das eine Pflicht der Durchsetzung: Der Baum folgt der Mitgliedschaft,
   nie umgekehrt.
3. **Replay-Verhalten.** BeeKEM spielt gleichzeitige Strukturänderungen erst
   bei der nächsten eigenen Operation ein; bis dahin zeigt `members()` den
   alten Stand, und ohne gemeinsamen Schlüssel rotiert die nächste
   Verschlüsselung selbst. Der Adapter muss damit rechnen (S4c: „schlüssel=
   nein“ bis zum nächsten Eintrag).
4. **Signaturen und Autorität.** BeeKEM prüft keine Autorität, jeder Signer
   darf entfernen. Das ist für den Schnitt genau richtig, verlangt aber,
   dass nur Operationen aus gültigen Autoritätsentscheidungen in den Baum
   gelangen (hier: `isValid` vor `receive`).
5. **Historie (KV4)** kommt wie bei Keyhive b aus der App-Kette. S6 direkt
   nach der Aufnahme bräuchte den Nudge von ARK (ein Eintrag unter dem neuen
   Schlüssel nach jeder Aufnahme).

## E7: Personen im Log, Geräte im Baum

Die Frage war, ob der Schlüssel-Port Personen oder Geräte als Mitglieder
kennt. Antwort aus dem Experiment: **beides, auf getrennten Ebenen.** Das
Autoritätslog führt Personen (Subjekt von `add`/`remove`, Rollen,
Konfliktmatrix). BeeKEM führt Geräte: ein Blatt je Gerät, weil nur so ein
einzelnes Gerät ohne die Person entfernt werden kann (S5b) und ein
erbeutetes Gerät nicht die Blattgeheimnisse der anderen Geräte derselben
Person preisgibt. Die Brücke ist die Gerätekarte (Person, Mitglieds-ID,
Share-Key), die jedes Gerät vorab an alle sendet.

Drei Regeln haben gereicht:

1. **Aufnahme einer Person** nimmt alle zu dem Zeitpunkt bekannten Blätter
   ihrer Geräte in den Baum (`addMember`).
2. **Eigene Geräte nimmt die Person selbst auf**: Jedes Gerät, das selbst
   im Baum steht und dessen Person Mitglied ist, fügt fehlende Blätter der
   eigenen Geräte hinzu (`ensureOwnLeaves`, nach jeder Karte und jeder
   BeeKEM-Operation). Bedingung ist „steht im Baum“, nicht „hält den
   Schlüssel“: Direkt nach der Gründung hält niemand einen Schlüssel, erst
   der erste Inhalt erzeugt ihn, und bis dahin blieb das Zweitgerät sonst
   außen vor.
3. **Entfernen einer Person** entfernt jedes ihrer Blätter, **Entfernen
   eines Geräts** (`removeDevice`, eigene Person oder Admin) entfernt eines
   und sendet einen Widerruf (`revoke`), damit kein Gerät es später wieder
   aufnimmt und Admins es heilen, falls die Entfernung nicht ankam.

Was das für den Port heißt:

- Der Autoritäts-Port braucht keine Geräte. Mitglied ist eine Person, und
  die Konfliktmatrix bleibt unverändert.
- Der Schlüssel-Port braucht eine Abbildung Person → Geräte und zwei
  Operationen, die es im Autoritätslog nicht gibt: Gerät aufnehmen und Gerät
  entfernen. Beide ändern die Mitgliedschaft nicht, erzeugen aber ein neues
  Geheimnis (KV1 gilt je Blatt, nicht je Person).
- Wer ein Gerät aufnehmen darf, ist eine Autoritätsfrage, die hier ohne
  Signaturen offen bleibt: Im Experiment reicht die Karte mit Personenangabe.
  Im Guss muss ein bestehendes Gerät der Person die Bindung signieren
  (sonst bindet sich ein Fremder an Bobs Namen), und der Widerruf gehört in
  das Log oder in eine signierte Gerätekette, nicht in einen losen Rahmen.
- Historie für das Zweitgerät kommt aus der Kette wie bei neuen Mitgliedern
  (S5 liest „vorher“ erst mit dem nächsten Eintrag). Ein direkter Schlüssel-
  Transfer zwischen den Geräten einer Person (an den Share-Key des neuen
  Geräts) wäre schneller und wäre die Lösung für S6 im Fall Gerätewechsel.
- Offen: zwei Geräte derselben Person nehmen in einer Partition
  gleichzeitig ein drittes auf (doppelte Aufnahme in BeeKEM); hier nicht
  getestet.

## Antworten auf die sieben Fragen

- **Ordnung:** kausal, durch Vorgänger in Autoritätsoperationen und in
  BeeKEM-Operationen; beide Seiten puffern, was Vorgänger vermisst.
- **Speicher:** Autoritätslog, BeeKEM-Zustand (serialisierbar, enthält die
  Blattgeheimnisse), Schlüsseltabelle der Kette.
- **Identität:** Ed25519 je Gerät (Mitglieds-ID im Baum), X25519-Share-Key
  als Pre-Key; Karte mit Personenangabe vorab an alle. Person = Name im Log.
- **Transport:** fünf Rahmen: Karte, Autoritätsoperation mit angehängten
  BeeKEM-Operationen, lose BeeKEM-Operation (Rotation, Heilung, Geräte-
  aufnahme, Update beim Schreiben), Gerätewiderruf, Inhalt mit Kette. Alle
  an alle.
- **Autorität:** unser Log; Strong Removal mit gegenseitiger Entfernung als
  Ausnahme; Gründer ohne Sonderrolle. Hier ohne Signaturen und ohne Politik
  (Experiment).
- **Schlüssel:** BeeKEM. Neues Geheimnis je Entfernung, Rotation auf
  Verlangen, Zusammenführung paralleler Geheimnisse über Konfliktschlüssel.
- **Historie:** Vorgänger-Kette in der Replik.
