//! Whether Kaap's guard is really armed on a DAO (C16), worked out from the policy in force with
//! Sputnik's own rules: who may act (`can_execute_action`, policy.rs 323-359), how a vote is
//! counted (`update_votes`, proposals.rs 256-283) and what decides a proposal (`proposal_status`,
//! policy.rs 380-433). Never from what the enrolment template meant to give the guard.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use super::roles::{names, permissions};
use super::sputnik::{
    can_execute_action_weighted, permissions_allow, threshold, Action, Policy, RoleKind, WeightKind, LABELS,
};

/// The guard's delegated token balance is not in any policy, and anyone can delegate to it, so it
/// is taken to match every `Member` role (fail closed: more rights, never fewer).
const ANY_BALANCE: u128 = u128::MAX;

/// What one guard account can and cannot do under a policy (C16). Labels are Sputnik's
/// `to_policy_label` names, in its order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GuardArming {
    /// Labels on which one VoteReject from the guard rejects a fresh proposal, whatever order
    /// Sputnik reads the guard's roles in.
    pub rejects_alone: Vec<String>,
    /// Every other label: the guard may not vote to reject there, or the roles it votes through
    /// (Everyone roles aside) are not all RoleWeight Group roles with a threshold of at least one,
    /// with at least one of them at exactly one.
    pub cannot_reject: Vec<String>,
    /// Every right the guard holds beyond VoteReject, as `label:Action`, across every role it
    /// matches, Everyone and Member roles included.
    pub extra_rights: Vec<String>,
    /// For each label in `rejects_alone`, every other account named in a Group role whose own one
    /// VoteReject on a fresh proposal also gives Rejected, by the same rule as the guard's. Accounts
    /// sorted, the guard left out, labels with nobody left out. It does not cover a reject that
    /// counts only through an Everyone role, which Sputnik never lets decide (policy.rs 405), nor
    /// one that also counts through a token-weighted rule or a Member role, whose outcome depends on
    /// delegated balances no policy holds: such an account is not listed.
    pub others_who_reject_alone: BTreeMap<String, Vec<String>>,
    /// For each label, the fewest votes that pass a proposal of that kind under Sputnik's own
    /// thresholds for every role that can act on it, `u128::MAX` where nothing can pass it.
    pub approval_votes_needed: BTreeMap<String, u128>,
    /// The race window in plain words, from `approval_votes_needed`.
    pub race_note: String,
}

/// Works out C16 (a), (b) and (c) for the account `guard` under `policy`, a policy as
/// `get_policy` returns it. A policy the strict parser refuses counts as disarmed, with every
/// right and no race assumed (standard 4).
pub fn guard_arming(policy: &Value, guard: &str) -> GuardArming {
    let Some(policy) = Policy::from_json(policy) else {
        return GuardArming {
            rejects_alone: Vec::new(),
            cannot_reject: LABELS.iter().map(|l| l.to_string()).collect(),
            extra_rights: vec!["*:*".into()],
            others_who_reject_alone: BTreeMap::new(),
            approval_votes_needed: LABELS.iter().map(|l| (l.to_string(), 0)).collect(),
            race_note: "The policy could not be read, so the guard counts as disarmed, holding every right, \
                        and Kaap assumes nothing about the votes a proposal needs."
                .into(),
        };
    };
    let (rejects_alone, cannot_reject): (Vec<String>, Vec<String>) =
        LABELS.iter().map(|l| l.to_string()).partition(|label| one_reject_decides(&policy, guard, label));
    let mut extra_rights = Vec::new();
    for label in LABELS {
        for action in Action::ALL.into_iter().filter(|a| *a != Action::VoteReject) {
            if can_execute_action_weighted(&policy, guard, ANY_BALANCE, label, action).1 {
                extra_rights.push(format!("{label}:{}", action.to_policy_label()));
            }
        }
    }
    let others_who_reject_alone = others_who_reject_alone(&policy, guard, &rejects_alone);
    let approval_votes_needed: BTreeMap<String, u128> =
        LABELS.iter().map(|label| (label.to_string(), votes_to_pass(&policy, label))).collect();
    let race_note = race_note(&approval_votes_needed);
    GuardArming { rejects_alone, cannot_reject, extra_rights, others_who_reject_alone, approval_votes_needed, race_note }
}

