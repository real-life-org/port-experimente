#!/bin/sh
# Holt das Subduction-Server-Binary (Rust, Ink & Switch) aus den GitHub-Releases
# nach .cache/, für den Keyhive-Lauf a (Automerge über ARK). Lokal und in der CI.
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
if [ -x "$OUT" ]; then echo "$OUT vorhanden"; exit 0; fi
mkdir -p .cache
curl -fsSL -o "$OUT.tmp" "https://github.com/inkandswitch/subduction/releases/download/$TAG/$ASSET"
chmod +x "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
"$OUT" --version
