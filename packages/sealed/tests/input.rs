//! Input parsing and validation. Not covered here: what the job does with a valid input (the
//! reads, the AI call and the verdict have their own files), and stdin handling, which is
//! `main.rs` reading at most one byte over the cap.

use kaap_core::Network;
use kaap_sealed::input::{parse_input, parse_request, InputError, Request, SealedText, MAX_INPUT_BYTES};

const GOOD: &str = r#"{"v":1,"network":"testnet","guard":"guard.kaap.testnet","dao":"demo.sputnikv2.testnet","proposal_id":7,"expires_in_ms":600000}"#;

fn parse(text: &str) -> Result<kaap_sealed::input::JobInput, InputError> {
    parse_input(text.as_bytes(), Some("testnet"))
}

#[test]
fn a_good_input_is_accepted_as_written() {
    let input = parse(GOOD).unwrap();
    assert_eq!(input.network, Network::Testnet);
    assert_eq!(input.guard, "guard.kaap.testnet");
    assert_eq!(input.dao, "demo.sputnikv2.testnet");
    assert_eq!(input.proposal_id, 7);
    assert_eq!(input.expires_in_ms, 600_000);
    assert!(!input.test_corrupt_https);
}

#[test]
fn the_network_must_be_the_runs_own() {
    assert_eq!(parse_input(GOOD.as_bytes(), Some("mainnet")), Err(InputError::NetworkNotThisRun));
    assert_eq!(parse_input(GOOD.as_bytes(), None), Err(InputError::RunNetworkUnset));
    let mainnet = GOOD.replace("testnet\",\"guard", "mainnet\",\"guard");
    assert_eq!(parse_input(mainnet.as_bytes(), Some("mainnet")).unwrap().network, Network::Mainnet);
    for other in ["sandbox", "Testnet", "", "localnet"] {
        let text = GOOD.replace("\"network\":\"testnet\"", &format!("\"network\":\"{other}\""));
        assert_eq!(parse_input(text.as_bytes(), Some(other)), Err(InputError::UnknownNetwork), "{other}");
    }
}

#[test]
fn unknown_missing_and_duplicate_fields_are_refused() {
    let extra = GOOD.replace("\"v\":1,", "\"v\":1,\"policy\":{},");
    let missing = GOOD.replace(",\"expires_in_ms\":600000", "");
    let duplicate = GOOD.replace("\"proposal_id\":7", "\"proposal_id\":7,\"proposal_id\":8");
    for text in [extra.as_str(), missing.as_str(), duplicate.as_str(), "[]", "null", "", "{}"] {
        assert_eq!(parse(text), Err(InputError::NotTheInputShape), "{text}");
    }
}

#[test]
fn numbers_out_of_range_are_refused() {
    for (from, to) in [
        ("\"proposal_id\":7", "\"proposal_id\":-1"),
        ("\"proposal_id\":7", "\"proposal_id\":7.5"),
        ("\"proposal_id\":7", "\"proposal_id\":18446744073709551616"),
        ("\"proposal_id\":7", "\"proposal_id\":\"7\""),
        ("\"v\":1", "\"v\":256"),
    ] {
        assert_eq!(parse(&GOOD.replace(from, to)), Err(InputError::NotTheInputShape), "{to}");
    }
    assert_eq!(parse(&GOOD.replace("\"v\":1", "\"v\":2")), Err(InputError::UnknownVersion));
    for bad in ["0", "3600001"] {
        let text = GOOD.replace("600000", bad);
        assert_eq!(parse(&text), Err(InputError::ExpiryOutOfRange), "{bad}");
    }
    assert_eq!(parse(&GOOD.replace("600000", "3600000")).unwrap().expires_in_ms, 3_600_000);
    assert_eq!(parse(&GOOD.replace("\"proposal_id\":7", "\"proposal_id\":18446744073709551615")).unwrap().proposal_id, u64::MAX);
}

#[test]
fn account_ids_follow_nearcore() {
    for bad in ["A.testnet", "a", "a..b", "-a.testnet", "a b", &"a".repeat(65), ""] {
        let text = GOOD.replace("demo.sputnikv2.testnet", bad);
        assert_eq!(parse(&text), Err(InputError::BadDao), "{bad:?}");
        let text = GOOD.replace("guard.kaap.testnet", bad);
        assert_eq!(parse(&text), Err(InputError::BadGuard), "{bad:?}");
    }
    let implicit = "ab".repeat(32);
    assert!(parse(&GOOD.replace("demo.sputnikv2.testnet", &implicit)).is_ok());
}

#[test]
fn the_test_flag_is_testnet_only() {
    let flagged = GOOD.replace("}", ",\"test_corrupt_https\":true}");
    assert!(parse(&flagged).unwrap().test_corrupt_https);
    let on_mainnet = flagged.replace("testnet\",\"guard", "mainnet\",\"guard");
    assert_eq!(parse_input(on_mainnet.as_bytes(), Some("mainnet")), Err(InputError::TestFlagOffTestnet));
}

