# Port-Notizen: RLTP über BeeKEM auf Portable Web Spaces (E12)

Stand 11.10.2026. Plan: `rltp/design/port-experimente-2026-10.md`, E12;
Hintergrund `rltp/design/pws-bruecke-2026-10.md`. Portable Web Spaces (PWS,
ex Wallet Attached Storage, W3C CCG v0.5) als Speicher einer Gruppe, mit
dem unveränderten BeeKEM-Kandidaten (E6–E9) darüber. Nur der Transport
wechselt. Server: `was-teaching-server` 0.42.2 im Prozess
(`startTestServer`, eigener Temp-Speicher je Server), Client
`@interop/was-client` 0.96; beide verlangen Node ≥ 24.

## Variante (a): blinder Speicher

- **Ein Space je Gruppe, eine Collection `frames`.** Jeder Rahmen des
  Kandidaten (Karte, Autoritätsoperation mit BeeKEM-Anhängen, lose
  BeeKEM-Operation, Widerruf, Inhalt mit Kette) wird als JSON-Resource
  `{from, label, b}` unter der ID `<gerät>-<laufnummer>` abgelegt; der
  Server prüft nichts am Inhalt (Klartext-Collection, die Bytes sind unsere
  versiegelten Rahmen).
- **Lesen über den changes-Feed**, je Gerät mit eigenem Checkpoint; Rahmen
  anderer Geräte gehen an `candidate.receive`, eigene werden übersprungen.
  Offline = kein Push, kein Pull; der Ausgang puffert.
- **Controller des Spaces ist ein Gruppenschlüssel** (`did:key`), den alle
  Geräte halten und mit dem alle signieren. Für WAS ist die Gruppe damit ein
  Controller. Mitgliedschaft kennt der Server nicht; wer den Schlüssel hat,
  liest und schreibt. Entfernen wirkt nur über die Schlüsselepoche (KV1),
  nie am Server.
- Partitionen: Im Prüfstand mit eigenem Transport ist nur die erste Gruppe
  online; die anderen puffern, ohne Mesh untereinander (Konvention aller
  Kandidaten mit eigenem Transport, wie Gen 2 und Keyhive über ARK).

### Ergebnisse (Prüfpunkt 1: trägt PWS als blinder Speicher?)

| | Ergebnis | Grund |
|---|---|---|
| S1–S4f, S4j, S5, S5c, S6b, S8 | bestanden | wie am Prüfstand-Relay |
| S6 | nicht bestanden | wie ohne Server: Historie erst über die Kette |
| S4e, S4j | bestanden | Fork und Fork-Ende laufen über den Feed wie über das Relay |
| S5b, S7 | nicht abbildbar | der Prüfstand sieht die Rahmen nicht (sie liegen beim Server), also kein Diebstahl-Modell über `w.log` |
| S10a–c | nicht abbildbar | der Server ist blind, kein durchsetzender Dienst (Variante a) |
| S9 (30 × 100, ein Lauf) | 105 ms/Op, davon 83 % Warten auf HTTP (`idleMs`); aktiv ≈ 18 ms/Op wie am Relay (E9 Schritt 3: 17,8) | der Server kostet Zeit, nicht der Kandidat; Sichten-Dienst am Relay: 31,9 |
| S9b (5 × 100) | 17,9 ms je Eintrag, davon 87 % HTTP | Inhalt geht als eine Resource je Eintrag |

**Antwort auf Prüfpunkt 1: ja.** Jedes Szenario, das am Prüfstand-Relay
besteht, besteht auch über PWS, ohne Änderung am Kandidaten. Der Feed
liefert die Rahmen in Schreibreihenfolge des Servers; die Puffer des
Kandidaten (`wartet`, BeeKEM-Vorgänger) tragen jede Reihenfolge.

### Prüfpunkt 3: was der Server lernt

**Korrektur nach dem Review zu PR #23 (#24):** Die erste Fassung dieser
Notiz war falsch. Der Server sieht die Rahmen im Klartext, Base64 ist keine
Verschlüsselung. Aus `visible()` nach Gründung, zwei Aufnahmen und einem
Eintrag, am HTTP-Payload geprüft:

| Rahmen | im Klartext beim Server |
|---|---|
| `card` | Personenname, BeeKEM-ID, Share-Key, Geräteschlüssel |
| `auth`, `policy` | die ganze Autoritätsoperation: Art, Subjekt, Signierer, Politik, Schlüsselbindung, Vorgänger; dazu die BeeKEM-Anhänge |
| `cgka` | BeeKEM-Operationen (signiert, Pfadgeheimnisse verschlüsselt) |
| `content` | nur `c`, `iv`, `tab`, `ref`: versiegelt |

Personen `alice`, `bob`, `carol` sind damit für den Server lesbar, ebenso
Mitgliedschaft, Regeln und wer wen aufgenommen hat. Nicht lesbar: Inhalte
und die Gruppengeheimnisse. Der Grund liegt nicht bei PWS, sondern beim
Prüfstand-Kandidaten: Er versiegelt Inhalte (KV1 ist das Thema von E6–E9),
nicht die Rahmen; das Prüfstand-Relay war nur per Konvention blind. Die
Spec versiegelt jeden replizierten Eintrag unter dem Epochenschlüssel
(Replication Contract, „key-blind by construction“; Access-Envelope) und
liefert Willkommen und Karten getrennt zu. Für E12 heißt das: Variante (a)
ist „blind“ nur für Inhalte; ein blinder Träger im Sinn der Spec braucht
den versiegelten Eintrag, und der gehört in den Träger-Prüfstand (E10/E11)
als eigene Tür, nicht in diesen Kandidaten.

