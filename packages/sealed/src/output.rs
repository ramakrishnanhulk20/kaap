//! Everything the job prints. A refusal or a hold carries a fixed reason written in this crate
//! (the `&'static str` type makes any other text impossible) and never a signature.

use serde::Serialize;
use serde_json::Value;

/// The documented limit on what `request_execution` returns on chain. Testnet returned 2,000
/// bytes whole on 26 Oct; mainnet is unmeasured, so 900 stays the cap.
pub const MAX_OUTPUT_BYTES: usize = 900;

#[derive(Serialize)]
struct Plain {
    v: u8,
    status: &'static str,
    reason: &'static str,
}

/// The input was not accepted. No outside call was made.
pub fn refused(reason: &'static str) -> String {
    plain("refused", reason)
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
