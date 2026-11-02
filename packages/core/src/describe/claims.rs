//! What a description claims, read by plain code into fixed fields. The sealed job hands these
//! fields to the model next to the quoted text, so the model is told what the code read rather
//! than asked to find it (C10). Every field holds only what the code read with certainty; a claim
//! it cannot read is left out, never guessed.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use super::lists::*;
use super::text::{fold, has_any, leading_words, readable};
use crate::decode::account::is_account_id;
use crate::decode::value::base_units;

/// The furthest a "Payload Hashes" field or a threshold line is read from its label. A bulk list
/// of 100 hashes is about 6.5 KiB; the bound keeps a text of repeated labels from costing the
/// square of its length (standard 4).
const MAX_FIELD_BYTES: usize = 8 * 1024;

/// A number followed by a ticker from `lists::TOKENS`, in the base units of that ticker's token.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AmountClaim {
    /// The exact token contract the ticker names (`near` for native NEAR).
    pub token: String,
    /// Whole base units as a decimal string, read through `decode::value::base_units`.
    pub amount: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Verb {
    Pay,
    Add,
    Grant,
    Remove,
    Upgrade,
    Swap,
    Stake,
    Unstake,
    Withdraw,
    Wrap,
    Deposit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phrase {
    Payment,
    NoValue,
    Rebalance,
    Storage,
    Rotation,
    Cleanup,
    Config,
    Bond,
    Threshold,
    Factory,
    Vote,
    Swap,
    DepositAddress,
}

/// "add X to [roles]" and the like. `exact` is true when the roles were written as quoted names
/// (the treasury app's form), so they are compared one by one; otherwise any role counts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MemberClaim {
    pub member: String,
    pub roles: Vec<String>,
    pub exact: bool,
}

/// An end-state roster ("council: a, b, c, d (x out)"), checked against the policy after the
/// change (ruling 24).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Roster {
    pub role: String,
    pub members: Vec<String>,
    pub out: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct PolicyClaims {
    pub adds: Vec<MemberClaim>,
    pub removes: Vec<MemberClaim>,
    pub rosters: Vec<Roster>,
    /// The threshold the text names, as written after "to" ("2", "49%"), or empty when it names
    /// a threshold change without a number.
    pub threshold: Option<String>,
    /// Words written as "remove <word> role"; only those that are role names count.
    pub role_words: Vec<String>,
}

