# Port-Experimente

Prüfstand für Gruppen-Autorität und Schlüsselvereinbarung. Dieselben
Szenarien laufen gegen mehrere Kandidaten: WoT Gen 2, p2panda, Keyhive
und DaWN. Aus dem, was jeder Kandidat von der App braucht, leiten wir den
Port ab. Plan und Begründung: `rltp/design/port-experimente-2026-10.md`.

## Aufbau

- `src/lab/types.ts`: Treiber-Schnittstelle des Prüfstands. Das ist
  **nicht** der gesuchte Port, sondern nur so viel, wie die Szenarien
  brauchen.
- `src/lab/world.ts`: simulierte Welt mit einem Y.Doc je Gerät und einem
  Store-and-Forward-Netz mit Partitionen. Jede Nachricht erreicht jedes
  Gerät, auch entfernte Mitglieder.
- `src/lab/scenarios.ts`: Szenarien S1 bis S8, Ergebnisse getrennt nach
  Autorität und Schlüsseln.
- `src/lab/load.ts`: S9-Last (30 Mitglieder, 500 Autoritätsoperationen).
- `src/candidates/<id>/`: ein Kandidat je Verzeichnis, mit `NOTES.md`
  (Port-Notizen). Kandidaten mit `nodeOnly` (Keyhive über ARK braucht einen
  lokalen Subduction-Server) laufen nur in Node und in der CI; die
  Browser-Seite nennt den Grund.

## Befehle

```sh
pnpm install
pnpm server:fetch              # Subduction-Server (Rust-Binary) für Keyhive, Lauf a
pnpm test                      # Prüfstand-Tests
REPORT=1 pnpm vitest run report # Ergebnistabelle aller Kandidaten
pnpm dev                       # Browser-Lauf lokal
```

Die Browser-Seite wird bei jedem Push auf `main` über GitHub Pages
veröffentlicht. Dort lassen sich alle Läufe auf einem echten Gerät
starten (S9, z. B. GrapheneOS) und das Ergebnis als JSON kopieren.
