//! Whole runs of the job on real recorded answers with the test key: the signed verdict, the
//! evidence published beside it, and every way to no signature. Not covered here: the OutLayer
//! host, keystore, storage and network (stood in by FastNEAR answers, the RFC 8032 test key, a
//! stand-in store and recorded answers; the testnet runs in `RUNS.md` cover them), and live NEAR
//! AI answers, which need Ram's key.

mod common;

use common::*;
use kaap_core::{AiStatus, Network, Severity};
use kaap_sealed::fixture::FixtureHttp;
use kaap_sealed::job::{run, Connections};
use kaap_sealed::net::{Deadline, Http, Response, DRPC_TESTNET, HOST_STAND_IN_TESTNET, PUBLISHED_ENDPOINTS};
use kaap_sealed::rpc::RpcProvider;
use serde_json::Value;

fn input(dao: &str, id: u64, extra: &str) -> String {
    format!(r#"{{"v":1,"network":"testnet","guard":"guard.kaap.testnet","dao":"{dao}","proposal_id":{id},"expires_in_ms":600000{extra}}}"#)
}

fn connections(fx: &Value, ai: impl Http + 'static, store: &Store) -> impl FnOnce(Network, Deadline) -> Connections {
    let text = fx.to_string();
    let store = store.clone();
    move |network, deadline| {
        assert_eq!(network, Network::Testnet);
        Connections {
            host: Box::new(RpcProvider::new(FixtureHttp::from_json(&text).unwrap(), HOST_STAND_IN_TESTNET, deadline)),
            https: Box::new(RpcProvider::new(FixtureHttp::from_json(&text).unwrap(), DRPC_TESTNET, deadline)),
            ai: Box::new(ai),
            signer: Box::new(TestSigner::new()),
            texts: Box::new(TestTexts::new()),
            nonce: Some([0; 32]),
            block_timestamp: None,
            quote: kaap_sealed::attest::tdx::check_quote,
            evidence: Box::new(store),
        }
    }
}

fn no_ai() -> Scripted {
    Scripted(Vec::new(), Vec::new())
}

/// The one record the run published, checked to sit under the hash of the verdict it printed.
fn published(store: &Store, out: &str) -> Value {
    let (verdict, _) = open(out);
    let records = store.records.borrow();
    assert_eq!(records.len(), 1, "one record per verdict");
    let key = kaap_sealed::attest::evidence::key_for(&kaap_core::verdict_hash(&verdict));
    assert_eq!(records[0].0, key);
    serde_json::from_slice(&records[0].1).unwrap()
}

#[test]
fn a_real_proposal_gives_a_signed_verdict_pinned_to_its_block() {
    let fx = fixture("transfer-ft.json");
    let store = Store::default();
    let out = run(input("corm1gu.sputnikv2.testnet", 1, "").as_bytes(), Some("testnet"), None, connections(&fx, no_ai(), &store));
    let (v, json) = open(&out);
    let record = published(&store, &out);
    assert_eq!((record["ai_status"].as_str(), record["reason"].as_str()), (Some("unavailable"), Some("ai_key_missing")));
    assert!(record.get("model_quotes").is_none() && record.get("verify_link").is_none(), "no AI, no AI evidence");
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
    assert_eq!(v.receivers_hash, kaap_core::receipt::receivers_hash(&pairs));

    let mut f = fx.clone();
    let block: Value = serde_json::from_str(exchange(&mut f, HTTPS, "block")["body"].as_str().unwrap()).unwrap();
    let ts_ms = block["result"]["header"]["timestamp_nanosec"].as_str().unwrap().parse::<u64>().unwrap() / 1_000_000;
    assert_eq!(v.expires_at_ms, ts_ms + 600_000);

    assert_eq!(v.ai_status, AiStatus::Unavailable);
    assert_eq!(v.model_id, "");
    assert_eq!(json["explanation"], "AI unavailable (ai_key_missing): no NEAR AI key reached this run.");
    assert_eq!(v.floor, Severity::High, "an unpriced token is UNKNOWN_VALUE");
    assert_eq!(v.risk, v.floor);
    assert!(v.findings.contains(&kaap_core::FindingCode::UnknownValue));
    assert_eq!(v.decoder_version, kaap_core::receipt::DECODER_VERSION);
    assert_eq!(v.decoder_version, "0.1.0");
}

#[test]
fn everything_the_job_prints_or_stores_has_its_keys_in_order() {
    // Whole bytes, not parsed values: a parser hides the order this checks.
    let in_order = |text: &str| {
        let value: Value = serde_json::from_str(text).unwrap();
        let mut sorted = value.clone();
        sorted.sort_all_objects();
        assert_eq!(text, sorted.to_string(), "keys out of order");
    };
    let store = Store::default();
    let out = run(input("corm1gu.sputnikv2.testnet", 1, "").as_bytes(), Some("testnet"), None, connections(&fixture("transfer-ft.json"), no_ai(), &store));
    in_order(&out);
    assert!(out.starts_with(r#"{"explanation":"#), "{out}");
    in_order(std::str::from_utf8(&store.records.borrow()[0].1).unwrap());
    in_order(&run(br#"{"v":1}"#, Some("testnet"), None, |_, _| panic!("connected")));
    in_order(&kaap_sealed::output::held("a reason"));
    in_order(&kaap_sealed::output::failed("a reason"));
}

#[test]
fn a_public_run_never_touches_the_text_key() {
    let texts = TestTexts::new();
    let asked = texts.asked.clone();
    let fx = fixture("transfer-ft.json");
    let plain = connections(&fx, no_ai(), &Store::default());
    open(&run(input("corm1gu.sputnikv2.testnet", 1, "").as_bytes(), Some("testnet"), None, move |network, deadline| {
        Connections { texts: Box::new(texts), ..plain(network, deadline) }
    }));
    assert!(asked.borrow().is_empty());
}

#[test]
fn every_fixture_runs_to_a_verdict_under_the_cap() {
    for name in ["transfer-ft.json", "function-call.json", "vote.json"] {
        let fx = fixture(name);
        let dao = fx["dao"].as_str().unwrap().to_string();
        let id = fx["proposal_id"].as_u64().unwrap();
        let out = run(input(&dao, id, "").as_bytes(), Some("testnet"), None, connections(&fx, no_ai(), &Store::default()));
        open(&out);
    }
}

#[test]
fn the_test_flag_makes_the_providers_disagree_and_nothing_is_signed() {
    let fx = fixture("transfer-ft.json");
    let out = run(input("corm1gu.sputnikv2.testnet", 1, r#","test_corrupt_https":true"#).as_bytes(), Some("testnet"), None, connections(&fx, no_ai(), &Store::default()));
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
fn a_run_without_its_ai_key_says_ai_key_missing_and_calls_no_ai_host() {
    struct NoCall;
    impl Http for NoCall {
        fn send(&mut self, r: &kaap_sealed::net::Request<'_>) -> Result<Response, kaap_sealed::net::HttpFail> {
            panic!("{}{} was asked without a key", r.endpoint.authority, r.endpoint.path)
        }
    }
    let fx = fixture("function-call.json");
    for key in [None, Some("")] {
        let store = Store::default();
        let out = run(input("r7thmvr8maey.sputnikv2.testnet", 10, "").as_bytes(), Some("testnet"), key, connections(&fx, NoCall, &store));
        let (v, json) = open(&out);
        assert_eq!((v.ai_status, v.model_id.as_str(), v.risk), (AiStatus::Unavailable, "", Severity::High), "{key:?}");
        assert_eq!(json["explanation"], "AI unavailable (ai_key_missing): no NEAR AI key reached this run.");
        let record = published(&store, &out);
        assert_eq!((record["ai_status"].as_str(), record["reason"].as_str()), (Some("unavailable"), Some("ai_key_missing")));
    }
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
    // An unknown call keeps a high floor; a Vote proposal has moved nothing since WO-03b, so its floor is low.
    let fx = fixture("function-call.json");
    // No NEAR_BLOCK_TIMESTAMP here, so no check can run: the answer counts, unverified.
    for (said, want) in [("critical", Severity::High), ("low", Severity::High), ("high", Severity::High)] {
        let ai = Scripted(vec![Response::new(200, list.clone()), Response::new(200, answer(said))], Vec::new());
        let store = Store::default();
        let out = run(input("r7thmvr8maey.sputnikv2.testnet", 10, "").as_bytes(), Some("testnet"), Some(key), connections(&fx, ai, &store));
        assert!(!out.contains(key), "the NEAR AI key is never printed");
        let (v, json) = open(&out);
        assert_eq!(v.ai_status, AiStatus::Unverified);
        assert_eq!(v.model_id, kaap_sealed::ai::MODEL_ID);
        assert_eq!(v.risk, want, "AI said {said} on a high floor");
        assert_eq!(
            json["explanation"].as_str().unwrap(),
            "AI unverified (the run had no trusted clock). The token transfer goes to a DAO account the text calls subscription."
        );
        let record = published(&store, &out);
        assert_eq!((record["ai_status"].as_str(), record["reason"].as_str()), (Some("unverified"), Some("no_clock")));
        assert_eq!(record["completion"]["completion_tokens"], 1);
        assert!(!String::from_utf8(store.records.borrow()[0].1.clone()).unwrap().contains(key), "nor stored");
    }
    let ai = Scripted(vec![Response::new(200, list), Response::new(200, b"{}".to_vec())], Vec::new());
    let (v, json) = open(&run(input("r7thmvr8maey.sputnikv2.testnet", 10, "").as_bytes(), Some("testnet"), Some(key), connections(&fx, ai, &Store::default())));
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
    for host in &hosts {
        assert!(PUBLISHED_ENDPOINTS.iter().any(|e| e.authority == *host), "{host} is in the manifest but never called");
    }
    assert_eq!(manifest["signing_keys"], serde_json::json!([{ "path": "verdict", "type": "ed25519" }]));
    assert_eq!(manifest["encryption_keys"], serde_json::json!([{ "path": "texts" }]));
}