Zusätzlich sieht der Server: Resource-IDs mit Gerätenamen und Laufnummer
(ein Pseudonym je Gerät × Gruppe wäre die Antwort, E8 Befund 5), die
Rahmen-Labels, Größen und die Lesezeitpunkte je Gerät über die
Checkpoints.

### Prüfpunkt 4: Serverwechsel

`space.exportBlob()` → neuer Server → `space.import()` unter derselben
Space-ID: 1 Collection, 8 Resources übernommen, 0 übersprungen, Space-Metadaten wiederhergestellt; Provenienz „unattested“ für alle 10 Einträge, weil wir keine Export-Signaturen setzen. Checkpoints sind Fakt des alten Servers (der
Feed wird neu gelesen, `seen` filtert Bekanntes). Ein neues Gerät liest die
ganze Historie vom neuen Server, Schreiben geht weiter, Mitgliedschaft
stimmt. Das ist ihr erklärtes Ziel „Data Portability“, und für uns reicht
es: Der Replication Contract verlangt nichts vom Träger, was der Umzug
verlieren könnte; Autorität und Schlüssel leben bei den Mitgliedern.

## Prüfpunkt 2: was die Gruppe als Controller kosten würde (Varianten b, c)

Nicht gebaut; aus dem Server-Code (`was-teaching-server` 0.42.2) abgeleitet.

- **Controller-Register.** `src/lib/validateDid.ts` lässt als Controller
  `did:key` und `did:webvh` zu; `src/lib/webvhController.ts` löst ein
  selbst gehostetes `did:webvh` aus einem Log im Space auf und prüft die
  Historie lokal; `src/zcap.ts` (1 863 Zeilen) hängt diesen Resolver in die
  Signaturprüfung (`setDidResolver(didResolverWithWebvh(…))`). Ein
  RLTP-Profil wäre eine weitere Methode derselben Klasse („verified log“):
  das Log ist unsere Sichten-Kette (E9 Schritt 2), der Schlüsselsatz des
  „Controller-Dokuments“ sind die `identities` der zuletzt verifizierten
  Sicht, jede unter `capabilityInvocation`. Unterschied zu `did:webvh`: Ein
  Eintrag ist nicht von einem Schlüssel des Vorgängers signiert, sondern von
  m Identitäten aus Vorgänger ∩ Nachfolger (Schnittregel); die
  Log-Verifikation braucht also eine Quorumregel statt der
  Einzelsignatur. Der Resolver-Anschluss existiert, die Methode nicht.
- **Container-Regel.** `src/lib/containerRule.ts`: Space löschen, Space-Meta
  ersetzen, Collection löschen sind „controller-only“ = direkte
  Root-Invocation durch den Controller. Mit der Gruppe als Controller wäre
  jedes gelistete Gerät „der Controller“ und dürfte löschen. Ein Profil
  müsste diese Operationen an ein Quorum binden; HTTP-Signaturen tragen eine
  Signatur, kein Quorum. Weg: ein quorum-signierter Eintrag in der Kette
  (`terminal`, Access §7.3 kennt ihn), den der Server als Löschauftrag
  liest, statt einer signierten Anfrage.
- **Verdrängung.** Entfernen wirkt heute nur über die Epoche. Mit der Kette
  als Controller-Historie würde die nächste Sicht einen entfernten
  Geräteschlüssel aus dem Dokument nehmen; die current-key-set rule von WAS
  macht das serverseitig sofort wirksam, samt allem, was dieser Schlüssel
  delegiert hat. Das ist Dienstklasse „Sicht“ aus Access §9.3, ohne eigenen
  Dienst.
- **Variante (c), Log-Replik:** der Server materialisiert das Autoritätslog.
  Das wäre ein Governing-Profil ihrer Governing History Logs
  (Server prüft nur das Zeilenformat, Leser verifizieren) plus
  Server-Auswertung: deutlich größerer Eingriff als (b).
- **Was wir mitbringen müssten:** ein Pseudonym je Gerät × Gruppe gegenüber
  dem Server (E8 Befund 5), die Kette als Resource-Log im Space, und die
  Entscheidung zu Befund 9 (welche Quorumregel die Kette fährt).

**Schätzung:** (b) ist ein Profil im Register plus eine Container-Ausnahme,
auf ihrer Seite vielleicht wenige hundert Zeilen an einem Resolver, dessen
Anschluss schon existiert; (c) ein neuer Server-Teil. Mit (a) als Boden
reicht (b) für alles, was E8 vom Dienst verlangt hat, und ihre Spec bliebe
unverändert, wenn das Register offen ist.

## Grenzen des Prüfstands

- Lesen ist nicht an den Besitznachweis gebunden, weil der Gruppenschlüssel
  geteilt ist (Variante a). Mit (b) hätte jedes Gerät seinen eigenen.
- `w.log` ist leer: Szenarien, die am Verkehr messen (S7, S5b, S10), sind
  nicht abbildbar. Ein Mithör-Modell am Server wäre möglich (Diebstahl =
  Zugriff auf den Server-Speicher), aber ein anderes Angreifer-Modell.
- Node ≥ 24 nur für diesen Kandidaten; die CI läuft auf 22 und überspringt
  ihn, bis sie angehoben wird.
