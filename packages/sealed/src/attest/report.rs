//! NEAR AI's keyed attestation report (`GET /v1/attestation/report`), fetched with this run's
//! nonce, and the binding of each model candidate's signing key and that nonce into its verified
//! TDX quote (docs.near.ai, "Model Attestations" and "Quote, Nonce, and Signer Bindings").
//!
//! NEAR's documented layout for its own dstack reports, without TLS binding: report data is 64
//! bytes, the first 32 the decoded signing address zero-padded on the right, the last 32 the
//! nonce. An ed25519 address fills all 32. No keyed model report has been seen yet (the first
//! keyed run confirms the layout), so every other layout is refused rather than tried.

use serde::Deserialize;

use super::{hex_array, Unverified};
use crate::ai::MODEL_ID_QUERY;
use crate::net::{Deadline, Http, HttpFail, Limits, Method, Request, NEAR_AI_REPORT};

/// The report carries every candidate's TDX quote, event log and eight-GPU NVIDIA evidence, a few
/// hundred KB in all.
pub const REPORT_LIMITS: Limits = Limits {
    connect_ms: 5_000,
    first_byte_ms: 15_000,
    between_bytes_ms: 5_000,
    overall_ms: 20_000,
    max_body_bytes: 2 * 1024 * 1024,
};

/// More candidates than this is not a report this job will spend its time budget on.
pub const MAX_CANDIDATES: usize = 4;
/// A TDX quote with its PCK chain is about 5 KB.
pub const MAX_QUOTE_BYTES: usize = 64 * 1024;

/// The query, with `provider=near` so only NEAR AI's own fleet answers (the layout above is
/// documented for it alone) and the TLS fingerprint left out of the report data.
pub fn report_tail(nonce: &[u8; 32]) -> String {
    format!(
        "?model={MODEL_ID_QUERY}&signing_algo=ed25519&nonce={}&provider=near&include_tls_fingerprint=false",
        hex::encode(nonce)
    )
}

/// Fetches the report with the NEAR AI key, the canonical model id and `x-no-aliasing`. A failed
/// call or any status but 200 gives `ReportUnavailable`.
pub fn fetch(http: &mut dyn Http, key: &str, nonce: &[u8; 32], deadline: Deadline) -> Result<Vec<u8>, Unverified> {
    if deadline.passed() {
        return Err(Unverified::Deadline);
    }
    let authorization = format!("Bearer {key}");
    let tail = report_tail(nonce);
    let response = http
        .send(&Request {
            method: Method::Get,
            endpoint: NEAR_AI_REPORT,
            tail: &tail,
            headers: &[("authorization", authorization.as_str()), ("accept", "application/json"), ("x-no-aliasing", "true")],
            body: None,
            keep_headers: &[],
            limits: REPORT_LIMITS.within(deadline),
        })
        .map_err(|fail| if fail == HttpFail::Timeout { Unverified::Deadline } else { Unverified::ReportUnavailable })?;
    if response.status != 200 {
        return Err(Unverified::ReportUnavailable);
    }
    Ok(response.body)
}

#[derive(Deserialize)]
struct RawReport {
    model_attestations: Option<Vec<RawCandidate>>,
}

#[derive(Deserialize)]
struct RawCandidate {
    intel_quote: String,
    request_nonce: String,
    signing_address: String,
    signing_algo: String,
    nvidia_payload: Option<String>,
    tls_cert_fingerprint: Option<String>,
    report_data: Option<String>,
}

/// One model candidate whose fields passed `candidates`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub quote: Vec<u8>,
    pub signing_address: [u8; 32],
    /// The JSON text NVIDIA's service is sent unchanged, when present.
    pub nvidia_payload: Option<String>,
    /// NEAR does not return this today; when it does, it must equal the quote's.
    pub report_data: Option<[u8; 64]>,
}

/// Reads the report's model candidates, each checked on its own: the algorithm is `ed25519` with
/// a 32-byte address, no TLS fingerprint is mixed into the layout (`ReportDataLayout`),
/// `request_nonce` is this run's nonce (`NonceMismatch`), and the quote is hex within
/// `MAX_QUOTE_BYTES` (`ReportUnreadable`). Fails as a whole on an unreadable report
/// (`ReportUnreadable`) or a missing, empty or over-long candidate list (`NoModelEvidence`). The
/// candidates are not trusted yet: `bind` and the quote check decide that.
pub fn candidates(body: &[u8], nonce: &[u8; 32]) -> Result<Vec<Result<Candidate, Unverified>>, Unverified> {
    let report: RawReport = serde_json::from_slice(body).map_err(|_| Unverified::ReportUnreadable)?;
    let list = report.model_attestations.unwrap_or_default();
    if list.is_empty() || list.len() > MAX_CANDIDATES {
        return Err(Unverified::NoModelEvidence);
    }
    Ok(list.into_iter().map(|raw| candidate(raw, nonce)).collect())
}

fn candidate(raw: RawCandidate, nonce: &[u8; 32]) -> Result<Candidate, Unverified> {
    if raw.signing_algo != "ed25519" {
        return Err(Unverified::ReportDataLayout);
    }
    let signing_address = hex_array::<32>(&raw.signing_address).ok_or(Unverified::ReportDataLayout)?;
    if raw.tls_cert_fingerprint.as_deref().is_some_and(|f| !f.is_empty()) {
        return Err(Unverified::ReportDataLayout);
    }
    if hex_array::<32>(&raw.request_nonce) != Some(*nonce) {
        return Err(Unverified::NonceMismatch);
    }
    if raw.intel_quote.len() > 2 * MAX_QUOTE_BYTES {
        return Err(Unverified::ReportUnreadable);
    }
    let quote = hex::decode(raw.intel_quote.strip_prefix("0x").unwrap_or(&raw.intel_quote)).map_err(|_| Unverified::ReportUnreadable)?;
    let report_data = match raw.report_data.as_deref() {
        None | Some("") => None,
        Some(text) => Some(hex_array::<64>(text).ok_or(Unverified::ReportUnreadable)?),
    };
    Ok(Candidate { quote, signing_address, nvidia_payload: raw.nvidia_payload, report_data })
}

/// Checks that `quote_report_data`, read from the verified quote, binds this candidate's key and
/// this run's nonce in NEAR's layout. The nonce half wrong gives `NonceMismatch` (an old or
/// replayed report); the key half wrong, or a returned `report_data` that differs from the
/// quote's, gives `ReportDataLayout`.
pub fn bind(candidate: &Candidate, quote_report_data: &[u8; 64], nonce: &[u8; 32]) -> Result<(), Unverified> {
    if candidate.report_data.is_some_and(|claimed| claimed != *quote_report_data) {
        return Err(Unverified::ReportDataLayout);
    }
    if quote_report_data[32..] != nonce[..] {
        return Err(Unverified::NonceMismatch);
    }
    if quote_report_data[..32] != candidate.signing_address[..] {
        return Err(Unverified::ReportDataLayout);
    }
    Ok(())
}
