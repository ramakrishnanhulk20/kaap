#!/usr/bin/env bash
# Deploys kaap-guard and kaap-registry to fresh, faucet-funded testnet accounts. Each contract's
# init runs in the same transaction as its deploy, then the account's only full-access key is
# deleted, so nobody, including us, can ever change the code. Prints the account ids, the code
# hashes and explorer links.
#
# Testnet only. Run inside WSL (or any Linux shell) from anywhere in the repo:
#   bash scripts/WO-02a-deploy-testnet.sh
# Needs cargo-near 0.22.0, near-cli-rs 0.30.1 and python3. The testnet faucet pays for every
# account, so no wallet or funds are needed.
#
# Optional settings, read from the environment or from .env:
#   KAAP_ACCEPTED_KEY  the ed25519 key both contracts obey. The default is the public half of the
#                      sandbox tests' fixed test seed, a throwaway until the sealed program's key
#                      replaces it (the guard by set_accepted_key, the registry by a new deploy).
#   KAAP_GUARD_OWNER   the testnet account that alone may change the guard's key. The default is a
#                      fresh faucet account made here, whose key is saved in ~/.near-credentials.
#   KAAP_DEPLOY        guard, registry or both (the default).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

NETWORK=testnet
THROWAWAY_TEST_KEY="ed25519:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB"
ACCEPTED_KEY="${KAAP_ACCEPTED_KEY:-$THROWAWAY_TEST_KEY}"
DEPLOY="${KAAP_DEPLOY:-both}"
STAMP="$(date -u +%m%d%H%M%S)"
CREDENTIALS="$HOME/.near-credentials/$NETWORK"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/kaap-target}"
OUT="$CARGO_TARGET_DIR/near-deploy"
LOG="$CARGO_TARGET_DIR/near-deploy/deploy-$STAMP.log"

case "$DEPLOY" in
  guard | registry | both) ;;
  *) echo "KAAP_DEPLOY must be guard, registry or both, not '$DEPLOY'" >&2; exit 1 ;;
esac
for tool in cargo-near near python3 sha256sum; do
  command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 1; }
done
mkdir -p "$OUT"
: >"$LOG"

say() { printf '%s\n' "$*" | tee -a "$LOG"; }

# Runs one near-cli-rs command, keeps its full output in the log, and prints the transaction id
# it reports, if any. Exits the script when the command fails.
run_near() {
  local output
  if ! output="$(near "$@" 2>&1)"; then
    printf '%s\n' "$output" >>"$LOG"
    printf '%s\n' "$output" >&2
    echo "near $1 $2 failed; full output in $LOG" >&2
    exit 1
  fi
  printf '%s\n' "$output" >>"$LOG"
  printf '%s\n' "$output" | sed -n 's/.*Transaction ID: \([1-9A-HJ-NP-Za-km-z]\{43,44\}\).*/\1/p' | head -n 1
}

public_key_of() {
  python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["public_key"])' "$CREDENTIALS/$1.json"
}

create_account() {
  local id="$1"
  run_near account create-account sponsor-by-faucet-service "$id" \
    autogenerate-new-keypair save-to-legacy-keychain network-config "$NETWORK" create >/dev/null
  [ -f "$CREDENTIALS/$id.json" ] || { echo "no key saved for $id" >&2; exit 1; }
}

build() {
  local crate="$1"
  (cd "$ROOT/packages/contracts/$crate" &&
    cargo near build non-reproducible-wasm --locked --out-dir "$OUT" >>"$LOG" 2>&1) || {
    echo "cargo near build failed for $crate; see $LOG" >&2
    exit 1
  }
}

# near-cli-rs prints a view's return value alone on stdout and everything else on stderr.
view() {
  near contract call-function as-read-only "$1" "$2" json-args "$3" network-config "$NETWORK" now \
    2>>"$LOG" | tee -a "$LOG" | tr -d '\n '
}

# Deploys, runs init, deletes the full-access key and checks that no key is left.
deploy() {
  local id="$1" wasm="$2" init_args="$3" deploy_tx key delete_tx keys_left
  deploy_tx="$(run_near contract deploy "$id" use-file "$wasm" \
    with-init-call new json-args "$init_args" prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
    network-config "$NETWORK" sign-with-legacy-keychain send)"
  key="$(public_key_of "$id")"
  delete_tx="$(run_near account delete-keys "$id" public-keys "$key" \
    network-config "$NETWORK" sign-with-legacy-keychain send)"
  keys_left="$(near account list-keys "$id" network-config "$NETWORK" now 2>&1 | tee -a "$LOG" | grep -c 'ed25519:' || true)"
  if [ "$keys_left" != "0" ]; then
    echo "$id still has $keys_left access key(s) after the delete; stopping" >&2
    exit 1
  fi
  DEPLOY_TX="$deploy_tx"
  DELETE_TX="$delete_tx"
}

link_account() { printf 'https://testnet.nearblocks.io/address/%s' "$1"; }
link_tx() { if [ -n "$1" ]; then printf 'https://testnet.nearblocks.io/txns/%s' "$1"; else printf '(no id printed)'; fi; }

say "Kaap testnet deploy, $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
say "accepted key: $ACCEPTED_KEY"
if [ "$ACCEPTED_KEY" = "$THROWAWAY_TEST_KEY" ]; then
  say "  (the sandbox tests' public test key: anyone can sign with it, so this deploy is for testing only)"
fi

if [ "$DEPLOY" != "registry" ]; then
  build guard
  if [ -n "${KAAP_GUARD_OWNER:-}" ]; then
    OWNER="$KAAP_GUARD_OWNER"
    say "guard owner: $OWNER (from KAAP_GUARD_OWNER)"
  else
    OWNER="kaap-owner-$STAMP.$NETWORK"
    create_account "$OWNER"
    say "guard owner: $OWNER (new faucet account; its key is in $CREDENTIALS/$OWNER.json)"
  fi
  GUARD="kaap-guard-$STAMP.$NETWORK"
  create_account "$GUARD"
  deploy "$GUARD" "$OUT/kaap_guard.wasm" \
    "{\"owner\":\"$OWNER\",\"accepted_key\":\"$ACCEPTED_KEY\",\"network\":\"$NETWORK\"}"
  say ""
  say "kaap-guard:    $GUARD"
  say "  code sha256: $(sha256sum "$OUT/kaap_guard.wasm" | cut -d' ' -f1)"
  say "  account:     $(link_account "$GUARD")"
  say "  deploy+init: $(link_tx "$DEPLOY_TX")"
  say "  key deleted: $(link_tx "$DELETE_TX")"
  say "  views:       accepted_key=$(view "$GUARD" accepted_key '{}') network=$(view "$GUARD" network '{}') owner=$(view "$GUARD" owner '{}')"
fi

if [ "$DEPLOY" != "guard" ]; then
  build registry
  REGISTRY="kaap-registry-$STAMP.$NETWORK"
  create_account "$REGISTRY"
  deploy "$REGISTRY" "$OUT/kaap_registry.wasm" \
    "{\"accepted_key\":\"$ACCEPTED_KEY\",\"network\":\"$NETWORK\"}"
  say ""
  say "kaap-registry: $REGISTRY"
  say "  code sha256: $(sha256sum "$OUT/kaap_registry.wasm" | cut -d' ' -f1)"
  say "  account:     $(link_account "$REGISTRY")"
  say "  deploy+init: $(link_tx "$DEPLOY_TX")"
  say "  key deleted: $(link_tx "$DELETE_TX")"
fi

say ""
say "No full-access key is left on the contract accounts. Full log: $LOG"
