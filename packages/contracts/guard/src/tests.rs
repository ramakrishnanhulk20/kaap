// Unit tests for kaap-guard in near-sdk's mocked VM: one test per error the contract can raise,
// plus the exact shape of the vote it sends and the record its callback writes.
//
// What this file does NOT cover:
// - a real DAO: Sputnik's answers (ERR_WRONG_KIND, ERR_PERMISSION_DENIED, the vote landing) are
//   in packages/contracts/tests/guard.rs, against the real 3.2 binary in a sandbox;
// - gas: the mocked VM does not charge wasm execution, so nothing here measures it (GAS.md does);
// - the deploy and the deleted full-access key (scripts/WO-02a-deploy-testnet.sh);
// - whether the sealed job computes the verdict fields correctly; the verdicts here are built by
//   hand and only their signature and rule checks are tested.

use ed25519_dalek::{Signer as _, SigningKey};
use kaap_core::{kind_hash, verdict_bytes, verdict_hash, AiStatus, FindingCode, Network, Severity, Verdict};
use near_sdk::json_types::Base64VecU8;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId, Gas, NearToken, PromiseResult, RuntimeFeesConfig};

use super::*;

const GUARD: &str = "guard.near";
const DAO: &str = "dao.near";
const OWNER: &str = "owner.near";
const STRANGER: &str = "stranger.near";
// Fixed throwaway seeds keep every run identical; they guard nothing.
const VERDICT_SEED: [u8; 32] = [7; 32];
const OTHER_SEED: [u8; 32] = [9; 32];
const NOW_MS: u64 = 1_800_000_000_000;
const PROPOSAL_ID: u64 = 7;
// Spaces on purpose: the guard must forward these bytes as they are, not a re-encoding (C5).
const KIND: &str =
    r#"{"Transfer": {"token_id": "", "receiver_id": "a1ice.near", "amount": "1000", "msg": null}}"#;

fn account(id: &str) -> AccountId {
    id.parse().unwrap()
}

fn key_string(seed: &[u8; 32]) -> String {
    let public = SigningKey::from_bytes(seed).verifying_key().to_bytes();
    format!("ed25519:{}", bs58::encode(public).into_string())
}

fn set_context(predecessor: &str, deposit_yocto: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(account(GUARD))
        .predecessor_account_id(account(predecessor))
        .signer_account_id(account(predecessor))
        .attached_deposit(NearToken::from_yoctonear(deposit_yocto))
        .block_timestamp(NOW_MS * 1_000_000)
        .prepaid_gas(Gas::from_tgas(300))
        .build());
}

fn set_callback_context(results: Vec<PromiseResult>) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(account(GUARD))
            .predecessor_account_id(account(GUARD))
            .block_timestamp(NOW_MS * 1_000_000)
            .build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        results,
    );
}

/// A verdict the guard accepts: critical on a critical floor with a plain-code finding.
fn verdict() -> Verdict {
    Verdict {
        version: 1,
        guard: GUARD.to_owned(),
        network: Network::Sandbox,
        dao: DAO.to_owned(),
        proposal_id: PROPOSAL_ID,
        kind_hash: kind_hash(KIND.as_bytes()).unwrap(),
        policy_hash: [1; 32],
        receivers_hash: [2; 32],
        block_height: 100,
        risk: Severity::Critical,
        floor: Severity::Critical,
        findings: vec![FindingCode::DescContradicts],
        decoder_version: "test".to_owned(),
        model_id: "none".to_owned(),
        ai_status: AiStatus::Unavailable,
        explanation_hash: [3; 32],
        expires_at_ms: NOW_MS + 60_000,
    }
}

fn signed(v: &Verdict, seed: &[u8; 32]) -> (Base64VecU8, Base64VecU8) {
    let signature = SigningKey::from_bytes(seed).sign(&verdict_bytes(v)).to_bytes();
    (
        Base64VecU8(borsh::to_vec(v).unwrap()),
        Base64VecU8(signature.to_vec()),
    )
}

