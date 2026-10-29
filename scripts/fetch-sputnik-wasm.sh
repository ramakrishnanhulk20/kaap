#!/usr/bin/env bash
# Fetches the Sputnik DAO 3.2 contract code the sandbox tests deploy, straight from NEAR mainnet,
# where it is the global contract every 3.2 DAO runs. The code is asked for by its hash, and the
# bytes are checked against the sha256 below before they are saved, so a wrong or tampered answer
# from either RPC is refused, never tested against.
#
# Run inside WSL (or any Linux shell) from anywhere in the repo:
#   bash scripts/fetch-sputnik-wasm.sh
# Needs curl and python3. Read only: no keys, no transactions.
set -euo pipefail
cd "$(dirname "$0")/.."

CODE_HASH="DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF"
# The same bytes' sha256 in hex, recorded from our own copy, saved from this same query on
# 20 Oct 2026. CODE_HASH is its base58 form.
SHA256="bf6f951ee5e45968e3367fa857bebf8bc80badec183998c2239c487237e0d7f6"
RPCS=("https://rpc.mainnet.fastnear.com" "https://near.drpc.org")
DEST="packages/contracts/tests/wasm/sputnik-dao-3.2.wasm"

if [ -f "$DEST" ] && [ "$(sha256sum "$DEST" | cut -d' ' -f1)" = "$SHA256" ]; then
  echo "already present and checked: $DEST (sha256 $SHA256)"
  exit 0
fi
mkdir -p "$(dirname "$DEST")"
tmp="$(mktemp)"
trap 'rm -f "$tmp" "$tmp.json"' EXIT
request="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_global_contract_code\",\"finality\":\"final\",\"code_hash\":\"$CODE_HASH\"}}"

for rpc in "${RPCS[@]}"; do
  echo "asking $rpc for global contract $CODE_HASH"
  if ! curl -sS --fail --max-time 60 -H 'Content-Type: application/json' -d "$request" -o "$tmp.json" "$rpc"; then
    echo "  no answer from $rpc"
    continue
  fi
  if ! python3 -I - "$tmp.json" "$tmp" <<'PY'
import base64, json, sys
reply = json.load(open(sys.argv[1]))
result = reply.get("result") or {}
if "code_base64" not in result:
    print("  unexpected reply:", json.dumps(reply)[:300])
    sys.exit(1)
with open(sys.argv[2], "wb") as out:
    out.write(base64.b64decode(result["code_base64"], validate=True))
print("  answered at block", result.get("block_height"))
PY
  then
    continue
  fi
  got="$(sha256sum "$tmp" | cut -d' ' -f1)"
  if [ "$got" != "$SHA256" ]; then
    echo "  refused: the bytes hash to $got, not $SHA256"
    continue
  fi
  mv "$tmp" "$DEST"
  echo "saved $DEST: $(stat -c %s "$DEST") bytes, sha256 $SHA256 (code hash $CODE_HASH)"
  exit 0
done
echo "no RPC returned bytes with sha256 $SHA256" >&2
exit 1
