//! Sputnik DAO's own rules for who may act on a proposal and how many votes decide it, ported line
//! for line so Kaap reads a policy exactly the way the contract will (C1, standard 1). Written from
//! sputnikdao2 `policy.rs`, `proposals.rs` and `types.rs` on main as read on 20 Oct 2026 (HEAD
//! 5434a59, the 3.2 release code); each item names the lines it ports. `packages/core-diff` checks
//! these rules against the real 3.2 binary in a sandbox.
//!
//! The parser accepts exactly the JSON Sputnik's serde types accept: every field required that
//! Sputnik requires, no unknown field (Sputnik's `deny_unknown_fields`), amounts and periods as
//! decimal strings read by `str::parse`, the parser near-sdk's `U128`, `U64` and near-token's
//! `NearToken` use. What Sputnik could not have stored reads as `None`, never as a guess. Account
//! ids are compared byte for byte and not checked for syntax: a policy Sputnik stored only holds
//! valid ones.
//!
//! Not ported: token-weighted vote counting needs the DAO's total delegation and each voter's
//! delegated balance, which no policy holds, so those take them as arguments (`threshold`,
//! `can_execute_action_weighted`), and `votes_needed` answers only for head-count roles.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Map, Value};

use crate::decode::value::read_kind;

/// `ProposalKind::to_policy_label` (proposals.rs 125-147), keyed by the kind's serde variant name,
/// in the source's order. This is the one list of kinds Kaap keeps, because Sputnik permissions
/// name kinds by these labels and offer no "every kind except" (standard 1).
pub const KIND_LABELS: [(&str, &str); 17] = [
    ("ChangeConfig", "config"),
    ("ChangePolicy", "policy"),
    ("AddMemberToRole", "add_member_to_role"),
    ("RemoveMemberFromRole", "remove_member_from_role"),
    ("FunctionCall", "call"),
    ("UpgradeSelf", "upgrade_self"),
    ("UpgradeRemote", "upgrade_remote"),
    ("Transfer", "transfer"),
    ("SetStakingContract", "set_vote_token"),
    ("AddBounty", "add_bounty"),
    ("BountyDone", "bounty_done"),
    ("Vote", "vote"),
    ("FactoryInfoUpdate", "factory_info_update"),
    ("ChangePolicyAddOrUpdateRole", "policy_add_or_update_role"),
    ("ChangePolicyRemoveRole", "policy_remove_role"),
    ("ChangePolicyUpdateDefaultVotePolicy", "policy_update_default_vote_policy"),
    ("ChangePolicyUpdateParameters", "policy_update_parameters"),
];

/// Every policy label, in `KIND_LABELS` order.
pub const LABELS: [&str; 17] = {
    let mut out = [""; 17];
    let mut i = 0;
    while i < 17 {
        out[i] = KIND_LABELS[i].1;
        i += 1;
    }
    out
};

/// The labels of the seven kinds that edit the policy (proposals.rs 363-378 and 436-459).
pub const POLICY_LABELS: [&str; 7] = [
    "policy",
    "add_member_to_role",
    "remove_member_from_role",
    "policy_add_or_update_role",
    "policy_remove_role",
    "policy_update_default_vote_policy",
    "policy_update_parameters",
];

/// The policy label of the kind named `variant`, or `None` for a name that is not one of
/// Sputnik's 17 kinds.
pub fn label_of(variant: &str) -> Option<&'static str> {
    KIND_LABELS.iter().find(|(name, _)| *name == variant).map(|(_, label)| *label)
}

/// The policy label of a kind as `get_proposal` returns it, read through the same strict reader
/// every decoder uses (`decode::value::read_kind`), so the label and the effects always come from
/// one reading of the bytes (standard 2). `""` for anything Sputnik could not have stored.
pub fn to_policy_label(kind_json: &[u8]) -> &'static str {
    read_kind(kind_json).and_then(|(variant, _)| label_of(&variant)).unwrap_or("")
}

/// Sputnik's `Action` (types.rs 47-69). Its policy label is the variant name (`format!("{:?}")`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Action {
    AddProposal,
    RemoveProposal,
    VoteApprove,
    VoteReject,
    VoteRemove,
    Finalize,
    MoveToHub,
}

