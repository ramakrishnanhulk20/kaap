#!/bin/bash
# Builds the sealed job for wasm32-wasip2 the same way every time, so anyone with the pinned
# toolchain (rust-toolchain.toml) and Cargo.lock gets the same sha256.
#
# Usage: bash packages/sealed/build.sh [local] [out.wasm]
#   local     the plain-wasmtime build with recorded fixtures and a test key, never published
#   out.wasm  where to copy the result (default: next to the target dir)
#
# Local paths are remapped so no home directory or checkout path lands in the binary; the
# script fails if one does.
set -euo pipefail

MODE=${1:-release}
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$HOME/kaap-target-sealed}
CARGO_HOME_DIR=${CARGO_HOME:-$HOME/.cargo}
RUSTUP_HOME_DIR=${RUSTUP_HOME:-$HOME/.rustup}

FEATURES=()
NAME=kaap-sealed
if [[ "$MODE" == "local" ]]; then
  FEATURES=(--features local)
  NAME=kaap-sealed-local
elif [[ "$MODE" != "release" ]]; then
  echo "unknown mode $MODE (expected release or local)" >&2
  exit 2
fi
OUT=${2:-$CARGO_TARGET_DIR/$NAME.wasm}

# The checkout path holds a space, which RUSTFLAGS would split; the encoded form separates
# flags with the 0x1f byte instead.
SEP=$'\x1f'
FLAGS="--remap-path-prefix=$REPO=/kaap${SEP}--remap-path-prefix=$CARGO_HOME_DIR=/cargo${SEP}--remap-path-prefix=$RUSTUP_HOME_DIR=/rustup"
export CARGO_ENCODED_RUSTFLAGS="$FLAGS"
export CARGO_PROFILE_RELEASE_STRIP=symbols

cd "$REPO"
cargo build -p kaap-sealed --release --target wasm32-wasip2 "${FEATURES[@]}"
WASM="$CARGO_TARGET_DIR/wasm32-wasip2/release/kaap-sealed.wasm"
cp "$WASM" "$OUT"

TOOLS=${KAAP_WASM_TOOLS:-$HOME/kaap-m0-outlayer/tools/wasm-tools}
echo "file: $OUT"
echo "size_bytes: $(stat -c%s "$OUT")"
echo "sha256: $(sha256sum "$OUT" | cut -d' ' -f1)"
if [[ -x "$TOOLS" ]]; then
  echo "manifest sections: $("$TOOLS" print "$OUT" 2>/dev/null | grep -c 'outlayer.manifest' || true)"
  echo "imports:"
  "$TOOLS" component wit "$OUT" | grep -E '^\s*import ' | sed 's/^/  /'
fi
LEAKS=$(strings -n 6 "$OUT" | grep -cE '/home/|/mnt/|/root/|/Users/' || true)
echo "local paths in binary: $LEAKS"
if [[ "$LEAKS" != "0" ]]; then
  strings -n 6 "$OUT" | grep -E '/home/|/mnt/|/root/|/Users/' | head -n 5 >&2
  echo "refusing: a local path is in the binary" >&2
  exit 1
fi
