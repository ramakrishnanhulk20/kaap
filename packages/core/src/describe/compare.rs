//! Compares the claims of any kind with the effects: amounts, tokens, recipients, accounts,
//! hashes, a Sputnik release, leading verbs, method names, governance words, and the ruling 28
//! rules. Policy member, roster and threshold claims are `policy`'s.
//!
//! Every amount on both sides goes through `decode::value::base_units`, every account through
//! `decode::account::is_account_id` (by way of `claims::account_shaped`) and is compared as an
//! exact string, every hash as its bytes through `bs58` or hex (standard 2).

use std::collections::BTreeSet;

use num_bigint::BigUint;
use serde_json::Value;

use super::claims::{account_shaped, hex_of, Claims, Phrase, Verb};
use super::lists::{GENERIC_METHOD_PARTS, NEAR_FAMILY, TOKENS};
use super::text::{has_phrase, words};
use super::{releases, Outcome};
use crate::decode::json::{self, Parsed};
use crate::decode::known::is_lookalike;
use crate::decode::value::base_units;
use crate::severity::{changes_control, moves_value};
use crate::types::{Effect, FindingCode, KeyOp, ProposalInput, StakingOp, WrapOp};

/// Payment apps build amounts in floating point, so an honest "0.10 NEAR" reaches the chain as
/// 100000000000000008388608 yoctoNEAR (`mic` #10). A 64-bit float is off by about one part in
/// 10^16; anything a person would notice is far outside one part in 10^12.
const AGREEMENT_PARTS: u64 = 1_000_000_000_000;

/// Arguments nest; deeper than this is not walked (standard 4).
const MAX_ARGS_DEPTH: usize = 32;

/// Verbs, governance words and ruling 28 read whether a policy change moves control, which needs
/// the policy before; a change measured without it is left out of those three (guide section 7:
/// fire no finding that needs the policy before).
pub(super) fn compare(claims: &Claims, folded: &str, input: &ProposalInput, effects: &[Effect], codes: &[FindingCode], out: &mut Outcome) {
    let touched = touched(effects);
    amounts(claims, input, effects, out);
    tokens(claims, effects, out);
    recipients(claims, input, effects, &touched, out);
    if claims.accounts.iter().any(|a| *a != input.dao && touched.contains(a)) {
        out.agree("an account the proposal touches is named");
    }
    hashes(claims, effects, out);
    release(claims, effects, out);
    methods(folded, effects, out);
    let measured: Vec<Effect> =
        effects.iter().filter(|e| !matches!(e, Effect::PolicyChange { before_unknown: true, .. })).cloned().collect();
    verbs(claims, &measured, out);
    governance_words(claims, &measured, out);
    ruling_26(claims, input, &measured, codes, out);
}

fn same_family(a: &str, b: &str) -> bool {
    a == b || (NEAR_FAMILY.contains(&a) && NEAR_FAMILY.contains(&b))
}

/// A token whose identity is certain enough to say a different ticker is wrong: native or
/// wrapped NEAR, a token in `lists::TOKENS`, or an imitation of one.
fn known_token(token: &str) -> bool {
    NEAR_FAMILY.contains(&token) || TOKENS.iter().any(|(_, contract, _)| *contract == token) || is_lookalike(token)
}

fn close(stated: &BigUint, sent: &BigUint) -> bool {
    let diff = if stated > sent { stated - sent } else { sent - stated };
    diff * AGREEMENT_PARTS <= *stated
}

/// Every amount an effect sends or commits, by exact token, in base units. Wrapping, staking and
/// storage deposits are in NEAR. `all` and unreadable amounts are left out.
fn amounts_in(effects: &[Effect], with_storage: bool) -> Vec<(&str, BigUint)> {
    let mut out = Vec::new();
    for e in effects {
        let (token, amount) = match e {
            Effect::Transfer { token, amount, .. }
            | Effect::TokenCallTransfer { token, amount, .. }
            | Effect::IntentsWithdraw { token, amount, .. }
            | Effect::IntentsTransfer { token, amount, .. } => (token.as_str(), amount),
            Effect::Wrap { amount, .. } | Effect::Staking { amount, .. } => ("near", amount),
            Effect::StorageDeposit { amount, .. } if with_storage => ("near", amount),
            _ => continue,
        };
        if let Some(a) = base_units(amount, 0) {
            out.push((token, a));
        }
    }
    out
}

