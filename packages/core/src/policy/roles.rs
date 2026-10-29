//! Reading the roles of a policy as `get_policy` returns it, and Sputnik's rule for which roles
//! can approve.

use serde_json::Value;

/// One role of a policy. `members` is `None` for the `Everyone` and `Member(balance)` kinds, which
/// have no member list a shortcut kind could change.
pub(crate) struct Role<'a> {
    pub name: &'a str,
    pub members: Option<Vec<&'a str>>,
    pub permissions: Vec<&'a str>,
}

impl Role<'_> {
    /// Sputnik grants an action when a role holds `<label>:<action>`, `<label>:*`, `*:<action>`
    /// or `*:*` (policy.rs `can_execute_action`, 335-357), so a role can approve some kind
    /// exactly when one of its permissions has the action part `VoteApprove` or `*` (guide
    /// ruling 1). The label part is not checked against Sputnik's 17 labels: a permission Sputnik
    /// would ignore still counts as approving here, which errs toward reporting a new approver.
    pub fn can_approve(&self) -> bool {
        self.permissions.iter().any(|p| {
            p.split_once(':').is_some_and(|(_, action)| action == "VoteApprove" || action == "*")
        })
    }
}

/// The roles of `policy`, in order, or `None` when any part of them is not the shape Sputnik
/// writes. A policy this cannot read is treated by callers as a policy not known (fail closed,
/// standard 4), never as a policy with no roles.
pub(crate) fn read_roles(policy: &Value) -> Option<Vec<Role<'_>>> {
    fn strings(v: &Value) -> Option<Vec<&str>> {
        v.as_array()?.iter().map(Value::as_str).collect()
    }
    policy
        .get("roles")?
        .as_array()?
        .iter()
        .map(|role| {
            let members = match role.get("kind")? {
                Value::String(kind) if kind == "Everyone" => None,
                Value::Object(kind) if kind.len() == 1 => match kind.iter().next()? {
                    (name, list) if name == "Group" => Some(strings(list)?),
                    (name, Value::String(_)) if name == "Member" => None,
                    _ => return None,
                },
                _ => return None,
            };
            Some(Role {
                name: role.get("name")?.as_str()?,
                members,
                permissions: strings(role.get("permissions")?)?,
            })
        })
        .collect()
}
