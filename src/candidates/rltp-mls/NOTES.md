# Port-Notizen: RLTP-Autorität über MLS (E13)

Stand 14.10.2026. Dritte Variante des Schlüssel-Ports: dieselbe Autorität,
dieselben Rahmen und derselbe Kandidatencode wie `rltp-beekem`
(`rltpBeekem({ keyPort: 'mls' })`), darunter MLS (RFC 9420) über OpenMLS
0.9.1 in `rust/mls-wasm` statt BeeKEM. Die Schnittstelle, die beide
erfüllen, steht in `../rltp-beekem/keyport.ts` (`KeyPeer`, `KeyPort`).

MLS liegt **unter** dem Autoritätslog: Commits werden aus Logeinträgen
abgeleitet (Aufnahme, Entfernung, Rotation, Heilung), nie umgekehrt
(Access §9.1). Mitgliedschaft entscheidet die Matrix; MLS liefert je Epoche
ein Exporter-Geheimnis, daraus den Eintragsschlüssel je Referenz
(SHA-256 über Label, Exporter, Referenz). Die Vorgänger-Tabelle der
versiegelten Rahmen und die Lückenreparatur sind unverändert.

## Ergebnisse

Alle S- und T-Szenarien wie bei `rltp-beekem` (vier Läufe in Folge, kein
Flackern); Erwartungen in `tests/rltp-mls.test.ts`.

| | Ergebnis | Grund |
|---|---|---|
| S1–S8, S4a–S4j, S5–S5c, S6, S6b | bestanden | wie BeeKEM |
| S4b, S4d, S4j | bestanden | gleichzeitige Commits: Tiebreak (unten), Heilung holt nach |
| S7 | bestanden | PCS nur über die ausdrückliche Rotation; MLS rotiert beim Schreiben nicht (BeeKEM: `updateOp` je Eintrag) |
| S10a–c | nicht abbildbar (blind) / wie BeeKEM mit `rltp-mls-sichten` (S10c nur mit m nach der neuen Sicht) | Dienstvarianten sind vom Schlüssel-Port unabhängig |
| T1–T7, T12 | bestanden | wie BeeKEM |
| T6b | nicht bestanden (blind) / bestanden (Sicht) | wie BeeKEM (D5) |
| T8, T11 | nicht abbildbar | wie BeeKEM |

## Was anders ist als bei BeeKEM

**Linear.** MLS kennt je Epoche genau einen Commit. BeeKEM führt
gleichzeitige Operationen zusammen; MLS muss wählen. Folgen für den
Kandidaten (alles in `index.ts` unter `port.linear`):

1. **Ein Heiler je Gruppe.** Bei BeeKEM heilt jedes Mitglied mit Schlüssel
   (fehlende Blätter nachziehen, fremde entfernen); gleichzeitige Heilungen
   verschmelzen. Bei MLS verlören sie den Tiebreak gegeneinander. Deshalb
   heilt nur das Mitglied mit der kleinsten Personenkennung unter den
   Mitgliedern laut Log; jede Person zieht ihre eigenen weiteren Geräte
   selbst nach (sonst kollidierten Heiler und Person). Das ist KV6 über
   Heilung, wie bei linear/0.1 vorgesehen.
2. **Angleichen nach jedem Commit.** Ein fremder Commit kann den Baum vom
   Log wegbewegen (verlorener Tiebreak); bei BeeKEM genügt Angleichen nach
   Autoritätsoperationen und vor dem Schreiben, bei MLS läuft `reconcile`
   auch nach jedem `cgka`-Rahmen.
3. **Willkommen.** MLS kennt keinen Beitritt ohne Willkommen; es reist im
   `welcome`-Rahmen des Kandidaten (Feld `key`), an den Willkommensschlüssel
   der Karte verschlüsselt, zusammen mit Gruppe und Aufnahme. Dazu der
   Digest des Commits, der den Neuen aufgenommen hat (Feld `commit`): für
   MLS ist dieser Commit nach dem Willkommen nicht mehr verarbeitbar
   (`stale`), für den Kandidaten ist er der Schlüsselstand des Neuen
   (`keyOp` seiner nächsten Rahmen, Öffnungs-Gate bei den anderen).
   Ein entferntes Gerät (Gruppe inaktiv) puffert Commits wie eines ohne
   Gruppe, bis ein Willkommen es wieder aufnimmt.
4. **Keine Rotation beim Schreiben.** PCS (KV5) nur über `rotate`.

**Vertrag zur Epochenwahl** (`rust/mls-wasm/src/peer.rs`, Kopf der Datei):

1. Commits bilden einen Baum über Epochen; je Epoche gilt der mit dem
   kleinsten Hash, für alle Repliken gleich, unabhängig von der
   Reihenfolge; nur über Schlüssel, nie über Mitgliedschaft.
2. Jede Replik hält Momentaufnahmen der letzten 8 verlassenen Epochen. Ein
   Commit auf eine verlassene Epoche wird gegen deren Momentaufnahme
   geprüft: kleinerer Hash als der dort angewandte → Rückfall auf diese
   Epoche, Commit nehmen, `lost`; sonst `stale`. Tiefer als die
   Momentaufnahmen reichen → `stale` (nicht mehr auflösbar, Befund).
3. Was nach einem Rückfall fehlt, stellt die Heilung aus dem Log wieder
   her. Rahmen, die unter einer verfallenen Epoche versiegelt wurden,
   sind für alle anderen unlesbar; ihr Autor versiegelt sie nach der
   Angleichung neu (`sealed`/`stranded` in `index.ts`).
4. Ein Willkommen auf eine höhere Epoche als die eigene ersetzt die eigene
   Gruppe (`reset`: sie stand auf einem verfallenen Zweig); alles seit dem
   Beitritt Versiegelte geht neu hinaus. Ein Willkommen auf eine inaktive
   Gruppe (nach Entfernung) nimmt wieder auf; ein gleich altes oder älteres
   ändert nichts.

