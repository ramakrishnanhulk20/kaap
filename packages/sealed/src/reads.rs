//! The two-provider read (C22): everything the verdict depends on is read at one final block from
//! the OutLayer host and from an independent HTTPS provider, and the job holds unless the two
//! agree.
//!
//! The host's `view` returns no block height, so the height comes from the HTTPS provider's final
//! block, and every later read on both sides is pinned to that one block. Two honest providers then
//! run the same contract code on the same state and return the same bytes; a difference is a lie or
//! a fault, never a race. The kind and the policy are compared in kaap-core's canonical form,
//! because Sputnik keeps sets and maps whose JSON order is not fixed (C5); every other proposal
//! field is compared byte for byte.
//!
//! What this does not cover: both providers lying the same way (a named non-goal), and anything
//! that changes after the block read. The verdict pins that block, the policy, the kind and every
//! called contract's code hash, so a later change is visible to whoever checks it (C4).

use std::collections::BTreeSet;
use std::fmt;

use kaap_core::receipt::{called_accounts, receivers_hash};
use kaap_core::{canonical_kind, canonical_policy, kind_hash, policy_hash};
use serde::de::{self, Deserialize, Deserializer, MapAccess, Visitor};
use serde_json::value::RawValue;

use crate::net::Deadline;
use crate::rpc::{AccountView, At, BlockView, Provider, ViewResult};

/// What the job judges, as both providers returned it at one block.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChainRead {
    pub block: BlockView,
    pub proposal: Proposal,
    /// The policy exactly as the HTTPS provider returned it.
    pub policy_json: Vec<u8>,
    pub kind_hash: [u8; 32],
    pub policy_hash: [u8; 32],
    /// (account, code hash) for the DAO and every contract the kind calls, sorted by account.
    pub code_hashes: Vec<(String, String)>,
    pub receivers_hash: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Proposal {
    pub id: u64,
    pub description: String,
    /// The exact bytes of the `kind` field as returned, never re-encoded (C5).
    pub kind_json: Vec<u8>,
    /// Sputnik's status word, or empty when the proposal carries none.
    pub status: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Item {
    Block,
    Proposal,
    Policy,
    CodeHash,
}

/// Why the job holds instead of judging. No verdict and no signature follow any of these.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Held {
    HttpsFailed(Item),
    HostFailed(Item),
    Disagree(Item),
    WrongBlock,
    NotTheProposal,
    NotAProposal,
    KindUnhashable,
    PolicyUnhashable,
    BadReceiver,
    Deadline,
}

impl Held {
    pub fn reason(self) -> &'static str {
        use Held::*;
        use Item::*;
        match self {
            HttpsFailed(Block) => "https read failed: block",
            HttpsFailed(Proposal) => "https read failed: get_proposal",
            HttpsFailed(Policy) => "https read failed: get_policy",
            HttpsFailed(CodeHash) => "https read failed: view_account",
            HostFailed(Block) => "host read failed: block",
            HostFailed(Proposal) => "host read failed: get_proposal",
            HostFailed(Policy) => "host read failed: get_policy",
            HostFailed(CodeHash) => "host read failed: view_account",
            Disagree(Block) => "providers disagree: block",
            Disagree(Proposal) => "providers disagree: get_proposal",
            Disagree(Policy) => "providers disagree: get_policy",
            Disagree(CodeHash) => "providers disagree: code hash",
            WrongBlock => "a read is not at the block asked for",
            NotTheProposal => "the DAO returned another proposal id",
            NotAProposal => "the DAO's answer is not a proposal object",
            KindUnhashable => "the proposal kind cannot be canonicalised",
            PolicyUnhashable => "the policy cannot be canonicalised",
            BadReceiver => "the kind names an invalid account id",
            Deadline => "the reads ran past their deadline",
        }
    }
}

/// How long to wait before asking the host once more for the block, in case its node is a block
/// or two behind the HTTPS provider's final head.
pub const HOST_CATCH_UP_MS: u64 = 1_000;

