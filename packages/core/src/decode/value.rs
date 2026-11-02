//! Effects and findings for the Transfer kind and for FunctionCall kinds: payments, token and
//! intents calls, wrapping, staking, storage deposits, DeFi, bulk payments and Kaap's own
//! enrolment call (guide sections 3 and 4; rulings 2, 3, 4, 10, 14, 15, 16, 17, 21 and 27).
//! FunctionCall actions to `v1.signer` method `sign` belong to `hash::check`, and this module
//! emits nothing for them, their attached NEAR included. Every other kind is `policy::decode`'s.
//!
//! A method means something only on the exact receiver the kind names (C3, `known::classify`),
//! and a token's value is looked up by its exact contract id. Anything this module cannot read
//! becomes an `unknown_call` with UNKNOWN_CALL, never a quiet pass (C2, standard 1). The findings
//! are worked out once, in `Sheet::finish`, from everything the actions decoded to.

use base64::Engine as _;
use num_bigint::BigUint;
use serde_json::{Map, Value};

use super::account::is_account_id;
use super::intents;
use super::json::{self, Parsed};
use super::known::{self, is_lookalike, Known};
use crate::canonical::canonical_kind;
use crate::enrolment;
use crate::types::{Effect, FindingCode, MsgKind, ProposalInput, Prices, StakingOp, WrapOp};

/// Sputnik stores native NEAR as an empty `token_id` (`OLD_BASE_TOKEN`); the guide writes it
/// `near`.
pub(super) const NATIVE: &str = "near";

/// Integer digits plus decimals above this are refused before any big-number work (standard 4).
/// u128, the widest amount Sputnik stores, has 39 digits, and real tokens use at most 24 decimals.
const MAX_AMOUNT_DIGITS: usize = 96;

/// Sputnik sends all of a FunctionCall's actions in one receipt, and NEAR runs at most 100
/// actions in a receipt (`max_actions_per_receipt`, mainnet protocol config read 20 Oct 2026), so a
/// longer list cannot execute. It is refused as unreadable, which also bounds the work.
const MAX_ACTIONS: usize = 100;

/// The most entries one list inside an action may hold (token ids, intents, signed payloads,
/// the tokens of one intents transfer). A longer list is refused as unreadable, so one action can
/// never produce an unbounded number of effects.
pub(super) const MAX_ITEMS: usize = 100;

pub(super) const INTENTS: &str = "intents.near";
const BULK_PAYMENT: &str = "bulkpayment.near";

/// A deposit of exactly 1 yoctoNEAR is the security deposit NEAR standards ask for, not value
/// (guide section 4, ATTACHED_DEPOSIT: "more than 1 yoctoNEAR").
const SECURITY_DEPOSIT: u8 = 1;

/// LARGE_AMOUNT: more than this many times the median earlier payment.
const LARGE_FACTOR: f64 = 10.0;

