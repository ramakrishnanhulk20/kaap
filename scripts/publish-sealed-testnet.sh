#!/bin/bash
# Publishes the sealed job on OutLayer testnet as project `kaap-sealed`, in one repeatable run.
# The project belongs to an owner account that does nothing else: OutLayer lets only a project's
# owner publish a build of it or choose the active one. The watcher's account only calls the
# project, so the key on the watcher's host cannot replace the program.
#   1. creates the owner account from the testnet faucet if packages/sealed/testnet.json names
#      none yet (its key stays in ~/.near-credentials/testnet, legacy keychain, never in the repo
#      and never on the watcher's host), and writes down the caller: KAAP_SEALED_CALLER, or the
#      worker account of deployments/testnet.json. The build reads the caller's name from that
#      file, since the caller's own runs are free, so the file comes before the build;
#   2. builds the wasm (packages/sealed/build.sh: pinned toolchain, local paths remapped);
#   3. hosts the wasm: `fastfs` uploads it to testnet FastFS from the owner account; any https URL
#      means the file is already served there (a host the operator approved);
#   4. downloads the URL and stops unless the served bytes have the build's sha256, because a run
#      whose wasm cannot be fetched is not refused, it hangs about 200 blocks (seen 24 Oct 2026);
#   5. registers it: create_project the first time, add_version (set active) after that, then
#      records the build in packages/sealed/testnet.json only once the project read back from the
#      chain names it active. A read that fails stops the run; it never counts as "no project".
# Runs inside WSL with near-cli-rs 0.30.1. Testnet only.
#
# Usage: bash scripts/publish-sealed-testnet.sh prepare     steps 1 and 2 only: nothing is hosted
#                                                           or registered, and the build's file and
#                                                           sha256 are printed, to host it by hand
#        bash scripts/publish-sealed-testnet.sh fastfs
#        bash scripts/publish-sealed-testnet.sh https://<host>/<path>/<file>.wasm
set -euo pipefail

