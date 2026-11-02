// Unit tests for kaap-registry in near-sdk's mocked VM: each refusal, the append-only history,
// the page cap, and the storage charge with its refund.
//
// What this file does NOT cover:
// - real balances moving: the refund here is only a created receipt; the sandbox test in
//   packages/contracts/tests/registry.rs checks the money on chain;
// - gas, which the mocked VM does not charge for wasm (GAS.md);
// - whether the sealed job fills a verdict correctly; verdicts here are built by hand.

use ed25519_dalek::{Signer as _, SigningKey};
use kaap_verdict::{verdict_bytes, verdict_hash, AiStatus, FindingCode, Network, Severity, Verdict};
use near_sdk::json_types::Base64VecU8;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId, NearToken};

use super::*;

const REGISTRY: &str = "registry.near";
const CALLER: &str = "worker.near";
const DAO: &str = "dao.near";
const VERDICT_SEED: [u8; 32] = [7; 32];
const OTHER_SEED: [u8; 32] = [9; 32];
const NOW_MS: u64 = 1_800_000_000_000;
const DEPOSIT: NearToken = NearToken::from_millinear(20);

fn account(id: &str) -> AccountId {
    id.parse().unwrap()
}

fn key_string(seed: &[u8; 32]) -> String {
    let public = SigningKey::from_bytes(seed).verifying_key().to_bytes();
    format!("ed25519:{}", bs58::encode(public).into_string())
}

fn set_context(predecessor: &str, deposit: NearToken) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(account(REGISTRY))
        .predecessor_account_id(account(predecessor))
        .signer_account_id(account(predecessor))
        .attached_deposit(deposit)
        .block_timestamp(NOW_MS * 1_000_000)
        .block_height(500)
        .build());
}