/// A guard for the sandbox network with DAO enrolled, and the context left at STRANGER.
fn guard() -> KaapGuard {
    set_context(GUARD, 0);
    let mut guard = KaapGuard::new(account(OWNER), key_string(&VERDICT_SEED), "sandbox".to_owned());
    set_context(DAO, 0);
    guard.enroll();
    set_context(STRANGER, 0);
    guard
}

fn veto(guard: &mut KaapGuard, v: &Verdict, kind: &str) {
    let (verdict, signature) = signed(v, &VERDICT_SEED);
    let _ = guard.veto(verdict, signature, kind.to_owned());
}

fn event_json(log: &str) -> near_sdk::serde_json::Value {
    let body = log.strip_prefix("EVENT_JSON:").expect("not a NEP-297 event");
    near_sdk::serde_json::from_str(body).unwrap()
}

#[test]
fn veto_sends_exactly_one_vote_reject_with_the_kind_bytes_unchanged() {
    let mut g = guard();
    let v = verdict();
    veto(&mut g, &v, KIND);

    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 2, "{receipts:?}");
    assert_eq!(receipts[0].receiver_id, account(DAO));
    let expected_args = format!(r#"{{"id":{PROPOSAL_ID},"action":"VoteReject","proposal":{KIND}}}"#);
    match receipts[0].actions.as_slice() {
        [MockAction::FunctionCallWeight { method_name, args, attached_deposit, prepaid_gas, gas_weight, .. }] => {
            assert_eq!(method_name, b"act_proposal");
            assert_eq!(args, expected_args.as_bytes());
            assert_eq!(*attached_deposit, NearToken::from_yoctonear(0));
            assert_eq!(*prepaid_gas, ACT_PROPOSAL_GAS);
            assert_eq!(gas_weight.0, 1);
        }
        other => panic!("the DAO receipt must hold one function call, got {other:?}"),
    }
    assert_eq!(receipts[1].receiver_id, account(GUARD));
    assert_eq!(receipts[1].receipt_indices, vec![0]);
    match receipts[1].actions.as_slice() {
        [MockAction::FunctionCallWeight { method_name, prepaid_gas, gas_weight, .. }] => {
            assert_eq!(method_name, b"on_veto_result");
            assert_eq!(*prepaid_gas, ON_VETO_RESULT_GAS);
            assert_eq!(gas_weight.0, 0);
        }
        other => panic!("the callback receipt must hold one function call, got {other:?}"),
    }

    let hash_hex = hex::encode(verdict_hash(&v));
    let event = event_json(get_logs().last().unwrap());
    assert_eq!(event["standard"], "kaap-guard");
    assert_eq!(event["version"], "1.0.0");
    assert_eq!(event["event"], "veto_sent");
    assert_eq!(event["data"][0]["dao"], DAO);
    assert_eq!(event["data"][0]["proposal_id"], PROPOSAL_ID);
    assert_eq!(event["data"][0]["verdict_hash"], hash_hex.as_str());
    assert!(g.was_used(hash_hex.clone()));
    assert_eq!(g.veto_result(hash_hex), None);
}

#[test]
fn veto_rule_follows_c9() {
    let base = verdict();
    let with = |risk, floor, findings: Vec<FindingCode>, ai_status| Verdict {
        risk,
        floor,
        findings,
        ai_status,
        ..base.clone()
    };
    use AiStatus::*;
    use FindingCode::*;
    use Severity::*;
    let cases = [
        (with(Critical, Critical, vec![DescContradicts], Unavailable), true),
        (with(Critical, High, vec![PolicyAddsApprover], Verified), true),
        (with(Critical, High, vec![PolicyAddsApprover], Unverified), false),
        (with(Critical, High, vec![PolicyAddsApprover], Unavailable), false),
        (with(Critical, Medium, vec![NewRecipient], Verified), false),
        (with(Critical, Unknown, vec![HashUnverified, UnknownCall], Verified), false),
        (with(Critical, Critical, vec![HashUnverified], Verified), false),
        (with(Critical, Critical, vec![], Verified), false),
        (with(High, Critical, vec![DescContradicts], Verified), false),
    ];
    for (v, vetoable) in cases {
        assert_eq!(is_vetoable(&v), vetoable, "{v:?}");
    }
}

