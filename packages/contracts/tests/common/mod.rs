// Shared sandbox harness for the kaap-guard and kaap-registry tests. It builds the contracts with
// cargo-near, starts one fresh near-sandbox per test, deploys the real Sputnik DAO 3.2 binary after
// checking its hash, and plays the sealed signer with a fixed throwaway ed25519 key.
//
// What this file does NOT cover: anything on its own. It holds no assertions about the contracts;
// those are in guard.rs and registry.rs.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use ed25519_dalek::{Signer as _, SigningKey};
use kaap_verdict::{kind_hash, verdict_bytes, verdict_hash, AiStatus, FindingCode, Network, Severity, Verdict};
use near_api::types::account::ContractState;
use near_api::types::transaction::result::ExecutionFinalResult;
use near_api::types::Reference;
use near_api::{Account, AccountId, Chain, Contract, CryptoHash, NearGas, NearToken, NetworkConfig, Signer};
use near_sandbox::config::{DEFAULT_GENESIS_ACCOUNT, DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY};
use near_sandbox::{Sandbox, SandboxConfig};
use serde_json::{json, Value};
use tokio::sync::{Semaphore, SemaphorePermit};

pub use anyhow::Result;

const REPO_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../..");
/// Written by scripts/fetch-sputnik-wasm.sh, which takes the code every 3.2 DAO runs from mainnet.
const SPUTNIK_WASM: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/wasm/sputnik-dao-3.2.wasm");
pub const SPUTNIK_CODE_HASH: &str = "DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF";

pub const NETWORK: &str = "sandbox";
pub const PROPOSAL_BOND: NearToken = NearToken::from_near(1);
pub const TEN_MINUTES_MS: u64 = 10 * 60 * 1000;
const ONE_WEEK_NS: u64 = 7 * 24 * 60 * 60 * 1_000_000_000;
const ONE_DAY_NS: u64 = 24 * 60 * 60 * 1_000_000_000;

// Fixed seeds keep every run identical. They are public test values and guard nothing; the
// testnet deploy uses the first one's public key until the sealed key replaces it.
pub const VERDICT_KEY_SEED: [u8; 32] = [7; 32];
pub const OTHER_KEY_SEED: [u8; 32] = [9; 32];
pub const THIRD_KEY_SEED: [u8; 32] = [11; 32];

/// Each sandbox is a full neard process, and cargo runs one test per core at once. On this 8 GB
/// machine, with other builds running beside the tests, four sandboxes at a time is the cap.
static SANDBOX_SLOTS: Semaphore = Semaphore::const_new(4);

/// Wasm built in this test process, by crate folder name, so each contract is built once.
static BUILT: Mutex<BTreeMap<String, Vec<u8>>> = Mutex::new(BTreeMap::new());

/// Builds `packages/contracts/<crate_dir>` with `cargo near build non-reproducible-wasm`, the same
/// command the deploy script runs, and returns the wasm. The build gets its own target folder
/// next to the one running the tests, so it never waits on the outer cargo's lock.
pub fn contract_wasm(crate_dir: &str) -> Result<Vec<u8>> {
    let mut built = BUILT.lock().map_err(|_| anyhow::anyhow!("a contract build panicked"))?;
    if let Some(code) = built.get(crate_dir) {
        return Ok(code.clone());
    }
    let target = outer_target_dir()?.join("near-contracts");
    let out = target.join("out");
    let crate_path = Path::new(REPO_ROOT).join("packages/contracts").join(crate_dir);
    let output = Command::new("cargo")
        .args(["near", "build", "non-reproducible-wasm", "--out-dir"])
        .arg(&out)
        .current_dir(&crate_path)
        .env("CARGO_TARGET_DIR", &target)
        .output()
        .map_err(|error| {
            anyhow::anyhow!("could not run cargo near ({error}); install cargo-near 0.22.0")
        })?;
    anyhow::ensure!(
        output.status.success(),
        "cargo near build failed in {}:\n{}",
        crate_path.display(),
        String::from_utf8_lossy(&output.stderr)
    );
    let wasm = out.join(format!("kaap_{crate_dir}.wasm"));
    let code = std::fs::read(&wasm)
        .map_err(|error| anyhow::anyhow!("cannot read {} ({error})", wasm.display()))?;
    built.insert(crate_dir.to_owned(), code.clone());
    Ok(code)
}

