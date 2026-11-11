//! NEAR AI's public Intel Trust Authority token (`GET /v1/attestation/ita-token`), shown as
//! gateway evidence and never as the model's: its "model" token carries the gateway's own TDX
//! quote and the gateway's key, not the model server's (seen in the live response, 23 Oct 2026).
//!
//! Intel signs with PS384 (RSASSA-PSS, SHA-384). Its keys are fetched from Intel's own URL on every
//! run and looked up by `kid`; the token's `jku` is only compared with that URL, never followed.

use base64::Engine as _;
use rsa::pss::{Signature, VerifyingKey};
use rsa::signature::Verifier;
use rsa::{BigUint, RsaPublicKey};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha512};
use sha2_digest10::Sha384;

use super::jwt::{current, key_bytes, one_key, split};
use super::{hex_array, tcb_accepted, Unverified, CLOCK_LEEWAY_SECS};
use crate::ai::{MODEL_ID, MODEL_ID_QUERY};
use crate::net::{Deadline, Http, HttpFail, Limits, Method, Request, INTEL_ITA_KEYS, NEAR_AI_ITA};

/// Intel's US region, the only one whose keys this job fetches. Exact strings: a trailing slash,
/// another case or another port is a different, refused value.
pub const ITA_ISSUER: &str = "https://portal.trustauthority.intel.com";
pub const ITA_KEYS_URL: &str = "https://portal.trustauthority.intel.com/certs";

/// The response held two tokens in 36,641 bytes on 23 Oct 2026; Intel's key set was 11,598 bytes.
pub const ITA_LIMITS: Limits = Limits {
    connect_ms: 5_000,
    first_byte_ms: 10_000,
    between_bytes_ms: 5_000,
    overall_ms: 15_000,
    max_body_bytes: 512 * 1024,
};
pub const ITA_KEYS_LIMITS: Limits = Limits {
    connect_ms: 5_000,
    first_byte_ms: 8_000,
    between_bytes_ms: 5_000,
    overall_ms: 10_000,
    max_body_bytes: 256 * 1024,
};
pub const MAX_TOKEN_BYTES: usize = 256 * 1024;
pub const MAX_MODEL_TOKENS: usize = 4;

/// What the gateway's token showed, all of it signed by Intel.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GatewayFacts {
    pub tcb_status: String,
    pub tcb_date: Option<String>,
    pub advisory_ids: Vec<String>,
    /// The gateway's own signing key, never the model's.
    pub signing_address: [u8; 32],
    pub kid: String,
    pub iat: u64,
    pub exp: u64,
    /// Intel's own appraisal of NVIDIA GPUs from the "model" token (count, overall result). It is
    /// bound to Intel's nonce and the gateway's quote, not to the model's machine.
    pub gpus: Option<(usize, bool)>,
}

/// Fetches the token response (no key: the endpoint is public) and Intel's current key set. Any
/// failed call or status other than 200 gives `GatewayUnavailable`.
pub fn fetch(http: &mut dyn Http, nonce: &[u8; 32], deadline: Deadline) -> Result<(Vec<u8>, Vec<u8>), Unverified> {
    let tail = format!("?model={MODEL_ID_QUERY}&signing_algo=ed25519&nonce={}", hex::encode(nonce));
    let token = get(http, Request {
        method: Method::Get,
        endpoint: NEAR_AI_ITA,
        tail: &tail,
        headers: &[("accept", "application/json"), ("x-no-aliasing", "true")],
        body: None,
        keep_headers: &[],
        limits: ITA_LIMITS.within(deadline),
    })?;
    let keys = get(http, Request {
        method: Method::Get,
        endpoint: INTEL_ITA_KEYS,
        tail: "",
        headers: &[("accept", "application/json")],
        body: None,
        keep_headers: &[],
        limits: ITA_KEYS_LIMITS.within(deadline),
    })?;
    Ok((token, keys))
}

fn get(http: &mut dyn Http, request: Request<'_>) -> Result<Vec<u8>, Unverified> {
    if request.limits.overall_ms == 0 {
        return Err(Unverified::Deadline);
    }
    match http.send(&request) {
        Ok(r) if r.status == 200 => Ok(r.body),
        Err(HttpFail::Timeout) => Err(Unverified::Deadline),
        _ => Err(Unverified::GatewayUnavailable),
    }
}

