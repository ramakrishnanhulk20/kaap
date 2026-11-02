//! kaap-core: the plain code that decides what a Sputnik DAO proposal means. The labelling
//! guide (`docs/eval/labeling-guide.md`, v2.3) is its specification.
//!
//! Who decodes what: FunctionCall actions to `v1.signer` method `sign` belong to `hash`, the
//! policy kinds to `policy`, and every other kind to `decode::value`. Each kind has exactly one
//! owner, so no effect is counted twice and none falls between two modules.

pub mod decode;
pub mod describe;
pub mod floor;
pub mod hash;
pub mod policy;
pub mod receipt;
pub mod severity;
pub mod types;

pub use kaap_verdict::{canonical, verdict};

pub use canonical::{canonical_kind, canonical_policy, kind_hash, policy_hash, CanonError};
pub use types::*;
pub use verdict::{verdict_bytes, verdict_hash};

/// Kaap's enrolment template (C30): the two proposals a DAO files to arm Kaap's guard. The first
/// adds the role `role` returns; the second calls the guard's `METHOD` with no arguments,
/// `DEPOSIT_YOCTO` and `GAS`. core-wasm builds its drafts from these items and `analyze` reads
/// Kaap's own enrolment back from them, so what Kaap asks a DAO to file and how Kaap reads it can
/// never drift apart.
pub mod enrolment {
    use serde_json::{json, Map, Value};

    use crate::policy::sputnik::LABELS;
    use crate::policy::GUARD_ROLE;

    /// The one kind the guard leaves alone, so a DAO can always remove Kaap with an ordinary
    /// proposal (threat model C15, C17).
    pub const OWN_REMOVAL: &str = "remove_member_from_role";

    /// The guard's own entry point (packages/contracts/guard `enroll`).
    pub const METHOD: &str = "enroll";

    /// 0.01 NEAR, which always covers the guard's storage for the DAO's entry: the guard keeps what
    /// the entry takes, about 0.0024 NEAR for a 64-character id, and refunds the rest
    /// (packages/contracts/GAS.md). It is also the most an `enroll` call may attach and still read
    /// as enrolment.
    pub const DEPOSIT_YOCTO: u128 = 10_000_000_000_000_000_000_000;

    /// 10 Tgas, of which `enroll` burns 1.88 (packages/contracts/GAS.md).
    pub const GAS: u64 = 10_000_000_000_000;

    /// Every Sputnik label but `OWN_REMOVAL`, in `LABELS` order.
    pub fn labels() -> Vec<&'static str> {
        LABELS.iter().copied().filter(|label| *label != OWN_REMOVAL).collect()
    }

    /// The role as the DAO files it: named `GUARD_ROLE`, `guard` its only member, VoteReject on
    /// each of `labels`, and on each of those a rule of its own that one vote decides (RoleWeight,
    /// quorum 0, threshold 1), so no default vote policy can change it. The role is created with
    /// its member in the same proposal, so the policy never holds it in any other shape.
    pub fn role(guard: &str) -> Value {
        let labels = labels();
        let rule = json!({ "weight_kind": "RoleWeight", "quorum": "0", "threshold": "1" });
        json!({
            "name": GUARD_ROLE,
            "kind": { "Group": [guard] },
            "permissions": labels.iter().map(|label| format!("{label}:VoteReject")).collect::<Vec<_>>(),
            "vote_policy": labels.iter().map(|label| (label.to_string(), rule.clone())).collect::<Map<_, _>>(),
        })
    }
}

/// Runs every plain-code check on one proposal: `decode::value`, `policy::decode` and
/// `hash::check`, whose effects and codes are joined in that order, then `describe::check` over
/// all of those effects, then `floor::finish`. When none of the three returns anything for the
/// kind, `fallback_code` adds one high finding first, so no kind ever comes out empty and low
/// (C2). Pure: same input, same `Analysis`, on every host; malformed `kind_json` gives a high
/// finding, never a panic (standard 4).
pub fn analyze(input: &ProposalInput) -> Analysis {
    let (mut effects, mut codes) = decode::value::decode(input);
    for (more_effects, more_codes) in [policy::decode(input), hash::check(input)] {
        effects.extend(more_effects);
        codes.extend(more_codes);
    }
    let label = policy::sputnik::to_policy_label(&input.kind_json);
    if effects.is_empty() && codes.is_empty() {
        codes.push(fallback_code(input, label));
    }
    let (desc, desc_codes) = describe::check(input, &effects);
    codes.extend(desc_codes);
    floor::finish(effects, codes, desc, label)
}

/// The labels of Sputnik's seven policy kinds, whose effect depends on the policy before.
const POLICY_KIND_LABELS: [&str; 7] = [
    "policy",
    "add_member_to_role",
    "remove_member_from_role",
    "policy_add_or_update_role",
    "policy_remove_role",
    "policy_update_default_vote_policy",
    "policy_update_parameters",
];

/// The high finding for a kind no module returned anything for. A FunctionCall, a kind that is
/// not one of Sputnik's 17, and bytes the strict reader of `decode::value::read_kind` refuses are
/// UNKNOWN_CALL. A policy kind with no policy before is POLICY_BEFORE_UNKNOWN. Any other Sputnik
/// kind, which today means a governance or policy kind whose decoder has not landed, is
/// OTHER_RISKY_KIND.
fn fallback_code(input: &ProposalInput, label: &str) -> FindingCode {
    if label.is_empty() || label == "call" || decode::value::read_kind(&input.kind_json).is_none() {
        FindingCode::UnknownCall
    } else if POLICY_KIND_LABELS.contains(&label) && input.policy_before.is_none() {
        FindingCode::PolicyBeforeUnknown
    } else {
        FindingCode::OtherRiskyKind
    }
}
