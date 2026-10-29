//! Whole runs of the job on real recorded answers with the test key: the signed verdict and every
//! way to no signature. Not covered here: the OutLayer host, keystore and network (stood in by
//! FastNEAR answers, the RFC 8032 test key and recorded answers; the testnet runs in `RUNS.md`
//! cover them), and live NEAR AI answers, which need Ram's key.

mod common;

use common::*;
use kaap_core::{AiStatus, Network, Severity};
use kaap_sealed::fixture::FixtureHttp;
use kaap_sealed::job::{run, Connections};
use kaap_sealed::net::{Deadline, Response, DRPC_TESTNET, HOST_STAND_IN_TESTNET, PUBLISHED_ENDPOINTS};
use kaap_sealed::rpc::RpcProvider;
use serde_json::Value;

fn input(dao: &str, id: u64, extra: &str) -> String {
    format!(r#"{{"v":1,"network":"testnet","guard":"guard.kaap.testnet","dao":"{dao}","proposal_id":{id},"expires_in_ms":600000{extra}}}"#)
}

fn connections(fx: &Value, ai: Scripted) -> impl FnOnce(Network, Deadline) -> Connections {
    let text = fx.to_string();
    move |network, deadline| {
        assert_eq!(network, Network::Testnet);
        Connections {
            host: Box::new(RpcProvider::new(FixtureHttp::from_json(&text).unwrap(), HOST_STAND_IN_TESTNET, deadline)),
            https: Box::new(RpcProvider::new(FixtureHttp::from_json(&text).unwrap(), DRPC_TESTNET, deadline)),
            ai: Box::new(ai),
            signer: Box::new(TestSigner::new()),
        }
    }
}

fn no_ai() -> Scripted {
    Scripted(Vec::new(), Vec::new())
}

#[test]
fn a_real_proposal_gives_a_signed_verdict_pinned_to_its_block() {
    let fx = fixture("transfer-ft.json");
    let out = run(input("corm1gu.sputnikv2.testnet", 1, "").as_bytes(), Some("testnet"), None, connections(&fx, no_ai()));
    let (v, json) = open(&out);
    assert_eq!(v.version, 1);
    assert_eq!((v.guard.as_str(), v.network, v.dao.as_str(), v.proposal_id), ("guard.kaap.testnet", Network::Testnet, "corm1gu.sputnikv2.testnet", 1));
    assert_eq!(v.block_height, fx["block_height"].as_u64().unwrap());

    let proposal: Value = serde_json::from_str(&view_text(&fx, HTTPS, "get_proposal")).unwrap();
    assert_eq!(v.kind_hash, kaap_core::kind_hash(proposal["kind"].to_string().as_bytes()).unwrap());
    assert_eq!(v.policy_hash, kaap_core::policy_hash(view_text(&fx, HTTPS, "get_policy").as_bytes()).unwrap());
    let mut pairs = Vec::new();
    for account in ["corm1gu.sputnikv2.testnet", "nori4qx.tanssg2.testnet"] {
        let mut f = fx.clone();
        let body: Value = serde_json::from_str(exchange(&mut f, HTTPS, account)["body"].as_str().unwrap()).unwrap();
        pairs.push((account.to_string(), body["result"]["code_hash"].as_str().unwrap().to_string()));
    }
    assert_eq!(v.receivers_hash, kaap_sealed::reads::receivers_hash(&pairs));

    let mut f = fx.clone();
    let block: Value = serde_json::from_str(exchange(&mut f, HTTPS, "block")["body"].as_str().unwrap()).unwrap();
    let ts_ms = block["result"]["header"]["timestamp_nanosec"].as_str().unwrap().parse::<u64>().unwrap() / 1_000_000;
    assert_eq!(v.expires_at_ms, ts_ms + 600_000);

    assert_eq!(v.ai_status, AiStatus::Unavailable);
    assert_eq!(v.model_id, "");
    assert_eq!(json["explanation"], "AI unavailable: no NEAR AI key is set for this project yet.");
    assert_eq!(v.floor, Severity::High, "an unpriced token is UNKNOWN_VALUE");
    assert_eq!(v.risk, v.floor);
    assert!(v.findings.contains(&kaap_core::FindingCode::UnknownValue));
    assert_eq!(v.decoder_version, "0.1.0");
}

#[test]
fn every_fixture_runs_to_a_verdict_under_the_cap() {
    for name in ["transfer-ft.json", "function-call.json", "vote.json"] {
        let fx = fixture(name);
        let dao = fx["dao"].as_str().unwrap().to_string();
        let id = fx["proposal_id"].as_u64().unwrap();
        let out = run(input(&dao, id, "").as_bytes(), Some("testnet"), None, connections(&fx, no_ai()));
        open(&out);
    }
}

#[test]
fn the_test_flag_makes_the_providers_disagree_and_nothing_is_signed() {
    let fx = fixture("transfer-ft.json");
    let out = run(input("corm1gu.sputnikv2.testnet", 1, r#","test_corrupt_https":true"#).as_bytes(), Some("testnet"), None, connections(&fx, no_ai()));
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v, serde_json::json!({ "v": 1, "status": "held", "reason": "providers disagree: get_proposal" }));
}

#[test]
fn a_refused_input_makes_no_outside_call() {
    let out = run(br#"{"v":1}"#, Some("testnet"), None, |_, _| panic!("connected for a refused input"));
    assert_eq!(serde_json::from_str::<Value>(&out).unwrap()["status"], "refused");
    let out = run(input("corm1gu.sputnikv2.testnet", 1, "").as_bytes(), Some("mainnet"), None, |_, _| panic!("connected"));
    assert_eq!(serde_json::from_str::<Value>(&out).unwrap()["reason"], "network is not the network this run is on");
}

#[test]
fn an_unverified_ai_answer_raises_to_high_at_most_and_the_key_never_shows() {
    let key = "sk-secret-key-7f3a";
    let list = std::fs::read(fixtures_dir().join("model-list-2026-10-29.json")).unwrap();
    let answer = |risk: &str| {
        let content = format!(r#"{{"risk":"{risk}","explanation":"The token transfer goes to a DAO account the text calls subscription."}}"#);
        serde_json::json!({
            "id": "c", "object": "chat.completion", "created": 1, "model": kaap_sealed::ai::MODEL_ID,
            "choices": [{ "index": 0, "finish_reason": "stop", "message": { "role": "assistant", "content": content } }],
            "usage": { "prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2 },
        })
        .to_string()
        .into_bytes()
    };
    let fx = fixture("vote.json");
    for (said, want) in [("critical", Severity::High), ("low", Severity::High), ("high", Severity::High)] {
        let ai = Scripted(vec![Response { status: 200, body: list.clone() }, Response { status: 200, body: answer(said) }], Vec::new());
        let out = run(input("r7thmvr8maey.sputnikv2.testnet", 11, "").as_bytes(), Some("testnet"), Some(key), connections(&fx, ai));
        assert!(!out.contains(key), "the NEAR AI key is never printed");
        let (v, json) = open(&out);
        assert_eq!(v.ai_status, AiStatus::Unverified);
        assert_eq!(v.model_id, kaap_sealed::ai::MODEL_ID);
        assert_eq!(v.risk, want, "AI said {said} on a high floor");
        assert!(json["explanation"].as_str().unwrap().starts_with("The token transfer"));
    }
    let ai = Scripted(vec![Response { status: 200, body: list }, Response { status: 200, body: b"{}".to_vec() }], Vec::new());
    let (v, json) = open(&run(input("r7thmvr8maey.sputnikv2.testnet", 11, "").as_bytes(), Some("testnet"), Some(key), connections(&fx, ai)));
    assert_eq!((v.ai_status, v.model_id.as_str()), (AiStatus::Unavailable, ""));
    assert_eq!(json["explanation"], "AI unavailable: the NEAR AI response could not be read.");
}

#[test]
fn the_code_calls_no_host_outside_the_manifest() {
    let manifest: Value = serde_json::from_str(include_str!("../manifest.json")).unwrap();
    let hosts: Vec<&str> = manifest["capabilities"]["network"].as_array().unwrap().iter().map(|h| h.as_str().unwrap()).collect();
    for endpoint in PUBLISHED_ENDPOINTS {
        assert!(hosts.contains(&endpoint.authority), "{} is called but not in the manifest", endpoint.authority);
    }
    assert_eq!(manifest["signing_keys"], serde_json::json!([{ "path": "verdict", "type": "ed25519" }]));
    assert_eq!(manifest["encryption_keys"], serde_json::json!([{ "path": "texts" }]));
}
