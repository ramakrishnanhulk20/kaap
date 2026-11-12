// Proves kaap-guard against the real Sputnik DAO 3.2 binary in a local near-sandbox. The guard is
// the only member of a reject-only Guard role; it casts VoteReject only for a fresh, single-use
// verdict signed by the accepted key that names it, this network, an enrolled DAO, the proposal
// and its kind, and it records every vote the DAO refuses.
//
// What this file does NOT cover:
// - testnet or mainnet: every test runs on its own throwaway sandbox (nearcore 2.13.4);
// - any Sputnik binary other than code hash DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF;
// - the real sealed signer or OutLayer: the test holds the signing key (common::SealedSigner);
// - TokenWeight voting, a Guard role with more than one member, or a guard matched by a second
//   role; C16's "disarmed" report belongs to the worker and the CLI;
// - kind shapes other than the two measured (`Shape`): one that costs more per byte than both
//   could need more than MIN_VETO_GAS at the size limit, and nothing here searches for one;
// - a DAO whose own current policy is large, which makes every vote in that DAO cost more than
//   in the two-role test DAO;
// - two vetoes for one proposal in the same block, or the guard account running out of storage
//   balance.

mod common;

use common::*;
use kaap_verdict::{AiStatus, FindingCode, Network, Severity, Verdict};
use near_api::types::transaction::result::ExecutionFinalResult;
use near_api::{AccountId, NearGas, NearToken};
use serde_json::{json, Value};

/// What a DAO attaches to `enroll`; the guard keeps the storage cost and sends the rest back.
const ENROL_DEPOSIT: NearToken = NearToken::from_millinear(10);

/// The least gas `veto` accepts, which every veto here attaches unless a test says otherwise.
const VETO_GAS: NearGas = NearGas::from_gas(kaap_guard::MIN_VETO_GAS.as_gas());
const MAX_VETO_KIND_BYTES: usize = kaap_guard::MAX_VETO_KIND_BYTES;
const KEY_CHANGE_DELAY_MS: u64 = kaap_guard::KEY_CHANGE_DELAY_MS;

struct World {
    env: Env,
    guard: AccountId,
    dao: AccountId,
    alice: AccountId,
    owner: AccountId,
    stranger: AccountId,
    sealed: SealedSigner,
}

/// A fresh sandbox with the guard deployed for the sandbox network, one Sputnik 3.2 DAO with the
/// guard as its only Guard member, and that DAO enrolled by its own approved proposal.
async fn world() -> Result<World> {
    world_on(Env::start().await?).await
}

/// `world` on a sandbox whose clock can skip a day in one jump.
async fn world_with_clock() -> Result<World> {
    world_on(Env::start_with_long_epochs().await?).await
}

async fn world_on(env: Env) -> Result<World> {
    let guard = env.account("guard", 30).await?;
    let dao = env.account("dao", 50).await?;
    let alice = env.account("alice", 200).await?;
    let owner = env.account("owner", 10).await?;
    let stranger = env.account("stranger", 50).await?;
    let sealed = SealedSigner::test_key();
    env.deploy(
        &guard,
        contract_wasm("guard")?,
        "new",
        json!({ "owner": owner, "accepted_key": sealed.public_key(), "network": NETWORK }),
    )
    .await?;
    env.deploy_sputnik(&dao, &alice, &guard).await?;
    let world = World { env, guard, dao, alice, owner, stranger, sealed };
    world.enroll(&world.dao).await?.into_result()?;
    Ok(world)
}

impl World {
    /// A second Sputnik 3.2 DAO with the same policy and the same guard in its Guard role.
    async fn add_dao(&self, name: &str, enroll: bool) -> Result<AccountId> {
        let dao = self.env.account(name, 50).await?;
        self.env.deploy_sputnik(&dao, &self.alice, &self.guard).await?;
        if enroll {
            self.enroll(&dao).await?.into_result()?;
        }
        Ok(dao)
    }

    /// Enrols `dao` the way a real DAO does: a FunctionCall proposal to `enroll` with `{}` that
    /// attaches the storage deposit, approved by its council. Returns the approval transaction,
    /// whose guard receipt is the enrolment itself.
    async fn enroll(&self, dao: &AccountId) -> Result<ExecutionFinalResult> {
        self.enroll_with(dao, json!({})).await
    }

    /// `enroll` with the arguments `args`.
    async fn enroll_with(&self, dao: &AccountId, args: Value) -> Result<ExecutionFinalResult> {
        let approval = self.dao_calls_guard(dao, "enroll", args, ENROL_DEPOSIT).await?;
        anyhow::ensure!(
            self.env.view(&self.guard, "is_enrolled", json!({ "dao": dao })).await? == json!(true),
            "{dao} approved its enrolment but the guard does not list it"
        );
        Ok(approval)
    }

    async fn veto_unreadable(&self, dao: &AccountId) -> Result<bool> {
        let on = self.env.view(&self.guard, "veto_unreadable", json!({ "dao": dao })).await?;
        on.as_bool().ok_or_else(|| anyhow::anyhow!("veto_unreadable returned {on}"))
    }

    /// `dao` files and approves a FunctionCall proposal that calls `method` on the guard with
    /// `args`, `deposit` and the 10 Tgas the guard README tells DAOs to give it.
    async fn dao_calls_guard(
        &self,
        dao: &AccountId,
        method: &str,
        args: Value,
        deposit: NearToken,
    ) -> Result<ExecutionFinalResult> {
        let kind = json!({ "FunctionCall": {
            "receiver_id": self.guard,
            "actions": [{
                "method_name": method,
                "args": b64(serde_json::to_string(&args)?.as_bytes()),
                "deposit": deposit.as_yoctonear().to_string(),
                "gas": NearGas::from_tgas(10).as_gas().to_string()
            }]
        }});
        let id = self.env.add_proposal(dao, &self.alice, kind).await?;
        let stored = self.env.proposal(dao, id).await?["kind"].clone();
        let approval = self
            .env
            .call(
                &self.alice,
                dao,
                "act_proposal",
                json!({ "id": id, "action": "VoteApprove", "proposal": stored }),
                NearToken::from_yoctonear(0),
                NearGas::from_tgas(300),
            )
            .await?;
        Ok(approval)
    }

    async fn file_transfer(&self, dao: &AccountId, near: u128) -> Result<u64> {
        let kind = json!({ "Transfer": {
            "token_id": "",
            "receiver_id": self.alice,
            "amount": NearToken::from_near(near).as_yoctonear().to_string(),
            "msg": null
        }});
        self.env.add_proposal(dao, &self.alice, kind).await
    }

    /// The kind as the DAO stores it, and a vetoable verdict for it that expires in ten minutes.
    async fn fresh(&self, dao: &AccountId, id: u64) -> Result<(String, Verdict)> {
        let kind_json = self.env.kind_json(dao, id).await?;
        let expires = self.env.chain_time_ms().await? + TEN_MINUTES_MS;
        let verdict = vetoable_verdict(&self.guard, dao, id, &kind_json, expires)?;
        Ok((kind_json, verdict))
    }

    async fn veto(&self, verdict: &Verdict, kind_json: &str) -> Result<ExecutionFinalResult> {
        let (verdict_b64, signature_b64) = self.sealed.sign(verdict);
        self.veto_raw(&verdict_b64, &signature_b64, kind_json).await
    }

    /// `veto` from the stranger, who holds no role anywhere and only carries the verdict.
    async fn veto_raw(
        &self,
        verdict_b64: &str,
        signature_b64: &str,
        kind_json: &str,
    ) -> Result<ExecutionFinalResult> {
        self.veto_raw_with_gas(verdict_b64, signature_b64, kind_json, VETO_GAS).await
    }

    /// `veto_raw` with the gas the stranger chooses to attach.
    async fn veto_raw_with_gas(
        &self,
        verdict_b64: &str,
        signature_b64: &str,
        kind_json: &str,
        gas: NearGas,
    ) -> Result<ExecutionFinalResult> {
        self.env
            .call(
                &self.stranger,
                &self.guard,
                "veto",
                json!({ "verdict": verdict_b64, "signature": signature_b64, "kind_json": kind_json }),
                NearToken::from_yoctonear(0),
                gas,
            )
            .await
    }

    async fn was_used(&self, verdict: &Verdict) -> Result<bool> {
        let used = self
            .env
            .view(&self.guard, "was_used", json!({ "verdict_hash_hex": verdict_hash_hex(verdict) }))
            .await?;
        used.as_bool().ok_or_else(|| anyhow::anyhow!("was_used returned {used}"))
    }

