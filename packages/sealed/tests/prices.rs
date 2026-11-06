//! Whole runs of the job on mainnet with 1Click's saved list and real saved `get_proposals` pages,
//! through the real JSON-RPC provider: what a payment reads as once both reads arrive, every way a
//! read can fail, and testnet staying exactly as it was. Not covered here: live 1Click and live
//! mainnet (the publish order's proof), the OutLayer host's own `view` (a stand-in answers as the
//! host, whose lossy text decoding of a page these tests do not exercise), a history call that hangs
//! (only the deadline between calls is tested, in `src/history.rs`), and the rule that turns pages
//! into a history (`packages/core/tests/history_before.rs`).

mod common;

use std::cell::RefCell;
use std::path::Path;
use std::rc::Rc;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use common::*;
use kaap_core::history::history_before;
use kaap_core::prices::prices_from_tokens;
use kaap_core::{Analysis, DescCheck, FindingCode, Network, Prices, Severity};
use kaap_sealed::fixture::FixtureHttp;
use kaap_sealed::input::{parse_input, JobInput};
use kaap_sealed::job::{judge_run, read_past, run, Connections, RunEnv, PAST_BUDGET_MS};
use kaap_sealed::net::{
    Deadline, Http, HttpFail, Request, Response, DRPC_MAINNET, DRPC_TESTNET, HOST_STAND_IN_MAINNET, HOST_STAND_IN_TESTNET, ONECLICK_TOKENS,
};
use kaap_sealed::payment::{PayEnv, Payer};
use kaap_sealed::prompt::{user_message, FACTS_PREAMBLE};
use kaap_sealed::proposal::{judge, proposal_input, Past};
use kaap_sealed::reads::{read_chain, ChainRead};
use kaap_sealed::rpc::{RpcProvider, MAX_VIEW_BYTES};
use kaap_sealed::verdict::sha256;
use serde_json::{json, Value};

const TOKENS: &str = include_str!("fixtures/oneclick-tokens-2026-11-05.json");
const POLICY: &str = r#"{"roles":[{"name":"council","kind":{"Group":["member.near"]},"permissions":["*:*"],"vote_policy":{}}],"default_vote_policy":{"weight_kind":"RoleWeight","quorum":"0","threshold":[1,2]},"proposal_bond":"1","proposal_period":"1","bounty_bond":"1","bounty_forgiveness_period":"1"}"#;
const DAO: &str = "n1-treasury.sputnik-dao.near";
const KNOWN: &str = "near-prime.sputnik-dao.near";
const ID: u64 = 277;
const HEIGHT: u64 = 223_196_155;
const BLOCK_HASH: &str = "blockhash";
const CODE_HASH: &str = "11111111111111111111111111111111";
const FILED_NS: u64 = 1_793_800_000_000_000_000;
const NEAR_USD: f64 = 3.73;

