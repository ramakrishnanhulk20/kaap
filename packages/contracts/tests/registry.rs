// Proves kaap-registry in a local near-sandbox: it stores only verdicts the accepted key signed,
// keeps every verdict for a proposal side by side, refuses oversized ones, and charges the caller
// for the storage a record takes, refunding the rest, so the contract's own balance never pays.
//
// What this file does NOT cover:
// - testnet or mainnet, or the real sealed signer (common::SealedSigner holds a test key);
// - whether a verdict's content is right; the registry only checks who signed it;
// - many writers racing on one proposal in the same block;
// - C29's daily cap on registry writes per DAO, which belongs to the worker.

mod common;

use common::*;
use kaap_core::{Network, Severity, Verdict};
use near_api::types::transaction::result::ExecutionFinalResult;
use near_api::{AccountId, NearGas, NearToken};
use serde_json::{json, Value};

/// The protocol's storage price: 10^19 yoctoNEAR per byte (near-sdk `env::storage_byte_cost`).
const YOCTO_PER_BYTE: u128 = 10_000_000_000_000_000_000;

struct World {
    env: Env,
    registry: AccountId,
    worker: AccountId,
    dao: AccountId,
    sealed: SealedSigner,
}

async fn world() -> Result<World> {
    let env = Env::start().await?;
    let registry = env.account("registry", 20).await?;
    let worker = env.account("worker", 50).await?;
    let sealed = SealedSigner::test_key();
    env.deploy(
        &registry,
        contract_wasm("registry")?,
        "new",
        json!({ "accepted_key": sealed.public_key(), "network": NETWORK }),
    )
    .await?;
    // The registry never calls the DAO, so the DAO account only has to be a valid id.
    let dao: AccountId = format!("dao.{NETWORK}").parse()?;
    Ok(World { env, registry, worker, dao, sealed })
}

impl World {
    fn verdict(&self, proposal_id: u64, block_height: u64) -> Result<Verdict> {
        let guard: AccountId = format!("guard.{NETWORK}").parse()?;
        let kind = r#"{"Transfer":{"amount":"1","msg":null,"receiver_id":"a.sandbox","token_id":""}}"#;
        Ok(Verdict { block_height, ..vetoable_verdict(&guard, &self.dao, proposal_id, kind, u64::MAX)? })
    }

    async fn record_raw(
        &self,
        verdict_b64: &str,
        signature_b64: &str,
        deposit: NearToken,
    ) -> Result<ExecutionFinalResult> {
        self.env
            .call(
                &self.worker,
                &self.registry,
                "record",
                json!({ "verdict": verdict_b64, "signature": signature_b64 }),
                deposit,
                NearGas::from_tgas(50),
            )
            .await
    }

    async fn record(&self, verdict: &Verdict) -> Result<ExecutionFinalResult> {
        let (verdict_b64, signature_b64) = self.sealed.sign(verdict);
        self.record_raw(&verdict_b64, &signature_b64, NearToken::from_millinear(20)).await
    }

    async fn history(&self, proposal_id: u64) -> Result<Vec<Value>> {
        let page = self
            .env
            .view(
                &self.registry,
                "history",
                json!({ "network": NETWORK, "dao": self.dao, "proposal_id": proposal_id, "from": 0, "limit": 50 }),
            )
            .await?;
        page.as_array().cloned().ok_or_else(|| anyhow::anyhow!("history returned {page}"))
    }

    async fn latest(&self, proposal_id: u64) -> Result<Value> {
        self.env
            .view(
                &self.registry,
                "latest",
                json!({ "network": NETWORK, "dao": self.dao, "proposal_id": proposal_id }),
            )
            .await
    }
}