impl Action {
    pub const ALL: [Action; 7] = [
        Action::AddProposal,
        Action::RemoveProposal,
        Action::VoteApprove,
        Action::VoteReject,
        Action::VoteRemove,
        Action::Finalize,
        Action::MoveToHub,
    ];

    pub fn to_policy_label(self) -> &'static str {
        match self {
            Action::AddProposal => "AddProposal",
            Action::RemoveProposal => "RemoveProposal",
            Action::VoteApprove => "VoteApprove",
            Action::VoteReject => "VoteReject",
            Action::VoteRemove => "VoteRemove",
            Action::Finalize => "Finalize",
            Action::MoveToHub => "MoveToHub",
        }
    }
}

/// `RoleKind` (policy.rs 15-22). A `Group` is a hash set in Sputnik, so repeats collapse and its
/// size is the number of distinct accounts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RoleKind {
    Everyone,
    Member(u128),
    Group(BTreeSet<String>),
}

/// `WeightKind` (policy.rs 113-118).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WeightKind {
    TokenWeight,
    RoleWeight,
}

/// `WeightOrRatio` (policy.rs 91-94): a bare string is a weight, a two-number array a ratio whose
/// second number is never zero (`NonZeroU64`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WeightOrRatio {
    Weight(u128),
    Ratio(u64, u64),
}

impl WeightOrRatio {
    /// `WeightOrRatio::to_weight` (policy.rs 98-106). `None` where `num * total` overflows u128,
    /// which only a token total could reach.
    pub fn to_weight(&self, total_weight: u128) -> Option<u128> {
        match *self {
            WeightOrRatio::Weight(weight) => Some(weight.min(total_weight)),
            WeightOrRatio::Ratio(num, denom) => {
                let share = u128::from(num).checked_mul(total_weight)? / u128::from(denom);
                Some((share + 1).min(total_weight))
            }
        }
    }
}

/// `VotePolicy` (policy.rs 125-136).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VotePolicy {
    pub weight_kind: WeightKind,
    pub quorum: u128,
    pub threshold: WeightOrRatio,
}

impl VotePolicy {
    /// The threshold line of `proposal_status` (policy.rs 415-418) for a role whose total weight
    /// is `total_weight`: the larger of the quorum and the threshold's weight.
    pub fn threshold_for(&self, total_weight: u128) -> Option<u128> {
        Some(self.quorum.max(self.threshold.to_weight(total_weight)?))
    }

    /// The JSON Sputnik writes for this vote policy, so an effect shows a rule the way
    /// `get_policy` would.
    pub fn to_json(&self) -> Value {
        let threshold = match self.threshold {
            WeightOrRatio::Weight(w) => json!(w.to_string()),
            WeightOrRatio::Ratio(n, d) => json!([n, d]),
        };
        let weight_kind = match self.weight_kind {
            WeightKind::TokenWeight => "TokenWeight",
            WeightKind::RoleWeight => "RoleWeight",
        };
        json!({ "weight_kind": weight_kind, "quorum": self.quorum.to_string(), "threshold": threshold })
    }

    pub fn from_json(v: &Value) -> Option<VotePolicy> {
        let map = object(v, &["weight_kind", "quorum", "threshold"], &[])?;
        let weight_kind = match map["weight_kind"].as_str()? {
            "TokenWeight" => WeightKind::TokenWeight,
            "RoleWeight" => WeightKind::RoleWeight,
            _ => return None,
        };
        // Untagged: Sputnik tries the weight (a string) first, then the ratio (policy.rs 90-94).
        let threshold = match &map["threshold"] {
            Value::String(_) => WeightOrRatio::Weight(u128_string(&map["threshold"])?),
            Value::Array(parts) if parts.len() == 2 => {
                let (num, denom) = (parts[0].as_u64()?, parts[1].as_u64()?);
                if denom == 0 {
                    return None;
                }
                WeightOrRatio::Ratio(num, denom)
            }
            _ => return None,
        };
        Some(VotePolicy { weight_kind, quorum: u128_string(&map["quorum"])?, threshold })
    }
}

