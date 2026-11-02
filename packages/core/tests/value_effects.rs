// Each value effect type of guide section 3, read from named answer-key records and checked
// against the label (the free-text `summary` aside). It does not cover the findings
// (value_findings.rs), random or hostile kinds (value_props.rs), agreement with the whole key
// (value_eval.rs), or `sign_request`, which `hash::check` owns.

mod common;

use common::{census_prices, input_of, label_effects, record, PLANTED, REAL};
use kaap_core::*;

fn run(file: &str, id: &str) -> (serde_json::Value, Analysis) {
    let r = record(file, id);
    let analysis = analyze(&input_of(&r, &census_prices()).unwrap());
    (r, analysis)
}

/// Effects as sorted text without `summary`, so a multiset compares equal in any order.
fn keys(effects: &[Effect]) -> Vec<String> {
    let mut keys: Vec<String> = effects
        .iter()
        .map(|e| {
            let mut v = serde_json::to_value(e).unwrap();
            v.as_object_mut().unwrap().remove("summary");
            v.to_string()
        })
        .collect();
    keys.sort();
    keys
}

fn matches_label(file: &str, ids: &[&str]) {
    for id in ids {
        let (r, a) = run(file, id);
        assert_eq!(keys(&a.effects), keys(&label_effects(&r)), "{id}");
    }
}

fn msg_kinds(a: &Analysis) -> Vec<MsgKind> {
    a.effects
        .iter()
        .filter_map(|e| match e {
            Effect::TokenCallTransfer { msg_kind, .. } => Some(*msg_kind),
            _ => None,
        })
        .collect()
}

#[test]
fn transfers_from_ft_transfer_and_from_attached_near() {
    matches_label(REAL, &[
        "mainnet:builder-ops.sputnik-dao.near:14",
        "mainnet:npro-admin.sputnik-dao.near:3",
        "mainnet:int-mnt-dao.sputnik-dao.near:18",
        "mainnet:stader-nearx.sputnik-dao.near:113",
    ]);
    matches_label(PLANTED, &["planted:38", "planted:52"]);
}

#[test]
fn token_call_transfer_reads_each_msg_kind() {
    for (file, id, expected) in [
        (REAL, "mainnet:petersalomonsendev.sputnik-dao.near:48", MsgKind::Empty),
        (REAL, "mainnet:mic.sputnik-dao.near:35", MsgKind::IntentsDeposit),
        (PLANTED, "planted:61", MsgKind::IntentsDeposit),
        (PLANTED, "planted:23", MsgKind::IntentsExecute),
        (REAL, "mainnet:dalang-safe.sputnik-dao.near:11", MsgKind::OtherJson),
        (REAL, "mainnet:burrow.sputnik-dao.near:1554", MsgKind::OtherJson),
        (REAL, "mainnet:fgl2.sputnik-dao.near:9", MsgKind::NotJson),
    ] {
        let (r, a) = run(file, id);
        assert_eq!(keys(&a.effects), keys(&label_effects(&r)), "{id}");
        assert!(msg_kinds(&a).iter().all(|k| *k == expected), "{id}: {:?}", msg_kinds(&a));
    }
}

#[test]
fn intents_withdraw_goes_to_the_real_destination() {
    matches_label(REAL, &[
        "mainnet:lesik_o.sputnik-dao.near:57",
        "mainnet:memdexdao001.sputnik-dao.near:5",
        "mainnet:o_lskik2.sputnik-dao.near:34",
        "mainnet:testing-astradao.sputnik-dao.near:588",
    ]);
    matches_label(PLANTED, &["planted:24", "planted:53"]);
    let (_, a) = run(REAL, "mainnet:lesik_o.sputnik-dao.near:57");
    assert!(matches!(&a.effects[..], [Effect::IntentsWithdraw { chain, address, .. }]
        if chain == "sol" && address == "PjR3spCLnn763e7cBhPcpiTK4NJE87J8jwtAsWiAGoj"));
}

#[test]
fn intents_transfer_drops_the_nep141_prefix() {
    matches_label(REAL, &[
        "mainnet:ergo-public.sputnik-dao.near:2",
        "mainnet:mic.sputnik-dao.near:72",
        "mainnet:confidential-staging.sputnik-dao.near:165",
    ]);
}

#[test]
fn intents_key_change_direct_and_inside_an_intent() {
    matches_label(REAL, &["mainnet:megha-business.sputnik-dao.near:0", "mainnet:dasdass.sputnik-dao.near:0"]);
    matches_label(PLANTED, &["planted:28"]);
}

#[test]
fn wrap_takes_the_attached_near() {
    matches_label(REAL, &["mainnet:burrow.sputnik-dao.near:1528", "mainnet:bob.sputnik-dao.near:3"]);
    matches_label(PLANTED, &["planted:70"]);
}

#[test]
fn staking_ops_on_pool_accounts() {
    matches_label(REAL, &[
        "mainnet:jasnah-treasury.sputnik-dao.near:148",
        "mainnet:jasnah-treasury.sputnik-dao.near:137",
        "mainnet:linear-stake-wars.sputnik-dao.near:159",
        "mainnet:testing-astradao.sputnik-dao.near:614",
    ]);
    matches_label(PLANTED, &["planted:63"]);
}

#[test]
fn storage_deposit_on_any_contract() {
    matches_label(REAL, &["mainnet:o_lskik2.sputnik-dao.near:76", "mainnet:aaapeter.sputnik-dao.near:2"]);
    matches_label(PLANTED, &["planted:51"]);
}

#[test]
fn defi_calls_only_on_the_exact_accounts() {
    matches_label(REAL, &[
        "mainnet:burrow.sputnik-dao.near:1456",
        "mainnet:burrow.sputnik-dao.near:1657",
        "mainnet:ref-labs.sputnik-dao.near:264",
        "mainnet:ref-labs.sputnik-dao.near:226",
    ]);
    let (_, elsewhere) = run(REAL, "mainnet:ref-labs.sputnik-dao.near:226");
    assert!(matches!(&elsewhere.effects[..], [Effect::UnknownCall { .. }]), "Burrow-shaped call on another account");
}

#[test]
fn bulk_payment_from_approve_list_and_from_a_funded_list() {
    matches_label(REAL, &[
        "mainnet:n1-treasury.sputnik-dao.near:219",
        "mainnet:ergo-public.sputnik-dao.near:1",
        "mainnet:fgl2.sputnik-dao.near:3",
        "mainnet:trezu-yash.sputnik-dao.near:5",
    ]);
}

#[test]
fn unknown_calls_keep_the_arguments() {
    matches_label(REAL, &[
        "mainnet:aggregate-oracle.sputnik-dao.near:21",
        "mainnet:braindao-treasury.sputnik-dao.near:83",
        "mainnet:hot-dao.sputnik-dao.near:176",
        "mainnet:mgoyal.sputnik-dao.near:7",
    ]);
    matches_label(PLANTED, &["planted:54", "planted:55", "planted:64"]);
    let (_, empty) = run(REAL, "mainnet:braindao-treasury.sputnik-dao.near:83");
    assert!(matches!(&empty.effects[..], [Effect::UnknownCall { args, .. }] if *args == serde_json::json!({})));
}

#[test]
fn sign_actions_are_left_to_the_hash_check() {
    let input = input_of(&record(REAL, "mainnet:agentic.sputnik-dao.near:10"), &census_prices()).unwrap();
    assert_eq!(decode::value::decode(&input), (vec![], vec![]));
}
