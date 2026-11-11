// Proves two things about the planted Kaap evaluation set, against the real Sputnik DAO 3.2
// binary in a throwaway local sandbox (nearcore 2.13.4, the near-sandbox crate's default):
//   1. every record in eval/planted/planted.jsonl is accepted by `add_proposal`, and the kind
//      `get_proposal` stores back is byte-for-byte the kind that was filed;
//   2. every sign proposal's NEP-413 hash, recomputed from its supplied text, matches or does
//      not match its on-chain payload_v2 exactly as the record's label says it should.
//
// What this file does NOT cover:
// - testnet or mainnet: everything runs in a throwaway local sandbox, no key is loaded for any
//   real network and no real transaction is sent;
// - voting, execution, or any effect of a proposal after it is filed (the labels describe what
//   execution WOULD do; this harness only files and reads back);
// - whether the labels are right, or whether Kaap's own decoder produces the labelled effects;
// - a DAO with any other policy than harness_policy.json;
// - any Sputnik binary other than code hash DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use near_api::types::account::ContractState;
use near_api::{Account, AccountId, Contract, CryptoHash, NearToken, NetworkConfig, Signer};
use near_sandbox::Sandbox;
use near_sandbox::config::{DEFAULT_GENESIS_ACCOUNT, DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY};
use serde_json::{Value, json};

const REPO_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../..");
/// Not in git: scripts/fetch-sputnik-wasm.sh takes it from NEAR mainnet by its code hash.
const SPUTNIK_WASM: &str = "packages/contracts/tests/wasm/sputnik-dao-3.2.wasm";
const SPUTNIK_CODE_HASH: &str = "DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF";
const PLANTED: &str = "eval/planted/planted.jsonl";
const HARNESS_POLICY: &str = include_str!("../harness_policy.json");

// The published set is frozen, so the counts are exact rather than lower bounds.
const RECORDS: usize = 73;
const ATTACKS: usize = 56;
const CONTROLS: usize = 17;
const SIGN_RECORDS: usize = 7;

fn repo_path(relative: &str) -> PathBuf {
    Path::new(REPO_ROOT).join(relative)
}

fn read_records() -> anyhow::Result<Vec<Value>> {
    let text = std::fs::read_to_string(repo_path(PLANTED))
        .map_err(|error| anyhow::anyhow!("cannot read {PLANTED} ({error})"))?;
    let mut out = Vec::new();
    for (n, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let record = serde_json::from_str::<Value>(line)
            .map_err(|error| anyhow::anyhow!("{PLANTED} line {}: {error}", n + 1))?;
        out.push(record);
    }
    anyhow::ensure!(!out.is_empty(), "{PLANTED} is empty");
    Ok(out)
}

/// Reads the fetched mainnet binary and refuses to go on unless it is the 3.2 release.
fn sputnik_wasm() -> anyhow::Result<Vec<u8>> {
    let code = match std::fs::read(repo_path(SPUTNIK_WASM)) {
        Ok(code) => code,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => anyhow::bail!(
            "{SPUTNIK_WASM} is missing: run `bash scripts/fetch-sputnik-wasm.sh` from the repo root first"
        ),
        Err(error) => anyhow::bail!("cannot read {SPUTNIK_WASM} ({error})"),
    };
    let hash = CryptoHash::hash(&code).to_string();
    anyhow::ensure!(
        hash == SPUTNIK_CODE_HASH,
        "{SPUTNIK_WASM} hashes to {hash}, expected {SPUTNIK_CODE_HASH}"
    );
    Ok(code)
}

/// The sandbox DAO that every record is filed on. alice.sandbox is the filer; she matches the
/// `all` Everyone role, which carries `*:AddProposal`, so she may file every kind.
struct TestDao {
    _sandbox: Sandbox,
    network: NetworkConfig,
    signer: Arc<Signer>,
    dao: Contract,
    alice: AccountId,
}

