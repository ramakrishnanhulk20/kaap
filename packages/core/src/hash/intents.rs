//! What the intents of a verified NEP-413 text authorise. The modelled kinds are the guide's
//! section 3 list (transfers, withdrawals and key changes); anything else, and any key change, is
//! HASH_TEXT_DANGEROUS (guide section 4; C6; standard 1: a missing entry produces an alert, not a
//! pass).
//!
//! The modelled intents are read by `decode::value`'s own intents reader, the one that reads an
//! `execute_intents` call the DAO makes itself, so a signed intent and a direct one can never be
//! read two ways (standard 2), and the value findings (NEW_RECIPIENT, LARGE_AMOUNT, UNKNOWN_VALUE,
//! LOOKALIKE_TOKEN, CROSS_CHAIN_OUT, INTENTS_KEY_CHANGE) come from the one place that computes
//! them. A text signed by the DAO executes its intents as the DAO, which is what that call means.
//!
//! A transfer to a 1Click deposit address keeps that address as its payee, so NEW_RECIPIENT judges
//! it, unless a verified quote names the real payee (C7, `quote_payout`).

use base64::Engine as _;
use serde_json::{json, Map, Value};

use super::quote::{payout_chain, Quote};
use crate::decode::value::base_units;
use crate::types::{Effect, FindingCode, ProposalInput};

/// The intent kinds guide section 3 gives an effect to.
pub const MODELLED_KINDS: [&str; 5] = ["transfer", "ft_withdraw", "mt_withdraw", "add_public_key", "remove_public_key"];

/// The account `decode::value` reads intents on. A text for the confidential shard
/// (`intents.far`) runs the same verifier, so it is read the same way.
const INTENTS: &str = "intents.near";

/// The effects and codes of `intents`, signed by `input.dao` for the verifier at `recipient`
/// with the text's deadline `deadline_ns`. `quotes` are quotes whose signature already checked.
/// A modelled kind whose fields do not read is treated like an unknown kind.
pub fn judge(
    intents: &[Map<String, Value>],
    recipient: &str,
    deadline_ns: i128,
    quotes: &[Quote],
    input: &ProposalInput,
) -> (Vec<Effect>, Vec<FindingCode>) {
    let mut effects = Vec::new();
    let mut codes = Vec::new();
    let mut dangerous = false;
    let mut modelled = Vec::new();
    for item in intents {
        match item.get("intent").and_then(Value::as_str) {
            Some(kind) if MODELLED_KINDS.contains(&kind) => {
                let item = quote_payout(item, deadline_ns, quotes).unwrap_or_else(|| item.clone());
                modelled.push(Value::Object(item));
            }
            _ => {
                dangerous = true;
                effects.push(unknown_intent(item.clone(), recipient));
            }
        }
    }
    if !modelled.is_empty() {
        let (decoded, decoded_codes) = executed(modelled, input);
        for effect in decoded {
            match effect {
                Effect::UnknownCall { args: Value::Object(item), .. } => {
                    dangerous = true;
                    effects.push(unknown_intent(item, recipient));
                }
                Effect::UnknownCall { .. } => {
                    dangerous = true;
                    effects.push(unknown_intent(Map::new(), recipient));
                }
                Effect::IntentsKeyChange { .. } => {
                    dangerous = true;
                    effects.push(effect);
                }
                other => effects.push(other),
            }
        }
        codes.extend(decoded_codes.into_iter().filter(|c| *c != FindingCode::UnknownCall));
    }
    if dangerous {
        codes.push(FindingCode::HashTextDangerous);
    }
    (effects, codes)
}

/// `intents` as the one `execute_intents` call on `intents.near` that would run them as the DAO,
/// decoded by `decode::value`.
fn executed(intents: Vec<Value>, input: &ProposalInput) -> (Vec<Effect>, Vec<FindingCode>) {
    let args = base64::engine::general_purpose::STANDARD.encode(json!({ "signed": intents }).to_string());
    let kind = json!({"FunctionCall": {"receiver_id": INTENTS, "actions": [
        {"method_name": "execute_intents", "args": args, "deposit": "0", "gas": "0"}
    ]}});
    super::decode_as(&kind, input)
}

/// A `transfer` of one token to a quote's deposit address, rewritten as the withdrawal the quote
/// promises: the same token and amount, to the quote's recipient on its payout chain. Only a
/// quote whose deposit address, origin asset, `amountIn` (whole base units) and deadline (to
/// the nanosecond) all equal the transfer's and the text's maps it. `None` leaves the transfer
/// as written, its deposit address the payee.
fn quote_payout(item: &Map<String, Value>, deadline_ns: i128, quotes: &[Quote]) -> Option<Map<String, Value>> {
    if item.get("intent")?.as_str()? != "transfer" {
        return None;
    }
    let to = item.get("receiver_id")?.as_str()?;
    let tokens = item.get("tokens")?.as_object().filter(|tokens| tokens.len() == 1)?;
    let (token_id, amount) = tokens.iter().next()?;
    let amount = base_units(amount.as_str()?, 0)?;
    let quote = quotes.iter().find(|q| {
        q.deposit_address == to && q.origin_asset == *token_id && q.amount_in == amount && q.deadline_ns == deadline_ns
    })?;
    let chain = payout_chain(quote);
    let withdrawal = if let Some(contract) = token_id.strip_prefix("nep141:") {
        json!({"intent": "ft_withdraw", "token": contract, "receiver_id": quote.recipient, "amount": amount.to_string(), "chain": chain})
    } else {
        let (contract, id) = token_id.strip_prefix("nep245:")?.split_once(':')?;
        json!({"intent": "mt_withdraw", "token": contract, "token_ids": [id], "amounts": [amount.to_string()], "receiver_id": quote.recipient, "chain": chain})
    };
    withdrawal.as_object().cloned()
}

/// An intent Kaap does not model, as an `unknown_call` on the verifier named after its kind (or
/// `intent` when it names none), with every other field as its arguments. It carries no
/// UNKNOWN_CALL: it is not a call, and HASH_TEXT_DANGEROUS already reports it (guide section 4).
fn unknown_intent(mut item: Map<String, Value>, recipient: &str) -> Effect {
    let method = match item.remove("intent") {
        Some(Value::String(kind)) if !kind.is_empty() => kind,
        _ => "intent".to_string(),
    };
    Effect::UnknownCall { receiver: recipient.to_string(), method, args: Value::Object(item), deposit: "0".into() }
}