fn decimals_of(token: &str, input: &ProposalInput) -> Option<u32> {
    TOKENS
        .iter()
        .find(|(_, contract, _)| *contract == token)
        .map(|&(_, _, d)| d)
        .or_else(|| input.prices.usd_by_token.get(token).map(|&(d, _)| u32::from(d)))
}

/// An amount claim agrees with one amount in its token family, or with their total (a batch
/// quoted as one sum). A number without a ticker agrees only when it is exactly one amount at
/// that token's decimals. A contradiction needs exactly one amount, other than a storage deposit,
/// so a batch quoting partial or running totals is never shown wrong by its numbers alone. A
/// stated token that differs counts only when the token sent is known (`known_token`). A text
/// that describes a swap names amounts on both sides of it (in, out, minimum out), so its amounts
/// can agree but never contradict.
fn amounts(claims: &Claims, input: &ProposalInput, effects: &[Effect], out: &mut Outcome) {
    let moved = amounts_in(effects, true);
    let stated: Vec<(&str, BigUint)> =
        claims.amounts.iter().filter_map(|c| Some((c.token.as_str(), base_units(&c.amount, 0)?))).collect();
    let agrees = |token: &str, value: &BigUint, same: fn(&str, &str) -> bool| {
        let total: BigUint = moved.iter().filter(|(t, _)| same(token, t)).map(|(_, a)| a).sum();
        moved.iter().any(|(t, a)| same(token, t) && close(value, a)) || (total > BigUint::ZERO && close(value, &total))
    };
    if stated.iter().any(|(t, v)| agrees(t, v, |a, b| a == b)) {
        out.agree("a stated amount is sent");
    }
    if stated.iter().any(|(t, v)| agrees(t, v, same_family)) {
        return;
    }
    let exact = claims.bare_numbers.iter().any(|n| {
        moved.iter().any(|(t, a)| decimals_of(t, input).and_then(|d| base_units(n, d)).is_some_and(|v| v == *a && v > BigUint::ZERO))
    });
    if exact {
        out.agree("a number in the text is exactly an amount sent");
    }
    let single = amounts_in(effects, false);
    if stated.is_empty() || single.len() != 1 || claims.phrases.contains(&Phrase::Swap) {
        return;
    }
    let token = single[0].0;
    if stated.iter().any(|(t, _)| same_family(t, token)) || known_token(token) {
        out.contradict("the stated amount or token is not what is sent");
    }
}

fn sent_tokens(effects: &[Effect]) -> Vec<&str> {
    effects
        .iter()
        .filter_map(|e| match e {
            Effect::Transfer { token, .. }
            | Effect::TokenCallTransfer { token, .. }
            | Effect::IntentsWithdraw { token, .. }
            | Effect::IntentsTransfer { token, .. } => Some(token.as_str()),
            _ => None,
        })
        .collect()
}

/// A ticker agrees when a value effect sends its token. A ticker alone is common in prose ("a
/// grant for USDC tooling"), so it contradicts only when what is sent imitates a known token.
fn tokens(claims: &Claims, effects: &[Effect], out: &mut Outcome) {
    let named: Vec<&str> = claims.tokens.iter().map(String::as_str).chain(claims.amounts.iter().map(|a| a.token.as_str())).collect();
    let sent = sent_tokens(effects);
    if named.is_empty() || sent.is_empty() {
        return;
    }
    if named.iter().any(|n| sent.contains(n)) {
        out.agree("a stated token is sent");
    } else if !named.iter().any(|n| sent.iter().any(|s| same_family(n, s))) && sent.iter().any(|s| is_lookalike(s)) {
        out.contradict("the token sent imitates the one the text names");
    }
}

