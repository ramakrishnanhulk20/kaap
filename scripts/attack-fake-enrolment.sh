#!/usr/bin/env bash
# Attacks the watcher's rule for what it takes up (C36 in docs/security/threat-model.md).
#
# Anyone can enrol an account in Kaap's guard. This enrols one that is no Sputnik DAO and waits to
# see what the hosted watcher makes of it. The right outcome: the watcher lists the account on
# /status under not_watched with the word not_a_sputnik_dao, watches exactly the treasuries it
# watched before, and signs nothing because of it. The account then unenrols, and the listing goes.
#
#   bash scripts/attack-fake-enrolment.sh <account> [watcher's https address]
#
# <account> is any testnet account that is not a Sputnik DAO and whose key is in near-cli-rs's
# legacy keychain (~/.near-credentials/testnet). It signs two transactions on testnet: enroll with
# 0.01 NEAR attached, most of which the guard refunds, and unenroll. Needs near-cli-rs, curl, Node.
# Without the watcher's address it uses the one in deployments/testnet.json.
#
# "Signs nothing" is read from the watcher account's own transaction counter before and after. If
# someone presses the site's try-it button in the same two minutes the counter moves for that
# reason, and the script says it cannot tell.
set -u
cd "$(dirname "$0")/.." || exit 2
ACCOUNT="${1:-}"
[ -n "$ACCOUNT" ] || { echo "usage: bash scripts/attack-fake-enrolment.sh <account> [watcher's https address]"; exit 2; }
field() { node -e "const d=require('./deployments/testnet.json');const v=process.argv[1].split('.').reduce((o,k)=>o&&o[k],d);if(typeof v!=='string')process.exit(1);console.log(v)" "$1"; }
GUARD="$(field guard.account_id)" || { echo "deployments/testnet.json names no guard"; exit 2; }
WATCHER_ACCOUNT="$(field watcher.account)" || { echo "deployments/testnet.json names no watcher"; exit 2; }
WATCHER="${2:-$(field watcher.url)}"
RPC="https://rpc.testnet.fastnear.com"

status() { curl -s -m 15 "$WATCHER/status"; }
part() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const a=process.argv[1];if(a==='listed')console.log(JSON.stringify((j.not_watched||[]).filter(x=>x.dao===process.argv[2])));else console.log(JSON.stringify({watching:j.watching,daos:(j.daos||[]).map(d=>d.dao)}))})" "$@"; }
nonce() { curl -s -m 15 -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":\"kaap\",\"method\":\"query\",\"params\":{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$WATCHER_ACCOUNT\"}}" "$RPC" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const k=JSON.parse(s).result.keys;console.log(k.map(x=>x.access_key.nonce).join(','))})"; }
call() { near contract call-function as-transaction "$GUARD" "$1" json-args '{}' prepaid-gas '30 Tgas' attached-deposit "$2" sign-as "$ACCOUNT" network-config testnet sign-with-legacy-keychain send 2>&1 | grep -E "Transaction ID|ERR_|Error|error" | sed -E 's/^[^A-Za-z]*//' | head -3; }

echo "Kaap fake-enrolment attack, $(date -u +%Y-%m-%dT%H:%M:%SZ): $ACCOUNT into $GUARD, watcher $WATCHER"
before="$(status | part watching)"
nonce_before="$(nonce)"
echo "before: the watcher watches $before"

echo "enrolling $ACCOUNT, which is no Sputnik DAO:"
call enroll '0.01 NEAR'
listed="[]"
for _ in $(seq 1 20); do
  sleep 8
  listed="$(status | part listed "$ACCOUNT")"
  [ "$listed" != "[]" ] && break
done
during="$(status | part watching)"
echo "the watcher's status page lists it as: $listed"
echo "during: the watcher watches $during"

echo "unenrolling $ACCOUNT:"
call unenroll '0 NEAR'
gone="no"
for _ in $(seq 1 20); do
  sleep 8
  [ "$(status | part listed "$ACCOUNT")" = "[]" ] && { gone="yes"; break; }
done
nonce_after="$(nonce)"
echo "after: listed no more: $gone; the watcher watches $(status | part watching)"

turned_away="no"
[ "$listed" = "[{\"dao\":\"$ACCOUNT\",\"reason\":\"not_a_sputnik_dao\"}]" ] && [ "$before" = "$during" ] && turned_away="yes"
if [ "$nonce_before" = "$nonce_after" ]; then spent="the watcher account signed nothing in that time"; else spent="the watcher account signed something in that time, which this script cannot tell apart from a try-it press"; fi
if [ "$turned_away" = "yes" ] && [ "$gone" = "yes" ] && [ "$nonce_before" = "$nonce_after" ]; then
  echo "RESULT: pass, the account was turned away as not_a_sputnik_dao, the watched treasuries did not change, and $spent"
elif [ "$turned_away" = "yes" ] && [ "$gone" = "yes" ]; then
  echo "RESULT: unclear, the account was turned away, but $spent"
  exit 1
else
  echo "RESULT: FAIL"
  exit 1
fi