impl PolicyClaims {
    /// True when the text names a specific member, role or threshold change (Ram, 26 Oct 2026).
    pub fn names_a_change(&self) -> bool {
        !self.adds.is_empty() || !self.removes.is_empty() || !self.rosters.is_empty() || self.threshold.is_some()
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Claims {
    /// False when nothing can be read with certainty: the text holds a bidirectional control or
    /// is longer than `text::MAX_CLAIM_TEXT_BYTES`. Every other field is then empty.
    pub readable: bool,
    pub amounts: Vec<AmountClaim>,
    /// Numbers with no ticker after them, kept only to recognise an exact amount (`matches`);
    /// they never make a contradiction.
    pub bare_numbers: Vec<String>,
    /// Token contracts named by a ticker alone ("USDC payout of 2500").
    pub tokens: Vec<String>,
    /// Every NEAR account id the text names.
    pub accounts: Vec<String>,
    /// Account ids written after "to", with at most three plain words between.
    pub recipients: Vec<String>,
    /// 32-byte hashes (64 hex characters, or base58 of 43 or 44 characters) as lower-case hex,
    /// leaving out a bulk payment's "Payload Hashes" list (ruling 12).
    pub hashes: Vec<String>,
    /// A Sputnik release label ("3.2") in a text that names Sputnik.
    pub release: Option<String>,
    pub verbs: Vec<Verb>,
    pub phrases: Vec<Phrase>,
    pub policy: PolicyClaims,
    pub hidden: bool,
    pub policy_template: bool,
}

/// Reads every claim in `description`.
pub fn extract(description: &str) -> Claims {
    let Some(view) = readable(description) else { return Claims::default() };
    let folded = fold(&view);
    let (amounts, bare_numbers) = numbers(&view);
    Claims {
        readable: true,
        amounts,
        bare_numbers,
        tokens: tickers(&view),
        accounts: distinct(accounts(&view).into_values().map(|(_, id)| id)),
        recipients: recipients(&view),
        hashes: hashes(&view),
        release: release(&folded),
        verbs: verbs(&folded),
        phrases: phrases(&folded),
        policy: policy_claims(&view),
        hidden: has_any(&folded, HIDDEN_PHRASES),
        policy_template: has_any(&folded, POLICY_TEMPLATES),
    }
}

fn token_of(ticker: &str) -> Option<(&'static str, u32)> {
    TOKENS.iter().find(|(t, _, _)| t.eq_ignore_ascii_case(ticker)).map(|&(_, contract, decimals)| (contract, decimals))
}

/// Every standalone number in `view`, those followed by a known ticker as amounts and the rest
/// as bare numbers. A number stands alone when no letter, digit, `.`, `,`, `_`, `-` or non-ASCII
/// character is glued to its front (so not `v1.5`, `-5`, part of `1,000` or `1 000`, or a digit
/// after a combining mark) and none to its end except a ticker after optional spaces.
fn numbers(view: &str) -> (Vec<AmountClaim>, Vec<String>) {
    let b = view.as_bytes();
    let (mut amounts, mut bare) = (Vec::new(), Vec::new());
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
        let number = view[start..i].trim_end_matches('.');
        if !stands_alone(b, start) || number.matches('.').count() > 1 {
            continue;
        }
        let mut unit = i;
        while unit < b.len() && b[unit] == b' ' {
            unit += 1;
        }
        let word_end = b[unit..].iter().position(|c| !c.is_ascii_alphabetic()).map_or(b.len(), |n| unit + n);
        let ticker = (word_end > unit && ends_word(b, word_end)).then(|| &view[unit..word_end]).and_then(token_of);
        match ticker {
            Some((contract, decimals)) => {
                if let Some(amount) = base_units(number, decimals) {
                    amounts.push(AmountClaim { token: contract.to_string(), amount: amount.to_string() });
                }
            }
            None if ends_word(b, start + number.len()) => bare.push(number.to_string()),
            None => {}
        }
    }
    (amounts, bare)
}

fn stands_alone(b: &[u8], start: usize) -> bool {
    let Some(&before) = start.checked_sub(1).and_then(|p| b.get(p)) else { return true };
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
/// byte is ASCII and not a letter, digit, `_` or `-`, and not a `.` that continues a name.
fn ends_word(b: &[u8], end: usize) -> bool {
    match b.get(end) {
        None => true,
        Some(&c) if !c.is_ascii() || c.is_ascii_alphanumeric() || c == b'_' || c == b'-' => false,
        Some(b'.') => !b.get(end + 1).is_some_and(u8::is_ascii_alphanumeric),
        Some(_) => true,
    }
}

fn starts_word(b: &[u8], start: usize) -> bool {
    start == 0 || {
        let c = b[start - 1];
        c.is_ascii() && !c.is_ascii_alphanumeric() && !b"._-".contains(&c)
    }
}

/// Tickers written alone, in any case, other than NEAR, whose bare word is too common to be a
/// claim ("NEAR Intents", "NEAR AI").
fn tickers(view: &str) -> Vec<String> {
    let b = view.as_bytes();
    let lower = view.to_ascii_lowercase();
    let mut out: Vec<String> = Vec::new();
    for (ticker, contract, _) in TOKENS.iter().filter(|(t, _, _)| *t != "near") {
        for (at, _) in lower.match_indices(ticker) {
            if starts_word(b, at) && ends_word(b, at + ticker.len()) && !out.iter().any(|c| c == contract) {
                out.push(contract.to_string());
            }
        }
    }
    out
}

/// A NEAR account id that is named (it has a top-level account of two or more characters
/// starting with a letter) or implicit (64 hex characters, `0x` and 40, or `0s` and 40). Numbers
/// such as `2.5`, abbreviations such as `e.g` and bare words are not accounts.
pub(super) fn account_shaped(id: &str) -> bool {
    if !is_account_id(id) {
        return false;
    }
    let hex = |s: &str| s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c));
    let implicit = (id.len() == 64 && hex(id))
        || (id.len() == 42 && (id.starts_with("0x") || id.starts_with("0s")) && hex(&id[2..]));
    let named = id.rsplit_once('.').is_some_and(|(_, top)| top.len() >= 2 && top.as_bytes()[0].is_ascii_lowercase());
    implicit || named
}

/// Account ids by the byte they start at, with the byte they end at.
type Found<'a> = BTreeMap<usize, (usize, &'a str)>;

fn distinct<'a>(ids: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    ids.filter(|id| seen.insert(*id)).map(str::to_string).collect()
}

