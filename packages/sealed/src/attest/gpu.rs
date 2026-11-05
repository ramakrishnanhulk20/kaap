//! The model's NVIDIA GPU evidence, judged by NVIDIA's Remote Attestation Service (NRAS) and then
//! checked here: NRAS's ES384 token verified against NVIDIA's published keys, its nonce, and its
//! overall verdict (docs.near.ai, "Quote, Nonce, and Signer Bindings"; NEAR AI's SDK guide).

use p384::ecdsa::signature::Verifier;
use p384::ecdsa::{Signature, VerifyingKey};
use serde_json::Value;

use super::jwt::{current, key_bytes, one_key, split};
use super::{hex_array, Unverified, CLOCK_LEEWAY_SECS};
use crate::net::{Deadline, Http, HttpFail, Limits, Method, Request, NVIDIA_KEYS, NVIDIA_NRAS};

pub const NRAS_ISSUER: &str = "https://nras.attestation.nvidia.com";

/// An eight-GPU payload goes up whole; NRAS answers with one overall token and one per GPU.
pub const NRAS_LIMITS: Limits = Limits {
    connect_ms: 5_000,
    first_byte_ms: 15_000,
    between_bytes_ms: 5_000,
    overall_ms: 20_000,
    max_body_bytes: 1024 * 1024,
};
/// NVIDIA's key set was 529,676 bytes with 215 rotating keys on 23 Oct 2026; the cap leaves it
/// room to grow fourfold.
pub const NVIDIA_KEYS_LIMITS: Limits = Limits {
    connect_ms: 5_000,
    first_byte_ms: 10_000,
    between_bytes_ms: 5_000,
    overall_ms: 15_000,
    max_body_bytes: 2 * 1024 * 1024,
};
pub const MAX_PAYLOAD_BYTES: usize = 1024 * 1024;
pub const MAX_TOKEN_BYTES: usize = 64 * 1024;

/// What NRAS's overall token showed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GpuFacts {
    pub passed: bool,
    pub iat: Option<u64>,
    pub exp: u64,
}

/// The payload a model candidate carries for NVIDIA, and how many GPUs it lists. The payload is
/// JSON text sent to NRAS unchanged; before it is sent, its `nonce` must be this run's
/// (`NonceMismatch`). None, empty, over `MAX_PAYLOAD_BYTES` or not a JSON object gives
/// `GpuEvidenceMissing`.
pub fn payload<'a>(nvidia_payload: Option<&'a str>, nonce: &[u8; 32]) -> Result<(&'a str, usize), Unverified> {
    let text = nvidia_payload.filter(|t| !t.is_empty() && t.len() <= MAX_PAYLOAD_BYTES).ok_or(Unverified::GpuEvidenceMissing)?;
    let value: Value = serde_json::from_str(text).map_err(|_| Unverified::GpuEvidenceMissing)?;
    if !value.is_object() {
        return Err(Unverified::GpuEvidenceMissing);
    }
    if value.get("nonce").and_then(Value::as_str).and_then(hex_array::<32>) != Some(*nonce) {
        return Err(Unverified::NonceMismatch);
    }
    let gpus = value.get("evidence_list").and_then(Value::as_array).map_or(0, Vec::len);
    Ok((text, gpus))
}

/// Sends the payload to NRAS. A failed call or a status other than 200 gives `GpuUnavailable`.
pub fn attest(http: &mut dyn Http, payload: &str, deadline: Deadline) -> Result<Vec<u8>, Unverified> {
    send(http, Request {
        method: Method::Post,
        endpoint: NVIDIA_NRAS,
        tail: "",
        headers: &[("content-type", "application/json"), ("accept", "application/json")],
        body: Some(payload.as_bytes()),
        keep_headers: &[],
        limits: NRAS_LIMITS.within(deadline),
    })
}

