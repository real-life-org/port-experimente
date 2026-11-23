#!/bin/sh
# Baut die Rust-Hüllen für den Browser und erzeugt die JS-Bindings.
# Voraussetzungen: Rust 1.96 mit Ziel wasm32-unknown-unknown, wasm-bindgen-cli 0.2.129.
#
# Ein gebautes Paket liegt zusätzlich im gemeinsamen Zwischenspeicher
# ($PORT_EXPERIMENTE_CACHE, sonst $XDG_CACHE_HOME/port-experimente, sonst ~/.cache/port-experimente), unter einem
# Schlüssel aus dem Inhalt der Hülle (alle Dateien, die git kennt oder nicht
# ignoriert), der Toolchain, der wasm-bindgen-Version und den Cargo- und rustc-Einstellungen der Umgebung. Ein zweiter Worktree
# mit denselben Quellen kopiert es, statt zu bauen. WASM_CACHE=off baut immer.
set -eu
cd "$(dirname "$0")/.."
TOOLCHAIN="${RUST_TOOLCHAIN:-1.96}"
SHARED="${PORT_EXPERIMENTE_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/port-experimente}"
case "$SHARED" in /*) ;; *) SHARED="$PWD/$SHARED" ;; esac # ein relativer Pfad gilt ab der Wurzel des Checkouts
key() { # <crate-dir>
  {
    echo "$TOOLCHAIN"; rustc "+$TOOLCHAIN" --version; wasm-bindgen --version; cat scripts/build-wasm.sh
    # Was Cargo oder rustc über die Umgebung anders bauen lässt (Profil, Flags, Wrapper), gehört zum Schlüssel.
    env | grep -E '^(CARGO_(PROFILE|BUILD|ENCODED|TARGET)_|RUSTFLAGS=|RUSTC)' | sort || true
    git ls-files -z --cached --others --exclude-standard "rust/$1" | sort -z | xargs -0 sha256sum
  } | sha256sum | cut -c1-32
}
build() { # <crate-dir> <wasm-name> <pkg-dir>
  if [ "${WASM_CACHE:-on}" != off ] && k=$(key "$1") && [ -d "$SHARED/wasm/$1/$k" ]; then
    rm -rf "$3" && mkdir -p "$3" && cp -R "$SHARED/wasm/$1/$k/." "$3/"
    echo "$3 aus dem Zwischenspeicher ($k)"
    return
  fi
  RUSTFLAGS='--cfg getrandom_backend="wasm_js"' cargo "+$TOOLCHAIN" build \
    --manifest-path "rust/$1/Cargo.toml" --target wasm32-unknown-unknown --release
  wasm-bindgen --target web --out-dir "$3" "rust/$1/target/wasm32-unknown-unknown/release/$2.wasm"
  if [ "${WASM_CACHE:-on}" != off ] && k=$(key "$1"); then
    tmp="$SHARED/wasm/$1/.tmp.$$"
    rm -rf "$tmp" && mkdir -p "$tmp" && cp -R "$3/." "$tmp/" && rm -rf "$SHARED/wasm/$1/$k" && mv "$tmp" "$SHARED/wasm/$1/$k"
  fi
}
build p2panda-wasm p2panda_wasm src/candidates/p2panda/pkg
build beekem-wasm beekem_wasm src/candidates/rltp-beekem/pkg
build mls-wasm mls_wasm src/candidates/rltp-mls/pkg
