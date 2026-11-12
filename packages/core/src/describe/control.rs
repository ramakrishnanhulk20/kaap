//! Policy kinds: what the text says about members, rosters, thresholds and roles, against what
//! the change does measured from the policy before (guide sections 4 and 7; rulings 9 and 22 to
//! 25, ruling 22 being the hidden-control rule of 26 Oct 2026).
//!
//! A described change that the effects do not make, including one already in place, is a
//! contradiction. When the text names a specific member, role or threshold change, any change of
//! control it does not mention is one too: an approver added or removed, fewer votes needed
//! (POLICY_LOWERS_THRESHOLD), an approving role whose holders are replaced (POLICY_REPLACES_ROLE),
//! or a change to the guard (GUARD_WEAKENED, ruling 23). An end-state
//! roster is checked against the end state (ruling 24). A text that names nothing specific never
//! fires the unmentioned-change rule. With the policy before unknown nothing here is a claim:
//! POLICY_BEFORE_UNKNOWN already stands.
//!
//! Members and accounts are compared as exact strings, role names without regard to case, and
//! the findings come from the same `policy::decode` the rest of Kaap runs (standard 2).

use std::collections::BTreeSet;

use serde_json::Value;

use super::claims::{Claims, MemberClaim, Verb};
use super::text::has_phrase;
use super::Outcome;
use crate::policy::sputnik::Policy;
use crate::types::{Effect, FindingCode, ProposalInput, RoleMember};

#[derive(Default)]
struct Change<'a> {
    roles_added: Vec<&'a str>,
    roles_removed: Vec<&'a str>,
    added: Vec<&'a RoleMember>,
    removed: Vec<&'a RoleMember>,
    permissions: bool,
    votes: Vec<&'a Value>,
    bond_or_period: bool,
    before_unknown: bool,
}

impl Change<'_> {
    fn is_empty(&self) -> bool {
        self.roles_added.is_empty()
            && self.roles_removed.is_empty()
            && self.added.is_empty()
            && self.removed.is_empty()
            && !self.permissions
            && self.votes.is_empty()
            && !self.bond_or_period
    }
}

fn change_of(effects: &[Effect]) -> Option<Change<'_>> {
    let mut found = None::<Change>;
    for e in effects {
        if let Effect::PolicyChange {
            roles_added,
            roles_removed,
            members_added,
            members_removed,
            permissions_changed,
            vote_policy_changed,
            bond_or_period_changed,
            before_unknown,
        } = e
        {
            let c = found.get_or_insert_with(Change::default);
            c.roles_added.extend(roles_added.iter().map(String::as_str));
            c.roles_removed.extend(roles_removed.iter().map(String::as_str));
            c.added.extend(members_added);
            c.removed.extend(members_removed);
            c.permissions |= !permissions_changed.is_empty();
            c.votes.extend(vote_policy_changed.iter().map(|v| &v.after));
            c.bond_or_period |= *bond_or_period_changed;
            c.before_unknown |= *before_unknown;
        }
    }
    found
}

