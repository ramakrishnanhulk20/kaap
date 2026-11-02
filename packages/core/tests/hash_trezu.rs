// The everyday texts a NEAR Business or Trezu member may hand Kaap, built to the shape Trezu
// builds them or, where 1Click builds them for Trezu, to the shape 1Click and NEAR Intents
// document (tests/fixtures-trezu/texts.json, each with its source), then texts that try to pass
// as one of them. Each runs through a real `v1.signer` sign proposal whose payload is the text's
// NEP-413 hash. Not covered here: whether 1Click or the verifier would accept a text (no test can
// run them), a two-token `token_diff` as 1Click returns it today (documented, not observed in
// Trezu's samples), and the hash checks themselves (hash_attacks.rs, hash_vectors.rs).

mod common;

use base64::Engine as _;
use common::census_prices;
use kaap_core::hash::text::rfc3339_ns;
use kaap_core::hash::{check, nep413_hash};
use kaap_core::*;
use serde_json::{json, Value};
use FindingCode::*;

const DAO: &str = "kmxv7.sputnik-dao.near";
const SUB: &str = "kmxv7.bulkpayment.near";
/// 2 Nov 2026 09:41:57 UTC, the final mainnet block 222701869.
const BLOCK_NS: u64 = 1_793_612_517_649_371_544;
const NEAR: &str = "000000000000000000000000";

struct Text {
    dao: String,
    path: String,
    recipient: String,
    nonce: [u8; 32],
    message: String,
}

fn fixture(name: &str) -> Text {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures-trezu/texts.json");
    let texts: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let t = texts.iter().find(|t| t["name"] == name).unwrap_or_else(|| panic!("no fixture {name}"));
    let field = |k: &str| t[k].as_str().unwrap().to_string();
    let nonce = base64::engine::general_purpose::STANDARD.decode(field("nonce")).unwrap().try_into().unwrap();
    Text { dao: field("dao"), path: field("path"), recipient: field("recipient"), nonce, message: field("message") }
}

impl Text {
    fn with_message(mut self, message: String) -> Self {
        self.message = message;
        self
    }

    /// The sign proposal for this text, the text handed in exactly as signed.
    fn proposal(&self, block: Option<u64>) -> ProposalInput {
        let payload: String = nep413_hash(&self.message, &self.nonce, &self.recipient, None).iter().map(|b| format!("{b:02x}")).collect();
        let args = json!({"request": {"path": self.path, "payload_v2": {"Eddsa": payload}, "domain_id": 1}});
        let args = base64::engine::general_purpose::STANDARD.encode(args.to_string());
        let kind = json!({"FunctionCall": {"receiver_id": "v1.signer", "actions": [
            {"method_name": "sign", "args": args, "deposit": "1", "gas": "250000000000000"}
        ]}});
        ProposalInput {
            network: Network::Mainnet,
            dao: self.dao.clone(),
            proposal_id: 13,
            description: "* Proposal Action: confidential <br>* Notes: Confidential proposal via private intents. Details are hidden for privacy.".into(),
            kind_json: serde_json::to_vec(&kind).unwrap(),
            policy_before: None,
            history: None,
            prices: census_prices(),
            dao_version: Some("3.2".into()),
            supplied_text: Some(SuppliedText {
                message: self.message.clone(),
                nonce: self.nonce,
                recipient: self.recipient.clone(),
                standard: TextStandard::Nep413,
                quotes: Vec::new(),
            }),
            guard_account: None,
            config_before: None,
            block_timestamp_ns: block,
        }
    }
}

/// A message for `signer` carrying `intents`, with a deadline after the test block.
fn message(signer: &str, intents: Value) -> String {
    json!({"deadline": "2026-11-02T12:00:00.000Z", "intents": intents, "signer_id": signer}).to_string()
}

fn login(signer: &str, intents: Value, configs: Value) -> String {
    json!({"deadline": "2126-09-29T21:56:00.000Z", "external_app_data": {"configs": configs}, "intents": intents, "signer_id": signer}).to_string()
}