/// The whole output and the whole prompt on testnet at commit 28f079d, before any of this existed,
/// as sha256 of the exact bytes.
const BEFORE: [(&str, &str, &str); 3] = [
    (
        "transfer-ft.json",
        "11b43ca0b4b379fd442cadf48c23594ff56c665f9b98dc4b5be4f57fe8bf78ac",
        "c2eba1e9d998f346c7a21e27f3a139b98ed5665b620bb1205979d6d133be03e8",
    ),
    (
        "function-call.json",
        "1053a585e7ffd5a3fd434a0a0f7c225f22bdd9a1af2a4abb8e0386f34651cf19",
        "f806f12c70ba27ccd579319ab165bfab32196187315865f6319a85c25ccf9571",
    ),
    (
        "vote.json",
        "848a4a546cfc4f10482210d6caa7950b9886ed1a22be91d4e8b302112c77c6eb",
        "cc5263ef5ff19e8dc4ec447fbef705a439925db1c045a3819751fcc6311217ad",
    ),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Trouble {
    Nothing,
    ListStatus500,
    ListGarbage,
    ListEmpty,
    ListOversized,
    ListTimedOut,
    ListHangs,
    PageRefused,
    PageOversized,
    ProvidersDisagree,
    TooManyIds,
}

/// Mainnet and 1Click behind one `Http`, answering each request as the real host would, with the
/// same body caps a real transport enforces. Clones share what was asked.
#[derive(Clone)]
struct Stage {
    proposal: String,
    proposals: Rc<Vec<Value>>,
    trouble: Trouble,
    list_ms: u64,
    calls: Rc<RefCell<Vec<String>>>,
    list_limits: Rc<RefCell<Vec<u64>>>,
}

impl Stage {
    fn new(proposal: String) -> Stage {
        Stage { proposal, proposals: Rc::new(saved_page(0)), trouble: Trouble::Nothing, list_ms: 0, calls: Rc::default(), list_limits: Rc::default() }
    }

    fn with(&self, trouble: Trouble) -> Stage {
        Stage { trouble, calls: Rc::default(), list_limits: Rc::default(), ..self.clone() }
    }

    fn asked(&self, what: &str) -> usize {
        self.calls.borrow().iter().filter(|call| call.ends_with(what)).count()
    }

    fn list(&self, r: &Request<'_>) -> Result<Response, HttpFail> {
        self.calls.borrow_mut().push("1click".to_string());
        self.list_limits.borrow_mut().push(r.limits.overall_ms);
        std::thread::sleep(Duration::from_millis(self.list_ms));
        let body = match self.trouble {
            Trouble::ListStatus500 => return Ok(Response::new(500, TOKENS.as_bytes().to_vec())),
            Trouble::ListTimedOut => return Err(HttpFail::Timeout),
            Trouble::ListHangs => {
                std::thread::sleep(Duration::from_millis(r.limits.overall_ms));
                return Err(HttpFail::Timeout);
            }
            Trouble::ListGarbage => b"<html>busy</html>".to_vec(),
            Trouble::ListEmpty => b"[]".to_vec(),
            Trouble::ListOversized => vec![b' '; 1024 * 1024 + 1],
            _ => TOKENS.as_bytes().to_vec(),
        };
        if body.len() > r.limits.max_body_bytes {
            return Err(HttpFail::TooLarge);
        }
        Ok(Response::new(200, body))
    }

    fn view(&self, r: &Request<'_>, params: &Value) -> Value {
        let method = params["method_name"].as_str().unwrap();
        self.calls.borrow_mut().push(format!("{} {method}", r.endpoint.authority));
        let is_host = r.endpoint == HOST_STAND_IN_MAINNET;
        let bytes: Vec<u8> = match method {
            "get_proposal" => self.proposal.clone().into_bytes(),
            "get_policy" => POLICY.as_bytes().to_vec(),
            "get_last_proposal_id" if self.trouble == Trouble::TooManyIds => b"301".to_vec(),
            "get_last_proposal_id" => self.proposals.len().to_string().into_bytes(),
            "get_proposals" if self.trouble == Trouble::PageRefused => return json!({ "error": { "message": "refused" } }),
            "get_proposals" if self.trouble == Trouble::PageOversized => vec![b' '; MAX_VIEW_BYTES + 1],
            "get_proposals" => {
                let args: Value = serde_json::from_slice(&STANDARD.decode(params["args_base64"].as_str().unwrap()).unwrap()).unwrap();
                let from = usize::try_from(args["from_index"].as_u64().unwrap()).unwrap();
                let end = self.proposals.len().min(from + 100);
                let mut page = serde_json::to_vec(&self.proposals[from..end]).unwrap();
                if is_host && self.trouble == Trouble::ProvidersDisagree {
                    page.push(b' ');
                }
                page
            }
            other => panic!("{other} was not expected"),
        };
        json!({ "result": { "result": bytes, "block_height": HEIGHT, "block_hash": BLOCK_HASH } })
    }

    fn providers(&self, deadline: Deadline) -> (RpcProvider<Stage>, RpcProvider<Stage>) {
        (RpcProvider::new(self.clone(), HOST_STAND_IN_MAINNET, deadline), RpcProvider::new(self.clone(), DRPC_MAINNET, deadline))
    }
}

impl Http for Stage {
    fn send(&mut self, r: &Request<'_>) -> Result<Response, HttpFail> {
        if r.endpoint == ONECLICK_TOKENS {
            return self.list(r);
        }
        let call: Value = serde_json::from_slice(r.body.unwrap()).unwrap();
        let answer = if call["method"] == "block" {
            json!({ "result": { "header": { "height": HEIGHT, "hash": BLOCK_HASH, "timestamp": FILED_NS + 1 } } })
        } else if call["params"]["request_type"] == "view_account" {
            json!({ "result": { "code_hash": CODE_HASH, "block_height": HEIGHT, "block_hash": BLOCK_HASH } })
        } else {
            self.view(r, &call["params"])
        };
        let body = answer.to_string().into_bytes();
        if body.len() > r.limits.max_body_bytes {
            return Err(HttpFail::TooLarge);
        }
        Ok(Response::new(200, body))
    }
}

/// The proposals of one real page in the shared fixture: 0 is the treasury that pays by Transfer,
/// 1 the NEAR Business treasury with no payment on record.
fn saved_page(page: usize) -> Vec<Value> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../core/tests/fixtures/history-parity.json");
    let fx: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    fx["real_pages"][page]["proposals"].as_array().unwrap().clone()
}

