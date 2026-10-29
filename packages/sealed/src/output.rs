//! Everything the job prints. A refusal or a hold carries a fixed reason written in this crate
//! (the `&'static str` type makes any other text impossible) and never a signature.

use serde::Serialize;

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
    serde_json::to_string(&Plain { v: 1, status, reason })
        .unwrap_or_else(|_| String::from(r#"{"v":1,"status":"refused","reason":"output could not be written"}"#))
}
