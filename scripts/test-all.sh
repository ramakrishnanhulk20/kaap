#!/usr/bin/env bash
# Runs every test suite in one shell, so the whole run is a single wsl.exe call from Windows.
# The build output goes to the WSL home: builds on /mnt/d are slow, and target/ must never land
# in the repo.
set -euo pipefail
cd "$(dirname "$0")/.."
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/kaap-target}"

cargo test --workspace

# Further suites go below this line, never above it.