fn saved_prices() -> Prices {
    prices_from_tokens(TOKENS).unwrap()
}

fn median_usd() -> f64 {
    history_before(&saved_page(0), FILED_NS, &saved_prices()).median_payment_usd_before.unwrap()
}

fn payment(to: &str, whole_near: u64, description: &str) -> String {
    let amount = format!("{whole_near}{}", "0".repeat(24));
    json!({
        "id": ID, "proposer": "proposer.near", "description": description,
        "kind": { "Transfer": { "token_id": "", "receiver_id": to, "amount": amount, "msg": null } },
        "status": "InProgress", "vote_counts": {}, "votes": {}, "submission_time": FILED_NS.to_string(),
    })
    .to_string()
}

fn usual_payment() -> String {
    payment(KNOWN, 5_600, "Pay 5600 NEAR to near-prime.sputnik-dao.near for the quarter")
}

fn raw_input() -> String {
    format!(r#"{{"v":1,"network":"mainnet","guard":"guard.kaap.near","dao":"{DAO}","proposal_id":{ID},"expires_in_ms":600000}}"#)
}

fn paid() -> RunEnv<'static> {
    let pay = PayEnv {
        execution_type: Some("HTTPS".into()),
        usd_payment: Some("10000".into()),
        attached_usd: Some("0".into()),
        sender: Some("payer.near".into()),
    };
    RunEnv { network: Some("mainnet"), pay }
}

fn connect(stage: &Stage) -> impl FnOnce(Network, Deadline) -> Connections {
    let stage = stage.clone();
    move |network, deadline| {
        assert_eq!(network, Network::Mainnet);
        let (host, https) = stage.providers(deadline);
        Connections {
            host: Box::new(host),
            https: Box::new(https),
            http: Box::new(stage),
            signer: Box::new(TestSigner::new()),
            texts: Box::new(TestTexts::new()),
            nonce: Some([0; 32]),
            block_timestamp: None,
            quote: kaap_sealed::attest::tdx::check_quote,
            evidence: Box::new(Store::default()),
        }
    }
}

fn whole_job(stage: &Stage) -> String {
    run(raw_input().as_bytes(), paid(), None, connect(stage))
}

fn parts(stage: &Stage) -> (JobInput, ChainRead) {
    let input = parse_input(raw_input().as_bytes(), Some("mainnet")).unwrap();
    let deadline = Deadline::after_ms(60_000);
    let (mut host, mut https) = stage.providers(deadline);
    let read = read_chain(&mut host, &mut https, &input.dao, input.proposal_id, deadline, 0).unwrap();
    stage.calls.borrow_mut().clear();
    (input, read)
}

