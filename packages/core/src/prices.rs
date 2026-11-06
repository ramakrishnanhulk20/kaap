//! USD prices from a 1Click `GET /v0/tokens` list. The CLI, the browser, the evaluation and the
//! sealed job all read the list through this one function, so a token is priced alike everywhere.

use serde_json::Value;

use crate::types::Prices;

/// The price table, keyed the way the guide writes tokens: the `nep141:` prefix dropped and every
/// other id kept whole. `None` when the text is not a JSON list. A missing, zero or non-finite price
/// is left out, so the token reads as unpriced (C2: never "0 USD"). Native NEAR is priced as
/// `wrap.near`, which wraps it one to one. The same mapping as kaap-core's test helper
/// `census_prices`, so the evaluation and a live check price tokens alike.
pub fn prices_from_tokens(tokens_json: &str) -> Option<Prices> {
    let list: Vec<Value> = serde_json::from_str(tokens_json).ok()?;
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
    Some(prices)
}
