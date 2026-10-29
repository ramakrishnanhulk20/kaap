//! The shapes every Kaap component reads and writes. Field names and spellings follow
//! `docs/eval/labeling-guide.md` (v2.3) sections 3 to 6, so a label from the answer key
//! deserialises straight into `Effect`, `Finding` and `Analysis`.
//!
//! Borsh encodes an enum as its variant index and a struct as its fields in order, and
//! `Network`, `Severity`, `FindingCode`, `AiStatus` and `Verdict` are inside every signed
//! verdict (C14). Reordering, inserting or removing a variant or a field silently changes what
//! every past signature means, so these are append-only, and only together with a new
//! `Verdict::version`.

use std::collections::BTreeMap;

use borsh::{BorshDeserialize, BorshSerialize};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, BorshSerialize, BorshDeserialize,
)]
#[serde(rename_all = "lowercase")]
pub enum Network {
    Mainnet,
    Testnet,
    Sandbox,
}

/// Everything the plain-code analysis may look at. The sealed job fills it from chain reads at
/// one final block; the CLI and the evaluation runner fill it from saved records.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProposalInput {
    pub network: Network,
    pub dao: String,
    pub proposal_id: u64,
    pub description: String,
    /// The exact bytes of `get_proposal(id).kind` as the RPC returned them. They are hashed only
    /// through `canonical::canonical_kind` and forwarded to the DAO unchanged (C5).
    pub kind_json: Vec<u8>,
    /// The policy before, as guide section 7 defines it. `None` means not known, which is
    /// different from an empty policy and must never be replaced by today's policy.
    pub policy_before: Option<Value>,
    /// `None` means the history is not available (guide `history_available: false`).
    pub history: Option<History>,
    pub prices: Prices,
    pub dao_version: Option<String>,
    pub supplied_text: Option<SuppliedText>,
}

/// Payment history before this proposal (guide section 8, `context.history`).
///
/// `median_payment_usd_before` is a float on purpose. Together with the USD price in `Prices`
/// it feeds exactly one comparison, the 10x test of LARGE_AMOUNT, where a rounding error of a
/// cent cannot move a payment across a tenfold line. Amounts themselves never touch a float:
/// they stay whole base units in strings.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct History {
    pub approved_payments_before: u32,
    pub median_payment_usd_before: Option<f64>,
    pub recipients_paid_before: Vec<String>,
}

/// USD prices keyed by the exact token id as the guide writes it (`near`, `wrap.near`,
/// `nep245:<contract>:<id>`), never by symbol (C3). The tuple is (decimals, USD per whole
/// token). A token missing here has no price, which is UNKNOWN_VALUE, never zero (C2).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Prices {
    pub usd_by_token: BTreeMap<String, (u8, f64)>,
}

/// A text handed in for a `sign_request`, hashed exactly as received (C6).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SuppliedText {
    pub message: String,
    pub nonce: [u8; 32],
    pub recipient: String,
    pub standard: TextStandard,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextStandard {
    Nep413,
    Nep461,
}

