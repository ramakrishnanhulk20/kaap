//! NEAR AI's keyed attestation report (`GET /v1/attestation/report`), fetched with this run's
//! nonce, and the binding of each model candidate's signing key and that nonce into its verified
//! TDX quote (docs.near.ai, "Model Attestations" and "Quote, Nonce, and Signer Bindings").
//!
//! NEAR's documented layout for its own dstack reports, without TLS binding: report data is 64
//! bytes, the first 32 the decoded signing address zero-padded on the right, the last 32 the
//! nonce. An ed25519 address fills all 32. No keyed model report has been seen yet (the first
//! keyed run confirms the layout), so every other layout is refused rather than tried.
//!
//! Each candidate also states which software its machine runs (`SoftwareClaims`): the event log,
//! the launcher configuration and the launcher's deployment log. They are read here as sent and
//! trusted only once `measure` holds them to the verified quote.

use serde::Deserialize;
use serde_json::{Map, Value};

use super::measure::Event;
use super::{hex_array, hex_bytes, Unverified};
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

/// The software fields are taken as any JSON, so one candidate sending them in an odd shape fails
/// alone, at its own check, and never makes the whole report unreadable.
#[derive(Deserialize)]
struct RawCandidate {
    intel_quote: String,
    request_nonce: String,
    signing_address: String,
    signing_algo: String,
    nvidia_payload: Option<String>,
    tls_cert_fingerprint: Option<String>,
    report_data: Option<String>,
    event_log: Option<Value>,
    info: Option<Value>,
    compose_manager_attestation: Option<Value>,
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

/// One model candidate as `entries` reads it: the fields `candidates` checks, and what its report
/// states about the software on its machine.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub candidate: Candidate,
    pub software: SoftwareClaims,
}

/// What a candidate's report states about the software on its machine. None of it is trusted
/// yet: `measure` holds each part to the verified quote, and a part that is missing or not
/// readable is `None` (or `DeploymentClaim::Unreadable`) so the check that needs it names it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SoftwareClaims {
    /// `event_log`, sent as a JSON array or as a JSON string holding one.
    pub event_log: Option<Vec<Event>>,
    /// `info.tcb_info.app_compose`, the launcher configuration, exactly as sent. `tcb_info` may be
    /// an object or a JSON string holding one.
    pub app_compose: Option<String>,
    /// `info.tcb_info.compose_hash` and `os_image_hash` as the report states them.
    pub compose_hash: Option<String>,
    pub os_image_hash: Option<String>,
    /// `info.app_id` and `info.instance_id` as the report states them.
    pub app_id: Option<String>,
    pub instance_id: Option<String>,
    pub deployment: DeploymentClaim,
}

/// `compose_manager_attestation`: the launcher's own quoted log of the deployments it was asked
/// to make. NEAR AI added it in November 2026 and documents it only in its SDK.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DeploymentClaim {
    /// Missing or JSON null.
    Absent,
    /// Present, but not in the shape `DeploymentLog` reads.
    Unreadable,
    Stated(DeploymentLog),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeploymentLog {
    /// Each action as the JSON object sent. Its hash is taken over these values, never over a
    /// typed copy that could drop a field.
    pub actions: Vec<Map<String, Value>>,
    pub actions_hash: String,
    pub nonce: String,
    /// The launcher's own TDX quote, within `MAX_QUOTE_BYTES`.
    pub quote: Vec<u8>,
    pub event_log: Vec<Event>,
    /// When returned, it must equal the launcher quote's report data.
    pub report_data: Option<String>,
}

/// Reads the report's model candidates, each checked on its own: the algorithm is `ed25519` with
/// a 32-byte address, no TLS fingerprint is mixed into the layout (`ReportDataLayout`),
/// `request_nonce` is this run's nonce (`NonceMismatch`), and the quote is hex within
/// `MAX_QUOTE_BYTES` (`ReportUnreadable`). Fails as a whole on an unreadable report
/// (`ReportUnreadable`) or a missing, empty or over-long candidate list (`NoModelEvidence`). The
/// candidates are not trusted yet: `bind` and the quote check decide that.
pub fn candidates(body: &[u8], nonce: &[u8; 32]) -> Result<Vec<Result<Candidate, Unverified>>, Unverified> {
    Ok(entries(body, nonce)?.into_iter().map(|entry| entry.map(|e| e.candidate)).collect())
}

