// 1Click quotes and the payees behind a deposit address, its recipient and its refund account
// (C7). The signature rebuild is proven on
// the three signed quotes in 1Click's own SDK tests, which a staging key signed; the pinned
// production key must refuse them. Not covered here: a quote signed by the production key (two
// keyless quote requests on 2 Nov 2026 returned HTTP 400, so through `check` the mapping is shown
// only refusing), whether 1Click quoted the address for this DAO, and what 1Click does with the
// funds afterwards.

use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey};
use kaap_core::hash::quote::{payout_chain, signed_message, verified, verify, Quote, ONE_CLICK_KEY};
use kaap_core::hash::{check, intents, nep413_hash};
use kaap_core::*;
use num_bigint::BigUint;
use serde_json::{json, Map, Value};
use FindingCode::*;

/// `STAGING_MANAGER_PUB_KEY` in defuse-protocol/one-click-sdk-typescript
/// src/__tests__/quote-signature.test.ts at ae8b24e (22 Sep 2026), read 2 Nov 2026. The three
/// quotes below are copied from the same file, written as JSON.
const STAGING_KEY: &str = "ed25519:5J5tkaxyPoR3Q9S8LXfo5bWnXK5Z2bctJ4mB9gENh7co";
const STAGING_NON_DRY_QUOTE: &str = r#"{"correlationId":"d4f1b110-46cc-4682-aa3f-44d81ffe4b80","timestamp":"2026-06-23T17:10:41.104Z","signature":"ed25519:53wcpim7FDNLbBHVezUpakthWq2TR9Lag3PwW3e8Cxmz4bFEodcc4rui5BiVHRRaHocYE9URVapzJD8JxLNDs8K9","quoteRequest":{"dry":false,"depositMode":"SIMPLE","swapType":"EXACT_INPUT","slippageTolerance":100,"originAsset":"1cs_v1:btc:native:coin","depositType":"ORIGIN_CHAIN","destinationAsset":"nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.stft.near","amount":"10000","refundTo":"bc1q6mte80265ghwq4vsrpm9lnaz46uvdreu9z8wly","refundType":"ORIGIN_CHAIN","recipient":"0xcac3C41676deF4FE375E57118f3eB83A99105577","recipientType":"DESTINATION_CHAIN","deadline":"2026-06-23T19:00:00.000Z","confidentiality":"public","quoteWaitingTimeMs":0,"appFees":[{"recipient":"5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd","fee":10}]},"quote":{"amountIn":"10000","amountInFormatted":"0.0001","amountInUsd":"6.237600000000","minAmountIn":"10000","amountOut":"5931560","amountOutFormatted":"5.93156","amountOutUsd":"5.925171709880","minAmountOut":"5872244","timeEstimate":812,"refundFee":"1900","withdrawFee":"300000","deadline":"2026-06-26T19:00:00.000Z","timeWhenInactive":"2026-06-26T19:00:00.000Z","depositAddress":"bc1q873cxltdc560dth6tpwqpehq9uvhxxcdgwnmnw"}}"#;
const STAGING_DRY_QUOTE: &str = r#"{"correlationId":"7d6d78f0-601f-4022-9735-854a22ed9dcb","timestamp":"2026-06-23T17:10:55.616Z","signature":"ed25519:3yVRcYGXRVj2YqrUng4Ne2yiWgh9YQfer46KW6sXiWzoyRHgsifwDp1HSZW7VLRTdKXoMgxJce22LQ9dcoihyfu5","quoteRequest":{"dry":true,"depositMode":"SIMPLE","swapType":"EXACT_INPUT","slippageTolerance":100,"originAsset":"1cs_v1:btc:native:coin","depositType":"ORIGIN_CHAIN","destinationAsset":"nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.stft.near","amount":"10000","refundTo":"bc1q6mte80265ghwq4vsrpm9lnaz46uvdreu9z8wly","refundType":"ORIGIN_CHAIN","recipient":"0xcac3C41676deF4FE375E57118f3eB83A99105577","recipientType":"DESTINATION_CHAIN","deadline":"2026-06-23T19:00:00.000Z","confidentiality":"public","quoteWaitingTimeMs":0,"appFees":[{"recipient":"5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd","fee":10}]},"quote":{"amountIn":"10000","amountInFormatted":"0.0001","amountInUsd":"6.237600000000","minAmountIn":"10000","amountOut":"5935024","amountOutFormatted":"5.935024","amountOutUsd":"5.928631979152","minAmountOut":"5875673","timeEstimate":812,"refundFee":"1900","withdrawFee":"300000"}}"#;
const STAGING_STATUS_QUOTE_RESPONSE: &str = r#"{"correlationId":"a60bbb06-4609-4976-873a-1f2f72c080e4","timestamp":"2026-06-23T17:10:41.104Z","signature":"ed25519:53wcpim7FDNLbBHVezUpakthWq2TR9Lag3PwW3e8Cxmz4bFEodcc4rui5BiVHRRaHocYE9URVapzJD8JxLNDs8K9","quoteRequest":{"dry":false,"swapType":"EXACT_INPUT","depositMode":"SIMPLE","slippageTolerance":100,"originAsset":"1cs_v1:btc:native:coin","depositType":"ORIGIN_CHAIN","destinationAsset":"nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.stft.near","amount":"10000","refundTo":"bc1q6mte80265ghwq4vsrpm9lnaz46uvdreu9z8wly","refundType":"ORIGIN_CHAIN","recipient":"0xcac3C41676deF4FE375E57118f3eB83A99105577","recipientType":"DESTINATION_CHAIN","deadline":"2026-06-23T19:00:00.000Z","appFees":[{"recipient":"5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd","fee":10}],"virtualChainRecipient":null,"virtualChainRefundRecipient":null,"referral":null,"confidentiality":"public"},"quote":{"amountIn":"10000","amountInFormatted":"0.0001","amountInUsd":"6.237600000000","minAmountIn":"10000","amountOut":"5931560","amountOutFormatted":"5.93156","amountOutUsd":"5.925171709880","minAmountOut":"5872244","timeWhenInactive":"2026-06-26T19:00:00.000Z","depositAddress":"bc1q873cxltdc560dth6tpwqpehq9uvhxxcdgwnmnw","deadline":"2026-06-26T19:00:00.000Z","timeEstimate":812,"refundFee":"1900","withdrawFee":"300000"}}"#;