    async fn veto_result(&self, verdict: &Verdict) -> Result<Value> {
        self.env
            .view(&self.guard, "veto_result", json!({ "verdict_hash_hex": verdict_hash_hex(verdict) }))
            .await
    }

    async fn votes(&self, dao: &AccountId, id: u64) -> Result<Value> {
        Ok(self.env.proposal(dao, id).await?["votes"].clone())
    }

    /// The refusal names `error`, the proposal is still open, and the verdict was not spent.
    async fn assert_refused_untouched(
        &self,
        outcome: ExecutionFinalResult,
        error: &str,
        dao: &AccountId,
        id: u64,
        verdict: &Verdict,
    ) -> Result<()> {
        let text = assert_refused(outcome, error)?;
        println!("refused with: {text}");
        anyhow::ensure!(self.env.status(dao, id).await? == "InProgress");
        anyhow::ensure!(!self.was_used(verdict).await?, "a refused verdict was marked used");
        Ok(())
    }

    /// The vote landed: the proposal is Rejected and the guard's Reject is its only vote.
    async fn assert_rejected_by_guard(&self, dao: &AccountId, id: u64) -> Result<()> {
        anyhow::ensure!(self.env.status(dao, id).await? == "Rejected");
        let votes = self.votes(dao, id).await?;
        anyhow::ensure!(votes == json!({ self.guard.as_str(): "Reject" }), "votes: {votes}");
        Ok(())
    }

    async fn set_accepted_key(
        &self,
        caller: &AccountId,
        key: &str,
        deposit_yocto: u128,
    ) -> Result<ExecutionFinalResult> {
        self.env
            .call(
                caller,
                &self.guard,
                "set_accepted_key",
                json!({ "key": key }),
                NearToken::from_yoctonear(deposit_yocto),
                NearGas::from_tgas(30),
            )
            .await
    }

    /// Calls a guard method that takes no arguments, with 30 Tgas.
    async fn call_guard(&self, caller: &AccountId, method: &str, deposit_yocto: u128) -> Result<ExecutionFinalResult> {
        self.env
            .call(caller, &self.guard, method, json!({}), NearToken::from_yoctonear(deposit_yocto), NearGas::from_tgas(30))
            .await
    }

    async fn accepted_key(&self) -> Result<Value> {
        self.env.view(&self.guard, "accepted_key", json!({})).await
    }

    async fn pending_key(&self) -> Result<Value> {
        self.env.view(&self.guard, "pending_key", json!({})).await
    }

    /// The owner announces `key`; returns the time it may take effect, after checking the event.
    async fn announce(&self, key: &str) -> Result<u64> {
        let before = self.env.chain_time_ms().await?;
        let outcome = self.set_accepted_key(&self.owner, key, 1).await?;
        let after = self.env.chain_time_ms().await?;
        let all = events(&outcome);
        outcome.into_result()?;
        let announced = event(&all, "key_change_announced")?;
        let entry = &announced["data"][0];
        anyhow::ensure!(entry["old_key"] == self.accepted_key().await?, "{announced}");
        anyhow::ensure!(entry["new_key"] == json!(key), "{announced}");
        let due = entry["effective_at_ms"]
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("no effective_at_ms in {announced}"))?;
        anyhow::ensure!(
            (before + KEY_CHANGE_DELAY_MS..=after + KEY_CHANGE_DELAY_MS).contains(&due),
            "the change is due at {due}, not a day after the announcement ({before} to {after})"
        );
        anyhow::ensure!(self.pending_key().await? == json!({ "key": key, "effective_at_ms": due }));
        Ok(due)
    }
}

fn event<'a>(all: &'a [Value], name: &str) -> Result<&'a Value> {
    all.iter()
        .find(|e| e["standard"] == "kaap-guard" && e["event"] == name)
        .ok_or_else(|| anyhow::anyhow!("no {name} event in {all:?}"))
}

#[tokio::test]
async fn valid_veto_rejects_the_proposal_and_the_dao_records_the_guards_vote() -> Result<()> {
    let w = world().await?;
    let id = w.file_transfer(&w.dao, 5).await?;
    let (kind_json, verdict) = w.fresh(&w.dao, id).await?;

    let outcome = w.veto(&verdict, &kind_json).await?;
    print_outcomes("valid veto", &outcome);
    let all = events(&outcome);
    outcome.into_result()?;

    w.assert_rejected_by_guard(&w.dao, id).await?;
    anyhow::ensure!(w.was_used(&verdict).await?);
    anyhow::ensure!(w.veto_result(&verdict).await? == json!("Ok"));
    let sent = event(&all, "veto_sent")?;
    anyhow::ensure!(sent["data"][0]["dao"] == json!(w.dao), "{sent}");
    anyhow::ensure!(sent["data"][0]["proposal_id"] == json!(id), "{sent}");
    let cast = event(&all, "veto_cast")?;
    anyhow::ensure!(cast["data"][0]["verdict_hash"] == json!(verdict_hash_hex(&verdict)), "{cast}");
    Ok(())
}

#[tokio::test]
async fn enrolment_storage_is_paid_by_the_dao_and_refunded_when_it_leaves() -> Result<()> {
    let w = world().await?;
    let dao = w.add_dao("dao-pays", false).await?;
    // The guard's free balance: what is left after its own storage is paid for.
    let free = |a: &near_api::types::account::Account| {
        a.amount.as_yoctonear() as i128 - a.storage_usage as i128 * 10_i128.pow(19)
    };
    let start = w.env.account_view(&w.guard).await?;

    w.enroll_with(&dao, json!({ "veto_unreadable": true })).await?.into_result()?;
    let enrolled = w.env.account_view(&w.guard).await?;
    let added = enrolled.storage_usage - start.storage_usage;
    let kept = enrolled.amount.as_yoctonear() - start.amount.as_yoctonear();
    println!("enrolment added {added} bytes; the guard kept {kept} yoctoNEAR of the 0.01 NEAR deposit");
    anyhow::ensure!(added > 0 && free(&enrolled) >= free(&start), "the guard paid for the enrolment");
    anyhow::ensure!(kept < ENROL_DEPOSIT.as_yoctonear() / 2, "the excess deposit was not refunded");

    // The setting was paid for with the enrolment, so changing it adds nothing.
    let zero = NearToken::from_yoctonear(0);
    w.dao_calls_guard(&dao, "set_veto_unreadable", json!({ "on": false }), zero).await?.into_result()?;
    anyhow::ensure!(!w.veto_unreadable(&dao).await?, "the mode did not change");
    let changed = w.env.account_view(&w.guard).await?;
    anyhow::ensure!(changed.storage_usage == enrolled.storage_usage, "changing the mode added storage");
    w.dao_calls_guard(&dao, "set_veto_unreadable", json!({ "on": true }), zero).await?.into_result()?;

    w.dao_calls_guard(&dao, "unenroll", json!({}), zero).await?.into_result()?;
    let left = w.env.account_view(&w.guard).await?;
    println!("unenrolment freed {} bytes", enrolled.storage_usage - left.storage_usage);
    anyhow::ensure!(left.storage_usage == start.storage_usage, "unenrolment left storage behind");
    anyhow::ensure!(free(&left) >= free(&start), "the unenrolment refund came out of the guard's own balance");
    anyhow::ensure!(w.env.view(&w.guard, "is_enrolled", json!({ "dao": dao })).await? == json!(false));
    anyhow::ensure!(!w.veto_unreadable(&dao).await?, "unenrolment kept the strict setting");

    let text = assert_refused(
        w.env.call(&w.stranger, &w.guard, "enroll", json!({}), NearToken::from_yoctonear(0), NearGas::from_tgas(30)).await?,
        "ERR_NOT_ENOUGH_DEPOSIT",
    )?;
    println!("enroll with no deposit refused with: {text}");
    Ok(())
}

#[tokio::test]
async fn err_bad_verdict_for_bytes_that_are_not_a_verdict() -> Result<()> {
    let w = world().await?;
    let id = w.file_transfer(&w.dao, 5).await?;
    let (kind_json, verdict) = w.fresh(&w.dao, id).await?;
    let (_, signature) = w.sealed.sign(&verdict);
    let outcome = w.veto_raw(&b64(b"not a verdict"), &signature, &kind_json).await?;
    w.assert_refused_untouched(outcome, "ERR_BAD_VERDICT", &w.dao, id, &verdict).await
}

#[tokio::test]
async fn err_bad_signature_from_another_key() -> Result<()> {
    let w = world().await?;
    let id = w.file_transfer(&w.dao, 5).await?;
    let (kind_json, verdict) = w.fresh(&w.dao, id).await?;
    let (verdict_b64, signature) = SealedSigner::other_key().sign(&verdict);
    let outcome = w.veto_raw(&verdict_b64, &signature, &kind_json).await?;
    w.assert_refused_untouched(outcome, "ERR_BAD_SIGNATURE", &w.dao, id, &verdict).await
}

