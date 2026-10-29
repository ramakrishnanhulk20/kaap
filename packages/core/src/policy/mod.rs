//! Effects and findings for the policy kinds, measured against the policy before (guide
//! sections 3, 4 and 7).

use crate::types::{Effect, FindingCode, ProposalInput};

/// Returns the policy effects and findings for `input`. Empty until WO-01b adds
/// AddMemberToRole.
pub fn decode(input: &ProposalInput) -> (Vec<Effect>, Vec<FindingCode>) {
    let _ = input;
    (Vec::new(), Vec::new())
}
