//! kaap-core: the plain code that decides what a Sputnik DAO proposal means. The labelling
//! guide (`docs/eval/labeling-guide.md`, v2.3) is its specification.
//!
//! Who decodes what: FunctionCall actions to `v1.signer` method `sign` belong to `hash`, the
//! policy kinds to `policy`, and every other kind to `decode::value`. Each kind has exactly one
//! owner, so no effect is counted twice and none falls between two modules.

pub mod canonical;
pub mod decode;
pub mod describe;
pub mod floor;
pub mod hash;
pub mod policy;
pub mod severity;
pub mod types;
pub mod verdict;

pub use canonical::{canonical_kind, canonical_policy, kind_hash, policy_hash, CanonError};
pub use types::*;
pub use verdict::{verdict_bytes, verdict_hash};

/// Runs every plain-code check on one proposal: `decode::value`, `policy::decode` and
/// `hash::check`, whose effects and codes are joined in that order, then `describe::check` over
/// all of those effects, then `floor::finish`. Pure: same input, same `Analysis`, on every host.
pub fn analyze(input: &ProposalInput) -> Analysis {
    let (mut effects, mut codes) = decode::value::decode(input);
    for (more_effects, more_codes) in [policy::decode(input), hash::check(input)] {
        effects.extend(more_effects);
        codes.extend(more_codes);
    }
    let (desc, desc_codes) = describe::check(input, &effects);
    codes.extend(desc_codes);
    floor::finish(effects, codes, desc, kind_label(&input.kind_json))
}

/// Sputnik's `to_policy_label` (sputnikdao2/src/proposals.rs 125-147, main as read on 20 Oct
/// 2026), keyed by the kind's serde variant name.
const KIND_LABELS: [(&str, &str); 17] = [
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

/// The policy label of a kind as `get_proposal` returns it: a one-key object, or the bare
/// string `"Vote"`. Anything else is `""`, which Sputnik could never have stored.
fn kind_label(kind_json: &[u8]) -> &'static str {
    let variant = match serde_json::from_slice::<serde_json::Value>(kind_json) {
        Ok(serde_json::Value::String(s)) => s,
        Ok(serde_json::Value::Object(map)) if map.len() == 1 => {
            map.into_iter().next().map(|(k, _)| k).unwrap_or_default()
        }
        _ => return "",
    };
    KIND_LABELS
        .iter()
        .find(|(name, _)| *name == variant)
        .map(|(_, label)| *label)
        .unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_match_sputnik() {
        assert_eq!(kind_label(br#"{"RemoveMemberFromRole":{"member_id":"a.near","role":"Guard"}}"#), "remove_member_from_role");
        assert_eq!(kind_label(br#"{"SetStakingContract":{"staking_id":"s.near"}}"#), "set_vote_token");
        assert_eq!(kind_label(br#""Vote""#), "vote");
        assert_eq!(kind_label(b"not json"), "");
        assert_eq!(kind_label(br#"{"Transfer":{},"Vote":{}}"#), "");
    }
}