/// The cargo target folder this test binary was built into: the binary sits in
/// `<target>/debug/deps/`.
fn outer_target_dir() -> Result<PathBuf> {
    let exe = std::env::current_exe()?;
    exe.ancestors()
        .nth(3)
        .map(Path::to_path_buf)
        .ok_or_else(|| anyhow::anyhow!("unexpected test binary path {}", exe.display()))
}

/// A file in this repository, by its path from the repo root.
pub fn repo_path(relative: &str) -> PathBuf {
    Path::new(REPO_ROOT).join(relative)
}

/// Reads the fetched mainnet binary and refuses to go on unless it is the 3.2 release.
pub fn sputnik_wasm() -> Result<Vec<u8>> {
    let path = Path::new(SPUTNIK_WASM);
    let code = std::fs::read(path).map_err(|error| {
        anyhow::anyhow!(
            "cannot read {} ({error}); run `bash scripts/fetch-sputnik-wasm.sh` first",
            path.display()
        )
    })?;
    let hash = CryptoHash::hash(&code).to_string();
    anyhow::ensure!(
        hash == SPUTNIK_CODE_HASH,
        "{} hashes to {hash}, expected {SPUTNIK_CODE_HASH}",
        path.display()
    );
    Ok(code)
}

/// The test's stand-in for the sealed program: it signs verdicts exactly as kaap-sealed will,
/// over `kaap_verdict::verdict_bytes`, with its own ed25519 library rather than the contract's host
/// function, so the two are checked against each other.
pub struct SealedSigner {
    key: SigningKey,
}

impl SealedSigner {
    pub fn test_key() -> Self {
        Self { key: SigningKey::from_bytes(&VERDICT_KEY_SEED) }
    }

    pub fn other_key() -> Self {
        Self { key: SigningKey::from_bytes(&OTHER_KEY_SEED) }
    }

    pub fn third_key() -> Self {
        Self { key: SigningKey::from_bytes(&THIRD_KEY_SEED) }
    }

    /// "ed25519:<base58>", the only spelling the contracts accept.
    pub fn public_key(&self) -> String {
        format!(
            "ed25519:{}",
            bs58::encode(self.key.verifying_key().to_bytes()).into_string()
        )
    }

    /// Returns (verdict, signature) as the base64 strings `veto` and `record` take.
    pub fn sign(&self, verdict: &Verdict) -> (String, String) {
        let signature = self.key.sign(&verdict_bytes(verdict)).to_bytes();
        (
            STANDARD.encode(borsh::to_vec(verdict).expect("a verdict always encodes")),
            STANDARD.encode(signature),
        )
    }
}

pub fn b64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

pub fn verdict_hash_hex(verdict: &Verdict) -> String {
    hex::encode(verdict_hash(verdict))
}

/// A verdict the guard accepts: critical on a critical floor with a plain-code finding, for the
/// kind exactly as given, on the sandbox network.
pub fn vetoable_verdict(
    guard: &AccountId,
    dao: &AccountId,
    proposal_id: u64,
    kind_json: &str,
    expires_at_ms: u64,
) -> Result<Verdict> {
    Ok(Verdict {
        version: 1,
        guard: guard.to_string(),
        network: Network::Sandbox,
        dao: dao.to_string(),
        proposal_id,
        kind_hash: kind_hash(kind_json.as_bytes()).map_err(|e| anyhow::anyhow!("{e}"))?,
        policy_hash: [1; 32],
        receivers_hash: [2; 32],
        block_height: 1,
        risk: Severity::Critical,
        floor: Severity::Critical,
        findings: vec![FindingCode::DescContradicts],
        decoder_version: "sandbox-test".to_owned(),
        model_id: "none".to_owned(),
        ai_status: AiStatus::Unavailable,
        explanation_hash: [3; 32],
        expires_at_ms,
    })
}