#[test]
fn oversized_input_is_refused_before_parsing() {
    let padded = format!("{GOOD}{}", " ".repeat(MAX_INPUT_BYTES + 1 - GOOD.len()));
    assert_eq!(parse(&padded), Err(InputError::TooLarge));
    let at_cap = format!("{GOOD}{}", " ".repeat(MAX_INPUT_BYTES - GOOD.len()));
    assert!(parse(&at_cap).is_ok());
}

/// A real X25519 public key: RFC 7748 section 6.1, Bob's.
const REPLY_KEY: &str = "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f";

fn with_text(ciphertext: &str, reply_key: &str) -> String {
    GOOD.replace("}", &format!(",\"text_ciphertext\":\"{ciphertext}\",\"reply_key\":\"{reply_key}\"}}"))
}

#[test]
fn a_text_comes_as_ciphertext_and_a_reply_key_together() {
    let input = parse(&with_text("AQID", REPLY_KEY)).unwrap();
    let reply_key: [u8; 32] = hex::decode(REPLY_KEY).unwrap().try_into().unwrap();
    assert_eq!(input.text, Some(SealedText { ciphertext: vec![1, 2, 3], reply_key }));
    assert!(parse(GOOD).unwrap().text.is_none());

    let upper = parse(&with_text("AQID", &REPLY_KEY.to_uppercase())).unwrap();
    assert_eq!(upper.text.unwrap().reply_key, reply_key, "both cases decode to the same key");

    let alone = GOOD.replace("}", ",\"text_ciphertext\":\"AQID\"}");
    assert_eq!(parse(&alone), Err(InputError::TextFieldsNotPaired));
    let alone = GOOD.replace("}", &format!(",\"reply_key\":\"{REPLY_KEY}\"}}"));
    assert_eq!(parse(&alone), Err(InputError::TextFieldsNotPaired));
    let doubled = with_text("AQID", REPLY_KEY).replace("}", ",\"reply_key\":\"00\"}");
    assert_eq!(parse(&doubled), Err(InputError::NotTheInputShape));
}

#[test]
fn a_text_that_cannot_be_read_as_bytes_is_refused() {
    for bad in ["not base64!", "AQI", "=AQID"] {
        assert_eq!(parse(&with_text(bad, REPLY_KEY)), Err(InputError::BadTextCiphertext), "{bad}");
    }
    let short = &REPLY_KEY[2..];
    let long = format!("{REPLY_KEY}00");
    let not_hex = "zz".repeat(32);
    for bad in [short, long.as_str(), not_hex.as_str(), ""] {
        assert_eq!(parse(&with_text("AQID", bad)), Err(InputError::BadReplyKey), "{bad}");
    }
}

#[test]
fn a_reply_key_anyone_could_read_is_refused() {
    let order_one = format!("01{}", "00".repeat(31));
    for low_order in [
        "00".repeat(32),
        order_one,
        "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800".to_string(),
        "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157".to_string(),
    ] {
        assert_eq!(parse(&with_text("AQID", &low_order)), Err(InputError::BadReplyKey), "{low_order}");
    }
}

#[test]
fn the_key_request_is_exactly_one_small_object_on_the_runs_network() {
    let op = |text: &str, network| parse_request(text.as_bytes(), network);
    assert_eq!(op(r#"{"v":1,"op":"pubkey"}"#, Some("testnet")), Ok(Request::TextKey(Network::Testnet)));
    assert_eq!(op(r#"{"v":1,"op":"pubkey"}"#, Some("mainnet")), Ok(Request::TextKey(Network::Mainnet)));
    assert_eq!(op(r#"{"v":1,"op":"pubkey"}"#, None), Err(InputError::RunNetworkUnset));
    assert_eq!(op(r#"{"v":1,"op":"pubkey"}"#, Some("sandbox")), Err(InputError::UnknownNetwork));
    assert_eq!(op(r#"{"v":2,"op":"pubkey"}"#, Some("testnet")), Err(InputError::UnknownVersion));
    assert_eq!(op(r#"{"v":1,"op":"keys"}"#, Some("testnet")), Err(InputError::UnknownOp));
    assert_eq!(op(r#"{"v":1,"op":"pubkey","extra":1}"#, Some("testnet")), Err(InputError::NotTheInputShape));
    assert_eq!(op(r#"{"v":1,"op":"pubkey","op":"pubkey"}"#, Some("testnet")), Err(InputError::NotTheInputShape));
    assert!(matches!(op(GOOD, Some("testnet")), Ok(Request::Judge(_))));
    let padded = format!("{}{}", r#"{"v":1,"op":"pubkey"}"#, " ".repeat(MAX_INPUT_BYTES));
    assert_eq!(op(&padded, Some("testnet")), Err(InputError::TooLarge));
}

#[test]
fn refusal_reasons_are_fixed_text() {
    let out = kaap_sealed::output::refused(InputError::NotTheInputShape.reason());
    let value: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(value["status"], "refused");
    assert_eq!(value["v"], 1);
    assert!(value.get("signature").is_none());
}
