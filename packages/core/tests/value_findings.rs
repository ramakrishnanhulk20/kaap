// Each finding `decode::value` owns (ATTACHED_DEPOSIT, NEW_RECIPIENT, LARGE_AMOUNT,
// UNKNOWN_VALUE, CROSS_CHAIN_OUT, LOOKALIKE_TOKEN, UNKNOWN_CALL, ARGS_NOT_JSON,
// INTENTS_KEY_CHANGE), firing and not firing on named answer-key records, plus duplicate keys
// (standard 2), exact receivers (C3) and the DeFi methods known to keep value with the DAO, on
// kinds built here. It does not cover the description,
// prompt or hash codes, the policy codes, random kinds (value_props.rs), or how much of the
// whole key agrees (value_eval.rs).

mod common;

use base64::Engine as _;
use common::{census_prices, codes, input_of, record, PLANTED, REAL};
use kaap_core::*;
use serde_json::json;
use FindingCode::*;

fn run(file: &str, id: &str) -> Analysis {
    analyze(&input_of(&record(file, id), &census_prices()).unwrap())
}

fn fires(code: FindingCode, file: &str, ids: &[&str]) {
    for id in ids {
        assert!(codes(&run(file, id)).contains(&code), "{code:?} should fire on {id}");
    }
}

fn silent(code: FindingCode, file: &str, ids: &[&str]) {
    for id in ids {
        assert!(!codes(&run(file, id)).contains(&code), "{code:?} should not fire on {id}");
    }
}

/// One FunctionCall action on a copy of a planted control.
fn call(receiver: &str, method: &str, args: &[u8], deposit: &str) -> Analysis {
    let mut input = input_of(&record(PLANTED, "planted:67"), &census_prices()).unwrap();
    let action = json!({
        "method_name": method,
        "args": base64::engine::general_purpose::STANDARD.encode(args),
        "deposit": deposit,
        "gas": "30000000000000",
    });
    input.kind_json = serde_json::to_vec(&json!({"FunctionCall": {"receiver_id": receiver, "actions": [action]}})).unwrap();
    analyze(&input)
}

#[test]
fn attached_deposit_only_when_the_near_becomes_a_transfer() {
    fires(AttachedDeposit, REAL, &["mainnet:int-mnt-dao.sputnik-dao.near:18", "mainnet:justhoot.sputnik-dao.near:11"]);
    fires(AttachedDeposit, PLANTED, &["planted:38", "planted:39", "planted:40"]);
    silent(AttachedDeposit, REAL, &[
        "mainnet:aaapeter.sputnik-dao.near:2",
        "mainnet:testing-astradao.sputnik-dao.near:614",
        "mainnet:n1-treasury.sputnik-dao.near:219",
        "mainnet:aggregate-oracle.sputnik-dao.near:21",
    ]);
    silent(AttachedDeposit, PLANTED, &["planted:70"]);
}

#[test]
fn new_recipient_judges_the_real_payee() {
    fires(NewRecipient, REAL, &[
        "mainnet:builder-ops.sputnik-dao.near:14",
        "mainnet:rdfgerfg.sputnik-dao.near:0",
        "mainnet:mic.sputnik-dao.near:20",
        "mainnet:lesik_o.sputnik-dao.near:57",
    ]);
    silent(NewRecipient, REAL, &["mainnet:burrow.sputnik-dao.near:1380", "mainnet:o_lskik2.sputnik-dao.near:34"]);
    silent(NewRecipient, PLANTED, &["planted:57"]);

    let r = record(REAL, "mainnet:mic.sputnik-dao.near:20");
    let mut input = input_of(&r, &census_prices()).unwrap();
    let history = input.history.as_mut().unwrap();
    for named in ["proofoffinger.near", "blackdragonisback.near", "mp_dao.near", "hijackcommunity.near", "g-nuff.near"] {
        history.recipients_paid_before.push(named.into());
    }
    assert!(!codes(&analyze(&input)).contains(&NewRecipient), "wrap.near and intents.near are not payees (rulings 4, 16)");
}

#[test]
fn large_amount_compares_the_priced_total_with_the_median() {
    fires(LargeAmount, REAL, &[
        "mainnet:staging-qa.sputnik-dao.near:253",
        "mainnet:das-willies.sputnik-dao.near:6",
        "mainnet:bcbbcl73sxe5g6-sputnik-dao-near.sputnik-dao.near:21",
        "mainnet:testing-astradao.sputnik-dao.near:588",
    ]);
    silent(LargeAmount, REAL, &[
        "mainnet:lesik-o.sputnik-dao.near:11",
        "mainnet:aurora-dao-bvi.sputnik-dao.near:549",
        "mainnet:stader-nearx.sputnik-dao.near:113",
        "mainnet:duct-community-token.sputnik-dao.near:32",
    ]);
}

