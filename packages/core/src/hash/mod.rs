//! The `sign_request` effect of a FunctionCall to `v1.signer` method `sign`, and the hash
//! checks on any supplied text (C6 to C8).

use crate::types::{Effect, FindingCode, ProposalInput};

/// Returns the sign-request effects and hash findings for `input`. Empty until WO-04.
pub fn check(input: &ProposalInput) -> (Vec<Effect>, Vec<FindingCode>) {
    let _ = input;
    (Vec::new(), Vec::new())
}