fn payee(e: &Effect) -> Option<&str> {
    match e {
        Effect::Transfer { to, .. } | Effect::TokenCallTransfer { to, .. } | Effect::IntentsTransfer { to, .. } => Some(to),
        Effect::IntentsWithdraw { address, .. } => Some(address),
        Effect::BulkPayment { contract, .. } => Some(contract),
        _ => None,
    }
}

/// A recipient written after "to" agrees when the proposal touches that account, and
/// contradicts when value moves and none of the recipients is touched, unless the text says the
/// payee sits behind a 1Click deposit address.
fn recipients(claims: &Claims, input: &ProposalInput, effects: &[Effect], touched: &BTreeSet<String>, out: &mut Outcome) {
    if claims.recipients.is_empty() || !effects.iter().any(moves_value) {
        return;
    }
    if claims.recipients.iter().any(|r| touched.contains(r) || *r == input.dao) {
        out.agree("a named recipient is paid");
    } else if !claims.phrases.contains(&Phrase::DepositAddress) {
        out.contradict("the named recipient is not paid");
    }
}

/// Every account an effect names, the account a typed effect implies (`intents.near` for an
/// intents effect, `wrap.near` for wrapping), and every account-shaped string inside the
/// arguments of an unknown call, `nep141:` dropped.
fn touched(effects: &[Effect]) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut add = |s: &str| {
        let s = s.strip_prefix("nep141:").unwrap_or(s);
        if account_shaped(s) {
            out.insert(s.to_string());
        }
    };
    for e in effects {
        match e {
            Effect::Transfer { token, to, .. } | Effect::TokenCallTransfer { token, to, .. } => {
                add(token);
                add(to);
            }
            Effect::IntentsWithdraw { token, address, .. } => {
                add(token);
                add(address);
                add("intents.near");
            }
            Effect::IntentsTransfer { token, to, .. } => {
                add(token);
                add(to);
                add("intents.near");
            }
            Effect::IntentsSwap { gives, receives } => {
                gives.iter().chain(receives).for_each(|t| add(&t.token));
                add("intents.near");
            }
            Effect::IntentsKeyChange { .. } => add("intents.near"),
            Effect::Wrap { .. } => add("wrap.near"),
            Effect::Staking { pool, .. } => add(pool),
            Effect::StorageDeposit { contract, for_account, .. } => {
                add(contract);
                add(for_account);
            }
            Effect::BulkPayment { contract, .. } => add(contract),
            Effect::SignRequest { mpc, path, .. } => {
                add(mpc);
                add(path);
            }
            Effect::PolicyChange { members_added, members_removed, .. } => {
                members_added.iter().chain(members_removed).for_each(|m| add(&m.member));
            }
            Effect::CodeUpgrade { target, .. } => add(target),
            Effect::GuardEnrol { guard, .. } => add(guard),
            Effect::UnknownCall { receiver, args, .. } => {
                add(receiver);
                strings_in(args, 0, &mut |s| add(s));
            }
            Effect::DefiCall { .. } | Effect::ConfigChange { .. } | Effect::OtherKind { .. } => {}
        }
    }
    out
}

