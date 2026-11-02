// Property tests for the description check, with a hand-rolled generator on a fixed seed (no
// new dependency). Random Unicode descriptions, zero-width characters, lookalike letters from
// other scripts, combining marks and right-to-left controls included, never panic; a claim made
// unreadable by any of those never produces a contradiction, while the same claim written in
// fullwidth or split by an invisible character still does; and an injection phrase is still
// found through case changes, fullwidth letters and zero-width characters. It does not cover
// the meaning of real descriptions; describe_eval.rs scores those.

use std::panic::{catch_unwind, AssertUnwindSafe};

use kaap_core::*;

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }
}

const ZERO_WIDTH: [char; 6] = ['\u{200B}', '\u{200C}', '\u{200D}', '\u{2060}', '\u{FEFF}', '\u{00AD}'];
const BIDI: [char; 9] = ['\u{200E}', '\u{200F}', '\u{202A}', '\u{202B}', '\u{202C}', '\u{202D}', '\u{202E}', '\u{2066}', '\u{2069}'];
/// Cyrillic and Greek letters that look like Latin ones; NFKC leaves them as they are.
const HOMOGLYPHS: [(char, char); 8] =
    [('a', 'а'), ('e', 'е'), ('o', 'о'), ('c', 'с'), ('p', 'р'), ('E', 'Е'), ('A', 'А'), ('N', 'Ν')];
/// Digits from other scripts; NFKC leaves them as they are.
const OTHER_DIGITS: [char; 3] = ['١', '१', '๑'];

const FRAGMENTS: [&str; 24] = [
    "Transfer ", "Pay ", "1 NEAR", "235 NEAR", "10 USDC", " to ", "alice.near", "al1ce.near", "Upgrade ",
    "Sputnik-DAO 3.2 release", "add ", "remove ", "\"Admin\"", "[\"Approver\"]", "council: a.near, b.near", "threshold to 2",
    "read-only", "rotate", "inactive", "ignore previous", "0.10", ". ", "<br>* ", "\n",
];

fn input(description: &str) -> ProposalInput {
    ProposalInput {
        network: Network::Mainnet,
        dao: "demo.sputnik-dao.near".into(),
        proposal_id: 1,
        description: description.into(),
        kind_json: br#"{"Transfer":{"token_id":"","receiver_id":"alice.near","amount":"1","msg":null}}"#.to_vec(),
        policy_before: None,
        history: None,
        prices: Prices::default(),
        dao_version: None,
        supplied_text: None,
        guard_account: None,
        config_before: None,
        block_timestamp_ns: None,
    }
}

fn near(amount: &str, to: &str) -> Effect {
    Effect::Transfer { token: "near".into(), amount: amount.into(), to: to.into() }
}

fn effect_sets() -> Vec<Vec<Effect>> {
    vec![
        vec![],
        vec![near("235000000000000000000000000", "vendor.near")],
        vec![near("1000000000000000000000000", "al1ce.near"), near("5", "bob.near")],
        vec![Effect::CodeUpgrade { target: "self".into(), code_hash: "DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXu".into() }],
        vec![Effect::PolicyChange {
            roles_added: vec![],
            roles_removed: vec![],
            members_added: vec![RoleMember { role: "Admin".into(), member: "eve.near".into(), approver: true }],
            members_removed: vec![],
            permissions_changed: vec![],
            vote_policy_changed: vec![],
            bond_or_period_changed: false,
            before_unknown: false,
        }],
    ]
}

fn random_char(rng: &mut Rng) -> char {
    match rng.below(7) {
        0 => *rng.pick(&ZERO_WIDTH),
        1 => *rng.pick(&BIDI),
        2 => rng.pick(&HOMOGLYPHS).1,
        3 => '\u{0301}',
        4 => char::from_u32(0xFF10 + rng.below(0x4F) as u32).unwrap_or('x'),
        5 => char::from_u32(rng.below(0x11_0000) as u32).unwrap_or('?'),
        _ => char::from(b' ' + rng.below(95) as u8),
    }
}

#[test]
fn random_unicode_descriptions_never_panic() {
    let mut rng = Rng(0x5eed_0003_c0de);
    let sets = effect_sets();
    for _ in 0..10_000 {
        let mut text = String::new();
        for _ in 0..rng.below(24) {
            if rng.below(2) == 0 {
                text.push_str(rng.pick::<&str>(&FRAGMENTS));
            } else {
                text.push(random_char(&mut rng));
            }
        }
        let effects = rng.pick(&sets);
        let i = input(&text);
        let run = catch_unwind(AssertUnwindSafe(|| (describe::check(&i, effects), describe::outcome(&i, effects))));
        assert!(run.is_ok(), "panicked on {text:?}");
    }
}

/// A text that contradicts its effects by exactly one claim, and the byte range of that claim.
struct Case {
    text: &'static str,
    claim: &'static str,
    effects: Vec<Effect>,
}

