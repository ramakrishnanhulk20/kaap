//! Building kaap-core's input from the agreed read and running `analyze` on it. Not covered
//! here: whether kaap-core decodes correctly (its own tests and the evaluation set cover that),
//! and prices and payment history, which this job does not read yet.

mod common;

use common::*;
use kaap_core::{analyze, Effect, FindingCode, Network, Severity};
use kaap_sealed::input::{parse_input, JobInput};
use kaap_sealed::net::Deadline;
use kaap_sealed::proposal::{judge, proposal_input};
use kaap_sealed::reads::{read_chain, ChainRead};

fn read(name: &str) -> ChainRead {
    let fx = fixture(name);
    let (mut host, mut https) = providers(&fx);
    read_chain(&mut host, &mut https, fx["dao"].as_str().unwrap(), fx["proposal_id"].as_u64().unwrap(), Deadline::after_ms(60_000), 0)
        .unwrap()
}

const GUARD: &str = "guard.kaap.testnet";

fn asked(dao: &str, id: u64) -> JobInput {
    let text = format!(r#"{{"v":1,"network":"testnet","guard":"{GUARD}","dao":"{dao}","proposal_id":{id},"expires_in_ms":600000}}"#);
    parse_input(text.as_bytes(), Some("testnet")).unwrap()
}

#[test]
fn the_input_is_the_agreed_read() {
    let r = read("transfer-ft.json");
    let input = proposal_input(&asked("corm1gu.sputnikv2.testnet", 1), None, &r);
    assert_eq!(input.kind_json, r.proposal.kind_json);
    assert_eq!(input.description, "transfer 10 cNEAR to subscription");
    assert_eq!(input.network, Network::Testnet);
    assert_eq!((input.dao.as_str(), input.proposal_id), ("corm1gu.sputnikv2.testnet", 1));
    let before = input.policy_before.as_ref().expect("an InProgress proposal runs against today's policy");
    let canonical = kaap_core::canonical_policy(&r.policy_json).unwrap();
    assert_eq!(before, &serde_json::from_slice::<serde_json::Value>(&canonical).unwrap());
    assert!(input.history.is_none());
    assert!(input.prices.usd_by_token.is_empty());
    assert!(input.supplied_text.is_none());
    assert_eq!(input.guard_account.as_deref(), Some(GUARD));
}

#[test]
fn kaaps_own_enrol_call_reads_as_guard_enrol_like_the_cli() {
    let mut r = read("function-call.json");
    let call = |receiver: &str| {
        let args = "e30="; // {}
        format!(r#"{{"FunctionCall":{{"receiver_id":"{receiver}","actions":[{{"method_name":"enroll","args":"{args}","deposit":"10000000000000000000000","gas":"10000000000000"}}]}}}}"#)
    };
    let asked = asked("r7thmvr8maey.sputnikv2.testnet", 10);

    r.proposal.kind_json = call(GUARD).into_bytes();
    let (_, analysis) = judge(&asked, None, &r);
    assert!(analysis.effects.iter().any(|e| matches!(e, Effect::GuardEnrol { guard, .. } if guard == GUARD)), "{:?}", analysis.effects);
    assert!(!analysis.findings.iter().any(|f| f.code == FindingCode::UnknownCall));

    r.proposal.kind_json = call("not-the-guard.testnet").into_bytes();
    let (_, analysis) = judge(&asked, None, &r);
    assert!(!analysis.effects.iter().any(|e| matches!(e, Effect::GuardEnrol { .. })), "only the guard the run names");
}

#[test]
fn a_proposal_no_longer_in_progress_has_no_policy_before() {
    let mut r = read("transfer-ft.json");
    for status in ["Approved", "Failed", "", "inprogress"] {
        r.proposal.status = status.to_string();
        assert!(proposal_input(&asked("corm1gu.sputnikv2.testnet", 1), None, &r).policy_before.is_none(), "{status:?}");
    }
}

#[test]
fn analyze_runs_on_exactly_that_input() {
    for name in ["transfer-ft.json", "function-call.json", "vote.json"] {
        let fx = fixture(name);
        let r = read(name);
        let (input, analysis) = judge(&asked(fx["dao"].as_str().unwrap(), fx["proposal_id"].as_u64().unwrap()), None, &r);
        assert_eq!(analysis, analyze(&input), "{name}");
        if name == "vote.json" {
            assert_eq!(analysis.risk_floor, Severity::Low, "a Vote proposal moves nothing");
        } else {
            assert_ne!(analysis.risk_floor, Severity::Low, "{name}: nothing here is a priced, known payment");
        }
    }
    let (_, ft) = judge(&asked("corm1gu.sputnikv2.testnet", 1), None, &read("transfer-ft.json"));
    assert!(ft.findings.iter().any(|f| f.code == FindingCode::UnknownValue), "an unpriced token is UNKNOWN_VALUE");
    let (_, call) = judge(&asked("r7thmvr8maey.sputnikv2.testnet", 10), None, &read("function-call.json"));
    assert!(call.findings.iter().any(|f| f.code == FindingCode::UnknownCall));
}
