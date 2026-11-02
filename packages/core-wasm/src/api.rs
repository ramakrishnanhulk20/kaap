//! The functions the bindings export, as plain Rust: JSON or text in, JSON or text out, and a fixed
//! error text out. Each one hands its input to one kaap-core function and adds no rule of its own,
//! so the CLI and the browser decide exactly what the sealed job decides (C14).
//!
//! Three things change shape on the way in, because JavaScript cannot carry them as they are: a
//! proposal kind and a policy arrive as their exact JSON text, a 64-bit time arrives as a decimal
//! string, and 32-byte values arrive as base64 or hex. Nothing an input says is ever copied into an
//! error, so an error can be shown without escaping attacker text.

use std::collections::BTreeSet;
use std::fmt;

use base64::Engine as _;
use kaap_core::hash::sign::to_hex;
use kaap_core::policy::arming::guard_arming as arming;
use kaap_core::policy::sputnik::to_policy_label;
use kaap_core::{
    analyze as analyze_input, canonical_kind as canon_kind, canonical_policy as canon_policy, describe,
    hash::{nep413_hash as nep413, nep461_hash as nep461},
    kind_hash as hash_kind, policy_hash as hash_policy, verdict_hash as hash_verdict, AiStatus, FindingCode, History,
    Network, Prices, ProposalInput, Severity, SuppliedText, TextStandard, Verdict,
};
use serde::de::{self, Deserializer, MapAccess, Visitor};
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{json, Value};

