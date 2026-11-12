#!/usr/bin/env bash
# Runs Kaap's worker against the testnet deployment in deployments/testnet.json, from this
# machine, until Ctrl-C. Inside WSL (or any Linux), from anywhere:
#   bash scripts/run-worker-local.sh
# Settings come from the environment first, then .env at the repo root (the worker reads it
# itself), and any KAAP_ setting still unset gets the testnet default printed below. The worker
# key is never read here: the worker loads it from KAAP_WORKER_CREDENTIALS_FILE.
set -euo pipefail
cd "$(dirname "$0")/.."

node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$node_major" -lt 24 ]; then
  echo "the worker needs Node 24 or later; this shell has $(node --version 2>/dev/null || echo none)" >&2
  exit 2
fi

state() { node -p "const s = require('./deployments/testnet.json'); $1"; }
worker="$(state 's.sealed.worker_account')"

# Only fill what is unset, so .env and the environment always win.
default() {
  local name="$1" value="$2"
  if [ -z "${!name:-}" ] && ! grep -qs "^${name}=." .env; then
    export "$name=$value"
    echo "default $name=$value"
  fi
}
default KAAP_NETWORK testnet
default KAAP_WORKER_ACCOUNT "$worker"
default KAAP_WORKER_CREDENTIALS_FILE "$HOME/.near-credentials/testnet/$worker.json"
default KAAP_GUARD "$(state 's.guard.account_id')"
default KAAP_REGISTRY "$(state 's.registry.account_id')"
default KAAP_OUTLAYER outlayer.testnet
default KAAP_SEALED_PROJECT "$(state 's.sealed.project_id')"
# Two free providers that held the watcher's steady load on 12 Nov 2026. fastnear's free tier began
# refusing it after seven minutes, and a vote is held whenever one provider will not answer.
default KAAP_RPC_PRIMARY https://near-testnet.drpc.org
default KAAP_RPC_SECONDARY https://testnet-rpc.intea.rs
default KAAP_WORKER_DB "$HOME/kaap-worker/testnet.sqlite"
default KAAP_CAP_RUNS_PER_DAO_DAY 60
default KAAP_CAP_RECORDS_PER_DAO_DAY 60
default KAAP_CAP_NEAR_PER_DAY 1

if [ ! -f packages/worker/dist/kaap-worker-bridge.wasm ]; then
  bash packages/worker/bridge/build.sh
fi

exec node packages/worker/src/main.ts