/// Reads proposal `proposal_id` of `dao` and everything its verdict depends on, from both
/// providers at one final block, and holds unless they agree.
///
/// Order: HTTPS `block` at final finality gives the block; HTTPS `get_proposal`, `get_policy` and
/// `view_account` for the DAO and each called contract follow at that block; then the same reads
/// on the host at that block. Holds on any failed read, any HTTPS answer not at that block, a
/// proposal whose `id` is not `proposal_id`, a kind or policy kaap-core cannot canonicalise (the
/// verdict could not pin it), an invalid account id in the kind, the deadline passing between two
/// reads, and any disagreement.
pub fn read_chain(
    host: &mut dyn Provider,
    https: &mut dyn Provider,
    dao: &str,
    proposal_id: u64,
    deadline: Deadline,
    host_catch_up_ms: u64,
) -> Result<ChainRead, Held> {
    use Item::*;
    let proposal_args = format!("{{\"id\":{proposal_id}}}");
    let on_time = || if deadline.passed() { Err(Held::Deadline) } else { Ok(()) };

    on_time()?;
    let head = https.block(At::Final).map_err(|_| Held::HttpsFailed(Block))?;
    let at = At::Height(head.height);
    on_time()?;
    let proposal_https = https
        .call_function(dao, "get_proposal", &proposal_args, at)
        .map_err(|_| Held::HttpsFailed(Proposal))?;
    pinned(&proposal_https, &head)?;
    on_time()?;
    let policy_https = https.call_function(dao, "get_policy", "{}", at).map_err(|_| Held::HttpsFailed(Policy))?;
    pinned(&policy_https, &head)?;

    let proposal = parse_proposal(&proposal_https.bytes)?;
    if proposal.id != proposal_id {
        return Err(Held::NotTheProposal);
    }
    let kind_hash = kind_hash(&proposal.kind_json).map_err(|_| Held::KindUnhashable)?;
    let policy_canonical = canonical_policy(&policy_https.bytes).map_err(|_| Held::PolicyUnhashable)?;
    let policy_hash = policy_hash(&policy_https.bytes).map_err(|_| Held::PolicyUnhashable)?;

    let accounts = called_accounts(dao, &proposal.kind_json).ok_or(Held::BadReceiver)?;
    let mut code_hashes = Vec::with_capacity(accounts.len());
    for account in &accounts {
        on_time()?;
        let view = https.view_account(account, at).map_err(|_| Held::HttpsFailed(CodeHash))?;
        if view.block_height != head.height || view.block_hash != head.hash {
            return Err(Held::WrongBlock);
        }
        code_hashes.push((account.clone(), view.code_hash));
    }

    on_time()?;
    let host_head = match host.block(at) {
        Ok(block) => block,
        Err(_) => {
            std::thread::sleep(std::time::Duration::from_millis(host_catch_up_ms.min(deadline.remaining_ms())));
            on_time()?;
            host.block(at).map_err(|_| Held::HostFailed(Block))?
        }
    };
    if host_head != head {
        return Err(Held::Disagree(Block));
    }
    on_time()?;
    let proposal_host = host
        .call_function(dao, "get_proposal", &proposal_args, at)
        .map_err(|_| Held::HostFailed(Proposal))?;
    if !same_proposal(&proposal_host.bytes, &proposal_https.bytes) {
        return Err(Held::Disagree(Proposal));
    }
    on_time()?;
    let policy_host = host.call_function(dao, "get_policy", "{}", at).map_err(|_| Held::HostFailed(Policy))?;
    if canonical_policy(&policy_host.bytes).ok().as_deref() != Some(policy_canonical.as_slice()) {
        return Err(Held::Disagree(Policy));
    }
    for (account, code_hash) in &code_hashes {
        on_time()?;
        let view: AccountView = host.view_account(account, at).map_err(|_| Held::HostFailed(CodeHash))?;
        if view.code_hash != *code_hash || view.block_height != head.height || view.block_hash != head.hash {
            return Err(Held::Disagree(CodeHash));
        }
    }

    code_hashes.sort();
    let receivers_hash = receivers_hash(&code_hashes);
    Ok(ChainRead {
        block: head,
        proposal,
        policy_json: policy_https.bytes,
        kind_hash,
        policy_hash,
        code_hashes,
        receivers_hash,
    })
}

