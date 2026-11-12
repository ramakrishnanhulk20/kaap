// Kaap's own enrolment call, `enroll` on the enrolled guard account, read as a `guard_enrol` effect
// with no UNKNOWN_CALL, UNKNOWN_VALUE or ATTACHED_DEPOSIT, in both shapes the template writes (the
// default one and the one that chooses strict mode), and every other shape of call on or near
// the guard left an unknown call. The kind is built the way the enrolment template builds it, with
// the template's own description, and read with no prices, so an unpriced NEAR amount would show.
// It does NOT cover the guard account being Kaap's (the caller vouches for that), what the guard
// contract does with the call (packages/contracts tests), or the role draft (enrol_guard_role.rs).

use base64::Engine as _;
use kaap_core::enrolment;
use kaap_core::{analyze, Analysis, Effect, FindingCode, Network, Prices, ProposalInput};
use serde_json::{json, Value};

const GUARD: &str = "kaap-guard-1029061211.testnet";
const DAO: &str = "kaap-dao-1029064008.testnet";

fn call(receiver: &str, method: &str, args: &Value, deposit: u128) -> Value {
    let args = base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(args).unwrap());
    json!({ "FunctionCall": { "receiver_id": receiver, "actions": [{
        "method_name": method, "args": args, "deposit": deposit.to_string(), "gas": enrolment::GAS.to_string(),
    }] } })
}

fn read(kind: &Value, guard_account: Option<&str>) -> Analysis {
    analyze(&ProposalInput {
        network: Network::Testnet,
        dao: DAO.into(),
        proposal_id: 1,
        description: format!(
            "Enrol this treasury in Kaap's guard {GUARD}. It attaches 0.01 NEAR for the guard's storage; the guard keeps \
             what its entry costs and refunds the rest."
        ),
        kind_json: serde_json::to_vec(kind).unwrap(),
        policy_before: None,
        history: None,
        prices: Prices::default(),
        dao_version: None,
        supplied_text: None,
        guard_account: guard_account.map(str::to_string),
        config_before: None,
        block_timestamp_ns: None,
    })
}

fn codes(a: &Analysis) -> Vec<FindingCode> {
    a.findings.iter().map(|f| f.code).collect()
}

fn is_unknown(a: &Analysis) -> bool {
    a.effects.iter().any(|e| matches!(e, Effect::UnknownCall { .. })) && codes(a).contains(&FindingCode::UnknownCall)
}

#[test]
fn the_cap_is_the_templates_one_hundredth_of_a_near() {
    assert_eq!(enrolment::DEPOSIT_YOCTO, 10u128.pow(22), "0.01 NEAR, packages/contracts/GAS.md");
    assert_eq!(enrolment::METHOD, "enroll");
}

#[test]
fn enroll_on_the_guard_reads_as_guard_enrol() {
    for deposit in [enrolment::DEPOSIT_YOCTO, 2_390_000_000_000_000_000_000] {
        let a = read(&call(GUARD, enrolment::METHOD, &json!({}), deposit), Some(GUARD));
        assert_eq!(a.effects, vec![Effect::GuardEnrol { guard: GUARD.into(), deposit: deposit.to_string(), strict: false }]);
        assert!(codes(&a).is_empty(), "no UNKNOWN_CALL, UNKNOWN_VALUE or ATTACHED_DEPOSIT: {:?}", codes(&a));
        let written = serde_json::to_value(&a.effects[0]).unwrap();
        assert_eq!(written, json!({ "type": "guard_enrol", "guard": GUARD, "deposit": deposit.to_string() }), "a default enrolment is written as before strict mode");
    }
}

#[test]
fn the_strict_enrolment_the_template_writes_reads_as_guard_enrol_in_strict_mode() {
    let args = enrolment::args(true);
    assert_eq!(args, json!({ "veto_unreadable": true }));
    let a = read(&call(GUARD, enrolment::METHOD, &args, enrolment::DEPOSIT_YOCTO), Some(GUARD));
    assert_eq!(a.effects, vec![Effect::GuardEnrol { guard: GUARD.into(), deposit: enrolment::DEPOSIT_YOCTO.to_string(), strict: true }]);
    assert!(codes(&a).is_empty(), "Kaap's own strict enrolment carries no finding: {:?}", codes(&a));
    let written = serde_json::to_value(&a.effects[0]).unwrap();
    assert_eq!(written["strict"], json!(true));
    assert_eq!(serde_json::from_value::<Effect>(written).unwrap(), a.effects[0], "and reads back");
    // The same call on another account, or with no guard named, is nobody's enrolment.
    assert!(is_unknown(&read(&call("not-the-guard.testnet", enrolment::METHOD, &args, enrolment::DEPOSIT_YOCTO), Some(GUARD))));
    assert!(is_unknown(&read(&call(GUARD, enrolment::METHOD, &args, enrolment::DEPOSIT_YOCTO), None)));
    assert!(is_unknown(&read(&call(GUARD, enrolment::METHOD, &args, enrolment::DEPOSIT_YOCTO + 1), Some(GUARD))));
}

#[test]
fn enroll_on_another_account_stays_unknown() {
    let a = read(&call("not-the-guard.testnet", enrolment::METHOD, &json!({}), enrolment::DEPOSIT_YOCTO), Some(GUARD));
    assert!(is_unknown(&a), "{:?}", a.effects);
    // Without the guard account no call is Kaap's own, whatever its receiver.
    assert!(is_unknown(&read(&call(GUARD, enrolment::METHOD, &json!({}), enrolment::DEPOSIT_YOCTO), None)));
}

#[test]
fn another_method_on_the_guard_stays_unknown() {
    for method in ["unenroll", "veto", "Enroll"] {
        let a = read(&call(GUARD, method, &json!({}), enrolment::DEPOSIT_YOCTO), Some(GUARD));
        assert!(is_unknown(&a), "{method}: {:?}", a.effects);
    }
}

#[test]
fn a_deposit_over_the_cap_stays_unknown() {
    let a = read(&call(GUARD, enrolment::METHOD, &json!({}), enrolment::DEPOSIT_YOCTO + 1), Some(GUARD));
    assert!(is_unknown(&a), "{:?}", a.effects);
    assert!(codes(&a).contains(&FindingCode::AttachedDeposit), "the NEAR is counted as sent to the guard");
}

#[test]
fn arguments_other_than_the_templates_two_shapes_stay_unknown() {
    for args in [
        json!({ "dao": DAO }),
        json!([]),
        json!("x"),
        json!({ "veto_unreadable": false }),
        json!({ "veto_unreadable": null }),
        json!({ "veto_unreadable": "true" }),
        json!({ "veto_unreadable": 1 }),
        json!({ "veto_unreadable": true, "dao": DAO }),
        json!({ "Veto_unreadable": true }),
    ] {
        let a = read(&call(GUARD, enrolment::METHOD, &args, enrolment::DEPOSIT_YOCTO), Some(GUARD));
        assert!(is_unknown(&a), "{args}: {:?}", a.effects);
    }
}
