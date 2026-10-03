# Gepatchte p2panda-Crates (Kandidat für einen Beitrag)

Kopien von `p2panda-store`, `p2panda-spaces`, `p2panda-encryption` und
`p2panda-core` 0.7.1 von crates.io (MIT OR Apache-2.0), eingebunden über
`[patch.crates-io]`. Zwei Änderungen:

1. **Speicher-Traits ohne SQLite** (`p2panda-store`, `p2panda-spaces`):
   nur Feature-Definitionen in `Cargo.toml`.
2. **`web-time` statt `std::time`** (`p2panda-encryption`, `p2panda-core`):
   `SystemTime::now()` gibt es auf `wasm32-unknown-unknown` nicht (Panic
   „time not implemented on this platform“). `web-time` reicht nativ
   `std::time` durch und nutzt im Browser `Date`. Geändert sind je ein
   Import in `data_scheme/group_secret.rs`, `key_bundle/lifetime.rs`
   (dort auch der Fehlertyp) und `timestamp.rs`, plus die Abhängigkeit.

## Problem 1: SQLite

`p2panda-spaces` baut nicht für `wasm32-unknown-unknown`. Grund ist nicht
der Code: In `p2panda-store` sind Traits und SQLite-Implementierung schon
sauber getrennt (`traits.rs` / `sqlite.rs`, Module hinter
`#[cfg(feature = "sqlite")]`). Aber die Features `groups`, `encryption` und
`spaces` schalten `sqlite` mit ein, und `p2panda-spaces` verlangt `sqlite`
auch selbst. Damit hängen sqlx und tokio mit `net` (mio) am Build, die es im
Browser nicht gibt.

## Änderung 1

`p2panda-store/Cargo.toml`:

```diff
-encryption = ["dep:p2panda-encryption", "sqlite"]
-groups = ["dep:p2panda-auth", "sqlite"]
-spaces = ["sqlite", "groups", "encryption"]
+encryption = ["dep:p2panda-encryption"]
+groups = ["dep:p2panda-auth"]
+spaces = ["dep:serde", "groups", "encryption"]
```

`p2panda-spaces/Cargo.toml`: Abhängigkeit nur noch auf die Traits;
SQLite nur für die eigenen Tests.

```diff
 [dependencies.p2panda-store]
-features = ["sqlite", "spaces"]
+features = ["spaces"]
+
+[dev-dependencies.p2panda-store]
+features = ["sqlite", "spaces"]
```

## Problem 2: Zeit

`p2panda-encryption` prüft Gültigkeit von Key-Bundles und Alter von
Gruppengeheimnissen mit `std::time::SystemTime::now()`, `p2panda-core`
nutzt es für `Timestamp::now()`. Beides bricht im Browser ab.

## Nachweis (03.10.2026, Rust 1.96)

- `p2panda-spaces` und alle Abhängigkeiten bauen für
  `wasm32-unknown-unknown` (getrandom mit `wasm_js`); im Baum kein sqlx,
  kein mio, tokio nur mit `sync`.
- `p2panda-store` baut ohne `sqlite` (`--no-default-features --features spaces`).
- Eigene Tests der Crates mit dem Patch, nativ:
  - `p2panda-spaces --features test_utils`: 27 bestanden.
  - `p2panda-encryption --features test_utils`: 48 bestanden (mit `web-time`).
  - `p2panda-core --features test_utils`: 55 bestanden. Hinweis: Unter
    `test_utils` nutzt `timestamp.rs` `mock_instant`; der `web-time`-Pfad
    wird dort nativ nicht berührt, im Browser-Lauf des Prüfstands schon.
  - `p2panda-store --features sqlite,spaces,test_utils` (dazu
    `p2panda-encryption/test_utils`, `p2panda-auth/test_utils`): 25 + 2
    bestanden, 1 ignoriert.

## Nutzen für p2panda

Gruppen, Schlüsselvereinbarung und Spaces laufen im Browser, sobald eine App
die Speicher-Traits selbst erfüllt (IndexedDB, Arbeitsspeicher). iroh ist
schon browserfähig; die Krypto-Crates sind reines Rust. Als möglicher
zweiter Schritt: ein Speicher im Arbeitsspeicher als Feature `memory` und
ein wasm32-Ziel in ihrer CI.

Weg zum Beitrag: erst Anfrage bei p2panda (Anton), dann ein kleiner PR über
einen Fork. Nichts davon ohne Freigabe.
