// Strict mode in the rules engine (threat model C8 and C17, decided 12 Nov 2026). A FunctionCall to
// the treasury's own guard that turns strict mode off, or whose arguments do not read as exactly
// `{"on":true}`, weakens the guard and carries GUARD_WEAKENED; turning it on does not. With
// `guard_strict`, a proposal whose findings include HASH_UNVERIFIED is `must_veto` and
// `veto_allowed`, and nothing else about any of the 373 public records changes. It does NOT cover
// the guard contract's own rule (packages/contracts tests), how the setting is read from the chain
// (the worker and the CLI), or a guard account the caller does not name: with `guard_account`
// unknown, a call to the guard stays an unknown call with no GUARD_WEAKENED.

mod common;

use base64::Engine as _;
use common::*;
use kaap_core::floor::{finish, finish_with_mode};
use kaap_core::{analyze, analyze_with_mode, enrolment, Analysis, DescCheck, FindingCode, Network, Prices, ProposalInput, Severity};
use serde_json::{json, Value};

const GUARD: &str = "kaap-guard-1111072803.testnet";
const DAO: &str = "kaap-dao-1111072928.testnet";

/// A FunctionCall kind with one action per entry of `actions` (method, raw argument bytes).
fn calls(receiver: &str, actions: &[(&str, &[u8])]) -> Value {
    let actions: Vec<Value> = actions
        .iter()
        .map(|(method, args)| {
            json!({ "method_name": method, "args": base64::engine::general_purpose::STANDARD.encode(args), "deposit": "0", "gas": "10000000000000" })
        })
        .collect();
    json!({ "FunctionCall": { "receiver_id": receiver, "actions": actions } })
}

fn mode_call(receiver: &str, method: &str, args: &[u8]) -> Value {
    calls(receiver, &[(method, args)])
}

fn read(kind: &Value, guard_account: Option<&str>) -> Analysis {
    analyze(&ProposalInput {
        network: Network::Testnet,
        dao: DAO.into(),
        proposal_id: 4,
        description: "Set strict mode on Kaap's guard".into(),
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

fn weakens(a: &Analysis) -> bool {
    codes(a).contains(&FindingCode::GuardWeakened)
}

#[test]
fn the_method_is_the_guards_own() {
    assert_eq!(enrolment::MODE_METHOD, "set_veto_unreadable");
}

#[test]
fn turning_strict_mode_off_weakens_the_guard() {
    let a = read(&mode_call(GUARD, enrolment::MODE_METHOD, br#"{"on":false}"#), Some(GUARD));
    assert!(weakens(&a), "{:?}", codes(&a));
    assert!(codes(&a).contains(&FindingCode::UnknownCall), "the call itself stays an unknown call");
    assert!(matches!(a.risk_floor, Severity::High | Severity::Critical), "at least high and alerts every member (C17)");
}

#[test]
fn arguments_that_do_not_read_as_turning_it_on_weaken_the_guard() {
    let unreadable: [&[u8]; 10] = [
        b"not json",
        b"",
        b"{}",
        br#"{"on":null}"#,
        br#"{"on":"true"}"#,
        br#"{"on":1}"#,
        br#"[true]"#,
        br#"{"on":true,"on":false}"#,
        br#"{"on":true,"also":1}"#,
        br#"{"On":true}"#,
    ];
    for args in unreadable {
        let a = read(&mode_call(GUARD, enrolment::MODE_METHOD, args), Some(GUARD));
        assert!(weakens(&a), "{}: {:?}", String::from_utf8_lossy(args), codes(&a));
    }
}

#[test]
fn turning_strict_mode_on_does_not_weaken_the_guard() {
    let a = read(&mode_call(GUARD, enrolment::MODE_METHOD, br#"{"on":true}"#), Some(GUARD));
    assert!(!weakens(&a), "{:?}", codes(&a));
    assert!(codes(&a).contains(&FindingCode::UnknownCall), "still an unknown call, high");
}

#[test]
fn a_second_action_that_turns_it_off_weakens_the_guard() {
    let on_then_off = calls(GUARD, &[(enrolment::MODE_METHOD, br#"{"on":true}"#), (enrolment::MODE_METHOD, br#"{"on":false}"#)]);
    assert!(weakens(&read(&on_then_off, Some(GUARD))));
}

#[test]
fn only_the_treasurys_own_guard_and_the_exact_method_count() {
    let off: &[u8] = br#"{"on":false}"#;
    assert!(!weakens(&read(&mode_call("not-the-guard.testnet", enrolment::MODE_METHOD, off), Some(GUARD))));
    assert!(!weakens(&read(&mode_call(GUARD, enrolment::MODE_METHOD, off), None)), "no guard account named, the non-goal above");
    for method in ["Set_veto_unreadable", "veto_unreadable", "set_veto_unreadable_v2"] {
        assert!(!weakens(&read(&mode_call(GUARD, method, off), Some(GUARD))), "{method}");
    }
}

#[test]
fn an_unreadable_hash_alone_is_vetoed_only_for_a_strict_treasury() {
    let hash_only = || (vec![], vec![FindingCode::HashUnverified], DescCheck::Vague, "call");
    let (e, c, d, l) = hash_only();
    let default = finish(e, c, d, l);
    assert!(!default.veto_allowed && !default.must_veto, "{default:?}");
    let (e, c, d, l) = hash_only();
    assert_eq!(finish_with_mode(e, c, d, l, false), default);
    let (e, c, d, l) = hash_only();
    let strict = finish_with_mode(e, c, d, l, true);
    assert!(strict.veto_allowed && strict.must_veto, "{strict:?}");
    assert_eq!(Analysis { must_veto: false, veto_allowed: false, ..strict }, default, "only the veto fields move");

    let medium = finish_with_mode(vec![], vec![FindingCode::NewRecipient], DescCheck::Vague, "transfer", true);
    assert_eq!(medium, finish(vec![], vec![FindingCode::NewRecipient], DescCheck::Vague, "transfer"), "no unreadable hash, nothing moves");
}

#[test]
fn on_the_373_public_records_the_flag_moves_only_the_veto_fields_of_unreadable_hashes() {
    let prices = census_prices();
    let (mut records, mut with_hash, mut hash_only, mut moved) = (0, 0, 0, 0);
    for file in [REAL, PLANTED] {
        for record in read_jsonl(&repo_root().join(file)).unwrap() {
            let input = input_of(&record, &prices).unwrap();
            let default = analyze(&input);
            assert_eq!(analyze_with_mode(&input, false), default, "{}", record["id"]);
            let strict = analyze_with_mode(&input, true);
            records += 1;
            if !codes(&default).contains(&FindingCode::HashUnverified) {
                assert_eq!(strict, default, "{}", record["id"]);
                continue;
            }
            with_hash += 1;
            assert_eq!(strict, Analysis { must_veto: true, veto_allowed: true, ..default.clone() }, "{}", record["id"]);
            moved += usize::from(strict != default);
            if codes(&default) == [FindingCode::HashUnverified] {
                hash_only += 1;
                assert!(!default.veto_allowed && !default.must_veto, "{}", record["id"]);
            }
        }
    }
    assert_eq!(records, 373);
    assert_eq!((with_hash, hash_only, moved), (30, 29, 30), "records with HASH_UNVERIFIED, with it alone, and whose veto fields the flag moves");
}
