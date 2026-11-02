//! What a role name stands for once duplicate names are counted: who holds it, what it may do,
//! and whether it can approve. Sputnik never computes these; the guide's findings are written in
//! them (sections 3 and 4). Every answer covers all the roles of a name, so a second role of the
//! same name can never hide a holder or a right (C1, fail closed).

use std::collections::BTreeSet;

use super::sputnik::{Policy, RoleKind};

/// The name the enrolment template gives Kaap's reject-only role (scripts/WO-02c-setup-testnet.mjs
/// `GUARD_ROLE`, C30). It is the fallback for recognising a proposal that touches the guard when
/// `ProposalInput::guard_account` is `None`; with the account known, its roles are found by member.
pub const GUARD_ROLE: &str = "guard";

/// Who the roles of one name cover.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Holders {
    pub accounts: BTreeSet<String>,
    pub everyone: bool,
    /// The lowest delegated balance a `Member` role of this name asks for.
    pub min_balance: Option<u128>,
}

impl Holders {
    pub fn of(policy: &Policy, name: &str) -> Holders {
        let mut out = Holders::default();
        for role in policy.roles.iter().filter(|r| r.name == name) {
            match &role.kind {
                RoleKind::Everyone => out.everyone = true,
                RoleKind::Member(balance) => {
                    out.min_balance = Some(out.min_balance.map_or(*balance, |b| b.min(*balance)))
                }
                RoleKind::Group(accounts) => out.accounts.extend(accounts.iter().cloned()),
            }
        }
        out
    }

    /// True when everyone `self` covers is shown to be covered by `other` as well. Token holders
    /// are never shown to be inside a list of accounts, so that case answers false.
    pub fn within(&self, other: &Holders) -> bool {
        if other.everyone {
            return true;
        }
        let tokens_within = match (self.min_balance, other.min_balance) {
            (None, _) => true,
            (Some(mine), Some(theirs)) => mine >= theirs,
            (Some(_), None) => false,
        };
        !self.everyone && tokens_within && self.accounts.is_subset(&other.accounts)
    }
}

/// The role names of `policy`, each once, in the order they first appear.
pub(crate) fn names(policy: &Policy) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    for role in &policy.roles {
        if !out.contains(&role.name.as_str()) {
            out.push(&role.name);
        }
    }
    out
}

/// How many roles of `policy` are called `name`.
pub(crate) fn count(policy: &Policy, name: &str) -> usize {
    policy.roles.iter().filter(|r| r.name == name).count()
}

/// True when two roles of `policy` share a name (POLICY_DUPLICATE_ROLE_NAMES, C1).
pub(crate) fn has_duplicate_names(policy: &Policy) -> bool {
    names(policy).len() < policy.roles.len()
}

/// Every permission held by a role called `name`.
pub(crate) fn permissions(policy: &Policy, name: &str) -> BTreeSet<String> {
    policy.roles.iter().filter(|r| r.name == name).flat_map(|r| r.permissions.iter().cloned()).collect()
}

/// True when a role called `name` can approve at least one kind (guide section 3 and ruling 1):
/// one of its permissions has the action part `VoteApprove` or `*`. A permission Sputnik would
/// ignore, such as one with a misspelt label, counts here too, so this errs toward naming an
/// approver.
pub(crate) fn can_approve(policy: &Policy, name: &str) -> bool {
    permissions(policy, name)
        .iter()
        .any(|p| p.split_once(':').is_some_and(|(_, action)| action == "VoteApprove" || action == "*"))
}
