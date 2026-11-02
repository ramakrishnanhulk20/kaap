//! The description check of guide section 5 and the findings DESC_CONTRADICTS, PROMPT_INJECTION
//! and EMPTY_DESCRIPTION (section 4; rulings 9, 12, 13, 18, 19 and 22 to 27).
//!
//! What it covers. Plain code reads a fixed set of claims from the text (`claims::extract`):
//! amounts with a known ticker (NEAR, wNEAR, USDC, USDT), tickers alone, NEAR account ids,
//! recipients written after "to", 32-byte hashes, a Sputnik release label, verbs that lead a
//! clause, the phrases of ruling 28, and policy claims (members added or removed, end-state
//! rosters, thresholds, roles removed). Each is compared with the effects the other modules
//! found: amounts in base units at the token's decimals, recipients and tokens as exact ids,
//! hashes byte for byte (not a bulk payment's "Payload Hashes", ruling 12), releases against the
//! factory's published hashes, and policy claims against the change measured from the policy
//! before. Any phrase addressed to a reviewer or a model, in the text or in any string the
//! proposal carries, is PROMPT_INJECTION.
//!
//! What it does not cover. A claim the code cannot read with certainty is not a claim, and the
//! AI judges the rest: numbers in words or with separators ("1,000", "83K"), tickers outside the
//! table, accounts in capitals or lookalike scripts, any text holding a bidirectional control,
//! texts over 64 KiB, other languages, and any meaning beyond the fixed lists. Those texts come
//! out `vague`, never `contradicts`, because a false contradiction floors a payment or a control
//! change at critical and the guard then vetoes an honest DAO.

mod claims;
mod compare;
mod control;
mod injection;
mod lists;
mod releases;
mod text;

pub use claims::{extract, AmountClaim, Claims, MemberClaim, Phrase, PolicyClaims, Roster, Verb};

use crate::types::{DescCheck, Effect, FindingCode, ProposalInput};

/// Guide section 5: "empty or under 20 characters".
const MIN_DESCRIPTION_CHARS: usize = 20;

/// Everything the description check found for one proposal: the claims read from the text, and
/// a short reason for each claim that agreed with the effects and each that they contradict.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    pub claims: Claims,
    pub agreements: Vec<&'static str>,
    pub contradictions: Vec<&'static str>,
    pub injection: bool,
}

impl Outcome {
    fn agree(&mut self, why: &'static str) {
        if !self.agreements.contains(&why) {
            self.agreements.push(why);
        }
    }

    fn contradict(&mut self, why: &'static str) {
        if !self.contradictions.contains(&why) {
            self.contradictions.push(why);
        }
    }
}

/// Reads the description's claims and compares each with `effects`, the effects every other
/// module found for `input`. Pure, and never panics on any text (standard 4).
pub fn outcome(input: &ProposalInput, effects: &[Effect]) -> Outcome {
    let mut out = Outcome { claims: claims::extract(&input.description), injection: injection::found(input), ..Outcome::default() };
    if out.claims.readable {
        let folded = text::readable(&input.description).map(|view| text::fold(&view)).unwrap_or_default();
        let policy_codes = if effects.iter().any(|e| matches!(e, Effect::PolicyChange { .. })) {
            crate::policy::decode(input).1
        } else {
            Vec::new()
        };
        let claims = out.claims.clone();
        compare::compare(&claims, &folded, input, effects, &policy_codes, &mut out);
        control::compare(&claims, &folded, input, effects, &policy_codes, &mut out);
    }
    out
}

/// The description check and its findings: EMPTY_DESCRIPTION for a text under 20 characters,
/// PROMPT_INJECTION for text addressed to a model, DESC_CONTRADICTS for any claim the effects
/// contradict. The check is `empty` before anything else, then `contradicts`, `hidden`,
/// `matches` when at least one claim agrees, and `vague` otherwise.
pub fn check(input: &ProposalInput, effects: &[Effect]) -> (DescCheck, Vec<FindingCode>) {
    let out = outcome(input, effects);
    let empty = input.description.trim().chars().count() < MIN_DESCRIPTION_CHARS;
    let contradicts = !out.contradictions.is_empty();

    let mut codes = Vec::new();
    if empty {
        codes.push(FindingCode::EmptyDescription);
    }
    if out.injection {
        codes.push(FindingCode::PromptInjection);
    }
    if contradicts {
        codes.push(FindingCode::DescContradicts);
    }
    let desc = if empty {
        DescCheck::Empty
    } else if contradicts {
        DescCheck::Contradicts
    } else if out.claims.hidden {
        DescCheck::Hidden
    } else if !out.agreements.is_empty() {
        DescCheck::Matches
    } else {
        DescCheck::Vague
    };
    (desc, codes)
}