/// Returns this module's effects and findings for `input`: something for the Transfer kind and
/// for every FunctionCall that is not only `v1.signer` `sign` actions, nothing for any other kind.
/// Never panics on any `kind_json` (standard 4).
pub fn decode(input: &ProposalInput) -> (Vec<Effect>, Vec<FindingCode>) {
    let mut sheet = Sheet::default();
    match read_kind(&input.kind_json) {
        Some((variant, body)) if variant == "Transfer" => transfer(&body, &mut sheet),
        Some((variant, body)) if variant == "FunctionCall" => function_call(&body, input, &mut sheet),
        _ => return (Vec::new(), Vec::new()),
    }
    sheet.finish(input)
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

/// A whole number of base units that a `U128` field (Sputnik's and every NEAR token's amount
/// type) can hold. A receiver could not parse anything else, so callers treat it as unreadable.
pub(super) fn u128_amount(text: &str) -> Option<BigUint> {
    base_units(text, 0).filter(|a| a.bits() <= 128)
}

/// One amount of value leaving the DAO's NEAR account, kept beside the effects for the value
/// findings. `payee` is who NEW_RECIPIENT judges: the real destination, the account an intents
/// deposit message credits, or `None` when the receiving contract only holds the funds for a
/// known effect or the DAO's own intents balance (ruling 4).
pub(super) struct Move {
    pub token: String,
    pub amount: BigUint,
    pub payee: Option<String>,
}

impl Move {
    pub(super) fn new(token: &str, amount: &BigUint, payee: Option<&str>) -> Self {
        Move { token: token.to_string(), amount: amount.clone(), payee: payee.map(str::to_string) }
    }
}

/// What one action, or a list inside one, decodes to.
#[derive(Default)]
pub(super) struct Decoded {
    pub effects: Vec<Effect>,
    pub moves: Vec<Move>,
    /// The action's attached NEAR is this effect's own amount (a wrap, a staking deposit, a
    /// storage deposit, a bulk list's total), so it is not also a transfer (ruling 4).
    pub takes_deposit: bool,
}

impl Decoded {
    pub(super) fn push(&mut self, effect: Effect, value: Option<Move>) {
        self.effects.push(effect);
        self.moves.extend(value);
    }

    pub(super) fn unknown(&mut self, receiver: &str, method: &str, args: Value, deposit: &BigUint) {
        self.effects.push(Effect::UnknownCall {
            receiver: receiver.to_string(),
            method: method.to_string(),
            args,
            deposit: deposit.to_string(),
        });
    }

    pub(super) fn extend(&mut self, other: Decoded) {
        self.effects.extend(other.effects);
        self.moves.extend(other.moves);
    }
}

/// Why an action did not decode to known effects. Either way it becomes an `unknown_call`;
/// `Ambiguous` also fires ARGS_NOT_JSON, because a `msg` inside valid arguments had a duplicate
/// key and so has no single reading (standard 2).
pub(super) enum Refusal {
    Unreadable,
    Ambiguous,
}

/// Everything one kind decoded to, before the findings are worked out.
#[derive(Default)]
struct Sheet {
    decoded: Decoded,
    /// The kind itself is not what Sputnik stores, so nothing in it can be trusted.
    unreadable: bool,
    attached_deposit: bool,
    args_not_json: bool,
}

impl Sheet {
    /// The findings this module owns, each from facts already decoded (guide section 4).
    fn finish(self, input: &ProposalInput) -> (Vec<Effect>, Vec<FindingCode>) {
        let effects = self.decoded.effects;
        let mut codes = Vec::new();
        if self.unreadable || effects.iter().any(|e| matches!(e, Effect::UnknownCall { .. })) {
            codes.push(FindingCode::UnknownCall);
        }
        if self.args_not_json {
            codes.push(FindingCode::ArgsNotJson);
        }
        if self.attached_deposit {
            codes.push(FindingCode::AttachedDeposit);
        }
        // Every key change this module decodes is on the DAO's own intents account: a direct
        // call by the DAO, or an unsigned intent the DAO executes as itself.
        if effects.iter().any(|e| matches!(e, Effect::IntentsKeyChange { .. })) {
            codes.push(FindingCode::IntentsKeyChange);
        }
        if effects.iter().any(|e| matches!(e, Effect::IntentsWithdraw { chain, .. } if chain != NATIVE)) {
            codes.push(FindingCode::CrossChainOut);
        }
        value_codes(&self.decoded.moves, input, &mut codes);
        (effects, codes)
    }
}

/// UNKNOWN_VALUE, LOOKALIKE_TOKEN, NEW_RECIPIENT and LARGE_AMOUNT. An unpriced token counts as
/// unknown, never as zero, and never towards LARGE_AMOUNT (ruling 14). The priced total is at
/// least every priced effect on its own, so one comparison covers both halves of the guide's rule.
/// Tokens deposited into intents.near and then sent on by an intent in the same message count
/// twice, so LARGE_AMOUNT errs towards firing there.
fn value_codes(moves: &[Move], input: &ProposalInput, codes: &mut Vec<FindingCode>) {
    let mut priced_total = 0.0;
    let mut unpriced = false;
    for value in moves {
        match usd_value(value, &input.prices) {
            Some(usd) => priced_total += usd,
            None => unpriced = true,
        }
    }
    if unpriced {
        codes.push(FindingCode::UnknownValue);
    }
    if moves.iter().any(|m| is_lookalike(&m.token)) {
        codes.push(FindingCode::LookalikeToken);
    }
    let Some(history) = &input.history else {
        return;
    };
    let paid_before = |payee: &String| history.recipients_paid_before.contains(payee);
    if moves.iter().any(|m| m.payee.as_ref().is_some_and(|p| !paid_before(p))) {
        codes.push(FindingCode::NewRecipient);
    }
    if history.median_payment_usd_before.is_some_and(|median| priced_total > LARGE_FACTOR * median) {
        codes.push(FindingCode::LargeAmount);
    }
}

/// USD value of one move from the price list, keyed by the exact token id (C3). A missing,
/// zero, negative or non-finite price is no price (C2).
fn usd_value(value: &Move, prices: &Prices) -> Option<f64> {
    let &(decimals, usd) = prices.usd_by_token.get(&value.token)?;
    if !(usd.is_finite() && usd > 0.0) {
        return None;
    }
    let units: f64 = value.amount.to_string().parse().ok()?;
    Some(units / 10f64.powi(i32::from(decimals)) * usd)
}

/// A Transfer kind as Sputnik's `internal_payout` runs it (proposals.rs 311-337): native NEAR
/// when `token_id` is empty, otherwise `ft_transfer` on the token, or `ft_transfer_call` when a
/// `msg` is set.
///
/// A body this cannot read, an amount Sputnik's `U128` could not hold, an explicit `token_id` of
/// `near` (it would read as native NEAR here while Sputnik calls the `near` account), and the
/// `ft_transfer_call` form give UNKNOWN_CALL with no effect: the kind is not understood, so it
/// must not come out low (C2). The `ft_transfer_call` form stays there because
/// `tests/decoders.rs` pins it; no record in the answer key uses it.
fn transfer(body: &Value, sheet: &mut Sheet) {
    let field = |name: &str| body.get(name).and_then(Value::as_str);
    let (Some(token_id), Some(to), Some(amount)) =
        (field("token_id"), field("receiver_id"), field("amount"))
    else {
        sheet.unreadable = true;
        return;
    };
    let Some(amount) = u128_amount(amount) else {
        sheet.unreadable = true;
        return;
    };
    let msg_set = match body.get("msg") {
        None | Some(Value::Null) => false,
        Some(Value::String(_)) => true,
        Some(_) => {
            sheet.unreadable = true;
            return;
        }
    };
    if to.is_empty() || token_id == NATIVE || (!token_id.is_empty() && msg_set) {
        sheet.unreadable = true;
        return;
    }
    let token = if token_id.is_empty() { NATIVE } else { token_id };
    let effect = Effect::Transfer { token: token.into(), amount: amount.to_string(), to: to.into() };
    sheet.decoded.push(effect, Some(Move::new(token, &amount, Some(to))));
}

struct Action {
    method: String,
    args: Vec<u8>,
    deposit: BigUint,
}

/// A FunctionCall kind, action by action, in the order Sputnik runs them. A kind whose shape
/// Sputnik could not have stored (a receiver that is not an account id, no actions or more than
/// `MAX_ACTIONS`, arguments that are not base64, a deposit its `U128` could not hold) is
/// unreadable as a whole: UNKNOWN_CALL and no effect.
fn function_call(body: &Value, input: &ProposalInput, sheet: &mut Sheet) {
    let Some((receiver, actions)) = read_call(body) else {
        sheet.unreadable = true;
        return;
    };
    for action in &actions {
        if action.method == "sign" && known::classify(receiver, &action.method) == Known::Signer {
            continue;
        }
        decode_action(receiver, action, input, sheet);
    }
}

fn read_call(body: &Value) -> Option<(&str, Vec<Action>)> {
    let receiver = body.get("receiver_id")?.as_str().filter(|r| is_account_id(r))?;
    let actions = body.get("actions")?.as_array()?;
    if actions.is_empty() || actions.len() > MAX_ACTIONS {
        return None;
    }
    let actions = actions
        .iter()
        .map(|action| {
            let args = action.get("args")?.as_str()?;
            Some(Action {
                method: action.get("method_name")?.as_str()?.to_string(),
                args: base64::engine::general_purpose::STANDARD.decode(args).ok()?,
                deposit: u128_amount(action.get("deposit")?.as_str()?)?,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    Some((receiver, actions))
}

/// One action's effects. Whatever is not read as a known effect becomes an `unknown_call`, and
/// attached NEAR that no effect accounts for becomes a `transfer` to the receiver with
/// ATTACHED_DEPOSIT, so attached NEAR is always counted as sent (C2).
fn decode_action(receiver: &str, action: &Action, input: &ProposalInput, sheet: &mut Sheet) {
    let method = action.method.as_str();
    let args = match action.args.as_slice() {
        [] => Parsed::Json(Value::Object(Map::new())),
        bytes => json::parse(bytes),
    };
    let read = match &args {
        Parsed::Json(value) => known_effects(receiver, method, value, &action.deposit, input),
        Parsed::NotJson | Parsed::DuplicateKey => Err(Refusal::Unreadable),
    };
    let mut decoded = match read {
        Ok(decoded) => decoded,
        Err(refusal) => {
            let shown = match args {
                Parsed::Json(value) => value,
                Parsed::NotJson | Parsed::DuplicateKey => {
                    sheet.args_not_json = true;
                    Value::String("not_json".into())
                }
            };
            if matches!(refusal, Refusal::Ambiguous) {
                sheet.args_not_json = true;
            }
            let mut unknown = Decoded::default();
            unknown.unknown(receiver, method, shown, &action.deposit);
            unknown
        }
    };
    if !decoded.takes_deposit && action.deposit > BigUint::from(SECURITY_DEPOSIT) {
        sheet.attached_deposit = true;
        let effect = Effect::Transfer {
            token: NATIVE.into(),
            amount: action.deposit.to_string(),
            to: receiver.into(),
        };
        decoded.push(effect, Some(Move::new(NATIVE, &action.deposit, Some(receiver))));
    }
    sheet.decoded.extend(decoded);
}

/// The known effect of `method` on `receiver`, or why there is none. NEP-145 `storage_deposit`
/// is known on any contract (ruling 3); everything else depends on the exact receiver.
fn known_effects(
    receiver: &str,
    method: &str,
    args: &Value,
    deposit: &BigUint,
    input: &ProposalInput,
) -> Result<Decoded, Refusal> {
    if method == "storage_deposit" {
        return storage_deposit(receiver, args, deposit, &input.dao);
    }
    match known::classify(receiver, method) {
        Known::Wrap => wrap(receiver, method, args, deposit, &input.dao),
        Known::Intents => intents::method(method, args, &input.dao),
        Known::BulkPayment if method == "approve_list" => approve_list(receiver, args, deposit),
        Known::Defi(protocol) => {
            let mut decoded = Decoded::default();
            let effect = Effect::DefiCall {
                protocol: protocol.name().into(),
                method: method.into(),
                summary: format!("{method} on {receiver}"),
            };
            decoded.push(effect, None);
            Ok(decoded)
        }
        Known::StakingPool => staking(receiver, method, args, deposit),
        Known::Other if method == enrolment::METHOD && input.guard_account.as_deref() == Some(receiver) => {
            guard_enrol(receiver, args, deposit)
        }
        Known::Other => token_method(receiver, method, args, &input.dao),
        Known::Signer | Known::BulkPayment => Err(Refusal::Unreadable),
    }
}

pub(super) fn object(args: &Value) -> Result<&Map<String, Value>, Refusal> {
    args.as_object().ok_or(Refusal::Unreadable)
}

pub(super) fn text<'a>(fields: &'a Map<String, Value>, name: &str) -> Result<&'a str, Refusal> {
    fields.get(name).and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or(Refusal::Unreadable)
}

/// A field that may be missing or `null`, but is a string when present.
pub(super) fn optional_text<'a>(fields: &'a Map<String, Value>, name: &str) -> Result<Option<&'a str>, Refusal> {
    match fields.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(_) => Err(Refusal::Unreadable),
    }
}

