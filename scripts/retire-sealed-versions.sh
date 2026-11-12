#!/bin/bash
# Removes published builds of the sealed job from its OutLayer testnet project, so nobody can name
# them with `version_key` any more. A build published before the price gate would otherwise run for
# anyone, free. Each build named must be recorded in packages/sealed/testnet.json and must not be
# the active one. The project owner signs `remove_version`, the script checks the build is gone from
# `list_versions`, and only then marks that entry `retired: true`. The entry stays in the file, so
# `kaap verify` still knows the build when it checks a past run; past runs live in OutLayer's
# attestation records, not in the version list. A build already gone is only marked.
#
# Usage: bash scripts/retire-sealed-versions.sh <sha256> [<sha256> ...]
# Runs inside WSL with near-cli-rs 0.30.1, with the owner's key in ~/.near-credentials/testnet.
# Testnet only. Each removal costs about 0.0005 testnet NEAR of gas and refunds the build's storage.
set -euo pipefail

[[ $# -ge 1 ]] || { echo "usage: retire-sealed-versions.sh <sha256> [<sha256> ...]" >&2; exit 2; }
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
STATE="$REPO/packages/sealed/testnet.json"
CONTRACT=$(jq -r .contract "$STATE")
ACCOUNT=$(jq -r .account "$STATE")
PROJECT=$(jq -r .project_id "$STATE")
NAME=${PROJECT#*/}
LOGS=${KAAP_SEALED_WORK:-$HOME/kaap-sealed-testnet}
mkdir -p "$LOGS"
command -v near >/dev/null || { echo "near-cli-rs is not on PATH" >&2; exit 1; }
[[ "$(jq -r .network "$STATE")" == "testnet" && "$CONTRACT" == "outlayer.testnet" ]] || { echo "$STATE is not the testnet record" >&2; exit 1; }
# remove_version acts on the signer's own project by name, so the project read must be that one.
[[ -n "$NAME" && "$NAME" != */* && "$PROJECT" == "$ACCOUNT/$NAME" ]] || { echo "$STATE names project $PROJECT, which is not $ACCOUNT's own" >&2; exit 1; }
[[ -f "$HOME/.near-credentials/testnet/$ACCOUNT.json" ]] || { echo "no key for $ACCOUNT in ~/.near-credentials/testnet" >&2; exit 1; }

view() {
  near contract call-function as-read-only "$CONTRACT" "$1" json-args "$2" network-config testnet now 2>/dev/null
}

# Sets ACTIVE and VERSIONS from the chain. Called only as a plain statement, so its exit stops the
# script: an answer that does not list the active build is a failed read, never "already removed".
# A full page of 100 may not be every build, and a build past it would read as already removed.
read_versions() {
  ACTIVE=$(view get_project "$(jq -nc --arg p "$PROJECT" '{project_id:$p}')" | jq -r .active_version) || ACTIVE=""
  VERSIONS=$(view list_versions "$(jq -nc --arg p "$PROJECT" '{project_id:$p, from_index:0, limit:100}')" \
    | jq -r 'if type == "array" and length < 100 then .[].wasm_hash else error("not a list of under 100 builds") end') || VERSIONS=""
  if ! [[ "$ACTIVE" =~ ^[0-9a-f]{64}$ ]] || ! grep -qx "$ACTIVE" <<<"$VERSIONS"; then
    echo "STOP: could not read $PROJECT and its versions from $CONTRACT (a failed read, or 100 or more builds, which is more than one page)" >&2
    exit 1
  fi
}

for SHA in "$@"; do
  [[ "$SHA" =~ ^[0-9a-f]{64}$ ]] || { echo "not a sha256: $SHA" >&2; exit 2; }
  [[ "$(jq --arg s "$SHA" '[.versions[] | select(.sha256 == $s)] | length' "$STATE")" == "1" ]] \
    || { echo "$SHA is not a build recorded in packages/sealed/testnet.json" >&2; exit 1; }
  read_versions
  if [[ "$SHA" == "$ACTIVE" || "$SHA" == "$(jq -r .active_version "$STATE")" ]]; then
    echo "STOP: $SHA is the active build; it is never removed" >&2
    exit 1
  fi

  if grep -qx "$SHA" <<<"$VERSIONS"; then
    LOG="$LOGS/retire-${SHA:0:8}.log"
    near contract call-function as-transaction "$CONTRACT" remove_version \
      json-args "$(jq -nc --arg n "$NAME" --arg v "$SHA" '{project_name:$n, version_key:$v}')" \
      prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' sign-as "$ACCOUNT" network-config testnet \
      sign-with-legacy-keychain send > "$LOG" 2>&1 || { tail -n 30 "$LOG" >&2; exit 1; }
    TX=$(sed 's/\x1b\[[0-9;]*m//g' "$LOG" | grep -m1 -oE 'Transaction ID: [1-9A-HJ-NP-Za-km-z]{40,50}' | awk '{print $3}' || true)
    sed 's/\x1b\[[0-9;]*m//g' "$LOG" | grep -m1 -oE 'Version removed: .*refund=[0-9]+' || true
    echo "remove_version ${SHA:0:8}: https://testnet.nearblocks.io/txns/${TX:-<no id printed, see $LOG>}"
  else
    echo "${SHA:0:8} is already gone from the project; only marking it"
  fi

  # A view can trail the block the removal landed in by a moment.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    read_versions
    grep -qx "$SHA" <<<"$VERSIONS" || break
    sleep 3
  done
  if grep -qx "$SHA" <<<"$VERSIONS"; then
    echo "STOP: ${SHA:0:8} is still listed by $CONTRACT; packages/sealed/testnet.json not changed" >&2
    exit 1
  fi
  TMP=$(mktemp)
  # Two plain statements: in `jq && mv` a failed jq would not stop the script, and the line below
  # would still claim the mark.
  jq --arg s "$SHA" '(.versions[] | select(.sha256 == $s) | .retired) = true' "$STATE" > "$TMP"
  mv "$TMP" "$STATE"
  echo "marked ${SHA:0:8} retired in packages/sealed/testnet.json"
done
read_versions
echo "still listed: $(cut -c1-8 <<<"$VERSIONS" | tr '\n' ' ')(active ${ACTIVE:0:8})"
