//! What the intents of a verified NEP-413 text authorise. Each kind is read to the shape the
//! NEAR Intents verifier defines it (near/intents d340060, contracts/defuse/core/src/intents/
//! tokens.rs and token_diff.rs); anything else, any field Kaap does not read, and any key change
//! is HASH_TEXT_DANGEROUS (guide section 4; C6; standard 1: a missing entry produces an alert,
//! not a pass).
//!
//! - `transfer`, `ft_withdraw`, `mt_withdraw`, `add_public_key`, `remove_public_key` are read by
//!   `decode::value`'s own intents reader, the one that reads an `execute_intents` call the DAO
//!   makes itself, a withdrawal's `msg` and `storage_deposit` included, so a signed intent and a
//!   direct one can never be read two ways (standard 2). A text signed by the DAO executes its
//!   intents as the DAO, which is what that call means.
//! - `native_withdraw` (tokens.rs 436-439) sends wNEAR out as native NEAR to `receiver_id`: it is
//!   read as an `ft_withdraw` of token `near`, an `intents_withdraw` of `near` on `near`.
//! - `storage_deposit` (tokens.rs 480-488) is a `storage_deposit` effect, and its part above
//!   `STORAGE_ALLOWANCE_YOCTO` is also a `transfer` of NEAR to the contract.
//! - `token_diff` (token_diff.rs 30-39) with at least one token given and one received is an
//!   `intents_swap`. One that only gives lets value leave with nothing in return, and one that
//!   only receives is not a shape 1Click builds, so both are refused.
//!
//! The value findings (NEW_RECIPIENT, LARGE_AMOUNT, UNKNOWN_VALUE, LOOKALIKE_TOKEN,
//! CROSS_CHAIN_OUT, INTENTS_KEY_CHANGE) come from one `decode::value` reading of the whole text,
//! so LARGE_AMOUNT judges its total. A swap's `gives` count there as value leaving with no payee.
//!
//! A transfer to a 1Click deposit address keeps that address as its payee, so NEW_RECIPIENT judges
//! it, unless a verified quote names the real payee (C7, `quote_payout`). Such a quote also names
//! the account 1Click refunds when the swap fails; unless that is the DAO, NEW_RECIPIENT judges it
//! too.

use base64::Engine as _;
use num_bigint::BigUint;
use serde_json::{json, Map, Value};

use super::quote::{payout_chain, Quote};
use crate::decode::account::is_account_id;
use crate::decode::value::{base_units, new_payee};
use crate::types::{Effect, FindingCode, ProposalInput, TokenAmount};

/// The kinds `decode::value` reads exactly as the text writes them.
const DECODED_KINDS: [&str; 5] = ["transfer", "ft_withdraw", "mt_withdraw", "add_public_key", "remove_public_key"];

/// The account `decode::value` reads intents on. A text for the confidential shard
/// (`intents.far`) runs the same verifier, so it is read the same way.
const INTENTS: &str = "intents.near";

const NATIVE: &str = "near";

/// A storage deposit up to 0.1 NEAR pays for a registration, which costs about 0.00125 NEAR (the
/// NEAR Intents docs, `storage_deposit`). Above it, the rest counts as NEAR sent to the contract,
/// so a storage deposit cannot carry value past the value findings (guide rulings 32 and 33, 2 Nov
/// 2026). `decode::intents` applies it to a withdrawal's own `storage_deposit`.
pub const STORAGE_ALLOWANCE_YOCTO: u128 = 100_000_000_000_000_000_000_000;

/// One `decode::value` reading holds at most 100 actions, one of which runs the text's other
/// intents, so a text may give at most 99 tokens in its swaps; one that gives more is refused.
const MAX_GIVES: usize = 99;

/// The most entries one `token_diff` may hold, the cap `decode::value` puts on any list.
const MAX_DIFF: usize = 100;

/// The part of a storage deposit of `paid` yoctoNEAR above `STORAGE_ALLOWANCE_YOCTO`, or `None`
/// when it is all a registration.
pub fn storage_excess(paid: &BigUint) -> Option<BigUint> {
    let allowance = BigUint::from(STORAGE_ALLOWANCE_YOCTO);
    (*paid > allowance).then(|| paid - allowance)
}

