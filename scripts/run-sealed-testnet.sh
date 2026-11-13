#!/bin/bash
# Runs Kaap's sealed job on OutLayer testnet against a real Sputnik proposal, from the caller
# account in packages/sealed/testnet.json (the watcher's account, which is not the project's
# owner), and checks every answer the way a stranger would:
# the verdict decodes, its signature verifies under the printed key with Node's crypto, the
# explanation hash matches, and every run printed the same key. Prints the block height the reads
# were pinned to, and per-run timing and cost. Runs inside WSL with near-cli-rs 0.30.1.
#
# Usage: bash scripts/run-sealed-testnet.sh <dao> <proposal id> [--runs N] [--corrupt] [--guard <account>] [--label <name>]
#   --corrupt   sets the job's testnet-only test flag: the HTTPS read is corrupted, so the job
#               must answer `held` with no signature
#   --guard     the guard account the verdict names (default: the worker account itself)
set -uo pipefail

DAO=${1:?usage: run-sealed-testnet.sh <dao> <proposal id> [--runs N] [--corrupt] [--guard g] [--label l]}
ID=${2:?proposal id}
shift 2
RUNS=3
CORRUPT=false
GUARD=""
LABEL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --runs) RUNS=$2; shift 2 ;;
    --corrupt) CORRUPT=true; shift ;;
    --guard) GUARD=$2; shift 2 ;;
    --label) LABEL=$2; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[[ "$ID" =~ ^[0-9]+$ && "$RUNS" =~ ^[0-9]+$ && "$RUNS" -ge 1 ]] || { echo "proposal id and --runs must be whole numbers" >&2; exit 2; }

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
STATE="$REPO/packages/sealed/testnet.json"
TOOLS="$REPO/packages/sealed/tools"
[[ -f "$STATE" ]] || { echo "no packages/sealed/testnet.json: run scripts/publish-sealed-testnet.sh first" >&2; exit 1; }
ACCOUNT=$(jq -r '.caller // .account' "$STATE")
PROJECT=$(jq -r .project_id "$STATE")
GUARD=${GUARD:-$ACCOUNT}
LABEL=${LABEL:-run-$(date -u +%Y%m%dT%H%M%SZ)}
OUT="${KAAP_SEALED_RUNS:-$HOME/kaap-sealed-testnet/runs}/$LABEL"
mkdir -p "$OUT"

INPUT=$(jq -nc --arg g "$GUARD" --arg d "$DAO" --argjson id "$ID" --argjson c "$CORRUPT" \
  '{v:1, network:"testnet", guard:$g, dao:$d, proposal_id:$id, expires_in_ms:600000} + (if $c then {test_corrupt_https:true} else {} end)')
# All three limits written out on every run: an empty resource_limits object is never picked up
# (OutLayer issue #31). 60 s matches the job's own 50 s budget plus room to sign and print.
ARGS=$(jq -nc --arg p "$PROJECT" --arg i "$INPUT" \
  '{source:{Project:{project_id:$p, version_key:null}}, input_data:$i, response_format:"Json",
    resource_limits:{max_instructions:10000000000, max_memory_mb:128, max_execution_seconds:60}}')

