// Table tests for the port of Sputnik's policy rules (`kaap_core::policy::sputnik`). Every expected
// value comes from the Sputnik 3.2 source (its own unit tests in policy.rs and lib.rs, or the
// formula read by hand, line cited) or from the first sandbox runs on the real binary (20 Oct
// 2026, a test crate not published here; the test names are cited below). It does NOT cover
// agreement with the binary on real DAO policies (packages/core-diff runs that in a sandbox),
// token-weighted voting against a live delegation, or the policy effects and findings built on
// top of these rules (tests/policy_eval.rs).

use std::collections::BTreeSet;

use kaap_core::policy::sputnik::*;
use serde_json::{json, Value};

/// Sputnik's `default_policy` (policy.rs 185-216): an Everyone role that may only file
/// proposals, and a council with every action but RemoveProposal, at RoleWeight 1/2.
fn default_policy(council: &[&str]) -> Value {
    json!({
        "roles": [
            { "name": "all", "kind": "Everyone", "permissions": ["*:AddProposal"], "vote_policy": {} },
            { "name": "council", "kind": { "Group": council },
              "permissions": ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"],
              "vote_policy": {} }
        ],
        "default_vote_policy": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 2] },
        "proposal_bond": "1000000000000000000000000",
        "proposal_period": "604800000000000",
        "bounty_bond": "1000000000000000000000000",
        "bounty_forgiveness_period": "86400000000000"
    })
}

fn parse(v: &Value) -> Policy {
    Policy::from_json(v).expect("a policy Sputnik accepts")
}

fn with_roles(roles: Value) -> Policy {
    let mut v = default_policy(&["a.near"]);
    v["roles"] = roles;
    parse(&v)
}

/// The DAO of the first sandbox runs: council [alice] with "*:*" and a guard role
/// [guard] holding VoteReject on the 16 labels other than remove_member_from_role.
fn first_sandbox_policy() -> Policy {
    let guard: Vec<String> =
        LABELS.iter().filter(|l| **l != "remove_member_from_role").map(|l| format!("{l}:VoteReject")).collect();
    with_roles(json!([
        { "name": "council", "kind": { "Group": ["alice.sandbox"] }, "permissions": ["*:*"], "vote_policy": {} },
        { "name": "guard", "kind": { "Group": ["guard.sandbox"] }, "permissions": guard, "vote_policy": {} }
    ]))
}

#[test]
fn to_weight_matches_sputniks_own_test() {
    // policy.rs 444-453, test_vote_policy.
    assert_eq!(WeightOrRatio::Weight(100).to_weight(1_000_000), Some(100));
    assert_eq!(WeightOrRatio::Ratio(1, 2).to_weight(2), Some(2));
    assert_eq!(WeightOrRatio::Ratio(1, 2).to_weight(5), Some(3));
    assert_eq!(WeightOrRatio::Ratio(1, 1).to_weight(5), Some(5));
}

#[test]
fn threshold_formula_cases() {
    // (rule, members, votes needed), from policy.rs 98-106 and 415-418 worked by hand.
    let cases: [(Value, usize, u128); 9] = [
        (json!({"weight_kind":"RoleWeight","quorum":"0","threshold":[1,2]}), 1, 1),
        (json!({"weight_kind":"RoleWeight","quorum":"0","threshold":[1,2]}), 4, 3),
        (json!({"weight_kind":"RoleWeight","quorum":"0","threshold":[49,100]}), 4, 2),
        (json!({"weight_kind":"RoleWeight","quorum":"0","threshold":[2,100]}), 10, 1),
        (json!({"weight_kind":"RoleWeight","quorum":"0","threshold":[3,5]}), 5, 4),
        (json!({"weight_kind":"RoleWeight","quorum":"0","threshold":[59,100]}), 5, 3),
        (json!({"weight_kind":"RoleWeight","quorum":"0","threshold":"5"}), 3, 3),
        (json!({"weight_kind":"RoleWeight","quorum":"3","threshold":[1,2]}), 2, 3),
        (json!({"weight_kind":"RoleWeight","quorum":"0","threshold":"1"}), 2, 1),
    ];
    for (rule, size, expected) in cases {
        let members: Vec<String> = (0..size).map(|i| format!("m{i}.near")).collect();
        let p = with_roles(json!([{ "name": "r", "kind": { "Group": members }, "permissions": ["*:*"], "vote_policy": { "transfer": rule } }]));
        assert_eq!(votes_needed(&p, "r", "transfer"), expected, "{rule} with {size} members");
    }
}