#[tokio::test]
async fn a_newer_verdict_is_stored_next_to_the_older_one_never_over_it() -> Result<()> {
    let w = world().await?;
    let first = w.verdict(3, 100)?;
    let second = Verdict { risk: Severity::High, ..w.verdict(3, 120)? };
    let index = w.record(&first).await?.into_result()?.json::<u32>()?;
    anyhow::ensure!(index == 0);
    let before = w.history(3).await?;

    let index = w.record(&second).await?.into_result()?.json::<u32>()?;
    anyhow::ensure!(index == 1);
    let history = w.history(3).await?;
    anyhow::ensure!(history.len() == 2, "history: {history:?}");
    anyhow::ensure!(history[0] == before[0], "the first record changed when the second arrived");
    anyhow::ensure!(history[1]["supersedes"] == json!(0), "{}", history[1]);
    anyhow::ensure!(history[1]["risk"] == json!("high"), "{}", history[1]);
    let (second_b64, second_signature) = w.sealed.sign(&second);
    let latest = w.latest(3).await?;
    anyhow::ensure!(latest["verdict"] == json!(second_b64), "{latest}");
    anyhow::ensure!(latest["signature"] == json!(second_signature), "{latest}");
    anyhow::ensure!(latest["verdict_hash"] == json!(verdict_hash_hex(&second)), "{latest}");

    // The same verdict again is refused, so an old verdict cannot be pushed back on top.
    assert_refused(w.record(&first).await?, "ERR_DUPLICATE")?;
    anyhow::ensure!(w.history(3).await?.len() == 2);
    Ok(())
}

#[tokio::test]
async fn err_too_large_for_a_verdict_over_the_cap() -> Result<()> {
    let w = world().await?;
    let (_, signature) = w.sealed.sign(&w.verdict(3, 100)?);
    // 1,025 bytes, one over MAX_VERDICT_BYTES.
    let oversized = b64(&[0u8; 1025]);
    let text = assert_refused(
        w.record_raw(&oversized, &signature, NearToken::from_millinear(20)).await?,
        "ERR_TOO_LARGE",
    )?;
    println!("oversized verdict refused with: {text}");
    // A real verdict padded past the cap through its free text field is refused the same way.
    let padded = Verdict { model_id: "m".repeat(1024), ..w.verdict(3, 100)? };
    let text = assert_refused(w.record(&padded).await?, "ERR_TOO_LARGE")?;
    println!("padded verdict refused with: {text}");
    anyhow::ensure!(w.latest(3).await? == Value::Null);
    Ok(())
}

#[tokio::test]
async fn err_bad_signature_from_another_key() -> Result<()> {
    let w = world().await?;
    let (verdict_b64, signature) = SealedSigner::other_key().sign(&w.verdict(3, 100)?);
    let text = assert_refused(
        w.record_raw(&verdict_b64, &signature, NearToken::from_millinear(20)).await?,
        "ERR_BAD_SIGNATURE",
    )?;
    println!("verdict signed by another key refused with: {text}");
    anyhow::ensure!(w.latest(3).await? == Value::Null);

    let wrong_network = Verdict { network: Network::Testnet, ..w.verdict(3, 100)? };
    assert_refused(w.record(&wrong_network).await?, "ERR_WRONG_NETWORK")?;
    Ok(())
}

