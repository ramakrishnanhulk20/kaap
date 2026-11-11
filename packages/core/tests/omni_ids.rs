// NEAR Intents' Omni token ids for BNB Chain, Polygon and Avalanche (changelog of 9 Nov 2026,
// https://docs.near-intents.org/changelog/entries/2026-11-09-evm-omni-token-ids.md): each new
// `.omdep.near` id names the same chain as the HOT id it replaced, a direct withdrawal of one to
// its own contract leaves NEAR, and a quote paying one out fires CROSS_CHAIN_OUT. The other Omni
// stems in 1Click's list read as the chain 1Click names, except `strk`, which reads `unknown`.
// Not covered here: how the Omni Bridge releases the funds on the other chain, stems 1Click adds
// after 11 Nov 2026 (they read as `unknown`), and a quote signed by 1Click's production key,
// which `check` alone accepts (hash_quotes.rs).

use base64::Engine as _;
use kaap_core::decode::value::decode;
use kaap_core::hash::intents;
use kaap_core::hash::quote::{payout_chain, Quote};
use kaap_core::*;
use num_bigint::BigUint;
use serde_json::{json, Value};
use FindingCode::*;

const DAO: &str = "family-bank.sputnik-dao.near";
const USDC: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const DEPOSIT: &str = "3f1c0de0a6c64a5ab6dc5c5bd16e3b2b8a3b0f7f6a0b1c2d3e4f5061728394a5";
const DEADLINE_NS: i128 = 1_796_083_200_000_000_000;
const PAYEE: &str = "0xpayee";

/// Every row of the changelog's table, ids as it prints them, with the census name the HOT table
/// in decode/intents.rs gives the chain (56 `bsc`, 137 `pol`, 43114 `avax`).
const CHANGELOG: [(&str, &str, &str); 14] = [
    ("bsc", "nep245:v2_1.omni.hot.tg:56_11111111111111111111", "nep141:bnb.omdep.near"),
    ("bsc", "nep245:v2_1.omni.hot.tg:56_12zbnsg6xndDVj25QyL82YMPudb", "nep141:bnb-0x000ae314e2a2172a039b26378814c252734f556a.omdep.near"),
    ("bsc", "nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g", "nep141:bnb-0x55d398326f99059ff775485246999027b3197955.omdep.near"),
    ("bsc", "nep245:v2_1.omni.hot.tg:56_28V9BijGeZDBFEEtkAcnJo4tPRH4", "nep141:bnb-0x510ad22d8c956dcc20f68932861f54a591001283.omdep.near"),
    ("bsc", "nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r", "nep141:bnb-0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d.omdep.near"),
    ("bsc", "nep245:v2_1.omni.hot.tg:56_SZzgw3HSudhZcTwPWUTi2RJB19t", "nep141:bnb-0x1fa4a73a3f0133f0025378af00236f3abdee5d63.omdep.near"),
    ("bsc", "nep245:v2_1.omni.hot.tg:56_24S22V8GMmQN8t6PbCdRb3mBewAd", "nep141:bnb-0x4c067de26475e1cefee8b8d1f6e2266b33a2372e.omdep.near"),
    ("pol", "nep245:v2_1.omni.hot.tg:137_11111111111111111111", "nep141:pol.omdep.near"),
    ("pol", "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L", "nep141:pol-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omdep.near"),
    ("pol", "nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr", "nep141:pol-0xc2132d05d31c914a87c6611c10748aeb04b58e8f.omdep.near"),
    ("pol", "nep245:v2_1.omni.hot.tg:137_2jwTGwKRX3AEe7tyzDrxtDjEFgSt", "nep141:pol-0x7ceb23fd6bc0add59e62ac25578270cff1b9f619.omdep.near"),
    ("avax", "nep245:v2_1.omni.hot.tg:43114_11111111111111111111", "nep141:avax.omdep.near"),
    ("avax", "nep245:v2_1.omni.hot.tg:43114_372BeH7ENZieCaabwkbWkBiTTgXp", "nep141:avax-0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7.omdep.near"),
    ("avax", "nep245:v2_1.omni.hot.tg:43114_3atVJH3r5c4GqiSYmg9fECvjc47o", "nep141:avax-0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e.omdep.near"),
];

fn input(kind: Value) -> ProposalInput {
    ProposalInput {
        network: Network::Mainnet,
        dao: DAO.into(),
        proposal_id: 9,
        description: "Pay the vendor".into(),
        kind_json: serde_json::to_vec(&kind).unwrap(),
        policy_before: None,
        history: Some(History {
            approved_payments_before: 3,
            median_payment_usd_before: None,
            recipients_paid_before: vec!["vendor.near".into()],
        }),
        prices: Prices::default(),
        dao_version: Some("3.2".into()),
        supplied_text: None,
        guard_account: None,
        config_before: None,
        block_timestamp_ns: None,
    }
}