/// One fresh sandbox. The neard process stops when this value is dropped, so every test gets a
/// clean chain; the slot is given back at the same moment.
pub struct Env {
    _slot: SemaphorePermit<'static>,
    pub sandbox: Sandbox,
    pub network: NetworkConfig,
    pub signer: Arc<Signer>,
}

impl Env {
    pub async fn start() -> Result<Self> {
        Self::start_with(SandboxConfig::default()).await
    }

    /// A sandbox whose epochs are so long that skipping days of blocks is one jump; across an
    /// epoch boundary the node fast-forwards one epoch at a time.
    pub async fn start_with_long_epochs() -> Result<Self> {
        Self::start_with(SandboxConfig {
            additional_genesis: Some(json!({ "epoch_length": 1_000_000 })),
            ..SandboxConfig::default()
        })
        .await
    }

    async fn start_with(config: SandboxConfig) -> Result<Self> {
        let slot = SANDBOX_SLOTS.acquire().await?;
        let sandbox = Sandbox::start_sandbox_with_config(config).await?;
        let network = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
        // Accounts made by the sandbox share the genesis test key, which is public by design.
        let signer = Signer::from_secret_key(DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;
        Ok(Self { _slot: slot, sandbox, network, signer })
    }

    pub async fn account(&self, name: &str, near: u128) -> Result<AccountId> {
        let id: AccountId = format!("{name}.{DEFAULT_GENESIS_ACCOUNT}").parse()?;
        self.sandbox
            .create_account(id.clone())
            .initial_balance(NearToken::from_near(near))
            .send()
            .await?;
        Ok(id)
    }

    /// Deploys `code` to `id` and calls `init` with `args` in the same transaction.
    pub async fn deploy(&self, id: &AccountId, code: Vec<u8>, init: &str, args: Value) -> Result<()> {
        Contract::deploy(id.clone())
            .use_code(code)
            .with_init_call(init, args)?
            .max_gas()
            .with_signer(self.signer.clone())
            .send_to(&self.network)
            .await?
            .into_result()?;
        Ok(())
    }

    pub async fn view(&self, contract: &AccountId, method: &str, args: Value) -> Result<Value> {
        Ok(Contract(contract.clone())
            .call_function(method, args)
            .read_only::<Value>()
            .fetch_from(&self.network)
            .await?
            .data)
    }

    /// Sends a function call from `caller` and hands back the raw outcome, success or not.
    pub async fn call(
        &self,
        caller: &AccountId,
        contract: &AccountId,
        method: &str,
        args: Value,
        deposit: NearToken,
        gas: NearGas,
    ) -> Result<ExecutionFinalResult> {
        Ok(Contract(contract.clone())
            .call_function(method, args)
            .transaction()
            .deposit(deposit)
            .gas(gas)
            .with_signer(caller.clone(), self.signer.clone())
            .send_to(&self.network)
            .await?)
    }

    pub async fn account_view(&self, id: &AccountId) -> Result<near_api::types::account::Account> {
        Ok(Account(id.clone()).view().fetch_from(&self.network).await?.data)
    }

    /// The latest block time in milliseconds, read from the chain rather than this machine's clock.
    pub async fn chain_time_ms(&self) -> Result<u64> {
        Ok(Chain::block().fetch_from(&self.network).await?.header.timestamp / 1_000_000)
    }

    /// Skips blocks until the block time is at least `target_ms`, and returns the block time
    /// then. A skipped block moves the clock by about one block time (310 ms in the sandbox with
    /// long epochs), so the rate is measured on a short skip first. Quick only on a sandbox from
    /// `start_with_long_epochs`.
    pub async fn advance_clock_to(&self, target_ms: u64) -> Result<u64> {
        let mut now = self.chain_time_ms().await?;
        let mut per_block_ms = 0;
        for _ in 0..10 {
            if now >= target_ms {
                return self.wait_for_final_block(target_ms).await;
            }
            let blocks = if per_block_ms == 0 { 100 } else { (target_ms - now).div_ceil(per_block_ms) };
            self.sandbox.fast_forward(blocks).await?;
            let after = self.chain_time_ms().await?;
            per_block_ms = ((after - now) / blocks).max(1);
            now = after;
        }
        anyhow::bail!("the sandbox clock stopped at {now} ms, short of {target_ms}")
    }

    /// Waits until the last final block is at or past `target_ms`, and returns the block time then.
    /// A transaction is signed against the final block, which trails the newest one. Straight
    /// after a skip it can still be a block from before the skip, and a transaction signed
    /// against that is refused as expired.
    async fn wait_for_final_block(&self, target_ms: u64) -> Result<u64> {
        for _ in 0..100 {
            let last_final = Chain::block().at(Reference::Final).fetch_from(&self.network).await?;
            if last_final.header.timestamp / 1_000_000 >= target_ms {
                return self.chain_time_ms().await;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        anyhow::bail!("the final block never caught up with the skip to {target_ms} ms")
    }

    /// Deploys Sputnik 3.2 to `dao` with a council role [council] holding "*:*" and a guard role
    /// [guard] holding only VoteReject, and checks the deployed code hash afterwards.
    pub async fn deploy_sputnik(
        &self,
        dao: &AccountId,
        council: &AccountId,
        guard: &AccountId,
    ) -> Result<()> {
        let guard_permissions: Vec<String> = GUARD_REJECT_KINDS
            .iter()
            .map(|label| format!("{label}:VoteReject"))
            .collect();
        // RoleWeight with threshold 1/2: on a one-member group Sputnik computes
        // min(1 * 1 / 2 + 1, 1) = 1 vote (policy.rs 98-106, 415-418), so the single member of each
        // role decides alone.
        let policy = json!({
            "roles": [
                { "name": "council", "kind": { "Group": [council] }, "permissions": ["*:*"], "vote_policy": {} },
                { "name": "guard", "kind": { "Group": [guard] }, "permissions": guard_permissions, "vote_policy": {} }
            ],
            "default_vote_policy": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 2] },
            "proposal_bond": PROPOSAL_BOND.as_yoctonear().to_string(),
            "proposal_period": ONE_WEEK_NS.to_string(),
            "bounty_bond": NearToken::from_near(1).as_yoctonear().to_string(),
            "bounty_forgiveness_period": ONE_DAY_NS.to_string()
        });
        let config = json!({ "name": "kaap-test", "purpose": "kaap guard tests", "metadata": "" });
        self.deploy(dao, sputnik_wasm()?, "new", json!({ "config": config, "policy": policy }))
            .await?;
        let deployed = self.account_view(dao).await?;
        anyhow::ensure!(
            deployed.contract_state == ContractState::LocalHash(SPUTNIK_CODE_HASH.parse()?),
            "{dao} is running {:?}, not Sputnik 3.2",
            deployed.contract_state
        );
        Ok(())
    }

    /// Files a proposal from `proposer`, attaching exactly the bond the live policy asks for.
    pub async fn add_proposal(&self, dao: &AccountId, proposer: &AccountId, kind: Value) -> Result<u64> {
        self.add_proposal_with_gas(dao, proposer, kind, NearGas::from_tgas(300)).await
    }

    /// `add_proposal` with the gas the proposer chooses; kinds near kaap-verdict's 256 KiB limit
    /// need more than 300 Tgas to file.
    pub async fn add_proposal_with_gas(
        &self,
        dao: &AccountId,
        proposer: &AccountId,
        kind: Value,
        gas: NearGas,
    ) -> Result<u64> {
        let bond: u128 = self.view(dao, "get_policy", json!({})).await?["proposal_bond"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("policy has no proposal_bond"))?
            .parse()?;
        let outcome = self
            .call(
                proposer,
                dao,
                "add_proposal",
                json!({ "proposal": { "description": "kaap guard test", "kind": kind } }),
                NearToken::from_yoctonear(bond),
                gas,
            )
            .await?;
        Ok(outcome.into_result()?.json::<u64>()?)
    }

    pub async fn proposal(&self, dao: &AccountId, id: u64) -> Result<Value> {
        self.view(dao, "get_proposal", json!({ "id": id })).await
    }

    /// The `get_proposal` answer exactly as the DAO returned it, before any JSON parser saw it.
    pub async fn proposal_text(&self, dao: &AccountId, id: u64) -> Result<String> {
        let bytes = Contract(dao.clone())
            .call_function("get_proposal", json!({ "id": id }))
            .read_only_raw()
            .fetch_from(&self.network)
            .await?
            .data;
        Ok(String::from_utf8(bytes)?)
    }

    /// The kind exactly as the DAO returned it, the bytes Kaap's worker forwards to `veto`.
    pub async fn kind_json(&self, dao: &AccountId, id: u64) -> Result<String> {
        Ok(raw_field(&self.proposal_text(dao, id).await?, "kind")?.to_owned())
    }

    pub async fn status(&self, dao: &AccountId, id: u64) -> Result<String> {
        let proposal = self.proposal(dao, id).await?;
        proposal["status"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| anyhow::anyhow!("proposal {id} has no status: {proposal}"))
    }
}

/// Sputnik matches permissions only as "kind:action", "kind:*", "*:action" or "*:*" (policy.rs
/// 346-353), so there is no "every kind except one". These are the 16 labels from
/// to_policy_label (proposals.rs 125-147) with remove_member_from_role left off, so the guard can
/// never block its own removal.
pub const GUARD_REJECT_KINDS: [&str; 16] = [
    "config",
    "policy",
    "add_member_to_role",
    "call",
    "upgrade_self",
    "upgrade_remote",
    "transfer",
    "set_vote_token",
    "add_bounty",
    "bounty_done",
    "vote",
    "factory_info_update",
    "policy_add_or_update_role",
    "policy_remove_role",
    "policy_update_default_vote_policy",
    "policy_update_parameters",
];

fn skip_space(text: &[u8], mut at: usize) -> usize {
    while matches!(text.get(at), Some(b' ' | b'\n' | b'\r' | b'\t')) {
        at += 1;
    }
    at
}

/// Where the one JSON value that starts at `start` ends, found by serde_json itself.
fn value_end(text: &str, start: usize) -> Result<usize> {
    let mut values = serde_json::Deserializer::from_str(&text[start..]).into_iter::<Value>();
    match values.next() {
        Some(Ok(_)) => Ok(start + values.byte_offset()),
        Some(Err(error)) => Err(error.into()),
        None => anyhow::bail!("no JSON value at byte {start}"),
    }
}

/// The exact text of `field` in the JSON object `object`, not a re-encoding of it. serde_json
/// here has no raw-value feature, so the slice is cut at the offsets its own parser reports.
pub fn raw_field<'a>(object: &'a str, field: &str) -> Result<&'a str> {
    let bytes = object.as_bytes();
    let mut at = skip_space(bytes, 0);
    anyhow::ensure!(bytes.get(at) == Some(&b'{'), "not a JSON object");
    at += 1;
    loop {
        at = skip_space(bytes, at);
        anyhow::ensure!(bytes.get(at) != Some(&b'}'), "no field {field:?}");
        let key_end = value_end(object, at)?;
        let key: String = serde_json::from_str(&object[at..key_end])?;
        at = skip_space(bytes, key_end);
        anyhow::ensure!(bytes.get(at) == Some(&b':'), "no colon after {key:?}");
        at = skip_space(bytes, at + 1);
        let end = value_end(object, at)?;
        if key == field {
            return Ok(&object[at..end]);
        }
        at = skip_space(bytes, end);
        anyhow::ensure!(bytes.get(at) == Some(&b','), "no field {field:?}");
        at += 1;
    }
}

