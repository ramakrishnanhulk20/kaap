//! Effects and findings for every kind that is not a Transfer or a FunctionCall: the policy kinds,
//! measured against the policy before (guide sections 3, 4 and 7), and the governance kinds
//! (ChangeConfig, UpgradeSelf, UpgradeRemote, SetStakingContract, bounties, Vote,
//! FactoryInfoUpdate).
//!
//! Today it reads AddMemberToRole. The other kinds come with WO-03b; until then `analyze` gives
//! them its high fallback finding.

mod members;
mod roles;

use crate::decode::value::read_kind;
use crate::types::{Effect, FindingCode, ProposalInput};

/// Returns the policy and governance effects and findings for `input`.
pub fn decode(input: &ProposalInput) -> (Vec<Effect>, Vec<FindingCode>) {
    match read_kind(&input.kind_json) {
        Some((variant, body)) if variant == "AddMemberToRole" => {
            members::add_member_to_role(&body, input.policy_before.as_ref())
        }
        _ => (Vec::new(), Vec::new()),
    }
}
