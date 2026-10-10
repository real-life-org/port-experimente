# Port-Notizen: RLTP-Autorität über BeeKEM (E6, E7, E8, E9)

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
| S10a–c | nicht abbildbar | ohne Dienst; Ergebnisse der Dienst-Varianten unter E8 |

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

## Autoritätslog: Befund aus dem Review zu PR #11

Die erste Fassung des Fixpunkts begann mit „alle Operationen gültig“ und
nahm für Strong Removal jede noch nicht ausgeschlossene Entfernung, auch eine
ohne Autorität. Eine unberechtigte Entfernung (Mitglied entfernt Admin)
unterdrückte so eine gleichzeitige gültige Aufnahme, und weil der Fixpunkt
Ausgeschlossene nie wieder prüfte, blieb das so (Repro: Alice nimmt Eve auf,
Carol entfernt zugleich unberechtigt Alice; Eve fehlte bei allen). Jetzt
bestimmt jede Runde zuerst die Autorität jeder Operation aus ihren gültigen
Vorfahren; Strong Removal trifft nur durch Entfernungen **mit** Autorität,
und jede Runde prüft alle Operationen neu (Schranke: Operationen + 2
Runden). Lehre für den Guss: „gültig“ sind zwei Prüfungen in fester
Reihenfolge, Autorität vor Gleichzeitigkeit, und nur die erste darf die
zweite speisen.