fn pinned(view: &ViewResult, head: &BlockView) -> Result<(), Held> {
    if view.block_height == Some(head.height) && view.block_hash.as_deref() == Some(head.hash.as_str()) {
        Ok(())
    } else {
        Err(Held::WrongBlock)
    }
}

/// Reads the four fields the job uses from a `get_proposal` answer. The answer must be one JSON
/// object with no duplicate keys, an `id` that is a whole number, a string `description` and a
/// `kind`; `status` is optional.
pub fn parse_proposal(bytes: &[u8]) -> Result<Proposal, Held> {
    let fields = top_level(bytes).ok_or(Held::NotAProposal)?;
    let raw = |key: &str| fields.0.iter().find(|(k, _)| k == key).map(|(_, v)| v.get());
    let id = raw("id").and_then(|v| serde_json::from_str::<u64>(v).ok()).ok_or(Held::NotAProposal)?;
    let description = raw("description")
        .and_then(|v| serde_json::from_str::<String>(v).ok())
        .ok_or(Held::NotAProposal)?;
    let kind_json = raw("kind").ok_or(Held::NotAProposal)?.as_bytes().to_vec();
    let status = raw("status").and_then(|v| serde_json::from_str::<String>(v).ok()).unwrap_or_default();
    Ok(Proposal { id, description, kind_json, status })
}

/// True when two `get_proposal` answers hold the same fields: the kind equal in canonical form,
/// every other field equal byte for byte.
pub fn same_proposal(a: &[u8], b: &[u8]) -> bool {
    let (Some(a), Some(b)) = (top_level(a), top_level(b)) else {
        return false;
    };
    a.0.len() == b.0.len()
        && a.0.iter().all(|(key, value)| {
            let Some((_, other)) = b.0.iter().find(|(k, _)| k == key) else {
                return false;
            };
            if key == "kind" {
                match (canonical_kind(value.get().as_bytes()), canonical_kind(other.get().as_bytes())) {
                    (Ok(x), Ok(y)) => x == y,
                    _ => value.get() == other.get(),
                }
            } else {
                value.get() == other.get()
            }
        })
}

/// A Sputnik proposal has about ten top-level fields. The cap keeps a fake DAO's answer with
/// thousands of keys from costing more than a real one to compare.
const MAX_PROPOSAL_FIELDS: usize = 32;

/// A JSON object's top-level fields with each value's exact text. Duplicate keys are refused, so
/// two readers can never take one answer two ways (standard 2).
struct Fields(Vec<(String, Box<RawValue>)>);

fn top_level(bytes: &[u8]) -> Option<Fields> {
    serde_json::from_slice(bytes).ok()
}

impl<'de> Deserialize<'de> for Fields {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct FieldsVisitor;
        impl<'de> Visitor<'de> for FieldsVisitor {
            type Value = Fields;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a JSON object with unique keys")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Fields, A::Error> {
                let mut seen = BTreeSet::new();
                let mut fields = Vec::new();
                while let Some(key) = map.next_key::<String>()? {
                    if !seen.insert(key.clone()) {
                        return Err(de::Error::custom("duplicate key"));
                    }
                    if fields.len() == MAX_PROPOSAL_FIELDS {
                        return Err(de::Error::custom("too many fields"));
                    }
                    fields.push((key, map.next_value::<Box<RawValue>>()?));
                }
                Ok(Fields(fields))
            }
        }
        d.deserialize_map(FieldsVisitor)
    }
}
