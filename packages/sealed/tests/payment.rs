//! The paid check as whole runs on real recorded answers: who pays, what a refusal prints and that
//! it reaches nothing, that Kaap's own runs are unchanged, and that a paid run leaves no public
//! evidence. The rules of `gate` itself are tested beside it in `src/payment.rs`. Not covered here:
//! real money on either door, OutLayer setting these variables as its source says, a payer's own
//! derived key (the test signer stands in for every caller), and whether OutLayer keeps a refused
//! run's amount.

mod common;

use std::cell::Cell;
use std::rc::Rc;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use common::world::{nonce, quote_binding_the_model, World, KEY, NOW};
use common::*;
use kaap_core::{AiStatus, Network};
use kaap_sealed::fixture::FixtureHttp;
use kaap_sealed::input::{parse_request, Request};
use kaap_sealed::job::{judge_run, run, Connections, RunEnv};
use kaap_sealed::net::{Deadline, Http, DRPC_TESTNET, HOST_STAND_IN_TESTNET};
use kaap_sealed::output::MAX_OUTPUT_BYTES;
use kaap_sealed::payment::{PayEnv, Payer, TESTNET_WORKER};
use kaap_sealed::rpc::RpcProvider;
use kaap_sealed::texts::{ecies_encrypt, text_context, text_public_key, SEALED_PREFIX};
use serde_json::{json, Value};
use x25519_dalek::{PublicKey, StaticSecret};

const DAO: &str = "corm1gu.sputnikv2.testnet";
const ID: u64 = 1;
const STRANGER: &str = "stranger.testnet";

fn input_for(dao: &str, id: u64, extra: &str) -> String {
    format!(r#"{{"v":1,"network":"testnet","guard":"guard.kaap.testnet","dao":"{dao}","proposal_id":{id},"expires_in_ms":600000{extra}}}"#)
}

fn input() -> String {
    input_for(DAO, ID, "")
}

fn https(amount: Option<&str>) -> PayEnv {
    PayEnv { execution_type: Some("HTTPS".into()), usd_payment: amount.map(Into::into), attached_usd: Some("0".into()), sender: Some(STRANGER.into()) }
}

fn chain(sender: Option<&str>, amount: Option<&str>) -> PayEnv {
    PayEnv { execution_type: Some("NEAR".into()), usd_payment: Some("0".into()), attached_usd: amount.map(Into::into), sender: sender.map(Into::into) }
}

fn on_testnet(pay: PayEnv) -> RunEnv<'static> {
    RunEnv { network: Some("testnet"), pay }
}

fn no_ai() -> Scripted {
    Scripted(Vec::new(), Vec::new())
}

