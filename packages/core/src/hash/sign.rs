//! The `sign` actions of a FunctionCall kind and the request each one carries.
//!
//! A kind is read by the same rules `decode::value` reads every FunctionCall with (an account id
//! receiver, 1 to 100 actions, base64 arguments, a deposit a `U128` holds), from the bytes
//! `decode::value::read_kind` gives after the canonical check. A kind those rules refuse is
//! `decode::value`'s UNKNOWN_CALL, so this module returns nothing for it and nothing is counted
//! twice.

use base64::Engine as _;
use num_bigint::BigUint;
use serde_json::{Map, Value};

use crate::decode::account::is_account_id;
use crate::decode::json::{self, Parsed};
use crate::decode::known::{classify, Known};
use crate::decode::value::{base_units, read_kind};

/// Sputnik sends a FunctionCall's actions in one receipt, which runs at most 100 actions.
const MAX_ACTIONS: usize = 100;

/// The MPC contract's Eddsa payload: 32 to 1232 bytes (mpc `Payload::Eddsa`). Ecdsa is exactly 32.
const MAX_EDDSA_BYTES: usize = 1232;

pub struct Call {
    pub receiver: String,
    pub actions: Vec<CallAction>,
}

pub struct CallAction {
    pub method: String,
    pub args: Vec<u8>,
    pub deposit: BigUint,
}

impl Call {
    /// The actions that are `sign` on a Chain Signatures contract Kaap knows by exact account.
    pub fn signs(&self) -> impl Iterator<Item = &CallAction> {
        let signer = classify(&self.receiver, "sign") == Known::Signer;
        self.actions.iter().filter(move |a| signer && a.method == "sign")
    }
}

/// The FunctionCall in `kind_json`, or `None` for any other kind and for one `decode::value`
/// refuses as unreadable.
pub fn read_call(kind_json: &[u8]) -> Option<Call> {
    let (variant, body) = read_kind(kind_json)?;
    if variant != "FunctionCall" {
        return None;
    }
    let receiver = body.get("receiver_id")?.as_str().filter(|r| is_account_id(r))?;
    let actions = body.get("actions")?.as_array()?;
    if actions.is_empty() || actions.len() > MAX_ACTIONS {
        return None;
    }
    let actions = actions
        .iter()
        .map(|action| {
            let deposit = base_units(action.get("deposit")?.as_str()?, 0).filter(|d| d.bits() <= 128)?;
            Some(CallAction {
                method: action.get("method_name")?.as_str()?.to_string(),
                args: base64::engine::general_purpose::STANDARD.decode(action.get("args")?.as_str()?).ok()?,
                deposit,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    Some(Call { receiver: receiver.to_string(), actions })
}

/// What one `sign` call asks the MPC network to sign.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    pub path: String,
    pub domain_id: u64,
    /// The payload bytes: a 32-byte hash for every proposal Trezu and NEAR Business file.
    pub payload: Vec<u8>,
}

/// Why a `sign` call's arguments did not read as one request. The call is then an unknown call.
pub enum Unread {
    /// Valid JSON of another shape, shown as it is.
    Shape(Value),
    /// Not JSON, or JSON with a duplicate key: ARGS_NOT_JSON too.
    NotJson,
}

/// Reads `{"request": {"path", "payload_v2": {"Eddsa" | "Ecdsa": <hex>}, "domain_id"}}` with no
/// other field. The MPC contract ignores fields it does not know, but a field Kaap does not know
/// may be one a later contract version reads, so it is not read past (standard 4).
/// Empty arguments are no arguments, `{}`, never ARGS_NOT_JSON (ruling 2).
pub fn read_request(args: &[u8]) -> Result<Request, Unread> {
    let value = match args {
        [] => Value::Object(Map::new()),
        bytes => match json::parse(bytes) {
            Parsed::Json(value) => value,
            Parsed::NotJson | Parsed::DuplicateKey => return Err(Unread::NotJson),
        },
    };
    request(&value).ok_or(Unread::Shape(value))
}

fn request(value: &Value) -> Option<Request> {
    let outer = exactly(value, &["request"])?;
    let request = exactly(outer.get("request")?, &["path", "payload_v2", "domain_id"])?;
    let path = request.get("path")?.as_str()?.to_string();
    let domain_id = request.get("domain_id")?.as_u64()?;
    let payload_v2 = request.get("payload_v2")?.as_object().filter(|p| p.len() == 1)?;
    let (scheme, hex) = payload_v2.iter().next()?;
    let payload = from_hex(hex.as_str()?)?;
    let fits = match scheme.as_str() {
        "Eddsa" => (32..=MAX_EDDSA_BYTES).contains(&payload.len()),
        "Ecdsa" => payload.len() == 32,
        _ => false,
    };
    fits.then_some(Request { path, domain_id, payload })
}

fn exactly<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Map<String, Value>> {
    value.as_object().filter(|m| m.len() == keys.len() && keys.iter().all(|k| m.contains_key(*k)))
}

fn from_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok()).collect()
}

pub fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
