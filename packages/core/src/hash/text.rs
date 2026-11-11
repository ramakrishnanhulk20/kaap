//! The one strict reader for a NEP-413 text that hashed to a `sign` payload (C6, standard 2). It
//! reads the same bytes `nep413_hash` hashed, through `decode::json`, so a duplicate key at any
//! depth, trailing data or text that is not JSON has no reading at all.
//!
//! What it accepts: a recipient Kaap models (the NEAR Intents verifier, public `intents.near` or
//! the confidential shard `intents.far`), a sign path that is the DAO, and a message with exactly
//! the fields the verifier and 1Click read: `signer_id` (the DAO), `deadline`, `intents`, and an
//! optional `external_app_data` holding only 1Click auth configs. Anything else is a `Refusal`,
//! and a refused text that hashed correctly is HASH_TEXT_DANGEROUS: the DAO would sign bytes Kaap
//! cannot read one way.
//!
//! One text signs with the empty path: Trezu's login for the DAO's bulk-payment sub-account
//! (`bulk_account`, `is_bulk_login`). The MPC key for the DAO and path `""` is the one
//! registered for that sub-account on the verifier (prepare_auth.rs 82-86), so the same key
//! could move the sub-account's funds; only the exact login, which carries no intent, is read.
//!
//! What it does not do: judge the intents themselves (`intents::judge` does), or check the
//! deadline against a block (the caller does, since only it knows the block).

use serde_json::{Map, Value};

use crate::decode::json::{self, Parsed};

/// The recipients whose message format this reader models: the NEAR Intents verifier on public
/// NEAR, and its confidential shard, where NEAR Business and Trezu send their texts.
pub const MODELLED_RECIPIENTS: [&str; 2] = ["intents.near", "intents.far"];

/// The recipient Trezu's login texts name (prepare_auth.rs 129 and 169, `INTENTS_CONTRACT_ID`).
const LOGIN_RECIPIENT: &str = "intents.near";

/// The factory Trezu derives every bulk-payment sub-account under: `BULK_PAYMENT_CONTRACT_ID`,
/// `bulkpayment.near` by default (NEAR-DevHub/trezu 7b063dd, nt-be/src/utils/env.rs 126-129).
/// On mainnet `kmxv7.bulkpayment.near` is a bootstrapped sub-account and `bulk-payment.near` does
/// not exist (views at block 222705041 and 222705043, 2 Nov 2026).
const BULK_FACTORY: &str = "bulkpayment.near";

const DAO_FACTORY_SUFFIX: &str = ".sputnik-dao.near";

/// A text longer than this is refused before it is parsed (standard 4). Trezu's longest texts,
/// a 25-recipient bulk header, are a few kilobytes.
pub const MAX_TEXT_BYTES: usize = 64 * 1024;

/// The most intents one text may carry, the same cap `decode::value` puts on any list.
pub const MAX_INTENTS: usize = 100;

const TOP_LEVEL_FIELDS: [&str; 4] = ["signer_id", "deadline", "intents", "external_app_data"];

const NANOS: i128 = 1_000_000_000;

/// Why a text that hashed correctly has no single reading.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    TooLong,
    NotJson,
    DuplicateKey,
    NotAnObject,
    UnknownField(String),
    MissingField(&'static str),
    RecipientNotModelled,
    PathNotTheDao,
    SignerNotTheDao,
    NotTheBulkLogin,
    Deadline,
    Intents,
    AppData,
    DelegateAction,
}

/// A text read one way.
#[derive(Clone, Debug, PartialEq)]
pub struct Message {
    /// The deadline in nanoseconds since 1970, signed so a deadline before 1970 still compares.
    pub deadline_ns: i128,
    /// Each entry is an object; its kind is not judged here.
    pub intents: Vec<Map<String, Value>>,
}