async fn setup() -> anyhow::Result<TestDao> {
    let code = sputnik_wasm()?;
    let sandbox = Sandbox::start_sandbox().await?;
    let network = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let signer = Signer::from_secret_key(DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;

    let root = DEFAULT_GENESIS_ACCOUNT;
    let dao_id: AccountId = format!("dao.{root}").parse()?;
    let alice: AccountId = format!("alice.{root}").parse()?;
    for (id, near) in [(&dao_id, 100), (&alice, 300)] {
        sandbox
            .create_account(id.clone())
            .initial_balance(NearToken::from_near(near))
            .send()
            .await?;
    }

    let policy: Value = serde_json::from_str(HARNESS_POLICY)?;
    let config = json!({ "name": "kaap-eval", "purpose": "planted eval DAO", "metadata": "" });

    Contract::deploy(dao_id.clone())
        .use_code(code)
        .with_init_call("new", json!({ "config": config, "policy": policy }))?
        .max_gas()
        .with_signer(signer.clone())
        .send_to(&network)
        .await?
        .into_result()?;

    let deployed = Account(dao_id.clone())
        .view()
        .fetch_from(&network)
        .await?
        .data;
    anyhow::ensure!(
        deployed.contract_state == ContractState::LocalHash(SPUTNIK_CODE_HASH.parse()?),
        "dao is running {:?}, not Sputnik 3.2",
        deployed.contract_state
    );

    Ok(TestDao {
        _sandbox: sandbox,
        network,
        signer,
        dao: Contract(dao_id),
        alice,
    })
}

impl TestDao {
    async fn view(&self, method: &str, args: Value) -> anyhow::Result<Value> {
        Ok(self
            .dao
            .call_function(method, args)
            .read_only::<Value>()
            .fetch_from(&self.network)
            .await?
            .data)
    }

    async fn proposal_bond(&self) -> anyhow::Result<u128> {
        let policy = self.view("get_policy", json!({})).await?;
        Ok(policy["proposal_bond"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("policy has no proposal_bond"))?
            .parse()?)
    }

    async fn stored_kind(&self, id: u64) -> anyhow::Result<Value> {
        let proposal = self.view("get_proposal", json!({ "id": id })).await?;
        Ok(proposal["kind"].clone())
    }

    /// Files one record and hands back the id the DAO assigned it. Attaches exactly the bond
    /// the live policy asks for.
    async fn add_proposal(&self, description: &str, kind: &Value) -> anyhow::Result<u64> {
        let bond = self.proposal_bond().await?;
        let id = self
            .dao
            .call_function(
                "add_proposal",
                json!({ "proposal": { "description": description, "kind": kind } }),
            )
            .transaction()
            .deposit(NearToken::from_yoctonear(bond))
            .with_signer(self.alice.clone(), self.signer.clone())
            .send_to(&self.network)
            .await?
            .into_result()?
            .json::<u64>()?;
        Ok(id)
    }
}

#[tokio::test]
async fn files_every_planted_record() -> anyhow::Result<()> {
    let records = read_records()?;
    let t = setup().await?;

    let mut filed = 0usize;
    let mut attacks = 0usize;
    let mut controls = 0usize;
    for rec in &records {
        let rid = rec["id"].as_str().unwrap_or("<no id>");
        let description = rec["description"].as_str().unwrap_or("");
        let kind = &rec["kind"];

        let id = t
            .add_proposal(description, kind)
            .await
            .map_err(|e| anyhow::anyhow!("{rid}: add_proposal rejected the record: {e}"))?;

        let stored = t.stored_kind(id).await?;
        let mut norm_filed = kind.clone();
        let mut norm_stored = stored.clone();
        sort_string_arrays(&mut norm_filed);
        sort_string_arrays(&mut norm_stored);
        anyhow::ensure!(
            norm_filed == norm_stored,
            "{rid}: stored kind differs from the filed kind\n  filed:  {}\n  stored: {}",
            serde_json::to_string(kind)?,
            serde_json::to_string(&stored)?
        );

        anyhow::ensure!(rec["label"].is_object(), "{rid}: record is missing its label");
        anyhow::ensure!(
            rec["sandbox_accepted"] == json!(true),
            "{rid}: record is not marked sandbox_accepted"
        );

        match rec["attack"].as_str() {
            Some(a) if a.starts_with("control:") => controls += 1,
            _ => attacks += 1,
        }
        filed += 1;
    }

    println!("(files) filed {filed} records on dao.sandbox: {attacks} attacks, {controls} controls");
    println!("(files) every stored kind equalled the filed kind");
    anyhow::ensure!(filed == RECORDS, "expected {RECORDS} records, filed {filed}");
    anyhow::ensure!(attacks == ATTACKS, "expected {ATTACKS} attacks, got {attacks}");
    anyhow::ensure!(controls == CONTROLS, "expected {CONTROLS} controls, got {controls}");
    Ok(())
}

/// NEP-413 payload hash: sha256( u32 little-endian (2^31 + 413) ++ borsh(String message)
/// ++ 32 nonce bytes ++ borsh(String recipient) ++ 0x00 for no callback_url ).
fn nep413_hash(message: &str, nonce: &[u8], recipient: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut data: Vec<u8> = Vec::new();
    data.extend_from_slice(&(2147483648u32 + 413).to_le_bytes());
    data.extend_from_slice(&(message.len() as u32).to_le_bytes());
    data.extend_from_slice(message.as_bytes());
    data.extend_from_slice(nonce);
    data.extend_from_slice(&(recipient.len() as u32).to_le_bytes());
    data.extend_from_slice(recipient.as_bytes());
    data.push(0u8);
    let mut hasher = Sha256::new();
    hasher.update(&data);
    hex::encode(hasher.finalize())
}

/// Sputnik stores a role's `permissions` and a Group role's member list as hash sets, so it
/// serialises them back in an order of its own choosing. A set has no order, so before comparing
/// a stored kind with the filed kind we sort every array whose elements are all strings. In a
/// ProposalKind the only all-string arrays are those two sets; threshold pairs are numbers, and
/// `roles` and `actions` are arrays of objects, so none of the order-bearing arrays are touched.
fn sort_string_arrays(v: &mut Value) {
    match v {
        Value::Array(a) => {
            for e in a.iter_mut() {
                sort_string_arrays(e);
            }
            if a.iter().all(Value::is_string) {
                a.sort_by(|x, y| x.as_str().cmp(&y.as_str()));
            }
        }
        Value::Object(m) => {
            for (_k, val) in m.iter_mut() {
                sort_string_arrays(val);
            }
        }
        _ => {}
    }
}

fn eddsa_from_kind(kind: &Value) -> anyhow::Result<String> {
    use base64::Engine;
    let args_b64 = kind["FunctionCall"]["actions"][0]["args"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("kind is not a FunctionCall with args"))?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(args_b64)?;
    let args: Value = serde_json::from_slice(&bytes)?;
    Ok(args["request"]["payload_v2"]["Eddsa"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("args have no request.payload_v2.Eddsa"))?
        .to_owned())
}

fn text_field<'a>(supplied: &'a Value, rid: &str, field: &str) -> anyhow::Result<&'a str> {
    supplied[field]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("{rid}: supplied_text has no string {field}"))
}

