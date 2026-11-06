//! Turns the agreed chain read into kaap-core's `ProposalInput` and runs `analyze`. Every rule
//! that decides what a proposal means lives in kaap-core; this file only fills its input.

use kaap_core::{analyze, canonical_policy, Analysis, History, Prices, ProposalInput, SuppliedText};

use crate::input::JobInput;
use crate::reads::ChainRead;

/// Sputnik's status word for a proposal still open to votes.
pub const IN_PROGRESS: &str = "InProgress";

/// The price list and the payment history, held together so one can never reach `analyze` without
/// the other. LARGE_AMOUNT needs a history, and a price clears UNKNOWN_VALUE, so prices alone would
/// hide a huge payment to a stranger.
#[derive(Clone, Debug, PartialEq)]
pub struct Past {
    pub prices: Prices,
    pub history: History,
}

/// The input `analyze` sees for the proposal in `read`.
///
/// `kind_json` is the exact bytes of the kind as read (C5). `policy_before` is the policy read
/// at the same block, which is the policy the proposal would run against only while it is still
/// InProgress; for any other status it is `None`, which kaap-core treats as not known and never
/// replaces with today's policy. The policy is parsed from kaap-core's canonical bytes, so it is
/// read by the same strict parser that the verdict's policy hash used (standard 2). `past` is what
/// `job::read_past` read. With none, `history` is `None` (not available) and every token is
/// unpriced (UNKNOWN_VALUE, never zero, C2). `block_timestamp_ns` is the
/// time of the block every read was pinned to, so a supplied text's deadline is judged against
/// the same moment as the proposal. `guard_account` is the input's `guard`, the account the
/// signed verdict names and the guard contract requires to be itself, so Kaap's own enrol call
/// reads as `guard_enrol` here as it does in the CLI (C14). As kaap-core says of this field, the
/// caller vouches for it: only the worker's runs sign with the key the guard accepts. `text` is a
/// sealed text the job has opened (`texts::open_text`).
pub fn proposal_input(input: &JobInput, text: Option<SuppliedText>, read: &ChainRead, past: Option<Past>) -> ProposalInput {
    let policy_before = if read.proposal.status == IN_PROGRESS {
        canonical_policy(&read.policy_json).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok())
    } else {
        None
    };
    let (prices, history) = match past {
        Some(Past { prices, history }) => (prices, Some(history)),
        None => (Prices::default(), None),
    };
    ProposalInput {
        network: input.network,
        dao: input.dao.clone(),
        proposal_id: input.proposal_id,
        description: read.proposal.description.clone(),
        kind_json: read.proposal.kind_json.clone(),
        policy_before,
        history,
        prices,
        dao_version: None,
        supplied_text: text,
        guard_account: Some(input.guard.clone()),
        config_before: None,
        block_timestamp_ns: Some(read.block.timestamp_ns),
    }
}

/// The input and kaap-core's analysis of it.
pub fn judge(input: &JobInput, text: Option<SuppliedText>, read: &ChainRead, past: Option<Past>) -> (ProposalInput, Analysis) {
    let proposal = proposal_input(input, text, read, past);
    let analysis = analyze(&proposal);
    (proposal, analysis)
}