/// The exact text of every item of the JSON array `array`.
pub fn raw_items(array: &str) -> Result<Vec<&str>> {
    let bytes = array.as_bytes();
    let mut at = skip_space(bytes, 0);
    anyhow::ensure!(bytes.get(at) == Some(&b'['), "not a JSON array");
    at = skip_space(bytes, at + 1);
    let mut items = Vec::new();
    if bytes.get(at) == Some(&b']') {
        return Ok(items);
    }
    loop {
        let end = value_end(array, at)?;
        items.push(&array[at..end]);
        at = skip_space(bytes, end);
        match bytes.get(at) {
            Some(b',') => at = skip_space(bytes, at + 1),
            Some(b']') => return Ok(items),
            _ => anyhow::bail!("unterminated array"),
        }
    }
}

/// The contract's own refusal text, or an error if the call went through.
pub fn refusal(outcome: ExecutionFinalResult) -> Result<String> {
    match outcome.into_result() {
        Ok(_) => anyhow::bail!("the call succeeded, a refusal was expected"),
        Err(failure) => Ok(failure.to_string()),
    }
}

/// Asserts the call failed with `expected` in its panic text.
pub fn assert_refused(outcome: ExecutionFinalResult, expected: &str) -> Result<String> {
    let text = refusal(outcome)?;
    anyhow::ensure!(text.contains(expected), "expected {expected}, got: {text}");
    Ok(text)
}

