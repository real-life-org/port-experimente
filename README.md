# Port-Experimente

Prüfstand für Gruppen-Autorität, Schlüsselvereinbarung, Replikation und
Zustellung. Dieselben Szenarien laufen gegen mehrere Kandidaten; aus dem,
was jeder Kandidat von der App braucht, leiten wir die Ports des Real Life
Trust Protocol ab. Plan und Begründung:
`rltp/design/port-experimente-2026-10.md` (private Werkstatt); die
Befunde je Kandidat liegen hier in `src/candidates/*/NOTES.md`.

## Ergebnisse

- **Die vier Befunde**, auf Englisch, für Leser außerhalb des Projekts:
  https://claude.ai/artifact/R8tvExLN2E4wARL8WELo9a. Eine Autorität über
  zwei Schlüsselprotokolle liefert dieselbe Zusagenzeile; ohne Historie
  kein CRDT; Zustellsemantik liegt im Adapter, nicht im Draht; Portable Web
  Spaces trägt eine Gruppe als blinder Speicher.
- **Die Konformitätsmatrix**, interaktiv: 40 Zusagen je Port, 13 Kandidaten,
  jede Zelle mit ihren Szenarien und dem aufgezeichneten Ergebnis:
  https://claude.ai/artifact/Ph4c9RDUN3gbPYVybisbsB. Stand: Lauf vom
  16.10.2026. Dieselbe Matrix als Markdown erzeugt `REPORT=1 pnpm vitest run
  report` (Datei `matrix.md`); die Browser-Seite rendert sie am Ende der
  Läufe.
- **Lesart.** Eine Zusage gilt nur, wenn jedes zugeordnete Szenario
  besteht. „nicht abbildbar“ heißt: der Kandidat hat keine Fähigkeit für
  das Szenario, oder die Trägerstörung traf keinen Rahmen dieser Art. Das
  ist eine Lücke in der Abdeckung, nie ein Bestehen.

## Kandidaten

| Kennung | Was | Transportklasse |
|---|---|---|
| `gen2` | WoT Generation 2 (`@web_of_trust/core` 0.6.0, Yjs, eigenes Relay im Prozess) | eigener Server |
| `p2panda` | p2panda-spaces 0.7.1 (WebAssembly) | Prüfstand-Relay |
| `keyhive` | Keyhive 0.3.0-alpha.1 (WebAssembly, Inhalt Yjs) | Prüfstand-Relay |
| `keyhive-ark` | Keyhive über ARK 0.6.0-alpha.1 (Automerge, Subduction-Server) | eigener Server, nur Node |
| `rltp-beekem` | Autoritätslog nach der Konfliktmatrix, Schlüssel aus BeeKEM 0.4.0 | Prüfstand-Relay |
| `rltp-beekem-sichten`, `-logreplik` | dasselbe mit durchsetzendem Dienst am Relay (Klasse Sicht bzw. Log) | Prüfstand-Relay, durchsetzend |
| `rltp-beekem-pws` | dasselbe auf Portable Web Spaces (was-teaching-server 0.42) als blindem Speicher | eigener Server, nur Node |
| `rltp-mls`, `rltp-mls-sichten` | derselbe Kandidatencode, Schlüssel aus MLS (OpenMLS 0.9.1) | Prüfstand-Relay |
| `consensual-mls-any-staged`, `-owner` | MLS ohne Autoritätslog, der Commit entscheidet die Mitgliedschaft (Raummodell) | Prüfstand-Relay |
| `klartext` | Null-Kandidat ohne Verschlüsselung; zeigt, dass der Prüfstand Fehler erkennt | Prüfstand-Relay |

Laufzeiten sind nur innerhalb einer Transportklasse vergleichbar: beim
eigenen Server steckt in S9 fast nur Warten.

## Szenarien

- **S1–S11** (`src/lab/scenarios.ts`): Mitgliedschaft unter Konflikt,
  Geräte je Person, Historie, erbeuteter Zustand, Dienst am Relay.
- **T1–T12** (`src/lab/traeger.ts`): der Träger als Gegner (verlieren,
  umordnen, verdoppeln, verändern, vorhalten, einfrieren, Trägerwechsel,
  was der Träger liest).
- **T9, T10, Z1–Z5** (`src/lab/zustellung.ts`): Zustellung im Paar über
  die Drähte Prüfstand-Umschlag, TSP Rev 3 und DIDComm v2 (authcrypt,
  anoncrypt): Quittungsverlust, Gerät offline, was der Träger lernt,
  Trägerwechsel, Mehrgerät, fremder Absender, falscher Empfängerschlüssel.
- **S9, S9b** (`src/lab/load.ts`): Last, 30 Mitglieder.

## Aufbau

- `src/lab/types.ts`: Treiber-Schnittstelle des Prüfstands. Das ist
  **nicht** der gesuchte Port, sondern nur so viel, wie die Szenarien
  brauchen.
- `src/lab/world.ts`: simulierte Welt mit einem Y.Doc je Gerät und einem
  Store-and-Forward-Netz mit Partitionen und Fehlerinjektion.
- `src/lab/matrix.ts`: Zusagen je Port mit Zuordnung Szenario → Zusage;
  erzeugt die Matrix.
- `src/candidates/<id>/`: ein Kandidat je Verzeichnis, mit `NOTES.md`.
  `rltp-beekem` ist das Experiment zum Port-Schnitt: das Autoritätslog
  (`authority.ts`) entscheidet die Mitgliedschaft, der Schlüssel-Port
  (`keyport.ts`) liefert die Schlüssel, BeeKEM oder MLS; der Dienst am
  Relay steht in `service.ts`.
- `src/candidates/zustellung/`: die Drähte des Zustellungs-Prüfstands.
- `rust/`: WebAssembly-Hüllen (`p2panda-wasm`, `beekem-wasm`, `mls-wasm`),
  gebaut von `scripts/build-wasm.sh`; die Bindings landen unter
  `src/candidates/*/pkg/`. `rust/mls-wasm/examples/vectors.rs` tauscht
  KeyPackage, Welcome, Commit und Nachricht als Rohbytes mit anderen
  MLS-Implementierungen (`cargo run --example vectors`).
- Kandidaten mit `nodeOnly` laufen nur in Node und in der CI; die
  Browser-Seite nennt den Grund.

## Befehle

```sh
pnpm install
pnpm wasm                       # Rust-Hüllen bauen (Rust 1.96, wasm-bindgen 0.2.129)
pnpm server:fetch               # Subduction-Server (Rust-Binary) für Keyhive über ARK
pnpm test                       # Prüfstand-Tests
pnpm test:rust                  # native Tests der Rust-Hüllen
REPORT=1 pnpm vitest run report # Ergebnistabelle aller Kandidaten und matrix.md
pnpm dev                        # Browser-Lauf lokal
```

Die Browser-Seite wird bei jedem Push auf `main` über GitHub Pages
veröffentlicht. Dort lassen sich alle Läufe auf einem echten Gerät
starten (S9, z. B. GrapheneOS) und das Ergebnis als JSON kopieren.
