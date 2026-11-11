// Tests for `policy::arming::guard_arming` (C16) on the testnet demo DAO's policy and edits of it,
// and on the planted harness policy. Expected values come from Sputnik's formulas worked by hand
// (policy.rs 98-106 and 380-433, proposals.rs 256-283 and 665-683); packages/core-diff runs the
// guard cases against the real 3.2 binary. It does NOT cover a guard holding
// delegated tokens, a DAO on a Sputnik version other than 3.2, or reading the live policy from
// chain.

mod common;

use std::collections::BTreeMap;

use common::{read_jsonl, record, repo_root, PLANTED};
use kaap_core::policy::arming::guard_arming;
use kaap_core::policy::sputnik::LABELS;
use serde_json::{json, Value};

const OWN_REMOVAL: &str = "remove_member_from_role";

/// The testnet demo DAO's policy, rebuilt the way scripts/setup-demo-dao.mjs `demoPolicy`
/// builds it: the saved NEAR Business template with the owner and the demo member in its two
/// places, plus a `guard` role holding the guard alone, VoteReject on the 16 labels other than
/// remove_member_from_role, threshold "1" on each. Returns the policy and the guard account.
fn m1() -> (Value, String) {
    let read = |file: &str| -> Value {
        serde_json::from_str(&std::fs::read_to_string(repo_root().join(file)).unwrap()).unwrap()
    };
    let (template, state) = (read("deployments/near-business-policy.json"), read("deployments/testnet.json"));
    let owner = state["owner"]["account_id"].clone();
    let member = state["dao"]["member"]["account_id"].clone();
    let guard = state["guard"]["account_id"].as_str().unwrap().to_string();
    let mut policy = template["policy"].clone();
    for role in policy["roles"].as_array_mut().unwrap() {
        let places = role["kind"]["Group"].as_array_mut().unwrap();
        for place in places.iter_mut() {
            *place = if *place == "<member 1>" { owner.clone() } else { member.clone() };
        }
    }
    let labels: Vec<&str> = LABELS.iter().copied().filter(|l| *l != OWN_REMOVAL).collect();
    let rule = json!({ "weight_kind": "RoleWeight", "quorum": "0", "threshold": "1" });
    policy["roles"].as_array_mut().unwrap().push(json!({
        "name": "guard",
        "kind": { "Group": [guard] },
        "permissions": labels.iter().map(|l| format!("{l}:VoteReject")).collect::<Vec<_>>(),
        "vote_policy": labels.iter().map(|l| (l.to_string(), rule.clone())).collect::<serde_json::Map<_, _>>(),
    }));
    (policy, guard)
}

fn role_mut<'a>(policy: &'a mut Value, name: &str) -> &'a mut Value {
    policy["roles"].as_array_mut().unwrap().iter_mut().find(|r| r["name"] == name).unwrap()
}

fn all_but(skip: &[&str]) -> Vec<String> {
    LABELS.iter().filter(|l| !skip.contains(l)).map(|l| l.to_string()).collect()
}

#[test]
fn the_m1_policy_is_armed_on_every_label_but_its_own_removal() {
    let (policy, guard) = m1();
    let a = guard_arming(&policy, &guard);
    assert_eq!(a.rejects_alone, all_but(&[OWN_REMOVAL]));
    assert_eq!(a.cannot_reject, vec![OWN_REMOVAL.to_string()]);
    assert!(a.extra_rights.is_empty(), "{:?}", a.extra_rights);
    // Approver: transfer and call need 2 of 2 (PROOF.md); nothing passes on one approval.
    assert_eq!(a.approval_votes_needed["transfer"], 2);
    assert_eq!(a.approval_votes_needed["call"], 2);
    assert!(a.approval_votes_needed.values().all(|v| *v >= 2), "{:?}", a.approval_votes_needed);
    assert_eq!(a.approval_votes_needed["vote"], u128::MAX, "no demo DAO role may approve a Vote kind");
    assert!(a.race_note.starts_with("Every kind that can pass needs at least 2 approvals"), "{}", a.race_note);
}

