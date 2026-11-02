//! A NEP-366 delegate action read from the exact borsh bytes `nep461_hash` hashed (standard 2),
//! with nearcore's action layout. Kaap v1 does not judge what a delegate action does, so each of
//! its actions becomes an `unknown_call` on the delegate's receiver (guide ruling 11).
//!
//! Covers the actions a delegate action may carry in nearcore's borsh order 0 to 7, 9 and 10.
//! A nested delegate (8), any later action, a public key type other than ed25519 or secp256k1, a
//! permission other than the two classic ones, or a single byte too many or too few is refused,
//! never read as something nearby.

use std::io::{Error, ErrorKind, Read, Result};

use base64::Engine as _;
use borsh::BorshDeserialize;
use num_bigint::BigUint;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::decode::json::{self as strict, Parsed};
use crate::types::Effect;

/// NEAR runs at most 100 actions in one receipt, so a longer list cannot execute.
const MAX_ACTIONS: usize = 100;

#[derive(Debug, BorshDeserialize)]
pub struct DelegateAction {
    pub sender_id: String,
    pub receiver_id: String,
    pub actions: Vec<Action>,
    pub nonce: u64,
    pub max_block_height: u64,
    pub public_key: PublicKey,
}

#[derive(Debug)]
pub enum PublicKey {
    Ed25519([u8; 32]),
    Secp256k1([u8; 64]),
}

impl BorshDeserialize for PublicKey {
    fn deserialize_reader<R: Read>(reader: &mut R) -> Result<Self> {
        match u8::deserialize_reader(reader)? {
            0 => Ok(PublicKey::Ed25519(<[u8; 32]>::deserialize_reader(reader)?)),
            1 => Ok(PublicKey::Secp256k1(<[u8; 64]>::deserialize_reader(reader)?)),
            _ => Err(refused("public key type")),
        }
    }
}

impl PublicKey {
    fn text(&self) -> String {
        match self {
            PublicKey::Ed25519(key) => format!("ed25519:{}", bs58::encode(key).into_string()),
            PublicKey::Secp256k1(key) => format!("secp256k1:{}", bs58::encode(key).into_string()),
        }
    }
}

#[derive(Debug, BorshDeserialize)]
pub enum Permission {
    FunctionCall { allowance: Option<u128>, receiver_id: String, method_names: Vec<String> },
    FullAccess,
}

#[derive(Debug, BorshDeserialize)]
pub struct AccessKey {
    pub nonce: u64,
    pub permission: Permission,
}

#[derive(Debug)]
pub enum Action {
    CreateAccount,
    DeployContract { code: Vec<u8> },
    FunctionCall { method_name: String, args: Vec<u8>, gas: u64, deposit: u128 },
    Transfer { deposit: u128 },
    Stake { stake: u128, public_key: PublicKey },
    AddKey { public_key: PublicKey, access_key: AccessKey },
    DeleteKey { public_key: PublicKey },
    DeleteAccount { beneficiary_id: String },
    DeployGlobalContract { code: Vec<u8>, by_account: bool },
    UseGlobalContract { code_hash: Option<[u8; 32]>, account_id: Option<String> },
}

impl BorshDeserialize for Action {
    fn deserialize_reader<R: Read>(r: &mut R) -> Result<Self> {
        Ok(match u8::deserialize_reader(r)? {
            0 => Action::CreateAccount,
            1 => Action::DeployContract { code: Vec::deserialize_reader(r)? },
            2 => Action::FunctionCall {
                method_name: String::deserialize_reader(r)?,
                args: Vec::deserialize_reader(r)?,
                gas: u64::deserialize_reader(r)?,
                deposit: u128::deserialize_reader(r)?,
            },
            3 => Action::Transfer { deposit: u128::deserialize_reader(r)? },
            4 => Action::Stake { stake: u128::deserialize_reader(r)?, public_key: PublicKey::deserialize_reader(r)? },
            5 => Action::AddKey {
                public_key: PublicKey::deserialize_reader(r)?,
                access_key: AccessKey::deserialize_reader(r)?,
            },
            6 => Action::DeleteKey { public_key: PublicKey::deserialize_reader(r)? },
            7 => Action::DeleteAccount { beneficiary_id: String::deserialize_reader(r)? },
            9 => {
                let code = Vec::deserialize_reader(r)?;
                let by_account = match u8::deserialize_reader(r)? {
                    0 => false,
                    1 => true,
                    _ => return Err(refused("global deploy mode")),
                };
                Action::DeployGlobalContract { code, by_account }
            }
            10 => match u8::deserialize_reader(r)? {
                0 => Action::UseGlobalContract { code_hash: Some(<[u8; 32]>::deserialize_reader(r)?), account_id: None },
                1 => Action::UseGlobalContract { code_hash: None, account_id: Some(String::deserialize_reader(r)?) },
                _ => return Err(refused("global contract identifier")),
            },
            _ => return Err(refused("action")),
        })
    }
}