#[tokio::test]
async fn err_wrong_guard_for_a_verdict_naming_another_guard() -> Result<()> {
    let w = world().await?;
    let id = w.file_transfer(&w.dao, 5).await?;
    let (kind_json, verdict) = w.fresh(&w.dao, id).await?;
    let for_other = Verdict { guard: format!("other-guard.{NETWORK}"), ..verdict };
    let outcome = w.veto(&for_other, &kind_json).await?;
    w.assert_refused_untouched(outcome, "ERR_WRONG_GUARD", &w.dao, id, &for_other).await
}

#[tokio::test]
async fn err_wrong_guard_for_a_verdict_naming_another_network() -> Result<()> {
    let w = world().await?;
    let id = w.file_transfer(&w.dao, 5).await?;
    let (kind_json, verdict) = w.fresh(&w.dao, id).await?;
    for network in [Network::Testnet, Network::Mainnet] {
        let elsewhere = Verdict { network, ..verdict.clone() };
        let outcome = w.veto(&elsewhere, &kind_json).await?;
        w.assert_refused_untouched(outcome, "ERR_WRONG_GUARD", &w.dao, id, &elsewhere).await?;
    }
    Ok(())
}

#[tokio::test]
async fn a_verdict_for_one_dao_cannot_be_turned_on_another() -> Result<()> {
    let w = world().await?;
    let dao_y = w.add_dao("dao-y", true).await?;
    let id_x = w.file_transfer(&w.dao, 5).await?;
    let id_y = w.file_transfer(&dao_y, 5).await?;
    anyhow::ensure!(id_x == id_y, "both DAOs must hold the same proposal id");
    let (kind_json, for_x) = w.fresh(&w.dao, id_x).await?;
    anyhow::ensure!(kind_json == w.env.kind_json(&dao_y, id_y).await?, "both kinds must match");

    // The attacker rewrites the DAO inside the verdict and keeps the signature made for X.
    let (_, signature_for_x) = w.sealed.sign(&for_x);
    let rewritten = Verdict { dao: dao_y.to_string(), ..for_x.clone() };
    let (rewritten_b64, _) = w.sealed.sign(&rewritten);
    let outcome = w.veto_raw(&rewritten_b64, &signature_for_x, &kind_json).await?;
    w.assert_refused_untouched(outcome, "ERR_BAD_SIGNATURE", &dao_y, id_y, &rewritten).await?;
    anyhow::ensure!(w.env.status(&w.dao, id_x).await? == "InProgress");
    Ok(())
}

#[tokio::test]
async fn err_not_enrolled_for_a_dao_that_never_enrolled() -> Result<()> {
    let w = world().await?;
    // This DAO gives the guard its Guard role but never voted to enrol.
    let dao_z = w.add_dao("dao-z", false).await?;
    let id = w.file_transfer(&dao_z, 5).await?;
    let (kind_json, verdict) = w.fresh(&dao_z, id).await?;
    let outcome = w.veto(&verdict, &kind_json).await?;
    w.assert_refused_untouched(outcome, "ERR_NOT_ENROLLED", &dao_z, id, &verdict).await
}

#[tokio::test]
async fn err_not_vetoable_for_an_ai_only_critical_on_a_medium_floor() -> Result<()> {
    let w = world().await?;
    let id = w.file_transfer(&w.dao, 5).await?;
    let (kind_json, verdict) = w.fresh(&w.dao, id).await?;
    let ai_only = Verdict {
        floor: Severity::Medium,
        findings: vec![FindingCode::NewRecipient],
        ai_status: AiStatus::Verified,
        ..verdict
    };
    let outcome = w.veto(&ai_only, &kind_json).await?;
    w.assert_refused_untouched(outcome, "ERR_NOT_VETOABLE", &w.dao, id, &ai_only).await
}

#[tokio::test]
async fn a_high_floor_raised_to_critical_needs_a_verified_ai_answer() -> Result<()> {
    let w = world().await?;
    let id = w.file_transfer(&w.dao, 5).await?;
    let (kind_json, verdict) = w.fresh(&w.dao, id).await?;
    let on_high_floor = |ai_status| Verdict {
        floor: Severity::High,
        findings: vec![FindingCode::PolicyAddsApprover],
        ai_status,
        ..verdict.clone()
    };
    for status in [AiStatus::Unverified, AiStatus::Unavailable] {
        let unproven = on_high_floor(status);
        let outcome = w.veto(&unproven, &kind_json).await?;
        w.assert_refused_untouched(outcome, "ERR_NOT_VETOABLE", &w.dao, id, &unproven).await?;
    }
    let proven = on_high_floor(AiStatus::Verified);
    w.veto(&proven, &kind_json).await?.into_result()?;
    w.assert_rejected_by_guard(&w.dao, id).await
}

#[tokio::test]
async fn err_not_vetoable_when_the_only_finding_is_hash_unverified() -> Result<()> {
    let w = world().await?;
    let id = w.file_transfer(&w.dao, 5).await?;
    let (kind_json, verdict) = w.fresh(&w.dao, id).await?;
    for floor in [Severity::High, Severity::Critical] {
        let unseen_text = Verdict {
            floor,
            findings: vec![FindingCode::HashUnverified],
            ai_status: AiStatus::Verified,
            ..verdict.clone()
        };
        let outcome = w.veto(&unseen_text, &kind_json).await?;
        w.assert_refused_untouched(outcome, "ERR_NOT_VETOABLE", &w.dao, id, &unseen_text).await?;
    }
    Ok(())
}

#[tokio::test]
async fn hash_unverified_needs_a_high_code_beside_it_to_back_a_veto() -> Result<()> {
    let w = world().await?;
    let id = w.file_transfer(&w.dao, 5).await?;
    let (kind_json, verdict) = w.fresh(&w.dao, id).await?;
    let beside = |other| Verdict {
        floor: Severity::High,
        findings: vec![FindingCode::HashUnverified, other],
        ai_status: AiStatus::Verified,
        ..verdict.clone()
    };
    let medium = beside(FindingCode::NewRecipient);
    let outcome = w.veto(&medium, &kind_json).await?;
    w.assert_refused_untouched(outcome, "ERR_NOT_VETOABLE", &w.dao, id, &medium).await?;

    w.veto(&beside(FindingCode::PolicyAddsApprover), &kind_json).await?.into_result()?;
    w.assert_rejected_by_guard(&w.dao, id).await
}

/// A request that shows only a hash Kaap could not read: no other finding, risk Unknown.
fn hash_only(verdict: Verdict) -> Verdict {
    Verdict {
        risk: Severity::Unknown,
        floor: Severity::Unknown,
        findings: vec![FindingCode::HashUnverified],
        ai_status: AiStatus::Unavailable,
        ..verdict
    }
}

/// C8: an unread hash alerts by default and is vetoed only for a treasury that chose it at
/// enrolment. The same verdict is refused, then lands once its DAO enrols again in strict mode.
#[tokio::test]
async fn strict_mode_is_chosen_at_enrolment_and_vetoes_a_hash_only_request() -> Result<()> {
    let w = world().await?;
    anyhow::ensure!(!w.veto_unreadable(&w.dao).await?, "a DAO enrolled with {{}} must not be strict");
    let id = w.file_transfer(&w.dao, 5).await?;
    let (kind_json, verdict) = w.fresh(&w.dao, id).await?;
    let unread = hash_only(verdict);
    let outcome = w.veto(&unread, &kind_json).await?;
    w.assert_refused_untouched(outcome, "ERR_NOT_VETOABLE", &w.dao, id, &unread).await?;

    let zero = NearToken::from_yoctonear(0);
    w.dao_calls_guard(&w.dao, "unenroll", json!({}), zero).await?.into_result()?;
    let approval = w.enroll_with(&w.dao, json!({ "veto_unreadable": true })).await?;
    let all = events(&approval);
    approval.into_result()?;
    let enrolled = event(&all, "enrolled")?;
    anyhow::ensure!(enrolled["data"] == json!([{ "dao": w.dao, "veto_unreadable": true }]), "{enrolled}");
    anyhow::ensure!(w.veto_unreadable(&w.dao).await?);

    let outcome = w.veto(&unread, &kind_json).await?;
    print_outcomes("hash-only verdict on a strict DAO", &outcome);
    outcome.into_result()?;
    w.assert_rejected_by_guard(&w.dao, id).await?;
    anyhow::ensure!(w.veto_result(&unread).await? == json!("Ok"));

    // Every verdict without HASH_UNVERIFIED still meets the ordinary rule or nothing.
    let id = w.file_transfer(&w.dao, 5).await?;
    let (kind_json, verdict) = w.fresh(&w.dao, id).await?;
    let ai_only = Verdict {
        floor: Severity::Medium,
        findings: vec![FindingCode::NewRecipient],
        ai_status: AiStatus::Verified,
        ..verdict.clone()
    };
    let outcome = w.veto(&ai_only, &kind_json).await?;
    w.assert_refused_untouched(outcome, "ERR_NOT_VETOABLE", &w.dao, id, &ai_only).await?;
    w.veto(&verdict, &kind_json).await?.into_result()?;
    w.assert_rejected_by_guard(&w.dao, id).await
}