fn refusal(paid: u64) -> String {
    format!(r#"{{"detail":"A check costs 10000 millionths of a dollar. This run carried {paid}. An underpayment is not refunded.","reason":"payment_below_price","status":"refused","v":1}}"#)
}

/// Everything a run can reach, each part noted: the outside calls, the public evidence store, and
/// whether the run connected at all.
#[derive(Clone, Default)]
struct Reach {
    calls: Records,
    store: Store,
    connected: Rc<Cell<bool>>,
}

impl Reach {
    fn connect(&self, fx: &Value, ai: impl Http + 'static) -> impl FnOnce(Network, Deadline) -> Connections {
        let (text, reach) = (fx.to_string(), self.clone());
        move |_, deadline| {
            reach.connected.set(true);
            let http = || Noted(FixtureHttp::from_json(&text).unwrap(), reach.calls.clone());
            Connections {
                host: Box::new(RpcProvider::new(http(), HOST_STAND_IN_TESTNET, deadline)),
                https: Box::new(RpcProvider::new(http(), DRPC_TESTNET, deadline)),
                ai: Box::new(Noted(ai, reach.calls.clone())),
                signer: Box::new(TestSigner::new()),
                texts: Box::new(TestTexts::new()),
                nonce: Some([0; 32]),
                block_timestamp: None,
                quote: kaap_sealed::attest::tdx::check_quote,
                evidence: Box::new(reach.store.clone()),
            }
        }
    }

    fn assert_untouched(&self) {
        assert!(!self.connected.get(), "the run connected");
        assert!(self.calls.borrow().is_empty(), "an outside call: {:?}", self.calls.borrow());
        assert!(self.store.records.borrow().is_empty(), "an evidence write");
    }
}

/// The transfer fixture run for `pay`, with what it reached.
fn checked(pay: PayEnv) -> (String, Reach) {
    let reach = Reach::default();
    let out = run(input().as_bytes(), on_testnet(pay), None, reach.connect(&fixture("transfer-ft.json"), no_ai()));
    (out, reach)
}

#[test]
fn a_worker_run_on_chain_is_free_and_byte_identical_to_a_run_without_the_gate() {
    let without = Reach::default();
    let Ok(Request::Judge(parsed)) = parse_request(input().as_bytes(), Some("testnet")) else { panic!("the input parses") };
    let expected = judge_run(parsed, None, Payer::Kaap, without.connect(&fixture("transfer-ft.json"), no_ai()));
    assert_eq!(without.store.records.borrow().len(), 1);

    for amount in [Some("0"), None] {
        let (out, reach) = checked(chain(Some(TESTNET_WORKER), amount));
        assert_eq!(out, expected, "{amount:?}");
        assert_eq!(*reach.calls.borrow(), *without.calls.borrow(), "the same calls in the same order");
        assert_eq!(*reach.store.records.borrow(), *without.store.records.borrow(), "the same evidence");
    }
}

#[test]
fn an_https_run_at_the_price_or_above_is_the_same_check_with_no_evidence() {
    let (worker_out, worker) = checked(chain(Some(TESTNET_WORKER), Some("0")));
    for amount in ["10000", "25000"] {
        let (out, reach) = checked(https(Some(amount)));
        assert_eq!(out, worker_out, "the same check, {amount}");
        assert_eq!(*reach.calls.borrow(), *worker.calls.borrow(), "the same calls, {amount}");
        assert!(reach.store.records.borrow().is_empty(), "no evidence write, {amount}");
    }
    assert_eq!(worker.store.records.borrow().len(), 1, "a Kaap run on the same answers does write");
}

#[test]
fn an_https_run_below_the_price_is_refused_and_reaches_nothing() {
    for (amount, paid) in [(Some("9999"), 9999), (Some("0"), 0), (Some(""), 0), (Some("abc"), 0), (None, 0)] {
        let (out, reach) = checked(https(amount));
        assert_eq!(out, refusal(paid), "{amount:?}");
        assert!(out.len() <= MAX_OUTPUT_BYTES);
        reach.assert_untouched();
    }
}

#[test]
fn a_chain_run_from_anyone_else_pays_with_its_attached_amount() {
    for sender in [Some(STRANGER), None] {
        let (out, reach) = checked(chain(sender, Some("10000")));
        open(&out);
        assert!(reach.connected.get(), "{sender:?}");
        assert!(reach.store.records.borrow().is_empty(), "no evidence write, {sender:?}");

        for amount in [Some("0"), None] {
            let (out, reach) = checked(chain(sender, amount));
            assert_eq!(out, refusal(0), "{sender:?} {amount:?}");
            reach.assert_untouched();
        }
    }
}

#[test]
fn no_input_field_can_name_the_worker_or_the_amount() {
    for extra in [r#","sender":"kaap""#, r#","worker":"stranger.testnet""#, r#","attached_usd":"10000""#, r#","usd_payment":"10000""#] {
        let reach = Reach::default();
        let raw = input_for(DAO, ID, extra);
        let out = run(raw.as_bytes(), on_testnet(chain(Some(STRANGER), Some("0"))), None, reach.connect(&fixture("transfer-ft.json"), no_ai()));
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["reason"], "input is not {v,network,guard,dao,proposal_id,expires_in_ms}", "{extra}");
        reach.assert_untouched();
    }
}