#[test]
fn every_label_is_judged_exactly_once() {
    // Standard 1: the labels come from to_policy_label, so a label missing here fails this test.
    let (m1_policy, guard) = m1();
    let harness = record(PLANTED, "planted:01")["context"]["policy_before"].clone();
    for (policy, account) in [(m1_policy, guard.as_str()), (harness, "guard.sandbox"), (json!({}), "x.near")] {
        let a = guard_arming(&policy, account);
        let mut judged: Vec<String> = a.rejects_alone.iter().chain(&a.cannot_reject).cloned().collect();
        judged.sort();
        assert_eq!(judged, { let mut all = all_but(&[]); all.sort(); all });
        assert_eq!(a.approval_votes_needed.len(), LABELS.len());
    }
}

#[test]
fn a_second_guard_member_disarms_only_a_ratio_guard() {
    // The demo DAO's guard rule is the absolute "1": with two members to_weight is min(1, 2) = 1
    // (policy.rs 98-106), so one reject still decides and the guard stays armed. The sandbox agrees
    // (core-diff guard_arming_agrees_with_the_binary).
    let (mut policy, guard) = m1();
    role_mut(&mut policy, "guard")["kind"]["Group"].as_array_mut().unwrap().push(json!("second-guard.testnet"));
    assert_eq!(guard_arming(&policy, &guard).rejects_alone, all_but(&[OWN_REMOVAL]));

    // The planted harness's guard has no rules of its own, so it uses the default 1/2: two
    // members need two rejects (1 * 2 / 2 + 1 = 2) and one guard vote decides nothing.
    let mut harness = record(PLANTED, "planted:01")["context"]["policy_before"].clone();
    assert_eq!(guard_arming(&harness, "guard.sandbox").rejects_alone, all_but(&[OWN_REMOVAL]));
    role_mut(&mut harness, "guard")["kind"]["Group"].as_array_mut().unwrap().push(json!("second-guard.sandbox"));
    let a = guard_arming(&harness, "guard.sandbox");
    assert!(a.rejects_alone.is_empty(), "{:?}", a.rejects_alone);
    assert_eq!(a.cannot_reject, all_but(&[]));
}

#[test]
fn others_who_reject_alone_lists_a_second_guard_member() {
    // On the demo DAO the owner and the demo member reject only through Approver and Admin, which
    // need 2 of 2, so nobody but the guard decides with one reject.
    let (mut policy, guard) = m1();
    assert!(guard_arming(&policy, &guard).others_who_reject_alone.is_empty());

    // A second member of the demo DAO's guard role meets the same fixed "1", on every label the
    // guard does.
    role_mut(&mut policy, "guard")["kind"]["Group"].as_array_mut().unwrap().push(json!("second-guard.testnet"));
    let a = guard_arming(&policy, &guard);
    let expected: BTreeMap<String, Vec<String>> =
        all_but(&[OWN_REMOVAL]).into_iter().map(|l| (l, vec!["second-guard.testnet".to_string()])).collect();
    assert_eq!(a.others_who_reject_alone, expected);

    // On the harness's 1/2 guard role a second member disarms both, so neither is listed.
    let mut harness = record(PLANTED, "planted:01")["context"]["policy_before"].clone();
    role_mut(&mut harness, "guard")["kind"]["Group"].as_array_mut().unwrap().push(json!("second-guard.sandbox"));
    assert!(guard_arming(&harness, "guard.sandbox").others_who_reject_alone.is_empty());
}

#[test]
fn others_who_reject_alone_reads_every_group_role_and_only_armed_labels() {
    // A watch role with its own "1" on transfer and on remove_member_from_role. The guard cannot
    // reject remove_member_from_role, so only transfer is listed, with the two accounts sorted.
    let (mut policy, guard) = m1();
    let one = json!({ "weight_kind": "RoleWeight", "quorum": "0", "threshold": "1" });
    policy["roles"].as_array_mut().unwrap().push(json!({
        "name": "watch",
        "kind": { "Group": ["zed.testnet", "amy.testnet"] },
        "permissions": ["transfer:VoteReject", "remove_member_from_role:VoteReject"],
        "vote_policy": { "transfer": one, "remove_member_from_role": one },
    }));
    let a = guard_arming(&policy, &guard);
    assert!(!a.rejects_alone.contains(&OWN_REMOVAL.to_string()));
    let expected: BTreeMap<String, Vec<String>> =
        [("transfer".to_string(), vec!["amy.testnet".to_string(), "zed.testnet".to_string()])].into();
    assert_eq!(a.others_who_reject_alone, expected);
}

