# shellcheck shell=bash
# Reads of the sealed job's OutLayer testnet project that count only on a parsed answer, and the one
# write of packages/sealed/testnet.json that follows a registration. Sourced by
# scripts/publish-sealed-testnet.sh. Needs near-cli-rs 0.30.1 and jq.

# get_project returns null for an unknown id, else a view whose uuid is what every key of the job is
# bound to. The uuid rule is the one the CLI enforces on packages/sealed/testnet.json; \A and \z,
# because jq's $ also matches before a trailing newline.
# shellcheck disable=SC2016  # $p is jq's variable, not the shell's
SEALED_PROJECT_VIEW='
  if length != 1 then error("not one JSON value")
  else .[0]
    | if . == null then null
      elif type == "object"
        and .project_id == $p
        and (.uuid | type) == "string" and (.uuid | test("\\A[0-9a-z]{1,64}\\z"))
        and (.active_version | type) == "string" and (.active_version | test("\\A[0-9a-f]{64}\\z"))
      then {project_id, uuid, active_version}
      else error("not a project view") end
  end'

# Prints `null` when the contract has no project with the id, else the project's id, uuid and
# active version as one line of JSON. Returns 1, with the reason on stderr, on a failed read or on
# any other answer.
read_project() {
  local contract="$1" project_id="$2" args raw err code=0
  args="$(jq -nc --arg p "$project_id" '{project_id:$p}')" || return 1
  err="$(mktemp)" || return 1
  raw="$(near contract call-function as-read-only "$contract" get_project json-args "$args" \
    network-config testnet now 2>"$err")" || code=$?
  if [[ $code -ne 0 ]]; then
    echo "could not read get_project for $project_id from $contract (near-cli exit $code):" >&2
    sed 's/\x1b\[[0-9;]*m//g' "$err" | tail -n 5 >&2
    rm -f "$err"
    return 1
  fi
  rm -f "$err"
  if ! jq -sc --arg p "$project_id" "$SEALED_PROJECT_VIEW" <<<"$raw" 2>/dev/null; then
    echo "get_project for $project_id from $contract answered neither null nor that project with a uuid of 1 to 64 lowercase letters or digits and a sha256 active version: $(printf '%s' "$raw" | tr -c '[:print:]' '?' | cut -c1-160)" >&2
    return 1
  fi
}

# Prints create_project when the contract has no such project, add_version when it has. A failed
# read is never "not created": it returns 1, with the reason on stderr.
registration_method() {
  local project
  project="$(read_project "$1" "$2")" || return 1
  if [[ "$project" == "null" ]]; then echo create_project; else echo add_version; fi
}

# After create_project or add_version: reads the project back, and only when it names the build
# just registered as active adds that build to the state file with the project's uuid. Prints the
# project line. Returns 1 with the state file untouched when the read fails, the project is missing,
# another build is active, or any value to be written is malformed.
# Usage: record_registration <state file> <contract> <project id> <sha256> <url> <tx> <method> <bytes>
record_registration() {
  local state="$1" contract="$2" project_id="$3" sha="$4" url="$5" tx="$6" method="$7" bytes="$8" project active tmp
  if ! [[ "$sha" =~ ^[0-9a-f]{64}$ && "$url" == https://* && "$tx" =~ ^[1-9A-HJ-NP-Za-km-z]{43,44}$ &&
    "$bytes" =~ ^[1-9][0-9]*$ && ("$method" == create_project || "$method" == add_version) ]]; then
    echo "not recording: a value to write is malformed (sha256 '$sha', tx '$tx', method '$method', bytes '$bytes')" >&2
    return 1
  fi
  project="$(read_project "$contract" "$project_id")" || return 1
  if [[ "$project" == "null" ]]; then
    echo "$contract has no project $project_id" >&2
    return 1
  fi
  active="$(jq -r .active_version <<<"$project")" || return 1
  if [[ "$active" != "$sha" ]]; then
    echo "the active build of $project_id is $active, not $sha" >&2
    return 1
  fi
  echo "project: $project"
  tmp="$(mktemp)" || return 1
  if ! jq --argjson project "$project" --arg sha "$sha" --arg url "$url" --arg tx "$tx" --arg m "$method" \
    --arg size "$bytes" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    'if .project_id != $project.project_id then error("the state file names another project")
     else .uuid = $project.uuid | .active_version = $sha
       | .versions += [{sha256:$sha, bytes:($size|tonumber), url:$url, registered_by:$m, tx:$tx, at:$at, retired:false}]
     end' "$state" >"$tmp"; then
    rm -f "$tmp"
    echo "could not update $state" >&2
    return 1
  fi
  mv "$tmp" "$state"
}