/// The reason one receipt failed. Its Display text is only "Executing transaction failed"; the
/// panic text sits in the boxed error that Debug prints (found in our pre-build sandbox spike).
pub fn receipt_error(error: &near_api::types::errors::ExecutionError) -> String {
    format!("{error:?}")
}

/// Every receipt of the transaction that ran on `account`, in order.
pub fn step_on<'a>(
    outcome: &'a ExecutionFinalResult,
    account: &AccountId,
) -> Result<Vec<&'a near_api::types::transaction::result::ExecutionOutcome>> {
    let steps: Vec<_> = outcome
        .receipt_outcomes()
        .iter()
        .filter(|step| &step.executor_id == account)
        .collect();
    anyhow::ensure!(!steps.is_empty(), "no receipt ran on {account}");
    Ok(steps)
}

/// Every NEP-297 event the transaction logged, parsed.
pub fn events(outcome: &ExecutionFinalResult) -> Vec<Value> {
    outcome
        .logs()
        .into_iter()
        .filter_map(|line| line.strip_prefix("EVENT_JSON:"))
        .filter_map(|body| serde_json::from_str(body).ok())
        .collect()
}

/// Prints one "GAS |" line per receipt, in execution order, with the gas in Tgas to three places,
/// so the gas report can be read straight off the test output.
pub fn report_gas(label: &str, outcome: &ExecutionFinalResult) {
    let tgas = |gas: NearGas| gas.as_gas() as f64 / 1e12;
    println!("GAS | {label} | total | {:.3}", tgas(outcome.total_gas_burnt));
    for step in outcome.outcomes() {
        let ended = match step.clone().into_result() {
            Ok(_) => "ok".to_owned(),
            Err(error) => {
                let text = receipt_error(&error);
                let reason = text
                    .split("Smart contract panicked: ")
                    .nth(1)
                    .unwrap_or(&text)
                    .chars()
                    .take(80)
                    .collect::<String>();
                format!("failed: {reason}")
            }
        };
        println!("GAS | {label} | {} | {:.3} | {ended}", step.executor_id, tgas(step.gas_burnt));
    }
}

/// Prints every step of a transaction: who ran it, the gas it burnt, how it ended.
pub fn print_outcomes(label: &str, outcome: &ExecutionFinalResult) {
    println!("{label}: total gas burnt {}", outcome.total_gas_burnt);
    for step in outcome.outcomes() {
        let ended = match step.clone().into_result() {
            Ok(_) => "succeeded".to_owned(),
            Err(error) => format!("FAILED: {}", receipt_error(&error)),
        };
        println!("{label}:   {} burnt {}, {ended}", step.executor_id, step.gas_burnt);
    }
}
