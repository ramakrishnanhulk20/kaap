// Checks the canonical kind and policy forms: two reads of one live DAO proposal, made on 24 and
// 26 Oct 2026 with no edit in between, hash alike; real edits and reorderings of ordered arrays
// hash differently; and the strict parser refuses what it must. It does not check the hash
// against a live RPC read, and it does not check that the guard forwards the raw kind bytes
// (packages/contracts/tests/guard.rs tests that against the real Sputnik binary).

use kaap_core::canonical::{
    canonical_kind, canonical_policy, kind_hash, policy_hash, CanonError, MAX_CANON_BYTES,
};
use serde_json::{json, Value};

const READ_OCT24: &[u8] = include_bytes!("fixtures/canonical/live-read-2026-10-24.json");
const READ_OCT26: &[u8] = include_bytes!("fixtures/canonical/live-read-2026-10-26.json");

fn hash_of(v: &Value) -> [u8; 32] {
    kind_hash(serde_json::to_string(v).unwrap().as_bytes()).unwrap()
}

#[test]
fn two_saved_reads_of_one_proposal_give_one_hash() {
    assert_ne!(READ_OCT24, READ_OCT26, "the fixtures must differ as bytes for this to prove anything");
    assert_eq!(kind_hash(READ_OCT24).unwrap(), kind_hash(READ_OCT26).unwrap());
    assert_eq!(canonical_kind(READ_OCT24).unwrap(), canonical_kind(READ_OCT26).unwrap());
}

#[test]
fn a_content_change_gives_another_hash() {
    let original = kind_hash(READ_OCT26).unwrap();
    let text = std::str::from_utf8(READ_OCT26).unwrap();
    let new_member = text.replacen("0s83e95d8c6c197ed0ffa929288e5b40f6e873330d", "eve.near", 1);
    assert_ne!(kind_hash(new_member.as_bytes()).unwrap(), original);
    let new_period = text.replacen("\"proposal_period\":\"604800000000000\"", "\"proposal_period\":\"1\"", 1);
    assert_ne!(new_period, text);
    assert_ne!(kind_hash(new_period.as_bytes()).unwrap(), original);
    let lost_permission = text.replacen("\"call:VoteApprove\",", "", 1);
    assert_ne!(lost_permission, text);
    assert_ne!(kind_hash(lost_permission.as_bytes()).unwrap(), original);
}

#[test]
fn reordering_roles_gives_another_hash() {
    let mut kind: Value = serde_json::from_slice(READ_OCT26).unwrap();
    let original = hash_of(&kind);
    kind["ChangePolicy"]["policy"]["roles"].as_array_mut().unwrap().swap(0, 2);
    assert_ne!(hash_of(&kind), original);
}

#[test]
fn reordering_function_call_actions_gives_another_hash() {
    let a = json!({"method_name": "ft_transfer", "args": "e30=", "deposit": "1", "gas": "50000000000000"});
    let b = json!({"method_name": "storage_deposit", "args": "e30=", "deposit": "1250000000000000000000", "gas": "50000000000000"});
    let forward = json!({"FunctionCall": {"receiver_id": "usdc.near", "actions": [a.clone(), b.clone()]}});
    let backward = json!({"FunctionCall": {"receiver_id": "usdc.near", "actions": [b, a]}});
    assert_ne!(hash_of(&forward), hash_of(&backward));
}

#[test]
fn key_order_and_whitespace_do_not_matter() {
    let one = br#"{"FunctionCall":{"receiver_id":"usdc.near","actions":[{"method_name":"ft_transfer","args":"e30=","deposit":"1","gas":"1"}]}}"#;
    let two = br#"{ "FunctionCall" : { "actions" : [ { "gas":"1", "deposit":"1", "args":"e30=", "method_name":"ft_transfer" } ], "receiver_id":"usdc.near" } }"#;
    assert_eq!(kind_hash(one).unwrap(), kind_hash(two).unwrap());
    let sorted = br#"{"FunctionCall":{"actions":[{"args":"e30=","deposit":"1","gas":"1","method_name":"ft_transfer"}],"receiver_id":"usdc.near"}}"#;
    assert_eq!(canonical_kind(two).unwrap(), sorted.to_vec());
}