/// `RolePermission` (policy.rs 69-79). `permissions` is a set, as in Sputnik, so two reads of
/// one role compare equal whatever order the JSON listed them in (standard 2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Role {
    pub name: String,
    pub kind: RoleKind,
    pub permissions: BTreeSet<String>,
    pub vote_policy: BTreeMap<String, VotePolicy>,
}

impl Role {
    pub fn from_json(v: &Value) -> Option<Role> {
        let map = object(v, &["name", "kind", "permissions", "vote_policy"], &[])?;
        let kind = match &map["kind"] {
            Value::String(s) if s == "Everyone" => RoleKind::Everyone,
            Value::Object(k) if k.len() == 1 => match k.iter().next()? {
                (name, Value::Null) if name == "Everyone" => RoleKind::Everyone,
                (name, balance) if name == "Member" => RoleKind::Member(u128_string(balance)?),
                (name, Value::Array(list)) if name == "Group" => RoleKind::Group(
                    list.iter().map(|m| m.as_str().map(str::to_string)).collect::<Option<_>>()?,
                ),
                _ => return None,
            },
            _ => return None,
        };
        let permissions =
            map["permissions"].as_array()?.iter().map(|p| p.as_str().map(str::to_string)).collect::<Option<_>>()?;
        let vote_policy = map["vote_policy"]
            .as_object()?
            .iter()
            .map(|(label, vp)| Some((label.clone(), VotePolicy::from_json(vp)?)))
            .collect::<Option<_>>()?;
        Some(Role { name: map["name"].as_str()?.to_string(), kind, permissions, vote_policy })
    }

    /// `RoleKind::match_user` (policy.rs 26-32). `weight` is the account's delegated token
    /// balance, which only a `Member` role reads.
    pub fn matches(&self, account: &str, weight: u128) -> bool {
        match &self.kind {
            RoleKind::Everyone => true,
            RoleKind::Member(amount) => weight >= *amount,
            RoleKind::Group(accounts) => accounts.contains(account),
        }
    }

    /// The four patterns of `can_execute_action` (policy.rs 346-353), and nothing looser: a
    /// permission string Sputnik would not match grants nothing here either.
    pub fn allows(&self, kind_label: &str, action: Action) -> bool {
        permissions_allow(&self.permissions, kind_label, action)
    }

    /// The members of a `Group`, or none for `Everyone` and `Member`, which have no list.
    pub fn members(&self) -> Option<&BTreeSet<String>> {
        match &self.kind {
            RoleKind::Group(accounts) => Some(accounts),
            _ => None,
        }
    }
}

/// True when `permissions` grant `action` on `kind_label` by one of Sputnik's four patterns.
pub fn permissions_allow(permissions: &BTreeSet<String>, kind_label: &str, action: Action) -> bool {
    let action = action.to_policy_label();
    permissions.iter().any(|p| {
        *p == format!("{kind_label}:{action}")
            || *p == format!("{kind_label}:*")
            || *p == format!("*:{action}")
            || p == "*:*"
    })
}

/// `PolicyParameters` (proposals.rs 55-60): each field left out or `null` is left unchanged.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PolicyParameters {
    pub proposal_bond: Option<u128>,
    pub proposal_period: Option<u64>,
    pub bounty_bond: Option<u128>,
    pub bounty_forgiveness_period: Option<u64>,
}

impl PolicyParameters {
    pub fn from_json(v: &Value) -> Option<PolicyParameters> {
        let names = ["proposal_bond", "proposal_period", "bounty_bond", "bounty_forgiveness_period"];
        let map = object(v, &[], &names)?;
        let get = |name: &str| map.get(name).filter(|v| !v.is_null());
        Some(PolicyParameters {
            proposal_bond: get(names[0]).map(u128_string).map_or(Some(None), |v| v.map(Some))?,
            proposal_period: get(names[1]).map(u64_string).map_or(Some(None), |v| v.map(Some))?,
            bounty_bond: get(names[2]).map(u128_string).map_or(Some(None), |v| v.map(Some))?,
            bounty_forgiveness_period: get(names[3]).map(u64_string).map_or(Some(None), |v| v.map(Some))?,
        })
    }

    pub fn is_empty(&self) -> bool {
        *self == PolicyParameters::default()
    }
}

