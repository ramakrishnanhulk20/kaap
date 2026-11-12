// Pins the JavaScript-facing functions to kaap-core itself: `analyze` through its JSON input gives
// kaap-core's own answer on every answer-key record once prices that come with no payment history
// are left out, which is the one rule the door adds, `read_proposal` keeps the kind's exact text
// and refuses a duplicate key, the scoreboards give today's numbers, the enrolment template is
// generated from Sputnik's label list and arms the guard on the NEAR Business role setup,
// `who_acts` names who files and approves on that setup, `eval_input` hands the sealed job's eval
// mode the scoreboards' own input, and its trimmed form changes only the prices. It does not run
// the wasm build (the CLI tests do), and it does not cover the hash, verdict or arming exports
// beyond what kaap-core's own tests already prove of the functions they call.

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
        // uses and no prices where there is no history, so any other difference is the wrapper's.
        let priced = history.is_some();
        let direct = analyze(&ProposalInput {
            network: serde_json::from_value(record["network"].clone()).unwrap(),
            dao: record["dao"].as_str().unwrap().into(),
            proposal_id,
            description: record["description"].as_str().unwrap().into(),
            kind_json: kind.into_bytes(),
            policy_before: policy.map(|p| serde_json::from_slice(&kaap_core::canonical_policy(p.as_bytes()).unwrap()).unwrap()),
            history: history.map(|h| serde_json::from_value(h).unwrap()),
            prices: if priced { Prices { usd_by_token: prices.usd_by_token.clone() } } else { Prices::default() },
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

/// A priced USDT payment to a stranger through the door, with and without a payment history.
fn priced_payment(history: Option<Value>) -> (Value, ProposalInput) {
    let tokens = std::fs::read_to_string(repo().join("packages/core/tests/fixtures/tokens.json")).unwrap();
    let prices = api::prices_from_tokens(&tokens).unwrap();
    assert!(prices.usd_by_token.contains_key("usdt.tether-token.near"));
    let kind = r#"{"Transfer": {"token_id": "usdt.tether-token.near", "receiver_id": "stranger.near", "amount": "1000000000000", "msg": null}}"#;
    let description = "Pay 1000000 USDT to stranger.near";
    let input = json!({
        "network": "mainnet", "dao": "family-bank.sputnik-dao.near", "proposal_id": 7,
        "description": description, "kind_json": kind, "history": history, "prices": prices,
    });
    let out: Value = serde_json::from_str(&api::analyze(&input.to_string()).unwrap()).unwrap();
    let direct = ProposalInput {
        network: kaap_core::Network::Mainnet,
        dao: "family-bank.sputnik-dao.near".into(),
        proposal_id: 7,
        description: description.into(),
        kind_json: kind.as_bytes().to_vec(),
        policy_before: None,
        history: history.map(|h| serde_json::from_value(h).unwrap()),
        prices,
        dao_version: None,
        supplied_text: None,
        guard_account: None,
        config_before: None,
        block_timestamp_ns: None,
    };
    (out["analysis"].clone(), direct)
}

#[test]
fn a_priced_payment_with_no_history_keeps_its_unknown_value() {
    let (analysis, direct) = priced_payment(None);
    assert_eq!(analysis["risk_floor"], "high", "{analysis}");
    assert!(analysis["findings"].as_array().unwrap().iter().any(|f| f["code"] == "UNKNOWN_VALUE"), "{analysis}");
    assert_eq!(analyze(&direct).risk_floor, kaap_core::Severity::Low, "kaap-core alone, handed the price, reads it low");
}

#[test]
fn a_priced_payment_with_a_history_is_judged_as_kaap_core_judges_it() {
    let history = json!({ "approved_payments_before": 3, "median_payment_usd_before": 2000000.0, "recipients_paid_before": ["stranger.near"] });
    let (analysis, direct) = priced_payment(Some(history));
    assert_eq!(analysis, serde_json::to_value(analyze(&direct)).unwrap());
    assert_eq!(analysis["risk_floor"], "low", "{analysis}");
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
    // planted #44 and #46 rest on instruction words alone, which no longer cause a veto (decided
    // 12 Nov 2026): each was critical with must_veto before and is high without it after; the
    // label says critical with must_veto (engine-stricter-than-key.md).
    assert_eq!((pick("describe", 1), pick("describe", 2), pick("describe", 3)), ((373, 373), (373, 373), (335, 337)));
    // Five Burrow calls that can pay an account other than the DAO are unknown calls, high, where
    // answer key v2.3 says `defi_call`, low (packages/core/docs/answer-key-notes/
    // engine-stricter-than-key.md): burrow #1395, #1399 and #1465 (add_asset_farm_reward) and
    // #1499 and #1634 (update_asset naming a beneficiary). Each was low with no finding before
    // and is high with UNKNOWN_CALL and veto_allowed after; the label says low.
    assert_eq!((pick("value", 0), pick("value", 2), pick("value", 3)), ((200, 205), (200, 205), (142, 147)));
    assert!((0..5).all(|i| pick("hash", i) == (42, 42)), "codes, floor, veto fields and effects: {:?}", rows("hash"));
}

#[test]
fn eval_input_is_what_the_scoreboards_judge() {
    let tokens = std::fs::read_to_string(repo().join("packages/core/tests/fixtures/tokens.json")).unwrap();
    let prices = api::prices_from_tokens(&tokens).unwrap();
    let lines: Vec<String> = ["eval/real/labels.jsonl", "eval/planted/labels.jsonl"]
        .iter()
        .flat_map(|f| std::fs::read_to_string(repo().join(f)).unwrap().lines().map(str::to_string).collect::<Vec<_>>())
        .collect();
    // A payment with a history, a full policy change with the policy before, and a supplied text.
    for id in ["mainnet:aurora-dao-bvi.sputnik-dao.near:548", "mainnet:adam.sputnik-dao.near:6", "planted:32"] {
        let line = lines.iter().find(|l| serde_json::from_str::<Value>(l).unwrap()["id"] == id).unwrap();
        let out = eval::eval_input(line, &tokens).unwrap();
        let judged = eval::input_of(&serde_json::from_str(line).unwrap(), &prices).unwrap();
        assert_eq!(out, serde_json::to_string(&judged).unwrap(), "{id}");
        let read: ProposalInput = serde_json::from_str(&out).unwrap();
        assert_eq!(read, judged, "{id}");
        assert_eq!(analyze(&read), analyze(&judged), "{id}");
    }
    assert!(eval::eval_input("not json", &tokens).is_err());
}

#[test]
fn a_trimmed_price_table_is_judged_exactly_as_the_full_one() {
    let tokens = std::fs::read_to_string(repo().join("packages/core/tests/fixtures/tokens.json")).unwrap();
    let prices = api::prices_from_tokens(&tokens).unwrap();
    let mut trimmed_any = 0;
    for line in ["eval/real/labels.jsonl", "eval/planted/labels.jsonl"].iter().flat_map(|f| std::fs::read_to_string(repo().join(f)).unwrap().lines().map(str::to_string).collect::<Vec<_>>()) {
        let full = eval::input_of(&serde_json::from_str(&line).unwrap(), &prices).unwrap();
        let Ok(out) = eval::eval_input_trimmed(&line, &tokens) else { continue };
        let cut: ProposalInput = serde_json::from_str(&out).unwrap();
        assert_eq!(analyze(&cut), analyze(&full));
        assert_eq!(ProposalInput { prices: full.prices.clone(), ..cut.clone() }, full, "only the prices differ");
        assert!(cut.prices.usd_by_token.keys().all(|k| full.prices.usd_by_token.contains_key(k)));
        assert!(out.len() < eval::eval_input(&line, &tokens).unwrap().len());
        trimmed_any += 1;
    }
    assert!(trimmed_any > 300, "{trimmed_any}");
}

/// The NEAR Business role setup (deployments/near-business-policy.json) with one account in every
/// member place, the shape 18 of the 22 new NEAR Business treasuries had on 24 Oct.
fn near_business(member: &str) -> Value {
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(repo().join("deployments/near-business-policy.json")).unwrap()).unwrap();
    let mut policy = saved["policy"].clone();
    for role in policy["roles"].as_array_mut().unwrap() {
        role["kind"]["Group"] = json!([member]);
    }
    policy
}

#[test]
fn the_enrolment_template_covers_every_sputnik_label_and_arms_the_guard() {
    use kaap_core::policy::sputnik::LABELS;
    let guard = "kaap-guard-1029061211.testnet";
    let t: Value = serde_json::from_str(&api::enrolment_drafts(guard).unwrap()).unwrap();
    let labels: Vec<&str> = t["labels"].as_array().unwrap().iter().map(|l| l.as_str().unwrap()).collect();
    assert_eq!(t["left_out"], json!([api::OWN_REMOVAL]));
    assert_eq!(labels.len() + 1, LABELS.len(), "every label but the guard's own removal");
    assert!(LABELS.iter().all(|l| labels.contains(l) || *l == api::OWN_REMOVAL), "a Sputnik label is missing from the template");
    let role = &t["drafts"][0]["kind"]["ChangePolicyAddOrUpdateRole"]["role"];
    assert_eq!(role["kind"], json!({ "Group": [guard] }), "the role is added with the guard already in it");
    assert_eq!(t["drafts"][1]["kind"]["FunctionCall"]["actions"][0]["method_name"], "enroll");
    assert!(api::enrolment_drafts("Not An Account").is_err());

    let mut policy = near_business("owner.testnet");
    policy["roles"].as_array_mut().unwrap().push(role.clone());
    let a: Value = serde_json::from_str(&api::guard_arming(&policy.to_string(), guard).unwrap()).unwrap();
    assert_eq!(a["rejects_alone"], json!(labels));
    assert_eq!(a["cannot_reject"], json!([api::OWN_REMOVAL]));
    assert_eq!(a["extra_rights"], json!([]));
}

#[test]
fn who_acts_follows_the_near_business_roles() {
    let policy = near_business("owner.testnet").to_string();
    let read = |label: &str| -> Value { serde_json::from_str(&api::who_acts(&policy, label).unwrap()).unwrap() };
    let role_add = read("policy_add_or_update_role");
    assert_eq!(role_add["add_proposal"]["accounts"], json!([{ "account": "owner.testnet", "roles": ["Admin"] }]));
    assert_eq!(role_add["vote_approve"]["accounts"], json!([{ "account": "owner.testnet", "roles": ["Admin"] }]));
    let call = read("call");
    assert_eq!(call["add_proposal"]["accounts"], json!([{ "account": "owner.testnet", "roles": ["Requestor"] }]), "Admin may not file a function call");
    assert_eq!(call["vote_approve"]["accounts"], json!([{ "account": "owner.testnet", "roles": ["Approver"] }]));
    for side in ["add_proposal", "vote_approve"] {
        assert_eq!(call[side]["anyone"], json!([]));
        assert_eq!(call[side]["token_roles"], json!([]));
    }
    assert!(api::who_acts(&policy, "transfers").is_err());
    assert!(api::who_acts("{}", "call").is_err());
}