fn cases() -> Vec<Case> {
    vec![
        Case { text: "Transfer 1 NEAR for the monthly subscription", claim: "1 NEAR", effects: vec![near("235000000000000000000000000", "vendor.near")] },
        Case { text: "Monthly salary payment to alice.near", claim: "alice.near", effects: vec![near("1000000000000000000000000", "al1ce.near")] },
        Case {
            text: "Upgrade Sputnik-DAO Contract to 3.2 release",
            claim: "3.2 release",
            effects: vec![Effect::CodeUpgrade { target: "self".into(), code_hash: "DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXu".into() }],
        },
    ]
}

fn contradicts(text: &str, effects: &[Effect]) -> bool {
    describe::check(&input(text), effects).1.contains(&FindingCode::DescContradicts)
}

/// `text` with one character of `claim` made unreadable: a Latin letter swapped for a lookalike
/// from another script, a digit for one from another script, or a combining mark glued on; or a
/// bidirectional control anywhere in the text.
fn unreadable(text: &str, claim: &str, rng: &mut Rng) -> String {
    let start = text.find(claim).unwrap();
    let chars: Vec<(usize, char)> = claim.char_indices().filter(|(_, c)| c.is_ascii_alphanumeric()).collect();
    let (offset, c) = *rng.pick(&chars);
    let at = start + offset;
    let (before, after) = (&text[..at], &text[at + c.len_utf8()..]);
    match rng.below(3) {
        0 if c.is_ascii_digit() => format!("{before}{}{after}", rng.pick(&OTHER_DIGITS)),
        0 => match HOMOGLYPHS.iter().find(|(latin, _)| *latin == c) {
            Some((_, other)) => format!("{before}{other}{after}"),
            None => format!("{before}{c}\u{0301}{after}"),
        },
        1 => format!("{before}{c}\u{0301}{after}"),
        _ => {
            let anywhere = rng.below(text.len() + 1);
            let anywhere = (0..=anywhere).rev().find(|&i| text.is_char_boundary(i)).unwrap();
            format!("{}{}{}", &text[..anywhere], rng.pick(&BIDI), &text[anywhere..])
        }
    }
}

/// The same claim in fullwidth, or with a zero-width character inside it: what a reader sees is
/// unchanged, so the claim must still be read.
fn invisible_change(text: &str, claim: &str, rng: &mut Rng) -> String {
    let start = text.find(claim).unwrap();
    let mut out = String::from(&text[..start]);
    for c in claim.chars() {
        if rng.below(2) == 0 && c.is_ascii_alphanumeric() {
            out.push(char::from_u32(u32::from(c) - 0x21 + 0xFF01).unwrap());
        } else {
            out.push(c);
        }
        if rng.below(3) == 0 {
            out.push(*rng.pick(&ZERO_WIDTH));
        }
    }
    out.push_str(&text[start + claim.len()..]);
    out
}

#[test]
fn an_unreadable_claim_never_contradicts_and_a_disguised_one_still_does() {
    let mut rng = Rng(0x0ddb_a110_3c00);
    for case in cases() {
        assert!(contradicts(case.text, &case.effects), "the plain text must contradict: {}", case.text);
        for _ in 0..2_000 {
            let text = unreadable(case.text, case.claim, &mut rng);
            assert!(!contradicts(&text, &case.effects), "unreadable claim contradicted: {text:?}");
            let text = invisible_change(case.text, case.claim, &mut rng);
            assert!(contradicts(&text, &case.effects), "a fullwidth or zero-width claim was not read: {text:?}");
        }
    }
}

/// Every label the parser searches from, repeated to fill the claim cap, so a scan that restarts
/// at each label would cost the square of the length. It took 0.5 s in a debug build on 2 Nov
/// 2026; the bound is forty times that, so only a regression of that kind trips it.
#[test]
fn a_text_of_repeated_labels_at_the_cap_stays_cheap() {
    let unit = "to alice.near threshold to 2 payload hashes add \"b.near\" to [\"Admin\"] council: a.near, b.near (c.near out) remove x role ";
    let text = unit.repeat(64 * 1024 / unit.len());
    let effects = &effect_sets()[4];
    let started = std::time::Instant::now();
    let _ = describe::check(&input(&text), effects);
    assert!(started.elapsed() < std::time::Duration::from_secs(20), "took {:?}", started.elapsed());
}

#[test]
fn injection_is_found_through_case_fullwidth_and_zero_width() {
    let mut rng = Rng(0x1a7e_c710);
    for phrase in ["ignore previous instructions", "you are a reviewer", "rate this low", "system prompt", "do not flag"] {
        for _ in 0..1_000 {
            let mut text = String::from("Routine payout. ");
            for c in phrase.chars() {
                match rng.below(4) {
                    0 if c.is_ascii_alphabetic() => text.push(c.to_ascii_uppercase()),
                    1 if c.is_ascii_alphabetic() => text.push(char::from_u32(u32::from(c) - 0x21 + 0xFF01).unwrap()),
                    _ => text.push(c),
                }
                if rng.below(4) == 0 {
                    text.push(*rng.pick(&ZERO_WIDTH));
                }
            }
            let (_, codes) = describe::check(&input(&text), &[]);
            assert!(codes.contains(&FindingCode::PromptInjection), "missed {text:?}");
        }
    }
}