#[tokio::test]
async fn only_an_enrolled_dao_sets_its_own_mode_and_each_change_is_announced() -> Result<()> {
    let w = world().await?;
    let zero = NearToken::from_yoctonear(0);
    let text = assert_refused(
        w.env.call(&w.stranger, &w.guard, "set_veto_unreadable", json!({ "on": true }), zero, NearGas::from_tgas(30)).await?,
        "ERR_NOT_ENROLLED",
    )?;
    println!("set_veto_unreadable from an account that never enrolled refused with: {text}");
    anyhow::ensure!(!w.veto_unreadable(&w.stranger).await?);

    for on in [true, false] {
        let approval = w.dao_calls_guard(&w.dao, "set_veto_unreadable", json!({ "on": on }), zero).await?;
        let all = events(&approval);
        approval.into_result()?;
        let changed = event(&all, "mode_changed")?;
        anyhow::ensure!(changed["data"] == json!([{ "dao": w.dao, "veto_unreadable": on }]), "{changed}");
        anyhow::ensure!(w.veto_unreadable(&w.dao).await? == on, "the view did not follow the change to {on}");
    }
    Ok(())
}

#[tokio::test]
async fn err_expired_one_millisecond_after_expiry() -> Result<()> {
    let w = world().await?;
    let id = w.file_transfer(&w.dao, 5).await?;
    let (kind_json, verdict) = w.fresh(&w.dao, id).await?;
    let expired = Verdict { expires_at_ms: w.env.chain_time_ms().await? - 1, ..verdict };
    let outcome = w.veto(&expired, &kind_json).await?;
    w.assert_refused_untouched(outcome, "ERR_EXPIRED", &w.dao, id, &expired).await
}

#[tokio::test]
async fn err_wrong_kind_hash_for_a_kind_the_verdict_did_not_review() -> Result<()> {
    let w = world().await?;
    let id = w.file_transfer(&w.dao, 5).await?;
    let (kind_json, verdict) = w.fresh(&w.dao, id).await?;
    let other_kind = kind_json.replace(
        &NearToken::from_near(5).as_yoctonear().to_string(),
        &NearToken::from_near(4).as_yoctonear().to_string(),
    );
    anyhow::ensure!(other_kind != kind_json);
    let outcome = w.veto(&verdict, &other_kind).await?;
    w.assert_refused_untouched(outcome, "ERR_WRONG_KIND_HASH", &w.dao, id, &verdict).await
}

#[tokio::test]
async fn err_bad_kind_for_a_kind_that_is_not_json() -> Result<()> {
    let w = world().await?;
    let id = w.file_transfer(&w.dao, 5).await?;
    let (_, verdict) = w.fresh(&w.dao, id).await?;
    let outcome = w.veto(&verdict, "{\"Transfer\": not json").await?;
    w.assert_refused_untouched(outcome, "ERR_BAD_KIND", &w.dao, id, &verdict).await
}

#[tokio::test]
async fn err_replay_of_the_same_verdict() -> Result<()> {
    let w = world().await?;
    let first = w.file_transfer(&w.dao, 5).await?;
    let second = w.file_transfer(&w.dao, 5).await?;
    let (kind_json, verdict) = w.fresh(&w.dao, first).await?;
    w.veto(&verdict, &kind_json).await?.into_result()?;
    w.assert_rejected_by_guard(&w.dao, first).await?;

    let replayed = assert_refused(w.veto(&verdict, &kind_json).await?, "ERR_REPLAY")?;
    println!("identical veto a second time refused with: {replayed}");
    // The same verdict moved onto another proposal id no longer matches its signature.
    let (_, signature) = w.sealed.sign(&verdict);
    let moved = Verdict { proposal_id: second, ..verdict };
    let (moved_b64, _) = w.sealed.sign(&moved);
    let outcome = w.veto_raw(&moved_b64, &signature, &kind_json).await?;
    w.assert_refused_untouched(outcome, "ERR_BAD_SIGNATURE", &w.dao, second, &moved).await
}

#[tokio::test]
async fn a_kind_with_its_sets_in_another_order_is_accepted_and_the_vote_lands() -> Result<()> {
    let w = world().await?;
    let kind = json!({ "ChangePolicyAddOrUpdateRole": { "role": {
        "name": "treasurers",
        "kind": { "Group": [format!("carol.{NETWORK}"), format!("alice.{NETWORK}"), format!("bob.{NETWORK}")] },
        "permissions": ["transfer:AddProposal", "call:AddProposal", "transfer:VoteApprove", "config:AddProposal"],
        "vote_policy": {
            "transfer": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 2] },
            "call": { "weight_kind": "RoleWeight", "quorum": "1", "threshold": [2, 3] },
            "config": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 1] }
        }
    }}});
    let id = w.env.add_proposal(&w.dao, &w.alice, kind).await?;
    let (read_kind, verdict) = w.fresh(&w.dao, id).await?;

    // The same kind with every set and every map written in reverse, and the role's keys too.
    let read: Value = serde_json::from_str(&read_kind)?;
    let role = &read["ChangePolicyAddOrUpdateRole"]["role"];
    let reversed = |items: &Value| -> Result<String> {
        let mut items = items.as_array().cloned().ok_or_else(|| anyhow::anyhow!("not a list"))?;
        items.reverse();
        Ok(serde_json::to_string(&items)?)
    };
    let vote_policy = role["vote_policy"]
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("no vote_policy map"))?
        .iter()
        .rev()
        .map(|(label, rule)| format!("{}:{rule}", Value::String(label.clone())))
        .collect::<Vec<_>>()
        .join(",");
    let reordered = format!(
        "{{\"ChangePolicyAddOrUpdateRole\":{{\"role\":{{\"vote_policy\":{{{vote_policy}}},\"permissions\":{},\"kind\":{{\"Group\":{}}},\"name\":{}}}}}}}",
        reversed(&role["permissions"])?,
        reversed(&role["kind"]["Group"])?,
        role["name"]
    );
    println!("kind as read:  {read_kind}");
    println!("kind as sent:  {reordered}");
    anyhow::ensure!(reordered != read_kind, "the reordered text must differ byte for byte");
    anyhow::ensure!(
        kaap_verdict::kind_hash(reordered.as_bytes()).ok() == Some(verdict.kind_hash),
        "the canonical hash must absorb the new order"
    );

    let outcome = w.veto(&verdict, &reordered).await?;
    print_outcomes("reordered kind", &outcome);
    outcome.into_result()?;
    w.assert_rejected_by_guard(&w.dao, id).await?;
    anyhow::ensure!(w.veto_result(&verdict).await? == json!("Ok"));
    Ok(())
}

/// The kind is exactly as long as kaap-verdict's canonical form of it, the rule `veto` applies.
fn ensure_canonical_length(source: &str, kind: &str) -> Result<()> {
    let canonical = kaap_verdict::canonical_kind(kind.as_bytes())
        .map_err(|error| anyhow::anyhow!("{source}: {error}"))?;
    anyhow::ensure!(
        canonical.len() == kind.len(),
        "{source}: the kind is {} bytes and its canonical form {}: {}",
        kind.len(),
        canonical.len(),
        kind.chars().take(300).collect::<String>()
    );
    Ok(())
}