/// The effects and codes of `intents`, signed by `input.dao` for the verifier at `recipient`
/// with the text's deadline `deadline_ns`. `quotes` are quotes whose signature already checked.
/// A kind whose fields do not read is treated like an unknown kind.
pub fn judge(
    intents: &[Map<String, Value>],
    recipient: &str,
    deadline_ns: i128,
    quotes: &[Quote],
    input: &ProposalInput,
) -> (Vec<Effect>, Vec<FindingCode>) {
    let mut text = Reading::default();
    for item in intents {
        let kind = item.get("intent").and_then(Value::as_str).unwrap_or_default();
        let read = match kind {
            "transfer" => match quote_payout(item, deadline_ns, quotes) {
                Some((paid, quote)) => {
                    if quote.refund_to != input.dao {
                        text.refunds.push(quote.refund_to.clone());
                    }
                    text.decoded(paid, input)
                }
                None => text.decoded(item.clone(), input),
            },
            _ if DECODED_KINDS.contains(&kind) => text.decoded(item.clone(), input),
            "native_withdraw" => native_withdraw(item).is_some_and(|sent| text.decoded(sent, input)),
            "storage_deposit" => text.storage_deposit(item, input),
            "token_diff" => text.swap(item, input),
            _ => false,
        };
        if !read {
            text.dangerous = true;
            text.effects.push(unknown_intent(item.clone(), recipient));
        }
    }
    text.finish(input)
}

/// A text as it is read, intent by intent.
#[derive(Default)]
struct Reading {
    effects: Vec<Effect>,
    /// The intents `decode::value` reads, as it reads them, and the effects each gave read alone.
    signed: Vec<Value>,
    alone: Vec<Effect>,
    /// The tokens the swaps give, as the text writes their ids, with the amounts.
    gives: Vec<(String, BigUint)>,
    /// The refund accounts of the quotes that mapped a transfer, where that account is not the DAO.
    refunds: Vec<String>,
    dangerous: bool,
}

impl Reading {
    /// Reads `intent` through `decode::value`. False when it gives no typed effect, which is how
    /// that reader answers an intent it cannot read.
    fn decoded(&mut self, intent: Map<String, Value>, input: &ProposalInput) -> bool {
        let intent = Value::Object(intent);
        let (effects, _) = executed(std::slice::from_ref(&intent), &[], input);
        if effects.iter().all(|e| matches!(e, Effect::UnknownCall { .. })) {
            return false;
        }
        self.dangerous |= effects.iter().any(|e| matches!(e, Effect::IntentsKeyChange { .. }));
        self.alone.extend(effects.iter().cloned());
        self.effects.extend(effects);
        self.signed.push(intent);
        true
    }

    /// `{"intent", "contract_id", "deposit_for_account_id" or its alias "account_id", "amount"}`.
    /// The part above the allowance is read as an `ft_withdraw` of `near` to the contract, which
    /// gives the value findings of NEAR sent there, and shown as the `transfer` it is.
    fn storage_deposit(&mut self, item: &Map<String, Value>, input: &ProposalInput) -> bool {
        let Some((contract, for_account, paid)) = storage_fields(item) else { return false };
        let mut sent = None;
        if let Some(excess) = storage_excess(&paid) {
            let to_contract = json!({"intent": "ft_withdraw", "token": NATIVE, "receiver_id": contract, "amount": excess.to_string()});
            let (effects, _) = executed(std::slice::from_ref(&to_contract), &[], input);
            let [withdrawn @ Effect::IntentsWithdraw { .. }] = effects.as_slice() else { return false };
            sent = Some((to_contract, withdrawn.clone(), excess));
        }
        let paid = paid.to_string();
        self.effects.push(Effect::StorageDeposit { contract: contract.into(), for_account: for_account.into(), amount: paid });
        if let Some((to_contract, withdrawn, excess)) = sent {
            self.effects.push(Effect::Transfer { token: NATIVE.into(), amount: excess.to_string(), to: contract.into() });
            self.alone.push(withdrawn);
            self.signed.push(to_contract);
        }
        true
    }