fn past_of(stage: &Stage, input: &JobInput, read: &ChainRead, deadline: Deadline) -> Option<Past> {
    let (mut host, mut https) = stage.providers(deadline);
    read_past(&mut stage.clone(), &mut host, &mut https, input, read, deadline)
}

fn codes(analysis: &Analysis) -> Vec<FindingCode> {
    analysis.findings.iter().map(|f| f.code).collect()
}

/// `stage`'s verdict from a whole run, its findings and its floor, with the risk equal to the floor
/// because no AI key reaches a test run.
fn judged(stage: &Stage) -> (Vec<FindingCode>, Severity) {
    let (verdict, _) = open(&whole_job(stage));
    assert_eq!(verdict.risk, verdict.floor);
    (verdict.findings, verdict.floor)
}

#[test]
fn a_usual_near_payment_to_a_known_recipient_stays_quiet() {
    let stage = Stage::new(usual_payment());
    assert_eq!(judged(&stage), (Vec::new(), Severity::Low));
    assert_eq!(stage.asked(" get_proposals"), 2, "one page, from each provider");
    assert_eq!(stage.asked("near.drpc.org get_last_proposal_id"), 1);
    assert_eq!(stage.asked("1click"), 1);
}

#[test]
fn a_new_recipient_gets_new_recipient_at_medium() {
    let stage = Stage::new(payment("stranger.near", 5_600, "Pay 5600 NEAR to stranger.near for the quarter"));
    assert_eq!(judged(&stage), (vec![FindingCode::NewRecipient], Severity::Medium));
}

#[test]
fn more_than_ten_times_the_median_gets_large_amount() {
    let over = (11.0 * median_usd() / NEAR_USD).ceil() as u64;
    let under = (9.0 * median_usd() / NEAR_USD).floor() as u64;
    let to_known = |near: u64| Stage::new(payment(KNOWN, near, &format!("Pay {near} NEAR to {KNOWN} for the quarter")));
    assert_eq!(judged(&to_known(over)), (vec![FindingCode::LargeAmount], Severity::Medium));
    assert_eq!(judged(&to_known(under)), (Vec::new(), Severity::Low));
}

#[test]
fn a_huge_payment_to_a_stranger_with_an_honest_description_is_a_warning_and_never_a_veto() {
    let stage = Stage::new(payment("stranger.near", 1_000_000, "Pay 1000000 NEAR to stranger.near for the quarter"));
    let (findings, floor) = judged(&stage);
    assert_eq!(floor, Severity::Medium);
    assert!(findings.contains(&FindingCode::NewRecipient) && findings.contains(&FindingCode::LargeAmount), "{findings:?}");
    let (input, read) = parts(&stage);
    let past = past_of(&stage, &input, &read, Deadline::after_ms(25_000));
    let (_, analysis) = judge(&input, None, &read, past);
    assert_eq!(codes(&analysis), findings);
    assert_eq!(analysis.description_check, DescCheck::Matches);
    assert!(!analysis.veto_allowed && !analysis.must_veto);
}

#[test]
fn every_failed_read_keeps_todays_verdict_with_unknown_value_at_high() {
    let stage = Stage::new(usual_payment());
    let (input, read) = parts(&stage);
    let (_, today) = judge(&input, None, &read, None);
    assert_eq!(today.risk_floor, Severity::High);
    assert!(codes(&today).contains(&FindingCode::UnknownValue));

    let mut unread_time: Value = serde_json::from_str(&usual_payment()).unwrap();
    unread_time["submission_time"] = json!("soon");
    let troubles = [
        Trouble::ListStatus500,
        Trouble::ListGarbage,
        Trouble::ListEmpty,
        Trouble::ListOversized,
        Trouble::ListTimedOut,
        Trouble::PageRefused,
        Trouble::PageOversized,
        Trouble::ProvidersDisagree,
        Trouble::TooManyIds,
    ];
    let mut outputs = Vec::new();
    for trouble in troubles {
        let out = whole_job(&stage.with(trouble));
        let (verdict, _) = open(&out);
        assert_eq!((verdict.floor, verdict.risk), (Severity::High, Severity::High), "{trouble:?}");
        assert_eq!(verdict.findings, codes(&today), "{trouble:?}");
        outputs.push(out);
    }
    assert!(outputs.iter().all(|out| *out == outputs[0]), "every failure signs one and the same verdict");

    let unread = Stage::new(unread_time.to_string());
    let (verdict, _) = open(&whole_job(&unread));
    assert_eq!((verdict.floor, verdict.findings), (Severity::High, codes(&today)), "a held job would not open");
    assert!(unread.calls.borrow().iter().all(|call| !call.contains("get_proposals") && call != "1click"));
}

