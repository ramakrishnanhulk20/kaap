// Checks the risk floor and the veto fields of guide section 6 on 12 hand-written cases. It does
// not check which codes a decoder fires, and it does not cover `should_veto`, which is a scoring
// truth for the answer key and never computed by Kaap.

use kaap_core::floor::finish;
use kaap_core::*;
use serde_json::json;
use FindingCode::*;

struct Case {
    name: &'static str,
    effects: Vec<serde_json::Value>,
    codes: Vec<FindingCode>,
    kind_label: &'static str,
    floor: Severity,
    must_veto: bool,
    veto_allowed: bool,
}

fn transfer() -> serde_json::Value {
    json!({"type": "transfer", "token": "near", "amount": "1000000000000000000000000", "to": "eve.near"})
}

fn guard_removal() -> serde_json::Value {
    json!({"type": "policy_change", "members_removed": [{"role": "Guard", "member": "guard.kaap.near", "approver": false}]})
}

#[test]
fn twelve_floor_and_veto_cases() {
    let cases = vec![
        Case { name: "nothing fired", effects: vec![transfer()], codes: vec![], kind_label: "transfer", floor: Severity::Low, must_veto: false, veto_allowed: false },
        Case { name: "short description only", effects: vec![], codes: vec![EmptyDescription], kind_label: "vote", floor: Severity::Low, must_veto: false, veto_allowed: false },
        Case { name: "new payee, large amount", effects: vec![transfer()], codes: vec![NewRecipient, LargeAmount], kind_label: "transfer", floor: Severity::Medium, must_veto: false, veto_allowed: false },
        Case { name: "unverifiable hash alone floors high but never vetoes", effects: vec![], codes: vec![HashUnverified], kind_label: "call", floor: Severity::High, must_veto: false, veto_allowed: false },
        Case { name: "unverifiable hash plus a medium finding", effects: vec![], codes: vec![HashUnverified, NewRecipient], kind_label: "call", floor: Severity::High, must_veto: false, veto_allowed: false },
        Case { name: "unverifiable hash plus an unknown call", effects: vec![], codes: vec![HashUnverified, UnknownCall], kind_label: "call", floor: Severity::High, must_veto: false, veto_allowed: true },
        Case { name: "new approver", effects: vec![], codes: vec![PolicyAddsApprover], kind_label: "add_member_to_role", floor: Severity::High, must_veto: false, veto_allowed: true },
        Case { name: "contradicted payment", effects: vec![transfer()], codes: vec![DescContradicts, NewRecipient], kind_label: "transfer", floor: Severity::Critical, must_veto: true, veto_allowed: true },
        Case { name: "contradiction with no value or control", effects: vec![json!({"type": "wrap", "op": "wrap", "amount": "1"})], codes: vec![DescContradicts], kind_label: "call", floor: Severity::High, must_veto: false, veto_allowed: true },
        Case { name: "hash mismatch", effects: vec![], codes: vec![HashMismatch], kind_label: "call", floor: Severity::Critical, must_veto: true, veto_allowed: true },
        Case { name: "hidden guard removal by remove_member_from_role", effects: vec![guard_removal()], codes: vec![DescContradicts, GuardWeakened, PolicyRemovesMember], kind_label: "remove_member_from_role", floor: Severity::Critical, must_veto: true, veto_allowed: false },
        Case { name: "hidden guard removal by policy_remove_role", effects: vec![guard_removal()], codes: vec![DescContradicts, GuardWeakened, PolicyRemovesMember], kind_label: "policy_remove_role", floor: Severity::Critical, must_veto: true, veto_allowed: true },
    ];
    assert_eq!(cases.len(), 12);
    for c in cases {
        let effects: Vec<Effect> = c.effects.into_iter().map(|e| serde_json::from_value(e).unwrap()).collect();
        let a = finish(effects.clone(), c.codes, DescCheck::Vague, c.kind_label);
        assert_eq!(a.risk_floor, c.floor, "{}: floor", c.name);
        assert_eq!(a.must_veto, c.must_veto, "{}: must_veto", c.name);
        assert_eq!(a.veto_allowed, c.veto_allowed, "{}: veto_allowed", c.name);
        assert_eq!(a.effects, effects, "{}: effects pass through", c.name);
    }
}

#[test]
fn codes_are_deduplicated_and_ordered_by_the_table() {
    let a = finish(vec![], vec![UnknownCall, AttachedDeposit, UnknownCall, HashMismatch], DescCheck::Contradicts, "call");
    let codes: Vec<FindingCode> = a.findings.iter().map(|f| f.code).collect();
    assert_eq!(codes, vec![HashMismatch, UnknownCall, AttachedDeposit]);
    assert_eq!(a.findings[0].severity, Severity::Critical);
    assert_eq!(a.findings[2].severity, Severity::Medium);
    assert_eq!(a.description_check, DescCheck::Contradicts);
}

#[test]
fn desc_contradicts_severity_sees_codes_from_other_modules() {
    let removal: Effect = serde_json::from_value(guard_removal()).unwrap();
    let without = finish(vec![removal.clone()], vec![DescContradicts, PolicyRemovesMember], DescCheck::Contradicts, "policy");
    let with = finish(vec![removal], vec![PolicyRemovesMember, DescContradicts, GuardWeakened], DescCheck::Contradicts, "policy");
    assert_eq!(without.risk_floor, Severity::High);
    assert_eq!(with.risk_floor, Severity::Critical);
}