#[test]
#[should_panic(expected = "ERR_BAD_VERDICT")]
fn err_bad_verdict_on_bytes_that_are_not_a_verdict() {
    let mut g = guard();
    let (_, signature) = signed(&verdict(), &VERDICT_SEED);
    let _ = g.veto(Base64VecU8(vec![1, 2, 3]), signature, KIND.to_owned());
}

#[test]
#[should_panic(expected = "ERR_BAD_VERDICT")]
fn err_bad_verdict_on_a_signed_version_2() {
    let mut g = guard();
    veto(&mut g, &Verdict { version: 2, ..verdict() }, KIND);
}

#[test]
#[should_panic(expected = "ERR_BAD_SIGNATURE")]
fn err_bad_signature_from_another_key() {
    let mut g = guard();
    let (v, signature) = signed(&verdict(), &OTHER_SEED);
    let _ = g.veto(v, signature, KIND.to_owned());
}

#[test]
#[should_panic(expected = "ERR_BAD_SIGNATURE")]
fn err_bad_signature_of_the_wrong_length() {
    let mut g = guard();
    let (v, signature) = signed(&verdict(), &VERDICT_SEED);
    let _ = g.veto(v, Base64VecU8(signature.0[..63].to_vec()), KIND.to_owned());
}

#[test]
#[should_panic(expected = "ERR_WRONG_GUARD")]
fn err_wrong_guard_for_another_guard() {
    let mut g = guard();
    veto(&mut g, &Verdict { guard: "other-guard.near".to_owned(), ..verdict() }, KIND);
}

#[test]
#[should_panic(expected = "ERR_WRONG_GUARD")]
fn err_wrong_guard_for_another_network() {
    let mut g = guard();
    veto(&mut g, &Verdict { network: Network::Testnet, ..verdict() }, KIND);
}

#[test]
#[should_panic(expected = "ERR_NOT_ENROLLED")]
fn err_not_enrolled() {
    let mut g = guard();
    veto(&mut g, &Verdict { dao: "never-enrolled.near".to_owned(), ..verdict() }, KIND);
}

#[test]
#[should_panic(expected = "ERR_NOT_VETOABLE")]
fn err_not_vetoable_for_an_ai_only_critical() {
    let mut g = guard();
    let v = Verdict {
        floor: Severity::Medium,
        findings: vec![FindingCode::NewRecipient],
        ai_status: AiStatus::Verified,
        ..verdict()
    };
    veto(&mut g, &v, KIND);
}

#[test]
#[should_panic(expected = "ERR_EXPIRED")]
fn err_expired_at_the_expiry_millisecond() {
    let mut g = guard();
    veto(&mut g, &Verdict { expires_at_ms: NOW_MS, ..verdict() }, KIND);
}

#[test]
#[should_panic(expected = "ERR_WRONG_KIND_HASH")]
fn err_wrong_kind_hash_for_a_different_kind() {
    let mut g = guard();
    let other = KIND.replace("1000", "1001");
    veto(&mut g, &verdict(), &other);
}

#[test]
#[should_panic(expected = "ERR_BAD_KIND")]
fn err_bad_kind_for_text_that_is_not_json() {
    let mut g = guard();
    veto(&mut g, &verdict(), "Transfer everything");
}

