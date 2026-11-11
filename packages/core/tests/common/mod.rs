//! Turns answer-key records (guide v2.3 section 8) into `ProposalInput`, for the decoder tests
//! and the evaluation runner alike, so both feed `analyze` the same way.

#![allow(dead_code)]

use std::path::{Path, PathBuf};

use base64::Engine as _;
use kaap_core::*;
use serde_json::Value;

pub const REAL: &str = "eval/real/labels.jsonl";
pub const PLANTED: &str = "eval/planted/labels.jsonl";

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

/// One `Value` per non-blank line, or the first line that is not JSON.
pub fn read_jsonl(path: &Path) -> Result<Vec<Value>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    text.lines()
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty())
        .map(|(n, line)| {
            serde_json::from_str(line).map_err(|e| format!("{} line {}: {e}", path.display(), n + 1))
        })
        .collect()
}

/// The record with this `id` in a labels file under the repo root. Panics if it is missing,
/// which in a test means the answer key changed under it.
pub fn record(file: &str, id: &str) -> Value {
    read_jsonl(&repo_root().join(file))
        .unwrap()
        .into_iter()
        .find(|r| r["id"] == id)
        .unwrap_or_else(|| panic!("{id} is not in {file}"))
}

/// Builds the input `analyze` sees for a record. Planted records have no `proposal_id`; their
/// number comes from the id (`planted:17` is 17). A supplied text without a `standard` is
/// NEP-413, the standard of every planted hash record (a message, a 32-byte nonce and a
/// recipient).
pub fn input_of(record: &Value, prices: &Prices) -> Result<ProposalInput, String> {
    let text = |v: &Value, what: &str| {
        v.as_str().map(str::to_string).ok_or_else(|| format!("{what} is not a string"))
    };
    let context = &record["context"];
    let proposal_id = match record.get("proposal_id").and_then(Value::as_u64) {
        Some(id) => id,
        None => text(&record["id"], "id")?
            .rsplit(':')
            .next()
            .and_then(|n| n.parse().ok())
            .ok_or("no proposal id")?,
    };
    let history = match (&context["history_available"], &context["history"]) {
        (Value::Bool(true), h @ Value::Object(_)) => {
            Some(serde_json::from_value(h.clone()).map_err(|e| format!("history: {e}"))?)
        }
        _ => None,
    };
    let supplied_text = match record.get("supplied_text") {
        None | Some(Value::Null) => None,
        Some(t) => Some(supplied(t)?),
    };
    Ok(ProposalInput {
        network: serde_json::from_value(record["network"].clone()).map_err(|e| format!("network: {e}"))?,
        dao: text(&record["dao"], "dao")?,
        proposal_id,
        description: text(&record["description"], "description")?,
        kind_json: serde_json::to_vec(&record["kind"]).map_err(|e| e.to_string())?,
        policy_before: match &context["policy_before"] {
            Value::Null => None,
            p => Some(p.clone()),
        },
        history,
        prices: prices.clone(),
        dao_version: context["dao_version"].as_str().map(str::to_string),
        supplied_text,
        guard_account: None,
        config_before: None,
        block_timestamp_ns: None,
    })
}

fn supplied(t: &Value) -> Result<SuppliedText, String> {
    let field = |name: &str| t[name].as_str().ok_or_else(|| format!("supplied_text.{name} missing"));
    let nonce = base64::engine::general_purpose::STANDARD
        .decode(field("nonce")?)
        .map_err(|e| format!("supplied_text.nonce: {e}"))?;
    Ok(SuppliedText {
        message: field("message")?.to_string(),
        nonce: nonce.try_into().map_err(|_| "supplied_text.nonce is not 32 bytes")?,
        recipient: field("recipient")?.to_string(),
        standard: match t.get("standard") {
            None | Some(Value::Null) => TextStandard::Nep413,
            Some(s) => serde_json::from_value(s.clone()).map_err(|e| format!("standard: {e}"))?,
        },
        quotes: Vec::new(),
    })
}

/// The label's effects, read through the same `Effect` type the decoder returns.
pub fn label_effects(record: &Value) -> Vec<Effect> {
    serde_json::from_value(record["label"]["effects"].clone()).unwrap()
}

pub fn codes(analysis: &Analysis) -> Vec<FindingCode> {
    analysis.findings.iter().map(|f| f.code).collect()
}

/// USD prices from the census token list (`tests/fixtures/tokens.json`, 1Click's
/// `GET https://1click.chaindefuser.com/v0/tokens` as read on 20 Oct 2026), keyed the way the
/// guide writes tokens: `nep141:` dropped, every other id kept whole. A missing, zero or
/// non-finite price is left out, so the token reads as unpriced (C2: never "0 USD"). Native NEAR
/// is not in the list; it is priced as `wrap.near`, which wraps it one to one with the same 24
/// decimals.
pub fn census_prices() -> Prices {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("tokens.json");
    let list: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let mut prices = Prices::default();
    for token in &list {
        let (Some(id), Some(decimals), Some(usd)) =
            (token["assetId"].as_str(), token["decimals"].as_u64(), token["price"].as_f64())
        else {
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
    prices
}
