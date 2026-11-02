#!/usr/bin/env bash
# Builds kaap-core-wasm through scripts/build-core-wasm.sh, then turns it into an ES module with the
# wasm-bindgen command line tool, written to the folder given as the first argument (default
# packages/core-wasm/pkg). Needs the repo's Rust toolchain (rust-toolchain.toml installs the wasm
# targets) and wasm-bindgen-cli at exactly the version Cargo.toml pins.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-$here/pkg}"
# The same default as scripts/build-core-wasm.sh, so the wasm is found where that script left it.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/kaap-target}"

want="$(sed -n 's/^wasm-bindgen = "=\(.*\)"$/\1/p' "$here/Cargo.toml")"
have="$(wasm-bindgen --version 2>/dev/null | awk '{print $2}' || true)"
if [ "$have" != "$want" ]; then
  echo "wasm-bindgen $want is needed (found ${have:-none}). Install it with:" >&2
  echo "  cargo install wasm-bindgen-cli --version $want --locked" >&2
  exit 1
fi

bash "$here/../../scripts/build-core-wasm.sh" --release -p kaap-core-wasm
wasm-bindgen --target web --no-typescript --out-dir "$out" "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/kaap_core_wasm.wasm"