#[derive(Deserialize)]
struct RawResponse {
    gateway: RawToken,
    #[serde(default)]
    models: Vec<RawModelToken>,
}

#[derive(Deserialize)]
struct RawToken {
    token: String,
}

#[derive(Deserialize)]
struct RawModelToken {
    model: String,
    token: String,
}

/// Checks the gateway token and every model token in `response` against Intel's `keys` at `now`.
///
/// Each token, in order: PS384 by the one key in Intel's set with its `kid`, `jku` and `iss` on
/// Intel's US region, current with `CLOCK_LEEWAY_SECS` (`GatewayTokenRejected`); carrying this
/// run's nonce (`NonceMismatch`); not debuggable (`GatewayTokenRejected`); TCB level accepted
/// (`TcbNotAccepted`); report data rebuilt in Intel's layout from its claims (`GatewayLayout`); and
/// Intel's GPU result, when present, true (`GpuNotTrusted`). A model token must name `MODEL_ID`.
/// An unreadable response or key set gives `GatewayTokenRejected` or `GatewayUnavailable`.
pub fn check(response: &[u8], keys: &[u8], nonce: &[u8; 32], now: u64) -> Result<GatewayFacts, Unverified> {
    let keys: Value = serde_json::from_slice(keys).map_err(|_| Unverified::GatewayUnavailable)?;
    let raw: RawResponse = serde_json::from_slice(response).map_err(|_| Unverified::GatewayTokenRejected)?;
    if raw.models.len() > MAX_MODEL_TOKENS {
        return Err(Unverified::GatewayTokenRejected);
    }
    let mut gateway = check_token(&raw.gateway.token, &keys, nonce, now)?;
    for model in &raw.models {
        if model.model != MODEL_ID {
            return Err(Unverified::GatewayTokenRejected);
        }
        let facts = check_token(&model.token, &keys, nonce, now)?;
        gateway.gpus = gateway.gpus.or(facts.gpus);
    }
    Ok(gateway)
}

fn check_token(token: &str, keys: &Value, nonce: &[u8; 32], now: u64) -> Result<GatewayFacts, Unverified> {
    let rejected = Unverified::GatewayTokenRejected;
    let jwt = split(token, MAX_TOKEN_BYTES).ok_or(rejected)?;
    let field = |v: &Value, name: &str| v.get(name).and_then(Value::as_str).map(str::to_string);
    if field(&jwt.header, "alg").as_deref() != Some("PS384") || field(&jwt.header, "jku").as_deref() != Some(ITA_KEYS_URL) {
        return Err(rejected);
    }
    let kid = field(&jwt.header, "kid").ok_or(rejected)?;
    let key = rsa_key(one_key(keys, &kid).ok_or(rejected)?).ok_or(rejected)?;
    let signature = Signature::try_from(jwt.signature.as_slice()).map_err(|_| rejected)?;
    VerifyingKey::<Sha384>::new(key).verify(jwt.signed, &signature).map_err(|_| rejected)?;

    let claims = &jwt.claims;
    if field(claims, "iss").as_deref() != Some(ITA_ISSUER) || !current(claims, now, CLOCK_LEEWAY_SECS) {
        return Err(rejected);
    }
    let tdx = claims.get("tdx").ok_or(rejected)?;
    let runtime = tdx.get("attester_runtime_data").ok_or(rejected)?;
    let caller_nonce = field(runtime, "caller_nonce").ok_or(rejected)?;
    if hex_array::<32>(&caller_nonce) != Some(*nonce) {
        return Err(Unverified::NonceMismatch);
    }
    if tdx.get("tdx_is_debuggable") != Some(&Value::Bool(false)) {
        return Err(rejected);
    }
    let tcb_status = field(tdx, "attester_tcb_status").ok_or(rejected)?;
    if !tcb_accepted(&tcb_status) {
        return Err(Unverified::TcbNotAccepted);
    }
    let algo = field(runtime, "signing_algo").ok_or(rejected)?;
    let address = field(runtime, "signing_address").ok_or(rejected)?;
    let verifier = tdx.get("verifier_nonce").ok_or(rejected)?;
    let rebuilt = gateway_report_data(
        &field(verifier, "val").ok_or(rejected)?,
        &field(verifier, "iat").ok_or(rejected)?,
        &algo,
        &address,
        &caller_nonce,
    );
    let claimed = field(tdx, "tdx_report_data").and_then(|t| hex_array::<64>(&t));
    if rebuilt.is_none() || rebuilt != claimed {
        return Err(Unverified::GatewayLayout);
    }

    let gpus = match claims.get("nvgpu") {
        None => None,
        Some(gpu) => {
            let passed = gpu.get("x-nvidia-overall-att-result") == Some(&Value::Bool(true));
            if !passed {
                return Err(Unverified::GpuNotTrusted);
            }
            Some((gpu.get("claim_details").and_then(Value::as_object).map_or(0, |m| m.len()), passed))
        }
    };
    let date_ok = |d: &String| d.len() <= 32 && d.bytes().all(|b| b.is_ascii_alphanumeric() || b"-:+.".contains(&b));
    Ok(GatewayFacts {
        tcb_status,
        tcb_date: field(tdx, "attester_tcb_date").filter(date_ok),
        advisory_ids: super::tdx::advisories(
            &tdx.get("attester_advisory_ids")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>())
                .unwrap_or_default(),
        ),
        signing_address: hex_array::<32>(&address).ok_or(Unverified::GatewayLayout)?,
        kid: kid.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '.').take(128).collect(),
        iat: claims.get("iat").and_then(Value::as_u64).unwrap_or(0),
        exp: claims.get("exp").and_then(Value::as_u64).unwrap_or(0),
        gpus,
    })
}