/// NVIDIA's current key set, fetched once per run and parsed. Unreadable gives `GpuUnavailable`.
pub fn fetch_keys(http: &mut dyn Http, deadline: Deadline) -> Result<Value, Unverified> {
    let body = send(http, Request {
        method: Method::Get,
        endpoint: NVIDIA_KEYS,
        tail: "",
        headers: &[("accept", "application/json")],
        body: None,
        keep_headers: &[],
        limits: NVIDIA_KEYS_LIMITS.within(deadline),
    })?;
    serde_json::from_slice(&body).map_err(|_| Unverified::GpuUnavailable)
}

fn send(http: &mut dyn Http, request: Request<'_>) -> Result<Vec<u8>, Unverified> {
    if request.limits.overall_ms == 0 {
        return Err(Unverified::Deadline);
    }
    match http.send(&request) {
        Ok(r) if r.status == 200 => Ok(r.body),
        Err(HttpFail::Timeout) => Err(Unverified::Deadline),
        _ => Err(Unverified::GpuUnavailable),
    }
}

/// Checks NRAS's answer at `now`: a JSON array whose first entry is `["JWT", <token>]`; that
/// token is ES384 by the one key in NVIDIA's set with its `kid`, issued by NRAS and current with
/// `CLOCK_LEEWAY_SECS` (`GpuTokenRejected`); its `eat_nonce` is this run's nonce
/// (`NonceMismatch`); and its `x-nvidia-overall-att-result` is `true` (`GpuNotTrusted`). The
/// per-GPU tokens after the first are not read, as in NEAR AI's SDK.
pub fn check(answer: &[u8], keys: &Value, nonce: &[u8; 32], now: u64) -> Result<GpuFacts, Unverified> {
    let rejected = Unverified::GpuTokenRejected;
    let answer: Value = serde_json::from_slice(answer).map_err(|_| rejected)?;
    let first = answer.as_array().and_then(|a| a.first()).and_then(Value::as_array).ok_or(rejected)?;
    let token = match first.as_slice() {
        [Value::String(kind), Value::String(token)] if kind == "JWT" => token,
        _ => return Err(rejected),
    };
    let jwt = split(token, MAX_TOKEN_BYTES).ok_or(rejected)?;
    if jwt.header.get("alg").and_then(Value::as_str) != Some("ES384") {
        return Err(rejected);
    }
    let kid = jwt.header.get("kid").and_then(Value::as_str).ok_or(rejected)?;
    let key = p384_key(one_key(keys, kid).ok_or(rejected)?).ok_or(rejected)?;
    let signature = Signature::from_slice(&jwt.signature).map_err(|_| rejected)?;
    key.verify(jwt.signed, &signature).map_err(|_| rejected)?;

    let claims = &jwt.claims;
    if claims.get("iss").and_then(Value::as_str) != Some(NRAS_ISSUER) || !current(claims, now, CLOCK_LEEWAY_SECS) {
        return Err(rejected);
    }
    if claims.get("eat_nonce").and_then(Value::as_str).and_then(hex_array::<32>) != Some(*nonce) {
        return Err(Unverified::NonceMismatch);
    }
    if claims.get("x-nvidia-overall-att-result") != Some(&Value::Bool(true)) {
        return Err(Unverified::GpuNotTrusted);
    }
    Ok(GpuFacts {
        passed: true,
        iat: claims.get("iat").and_then(Value::as_u64),
        exp: claims.get("exp").and_then(Value::as_u64).unwrap_or(0),
    })
}

/// A P-384 public key from its JWKS entry (`kty` EC, `crv` P-384, 48-byte `x` and `y`).
fn p384_key(jwk: &Value) -> Option<VerifyingKey> {
    let text = |name: &str| jwk.get(name).and_then(Value::as_str);
    if text("kty") != Some("EC") || text("crv") != Some("P-384") {
        return None;
    }
    let (x, y) = (key_bytes(jwk, "x")?, key_bytes(jwk, "y")?);
    if x.len() != 48 || y.len() != 48 {
        return None;
    }
    let point = [&[0x04][..], &x, &y].concat();
    VerifyingKey::from_sec1_bytes(&point).ok()
}