pub(super) fn account<'a>(fields: &'a Map<String, Value>, name: &str) -> Result<&'a str, Refusal> {
    text(fields, name).and_then(|a| if is_account_id(a) { Ok(a) } else { Err(Refusal::Unreadable) })
}

pub(super) fn amount(fields: &Map<String, Value>, name: &str) -> Result<BigUint, Refusal> {
    text(fields, name).ok().and_then(u128_amount).ok_or(Refusal::Unreadable)
}

/// NEP-145: the attached NEAR pays storage for `account_id`, or for the caller (the DAO) when it
/// is missing. The NEAR is the effect, not an extra transfer, and the contract is not a payee
/// (rulings 3 and 4).
fn storage_deposit(contract: &str, args: &Value, deposit: &BigUint, dao: &str) -> Result<Decoded, Refusal> {
    let fields = object(args)?;
    let for_account = match fields.get("account_id") {
        None | Some(Value::Null) => dao,
        Some(Value::String(account)) if is_account_id(account) => account,
        Some(_) => return Err(Refusal::Unreadable),
    };
    let mut decoded = Decoded::default();
    let effect = Effect::StorageDeposit {
        contract: contract.into(),
        for_account: for_account.into(),
        amount: deposit.to_string(),
    };
    decoded.push(effect, None);
    decoded.takes_deposit = true;
    Ok(decoded)
}