const DAO: &str = "family-bank.sputnik-dao.near";
const DEPOSIT: &str = "3f1c0de0a6c64a5ab6dc5c5bd16e3b2b8a3b0f7f6a0b1c2d3e4f5061728394a5";
const USDC: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const DEADLINE: &str = "2026-12-01T00:00:00.000Z";
const DEADLINE_NS: i128 = 1_796_083_200_000_000_000;

fn signature_checks(response: &str, key: &str) -> bool {
    let Ok(Value::Object(fields)) = serde_json::from_str::<Value>(response) else { return false };
    let raw = |text: &str| bs58::decode(text.strip_prefix("ed25519:").unwrap_or(text)).into_vec().unwrap();
    let key = VerifyingKey::from_bytes(&raw(key).try_into().unwrap()).unwrap();
    let signature = Signature::from_bytes(&raw(fields["signature"].as_str().unwrap()).try_into().unwrap());
    key.verify_strict(signed_message(&fields).unwrap().as_bytes(), &signature).is_ok()
}

fn edited(response: &str, edit: impl FnOnce(&mut Value)) -> String {
    let mut value: Value = serde_json::from_str(response).unwrap();
    edit(&mut value);
    value.to_string()
}

#[test]
fn the_sdk_quotes_verify_against_the_key_that_signed_them() {
    let quote = verify(STAGING_NON_DRY_QUOTE, STAGING_KEY).expect("a full quote signed by the staging key");
    assert_eq!(
        quote,
        Quote {
            deposit_address: "bc1q873cxltdc560dth6tpwqpehq9uvhxxcdgwnmnw".into(),
            origin_asset: "1cs_v1:btc:native:coin".into(),
            amount_in: BigUint::from(10_000u32),
            deadline_ns: 1_782_500_400_000_000_000,
            destination_asset: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.stft.near".into(),
            recipient: "0xcac3C41676deF4FE375E57118f3eB83A99105577".into(),
            recipient_type: "DESTINATION_CHAIN".into(),
            refund_to: "bc1q6mte80265ghwq4vsrpm9lnaz46uvdreu9z8wly".into(),
            refund_type: "ORIGIN_CHAIN".into(),
        }
    );
    assert_eq!(verify(STAGING_STATUS_QUOTE_RESPONSE, STAGING_KEY), Some(quote), "the status endpoint's shape, nulls and order");
    assert!(signature_checks(STAGING_DRY_QUOTE, STAGING_KEY), "a dry quote signs the smaller payload");
    assert_eq!(verify(STAGING_DRY_QUOTE, STAGING_KEY), None, "a dry quote names no deposit address");
}

#[test]
fn only_the_pinned_key_counts() {
    for response in [STAGING_NON_DRY_QUOTE, STAGING_STATUS_QUOTE_RESPONSE] {
        assert_eq!(verify(response, ONE_CLICK_KEY), None);
        let self_vouching = edited(response, |v| v["managerPublicKey"] = json!(STAGING_KEY));
        assert!(verified(&[response.to_string(), self_vouching]).is_empty(), "a key inside the response is never used (A8)");
    }
}

