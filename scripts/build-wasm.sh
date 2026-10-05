#!/bin/sh
# Baut die Rust-Hüllen für den Browser und erzeugt die JS-Bindings.
# Voraussetzungen: Rust 1.96 mit Ziel wasm32-unknown-unknown, wasm-bindgen-cli 0.2.129.
set -eu
cd "$(dirname "$0")/.."
TOOLCHAIN="${RUST_TOOLCHAIN:-1.96}"
build() { # <crate-dir> <wasm-name> <pkg-dir>
  RUSTFLAGS='--cfg getrandom_backend="wasm_js"' cargo "+$TOOLCHAIN" build \
    --manifest-path "rust/$1/Cargo.toml" --target wasm32-unknown-unknown --release
  wasm-bindgen --target web --out-dir "$3" "rust/$1/target/wasm32-unknown-unknown/release/$2.wasm"
}
build p2panda-wasm p2panda_wasm src/candidates/p2panda/pkg
build beekem-wasm beekem_wasm src/candidates/rltp-beekem/pkg
