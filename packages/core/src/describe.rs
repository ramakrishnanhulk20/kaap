//! The description check of guide section 5 and the findings DESC_CONTRADICTS,
//! PROMPT_INJECTION and EMPTY_DESCRIPTION.

use crate::types::{DescCheck, Effect, FindingCode, ProposalInput};

/// Compares the description with every effect the other modules found. Until WO-01b it checks
/// no claim, which is what `vague` means, and so it can never fire DESC_CONTRADICTS.
pub fn check(input: &ProposalInput, effects: &[Effect]) -> (DescCheck, Vec<FindingCode>) {
    let _ = (input, effects);
    (DescCheck::Vague, Vec::new())
}
