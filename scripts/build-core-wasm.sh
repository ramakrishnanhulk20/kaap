#!/usr/bin/env bash
# Builds kaap-core for both wasm hosts: wasm32-unknown-unknown (contracts, browser) and
# wasm32-wasip2 (the sealed job on OutLayer). Extra arguments, such as --release, are passed on.
set -euo pipefail
cd "$(dirname "$0")/.."
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/kaap-target}"

cargo build -p kaap-core --target wasm32-unknown-unknown "$@"
cargo build -p kaap-core --target wasm32-wasip2 "$@"