#[test]
fn group_members_and_permissions_are_sets_in_both_role_kinds() {
    let role = |members: [&str; 2], perms: [&str; 2]| {
        json!({"name": "Council", "kind": {"Group": members}, "permissions": perms,
               "vote_policy": {"transfer": {"weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 2]}}})
    };
    let r1 = role(["a.near", "b.near"], ["*:VoteApprove", "*:AddProposal"]);
    let r2 = role(["b.near", "a.near"], ["*:AddProposal", "*:VoteApprove"]);
    let upsert = |r: &Value| json!({"ChangePolicyAddOrUpdateRole": {"role": r}});
    assert_eq!(hash_of(&upsert(&r1)), hash_of(&upsert(&r2)));
    let policy = |r: &Value| json!({"ChangePolicy": {"policy": {"roles": [r], "default_vote_policy": {"weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 2]}}}});
    assert_eq!(hash_of(&policy(&r1)), hash_of(&policy(&r2)));
}

#[test]
fn arrays_outside_the_two_sets_keep_their_order() {
    let threshold = |t: [u64; 2]| json!({"ChangePolicyUpdateDefaultVotePolicy": {"vote_policy": {"weight_kind": "RoleWeight", "quorum": "0", "threshold": t}}});
    assert_ne!(hash_of(&threshold([1, 2])), hash_of(&threshold([2, 1])));
    let stray = |p: [&str; 2]| json!({"SomeFutureKind": {"permissions": p}});
    assert_ne!(hash_of(&stray(["a", "b"])), hash_of(&stray(["b", "a"])));
    let council = |c: [&str; 2]| json!({"ChangePolicy": {"policy": c}});
    assert_ne!(hash_of(&council(["a.near", "b.near"])), hash_of(&council(["b.near", "a.near"])));
}

#[test]
fn canonical_policy_sorts_the_same_sets_and_keeps_roles_in_order() {
    let p1 = br#"{"roles":[{"name":"A","kind":{"Group":["x.near","y.near"]},"permissions":["p:1","p:2"],"vote_policy":{"b":{"threshold":"1"},"a":{"threshold":"2"}}},{"name":"B","kind":"Everyone","permissions":[],"vote_policy":{}}],"proposal_bond":"0"}"#;
    let p2 = br#"{"proposal_bond":"0","roles":[{"vote_policy":{"a":{"threshold":"2"},"b":{"threshold":"1"}},"permissions":["p:2","p:1"],"kind":{"Group":["y.near","x.near"]},"name":"A"},{"name":"B","kind":"Everyone","permissions":[],"vote_policy":{}}]}"#;
    assert_eq!(policy_hash(p1).unwrap(), policy_hash(p2).unwrap());
    let swapped = br#"{"roles":[{"name":"B","kind":"Everyone","permissions":[],"vote_policy":{}},{"name":"A","kind":{"Group":["x.near","y.near"]},"permissions":["p:1","p:2"],"vote_policy":{"b":{"threshold":"1"},"a":{"threshold":"2"}}}],"proposal_bond":"0"}"#;
    assert_ne!(policy_hash(p1).unwrap(), policy_hash(swapped).unwrap());
}

#[test]
fn the_canonical_form_is_stable_under_itself() {
    let once = canonical_kind(READ_OCT24).unwrap();
    assert_eq!(canonical_kind(&once).unwrap(), once);
    let policy = canonical_policy(br#"{"roles":[{"kind":{"Group":["b","a"]},"permissions":["z","y"]}]}"#).unwrap();
    assert_eq!(policy, br#"{"roles":[{"kind":{"Group":["a","b"]},"permissions":["y","z"]}]}"#.to_vec());
}

#[test]
fn input_over_256_kib_is_refused() {
    let padded = |total: usize| {
        let mut v = b"{\"Vote\":\"".to_vec();
        v.resize(total - 2, b'a');
        v.extend_from_slice(b"\"}");
        v
    };
    assert!(canonical_kind(&padded(MAX_CANON_BYTES)).is_ok());
    assert_eq!(
        canonical_kind(&padded(MAX_CANON_BYTES + 1)),
        Err(CanonError::TooLarge { len: MAX_CANON_BYTES + 1, max: MAX_CANON_BYTES })
    );
    assert!(matches!(canonical_policy(&padded(MAX_CANON_BYTES + 1)), Err(CanonError::TooLarge { .. })));
}

#[test]
fn ambiguous_or_malformed_json_is_refused() {
    let bad: [&[u8]; 9] = [
        br#"{"Transfer":{"amount":"1","amount":"2"}}"#,
        br#"{"Vote":1.5}"#,
        br#"{"Vote":1e2}"#,
        br#"{"Vote":18446744073709551616}"#,
        br#"{"Vote":-0}"#,
        br#"{"Vote":"x"} {"Vote":"y"}"#,
        b"",
        b"not json",
        b"{\"Vote\":\"\xff\"}",
    ];
    for input in bad {
        assert!(matches!(canonical_kind(input), Err(CanonError::Invalid(_))), "{:?}", String::from_utf8_lossy(input));
    }
    assert!(canonical_kind(br#""Vote""#).is_ok());
    assert!(canonical_kind(br#"{"Vote":18446744073709551615}"#).is_ok());
    assert!(canonical_kind(br#"{"Vote":-9223372036854775808}"#).is_ok());
}
