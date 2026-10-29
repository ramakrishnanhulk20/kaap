//! The description check of guide section 5 and the findings DESC_CONTRADICTS,
//! PROMPT_INJECTION and EMPTY_DESCRIPTION.
//!
//! What it checks today:
//! - A description under 20 characters, after trimming, is `empty` and fires EMPTY_DESCRIPTION,
//!   whatever the kind. A short text can still be contradicted (ruling 18).
//! - When every effect is a `transfer`, two kinds of claim. An amount of NEAR: a plain decimal
//!   number followed by the word NEAR, in any case. A recipient: a NEAR account id written
//!   straight after the word "to". The description contradicts the effects when it states NEAR
//!   amounts and none of them is an amount of NEAR sent, or names recipients and none of them is
//!   paid. One agreeing amount is enough because descriptions often quote other amounts of the
//!   same token for context, such as a batch total.
//!
//! What it does not check yet (WO-03c): amounts in any other token, token names, methods,
//! hashes, accounts named in any other way, policy and other non-payment effects, `hidden`, and
//! PROMPT_INJECTION. A claim it cannot read with certainty is not a claim, so an unread
//! description is `vague`, never `contradicts`: a false contradiction floors a payment at
//! critical, and the guard vetoes an honest proposal.

use num_bigint::BigUint;

use crate::decode::value::base_units;
use crate::types::{DescCheck, Effect, FindingCode, ProposalInput};

const NATIVE: &str = "near";
const NEAR_DECIMALS: u32 = 24;

/// Guide section 5: "empty or under 20 characters".
const MIN_DESCRIPTION_CHARS: usize = 20;

/// Payment apps build amounts in floating point, so an honest "0.10 NEAR" reaches the chain as
/// 100000000000000008388608 yoctoNEAR (`mic` #10). A 64-bit float is off by about one part in
/// 10^16; anything a person would notice is far outside one part in 10^12.
const AGREEMENT_PARTS: u64 = 1_000_000_000_000;

/// Compares the description with every effect the other modules found.
pub fn check(input: &ProposalInput, effects: &[Effect]) -> (DescCheck, Vec<FindingCode>) {
    let text = input.description.as_str();
    let empty = text.trim().chars().count() < MIN_DESCRIPTION_CHARS;
    let payments_only = !effects.is_empty() && effects.iter().all(|e| matches!(e, Effect::Transfer { .. }));
    let claims = if payments_only { payment_claims(text, effects) } else { Claims::None };

    let mut codes = Vec::new();
    if empty {
        codes.push(FindingCode::EmptyDescription);
    }
    if claims == Claims::Contradict {
        codes.push(FindingCode::DescContradicts);
    }
    let desc = match claims {
        _ if empty => DescCheck::Empty,
        Claims::Contradict => DescCheck::Contradicts,
        Claims::Agree => DescCheck::Matches,
        Claims::None => DescCheck::Vague,
    };
    (desc, codes)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Claims {
    None,
    Agree,
    Contradict,
}

fn payment_claims(text: &str, effects: &[Effect]) -> Claims {
    let mut near_sent = Vec::new();
    let mut payees = Vec::new();
    for effect in effects {
        if let Effect::Transfer { token, amount, to } = effect {
            payees.push(to.as_str());
            if token == NATIVE {
                match base_units(amount, 0) {
                    Some(sent) => near_sent.push(sent),
                    // An effect amount this parser cannot read is not something to agree with.
                    None => return Claims::None,
                }
            }
        }
    }

    let stated = near_amounts(text);
    let named = recipients(text);
    let amounts_checked = !stated.is_empty() && !near_sent.is_empty();
    let recipients_checked = !named.is_empty();
    if !amounts_checked && !recipients_checked {
        return Claims::None;
    }
    let amounts_agree = !amounts_checked || stated.iter().any(|s| near_sent.iter().any(|sent| agrees(s, sent)));
    let recipients_agree = !recipients_checked || named.iter().any(|n| payees.contains(n));
    if amounts_agree && recipients_agree {
        Claims::Agree
    } else {
        Claims::Contradict
    }
}

/// True when `sent` is within one part in `AGREEMENT_PARTS` of `stated`. Integer arithmetic only.
fn agrees(stated: &BigUint, sent: &BigUint) -> bool {
    let diff = if stated > sent { stated - sent } else { sent - stated };
    diff * AGREEMENT_PARTS <= *stated
}

/// Every NEAR amount stated in `text`, in yoctoNEAR. A number counts only when it stands alone:
/// not glued to a letter, digit, `.`, `,`, `_` or `-` before it (so no `v1.5`, no `-5`, no part
/// of `1,000` or `1 000`), and followed, after optional spaces, by the whole word NEAR (so not
/// `wNEAR`, `LiNEAR`, `83K NEAR` or `near.social`).
fn near_amounts(text: &str) -> Vec<BigUint> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if !b[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        while i < b.len() && (b[i].is_ascii_digit() || b[i] == b'.') {
            i += 1;
        }
        if !number_stands_alone(b, start) {
            continue;
        }
        let mut unit = i;
        while unit < b.len() && (b[unit] == b' ' || b[unit] == b'\t') {
            unit += 1;
        }
        let is_near = b.get(unit..unit + 4).is_some_and(|w| w.eq_ignore_ascii_case(b"near"))
            && word_ends(b, unit + 4);
        if let Some(amount) = is_near.then(|| base_units(&text[start..i], NEAR_DECIMALS)).flatten() {
            out.push(amount);
        }
    }
    out
}

