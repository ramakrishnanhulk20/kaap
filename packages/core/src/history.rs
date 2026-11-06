//! The payment history NEW_RECIPIENT and LARGE_AMOUNT compare against, read from a DAO's stored
//! proposals. This is the census payment rule, the same rule as `historyBefore`, `paymentOf`,
//! `usdOf` and `median` in `packages/cli/src/history.ts`, so `kaap check` and the sealed job see one
//! past. `tests/history_before.rs` and a CLI test load one shared fixture to hold the two together.
//! USD uses today's prices, so a median is an estimate.
//!
//! JavaScript's looseness is copied where a stored proposal can reach it, which is why this file
//! has its own whole-number, string and rounding readers. Three things are left out, each only a
//! contract that is not Sputnik or a call no token accepts could show: `0x` style amounts, which
//! `BigInt` reads and NEP-141's decimal `U128` refuses, read here as unpriced; base64 that is not
//! canonical, which Sputnik never writes, read here as no arguments; and the prices JavaScript finds
//! on `Object.prototype` for a token called `constructor`, which here is simply unpriced.

use base64::Engine as _;
use serde_json::Value;

use crate::types::{History, Prices};

const SEND_METHODS: [&str; 5] = ["ft_transfer", "ft_transfer_call", "mt_transfer", "mt_transfer_call", "near_withdraw"];

const INTENTS_MOVES: [&str; 10] = [
    "ft_withdraw",
    "mt_withdraw",
    "mt_transfer",
    "mt_transfer_call",
    "mt_batch_transfer",
    "mt_batch_transfer_call",
    "ft_force_withdraw",
    "mt_force_transfer",
    "native_withdraw",
    "nft_withdraw",
];

/// The largest whole number JavaScript holds exactly, the limit `z.number().int()` sets.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// The DAO's approved payments submitted strictly before `submission_time_ns`.
///
/// A payment is a Transfer, or a function call that sends tokens, minus Trezu's asset-exchange and
/// public-to-confidential proposals. The median covers priced payments only, rounded to cents, and
/// is `None` when none is priced (C2: an unpriced payment is never counted as zero). The receivers
/// are sorted and unique. A proposal this cannot read counts as not a payment. Pure, and it cannot
/// panic on any JSON.
pub fn history_before(proposals: &[Value], submission_time_ns: u64, prices: &Prices) -> History {
    let earlier: Vec<Payment> = proposals
        .iter()
        .filter(|p| is_stored(p) && p["status"] == "Approved")
        .filter(|p| p["submission_time"].as_str().and_then(submission_ns).is_some_and(|t| t < submission_time_ns))
        .filter_map(|p| payment_of(p, prices))
        .collect();
    let priced: Vec<f64> = earlier.iter().filter_map(|payment| payment.usd).collect();
    let approved_payments_before = u32::try_from(earlier.len()).unwrap_or(u32::MAX);
    let mut receivers: Vec<String> = earlier.into_iter().flat_map(|payment| payment.receivers).collect();
    receivers.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    receivers.dedup();
    History {
        approved_payments_before,
        median_payment_usd_before: median(priced).map(|usd| math_round(usd * 100.0) / 100.0),
        recipients_paid_before: receivers,
    }
}

/// A stored `submission_time`, or `None` when it is not 1 to 20 digits that fit a u64. Both sides of
/// the "strictly before" comparison go through this one reader (standard 2).
pub fn submission_ns(text: &str) -> Option<u64> {
    if !is_digits(text) {
        return None;
    }
    text.parse().ok()
}

fn is_digits(text: &str) -> bool {
    (1..=20).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_digit())
}

fn is_whole(value: &Value) -> bool {
    value.as_f64().is_some_and(|n| n >= 0.0 && n <= MAX_SAFE_INTEGER && n.fract() == 0.0)
}

