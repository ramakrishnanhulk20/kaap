//! The `policy_change` effect of Sputnik's seven policy kinds (guide sections 3 and 7). Each kind
//! is applied to the policy before the way Sputnik executes it (proposals.rs 363-459, which edit
//! the policy in force at execution), and then one function compares the two policies, so the
//! policy before and the policy after always go through the same parser and the same comparison
//! (standard 2).

use serde_json::{json, Map, Value};

use super::arming::{may_reject, one_reject_decides};
use super::members::changes;
use super::roles::{can_approve, count, has_duplicate_names, names, permissions, Holders, GUARD_ROLE};
use super::sputnik::{
    object, permissions_allow, Action, Policy, PolicyParameters, Role, RoleKind, VotePolicy, WeightKind, WeightOrRatio,
    LABELS,
};
use crate::types::{Effect, FindingCode, PermissionChange, RoleMember, VotePolicyChange};

/// A policy kind as Sputnik's serde types read it (proposals.rs 67-121).
enum Edit {
    Full(Policy),
    AddMember { member: String, role: String },
    RemoveMember { member: String, role: String },
    AddOrUpdateRole(Role),
    RemoveRole(String),
    DefaultVotePolicy(VotePolicy),
    Parameters(PolicyParameters),
}

impl Edit {
    /// The policy kind `variant` with this body, or `None` when Sputnik would not have stored it:
    /// a field missing, one it does not have (`deny_unknown_fields`), or a value of the wrong
    /// shape. A full policy in the old bare-list form is refused, as `add_proposal` refuses it
    /// (proposals.rs 548-551).
    fn read(variant: &str, body: &Value) -> Option<Edit> {
        fn field<'a>(body: &'a Value, name: &str) -> Option<&'a Value> {
            object(body, &[name], &[]).map(|map: &Map<String, Value>| &map[name])
        }
        Some(match variant {
            "ChangePolicy" => Edit::Full(Policy::from_json(field(body, "policy")?)?),
            "AddMemberToRole" | "RemoveMemberFromRole" => {
                let map = object(body, &["member_id", "role"], &[])?;
                let member = map["member_id"].as_str()?.to_string();
                let role = map["role"].as_str()?.to_string();
                if variant == "AddMemberToRole" {
                    Edit::AddMember { member, role }
                } else {
                    Edit::RemoveMember { member, role }
                }
            }
            "ChangePolicyAddOrUpdateRole" => Edit::AddOrUpdateRole(Role::from_json(field(body, "role")?)?),
            "ChangePolicyRemoveRole" => Edit::RemoveRole(field(body, "role")?.as_str()?.to_string()),
            "ChangePolicyUpdateDefaultVotePolicy" => {
                Edit::DefaultVotePolicy(VotePolicy::from_json(field(body, "vote_policy")?)?)
            }
            "ChangePolicyUpdateParameters" => {
                Edit::Parameters(PolicyParameters::from_json(field(body, "parameters")?)?)
            }
            _ => return None,
        })
    }

    /// The policy in force after this kind executes on `before`.
    fn apply(&self, before: &Policy) -> Policy {
        let mut after = before.clone();
        match self {
            Edit::Full(policy) => return policy.clone(),
            Edit::AddMember { member, role } => after.add_member_to_role(role, member),
            Edit::RemoveMember { member, role } => after.remove_member_from_role(role, member),
            Edit::AddOrUpdateRole(role) => after.add_or_update_role(role),
            Edit::RemoveRole(role) => after.remove_role(role),
            Edit::DefaultVotePolicy(vote_policy) => after.update_default_vote_policy(vote_policy),
            Edit::Parameters(parameters) => after.update_parameters(parameters),
        }
        after
    }
}