#[test]
fn unknown_value_for_unpriced_tokens_never_low() {
    for id in [
        "mainnet:chatgpt.sputnik-dao.near:17",
        "mainnet:meteor.sputnik-dao.near:79",
        "mainnet:duct-community-token.sputnik-dao.near:32",
    ] {
        let a = run(REAL, id);
        assert!(codes(&a).contains(&UnknownValue) && !codes(&a).contains(&LargeAmount), "{id} (ruling 14)");
        assert_eq!(a.risk_floor, Severity::High, "{id}");
    }
    silent(UnknownValue, REAL, &["mainnet:burrow.sputnik-dao.near:1482", "mainnet:fgl2.sputnik-dao.near:3"]);
}

#[test]
fn cross_chain_out_only_off_near() {
    fires(CrossChainOut, REAL, &["mainnet:memdexdao001.sputnik-dao.near:5", "mainnet:testing-astradao.sputnik-dao.near:588"]);
    fires(CrossChainOut, PLANTED, &["planted:23", "planted:25"]);
    silent(CrossChainOut, REAL, &["mainnet:o_lskik2.sputnik-dao.near:34", "mainnet:o_lskik2.sputnik-dao.near:53"]);
}

#[test]
fn lookalike_token_on_imitations_of_the_known_tokens() {
    fires(LookalikeToken, REAL, &["mainnet:webassemblymusic-treasury.sputnik-dao.near:58"]);
    fires(LookalikeToken, PLANTED, &["planted:19", "planted:20", "planted:21", "planted:22"]);
    silent(LookalikeToken, PLANTED, &["planted:58", "planted:67"]);
}

#[test]
fn unknown_call_is_never_low() {
    for id in [
        "mainnet:aurora-dao-bvi.sputnik-dao.near:535",
        "mainnet:mgoyal.sputnik-dao.near:7",
        "mainnet:lesik_o.sputnik-dao.near:20",
        "mainnet:rainbowbridge.sputnik-dao.near:315",
    ] {
        let a = run(REAL, id);
        assert!(codes(&a).contains(&UnknownCall), "{id}");
        assert_eq!(a.risk_floor, Severity::High, "{id}");
    }
}

#[test]
fn args_not_json_but_empty_args_fire_nothing() {
    fires(ArgsNotJson, PLANTED, &["planted:54", "planted:55", "planted:56"]);
    silent(ArgsNotJson, REAL, &["mainnet:braindao-treasury.sputnik-dao.near:83", "mainnet:linear-stake-wars.sputnik-dao.near:159"]);
}

#[test]
fn intents_key_change_on_the_daos_own_account() {
    fires(IntentsKeyChange, REAL, &["mainnet:confidential-treas.sputnik-dao.near:0"]);
    fires(IntentsKeyChange, PLANTED, &["planted:26", "planted:28", "planted:51"]);
}

