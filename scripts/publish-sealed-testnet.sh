#!/bin/bash
# Publishes the sealed job on OutLayer testnet as project `kaap-sealed`, owned by Kaap's testnet
# worker account, in one repeatable run:
#   1. builds the wasm (packages/sealed/build.sh: pinned toolchain, local paths remapped);
#   2. creates the worker account from the testnet faucet if packages/sealed/testnet.json names
#      none yet (its key stays in ~/.near-credentials/testnet, legacy keychain, never in the repo);
#   3. hosts the wasm: `fastfs` uploads it to testnet FastFS from the worker account; any https URL
#      means the file is already served there (a host Ram approved);
#   4. downloads the URL and stops unless the served bytes have the build's sha256, because a run
#      whose wasm cannot be fetched is not refused, it hangs about 200 blocks (m0c spike);
#   5. registers it: create_project the first time, add_version (set active) after that.
# Runs inside WSL with near-cli-rs 0.30.1. Testnet only.
#
# Usage: bash scripts/publish-sealed-testnet.sh fastfs
#        bash scripts/publish-sealed-testnet.sh https://<host>/<path>/<file>.wasm
set -euo pipefail

HOST_ARG=${1:?usage: publish-sealed-testnet.sh fastfs | https://...}
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
STATE="$REPO/packages/sealed/testnet.json"
WORK=${KAAP_SEALED_WORK:-$HOME/kaap-sealed-testnet}
CONTRACT=outlayer.testnet
PROJECT_NAME=kaap-sealed
mkdir -p "$WORK"
command -v near >/dev/null || { echo "near-cli-rs is not on PATH" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is not on PATH" >&2; exit 1; }

echo "== 1. build"
bash "$REPO/packages/sealed/build.sh" release "$WORK/kaap-sealed.wasm" | grep -E '^(size_bytes|sha256|manifest sections|local paths)'
SHA=$(sha256sum "$WORK/kaap-sealed.wasm" | cut -d' ' -f1)
WASM="$WORK/kaap-sealed-$SHA.wasm"
cp "$WORK/kaap-sealed.wasm" "$WASM"
echo "build: $WASM"

echo "== 2. worker account"
if [[ -f "$STATE" ]]; then
  ACCOUNT=$(jq -r .account "$STATE")
  echo "reusing $ACCOUNT from packages/sealed/testnet.json"
else
  ACCOUNT="kaap-worker-$(date -u +%m%d%H%M%S).testnet"
  near account create-account sponsor-by-faucet-service "$ACCOUNT" autogenerate-new-keypair \
    save-to-legacy-keychain network-config testnet create > "$WORK/create-account.log" 2>&1 \
    || { tail -n 20 "$WORK/create-account.log" >&2; exit 1; }
  echo "created $ACCOUNT (key in ~/.near-credentials/testnet only)"
  jq -n --arg a "$ACCOUNT" --arg p "$ACCOUNT/$PROJECT_NAME" \
    '{network:"testnet", account:$a, project_id:$p, contract:"outlayer.testnet", versions:[]}' > "$STATE"
fi
[[ -f "$HOME/.near-credentials/testnet/$ACCOUNT.json" ]] || { echo "no key for $ACCOUNT in ~/.near-credentials/testnet" >&2; exit 1; }

echo "== 3. host"
if [[ "$HOST_ARG" == "fastfs" ]]; then
  URL="https://test.fastfs.io/$ACCOUNT/$CONTRACT/$SHA.wasm"
  # FastFS's own format (OutLayer scripts/upload_wasm_fastfs.py): borsh FastfsData::Simple.
  python3 -I - "$WASM" "$SHA" "$WORK/fastfs-payload.bin" <<'PY'
import struct, sys
wasm, sha, out = sys.argv[1], sys.argv[2], sys.argv[3]
content = open(wasm, "rb").read()
assert len(content) <= 1 << 20, "over 1 MB needs the chunked form"
s = lambda b: struct.pack("<I", len(b)) + b
open(out, "wb").write(b"\x00" + s(f"{sha}.wasm".encode()) + b"\x01" + s(b"application/wasm") + s(content))
PY
  # The call fails with "Exceeded the prepaid gas." by design: FastFS indexes the arguments.
  near contract call-function as-transaction "$CONTRACT" __fastdata_fastfs file-args "$WORK/fastfs-payload.bin" \
    prepaid-gas '1 Ggas' attached-deposit '0 NEAR' sign-as "$ACCOUNT" network-config testnet \
    sign-with-legacy-keychain send > "$WORK/fastfs-upload.log" 2>&1 || true
  echo "uploaded to FastFS; waiting for $URL"
elif [[ "$HOST_ARG" == https://* ]]; then
  URL="$HOST_ARG"
else
  echo "the host must be fastfs or an https URL" >&2
  exit 2
fi

echo "== 4. served sha256"
SERVED=""
for attempt in $(seq 1 30); do
  SERVED=$(curl -sS -L --max-time 60 --max-filesize 10000000 "$URL" 2>/dev/null | sha256sum | cut -d' ' -f1 || true)
  [[ "$SERVED" == "$SHA" ]] && break
  [[ "$HOST_ARG" == "fastfs" ]] || break
  sleep 10
done
CODE=$(curl -sS -o /dev/null -w '%{http_code} %{num_redirects} %{content_type}' --max-time 60 "$URL" || true)
echo "url: $URL"
echo "http status, redirects, content type: $CODE"
if [[ "$SERVED" != "$SHA" ]]; then
  echo "STOP: the URL does not serve the build (served sha256 ${SERVED:-none}, build $SHA). Nothing registered." >&2
  exit 1
fi
echo "served sha256 matches: $SHA"

echo "== 5. register"
SOURCE=$(jq -nc --arg u "$URL" --arg h "$SHA" '{WasmUrl:{url:$u, hash:$h, build_target:"wasm32-wasip2"}}')
EXISTS=$(near contract call-function as-read-only "$CONTRACT" get_project json-args "$(jq -nc --arg p "$ACCOUNT/$PROJECT_NAME" '{project_id:$p}')" \
  network-config testnet now 2>/dev/null | grep -c '"uuid"' || true)
if [[ "$EXISTS" == "0" ]]; then
  METHOD=create_project
  ARGS=$(jq -nc --arg n "$PROJECT_NAME" --argjson s "$SOURCE" '{name:$n, source:$s}')
  # Storage deposit is about 0.0074 NEAR; the contract refunds the rest.
  DEPOSIT='0.1 NEAR'
else
  METHOD=add_version
  ARGS=$(jq -nc --arg n "$PROJECT_NAME" --argjson s "$SOURCE" '{project_name:$n, source:$s, set_active:true}')
  DEPOSIT='0.05 NEAR'
fi
near contract call-function as-transaction "$CONTRACT" "$METHOD" json-args "$ARGS" prepaid-gas '100.0 Tgas' \
  attached-deposit "$DEPOSIT" sign-as "$ACCOUNT" network-config testnet sign-with-legacy-keychain send \
  > "$WORK/register.log" 2>&1 || { tail -n 30 "$WORK/register.log" >&2; exit 1; }
TX=$(sed 's/\x1b\[[0-9;]*m//g' "$WORK/register.log" | grep -m1 -oE 'Transaction ID: [1-9A-HJ-NP-Za-km-z]{40,50}' | awk '{print $3}')
grep -m3 -E 'Project created|Version added' "$WORK/register.log" | sed 's/\x1b\[[0-9;]*m//g' || true
echo "$METHOD tx: https://testnet.nearblocks.io/txns/$TX"

PROJECT=$(near contract call-function as-read-only "$CONTRACT" get_project json-args "$(jq -nc --arg p "$ACCOUNT/$PROJECT_NAME" '{project_id:$p}')" \
  network-config testnet now 2>/dev/null | sed -n '/^{/,/^}/p')
echo "project: $(echo "$PROJECT" | jq -c '{project_id, uuid, active_version}')"
TMP=$(mktemp)
jq --arg sha "$SHA" --arg url "$URL" --arg tx "$TX" --arg m "$METHOD" --arg uuid "$(echo "$PROJECT" | jq -r .uuid)" \
  --arg size "$(stat -c%s "$WASM")" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '.uuid = $uuid | .active_version = $sha | .versions += [{sha256:$sha, bytes:($size|tonumber), url:$url, registered_by:$m, tx:$tx, at:$at, retired:false}]' \
  "$STATE" > "$TMP" && mv "$TMP" "$STATE"
echo "state: packages/sealed/testnet.json"