#[test]
fn one_member_council_executes_on_the_first_vote() {
    // lib.rs test_basics (one council member approves alone) and the first sandbox runs'
    // alice_alone_approves_first.
    assert_eq!(votes_needed(&parse(&default_policy(&["a.near"])), "council", "transfer"), 1);
    assert_eq!(votes_needed(&first_sandbox_policy(), "council", "transfer"), 1);
    // lib.rs test_vote_twice: with two members one approval is not enough.
    assert_eq!(votes_needed(&parse(&default_policy(&["a.near", "b.near"])), "council", "transfer"), 2);
}

#[test]
fn guard_rejects_alone_and_can_do_nothing_else() {
    // The first sandbox runs' guard_reject_kills_transfer, guard_cannot_approve and
    // guard_cannot_block_its_removal.
    let p = first_sandbox_policy();
    assert_eq!(can_execute_action(&p, "guard.sandbox", "transfer", Action::VoteReject), (vec!["guard".to_string()], true));
    assert_eq!(votes_needed(&p, "guard", "transfer"), 1);
    assert!(!can_execute_action(&p, "guard.sandbox", "transfer", Action::VoteApprove).1);
    assert!(!can_execute_action(&p, "guard.sandbox", "remove_member_from_role", Action::VoteReject).1);
    assert!(!can_execute_action(&p, "guard.sandbox", "transfer", Action::AddProposal).1);
}

#[test]
fn default_policy_rights() {
    let p = parse(&default_policy(&["a.near"]));
    // lib.rs test_basics: a non-member may file proposals through the Everyone role.
    assert_eq!(can_execute_action(&p, "x.near", "add_member_to_role", Action::AddProposal), (vec!["all".to_string()], true));
    assert!(!can_execute_action(&p, "x.near", "transfer", Action::VoteApprove).1);
    // A member matches Everyone as well as council (policy.rs 28).
    assert_eq!(
        can_execute_action(&p, "a.near", "transfer", Action::AddProposal),
        (vec!["all".to_string(), "council".to_string()], true)
    );
    // lib.rs test_remove_proposal_denied: "all actions except RemoveProposal" (policy.rs 197).
    assert!(!can_execute_action(&p, "a.near", "transfer", Action::RemoveProposal).1);
}

#[test]
fn remove_proposal_once_granted() {
    // lib.rs test_remove_proposal_allowed adds "*:RemoveProposal" to the council.
    let mut v = default_policy(&["a.near"]);
    v["roles"][1]["permissions"].as_array_mut().unwrap().push(json!("*:RemoveProposal"));
    assert!(can_execute_action(&parse(&v), "a.near", "transfer", Action::RemoveProposal).1);
}

#[test]
fn the_four_permission_patterns_and_nothing_else() {
    // policy.rs 346-353: "<label>:<action>", "<label>:*", "*:<action>", "*:*", matched exactly.
    let cases: [(&str, bool); 10] = [
        ("transfer:VoteApprove", true),
        ("transfer:*", true),
        ("*:VoteApprove", true),
        ("*:*", true),
        ("call:VoteApprove", false),
        ("Transfer:VoteApprove", false),
        ("transfer:voteapprove", false),
        ("transfer:VoteApprove ", false),
        ("transfer", false),
        ("*", false),
    ];
    for (permission, expected) in cases {
        let p = with_roles(json!([{ "name": "r", "kind": { "Group": ["a.near"] }, "permissions": [permission], "vote_policy": {} }]));
        assert_eq!(can_execute_action(&p, "a.near", "transfer", Action::VoteApprove).1, expected, "{permission:?}");
    }
}