/// `Policy` (policy.rs 153-166), as `get_policy` returns it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    pub roles: Vec<Role>,
    pub default_vote_policy: VotePolicy,
    pub proposal_bond: u128,
    pub proposal_period: u64,
    pub bounty_bond: u128,
    pub bounty_forgiveness_period: u64,
}

impl Policy {
    /// Reads a policy, or `None` when any part of it is not what Sputnik would accept. Callers
    /// treat `None` as a policy not known, never as an empty one (standard 4).
    pub fn from_json(v: &Value) -> Option<Policy> {
        let map = object(
            v,
            &["roles", "default_vote_policy", "proposal_bond", "proposal_period", "bounty_bond", "bounty_forgiveness_period"],
            &[],
        )?;
        Some(Policy {
            roles: map["roles"].as_array()?.iter().map(Role::from_json).collect::<Option<_>>()?,
            default_vote_policy: VotePolicy::from_json(&map["default_vote_policy"])?,
            proposal_bond: u128_string(&map["proposal_bond"])?,
            proposal_period: u64_string(&map["proposal_period"])?,
            bounty_bond: u128_string(&map["bounty_bond"])?,
            bounty_forgiveness_period: u64_string(&map["bounty_forgiveness_period"])?,
        })
    }

    /// `internal_get_role` (policy.rs 374-376): the first role with this name. Vote rules and
    /// group sizes are always read from it, even when a later role has the same name (C1).
    pub fn first_role(&self, name: &str) -> Option<&Role> {
        self.roles.iter().find(|r| r.name == name)
    }

    /// The vote rule `role` applies to `kind_label`: its own entry, else the default
    /// (policy.rs 399-402).
    pub fn vote_policy_for(&self, role: &Role, kind_label: &str) -> VotePolicy {
        role.vote_policy.get(kind_label).copied().unwrap_or(self.default_vote_policy)
    }

    /// `add_member_to_role` (policy.rs 292-305): only the first role of that name, and only if it
    /// is a `Group`; otherwise Sputnik writes a log line and changes nothing.
    pub fn add_member_to_role(&mut self, role: &str, member: &str) {
        if let Some(RoleKind::Group(accounts)) = self.roles.iter_mut().find(|r| r.name == role).map(|r| &mut r.kind) {
            accounts.insert(member.to_string());
        }
    }

    /// `remove_member_from_role` (policy.rs 307-320), with the same first-match rule.
    pub fn remove_member_from_role(&mut self, role: &str, member: &str) {
        if let Some(RoleKind::Group(accounts)) = self.roles.iter_mut().find(|r| r.name == role).map(|r| &mut r.kind) {
            accounts.remove(member);
        }
    }

    /// `add_or_update_role` (policy.rs 246-259): replaces the first role of that name whole,
    /// members included, or appends it.
    pub fn add_or_update_role(&mut self, role: &Role) {
        match self.roles.iter_mut().find(|r| r.name == role.name) {
            Some(existing) => *existing = role.clone(),
            None => self.roles.push(role.clone()),
        }
    }

    /// `remove_role` (policy.rs 261-269): the first role of that name, or nothing.
    pub fn remove_role(&mut self, role: &str) {
        if let Some(i) = self.roles.iter().position(|r| r.name == role) {
            self.roles.remove(i);
        }
    }

    /// `update_default_vote_policy` (policy.rs 271-274).
    pub fn update_default_vote_policy(&mut self, vote_policy: &VotePolicy) {
        self.default_vote_policy = *vote_policy;
    }

    /// `update_parameters` (policy.rs 276-290).
    pub fn update_parameters(&mut self, p: &PolicyParameters) {
        if let Some(v) = p.proposal_bond {
            self.proposal_bond = v;
        }
        if let Some(v) = p.proposal_period {
            self.proposal_period = v;
        }
        if let Some(v) = p.bounty_bond {
            self.bounty_bond = v;
        }
        if let Some(v) = p.bounty_forgiveness_period {
            self.bounty_forgiveness_period = v;
        }
    }
}