fn refused(what: &str) -> Error {
    Error::new(ErrorKind::InvalidData, format!("not a delegate {what} Kaap reads"))
}

/// Reads `bytes` as exactly one delegate action of at most `MAX_ACTIONS` actions; any byte left
/// over is a refusal.
pub fn read(bytes: &[u8]) -> Option<DelegateAction> {
    borsh::from_slice::<DelegateAction>(bytes)
        .ok()
        .filter(|d| !d.actions.is_empty() && d.actions.len() <= MAX_ACTIONS)
}

/// The delegate action's actions as `unknown_call` effects on its receiver, in order, and
/// whether any function call carried arguments that are not JSON (ARGS_NOT_JSON).
pub fn effects(delegate: &DelegateAction) -> (Vec<Effect>, bool) {
    let mut args_not_json = false;
    let effects = delegate
        .actions
        .iter()
        .map(|action| {
            let (method, args, deposit): (String, Value, u128) = match action {
                Action::CreateAccount => ("CreateAccount".into(), json!({}), 0),
                Action::DeployContract { code } => ("DeployContract".into(), json!({"code_hash": code_hash(code)}), 0),
                Action::FunctionCall { method_name, args, deposit, .. } => {
                    let shown = match args.as_slice() {
                        [] => Value::Object(Map::new()),
                        bytes => match strict::parse(bytes) {
                            Parsed::Json(value) => value,
                            Parsed::NotJson | Parsed::DuplicateKey => {
                                args_not_json = true;
                                Value::String("not_json".into())
                            }
                        },
                    };
                    (method_name.clone(), shown, *deposit)
                }
                Action::Transfer { deposit } => ("Transfer".into(), json!({}), *deposit),
                Action::Stake { stake, public_key } => {
                    ("Stake".into(), json!({"stake": stake.to_string(), "public_key": public_key.text()}), 0)
                }
                Action::AddKey { public_key, access_key } => {
                    let permission = match &access_key.permission {
                        Permission::FullAccess => json!("full_access"),
                        Permission::FunctionCall { allowance, receiver_id, method_names } => json!({
                            "allowance": allowance.map(|a| a.to_string()),
                            "receiver_id": receiver_id,
                            "method_names": method_names,
                        }),
                    };
                    ("AddKey".into(), json!({"public_key": public_key.text(), "permission": permission}), 0)
                }
                Action::DeleteKey { public_key } => ("DeleteKey".into(), json!({"public_key": public_key.text()}), 0),
                Action::DeleteAccount { beneficiary_id } => {
                    ("DeleteAccount".into(), json!({"beneficiary_id": beneficiary_id}), 0)
                }
                Action::DeployGlobalContract { code, by_account } => (
                    "DeployGlobalContract".into(),
                    json!({"code_hash": code_hash(code), "by_account": by_account}),
                    0,
                ),
                Action::UseGlobalContract { code_hash, account_id } => (
                    "UseGlobalContract".into(),
                    json!({
                        "code_hash": code_hash.map(|h| bs58::encode(h).into_string()),
                        "account_id": account_id,
                    }),
                    0,
                ),
            };
            Effect::UnknownCall {
                receiver: delegate.receiver_id.clone(),
                method,
                args,
                deposit: BigUint::from(deposit).to_string(),
            }
        })
        .collect();
    (effects, args_not_json)
}

/// Base58 sha256 of contract code, as NEAR writes a code hash.
fn code_hash(code: &[u8]) -> String {
    bs58::encode(Sha256::digest(code)).into_string()
}

/// The delegate actions a description carries in Templar's `tmplrmgr-mpc` form: the marker,
/// then on the same line `{"v":1,"kind":"delegate_action","bytes":"<base64 borsh>"}`
/// (templar.sputnik-dao.near #206 and #216). Only the first `MAX_IN_DESCRIPTION` markers are
/// read. A form this does not read is no text: the payload then stays unverified.
pub fn in_description(description: &str) -> Vec<Vec<u8>> {
    const MARKER: &str = "tmplrmgr-mpc:";
    const MAX_IN_DESCRIPTION: usize = 8;
    description
        .match_indices(MARKER)
        .take(MAX_IN_DESCRIPTION)
        .filter_map(|(at, _)| {
            let rest = &description[at + MARKER.len()..];
            let line = rest.split('\n').next().unwrap_or("").trim_end();
            let Parsed::Json(Value::Object(fields)) = strict::parse(line.as_bytes()) else {
                return None;
            };
            let well_formed = fields.len() == 3
                && fields.get("v").and_then(Value::as_u64) == Some(1)
                && fields.get("kind").and_then(Value::as_str) == Some("delegate_action");
            let bytes = fields.get("bytes").and_then(Value::as_str).filter(|_| well_formed)?;
            base64::engine::general_purpose::STANDARD.decode(bytes).ok()
        })
        .collect()
}