/// Every string in `v`, and in any JSON a string holds (a `msg` inside `args`), read with the
/// decoder's own strict parser.
fn strings_in(v: &Value, depth: usize, f: &mut impl FnMut(&str)) {
    if depth > MAX_ARGS_DEPTH {
        return;
    }
    match v {
        Value::String(s) => {
            f(s);
            if s.starts_with(['{', '[']) {
                if let Parsed::Json(inner) = json::parse(s.as_bytes()) {
                    strings_in(&inner, depth + 1, f);
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|i| strings_in(i, depth + 1, f)),
        Value::Object(map) => map.values().for_each(|i| strings_in(i, depth + 1, f)),
        _ => {}
    }
}

/// Every 32-byte value an effect holds, as lower-case hex: code hashes, payload hashes, bulk
/// list ids, public keys, and 64-hex strings inside unknown-call arguments.
fn effect_hashes(effects: &[Effect]) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut add_hex = |s: &str| {
        if s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit()) {
            out.insert(s.to_ascii_lowercase());
        }
    };
    for e in effects {
        match e {
            Effect::SignRequest { payload_hash, .. } => add_hex(payload_hash),
            Effect::BulkPayment { list_id, .. } => add_hex(list_id),
            Effect::UnknownCall { args, .. } => strings_in(args, 0, &mut |s| add_hex(s)),
            _ => {}
        }
    }
    for e in effects {
        let b58 = match e {
            Effect::CodeUpgrade { code_hash, .. } => code_hash.as_str(),
            Effect::IntentsKeyChange { public_key, .. } => public_key.strip_prefix("ed25519:").unwrap_or(""),
            _ => continue,
        };
        if let Some(bytes) = releases::hash_bytes(b58) {
            out.insert(hex_of(&bytes));
        }
    }
    out
}

/// A hash agrees when an effect holds it. It contradicts only on a proposal that is nothing but
/// code upgrades, where every hash the text names differs from the code it installs (ruling 13).
fn hashes(claims: &Claims, effects: &[Effect], out: &mut Outcome) {
    if claims.hashes.is_empty() {
        return;
    }
    let held = effect_hashes(effects);
    if claims.hashes.iter().any(|h| held.contains(h)) {
        out.agree("a stated hash is in the proposal");
    } else if !effects.is_empty() && effects.iter().all(|e| matches!(e, Effect::CodeUpgrade { .. })) {
        out.contradict("the stated code hash is not the code installed");
    }
}

/// A Sputnik release label on an upgrade of the DAO itself is checked against the hash the
/// factory publishes for it (ruling 29). Labels the factory does not publish are not claims.
fn release(claims: &Claims, effects: &[Effect], out: &mut Outcome) {
    let Some(published) = claims.release.as_deref().and_then(releases::code_hash) else { return };
    for e in effects {
        if let Effect::CodeUpgrade { target, code_hash } = e {
            if target == "self" {
                if releases::hash_bytes(code_hash).as_deref() == Some(published.as_slice()) {
                    out.agree("the release named is the code installed");
                } else {
                    out.contradict("the code installed is not the release named");
                }
            }
        }
    }
}

/// True when `e` is an effect `verb` can describe. An unknown call or a DeFi call can carry
/// almost any action, so it satisfies every verb that could plausibly be its method.
fn satisfies(verb: Verb, e: &Effect) -> bool {
    let open = matches!(e, Effect::UnknownCall { .. } | Effect::DefiCall { .. });
    match verb {
        Verb::Pay => open || moves_value(e) || matches!(e, Effect::SignRequest { .. }),
        Verb::Add | Verb::Grant => {
            open || moves_value(e)
                || matches!(e, Effect::StorageDeposit { .. } | Effect::Staking { .. } | Effect::Wrap { .. })
                || matches!(e, Effect::IntentsKeyChange { op: KeyOp::Add, .. })
                || matches!(e, Effect::PolicyChange { members_added, roles_added, permissions_changed, .. }
                    if !members_added.is_empty() || !roles_added.is_empty() || permissions_changed.iter().any(|p| !p.added.is_empty()))
        }
        Verb::Remove => {
            open || matches!(e, Effect::IntentsKeyChange { op: KeyOp::Remove, .. })
                || matches!(e, Effect::PolicyChange { members_removed, roles_removed, permissions_changed, .. }
                    if !members_removed.is_empty() || !roles_removed.is_empty() || permissions_changed.iter().any(|p| !p.removed.is_empty()))
        }
        Verb::Upgrade => open || matches!(e, Effect::CodeUpgrade { .. }),
        Verb::Swap => open || moves_value(e) || matches!(e, Effect::Wrap { .. } | Effect::SignRequest { .. }),
        Verb::Stake => {
            open || matches!(e, Effect::Staking { op: StakingOp::Stake | StakingOp::Deposit, .. } | Effect::TokenCallTransfer { .. })
        }
        Verb::Unstake => open || matches!(e, Effect::Staking { op: StakingOp::Unstake, .. }),
        Verb::Withdraw => {
            open || moves_value(e)
                || matches!(e, Effect::Staking { op: StakingOp::Withdraw, .. } | Effect::Wrap { op: WrapOp::Unwrap, .. })
        }
        Verb::Wrap => open || matches!(e, Effect::Wrap { .. }),
        Verb::Deposit => {
            open || moves_value(e) || matches!(e, Effect::StorageDeposit { .. } | Effect::Staking { .. } | Effect::Wrap { .. })
        }
    }
}

