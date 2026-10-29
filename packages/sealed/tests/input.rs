//! Input parsing and validation. Not covered here: what the job does with a valid input (the
//! reads, the AI call and the verdict have their own files), and stdin handling, which is
//! `main.rs` reading at most one byte over the cap.

use kaap_core::Network;
use kaap_sealed::input::{parse_input, InputError, MAX_INPUT_BYTES};

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

#[test]
fn refusal_reasons_are_fixed_text() {
    let out = kaap_sealed::output::refused(InputError::NotTheInputShape.reason());
    let value: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(value["status"], "refused");
    assert_eq!(value["v"], 1);
    assert!(value.get("signature").is_none());
}