#[test]
fn a_duplicate_key_in_args_or_msg_is_a_finding_not_a_reading() {
    let in_args = call("usdt.tether-token.near", "ft_transfer", br#"{"receiver_id":"a.near","receiver_id":"b.near","amount":"1"}"#, "1");
    assert!(matches!(&in_args.effects[..], [Effect::UnknownCall { args, .. }] if *args == json!("not_json")));
    assert!(codes(&in_args).contains(&ArgsNotJson) && codes(&in_args).contains(&UnknownCall));

    let msg = r#"{"receiver_id":"a.near","receiver_id":"b.near"}"#;
    let args = serde_json::to_vec(&json!({"receiver_id": "intents.near", "amount": "1", "msg": msg})).unwrap();
    let in_msg = call("wrap.near", "ft_transfer_call", &args, "1");
    assert!(matches!(&in_msg.effects[..], [Effect::UnknownCall { method, .. }] if method == "ft_transfer_call"));
    assert!(codes(&in_msg).contains(&ArgsNotJson) && codes(&in_msg).contains(&UnknownCall));
}

/// One call with no attached NEAR beyond the security deposit, under a text that claims nothing.
fn defi(receiver: &str, method: &str, args: &str) -> Analysis {
    let mut input = input_of(&record(PLANTED, "planted:67"), &census_prices()).unwrap();
    input.description = "For the council to review.".into();
    let action = json!({
        "method_name": method,
        "args": base64::engine::general_purpose::STANDARD.encode(args),
        "deposit": "1",
        "gas": "30000000000000",
    });
    input.kind_json = serde_json::to_vec(&json!({"FunctionCall": {"receiver_id": receiver, "actions": [action]}})).unwrap();
    analyze(&input)
}

#[test]
fn a_defi_call_is_known_only_where_the_protocol_pays_nobody_but_the_dao() {
    let lp = r#"{"receiver_id": "stranger.near", "token_id": ":79", "amount": "10000000000000000000000000", "msg": ""}"#;
    let a = defi("v2.ref-finance.near", "mft_transfer_call", lp);
    assert!(matches!(&a.effects[..], [Effect::UnknownCall { method, .. }] if method == "mft_transfer_call"), "{:?}", a.effects);
    assert!(codes(&a).contains(&UnknownCall));
    assert_eq!(a.risk_floor, Severity::High);

    let config = |beneficiaries: &str| {
        format!(r#"{{"token_id": "wrap.near", "asset_config": {{"reserve_ratio": 2500, "beneficiaries": {beneficiaries}, "extra_decimals": 0}}}}"#)
    };
    let burrow = "contract.main.burrow.near";
    for (method, args) in [
        ("execute", r#"{"actions": [{"Withdraw": {"token_id": "wrap.near"}}, {"Withdraw": {"token_id": "usdt.tether-token.near", "amount": "5"}}]}"#.to_string()),
        ("update_asset_limit", r#"{"token_id": "eth.bridge.near", "borrowed_limit": "6"}"#.to_string()),
        ("enable_asset_capacity", r#"{"token_id": "wrap.near", "can_deposit": true}"#.to_string()),
        ("update_asset", config("{}")),
    ] {
        let a = defi(burrow, method, &args);
        assert!(matches!(&a.effects[..], [Effect::DefiCall { method: m, .. }] if m == method), "{method}: {:?}", a.effects);
        assert_eq!(a.risk_floor, Severity::Low, "{method}: {:?}", a.findings);
    }
    for (method, args) in [
        ("execute", r#"{"actions": [{"Withdraw": {"token_id": "wrap.near"}}, {"ForceClose": {"account_id": "x.near"}}]}"#.to_string()),
        ("execute", r#"{"actions": []}"#.to_string()),
        ("update_asset", config(r#"{"stranger.near": 10000}"#)),
        ("add_asset_farm_reward", r#"{"farm_id": "NetTvl", "reward_token_id": "wrap.near", "new_reward_per_day": "1", "new_booster_log_bases": {}, "reward_amount": "1"}"#.to_string()),
        ("claim_prot_fee", r#"{"token_id": "wrap.near"}"#.to_string()),
    ] {
        let a = defi(burrow, method, &args);
        assert!(matches!(&a.effects[..], [Effect::UnknownCall { .. }]), "{method} {args}: {:?}", a.effects);
        assert_eq!(a.risk_floor, Severity::High, "{method} {args}");
    }
    let swap = defi("dclv2.ref-labs.near", "swap", r#"{"pool_ids": ["a|b|100"], "input_token": "a", "amount": "1"}"#);
    assert!(matches!(&swap.effects[..], [Effect::UnknownCall { .. }]), "{:?}", swap.effects);
}

#[test]
fn a_method_means_something_only_on_its_exact_account() {
    let near = "1000000000000000000000000";
    let fake_wrap = call("wrap.nearr", "near_deposit", b"{}", near);
    let to_fake_wrap = Effect::Transfer { token: "near".into(), amount: near.into(), to: "wrap.nearr".into() };
    assert!(matches!(&fake_wrap.effects[0], Effect::UnknownCall { .. }));
    assert_eq!(fake_wrap.effects[1], to_fake_wrap);
    assert!(codes(&fake_wrap).contains(&AttachedDeposit));

    let fake_intents = call("intents.nearr", "add_public_key", br#"{"public_key":"ed25519:x"}"#, "1");
    assert!(!codes(&fake_intents).contains(&IntentsKeyChange) && codes(&fake_intents).contains(&UnknownCall));

    let named_near = call("near", "ft_transfer", br#"{"receiver_id":"a.near","amount":"1"}"#, "1");
    assert!(matches!(&named_near.effects[..], [Effect::UnknownCall { .. }]), "a token called near would read as native NEAR");
}
