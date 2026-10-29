#!/bin/bash
# DONE MEANS 1, second half: the local build under plain wasmtime, against a recorded fixture,
# signed with the RFC 8032 test key, checked with Node crypto. Also runs the corrupt flag and a
# refused input. Needs wasmtime (KAAP_WASMTIME, default the M0 copy of 28.0.1).
#
# Usage: bash packages/sealed/run-local.sh [fixture.json ...]
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WASMTIME=${KAAP_WASMTIME:-$HOME/kaap-m0-outlayer/tools/wasmtime28}
OUT_DIR=${KAAP_LOCAL_OUT:-$HOME/kaap-target-sealed/local-runs}
mkdir -p "$OUT_DIR"
WASM="$OUT_DIR/kaap-sealed-local.wasm"
bash "$HERE/build.sh" local "$WASM" | grep -E '^(sha256|size_bytes|local paths)'
TEST_KEY=ed25519:FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z
FIXTURES=("$@")
if [[ ${#FIXTURES[@]} -eq 0 ]]; then FIXTURES=("$HERE"/tests/fixtures/transfer-ft.json "$HERE"/tests/fixtures/function-call.json "$HERE"/tests/fixtures/vote.json); fi

job() { # fixture, input
  local dir name
  dir=$(dirname "$1"); name=$(basename "$1")
  printf '%s' "$2" | "$WASMTIME" run -S http --dir "$dir::/fixtures" \
    --env NEAR_NETWORK_ID=testnet --env "KAAP_FIXTURES=/fixtures/$name" "$WASM"
}

for fx in "${FIXTURES[@]}"; do
  dao=$(jq -r .dao "$fx"); id=$(jq -r .proposal_id "$fx"); height=$(jq -r .block_height "$fx")
  input="{\"v\":1,\"network\":\"testnet\",\"guard\":\"guard.kaap.testnet\",\"dao\":\"$dao\",\"proposal_id\":$id,\"expires_in_ms\":600000}"
  echo "== $(basename "$fx"): $dao #$id, recorded at block $height"
  job "$fx" "$input" > "$OUT_DIR/out.json"
  echo "output: $(cat "$OUT_DIR/out.json")"
  node "$HERE/tools/check-output.mjs" "$OUT_DIR/out.json" --dao "$dao" --id "$id" --network testnet --block_height "$height" --key "$TEST_KEY" \
    | jq -c '{check, bytes, public_key, block_height: .verdict.block_height, risk: .verdict.risk, floor: .verdict.floor, findings: .verdict.findings, ai_status: .verdict.ai_status}'
done

fx=${FIXTURES[0]}
dao=$(jq -r .dao "$fx"); id=$(jq -r .proposal_id "$fx")
echo "== corrupt flag on $(basename "$fx")"
job "$fx" "{\"v\":1,\"network\":\"testnet\",\"guard\":\"guard.kaap.testnet\",\"dao\":\"$dao\",\"proposal_id\":$id,\"expires_in_ms\":600000,\"test_corrupt_https\":true}" > "$OUT_DIR/out.json"
echo "output: $(cat "$OUT_DIR/out.json")"
node "$HERE/tools/check-output.mjs" "$OUT_DIR/out.json"
echo "== refused input"
job "$fx" '{"v":1,"network":"testnet","dao":"x"}' > "$OUT_DIR/out.json"
echo "output: $(cat "$OUT_DIR/out.json")"