/// The DAO withdrawing `asset` (an id as intents.near holds it) to that token's own contract with
/// a `WITHDRAW_TO:` memo, read by the value decoder: the withdrawal's chain and address, and
/// whether CROSS_CHAIN_OUT fired.
fn withdrawn(asset: &str) -> (String, String, bool) {
    let memo = format!("WITHDRAW_TO:{PAYEE}");
    let (method, args) = match asset.strip_prefix("nep141:") {
        Some(contract) => ("ft_withdraw", json!({"token": contract, "receiver_id": contract, "amount": "1000", "memo": memo})),
        None => {
            let (contract, id) = asset.strip_prefix("nep245:").and_then(|rest| rest.split_once(':')).unwrap();
            ("mt_withdraw", json!({"token": contract, "token_ids": [id], "amounts": ["1000"], "receiver_id": contract, "memo": memo}))
        }
    };
    let args = base64::engine::general_purpose::STANDARD.encode(args.to_string());
    let (effects, codes) = decode(&input(json!({"FunctionCall": {"receiver_id": "intents.near", "actions": [
        {"method_name": method, "args": args, "deposit": "1", "gas": "50000000000000"}
    ]}})));
    match effects.as_slice() {
        [Effect::IntentsWithdraw { chain, address, .. }] => (chain.clone(), address.clone(), codes.contains(&CrossChainOut)),
        other => panic!("{asset}: {other:?}"),
    }
}

fn quote(destination: &str) -> Quote {
    Quote {
        deposit_address: DEPOSIT.into(),
        origin_asset: format!("nep141:{USDC}"),
        amount_in: BigUint::from(5_000_000u32),
        deadline_ns: DEADLINE_NS,
        destination_asset: destination.into(),
        recipient: PAYEE.into(),
        recipient_type: "DESTINATION_CHAIN".into(),
    }
}

#[test]
fn every_changelog_row_names_one_chain_by_its_old_and_new_id() {
    for (census, old, new) in CHANGELOG {
        let leaves = (census.to_string(), PAYEE.to_string(), true);
        assert_eq!(withdrawn(old), leaves, "{old}");
        assert_eq!(withdrawn(new), leaves, "{new}: the same chain as {old}");
        assert_ne!(census, "near");
        assert_eq!(payout_chain(&quote(new)), census, "{new}: a quote paying it out");
    }
}

/// One token per other Omni stem in 1Click's token list of 11 Nov 2026, with the `blockchain`
/// name 1Click gives it.
const OTHER_STEMS: [(&str, &str); 4] = [
    ("base", "nep141:base-0xc2bc2a4cd04358281c7cf36a057fc15e5552b18b.omdep.near"),
    ("abs", "nep141:abs.omdep.near"),
    ("fogo", "nep141:fogo.omdep.near"),
    ("sol", "nep141:sol-0xaad74c68eecfc9f8c5bdcea614f6167048c795ef.omdep.near"),
];

#[test]
fn the_other_omni_stems_in_1click_s_list_read_as_their_chain() {
    for (chain, asset) in OTHER_STEMS {
        assert_eq!(payout_chain(&quote(asset)), chain, "{asset}");
        assert_eq!(withdrawn(asset), (chain.to_string(), PAYEE.to_string(), true), "{asset}");
    }
}

/// strkBTC is listed by 1Click as blockchain `near`, but how it leaves NEAR is unproven.
#[test]
fn an_omni_stem_with_no_mapping_reads_unknown() {
    for asset in [
        "nep141:strk-0xe646ef2a705bf5147ceffc8dfbcc7bee4946b8f7.omdep.near",
        "nep141:bsc.omdep.near",
    ] {
        assert_eq!(payout_chain(&quote(asset)), "unknown", "{asset}");
        assert_eq!(withdrawn(asset), ("unknown".to_string(), PAYEE.to_string(), true), "{asset}");
    }
}

#[test]
fn an_ordinary_near_token_still_reads_near() {
    let usdt = "nep141:usdt.tether-token.near";
    assert_eq!(payout_chain(&quote(usdt)), "near");
    let to_itself = ("near".to_string(), "usdt.tether-token.near".to_string(), false);
    assert_eq!(withdrawn(usdt), to_itself, "a NEAR token sent to its own contract stays on NEAR");
}

/// Through `intents::judge`, the function `check` hands a NEP-413 text's intents and its verified
/// quotes to. A quote that verifies under 1Click's production key cannot be made in a test.
#[test]
fn a_quote_paying_bnb_to_an_outside_recipient_fires_cross_chain_out() {
    let transfer = json!({"intent": "transfer", "receiver_id": DEPOSIT, "tokens": {format!("nep141:{USDC}"): "5000000"}});
    let quotes = [quote("nep141:bnb.omdep.near")];
    let (effects, codes) = intents::judge(&[transfer.as_object().unwrap().clone()], "intents.near", DEADLINE_NS, &quotes, &input(json!({})));
    let paid = Effect::IntentsWithdraw { token: USDC.into(), amount: "5000000".into(), chain: "bsc".into(), address: PAYEE.into() };
    assert_eq!(effects, vec![paid]);
    assert!(codes.contains(&CrossChainOut), "{codes:?}");
}
