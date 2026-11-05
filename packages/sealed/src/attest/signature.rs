//! NEAR AI's signature on one completion (`GET /v1/signature/{chat_id}`), checked against the exact
//! bytes the job sent and received (docs.near.ai, "Response Signatures", 23 Sep 2026).
//!
//! Only `provider_tee` ties an answer to the model's sealed machine; a `gateway` signature proves
//! only that NEAR AI's gateway relayed the bytes, so it is refused. The text is rebuilt here from
//! the bytes on the wire, never taken from the signature's own answer.

use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::{hex_array, Unverified, VerifiedModel};
use crate::net::{Deadline, Http, HttpFail, Limits, Method, Request, NEAR_AI_SIGNATURE};

/// A signature is a few hundred bytes of JSON.
pub const SIGNATURE_LIMITS: Limits = Limits {
    connect_ms: 5_000,
    first_byte_ms: 8_000,
    between_bytes_ms: 5_000,
    overall_ms: 8_000,
    max_body_bytes: 64 * 1024,
};

/// NEAR AI records a signature shortly after the answer; until then the lookup answers 404 or a
/// 2xx carrying `error_code`. Four tries 750 ms apart wait about two seconds, the "short, bounded
/// retry" the docs ask for.
pub const SIGNATURE_ATTEMPTS: u32 = 4;
pub const SIGNATURE_RETRY_MS: u64 = 750;

/// True for a chat id this job will put into a URL path: 1 to 128 ASCII letters, digits, `-` or
/// `_` (NEAR AI's ids look like `chatcmpl-` and hex). Anything else is never sent anywhere.
pub fn chat_id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The text a `provider_tee` signature must carry: `<model id>:<sha256 hex of the request
/// bytes>:<sha256 hex of the response bytes>`, lowercase hex, the bytes exactly as they crossed
/// the wire.
pub fn expected_text(model_id: &str, request: &[u8], response: &[u8]) -> String {
    format!("{model_id}:{}:{}", hex::encode(Sha256::digest(request)), hex::encode(Sha256::digest(response)))
}

/// Fetches the signature for `chat_id`, retrying a not-yet-recorded answer up to
/// `SIGNATURE_ATTEMPTS` times. `chat_id` must already have passed `chat_id_ok`. Any status other
/// than 200 or 404, a failed call, or running out of tries or time gives `SignatureUnavailable`.
pub fn fetch(http: &mut dyn Http, key: &str, chat_id: &str, deadline: Deadline) -> Result<Vec<u8>, Unverified> {
    if !chat_id_ok(chat_id) {
        return Err(Unverified::SignatureUnavailable);
    }
    let authorization = format!("Bearer {key}");
    let tail = format!("{chat_id}?signing_algo=ed25519");
    for attempt in 0..SIGNATURE_ATTEMPTS {
        if attempt > 0 {
            http.pause(SIGNATURE_RETRY_MS);
        }
        if deadline.passed() {
            return Err(Unverified::Deadline);
        }
        let response = http.send(&Request {
            method: Method::Get,
            endpoint: NEAR_AI_SIGNATURE,
            tail: &tail,
            headers: &[("authorization", authorization.as_str()), ("accept", "application/json")],
            body: None,
            keep_headers: &[],
            limits: SIGNATURE_LIMITS.within(deadline),
        });
        match response {
            Ok(r) if r.status == 200 && !is_pending(&r.body) => return Ok(r.body),
            Ok(r) if r.status == 200 || r.status == 404 => continue,
            Err(HttpFail::Timeout) => return Err(Unverified::Deadline),
            _ => return Err(Unverified::SignatureUnavailable),
        }
    }
    Err(Unverified::SignatureUnavailable)
}

/// A 2xx answer with `error_code` is "not available yet", not a signature (docs).
fn is_pending(body: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(body).is_ok_and(|v| v.get("error_code").is_some())
}

#[derive(Deserialize)]
struct RawSignature {
    text: String,
    signature: String,
    signing_address: String,
    signing_algo: String,
    signature_kind: Option<String>,
}

/// A signature that passed `check`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedAnswer {
    pub text: String,
    pub signature: [u8; 64],
    pub signing_address: [u8; 32],
}

/// Checks a signature answer against `expected_text`, in this order: the kind is `provider_tee`
/// (`gateway` gives `GatewaySigned`; absent or anything else gives `SignatureUnreadable`, never a
/// guess from the shape of the text); the algorithm is `ed25519`; the key is 32 bytes and the
/// signature 64; the signature verifies over the UTF-8 bytes of `text` under that key, with
/// ed25519-dalek's strict rules (`SignatureInvalid`); and `text` equals `expected_text` byte for
/// byte (`TextMismatch`). Does not decide whether the key is trusted: that is `match_signer`.
pub fn check(body: &[u8], expected_text: &str) -> Result<SignedAnswer, Unverified> {
    let raw: RawSignature = serde_json::from_slice(body).map_err(|_| Unverified::SignatureUnreadable)?;
    match raw.signature_kind.as_deref() {
        Some("provider_tee") => {}
        Some("gateway") => return Err(Unverified::GatewaySigned),
        _ => return Err(Unverified::SignatureUnreadable),
    }
    if raw.signing_algo != "ed25519" {
        return Err(Unverified::SignatureUnreadable);
    }
    let signing_address: [u8; 32] = hex_array(&raw.signing_address).ok_or(Unverified::SignatureUnreadable)?;
    let signature: [u8; 64] = hex_array(&raw.signature).ok_or(Unverified::SignatureUnreadable)?;
    let key = VerifyingKey::from_bytes(&signing_address).map_err(|_| Unverified::SignatureUnreadable)?;
    key.verify_strict(raw.text.as_bytes(), &Signature::from_bytes(&signature))
        .map_err(|_| Unverified::SignatureInvalid)?;
    if raw.text != expected_text {
        return Err(Unverified::TextMismatch);
    }
    Ok(SignedAnswer { text: raw.text, signature, signing_address })
}

/// The one verified model whose key signed the answer. No match, or more than one, gives
/// `SignerNotAttested`: NEAR AI's guide treats an ambiguous match as unverified, because instances
/// of one model share a key.
pub fn match_signer<'a>(signer: &[u8; 32], verified: &'a [VerifiedModel]) -> Result<&'a VerifiedModel, Unverified> {
    let mut matches = verified.iter().filter(|m| m.signing_address == *signer);
    match (matches.next(), matches.next()) {
        (Some(one), None) => Ok(one),
        _ => Err(Unverified::SignerNotAttested),
    }
}
