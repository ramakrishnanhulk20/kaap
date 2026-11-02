// A withdrawal's `msg` and `storage_deposit` when the DAO calls `intents.near` itself: the
// `ft_withdraw` and `mt_withdraw` methods, and withdrawal intents run through `execute_intents`.
// A signed text's withdrawals go through the same reader (hash_trezu.rs). Not covered here: the
// other intent kinds (value_effects.rs), the value findings in general (value_findings.rs), and
// what the receiver's code does with the message, which Kaap cannot see.

mod common;

use base64::Engine as _;
use common::census_prices;
use kaap_core::decode::value::decode;
use kaap_core::*;
use serde_json::{json, Value};
use FindingCode::*;

const DAO: &str = "family-bank.sputnik-dao.near";
const USDC: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const NEAR: &str = "000000000000000000000000";

fn call(method: &str, args: Value, paid: &[&str]) -> (Vec<Effect>, Vec<FindingCode>) {
    let args = base64::engine::general_purpose::STANDARD.encode(args.to_string());
    let kind = json!({"FunctionCall": {"receiver_id": "intents.near", "actions": [
        {"method_name": method, "args": args, "deposit": "1", "gas": "50000000000000"}
    ]}});
    let input = ProposalInput {
        network: Network::Mainnet,
        dao: DAO.into(),
        proposal_id: 7,
        description: "Pay the vendor".into(),
        kind_json: serde_json::to_vec(&kind).unwrap(),
        policy_before: None,
        history: Some(History {
            approved_payments_before: 3,
            median_payment_usd_before: Some(1.0),
            recipients_paid_before: paid.iter().map(|p| p.to_string()).collect(),
        }),
        prices: census_prices(),
        dao_version: Some("3.2".into()),
        supplied_text: None,
        guard_account: None,
        config_before: None,
        block_timestamp_ns: None,
    };
    let (effects, mut codes) = decode(&input);
    codes.sort();
    (effects, codes)
}

fn usdc_out() -> Effect {
    Effect::IntentsWithdraw { token: USDC.into(), amount: "5000000".into(), chain: "near".into(), address: "vendor.near".into() }
}

fn hook(method: &str, msg: &str) -> Effect {
    Effect::UnknownCall { receiver: "vendor.near".into(), method: method.into(), args: json!({ "msg": msg }), deposit: "0".into() }
}

/// The verifier runs `ft_transfer_call` for any `msg`, the empty one included (near/intents
/// d340060, core/src/intents/tokens.rs 177-181).
#[test]
fn a_msg_on_a_direct_withdrawal_calls_the_receiver() {
    for msg in ["", "{\"action\":\"swap\"}"] {
        let args = json!({"token": USDC, "receiver_id": "vendor.near", "amount": "5000000", "msg": msg});
        assert_eq!(call("ft_withdraw", args, &["vendor.near"]), (vec![usdc_out(), hook("ft_on_transfer", msg)], vec![UnknownCall]), "{msg:?}");
    }
    let plain = json!({"token": USDC, "receiver_id": "vendor.near", "amount": "5000000", "msg": null});
    assert_eq!(call("ft_withdraw", plain, &["vendor.near"]), (vec![usdc_out()], vec![]));
}

#[test]
fn a_msg_on_a_multi_token_withdrawal_intent_calls_the_receiver() {
    let id = "56_11111111111111111111";
    let intent = json!({"intent": "mt_withdraw", "token": "v2_1.omni.hot.tg", "token_ids": [id], "amounts": ["7"], "receiver_id": "vendor.near", "msg": "go"});
    let (effects, codes) = call("execute_intents", json!({ "signed": [intent] }), &["vendor.near"]);
    assert_eq!(effects.last(), Some(&hook("mt_on_transfer", "go")));
    assert!(codes.contains(&UnknownCall), "{codes:?}");
}

/// The `ft_withdraw` method passes no storage deposit on (near/intents d340060,
/// contracts/defuse/src/contract/tokens/nep141/withdraw.rs 27-50), so the argument pays nothing.
#[test]
fn the_withdraw_method_ignores_a_storage_deposit_argument() {
    let args = json!({"token": USDC, "receiver_id": "vendor.near", "amount": "5000000", "storage_deposit": format!("50{NEAR}")});
    assert_eq!(call("ft_withdraw", args, &["vendor.near"]), (vec![usdc_out()], vec![]));
}

#[test]
fn a_withdrawal_intent_s_storage_deposit_is_a_registration_up_to_a_tenth_of_a_near() {
    let intent = |paid: &str| json!({"signed": [{"intent": "ft_withdraw", "token": USDC, "receiver_id": "vendor.near", "amount": "5000000", "storage_deposit": paid}]});
    let registration = Effect::StorageDeposit { contract: USDC.into(), for_account: "vendor.near".into(), amount: "1250000000000000000000".into() };
    assert_eq!(call("execute_intents", intent("1250000000000000000000"), &["vendor.near"]), (vec![usdc_out(), registration], vec![]));

    let (effects, codes) = call("execute_intents", intent(&format!("50{NEAR}")), &["vendor.near"]);
    assert_eq!(effects, vec![
        usdc_out(),
        Effect::StorageDeposit { contract: USDC.into(), for_account: "vendor.near".into(), amount: format!("50{NEAR}") },
        Effect::Transfer { token: "near".into(), amount: format!("499{}", &NEAR[1..]), to: USDC.into() },
    ]);
    assert!(codes.len() == 2 && codes.contains(&NewRecipient) && codes.contains(&LargeAmount), "{codes:?}: 49.9 NEAR sent to the token contract");
}

#[test]
fn an_unreadable_msg_or_storage_deposit_makes_the_withdrawal_unknown() {
    for (field, value) in [("msg", json!(5)), ("storage_deposit", json!("-1")), ("storage_deposit", json!(1))] {
        let mut intent = json!({"intent": "ft_withdraw", "token": USDC, "receiver_id": "vendor.near", "amount": "5000000"});
        intent[field] = value;
        let (effects, codes) = call("execute_intents", json!({ "signed": [intent] }), &["vendor.near"]);
        assert!(matches!(&effects[..], [Effect::UnknownCall { method, .. }] if method == "ft_withdraw"), "{field}: {effects:?}");
        assert_eq!(codes, vec![UnknownCall], "{field}");
    }
}