/// Intel's RSA signing key from its JWKS entry: `kty` RSA, `alg` PS384 and `use` sig when given.
fn rsa_key(jwk: &Value) -> Option<RsaPublicKey> {
    let text = |name: &str| jwk.get(name).and_then(Value::as_str);
    if text("kty") != Some("RSA") || text("alg").is_some_and(|a| a != "PS384") || text("use").is_some_and(|u| u != "sig") {
        return None;
    }
    let n = BigUint::from_bytes_be(&key_bytes(jwk, "n")?);
    let e = BigUint::from_bytes_be(&key_bytes(jwk, "e")?);
    RsaPublicKey::new(n, e).ok()
}

/// The gateway's TDX report data in Intel's layout, rebuilt from the token's claims:
/// `SHA-512(base64decode(verifier_nonce.val) || base64decode(verifier_nonce.iat) || runtime JSON)`,
/// where the runtime JSON is `{"signing_algo":..,"signing_address":..,"caller_nonce":..}` compact,
/// in that key order. Intel's TDX adapter documents the hash; the key order is NEAR's and was
/// observed on two live samples on 23 Oct 2026, not documented, so any other order fails.
///
/// Returns `None`, so the caller refuses, when either nonce part is not standard base64, or a
/// runtime value is anything but `ed25519` and lowercase-or-uppercase hex of the right length:
/// only such values can be placed in the JSON without escaping, so the bytes rebuilt are the
/// bytes Intel hashed.
pub fn gateway_report_data(
    verifier_val_b64: &str,
    verifier_iat_b64: &str,
    signing_algo: &str,
    signing_address: &str,
    caller_nonce: &str,
) -> Option<[u8; 64]> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let hex_of = |s: &str, len: usize| s.len() == len && s.bytes().all(|b| b.is_ascii_hexdigit());
    if signing_algo != "ed25519" || !hex_of(signing_address, 64) || !hex_of(caller_nonce, 64) {
        return None;
    }
    let val = b64.decode(verifier_val_b64).ok()?;
    let iat = b64.decode(verifier_iat_b64).ok()?;
    let runtime = format!(
        r#"{{"signing_algo":"{signing_algo}","signing_address":"{signing_address}","caller_nonce":"{caller_nonce}"}}"#
    );
    let mut hash = Sha512::new();
    hash.update(&val);
    hash.update(&iat);
    hash.update(runtime.as_bytes());
    let mut out = [0u8; 64];
    out.copy_from_slice(&hash.finalize());
    Some(out)
}