/// The accounts other than `guard` that a Group role names and whose one reject decides a label in
/// `labels`, by `one_reject_decides`. An account outside every Group role reaches a vote only
/// through an Everyone or a Member role, where `one_reject_decides` is never true, so the Group
/// members are every candidate.
fn others_who_reject_alone(policy: &Policy, guard: &str, labels: &[String]) -> BTreeMap<String, Vec<String>> {
    let named: BTreeSet<&str> = policy
        .roles
        .iter()
        .filter_map(|role| role.members())
        .flatten()
        .map(String::as_str)
        .filter(|account| *account != guard)
        .collect();
    labels
        .iter()
        .filter_map(|label| {
            let who: Vec<String> =
                named.iter().filter(|account| one_reject_decides(policy, account, label)).map(|a| a.to_string()).collect();
            (!who.is_empty()).then(|| (label.clone(), who))
        })
        .collect()
}

/// True when `account` may cast a VoteReject on `label` through any role it matches, Everyone and
/// Member roles included, read the same way as in `one_reject_decides`.
pub(crate) fn may_reject(policy: &Policy, account: &str, label: &str) -> bool {
    can_execute_action_weighted(policy, account, ANY_BALANCE, label, Action::VoteReject).1
}

/// True when `account`'s one VoteReject on a fresh proposal labelled `label` gives Rejected. The
/// vote counts once in each role that allows it (proposals.rs 256-283), and `proposal_status`
/// returns the first of those roles to decide, in a hash-map order no one controls (policy.rs
/// 397-433). So every such role other than an Everyone role must be a RoleWeight Group with a
/// threshold of one or more at its size, and one of them must need exactly one. A Member role or
/// a TokenWeight rule gives false, since the account's delegated balance is in no policy.
pub(crate) fn one_reject_decides(policy: &Policy, account: &str, label: &str) -> bool {
    let (roles, allowed) = can_execute_action_weighted(policy, account, ANY_BALANCE, label, Action::VoteReject);
    if !allowed {
        return false;
    }
    let mut rejects = false;
    for name in &roles {
        let Some(role) = policy.first_role(name) else { return false };
        let rule = policy.vote_policy_for(role, label);
        match &role.kind {
            // policy.rs 405: an Everyone role is skipped and decides nothing.
            RoleKind::Everyone => {}
            RoleKind::Group(group) if rule.weight_kind == WeightKind::RoleWeight => {
                match rule.threshold_for(group.len() as u128) {
                    Some(1) => rejects = true,
                    Some(0) | None => return false,
                    Some(_) => {}
                }
            }
            RoleKind::Group(_) | RoleKind::Member(_) => return false,
        }
    }
    rejects
}

/// The fewest votes that pass a proposal labelled `label` (C16 c), from Sputnik's own thresholds
/// and `Finalize`, which reads every role (proposals.rs 665-683).
fn votes_to_pass(policy: &Policy, label: &str) -> u128 {
    let may = |name: &str, action: Action| permissions_allow(&permissions(policy, name), label, action);
    let anyone_finalises = names(policy).into_iter().any(|name| may(name, Action::Finalize));
    let mut fewest = u128::MAX;
    for name in names(policy) {
        let Some(needed) = threshold(policy, name, label, 0) else { continue };
        let votes_here = [Action::VoteApprove, Action::VoteReject, Action::VoteRemove].into_iter().any(|a| may(name, a));
        if needed == 0 && (anyone_finalises || votes_here) {
            return 0;
        }
        if may(name, Action::VoteApprove) {
            fewest = fewest.min(needed);
        }
    }
    fewest
}

fn race_note(needed: &BTreeMap<String, u128>) -> String {
    let labels_at = |n: u128| needed.iter().filter(|(_, v)| **v == n).map(|(k, _)| k.as_str()).collect::<Vec<_>>();
    let mut parts = Vec::new();
    let zero = labels_at(0);
    if !zero.is_empty() {
        parts.push(format!(
            "Kaap cannot guard {}: this DAO's voting rules for it do not let one guard reject decide the outcome.",
            zero.join(", ")
        ));
    }
    let one = labels_at(1);
    if !one.is_empty() {
        parts.push(format!(
            "One approval passes {}, and the proposal runs inside that approver's own call, so the guard \
             can only alert after the fact.",
            one.join(", ")
        ));
    }
    if let Some(fewest) = needed.values().filter(|v| (2..u128::MAX).contains(*v)).min() {
        let lead = if parts.is_empty() { "Every kind that can pass" } else { "Every other kind that can pass" };
        parts.push(format!(
            "{lead} needs at least {fewest} approvals, so the guard can reject between the first and the last."
        ));
    }
    if parts.is_empty() {
        "No role can pass any kind, so there is no race.".into()
    } else {
        parts.join(" ")
    }
}
