// Attacks on the hash checker: texts that try to pass as the text behind a `sign` payload, or to
// be read two ways. Each builds a real `v1.signer` sign proposal whose payload is the NEP-413
// hash of the text, so the hash always matches unless the attack is about the hash itself. Not
// covered here: the published hash vectors (hash_vectors.rs), the answer key (hash_eval.rs), and
// whether the verifier contract or 1Click would accept a text, which no test here can run.

use base64::Engine as _;
use kaap_core::hash::{check, nep413_hash};
use kaap_core::*;
use serde_json::json;
use FindingCode::*;

const DAO: &str = "family-bank.sputnik-dao.near";
const USDC: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const NONCE: [u8; 32] = [7; 32];
/// 2 Nov 2026 09:41:57 UTC, the final mainnet block 222701869.
const BLOCK_NS: u64 = 1_793_612_517_649_371_544;

fn payment_text(signer: &str, deadline: &str) -> String {
    format!(
        r#"{{"signer_id":"{signer}","deadline":"{deadline}","intents":[{{"intent":"transfer","receiver_id":"vendor.near","tokens":{{"nep141:{USDC}":"5000000"}}}}]}}"#
    )
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sign_kind(payload: &str, path: &str, deposit: &str) -> Vec<u8> {
    let args = json!({"request": {"path": path, "payload_v2": {"Eddsa": payload}, "domain_id": 1}});
    let args = base64::engine::general_purpose::STANDARD.encode(args.to_string());
    let kind = json!({"FunctionCall": {"receiver_id": "v1.signer", "actions": [
        {"method_name": "sign", "args": args, "deposit": deposit, "gas": "15000000000000"}
    ]}});
    serde_json::to_vec(&kind).unwrap()
}

fn input(kind_json: Vec<u8>, supplied_text: Option<SuppliedText>, block_timestamp_ns: Option<u64>) -> ProposalInput {
    ProposalInput {
        network: Network::Mainnet,
        dao: DAO.into(),
        proposal_id: 13,
        description: "* Proposal Action: confidential <br>* Notes: Confidential proposal via private intents. Details are hidden for privacy.".into(),
        kind_json,
        policy_before: None,
        history: None,
        prices: Prices::default(),
        dao_version: Some("3.2".into()),
        supplied_text,
        guard_account: None,
        config_before: None,
        block_timestamp_ns,
    }
}

fn supplied(message: &str, nonce: [u8; 32], recipient: &str) -> SuppliedText {
    SuppliedText { message: message.into(), nonce, recipient: recipient.into(), standard: TextStandard::Nep413, quotes: Vec::new() }
}

/// A sign proposal whose payload is the hash of `signed`, with `handed` supplied as its text.
fn proposal(signed: &SuppliedText, handed: SuppliedText, path: &str, block: Option<u64>) -> ProposalInput {
    let payload = hex(&nep413_hash(&signed.message, &signed.nonce, &signed.recipient, None));
    input(sign_kind(&payload, path, "1"), Some(handed), block)
}

/// The proposal for a text supplied exactly as signed.
fn honest(message: &str, recipient: &str, path: &str, block: Option<u64>) -> ProposalInput {
    let text = supplied(message, NONCE, recipient);
    proposal(&text, text.clone(), path, block)
}

fn hash_codes(input: &ProposalInput) -> Vec<FindingCode> {
    let mut codes = check(input).1;
    codes.retain(|c| matches!(c, HashMismatch | HashTextDangerous | HashUnverified));
    codes.sort();
    codes.dedup();
    codes
}

fn sign_effect(input: &ProposalInput) -> (bool, Option<TextSource>, Option<TextStandard>) {
    check(input)
        .0
        .into_iter()
        .find_map(|e| match e {
            Effect::SignRequest { text_supplied, text_source, text_standard, .. } => Some((text_supplied, text_source, text_standard)),
            _ => None,
        })
        .expect("a sign call always has its sign_request effect")
}

#[test]
fn an_honest_text_reads_and_is_not_flagged() {
    let input = honest(&payment_text(DAO, "2026-12-01T00:00:00Z"), "intents.near", DAO, Some(BLOCK_NS));
    assert_eq!(hash_codes(&input), Vec::<FindingCode>::new());
    assert_eq!(sign_effect(&input), (true, Some(TextSource::Planted), Some(TextStandard::Nep413)));
    let analysis = analyze(&input);
    assert!(!analysis.must_veto);
}

#[test]
fn no_text_is_unknown_never_low_and_never_a_veto_alone() {
    let text = supplied(&payment_text(DAO, "2026-12-01T00:00:00Z"), NONCE, "intents.near");
    let payload = hex(&nep413_hash(&text.message, &text.nonce, &text.recipient, None));
    let input = input(sign_kind(&payload, DAO, "1"), None, Some(BLOCK_NS));
    assert_eq!(hash_codes(&input), vec![HashUnverified]);
    assert_eq!(sign_effect(&input), (false, None, None));
    let analysis = analyze(&input);
    assert_eq!(analysis.risk_floor, Severity::High, "C8: UNKNOWN counts as high, never low");
    assert!(analysis.findings.contains(&Finding { code: HashUnverified, severity: Severity::Unknown }));
    assert!(!analysis.must_veto && !analysis.veto_allowed, "guide section 4: an unverifiable hash alone never vetoes");
}

#[test]
fn a_changed_nonce_is_a_mismatch() {
    let signed = supplied(&payment_text(DAO, "2026-12-01T00:00:00Z"), NONCE, "intents.near");
    let mut nonce = NONCE;
    nonce[31] ^= 1;
    let input = proposal(&signed, supplied(&signed.message, nonce, "intents.near"), DAO, Some(BLOCK_NS));
    assert_eq!(hash_codes(&input), vec![HashMismatch]);
    assert_eq!(sign_effect(&input), (true, Some(TextSource::Planted), Some(TextStandard::Nep413)));
    assert!(analyze(&input).must_veto);
}

#[test]
fn a_changed_recipient_or_one_byte_of_text_is_a_mismatch() {
    let signed = supplied(&payment_text(DAO, "2026-12-01T00:00:00Z"), NONCE, "intents.near");
    let other_recipient = proposal(&signed, supplied(&signed.message, NONCE, "intents.far"), DAO, None);
    let spaced = proposal(&signed, supplied(&format!("{} ", signed.message), NONCE, "intents.near"), DAO, None);
    for input in [other_recipient, spaced] {
        assert_eq!(hash_codes(&input), vec![HashMismatch]);
    }
}

#[test]
fn a_duplicate_key_is_dangerous_at_any_depth() {
    let top = format!(r#"{{"signer_id":"{DAO}","deadline":"2026-12-01T00:00:00Z","intents":[],"intents":[{{"intent":"add_public_key","public_key":"ed25519:EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"}}]}}"#);
    let nested = format!(r#"{{"signer_id":"{DAO}","deadline":"2026-12-01T00:00:00Z","intents":[{{"intent":"transfer","receiver_id":"vendor.near","receiver_id":"attacker.near","tokens":{{"nep141:{USDC}":"5000000"}}}}]}}"#);
    for message in [top, nested] {
        let input = honest(&message, "intents.near", DAO, Some(BLOCK_NS));
        assert_eq!(hash_codes(&input), vec![HashTextDangerous], "{message}");
        assert!(analyze(&input).must_veto);
    }
}

#[test]
fn a_text_for_another_dao_is_dangerous() {
    let input = honest(&payment_text("other.sputnik-dao.near", "2026-12-01T00:00:00Z"), "intents.near", DAO, Some(BLOCK_NS));
    assert_eq!(hash_codes(&input), vec![HashTextDangerous]);
    let other_path = honest(&payment_text(DAO, "2026-12-01T00:00:00Z"), "intents.near", "other.sputnik-dao.near", Some(BLOCK_NS));
    assert_eq!(hash_codes(&other_path), vec![HashTextDangerous], "the sign path must be the DAO too");
}

#[test]
fn trailing_bytes_are_dangerous() {
    let good = payment_text(DAO, "2026-12-01T00:00:00Z");
    for message in [format!("{good} x"), format!("{good}{{}}"), format!("{good}\0")] {
        let input = honest(&message, "intents.near", DAO, Some(BLOCK_NS));
        assert_eq!(hash_codes(&input), vec![HashTextDangerous], "{message:?}");
    }
}

#[test]
fn texts_with_no_single_reading_are_dangerous() {
    let unknown_field = format!(r#"{{"signer_id":"{DAO}","deadline":"2026-12-01T00:00:00Z","intents":[],"referral":"x"}}"#);
    let not_json = "Authenticate DAO for confidential intents".to_string();
    let bad_deadline = format!(r#"{{"signer_id":"{DAO}","deadline":"1 Dec 2026","intents":[]}}"#);
    let unknown_app_data = format!(r#"{{"signer_id":"{DAO}","deadline":"2026-12-01T00:00:00Z","intents":[],"external_app_data":{{"configs":[{{"type":"trade","expires_in":60}}]}}}}"#);
    let missing_intents = format!(r#"{{"signer_id":"{DAO}","deadline":"2026-12-01T00:00:00Z"}}"#);
    for message in [unknown_field, not_json, bad_deadline, unknown_app_data, missing_intents] {
        let input = honest(&message, "intents.near", DAO, Some(BLOCK_NS));
        assert_eq!(hash_codes(&input), vec![HashTextDangerous], "{message}");
    }
    let other_verifier = honest(&payment_text(DAO, "2026-12-01T00:00:00Z"), "staging-intents.near", DAO, Some(BLOCK_NS));
    assert_eq!(hash_codes(&other_verifier), vec![HashTextDangerous], "a recipient Kaap does not model");
}

#[test]
fn a_passed_deadline_is_unverified_not_dangerous() {
    let message = payment_text(DAO, "2026-11-01T00:00:00Z");
    let input = honest(&message, "intents.near", DAO, Some(BLOCK_NS));
    assert_eq!(hash_codes(&input), vec![HashUnverified]);
    assert_eq!(sign_effect(&input), (false, Some(TextSource::Planted), Some(TextStandard::Nep413)), "the effect says a text came and was not counted");
    let analysis = analyze(&input);
    assert!(!analysis.must_veto && !analysis.veto_allowed);

    let at_the_block = payment_text(DAO, "2026-11-02T09:41:57.649371544Z");
    assert_eq!(hash_codes(&honest(&at_the_block, "intents.near", DAO, Some(BLOCK_NS))), vec![HashUnverified], "a deadline equal to the block is passed");
    let unknown_block = honest(&message, "intents.near", DAO, None);
    assert_eq!(hash_codes(&unknown_block), Vec::<FindingCode>::new(), "no block time: the deadline is not judged");
}

#[test]
fn a_passed_deadline_does_not_hide_a_text_with_no_single_reading() {
    let message = format!(r#"{{"signer_id":"{DAO}","deadline":"2020-01-01T00:00:00Z","intents":[],"intents":[]}}"#);
    assert_eq!(hash_codes(&honest(&message, "intents.near", DAO, Some(BLOCK_NS))), vec![HashTextDangerous]);
}

/// Q3 ruling: the planted records' `{"timestamp": <seconds>}` is read as a second form, judged
/// against the block like the RFC 3339 form.
#[test]
fn the_planted_deadline_form_is_read_and_judged() {
    let form = |seconds: u64| format!(r#"{{"signer_id":"{DAO}","deadline":{{"timestamp":{seconds}}},"intents":[]}}"#);
    assert_eq!(hash_codes(&honest(&form(1_800_000_000), "intents.near", DAO, Some(BLOCK_NS))), Vec::<FindingCode>::new());
    assert_eq!(hash_codes(&honest(&form(1_790_000_000), "intents.near", DAO, Some(BLOCK_NS))), vec![HashUnverified]);
    assert_eq!(hash_codes(&honest(&form(1_790_000_000), "intents.near", DAO, None)), Vec::<FindingCode>::new());
    let as_text = format!(r#"{{"signer_id":"{DAO}","deadline":{{"timestamp":"1800000000"}},"intents":[]}}"#);
    assert_eq!(hash_codes(&honest(&as_text, "intents.near", DAO, Some(BLOCK_NS))), vec![HashTextDangerous]);
}

#[test]
fn a_valid_text_carrying_add_public_key_is_dangerous() {
    let message = format!(r#"{{"signer_id":"{DAO}","deadline":"2026-12-01T00:00:00Z","intents":[{{"intent":"add_public_key","public_key":"ed25519:EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"}}]}}"#);
    let input = honest(&message, "intents.near", DAO, Some(BLOCK_NS));
    assert_eq!(hash_codes(&input), vec![HashTextDangerous]);
    assert!(sign_effect(&input).0);
    let (effects, codes) = check(&input);
    assert!(codes.contains(&IntentsKeyChange));
    assert!(effects.contains(&Effect::IntentsKeyChange {
        op: KeyOp::Add,
        public_key: "ed25519:EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE".into()
    }));
    let analysis = analyze(&input);
    assert!(analysis.must_veto && analysis.veto_allowed);
}

#[test]
fn what_a_text_authorises_becomes_intents_effects_with_their_findings() {
    let message = format!(
        r#"{{"signer_id":"{DAO}","deadline":"2026-12-01T00:00:00Z","intents":[{{"intent":"transfer","receiver_id":"vendor.near","tokens":{{"nep141:{USDC}":"5000000"}}}},{{"intent":"ft_withdraw","token":"eth.omft.near","receiver_id":"eth.omft.near","amount":"1000","memo":"WITHDRAW_TO:0xabc"}}]}}"#
    );
    let mut input = honest(&message, "intents.far", DAO, Some(BLOCK_NS));
    input.history = Some(History { approved_payments_before: 2, median_payment_usd_before: None, recipients_paid_before: vec!["paid.near".into()] });
    let (effects, codes) = check(&input);
    assert!(effects.contains(&Effect::IntentsTransfer { token: USDC.into(), amount: "5000000".into(), to: "vendor.near".into() }));
    assert!(effects.contains(&Effect::IntentsWithdraw { token: "eth.omft.near".into(), amount: "1000".into(), chain: "eth".into(), address: "0xabc".into() }));
    for code in [NewRecipient, CrossChainOut] {
        assert!(codes.contains(&code), "{code:?} in {codes:?}");
    }
    assert!(!codes.contains(&HashTextDangerous) && !codes.contains(&UnknownCall));
}

#[test]
fn a_modelled_kind_that_does_not_read_is_dangerous() {
    let message = format!(r#"{{"signer_id":"{DAO}","deadline":"2026-12-01T00:00:00Z","intents":[{{"intent":"transfer","receiver_id":"vendor.near","tokens":{{"usdc":"-5"}}}}]}}"#);
    let (effects, codes) = check(&honest(&message, "intents.near", DAO, Some(BLOCK_NS)));
    assert!(codes.contains(&HashTextDangerous) && !codes.contains(&UnknownCall), "{codes:?}");
    assert!(effects.contains(&Effect::UnknownCall {
        receiver: "intents.near".into(),
        method: "transfer".into(),
        args: json!({"receiver_id": "vendor.near", "tokens": {"usdc": "-5"}}),
        deposit: "0".into(),
    }));
}

#[test]
fn an_unknown_intent_kind_is_dangerous_and_shown_not_as_a_call() {
    let message = format!(r#"{{"signer_id":"{DAO}","deadline":"2026-12-01T00:00:00Z","intents":[{{"intent":"auth_call","contract_id":"evil.near","msg":"x"}}]}}"#);
    let input = honest(&message, "intents.far", DAO, Some(BLOCK_NS));
    let (effects, codes) = check(&input);
    assert!(codes.contains(&HashTextDangerous) && !codes.contains(&UnknownCall), "{codes:?}");
    assert!(effects.contains(&Effect::UnknownCall {
        receiver: "intents.far".into(),
        method: "auth_call".into(),
        args: json!({"contract_id": "evil.near", "msg": "x"}),
        deposit: "0".into(),
    }));
}

#[test]
fn one_text_verifies_one_sign_and_the_rest_stay_unverified() {
    let text = supplied(&payment_text(DAO, "2026-12-01T00:00:00Z"), NONCE, "intents.near");
    let payload = hex(&nep413_hash(&text.message, &text.nonce, &text.recipient, None));
    let args = |p: &str| base64::engine::general_purpose::STANDARD.encode(json!({"request": {"path": DAO, "payload_v2": {"Eddsa": p}, "domain_id": 1}}).to_string());
    let kind = json!({"FunctionCall": {"receiver_id": "v1.signer", "actions": [
        {"method_name": "sign", "args": args(&"ab".repeat(32)), "deposit": "1", "gas": "15000000000000"},
        {"method_name": "sign", "args": args(&payload), "deposit": "1", "gas": "15000000000000"}
    ]}});
    let input = input(serde_json::to_vec(&kind).unwrap(), Some(text), Some(BLOCK_NS));
    let supplied_flags: Vec<bool> = check(&input)
        .0
        .iter()
        .filter_map(|e| match e {
            Effect::SignRequest { text_supplied, .. } => Some(*text_supplied),
            _ => None,
        })
        .collect();
    assert_eq!(supplied_flags, vec![false, true]);
    assert_eq!(hash_codes(&input), vec![HashUnverified]);
}

#[test]
fn unreadable_sign_arguments_and_extra_deposit_are_never_low() {
    let not_a_request = base64::engine::general_purpose::STANDARD.encode(r#"{"request":{"path":"x","payload":[1,2,3],"key_version":0}}"#);
    let kind = json!({"FunctionCall": {"receiver_id": "v1.signer", "actions": [
        {"method_name": "sign", "args": not_a_request, "deposit": "1", "gas": "15000000000000"}
    ]}});
    let codes = check(&input(serde_json::to_vec(&kind).unwrap(), None, None)).1;
    assert_eq!(codes, vec![UnknownCall]);

    let deposit = honest(&payment_text(DAO, "2026-12-01T00:00:00Z"), "intents.near", DAO, None);
    let mut with_near = deposit.clone();
    let payload = hex(&nep413_hash(&deposit.supplied_text.as_ref().unwrap().message, &NONCE, "intents.near", None));
    with_near.kind_json = sign_kind(&payload, DAO, "1000000000000000000000000");
    let (effects, codes) = check(&with_near);
    assert!(codes.contains(&AttachedDeposit));
    assert!(effects.contains(&Effect::Transfer { token: "near".into(), amount: "1000000000000000000000000".into(), to: "v1.signer".into() }));
}
