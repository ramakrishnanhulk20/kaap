//! 1Click quotes: the only way a transfer to a 1Click deposit address names its real payee (C7).
//!
//! A quote counts only when its signature checks against 1Click's key pinned here, never a key
//! the response carries (A8), over the payload 1Click's own SDK rebuilds (`verifyQuoteSignature`,
//! quote-signature.ts): the signed request fields, the signed quote fields and the timestamp, as
//! key-sorted JSON, hashed with sha256, written in base58, and that text signed with ed25519.
//! Only a full (not dry) quote names a deposit address.
//!
//! What it does not prove: that the deposit address was quoted for this DAO, or what happens to
//! the funds after 1Click receives them (threat model non-goal: a cross-chain withdrawal is not
//! followed past its quote). A number that JavaScript would print differently from Rust (a
//! fraction in exponent form) makes the check fail, which leaves the address unmapped.

use ed25519_dalek::{Signature, VerifyingKey};
use num_bigint::BigUint;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::text::rfc3339_ns;
use crate::decode::json::{self, Parsed};
use crate::decode::value::base_units;

/// 1Click's quote-signing key, `ONE_CLICK_MANAGER_PUB_KEY` in
/// defuse-protocol/one-click-sdk-typescript `src/quote-signature.ts`, re-checked on 2 Nov 2026
/// at HEAD ae8b24e (22 Sep 2026, the file's last change).
pub const ONE_CLICK_KEY: &str = "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";

/// A quote response longer than this is not read (standard 4); real ones are about 1.5 KiB.
const MAX_QUOTE_BYTES: usize = 16 * 1024;

/// Quotes read per text. Trezu's bulk route caps a payment list at 25.
pub const MAX_QUOTES: usize = 25;

/// Request fields the SDK signs as they are (`buildSignedQuoteRequest`).
const REQUEST_FIELDS: [&str; 12] = [
    "dry",
    "swapType",
    "slippageTolerance",
    "originAsset",
    "depositType",
    "destinationAsset",
    "amount",
    "refundTo",
    "refundType",
    "recipient",
    "recipientType",
    "deadline",
];

/// Request fields the SDK signs only when they are truthy in JavaScript.
const REQUEST_FIELDS_IF_SET: [&str; 5] =
    ["quoteWaitingTimeMs", "referral", "virtualChainRecipient", "virtualChainRefundRecipient", "customRecipientMsg"];

/// Quote fields signed for every quote (`buildSignedQuote`).
const QUOTE_FIELDS: [&str; 8] = [
    "amountIn",
    "amountInFormatted",
    "amountInUsd",
    "minAmountIn",
    "amountOut",
    "amountOutFormatted",
    "amountOutUsd",
    "minAmountOut",
];

/// Quote fields signed for a full quote only when truthy; a falsy `deadline` here also removes
/// the request's `deadline`, because the SDK spreads the quote over the request.
const QUOTE_FIELDS_IF_SET: [&str; 7] =
    ["depositAddress", "depositMemo", "deadline", "timeWhenInactive", "timeEstimate", "refundFee", "withdrawFee"];

/// What a verified full quote says about its deposit address.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Quote {
    pub deposit_address: String,
    /// The asset id the payer sends, as 1Click writes it (`nep141:wrap.near`).
    pub origin_asset: String,
    pub amount_in: BigUint,
    pub deadline_ns: i128,
    pub destination_asset: String,
    pub recipient: String,
    pub recipient_type: String,
}

/// Every quote in `responses` whose signature checks against `ONE_CLICK_KEY`.
pub fn verified(responses: &[String]) -> Vec<Quote> {
    responses.iter().take(MAX_QUOTES).filter_map(|r| verify(r, ONE_CLICK_KEY)).collect()
}

/// The quote in `response` when its signature checks against `key` and it is a full quote with
/// a deposit address, an origin asset, a whole-number `amountIn`, an RFC 3339 deadline, a
/// destination asset and a recipient. `None` for anything else.
pub fn verify(response: &str, key: &str) -> Option<Quote> {
    if response.len() > MAX_QUOTE_BYTES {
        return None;
    }
    let Parsed::Json(Value::Object(response)) = json::parse(response.as_bytes()) else {
        return None;
    };
    let message = signed_message(&response)?;
    let signature = Signature::from_bytes(&ed25519_bytes(response.get("signature")?.as_str()?)?);
    let key = VerifyingKey::from_bytes(&ed25519_bytes(key)?).ok()?;
    key.verify_strict(message.as_bytes(), &signature).ok()?;

    let request = response.get("quoteRequest")?.as_object()?;
    let quote = response.get("quote")?.as_object()?;
    if request.get("dry")?.as_bool()? {
        return None;
    }
    let text = |fields: &Map<String, Value>, name: &str| fields.get(name)?.as_str().filter(|s| !s.is_empty()).map(str::to_string);
    Some(Quote {
        deposit_address: text(quote, "depositAddress")?,
        origin_asset: text(request, "originAsset")?,
        amount_in: base_units(&text(quote, "amountIn")?, 0)?,
        deadline_ns: rfc3339_ns(&text(quote, "deadline")?)?,
        destination_asset: text(request, "destinationAsset")?,
        recipient: text(request, "recipient")?,
        recipient_type: text(request, "recipientType")?,
    })
}