/// The shape the CLI's `storedSchema` asks of each proposal.
fn is_stored(p: &Value) -> bool {
    let logged = |entry: &Value| entry["block_height"].as_str().map_or(is_whole(&entry["block_height"]), is_digits);
    is_whole(&p["id"])
        && p["status"].is_string()
        && p["description"].is_string()
        && p["submission_time"].as_str().is_some_and(is_digits)
        && p.get("votes").is_none_or(Value::is_object)
        && p.get("last_actions_log").is_none_or(|log| log.as_array().is_some_and(|log| log.iter().all(logged)))
}

struct Payment {
    /// `None` when any part of it is unpriced.
    usd: Option<f64>,
    receivers: Vec<String>,
}

/// The payment `p` makes, or `None` when it is not a payment.
fn payment_of(p: &Value, prices: &Prices) -> Option<Payment> {
    let kind = &p["kind"];
    let k = variant(kind);
    let body = &kind[k];
    if k == "Transfer" {
        let usd = usd_of(prices, &string_of(&body["token_id"]), &body["amount"]);
        return Some(Payment { usd, receivers: vec![string_of(&body["receiver_id"])] });
    }
    if k != "FunctionCall" {
        return None;
    }
    let contract = string_of(&body["receiver_id"]);
    let is_intents = contract == "intents.near";
    let (mut any_move, mut sum, mut known, mut receivers) = (false, 0.0, true, Vec::new());
    for action in body["actions"].as_array().map_or(&[][..], Vec::as_slice) {
        let method = string_of(&action["method_name"]);
        if !SEND_METHODS.contains(&method.as_str()) && !is_intents {
            continue;
        }
        let v = args(&action["args"]);
        let amount = &v["amount"];
        let token_id = v["token_id"].as_str().and_then(|id| id.strip_prefix("nep141:"));
        let mut receiver = if v["receiver_id"].is_null() { &v["to"] } else { &v["receiver_id"] };
        let token = match method.as_str() {
            "ft_transfer" | "ft_transfer_call" => Some(contract.as_str()),
            "mt_transfer" | "mt_transfer_call" => token_id,
            "near_withdraw" => {
                receiver = &Value::Null;
                Some("")
            }
            _ if is_intents => v["token"].as_str().or(token_id),
            _ => None,
        };
        let moves = !is_intents || INTENTS_MOVES.contains(&method.as_str());
        any_move |= moves;
        if let (true, Some(to)) = (moves, receiver.as_str().filter(|to| !to.is_empty())) {
            receivers.push(to.to_string());
        }
        match token.filter(|_| is_truthy(amount)).and_then(|token| usd_of(prices, token, amount)) {
            Some(value) => sum += value,
            None => known = false,
        }
    }
    let action = proposal_action(p["description"].as_str().unwrap_or_default());
    if !any_move || matches!(action, Some("asset-exchange" | "public-to-confidential")) {
        return None;
    }
    Some(Payment { usd: known.then_some(sum), receivers })
}

/// The kind's variant name, or "" when it has none.
fn variant(kind: &Value) -> &str {
    match kind {
        Value::String(name) => name,
        Value::Object(fields) if fields.len() == 1 => fields.keys().next().map_or("", String::as_str),
        _ => "",
    }
}

/// A call's arguments, or `Null` (which reads as no fields) when they are not base64 of UTF-8 JSON
/// holding an object. `TextDecoder` drops a leading byte order mark, so this does too.
fn args(b64: &Value) -> Value {
    let Some(bytes) = b64.as_str().and_then(|text| base64::engine::general_purpose::STANDARD.decode(text).ok()) else {
        return Value::Null;
    };
    let text = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes);
    serde_json::from_slice::<Value>(text).ok().filter(Value::is_object).unwrap_or(Value::Null)
}

/// USD of `raw` base units of `token` ("" is native NEAR), or `None` when unpriced.
fn usd_of(prices: &Prices, token: &str, raw: &Value) -> Option<f64> {
    let &(decimals, usd) = prices.usd_by_token.get(if token.is_empty() { "near" } else { token })?;
    Some(whole_number(raw)? / 10f64.powi(i32::from(decimals)) * usd)
}

