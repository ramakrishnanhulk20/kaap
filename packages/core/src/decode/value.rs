//! Effects and findings for every kind that is not a policy kind and not a sign call: payments,
//! token and intents calls, wrapping, staking, storage deposits, DeFi and bulk payments (guide
//! section 3). FunctionCall actions to `v1.signer` method `sign` belong to `hash::check`, and
//! this module emits nothing for them.
//!
//! Today it reads the Transfer kind. FunctionCall kinds come with WO-03a; until then `analyze`
//! gives them its high fallback finding.

use num_bigint::BigUint;
use serde_json::Value;

use crate::canonical::canonical_kind;
use crate::types::{Effect, FindingCode, ProposalInput};

/// Sputnik stores native NEAR as an empty `token_id` (`OLD_BASE_TOKEN`); the guide writes it
/// `near`.
const NATIVE: &str = "near";

/// Integer digits plus decimals above this are refused before any big-number work (standard 4).
/// u128, the widest amount Sputnik stores, has 39 digits, and real tokens use at most 24 decimals.
const MAX_AMOUNT_DIGITS: usize = 96;

/// Returns this module's effects and findings for `input`.
pub fn decode(input: &ProposalInput) -> (Vec<Effect>, Vec<FindingCode>) {
    match read_kind(&input.kind_json) {
        Some((variant, body)) if variant == "Transfer" => transfer(&body, input),
        _ => (Vec::new(), Vec::new()),
    }
}

/// Reads a kind as its variant name and body (`Value::Null` for a bare-string kind such as
/// `"Vote"`). The bytes go through `canonical::canonical_kind` first, so every module decodes the
/// same bytes the verdict hashes, and anything that strict parser refuses (a duplicate key, a
/// fractional number, over 256 KiB) reads as `None`, never as a lenient second reading.
pub fn read_kind(kind_json: &[u8]) -> Option<(String, Value)> {
    let canonical = canonical_kind(kind_json).ok()?;
    match serde_json::from_slice::<Value>(&canonical).ok()? {
        Value::String(variant) => Some((variant, Value::Null)),
        Value::Object(map) if map.len() == 1 => map.into_iter().next(),
        _ => None,
    }
}

/// The one parser for token amounts (standard 2): every amount in a kind and every amount stated
/// in a description becomes whole base units through this function, never through a float.
///
/// `text` is ASCII digits with at most one `.` followed by at least one digit; no sign, no
/// exponent, no separators, no spaces. `decimals` shifts it into base units, so
/// `base_units("0.10", 24)` is 10^23 and `base_units("5000000", 0)` is 5000000. Returns `None`
/// for anything else, for more fraction digits than `decimals` (not a whole number of base
/// units), and for more than `MAX_AMOUNT_DIGITS` digits in all.
pub fn base_units(text: &str, decimals: u32) -> Option<BigUint> {
    let (whole, fraction) = match text.split_once('.') {
        Some((whole, fraction)) if !fraction.is_empty() => (whole, fraction),
        Some(_) => return None,
        None => (text, ""),
    };
    let all_digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    let decimals = usize::try_from(decimals).ok()?;
    if whole.is_empty()
        || !all_digits(whole)
        || !all_digits(fraction)
        || fraction.len() > decimals
        || whole.len().checked_add(decimals)? > MAX_AMOUNT_DIGITS
    {
        return None;
    }
    let mut digits = String::with_capacity(whole.len() + decimals);
    digits.push_str(whole);
    digits.push_str(fraction);
    digits.extend(std::iter::repeat_n('0', decimals - fraction.len()));
    BigUint::parse_bytes(digits.as_bytes(), 10)
}

/// A Transfer kind as Sputnik's `internal_payout` runs it (proposals.rs 311-337): native NEAR
/// when `token_id` is empty, otherwise `ft_transfer` on the token, or `ft_transfer_call` when a
/// `msg` is set.
///
/// A body this cannot read, an amount Sputnik's `U128` could not hold, an explicit `token_id` of
/// `near` (it would read as native NEAR here while Sputnik calls the `near` account), and the
/// `ft_transfer_call` form (its `msg` grammar is WO-03a's) give UNKNOWN_CALL with no effect: the
/// kind is not understood, so it must not come out low (C2). A token with no census price adds
/// UNKNOWN_VALUE, never a value of zero (C2, C3).
fn transfer(body: &Value, input: &ProposalInput) -> (Vec<Effect>, Vec<FindingCode>) {
    let unreadable = || (Vec::new(), vec![FindingCode::UnknownCall]);
    let field = |name: &str| body.get(name).and_then(Value::as_str);
    let (Some(token_id), Some(to), Some(amount)) =
        (field("token_id"), field("receiver_id"), field("amount"))
    else {
        return unreadable();
    };
    let Some(amount) = base_units(amount, 0).filter(|a| a.bits() <= 128) else {
        return unreadable();
    };
    let msg_set = match body.get("msg") {
        None | Some(Value::Null) => false,
        Some(Value::String(_)) => true,
        Some(_) => return unreadable(),
    };
    if to.is_empty() || token_id == NATIVE || (!token_id.is_empty() && msg_set) {
        return unreadable();
    }
    let token = if token_id.is_empty() { NATIVE } else { token_id };

    let mut codes = Vec::new();
    if !input.prices.usd_by_token.contains_key(token) {
        codes.push(FindingCode::UnknownValue);
    }
    let effect = Effect::Transfer {
        token: token.to_string(),
        amount: amount.to_string(),
        to: to.to_string(),
    };
    (vec![effect], codes)
}
