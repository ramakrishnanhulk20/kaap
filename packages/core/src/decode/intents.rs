//! Calls on `intents.near` and the deposit messages it reads (guide section 3; intents brief 3b:
//! a deposit `msg` is empty, an account name, or `{"receiver_id", "execute_intents",
//! "refund_if_fails"}`).
//!
//! Intents carried by a deposit message or by `execute_intents` are read through one table of
//! modelled kinds: withdrawals, transfers, key changes, and a `token_diff` that only receives.
//! Any other kind, a `token_diff` that gives tokens away, a modelled kind with fields this cannot
//! read, and a signed payload (whose signer this module does not check) each become an
//! `unknown_call` on `intents.near`, so a missing entry produces an alert, not a pass
//! (standard 1).
//!
//! A withdrawal also reads its `msg` and `storage_deposit` (`after_withdraw`). `hash::intents`
//! reads a signed text's withdrawals through this same code, so the two are never read two ways
//! (standard 2).
//!
//! A message may also carry its intents as a bare `intents` list, as the planted attacks do.
//! intents.near may refuse that shape, but the module cannot prove it does, so it takes the worst
//! plausible reading and treats those intents as executed (C2). For the same reason a withdrawal
//! intent that names a destination `chain` other than NEAR is read as leaving NEAR.

use num_bigint::BigUint;
use serde_json::{json, Map, Value};

use super::account::is_account_id;
use super::json::{self, Parsed};
use super::value::{account, amount, object, optional_text, text, token_call, u128_amount};
use super::value::{Decoded, Move, Refusal, INTENTS, MAX_ITEMS, NATIVE};
use crate::hash::intents::storage_excess;
use crate::hash::quote::omni_chain;
use crate::types::{Effect, KeyOp, MsgKind};

/// Defuse's PoA bridge tokens are `<chain>.omft.near` or `<chain>-<address>.omft.near`, and
/// `<chain>` is the census `blockchain` name (checked against every omft token in the census
/// list on 29 Oct 2026).
const OMFT_SUFFIX: &str = ".omft.near";

const HOT_OMNI: &str = "v2_1.omni.hot.tg";

/// HOT Omni token ids start with a chain id. These are the ids the census token list uses, with
/// its `blockchain` names. A chain id not listed reads as `unknown`, which still fires
/// CROSS_CHAIN_OUT, so the table only names the chain and never lets a withdrawal pass.
const HOT_CHAINS: [(&str, &str); 11] = [
    ("10", "op"),
    ("56", "bsc"),
    ("137", "pol"),
    ("143", "monad"),
    ("196", "xlayer"),
    ("1100", "stellar"),
    ("1117", "ton"),
    ("9745", "plasma"),
    ("36900", "adi"),
    ("43114", "avax"),
    ("534352", "scroll"),
];

/// The bridges read a withdrawal's destination from a memo in this form.
const WITHDRAW_TO: &str = "WITHDRAW_TO:";

const UNKNOWN: &str = "unknown";

/// How a withdrawal reaches `intents.near`. Only an intent pays a `storage_deposit`: the
/// `ft_withdraw` and `mt_withdraw` methods pass none on (near/intents d340060,
/// contracts/defuse/src/contract/tokens/nep141/withdraw.rs 27-50 and nep245/withdraw.rs 32-58),
/// so that argument to a method moves nothing.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Form {
    Method,
    Intent,
}

/// A method called directly on `intents.near` by the DAO.
pub(super) fn method(method: &str, args: &Value, dao: &str) -> Result<Decoded, Refusal> {
    let fields = object(args)?;
    let mut decoded = Decoded::default();
    match method {
        "mt_transfer" => {
            let to = account(fields, "receiver_id")?;
            let token = guide_token(text(fields, "token_id")?)?;
            let sent = amount(fields, "amount")?;
            let effect = Effect::IntentsTransfer { token: token.clone(), amount: sent.to_string(), to: to.into() };
            decoded.push(effect, Some(Move::new(&token, &sent, Some(to))));
        }
        "mt_transfer_call" => {
            let to = account(fields, "receiver_id")?;
            let token = guide_token(text(fields, "token_id")?)?;
            let sent = amount(fields, "amount")?;
            let msg = fields.get("msg").and_then(Value::as_str).ok_or(Refusal::Unreadable)?;
            return token_call(&token, &sent, to, msg, dao);
        }
        "ft_withdraw" => ft_withdraw(fields, Form::Method, &mut decoded)?,
        "mt_withdraw" => mt_withdraw(fields, Form::Method, &mut decoded)?,
        "add_public_key" | "remove_public_key" => key_change(method, fields, &mut decoded)?,
        "execute_intents" => {
            for item in list(fields, "signed")? {
                read_item(item, "execute_intents", &mut decoded);
            }
        }
        _ => return Err(Refusal::Unreadable),
    }
    Ok(decoded)
}

