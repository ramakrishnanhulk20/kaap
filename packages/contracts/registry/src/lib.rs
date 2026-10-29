//! kaap-registry: the public, append-only record of Kaap verdicts.
//!
//! Anyone may record a verdict and pays for the storage it takes. The registry trusts the sealed
//! program's key, fixed at init, rather than a publisher account: a verdict is stored only when
//! that key signed it, so whoever submits it, the record says exactly what the sealed program
//! said. A new key means a new registry, on purpose: the code is immutable, with no upgrade
//! method and no full-access key left on the account after deploy.
//!
//! Records are never changed or removed. A newer verdict for the same (network, DAO, proposal)
//! is stored next to the earlier ones and points back to the one it supersedes (C13). A verdict
//! holds only hashes, ids, levels and codes, never a confidential text or an explanation of one.

use kaap_core::verdict::VERDICT_VERSION;
use kaap_core::{verdict_bytes, verdict_hash, Verdict};
use near_sdk::borsh::BorshDeserialize;
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde::Serialize;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, near, require, AccountId, CurveType, PanicOnDefault, Promise, PublicKey};

pub const ERR_BAD_KEY: &str = "ERR_BAD_KEY";
pub const ERR_BAD_NETWORK: &str = "ERR_BAD_NETWORK";
pub const ERR_TOO_LARGE: &str = "ERR_TOO_LARGE";
pub const ERR_BAD_VERDICT: &str = "ERR_BAD_VERDICT";
pub const ERR_BAD_SIGNATURE: &str = "ERR_BAD_SIGNATURE";
pub const ERR_WRONG_NETWORK: &str = "ERR_WRONG_NETWORK";
pub const ERR_DUPLICATE: &str = "ERR_DUPLICATE";
pub const ERR_NOT_ENOUGH_DEPOSIT: &str = "ERR_NOT_ENOUGH_DEPOSIT";

/// The largest verdict accepted, in borsh bytes. A verdict's fixed fields take about 300 bytes,
/// and the sealed job's whole output, verdict and signature together, is capped at 900 bytes
/// (DECISIONS.md, 26 Oct 2026), so anything bigger cannot have come from it. The cap also bounds
/// what one `history` page can return.
pub const MAX_VERDICT_BYTES: usize = 1024;

/// The most records one `history` page returns. Measured as a transaction: 1.47 Tgas for one
/// record and 3.33 Tgas for ten, about 0.21 Tgas each, so a full page of 50 is about 12 Tgas,
/// well inside the gas an RPC view may burn, and under 100 KB of JSON.
pub const MAX_HISTORY_PAGE: u64 = 50;

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct ProposalKey {
    /// Written only by `network_name`, so a stored key and a key built from a view's argument
    /// always come out of the same serializer.
    network: String,
    dao: AccountId,
    proposal_id: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct EntryKey {
    proposal: ProposalKey,
    index: u32,
}

/// Per proposal: how many verdicts are recorded and which one is the latest. Kept up to date by
/// `record`, so `latest` is one read however long the history grows.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ProposalHead {
    count: u32,
    latest: u32,
    latest_block_height: u64,
}

#[near(serializers = [borsh])]
struct StoredVerdict {
    /// The borsh bytes exactly as signed, without the domain prefix.
    verdict: Vec<u8>,
    signature: Vec<u8>,
    /// The record that was latest when this one arrived and that this one replaced as latest.
    supersedes: Option<u32>,
    recorded_by: AccountId,
    recorded_at_block: u64,
    recorded_at_ms: u64,
}