/// The effect and findings of the policy kind `variant` with this `body`, against `before`, the
/// policy before as guide section 7 defines it. `guard` is the enrolled guard account, `None` when
/// it is not known.
///
/// A body Sputnik could not have stored gives no effect, and UNKNOWN_CALL, or POLICY_BEFORE_UNKNOWN
/// when there is no policy before either. A policy before that is missing, or that the strict
/// parser refuses, is not known (standard 4): the effect carries `before_unknown` and only what the
/// kind itself shows, a removed or added member counts as an approver (C2), and the findings are
/// POLICY_BEFORE_UNKNOWN plus the two the kind proves alone: duplicate role names in a full
/// policy, and GUARD_WEAKENED for a shortcut kind that names the guard role or removes the guard
/// account from a role.
pub(crate) fn decode(
    variant: &str,
    body: &Value,
    before: Option<&Value>,
    guard: Option<&str>,
) -> (Vec<Effect>, Vec<FindingCode>) {
    let before = before.and_then(Policy::from_json);
    let Some(edit) = Edit::read(variant, body) else {
        let code = if before.is_some() { FindingCode::UnknownCall } else { FindingCode::PolicyBeforeUnknown };
        return (Vec::new(), vec![code]);
    };
    let Some(before) = before else {
        let mut codes = vec![FindingCode::PolicyBeforeUnknown];
        // A full policy shows its own role names, so this one needs no policy before (Q2).
        if matches!(&edit, Edit::Full(after) if has_duplicate_names(after)) {
            codes.push(FindingCode::PolicyDuplicateRoleNames);
        }
        // A shortcut kind names the role it edits, so an edit of the guard role is named even
        // when its effect cannot be measured (C17).
        let role = match &edit {
            Edit::AddMember { role, .. } | Edit::RemoveMember { role, .. } | Edit::RemoveRole(role) => Some(role.as_str()),
            Edit::AddOrUpdateRole(role) => Some(role.name.as_str()),
            _ => None,
        };
        // Without a policy before, the roles that hold the guard account are not known, so the
        // template's role name still counts, and so does a removal that names the account itself.
        let removes_guard = matches!((&edit, guard), (Edit::RemoveMember { member, .. }, Some(g)) if member == g);
        if role == Some(GUARD_ROLE) || removes_guard {
            codes.push(FindingCode::GuardWeakened);
        }
        return (vec![unknown_before(&edit)], codes);
    };
    let after = edit.apply(&before);
    let change = compare(&before, &after);
    let codes = findings(&edit, &before, &after, &change, guard);
    (vec![change.into_effect(false)], codes)
}

/// The guide section 4 codes a policy change fires, measured on the two policies.
fn findings(edit: &Edit, before: &Policy, after: &Policy, change: &Change, guard: Option<&str>) -> Vec<FindingCode> {
    let mut codes = Vec::new();
    // Sputnik reads permissions from the last role of a name and votes from the first (C1), so
    // two roles of one name never mean what a reader expects.
    if has_duplicate_names(after) {
        codes.push(FindingCode::PolicyDuplicateRoleNames);
    }
    if matches!(edit, Edit::Full(_) | Edit::AddOrUpdateRole(_)) && replaces_approving_role(before, after) {
        codes.push(FindingCode::PolicyReplacesRole);
    }
    if lowers_threshold(before, after) {
        codes.push(FindingCode::PolicyLowersThreshold);
    }
    let weakened = match guard {
        Some(account) => guard_account_weakened(before, after, account),
        None => guard_weakened(before, after),
    };
    if weakened {
        codes.push(FindingCode::GuardWeakened);
    }
    if change.members_added.iter().any(|m| m.approver) {
        codes.push(FindingCode::PolicyAddsApprover);
    }
    // Any role, approving or not, and a whole role's removal removes its members (ruling 7).
    if !change.members_removed.is_empty() {
        codes.push(FindingCode::PolicyRemovesMember);
    }
    codes
}

/// True when a role name that can approve, before or after, ends up covering someone it did not
/// cover before (POLICY_REPLACES_ROLE). Holders are compared whole, so a Group turned into
/// Everyone, or into a token role, is a replacement too.
fn replaces_approving_role(before: &Policy, after: &Policy) -> bool {
    names(after).into_iter().any(|name| {
        count(before, name) > 0
            && (can_approve(before, name) || can_approve(after, name))
            && !Holders::of(after, name).within(&Holders::of(before, name))
    })
}

/// True when, on some kind, a role name that can approve it after the change could not before,
/// or needs fewer votes for it (POLICY_LOWERS_THRESHOLD, rulings 8, 20 and 27). A label with no
/// rule of its own uses the default (policy.rs 399-402), so a lowered default counts for every
/// role that relies on it. Approve rights are Sputnik's exact four patterns over every role of
/// the name, and a role name new in the policy gains every right it holds.
fn lowers_threshold(before: &Policy, after: &Policy) -> bool {
    let approves = |policy: &Policy, name: &str, label: &str| {
        permissions_allow(&permissions(policy, name), label, Action::VoteApprove)
    };
    names(after).into_iter().any(|name| {
        LABELS.iter().any(|label| {
            if !approves(after, name, label) {
                return false;
            }
            match (before.first_role(name), after.first_role(name)) {
                (Some(old), Some(new)) => !approves(before, name, label) || needs_fewer(before, old, after, new, label),
                _ => true,
            }
        })
    })
}

