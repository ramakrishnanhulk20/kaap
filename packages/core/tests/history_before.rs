//! Holds `kaap_core::history::history_before` to the TypeScript rule in `packages/cli/src/history.ts`:
//! this file and `packages/cli/test/history-parity.test.ts` load one fixture and must both give its
//! expected value. Not covered here: reading pages from a provider, proposals that do not read (the
//! unit tests in `src/history.rs`, since the TypeScript's schema refuses those first), and whether
//! today's prices are the right ones to judge an old payment by.

use std::path::Path;

use kaap_core::history::history_before;
use kaap_core::{History, Prices};
use serde_json::Value;

fn fixture() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/history-parity.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn proposals(fx: &Value) -> Vec<Value> {
    let pages = fx["real_pages"].as_array().unwrap().iter().flat_map(|page| page["proposals"].as_array().unwrap());
    pages.chain(fx["hand_made"].as_array().unwrap()).cloned().collect()
}

fn prices(fx: &Value) -> Prices {
    serde_json::from_value(fx["prices"].clone()).unwrap()
}

fn time(fx: &Value) -> u64 {
    fx["submission_time"].as_str().unwrap().parse().unwrap()
}

#[test]
fn history_before_gives_the_shared_fixtures_expected_value() {
    let fx = fixture();
    let expected: History = serde_json::from_value(fx["expected"].clone()).unwrap();
    assert_eq!(history_before(&proposals(&fx), time(&fx), &prices(&fx)), expected);
}

#[test]
fn history_before_counts_no_real_near_business_proposal_as_a_payment() {
    let fx = fixture();
    let page = fx["real_pages"][1]["proposals"].as_array().unwrap();
    let moved = page.iter().filter(|p| p["description"] == "* Proposal Action: public-to-confidential").count();
    assert_eq!(moved, 3, "the page must hold the real proposals the rule leaves out");
    let history = history_before(page, time(&fx), &prices(&fx));
    assert_eq!(history, History { approved_payments_before: 0, median_payment_usd_before: None, recipients_paid_before: Vec::new() });
}

#[test]
fn history_before_is_strictly_before_the_submission_time() {
    let fx = fixture();
    let all = proposals(&fx);
    let later = history_before(&all, time(&fx) + 1, &prices(&fx));
    assert!(later.recipients_paid_before.iter().any(|r| r == "made-exact-time.near"));
    assert!(!later.recipients_paid_before.iter().any(|r| r == "made-later.near"));
}