/// `wrap.near`: `near_deposit` wraps the attached NEAR, `near_withdraw` unwraps `amount`, and the
/// token methods move wNEAR like any other token.
fn wrap(receiver: &str, method: &str, args: &Value, deposit: &BigUint, dao: &str) -> Result<Decoded, Refusal> {
    let mut decoded = Decoded::default();
    match method {
        "near_deposit" => {
            object(args)?;
            decoded.push(Effect::Wrap { op: WrapOp::Wrap, amount: deposit.to_string() }, None);
            decoded.takes_deposit = true;
        }
        "near_withdraw" => {
            let unwrapped = amount(object(args)?, "amount")?;
            decoded.push(Effect::Wrap { op: WrapOp::Unwrap, amount: unwrapped.to_string() }, None);
        }
        _ => return token_method(receiver, method, args, dao),
    }
    Ok(decoded)
}

/// Kaap's own enrolment call on the enrolled guard account (`enrolment`, C30). The attached NEAR
/// pays the guard's storage for this DAO's entry and the guard refunds what is left, so it is this
/// effect, not a payment. Only the template's exact shape is read: no arguments, and at most the
/// template's deposit. Anything else on the guard is an unknown call (fail closed).
fn guard_enrol(guard: &str, args: &Value, deposit: &BigUint) -> Result<Decoded, Refusal> {
    if !object(args)?.is_empty() || *deposit > BigUint::from(enrolment::DEPOSIT_YOCTO) {
        return Err(Refusal::Unreadable);
    }
    let mut decoded = Decoded::default();
    decoded.push(Effect::GuardEnrol { guard: guard.into(), deposit: deposit.to_string() }, None);
    decoded.takes_deposit = true;
    Ok(decoded)
}