#[test]
fn an_everyone_role_gives_the_guard_its_rights() {
    let (mut policy, guard) = m1();
    policy["roles"].as_array_mut().unwrap().push(json!({
        "name": "all", "kind": "Everyone", "permissions": ["*:AddProposal"], "vote_policy": {}
    }));
    let a = guard_arming(&policy, &guard);
    assert_eq!(a.extra_rights, LABELS.iter().map(|l| format!("{l}:AddProposal")).collect::<Vec<_>>());
    assert_eq!(a.rejects_alone, all_but(&[OWN_REMOVAL]), "filing rights do not change the reject");
}

#[test]
fn rights_from_any_matching_role_are_extra_rights() {
    // A guard that also sits in the Approver role holds its approve, finalise and remove rights.
    let (mut policy, guard) = m1();
    role_mut(&mut policy, "Approver")["kind"]["Group"].as_array_mut().unwrap().push(json!(guard));
    let a = guard_arming(&policy, &guard);
    let expected = ["call:RemoveProposal", "call:VoteApprove", "call:Finalize", "transfer:RemoveProposal", "transfer:VoteApprove", "transfer:Finalize"];
    assert_eq!(a.extra_rights, expected);
    // Approver now needs 2 of 3 on transfer, so the guard's reject counts there without deciding,
    // and the guard role still decides alone.
    assert_eq!(a.rejects_alone, all_but(&[OWN_REMOVAL]));

    // A Member role is taken to match the guard, whose delegated balance no policy shows.
    let (mut policy, guard) = m1();
    policy["roles"].as_array_mut().unwrap().push(json!({
        "name": "holders", "kind": { "Member": "1000000000000000000000000" }, "permissions": ["transfer:VoteApprove"], "vote_policy": {}
    }));
    assert_eq!(guard_arming(&policy, &guard).extra_rights, ["transfer:VoteApprove"]);
}

#[test]
fn a_guard_vote_that_cannot_decide_is_not_a_reject() {
    let (mut policy, guard) = m1();
    role_mut(&mut policy, "guard")["vote_policy"]["transfer"] = json!({ "weight_kind": "TokenWeight", "quorum": "0", "threshold": [1, 2] });
    assert_eq!(guard_arming(&policy, &guard).cannot_reject, [OWN_REMOVAL, "transfer"]);

    let (mut policy, guard) = m1();
    role_mut(&mut policy, "guard")["vote_policy"]["call"] = json!({ "weight_kind": "RoleWeight", "quorum": "0", "threshold": "0" });
    assert!(guard_arming(&policy, &guard).cannot_reject.contains(&"call".to_string()));
}

#[test]
fn an_unreadable_policy_is_disarmed() {
    let a = guard_arming(&json!({ "roles": [] }), "guard.near");
    assert!(a.rejects_alone.is_empty());
    assert_eq!(a.cannot_reject, all_but(&[]));
    assert_eq!(a.extra_rights, ["*:*"]);
    assert!(a.others_who_reject_alone.is_empty());
    assert!(a.approval_votes_needed.values().all(|v| *v == 0));
}

#[test]
fn the_planted_policies_with_a_guard_are_judged_like_the_harness() {
    // Every planted record's policy before is the harness policy, armed on 16 labels.
    let records = read_jsonl(&repo_root().join(PLANTED)).unwrap();
    let policies: Vec<&Value> = records.iter().map(|r| &r["context"]["policy_before"]).filter(|p| !p.is_null()).collect();
    assert!(!policies.is_empty());
    for policy in policies {
        assert_eq!(guard_arming(policy, "guard.sandbox").rejects_alone, all_but(&[OWN_REMOVAL]));
    }
}