/// True when the first role of a name may need fewer votes on `label` after the change than
/// before. Head counts are compared at the group size after the change, so a member added or
/// removed alone never counts. A rule that counts tokens depends on the DAO's delegation, which no
/// policy holds, so it is compared rule against rule and any change that could ask for less, or
/// that switches between heads and tokens, counts as fewer (fail closed).
fn needs_fewer(before: &Policy, old: &Role, after: &Policy, new: &Role, label: &str) -> bool {
    let (was, now) = (before.vote_policy_for(old, label), after.vote_policy_for(new, label));
    let heads = |rule: &VotePolicy| rule.weight_kind == WeightKind::RoleWeight;
    match (&old.kind, &new.kind) {
        // policy.rs 405: proposal_status skips an Everyone role, so it decides nothing.
        (_, RoleKind::Everyone) => false,
        (RoleKind::Everyone, _) => true,
        (RoleKind::Group(_), RoleKind::Group(group)) if heads(&was) && heads(&now) => {
            let size = group.len() as u128;
            match (was.threshold_for(size), now.threshold_for(size)) {
                (Some(was), Some(now)) => now < was,
                _ => true,
            }
        }
        (old_kind, new_kind) => {
            std::mem::discriminant(old_kind) != std::mem::discriminant(new_kind)
                || heads(&was) != heads(&now)
                || token_rule_may_ask_less(&was, &now)
        }
    }
}

/// True when the token rule `now` can ask for less weight than `was` at some total delegation.
fn token_rule_may_ask_less(was: &VotePolicy, now: &VotePolicy) -> bool {
    now.quorum < was.quorum
        || match (was.threshold, now.threshold) {
            (WeightOrRatio::Weight(was), WeightOrRatio::Weight(now)) => now < was,
            (WeightOrRatio::Ratio(wn, wd), WeightOrRatio::Ratio(nn, nd)) => {
                u128::from(nn) * u128::from(wd) < u128::from(wn) * u128::from(nd)
            }
            _ => true,
        }
}

/// True when the change touches Kaap's guard role (GUARD_WEAKENED, C17): a role called `guard`
/// appears, goes, or differs in who it covers, its permissions or its own vote rules; or the
/// default vote policy changes so that the guard needs more votes on a label it can reject and has
/// no rule of its own for. A default that asks for fewer votes leaves one guard vote at least as
/// strong, so it is not counted. This is the rule when the guard account is not known.
fn guard_weakened(before: &Policy, after: &Policy) -> bool {
    let guard_roles = |policy: &Policy| policy.roles.iter().filter(|r| r.name == GUARD_ROLE).cloned().collect::<Vec<_>>();
    let now = guard_roles(after);
    if guard_roles(before) != now {
        return true;
    }
    let (Some(guard), false) = (now.first(), before.default_vote_policy == after.default_vote_policy) else {
        return false;
    };
    let (was, rule) = (before.default_vote_policy, after.default_vote_policy);
    LABELS.iter().any(|label| {
        let relies_on_default = !guard.vote_policy.contains_key(*label)
            && permissions_allow(&permissions(after, GUARD_ROLE), label, Action::VoteReject);
        let asks_more = match &guard.kind {
            RoleKind::Group(group) if was.weight_kind == WeightKind::RoleWeight && rule.weight_kind == WeightKind::RoleWeight => {
                let size = group.len() as u128;
                was.threshold_for(size) < rule.threshold_for(size)
            }
            _ => true,
        };
        relies_on_default && asks_more
    })
}

/// True when the change touches the guard account's roles or takes something from its own reject
/// (GUARD_WEAKENED with the account known, C17). The guard's roles are every role that names the
/// account as a Group member, before or after the change; the finding fires when the roles of any
/// of those names differ at all: members, permissions, own vote rules, kind, or a role of the
/// name added or removed (guide section 4, "any change to the Guard role"). It also fires when, on
/// some label, the account's one VoteReject decided a fresh proposal before and no longer does, or
/// it could cast a VoteReject before and holds that right through no role after, which catches a
/// default vote policy or another role's change that weakens it. Those two read both sides by the
/// rules `guard_arming` uses. A role called `guard` that does not hold the account is not read.
fn guard_account_weakened(before: &Policy, after: &Policy, guard: &str) -> bool {
    let holds_guard = |role: &Role| role.members().is_some_and(|members| members.contains(guard));
    let roles_named = |policy: &Policy, name: &str| policy.roles.iter().filter(|r| r.name == name).cloned().collect::<Vec<_>>();
    let role_changed = before
        .roles
        .iter()
        .chain(&after.roles)
        .filter(|role| holds_guard(role))
        .any(|role| roles_named(before, &role.name) != roles_named(after, &role.name));
    role_changed
        || LABELS.iter().any(|label| {
            (one_reject_decides(before, guard, label) && !one_reject_decides(after, guard, label))
                || (may_reject(before, guard, label) && !may_reject(after, guard, label))
        })
}

