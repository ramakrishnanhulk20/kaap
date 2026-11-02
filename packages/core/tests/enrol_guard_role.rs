// Kaap's own enrolment role draft read with the guard account known: the exact role the template
// adds (`enrolment::role`, which core-wasm's drafts are built from) gives no GUARD_WEAKENED, and
// every departure from it still does, on the M1 testnet DAO's policy as it was before enrolment.
// It does NOT cover the draft with no policy before (GUARD_WEAKENED still fires there, since the
// guard's roles cannot be known), the guard account being Kaap's (the caller vouches for that),
// the template's `enroll` call (enrol_guard_call.rs), or a DAO on a Sputnik version other than 3.2.

mod common;

use common::repo_root;
use kaap_core::enrolment::{self, OWN_REMOVAL};
use kaap_core::policy::GUARD_ROLE;
use kaap_core::{analyze, FindingCode, Network, Prices, ProposalInput};
use serde_json::{json, Value};

/// The M1 testnet DAO's policy before enrolment, rebuilt as scripts/WO-02c-setup-testnet.mjs
/// builds it (the NEAR Business template with the owner and the demo member in its places), the
/// DAO and the guard account.
fn dao_before() -> (Value, String, String) {
    let read = |file: &str| -> Value {
        serde_json::from_str(&std::fs::read_to_string(repo_root().join(file)).unwrap()).unwrap()
    };
    let (template, state) = (read("deployments/near-business-policy.json"), read("deployments/testnet.json"));
    let owner = state["owner"]["account_id"].clone();
    let member = state["dao"]["member"]["account_id"].clone();
    let mut policy = template["policy"].clone();
    for role in policy["roles"].as_array_mut().unwrap() {
        for place in role["kind"]["Group"].as_array_mut().unwrap().iter_mut() {
            *place = if *place == "<member 1>" { owner.clone() } else { member.clone() };
        }
    }
    let dao = state["dao"]["account_id"].as_str().unwrap().to_string();
    (policy, dao, state["guard"]["account_id"].as_str().unwrap().to_string())
}

fn template_role(guard: &str) -> Value {
    enrolment::role(guard)
}

/// The findings `analyze` gives `kind` on the DAO with `policy` before it, the guard account known.
fn codes(kind: Value, policy: Value, dao: &str, guard: &str) -> Vec<FindingCode> {
    let input = ProposalInput {
        network: Network::Testnet,
        dao: dao.to_string(),
        proposal_id: 0,
        description: format!(
            "Add Kaap's guard role \"{GUARD_ROLE}\" with one member, the guard contract {guard}. It may only vote to reject, \
             on every kind of proposal except removing a member from a role, so this DAO can always remove Kaap. One reject \
             from it decides. It cannot approve, remove or finalise anything."
        ),
        kind_json: serde_json::to_vec(&kind).unwrap(),
        policy_before: Some(policy),
        history: None,
        prices: Prices::default(),
        dao_version: None,
        supplied_text: None,
        guard_account: Some(guard.to_string()),
        config_before: None,
        block_timestamp_ns: None,
    };
    analyze(&input).findings.iter().map(|f| f.code).collect()
}

fn add_role(role: Value) -> Value {
    json!({ "ChangePolicyAddOrUpdateRole": { "role": role } })
}

/// The findings for adding `role` to the M1 DAO before enrolment.
fn codes_for_role(role: Value) -> Vec<FindingCode> {
    let (policy, dao, guard) = dao_before();
    codes(add_role(role), policy, &dao, &guard)
}

#[test]
fn the_template_role_draft_gives_no_guard_weakened() {
    let (_, _, guard) = dao_before();
    let found = codes_for_role(template_role(&guard));
    assert!(!found.contains(&FindingCode::GuardWeakened), "{found:?}");
    assert!(found.is_empty(), "the enrolment role reads as nothing to warn about: {found:?}");
}

#[test]
fn a_second_member_still_fires() {
    let (_, _, guard) = dao_before();
    let mut role = template_role(&guard);
    role["kind"]["Group"] = json!([guard, "intruder.testnet"]);
    assert!(codes_for_role(role).contains(&FindingCode::GuardWeakened));
}

#[test]
fn an_extra_right_still_fires() {
    let (_, _, guard) = dao_before();
    for extra in [format!("{OWN_REMOVAL}:VoteReject"), "transfer:VoteApprove".to_string(), "*:VoteReject".to_string()] {
        let mut role = template_role(&guard);
        role["permissions"].as_array_mut().unwrap().push(json!(extra));
        assert!(codes_for_role(role).contains(&FindingCode::GuardWeakened), "{extra}");
    }
}

#[test]
fn a_changed_threshold_still_fires() {
    let (_, _, guard) = dao_before();
    // With one member, "2" and [1, 2] both still need one vote by Sputnik's formula, so the guard
    // stays armed; they fire because they are not the template, which is the rule (fail closed).
    for threshold in [json!("2"), json!([1, 2])] {
        let mut role = template_role(&guard);
        role["vote_policy"]["transfer"]["threshold"] = threshold.clone();
        assert!(codes_for_role(role).contains(&FindingCode::GuardWeakened), "{threshold}");
    }
}

#[test]
fn the_template_over_an_existing_guard_role_still_fires() {
    let (mut policy, dao, guard) = dao_before();
    policy["roles"].as_array_mut().unwrap().push(json!({
        "name": GUARD_ROLE,
        "kind": { "Group": ["kaap-guard-old.testnet"] },
        "permissions": ["transfer:VoteReject"],
        "vote_policy": {},
    }));
    assert!(codes(add_role(template_role(&guard)), policy, &dao, &guard).contains(&FindingCode::GuardWeakened));
}

#[test]
fn the_template_beside_another_change_to_a_guard_role_still_fires() {
    let (mut before, dao, guard) = dao_before();
    let requestor = before["roles"].as_array_mut().unwrap().iter_mut().find(|r| r["name"] == "Requestor").unwrap();
    requestor["kind"]["Group"].as_array_mut().unwrap().push(json!(guard));
    let mut after = dao_before().0;
    after["roles"].as_array_mut().unwrap().push(template_role(&guard));
    let found = codes(json!({ "ChangePolicy": { "policy": after.clone() } }), before.clone(), &dao, &guard);
    assert!(found.contains(&FindingCode::GuardWeakened), "the guard left Requestor: {found:?}");

    // The same full policy with Requestor left as it was is the template alone.
    let requestor = after["roles"].as_array_mut().unwrap().iter_mut().find(|r| r["name"] == "Requestor").unwrap();
    requestor["kind"]["Group"].as_array_mut().unwrap().push(json!(guard));
    let found = codes(json!({ "ChangePolicy": { "policy": after } }), before, &dao, &guard);
    assert!(!found.contains(&FindingCode::GuardWeakened), "{found:?}");
}