#[test]
#[should_panic(expected = "ERR_BAD_KIND")]
fn err_bad_kind_for_a_kind_that_would_smuggle_a_memo_field() {
    let mut g = guard();
    let smuggled = format!(r#"{KIND},"memo":"x""#);
    let v = Verdict { kind_hash: [0; 32], ..verdict() };
    veto(&mut g, &v, &smuggled);
}

#[test]
#[should_panic(expected = "ERR_REPLAY")]
fn err_replay_of_the_same_verdict() {
    let mut g = guard();
    let v = verdict();
    veto(&mut g, &v, KIND);
    veto(&mut g, &v, KIND);
}

#[test]
fn callback_records_a_refused_vote_and_says_so() {
    let mut g = guard();
    let v = verdict();
    veto(&mut g, &v, KIND);
    let hash_hex = hex::encode(verdict_hash(&v));

    set_callback_context(vec![PromiseResult::Failed]);
    g.on_veto_result(hash_hex.clone());
    assert_eq!(g.veto_result(hash_hex.clone()), Some("Failed".to_owned()));
    assert!(g.was_used(hash_hex.clone()));
    let event = event_json(get_logs().last().unwrap());
    assert_eq!(event["event"], "veto_refused");
    assert_eq!(event["data"][0]["verdict_hash"], hash_hex.as_str());
    assert_eq!(event["data"][0]["result"], "Failed");
}

#[test]
fn callback_records_a_cast_vote() {
    let mut g = guard();
    let v = verdict();
    veto(&mut g, &v, KIND);
    let hash_hex = hex::encode(verdict_hash(&v));

    set_callback_context(vec![PromiseResult::Successful(vec![])]);
    g.on_veto_result(hash_hex.clone());
    assert_eq!(g.veto_result(hash_hex.clone()), Some("Ok".to_owned()));
    let event = event_json(get_logs().last().unwrap());
    assert_eq!(event["event"], "veto_cast");
    assert_eq!(event["data"][0]["result"], "Ok");
}

#[test]
#[should_panic(expected = "ERR_NOT_CALLBACK")]
fn err_not_callback_without_a_promise_result() {
    let mut g = guard();
    set_callback_context(vec![]);
    g.on_veto_result(hex::encode([0u8; 32]));
}

#[test]
#[should_panic(expected = "ERR_BAD_HASH")]
fn err_bad_hash_for_short_hex() {
    let g = guard();
    g.was_used("abcd".to_owned());
}

#[test]
#[should_panic(expected = "ERR_BAD_KEY")]
fn err_bad_key_for_a_bare_base58_key() {
    set_context(GUARD, 0);
    let bare = key_string(&VERDICT_SEED).replace("ed25519:", "");
    let _ = KaapGuard::new(account(OWNER), bare, "sandbox".to_owned());
}

#[test]
#[should_panic(expected = "ERR_BAD_NETWORK")]
fn err_bad_network_for_a_capitalised_name() {
    set_context(GUARD, 0);
    let _ = KaapGuard::new(account(OWNER), key_string(&VERDICT_SEED), "Testnet".to_owned());
}

#[test]
fn enroll_emits_the_nep297_event_in_the_agreed_shape() {
    set_context(GUARD, 0);
    let mut g = KaapGuard::new(account(OWNER), key_string(&VERDICT_SEED), "sandbox".to_owned());
    set_context(DAO, 0);
    g.enroll();
    assert!(g.is_enrolled(account(DAO)));
    let logs = get_logs();
    assert_eq!(
        logs.last().unwrap(),
        r#"EVENT_JSON:{"standard":"kaap-guard","version":"1.0.0","event":"enrolled","data":[{"dao":"dao.near"}]}"#
    );
}

#[test]
#[should_panic(expected = "ERR_ALREADY_ENROLLED")]
fn err_already_enrolled() {
    let mut g = guard();
    set_context(DAO, 0);
    g.enroll();
}

#[test]
#[should_panic(expected = "ERR_NOT_ENROLLED")]
fn err_not_enrolled_on_unenroll() {
    let mut g = guard();
    g.unenroll();
}

#[test]
fn unenroll_stops_vetoes_for_that_dao() {
    let mut g = guard();
    set_context(DAO, 0);
    g.unenroll();
    assert!(!g.is_enrolled(account(DAO)));
    assert_eq!(event_json(get_logs().last().unwrap())["event"], "unenrolled");
}

#[test]
fn enrolled_daos_pages_and_caps_the_limit() {
    let mut g = guard();
    for i in 0..(MAX_ENROLLED_PAGE + 5) {
        set_context(&format!("dao-{i}.near"), 0);
        g.enroll();
    }
    let total = MAX_ENROLLED_PAGE + 6;
    assert_eq!(g.enrolled_daos(0, 1_000).len() as u64, MAX_ENROLLED_PAGE);
    assert_eq!(g.enrolled_daos(MAX_ENROLLED_PAGE, 1_000).len() as u64, total - MAX_ENROLLED_PAGE);
    assert_eq!(g.enrolled_daos(0, 1), vec![account(DAO)]);
    assert!(g.enrolled_daos(u64::MAX, 10).is_empty());
    assert!(g.enrolled_daos(0, 0).is_empty());
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn err_not_owner_on_set_accepted_key() {
    let mut g = guard();
    set_context(STRANGER, 1);
    g.set_accepted_key(key_string(&OTHER_SEED));
}

#[test]
#[should_panic(expected = "ERR_NEED_ONE_YOCTO")]
fn err_need_one_yocto_on_set_accepted_key() {
    let mut g = guard();
    set_context(OWNER, 0);
    g.set_accepted_key(key_string(&OTHER_SEED));
}

#[test]
#[should_panic(expected = "ERR_BAD_KEY")]
fn err_bad_key_on_set_accepted_key() {
    let mut g = guard();
    set_context(OWNER, 1);
    g.set_accepted_key(key_string(&OTHER_SEED).replace("ed25519", "ED25519"));
}

#[test]
fn set_accepted_key_swaps_the_key_and_says_so() {
    let mut g = guard();
    set_context(OWNER, 1);
    g.set_accepted_key(key_string(&OTHER_SEED));
    assert_eq!(g.accepted_key(), key_string(&OTHER_SEED));
    let event = event_json(get_logs().last().unwrap());
    assert_eq!(event["event"], "key_changed");
    assert_eq!(event["data"][0]["old_key"], key_string(&VERDICT_SEED).as_str());
    assert_eq!(event["data"][0]["new_key"], key_string(&OTHER_SEED).as_str());
}

#[test]
#[should_panic(expected = "ERR_BAD_SIGNATURE")]
fn err_bad_signature_from_the_old_key_after_a_key_change() {
    let mut g = guard();
    set_context(OWNER, 1);
    g.set_accepted_key(key_string(&OTHER_SEED));
    set_context(STRANGER, 0);
    veto(&mut g, &verdict(), KIND);
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn err_not_owner_on_propose_owner() {
    let mut g = guard();
    set_context(STRANGER, 1);
    g.propose_owner(account(STRANGER));
}

#[test]
#[should_panic(expected = "ERR_NOT_PENDING_OWNER")]
fn err_not_pending_owner_on_accept_by_someone_else() {
    let mut g = guard();
    set_context(OWNER, 1);
    g.propose_owner(account("new-owner.near"));
    set_context(STRANGER, 1);
    g.accept_owner();
}

#[test]
fn owner_transfer_takes_two_steps() {
    let mut g = guard();
    set_context(OWNER, 1);
    g.propose_owner(account("new-owner.near"));
    assert_eq!(g.owner(), account(OWNER), "proposing must not hand over ownership");
    assert_eq!(event_json(get_logs().last().unwrap())["event"], "owner_proposed");

    set_context("new-owner.near", 1);
    g.accept_owner();
    assert_eq!(g.owner(), account("new-owner.near"));
    let event = event_json(get_logs().last().unwrap());
    assert_eq!(event["event"], "owner_accepted");
    assert_eq!(event["data"][0]["old_owner"], OWNER);
    assert_eq!(event["data"][0]["new_owner"], "new-owner.near");
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn err_not_owner_for_the_old_owner_after_a_transfer() {
    let mut g = guard();
    set_context(OWNER, 1);
    g.propose_owner(account("new-owner.near"));
    set_context("new-owner.near", 1);
    g.accept_owner();
    set_context(OWNER, 1);
    g.set_accepted_key(key_string(&OTHER_SEED));
}
