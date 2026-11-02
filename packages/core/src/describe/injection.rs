//! PROMPT_INJECTION: text addressed to a reviewer or a model, in the description or in any
//! string the proposal carries. Every string is compared after `text::fold` (NFKC, invisible
//! characters removed, lower case, whitespace collapsed), the same normalisation the phrases in
//! `lists::INJECTION_PHRASES` get, so a fullwidth or zero-width-split "ignore previous" is still
//! found (standard 2).
//!
//! Strings read: the description, the supplied hash text, every string in the kind, and each of
//! those strings decoded once from base64 when that gives UTF-8 text (a FunctionCall's `args`,
//! with any nested `msg` inside it). The kind is read through `decode::value::read_kind`, which
//! caps it at 256 KiB, and nesting deeper than `MAX_DEPTH` is not walked (standard 4). It misses
//! paraphrases, other languages, text hidden in images or links, and base64 nested twice; the
//! AI, which sees every string only as quoted data (C10), is the second line.

use base64::Engine as _;
use serde_json::Value;

use super::lists::INJECTION_PHRASES;
use super::text::{fold, has_phrase};
use crate::decode::value::read_kind;
use crate::types::ProposalInput;

const MAX_DEPTH: usize = 32;

/// Base64 shorter than this cannot hold the shortest phrase.
const MIN_BASE64_LEN: usize = 8;

fn addressed_to_a_model(text: &str) -> bool {
    let folded = fold(text);
    INJECTION_PHRASES.iter().any(|p| has_phrase(&folded, p))
}

fn decoded(s: &str) -> Option<String> {
    if s.len() < MIN_BASE64_LEN {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(s).ok()?;
    String::from_utf8(bytes).ok()
}

fn any_string(v: &Value, depth: usize, hit: &mut impl FnMut(&str) -> bool) -> bool {
    if depth > MAX_DEPTH {
        return false;
    }
    match v {
        Value::String(s) => hit(s),
        Value::Array(items) => items.iter().any(|i| any_string(i, depth + 1, hit)),
        Value::Object(map) => map.iter().any(|(k, i)| hit(k) || any_string(i, depth + 1, hit)),
        _ => false,
    }
}

/// True when the description or any string the proposal carries holds a phrase from
/// `lists::INJECTION_PHRASES`.
pub(super) fn found(input: &ProposalInput) -> bool {
    if addressed_to_a_model(&input.description) {
        return true;
    }
    if input.supplied_text.as_ref().is_some_and(|t| addressed_to_a_model(&t.message)) {
        return true;
    }
    let Some((_, body)) = read_kind(&input.kind_json) else { return false };
    any_string(&body, 0, &mut |s| addressed_to_a_model(s) || decoded(s).is_some_and(|d| addressed_to_a_model(&d)))
}