#[test]
fn a_failed_price_list_never_starts_the_history_read() {
    for trouble in [Trouble::ListStatus500, Trouble::ListEmpty, Trouble::ListTimedOut] {
        let stage = Stage::new(usual_payment()).with(trouble);
        open(&whole_job(&stage));
        assert_eq!((stage.asked(" get_last_proposal_id"), stage.asked(" get_proposals")), (0, 0), "{trouble:?}");
    }
}

#[test]
fn testnet_makes_neither_read_and_prints_and_prompts_what_it_did_before() {
    for (name, output, prompt) in BEFORE {
        let fx = fixture(name);
        let (dao, id) = (fx["dao"].as_str().unwrap().to_string(), fx["proposal_id"].as_u64().unwrap());
        let raw = format!(r#"{{"v":1,"network":"testnet","guard":"guard.kaap.testnet","dao":"{dao}","proposal_id":{id},"expires_in_ms":600000}}"#);
        let (calls, seen, text) = (Records::default(), Records::default(), fx.to_string());
        let (chain_calls, http_calls) = (seen.clone(), calls.clone());
        let out = run(raw.as_bytes(), worker_env(Some("testnet")), None, move |_, deadline| {
            let chain = || Noted(FixtureHttp::from_json(&text).unwrap(), chain_calls.clone());
            Connections {
                host: Box::new(RpcProvider::new(chain(), HOST_STAND_IN_TESTNET, deadline)),
                https: Box::new(RpcProvider::new(chain(), DRPC_TESTNET, deadline)),
                http: Box::new(Noted(Scripted(Vec::new(), Vec::new()), http_calls)),
                signer: Box::new(TestSigner::new()),
                texts: Box::new(TestTexts::new()),
                nonce: Some([0; 32]),
                block_timestamp: None,
                quote: kaap_sealed::attest::tdx::check_quote,
                evidence: Box::new(Store::default()),
            }
        });
        assert_eq!(hex::encode(sha256(out.as_bytes())), output, "{name}: the output changed");
        assert!(calls.borrow().is_empty(), "{name}: {:?}", calls.borrow());
        assert!(!seen.borrow().is_empty());
        for (_, body) in seen.borrow().iter() {
            let body = String::from_utf8_lossy(body);
            assert!(!body.contains("get_proposals") && !body.contains("get_last_proposal_id"), "{name}: {body}");
        }

        let (mut host, mut https) = providers(&fx);
        let read = read_chain(&mut host, &mut https, &dao, id, Deadline::after_ms(60_000), 0).unwrap();
        let input = parse_input(raw.as_bytes(), Some("testnet")).unwrap();
        let (proposal, analysis) = judge(&input, None, &read, None);
        let message = user_message(&proposal, &analysis).unwrap();
        assert_eq!(hex::encode(sha256(message.as_bytes())), prompt, "{name}: the prompt changed");
    }
}

#[test]
fn a_hanging_price_list_costs_no_more_than_the_budget_and_the_verdict_is_still_signed() {
    let stage = Stage::new(usual_payment()).with(Trouble::ListHangs);
    let started = Instant::now();
    let out = whole_job(&stage);
    let spent = started.elapsed();
    assert!(stage.list_limits.borrow()[0] <= PAST_BUDGET_MS, "{:?}", stage.list_limits.borrow());
    assert!(spent < Duration::from_millis(PAST_BUDGET_MS + 1_500), "{spent:?}");
    let (verdict, _) = open(&out);
    assert_eq!(verdict.floor, Severity::High);
    assert!(verdict.findings.contains(&FindingCode::UnknownValue));
    assert_eq!(stage.asked(" get_proposals"), 0, "the budget was gone before the history");
}

#[test]
fn a_slow_chain_read_takes_the_safe_reading_instead_of_stacking_up() {
    let stage = Stage::new(usual_payment());
    let (input, read) = parts(&stage);

    assert_eq!(past_of(&stage, &input, &read, Deadline::after_ms(PAST_BUDGET_MS - 1)), None);
    assert!(stage.calls.borrow().is_empty(), "too little room left to start either read");

    let slow_list = Stage { list_ms: 1_500, ..stage.with(Trouble::Nothing) };
    assert_eq!(past_of(&slow_list, &input, &read, Deadline::after_ms(PAST_BUDGET_MS + 1_000)), None);
    assert_eq!(slow_list.calls.borrow().as_slice(), ["1click"], "the list used up the room the history needed");

    assert!(past_of(&stage, &input, &read, Deadline::after_ms(25_000)).is_some());
}

#[test]
fn both_reads_arrive_together_and_reach_the_prompt() {
    let stage = Stage::new(usual_payment());
    let (input, read) = parts(&stage);
    let past = past_of(&stage, &input, &read, Deadline::after_ms(25_000)).unwrap();
    assert_eq!(past.history, history_before(&saved_page(0), FILED_NS, &saved_prices()));
    assert_eq!(past.history.approved_payments_before, 70);

    let proposal = proposal_input(&input, None, &read, Some(past.clone()));
    assert_eq!((proposal.prices.clone(), proposal.history.clone()), (saved_prices(), Some(past.history.clone())));
    let (proposal, analysis) = judge(&input, None, &read, Some(past.clone()));
    let message = user_message(&proposal, &analysis).unwrap();
    let facts: Value = serde_json::from_str(message.strip_prefix(FACTS_PREAMBLE).unwrap()).unwrap();
    assert_eq!(facts["history"]["available"], true);
    assert_eq!(facts["history"]["approved_payments_before"], 70);
    assert_eq!(facts["history"]["median_payment_usd_before"], json!(past.history.median_payment_usd_before));
}

#[test]
fn a_dao_with_no_past_payments_has_a_complete_empty_history_and_reads_as_a_warning() {
    let stage = Stage { proposals: Rc::new(saved_page(1)), ..Stage::new(payment("stranger.near", 5_600, "Pay 5600 NEAR to stranger.near for the quarter")) };
    let (input, read) = parts(&stage);
    let past = past_of(&stage, &input, &read, Deadline::after_ms(25_000)).unwrap();
    assert_eq!((past.history.approved_payments_before, past.history.median_payment_usd_before), (0, None));
    assert!(proposal_input(&input, None, &read, Some(past)).history.is_some());
    assert_eq!(judged(&stage), (vec![FindingCode::NewRecipient], Severity::Medium));
}

#[test]
fn three_hundred_ids_are_read_whole_by_the_job() {
    let page = saved_page(0);
    let stage = Stage { proposals: Rc::new([page.clone(), page.clone(), page].concat()), ..Stage::new(usual_payment()) };
    assert_eq!(judged(&stage), (Vec::new(), Severity::Low));
    assert_eq!(stage.asked(" get_proposals"), 6, "three pages, from each provider");
}

#[test]
fn a_paid_run_reads_and_judges_exactly_as_a_worker_run_does() {
    let stage = Stage::new(usual_payment());
    let paid_run = whole_job(&stage);
    let worker = stage.with(Trouble::Nothing);
    let input = parse_input(raw_input().as_bytes(), Some("mainnet")).unwrap();
    assert_eq!(judge_run(input, None, Payer::Kaap, connect(&worker)), paid_run);
    assert_eq!(worker.calls.borrow().as_slice(), stage.calls.borrow().as_slice());
}