/// JavaScript numbers are exact only up to 2^53 - 1, so any larger id is refused rather than
/// handed back rounded.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// A Sputnik proposal has about ten top-level fields (the sealed job's cap).
const MAX_PROPOSAL_FIELDS: usize = 32;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AnalyzeInput {
    network: Network,
    dao: String,
    proposal_id: u64,
    description: String,
    /// The exact text of `get_proposal(id).kind`.
    kind_json: String,
    /// The exact text of the policy before, read through kaap-core's canonical parser exactly as
    /// the sealed job reads it (standard 2). Absent or null means not known.
    #[serde(default)]
    policy_before_json: Option<String>,
    #[serde(default)]
    history: Option<History>,
    #[serde(default)]
    prices: Prices,
    #[serde(default)]
    dao_version: Option<String>,
    #[serde(default)]
    supplied_text: Option<TextInput>,
    #[serde(default)]
    guard_account: Option<String>,
    #[serde(default)]
    config_before: Option<Value>,
    /// Nanoseconds since 1970 as a decimal string.
    #[serde(default)]
    block_timestamp_ns: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TextInput {
    message: String,
    /// Base64 of the 32-byte nonce.
    nonce: String,
    recipient: String,
    standard: TextStandard,
    #[serde(default)]
    quotes: Vec<String>,
}

/// Runs `kaap_core::analyze` and returns `{analysis, kind_label, description}`, where
/// `description` holds the reasons the description check gave (`describe::outcome`) so a reader
/// can see why it agreed or contradicted. Errors on an input that does not read as the shape
/// above, a policy kaap-core cannot canonicalise, a nonce that is not 32 bytes of base64, or a
/// time that is not a whole number.
pub fn analyze(input_json: &str) -> Result<String, Error> {
    let input: AnalyzeInput = serde_json::from_str(input_json).map_err(|_| Error("the analyze input is not the expected shape"))?;
    let policy_before = match input.policy_before_json {
        None => None,
        Some(text) => Some(canonical_value(&text).ok_or(Error("policy_before_json is not a policy kaap-core can read"))?),
    };
    let supplied_text = match input.supplied_text {
        None => None,
        Some(t) => Some(SuppliedText {
            message: t.message,
            nonce: base64::engine::general_purpose::STANDARD
                .decode(&t.nonce)
                .ok()
                .and_then(|n| <[u8; 32]>::try_from(n).ok())
                .ok_or(Error("supplied_text.nonce is not 32 bytes of base64"))?,
            recipient: t.recipient,
            standard: t.standard,
            quotes: t.quotes,
        }),
    };
    let block_timestamp_ns = match input.block_timestamp_ns {
        None => None,
        Some(text) => Some(text.parse::<u64>().map_err(|_| Error("block_timestamp_ns is not a whole number"))?),
    };
    let input = ProposalInput {
        network: input.network,
        dao: input.dao,
        proposal_id: input.proposal_id,
        description: input.description,
        kind_json: input.kind_json.into_bytes(),
        policy_before,
        history: input.history,
        prices: input.prices,
        dao_version: input.dao_version,
        supplied_text,
        guard_account: input.guard_account,
        config_before: input.config_before,
        block_timestamp_ns,
    };
    let analysis = analyze_input(&input);
    let outcome = describe::outcome(&input, &analysis.effects);
    to_json(&json!({
        "analysis": analysis,
        "kind_label": to_policy_label(&input.kind_json),
        "description": {
            "agreements": outcome.agreements,
            "contradictions": outcome.contradictions,
            "injection": outcome.injection,
        },
    }))
}

/// Reads a `get_proposal` answer the way the sealed job does (`reads::parse_proposal`): one JSON
/// object with unique keys and at most 32 fields, a whole-number `id`, a string `description` and
/// a `kind`. Returns `{id, proposer, description, kind_json, status, submission_time}` with
/// `kind_json` the exact text of the kind, never re-encoded (C5); `proposer`, `status` and
/// `submission_time` are empty when absent.
pub fn read_proposal(answer: &str) -> Result<String, Error> {
    let fields: Fields = serde_json::from_str(answer).map_err(|_| Error("the answer is not a proposal object"))?;
    let raw = |key: &str| fields.0.iter().find(|(k, _)| k == key).map(|(_, v)| v.get());
    let text = |key: &str| raw(key).and_then(|v| serde_json::from_str::<String>(v).ok());
    let id = raw("id")
        .and_then(|v| serde_json::from_str::<u64>(v).ok())
        .filter(|id| *id <= MAX_SAFE_INTEGER)
        .ok_or(Error("the answer has no whole-number id"))?;
    let description = text("description").ok_or(Error("the answer has no description"))?;
    let kind_json = raw("kind").ok_or(Error("the answer has no kind"))?;
    to_json(&json!({
        "id": id,
        "proposer": text("proposer").unwrap_or_default(),
        "description": description,
        "kind_json": kind_json,
        "status": text("status").unwrap_or_default(),
        "submission_time": text("submission_time").unwrap_or_default(),
    }))
}

/// kaap-core's NEAR account id rule (`decode::account::is_account_id`): syntax only.
pub fn is_account_id(id: &str) -> bool {
    kaap_core::decode::account::is_account_id(id)
}

pub fn canonical_kind(kind_json: &str) -> Result<String, Error> {
    canon_kind(kind_json.as_bytes()).map_err(|_| Error("the kind cannot be canonicalised")).and_then(utf8)
}

pub fn canonical_policy(policy_json: &str) -> Result<String, Error> {
    canon_policy(policy_json.as_bytes()).map_err(|_| Error("the policy cannot be canonicalised")).and_then(utf8)
}

/// Hex of `kaap_core::kind_hash`, the `kind_hash` a verdict carries.
pub fn kind_hash(kind_json: &str) -> Result<String, Error> {
    hash_kind(kind_json.as_bytes()).map(|h| to_hex(&h)).map_err(|_| Error("the kind cannot be canonicalised"))
}

/// Hex of `kaap_core::policy_hash`, the `policy_hash` a verdict carries.
pub fn policy_hash(policy_json: &str) -> Result<String, Error> {
    hash_policy(policy_json.as_bytes()).map(|h| to_hex(&h)).map_err(|_| Error("the policy cannot be canonicalised"))
}

/// Hex of the NEP-413 hash of a message, a base64 32-byte nonce, a recipient and an optional
/// callback URL. The message is hashed exactly as given.
pub fn nep413_hash(message: &str, nonce_b64: &str, recipient: &str, callback_url: Option<String>) -> Result<String, Error> {
    let nonce = base64::engine::general_purpose::STANDARD
        .decode(nonce_b64)
        .ok()
        .and_then(|n| <[u8; 32]>::try_from(n).ok())
        .ok_or(Error("the nonce is not 32 bytes of base64"))?;
    Ok(to_hex(&nep413(message, &nonce, recipient, callback_url.as_deref())))
}

/// Hex of the NEP-461 hash of a borsh delegate action given as base64.
pub fn nep461_hash(delegate_b64: &str) -> Result<String, Error> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(delegate_b64)
        .map_err(|_| Error("the delegate action is not base64"))?;
    Ok(to_hex(&nep461(&bytes)))
}

/// A verdict as the worker writes it: the four 32-byte fields in lower-case hex.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VerdictInput {
    version: u8,
    guard: String,
    network: Network,
    dao: String,
    proposal_id: u64,
    kind_hash: String,
    policy_hash: String,
    receivers_hash: String,
    block_height: u64,
    risk: Severity,
    floor: Severity,
    findings: Vec<FindingCode>,
    decoder_version: String,
    model_id: String,
    ai_status: AiStatus,
    explanation_hash: String,
    expires_at_ms: u64,
}

/// Hex of `kaap_core::verdict_hash`, the id the guard records against a second use.
pub fn verdict_hash(verdict_json: &str) -> Result<String, Error> {
    let v: VerdictInput = serde_json::from_str(verdict_json).map_err(|_| Error("the verdict is not the expected shape"))?;
    let verdict = Verdict {
        version: v.version,
        guard: v.guard,
        network: v.network,
        dao: v.dao,
        proposal_id: v.proposal_id,
        kind_hash: hex32(&v.kind_hash)?,
        policy_hash: hex32(&v.policy_hash)?,
        receivers_hash: hex32(&v.receivers_hash)?,
        block_height: v.block_height,
        risk: v.risk,
        floor: v.floor,
        findings: v.findings,
        decoder_version: v.decoder_version,
        model_id: v.model_id,
        ai_status: v.ai_status,
        explanation_hash: hex32(&v.explanation_hash)?,
        expires_at_ms: v.expires_at_ms,
    };
    Ok(to_hex(&hash_verdict(&verdict)))
}