/// What the kind alone shows when the policy before is not known (guide section 7).
fn unknown_before(edit: &Edit) -> Effect {
    let mut change = Change::default();
    match edit {
        Edit::AddMember { member, role } => {
            change.members_added.push(RoleMember { role: role.clone(), member: member.clone(), approver: true })
        }
        Edit::RemoveMember { member, role } => {
            change.members_removed.push(RoleMember { role: role.clone(), member: member.clone(), approver: true })
        }
        Edit::RemoveRole(role) => change.roles_removed.push(role.clone()),
        Edit::DefaultVotePolicy(vote_policy) => change.vote_policy_changed.push(VotePolicyChange {
            role: "default".into(),
            label: "default".into(),
            before: json!("unknown"),
            after: vote_policy.to_json(),
        }),
        Edit::Parameters(parameters) => change.bond_or_period_changed = !parameters.is_empty(),
        // A whole policy or a whole role replaces something unknown: no single addition or
        // removal can be shown (guide section 7, ruling 6).
        Edit::Full(_) | Edit::AddOrUpdateRole(_) => {}
    }
    change.into_effect(true)
}

/// The fields of a `policy_change` effect.
#[derive(Default)]
struct Change {
    roles_added: Vec<String>,
    roles_removed: Vec<String>,
    members_added: Vec<RoleMember>,
    members_removed: Vec<RoleMember>,
    permissions_changed: Vec<PermissionChange>,
    vote_policy_changed: Vec<VotePolicyChange>,
    bond_or_period_changed: bool,
}

impl Change {
    fn into_effect(self, before_unknown: bool) -> Effect {
        Effect::PolicyChange {
            roles_added: self.roles_added,
            roles_removed: self.roles_removed,
            members_added: self.members_added,
            members_removed: self.members_removed,
            permissions_changed: self.permissions_changed,
            vote_policy_changed: self.vote_policy_changed,
            bond_or_period_changed: self.bond_or_period_changed,
            before_unknown,
        }
    }
}

/// Everything that differs between two policies, as guide section 3 writes it.
///
/// Roles are matched by name, every role of a name counted together. A name with more roles after
/// than before lists each extra one in `roles_added` (the second and later as `<name> (duplicate)`),
/// and the reverse in `roles_removed`; their members come through `members_added` and
/// `members_removed`. Permissions are compared for names in both policies; vote rules too, read
/// from the first role of a name, as Sputnik reads them (policy.rs 374-376), with `null` for a
/// label that has no rule of its own (ruling 26). The default vote policy is written as role
/// `default`, label `default`.
fn compare(before: &Policy, after: &Policy) -> Change {
    let mut change = Change::default();
    let mut order = names(before);
    order.extend(names(after).into_iter().filter(|n| !names(before).contains(n)));
    for name in &order {
        let (was, now) = (count(before, name), count(after, name));
        let numbered = |i: usize| if i == 0 { name.to_string() } else { format!("{name} (duplicate)") };
        change.roles_added.extend((was..now).map(numbered));
        change.roles_removed.extend((now..was).map(numbered));
        let (Some(first_before), Some(first_after)) = (before.first_role(name), after.first_role(name)) else {
            continue;
        };
        let (had, has) = (permissions(before, name), permissions(after, name));
        let added: Vec<String> = has.difference(&had).cloned().collect();
        let removed: Vec<String> = had.difference(&has).cloned().collect();
        if !added.is_empty() || !removed.is_empty() {
            change.permissions_changed.push(PermissionChange { role: name.to_string(), added, removed });
        }
        let mut labels: Vec<&String> = first_before.vote_policy.keys().chain(first_after.vote_policy.keys()).collect();
        labels.sort();
        labels.dedup();
        for label in labels {
            let (old, new) = (first_before.vote_policy.get(label), first_after.vote_policy.get(label));
            if old != new {
                change.vote_policy_changed.push(VotePolicyChange {
                    role: name.to_string(),
                    label: label.clone(),
                    before: old.map_or(Value::Null, VotePolicy::to_json),
                    after: new.map_or(Value::Null, VotePolicy::to_json),
                });
            }
        }
    }
    if before.default_vote_policy != after.default_vote_policy {
        change.vote_policy_changed.push(VotePolicyChange {
            role: "default".into(),
            label: "default".into(),
            before: before.default_vote_policy.to_json(),
            after: after.default_vote_policy.to_json(),
        });
    }
    (change.members_added, change.members_removed) = changes(before, after);
    change.bond_or_period_changed = before.proposal_bond != after.proposal_bond
        || before.proposal_period != after.proposal_period
        || before.bounty_bond != after.bounty_bond
        || before.bounty_forgiveness_period != after.bounty_forgiveness_period;
    change
}