/// Trezu's `approve_list`: the attached NEAR is the list's total, paid out later to recipients
/// the proposal does not show, so no payee is judged here.
fn approve_list(contract: &str, args: &Value, deposit: &BigUint) -> Result<Decoded, Refusal> {
    let list_id = text(object(args)?, "list_id")?;
    let mut decoded = Decoded::default();
    let effect = Effect::BulkPayment {
        contract: contract.into(),
        list_id: list_id.into(),
        total: deposit.to_string(),
    };
    decoded.push(effect, Some(Move::new(NATIVE, deposit, None)));
    decoded.takes_deposit = true;
    Ok(decoded)
}

/// The standard staking-pool methods `known::classify` lets through. A staking deposit's NEAR is
/// the effect itself; `deposit_and_stake` is a deposit and then a stake of the same amount; the
/// `_all` methods take everything, written `all` (ruling 21).
fn staking(pool: &str, method: &str, args: &Value, deposit: &BigUint) -> Result<Decoded, Refusal> {
    let fields = object(args)?;
    let mut decoded = Decoded::default();
    let mut add = |op: StakingOp, amount: String| {
        decoded.push(Effect::Staking { pool: pool.into(), op, amount }, None);
    };
    let all = || "all".to_string();
    match method {
        "deposit" => add(StakingOp::Deposit, deposit.to_string()),
        "deposit_and_stake" => {
            add(StakingOp::Deposit, deposit.to_string());
            add(StakingOp::Stake, deposit.to_string());
        }
        "stake" => add(StakingOp::Stake, amount(fields, "amount")?.to_string()),
        "stake_all" => add(StakingOp::Stake, all()),
        "unstake" => add(StakingOp::Unstake, amount(fields, "amount")?.to_string()),
        "unstake_all" => add(StakingOp::Unstake, all()),
        "withdraw" => add(StakingOp::Withdraw, amount(fields, "amount")?.to_string()),
        "withdraw_all" => add(StakingOp::Withdraw, all()),
        _ => return Err(Refusal::Unreadable),
    }
    decoded.takes_deposit = matches!(method, "deposit" | "deposit_and_stake");
    Ok(decoded)
}