fn changes_value_or_control(e: &Effect) -> bool {
    moves_value(e) || changes_control(e) || matches!(e, Effect::ConfigChange { .. })
}

/// A leading verb agrees when an effect it can describe is there, and contradicts when none is
/// while a different value or control effect is. "Pay" and "swap" fit any movement of value, so
/// like "transfer" in guide section 5 they never agree on their own; "grant" and "promote" are
/// read only by `control`.
fn verbs(claims: &Claims, effects: &[Effect], out: &mut Outcome) {
    for &verb in claims.verbs.iter().filter(|v| **v != Verb::Grant) {
        if effects.iter().any(|e| satisfies(verb, e)) {
            if !matches!(verb, Verb::Pay | Verb::Swap) {
                out.agree("the leading verb is what the proposal does");
            }
        } else if effects.iter().any(changes_value_or_control) {
            out.contradict("the leading verb is not what the proposal does");
        }
    }
}

/// A called method's full name in the text, or a distinctive part of it as a word ("farm" for
/// `add_asset_farm_reward`), agrees (ruling 19).
fn methods(folded: &str, effects: &[Effect], out: &mut Outcome) {
    let said: BTreeSet<&str> = words(folded).collect();
    let named = effects.iter().any(|e| {
        let (Effect::UnknownCall { method, .. } | Effect::DefiCall { method, .. }) = e else { return false };
        has_phrase(folded, method)
            || method.split('_').any(|part| {
                part.len() >= 4
                    && !GENERIC_METHOD_PARTS.contains(&part)
                    && (said.contains(part) || said.contains(format!("{part}s").as_str()))
            })
    });
    if named {
        out.agree("a method the proposal calls is named");
    }
}

fn governance_words(claims: &Claims, effects: &[Effect], out: &mut Outcome) {
    let has = |p: Phrase| claims.phrases.contains(&p);
    for e in effects {
        let shown = match e {
            Effect::ConfigChange { .. } => has(Phrase::Config),
            Effect::PolicyChange { bond_or_period_changed, vote_policy_changed, .. } => {
                (has(Phrase::Bond) && *bond_or_period_changed) || (has(Phrase::Threshold) && !vote_policy_changed.is_empty())
            }
            Effect::OtherKind { kind, .. } => {
                (has(Phrase::Factory) && kind == "FactoryInfoUpdate") || (has(Phrase::Vote) && kind == "Vote")
            }
            _ => false,
        };
        if shown {
            out.agree("the governance change named is made");
        }
    }
}