/// One recorded verdict as the views return it: the signed bytes, so anyone can check the
/// signature themselves, and the fields a reader needs most, decoded with kaap-core's spelling.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerdictRecord {
    /// Position in this proposal's history, 0 for the first verdict recorded.
    pub index: u32,
    /// The index of the record that was latest when this one arrived and that this one replaced
    /// as latest. None for the first record, and for a record whose verdict was read at an older
    /// block than the latest one, which is kept in the history but never becomes latest.
    pub supersedes: Option<u32>,
    /// `kaap_core::verdict_hash`, hex.
    pub verdict_hash: String,
    /// borsh of `kaap_core::Verdict` without the domain prefix, exactly as signed.
    pub verdict: Base64VecU8,
    pub signature: Base64VecU8,
    pub guard: String,
    pub risk: String,
    pub floor: String,
    pub findings: Vec<String>,
    pub ai_status: String,
    pub model_id: String,
    pub decoder_version: String,
    /// The block the sealed job read the proposal at.
    pub block_height: u64,
    pub expires_at_ms: u64,
    pub recorded_by: AccountId,
    pub recorded_at_block: u64,
    pub recorded_at_ms: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct RecordedEntry {
    pub network: String,
    pub dao: AccountId,
    pub proposal_id: u64,
    pub index: u32,
    pub verdict_hash: String,
    pub risk: String,
    /// What the caller paid for the storage this record took, in yoctoNEAR.
    pub storage_cost: U128,
    /// What was sent back to the caller from the deposit, in yoctoNEAR.
    pub refund: U128,
}

/// NEP-297 events, logged as `EVENT_JSON:{"standard":"kaap-registry","version":"1.0.0",...}`.
#[near(event_json(standard = "kaap-registry"))]
pub enum RegistryEvent {
    #[event_version("1.0.0")]
    VerdictRecorded(Vec<RecordedEntry>),
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct KaapRegistry {
    accepted_key: PublicKey,
    /// kaap-core's spelling of the network, as in kaap-guard.
    network: String,
    heads: LookupMap<ProposalKey, ProposalHead>,
    entries: LookupMap<EntryKey, StoredVerdict>,
    /// Hashes of every verdict recorded, so the same verdict cannot be recorded twice and pushed
    /// back to the top of a history it has already left.
    seen: LookupSet<[u8; 32]>,
}

/// Parses "ed25519:<base58 of 32 bytes>" and refuses every other spelling, as kaap-guard does.
fn parse_accepted_key(key: &str) -> PublicKey {
    let parsed: PublicKey = key.parse().unwrap_or_else(|_| env::panic_str(ERR_BAD_KEY));
    require!(
        parsed.curve_type() == CurveType::ED25519 && parsed.to_string() == key,
        ERR_BAD_KEY
    );
    parsed
}

/// A kaap-core enum's serde name ("critical", "testnet", "DESC_CONTRADICTS"), so every string the
/// registry writes or compares is spelled the way kaap-core spells it.
fn name_of<T: Serialize>(value: T) -> String {
    match near_sdk::serde_json::to_value(value) {
        Ok(near_sdk::serde_json::Value::String(name)) => name,
        _ => env::abort(),
    }
}

fn parse_network(name: &str) -> String {
    let network: kaap_core::Network = near_sdk::serde_json::from_value(
        near_sdk::serde_json::Value::String(name.to_owned()),
    )
    .unwrap_or_else(|_| env::panic_str(ERR_BAD_NETWORK));
    name_of(network)
}

#[near]
impl KaapRegistry {
    /// Fixes the key whose signatures this registry accepts, and the network it records for.
    /// Neither can change later; a new key means a new registry.
    ///
    /// Only the contract account itself may call this, batched with the deploy. Panics with
    /// ERR_BAD_KEY unless `accepted_key` is exactly "ed25519:<base58 of 32 bytes>", and with
    /// ERR_BAD_NETWORK unless `network` is "mainnet", "testnet" or "sandbox".
    #[init]
    #[private]
    pub fn new(accepted_key: String, network: String) -> Self {
        Self {
            accepted_key: parse_accepted_key(&accepted_key),
            network: parse_network(&network),
            heads: LookupMap::new(b"c"),
            entries: LookupMap::new(b"r"),
            seen: LookupSet::new(b"s"),
        }
    }