/// `kaap_core::policy::arming::guard_arming` for `guard` under the policy text, read through the
/// canonical parser. Vote counts are decimal strings, and "none" where nothing can pass a kind.
pub fn guard_arming(policy_json: &str, guard: &str) -> Result<String, Error> {
    let policy = canonical_value(policy_json).ok_or(Error("the policy cannot be read"))?;
    let a = arming(&policy, guard);
    let needed: serde_json::Map<String, Value> = a
        .approval_votes_needed
        .iter()
        .map(|(label, n)| (label.clone(), json!(if *n == u128::MAX { "none".to_string() } else { n.to_string() })))
        .collect();
    to_json(&json!({
        "rejects_alone": a.rejects_alone,
        "cannot_reject": a.cannot_reject,
        "extra_rights": a.extra_rights,
        "others_who_reject_alone": a.others_who_reject_alone,
        "approval_votes_needed": needed,
        "race_note": a.race_note,
    }))
}

/// USD prices from a 1Click `GET /v0/tokens` list, keyed the way the guide writes tokens: the
/// `nep141:` prefix dropped and every other id kept whole. A missing, zero or non-finite price is
/// left out, so the token reads as unpriced (C2: never "0 USD"). Native NEAR is priced as
/// `wrap.near`, which wraps it one to one. The same mapping as kaap-core's test helper
/// `census_prices`, so the evaluation and a live check price tokens alike.
pub fn prices_from_tokens(tokens_json: &str) -> Result<Prices, Error> {
    let list: Vec<Value> = serde_json::from_str(tokens_json).map_err(|_| Error("the token list is not a JSON list"))?;
    let mut prices = Prices::default();
    for token in &list {
        let (Some(id), Some(decimals), Some(usd)) = (token["assetId"].as_str(), token["decimals"].as_u64(), token["price"].as_f64()) else {
            continue;
        };
        let Ok(decimals) = u8::try_from(decimals) else { continue };
        if !(usd.is_finite() && usd > 0.0) {
            continue;
        }
        let key = id.strip_prefix("nep141:").unwrap_or(id);
        prices.usd_by_token.entry(key.to_string()).or_insert((decimals, usd));
    }
    if let Some(&wrapped) = prices.usd_by_token.get("wrap.near") {
        prices.usd_by_token.insert("near".into(), wrapped);
    }
    Ok(prices)
}

pub fn prices_json(tokens_json: &str) -> Result<String, Error> {
    to_json(&prices_from_tokens(tokens_json)?)
}

/// A fixed error text. Never built from input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Error(pub &'static str);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

fn canonical_value(policy_json: &str) -> Option<Value> {
    canon_policy(policy_json.as_bytes()).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

fn utf8(bytes: Vec<u8>) -> Result<String, Error> {
    String::from_utf8(bytes).map_err(|_| Error("the canonical form is not UTF-8"))
}

fn to_json<T: serde::Serialize>(value: &T) -> Result<String, Error> {
    serde_json::to_string(value).map_err(|_| Error("the answer could not be written"))
}

fn hex32(text: &str) -> Result<[u8; 32], Error> {
    let bytes = text.as_bytes();
    if bytes.len() != 64 {
        return Err(Error("a hash field is not 64 hex characters"));
    }
    let nibble = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    };
    let mut out = [0u8; 32];
    for (i, pair) in bytes.chunks(2).enumerate() {
        match (nibble(pair[0]), nibble(pair[1])) {
            (Some(hi), Some(lo)) => out[i] = hi << 4 | lo,
            _ => return Err(Error("a hash field is not lower-case hex")),
        }
    }
    Ok(out)
}

/// A JSON object's top-level fields with each value's exact text. A duplicate key is refused, so
/// two readers can never take one answer two ways (standard 2).
struct Fields(Vec<(String, Box<RawValue>)>);

impl<'de> Deserialize<'de> for Fields {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct FieldsVisitor;
        impl<'de> Visitor<'de> for FieldsVisitor {
            type Value = Fields;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a JSON object with unique keys")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Fields, A::Error> {
                let mut seen = BTreeSet::new();
                let mut fields = Vec::new();
                while let Some(key) = map.next_key::<String>()? {
                    if !seen.insert(key.clone()) {
                        return Err(de::Error::custom("duplicate key"));
                    }
                    if fields.len() == MAX_PROPOSAL_FIELDS {
                        return Err(de::Error::custom("too many fields"));
                    }
                    fields.push((key, map.next_value::<Box<RawValue>>()?));
                }
                Ok(Fields(fields))
            }
        }
        d.deserialize_map(FieldsVisitor)
    }
}