    /// A `token_diff` with only `diff`, and optionally its `memo` and `referral`, which move
    /// nothing (token_diff.rs 42-104). Each token id is named by `decode::value`'s own reader.
    fn swap(&mut self, item: &Map<String, Value>, input: &ProposalInput) -> bool {
        let Some(entries) = diff_entries(item) else { return false };
        let (mut gives, mut receives) = (Vec::new(), Vec::new());
        for (token_id, given, amount) in &entries {
            let Some(token) = guide_name(token_id, input) else { return false };
            let side = if *given { &mut gives } else { &mut receives };
            side.push(TokenAmount { token, amount: amount.to_string() });
        }
        if gives.is_empty() || receives.is_empty() {
            return false;
        }
        self.gives.extend(entries.into_iter().filter(|(_, given, _)| *given).map(|(id, _, amount)| (id, amount)));
        self.effects.push(Effect::IntentsSwap { gives, receives });
        true
    }

    /// The codes of the whole text, from one `decode::value` reading of every intent it reads and
    /// every token its swaps give. That reading must give exactly what the intents gave one by one,
    /// then one deposit back per token given; anything else, a list too long for one reading
    /// included, makes the text HASH_TEXT_DANGEROUS.
    fn finish(mut self, input: &ProposalInput) -> (Vec<Effect>, Vec<FindingCode>) {
        let mut codes = Vec::new();
        if self.gives.len() > MAX_GIVES {
            self.dangerous = true;
        } else if !self.signed.is_empty() || !self.gives.is_empty() {
            let (effects, decoded_codes) = executed(&self.signed, &self.gives, input);
            let read_as_parts = effects.len() == self.alone.len() + self.gives.len()
                && effects[..self.alone.len()] == self.alone[..]
                && effects[self.alone.len()..].iter().all(|e| matches!(e, Effect::TokenCallTransfer { .. }));
            if read_as_parts {
                codes.extend(decoded_codes);
            } else {
                self.dangerous = true;
            }
        }
        // A refund account is paid the same funds when the swap fails, so it is judged as a payee
        // by the same NEW_RECIPIENT test, without counting the funds a second time.
        if self.refunds.iter().any(|refund| new_payee(refund, input.history.as_ref())) {
            codes.push(FindingCode::NewRecipient);
        }
        if self.dangerous {
            codes.push(FindingCode::HashTextDangerous);
        }
        (self.effects, codes)
    }
}

/// `{"intent", "receiver_id", "amount"}` as the `ft_withdraw` of `near` it is read as.
fn native_withdraw(item: &Map<String, Value>) -> Option<Map<String, Value>> {
    if !has_exactly(item, &["intent", "receiver_id", "amount"]) {
        return None;
    }
    let receiver = item.get("receiver_id")?.as_str().filter(|r| is_account_id(r))?;
    let amount = item.get("amount")?.as_str()?;
    json!({"intent": "ft_withdraw", "token": NATIVE, "receiver_id": receiver, "amount": amount}).as_object().cloned()
}

/// The contract, the account it registers and the yoctoNEAR paid. Both the field name and its
/// alias at once would be a duplicate field to the verifier, so that is refused.
fn storage_fields(item: &Map<String, Value>) -> Option<(&str, &str, BigUint)> {
    let for_key = match (item.contains_key("deposit_for_account_id"), item.contains_key("account_id")) {
        (true, false) => "deposit_for_account_id",
        (false, true) => "account_id",
        _ => return None,
    };
    if !has_exactly(item, &["intent", "contract_id", for_key, "amount"]) {
        return None;
    }
    let account = |name: &str| item.get(name)?.as_str().filter(|a| is_account_id(a));
    let paid = base_units(item.get("amount")?.as_str()?, 0).filter(|a| a.bits() <= 128)?;
    Some((account("contract_id")?, account(for_key)?, paid))
}