fn one_auth() -> Value {
    json!([{"expires_in": 3_153_600_000u64, "type": "auth"}])
}

fn history(median_usd: Option<f64>, paid: &[&str]) -> Option<History> {
    Some(History { approved_payments_before: 3, median_payment_usd_before: median_usd, recipients_paid_before: paid.iter().map(|p| p.to_string()).collect() })
}

/// Effects other than the `sign_request`, which every one of these proposals has.
fn read(input: &ProposalInput) -> (Vec<Effect>, Vec<FindingCode>) {
    let (mut effects, mut codes) = check(input);
    assert!(matches!(effects.first(), Some(Effect::SignRequest { text_supplied: true, .. })), "{effects:?}");
    effects.remove(0);
    codes.sort();
    codes.dedup();
    (effects, codes)
}

fn amounts(pairs: &[(&str, &str)]) -> Vec<TokenAmount> {
    pairs.iter().map(|(token, amount)| TokenAmount { token: token.to_string(), amount: amount.to_string() }).collect()
}

#[test]
fn a_1click_swap_reads_as_a_swap() {
    let swap = Effect::IntentsSwap {
        gives: amounts(&[("wrap.near", &format!("1{NEAR}"))]),
        receives: amounts(&[("usdt.tether-token.near", "1000000")]),
    };
    let public = fixture("swap");
    let mut confidential = fixture("swap");
    confidential.recipient = "intents.far".into();
    for text in [public, confidential] {
        let input = text.proposal(Some(BLOCK_NS));
        assert_eq!(read(&input), (vec![swap.clone()], vec![]), "{}", text.recipient);
        assert!(!analyze(&input).must_veto);
    }
}

#[test]
fn a_swap_gives_value_like_a_transfer_out_and_never_has_a_payee() {
    let mut input = fixture("swap").proposal(Some(BLOCK_NS));
    input.history = history(Some(0.01), &[]);
    let codes = read(&input).1;
    assert!(codes.contains(&LargeAmount), "{codes:?}");
    assert!(!codes.contains(&NewRecipient) && !codes.contains(&HashTextDangerous), "{codes:?}");

    input.prices = Prices::default();
    assert_eq!(read(&input).1, vec![UnknownValue], "an unpriced token given is unknown value, never zero");
    input.history = history(Some(1_000_000.0), &[]);
    input.prices = census_prices();
    assert_eq!(read(&input).1, Vec::<FindingCode>::new(), "1 NEAR against a large median");
}

#[test]
fn a_native_withdrawal_reads_as_an_intents_withdraw() {
    let input = fixture("native_withdraw").proposal(Some(BLOCK_NS));
    let withdraw = Effect::IntentsWithdraw { token: "near".into(), amount: format!("5{NEAR}"), chain: "near".into(), address: "vendor.near".into() };
    assert_eq!(read(&input), (vec![withdraw], vec![]));
    let mut paid_before = input.clone();
    paid_before.history = history(None, &[]);
    assert_eq!(read(&paid_before).1, vec![NewRecipient], "the receiver is judged as a payee");
}

#[test]
fn a_storage_registration_reads_as_a_storage_deposit_and_a_large_one_as_value() {
    let mut input = fixture("storage_deposit").proposal(Some(BLOCK_NS));
    input.history = history(Some(1.0), &[]);
    let small = Effect::StorageDeposit { contract: "usdc.near".into(), for_account: "bob.near".into(), amount: "1250000000000000000000".into() };
    assert_eq!(read(&input), (vec![small], vec![]), "0.00125 NEAR is a registration");

    let fifty = fixture("storage_deposit").message.replace("1250000000000000000000", &format!("50{NEAR}"));
    let mut input = fixture("storage_deposit").with_message(fifty).proposal(Some(BLOCK_NS));
    input.history = history(Some(1.0), &[]);
    let (effects, codes) = read(&input);
    assert_eq!(effects, vec![
        Effect::StorageDeposit { contract: "usdc.near".into(), for_account: "bob.near".into(), amount: format!("50{NEAR}") },
        Effect::Transfer { token: "near".into(), amount: format!("499{}", &NEAR[1..]), to: "usdc.near".into() },
    ]);
    assert!(codes.len() == 2 && codes.contains(&NewRecipient) && codes.contains(&LargeAmount), "{codes:?}: the 49.9 NEAR above the allowance is value sent to the contract");
}