/// Reads the `msg` of a deposit into `intents.near` as its `msg_kind`, the account it credits
/// (`None` for the DAO's own intents balance), and the effects of any intents it carries.
///
/// Empty: the DAO's own balance. A bare account name: a deposit for that account (ruling 16). A
/// JSON object with `intents` or `execute_intents`: those intents run, `intents_execute` when
/// any has an effect and `intents_deposit` otherwise. A JSON object with only a `receiver_id`: a
/// deposit for that account. Any other JSON is `other_json` and anything else `not_json`;
/// intents.near does not know where to credit those, so `intents.near` itself is the payee. A
/// duplicate key is refused as ambiguous (standard 2).
pub(super) fn deposit_message(msg: &str, dao: &str) -> Result<(MsgKind, Option<String>, Decoded), Refusal> {
    let credit = |account: &str| (account != dao).then(|| account.to_string());
    let nothing = Decoded::default;
    if msg.is_empty() {
        return Ok((MsgKind::Empty, None, nothing()));
    }
    if is_account_id(msg) {
        return Ok((MsgKind::IntentsDeposit, credit(msg), nothing()));
    }
    let fields = match json::parse(msg.as_bytes()) {
        Parsed::DuplicateKey => return Err(Refusal::Ambiguous),
        Parsed::NotJson => return Ok((MsgKind::NotJson, Some(INTENTS.into()), nothing())),
        Parsed::Json(Value::Object(fields)) => fields,
        Parsed::Json(_) => return Ok((MsgKind::OtherJson, Some(INTENTS.into()), nothing())),
    };
    let payee = match fields.get("receiver_id") {
        None | Some(Value::Null) => None,
        Some(Value::String(receiver)) if is_account_id(receiver) => credit(receiver),
        Some(_) => return Err(Refusal::Unreadable),
    };
    const LISTS: [&str; 2] = ["intents", "execute_intents"];
    if !LISTS.iter().any(|key| fields.contains_key(*key)) {
        return Ok(if fields.contains_key("receiver_id") {
            (MsgKind::IntentsDeposit, payee, nothing())
        } else {
            (MsgKind::OtherJson, Some(INTENTS.into()), nothing())
        });
    }
    let mut inner = Decoded::default();
    for key in LISTS {
        if fields.contains_key(key) {
            for item in list(&fields, key)? {
                read_item(item, key, &mut inner);
            }
        }
    }
    let kind = if inner.effects.is_empty() { MsgKind::IntentsDeposit } else { MsgKind::IntentsExecute };
    Ok((kind, payee, inner))
}

/// An array field of at most `MAX_ITEMS` entries.
fn list<'a>(fields: &'a Map<String, Value>, name: &str) -> Result<&'a [Value], Refusal> {
    match fields.get(name) {
        Some(Value::Array(items)) if items.len() <= MAX_ITEMS => Ok(items),
        _ => Err(Refusal::Unreadable),
    }
}

/// One entry of an intents list: a modelled intent's effects, or one `unknown_call` on
/// `intents.near` naming the intent kind (or `wrapper` for an entry with no kind, such as a
/// signed payload) with the entry as its arguments.
fn read_item(item: &Value, wrapper: &str, out: &mut Decoded) {
    let kind = item.get("intent").and_then(Value::as_str).filter(|k| !k.is_empty());
    let read = match (item.as_object(), kind) {
        (Some(fields), Some(kind)) => intent(kind, fields),
        _ => Err(Refusal::Unreadable),
    };
    match read {
        Ok(decoded) => out.extend(decoded),
        Err(_) => out.unknown(INTENTS, kind.unwrap_or(wrapper), item.clone(), &BigUint::ZERO),
    }
}