/// Ruling 28, each rule tied to one phrase list in `lists`.
fn ruling_26(claims: &Claims, input: &ProposalInput, effects: &[Effect], codes: &[FindingCode], out: &mut Outcome) {
    let has = |p: Phrase| claims.phrases.contains(&p);
    let value_moves = effects.iter().any(moves_value);

    let says_payment = has(Phrase::Payment) || claims.verbs.contains(&Verb::Pay) || !claims.amounts.is_empty();
    let pays = value_moves || effects.iter().any(|e| matches!(e, Effect::UnknownCall { .. }));
    let control = effects.iter().any(|e| changes_control(e) || matches!(e, Effect::ConfigChange { .. }));
    if says_payment && !pays && control {
        out.contradict("a payment is described and none is made");
    }

    if has(Phrase::NoValue) {
        if value_moves {
            out.contradict("the text says no value moves and value moves");
        } else {
            out.agree("the text says no value moves and none does");
        }
    }

    if (claims.verbs.contains(&Verb::Deposit) || has(Phrase::Rebalance)) && sends_out(input, effects, &claims.accounts) {
        out.contradict("a deposit is described and value leaves the DAO");
    }

    if has(Phrase::Storage) && value_moves {
        out.contradict("storage registration is described and value moves");
    }

    if has(Phrase::Rotation) && !claims.policy.names_a_change() && uneven_rotation(effects) {
        out.contradict("a rotation is described and the change is not one for one");
    }

    if hidden_second_payment(claims, effects) {
        out.contradict("a second payment is not mentioned");
    }

    if has(Phrase::Cleanup) && codes.contains(&FindingCode::GuardWeakened) {
        out.contradict("the guard is called inactive or unused");
    }
}

/// Value leaving the DAO to a destination the text does not name: a withdrawal out of intents to
/// anywhere but the DAO on NEAR, or a plain transfer to another account that is not the deposit
/// attached to a call. A payee the text names (a 1Click deposit address listed in the text, a
/// gas top-up "to g-nuff.near") is described, not hidden.
fn sends_out(input: &ProposalInput, effects: &[Effect], named: &[String]) -> bool {
    let called: Vec<&str> = effects
        .iter()
        .filter_map(|e| if let Effect::UnknownCall { receiver, .. } = e { Some(receiver.as_str()) } else { None })
        .collect();
    let unnamed = |to: &str| to != input.dao && !named.iter().any(|n| n == to);
    effects.iter().any(|e| match e {
        Effect::IntentsWithdraw { chain, address, .. } => (chain != "near" || *address != input.dao) && unnamed(address),
        Effect::Transfer { to, .. } => unnamed(to) && !called.contains(&to.as_str()),
        _ => false,
    })
}

/// Keys added with none removed, or approvers changed other than one in and one out.
fn uneven_rotation(effects: &[Effect]) -> bool {
    let (mut keys_in, mut keys_out, mut in_, mut out) = (0, 0, 0, 0);
    for e in effects {
        match e {
            Effect::IntentsKeyChange { op: KeyOp::Add, .. } => keys_in += 1,
            Effect::IntentsKeyChange { op: KeyOp::Remove, .. } => keys_out += 1,
            Effect::PolicyChange { members_added, members_removed, .. } => {
                in_ += members_added.iter().filter(|m| m.approver).count();
                out += members_removed.iter().filter(|m| m.approver).count();
            }
            _ => {}
        }
    }
    (keys_in > 0 && keys_out == 0) || (in_ > 0 && !(in_ == 1 && out == 1))
}

/// One stated amount that one value effect sends, beside another value effect to a payee or in
/// a token the text never names. Storage deposits are not value effects here.
fn hidden_second_payment(claims: &Claims, effects: &[Effect]) -> bool {
    let [stated] = claims.amounts.as_slice() else { return false };
    let Some(value) = base_units(&stated.amount, 0) else { return false };
    let paid: Vec<(&str, &str, BigUint)> = effects
        .iter()
        .filter(|e| moves_value(e))
        .filter_map(|e| {
            let token = sent_tokens(std::slice::from_ref(e)).first().copied()?;
            let amount = amounts_in(std::slice::from_ref(e), false).first()?.1.clone();
            Some((token, payee(e)?, amount))
        })
        .collect();
    if paid.len() < 2 {
        return false;
    }
    let Some(first) = paid.iter().position(|(t, _, a)| same_family(t, &stated.token) && close(&value, a)) else { return false };
    let (token, to, _) = paid[first];
    let named_token = |t: &str| claims.tokens.iter().any(|n| same_family(n, t)) || same_family(&stated.token, t);
    paid.iter().enumerate().any(|(i, (t, p, _))| {
        i != first && ((*p != to && !claims.accounts.iter().any(|a| a == p)) || (!same_family(t, token) && !named_token(t)))
    })
}
