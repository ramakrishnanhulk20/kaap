//! Turns the agreed chain read into kaap-core's `ProposalInput` and runs `analyze`. Every rule
//! that decides what a proposal means lives in kaap-core; this file only fills its input.

use kaap_core::{analyze, canonical_policy, Analysis, Network, Prices, ProposalInput};

use crate::reads::ChainRead;

/// Sputnik's status word for a proposal still open to votes.
pub const IN_PROGRESS: &str = "InProgress";

/// The input `analyze` sees for the proposal in `read`.
///
/// `kind_json` is the exact bytes of the kind as read (C5). `policy_before` is the policy read
/// at the same block, which is the policy the proposal would run against only while it is still
/// InProgress; for any other status it is `None`, which kaap-core treats as not known and never
/// replaces with today's policy. The policy is parsed from kaap-core's canonical bytes, so it is
/// read by the same strict parser that the verdict's policy hash used (standard 2). There is no
/// payment history and no price list in this job yet, so `history` is `None` (not available)
/// and every token is unpriced (UNKNOWN_VALUE, never zero, C2).
pub fn proposal_input(network: Network, dao: &str, proposal_id: u64, read: &ChainRead) -> ProposalInput {
    let policy_before = if read.proposal.status == IN_PROGRESS {
        canonical_policy(&read.policy_json).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok())
    } else {
        None
    };
    ProposalInput {
        network,
        dao: dao.to_string(),
        proposal_id,
        description: read.proposal.description.clone(),
        kind_json: read.proposal.kind_json.clone(),
        policy_before,
        history: None,
        prices: Prices::default(),
        dao_version: None,
        supplied_text: None,
        guard_account: None,
        config_before: None,
    }
}

/// The input and kaap-core's analysis of it.
pub fn judge(network: Network, dao: &str, proposal_id: u64, read: &ChainRead) -> (ProposalInput, Analysis) {
    let input = proposal_input(network, dao, proposal_id, read);
    let analysis = analyze(&input);
    (input, analysis)
}
