#!/bin/sh
# Baut rust/p2panda-wasm für den Browser und erzeugt die JS-Bindings.
# Voraussetzungen: Rust 1.96 mit Ziel wasm32-unknown-unknown, wasm-bindgen-cli 0.2.129.
set -eu
cd "$(dirname "$0")/.."
TOOLCHAIN="${RUST_TOOLCHAIN:-1.96}"
RUSTFLAGS='--cfg getrandom_backend="wasm_js"' cargo "+$TOOLCHAIN" build \
  --manifest-path rust/p2panda-wasm/Cargo.toml --target wasm32-unknown-unknown --release
wasm-bindgen --target web --out-dir src/candidates/p2panda/pkg \
  rust/p2panda-wasm/target/wasm32-unknown-unknown/release/p2panda_wasm.wasm