/// Every `get_proposal` answer recorded from testnet and mainnet in the CLI's fixtures, and every
/// proposal inside a recorded `get_proposals` answer, as the RPC returned it. The worker forwards
/// these exact bytes, so none may break the guard's length rule.
#[test]
fn every_recorded_kind_is_as_long_as_its_canonical_form() -> Result<()> {
    let mut paths: Vec<_> = std::fs::read_dir(repo_path("packages/cli/test/fixtures"))?
        .map(|entry| entry.map(|e| e.path()))
        .collect::<Result<_, _>>()?;
    paths.sort();
    let (mut single, mut listed) = (0, 0);
    for path in paths.iter().filter(|p| p.extension().is_some_and(|e| e == "json")) {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("?");
        let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
        for exchange in fixture["exchanges"].as_array().into_iter().flatten() {
            let Some(body) = exchange["body"].as_str().and_then(|b| serde_json::from_str::<Value>(b).ok())
            else {
                continue;
            };
            let method = body["params"]["method_name"].as_str().unwrap_or_default();
            if method != "get_proposal" && method != "get_proposals" {
                continue;
            }
            let answer: Value = serde_json::from_str(exchange["text"].as_str().unwrap_or("null"))?;
            let Some(text) = answer["result"]["result_text"].as_str() else {
                continue;
            };
            let proposals = if method == "get_proposal" { vec![text] } else { raw_items(text)? };
            for proposal in proposals {
                ensure_canonical_length(&format!("{name} {method}"), raw_field(proposal, "kind")?)?;
                if method == "get_proposal" {
                    single += 1;
                } else {
                    listed += 1;
                }
            }
        }
    }
    println!("{single} recorded get_proposal kinds and {listed} kinds inside get_proposals answers, each at its canonical length");
    anyhow::ensure!(single > 0 && listed > 0, "the fixtures hold no proposal answers");
    Ok(())
}

/// Every planted evaluation record, filed on the real Sputnik 3.2 binary and read back raw.
#[tokio::test]
async fn every_planted_kind_reads_back_from_sputnik_at_its_canonical_length() -> Result<()> {
    let w = world().await?;
    let records = std::fs::read_to_string(repo_path("eval/planted/planted.jsonl"))?;
    let mut filed = 0;
    for line in records.lines().filter(|line| !line.trim().is_empty()) {
        let record: Value = serde_json::from_str(line)?;
        let name = record["id"].as_str().unwrap_or("?").to_owned();
        let id = w
            .env
            .add_proposal(&w.dao, &w.alice, record["kind"].clone())
            .await
            .map_err(|error| anyhow::anyhow!("{name}: add_proposal refused it: {error}"))?;
        ensure_canonical_length(&name, &w.env.kind_json(&w.dao, id).await?)?;
        filed += 1;
    }
    println!("{filed} planted kinds read back from Sputnik, each at its canonical length");
    anyhow::ensure!(filed == 73, "expected the 73 planted records, filed {filed}");
    Ok(())
}

/// The guard's own receipt succeeded, the DAO's failed with `dao_error`, the callback recorded
/// the refusal and said so, and the proposal kept the status `status`.
async fn assert_refusal_recorded(
    w: &World,
    outcome: ExecutionFinalResult,
    dao_error: &str,
    id: u64,
    verdict: &Verdict,
    status: &str,
) -> Result<()> {
    print_outcomes("refused vote", &outcome);
    let guard_steps = step_on(&outcome, &w.guard)?;
    anyhow::ensure!(guard_steps.len() == 2, "expected veto and on_veto_result on the guard");
    for step in &guard_steps {
        anyhow::ensure!(step.is_success(), "a guard receipt failed: {step:?}");
    }
    let dao_step = step_on(&outcome, &w.dao)?[0].clone();
    let dao_failure = match dao_step.into_result() {
        Ok(_) => anyhow::bail!("the DAO accepted the vote"),
        Err(error) => receipt_error(&error),
    };
    anyhow::ensure!(dao_failure.contains(dao_error), "DAO receipt: {dao_failure}");
    let refused = event(&events(&outcome), "veto_refused")?.clone();
    anyhow::ensure!(refused["data"][0]["verdict_hash"] == json!(verdict_hash_hex(verdict)));
    anyhow::ensure!(refused["data"][0]["result"] == json!("Failed"), "{refused}");
    outcome.into_result()?;

    anyhow::ensure!(w.env.status(&w.dao, id).await? == status);
    anyhow::ensure!(w.was_used(verdict).await?, "the spent verdict must stay spent");
    anyhow::ensure!(w.veto_result(verdict).await? == json!("Failed"));
    println!("{dao_error} reached the DAO receipt; veto_result records \"Failed\"");
    Ok(())
}

#[tokio::test]
async fn a_vote_the_dao_refuses_for_a_different_kind_is_recorded() -> Result<()> {
    let w = world().await?;
    let id = w.file_transfer(&w.dao, 5).await?;
    let stored = w.env.kind_json(&w.dao, id).await?;
    let altered = stored.replace(
        &NearToken::from_near(5).as_yoctonear().to_string(),
        &NearToken::from_near(4).as_yoctonear().to_string(),
    );
    anyhow::ensure!(altered != stored);
    // The signer vouches for the altered kind, so every check inside the guard passes.
    let expires = w.env.chain_time_ms().await? + TEN_MINUTES_MS;
    let verdict = vetoable_verdict(&w.guard, &w.dao, id, &altered, expires)?;
    let outcome = w.veto(&verdict, &altered).await?;
    assert_refusal_recorded(&w, outcome, "ERR_WRONG_KIND", id, &verdict, "InProgress").await
}

#[tokio::test]
async fn a_remove_member_from_role_proposal_cannot_be_rejected_and_the_refusal_is_recorded(
) -> Result<()> {
    let w = world().await?;
    let kind = json!({ "RemoveMemberFromRole": { "member_id": w.guard, "role": "guard" } });
    let id = w.env.add_proposal(&w.dao, &w.alice, kind).await?;
    let (kind_json, verdict) = w.fresh(&w.dao, id).await?;
    let outcome = w.veto(&verdict, &kind_json).await?;
    assert_refusal_recorded(&w, outcome, "ERR_PERMISSION_DENIED", id, &verdict, "InProgress").await
}

/// The guard does not read a proposal's status; Sputnik refuses a vote on one its members already
/// decided, and the guard records that refusal like any other.
#[tokio::test]
async fn a_veto_on_a_proposal_its_members_already_decided_is_refused_and_recorded() -> Result<()> {
    let w = world().await?;
    for (vote, status) in [("VoteApprove", "Approved"), ("VoteReject", "Rejected")] {
        let id = w.file_transfer(&w.dao, 5).await?;
        let (kind_json, verdict) = w.fresh(&w.dao, id).await?;
        let stored = w.env.proposal(&w.dao, id).await?["kind"].clone();
        w.env
            .call(
                &w.alice,
                &w.dao,
                "act_proposal",
                json!({ "id": id, "action": vote, "proposal": stored }),
                NearToken::from_yoctonear(0),
                NearGas::from_tgas(300),
            )
            .await?
            .into_result()?;
        anyhow::ensure!(w.env.status(&w.dao, id).await? == status, "the council's {vote} did not decide it");

        let outcome = w.veto(&verdict, &kind_json).await?;
        assert_refusal_recorded(&w, outcome, "ERR_PROPOSAL_NOT_READY_FOR_VOTE", id, &verdict, status)
            .await?;
        let votes = w.votes(&w.dao, id).await?;
        anyhow::ensure!(votes.get(w.guard.as_str()).is_none(), "the guard's vote was counted: {votes}");
    }
    Ok(())
}

/// C19: a key change is announced, and for a day the accepted key alone counts; then anyone may
/// apply it, and from then on only the new key counts.
#[tokio::test]
async fn a_key_change_waits_a_day_and_until_then_only_the_accepted_key_counts() -> Result<()> {
    let w = world_with_clock().await?;
    let original = w.sealed.public_key();
    let next = SealedSigner::other_key();
    assert_refused(w.call_guard(&w.stranger, "apply_key_change", 0).await?, "ERR_NO_PENDING_KEY")?;

    let due = w.announce(&next.public_key()).await?;
    anyhow::ensure!(w.accepted_key().await? == json!(original), "the announcement changed the key");

    let id = w.file_transfer(&w.dao, 5).await?;
    let (kind_json, verdict) = w.fresh(&w.dao, id).await?;
    let (verdict_b64, signature_b64) = next.sign(&verdict);
    let outcome = w.veto_raw(&verdict_b64, &signature_b64, &kind_json).await?;
    w.assert_refused_untouched(outcome, "ERR_BAD_SIGNATURE", &w.dao, id, &verdict).await?;
    let text = assert_refused(w.call_guard(&w.stranger, "apply_key_change", 0).await?, "ERR_TOO_EARLY")?;
    println!("apply_key_change a day early refused with: {text}");

    let now = w.env.advance_clock_to(due).await?;
    println!("clock moved to {now}, the change was due at {due}");
    let applied = w.call_guard(&w.stranger, "apply_key_change", 0).await?;
    let all = events(&applied);
    applied.into_result()?;
    let changed = event(&all, "key_changed")?;
    anyhow::ensure!(changed["data"] == json!([{ "old_key": original, "new_key": next.public_key() }]), "{changed}");
    anyhow::ensure!(w.accepted_key().await? == json!(next.public_key()));
    anyhow::ensure!(w.pending_key().await?.is_null());

    let (kind_json, verdict) = w.fresh(&w.dao, id).await?;
    let outcome = w.veto(&verdict, &kind_json).await?;
    w.assert_refused_untouched(outcome, "ERR_BAD_SIGNATURE", &w.dao, id, &verdict).await?;
    let (verdict_b64, signature_b64) = next.sign(&verdict);
    w.veto_raw(&verdict_b64, &signature_b64, &kind_json).await?.into_result()?;
    w.assert_rejected_by_guard(&w.dao, id).await
}

