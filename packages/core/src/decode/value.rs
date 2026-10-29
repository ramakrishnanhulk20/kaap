//! Effects and findings for every kind that is not a policy kind and not a sign call: payments,
//! token and intents calls, wrapping, staking, storage deposits, DeFi and bulk payments (guide
//! section 3). FunctionCall actions to `v1.signer` method `sign` belong to `hash::check`, and
//! this module emits nothing for them.

use crate::types::{Effect, FindingCode, ProposalInput};

/// Returns this module's effects and findings for `input`. Empty until WO-01b adds Transfer.
pub fn decode(input: &ProposalInput) -> (Vec<Effect>, Vec<FindingCode>) {
    let _ = input;
    (Vec::new(), Vec::new())
}
