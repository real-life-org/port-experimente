#!/bin/sh
# Holt das Subduction-Server-Binary (Rust, Ink & Switch) aus den GitHub-Releases,
# für den Keyhive-Lauf a (Automerge über ARK). Lokal und in der CI.
#
# Das Binary liegt einmal im gemeinsamen Zwischenspeicher
# ($PORT_EXPERIMENTE_CACHE, sonst $XDG_CACHE_HOME/port-experimente, sonst ~/.cache/port-experimente) und wird von dort
# nach .cache/ dieses Checkouts verlinkt: ein zweiter Worktree lädt nichts.
set -eu
cd "$(dirname "$0")/.."
TAG="${SUBDUCTION_TAG:-v0.18.0-nightly.2026-09-30}"
VERSION="${SUBDUCTION_VERSION:-0.18.0}"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) ASSET="subduction-linux-x86_64-$VERSION" ;;
  Linux-aarch64) ASSET="subduction-linux-aarch64-$VERSION" ;;
  Darwin-arm64) ASSET="subduction-macos-aarch64-$VERSION" ;;
  *) echo "keine Binary für $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
OUT=".cache/subduction-$VERSION"
SHARED="${PORT_EXPERIMENTE_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/port-experimente}"
case "$SHARED" in /*) ;; *) SHARED="$PWD/$SHARED" ;; esac # ein relativer Pfad gilt ab der Wurzel des Checkouts, auch als Ziel des Verweises
# Der Tag gehört zum Namen: dieselbe Version aus einem anderen Release ist ein anderes Binary.
BIN="$SHARED/subduction/$TAG/$ASSET"
if [ ! -x "$BIN" ]; then
  mkdir -p "$(dirname "$BIN")"
  curl -fsSL -o "$BIN.tmp.$$" "https://github.com/inkandswitch/subduction/releases/download/$TAG/$ASSET"
  chmod +x "$BIN.tmp.$$" && mv "$BIN.tmp.$$" "$BIN"
else
  echo "aus dem Zwischenspeicher: $BIN"
fi
# Der Verweis im Checkout wird bei jedem Aufruf neu gesetzt: er zeigt auf genau das angeforderte Release und Asset,
# auch wenn vorher ein anderes Release derselben Version hier lag.
mkdir -p .cache
rm -f "$OUT"
ln -s "$BIN" "$OUT" 2>/dev/null || cp "$BIN" "$OUT"
"$OUT" --version