#[tokio::test]
async fn only_the_owner_announces_or_cancels_a_key_change_and_only_with_one_yocto() -> Result<()> {
    let w = world().await?;
    let original = w.sealed.public_key();
    let replacement = SealedSigner::other_key().public_key();

    let text = assert_refused(w.set_accepted_key(&w.stranger, &replacement, 1).await?, "ERR_NOT_OWNER")?;
    println!("set_accepted_key from a non-owner refused with: {text}");
    let text = assert_refused(w.set_accepted_key(&w.owner, &replacement, 0).await?, "ERR_NEED_ONE_YOCTO")?;
    println!("set_accepted_key without one yoctoNEAR refused with: {text}");
    anyhow::ensure!(w.pending_key().await?.is_null());
    assert_refused(w.call_guard(&w.owner, "cancel_key_change", 1).await?, "ERR_NO_PENDING_KEY")?;

    w.announce(&replacement).await?;
    let text = assert_refused(w.call_guard(&w.stranger, "cancel_key_change", 1).await?, "ERR_NOT_OWNER")?;
    println!("cancel_key_change from a non-owner refused with: {text}");
    let text = assert_refused(w.call_guard(&w.owner, "cancel_key_change", 0).await?, "ERR_NEED_ONE_YOCTO")?;
    println!("cancel_key_change without one yoctoNEAR refused with: {text}");

    let cancelled = w.call_guard(&w.owner, "cancel_key_change", 1).await?;
    let all = events(&cancelled);
    cancelled.into_result()?;
    let event = event(&all, "key_change_cancelled")?;
    anyhow::ensure!(event["data"] == json!([{ "key": replacement }]), "{event}");
    anyhow::ensure!(w.pending_key().await?.is_null());
    anyhow::ensure!(w.accepted_key().await? == json!(original));
    assert_refused(w.call_guard(&w.stranger, "apply_key_change", 0).await?, "ERR_NO_PENDING_KEY")?;

    // The accepted key never stopped counting.
    let id = w.file_transfer(&w.dao, 5).await?;
    let (kind_json, verdict) = w.fresh(&w.dao, id).await?;
    w.veto(&verdict, &kind_json).await?.into_result()?;
    w.assert_rejected_by_guard(&w.dao, id).await
}

#[tokio::test]
async fn a_second_announcement_replaces_the_first_and_restarts_the_clock() -> Result<()> {
    let w = world_with_clock().await?;
    let first = SealedSigner::other_key().public_key();
    let second = SealedSigner::third_key().public_key();
    let first_due = w.announce(&first).await?;
    w.env.advance_clock_to(first_due - KEY_CHANGE_DELAY_MS / 2).await?;
    let second_due = w.announce(&second).await?;
    anyhow::ensure!(second_due >= first_due + KEY_CHANGE_DELAY_MS / 2, "the clock did not restart");

    let now = w.env.advance_clock_to(first_due).await?;
    anyhow::ensure!(now < second_due, "the clock overshot the second announcement's time");
    let text = assert_refused(w.call_guard(&w.stranger, "apply_key_change", 0).await?, "ERR_TOO_EARLY")?;
    println!("apply_key_change at the first announcement's time refused with: {text}");

    w.env.advance_clock_to(second_due).await?;
    w.call_guard(&w.stranger, "apply_key_change", 0).await?.into_result()?;
    anyhow::ensure!(w.accepted_key().await? == json!(second));
    Ok(())
}

#[tokio::test]
async fn ownership_moves_only_when_the_proposed_owner_accepts() -> Result<()> {
    let w = world().await?;
    let next = w.env.account("next-owner", 10).await?;
    let one_yocto = NearToken::from_yoctonear(1);
    let gas = NearGas::from_tgas(30);

    let text = assert_refused(
        w.env.call(&w.stranger, &w.guard, "propose_owner", json!({ "new_owner": w.stranger }), one_yocto, gas).await?,
        "ERR_NOT_OWNER",
    )?;
    println!("propose_owner from a non-owner refused with: {text}");

    let proposed = w.env.call(&w.owner, &w.guard, "propose_owner", json!({ "new_owner": next }), one_yocto, gas).await?;
    let all = events(&proposed);
    proposed.into_result()?;
    anyhow::ensure!(event(&all, "owner_proposed")?["data"][0]["proposed_owner"] == json!(next));
    anyhow::ensure!(w.env.view(&w.guard, "owner", json!({})).await? == json!(w.owner));

    let text = assert_refused(
        w.env.call(&w.stranger, &w.guard, "accept_owner", json!({}), one_yocto, gas).await?,
        "ERR_NOT_PENDING_OWNER",
    )?;
    println!("accept_owner from someone else refused with: {text}");

    let accepted = w.env.call(&next, &w.guard, "accept_owner", json!({}), one_yocto, gas).await?;
    let all = events(&accepted);
    accepted.into_result()?;
    let event = event(&all, "owner_accepted")?;
    anyhow::ensure!(event["data"][0]["old_owner"] == json!(w.owner), "{event}");
    anyhow::ensure!(w.env.view(&w.guard, "owner", json!({})).await? == json!(next));

    let replacement = SealedSigner::other_key().public_key();
    assert_refused(w.set_accepted_key(&w.owner, &replacement, 1).await?, "ERR_NOT_OWNER")?;
    w.set_accepted_key(&next, &replacement, 1).await?.into_result()?;
    Ok(())
}

/// How a big policy kind spends its bytes. Both cost the most per byte of any kind measured:
/// many short strings in sets the guard sorts and Sputnik hashes.
#[derive(Clone, Copy, Debug)]
enum Shape {
    /// 80 roles, each a list of members named like `m3-41.sandbox`.
    ManyRoles,
    /// Two roles with very long lists of the shortest account ids NEAR allows, so each byte
    /// carries as many members as it can.
    LongLists,
}

impl Shape {
    fn roles(self) -> usize {
        match self {
            Shape::ManyRoles => 80,
            Shape::LongLists => 2,
        }
    }

    fn member(self, role: usize, n: usize) -> String {
        match self {
            Shape::ManyRoles => format!("m{role}-{n}.{NETWORK}"),
            Shape::LongLists => short_id(n),
        }
    }
}

/// The `n`th string of two or more characters from [0-9a-z], shortest first. Each is a valid
/// NEAR account id and none repeats.
fn short_id(n: usize) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let (mut len, mut first) = (2u32, 0);
    while n - first >= 36usize.pow(len) {
        first += 36usize.pow(len);
        len += 1;
    }
    let mut rest = n - first;
    let mut id = vec![b'0'; len as usize];
    for slot in id.iter_mut().rev() {
        *slot = DIGITS[rest % 36];
        rest /= 36;
    }
    String::from_utf8(id).unwrap_or_default()
}

/// A full ChangePolicy body with `roles` extra Group roles of `members` members each, on top of
/// the council and guard roles, to measure what a big policy kind costs.
fn big_policy(w: &World, roles: usize, members: usize) -> Value {
    shaped_policy(w, Shape::ManyRoles, roles, members, 0)
}

/// `big_policy` in `shape`, with `pad` more characters in the last role's name.
fn shaped_policy(w: &World, shape: Shape, roles: usize, members: usize, pad: usize) -> Value {
    let permissions: Vec<String> = GUARD_REJECT_KINDS
        .iter()
        .map(|label| format!("{label}:AddProposal"))
        .collect();
    let mut all_roles = vec![
        json!({ "name": "council", "kind": { "Group": [w.alice] }, "permissions": ["*:*"], "vote_policy": {} }),
        json!({ "name": "guard", "kind": { "Group": [w.guard] },
                "permissions": GUARD_REJECT_KINDS.iter().map(|l| format!("{l}:VoteReject")).collect::<Vec<_>>(),
                "vote_policy": {} }),
    ];
    for r in 0..roles {
        let group: Vec<String> = (0..members).map(|m| shape.member(r, m)).collect();
        let pad = if r + 1 == roles { "x".repeat(pad) } else { String::new() };
        all_roles.push(json!({
            "name": format!("role-{r}{pad}"),
            "kind": { "Group": group },
            "permissions": permissions,
            "vote_policy": { "transfer": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 2] } }
        }));
    }
    json!({
        "roles": all_roles,
        "default_vote_policy": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 2] },
        "proposal_bond": PROPOSAL_BOND.as_yoctonear().to_string(),
        "proposal_period": (7u64 * 24 * 60 * 60 * 1_000_000_000).to_string(),
        "bounty_bond": NearToken::from_near(1).as_yoctonear().to_string(),
        "bounty_forgiveness_period": (24u64 * 60 * 60 * 1_000_000_000).to_string()
    })
}