#[test]
fn the_bulk_login_is_a_sign_request_alone() {
    for name in ["bulk_login", "dao_login"] {
        let input = fixture(name).proposal(Some(BLOCK_NS));
        assert_eq!(read(&input), (vec![], vec![]), "{name}");
        let analysis = analyze(&input);
        assert!(!analysis.must_veto, "{name}");
        assert!(matches!(&analysis.effects[..], [Effect::SignRequest { path, .. }] if *path == fixture(name).path), "{name}");
    }
}

/// Trezu's own samples are transfers to a 1Click deposit address, judged at a block an hour
/// before their deadline, when they could still execute.
#[test]
fn trezu_s_own_transfer_texts_still_read() {
    for name in ["trezu_signed_shield", "trezu_e2e_intent", "trezu_mock_intent"] {
        let text = fixture(name);
        let deadline: Value = serde_json::from_str::<Value>(&text.message).unwrap()["deadline"].clone();
        let live = rfc3339_ns(deadline.as_str().unwrap()).unwrap() - 3_600_000_000_000;
        let (effects, codes) = read(&text.proposal(Some(u64::try_from(live).unwrap())));
        assert!(matches!(&effects[..], [Effect::IntentsTransfer { token, to, .. }] if token == "wrap.near" && to.len() == 64), "{name}: {effects:?}");
        assert_eq!(codes, Vec::<FindingCode>::new(), "{name}");
    }
}

/// The text Trezu builds with path `""` signed for anything but the exact login: `intents` as
/// given, `configs` as given, signed by `signer` for `recipient`.
fn empty_path(signer: &str, intents: Value, configs: Value, recipient: &str) -> ProposalInput {
    let mut text = fixture("bulk_login").with_message(login(signer, intents, configs));
    text.recipient = recipient.into();
    text.proposal(Some(BLOCK_NS))
}

fn dangerous(input: &ProposalInput) -> bool {
    let codes = read(input).1;
    codes.contains(&HashTextDangerous) && analyze(input).must_veto
}

#[test]
fn a_token_diff_that_gives_and_takes_nothing_back_is_dangerous() {
    let gives_only = json!([{"intent": "token_diff", "diff": {"nep141:wrap.near": format!("-1{NEAR}"), "nep141:usdt.tether-token.near": "-1000000"}}]);
    assert!(dangerous(&fixture("swap").with_message(message(DAO, gives_only)).proposal(Some(BLOCK_NS))));
}

#[test]
fn a_token_diff_off_the_documented_shape_is_dangerous() {
    for diff in [
        json!({"intent": "token_diff", "diff": {"nep141:wrap.near": "-1", "nep141:usdt.tether-token.near": "0"}}),
        json!({"intent": "token_diff", "diff": {"nep141:wrap.near": "-1", "nep141:usdt.tether-token.near": "+5"}}),
        json!({"intent": "token_diff", "diff": {"nep141:wrap.near": "-1", "usdt": "5"}}),
        json!({"intent": "token_diff", "diff": {}}),
        json!({"intent": "token_diff", "diff": {"nep141:wrap.near": "-1", "nep141:usdt.tether-token.near": "5"}, "receiver_id": "attacker.near"}),
        json!({"intent": "token_diff", "diff": {"nep141:wrap.near": "-1", "nep141:usdt.tether-token.near": "5"}, "referral": "Not An Account"}),
        json!({"intent": "token_diff", "diff": {"nep141:wrap.near": format!("-{}", 1u128 << 127), "nep141:usdt.tether-token.near": "5"}}),
    ] {
        let input = fixture("swap").with_message(message(DAO, json!([diff]))).proposal(Some(BLOCK_NS));
        assert!(dangerous(&input), "{diff}");
    }
}

