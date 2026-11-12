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
// - a DAO call that runs out of gas inside a 300 Tgas veto: gas_report prints where that starts
//   for policy kinds, and nothing asserts it;
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
    let env = Env::start().await?;
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

    /// Enrols `dao` the way a real DAO does: a FunctionCall proposal to `enroll` that attaches
    /// the storage deposit, approved by its council. Returns the approval transaction, whose
    /// guard receipt is the enrolment itself.
    async fn enroll(&self, dao: &AccountId) -> Result<ExecutionFinalResult> {
        let approval = self.dao_calls_guard(dao, "enroll", ENROL_DEPOSIT).await?;
        anyhow::ensure!(
            self.env.view(&self.guard, "is_enrolled", json!({ "dao": dao })).await? == json!(true),
            "{dao} approved its enrolment but the guard does not list it"
        );
        Ok(approval)
    }

    /// `dao` files and approves a FunctionCall proposal that calls `method` on the guard with
    /// `deposit` and the 10 Tgas the guard README tells DAOs to give it.
    async fn dao_calls_guard(
        &self,
        dao: &AccountId,
        method: &str,
        deposit: NearToken,
    ) -> Result<ExecutionFinalResult> {
        let kind = json!({ "FunctionCall": {
            "receiver_id": self.guard,
            "actions": [{
                "method_name": method,
                "args": b64(b"{}"),
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
        self.veto_raw_with_gas(verdict_b64, signature_b64, kind_json, NearGas::from_tgas(300))
            .await
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

    w.enroll(&dao).await?.into_result()?;
    let enrolled = w.env.account_view(&w.guard).await?;
    let added = enrolled.storage_usage - start.storage_usage;
    let kept = enrolled.amount.as_yoctonear() - start.amount.as_yoctonear();
    println!("enrolment added {added} bytes; the guard kept {kept} yoctoNEAR of the 0.01 NEAR deposit");
    anyhow::ensure!(added > 0 && free(&enrolled) >= free(&start), "the guard paid for the enrolment");
    anyhow::ensure!(kept < ENROL_DEPOSIT.as_yoctonear() / 2, "the excess deposit was not refunded");

    w.dao_calls_guard(&dao, "unenroll", NearToken::from_yoctonear(0)).await?.into_result()?;
    let left = w.env.account_view(&w.guard).await?;
    println!("unenrolment freed {} bytes", enrolled.storage_usage - left.storage_usage);
    anyhow::ensure!(left.storage_usage == start.storage_usage, "unenrolment left storage behind");
    anyhow::ensure!(free(&left) >= free(&start), "the unenrolment refund came out of the guard's own balance");
    anyhow::ensure!(w.env.view(&w.guard, "is_enrolled", json!({ "dao": dao })).await? == json!(false));

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

#[tokio::test]
async fn only_the_owner_changes_the_key_and_only_with_one_yocto() -> Result<()> {
    let w = world().await?;
    let original = w.sealed.public_key();
    let replacement = SealedSigner::other_key().public_key();

    let text = assert_refused(w.set_accepted_key(&w.stranger, &replacement, 1).await?, "ERR_NOT_OWNER")?;
    println!("set_accepted_key from a non-owner refused with: {text}");
    let text = assert_refused(w.set_accepted_key(&w.owner, &replacement, 0).await?, "ERR_NEED_ONE_YOCTO")?;
    println!("set_accepted_key without one yoctoNEAR refused with: {text}");
    anyhow::ensure!(w.env.view(&w.guard, "accepted_key", json!({})).await? == json!(original));

    let changed = w.set_accepted_key(&w.owner, &replacement, 1).await?;
    let all = events(&changed);
    changed.into_result()?;
    let event = event(&all, "key_changed")?;
    anyhow::ensure!(event["data"][0]["old_key"] == json!(original), "{event}");
    anyhow::ensure!(event["data"][0]["new_key"] == json!(replacement), "{event}");
    anyhow::ensure!(w.env.view(&w.guard, "accepted_key", json!({})).await? == json!(replacement));

    // A verdict the old key signed stops working at once.
    let id = w.file_transfer(&w.dao, 5).await?;
    let (kind_json, verdict) = w.fresh(&w.dao, id).await?;
    let outcome = w.veto(&verdict, &kind_json).await?;
    w.assert_refused_untouched(outcome, "ERR_BAD_SIGNATURE", &w.dao, id, &verdict).await
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

/// A full ChangePolicy body with `roles` extra Group roles of `members` members each, on top of
/// the council and guard roles, to measure what a big policy kind costs.
fn big_policy(w: &World, roles: usize, members: usize) -> Value {
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
        let group: Vec<String> = (0..members).map(|m| format!("m{r}-{m}.{NETWORK}")).collect();
        all_roles.push(json!({
            "name": format!("role-{r}"),
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

/// A signed verdict is public before the worker uses it. A stranger who sends it first with
/// enough gas for the guard but too little for the DAO's vote on a big kind must not be able to
/// spend it: the short call fails whole, and the honest 300 Tgas call still lands.
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
    print_outcomes("the same verdict with 300 Tgas", &outcome);
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
    let w = world().await?;
    let guard_bytes = || async { Ok::<u64, anyhow::Error>(w.env.account_view(&w.guard).await?.storage_usage) };
    let dao = w.add_dao("dao-gas", false).await?;
    let before = guard_bytes().await?;
    let enrolment = w.enroll(&dao).await?;
    report_gas("enroll, through the DAO's approved FunctionCall proposal", &enrolment);
    enrolment.into_result()?;
    println!("GAS | enroll | guard storage added (bytes) | {}", guard_bytes().await? - before);

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

    // Padding a FunctionCall's args is the cheapest way for a proposer to make a kind big. These
    // are printed, not asserted, to show where a veto stops fitting in one 300 Tgas transaction.
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
    // Policy-shaped kinds cost the most per byte. These find the largest one whose vote still
    // lands with the 300 Tgas every veto attaches, in steps of about 1.4 KB from 200 KB, then two
    // far above it, the last just under kaap-verdict's 256 KiB limit.
    let mut largest_landed = 0;
    let mut smallest_not_landed = usize::MAX;
    for (roles, members) in [
        (60, 80),
        (80, 110),
        (80, 112),
        (80, 113),
        (80, 114),
        (80, 115),
        (80, 116),
        (80, 117),
        (80, 118),
        (80, 120),
        (80, 130),
        (80, 154),
    ] {
        let kind = json!({ "ChangePolicy": { "policy": big_policy(&w, roles, members) } });
        let id = match w.env.add_proposal(&w.dao, &w.alice, kind).await {
            Ok(id) => id,
            Err(error) => {
                println!("GAS | ChangePolicy of {roles} roles x {members} members | add_proposal failed: {error}");
                continue;
            }
        };
        let (kind_json, verdict) = w.fresh(&w.dao, id).await?;
        let outcome = w.veto(&verdict, &kind_json).await?;
        report_gas(&format!("veto, large ChangePolicy kind of {} bytes", kind_json.len()), &outcome);
        let status = w.env.status(&w.dao, id).await?;
        println!(
            "GAS | large ChangePolicy kind of {} bytes | status after veto | {status} | veto_result {}",
            kind_json.len(),
            w.veto_result(&verdict).await?
        );
        if status == "Rejected" {
            largest_landed = largest_landed.max(kind_json.len());
        } else {
            let reason = match step_on(&outcome, &w.dao)?[0].clone().into_result() {
                Ok(_) => "the DAO's receipt succeeded".to_owned(),
                Err(error) => receipt_error(&error),
            };
            println!("GAS | large ChangePolicy kind of {} bytes | DAO receipt | {reason}", kind_json.len());
            smallest_not_landed = smallest_not_landed.min(kind_json.len());
        }
    }
    println!("GAS | largest ChangePolicy kind whose vote landed with 300 Tgas | {largest_landed} bytes");
    println!("GAS | smallest ChangePolicy kind whose vote did not land | {smallest_not_landed} bytes");

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
    Ok(())
}