#[test]
fn asking_for_the_text_key_stays_free_on_either_door() {
    for pay in [https(Some("0")), https(None), chain(Some(STRANGER), Some("0")), chain(None, None), PayEnv::default()] {
        let reach = Reach::default();
        let out = run(br#"{"v":1,"op":"pubkey"}"#, on_testnet(pay.clone()), None, reach.connect(&fixture("transfer-ft.json"), no_ai()));
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["status"], "ok", "{pay:?}");
        assert_eq!(v["text_key"], hex::encode(text_public_key(&mut TestTexts::new()).unwrap()));
        assert!(reach.calls.borrow().is_empty() && reach.store.records.borrow().is_empty(), "{pay:?}");
    }
}

#[test]
fn a_paid_run_may_carry_a_sealed_text() {
    let reply = PublicKey::from(&StaticSecret::from([42; 32])).to_bytes();
    let text = json!({ "message": "a text", "nonce": STANDARD.encode([9; 32]), "recipient": "intents.near", "standard": "nep413" }).to_string();
    let job_key = text_public_key(&mut TestTexts::new()).unwrap();
    let aad = text_context(Network::Testnet, DAO, ID, &reply);
    let ciphertext = ecies_encrypt(&mut TestTexts::keyed(7), &job_key, text.as_bytes(), &aad).unwrap();
    let extra = format!(r#","text_ciphertext":"{}","reply_key":"{}""#, STANDARD.encode(ciphertext), hex::encode(reply));

    let reach = Reach::default();
    let raw = input_for(DAO, ID, &extra);
    let out = run(raw.as_bytes(), on_testnet(https(Some("10000"))), None, reach.connect(&fixture("transfer-ft.json"), no_ai()));
    let (_, json) = open(&out);
    assert!(json["explanation"].as_str().unwrap().starts_with(SEALED_PREFIX), "{out}");
    assert!(reach.store.records.borrow().is_empty());
}

#[test]
fn a_paid_run_cannot_sign_verified_because_it_publishes_no_evidence() {
    let mut fx = fixture("function-call.json");
    let ns = NOW * 1_000_000_000;
    for authority in [HTTPS, HOST] {
        edit_answer(&mut fx, authority, "block", |b| b["result"]["header"]["timestamp"] = json!(ns));
    }
    let judged = |pay: PayEnv| {
        let reach = Reach::default();
        let plain = reach.connect(&fx, World::new());
        let raw = input_for("r7thmvr8maey.sputnikv2.testnet", 10, "");
        let out = run(raw.as_bytes(), on_testnet(pay), Some(KEY), move |network, deadline| Connections {
            nonce: Some(nonce()),
            block_timestamp: Some(ns.to_string()),
            quote: quote_binding_the_model,
            ..plain(network, deadline)
        });
        let (verdict, json) = open(&out);
        let records = reach.store.records.borrow().len();
        (verdict.ai_status, json["explanation"].as_str().unwrap().to_string(), records)
    };

    let (status, explanation, records) = judged(chain(Some(TESTNET_WORKER), Some("0")));
    assert_eq!((status, records), (AiStatus::Verified, 1), "{explanation}");

    let (status, explanation, records) = judged(chain(Some(STRANGER), Some("10000")));
    assert_eq!((status, records), (AiStatus::Unverified, 0), "{explanation}");
    assert!(explanation.starts_with("AI unverified (the evidence could not be published). "), "{explanation}");
}

#[test]
fn mainnet_has_no_free_caller_until_it_has_a_worker() {
    let raw = br#"{"v":1,"network":"mainnet","guard":"guard.kaap.near","dao":"kaap.sputnik-dao.near","proposal_id":1,"expires_in_ms":600000}"#;
    for sender in [TESTNET_WORKER, "", STRANGER] {
        let reach = Reach::default();
        let env = RunEnv { network: Some("mainnet"), pay: chain(Some(sender), Some("0")) };
        let out = run(raw, env, None, reach.connect(&fixture("transfer-ft.json"), no_ai()));
        assert_eq!(out, refusal(0), "{sender:?}");
        reach.assert_untouched();
    }
}