fn intent(kind: &str, fields: &Map<String, Value>) -> Result<Decoded, Refusal> {
    let mut decoded = Decoded::default();
    match kind {
        "ft_withdraw" => ft_withdraw(fields, Form::Intent, &mut decoded)?,
        "mt_withdraw" => mt_withdraw(fields, Form::Intent, &mut decoded)?,
        "add_public_key" | "remove_public_key" => key_change(kind, fields, &mut decoded)?,
        "transfer" => {
            let to = account(fields, "receiver_id")?;
            let tokens = match fields.get("tokens") {
                Some(Value::Object(tokens)) if !tokens.is_empty() && tokens.len() <= MAX_ITEMS => tokens,
                _ => return Err(Refusal::Unreadable),
            };
            for (token_id, sent) in tokens {
                let token = guide_token(token_id)?;
                let sent = sent.as_str().and_then(u128_amount).ok_or(Refusal::Unreadable)?;
                let effect = Effect::IntentsTransfer { token: token.clone(), amount: sent.to_string(), to: to.into() };
                decoded.push(effect, Some(Move::new(&token, &sent, Some(to))));
            }
        }
        // A diff with only non-negative entries gives nothing away, so it has no effect. A
        // negative entry fails the amount parser and the intent becomes an unknown call.
        "token_diff" => match fields.get("diff") {
            Some(Value::Object(diff)) if diff.len() <= MAX_ITEMS => {
                for change in diff.values() {
                    change.as_str().and_then(u128_amount).ok_or(Refusal::Unreadable)?;
                }
            }
            _ => return Err(Refusal::Unreadable),
        },
        _ => return Err(Refusal::Unreadable),
    }
    Ok(decoded)
}

fn ft_withdraw(fields: &Map<String, Value>, form: Form, out: &mut Decoded) -> Result<(), Refusal> {
    let token = account(fields, "token")?;
    let sent = amount(fields, "amount")?;
    withdraw(fields, token, token, None, &sent, out)?;
    after_withdraw(fields, token, "ft_on_transfer", form, out)
}

fn mt_withdraw(fields: &Map<String, Value>, form: Form, out: &mut Decoded) -> Result<(), Refusal> {
    let contract = account(fields, "token")?;
    let ids = list(fields, "token_ids")?;
    let amounts = list(fields, "amounts")?;
    if ids.is_empty() || ids.len() != amounts.len() {
        return Err(Refusal::Unreadable);
    }
    for (id, sent) in ids.iter().zip(amounts) {
        let id = id.as_str().filter(|id| !id.is_empty()).ok_or(Refusal::Unreadable)?;
        let sent = sent.as_str().and_then(u128_amount).ok_or(Refusal::Unreadable)?;
        withdraw(fields, &format!("nep245:{contract}:{id}"), contract, Some(id), &sent, out)?;
    }
    after_withdraw(fields, contract, "mt_on_transfer", form, out)
}

/// What a withdrawal of `contract`'s tokens does besides moving them (near/intents d340060,
/// contracts/defuse/src/contract/tokens/nep141/withdraw.rs 118-151, nep245/withdraw.rs 161-203).
///
/// An intent's `storage_deposit` pays that much wNEAR to `contract` for the receiver first: a
/// `storage_deposit` effect, and its part above `hash::intents::STORAGE_ALLOWANCE_YOCTO` also a
/// `transfer` of NEAR to `contract`, so the value findings judge it. Any `msg`, the empty one
/// included (`is_call` is `msg.is_some()`, core/src/intents/tokens.rs 177-181), makes the token
/// call `hook` on the receiver with it, which runs code this module cannot see: an
/// `unknown_call` there.
fn after_withdraw(fields: &Map<String, Value>, contract: &str, hook: &str, form: Form, out: &mut Decoded) -> Result<(), Refusal> {
    let receiver = text(fields, "receiver_id")?;
    if form == Form::Intent {
        if let Some(paid) = optional_text(fields, "storage_deposit")? {
            let paid = u128_amount(paid).ok_or(Refusal::Unreadable)?;
            let effect = Effect::StorageDeposit { contract: contract.into(), for_account: receiver.into(), amount: paid.to_string() };
            out.push(effect, None);
            if let Some(excess) = storage_excess(&paid) {
                let sent = Effect::Transfer { token: NATIVE.into(), amount: excess.to_string(), to: contract.into() };
                out.push(sent, Some(Move::new(NATIVE, &excess, Some(contract))));
            }
        }
    }
    if let Some(msg) = optional_text(fields, "msg")? {
        out.unknown(receiver, hook, json!({ "msg": msg }), &BigUint::ZERO);
    }
    Ok(())
}

/// One withdrawal of `token` (as the guide writes it) held by `contract`, with the destination
/// from `destination`. The destination is the payee (ruling 15).
fn withdraw(
    fields: &Map<String, Value>,
    token: &str,
    contract: &str,
    token_id: Option<&str>,
    sent: &BigUint,
    out: &mut Decoded,
) -> Result<(), Refusal> {
    let receiver = text(fields, "receiver_id")?;
    let memo = optional_text(fields, "memo")?;
    let stated_chain = optional_text(fields, "chain")?;
    let (chain, address) = destination(contract, token_id, receiver, memo, stated_chain);
    out.push(
        Effect::IntentsWithdraw { token: token.into(), amount: sent.to_string(), chain, address: address.clone() },
        Some(Move::new(token, sent, Some(address.as_str()))),
    );
    Ok(())
}

