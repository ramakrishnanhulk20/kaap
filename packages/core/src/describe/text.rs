//! The two forms a description is read in. `readable` is the text claims are parsed from: NFKC,
//! so a fullwidth "１ ＮＥＡＲ" reads as the "1 NEAR" a person sees, with invisible characters
//! removed, so a zero-width space cannot split or hide a claim. `fold` is the same text in lower
//! case with whitespace runs collapsed, the one form every phrase list is compared in. Both sides
//! of every text comparison pass through `fold` (standard 2).
//!
//! What this does not do: it does not map lookalike letters from other scripts to Latin (a
//! Cyrillic "а" stays Cyrillic), so a claim spelt with one is unreadable and is not a claim. That
//! errs toward `vague`, never toward a contradiction.

use unicode_normalization::UnicodeNormalization;

/// The Unicode property Default_Ignorable_Code_Point (DerivedCoreProperties.txt, Unicode 15.1):
/// characters that render as nothing. They are removed before any comparison.
const IGNORABLE: [(u32, u32); 17] = [
    (0x00AD, 0x00AD),
    (0x034F, 0x034F),
    (0x061C, 0x061C),
    (0x115F, 0x1160),
    (0x17B4, 0x17B5),
    (0x180B, 0x180F),
    (0x200B, 0x200F),
    (0x202A, 0x202E),
    (0x2060, 0x206F),
    (0x3164, 0x3164),
    (0xFE00, 0xFE0F),
    (0xFEFF, 0xFEFF),
    (0xFFA0, 0xFFA0),
    (0xFFF0, 0xFFF8),
    (0x1BCA0, 0x1BCA3),
    (0x1D173, 0x1D17A),
    (0xE0000, 0xE0FFF),
];

/// The Unicode property Bidi_Control (PropList.txt): characters that change the order text is
/// shown in, so what a reader sees is not the order the bytes hold.
const BIDI_CONTROL: [(u32, u32); 4] = [(0x061C, 0x061C), (0x200E, 0x200F), (0x202A, 0x202E), (0x2066, 0x2069)];

/// Descriptions longer than this are not parsed for claims; the injection check still reads all
/// of it. A Sputnik description has no length cap of its own, so this bounds the work (standard 4).
pub(super) const MAX_CLAIM_TEXT_BYTES: usize = 64 * 1024;

fn in_ranges(c: char, ranges: &[(u32, u32)]) -> bool {
    let c = u32::from(c);
    ranges.iter().any(|&(lo, hi)| (lo..=hi).contains(&c))
}

pub(super) fn is_ignorable(c: char) -> bool {
    in_ranges(c, &IGNORABLE)
}

pub(super) fn is_bidi_control(c: char) -> bool {
    in_ranges(c, &BIDI_CONTROL)
}

fn visible_nfkc(text: &str) -> String {
    let chars = text.nfkc();
    chars.filter(|&c| !is_ignorable(c)).collect()
}

/// The text claims are parsed from, or `None` when nothing in it can be read with certainty: it
/// holds a bidirectional control, so its shown order is not its stored order, or it is longer
/// than `MAX_CLAIM_TEXT_BYTES`.
pub(super) fn readable(text: &str) -> Option<String> {
    if text.len() > MAX_CLAIM_TEXT_BYTES || text.chars().any(is_bidi_control) {
        return None;
    }
    Some(visible_nfkc(text))
}

/// NFKC, invisible characters removed, lower case, `<br>` read as a line break, and each run of
/// whitespace collapsed to one space, or to one line break when the run holds one.
pub(super) fn fold(text: &str) -> String {
    let lower = visible_nfkc(text).to_lowercase().replace("<br>", "\n").replace("<br/>", "\n");
    let mut out = String::with_capacity(lower.len());
    let mut pending: Option<char> = None;
    for c in lower.chars() {
        if c.is_whitespace() {
            pending = Some(if c == '\n' || pending == Some('\n') { '\n' } else { ' ' });
            continue;
        }
        if let Some(space) = pending.take() {
            if !out.is_empty() {
                out.push(space);
            }
        }
        out.push(c);
    }
    out
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// True when `phrase`, folded, occurs in `folded` as whole words: an alphanumeric end of the
/// phrase is never glued to more letters or digits in the text.
pub(super) fn has_phrase(folded: &str, phrase: &str) -> bool {
    let phrase = fold(phrase);
    let (Some(first), Some(last)) = (phrase.chars().next(), phrase.chars().last()) else { return false };
    folded.match_indices(phrase.as_str()).any(|(at, _)| {
        let before_ok = !is_word_char(first) || folded[..at].chars().next_back().is_none_or(|c| !is_word_char(c));
        let after_ok =
            !is_word_char(last) || folded[at + phrase.len()..].chars().next().is_none_or(|c| !is_word_char(c));
        before_ok && after_ok
    })
}

pub(super) fn has_any(folded: &str, phrases: &[&str]) -> bool {
    phrases.iter().any(|p| has_phrase(folded, p))
}

/// The first word of every clause of a folded text: its start, and after a line break, `!`, `?`,
/// `;`, `*`, `|`, a bracket, `>`, or a `.` or `:` followed by a space (so `nep141:wrap.near` and
/// `v1.signer` stay one word). These are the verbs a text
/// leads with ("Transfer 1 NEAR", "* Proposal Action: unstake"), as opposed to the same word used
/// as a noun inside a sentence ("for transferring tokens", "Scheduled maintenance upgrade"). A
/// clause that starts with a dotted or hyphenated name (`wrap.near`, `bulk-payment`) leads with
/// no word.
pub(super) fn leading_words(folded: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut at_start = true;
    let mut chars = folded.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if at_start && c.is_alphanumeric() {
            let end = folded[i..].find(|ch: char| !(is_word_char(ch) || ch == '.' || ch == '-')).map_or(folded.len(), |n| i + n);
            let token = folded[i..end].trim_end_matches('.');
            if !token.contains(['.', '-']) {
                out.push(token);
            }
            at_start = false;
            continue;
        }
        let next_is_space = chars.peek().is_none_or(|&(_, n)| n.is_whitespace());
        if matches!(c, '\n' | '!' | '?' | ';' | '*' | '|' | '(' | ')' | '[' | ']' | '>') || (matches!(c, '.' | ':') && next_is_space) {
            at_start = true;
        } else if c.is_alphanumeric() {
            at_start = false;
        }
    }
    out
}

/// The words of a folded text: runs of letters, digits and `_`.
pub(super) fn words(folded: &str) -> impl Iterator<Item = &str> {
    folded.split(|c: char| !is_word_char(c)).filter(|w| !w.is_empty())
}