fn verdict(proposal_id: u64, block_height: u64) -> Verdict {
    Verdict {
        version: 1,
        guard: "guard.near".to_owned(),
        network: Network::Sandbox,
        dao: DAO.to_owned(),
        proposal_id,
        kind_hash: [4; 32],
        policy_hash: [1; 32],
        receivers_hash: [2; 32],
        block_height,
        risk: Severity::Critical,
        floor: Severity::Critical,
        findings: vec![FindingCode::DescContradicts, FindingCode::NewRecipient],
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

fn registry() -> KaapRegistry {
    set_context(REGISTRY, NearToken::from_yoctonear(0));
    let registry = KaapRegistry::new(key_string(&VERDICT_SEED), "sandbox".to_owned());
    set_context(CALLER, DEPOSIT);
    registry
}

fn record(registry: &mut KaapRegistry, v: &Verdict) -> u32 {
    let (verdict, signature) = signed(v, &VERDICT_SEED);
    registry.record(verdict, signature)
}

fn event_json(log: &str) -> near_sdk::serde_json::Value {
    let body = log.strip_prefix("EVENT_JSON:").expect("not a NEP-297 event");
    near_sdk::serde_json::from_str(body).unwrap()
}

fn latest(registry: &KaapRegistry, proposal_id: u64) -> Option<VerdictRecord> {
    registry.latest("sandbox".to_owned(), account(DAO), proposal_id)
}

#[test]
fn record_charges_the_storage_it_used_and_refunds_the_rest() {
    let mut r = registry();
    let v = verdict(3, 100);
    let before = env::storage_usage();
    assert_eq!(record(&mut r, &v), 0);
    let used = env::storage_usage() - before;
    let cost = env::storage_byte_cost().saturating_mul(u128::from(used));
    assert!(used > 0);

    let event = event_json(get_logs().last().unwrap());
    assert_eq!(event["standard"], "kaap-registry");
    assert_eq!(event["event"], "verdict_recorded");
    assert_eq!(event["data"][0]["dao"], DAO);
    assert_eq!(event["data"][0]["proposal_id"], 3);
    assert_eq!(event["data"][0]["risk"], "critical");
    assert_eq!(event["data"][0]["verdict_hash"], hex::encode(verdict_hash(&v)).as_str());
    assert_eq!(event["data"][0]["storage_cost"], cost.as_yoctonear().to_string().as_str());
    let refund = DEPOSIT.saturating_sub(cost);
    assert_eq!(event["data"][0]["refund"], refund.as_yoctonear().to_string().as_str());

    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 1, "{receipts:?}");
    assert_eq!(receipts[0].receiver_id, account(CALLER));
    match receipts[0].actions.as_slice() {
        [MockAction::Transfer { deposit, .. }] => assert_eq!(*deposit, refund),
        other => panic!("the refund must be one plain transfer, got {other:?}"),
    }
}

#[test]
fn latest_returns_the_record_with_the_signed_bytes_and_decoded_fields() {
    let mut r = registry();
    let v = verdict(3, 100);
    record(&mut r, &v);
    let (verdict_b64, signature_b64) = signed(&v, &VERDICT_SEED);
    let found = latest(&r, 3).unwrap();
    assert_eq!(found.index, 0);
    assert_eq!(found.supersedes, None);
    assert_eq!(found.verdict, verdict_b64);
    assert_eq!(found.signature, signature_b64);
    assert_eq!(found.risk, "critical");
    assert_eq!(found.floor, "critical");
    assert_eq!(found.findings, vec!["DESC_CONTRADICTS", "NEW_RECIPIENT"]);
    assert_eq!(found.ai_status, "unavailable");
    assert_eq!(found.block_height, 100);
    assert_eq!(found.recorded_by, account(CALLER));
    assert_eq!(found.recorded_at_block, 500);
    assert_eq!(found.recorded_at_ms, NOW_MS);
    assert_eq!(latest(&r, 4), None);
    assert_eq!(r.latest("testnet".to_owned(), account(DAO), 3), None);
}

#[test]
fn a_newer_verdict_is_stored_next_to_the_older_one_never_over_it() {
    let mut r = registry();
    let first = verdict(3, 100);
    let second = Verdict { risk: Severity::High, ..verdict(3, 120) };
    record(&mut r, &first);
    let before = r.history("sandbox".to_owned(), account(DAO), 3, 0, 10);
    set_context(CALLER, DEPOSIT);
    assert_eq!(record(&mut r, &second), 1);

    let history = r.history("sandbox".to_owned(), account(DAO), 3, 0, 10);
    assert_eq!(history.len(), 2);
    assert_eq!(history[0], before[0], "the first record changed when the second arrived");
    assert_eq!(history[1].index, 1);
    assert_eq!(history[1].supersedes, Some(0));
    assert_eq!(history[1].risk, "high");
    assert_eq!(latest(&r, 3).unwrap().verdict_hash, hex::encode(verdict_hash(&second)));
}

#[test]
fn history_caps_the_page_and_pages_past_the_end_are_empty() {
    let mut r = registry();
    let total = MAX_HISTORY_PAGE + 5;
    for height in 0..total {
        set_context(CALLER, DEPOSIT);
        record(&mut r, &verdict(3, height));
    }
    let page = |from, limit| r.history("sandbox".to_owned(), account(DAO), 3, from, limit);
    assert_eq!(page(0, 1_000).len() as u64, MAX_HISTORY_PAGE);
    assert_eq!(page(MAX_HISTORY_PAGE, 1_000).len(), 5);
    assert_eq!(page(MAX_HISTORY_PAGE, 1_000)[0].index as u64, MAX_HISTORY_PAGE);
    assert!(page(total, 10).is_empty());
    assert!(page(u64::MAX, 10).is_empty());
    assert!(page(0, 0).is_empty());
}

#[test]
fn an_older_verdict_recorded_later_never_becomes_latest() {
    let mut r = registry();
    let newer = verdict(3, 120);
    let older = Verdict { risk: Severity::Low, ..verdict(3, 100) };
    record(&mut r, &newer);
    set_context(CALLER, DEPOSIT);
    assert_eq!(record(&mut r, &older), 1);

    let found = latest(&r, 3).unwrap();
    assert_eq!(found.index, 0);
    assert_eq!(found.verdict_hash, hex::encode(verdict_hash(&newer)));
    let history = r.history("sandbox".to_owned(), account(DAO), 3, 0, 10);
    assert_eq!(history.len(), 2, "the older verdict is still kept");
    assert_eq!(history[1].supersedes, None, "a stale verdict supersedes nothing");

    // A verdict read at the same block as the latest is newer information, so it wins the tie.
    set_context(CALLER, DEPOSIT);
    let same_block = Verdict { risk: Severity::High, ..verdict(3, 120) };
    assert_eq!(record(&mut r, &same_block), 2);
    let found = latest(&r, 3).unwrap();
    assert_eq!(found.index, 2);
    assert_eq!(found.supersedes, Some(0));
}

#[test]
fn the_accepted_key_and_network_are_readable() {
    let r = registry();
    assert_eq!(r.accepted_key(), key_string(&VERDICT_SEED));
    assert_eq!(r.network(), "sandbox");
}

#[test]
#[should_panic(expected = "ERR_TOO_LARGE")]
fn err_too_large_above_the_cap() {
    let mut r = registry();
    let (_, signature) = signed(&verdict(3, 100), &VERDICT_SEED);
    r.record(Base64VecU8(vec![0; MAX_VERDICT_BYTES + 1]), signature);
}

#[test]
#[should_panic(expected = "ERR_BAD_VERDICT")]
fn err_bad_verdict_on_bytes_that_are_not_a_verdict() {
    let mut r = registry();
    let (_, signature) = signed(&verdict(3, 100), &VERDICT_SEED);
    r.record(Base64VecU8(vec![1, 2, 3]), signature);
}

#[test]
#[should_panic(expected = "ERR_BAD_VERDICT")]
fn err_bad_verdict_on_a_signed_version_2() {
    let mut r = registry();
    record(&mut r, &Verdict { version: 2, ..verdict(3, 100) });
}

#[test]
#[should_panic(expected = "ERR_BAD_VERDICT")]
fn err_bad_verdict_on_a_dao_that_is_not_an_account_id() {
    let mut r = registry();
    record(&mut r, &Verdict { dao: "Not An Account".to_owned(), ..verdict(3, 100) });
}

#[test]
#[should_panic(expected = "ERR_BAD_SIGNATURE")]
fn err_bad_signature_from_another_key() {
    let mut r = registry();
    let (v, signature) = signed(&verdict(3, 100), &OTHER_SEED);
    r.record(v, signature);
}

#[test]
#[should_panic(expected = "ERR_WRONG_NETWORK")]
fn err_wrong_network() {
    let mut r = registry();
    record(&mut r, &Verdict { network: Network::Mainnet, ..verdict(3, 100) });
}

#[test]
#[should_panic(expected = "ERR_DUPLICATE")]
fn err_duplicate_for_the_same_verdict_twice() {
    let mut r = registry();
    let v = verdict(3, 100);
    record(&mut r, &v);
    set_context(CALLER, DEPOSIT);
    record(&mut r, &v);
}

#[test]
#[should_panic(expected = "ERR_NOT_ENOUGH_DEPOSIT")]
fn err_not_enough_deposit() {
    let mut r = registry();
    set_context(CALLER, NearToken::from_yoctonear(1));
    record(&mut r, &verdict(3, 100));
}

#[test]
#[should_panic(expected = "ERR_BAD_KEY")]
fn err_bad_key_at_init() {
    set_context(REGISTRY, NearToken::from_yoctonear(0));
    let _ = KaapRegistry::new(key_string(&VERDICT_SEED).replace("ed25519:", ""), "sandbox".to_owned());
}

#[test]
#[should_panic(expected = "ERR_BAD_NETWORK")]
fn err_bad_network_at_init() {
    set_context(REGISTRY, NearToken::from_yoctonear(0));
    let _ = KaapRegistry::new(key_string(&VERDICT_SEED), "localnet".to_owned());
}

#[test]
#[should_panic(expected = "ERR_BAD_NETWORK")]
fn err_bad_network_in_a_view() {
    let r = registry();
    let _ = r.latest("Mainnet".to_owned(), account(DAO), 3);
}