/// An edit to a signed quote response.
type QuoteEdit = fn(&mut Value);

#[test]
fn any_edit_to_a_signed_field_breaks_the_signature() {
    let edits: [(&str, QuoteEdit); 7] = [
        ("deposit address", |v| v["quote"]["depositAddress"] = json!("bc1q0000000000000000000000000000000000000000")),
        ("amount in", |v| v["quote"]["amountIn"] = json!("10001")),
        ("recipient", |v| v["quoteRequest"]["recipient"] = json!("0x0000000000000000000000000000000000000001")),
        ("deadline", |v| v["quote"]["deadline"] = json!("2026-06-27T19:00:00.000Z")),
        ("timestamp", |v| v["timestamp"] = json!("2026-06-23T17:10:41.105Z")),
        ("empty signature", |v| v["signature"] = json!("")),
        ("malformed signature", |v| v["signature"] = json!("not-a-valid-signature")),
    ];
    for (what, edit) in edits {
        assert_eq!(verify(&edited(STAGING_NON_DRY_QUOTE, edit), STAGING_KEY), None, "{what}");
    }
    let unsigned_field = edited(STAGING_NON_DRY_QUOTE, |v| v["correlationId"] = json!("another"));
    assert!(verify(&unsigned_field, STAGING_KEY).is_some(), "fields the SDK leaves out of the signature may change");
    let duplicate = STAGING_NON_DRY_QUOTE.replacen(r#""timestamp":"#, r#""timestamp":"x","timestamp":"#, 1);
    assert_eq!(verify(&duplicate, STAGING_KEY), None, "a duplicate key has no single reading");
}

fn quote(recipient: &str, destination: &str, recipient_type: &str) -> Quote {
    Quote {
        deposit_address: DEPOSIT.into(),
        origin_asset: format!("nep141:{USDC}"),
        amount_in: BigUint::from(5_000_000u32),
        deadline_ns: DEADLINE_NS,
        destination_asset: destination.into(),
        recipient: recipient.into(),
        recipient_type: recipient_type.into(),
        refund_to: DAO.into(),
        refund_type: "INTENTS".into(),
    }
}

const ETH_USDC: &str = "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near";

#[test]
fn the_payout_chain_comes_from_the_destination() {
    let chain = |asset: &str, recipient_type: &str| payout_chain(&quote("x", asset, recipient_type));
    assert_eq!(chain(ETH_USDC, "DESTINATION_CHAIN"), "eth");
    assert_eq!(chain("nep141:btc.omft.near", "DESTINATION_CHAIN"), "btc");
    assert_eq!(chain("1cs_v1:sol:native:coin", "DESTINATION_CHAIN"), "sol");
    assert_eq!(chain(&format!("nep141:{USDC}"), "DESTINATION_CHAIN"), "near");
    assert_eq!(chain("nep245:v2_1.omni.hot.tg:56_11111111111111111111", "DESTINATION_CHAIN"), "unknown");
    assert_eq!(chain("nep141:eth.omft.near", "INTENTS"), "near");
}

fn input(history: bool) -> ProposalInput {
    ProposalInput {
        network: Network::Mainnet,
        dao: DAO.into(),
        proposal_id: 13,
        description: "* Proposal Action: confidential".into(),
        kind_json: b"{}".to_vec(),
        policy_before: None,
        history: history.then(|| History {
            approved_payments_before: 4,
            median_payment_usd_before: None,
            recipients_paid_before: vec!["alice.near".into()],
        }),
        prices: Prices::default(),
        dao_version: Some("3.2".into()),
        supplied_text: None,
        guard_account: None,
        config_before: None,
        block_timestamp_ns: None,
    }
}

fn transfer(to: &str, amount: &str) -> Map<String, Value> {
    json!({"intent": "transfer", "receiver_id": to, "tokens": {format!("nep141:{USDC}"): amount}}).as_object().unwrap().clone()
}

/// The mapping itself, given a quote whose signature already checked.
#[test]
fn a_matching_verified_quote_names_the_real_payee() {
    let paid = |recipient: &str| {
        let quotes = [quote(recipient, ETH_USDC, "DESTINATION_CHAIN")];
        intents::judge(&[transfer(DEPOSIT, "5000000")], "intents.far", DEADLINE_NS, &quotes, &input(true))
    };
    let (effects, codes) = paid("0xpayee");
    assert_eq!(
        effects,
        vec![Effect::IntentsWithdraw { token: USDC.into(), amount: "5000000".into(), chain: "eth".into(), address: "0xpayee".into() }]
    );
    assert!(codes.contains(&CrossChainOut) && codes.contains(&NewRecipient), "{codes:?}");
    assert!(!paid("alice.near").1.contains(&NewRecipient), "NEW_RECIPIENT judges the quote's recipient, not the address");
}

/// A failed swap pays the quote's `refundTo`, so a refund to anyone but the DAO is a second payee.
#[test]
fn a_refund_to_anyone_but_the_dao_is_a_second_payee() {
    let codes = |refund_to: &str| {
        let mut quote = quote("alice.near", ETH_USDC, "DESTINATION_CHAIN");
        quote.refund_to = refund_to.into();
        intents::judge(&[transfer(DEPOSIT, "5000000")], "intents.far", DEADLINE_NS, &[quote], &input(true)).1
    };
    assert!(!codes(DAO).contains(&NewRecipient), "a refund to the DAO pays nobody new");
    assert!(codes("stranger.near").contains(&NewRecipient), "the recipient was paid before, the refund account never");
    assert!(!codes("alice.near").contains(&NewRecipient), "a refund account paid before is judged like any payee");
}

#[test]
fn a_quote_that_differs_in_anything_leaves_the_deposit_address_as_payee() {
    let good = quote("0xpayee", ETH_USDC, "DESTINATION_CHAIN");
    let mut other_token = good.clone();
    other_token.origin_asset = "nep141:wrap.near".into();
    let mut other_address = good.clone();
    other_address.deposit_address = "another.near".into();
    let cases = [
        ("amount", "5000001", good.clone(), DEADLINE_NS),
        ("token", "5000000", other_token, DEADLINE_NS),
        ("address", "5000000", other_address, DEADLINE_NS),
        ("deadline", "5000000", good, DEADLINE_NS + 1),
    ];
    for (what, amount, quote, deadline) in cases {
        let (effects, codes) = intents::judge(&[transfer(DEPOSIT, amount)], "intents.far", deadline, &[quote], &input(true));
        assert_eq!(effects, vec![Effect::IntentsTransfer { token: USDC.into(), amount: amount.into(), to: DEPOSIT.into() }], "{what}");
        assert!(codes.contains(&NewRecipient), "{what}: the deposit address is judged as a new payee");
    }
}

/// Through `check`: a staging-signed quote edited to name this deposit address fails the pinned
/// key, so the transfer keeps the deposit address and NEW_RECIPIENT fires on it.
#[test]
fn check_maps_nothing_without_a_quote_the_pinned_key_signed() {
    let message = format!(
        r#"{{"signer_id":"{DAO}","deadline":"{DEADLINE}","intents":[{{"intent":"transfer","receiver_id":"{DEPOSIT}","tokens":{{"nep141:{USDC}":"5000000"}}}}]}}"#
    );
    let nonce = [9u8; 32];
    let payload: String = nep413_hash(&message, &nonce, "intents.far", None).iter().map(|b| format!("{b:02x}")).collect();
    let args = base64::engine::general_purpose::STANDARD
        .encode(json!({"request": {"path": DAO, "payload_v2": {"Eddsa": payload}, "domain_id": 1}}).to_string());
    let mut proposal = input(true);
    proposal.kind_json = serde_json::to_vec(&json!({"FunctionCall": {"receiver_id": "v1.signer", "actions": [
        {"method_name": "sign", "args": args, "deposit": "1", "gas": "15000000000000"}
    ]}}))
    .unwrap();
    let forged = edited(STAGING_NON_DRY_QUOTE, |v| {
        v["quote"]["depositAddress"] = json!(DEPOSIT);
        v["quoteRequest"]["originAsset"] = json!(format!("nep141:{USDC}"));
        v["quote"]["amountIn"] = json!("5000000");
        v["quote"]["deadline"] = json!(DEADLINE);
    });
    proposal.supplied_text = Some(SuppliedText {
        message,
        nonce,
        recipient: "intents.far".into(),
        standard: TextStandard::Nep413,
        quotes: vec![forged, STAGING_NON_DRY_QUOTE.to_string()],
    });
    let (effects, codes) = check(&proposal);
    assert!(effects.contains(&Effect::IntentsTransfer { token: USDC.into(), amount: "5000000".into(), to: DEPOSIT.into() }));
    assert!(!effects.iter().any(|e| matches!(e, Effect::IntentsWithdraw { .. })));
    assert!(codes.contains(&NewRecipient));
    assert!(!codes.contains(&HashTextDangerous) && !codes.contains(&HashUnverified));
}