#[tokio::test]
async fn storage_is_paid_by_the_caller_and_the_rest_is_refunded() -> Result<()> {
    let w = world().await?;
    let registry_before = w.env.account_view(&w.registry).await?;
    let worker_before = w.env.account_view(&w.worker).await?;
    let deposit = NearToken::from_near(1);

    let (verdict_b64, signature) = w.sealed.sign(&w.verdict(3, 100)?);
    let outcome = w.record_raw(&verdict_b64, &signature, deposit).await?;
    print_outcomes("record", &outcome);
    let recorded = events(&outcome)
        .into_iter()
        .find(|e| e["event"] == "verdict_recorded")
        .ok_or_else(|| anyhow::anyhow!("no verdict_recorded event"))?;
    outcome.into_result()?;

    let registry_after = w.env.account_view(&w.registry).await?;
    let worker_after = w.env.account_view(&w.worker).await?;
    let grown = registry_after.storage_usage - registry_before.storage_usage;
    let cost = u128::from(grown) * YOCTO_PER_BYTE;
    println!("record grew the registry by {grown} bytes, a storage cost of {cost} yoctoNEAR");
    anyhow::ensure!(recorded["data"][0]["storage_cost"] == json!(cost.to_string()), "{recorded}");
    let refund = deposit.as_yoctonear() - cost;
    anyhow::ensure!(recorded["data"][0]["refund"] == json!(refund.to_string()), "{recorded}");

    // The registry's free balance, what is left after its storage is paid for, did not shrink:
    // the caller's deposit covered every byte.
    let free = |a: &near_api::types::account::Account| {
        a.amount.as_yoctonear() as i128 - a.storage_usage as i128 * YOCTO_PER_BYTE as i128
    };
    anyhow::ensure!(
        free(&registry_after) >= free(&registry_before),
        "the registry paid for storage itself: free balance {} -> {}",
        free(&registry_before),
        free(&registry_after)
    );
    // The worker paid the storage cost plus gas, and got the rest of its 1 NEAR back.
    let spent = worker_before.amount.as_yoctonear() - worker_after.amount.as_yoctonear();
    let gas_paid = spent - cost;
    println!("the worker spent {spent} yoctoNEAR: {cost} for storage and {gas_paid} for gas");
    anyhow::ensure!(spent >= cost && gas_paid < NearToken::from_millinear(10).as_yoctonear());
    Ok(())
}

#[tokio::test]
async fn err_not_enough_deposit_when_the_storage_is_not_covered() -> Result<()> {
    let w = world().await?;
    let (verdict_b64, signature) = w.sealed.sign(&w.verdict(3, 100)?);
    let text = assert_refused(
        w.record_raw(&verdict_b64, &signature, NearToken::from_yoctonear(1)).await?,
        "ERR_NOT_ENOUGH_DEPOSIT",
    )?;
    println!("record with 1 yoctoNEAR refused with: {text}");
    anyhow::ensure!(w.latest(3).await? == Value::Null);
    Ok(())
}

/// Not a check of behaviour: prints the gas `record` and `history` burn, for
/// packages/contracts/GAS.md. Rerun with
/// `cargo test -p kaap-registry --test registry_sandbox gas_report -- --nocapture`.
#[tokio::test]
async fn gas_report() -> Result<()> {
    let w = world().await?;
    let first = w.record(&w.verdict(3, 100)?).await?;
    report_gas("record, first verdict for a proposal", &first);
    first.into_result()?;
    let next = w.record(&w.verdict(3, 101)?).await?;
    report_gas("record, a later verdict for the same proposal", &next);
    next.into_result()?;

    // The biggest verdict the cap allows: its free text fields padded to just under 1,024 bytes.
    let base = w.verdict(4, 100)?;
    let base_len = borsh::to_vec(&base)?.len();
    let largest = Verdict { model_id: "m".repeat(1024 - base_len + base.model_id.len()), ..base };
    anyhow::ensure!(borsh::to_vec(&largest)?.len() == 1024);
    let outcome = w.record(&largest).await?;
    report_gas("record, a verdict of exactly 1,024 bytes", &outcome);
    let cost = events(&outcome)
        .into_iter()
        .find(|e| e["event"] == "verdict_recorded")
        .map(|e| e["data"][0]["storage_cost"].clone());
    println!("GAS | record, a verdict of exactly 1,024 bytes | storage cost (yoctoNEAR) | {cost:?}");
    outcome.into_result()?;

    for height in 102..110 {
        w.record(&w.verdict(3, height)?).await?.into_result()?;
    }
    for limit in [1u64, 10] {
        let page = w
            .env
            .call(
                &w.worker,
                &w.registry,
                "history",
                json!({ "network": NETWORK, "dao": w.dao, "proposal_id": 3, "from": 0, "limit": limit }),
                NearToken::from_yoctonear(0),
                NearGas::from_tgas(300),
            )
            .await?;
        report_gas(&format!("history page of {limit}, called as a transaction"), &page);
        anyhow::ensure!(page.into_result()?.json::<Vec<Value>>()?.len() as u64 == limit);
    }
    Ok(())
}