#[test]
fn duplicate_names_take_permissions_from_the_last_match_and_votes_from_the_first() {
    // policy.rs 323-331: get_user_roles maps name to permissions, so a later role of the same
    // name that the account matches overwrites an earlier one. policy.rs 374-376 and 398: the
    // vote rule and the group size come from the first role of that name.
    let roles = json!([
        { "name": "council", "kind": { "Group": ["x.near"] }, "permissions": ["*:VoteApprove"], "vote_policy": {} },
        { "name": "council", "kind": { "Group": ["x.near", "y.near", "z.near"] }, "permissions": ["*:AddProposal"],
          "vote_policy": { "transfer": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": "3" } } }
    ]);
    let p = with_roles(roles.clone());
    assert!(!can_execute_action(&p, "x.near", "transfer", Action::VoteApprove).1, "the last match wins for x");
    assert!(!can_execute_action(&p, "y.near", "transfer", Action::VoteApprove).1);
    assert_eq!(votes_needed(&p, "council", "transfer"), 1, "first role: one member at the default 1/2");

    let mut swapped = roles.as_array().unwrap().clone();
    swapped.reverse();
    let p = with_roles(Value::Array(swapped));
    assert!(can_execute_action(&p, "x.near", "transfer", Action::VoteApprove).1, "now the approving role is last for x");
    assert!(!can_execute_action(&p, "y.near", "transfer", Action::VoteApprove).1, "y only matches the filing role");
    assert_eq!(votes_needed(&p, "council", "transfer"), 3, "first role: weight 3 of 3 members");
}

#[test]
fn roles_that_never_decide_by_head_count() {
    let p = with_roles(json!([
        { "name": "all", "kind": "Everyone", "permissions": ["*:*"], "vote_policy": {} },
        { "name": "holders", "kind": { "Member": "1" }, "permissions": ["*:*"], "vote_policy": {} },
        { "name": "tw", "kind": { "Group": ["a.near"] }, "permissions": ["*:*"],
          "vote_policy": { "transfer": { "weight_kind": "TokenWeight", "quorum": "600", "threshold": [1, 2] } } }
    ]));
    // policy.rs 405: an Everyone role is skipped by proposal_status.
    assert_eq!(votes_needed(&p, "all", "transfer"), u128::MAX);
    assert_eq!(threshold(&p, "all", "transfer", 1000), None);
    // policy.rs 413 and 407-411: Member roles and TokenWeight rules count tokens.
    assert_eq!(votes_needed(&p, "holders", "transfer"), u128::MAX);
    assert_eq!(threshold(&p, "holders", "transfer", 1000), Some(501));
    assert_eq!(votes_needed(&p, "tw", "transfer"), u128::MAX);
    assert_eq!(threshold(&p, "tw", "transfer", 1000), Some(600), "the quorum is the floor");
    // policy.rs 398: ERR_MISSING_ROLE.
    assert_eq!(votes_needed(&p, "nobody", "transfer"), u128::MAX);
    // policy.rs 29: a Member role matches on delegated balance only.
    assert_eq!(can_execute_action(&p, "a.near", "transfer", Action::VoteApprove).0, vec!["all", "tw"]);
    assert_eq!(can_execute_action_weighted(&p, "b.near", 1, "transfer", Action::VoteApprove).0, vec!["all", "holders"]);
    assert_eq!(can_execute_action_weighted(&p, "b.near", 0, "transfer", Action::VoteApprove).0, vec!["all"]);
}

#[test]
fn a_group_counts_distinct_members() {
    // RoleKind::Group is a HashSet (policy.rs 21), so a repeated account is one member.
    let p = with_roles(json!([{ "name": "r", "kind": { "Group": ["a.near", "a.near", "b.near"] }, "permissions": ["*:*"], "vote_policy": {} }]));
    assert_eq!(p.roles[0].members().map(BTreeSet::len), Some(2));
    assert_eq!(votes_needed(&p, "r", "transfer"), 2);
}

#[test]
fn adding_a_member_to_a_role_that_does_not_exist_does_nothing() {
    // policy.rs 292-305 and lib.rs test_add_to_missing_role: only a log line.
    let before = parse(&default_policy(&["a.near"]));
    let mut after = before.clone();
    after.add_member_to_role("missing", "b.near");
    assert_eq!(after, before);
    // ERR_ROLE_WRONG_KIND: an Everyone role has no member list to add to.
    after.add_member_to_role("all", "b.near");
    assert_eq!(after, before);
    // Role names are matched exactly, so "Council" is a missing role.
    after.add_member_to_role("Council", "b.near");
    assert_eq!(after, before);
    after.add_member_to_role("council", "b.near");
    assert_eq!(after.first_role("council").unwrap().members().unwrap().len(), 2);
}

#[test]
fn shortcut_edits_touch_only_the_first_role_of_a_name() {
    let p = with_roles(json!([
        { "name": "c", "kind": { "Group": ["a.near"] }, "permissions": [], "vote_policy": {} },
        { "name": "c", "kind": { "Group": ["a.near"] }, "permissions": [], "vote_policy": {} }
    ]));
    let mut added = p.clone();
    added.add_member_to_role("c", "b.near");
    assert_eq!(added.roles[0].members().unwrap().len(), 2);
    assert_eq!(added.roles[1].members().unwrap().len(), 1);

    let mut removed = p.clone();
    removed.remove_member_from_role("c", "a.near");
    assert!(removed.roles[0].members().unwrap().is_empty());
    assert_eq!(removed.roles[1].members().unwrap().len(), 1);

    let mut dropped = p.clone();
    dropped.remove_role("c");
    assert_eq!(dropped.roles.len(), 1, "policy.rs 261-269 removes the first match and returns");
    dropped.remove_role("missing");
    assert_eq!(dropped.roles.len(), 1, "ERR_ROLE_NOT_FOUND is only a log line");
}

#[test]
fn removing_a_member_who_is_not_there_changes_nothing() {
    let before = parse(&default_policy(&["a.near"]));
    let mut after = before.clone();
    after.remove_member_from_role("council", "b.near");
    assert_eq!(after, before);
    after.remove_member_from_role("council", "a.near");
    assert!(after.first_role("council").unwrap().members().unwrap().is_empty());
}

#[test]
fn add_or_update_role_replaces_the_whole_role_members_included() {
    // policy.rs 246-259 and the test_add_role and test_update_role tests (policy.rs 455-534).
    let mut p = parse(&default_policy(&["a.near", "b.near"]));
    let replacement = Role::from_json(&json!({ "name": "council", "kind": { "Group": ["c.near"] }, "permissions": ["*:*"], "vote_policy": {} })).unwrap();
    p.add_or_update_role(&replacement);
    assert_eq!(p.roles.len(), 2);
    assert_eq!(p.first_role("council"), Some(&replacement));
    assert!(!can_execute_action(&p, "a.near", "transfer", Action::VoteApprove).1, "a.near lost its seat");

    let community = Role::from_json(&json!({ "name": "community", "kind": { "Group": ["d.near", "e.near"] }, "permissions": ["*:*"], "vote_policy": {} })).unwrap();
    p.add_or_update_role(&community);
    assert_eq!(p.roles.len(), 3);
    assert_eq!(p.roles[2], community, "a new name is appended");
}

#[test]
fn remove_role_matches_sputniks_own_test() {
    // policy.rs 536-550, test_remove_role.
    let mut p = parse(&default_policy(&["a.near", "b.near"]));
    p.remove_role("council");
    assert!(p.first_role("council").is_none());
    assert_eq!(p.roles.len(), 1);
}

#[test]
fn default_vote_policy_and_parameters_match_sputniks_own_tests() {
    // policy.rs 552-585 and 587-620.
    let mut p = parse(&default_policy(&["a.near", "b.near"]));
    let vp = VotePolicy::from_json(&json!({ "weight_kind": "TokenWeight", "quorum": "100", "threshold": [1, 4] })).unwrap();
    p.update_default_vote_policy(&vp);
    assert_eq!(p.default_vote_policy, vp);

    let params = PolicyParameters::from_json(&json!({
        "proposal_bond": "100000000000000000000000000", "proposal_period": null,
        "bounty_bond": null, "bounty_forgiveness_period": "432000000000000"
    }))
    .unwrap();
    p.update_parameters(&params);
    assert_eq!(p.proposal_bond, 100 * 10u128.pow(24));
    assert_eq!(p.proposal_period, 604_800_000_000_000);
    assert_eq!(p.bounty_bond, 10u128.pow(24));
    assert_eq!(p.bounty_forgiveness_period, 432_000_000_000_000);

    let unchanged = p.clone();
    p.update_parameters(&PolicyParameters::from_json(&json!({})).unwrap());
    assert_eq!(p, unchanged, "every field is an Option, so an empty object changes nothing");
}

#[test]
fn the_parser_takes_only_what_sputnik_accepts() {
    let good = default_policy(&["a.near"]);
    let edits: [(&str, Value); 9] = [
        ("an unknown policy field", json!({"extra": 1})),
        ("a bond written as a number", json!({"proposal_bond": 1})),
        ("a missing period", json!({"proposal_period": null})),
        ("a zero ratio denominator", json!({"default_vote_policy": {"weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 0]}})),
        ("a threshold written as a number", json!({"default_vote_policy": {"weight_kind": "RoleWeight", "quorum": "0", "threshold": 1}})),
        ("an unknown weight kind", json!({"default_vote_policy": {"weight_kind": "HeadCount", "quorum": "0", "threshold": "1"}})),
        ("a quorum with a decimal point", json!({"default_vote_policy": {"weight_kind": "RoleWeight", "quorum": "1.5", "threshold": "1"}})),
        ("an unknown role field", json!({"roles": [{"name": "r", "kind": "Everyone", "permissions": [], "vote_policy": {}, "x": 1}]})),
        ("a role kind Sputnik does not have", json!({"roles": [{"name": "r", "kind": {"Admins": []}, "permissions": [], "vote_policy": {}}]})),
    ];
    for (what, edit) in edits {
        let mut v = good.clone();
        for (k, val) in edit.as_object().unwrap() {
            v[k] = val.clone();
        }
        assert_eq!(Policy::from_json(&v), None, "{what}");
    }
    // VersionedPolicy::Default, a bare account list, is refused by add_proposal (proposals.rs 548-551).
    assert_eq!(Policy::from_json(&json!(["a.near"])), None);
    // near-sdk reads U128 with str::parse, which takes a leading "+", so Sputnik does too.
    let mut plus = good.clone();
    plus["default_vote_policy"]["quorum"] = json!("+2");
    assert_eq!(parse(&plus).default_vote_policy.quorum, 2);
    // Sputnik writes vote rules back in this one shape.
    assert_eq!(
        parse(&good).default_vote_policy.to_json(),
        json!({"weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 2]})
    );
}

/// The variants of `ProposalKind` as declared in proposals.rs 67-121, copied from the source.
/// If Sputnik adds a kind, this list and `KIND_LABELS` must both change, or this test fails.
const PROPOSAL_KIND_VARIANTS: [&str; 17] = [
    "ChangeConfig",
    "ChangePolicy",
    "AddMemberToRole",
    "RemoveMemberFromRole",
    "FunctionCall",
    "UpgradeSelf",
    "UpgradeRemote",
    "Transfer",
    "SetStakingContract",
    "AddBounty",
    "BountyDone",
    "Vote",
    "FactoryInfoUpdate",
    "ChangePolicyAddOrUpdateRole",
    "ChangePolicyRemoveRole",
    "ChangePolicyUpdateDefaultVotePolicy",
    "ChangePolicyUpdateParameters",
];

#[test]
fn every_kind_has_exactly_one_label() {
    let variants: BTreeSet<&str> = KIND_LABELS.iter().map(|(v, _)| *v).collect();
    assert_eq!(variants, PROPOSAL_KIND_VARIANTS.into_iter().collect::<BTreeSet<_>>());
    assert_eq!(LABELS.iter().collect::<BTreeSet<_>>().len(), 17, "no two kinds share a label");
    for variant in PROPOSAL_KIND_VARIANTS {
        assert!(label_of(variant).is_some_and(|l| LABELS.contains(&l)), "{variant}");
    }
    assert_eq!(label_of("Nonsense"), None);
}

#[test]
fn labels_of_kinds_as_get_proposal_returns_them() {
    // Moved from lib.rs (`tests::labels_match_sputnik`), now read through the strict kind reader.
    assert_eq!(to_policy_label(br#"{"RemoveMemberFromRole":{"member_id":"a.near","role":"Guard"}}"#), "remove_member_from_role");
    assert_eq!(to_policy_label(br#"{"SetStakingContract":{"staking_id":"s.near"}}"#), "set_vote_token");
    assert_eq!(to_policy_label(br#""Vote""#), "vote");
    assert_eq!(to_policy_label(b"not json"), "");
    assert_eq!(to_policy_label(br#"{"Transfer":{},"Vote":{}}"#), "");
    assert_eq!(to_policy_label(br#"{"Transfer":{"token_id":"","token_id":"x.near"}}"#), "", "a duplicate key is refused");
    assert_eq!(to_policy_label(br#"{"Nonsense":{}}"#), "");
}

#[test]
fn action_labels_are_the_variant_names() {
    // types.rs 65-69: to_policy_label is format!("{:?}", self).
    for action in Action::ALL {
        assert_eq!(action.to_policy_label(), format!("{action:?}"));
    }
}
