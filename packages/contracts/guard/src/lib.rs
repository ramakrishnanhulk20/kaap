//! kaap-guard: the only member of a Sputnik DAO's reject-only Guard role.
//!
//! Anyone may hand it a verdict signed by the accepted key. When the verdict is fresh, unused,
//! names this guard, this network and an enrolled DAO, and meets the veto rule, the guard casts
//! VoteReject on the proposal the verdict names. It can cast nothing else: the receiver comes
//! from the signed verdict, the method and the action are fixed in this file, and `veto` is the
//! only method that calls another contract (C15). The only other promises are plain refunds of
//! a caller's own storage deposit, sent back to that caller by `enroll` and `unenroll` (C29).
//!
//! The code is immutable on purpose. There is no upgrade method, and the deploy script deletes
//! the account's full-access key right after `new`. A new version is a new contract, which a DAO
//! adopts with one ordinary proposal that moves its Guard role.

use kaap_core::severity::min_severity;
use kaap_core::verdict::VERDICT_VERSION;
use kaap_core::{kind_hash, verdict_bytes, verdict_hash, AiStatus, FindingCode, Severity, Verdict};
use near_sdk::borsh::BorshDeserialize;
use near_sdk::json_types::Base64VecU8;
use near_sdk::serde::de::IgnoredAny;
use near_sdk::store::{IterableSet, LookupMap};
use near_sdk::{
    env, near, require, AccountId, CurveType, Gas, GasWeight, NearToken, PanicOnDefault, Promise,
    PromiseError, PublicKey,
};

pub const ERR_BAD_KEY: &str = "ERR_BAD_KEY";
pub const ERR_BAD_NETWORK: &str = "ERR_BAD_NETWORK";
pub const ERR_ALREADY_ENROLLED: &str = "ERR_ALREADY_ENROLLED";
pub const ERR_NOT_ENROLLED: &str = "ERR_NOT_ENROLLED";
pub const ERR_BAD_VERDICT: &str = "ERR_BAD_VERDICT";
pub const ERR_BAD_SIGNATURE: &str = "ERR_BAD_SIGNATURE";
pub const ERR_WRONG_GUARD: &str = "ERR_WRONG_GUARD";
pub const ERR_NOT_VETOABLE: &str = "ERR_NOT_VETOABLE";
pub const ERR_EXPIRED: &str = "ERR_EXPIRED";
pub const ERR_WRONG_KIND_HASH: &str = "ERR_WRONG_KIND_HASH";
pub const ERR_BAD_KIND: &str = "ERR_BAD_KIND";
pub const ERR_REPLAY: &str = "ERR_REPLAY";
pub const ERR_BAD_HASH: &str = "ERR_BAD_HASH";
pub const ERR_NOT_CALLBACK: &str = "ERR_NOT_CALLBACK";
pub const ERR_NOT_OWNER: &str = "ERR_NOT_OWNER";
pub const ERR_NEED_ONE_YOCTO: &str = "ERR_NEED_ONE_YOCTO";
pub const ERR_NOT_PENDING_OWNER: &str = "ERR_NOT_PENDING_OWNER";
pub const ERR_NOT_ENOUGH_DEPOSIT: &str = "ERR_NOT_ENOUGH_DEPOSIT";

/// The most entries `enrolled_daos` returns in one page. Measured as a transaction: 1.30 Tgas for
/// one entry and 2.14 Tgas for twelve, about 0.08 Tgas each, so a full page of 100 is about
/// 9 Tgas, far inside the gas an RPC view may burn, and its JSON stays under 7 KB.
pub const MAX_ENROLLED_PAGE: u64 = 100;

/// What `veto_result` reports for a vote the DAO accepted.
pub const RESULT_OK: &str = "Ok";

/// Gas the DAO's `act_proposal` receives at the least. Measured in the sandbox against Sputnik
/// 3.2 (packages/contracts/GAS.md): 2.4 Tgas for a Transfer, 17.3 Tgas for a 22.7 KB
/// ChangePolicy, the size of a big real DAO's policy, and 48.9 Tgas for a 65 KB one. 100 Tgas is
/// twice the largest of those. The call also gets every unit the caller attached beyond the
/// guard's own needs (weight 1), which is how a 198 KB ChangePolicy veto landed with 155 Tgas.
pub const ACT_PROPOSAL_GAS: Gas = Gas::from_tgas(100);