/// The text 1Click signs for `response`: base58 of sha256 of the key-sorted JSON of the signed
/// fields (`quoteHash`).
pub fn signed_message(response: &Map<String, Value>) -> Option<String> {
    let request = response.get("quoteRequest")?.as_object()?;
    let quote = response.get("quote")?.as_object()?;
    let dry = request.get("dry").and_then(Value::as_bool) == Some(true);
    let mut signed = Map::new();
    for name in REQUEST_FIELDS {
        if let Some(value) = request.get(name) {
            signed.insert(name.to_string(), value.clone());
        }
    }
    for name in REQUEST_FIELDS_IF_SET {
        if let Some(value) = request.get(name).filter(|v| truthy(v)) {
            signed.insert(name.to_string(), value.clone());
        }
    }
    for name in QUOTE_FIELDS {
        if let Some(value) = quote.get(name) {
            signed.insert(name.to_string(), value.clone());
        }
    }
    if !dry {
        for name in QUOTE_FIELDS_IF_SET {
            match quote.get(name).filter(|v| truthy(v)) {
                Some(value) => signed.insert(name.to_string(), value.clone()),
                None => signed.remove(name),
            };
        }
    }
    signed.insert("timestamp".into(), response.get("timestamp")?.clone());
    let mut text = String::new();
    stable_json(&Value::Object(signed), &mut text);
    Some(bs58::encode(Sha256::digest(text.as_bytes())).into_string())
}

/// JavaScript truthiness for a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `json-stable-stringify` with its defaults: object keys sorted by UTF-16 code unit, no spaces,
/// strings escaped as `JSON.stringify` escapes them (serde_json escapes the same characters), and
/// numbers as JavaScript prints them where the two agree.
fn stable_json(value: &Value, out: &mut String) {
    match value {
        Value::Object(fields) => {
            let mut keys: Vec<&String> = fields.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                stable_json(&fields[key], out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                stable_json(item, out);
            }
            out.push(']');
        }
        Value::Number(n) => match n.as_f64() {
            Some(f) if n.is_f64() && f.fract() == 0.0 && f.abs() < 1e21 => out.push_str(&format!("{f:.0}")),
            _ => out.push_str(&n.to_string()),
        },
        other => out.push_str(&other.to_string()),
    }
}

/// The 32 or 64 raw bytes of an `ed25519:<base58>` key or signature.
fn ed25519_bytes<const N: usize>(text: &str) -> Option<[u8; N]> {
    let encoded = text.strip_prefix("ed25519:").unwrap_or(text);
    bs58::decode(encoded).into_vec().ok()?.try_into().ok()
}

/// Omni Bridge tokens are `<stem>.omdep.near` or `<stem>-<address>.omdep.near` (NEAR Intents
/// changelog, 9 Nov 2026: BNB Chain, Polygon and Avalanche tokens moved here from HOT ids).
const OMDEP_SUFFIX: &str = ".omdep.near";

/// Omni's stem for a chain is not always the census name (`bnb` is `bsc`), so each stem maps to
/// the `blockchain` name 1Click's token list gives its tokens, which for `avax`, `bnb` and `pol`
/// is also the name `decode::intents`' HOT table gives the same chain. Stems checked against the
/// changelog's table and 1Click's token list on 11 Nov 2026.
///
/// `strk` is left out on purpose: 1Click lists strkBTC (`strk-0x....omdep.near`) as blockchain
/// `near`, but how it leaves NEAR is unproven, so a payout of it reads `unknown` and fails closed
/// with CROSS_CHAIN_OUT.
const OMNI_CHAINS: [(&str, &str); 7] = [
    ("abs", "abs"),
    ("avax", "avax"),
    ("base", "base"),
    ("bnb", "bsc"),
    ("fogo", "fogo"),
    ("pol", "pol"),
    ("sol", "sol"),
];

/// The census `blockchain` name of the Omni Bridge token `contract`, `unknown` for a stem not in
/// `OMNI_CHAINS`, and `None` when `contract` is not an Omni Bridge token. Never `near`: anything
/// under `omdep.near` is a bridged token. `decode::intents` names a withdrawal's chain with this
/// same function, so a quote and a withdrawal never read one token two ways.
pub(crate) fn omni_chain(contract: &str) -> Option<&'static str> {
    let stem = contract.strip_suffix(OMDEP_SUFFIX)?.split('-').next().unwrap_or_default();
    Some(OMNI_CHAINS.iter().find(|(omni, _)| *omni == stem).map_or("unknown", |(_, census)| *census))
}

/// The chain a quote pays out on, as the census `blockchain` name: `near` when the recipient is
/// an account inside NEAR Intents or the destination asset is a NEAR token, the bridge's chain for
/// a PoA bridge token (`nep141:eth-0x....omft.near` is `eth`), an Omni Bridge token
/// (`nep141:bnb.omdep.near` is `bsc`, `omni_chain`) or a 1Click asset id
/// (`1cs_v1:btc:native:coin` is `btc`), and `unknown` for anything else, which is never `near`, so
/// CROSS_CHAIN_OUT still fires.
pub fn payout_chain(quote: &Quote) -> String {
    if quote.recipient_type == "INTENTS" {
        return "near".into();
    }
    let asset = quote.destination_asset.as_str();
    let named = if let Some(rest) = asset.strip_prefix("1cs_v1:") {
        rest.split(':').next()
    } else if let Some(chain) = asset.strip_prefix("nep141:").and_then(omni_chain) {
        Some(chain)
    } else if let Some(contract) = asset.strip_prefix("nep141:") {
        match contract.strip_suffix(".omft.near") {
            Some(stem) => stem.split('-').next(),
            None if !contract.contains(':') => Some("near"),
            None => None,
        }
    } else {
        None
    };
    named
        .filter(|chain| !chain.is_empty() && chain.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
        .unwrap_or("unknown")
        .to_string()
}