/// A ChangePolicy kind in `shape` of exactly `bytes` bytes of compact JSON: as many members per
/// role as fit, and the last role's name padded for the rest.
fn policy_kind_of_size(w: &World, shape: Shape, bytes: usize) -> Result<Value> {
    let kind = |members, pad| {
        json!({ "ChangePolicy": { "policy": shaped_policy(w, shape, shape.roles(), members, pad) } })
    };
    let size = |members| serde_json::to_string(&kind(members, 0)).map(|text| text.len());
    let (mut fits, mut over) = (0, 1);
    while size(over)? <= bytes {
        fits = over;
        over *= 2;
    }
    while over - fits > 1 {
        let mid = (fits + over) / 2;
        if size(mid)? <= bytes {
            fits = mid;
        } else {
            over = mid;
        }
    }
    let pad = bytes
        .checked_sub(size(fits)?)
        .ok_or_else(|| anyhow::anyhow!("no {shape:?} policy is as small as {bytes} bytes"))?;
    let kind = kind(fits, pad);
    anyhow::ensure!(serde_json::to_string(&kind)?.len() == bytes);
    Ok(kind)
}

/// Files a ChangePolicy of exactly `bytes` bytes, as the DAO returns it, and gives back its id and
/// that text.
async fn file_policy_of_size(w: &World, shape: Shape, bytes: usize) -> Result<(u64, String)> {
    let kind = policy_kind_of_size(w, shape, bytes)?;
    let id = w
        .env
        .add_proposal_with_gas(&w.dao, &w.alice, kind, NearGas::from_tgas(1000))
        .await?;
    let kind_json = w.env.kind_json(&w.dao, id).await?;
    anyhow::ensure!(
        kind_json.len() == bytes,
        "the DAO returned {} bytes for a {bytes}-byte {shape:?} kind",
        kind_json.len()
    );
    Ok((id, kind_json))
}

/// Gas burnt by the guard's `veto` receipt and by the DAO's `act_proposal` receipt, in Tgas.
fn guard_and_dao_gas(w: &World, outcome: &ExecutionFinalResult) -> Result<(f64, f64)> {
    let tgas = |gas: NearGas| gas.as_gas() as f64 / 1e12;
    let guard = step_on(outcome, &w.guard)?[0].gas_burnt;
    let dao = step_on(outcome, &w.dao).map(|steps| steps[0].gas_burnt).unwrap_or(NearGas::from_gas(0));
    Ok((tgas(guard), tgas(dao)))
}

/// The invariant at the edge: a kind of exactly `MAX_VETO_KIND_BYTES`, in each measured shape,
/// lands with exactly `MIN_VETO_GAS`, one gas unit less is refused and leaves the verdict usable,
/// and one byte more is refused before anything is read.
#[tokio::test]
async fn a_kind_at_the_size_limit_lands_with_exactly_the_least_gas_and_nothing_less() -> Result<()> {
    let w = world().await?;
    for shape in [Shape::ManyRoles, Shape::LongLists] {
        let (id, kind_json) = file_policy_of_size(&w, shape, MAX_VETO_KIND_BYTES).await?;
        let expires = w.env.chain_time_ms().await? + TEN_MINUTES_MS;
        let verdict = vetoable_verdict(&w.guard, &w.dao, id, &kind_json, expires)?;
        let (verdict_b64, signature_b64) = w.sealed.sign(&verdict);

        let one_less = NearGas::from_gas(VETO_GAS.as_gas() - 1);
        let short = w.veto_raw_with_gas(&verdict_b64, &signature_b64, &kind_json, one_less).await?;
        println!("LIMIT | {shape:?} | {MAX_VETO_KIND_BYTES} | {} gas | refused", one_less.as_gas());
        w.assert_refused_untouched(short, "ERR_NOT_ENOUGH_GAS", &w.dao, id, &verdict).await?;

        let outcome = w.veto_raw_with_gas(&verdict_b64, &signature_b64, &kind_json, VETO_GAS).await?;
        let (guard, dao) = guard_and_dao_gas(&w, &outcome)?;
        println!("LIMIT | {shape:?} | {MAX_VETO_KIND_BYTES} | {} gas | landed | guard {guard:.2} | DAO {dao:.2}", VETO_GAS.as_gas());
        outcome.into_result()?;
        w.assert_rejected_by_guard(&w.dao, id).await?;
        anyhow::ensure!(w.veto_result(&verdict).await? == json!("Ok"));
    }

    let (id, kind_json) = file_policy_of_size(&w, Shape::LongLists, MAX_VETO_KIND_BYTES + 1).await?;
    let (_, verdict) = w.fresh(&w.dao, id).await?;
    let outcome = w.veto(&verdict, &kind_json).await?;
    w.assert_refused_untouched(outcome, "ERR_KIND_TOO_LARGE", &w.dao, id, &verdict).await
}

/// A padded spelling of a large kind hashes like the kind the verdict reviewed, so only its length
/// tells it apart. Past the size limit it is refused for its size, within it for its length; the
/// verdict stays unused either way, and the kind as the DAO returned it then lands.
#[tokio::test]
async fn a_padded_spelling_of_a_large_kind_is_refused_and_the_compact_one_then_lands() -> Result<()> {
    let w = world().await?;
    let kind = json!({ "ChangePolicy": { "policy": big_policy(&w, 80, 110) } });
    let id = w.env.add_proposal(&w.dao, &w.alice, kind).await?;
    let (kind_json, verdict) = w.fresh(&w.dao, id).await?;

    let probe = format!("{kind_json}{}", " ".repeat(60_000));
    anyhow::ensure!(kaap_verdict::kind_hash(probe.as_bytes()).ok() == Some(verdict.kind_hash));
    println!("a {}-byte kind with 60,000 spaces after it is {} bytes", kind_json.len(), probe.len());
    let outcome = w.veto(&verdict, &probe).await?;
    w.assert_refused_untouched(outcome, "ERR_KIND_TOO_LARGE", &w.dao, id, &verdict).await?;

    let padded = format!("{kind_json}{}", " ".repeat(MAX_VETO_KIND_BYTES - kind_json.len()));
    anyhow::ensure!(kaap_verdict::kind_hash(padded.as_bytes()).ok() == Some(verdict.kind_hash));
    let outcome = w.veto(&verdict, &padded).await?;
    w.assert_refused_untouched(outcome, "ERR_BAD_KIND", &w.dao, id, &verdict).await?;

    w.veto(&verdict, &kind_json).await?.into_result()?;
    w.assert_rejected_by_guard(&w.dao, id).await?;
    anyhow::ensure!(w.veto_result(&verdict).await? == json!("Ok"));
    Ok(())
}

/// A signed verdict is public before the worker uses it. A stranger who sends it first with
/// enough gas for the guard but too little for the DAO's vote on a big kind must not be able to
/// spend it: the short call fails whole, and a call with `MIN_VETO_GAS` still lands.
#[tokio::test]
async fn a_veto_with_too_little_gas_for_the_vote_fails_whole_and_leaves_the_verdict_usable(
) -> Result<()> {
    let w = world().await?;
    let kind = json!({ "ChangePolicy": { "policy": big_policy(&w, 80, 110) } });
    let id = w.env.add_proposal(&w.dao, &w.alice, kind).await?;
    let (kind_json, verdict) = w.fresh(&w.dao, id).await?;
    let (verdict_b64, signature_b64) = w.sealed.sign(&verdict);

    let short = w
        .veto_raw_with_gas(&verdict_b64, &signature_b64, &kind_json, NearGas::from_tgas(240))
        .await?;
    print_outcomes(&format!("veto of a {}-byte ChangePolicy with 240 Tgas", kind_json.len()), &short);
    println!(
        "after the 240 Tgas call: was_used {}, veto_result {}, status {}",
        w.was_used(&verdict).await?,
        w.veto_result(&verdict).await?,
        w.env.status(&w.dao, id).await?
    );
    w.assert_refused_untouched(short, "ERR_NOT_ENOUGH_GAS", &w.dao, id, &verdict).await?;
    anyhow::ensure!(w.veto_result(&verdict).await?.is_null(), "a refused call left a veto result");

    let outcome = w.veto_raw(&verdict_b64, &signature_b64, &kind_json).await?;
    print_outcomes("the same verdict with MIN_VETO_GAS", &outcome);
    outcome.into_result()?;
    w.assert_rejected_by_guard(&w.dao, id).await?;
    anyhow::ensure!(w.veto_result(&verdict).await? == json!("Ok"));
    Ok(())
}

