// Pins the JavaScript-facing functions to kaap-core itself: `analyze` through its JSON input gives
// kaap-core's own answer on every answer-key record, `read_proposal` keeps the kind's exact text
// and refuses a duplicate key, and the scoreboards give today's numbers. It does not run the wasm
// build (the CLI tests do), and it does not cover the hash, verdict or arming exports beyond
// what kaap-core's own tests already prove of the functions they call.

use std::path::{Path, PathBuf};

use kaap_core::{analyze, Prices, ProposalInput};
use kaap_core_wasm::{api, eval};
use serde_json::{json, Value};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

fn records() -> Vec<Value> {
    ["eval/real/labels.jsonl", "eval/planted/labels.jsonl"]
        .iter()
        .flat_map(|f| std::fs::read_to_string(repo().join(f)).unwrap().lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str(l).unwrap()).collect::<Vec<Value>>())
        .collect()
}

#[test]
fn analyze_through_json_matches_kaap_core_on_every_record() {
    let prices = api::prices_from_tokens(&std::fs::read_to_string(repo().join("packages/core/tests/fixtures/tokens.json")).unwrap()).unwrap();
    let records = records();
    assert_eq!(records.len(), 373);
    let mut checked = 0;
    for record in records.iter().filter(|r| r.get("supplied_text").is_none_or(Value::is_null)) {
        let context = &record["context"];
        let kind = serde_json::to_string(&record["kind"]).unwrap();
        let policy = (!context["policy_before"].is_null()).then(|| serde_json::to_string(&context["policy_before"]).unwrap());
        let history = (context["history_available"] == true).then(|| context["history"].clone());
        let proposal_id = record["proposal_id"].as_u64().unwrap_or_else(|| record["id"].as_str().unwrap().rsplit(':').next().unwrap().parse().unwrap());
        let input = json!({
            "network": record["network"], "dao": record["dao"], "proposal_id": proposal_id,
            "description": record["description"], "kind_json": kind, "policy_before_json": policy,
            "history": history, "prices": prices, "dao_version": context["dao_version"],
        });
        let out: Value = serde_json::from_str(&api::analyze(&input.to_string()).unwrap()).unwrap();

        // kaap-core directly, with the policy read through the same canonical parser the sealed job
        // uses, so any difference is the wrapper's.
        let direct = analyze(&ProposalInput {
            network: serde_json::from_value(record["network"].clone()).unwrap(),
            dao: record["dao"].as_str().unwrap().into(),
            proposal_id,
            description: record["description"].as_str().unwrap().into(),
            kind_json: kind.into_bytes(),
            policy_before: policy.map(|p| serde_json::from_slice(&kaap_core::canonical_policy(p.as_bytes()).unwrap()).unwrap()),
            history: history.map(|h| serde_json::from_value(h).unwrap()),
            prices: Prices { usd_by_token: prices.usd_by_token.clone() },
            dao_version: context["dao_version"].as_str().map(str::to_string),
            supplied_text: None,
            guard_account: None,
            config_before: None,
            block_timestamp_ns: None,
        });
        assert_eq!(out["analysis"], serde_json::to_value(&direct).unwrap(), "{}", record["id"]);
        checked += 1;
    }
    assert!(checked > 300, "{checked}");
}

#[test]
fn read_proposal_keeps_the_kind_bytes_and_refuses_a_duplicate_key() {
    let kind = r#"{"Transfer": {"token_id":"","receiver_id":"a.near","amount":"1","msg":null}}"#;
    let answer = format!(r#"{{"id":7,"proposer":"p.near","description":"d","kind":{kind},"status":"Approved","submission_time":"1700000000000000000"}}"#);
    let out: Value = serde_json::from_str(&api::read_proposal(&answer).unwrap()).unwrap();
    assert_eq!(out["kind_json"], kind, "the kind text is kept byte for byte, spaces included");
    assert_eq!(out["submission_time"], "1700000000000000000");
    let twice = format!(r#"{{"id":7,"description":"d","kind":{kind},"description":"e"}}"#);
    assert!(api::read_proposal(&twice).is_err());
}

#[test]
fn the_scoreboards_give_todays_numbers() {
    let out: Value = serde_json::from_str(&eval::scoreboards_from(&repo()).unwrap()).unwrap();
    let rows = |name: &str| -> Vec<(String, u64, u64)> {
        let board = out["boards"].as_array().unwrap().iter().find(|b| b["name"] == name).unwrap();
        board["rows"].as_array().unwrap().iter().map(|r| (r["measure"].as_str().unwrap().to_string(), r["agree"].as_u64().unwrap(), r["of"].as_u64().unwrap())).collect()
    };
    for (name, rows) in ["all", "value", "policy", "describe", "hash"].map(|n| (n, rows(n))) {
        println!("{name}: {rows:?}");
    }
    let pick = |name: &str, i: usize| {
        let r = &rows(name)[i];
        (r.1, r.2)
    };
    assert_eq!(pick("policy", 0), (129, 129));
    assert_eq!((pick("policy", 1), pick("policy", 2), pick("policy", 3)), ((97, 97), (97, 97), (97, 97)));
    assert_eq!(pick("describe", 0), (356, 373));
    assert_eq!((pick("describe", 1), pick("describe", 2), pick("describe", 3)), ((373, 373), (373, 373), (337, 337)));
    assert_eq!((pick("value", 0), pick("value", 2), pick("value", 3)), ((205, 205), (205, 205), (147, 147)));
    assert!((0..5).all(|i| pick("hash", i) == (42, 42)), "codes, floor, veto fields and effects: {:?}", rows("hash"));
}