/// One thing executing the proposal would do (guide section 3). Amounts are whole base units
/// as decimal strings; `"all"` stands for a call that takes everything, where the guide allows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Effect {
    Transfer {
        token: String,
        amount: String,
        to: String,
    },
    TokenCallTransfer {
        token: String,
        amount: String,
        to: String,
        msg_kind: MsgKind,
    },
    IntentsWithdraw {
        token: String,
        amount: String,
        /// `near` for a NEAR account, otherwise the census `blockchain` name. An open set, so
        /// a string rather than a list of chains that would miss the next one.
        chain: String,
        address: String,
    },
    IntentsTransfer {
        token: String,
        amount: String,
        to: String,
    },
    IntentsKeyChange {
        op: KeyOp,
        public_key: String,
    },
    Wrap {
        op: WrapOp,
        amount: String,
    },
    Staking {
        pool: String,
        op: StakingOp,
        amount: String,
    },
    StorageDeposit {
        contract: String,
        for_account: String,
        amount: String,
    },
    DefiCall {
        protocol: String,
        method: String,
        summary: String,
    },
    BulkPayment {
        contract: String,
        list_id: String,
        total: String,
    },
    SignRequest {
        mpc: String,
        path: String,
        domain_id: u64,
        payload_hash: String,
        text_supplied: bool,
        text_source: Option<TextSource>,
        text_standard: Option<TextStandard>,
    },
    /// The labels leave out empty lists and false flags, so every field defaults.
    PolicyChange {
        #[serde(default)]
        roles_added: Vec<String>,
        #[serde(default)]
        roles_removed: Vec<String>,
        #[serde(default)]
        members_added: Vec<RoleMember>,
        #[serde(default)]
        members_removed: Vec<RoleMember>,
        #[serde(default)]
        permissions_changed: Vec<PermissionChange>,
        #[serde(default)]
        vote_policy_changed: Vec<VotePolicyChange>,
        #[serde(default)]
        bond_or_period_changed: bool,
        #[serde(default)]
        before_unknown: bool,
    },
    ConfigChange {
        name: String,
        purpose_changed: ChangeFlag,
        metadata_changed: ChangeFlag,
    },
    CodeUpgrade {
        /// `self` or the receiving contract's account id.
        target: String,
        code_hash: String,
    },
    OtherKind {
        kind: String,
        summary: String,
    },
    UnknownCall {
        receiver: String,
        method: String,
        /// The decoded JSON arguments, `{}` for none, or the string `"not_json"`.
        args: Value,
        deposit: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MsgKind {
    Empty,
    IntentsDeposit,
    IntentsExecute,
    OtherJson,
    NotJson,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyOp {
    Add,
    Remove,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WrapOp {
    Wrap,
    Unwrap,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StakingOp {
    Stake,
    Unstake,
    Withdraw,
    Deposit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextSource {
    Planted,
    Description,
}

/// `approver` is true when the role can approve at least one kind (a `VoteApprove` permission
/// or a wildcard action) in the policy the member is in: after the change for an added member,
/// before it for a removed one (guide section 3, 29 Oct 2026). `policy::decode` sets it. It has
/// no default on purpose: a missing value must fail to parse, never read as "not an approver".
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoleMember {
    pub role: String,
    pub member: String,
    pub approver: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PermissionChange {
    pub role: String,
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

/// A default vote policy change uses `role: "default"`, `label: "default"`. A vote rule with no
/// entry of its own is `null` in `before` or `after` (ruling 26).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VotePolicyChange {
    pub role: String,
    pub label: String,
    pub before: Value,
    pub after: Value,
}

/// A ChangeConfig flag: `true`, `false`, or `"unknown"` when the earlier config is not in the
/// data (guide section 3). Unknown is kept distinct so it can never read as "unchanged".
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ChangeFlag {
    Changed,
    Unchanged,
    Unknown,
}

impl Serialize for ChangeFlag {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            ChangeFlag::Changed => s.serialize_bool(true),
            ChangeFlag::Unchanged => s.serialize_bool(false),
            ChangeFlag::Unknown => s.serialize_str("unknown"),
        }
    }
}

impl<'de> Deserialize<'de> for ChangeFlag {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Bool(bool),
            Text(String),
        }
        match Raw::deserialize(d)? {
            Raw::Bool(true) => Ok(ChangeFlag::Changed),
            Raw::Bool(false) => Ok(ChangeFlag::Unchanged),
            Raw::Text(t) if t == "unknown" => Ok(ChangeFlag::Unknown),
            Raw::Text(t) => Err(D::Error::custom(format!(
                "a config flag is true, false or \"unknown\", not {t:?}"
            ))),
        }
    }
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Finding {
    pub code: FindingCode,
    pub severity: Severity,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DescCheck {
    Matches,
    Contradicts,
    Vague,
    Empty,
    Hidden,
}

/// The plain-code result for one proposal, in the same field names as a label, so the
/// evaluation runner compares like with like.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Analysis {
    pub effects: Vec<Effect>,
    pub findings: Vec<Finding>,
    pub risk_floor: Severity,
    pub description_check: DescCheck,
    pub must_veto: bool,
    pub veto_allowed: bool,
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