/// Reads `message`, the exact text whose NEP-413 hash matched, for `dao`. `recipient` and
/// `path` are the NEP-413 recipient and the `sign` call's path. With the empty path, only
/// `dao`'s exact bulk login reads.
pub fn read(message: &str, recipient: &str, path: &str, dao: &str) -> Result<Message, Refusal> {
    if message.len() > MAX_TEXT_BYTES {
        return Err(Refusal::TooLong);
    }
    if !MODELLED_RECIPIENTS.contains(&recipient) {
        return Err(Refusal::RecipientNotModelled);
    }
    let login = path.is_empty() && path != dao;
    let signer = if path == dao {
        dao.to_string()
    } else if login {
        bulk_account(dao).ok_or(Refusal::PathNotTheDao)?
    } else {
        return Err(Refusal::PathNotTheDao);
    };
    let fields = match json::parse(message.as_bytes()) {
        Parsed::Json(Value::Object(fields)) => fields,
        Parsed::Json(_) => return Err(Refusal::NotAnObject),
        Parsed::NotJson => return Err(Refusal::NotJson),
        Parsed::DuplicateKey => return Err(Refusal::DuplicateKey),
    };
    if let Some(unknown) = fields.keys().find(|k| !TOP_LEVEL_FIELDS.contains(&k.as_str())) {
        return Err(Refusal::UnknownField(unknown.clone()));
    }
    let field = |name: &'static str| fields.get(name).ok_or(Refusal::MissingField(name));
    if field("signer_id")?.as_str() != Some(signer.as_str()) {
        return Err(Refusal::SignerNotTheDao);
    }
    let deadline_ns = deadline_ns(field("deadline")?).ok_or(Refusal::Deadline)?;
    let intents = match field("intents")? {
        Value::Array(items) if items.len() <= MAX_INTENTS => items
            .iter()
            .map(|item| item.as_object().cloned().ok_or(Refusal::Intents))
            .collect::<Result<Vec<_>, _>>()?,
        _ => return Err(Refusal::Intents),
    };
    if let Some(data) = fields.get("external_app_data") {
        if !is_auth_only(data) {
            return Err(Refusal::AppData);
        }
    }
    if login && !is_bulk_login(&fields, recipient, &intents) {
        return Err(Refusal::NotTheBulkLogin);
    }
    Ok(Message { deadline_ns, intents })
}

/// The bulk-payment sub-account Trezu derives for `dao` (`derive_bulk_subaccount_id`,
/// NEAR-DevHub/trezu 7b063dd, nt-be/src/handlers/treasury/confidential_setup.rs 266-294): the
/// DAO's one label before `.sputnik-dao.near`, then `.bulkpayment.near`. `None` for a DAO not
/// named that way, which Trezu refuses too.
pub fn bulk_account(dao: &str) -> Option<String> {
    let prefix = dao.strip_suffix(DAO_FACTORY_SUFFIX).filter(|p| !p.is_empty() && !p.contains('.'))?;
    Some(format!("{prefix}.{BULK_FACTORY}"))
}

/// The login Trezu builds for a bulk-payment sub-account (`build_auth_proposal_with_signer`,
/// prepare_auth.rs 92-202): for `intents.near`, with a deadline string, no intent, and app data
/// holding exactly one auth config. The signer was checked before this.
fn is_bulk_login(fields: &Map<String, Value>, recipient: &str, intents: &[Map<String, Value>]) -> bool {
    let one_config = fields
        .get("external_app_data")
        .and_then(|data| data.get("configs"))
        .and_then(Value::as_array)
        .is_some_and(|configs| configs.len() == 1);
    recipient == LOGIN_RECIPIENT
        && intents.is_empty()
        && fields.get("deadline").is_some_and(Value::is_string)
        && one_config
}

/// `{"configs": [{"type": "auth", "expires_in": <seconds>}, ...]}`, the only app data 1Click
/// reads from a Trezu text (prepare_auth.rs 104-138): a session for reading and quoting, which
/// moves nothing. Any other content is data Kaap cannot say the meaning of.
fn is_auth_only(data: &Value) -> bool {
    let Some(data) = data.as_object() else { return false };
    let Some(Value::Array(configs)) = data.get("configs") else { return false };
    data.len() == 1
        && configs.len() <= MAX_INTENTS
        && configs.iter().all(|config| {
            config.as_object().is_some_and(|c| {
                c.len() == 2
                    && c.get("type").and_then(Value::as_str) == Some("auth")
                    && c.get("expires_in").is_some_and(|e| e.as_u64().is_some())
            })
        })
}

/// The deadline in nanoseconds since 1970. The verifier's own form is an RFC 3339 string. The
/// planted records write `{"timestamp": <seconds>}`, which the verifier would refuse to parse; it
/// is read as a second form so those texts are judged on their intents, the worst plausible
/// reading. Anything else has no reading.
pub fn deadline_ns(value: &Value) -> Option<i128> {
    match value {
        Value::String(text) => rfc3339_ns(text),
        Value::Object(fields) if fields.len() == 1 => {
            let seconds = fields.get("timestamp")?.as_u64()?;
            Some(i128::from(seconds) * NANOS)
        }
        _ => None,
    }
}