/// Every account id in `view`: a run of `a-z`, `0-9`, `.`, `_` and `-` with no ASCII letter,
/// digit or non-ASCII character glued to either end, a final `.` dropped.
fn accounts(view: &str) -> Found<'_> {
    let b = view.as_bytes();
    let in_id = |c: u8| matches!(c, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-');
    let mut out = Found::new();
    let mut i = 0;
    while i < b.len() {
        if !in_id(b[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < b.len() && in_id(b[i]) {
            i += 1;
        }
        let glued = |c: u8| !c.is_ascii() || c.is_ascii_alphanumeric();
        if (start > 0 && glued(b[start - 1])) || (i < b.len() && glued(b[i])) {
            continue;
        }
        let id = view[start..i].trim_end_matches('.');
        if account_shaped(id) {
            out.insert(start, (start + id.len(), id));
        }
    }
    out
}

/// Account ids written after the word "to", straight after it or after at most three words of
/// lower-case letters ("to the treasurer bob.near").
fn recipients(view: &str) -> Vec<String> {
    let lower = view.to_ascii_lowercase();
    let b = lower.as_bytes();
    let found = accounts(view);
    let mut out = Vec::new();
    for (at, _) in lower.match_indices("to ") {
        if !starts_word(b, at) {
            continue;
        }
        let mut p = at + 3;
        for _ in 0..4 {
            while p < b.len() && b[p] == b' ' {
                p += 1;
            }
            if let Some(&(_, id)) = found.get(&p) {
                out.push(id);
                break;
            }
            let word = b[p..].iter().position(|c| !c.is_ascii_lowercase()).map_or(b.len() - p, |n| n);
            if word == 0 || b.get(p + word).is_some_and(|&c| c != b' ') {
                break;
            }
            p += word;
        }
    }
    distinct(out.into_iter())
}

/// 32-byte hashes, as lower-case hex. A bulk payment's "Payload Hashes" field is skipped up to
/// the end of its line or field (ruling 12).
fn hashes(view: &str) -> Vec<String> {
    let lower = view.to_ascii_lowercase();
    let skip: Vec<(usize, usize)> = lower
        .match_indices("payload hashes")
        .map(|(at, _)| {
            let window = (at + MAX_FIELD_BYTES).min(lower.len());
            let window = (at..=window).rev().find(|&i| lower.is_char_boundary(i)).unwrap_or(at);
            let field = &lower[at..window];
            let end = field.find(['\n', '*']).unwrap_or(field.len());
            (at, at + field[..end].find("<br").unwrap_or(end))
        })
        .collect();
    let (mut next_skip, mut skipped_to) = (0, 0);
    let b = view.as_bytes();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if !b[i].is_ascii_alphanumeric() {
            i += 1;
            continue;
        }
        let start = i;
        while i < b.len() && b[i].is_ascii_alphanumeric() {
            i += 1;
        }
        while next_skip < skip.len() && skip[next_skip].0 <= start {
            skipped_to = skipped_to.max(skip[next_skip].1);
            next_skip += 1;
        }
        let glued = |c: u8| !c.is_ascii() || c == b'_';
        if (start > 0 && glued(b[start - 1])) || (i < b.len() && glued(b[i])) || start < skipped_to {
            continue;
        }
        let word = &view[start..i];
        let bytes = if word.len() == 64 && word.bytes().all(|c| c.is_ascii_hexdigit()) {
            Some(word.to_ascii_lowercase())
        } else if (43..=44).contains(&word.len()) {
            bs58::decode(word).into_vec().ok().filter(|v| v.len() == 32).map(|v| hex_of(&v))
        } else {
            None
        };
        if let Some(h) = bytes {
            if !out.contains(&h) {
                out.push(h);
            }
        }
    }
    out
}

pub(super) fn hex_of(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A version label "N.M" beside "release", "version" or a leading "v", in a text that names
/// Sputnik.
fn release(folded: &str) -> Option<String> {
    if !folded.contains("sputnik") {
        return None;
    }
    let b = folded.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if !b[i].is_ascii_digit() || (i > 0 && (b[i - 1].is_ascii_digit() || b[i - 1] == b'.')) {
            i += 1;
            continue;
        }
        let start = i;
        while i < b.len() && (b[i].is_ascii_digit() || b[i] == b'.') {
            i += 1;
        }
        let label = folded[start..i].trim_end_matches('.');
        let parts: Vec<&str> = label.split('.').collect();
        if parts.len() != 2 || parts.iter().any(|p| p.is_empty() || p.len() > 3) {
            continue;
        }
        let before = folded[..start].trim_end();
        let after = folded[start + label.len()..].trim_start();
        let marked = before.ends_with("release")
            || before.ends_with("version")
            || (start > 0 && b[start - 1] == b'v' && (start < 2 || !b[start - 2].is_ascii_alphanumeric()))
            || after.starts_with("release");
        if marked {
            return Some(label.to_string());
        }
    }
    None
}

fn verbs(folded: &str) -> Vec<Verb> {
    let families: [(&[&str], Verb); 11] = [
        (PAY_VERBS, Verb::Pay),
        (ADD_VERBS, Verb::Add),
        (GRANT_VERBS, Verb::Grant),
        (REMOVE_VERBS, Verb::Remove),
        (UPGRADE_VERBS, Verb::Upgrade),
        (SWAP_VERBS, Verb::Swap),
        (STAKE_VERBS, Verb::Stake),
        (UNSTAKE_VERBS, Verb::Unstake),
        (WITHDRAW_VERBS, Verb::Withdraw),
        (WRAP_VERBS, Verb::Wrap),
        (VENUE_VERBS, Verb::Deposit),
    ];
    let mut out = Vec::new();
    for word in leading_words(folded) {
        if let Some((_, verb)) = families.iter().find(|(list, _)| list.contains(&word)) {
            if !out.contains(verb) {
                out.push(*verb);
            }
        }
    }
    out
}

fn phrases(folded: &str) -> Vec<Phrase> {
    let lists: [(&[&str], Phrase); 13] = [
        (SWAP_WORDS, Phrase::Swap),
        (DEPOSIT_ADDRESS_PHRASES, Phrase::DepositAddress),
        (PAYMENT_WORDS, Phrase::Payment),
        (NO_VALUE_PHRASES, Phrase::NoValue),
        (VENUE_WORDS, Phrase::Rebalance),
        (STORAGE_PHRASES, Phrase::Storage),
        (ROTATION_WORDS, Phrase::Rotation),
        (CLEANUP_WORDS, Phrase::Cleanup),
        (CONFIG_WORDS, Phrase::Config),
        (BOND_WORDS, Phrase::Bond),
        (THRESHOLD_WORDS, Phrase::Threshold),
        (FACTORY_WORDS, Phrase::Factory),
        (VOTE_WORDS, Phrase::Vote),
    ];
    lists.iter().filter(|(list, _)| has_any(folded, list)).map(|(_, p)| *p).collect()
}

/// The quoted names of a `["a", "b"]` list starting at `at`, and the byte after its `]`.
fn quoted_list(view: &str, at: usize) -> Option<(Vec<String>, usize)> {
    let rest = view.get(at..)?.strip_prefix('[')?;
    let close = rest.find(']')?;
    let items = rest[..close]
        .split(',')
        .map(|item| item.trim().strip_prefix('"').and_then(|s| s.strip_suffix('"')).map(str::to_string))
        .collect::<Option<Vec<String>>>()?;
    Some((items, at + 1 + close + 1))
}

fn skip_spaces(b: &[u8], mut p: usize) -> usize {
    while p < b.len() && b[p] == b' ' {
        p += 1;
    }
    p
}

/// "add X to R", "remove X from R", "add member: X", the treasury app's `add "X" to ["R"]` and
/// `edit "X": added to ["R"]`, end-state rosters, threshold changes and "remove <word> role".
fn policy_claims(view: &str) -> PolicyClaims {
    let lower = view.to_ascii_lowercase();
    let b = lower.as_bytes();
    let found = accounts(view);
    let account_at = |p: usize| found.get(&p).map(|&(e, id)| (id.to_string(), e));
    let mut claims = PolicyClaims::default();

    for verb in ["add", "remove", "edit"] {
        for (at, _) in lower.match_indices(verb) {
            if !starts_word(b, at) || b.get(at + verb.len()) != Some(&b' ') {
                continue;
            }
            let mut p = skip_spaces(b, at + verb.len());
            for filler in ["inactive member:", "member:", "member "] {
                if lower[p..].starts_with(filler) {
                    p = skip_spaces(b, p + filler.len());
                    break;
                }
            }
            let quoted = b.get(p) == Some(&b'"');
            let Some((member, end)) = account_at(p + usize::from(quoted)) else { continue };
            let mut q = end;
            if quoted {
                if b.get(q) != Some(&b'"') {
                    continue;
                }
                q += 1;
            }
            let mut op = verb;
            if verb == "edit" {
                q = skip_spaces(b, q + usize::from(b.get(q) == Some(&b':')));
                if lower[q..].starts_with("added ") {
                    op = "add";
                } else if lower[q..].starts_with("removed ") {
                    op = "remove";
                } else {
                    continue;
                }
                q = skip_spaces(b, q + op.len() + 2);
            } else {
                q = skip_spaces(b, q);
            }
            let (roles, exact) = role_after(view, &lower, q);
            let claim = MemberClaim { member, roles, exact };
            if op == "add" {
                claims.adds.push(claim);
            } else {
                claims.removes.push(claim);
            }
        }
    }

    claims.rosters = rosters(view, &lower, &found);
    claims.threshold = threshold(&lower);
    for (at, _) in lower.match_indices(" role") {
        let before: Vec<&str> = lower[..at].rsplit(' ').take(3).collect();
        let straight = before.len() >= 2 && REMOVE_VERBS.contains(&before[1]);
        let after_article = before.len() == 3 && REMOVE_VERBS.contains(&before[2]) && ["the", "a", "an"].contains(&before[1]);
        if straight || after_article {
            claims.role_words.push(view[at - before[0].len()..at].to_string());
        }
    }
    claims
}

/// The role or roles after "to", "from" or "as" at `p`: a quoted list or a quoted name (exact), or
/// one plain word after an optional article (not exact).
fn role_after(view: &str, lower: &str, p: usize) -> (Vec<String>, bool) {
    let b = lower.as_bytes();
    let Some(word) = ["to ", "from ", "as "].iter().find(|w| lower[p..].starts_with(**w)) else {
        return (Vec::new(), false);
    };
    let mut q = skip_spaces(b, p + word.len());
    if b.get(q) == Some(&b'[') {
        return quoted_list(view, q).map_or((Vec::new(), false), |(roles, _)| (roles, true));
    }
    if b.get(q) == Some(&b'"') {
        return view[q + 1..].find('"').map_or((Vec::new(), false), |close| (vec![view[q + 1..q + 1 + close].to_string()], true));
    }
    for article in ["the ", "a ", "an "] {
        if lower[q..].starts_with(article) {
            q = skip_spaces(b, q + article.len());
            break;
        }
    }
    let len = b[q..].iter().position(|c| !(c.is_ascii_alphanumeric() || *c == b'_' || *c == b'-')).unwrap_or(b.len() - q);
    if len == 0 {
        (Vec::new(), false)
    } else {
        (vec![view[q..q + len].to_string()], false)
    }
}

/// "role: a, b and c" with two or more accounts, and the accounts a parenthesis marks "out".
fn rosters(view: &str, lower: &str, found: &Found) -> Vec<Roster> {
    let b = lower.as_bytes();
    let marked_out = out_members(lower, found);
    let mut out = Vec::new();
    for (colon, _) in lower.match_indices(':') {
        let role_start = lower[..colon]
            .char_indices()
            .rev()
            .find(|&(_, c)| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
            .map_or(0, |(n, c)| n + c.len_utf8());
        if role_start == colon {
            continue;
        }
        let mut members = Vec::new();
        let mut p = skip_spaces(b, colon + 1);
        while let Some(&(end, id)) = found.get(&p) {
            members.push(id.to_string());
            p = end;
            if lower[p..].starts_with(", ") {
                p += 2;
            } else if lower[p..].starts_with(" and ") {
                p += 5;
            } else if lower[p..].starts_with(',') {
                p += 1;
            } else {
                break;
            }
            p = skip_spaces(b, p);
        }
        if members.len() >= 2 {
            out.push(Roster { role: view[role_start..colon].to_string(), members, out: marked_out.clone() });
        }
    }
    out
}

fn out_members(lower: &str, found: &Found) -> Vec<String> {
    let mut out = Vec::new();
    for (at, _) in lower.match_indices(" out") {
        if lower.as_bytes().get(at + 4).is_some_and(u8::is_ascii_alphanumeric) {
            continue;
        }
        let from = lower[..at].rfind(['(', ',', ';']).map_or(0, |n| n + 1);
        out.extend(found.range(from..at).filter(|(_, (e, _))| *e <= at).map(|(_, (_, id))| id.to_string()));
    }
    out
}

/// The value a threshold change names: the number or percentage after the last "to" in a line
/// that holds "threshold", or empty when no such line names a number.
fn threshold(lower: &str) -> Option<String> {
    let mut named = None;
    for (at, _) in lower.match_indices("threshold") {
        let window = (at + MAX_FIELD_BYTES).min(lower.len());
        let window = (at..=window).rev().find(|&i| lower.is_char_boundary(i)).unwrap_or(at);
        let line = &lower[at..window];
        let line = &line[..line.find(['\n', '*', '<']).unwrap_or(line.len())];
        let value = line.rfind(" to ").and_then(|to| {
            let rest = line[to + 4..].trim_start();
            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
            (digits > 0).then(|| format!("{}{}", &rest[..digits], if rest[digits..].starts_with('%') { "%" } else { "" }))
        });
        if value.is_some() {
            return value;
        }
        named = Some(String::new());
    }
    named
}