/// Where a withdrawal really goes, as (`chain`, `address`). Sending a bridge token to its own
/// bridge contract takes it off NEAR, to the address in a `WITHDRAW_TO:` memo, or to an `unknown`
/// address without one. Otherwise a stated `chain` other than NEAR wins, and the funds go to
/// `receiver_id` on NEAR.
fn destination(
    contract: &str,
    token_id: Option<&str>,
    receiver: &str,
    memo: Option<&str>,
    stated_chain: Option<&str>,
) -> (String, String) {
    if receiver == contract && is_bridge(contract) {
        let address = memo.and_then(|m| m.strip_prefix(WITHDRAW_TO)).unwrap_or(UNKNOWN);
        return (bridge_chain(contract, token_id), address.into());
    }
    match stated_chain {
        Some(chain) if !chain.is_empty() && !chain.eq_ignore_ascii_case(NATIVE) => (chain.into(), receiver.into()),
        _ => (NATIVE.into(), receiver.into()),
    }
}

/// HOT Omni, a PoA token (`.omft.near`) or an Omni Bridge token (`.omdep.near`, which replaced
/// HOT's ids for BNB Chain, Polygon and Avalanche on 9 Nov 2026).
fn is_bridge(contract: &str) -> bool {
    contract == HOT_OMNI
        || contract.strip_suffix(OMFT_SUFFIX).is_some_and(|stem| !stem.is_empty())
        || omni_chain(contract).is_some()
}

/// The census `blockchain` name of a bridge token, or `unknown`. Never `near`. An Omni Bridge
/// token is named by `hash::quote::omni_chain`, the reader a quote's payout chain uses.
fn bridge_chain(contract: &str, token_id: Option<&str>) -> String {
    let named = if contract == HOT_OMNI {
        token_id
            .and_then(|id| id.split_once('_'))
            .and_then(|(chain_id, _)| HOT_CHAINS.iter().find(|(id, _)| *id == chain_id))
            .map(|(_, chain)| *chain)
    } else if let Some(chain) = omni_chain(contract) {
        Some(chain)
    } else {
        contract
            .strip_suffix(OMFT_SUFFIX)
            .and_then(|stem| stem.split('-').next())
            .filter(|chain| !chain.is_empty() && chain.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
    };
    named.filter(|chain| *chain != NATIVE).unwrap_or(UNKNOWN).into()
}

fn key_change(method: &str, fields: &Map<String, Value>, out: &mut Decoded) -> Result<(), Refusal> {
    let op = if method == "add_public_key" { KeyOp::Add } else { KeyOp::Remove };
    let public_key = text(fields, "public_key")?;
    out.push(Effect::IntentsKeyChange { op, public_key: public_key.into() }, None);
    Ok(())
}

/// A token id inside intents.near as the guide writes it: `nep141:` dropped from a fungible
/// token, a multi-token or NFT id kept whole. An id with no standard prefix is not one
/// intents.near holds.
fn guide_token(token_id: &str) -> Result<String, Refusal> {
    if let Some(contract) = token_id.strip_prefix("nep141:") {
        return if is_account_id(contract) { Ok(contract.into()) } else { Err(Refusal::Unreadable) };
    }
    if token_id.starts_with("nep245:") || token_id.starts_with("nep171:") {
        return Ok(token_id.into());
    }
    Err(Refusal::Unreadable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_chains_are_census_names() {
        assert_eq!(bridge_chain("sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", None), "sol");
        assert_eq!(bridge_chain("zec.omft.near", None), "zec");
        assert_eq!(bridge_chain(HOT_OMNI, Some("1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR")), "ton");
        assert_eq!(bridge_chain(HOT_OMNI, Some("4444119_wyixUKCL")), UNKNOWN);
        assert_eq!(bridge_chain("near.omft.near", None), UNKNOWN);
    }

    #[test]
    fn a_withdrawal_to_a_bridge_without_a_memo_has_an_unknown_address() {
        let to_bridge = destination("eth.omft.near", None, "eth.omft.near", None, None);
        assert_eq!(to_bridge, ("eth".into(), UNKNOWN.into()));
        let memo_without_bridge = destination("wrap.near", None, "alice.near", Some("WITHDRAW_TO:0xabc"), None);
        assert_eq!(memo_without_bridge, (NATIVE.into(), "alice.near".into()));
    }
}
