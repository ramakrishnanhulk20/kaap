// The WO-04 scoreboard: `analyze` on every record a `sign` call or a hash text decides (every
// real record whose kind calls `sign` on v1.signer, planted families i, j and k, and the auth
// control #62), scored on the finding codes and the risk floor, with must_veto, veto_allowed,
// effects and the description check printed beside them. It fails unless codes and floor agree
// on every record. A second test runs four NEAR Business payments read live from mainnet: each
// must be HASH_UNVERIFIED with no veto. Not covered here: severities one by one (the floor
// carries them), the description check's own bars (describe_eval.rs), and any text the key
// does not hold.

mod common;

use common::{census_prices, input_of, read_jsonl, repo_root, PLANTED, REAL};
use kaap_core::*;
use serde_json::Value;

/// Families i (26 to 28), j (29 to 31) and k (32 to 34), and the honest auth control (PLANTED.md).
const PLANTED_HASH: [&str; 10] = [
    "planted:26",
    "planted:27",
    "planted:28",
    "planted:29",
    "planted:30",
    "planted:31",
    "planted:32",
    "planted:33",
    "planted:34",
    "planted:62",
];

fn calls_sign(record: &Value) -> bool {
    let call = &record["kind"]["FunctionCall"];
    call["receiver_id"] == "v1.signer"
        && call["actions"].as_array().is_some_and(|actions| actions.iter().any(|a| a["method_name"] == "sign"))
}

fn name<T: serde::Serialize>(v: &T) -> String {
    match serde_json::to_value(v) {
        Ok(Value::String(s)) => s,
        other => format!("{other:?}"),
    }
}

fn sorted(mut items: Vec<String>) -> Vec<String> {
    items.sort();
    items.dedup();
    items
}

#[test]
fn hash_eval() {
    let prices = census_prices();
    let mut records: Vec<Value> = read_jsonl(&repo_root().join(REAL)).unwrap().into_iter().filter(calls_sign).collect();
    let real = records.len();
    records.extend(
        read_jsonl(&repo_root().join(PLANTED)).unwrap().into_iter().filter(|r| PLANTED_HASH.contains(&r["id"].as_str().unwrap_or(""))),
    );
    assert_eq!(records.len() - real, PLANTED_HASH.len());

    let fields = ["finding_codes", "risk_floor", "must_veto", "veto_allowed", "effects", "description_check"];
    let mut agree = [0usize; 6];
    let mut differing = Vec::new();
    for record in &records {
        let id = record["id"].as_str().unwrap();
        let a = analyze(&input_of(record, &prices).unwrap());
        let label = &record["label"];
        let key_effects: Vec<Effect> = serde_json::from_value(label["effects"].clone()).unwrap();
        let effect_keys = |effects: &[Effect]| sorted(effects.iter().map(|e| serde_json::to_string(e).unwrap()).collect());
        let pairs = [
            (
                sorted(label["findings"].as_array().unwrap().iter().map(|f| f["code"].as_str().unwrap().to_string()).collect()).join(","),
                sorted(a.findings.iter().map(|f| name(&f.code)).collect()).join(","),
            ),
            (label["risk_floor"].as_str().unwrap().to_string(), name(&a.risk_floor)),
            (label["must_veto"].to_string(), a.must_veto.to_string()),
            (label["veto_allowed"].to_string(), a.veto_allowed.to_string()),
            (effect_keys(&key_effects).join("; "), effect_keys(&a.effects).join("; ")),
            (label["description_check"].as_str().unwrap().to_string(), name(&a.description_check)),
        ];
        for (i, (key, kaap)) in pairs.iter().enumerate() {
            if key == kaap {
                agree[i] += 1;
            } else {
                differing.push(format!("- {id} {:<18}\n    key:  {key}\n    kaap: {kaap}", fields[i]));
            }
        }
    }

    let of = records.len();
    println!();
    println!("== WO-04 hash scoreboard: {real} real sign records, {} planted hash records", of - real);
    println!("{:<20} {:>6} {:>6}", "field", "agree", "of");
    for (field, agreed) in fields.iter().zip(agree) {
        println!("{field:<20} {agreed:>6} {of:>6}");
    }
    for line in &differing {
        println!("{line}");
    }
    assert!(real >= 30, "the key holds 32 real sign records");
    assert_eq!((agree[0], agree[1]), (of, of), "finding codes and floor must agree on every hash record");
}

