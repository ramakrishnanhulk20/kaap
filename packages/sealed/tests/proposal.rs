//! Building kaap-core's input from the agreed read and running `analyze` on it. Not covered
//! here: whether kaap-core decodes correctly (its own tests and the evaluation set cover that),
//! and prices and payment history, which this job does not read yet.

mod common;

use common::*;
use kaap_core::{analyze, FindingCode, Network, Severity};
use kaap_sealed::net::Deadline;
use kaap_sealed::proposal::{judge, proposal_input};
use kaap_sealed::reads::{read_chain, ChainRead};

fn read(name: &str) -> ChainRead {
    let fx = fixture(name);
    let (mut host, mut https) = providers(&fx);
    read_chain(&mut host, &mut https, fx["dao"].as_str().unwrap(), fx["proposal_id"].as_u64().unwrap(), Deadline::after_ms(60_000), 0)
        .unwrap()
}

#[test]
fn the_input_is_the_agreed_read() {
    let r = read("transfer-ft.json");
    let input = proposal_input(Network::Testnet, "corm1gu.sputnikv2.testnet", 1, &r);
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
}

#[test]
fn a_proposal_no_longer_in_progress_has_no_policy_before() {
    let mut r = read("transfer-ft.json");
    for status in ["Approved", "Failed", "", "inprogress"] {
        r.proposal.status = status.to_string();
        assert!(proposal_input(Network::Testnet, "corm1gu.sputnikv2.testnet", 1, &r).policy_before.is_none(), "{status:?}");
    }
}

#[test]
fn analyze_runs_on_exactly_that_input() {
    for name in ["transfer-ft.json", "function-call.json", "vote.json"] {
        let fx = fixture(name);
        let r = read(name);
        let (input, analysis) = judge(Network::Testnet, fx["dao"].as_str().unwrap(), fx["proposal_id"].as_u64().unwrap(), &r);
        assert_eq!(analysis, analyze(&input), "{name}");
        assert_ne!(analysis.risk_floor, Severity::Low, "{name}: nothing here is a priced, known payment");
    }
    let (_, ft) = judge(Network::Testnet, "corm1gu.sputnikv2.testnet", 1, &read("transfer-ft.json"));
    assert!(ft.findings.iter().any(|f| f.code == FindingCode::UnknownValue), "an unpriced token is UNKNOWN_VALUE");
    let (_, call) = judge(Network::Testnet, "r7thmvr8maey.sputnikv2.testnet", 10, &read("function-call.json"));
    assert!(call.findings.iter().any(|f| f.code == FindingCode::UnknownCall));
}