/// JavaScript's `Number(BigInt(raw))`: a whole JSON number, or text of decimal digits with an
/// optional sign and white space around it, where empty text is 0.
fn whole_number(raw: &Value) -> Option<f64> {
    match raw {
        Value::Number(number) => number.as_f64().filter(|n| n.fract() == 0.0),
        Value::String(text) => {
            let text = text.trim_matches(is_js_space);
            if text.is_empty() {
                return Some(0.0);
            }
            let digits = text.strip_prefix(['+', '-']).unwrap_or(text);
            if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let size: f64 = digits.parse().ok()?;
            Some(if text.starts_with('-') { -size } else { size })
        }
        _ => None,
    }
}

/// Whether JavaScript counts an amount as present. Only the two falsy forms `whole_number` would
/// otherwise read matter here: every other value it cannot read gives no price anyway.
fn is_truthy(amount: &Value) -> bool {
    !(amount.as_str() == Some("") || amount.as_f64() == Some(0.0))
}

/// JavaScript's `String(value ?? '')`.
fn string_of(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(string_of).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_string(),
        other => other.to_string(),
    }
}

/// JavaScript's `\s`, which `char::is_whitespace` misses by one character each way.
fn is_js_space(c: char) -> bool {
    c == '\u{feff}' || (c != '\u{85}' && c.is_whitespace())
}

/// What `/\* Proposal Action:\s*([a-z-]+)/` captures from a description.
fn proposal_action(description: &str) -> Option<&str> {
    const MARK: &str = "* Proposal Action:";
    description.match_indices(MARK).find_map(|(at, _)| {
        let rest = description[at + MARK.len()..].trim_start_matches(is_js_space);
        let end = rest.find(|c: char| !(c.is_ascii_lowercase() || c == '-')).unwrap_or(rest.len());
        (end > 0).then(|| &rest[..end])
    })
}

fn median(mut values: Vec<f64>) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let m = values.len() >> 1;
    Some(if values.len() % 2 == 1 { values[m] } else { (values[m - 1] + values[m]) / 2.0 })
}

/// JavaScript's `Math.round`, where a half goes up: `f64::round` takes -2.5 to -3, this to -2.
fn math_round(x: f64) -> f64 {
    let below = x.floor();
    if x - below >= 0.5 {
        below + 1.0
    } else {
        below
    }
}