/// NEP-141 methods called on the token contract itself, which is then the token (C3: value keyed
/// by the exact contract id). A token named `near` would read as native NEAR, so it is refused.
fn token_method(token: &str, method: &str, args: &Value, dao: &str) -> Result<Decoded, Refusal> {
    if token == NATIVE {
        return Err(Refusal::Unreadable);
    }
    let fields = object(args)?;
    match method {
        "ft_transfer" => {
            let to = account(fields, "receiver_id")?;
            let sent = amount(fields, "amount")?;
            let mut decoded = Decoded::default();
            let effect = Effect::Transfer { token: token.into(), amount: sent.to_string(), to: to.into() };
            decoded.push(effect, Some(Move::new(token, &sent, Some(to))));
            Ok(decoded)
        }
        "ft_transfer_call" => {
            let to = account(fields, "receiver_id")?;
            let sent = amount(fields, "amount")?;
            let msg = fields.get("msg").and_then(Value::as_str).ok_or(Refusal::Unreadable)?;
            token_call(token, &sent, to, msg, dao)
        }
        _ => Err(Refusal::Unreadable),
    }
}

/// `ft_transfer_call` or `mt_transfer_call` of `amount` of `token` to `to` with `msg`, as a
/// `token_call_transfer` plus what the receiver does with it: an intents deposit message is read
/// by `intents::deposit_message`, and a Trezu list id sent to `bulkpayment.near` funds that list
/// (a `bulk_payment` for the same tokens, counted once). Otherwise `to` is the payee.
pub(super) fn token_call(token: &str, amount: &BigUint, to: &str, msg: &str, dao: &str) -> Result<Decoded, Refusal> {
    let mut decoded = Decoded::default();
    let effect = |msg_kind| Effect::TokenCallTransfer {
        token: token.into(),
        amount: amount.to_string(),
        to: to.into(),
        msg_kind,
    };
    if to == INTENTS {
        let (msg_kind, payee, inner) = intents::deposit_message(msg, dao)?;
        decoded.push(effect(msg_kind), Some(Move::new(token, amount, payee.as_deref())));
        decoded.extend(inner);
    } else if to == BULK_PAYMENT && is_list_id(msg) {
        decoded.push(effect(msg_kind(msg)?), Some(Move::new(token, amount, None)));
        let funded = Effect::BulkPayment { contract: to.into(), list_id: msg.into(), total: amount.to_string() };
        decoded.push(funded, None);
    } else {
        decoded.push(effect(msg_kind(msg)?), Some(Move::new(token, amount, Some(to))));
    }
    Ok(decoded)
}

/// The `msg_kind` of a message for a receiver with no message grammar of its own here.
pub(super) fn msg_kind(msg: &str) -> Result<MsgKind, Refusal> {
    if msg.is_empty() {
        return Ok(MsgKind::Empty);
    }
    match json::parse(msg.as_bytes()) {
        Parsed::Json(_) => Ok(MsgKind::OtherJson),
        Parsed::NotJson => Ok(MsgKind::NotJson),
        Parsed::DuplicateKey => Err(Refusal::Ambiguous),
    }
}

/// Trezu list ids are sha256 digests in lowercase hex.
fn is_list_id(msg: &str) -> bool {
    msg.len() == 64 && msg.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