#[tokio::test]
async fn hashes_match_intended_outcome() -> anyhow::Result<()> {
    use base64::Engine;
    let records = read_records()?;

    let mut checked = 0usize;
    for rec in &records {
        let Some(supplied) = rec.get("supplied_text") else {
            continue;
        };
        let rid = rec["id"].as_str().unwrap_or("<no id>");
        let message = text_field(supplied, rid, "message")?;
        let recipient = text_field(supplied, rid, "recipient")?;
        let nonce = base64::engine::general_purpose::STANDARD
            .decode(text_field(supplied, rid, "nonce")?)?;
        anyhow::ensure!(nonce.len() == 32, "{rid}: nonce is not 32 bytes");

        let recomputed = nep413_hash(message, &nonce, recipient);
        let on_chain = eddsa_from_kind(&rec["kind"])?;

        let findings: Vec<&str> = rec["label"]["findings"]
            .as_array()
            .map(|a| a.iter().filter_map(|f| f["code"].as_str()).collect())
            .unwrap_or_default();
        // A HASH_MISMATCH record must NOT recompute to its on-chain hash. Every other sign
        // record (HASH_TEXT_DANGEROUS and the honest auth control) must recompute exactly.
        let expect_match = !findings.contains(&"HASH_MISMATCH");

        let matched = recomputed == on_chain;
        println!(
            "(hash) {rid}: recomputed {}  on-chain {}  match={matched}  expected={expect_match}",
            &recomputed[..16],
            &on_chain[..16]
        );
        anyhow::ensure!(
            matched == expect_match,
            "{rid}: hash match was {matched}, label expected {expect_match}\n  recomputed: {recomputed}\n  on-chain:   {on_chain}"
        );
        checked += 1;
    }

    println!("(hash) checked {checked} sign records against their labelled outcome");
    anyhow::ensure!(checked == SIGN_RECORDS, "expected {SIGN_RECORDS} sign records, checked {checked}");
    Ok(())
}