HOST_ARG=${1:?usage: publish-sealed-testnet.sh prepare | fastfs | https://...}
[[ "$HOST_ARG" == prepare || "$HOST_ARG" == fastfs || "$HOST_ARG" == https://* ]] || { echo "the argument must be prepare, fastfs or an https URL" >&2; exit 2; }
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
STATE="$REPO/packages/sealed/testnet.json"
WORK=${KAAP_SEALED_WORK:-$HOME/kaap-sealed-testnet}
CONTRACT=outlayer.testnet
PROJECT_NAME=kaap-sealed
mkdir -p "$WORK"
command -v near >/dev/null || { echo "near-cli-rs is not on PATH" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is not on PATH" >&2; exit 1; }
# shellcheck source=scripts/lib/sealed-project.sh
. "$REPO/scripts/lib/sealed-project.sh"

echo "== 1. owner account"
if [[ -f "$STATE" ]]; then
  ACCOUNT=$(jq -r '.owner // .account' "$STATE")
  echo "reusing $ACCOUNT from packages/sealed/testnet.json"
else
  CALLER=${KAAP_SEALED_CALLER:-$(jq -r .sealed.worker_account "$REPO/deployments/testnet.json")}
  [[ "$CALLER" =~ ^[a-z0-9._-]{2,64}$ ]] || { echo "no caller: set KAAP_SEALED_CALLER to the watcher's account" >&2; exit 1; }
  ACCOUNT="kaap-sealed-owner-$(date -u +%m%d%H%M%S).testnet"
  near account create-account sponsor-by-faucet-service "$ACCOUNT" autogenerate-new-keypair \
    save-to-legacy-keychain network-config testnet create > "$WORK/create-account.log" 2>&1 \
    || { tail -n 20 "$WORK/create-account.log" >&2; exit 1; }
  echo "created $ACCOUNT (key in ~/.near-credentials/testnet only)"
fi
[[ -f "$HOME/.near-credentials/testnet/$ACCOUNT.json" ]] || { echo "no key for $ACCOUNT in ~/.near-credentials/testnet" >&2; exit 1; }
if [[ ! -f "$STATE" ]]; then
  [[ "$CALLER" != "$ACCOUNT" ]] || { echo "the caller must not be the owner" >&2; exit 1; }
  jq -n --arg o "$ACCOUNT" --arg c "$CALLER" --arg p "$ACCOUNT/$PROJECT_NAME" \
    '{network:"testnet", owner:$o, caller:$c, project_id:$p, contract:"outlayer.testnet", versions:[]}' > "$STATE"
fi
echo "caller: $(jq -r '.caller // .account' "$STATE")"

echo "== 2. build"
bash "$REPO/packages/sealed/build.sh" release "$WORK/kaap-sealed.wasm" | grep -E '^(size_bytes|sha256|manifest sections|local paths)'
SHA=$(sha256sum "$WORK/kaap-sealed.wasm" | cut -d' ' -f1)
WASM="$WORK/kaap-sealed-$SHA.wasm"
cp "$WORK/kaap-sealed.wasm" "$WASM"
echo "build: $WASM"
if [[ "$HOST_ARG" == prepare ]]; then
  echo "prepared: nothing hosted, nothing registered. Host $WASM at an https URL, then run this script with that URL."
  exit 0
fi

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
else
  URL="$HOST_ARG"
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
METHOD=$(registration_method "$CONTRACT" "$ACCOUNT/$PROJECT_NAME") \
  || { echo "STOP: could not tell whether $ACCOUNT/$PROJECT_NAME exists on $CONTRACT. Nothing registered; check the testnet RPC and run again." >&2; exit 1; }
if [[ "$METHOD" == "create_project" ]]; then
  ARGS=$(jq -nc --arg n "$PROJECT_NAME" --argjson s "$SOURCE" '{name:$n, source:$s}')
  # Storage deposit is about 0.0074 NEAR; the contract refunds the rest.
  DEPOSIT='0.1 NEAR'
else
  ARGS=$(jq -nc --arg n "$PROJECT_NAME" --argjson s "$SOURCE" '{project_name:$n, source:$s, set_active:true}')
  DEPOSIT='0.05 NEAR'
fi
near contract call-function as-transaction "$CONTRACT" "$METHOD" json-args "$ARGS" prepaid-gas '100.0 Tgas' \
  attached-deposit "$DEPOSIT" sign-as "$ACCOUNT" network-config testnet sign-with-legacy-keychain send \
  > "$WORK/register.log" 2>&1 || { tail -n 30 "$WORK/register.log" >&2; exit 1; }
TX=$(sed 's/\x1b\[[0-9;]*m//g' "$WORK/register.log" | grep -m1 -oE 'Transaction ID: [1-9A-HJ-NP-Za-km-z]{40,50}' | awk '{print $3}' || true)
grep -m3 -E 'Project created|Version added' "$WORK/register.log" | sed 's/\x1b\[[0-9;]*m//g' || true
if ! [[ "$TX" =~ ^[1-9A-HJ-NP-Za-km-z]{43,44}$ ]]; then
  echo "STOP: $METHOD was sent, but near-cli printed no transaction id. packages/sealed/testnet.json not changed; see $WORK/register.log and check get_project for $ACCOUNT/$PROJECT_NAME on $CONTRACT." >&2
  exit 1
fi
echo "$METHOD tx: https://testnet.nearblocks.io/txns/$TX"

record_registration "$STATE" "$CONTRACT" "$ACCOUNT/$PROJECT_NAME" "$SHA" "$URL" "$TX" "$METHOD" "$(stat -c%s "$WASM")" \
  || { echo "STOP: $METHOD went through (https://testnet.nearblocks.io/txns/$TX), but the project read back from $CONTRACT did not confirm this build as active (reason above), so packages/sealed/testnet.json was not changed. Check get_project for $ACCOUNT/$PROJECT_NAME, then add the build to the file." >&2; exit 1; }
echo "state: packages/sealed/testnet.json"