// What the shared fixture cannot hold, because the TypeScript takes proposals its schema has already
// checked: a proposal that does not read, and the text and rounding readers on their odd inputs. The
// rule itself is covered by tests/history_before.rs.
#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn prices() -> Prices {
        Prices { usd_by_token: [("near".to_string(), (24, 4.0))].into_iter().collect() }
    }

    fn approved(kind: Value) -> Value {
        json!({ "id": 1, "status": "Approved", "description": "", "kind": kind, "submission_time": "10" })
    }

    fn near(amount: &str) -> Value {
        json!({ "Transfer": { "token_id": "", "receiver_id": "bob.near", "amount": amount, "msg": null } })
    }

    #[test]
    fn a_proposal_that_does_not_read_is_not_a_payment() {
        let good = approved(near("1000000000000000000000000"));
        let spoiled = |key: &str, value: Value| {
            let mut p = good.clone();
            p[key] = value;
            p
        };
        let mut no_time = good.clone();
        no_time.as_object_mut().unwrap().remove("submission_time");
        let unreadable = [
            json!(null),
            json!(7),
            json!([good.clone()]),
            no_time,
            spoiled("id", json!(-1)),
            spoiled("id", json!(1.5)),
            spoiled("id", json!("1")),
            spoiled("status", json!(1)),
            spoiled("description", json!(null)),
            spoiled("submission_time", json!(10)),
            spoiled("submission_time", json!("+10")),
            spoiled("submission_time", json!("")),
            spoiled("submission_time", json!("123456789012345678901")),
            spoiled("votes", json!([])),
            spoiled("last_actions_log", json!(null)),
            spoiled("last_actions_log", json!([{ "block_height": "x" }])),
        ];
        for p in unreadable {
            let history = history_before(&[p.clone()], 11, &prices());
            assert_eq!(history.approved_payments_before, 0, "{p}");
        }
        assert_eq!(history_before(&[good], 11, &prices()).approved_payments_before, 1);
    }

    #[test]
    fn the_submission_time_reader_takes_only_digits_that_fit() {
        assert_eq!(submission_ns("1700000000000000000"), Some(1_700_000_000_000_000_000));
        assert_eq!(submission_ns("18446744073709551615"), Some(u64::MAX));
        for bad in ["", "+1", "-1", " 1", "1 ", "1.0", "0x10", "18446744073709551616", "123456789012345678901"] {
            assert_eq!(submission_ns(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn amounts_read_the_way_bigint_reads_them() {
        for (raw, want) in [
            (json!("12"), Some(12.0)),
            (json!(" 12\n"), Some(12.0)),
            (json!("+12"), Some(12.0)),
            (json!("-12"), Some(-12.0)),
            (json!(""), Some(0.0)),
            (json!("   "), Some(0.0)),
            (json!(12), Some(12.0)),
            (json!(12.5), None),
            (json!("12.5"), None),
            (json!("1e3"), None),
            (json!("+"), None),
            (json!("0x10"), None),
            (json!(true), None),
            (json!(null), None),
            (json!([1]), None),
        ] {
            assert_eq!(whole_number(&raw), want, "{raw}");
        }
    }

    #[test]
    fn a_function_call_amount_that_javascript_counts_as_missing_is_unpriced() {
        let call = |amount: Value| {
            let args = base64::engine::general_purpose::STANDARD.encode(json!({ "receiver_id": "bob.near", "amount": amount }).to_string());
            approved(json!({ "FunctionCall": { "receiver_id": "wrap.near", "actions": [{ "method_name": "ft_transfer", "args": args }] } }))
        };
        let mut prices = prices();
        prices.usd_by_token.insert("wrap.near".to_string(), (24, 4.0));
        for amount in [json!(""), json!(0)] {
            let history = history_before(&[call(amount.clone())], 11, &prices);
            assert_eq!((history.approved_payments_before, history.median_payment_usd_before), (1, None), "{amount}");
        }
        assert_eq!(history_before(&[call(json!("0"))], 11, &prices).median_payment_usd_before, Some(0.0));
    }

    #[test]
    fn rounding_sends_a_half_up_as_math_round_does() {
        for (x, want) in [(2.5, 3.0), (-2.5, -2.0), (2.4, 2.0), (-2.6, -3.0), (0.499_999_999_999_999_94, 0.0), (1e300, 1e300)] {
            assert_eq!(math_round(x), want, "{x}");
        }
    }

    #[test]
    fn the_action_line_reads_the_way_the_regular_expression_does() {
        for (text, want) in [
            ("* Proposal Action: asset-exchange", Some("asset-exchange")),
            ("* Proposal Action:\u{feff} \npublic-to-confidential <br>", Some("public-to-confidential")),
            ("* Proposal Action: Payment\n* Proposal Action: payment2", Some("payment")),
            ("* Proposal Action:\u{85}payment", None),
            ("Proposal Action: payment", None),
            ("", None),
        ] {
            assert_eq!(proposal_action(text), want, "{text:?}");
        }
    }

    #[test]
    fn a_byte_order_mark_is_dropped_and_other_arguments_read_as_none() {
        let encode = |bytes: &[u8]| json!(base64::engine::general_purpose::STANDARD.encode(bytes));
        assert_eq!(args(&encode(b"\xef\xbb\xbf{\"amount\":\"1\"}"))["amount"], "1");
        for bad in [encode(b"[1]"), encode(b"\xff"), json!(""), json!("not base64!"), json!(1)] {
            assert!(args(&bad).is_null(), "{bad}");
        }
    }
}