    /// Records a verdict signed by the accepted key. Anyone may call it; the caller attaches the
    /// storage cost and gets the rest back in the same transaction. The largest verdict allowed
    /// takes about 1,520 bytes with its index entries, so 0.02 NEAR is always enough.
    ///
    /// `verdict` is the borsh encoding of `kaap_core::Verdict` without the domain prefix, and
    /// `signature` the 64-byte ed25519 signature over `kaap_core::verdict_bytes`, exactly as
    /// kaap-guard's `veto` takes them.
    ///
    /// Panics with ERR_TOO_LARGE above `MAX_VERDICT_BYTES`, ERR_BAD_VERDICT unless the bytes
    /// decode to a version 1 verdict with a valid DAO account id, ERR_BAD_SIGNATURE unless the
    /// accepted key signed it, ERR_WRONG_NETWORK unless it names this registry's network,
    /// ERR_DUPLICATE if this exact verdict is already recorded, and ERR_NOT_ENOUGH_DEPOSIT if
    /// the deposit does not cover the storage. Emits `verdict_recorded`. Returns the record's
    /// index in its proposal's history.
    #[payable]
    pub fn record(&mut self, verdict: Base64VecU8, signature: Base64VecU8) -> u32 {
        require!(verdict.0.len() <= MAX_VERDICT_BYTES, ERR_TOO_LARGE);
        let decoded = Verdict::try_from_slice(&verdict.0)
            .unwrap_or_else(|_| env::panic_str(ERR_BAD_VERDICT));
        require!(decoded.version == VERDICT_VERSION, ERR_BAD_VERDICT);

        let signature: [u8; 64] = signature
            .0
            .as_slice()
            .try_into()
            .unwrap_or_else(|_| env::panic_str(ERR_BAD_SIGNATURE));
        require!(
            env::ed25519_verify(&signature, verdict_bytes(&decoded), &self.key_bytes()),
            ERR_BAD_SIGNATURE
        );

        let network = name_of(decoded.network);
        require!(network == self.network, ERR_WRONG_NETWORK);
        let dao: AccountId = decoded
            .dao
            .parse()
            .unwrap_or_else(|_| env::panic_str(ERR_BAD_VERDICT));
        let hash = verdict_hash(&decoded);
        require!(!self.seen.contains(&hash), ERR_DUPLICATE);

        let before = env::storage_usage();
        let proposal = ProposalKey {
            network: network.clone(),
            dao: dao.clone(),
            proposal_id: decoded.proposal_id,
        };
        // The latest verdict is the one read at the highest block, ties going to the later
        // record, so recording an older verdict after a newer one never moves `latest` back.
        let head = self.heads.get(&proposal).copied();
        let index = head.map_or(0, |h| h.count);
        let becomes_latest = head.is_none_or(|h| decoded.block_height >= h.latest_block_height);
        let next_head = match head {
            Some(h) if !becomes_latest => ProposalHead { count: index + 1, ..h },
            _ => ProposalHead {
                count: index + 1,
                latest: index,
                latest_block_height: decoded.block_height,
            },
        };
        self.entries.insert(
            EntryKey {
                proposal: proposal.clone(),
                index,
            },
            StoredVerdict {
                verdict: verdict.0,
                signature: signature.to_vec(),
                supersedes: head.filter(|_| becomes_latest).map(|h| h.latest),
                recorded_by: env::predecessor_account_id(),
                recorded_at_block: env::block_height(),
                recorded_at_ms: env::block_timestamp_ms(),
            },
        );
        self.heads.insert(proposal, next_head);
        self.seen.insert(hash);
        // The two maps only write to storage when flushed (the set writes at once), and the
        // cost must be measured on what was really written.
        self.entries.flush();
        self.heads.flush();
        let used = env::storage_usage().saturating_sub(before);
        let cost = env::storage_byte_cost().saturating_mul(u128::from(used));
        let attached = env::attached_deposit();
        require!(attached >= cost, ERR_NOT_ENOUGH_DEPOSIT);
        let refund = attached.saturating_sub(cost);

        RegistryEvent::VerdictRecorded(vec![RecordedEntry {
            network,
            dao,
            proposal_id: decoded.proposal_id,
            index,
            verdict_hash: hex::encode(hash),
            risk: name_of(decoded.risk),
            storage_cost: U128(cost.as_yoctonear()),
            refund: U128(refund.as_yoctonear()),
        }])
        .emit();
        // Every write is done before the refund leaves, and the refund is a plain transfer with
        // no callback, so nothing can re-enter this call.
        if !refund.is_zero() {
            Promise::new(env::predecessor_account_id())
                .transfer(refund)
                .detach();
        }
        index
    }