/// `candidates`, with each candidate's `SoftwareClaims` beside it. Reading the claims never fails
/// a candidate: whatever is missing or unreadable is left for `measure` to name, after the quote
/// is checked. Every list in them is bounded by `REPORT_LIMITS.max_body_bytes`.
pub fn entries(body: &[u8], nonce: &[u8; 32]) -> Result<Vec<Result<Entry, Unverified>>, Unverified> {
    let report: RawReport = serde_json::from_slice(body).map_err(|_| Unverified::ReportUnreadable)?;
    let list = report.model_attestations.unwrap_or_default();
    if list.is_empty() || list.len() > MAX_CANDIDATES {
        return Err(Unverified::NoModelEvidence);
    }
    Ok(list.into_iter().map(|raw| entry(raw, nonce)).collect())
}

fn entry(mut raw: RawCandidate, nonce: &[u8; 32]) -> Result<Entry, Unverified> {
    let (event_log, info, deployment) = (raw.event_log.take(), raw.info.take(), raw.compose_manager_attestation.take());
    let candidate = candidate(raw, nonce)?;
    Ok(Entry { candidate, software: software(event_log, info, deployment) })
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
    let quote = quote_bytes(&raw.intel_quote).ok_or(Unverified::ReportUnreadable)?;
    let report_data = match raw.report_data.as_deref() {
        None | Some("") => None,
        Some(text) => Some(hex_array::<64>(text).ok_or(Unverified::ReportUnreadable)?),
    };
    Ok(Candidate { quote, signing_address, nvidia_payload: raw.nvidia_payload, report_data })
}

/// A quote's hex, with or without `0x`, within `MAX_QUOTE_BYTES`.
fn quote_bytes(text: &str) -> Option<Vec<u8>> {
    if text.len() > 2 * MAX_QUOTE_BYTES {
        return None;
    }
    hex_bytes(text)
}

fn software(event_log: Option<Value>, info: Option<Value>, deployment: Option<Value>) -> SoftwareClaims {
    let mut info = info.unwrap_or(Value::Null);
    let tcb_info = info.get_mut("tcb_info").map(Value::take).and_then(object).unwrap_or_default();
    let text = |map: Option<&Value>| map.and_then(Value::as_str).map(str::to_owned);
    SoftwareClaims {
        event_log: event_log.and_then(events),
        app_compose: text(tcb_info.get("app_compose")),
        compose_hash: text(tcb_info.get("compose_hash")),
        os_image_hash: text(tcb_info.get("os_image_hash")),
        app_id: text(info.get("app_id")),
        instance_id: text(info.get("instance_id")),
        deployment: match deployment {
            None | Some(Value::Null) => DeploymentClaim::Absent,
            Some(value) => deployment_log(value).map_or(DeploymentClaim::Unreadable, DeploymentClaim::Stated),
        },
    }
}

/// A JSON object, sent as one or as a JSON string holding one.
fn object(value: Value) -> Option<Map<String, Value>> {
    match value {
        Value::Object(map) => Some(map),
        Value::String(text) => serde_json::from_str(&text).ok(),
        _ => None,
    }
}

/// An event log, sent as a JSON array or as a JSON string holding one. Any entry that is not an
/// event makes the whole log unreadable.
fn events(value: Value) -> Option<Vec<Event>> {
    match value {
        Value::String(text) => serde_json::from_str(&text).ok(),
        list => serde_json::from_value(list).ok(),
    }
}

fn deployment_log(value: Value) -> Option<DeploymentLog> {
    let Value::Object(mut map) = value else { return None };
    let report_data = match map.remove("report_data") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s).filter(|s| !s.is_empty()),
        Some(_) => return None,
    };
    let mut text = |key: &str| match map.remove(key) {
        Some(Value::String(s)) => Some(s),
        _ => None,
    };
    let (actions_hash, nonce, quote) = (text("actions_hash")?, text("nonce")?, text("quote")?);
    let actions = match map.remove("actions")? {
        Value::Array(list) => list.into_iter().map(|a| if let Value::Object(m) = a { Some(m) } else { None }).collect::<Option<Vec<_>>>()?,
        _ => return None,
    };
    let event_log = events(map.remove("event_log")?)?;
    Some(DeploymentLog { actions, actions_hash, nonce, quote: quote_bytes(&quote)?, event_log, report_data })
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
