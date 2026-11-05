//! A compact JWT read once, so the bytes whose signature is checked are the bytes whose claims
//! are read (standard 2). Signature algorithms live with their issuers (`ita.rs`, `gpu.rs`).

use base64::Engine as _;
use serde_json::Value;

/// The three parts of a token: header and claims as JSON objects, the exact `header.payload`
/// bytes the signature covers, and the decoded signature.
pub struct Jwt<'a> {
    pub header: Value,
    pub claims: Value,
    pub signed: &'a [u8],
    pub signature: Vec<u8>,
}

fn b64url(part: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(part).ok()
}

fn object(part: &str) -> Option<Value> {
    serde_json::from_slice::<Value>(&b64url(part)?).ok().filter(Value::is_object)
}

/// Splits `token`, or `None` when it is over `max` bytes, not exactly three base64url parts
/// without padding, or its header or claims are not JSON objects.
pub fn split(token: &str, max: usize) -> Option<Jwt<'_>> {
    if token.len() > max {
        return None;
    }
    let parts: Vec<&str> = token.split('.').collect();
    let [head, body, signature] = parts.as_slice() else {
        return None;
    };
    Some(Jwt {
        header: object(head)?,
        claims: object(body)?,
        signed: &token.as_bytes()[..head.len() + 1 + body.len()],
        signature: b64url(signature)?,
    })
}

/// The one key in a JWKS whose `kid` is `kid`: none, or the same kid twice, is `None`.
pub fn one_key<'a>(keys: &'a Value, kid: &str) -> Option<&'a Value> {
    let mut found = keys.get("keys")?.as_array()?.iter().filter(|k| k.get("kid").and_then(Value::as_str) == Some(kid));
    match (found.next(), found.next()) {
        (Some(key), None) => Some(key),
        _ => None,
    }
}

/// A key's base64url field, decoded.
pub fn key_bytes(key: &Value, field: &str) -> Option<Vec<u8>> {
    b64url(key.get(field)?.as_str()?)
}

/// True when the claims are current at `now`: `exp` is present and still ahead, and `nbf` and
/// `iat`, when present, are no further ahead than `leeway` (tokens are minted during the run, after
/// the block whose time `now` is).
pub fn current(claims: &Value, now: u64, leeway: u64) -> bool {
    let at = |name: &str| claims.get(name).map(Value::as_u64);
    let not_ahead = |t: Option<Option<u64>>| match t {
        None => true,
        Some(Some(t)) => t <= now.saturating_add(leeway),
        Some(None) => false,
    };
    matches!(at("exp"), Some(Some(exp)) if exp > now) && not_ahead(at("nbf")) && not_ahead(at("iat"))
}
