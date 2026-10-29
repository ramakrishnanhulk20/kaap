// Checks the section 4 severity table and the DESC_CONTRADICTS value-or-control rule on
// hand-built effects. It does not check that any decoder produces those effects, and it does not
// check the labelled answer key; the evaluation runner (WO-01b) does both.

use kaap_core::severity::severity;
use kaap_core::*;
use serde_json::json;

fn effect(v: serde_json::Value) -> Effect {
    serde_json::from_value(v).expect("test effect must match the guide's shape")
}

fn member(role: &str, who: &str, approver: bool) -> serde_json::Value {
    json!({"role": role, "member": who, "approver": approver})
}

fn desc_severity(effects: &[Effect], other_codes: &[FindingCode]) -> Severity {
    let mut codes = vec![FindingCode::DescContradicts];
    codes.extend_from_slice(other_codes);
    severity(FindingCode::DescContradicts, effects, &codes)
}

#[test]
fn table_covers_all_24_codes_with_the_guide_severities() {
    use FindingCode::*;
    let table = [
        (HashMismatch, Severity::Critical),
        (HashTextDangerous, Severity::Critical),
        (PolicyDuplicateRoleNames, Severity::Critical),
        (PromptInjection, Severity::Critical),
        (DescContradicts, Severity::High),
        (PolicyAddsApprover, Severity::High),
        (PolicyLowersThreshold, Severity::High),
        (PolicyReplacesRole, Severity::High),
        (PolicyRemovesMember, Severity::High),
        (PolicyBeforeUnknown, Severity::High),
        (CodeUpgrade, Severity::High),
        (IntentsKeyChange, Severity::High),
        (GuardWeakened, Severity::High),
        (UnknownCall, Severity::High),
        (ArgsNotJson, Severity::High),
        (UnknownValue, Severity::High),
        (LookalikeToken, Severity::High),
        (OtherRiskyKind, Severity::High),
        (HashUnverified, Severity::Unknown),
        (AttachedDeposit, Severity::Medium),
        (CrossChainOut, Severity::Medium),
        (NewRecipient, Severity::Medium),
        (LargeAmount, Severity::Medium),
        (EmptyDescription, Severity::Low),
    ];
    let listed: Vec<FindingCode> = table.iter().map(|(c, _)| *c).collect();
    assert_eq!(listed, FindingCode::ALL.to_vec(), "table must list every code once, in guide order");
    for (code, expected) in table {
        assert_eq!(severity(code, &[], &[code]), expected, "{code:?}");
    }
}

#[test]
fn codes_other_than_desc_contradicts_ignore_context() {
    let busy = [
        effect(json!({"type": "transfer", "token": "near", "amount": "1", "to": "a.near"})),
        effect(json!({"type": "code_upgrade", "target": "self", "code_hash": "h"})),
    ];
    let all = FindingCode::ALL;
    for code in all.into_iter().filter(|c| *c != FindingCode::DescContradicts) {
        assert_eq!(severity(code, &busy, &all), severity(code, &[], &[code]), "{code:?}");
    }
}

#[test]
fn desc_contradicts_is_critical_when_value_moves() {
    let cases = [
        json!({"type": "transfer", "token": "near", "amount": "1", "to": "a.near"}),
        json!({"type": "token_call_transfer", "token": "usdc.near", "amount": "5", "to": "intents.near", "msg_kind": "intents_deposit"}),
        json!({"type": "intents_withdraw", "token": "wrap.near", "amount": "9", "chain": "eth", "address": "0xabc"}),
        json!({"type": "intents_transfer", "token": "wrap.near", "amount": "9", "to": "b.near"}),
        json!({"type": "bulk_payment", "contract": "bulkpayment.near", "list_id": "7", "total": "100"}),
    ];
    for c in cases {
        assert_eq!(desc_severity(&[effect(c.clone())], &[]), Severity::Critical, "{c}");
    }
}

#[test]
fn desc_contradicts_is_critical_when_control_changes() {
    let cases = [
        json!({"type": "policy_change", "members_added": [member("Approver", "eve.near", true)]}),
        json!({"type": "policy_change", "members_removed": [member("Admin", "bob.near", true)]}),
        json!({"type": "policy_change", "permissions_changed": [{"role": "Requestor", "added": ["*:VoteApprove"], "removed": []}]}),
        json!({"type": "policy_change", "vote_policy_changed": [{"role": "Admin", "label": "policy", "before": {"threshold": [1, 2]}, "after": {"threshold": "1"}}]}),
        json!({"type": "intents_key_change", "op": "add", "public_key": "ed25519:abc"}),
        json!({"type": "code_upgrade", "target": "self", "code_hash": "h"}),
    ];
    for c in cases {
        assert_eq!(desc_severity(&[effect(c.clone())], &[]), Severity::Critical, "{c}");
    }
}

#[test]
fn guard_weakened_alongside_counts_as_control() {
    // Removing the guard from its own reject-only role: the role cannot approve, so only the
    // GUARD_WEAKENED code makes this a control change (ruling 23, planted #48 and #49).
    let removal = [effect(json!({"type": "policy_change", "members_removed": [member("Guard", "guard.kaap.near", false)]}))];
    assert_eq!(desc_severity(&removal, &[FindingCode::PolicyRemovesMember]), Severity::High);
    assert_eq!(
        desc_severity(&removal, &[FindingCode::PolicyRemovesMember, FindingCode::GuardWeakened]),
        Severity::Critical
    );
    assert_eq!(desc_severity(&[], &[FindingCode::GuardWeakened]), Severity::Critical);
}

#[test]
fn desc_contradicts_is_high_without_value_or_control() {
    let cases = [
        json!({"type": "policy_change", "members_added": [member("Requestor", "alice.near", false)]}),
        json!({"type": "policy_change", "members_removed": [member("Requestor", "alice.near", false)]}),
        json!({"type": "policy_change", "bond_or_period_changed": true}),
        json!({"type": "policy_change", "roles_added": ["Observers"]}),
        json!({"type": "config_change", "name": "dao", "purpose_changed": true, "metadata_changed": "unknown"}),
        json!({"type": "wrap", "op": "wrap", "amount": "1"}),
        json!({"type": "staking", "pool": "a.poolv1.near", "op": "unstake", "amount": "all"}),
        json!({"type": "storage_deposit", "contract": "usdc.near", "for_account": "dao.near", "amount": "1250000000000000000000"}),
        json!({"type": "defi_call", "protocol": "burrow", "method": "execute", "summary": "supply"}),
        json!({"type": "sign_request", "mpc": "v1.signer", "path": "dao.near", "domain_id": 1, "payload_hash": "ab", "text_supplied": false, "text_source": null, "text_standard": null}),
        json!({"type": "other_kind", "kind": "AddBounty", "summary": "bounty"}),
        json!({"type": "unknown_call", "receiver": "x.near", "method": "upgrade", "args": {}, "deposit": "0"}),
    ];
    for c in cases {
        assert_eq!(desc_severity(&[effect(c.clone())], &[]), Severity::High, "{c}");
    }
    assert_eq!(desc_severity(&[], &[]), Severity::High);
    assert_eq!(desc_severity(&[], &[FindingCode::PolicyRemovesMember, FindingCode::UnknownCall]), Severity::High);
}

#[test]
fn member_entries_without_approver_are_refused() {
    let missing = json!({"type": "policy_change", "members_added": [{"role": "Admin", "member": "eve.near"}]});
    assert!(serde_json::from_value::<Effect>(missing).is_err());
}