/// NEAR Business payments: `get_proposal` read at final mainnet block 222701869 (hash
/// 55EPfEy3H1qawyMdJj877TVP3cMhkJCXF49uW9YApv9N, 2 Nov 2026 09:41 UTC), kinds kept byte for byte.
/// All four are Approved with the fixed Trezu text; nobody outside the treasury holds the text.
const NEAR_BUSINESS: [(&str, u64, &str); 4] = [
    (
        "kmxv7.sputnik-dao.near",
        13,
        r#"{"FunctionCall":{"receiver_id":"v1.signer","actions":[{"method_name":"sign","args":"eyJyZXF1ZXN0Ijp7InBhdGgiOiJrbXh2Ny5zcHV0bmlrLWRhby5uZWFyIiwicGF5bG9hZF92MiI6eyJFZGRzYSI6IjE4ZTIxYTI0YzVmMWYwNDI4MWI1ZWNjMDg0YjU5NDdiZmM5ZGVlZjhlNTRkYzhkODk2NzEzOTZjZGYzYWE0ZTAifSwiZG9tYWluX2lkIjoxfX0=","deposit":"1","gas":"15000000000000"}]}}"#,
    ),
    (
        "kmxv7.sputnik-dao.near",
        7,
        r#"{"FunctionCall":{"receiver_id":"v1.signer","actions":[{"method_name":"sign","args":"eyJyZXF1ZXN0Ijp7InBhdGgiOiJrbXh2Ny5zcHV0bmlrLWRhby5uZWFyIiwicGF5bG9hZF92MiI6eyJFZGRzYSI6IjQ0ZGYyOTQ0YzcyMzk4ZTcxNDI2ZDQ5MjJkMGRjOWQ4ODE4OTJjY2YzOGI5OWM4OTVlOWNlNDE5YTRiNzJlOGYifSwiZG9tYWluX2lkIjoxfX0=","deposit":"1","gas":"15000000000000"}]}}"#,
    ),
    (
        "q86dw.sputnik-dao.near",
        5,
        r#"{"FunctionCall":{"receiver_id":"v1.signer","actions":[{"method_name":"sign","args":"eyJyZXF1ZXN0Ijp7InBhdGgiOiJxODZkdy5zcHV0bmlrLWRhby5uZWFyIiwicGF5bG9hZF92MiI6eyJFZGRzYSI6IjFkMDI1MDkzNmQyYTVjODhiZjczZGM0OGIyOGRkNmRmNTVlNjdlNDgwZWVkNjhkMTc4NzNmNDYzZjY5YjgxMmMifSwiZG9tYWluX2lkIjoxfX0=","deposit":"1","gas":"15000000000000"}]}}"#,
    ),
    (
        "8rzrd.sputnik-dao.near",
        4,
        r#"{"FunctionCall":{"receiver_id":"v1.signer","actions":[{"method_name":"sign","args":"eyJyZXF1ZXN0Ijp7InBhdGgiOiI4cnpyZC5zcHV0bmlrLWRhby5uZWFyIiwicGF5bG9hZF92MiI6eyJFZGRzYSI6IjgxZWFlOTQ5YzQ4NzgyNGExM2RmZDM3OTA0MDEzYzcyMTY2Nzg2ZTljYTZkNWM1OWU1ZjVmMTdhNWM0MWVkZWIifSwiZG9tYWluX2lkIjoxfX0=","deposit":"1","gas":"15000000000000"}]}}"#,
    ),
];

const TREZU_TEXT: &str =
    "* Proposal Action: confidential <br>* Notes: Confidential proposal via private intents. Details are hidden for privacy.";

#[test]
fn near_business_payments_read_live_are_unverified_and_never_vetoed() {
    for (dao, id, kind) in NEAR_BUSINESS {
        let input = ProposalInput {
            network: Network::Mainnet,
            dao: dao.into(),
            proposal_id: id,
            description: TREZU_TEXT.into(),
            kind_json: kind.as_bytes().to_vec(),
            policy_before: None,
            history: None,
            prices: census_prices(),
            dao_version: None,
            supplied_text: None,
            guard_account: None,
            config_before: None,
            block_timestamp_ns: Some(1_793_612_517_649_371_544),
        };
        let a = analyze(&input);
        let codes: Vec<FindingCode> = a.findings.iter().map(|f| f.code).collect();
        assert_eq!(codes, vec![FindingCode::HashUnverified], "{dao} #{id}");
        assert_eq!(a.risk_floor, Severity::High, "{dao} #{id}: UNKNOWN counts as high, never low (C8)");
        assert!(!a.must_veto && !a.veto_allowed, "{dao} #{id}: an unverifiable hash alone never vetoes");
        assert!(matches!(&a.effects[..], [Effect::SignRequest { path, domain_id: 1, text_supplied: false, .. }] if path == dao));
    }
}