fn number_stands_alone(b: &[u8], start: usize) -> bool {
    let Some(&before) = start.checked_sub(1).and_then(|p| b.get(p)) else {
        return true;
    };
    if before.is_ascii_alphanumeric() || !before.is_ascii() || b".,_-".contains(&before) {
        return false;
    }
    let mut p = start;
    while p > 0 && b[p - 1] == b' ' {
        p -= 1;
    }
    !(p < start && p > 0 && (b[p - 1].is_ascii_digit() || b[p - 1] == b','))
}

/// True when the word that ended at `end` is not glued to more word: the text ends, or the next
/// byte is ASCII and not a letter, digit or `_`, and not a `.` that continues an account id.
fn word_ends(b: &[u8], end: usize) -> bool {
    match b.get(end) {
        None => true,
        Some(&c) if !c.is_ascii() || c.is_ascii_alphanumeric() || c == b'_' => false,
        Some(b'.') => !b.get(end + 1).is_some_and(u8::is_ascii_alphanumeric),
        Some(_) => true,
    }
}

/// Every account id written straight after the word "to" (any case, one or more spaces), with a
/// final full stop dropped. Only an id that `is_account_shaped` accepts and that is not glued to
/// more text counts, so "to the advisor", "to deploy" and "to 2.5" are not recipients.
fn recipients(text: &str) -> Vec<&str> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    for i in 0..b.len().saturating_sub(2) {
        let starts_word = i == 0 || (b[i - 1].is_ascii() && !b[i - 1].is_ascii_alphanumeric() && b[i - 1] != b'_');
        if !starts_word || !b[i..i + 2].eq_ignore_ascii_case(b"to") || !matches!(b[i + 2], b' ' | b'\t') {
            continue;
        }
        let mut start = i + 2;
        while start < b.len() && matches!(b[start], b' ' | b'\t') {
            start += 1;
        }
        let mut end = start;
        while end < b.len() && matches!(b[end], b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-') {
            end += 1;
        }
        if b.get(end).is_some_and(|c| !c.is_ascii() || c.is_ascii_alphanumeric()) {
            continue;
        }
        let id = text[start..end].trim_end_matches('.');
        if is_account_shaped(id) {
            out.push(id);
        }
    }
    out
}

/// A valid NEAR account id (2 to 64 characters of `a-z`, `0-9` and the separators `.`, `-`, `_`,
/// never two separators in a row or one at either end, as nearcore's `AccountId` requires) that
/// is either implicit (64 hex characters, or `0x` and 40) or named under a top-level account of
/// two or more characters starting with a letter. The last part rules out numbers such as `2.5`
/// and abbreviations such as `e.g`.
fn is_account_shaped(id: &str) -> bool {
    let b = id.as_bytes();
    let separator = |c: u8| matches!(c, b'.' | b'-' | b'_');
    let valid = (2..=64).contains(&b.len())
        && b.iter().all(|&c| c.is_ascii_lowercase() || c.is_ascii_digit() || separator(c))
        && !separator(b[0])
        && !separator(b[b.len() - 1])
        && !b.windows(2).any(|w| separator(w[0]) && separator(w[1]));
    if !valid {
        return false;
    }
    let hex = |s: &str| s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c));
    let implicit = (b.len() == 64 && hex(id)) || (b.len() == 42 && id.starts_with("0x") && hex(&id[2..]));
    let named = id.rsplit_once('.').is_some_and(|(_, top)| {
        top.len() >= 2 && top.as_bytes()[0].is_ascii_lowercase()
    });
    implicit || named
}