Offen, für Anton: Ketten gleichzeitiger Entfernungen. A entfernt B, B
entfernt zugleich C (beide Admins). Heute: B's Entfernung hat Autorität und
unterdrückt C's gleichzeitige Aufnahmen, ist aber selbst durch A ungültig,
also bleibt C Mitglied. Konsequent wäre entweder „Entfernungen mit Autorität
gelten immer, nur Aufnahmen eines Entfernten verfallen“ (Verallgemeinerung
von Entscheidung 2, dann ist C raus) oder „nur gültige Entfernungen
unterdrücken“ (dann pendelt ein Dreier-Zyklus und braucht einen Tiebreak).

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
- Karten und Widerrufe sind Wissen je Replika und ändern sich nur durch
  empfangene Rahmen. In einer Partition heilt ein Admin deshalb nichts, was
  er nicht zugestellt bekommen hat; nach der Zustellung konvergieren alle
  (Test „#14“). Ob eine Person entfernt werden kann, entscheidet das Log,
  nicht die Kartentabelle: Nach Widerruf ihres letzten Geräts hat sie keine
  Karte mehr, ist aber Mitglied (Test „#13“).
- Offen: zwei Geräte derselben Person nehmen in einer Partition
  gleichzeitig ein drittes auf (doppelte Aufnahme in BeeKEM); hier nicht
  getestet.

## E8: Durchsetzender, schlüsselblinder Dienst am Relay

Frage: Was bringt Durchsetzung am Relay über die Durchsetzung in den Repliken
hinaus, und was muss der Dienst dafür wissen? Zwei Varianten desselben
Kandidaten (`service.ts`), Transportklasse „Prüfstand-Relay, durchsetzend“:

- **Sichten (Access §7.3).** Der Dienst kennt den Log nicht. Jedes
  Mitgliedsgerät schlägt nach jeder Änderung die Sicht seines Stands vor
  (seq, Vorgänger-Hash, identities = Geräte-IDs, m für die nächste Sicht);
  der Dienst zählt gleichlautende Vorschläge von Geräten, die in alter und
  neuer Sicht stehen, als Quorum (m = 1 bei einer Identität, sonst 2) und
  bestätigt die angenommene Sicht an alle (`ack`). Vorschläge gehen an den
  Dienst allein („behalten“).
- **Log-Replik (Kontrolle, wie Gen 2).** Der Dienst führt eine Replik des
  Autoritätslogs und wertet sie selbst aus.

Beide binden ein Gerät über seine eigene Karte an seine BeeKEM-ID (ohne
Besitznachweis; §7.3 verlangt eine Challenge) und bedienen nur Geräte, die
laut Sicht bzw. Log Mitglied sind (Verdrängung, §9.3). Beide lassen
**Autoritätsoperationen immer durch**, auch von Entfernten, und gaten nur
Inhalt, Schlüsseloperationen und Widerrufe.

| | Sichten | Log-Replik | Grund |
|---|---|---|---|
| S1–S8 | wie ohne Dienst | wie ohne Dienst | S4a: der gleichzeitige Eintrag des Entfernten erreicht niemanden mehr |
| S10a Entfernter schreibt gleichzeitig | bestanden | bestanden | Relay verwirft, kein Residual; Bob wird nicht mehr bedient |
| S10b Entfernung ohne Relay, Entfernter schreibt am Relay | bestanden | bestanden | Dienst lässt durch, bis die Entfernung ihn erreicht (Sicht veraltet, erwartet); danach verworfen |
| S10c gegenseitige Entfernung lässt nur Carol | **nicht bestanden** | bestanden | Sichten: m=2 der alten Sicht ist mit einer Identität nicht mehr erfüllbar, der Dienst friert ein und bedient Alice weiter (§7.3 „stated residual“). Log-Replik: wertet selbst aus |

### Befunde

1. **Evidenz ist nie gated.** Die erste Fassung verwarf auch
   Autoritätsoperationen von Nicht-Mitgliedern. Damit sah bei gegenseitiger
   Entfernung die Relay-Seite Bobs Entfernung von Alice nie, die Repliken
   liefen auseinander, und mit Sichten fror der Dienst auf einem falschen
   Stand ein. Access §9.3 sagt das schon („non-effecting evidence transport
   of 3.6 is never gated“); das Experiment zeigt, dass es keine Feinheit ist,
   sondern die Konfliktmatrix daran hängt. Für den Port: Der Dienst gated
   Wirkung (Inhalt, Schlüssel), nie Evidenz (Autoritätsoperationen).
2. **Verdrängte erfahren nichts.** Wen der Dienst nicht mehr bedient, der
   bekommt auch die Operation nicht, die ihn entfernt hat (S10c: Bob sieht
   weiter {bob, carol}). Ohne Dienst lernte er es aus dem Mesh. Das ist der
   Platz von Access §10.2 `removal-notice`: eine Zustellung an einen, kein
   Replikationsrahmen. Für E11 der erste harte Delivery-Fall aus der Gruppe
   heraus.
3. **Quorum friert ein.** Sichten mit festem m aus der Vorgängersicht
   scheitern an genau den Fällen, die die Matrix löst: gegenseitige
   Entfernung, die das Quorum unterschreitet. Die Spec nennt das „stated
   residual“ und verlangt, m vorher zu senken; bei gleichzeitigen
   Entfernungen gibt es kein Vorher. Die Log-Replik hat das Problem nicht,
   weil sie dieselbe Matrix rechnet wie die Repliken. Für den Guss: Entweder
   m folgt der Sicht selbst (m = min(2, |identities|) der **neuen** Sicht,
   dann ist ein Einzelsignierer bei Schrumpfen auf eins zulässig), oder der
   Dienst bekommt den Log. Sichten kaufen hier nichts, was die Log-Replik
   nicht hat, kosten aber Verkehr (unten).
4. **Sichten sind teuer.** Jedes Mitgliedsgerät schlägt nach jedem Rahmen
   vor, bis der Dienst bestätigt; bei 30 Mitgliedern und 500 Operationen war
   S9 nach zehn Minuten nicht fertig (ohne Dienst 193 ms je Operation).
   Kleiner skaliert es noch: 10 × 100: ohne Dienst 14,6, Log-Replik 11,3,
   Sichten 11,4 ms je Operation; 30 × 100: Sichten 59; 30 × 200: Sichten 74,
   Log-Replik 54. Der Dienst spart sogar Arbeit (verworfene Rahmen erreichen
   niemanden), aber die Sichten wachsen überproportional mit der Zahl der
   Operationen. Auf der Seite läuft diese Variante deshalb nur 30 × 100
   (`loadSize`). Abgelehnte Vorschläge
   (falsche seq, weil die Bestätigung noch nicht da war) sind der Normalfall,
   nicht die Ausnahme: 5 bis 10 je Szenario mit drei bis vier Geräten.
5. **Was der Dienst lernt.** Sichten: Geräte-IDs aller Mitglieder, seq,
   Gruppenzugehörigkeit der IDs; die IDs sind hier gruppenübergreifend gleich
   (ein BeeKEM-Schlüsselpaar je Gerät), ein Dienst für mehrere Gruppen könnte
   Gruppen über Geräte verbinden. Log-Replik: zusätzlich Personen, Rollen und
   die ganze Operationsgeschichte. Gen 3 sieht Member-Anker je Gruppe vor
   (Gerät × Gruppe); das wäre hier ein eigener Share-Key je Gruppe.

### Delivery-Hypothesen DV1–DV6 (von der Delivery-Session, nicht entschieden)

Lesart: „bricht“ heißt bricht **am Kandidaten**; die Hypothese steht dann
als Anforderung an den Port, nicht als widerlegt. Ein Dienst ohne diese
Zusagen tut genau das, was die Tabelle zeigt.

| | Dienst-Rahmen in E8 | Befund |
|---|---|---|
| DV1 Ack ist Ankunft, nie Entscheidung | `ack` bestätigt eine **angenommene** Sicht, also ein Quorum-Verdikt, kein Ankunftssignal. Für einen Vorschlag gibt es kein Ankunftssignal | bricht am Kandidaten: Verdikt und Ankunft brauchen zwei getrennte Rahmen |
| DV2 Nichts Angenommenes endet still | Verworfene Inhalte (S10a) und abgelehnte Vorschläge (falsche seq) verschwinden ohne Rückmeldung; der Schreiber merkt nichts | bricht am Kandidaten: genau der Fehler, den DV2 verbietet |
| DV3 Mindestens einmal, idempotent über den Inhalt | Vorschläge sind über ihren Inhalt idempotent (gleicher Hash = gleiche Unterschrift); Sequenz ist die Ordnung, Hash die Identität | hält |
| DV4 Träger lernt nichts Verbindendes | siehe Befund 5: Geräte-IDs sind global | bricht am Kandidaten: globale Geräteschlüssel; Anker je Gruppe (Gerät × Gruppe) heilen es |
| DV5 Ablehnungen wiederholbar, ohne Aussage über Beteiligte | es gibt keine Ablehnungen (siehe DV2) | nicht anwendbar |
| DV6 Adresse je Beziehung oder Gruppe, nicht global | Adresse im Prüfstand ist der Gerätename; im Dienst die globale Geräte-ID | bricht am Kandidaten, wie DV4 |

Ordnung: Der Dienst braucht für Sichten eine totale Ordnung (seq +1,
Vorgänger-Hash); die Repliken selbst brauchen nur kausale. Dienstwechsel ist
nicht getestet; mit Sichten müsste der neue Dienst die Kette ab einer
registrierten Sicht übernehmen, mit Log-Replik den Log nachziehen.

## Antworten auf die sieben Fragen

- **Ordnung:** kausal, durch Vorgänger in Autoritätsoperationen und in
  BeeKEM-Operationen; beide Seiten puffern, was Vorgänger vermisst.
- **Speicher:** Autoritätslog, BeeKEM-Zustand (serialisierbar, enthält die
  Blattgeheimnisse), Schlüsseltabelle der Kette.
- **Identität:** Ed25519 je Gerät (Mitglieds-ID im Baum), X25519-Share-Key
  als Pre-Key; Karte mit Personenangabe vorab an alle. Person = Name im Log.
- **Transport:** fünf Rahmen an alle (Replication): Karte,
  Autoritätsoperation mit angehängten BeeKEM-Operationen, lose
  BeeKEM-Operation (Rotation, Heilung, Geräteaufnahme, Update beim
  Schreiben), Gerätewiderruf, Inhalt mit Kette. Mit Dienst zwei weitere an
  einen (Delivery): Sichtvorschlag an den Dienst, Bestätigung des Dienstes
  an die bedienten Geräte. Einzelempfänger-Kandidat ohne Dienst ist nur die
  BeeKEM-Willkommensnachricht, die hier im Add-Op an alle mitreist.
- **Autorität:** unser Log; Strong Removal mit gegenseitiger Entfernung als
  Ausnahme; Gründer ohne Sonderrolle. Seit E9 mit Signaturen und Politik
  nach Access §4 (unten).
- **Schlüssel:** BeeKEM. Neues Geheimnis je Entfernung, Rotation auf
  Verlangen, Zusammenführung paralleler Geheimnisse über Konfliktschlüssel.
- **Historie:** Vorgänger-Kette in der Replik.

## E9: Signaturen, Politik, Fork (Schritt 1)

Frage: Hält der Guss Access 0.54–0.56 am Code? Schritt 1 ersetzt im
Autoritätslog (`authority.ts`) die Rollen und die unsignierten Operationen
durch die Spec-Form; der Schnitt (Autorität bei uns, BeeKEM für Schlüssel)
bleibt. Schritt 2 (Sichten-Kette nach §7.3 mit Signaturen, m aus der neuen
Sicht, Challenge; S10c', S10d) steht aus.

- **Signaturen.** Jede Operation trägt ein signature-set über ihre Hülle;
  die id ist der Digest der Hülle (Körper ohne Beweise), eine Hülle, die
  nicht zur id passt, ist nicht die signierte. Ein Signierer zählt, wenn
  seine Signatur unter dem Schlüssel prüft, den die gültige Aufnahme (oder
  die Genesis) für ihn registriert hat, und er an der Position Mitglied ist
  (policy currency). Ed25519 je Person, über ihre Geräte geteilt (wie heute
  der Seed); die Gruppen-DID signiert die Genesis mit und wird verworfen
  (RLTP-ACC-3060). `@noble/curves`, synchron, damit die Faltung synchron
  bleibt.
- **Politik als Daten.** `any-member`, `threshold k`, `actors`, `vouch n`,
  `all`, `any`, `strongest` (§4.2); Gültigkeit über Satisfaction-Mengen
  (§4.4), `strongest` und die Ordnung ≥ durch Aufzählung über das endliche
  Universum (Signierer ⊆ Mitglieder, Bürgen ⊆ Mitglieder, Ja des Subjekts;
  Schranke 16 Mitglieder). Strukturprüfung: Aritäten, Tiefe ≤ 4, nichtleere
  Kompositionen, vouch nur auf `member.add`, mindestens eine konkrete Regel.
  Rollen gibt es nicht mehr: „Admin“ ist ein Eintrag in den `actors` von
  `member.add`/`member.remove`; `policy.change` ist `strongest`. Befördern
  = `policy.change`, das den Namen anhängt.
- **Fork (Klassenregel 3, RLTP-ACC-3495).** `policy.change` neben einer
  Durchsetzung (remove, policy.change): beide verfallen; im Fork verfällt
  jede weitere Durchsetzung, Aufnahmen gehen weiter; Ende durch ein
  `policy.change`, dessen Vorgänger beide Zweige enthalten (autorisiert
  nach der Politik vor dem Fork, weil die Geschwister verfallen sind).
  Strong Removal läuft vor Klassenregel 3 (§3.6: Dispositionen zuerst).

| | Ergebnis | Grund |
|---|---|---|
| S1–S8, S5b/c, S10a/b | unverändert | Regression |
| S4e | **bestanden** (bisher nicht abbildbar) | zwei `policy.change` gleichzeitig: Fork, alle einig (`fork=ja`) |
| S4j | bestanden | `policy.change` neben Entfernung: Fork, Carol bleibt; `policy.change` auf beide beendet ihn, danach wirkt die Entfernung |
| S4g (Log) | bestanden | ohne, gefälschte, fremde Signatur und geänderte Hülle: ungültig; Genesis braucht Gründerin und Gruppenschlüssel |
| S4h (Log) | bestanden | `threshold 2`: eine Signatur reicht nicht, zwei gleichzeitige Einzelsignaturen bilden keine Entfernung, Nicht-Mitglieder zählen nicht |
| S4i (Log) | bestanden | `vouch 2`: eine Bürgschaft zu wenig; ohne Ja des Subjekts nichts; Bürgschaften einer anderen Aufnahme zählen nicht; vouch auf `member.remove` strukturell ungültig |
| strongest (Log) | bestanden | löst zu `actors({alice,bob},2)` auf; `all[actors(a),actors(b)] ≥ threshold(2)` (§4.4) |
| S10c (Sichten) | unverändert nicht bestanden | Schritt 2 |
| S9 | 267 ms je Operation (30 × 500, Median aus 3; E6: 183) | Signaturen prüfen je Faltung neu, und die Faltung ist noch quadratisch; S9b 0,46 ms je Gerät und Zustellung (5 × 200), unverändert |

### Aus dem Review zu PR #16 (Codex, CodeRabbit)

- **Eine Aufnahme ersetzt keine Schlüsselbindung (#17).** Die erste Fassung
  setzte bei jeder gültigen Aufnahme den Schlüssel des Subjekts neu; unter
  `member.add = any-member` konnte ein Mitglied Alices Namen an einen eigenen
  Schlüssel binden und danach als Alice entfernen. Jetzt: Wer schon einen
  Schlüssel hat, kommt nur unter demselben wieder; ein Mitglied wird nicht
  erneut aufgenommen; zwei gleichzeitige Aufnahmen derselben Person unter
  verschiedenen Schlüsseln verfallen beide. Ein Schlüsselwechsel braucht
  eine eigene Regel (Access `anchor.rotate`), hier nicht gebaut. Für den
  Guss: Die Bindung Name → Schlüssel ist ein eigener Zustand neben der
  Mitgliedschaft; welche Operation sie setzen darf, gehört ausgesprochen.
- **Beweise derselben Hülle werden zusammengeführt.** Signaturen und
  Bürgschaften sind nicht Teil der id; eine zweite Kopie bringt ihre mit
  (`'ergänzt'`), sonst gehen nachgereichte Mitsignaturen verloren und zwei
  Repliken beurteilen dieselbe Operation verschieden. Der Kandidat nimmt
  BeeKEM-Anhänge genau einmal in den Baum, auch wenn die Operation erst
  durch Nachlieferung gültig wird.
- **Strong Removal zählt geprüfte Signierer**, nie behauptete Namen; sonst
  könnte eine angehängte ungültige Signatur unter dem Namen eines gerade
  Entfernten eine gültige Operation zu Fall bringen.
- **Join je Fork-Paar.** Ein `policy.change` beendet nur den Fork, dessen
  beide Geschwister es als Vorgänger hat; eine im Fork verfallene
  Durchsetzung bildet selbst kein weiteres Paar (sonst poisoniert ein
  verfallenes `remove` den Join, der den Fork beenden soll).
- **Befördern erweitert die Regeln**, statt sie durch `actors(k=1)` zu
  ersetzen; `threshold` und `vouch` bleiben erhalten.
- **Eine Beförderung gilt nur, solange ihre Aufnahme gilt (#18).** Ein
  kausaler Vorgänger bindet nicht: Unter `add:vouch:1` war die Aufnahme
  ungültig, die nachfolgende `policy.change` aber gültig, und eine spätere
  gewöhnliche Aufnahme machte die verwaisten actors-Rechte wirksam. Neu in
  der Hülle: `dependsOn`, eine Gültigkeitsabhängigkeit, die der Fixpunkt in
  jeder Runde prüft (nachgereichte Beweise und spätere Invalidierung
  eingeschlossen; nur Vorgänger erlaubt). Für den Guss: Die Spec kennt
  Autorität nur je Position; „gilt nur mit X“ ist ein eigener Mechanismus,
  den die Admission Chain der Membership Tasks (invite → accept → add) für
  die Aufnahme schon leistet. Für Politik, die an einer Aufnahme hängt,
  fehlt er, und `actors`, die Nicht-Mitglieder nennen, sind der Grund.

### Wo der Code vom Guss abweichen musste (Befund für 0.57)

1. **Autor einer k-of-n-Operation.** Die Spec disponiert „eine Entfernung
   ihres Autors“ (RLTP-ACC-3400); eine Operation mit signature-set hat
   keinen einen Autor. Hier verfällt sie, sobald **einer** ihrer gültigen
   Signierer gleichzeitig entfernt wird (fail-closed). Der Guss sollte das
   sagen: alle Mitsignierer sind Autoren, oder nur der `author` des
   Umschlags.
2. **Befördern ist Verfassung.** Ohne Rollen ist „x wird Admin“ ein
   `policy.change`. Wer gleichzeitig entfernt wird und jemanden befördert
   (S4f), löst keinen Fork aus, weil Strong Removal zuerst greift; stünde
   Klassenregel 3 zuerst, forkte jede Entfernung eines Admins, der gerade
   befördert. Die Reihenfolge der Dispositionen trägt damit mehr, als §3.6
   vermuten lässt; sie sollte als Regel mit Rationale stehen.
3. **Was im Fork weitergeht.** §3.6 sagt „fails closed“. Hier verfällt nur
   Durchsetzung; Aufnahmen und Inhalte laufen weiter (der Schlüsselbaum
   folgt der Mitgliedschaft). Ob eine Aufnahme im Fork gelten soll, ist eine
   Entscheidung für den Guss.
4. **Konsens des Subjekts.** `vouch` verlangt „A enthält das Subjekt“; hier
   prüft die Subjekt-Signatur unter dem Schlüssel aus der Aufnahme selbst,
   bevor das Subjekt Mitglied ist. Eine Aufnahme ohne vouch-Regel braucht
   hier kein Ja des Subjekts; in der Spec liefert das die Membership Tasks
   (accept), außerhalb des Logs. Die Bürgschaft ist an die Nonce der
   Aufnahme gebunden, nicht an ein Accept-Dokument (Vereinfachung).
5. **Heilung unter Quorum.** Wer den Schlüsselbaum heilt (Blatt eines
   Nicht-Mitglieds entfernen), bestimmt hier `may(person, member.remove)`
   allein. Unter `threshold 2` darf das niemand allein, und der Baum bleibt
   ungeheilt. Heilung ist eine Pflicht der Durchsetzung, keine
   Mitgliedschaftsentscheidung; sie sollte ohne Politik-Quorum erlaubt sein
   (jedes Mitglied darf den Baum der Mitgliedschaft angleichen).
6. **Nicht modelliert:** pending exits in der policy currency (5.4, kein
   `member.leave` im Prüfstand); der Transportkosten-Bound der Politik
   (§4.4); `strongest` jenseits von 16 Mitgliedern (symbolische Ordnung
   nötig, die Spec erlaubt sie); Schlüsselwechsel einer Person
   (`anchor.rotate`).
