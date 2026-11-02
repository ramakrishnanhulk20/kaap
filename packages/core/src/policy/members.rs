//! The members a policy change adds and removes, role name by role name (guide section 3).

use super::roles::{can_approve, names, Holders};
use super::sputnik::Policy;
use crate::types::RoleMember;

/// The accounts that hold a role name in `after` but not in `before` (added), and the reverse
/// (removed). Names come in the order `before` lists them, then the names new in `after`; the
/// accounts of a name are sorted. An added member's `approver` reads the policy after the change,
/// a removed member's the policy before it.
///
/// A name counts every role of that name, so when a shortcut kind adds an account to the first of
/// two roles it already sits in through the second, nothing is reported: its rights do not change.
/// `Everyone` and `Member` roles have no list, so a change to who they cover shows up only through
/// POLICY_REPLACES_ROLE, never here.
pub(crate) fn changes(before: &Policy, after: &Policy) -> (Vec<RoleMember>, Vec<RoleMember>) {
    let mut order = names(before);
    for name in names(after) {
        if !order.contains(&name) {
            order.push(name);
        }
    }
    let (mut added, mut removed) = (Vec::new(), Vec::new());
    for name in order {
        let (was, now) = (Holders::of(before, name).accounts, Holders::of(after, name).accounts);
        let approver_after = can_approve(after, name);
        let approver_before = can_approve(before, name);
        for member in now.difference(&was) {
            added.push(RoleMember { role: name.into(), member: member.clone(), approver: approver_after });
        }
        for member in was.difference(&now) {
            removed.push(RoleMember { role: name.into(), member: member.clone(), approver: approver_before });
        }
    }
    (added, removed)
}