#[test]
fn a_swap_signed_for_another_account_is_dangerous() {
    let swap: Value = serde_json::from_str::<Value>(&fixture("swap").message).unwrap()["intents"].clone();
    for signer in ["other.sputnik-dao.near", SUB] {
        let input = fixture("swap").with_message(message(signer, swap.clone())).proposal(Some(BLOCK_NS));
        assert!(dangerous(&input), "{signer}");
    }
}

#[test]
fn a_bulk_login_carrying_an_intent_is_dangerous() {
    let drain = json!([{"intent": "transfer", "receiver_id": "attacker.near", "tokens": {"nep141:wrap.near": format!("1{NEAR}")}}]);
    assert!(dangerous(&empty_path(SUB, drain, one_auth(), "intents.near")));
    assert!(dangerous(&empty_path(SUB, json!([]), json!([]), "intents.near")), "no auth config is not the login");
}

#[test]
fn a_bulk_login_for_anyone_but_the_dao_s_own_sub_account_is_dangerous() {
    for signer in ["other.bulkpayment.near", "kmxv7.bulk-payment.near", "kmxv7.bulkpayment.near.evil.near", DAO] {
        assert!(dangerous(&empty_path(signer, json!([]), one_auth(), "intents.near")), "{signer}");
    }
    assert!(dangerous(&empty_path(SUB, json!([]), one_auth(), "intents.far")), "Trezu logs in on intents.near only");
    let two = json!([{"expires_in": 60, "type": "auth"}, {"expires_in": 60, "type": "auth"}]);
    assert!(dangerous(&empty_path(SUB, json!([]), two, "intents.near")), "exactly one auth config");
    let mut not_a_trezu_dao = empty_path("kmxv7.bulkpayment.near", json!([]), one_auth(), "intents.near");
    not_a_trezu_dao.dao = "kmxv7.near".into();
    assert!(dangerous(&not_a_trezu_dao), "a DAO Trezu derives no sub-account for");
}

#[test]
fn auth_call_and_a_change_of_who_acts_for_the_dao_are_dangerous() {
    for intent in [
        json!({"intent": "auth_call", "contract_id": "evil.near", "msg": "x", "attached_deposit": "0"}),
        json!({"intent": "set_auth_by_predecessor_id", "enabled": false}),
    ] {
        let input = fixture("swap").with_message(message(DAO, json!([intent]))).proposal(Some(BLOCK_NS));
        assert!(dangerous(&input), "{intent}");
    }
}

#[test]
fn a_native_withdrawal_or_storage_deposit_off_its_shape_is_dangerous() {
    for intent in [
        json!({"intent": "native_withdraw", "receiver_id": "vendor.near", "amount": "5", "msg": "x"}),
        json!({"intent": "native_withdraw", "receiver_id": "Vendor.near", "amount": "5"}),
        json!({"intent": "native_withdraw", "receiver_id": "vendor.near", "amount": "-5"}),
        json!({"intent": "storage_deposit", "contract_id": "usdc.near", "account_id": "bob.near", "deposit_for_account_id": "eve.near", "amount": "1"}),
        json!({"intent": "storage_deposit", "contract_id": "usdc.near", "amount": "1"}),
    ] {
        let input = fixture("native_withdraw").with_message(message(DAO, json!([intent]))).proposal(Some(BLOCK_NS));
        assert!(dangerous(&input), "{intent}");
    }
}

/// A withdrawal's `msg`, even an empty one, makes the token call the receiver: an unknown call,
/// not a text with no reading.
#[test]
fn a_signed_withdrawal_with_a_msg_calls_the_receiver() {
    let usdc = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
    let withdraw = json!([{"intent": "ft_withdraw", "token": usdc, "receiver_id": "vendor.near", "amount": "5000000", "msg": ""}]);
    let input = fixture("native_withdraw").with_message(message(DAO, withdraw)).proposal(Some(BLOCK_NS));
    let (effects, codes) = read(&input);
    assert!(effects.contains(&Effect::UnknownCall { receiver: "vendor.near".into(), method: "ft_on_transfer".into(), args: json!({"msg": ""}), deposit: "0".into() }));
    assert_eq!(codes, vec![UnknownCall]);
}