Befunde hinter dem Vertrag (T2 flackerte in einem von vier Läufen, bevor
er stand):

- Alice nimmt Dave auf, Bob entfernt gleichzeitig Carol. Verliert Alices
  Commit, sind ihre Aufnahme (versiegelt unter der verfallenen Epoche) und
  Daves Willkommen tot: Bob sieht Dave nie, Dave hängt auf einem Zweig, den
  niemand sonst kennt (Punkt 3 und 4).
- Dieselbe Epochennummer heißt nicht derselbe Vorgänger. Alices Heilung
  nach dem Rückfall (Epoche 3→4 auf dem gültigen Zweig) und ihr früherer
  Commit auf dem verfallenen Zweig (auch 3→4) sind keine Geschwister; wer
  sie nur über die Nummer vergleicht, fällt auf den falschen Zweig und
  kommt nicht wieder heraus (Bob: Baum ohne Dave, Commit wartet ewig).
  Deshalb die probeweise Anwendung mit Rücknahme (Punkt 2).
- Mit nur einer Momentaufnahme (eine Epoche zurück) wäre eine Replik, die
  vor dem Geschwister-Commit schon zwei eigene Commits gemacht hat,
  dauerhaft abgespalten.
- Der Commit, der den Neuen aufgenommen hat, lässt sich über die
  Epochennummer nicht erkennen: nach einem `reset` hielt Dave einen
  Commit vom verfallenen Zweig (gleiche Nummer) für den seinen, trug ihn
  als `keyOp`, und Bob öffnete Daves Einträge nie. Deshalb trägt das
  Willkommen den Digest des Commits (Punkt 3 oben), statt dass der Peer
  rät. Und ein entferntes Gerät verwarf den Commit seiner Wiederaufnahme
  als `stale` (Gruppe inaktiv, gleiche Epoche): S4j, Carol sah das
  Fork-Ende nicht.
- Kandidatenseitig: `noteOp` war nicht idempotent. Eine Reparaturantwort
  sendet alte Schlüsseloperationen noch einmal; der Empfänger verbuchte
  sie erneut und trug fortan diese alte Operation als `keyOp` seiner
  Rahmen. Ein Neuling, der sie nie angewandt hat (bei MLS sind Commits vor
  dem Beitritt `stale`), versuchte diese Rahmen nie zu öffnen (T2: Dave
  liest Bobs Eintrag nicht; S4j: Carol sieht das Fork-Ende nicht). Bei
  BeeKEM blieb das verdeckt, weil dort jeder Rahmen mit einer eigenen
  Operation kommt und der Baum alte Operationen aufnimmt.

## Befunde

- **KeyPackage-Wiederverwendung.** MLS sieht ein KeyPackage als einmalig
  vor; die Karte des Prüfstands trägt eines als Share-Key, und eine
  Wiederaufnahme (S4j, T4) nutzt dieselbe Karte. Der Peer legt das
  verbrauchte Bündel nach dem Beitritt wieder in den Speicher
  (`restore_key_package`). In der Praxis braucht eine Wiederaufnahme eine
  frische Karte oder einen KeyPackage-Vorrat beim Dienst.
- **Willkommen-Größe gegen RLTP-MT-2240 (16 KB).** Gemessen mit
  Ratchet-Tree-Extension (der Neue braucht keinen Dienst, der den Baum
  hält): 839 B bei 1 Mitglied, 2,7 KB bei 10, 6,5 KB bei 30, etwa 190 B je
  weiterem Mitglied; die 16 KB wären bei rund 80 Mitgliedern erreicht.
  Commits: 735 B bis 3,3 KB (30 Mitglieder). Versiegelter Eintrag von
  100 B Klartext: 184 B. Peer-Zustand bei 30 Mitgliedern: 47 KB.
- **Wasm-Größe.** `mls_wasm_bg.wasm` 2,6 MB gegen 0,97 MB bei BeeKEM.
- **Mehrere Commits vor dem Geschwister.** Der Tiebreak setzt voraus, dass
  die verlorene Epoche noch als Momentaufnahme vorliegt (8 zurück). Eine
  Replik, die länger offline Commits sammelt, bleibt abgespalten, bis sie
  wieder willkommen geheißen wird (`reset`). Im Prüfstand nicht
  aufgetreten.
- **S9-Last.** 30 Mitglieder × 100 Operationen: etwa 290 ms je Operation
  (BeeKEM-Kandidat etwa ein Zehntel); jede Aufnahme ist ein Commit über die
  ganze Gruppe, und jeder Commit wird einmal als Momentaufnahme kopiert.
  Deshalb `loadSize` 30 × 100.

## Aufbau

- `rust/mls-wasm/src/peer.rs`: `Peer` (OpenMLS-Gruppe, Exporter je Epoche,
  Momentaufnahmen, eigene Commit-Digests), `rust/mls-wasm/src/wasm.rs`:
  `MlsPeer`-Bindings mit derselben Oberfläche wie `beekem-wasm`
  (synchron, Fehler als `Error`).
- `rust/mls-wasm/tests/peer.rs`: Lebenszyklus mit Diebstahl und Rotation;
  gleichzeitige Commits mit Unbeteiligten; Rückfall über mehrere Epochen;
  Commit vom anderen Zweig ist kein Geschwister; Willkommen ersetzt
  verfallenen Zweig.
- `src/candidates/rltp-mls/load.ts`: lädt `pkg/` (gitignored, gebaut von
  `scripts/build-wasm.sh`).
- Registriert als `rltp-mls` und `rltp-mls-sichten` in
  `src/candidates/index.ts`.