    /// The verdict recorded for this proposal that was read at the highest block, the later
    /// record winning a tie, or None. A verdict read at an older block and recorded afterwards
    /// stays in `history` but never becomes latest (C13).
    ///
    /// Panics with ERR_BAD_NETWORK unless `network` is "mainnet", "testnet" or "sandbox".
    pub fn latest(&self, network: String, dao: AccountId, proposal_id: u64) -> Option<VerdictRecord> {
        let proposal = ProposalKey {
            network: parse_network(&network),
            dao,
            proposal_id,
        };
        let head = *self.heads.get(&proposal)?;
        self.record_at(&proposal, head.latest)
    }

    /// Up to `limit` verdicts recorded for this proposal, oldest first, starting at index
    /// `from`. `limit` is capped at `MAX_HISTORY_PAGE`; a start past the end gives an empty list.
    ///
    /// Panics with ERR_BAD_NETWORK unless `network` is "mainnet", "testnet" or "sandbox".
    pub fn history(
        &self,
        network: String,
        dao: AccountId,
        proposal_id: u64,
        from: u64,
        limit: u64,
    ) -> Vec<VerdictRecord> {
        let proposal = ProposalKey {
            network: parse_network(&network),
            dao,
            proposal_id,
        };
        let count = u64::from(self.heads.get(&proposal).map_or(0, |h| h.count));
        let end = from.saturating_add(limit.min(MAX_HISTORY_PAGE)).min(count);
        (from..end)
            .filter_map(|index| self.record_at(&proposal, u32::try_from(index).ok()?))
            .collect()
    }

    /// The key whose signatures this registry accepts, as "ed25519:<base58>". Fixed at `new`.
    pub fn accepted_key(&self) -> String {
        self.accepted_key.to_string()
    }

    /// The network this registry records for: "mainnet", "testnet" or "sandbox".
    pub fn network(&self) -> String {
        self.network.clone()
    }
}

impl KaapRegistry {
    /// The 32 key bytes; only ed25519 keys are ever stored.
    fn key_bytes(&self) -> [u8; 32] {
        self.accepted_key.as_bytes()[1..]
            .try_into()
            .unwrap_or_else(|_| env::abort())
    }

    fn record_at(&self, proposal: &ProposalKey, index: u32) -> Option<VerdictRecord> {
        let stored = self.entries.get(&EntryKey {
            proposal: proposal.clone(),
            index,
        })?;
        // Every stored verdict decoded once already in `record`, so this cannot fail.
        let verdict = Verdict::try_from_slice(&stored.verdict).unwrap_or_else(|_| env::abort());
        Some(VerdictRecord {
            index,
            supersedes: stored.supersedes,
            verdict_hash: hex::encode(verdict_hash(&verdict)),
            verdict: Base64VecU8(stored.verdict.clone()),
            signature: Base64VecU8(stored.signature.clone()),
            guard: verdict.guard,
            risk: name_of(verdict.risk),
            floor: name_of(verdict.floor),
            findings: verdict.findings.into_iter().map(name_of).collect(),
            ai_status: name_of(verdict.ai_status),
            model_id: verdict.model_id,
            decoder_version: verdict.decoder_version,
            block_height: verdict.block_height,
            expires_at_ms: verdict.expires_at_ms,
            recorded_by: stored.recorded_by.clone(),
            recorded_at_block: stored.recorded_at_block,
            recorded_at_ms: stored.recorded_at_ms,
        })
    }
}

#[cfg(test)]
mod tests;
