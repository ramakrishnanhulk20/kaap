# shellcheck shell=bash
# The check behind "no access key is left" on a contract account. Sourced by
# scripts/deploy-contracts-testnet.sh. It counts only on a parsed answer: a failed read, a rate
# limit or a changed output format is never read as zero keys.

# Two independent testnet providers, the pair Kaap's CLI compares (packages/cli/src/rpc.ts).
ACCESS_KEY_RPCS=("https://rpc.testnet.fastnear.com" "https://near-testnet.drpc.org")

# Succeeds only when every provider in ACCESS_KEY_RPCS answers view_access_key_list at final
# finality for the account with a well-formed, empty key list. A failed read, an error, a malformed
# answer, answers that differ, or any key listed, of any type, is a failure, with the reasons on
# stderr. The raw answers are appended to the log file named by the second argument, if any.
no_access_keys_left() {
  local account="$1" log="${2:-/dev/null}" dir request rpc n=0 code status=0
  local -a reads=()
  dir="$(mktemp -d)" || { echo "could not make a temporary folder to read the keys of $account" >&2; return 1; }
  request="$(python3 -I -c 'import json, sys; print(json.dumps({"jsonrpc": "2.0", "id": "kaap", "method": "query", "params": {"request_type": "view_access_key_list", "finality": "final", "account_id": sys.argv[1]}}))' "$account")" || {
    rm -rf "$dir"
    echo "could not build the key-list request for $account" >&2
    return 1
  }
  for rpc in "${ACCESS_KEY_RPCS[@]}"; do
    n=$((n + 1))
    code=0
    curl -sS --max-time 30 --retry 2 --retry-delay 2 --max-filesize 1048576 \
      -H 'Content-Type: application/json' -d "$request" -o "$dir/$n.body" -w '%{http_code}' \
      "$rpc" >"$dir/$n.http" 2>>"$log" || code=$?
    reads+=("$rpc" "$code" "$dir/$n.http" "$dir/$n.body")
  done
  python3 -I - "$account" "$log" "${reads[@]}" <<'PY' || status=$?
import json, sys

account, log = sys.argv[1], sys.argv[2]
reads = [sys.argv[i:i + 4] for i in range(3, len(sys.argv), 4)]


class Unread(Exception):
    pass


# Provider text reaches the terminal only as a short run of printable characters.
def clean(text):
    return "".join(c if " " <= c <= "~" else "?" for c in str(text))[:160]


def listing(keys):
    if not keys:
        return "none"
    more = f" and {len(keys) - 4} more" if len(keys) > 4 else ""
    return ", ".join(clean(k) for k in keys[:4]) + more


def read(path):
    try:
        with open(path, "rb") as f:
            return f.read()
    except OSError:
        return b""


def keys_in(host, curl_exit, http, body):
    if curl_exit != "0":
        why = ", timed out" if curl_exit == "28" else ""
        raise Unread(f"no answer from {host} (curl exit {clean(curl_exit)}{why})")
    if http != "200":
        raise Unread(f"{host} answered HTTP {clean(http)}")
    try:
        reply = json.loads(body)
    except ValueError:
        raise Unread(f"{host} answered something that is not JSON")
    if not isinstance(reply, dict):
        raise Unread(f"{host} answered JSON that is not a JSON-RPC reply")
    if "error" in reply:
        error = reply["error"]
        cause = error.get("cause") if isinstance(error, dict) else None
        if isinstance(cause, dict) and "name" in cause:
            name = cause["name"]
        elif isinstance(error, dict):
            name = error.get("name") or error.get("message")
        else:
            name = error
        raise Unread(f"{host} answered an error: {clean(name)}")
    result = reply.get("result")
    if not isinstance(result, dict):
        raise Unread(f"{host} answered no result")
    if "error" in result:
        raise Unread(f"{host} answered an error: {clean(result['error'])}")
    keys, height = result.get("keys"), result.get("block_height")
    if not isinstance(keys, list) or type(height) is not int or not isinstance(result.get("block_hash"), str):
        raise Unread(f"{host} answered without a key list, block height and block hash")
    listed = []
    for entry in keys:
        if not isinstance(entry, dict) or not isinstance(entry.get("public_key"), str) or not isinstance(entry.get("access_key"), dict):
            raise Unread(f"{host} listed an entry that is not an access key")
        listed.append(entry["public_key"])
    return sorted(listed), height


answers, problems = [], []
with open(log, "a", encoding="utf-8") as out:
    for rpc, curl_exit, http_file, body_file in reads:
        host = rpc.split("://", 1)[-1].split("/", 1)[0]
        http = read(http_file).decode("ascii", "replace").strip()
        body = read(body_file)
        out.write(f"view_access_key_list {account} from {host}: curl exit {curl_exit}, HTTP {http}: {body[:4000].decode('utf-8', 'replace')}\n")
        try:
            answers.append((host, *keys_in(host, curl_exit, http, body)))
        except Unread as e:
            problems.append(str(e))
    if len(reads) < 2:
        problems.append("fewer than two providers were asked")
    if problems:
        print(f"could not confirm that {account} has no access key: " + "; ".join(problems), file=sys.stderr)
        sys.exit(1)
    if len({tuple(keys) for _, keys, _ in answers}) > 1:
        lists = "; ".join(f"{host} lists {listing(keys)}" for host, keys, _ in answers)
        print(f"the providers disagree on the access keys of {account}: {lists}", file=sys.stderr)
        sys.exit(1)
    keys = answers[0][1]
    if keys:
        print(f"{account} still has {len(keys)} access key(s), every provider agrees: {listing(keys)}", file=sys.stderr)
        sys.exit(1)
    out.write(f"no access key on {account}: " + ", ".join(f"{host} at block {height}" for host, _, height in answers) + "\n")
PY
  rm -rf "$dir"
  return "$status"
}