/// Not a check of behaviour: prints the gas each main guard action burns, receipt by receipt, for
/// packages/contracts/GAS.md. Rerun with
/// `cargo test -p kaap-guard --test guard_sandbox gas_report -- --nocapture`.
#[tokio::test]
async fn gas_report() -> Result<()> {
    let w = world_with_clock().await?;
    let guard_bytes = || async { Ok::<u64, anyhow::Error>(w.env.account_view(&w.guard).await?.storage_usage) };
    let zero = NearToken::from_yoctonear(0);
    let dao = w.add_dao("dao-gas", false).await?;
    let before = guard_bytes().await?;
    let enrolment = w.enroll(&dao).await?;
    report_gas("enroll, through the DAO's approved FunctionCall proposal", &enrolment);
    enrolment.into_result()?;
    println!("GAS | enroll | guard storage added (bytes) | {}", guard_bytes().await? - before);

    let strict = w.add_dao("dao-gas-strict", false).await?;
    let before = guard_bytes().await?;
    let enrolment = w.enroll_with(&strict, json!({ "veto_unreadable": true })).await?;
    report_gas("enroll with veto_unreadable true, through the DAO's approved proposal", &enrolment);
    enrolment.into_result()?;
    println!("GAS | enroll strict | guard storage added (bytes) | {}", guard_bytes().await? - before);
    let before = guard_bytes().await?;
    let change = w.dao_calls_guard(&strict, "set_veto_unreadable", json!({ "on": false }), zero).await?;
    report_gas("set_veto_unreadable, through the DAO's approved proposal", &change);
    change.into_result()?;
    println!("GAS | set_veto_unreadable | guard storage added (bytes) | {}", guard_bytes().await? as i64 - before as i64);

    let id = w.file_transfer(&w.dao, 5).await?;
    let (kind_json, verdict) = w.fresh(&w.dao, id).await?;
    let before = guard_bytes().await?;
    let outcome = w.veto(&verdict, &kind_json).await?;
    report_gas(&format!("veto, Transfer kind of {} bytes", kind_json.len()), &outcome);
    outcome.into_result()?;
    w.assert_rejected_by_guard(&w.dao, id).await?;
    println!("GAS | veto | guard storage added (bytes) | {}", guard_bytes().await? - before);

    for (roles, members) in [(4, 10), (20, 30), (40, 60)] {
        let kind = json!({ "ChangePolicy": { "policy": big_policy(&w, roles, members) } });
        let id = w.env.add_proposal(&w.dao, &w.alice, kind).await?;
        let (kind_json, verdict) = w.fresh(&w.dao, id).await?;
        let outcome = w.veto(&verdict, &kind_json).await?;
        report_gas(&format!("veto, ChangePolicy kind of {} bytes", kind_json.len()), &outcome);
        outcome.into_result()?;
        w.assert_rejected_by_guard(&w.dao, id).await?;
    }

    // Padding a FunctionCall's args is the cheapest way for a proposer to make a kind big; all
    // three stay under the size limit. Printed, not asserted.
    for raw_bytes in [48 * 1024, 96 * 1024, 144 * 1024] {
        let kind = json!({ "FunctionCall": {
            "receiver_id": format!("target.{NETWORK}"),
            "actions": [{ "method_name": "m", "args": b64(&vec![7u8; raw_bytes]), "deposit": "0", "gas": "1000000000000" }]
        }});
        let id = match w.env.add_proposal(&w.dao, &w.alice, kind).await {
            Ok(id) => id,
            Err(error) => {
                println!("GAS | padded FunctionCall of {raw_bytes} raw args bytes | add_proposal failed: {error}");
                continue;
            }
        };
        let (kind_json, verdict) = w.fresh(&w.dao, id).await?;
        let outcome = w.veto(&verdict, &kind_json).await?;
        report_gas(&format!("veto, padded FunctionCall kind of {} bytes", kind_json.len()), &outcome);
        println!(
            "GAS | padded FunctionCall kind of {} bytes | status after veto | {}",
            kind_json.len(),
            w.env.status(&w.dao, id).await?
        );
    }
    // Policy kinds cost the most per byte. Both measured shapes at half the size limit and at the
    // limit, with the MIN_VETO_GAS every veto attaches, then the refusal one byte over it.
    for shape in [Shape::ManyRoles, Shape::LongLists] {
        for bytes in [MAX_VETO_KIND_BYTES / 2, MAX_VETO_KIND_BYTES] {
            let (id, _) = file_policy_of_size(&w, shape, bytes).await?;
            let (kind_json, verdict) = w.fresh(&w.dao, id).await?;
            let outcome = w.veto(&verdict, &kind_json).await?;
            report_gas(&format!("veto, {shape:?} ChangePolicy kind of {bytes} bytes"), &outcome);
            outcome.into_result()?;
            w.assert_rejected_by_guard(&w.dao, id).await?;
        }
    }
    let (id, _) = file_policy_of_size(&w, Shape::LongLists, MAX_VETO_KIND_BYTES + 1).await?;
    let (kind_json, verdict) = w.fresh(&w.dao, id).await?;
    let outcome = w.veto(&verdict, &kind_json).await?;
    report_gas("veto of a kind one byte over the limit (ERR_KIND_TOO_LARGE)", &outcome);

    let id = w.file_transfer(&w.dao, 5).await?;
    let stored = w.env.kind_json(&w.dao, id).await?;
    let altered = stored.replace(
        &NearToken::from_near(5).as_yoctonear().to_string(),
        &NearToken::from_near(4).as_yoctonear().to_string(),
    );
    let expires = w.env.chain_time_ms().await? + TEN_MINUTES_MS;
    let refused = vetoable_verdict(&w.guard, &w.dao, id, &altered, expires)?;
    let before = guard_bytes().await?;
    let outcome = w.veto(&refused, &altered).await?;
    report_gas("veto the DAO refuses (ERR_WRONG_KIND)", &outcome);
    println!("GAS | refused veto | guard storage added (bytes) | {}", guard_bytes().await? - before);

    let id = w.file_transfer(&w.dao, 5).await?;
    let (kind_json, verdict) = w.fresh(&w.dao, id).await?;
    let outcome = w.veto(&Verdict { floor: Severity::Medium, ..verdict }, &kind_json).await?;
    report_gas("veto refused by the guard itself (ERR_NOT_VETOABLE)", &outcome);

    for n in 0..10 {
        let account = w.env.account(&format!("plain-{n}"), 5).await?;
        w.env
            .call(&account, &w.guard, "enroll", json!({}), ENROL_DEPOSIT, NearGas::from_tgas(30))
            .await?
            .into_result()?;
    }
    for limit in [1u64, 12] {
        let page = w
            .env
            .call(
                &w.stranger,
                &w.guard,
                "enrolled_daos",
                json!({ "from_index": 0, "limit": limit }),
                NearToken::from_yoctonear(0),
                NearGas::from_tgas(300),
            )
            .await?;
        report_gas(&format!("enrolled_daos page of {limit}, called as a transaction"), &page);
        anyhow::ensure!(page.into_result()?.json::<Vec<String>>()?.len() as u64 == limit);
    }

    let next = SealedSigner::other_key().public_key();
    let announced = w.set_accepted_key(&w.owner, &next, 1).await?;
    report_gas("set_accepted_key, announcing a change", &announced);
    announced.into_result()?;
    let cancelled = w.call_guard(&w.owner, "cancel_key_change", 1).await?;
    report_gas("cancel_key_change", &cancelled);
    cancelled.into_result()?;
    let before = guard_bytes().await?;
    let due = w.announce(&next).await?;
    println!("GAS | pending key | guard storage added (bytes) | {}", guard_bytes().await? - before);
    w.env.advance_clock_to(due).await?;
    let applied = w.call_guard(&w.stranger, "apply_key_change", 0).await?;
    report_gas("apply_key_change, by an account with no role", &applied);
    applied.into_result()?;
    println!("GAS | apply_key_change | guard storage left over (bytes) | {}", guard_bytes().await? as i64 - before as i64);
    Ok(())
}
