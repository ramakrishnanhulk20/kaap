//! The types inside every signed verdict. Field names and spellings follow
//! `docs/eval/labeling-guide.md` (v2.3) sections 4 to 6.
//!
//! Borsh encodes an enum as its variant index and a struct as its fields in order, and
//! `Network`, `Severity`, `FindingCode`, `AiStatus` and `Verdict` are inside every signed
//! verdict (C14). Reordering, inserting or removing a variant or a field silently changes what
//! every past signature means, so these are append-only, and only together with a new
//! `Verdict::version`.

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, BorshSerialize, BorshDeserialize,
)]
#[serde(rename_all = "lowercase")]
pub enum Network {
    Mainnet,
    Testnet,
    Sandbox,
}

/// The 24 plain-code checks of guide section 4, in the table's order.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Hash,
    PartialOrd,
    Ord,
    Serialize,
    Deserialize,
    BorshSerialize,
    BorshDeserialize,
)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FindingCode {
    HashMismatch,
    HashTextDangerous,
    PolicyDuplicateRoleNames,
    PromptInjection,
    DescContradicts,
    PolicyAddsApprover,
    PolicyLowersThreshold,
    PolicyReplacesRole,
    PolicyRemovesMember,
    PolicyBeforeUnknown,
    CodeUpgrade,
    IntentsKeyChange,
    GuardWeakened,
    UnknownCall,
    ArgsNotJson,
    UnknownValue,
    LookalikeToken,
    OtherRiskyKind,
    HashUnverified,
    AttachedDeposit,
    CrossChainOut,
    NewRecipient,
    LargeAmount,
    EmptyDescription,
}

impl FindingCode {
    pub const ALL: [FindingCode; 24] = [
        FindingCode::HashMismatch,
        FindingCode::HashTextDangerous,
        FindingCode::PolicyDuplicateRoleNames,
        FindingCode::PromptInjection,
        FindingCode::DescContradicts,
        FindingCode::PolicyAddsApprover,
        FindingCode::PolicyLowersThreshold,
        FindingCode::PolicyReplacesRole,
        FindingCode::PolicyRemovesMember,
        FindingCode::PolicyBeforeUnknown,
        FindingCode::CodeUpgrade,
        FindingCode::IntentsKeyChange,
        FindingCode::GuardWeakened,
        FindingCode::UnknownCall,
        FindingCode::ArgsNotJson,
        FindingCode::UnknownValue,
        FindingCode::LookalikeToken,
        FindingCode::OtherRiskyKind,
        FindingCode::HashUnverified,
        FindingCode::AttachedDeposit,
        FindingCode::CrossChainOut,
        FindingCode::NewRecipient,
        FindingCode::LargeAmount,
        FindingCode::EmptyDescription,
    ];
}

/// `Unknown` is shown as UNKNOWN but counts as `High` for the risk floor (guide section 1).
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, BorshSerialize, BorshDeserialize,
)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Low,
    Medium,
    High,
    Critical,
    Unknown,
}

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, BorshSerialize, BorshDeserialize,
)]
#[serde(rename_all = "lowercase")]
pub enum AiStatus {
    Verified,
    Unverified,
    Unavailable,
}

/// The one thing the sealed job signs and the guard checks. Its bytes come only from
/// `verdict::verdict_bytes` (C14); field order is part of that encoding.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct Verdict {
    /// 1 for this layout.
    pub version: u8,
    pub guard: String,
    pub network: Network,
    pub dao: String,
    pub proposal_id: u64,
    /// sha256 of `canonical::canonical_kind(kind_json)` (C5).
    pub kind_hash: [u8; 32],
    /// sha256 of `canonical::canonical_policy` of the policy the verdict was computed on (C4).
    pub policy_hash: [u8; 32],
    /// sha256 of the sorted (receiver account, code hash) pairs of every contract the kind
    /// calls, so a receiver redeploy invalidates the verdict (C4).
    pub receivers_hash: [u8; 32],
    pub block_height: u64,
    pub risk: Severity,
    pub floor: Severity,
    pub findings: Vec<FindingCode>,
    pub decoder_version: String,
    pub model_id: String,
    pub ai_status: AiStatus,
    pub explanation_hash: [u8; 32],
    pub expires_at_ms: u64,
}
