# Port-Notizen: RLTP-Autorität über BeeKEM (E6)

Stand 05.10.2026. Das Experiment zum Schnitt aus der Synthese: **Autorität
bei uns, Schlüsselvereinbarung als Adapter.** Ein minimales Autoritätslog
nach der Konfliktmatrix (`authority.ts`) entscheidet die Mitgliedschaft;
BeeKEM 0.4.0 (Keyhives CGKA als eigene Crate, ohne Keyhives
Delegationsketten) liefert die Schlüssel, über `rust/beekem-wasm`; Yjs die
Inhalte; Historie über die Vorgänger-Kette wie bei Keyhive b. Über das Netz
des Prüfstands, ohne Server. Ein Gerät je Person.

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
| S5 | nicht abbildbar | ein Gerät je Person |
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

## Antworten auf die sieben Fragen

- **Ordnung:** kausal, durch Vorgänger in Autoritätsoperationen und in
  BeeKEM-Operationen; beide Seiten puffern, was Vorgänger vermisst.
- **Speicher:** Autoritätslog, BeeKEM-Zustand (serialisierbar, enthält die
  Blattgeheimnisse), Schlüsseltabelle der Kette.
- **Identität:** Ed25519 je Peer (Mitglieds-ID), X25519-Share-Key als
  Pre-Key; Karte vorab an alle.
- **Transport:** vier Rahmen: Karte, Autoritätsoperation mit angehängten
  BeeKEM-Operationen, lose BeeKEM-Operation (Rotation, Heilung, Update beim
  Schreiben), Inhalt mit Kette. Alle an alle.
- **Autorität:** unser Log; Strong Removal mit gegenseitiger Entfernung als
  Ausnahme; Gründer ohne Sonderrolle. Hier ohne Signaturen und ohne Politik
  (Experiment).
- **Schlüssel:** BeeKEM. Neues Geheimnis je Entfernung, Rotation auf
  Verlangen, Zusammenführung paralleler Geheimnisse über Konfliktschlüssel.
- **Historie:** Vorgänger-Kette in der Replik.