/// `YYYY-MM-DDTHH:MM:SS[.fraction]` then `Z` or `+HH:MM` / `-HH:MM`, as RFC 3339 section 5.6
/// writes it, with 1 to 9 fraction digits. No leap second, no lower-case `t` or `z`, no space:
/// a form this does not read is refused rather than guessed at.
pub fn rfc3339_ns(text: &str) -> Option<i128> {
    let b = text.as_bytes();
    let digits = |from: usize, len: usize| -> Option<i64> {
        let part = b.get(from..from + len)?;
        part.iter().all(u8::is_ascii_digit).then(|| part.iter().fold(0i64, |n, d| n * 10 + i64::from(d - b'0')))
    };
    let at = |i: usize, c: u8| b.get(i) == Some(&c);
    if !(at(4, b'-') && at(7, b'-') && at(10, b'T') && at(13, b':') && at(16, b':')) {
        return None;
    }
    let (year, month, day) = (digits(0, 4)?, digits(5, 2)?, digits(8, 2)?);
    let (hour, minute, second) = (digits(11, 2)?, digits(14, 2)?, digits(17, 2)?);
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let mut i = 19;
    let mut fraction_ns: i128 = 0;
    if at(i, b'.') {
        let count = b[i + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
        if !(1..=9).contains(&count) {
            return None;
        }
        let value = digits(i + 1, count)?;
        fraction_ns = i128::from(value) * 10i128.pow(9 - count as u32);
        i += 1 + count;
    }
    let offset_seconds = match b.get(i..)? {
        [b'Z'] => 0,
        [sign @ (b'+' | b'-'), _, _, b':', _, _] => {
            let (h, m) = (digits(i + 1, 2)?, digits(i + 4, 2)?);
            if h > 23 || m > 59 {
                return None;
            }
            let offset = h * 3600 + m * 60;
            if *sign == b'+' { offset } else { -offset }
        }
        _ => return None,
    };
    let seconds = days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second - offset_seconds;
    Some(i128::from(seconds) * NANOS + fraction_ns)
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days from 1970-01-01 to the given proleptic Gregorian date (Howard Hinnant's
/// `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3339_instants() {
        assert_eq!(rfc3339_ns("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(rfc3339_ns("2026-09-21T14:13:20Z"), Some(1_790_000_000 * NANOS));
        assert_eq!(rfc3339_ns("2026-09-21T16:13:20+02:00"), Some(1_790_000_000 * NANOS));
        assert_eq!(rfc3339_ns("2025-05-21T10:34:04.254392Z"), Some(1_747_823_644 * NANOS + 254_392_000));
        assert_eq!(rfc3339_ns("2024-02-29T00:00:00.5Z"), Some(1_709_164_800 * NANOS + 500_000_000));
        assert_eq!(rfc3339_ns("1969-12-31T23:59:59Z"), Some(-NANOS));
        for bad in [
            "2023-02-29T00:00:00Z",
            "2026-13-01T00:00:00Z",
            "2026-09-21T24:00:00Z",
            "2026-09-21T23:59:60Z",
            "2026-09-21t14:13:20Z",
            "2026-09-21 14:13:20Z",
            "2026-09-21T14:13:20",
            "2026-09-21T14:13:20z",
            "2026-09-21T14:13:20.Z",
            "2026-09-21T14:13:20.1234567891Z",
            "2026-09-21T14:13:20+0200",
            "2026-09-21T14:13:20Z ",
            "+2026-09-21T14:13:20Z",
            "",
        ] {
            assert_eq!(rfc3339_ns(bad), None, "{bad}");
        }
    }

    #[test]
    fn both_deadline_forms() {
        assert_eq!(deadline_ns(&serde_json::json!({"timestamp": 1_790_000_000})), Some(1_790_000_000 * NANOS));
        assert_eq!(deadline_ns(&serde_json::json!("2026-09-21T14:13:20Z")), Some(1_790_000_000 * NANOS));
        for bad in [
            serde_json::json!({"timestamp": -1}),
            serde_json::json!({"timestamp": 1.5}),
            serde_json::json!({"timestamp": "1790000000"}),
            serde_json::json!({"timestamp": 1, "x": 2}),
            serde_json::json!(1_790_000_000),
            serde_json::json!(null),
        ] {
            assert_eq!(deadline_ns(&bad), None, "{bad}");
        }
    }
}
