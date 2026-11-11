//! Everything the job prints. A refusal or a hold carries a fixed reason written in this crate
//! (the `&'static str` type makes any other text impossible) and never a signature.

use serde::Serialize;
use serde_json::Value;

use crate::payment::Refusal;

/// The documented limit on what `request_execution` returns on chain. Testnet returned 2,000
/// bytes whole on 26 Oct; mainnet is unmeasured, so 900 stays the cap.
pub const MAX_OUTPUT_BYTES: usize = 900;

#[derive(Serialize)]
struct Plain {
    v: u8,
    status: &'static str,
    reason: &'static str,
}

/// The input was not accepted. No outside call was made, except for `TEXT_DOES_NOT_MATCH`.
pub fn refused(reason: &'static str) -> String {
    plain("refused", reason)
}

/// Why a run is refused when its sealed text hashes to no payload of the proposal. Anyone can
/// encrypt a text to the job's key, so such a text proves nothing about the proposal and is never
/// judged. It is known only after the chain reads, so unlike the other refusals it comes after
/// them, but before the model is asked: no signature, no AI request, no evidence.
pub const TEXT_DOES_NOT_MATCH: &str = "text_does_not_match";

#[derive(Serialize)]
struct BelowPrice {
    v: u8,
    status: &'static str,
    reason: &'static str,
    detail: String,
}

/// The run's payment was refused. Like a refused input it is a normal answer, never a trap: a
/// trap's fate on OutLayer differs between its two doors, and this one reads the same on both. No
/// outside call was made.
pub fn below_price(why: Refusal) -> String {
    sorted_json(&BelowPrice { v: 1, status: "refused", reason: why.reason(), detail: why.sentence() })
        .unwrap_or_else(|_| refused(why.reason()))
}

/// A read failed or the two providers disagreed. No verdict, no signature (C22).
pub fn held(reason: &'static str) -> String {
    plain("held", reason)
}

/// The reads agreed but no signed verdict could be made (the signer, the expiry, or the size
/// cap). No signature.
pub fn failed(reason: &'static str) -> String {
    plain("failed", reason)
}

fn plain(status: &'static str, reason: &'static str) -> String {
    sorted_json(&Plain { v: 1, status, reason })
        .unwrap_or_else(|_| String::from(r#"{"reason":"output could not be written","status":"refused","v":1}"#))
}

/// `value` as one line of JSON with every object's keys in order. Everything this job prints or
/// stores goes through here: dcap-qvl turns on serde_json's `preserve_order` for every crate built
/// with this one, so without the sort the job and the CLI would show one object in two orders
/// (DECISIONS, 2 Nov 2026).
pub fn sorted_json(value: &impl Serialize) -> Result<String, serde_json::Error> {
    let mut value: Value = serde_json::to_value(value)?;
    value.sort_all_objects();
    Ok(value.to_string())
}
