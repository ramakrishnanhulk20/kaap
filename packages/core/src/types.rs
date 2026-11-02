//! The shapes every Kaap component reads and writes. Field names and spellings follow
//! `docs/eval/labeling-guide.md` (v2.3) sections 3 to 6, so a label from the answer key
//! deserialises straight into `Effect`, `Finding` and `Analysis`.
//!
//! The types inside a signed verdict live in kaap-verdict, which the contracts build from, and
//! are re-exported here, so work on these analysis types never changes the contracts' wasm.

use std::collections::BTreeMap;

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

pub use kaap_verdict::types::{AiStatus, FindingCode, Network, Severity, Verdict};

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
    /// The guard account enrolled for this DAO. When set, GUARD_WEAKENED follows what a policy
    /// change does to this account's own reject, whatever the roles holding it are called. `None`
    /// means not known: GUARD_WEAKENED then keys on the role named `guard`, so a guard role under
    /// another name is missed. It does not say whether the account is really Kaap's guard; the
    /// caller vouches for that.
    #[serde(default)]
    pub guard_account: Option<String>,
    /// The DAO's `get_config` before this proposal. When it reads as Sputnik's config (`name`,
    /// `purpose` and base64 `metadata`, nothing else), a ChangeConfig's two flags compare against
    /// it field by field. `None`, or a value that does not read that way, means not known, and the
    /// flags stay `"unknown"` (guide ruling 21). It is not checked against the chain, and nothing
    /// but the ChangeConfig flags reads it.
    #[serde(default)]
    pub config_before: Option<Value>,
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