/// `can_execute_action` (policy.rs 323-359) for an account with no delegated tokens, which is
/// every account on a DAO without a staking contract. Returns the names of the roles that allow
/// the action and whether any does.
///
/// Sputnik first maps each role name the account matches to that role's permissions, a later role
/// of the same name overwriting an earlier one, so with duplicate names the permissions come from
/// the last role the account matches (C1). The names come back sorted; Sputnik's own order is a
/// hash map's.
pub fn can_execute_action(policy: &Policy, account: &str, kind_label: &str, action: Action) -> (Vec<String>, bool) {
    can_execute_action_weighted(policy, account, 0, kind_label, action)
}

/// `can_execute_action` for an account whose delegated token balance is `weight`, which decides
/// whether it matches a `Member` role.
pub fn can_execute_action_weighted(
    policy: &Policy,
    account: &str,
    weight: u128,
    kind_label: &str,
    action: Action,
) -> (Vec<String>, bool) {
    let mut user_roles: BTreeMap<&str, &BTreeSet<String>> = BTreeMap::new();
    for role in policy.roles.iter().filter(|r| r.matches(account, weight)) {
        user_roles.insert(&role.name, &role.permissions);
    }
    let allowed: Vec<String> = user_roles
        .into_iter()
        .filter(|(_, permissions)| permissions_allow(permissions, kind_label, action))
        .map(|(name, _)| name.to_string())
        .collect();
    let any = !allowed.is_empty();
    (allowed, any)
}

/// The threshold `proposal_status` sets for `role` on a proposal labelled `kind_label`
/// (policy.rs 397-418): the vote rule and the group come from the first role of that name, a
/// `Group` under RoleWeight counts heads, and a token-weighted rule or a `Member` role counts
/// tokens against `total_supply`, the DAO's total delegation. `None` for an `Everyone` role,
/// which Sputnik skips because it has no size, for a name no role has (`ERR_MISSING_ROLE`), and
/// where the token arithmetic would overflow.
pub fn threshold(policy: &Policy, role: &str, kind_label: &str, total_supply: u128) -> Option<u128> {
    let role_info = policy.first_role(role)?;
    let vote_policy = policy.vote_policy_for(role_info, kind_label);
    let total_weight = match &role_info.kind {
        RoleKind::Everyone => return None,
        RoleKind::Group(group) if vote_policy.weight_kind == WeightKind::RoleWeight => group.len() as u128,
        RoleKind::Group(_) | RoleKind::Member(_) => total_supply,
    };
    vote_policy.threshold_for(total_weight)
}

/// The votes of distinct members `role` needs to decide a proposal labelled `kind_label`, by the
/// `proposal_status` formula. This is a head count only for a `Group` role whose rule for the
/// label is RoleWeight; for every other role it is `u128::MAX`, meaning "no number of members
/// decides alone": an `Everyone` role never decides, and token weight depends on the DAO's total
/// delegation, which no policy holds (see `threshold`). Callers that need a fail-closed answer
/// for those roles handle them explicitly.
pub fn votes_needed(policy: &Policy, role: &str, kind_label: &str) -> u128 {
    let Some(role_info) = policy.first_role(role) else { return u128::MAX };
    let head_count = matches!(role_info.kind, RoleKind::Group(_))
        && policy.vote_policy_for(role_info, kind_label).weight_kind == WeightKind::RoleWeight;
    if !head_count {
        return u128::MAX;
    }
    threshold(policy, role, kind_label, 0).unwrap_or(u128::MAX)
}

/// The object `v` when it has every key in `required`, and no key outside `required` and
/// `optional` (Sputnik's `deny_unknown_fields`).
pub(crate) fn object<'a>(v: &'a Value, required: &[&str], optional: &[&str]) -> Option<&'a Map<String, Value>> {
    let map = v.as_object()?;
    let known = |k: &str| required.contains(&k) || optional.contains(&k);
    (required.iter().all(|k| map.contains_key(*k)) && map.keys().all(|k| known(k.as_str()))).then_some(map)
}

/// A near-sdk `U128` or `NearToken`: a JSON string read by `str::parse::<u128>`.
pub(crate) fn u128_string(v: &Value) -> Option<u128> {
    v.as_str()?.parse().ok()
}

/// A near-sdk `U64`: a JSON string read by `str::parse::<u64>`.
pub(crate) fn u64_string(v: &Value) -> Option<u64> {
    v.as_str()?.parse().ok()
}