fn same_role(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// True when claim `c` covers `role`: its roles were written exactly and name `role`, or they
/// were written loosely ("to the treasury (Admin)"), which covers any role.
fn covers(c: &MemberClaim, role: &str) -> bool {
    !c.exact || c.roles.is_empty() || c.roles.iter().any(|r| same_role(r, role))
}

/// True when every role an exact claim lists holds the change, or, for a loose claim, any role
/// does. `role_gone` counts a role removed whole as removing its members.
fn made(c: &MemberClaim, changed: &[&RoleMember], role_gone: &dyn Fn(&str) -> bool) -> bool {
    let in_role = |role: &str| changed.iter().any(|m| m.member == c.member && same_role(&m.role, role)) || role_gone(role);
    if c.exact && !c.roles.is_empty() {
        c.roles.iter().all(|r| in_role(r))
    } else {
        changed.iter().any(|m| m.member == c.member)
    }
}

fn group_members(policy: &Policy, role: &str) -> BTreeSet<String> {
    policy.roles.iter().filter(|r| same_role(&r.name, role)).filter_map(|r| r.members()).flatten().cloned().collect()
}

fn threshold_is(after: &Value, stated: &str) -> bool {
    let t = &after["threshold"];
    match stated.strip_suffix('%') {
        Some(pct) => {
            let (Ok(pct), Some([n, d])) = (pct.parse::<u128>(), t.as_array().map(Vec::as_slice)) else { return false };
            let (Some(n), Some(d)) = (n.as_u64(), d.as_u64()) else { return false };
            u128::from(n) * 100 == pct * u128::from(d)
        }
        None => t.as_str() == Some(stated) || t.as_u64().is_some_and(|n| n.to_string() == stated),
    }
}

pub(super) fn compare(claims: &Claims, folded: &str, input: &ProposalInput, effects: &[Effect], codes: &[FindingCode], out: &mut Outcome) {
    let Some(change) = change_of(effects) else { return };
    if change.before_unknown {
        return;
    }
    if claims.policy_template {
        out.agree("the treasury app's policy text");
    }
    let p = &claims.policy;
    let before = input.policy_before.as_ref().and_then(Policy::from_json);
    let role_known = |role: &str| {
        before.as_ref().is_some_and(|b| b.roles.iter().any(|r| same_role(&r.name, role)))
            || change.added.iter().chain(&change.removed).any(|m| same_role(&m.role, role))
            || change.roles_added.iter().any(|r| same_role(r, role))
    };
    let removed_roles: Vec<&str> = p.role_words.iter().map(String::as_str).filter(|w| role_known(w)).collect();
    let role_gone = |role: &str| change.roles_removed.iter().any(|r| same_role(r, role));

    for c in &p.adds {
        if made(c, &change.added, &|_| false) {
            out.agree("a named member is added");
        } else {
            out.contradict("a named addition is not made");
        }
    }
    for c in &p.removes {
        if made(c, &change.removed, &role_gone) {
            out.agree("a named member is removed");
        } else {
            out.contradict("a named removal is not made");
        }
    }
    let rosters: Vec<_> = p.rosters.iter().filter(|r| role_known(&r.role)).collect();
    if let Some(before) = &before {
        for r in &rosters {
            let mut end = group_members(before, &r.role);
            for m in change.added.iter().filter(|m| same_role(&m.role, &r.role)) {
                end.insert(m.member.clone());
            }
            for m in change.removed.iter().filter(|m| same_role(&m.role, &r.role)) {
                end.remove(&m.member);
            }
            if r.members.iter().all(|m| end.contains(m)) && r.out.iter().all(|m| !end.contains(m)) {
                out.agree("the roster is the role after the change");
            } else {
                out.contradict("the roster is not the role after the change");
            }
        }
    }
    if let Some(stated) = &p.threshold {
        if change.votes.is_empty() {
            out.contradict("a threshold change is described and none is made");
        } else if stated.is_empty() || change.votes.iter().any(|after| threshold_is(after, stated)) {
            out.agree("the threshold named is set");
        }
    }
    for role in &removed_roles {
        if role_gone(role) {
            out.agree("the role named is removed");
        } else {
            out.contradict("the role named is not removed");
        }
    }
    let adds_said = claims.verbs.contains(&Verb::Add) || claims.verbs.contains(&Verb::Grant);
    if adds_said && p.adds.is_empty() && change.is_empty() {
        out.contradict("an addition is described and the policy does not change");
    }

    if !p.names_a_change() && removed_roles.is_empty() {
        return;
    }
    let in_roster = |m: &RoleMember| rosters.iter().find(|r| same_role(&r.role, &m.role));
    for m in change.added.iter().filter(|m| m.approver) {
        let said = p.adds.iter().any(|c| c.member == m.member && covers(c, &m.role))
            || in_roster(m).is_some_and(|r| r.members.contains(&m.member));
        if !said {
            out.contradict("an approver is added and the text does not say so");
        }
    }
    for m in change.removed.iter().filter(|m| m.approver) {
        let said = p.removes.iter().any(|c| c.member == m.member && covers(c, &m.role))
            || in_roster(m).is_some_and(|r| r.out.contains(&m.member) || !r.members.contains(&m.member))
            || removed_roles.iter().any(|r| same_role(r, &m.role));
        if !said {
            out.contradict("an approver is removed and the text does not say so");
        }
    }
    if codes.contains(&FindingCode::PolicyLowersThreshold) && p.threshold.is_none() {
        out.contradict("fewer votes are needed and the text does not say so");
    }
    if codes.contains(&FindingCode::GuardWeakened) && !has_phrase(folded, "guard") {
        out.contradict("the guard changes and the text does not say so");
    }
    // A replaced role is mentioned when the text names it, or names as added every account it
    // newly covers. A role opened to token holders or to everyone covers no account a text could
    // list, so only its name mentions it.
    if codes.contains(&FindingCode::PolicyReplacesRole) {
        for replaced in crate::policy::replaced_roles(input) {
            let named_as_added = |account: &String| {
                p.adds.iter().any(|c| c.member == *account && covers(c, &replaced.name))
                    || rosters.iter().any(|r| same_role(&r.role, &replaced.name) && r.members.contains(account))
            };
            let accounts_named = replaced.accounts.as_ref().is_some_and(|accounts| accounts.iter().all(named_as_added));
            if !has_phrase(folded, &replaced.name) && !accounts_named {
                out.contradict("a role's holders are replaced and the text does not say so");
            }
        }
    }
}