/// Gas for `on_veto_result`, which reads one promise result, writes one entry and logs one
/// event. Measured at 1.62 Tgas whatever the kind's size; 10 Tgas is six times that.
pub const ON_VETO_RESULT_GAS: Gas = Gas::from_tgas(10);

/// What happened to a verdict once the guard accepted it. The entry is written when the vote is
/// sent, so its presence alone marks the verdict as used.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
enum VetoOutcome {
    /// The vote went out and the DAO has not answered yet.
    Sent,
    /// The DAO accepted the VoteReject.
    Cast,
    /// The DAO refused it; the text says how the refusal reached the callback.
    Refused(String),
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct KaapGuard {
    owner: AccountId,
    pending_owner: Option<AccountId>,
    accepted_key: PublicKey,
    /// The network's name in kaap-core's own spelling ("mainnet", "testnet", "sandbox"). It is a
    /// string because kaap-core's `Network` has no borsh schema for the ABI build, and it is only
    /// ever produced by `network_name`, so both sides of the comparison in `veto` come out of the
    /// same serializer.
    network: String,
    enrolled: IterableSet<AccountId>,
    /// Keyed by `kaap_core::verdict_hash`, the sha256 of the signed bytes, so a second signature
    /// or another base64 spelling of the same verdict is still the same entry.
    vetoes: LookupMap<[u8; 32], VetoOutcome>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct DaoEntry {
    pub dao: AccountId,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct KeyChangedEntry {
    pub old_key: String,
    pub new_key: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct OwnerProposedEntry {
    pub owner: AccountId,
    pub proposed_owner: AccountId,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct OwnerAcceptedEntry {
    pub old_owner: AccountId,
    pub new_owner: AccountId,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct VetoSentEntry {
    pub dao: AccountId,
    pub proposal_id: u64,
    pub verdict_hash: String,
}

/// `result` is "Ok" for `veto_cast`. For `veto_refused` it is how the refusal reached the
/// callback ("Failed"); the DAO's own reason, such as ERR_WRONG_KIND, is only in the DAO's
/// receipt, because NEAR never hands a panic text to a callback.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct VetoResultEntry {
    pub verdict_hash: String,
    pub result: String,
}

/// NEP-297 events, logged as `EVENT_JSON:{"standard":"kaap-guard","version":"1.0.0",...}`. Each
/// variant carries a list so `data` is always an array, as NEP-297 asks.
#[near(event_json(standard = "kaap-guard"))]
pub enum GuardEvent {
    #[event_version("1.0.0")]
    Enrolled(Vec<DaoEntry>),
    #[event_version("1.0.0")]
    Unenrolled(Vec<DaoEntry>),
    #[event_version("1.0.0")]
    VetoSent(Vec<VetoSentEntry>),
    #[event_version("1.0.0")]
    VetoCast(Vec<VetoResultEntry>),
    #[event_version("1.0.0")]
    VetoRefused(Vec<VetoResultEntry>),
    #[event_version("1.0.0")]
    KeyChanged(Vec<KeyChangedEntry>),
    #[event_version("1.0.0")]
    OwnerProposed(Vec<OwnerProposedEntry>),
    #[event_version("1.0.0")]
    OwnerAccepted(Vec<OwnerAcceptedEntry>),
}

/// Exactly one yoctoNEAR proves the call was signed with a full-access key, because a
/// function-call access key cannot attach a deposit.
fn require_one_yocto() {
    require!(
        env::attached_deposit() == NearToken::from_yoctonear(1),
        ERR_NEED_ONE_YOCTO
    );
}

/// The veto rule (threat model C9; Ram's rulings of 20 and 23 Oct 2026), the same test as
/// `backed_by_proof` in kaap-core's `floor::finish`. The verdict must be critical and its
/// plain-code floor high or critical, and at least one finding other than HASH_UNVERIFIED must
/// be high or critical in its own right: an unexplained hash alerts but never vetoes, so a high
/// floor built from HASH_UNVERIFIED beside a medium code is not enough. The verdict carries codes
/// without effects, so each code counts at `min_severity`, which never overstates it. When the
/// floor is high, the AI is what raised it to critical, and only an AI answer proven by its
/// attestation may do that. A floor of Unknown is refused like any floor below high: an
/// unverifiable sign request alerts members but never triggers the guard (C8).
fn is_vetoable(verdict: &Verdict) -> bool {
    let floor_high = matches!(verdict.floor, Severity::High | Severity::Critical);
    let backed_by_proof = verdict.findings.iter().any(|&code| {
        code != FindingCode::HashUnverified
            && matches!(min_severity(code), Severity::High | Severity::Critical)
    });
    let raised_by_proven_ai =
        verdict.floor == Severity::Critical || verdict.ai_status == AiStatus::Verified;
    verdict.risk == Severity::Critical && floor_high && backed_by_proof && raised_by_proven_ai
}

fn storage_cost(bytes: u64) -> NearToken {
    env::storage_byte_cost().saturating_mul(u128::from(bytes))
}

/// Sends `amount` back to `to` as a plain transfer with no callback. Callers run it after their
/// last write, so nothing can re-enter the call that owes the refund.
fn refund(to: &AccountId, amount: NearToken) {
    if !amount.is_zero() {
        Promise::new(to.clone()).transfer(amount).detach();
    }
}

fn parse_hash(hash_hex: &str) -> [u8; 32] {
    let mut hash = [0u8; 32];
    hex::decode_to_slice(hash_hex, &mut hash).unwrap_or_else(|_| env::panic_str(ERR_BAD_HASH));
    hash
}

/// Parses "ed25519:<base58 of 32 bytes>" and refuses every other spelling. near-sdk's parser
/// also takes a bare key, any letter case in the prefix and other curves, so the result must
/// print back to exactly the input.
fn parse_accepted_key(key: &str) -> PublicKey {
    let parsed: PublicKey = key.parse().unwrap_or_else(|_| env::panic_str(ERR_BAD_KEY));
    require!(
        parsed.curve_type() == CurveType::ED25519 && parsed.to_string() == key,
        ERR_BAD_KEY
    );
    parsed
}

/// The one spelling of a network, produced by kaap-core's own serde derive so the guard can
/// never disagree with the sealed job about what a network is called.
fn network_name(network: kaap_core::Network) -> String {
    match near_sdk::serde_json::to_value(network) {
        Ok(near_sdk::serde_json::Value::String(name)) => name,
        _ => env::panic_str(ERR_BAD_NETWORK),
    }
}

/// Reads a network name through kaap-core's serde derive, so only its exact lowercase names
/// pass.
fn parse_network(name: &str) -> String {
    let network: kaap_core::Network = near_sdk::serde_json::from_value(
        near_sdk::serde_json::Value::String(name.to_owned()),
    )
    .unwrap_or_else(|_| env::panic_str(ERR_BAD_NETWORK));
    network_name(network)
}

#[near]
impl KaapGuard {
    /// Sets the owner, who alone may change the accepted key, the key whose signatures this
    /// guard obeys, and the network it serves.
    ///
    /// Only the contract account itself may call this, so the deploy script batches it with the
    /// deploy. Panics with ERR_BAD_KEY unless `accepted_key` is exactly
    /// "ed25519:<base58 of 32 bytes>", and with ERR_BAD_NETWORK unless `network` is "mainnet",
    /// "testnet" or "sandbox".
    #[init]
    #[private]
    pub fn new(owner: AccountId, accepted_key: String, network: String) -> Self {
        Self {
            owner,
            pending_owner: None,
            accepted_key: parse_accepted_key(&accepted_key),
            network: parse_network(&network),
            enrolled: IterableSet::new(b"e"),
            vetoes: LookupMap::new(b"v"),
        }
    }

    /// Enrols the calling account as a DAO this guard watches and may vote in. A DAO calls it
    /// through an ordinary FunctionCall proposal, so enrolment is the DAO's own vote. Any account
    /// can enrol itself, but a vote only counts in a DAO whose policy gives this guard a role.
    ///
    /// The caller attaches the storage its entry takes, measured as it is written (0.01 NEAR
    /// always covers it), and gets the rest back in the same call, so an enrolment never spends
    /// the guard's own balance (C29). Panics with ERR_ALREADY_ENROLLED if the caller is already
    /// enrolled and ERR_NOT_ENOUGH_DEPOSIT if the deposit does not cover the storage. Emits
    /// `enrolled`.
    #[payable]
    pub fn enroll(&mut self) {
        let dao = env::predecessor_account_id();
        let before = env::storage_usage();
        require!(self.enrolled.insert(dao.clone()), ERR_ALREADY_ENROLLED);
        // The set only writes to storage when flushed, and the charge must be what was written.
        self.enrolled.flush();
        let cost = storage_cost(env::storage_usage().saturating_sub(before));
        let attached = env::attached_deposit();
        require!(attached >= cost, ERR_NOT_ENOUGH_DEPOSIT);
        GuardEvent::Enrolled(vec![DaoEntry { dao: dao.clone() }]).emit();
        refund(&dao, attached.saturating_sub(cost));
    }

    /// Removes the calling account from the enrolled DAOs, after which `veto` refuses every
    /// verdict that names it. Called the same way as `enroll`. The storage the entry frees goes
    /// back to the caller, which is exactly what its enrolment charged: every entry's size
    /// depends only on its own account id, whatever moves into its place in the set.
    ///
    /// Panics with ERR_NOT_ENROLLED if the caller is not enrolled. Emits `unenrolled`.
    pub fn unenroll(&mut self) {
        let dao = env::predecessor_account_id();
        let before = env::storage_usage();
        require!(self.enrolled.remove(&dao), ERR_NOT_ENROLLED);
        self.enrolled.flush();
        let freed = before.saturating_sub(env::storage_usage());
        GuardEvent::Unenrolled(vec![DaoEntry { dao: dao.clone() }]).emit();
        refund(&dao, storage_cost(freed));
    }

    /// Casts VoteReject on the proposal a signed verdict names. Anyone may call it: the
    /// signature is the authority, and the caller only pays gas.
    ///
    /// `verdict` is the borsh encoding of `kaap_core::Verdict` without the domain prefix;
    /// `signature` is the 64-byte ed25519 signature by the accepted key over
    /// `kaap_core::verdict_bytes` (the prefix followed by that borsh); `kind_json` is the
    /// proposal's kind as `get_proposal` returned it, which the guard forwards to the DAO
    /// unchanged (C5).
    ///
    /// Checks, in this order, each failure a panic with the error named:
    /// the verdict decodes and has version 1 (ERR_BAD_VERDICT); the signature is valid for the
    /// accepted key (ERR_BAD_SIGNATURE); the verdict names this contract and this network
    /// (ERR_WRONG_GUARD); its DAO is enrolled (ERR_NOT_ENROLLED); it meets the veto rule of C9
    /// (ERR_NOT_VETOABLE); the block time is before `expires_at_ms` (ERR_EXPIRED); `kind_json`
    /// hashes, through kaap-core's canonical form, to the verdict's `kind_hash`
    /// (ERR_WRONG_KIND_HASH, or ERR_BAD_KIND when it cannot be canonicalised at all); `kind_json`
    /// parses as JSON (ERR_BAD_KIND); the verdict was never used (ERR_REPLAY).
    ///
    /// Then it marks the verdict used, emits `veto_sent`, and calls `act_proposal` on the DAO
    /// with `{"id":<proposal_id>,"action":"VoteReject","proposal":<kind_json>}`, no deposit and
    /// at least `ACT_PROPOSAL_GAS`, followed by `on_veto_result`. The caller must attach enough
    /// gas for the guard's own work plus both of those, or the whole call fails and nothing is
    /// spent; attach 300 Tgas, since what is not burnt is refunded and big kinds need it. Once
    /// the guard's receipt succeeds the verdict is spent, whatever the DAO answers.
    pub fn veto(
        &mut self,
        verdict: Base64VecU8,
        signature: Base64VecU8,
        kind_json: String,
    ) -> Promise {
        let verdict = Verdict::try_from_slice(&verdict.0)
            .unwrap_or_else(|_| env::panic_str(ERR_BAD_VERDICT));
        require!(verdict.version == VERDICT_VERSION, ERR_BAD_VERDICT);

        let signature: [u8; 64] = signature
            .0
            .as_slice()
            .try_into()
            .unwrap_or_else(|_| env::panic_str(ERR_BAD_SIGNATURE));
        require!(
            env::ed25519_verify(&signature, verdict_bytes(&verdict), &self.key_bytes()),
            ERR_BAD_SIGNATURE
        );

        require!(
            verdict.guard == env::current_account_id().as_str()
                && network_name(verdict.network) == self.network,
            ERR_WRONG_GUARD
        );

        // An id that does not parse can never have enrolled, so it is refused the same way.
        let dao: AccountId = verdict
            .dao
            .parse()
            .unwrap_or_else(|_| env::panic_str(ERR_NOT_ENROLLED));
        require!(self.enrolled.contains(&dao), ERR_NOT_ENROLLED);

        require!(is_vetoable(&verdict), ERR_NOT_VETOABLE);
        require!(
            env::block_timestamp_ms() < verdict.expires_at_ms,
            ERR_EXPIRED
        );

        // The canonical form absorbs the key and set order Sputnik's JSON may change between
        // reads, so the hash matches while the exact bytes, never the canonical ones, are sent.
        match kind_hash(kind_json.as_bytes()) {
            Ok(hash) => require!(hash == verdict.kind_hash, ERR_WRONG_KIND_HASH),
            Err(_) => env::panic_str(ERR_BAD_KIND),
        }
        // The canonical parser is stricter than this one, so after a hash match this cannot
        // fail today. It stays because the vote's arguments are built by concatenation, and that
        // is only sound while `kind_json` is exactly one JSON value.
        require!(
            near_sdk::serde_json::from_str::<IgnoredAny>(&kind_json).is_ok(),
            ERR_BAD_KIND
        );

        let hash = verdict_hash(&verdict);
        require!(!self.vetoes.contains_key(&hash), ERR_REPLAY);
        self.vetoes.insert(hash, VetoOutcome::Sent);
        let hash_hex = hex::encode(hash);
        GuardEvent::VetoSent(vec![VetoSentEntry {
            dao: dao.clone(),
            proposal_id: verdict.proposal_id,
            verdict_hash: hash_hex.clone(),
        }])
        .emit();

        let args = format!(
            "{{\"id\":{},\"action\":\"VoteReject\",\"proposal\":{kind_json}}}",
            verdict.proposal_id
        );
        Promise::new(dao)
            .function_call_weight(
                "act_proposal",
                args.into_bytes(),
                NearToken::from_yoctonear(0),
                ACT_PROPOSAL_GAS,
                GasWeight(1),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ON_VETO_RESULT_GAS)
                    .with_unused_gas_weight(0)
                    .on_veto_result(hash_hex),
            )
    }

    /// Records the DAO's answer to the vote sent for `verdict_hash` (64 hex characters) and
    /// emits `veto_cast` or `veto_refused`, so a refused vote is never silent (C18). Only this
    /// contract may call it, as the callback `veto` attaches.
    ///
    /// A callback cannot read the DAO's panic text, so a refusal is recorded as "Failed"; the
    /// reason is in the DAO's receipt of the same transaction. Panics with ERR_BAD_HASH on a
    /// malformed hash and ERR_NOT_CALLBACK unless exactly one promise result is present.
    #[private]
    pub fn on_veto_result(&mut self, verdict_hash: String) {
        let hash = parse_hash(&verdict_hash);
        require!(env::promise_results_count() == 1, ERR_NOT_CALLBACK);
        // act_proposal returns nothing, so any result length means it succeeded.
        let refusal = match env::promise_result_checked(0, 0) {
            Ok(_) | Err(PromiseError::TooLong(_)) => None,
            Err(PromiseError::Failed) => Some("Failed".to_owned()),
            Err(other) => Some(other.to_string()),
        };
        match refusal {
            None => {
                self.vetoes.insert(hash, VetoOutcome::Cast);
                GuardEvent::VetoCast(vec![VetoResultEntry {
                    verdict_hash,
                    result: RESULT_OK.to_owned(),
                }])
                .emit();
            }
            Some(reason) => {
                self.vetoes.insert(hash, VetoOutcome::Refused(reason.clone()));
                GuardEvent::VetoRefused(vec![VetoResultEntry {
                    verdict_hash,
                    result: reason,
                }])
                .emit();
            }
        }
    }

    /// Replaces the accepted key. Verdicts signed by the old key stop working at once.
    ///
    /// Panics with ERR_NOT_OWNER unless the owner calls, ERR_NEED_ONE_YOCTO unless exactly one
    /// yoctoNEAR is attached, and ERR_BAD_KEY unless `key` is exactly
    /// "ed25519:<base58 of 32 bytes>". Emits `key_changed` with the old and the new key, which
    /// the worker turns into a member alert (C18).
    #[payable]
    pub fn set_accepted_key(&mut self, key: String) {
        self.require_owner();
        require_one_yocto();
        let new_key = parse_accepted_key(&key);
        let old_key = std::mem::replace(&mut self.accepted_key, new_key);
        GuardEvent::KeyChanged(vec![KeyChangedEntry {
            old_key: old_key.to_string(),
            new_key: key,
        }])
        .emit();
    }

    /// First half of an owner transfer: names the account that may take ownership. The current
    /// owner keeps every right until `accept_owner` runs, and a second proposal replaces the
    /// first.
    ///
    /// Panics with ERR_NOT_OWNER unless the owner calls and ERR_NEED_ONE_YOCTO unless exactly
    /// one yoctoNEAR is attached. Emits `owner_proposed`.
    #[payable]
    pub fn propose_owner(&mut self, new_owner: AccountId) {
        self.require_owner();
        require_one_yocto();
        self.pending_owner = Some(new_owner.clone());
        GuardEvent::OwnerProposed(vec![OwnerProposedEntry {
            owner: self.owner.clone(),
            proposed_owner: new_owner,
        }])
        .emit();
    }

    /// Second half of an owner transfer: the proposed account takes ownership.
    ///
    /// Panics with ERR_NEED_ONE_YOCTO unless exactly one yoctoNEAR is attached and
    /// ERR_NOT_PENDING_OWNER unless the caller is the proposed owner. Emits `owner_accepted`.
    #[payable]
    pub fn accept_owner(&mut self) {
        require_one_yocto();
        let caller = env::predecessor_account_id();
        require!(
            self.pending_owner.as_ref() == Some(&caller),
            ERR_NOT_PENDING_OWNER
        );
        self.pending_owner = None;
        let old_owner = std::mem::replace(&mut self.owner, caller.clone());
        GuardEvent::OwnerAccepted(vec![OwnerAcceptedEntry {
            old_owner,
            new_owner: caller,
        }])
        .emit();
    }

    /// The key whose signatures this guard obeys, as "ed25519:<base58>".
    pub fn accepted_key(&self) -> String {
        self.accepted_key.to_string()
    }

    /// The network this guard serves: "mainnet", "testnet" or "sandbox".
    pub fn network(&self) -> String {
        self.network.clone()
    }

    /// The account that alone may change the accepted key.
    pub fn owner(&self) -> AccountId {
        self.owner.clone()
    }

    /// Whether `dao` has enrolled and not since unenrolled.
    pub fn is_enrolled(&self, dao: AccountId) -> bool {
        self.enrolled.contains(&dao)
    }

    /// One page of enrolled DAOs, in storage order, starting at `from_index`. `limit` is capped
    /// at `MAX_ENROLLED_PAGE`; a start past the end gives an empty list. The order changes when
    /// a DAO unenrols, because the last entry moves into its place.
    pub fn enrolled_daos(&self, from_index: u64, limit: u64) -> Vec<AccountId> {
        let skip = usize::try_from(from_index).unwrap_or(usize::MAX);
        let take = usize::try_from(limit.min(MAX_ENROLLED_PAGE)).unwrap_or(0);
        self.enrolled.iter().skip(skip).take(take).cloned().collect()
    }

    /// Whether the verdict with this `kaap_core::verdict_hash` (64 hex characters) was used.
    ///
    /// Panics with ERR_BAD_HASH if the input is not 32 bytes of hex, rather than answer false.
    pub fn was_used(&self, verdict_hash_hex: String) -> bool {
        self.vetoes.contains_key(&parse_hash(&verdict_hash_hex))
    }

    /// What the DAO answered to the vote cast for this verdict: "Ok" when the VoteReject landed,
    /// "Failed" when the DAO refused it, and None while the answer is pending or when the
    /// verdict was never used.
    ///
    /// Panics with ERR_BAD_HASH if the input is not 32 bytes of hex.
    pub fn veto_result(&self, verdict_hash_hex: String) -> Option<String> {
        match self.vetoes.get(&parse_hash(&verdict_hash_hex))? {
            VetoOutcome::Sent => None,
            VetoOutcome::Cast => Some(RESULT_OK.to_owned()),
            VetoOutcome::Refused(reason) => Some(reason.clone()),
        }
    }
}

#[cfg(test)]
mod tests;

impl KaapGuard {
    fn require_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, ERR_NOT_OWNER);
    }

    /// The 32 key bytes. A near-sdk `PublicKey` is a curve byte followed by the key, and only
    /// ed25519 keys are ever stored (`parse_accepted_key`).
    fn key_bytes(&self) -> [u8; 32] {
        self.accepted_key.as_bytes()[1..]
            .try_into()
            .unwrap_or_else(|_| env::abort())
    }
}
