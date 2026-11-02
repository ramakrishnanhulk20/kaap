//! Effects and findings for every kind that is not a Transfer or a FunctionCall: the seven policy
//! kinds, measured against the policy before (guide sections 3, 4 and 7), and the governance kinds
//! (ChangeConfig, UpgradeSelf, UpgradeRemote, SetStakingContract, bounties, Vote,
//! FactoryInfoUpdate). Who may act and how many votes decide come only from `sputnik`, the port of
//! Sputnik's own rules (C1, standard 1).

pub mod arming;
mod change;
mod governance;
mod members;
mod roles;
pub mod sputnik;

pub use roles::GUARD_ROLE;

use crate::decode::value::read_kind;
use crate::types::{Effect, FindingCode, ProposalInput};

/// Returns the policy and governance effects and findings for `input`, and nothing for a
/// Transfer, a FunctionCall (`decode::value` and `hash` own those) or bytes that are not one of
/// Sputnik's 17 kinds (`analyze` gives those its high fallback).
pub fn decode(input: &ProposalInput) -> (Vec<Effect>, Vec<FindingCode>) {
    let Some((variant, body)) = read_kind(&input.kind_json) else { return (Vec::new(), Vec::new()) };
    match sputnik::label_of(&variant) {
        None | Some("transfer" | "call") => (Vec::new(), Vec::new()),
        Some(label) if sputnik::POLICY_LABELS.contains(&label) => {
            change::decode(&variant, &body, input.policy_before.as_ref())
        }
        Some(_) => governance::decode(&variant, &body),
    }
}