/// Each entry of a `token_diff`'s `diff` as (token id, given, amount). The verifier reads each as
/// an `i128` and refuses an empty diff or a zero entry (token_diff.rs 52-62), so an amount that is
/// zero, signed other than by one leading `-`, or past 127 bits is refused here too.
fn diff_entries(item: &Map<String, Value>) -> Option<Vec<(String, bool, BigUint)>> {
    if item.keys().any(|k| !["intent", "diff", "memo", "referral"].contains(&k.as_str())) {
        return None;
    }
    if item.get("memo").is_some_and(|m| !m.is_string()) {
        return None;
    }
    if item.get("referral").is_some_and(|r| !r.as_str().is_some_and(is_account_id)) {
        return None;
    }
    let diff = item.get("diff")?.as_object().filter(|d| !d.is_empty() && d.len() <= MAX_DIFF)?;
    diff.iter()
        .map(|(token_id, delta)| {
            let delta = delta.as_str()?;
            let (given, digits) = match delta.strip_prefix('-') {
                Some(digits) => (true, digits),
                None => (false, delta),
            };
            let amount = base_units(digits, 0).filter(|a| a.bits() <= 127 && *a != BigUint::ZERO)?;
            Some((token_id.clone(), given, amount))
        })
        .collect()
}

fn has_exactly(item: &Map<String, Value>, keys: &[&str]) -> bool {
    item.len() == keys.len() && keys.iter().all(|k| item.contains_key(*k))
}

/// The token as the guide writes it (`nep141:` dropped, any other id kept whole), named by the
/// reader `decode::value` prices every intents token with, or `None` for an id intents.near does
/// not hold.
fn guide_name(token_id: &str, input: &ProposalInput) -> Option<String> {
    let (effects, _) = executed(&[], &[(token_id.to_string(), BigUint::from(1u8))], input);
    match effects.as_slice() {
        [Effect::TokenCallTransfer { token, .. }] => Some(token.clone()),
        _ => None,
    }
}

/// `signed` as the one `execute_intents` call on `intents.near` that would run them as the DAO,
/// then one deposit back into `intents.near` with an empty message for each token given, all
/// decoded by `decode::value` as one proposal. A deposit back credits the DAO's own balance, so
/// it reads as value leaving with no payee, which is what a swap gives: the tokens go to whoever
/// fills it, and what comes back is its `receives`.
fn executed(signed: &[Value], gives: &[(String, BigUint)], input: &ProposalInput) -> (Vec<Effect>, Vec<FindingCode>) {
    let call = |method: &str, args: Value| {
        let args = base64::engine::general_purpose::STANDARD.encode(args.to_string());
        json!({"method_name": method, "args": args, "deposit": "0", "gas": "0"})
    };
    let mut actions = Vec::new();
    if !signed.is_empty() {
        actions.push(call("execute_intents", json!({ "signed": signed })));
    }
    for (token_id, amount) in gives {
        let args = json!({"receiver_id": INTENTS, "token_id": token_id, "amount": amount.to_string(), "msg": ""});
        actions.push(call("mt_transfer_call", args));
    }
    let kind = json!({"FunctionCall": {"receiver_id": INTENTS, "actions": actions}});
    super::decode_as(&kind, input)
}

/// A `transfer` of one token to a quote's deposit address, rewritten as the withdrawal the quote
/// promises: the same token and amount, to the quote's recipient on its payout chain, with the
/// quote that mapped it. Only a quote whose deposit address, origin asset, `amountIn` (whole base
/// units) and deadline (to the nanosecond) all equal the transfer's and the text's maps it. `None`
/// leaves the transfer as written, its deposit address the payee.
fn quote_payout<'q>(item: &Map<String, Value>, deadline_ns: i128, quotes: &'q [Quote]) -> Option<(Map<String, Value>, &'q Quote)> {
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
    Some((withdrawal.as_object().cloned()?, quote))
}

/// An intent Kaap does not read, as an `unknown_call` on the verifier named after its kind (or
/// `intent` when it names none), with every other field as its arguments. It carries no
/// UNKNOWN_CALL: it is not a call, and HASH_TEXT_DANGEROUS already reports it (guide section 4).
fn unknown_intent(mut item: Map<String, Value>, recipient: &str) -> Effect {
    let method = match item.remove("intent") {
        Some(Value::String(kind)) if !kind.is_empty() => kind,
        _ => "intent".to_string(),
    };
    Effect::UnknownCall { receiver: recipient.to_string(), method, args: Value::Object(item), deposit: "0".into() }
}
