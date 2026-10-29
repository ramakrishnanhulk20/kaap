//! AddMemberToRole, applied to the policy before it the way Sputnik's
//! `Policy::add_member_to_role` applies it (policy.rs 292-305): the member joins the first role
//! with exactly that name if it is a `Group` role; a missing role or a role of another kind only
//! writes a log line, and adding an account already in the role changes nothing.

use serde_json::Value;

use super::roles::read_roles;
use crate::types::{Effect, FindingCode, RoleMember};

/// The effect and findings of an AddMemberToRole `body` against `before`, the policy before as
/// guide section 7 defines it.
///
/// With `before` known (and readable): one `policy_change`, listing the member in
/// `members_added` only when the policy really changes, with POLICY_ADDS_APPROVER when the role
/// can approve. With `before` unknown or unreadable: `before_unknown`, the member and role the
/// kind names with `approver: true` (an unknown role is treated as one that can approve, C2), and
/// POLICY_BEFORE_UNKNOWN, with no finding that needs the policy before (guide section 7). A body
/// without a string `member_id` and `role` is not understood: no effect, and UNKNOWN_CALL, or
/// POLICY_BEFORE_UNKNOWN when there is no policy before either.
pub(crate) fn add_member_to_role(body: &Value, before: Option<&Value>) -> (Vec<Effect>, Vec<FindingCode>) {
    let roles = before.and_then(read_roles);
    let field = |name: &str| body.get(name).and_then(Value::as_str);
    let (Some(member), Some(role)) = (field("member_id"), field("role")) else {
        let code = if roles.is_some() { FindingCode::UnknownCall } else { FindingCode::PolicyBeforeUnknown };
        return (Vec::new(), vec![code]);
    };

    let Some(roles) = roles else {
        let effect = Effect::PolicyChange {
            roles_added: Vec::new(),
            roles_removed: Vec::new(),
            members_added: vec![RoleMember { role: role.into(), member: member.into(), approver: true }],
            members_removed: Vec::new(),
            permissions_changed: Vec::new(),
            vote_policy_changed: Vec::new(),
            bond_or_period_changed: false,
            before_unknown: true,
        };
        return (vec![effect], vec![FindingCode::PolicyBeforeUnknown]);
    };

    let mut codes = Vec::new();
    let mut members_added = Vec::new();
    let target = roles.iter().find(|r| r.name == role);
    if let Some(Some(members)) = target.map(|r| &r.members) {
        if !members.contains(&member) {
            // With two roles of one name, Sputnik's permission lookup may read either one, so the
            // member counts as an approver if any role of that name can approve (C1, fail closed).
            let approver = roles.iter().any(|r| r.name == role && r.can_approve());
            if approver {
                codes.push(FindingCode::PolicyAddsApprover);
            }
            members_added.push(RoleMember { role: role.into(), member: member.into(), approver });
        }
    }
    let effect = Effect::PolicyChange {
        roles_added: Vec::new(),
        roles_removed: Vec::new(),
        members_added,
        members_removed: Vec::new(),
        permissions_changed: Vec::new(),
        vote_policy_changed: Vec::new(),
        bond_or_period_changed: false,
        before_unknown: false,
    };
    (vec![effect], codes)
}
