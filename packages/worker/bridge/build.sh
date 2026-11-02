#!/usr/bin/env bash
# Builds the worker's kaap-core bridge to plain WebAssembly and copies it to
# packages/worker/dist/kaap-worker-bridge.wasm, where src/bridge.ts loads it. Runs inside Linux or
# WSL with the toolchain from the repo's rust-toolchain.toml. The build output goes outside the
# repo, because builds on /mnt/d are slow and target/ must never land in it.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/kaap-target-worker}"

# The first build starts from the root lockfile, so shared crates resolve exactly as the sealed
# job and the contracts do.
if [ ! -f "$here/Cargo.lock" ]; then
  cp "$here/../../../Cargo.lock" "$here/Cargo.lock"
fi

cargo build --quiet --manifest-path "$here/Cargo.toml" --target wasm32-unknown-unknown --release

mkdir -p "$here/../dist"
cp "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/kaap_worker_bridge.wasm" "$here/../dist/kaap-worker-bridge.wasm"