echo "project $PROJECT, caller $ACCOUNT, active version $(jq -r .active_version "$STATE")"
echo "input $INPUT"
FAILED=0
KEYS=()
for n in $(seq 1 "$RUNS"); do
  start=$(node -e 'console.log(Date.now())')
  near contract call-function as-transaction outlayer.testnet request_execution json-args "$ARGS" \
    prepaid-gas '300.0 Tgas' attached-deposit '0.02 NEAR' sign-as "$ACCOUNT" network-config testnet \
    sign-with-legacy-keychain send > "$OUT/$n.log" 2>&1
  cli=$?
  end=$(node -e 'console.log(Date.now())')
  TX=$(sed 's/\x1b\[[0-9;]*m//g' "$OUT/$n.log" | grep -m1 -oE 'Transaction ID: [1-9A-HJ-NP-Za-km-z]{40,50}' | awk '{print $3}')
  if [[ -z "$TX" ]]; then
    echo "run $n: near-cli exit $cli and no transaction id; see $OUT/$n.log"
    FAILED=1
    continue
  fi
  # A failed read-back writes nothing, so the run is failed here rather than checked against an
  # output file a past run under the same --label left behind.
  if ! node "$TOOLS/run-report.mjs" "$TX" "$ACCOUNT" "$OUT/$n.summary.json" "$OUT/$n.output.json" > /dev/null; then
    echo "run $n: could not read transaction $TX back from the testnet RPC; see https://testnet.nearblocks.io/txns/$TX"
    FAILED=1
    continue
  fi
  WALL=$((end - start))
  TMP=$(mktemp)
  jq --argjson w "$WALL" --argjson c "$cli" '.wall_ms = $w | .cli_exit = $c' "$OUT/$n.summary.json" > "$TMP" && mv "$TMP" "$OUT/$n.summary.json"
  CHECK=$(node "$TOOLS/check-output.mjs" "$OUT/$n.output.json" --dao "$DAO" --id "$ID" --network testnet --guard "$GUARD")
  ok=$?
  echo "run $n: $(jq -c '{tx: .explorer, wall_ms, blocks, on_chain_ms, worker_time_ms, total_near}' "$OUT/$n.summary.json")"
  echo "  output: $(cat "$OUT/$n.output.json")"
  echo "  check: $(echo "$CHECK" | jq -c 'if .check == "passed" then {check, public_key, block_height: .verdict.block_height, risk: .verdict.risk, floor: .verdict.floor, findings: .verdict.findings, ai_status: .verdict.ai_status, expires_at_ms: .verdict.expires_at_ms} else . end')"
  [[ $ok -eq 0 ]] || FAILED=1
  if [[ "$CORRUPT" == "true" ]]; then
    [[ "$(jq -r .status "$OUT/$n.output.json")" == "held" && "$(jq -r '.signature // "none"' "$OUT/$n.output.json")" == "none" ]] \
      || { echo "  expected held with no signature"; FAILED=1; }
  else
    [[ "$(echo "$CHECK" | jq -r .check)" == "passed" ]] || FAILED=1
    KEYS+=("$(echo "$CHECK" | jq -r .public_key)")
  fi
done

if [[ "$CORRUPT" != "true" && ${#KEYS[@]} -gt 0 ]]; then
  DISTINCT=$(printf '%s\n' "${KEYS[@]}" | sort -u | wc -l)
  echo "public keys over ${#KEYS[@]} runs: $DISTINCT distinct ($(printf '%s\n' "${KEYS[@]}" | sort -u | tr '\n' ' '))"
  [[ "$DISTINCT" == "1" ]] || FAILED=1
fi
if [[ "$RUNS" -ge 2 ]]; then
  jq -s '
    def pct(p): sort | .[((length - 1) * p | floor)];
    {runs: length,
     wall_ms: {p50: (map(.wall_ms) | pct(0.5)), p90: (map(.wall_ms) | pct(0.9)), max: (map(.wall_ms) | max)},
     on_chain_ms: {p50: (map(.on_chain_ms) | pct(0.5)), p90: (map(.on_chain_ms) | pct(0.9)), max: (map(.on_chain_ms) | max)},
     blocks: {p50: (map(.blocks) | pct(0.5)), p90: (map(.blocks) | pct(0.9)), max: (map(.blocks) | max)},
     worker_time_ms: {p50: (map(.worker_time_ms) | pct(0.5)), p90: (map(.worker_time_ms) | pct(0.9)), max: (map(.worker_time_ms) | max)},
     total_near: {mean: ((map(.total_near) | add) / length), min: (map(.total_near) | min), max: (map(.total_near) | max)},
     outlayer_charge_near_mean: ((map(.outlayer_charge_near) | add) / length),
     gas_burnt_near_mean: ((map(.gas_burnt_near) | add) / length)}' "$OUT"/*.summary.json | tee "$OUT/stats.json"
fi
echo "saved: $OUT"
if [[ $FAILED -eq 0 ]]; then echo "RESULT: pass"; else echo "RESULT: FAIL"; fi
exit $FAILED
