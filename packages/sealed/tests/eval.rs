//! Eval mode: a ProposalInput handed in whole is judged by kaap-core and the model, and the job
//! prints the scores without a signature or an evidence write, reading only the final block for its
//! clock. Also pins every judge run with no `op` to the bytes it printed before eval mode existed.
//! Not covered here: a live model answer (`scripts/ai-eval.mjs` runs the answer key on testnet),
//! OutLayer setting the run's variables, and whether the inputs the script builds match the
//! scoreboards (`packages/core-wasm/tests`).

mod common;

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use common::world::{nonce, quote_binding_the_model, World, KEY, NOW};
use common::*;
use kaap_core::{analyze, AiStatus, Analysis, DescCheck, Finding, FindingCode, History, Network, Prices, ProposalInput, Severity};
use kaap_sealed::ai::{AiAnswer, AiOutcome, AiRisk, Check, MODEL_ID};
use kaap_sealed::attest::evidence::CompletionRecord;
use kaap_sealed::attest::Unverified;
use kaap_sealed::fixture::FixtureHttp;
use kaap_sealed::input::{InputError, MAX_INPUT_BYTES};
use kaap_sealed::job::{run, Connections, RunEnv};
use kaap_sealed::net::{Deadline, Http, DRPC_TESTNET, HOST_STAND_IN_TESTNET};
use kaap_sealed::output::{eval_scores, MAX_OUTPUT_BYTES};
use kaap_sealed::payment::PayEnv;
use kaap_sealed::rpc::{At, AccountView, BlockView, Provider, ReadFail, RpcProvider, ViewResult};
use kaap_sealed::verdict::{SignFail, VerdictSigner};
use serde_json::{json, Value};

fn sha(bytes: &[u8]) -> String {
    hex::encode(kaap_sealed::verdict::sha256(bytes))
}

fn stranger(execution_type: &str, amount: &str) -> PayEnv {
    let https = execution_type == "HTTPS";
    PayEnv {
        execution_type: Some(execution_type.into()),
        usd_payment: Some(if https { amount } else { "0" }.into()),
        attached_usd: Some(if https { "0" } else { amount }.into()),
        sender: Some("stranger.testnet".into()),
    }
}

/// One judge run on `fx` as OutLayer would start it, with `ai` as every AI host and `clock` as
/// `NEAR_BLOCK_TIMESTAMP`. Returns the output and every evidence record written.
fn judge(fx: &Value, raw: &str, pay: PayEnv, ai: impl Http + 'static, clock: Option<String>, key: Option<&str>) -> (String, Vec<Vec<u8>>) {
    let store = Store::default();
    let kept = store.clone();
    let text = fx.to_string();
    let out = run(raw.as_bytes(), RunEnv { network: Some("testnet"), pay }, key, move |network, deadline| {
        assert_eq!(network, Network::Testnet);
        Connections {
            host: Box::new(RpcProvider::new(FixtureHttp::from_json(&text).unwrap(), HOST_STAND_IN_TESTNET, deadline)),
            https: Box::new(RpcProvider::new(FixtureHttp::from_json(&text).unwrap(), DRPC_TESTNET, deadline)),
            http: Box::new(ai),
            signer: Box::new(TestSigner::new()),
            texts: Box::new(TestTexts::new()),
            nonce: Some(nonce()),
            block_timestamp: clock,
            quote: quote_binding_the_model,
            evidence: Box::new(store),
        }
    });
    let records = kept.records.borrow().iter().map(|(_, r)| r.clone()).collect();
    (out, records)
}

fn judge_input(dao: &str, id: u64, extra: &str) -> String {
    format!(r#"{{"v":1,"network":"testnet","guard":"guard.kaap.testnet","dao":"{dao}","proposal_id":{id},"expires_in_ms":600000{extra}}}"#)
}

/// `function-call.json` with both providers' final block at the test clock, so a whole verified
/// answer can be checked against it.
fn clocked_fixture() -> Value {
    let mut fx = fixture("function-call.json");
    for authority in [HTTPS, HOST] {
        edit_answer(&mut fx, authority, "block", |b| b["result"]["header"]["timestamp"] = json!(NOW * 1_000_000_000));
    }
    fx
}

/// Every judge run the capture covers, by name: its output and evidence records, each hashed.
fn judge_runs() -> Vec<(String, String)> {
    let mut seen = Vec::new();
    let mut keep = |name: &str, (out, records): (String, Vec<Vec<u8>>)| {
        seen.push((format!("{name} output"), sha(out.as_bytes())));
        for (i, record) in records.iter().enumerate() {
            seen.push((format!("{name} evidence {i}"), sha(record)));
        }
    };
    let worker = || worker_env(Some("testnet")).pay;
    let none = || Scripted(Vec::new(), Vec::new());
    for name in ["transfer-ft.json", "function-call.json", "vote.json"] {
        let fx = fixture(name);
        let raw = judge_input(fx["dao"].as_str().unwrap(), fx["proposal_id"].as_u64().unwrap(), "");
        keep(&format!("{name} worker, no key"), judge(&fx, &raw, worker(), none(), None, None));
        keep(&format!("{name} paid, no key"), judge(&fx, &raw, stranger("HTTPS", "10000"), none(), None, None));
    }
    let fx = clocked_fixture();
    let raw = judge_input("r7thmvr8maey.sputnikv2.testnet", 10, "");
    let clock = || Some((NOW * 1_000_000_000).to_string());
    keep("verified worker", judge(&fx, &raw, worker(), World::new(), clock(), Some(KEY)));
    keep("verified paid", judge(&fx, &raw, stranger("NEAR", "10000"), World::new(), clock(), Some(KEY)));
    keep("no clock worker", judge(&fx, &raw, worker(), World::new(), None, Some(KEY)));
    keep("unpaid stranger", judge(&fx, &raw, stranger("NEAR", "0"), World::new(), clock(), Some(KEY)));
    keep("held", judge(&fx, &judge_input("r7thmvr8maey.sputnikv2.testnet", 10, r#","test_corrupt_https":true"#), worker(), none(), None, None));
    for (name, raw) in [("refused 0", r#"{"v":1}"#), ("refused 2", ""), ("refused 3", "[]")] {
        keep(name, judge(&fx, raw, worker(), none(), None, None));
    }
    seen
}

/// Taken on 11 Nov 2026 at commit 04a26ae with only this file added, before any eval code existed.
/// The three no-key outputs equal `tests/texts.rs`'s own capture.
const CAPTURE: [(&str, &str); 19] = [
    ("transfer-ft.json worker, no key output", "11b43ca0b4b379fd442cadf48c23594ff56c665f9b98dc4b5be4f57fe8bf78ac"),
    ("transfer-ft.json worker, no key evidence 0", "4df13dd379a4d7242a0861498b79ef8aac0aaee9dd01bc4681b193ac74a7e655"),
    ("transfer-ft.json paid, no key output", "11b43ca0b4b379fd442cadf48c23594ff56c665f9b98dc4b5be4f57fe8bf78ac"),
    ("function-call.json worker, no key output", "1053a585e7ffd5a3fd434a0a0f7c225f22bdd9a1af2a4abb8e0386f34651cf19"),
    ("function-call.json worker, no key evidence 0", "17ea5792c7c8fa79e49a73264da1b150180ef3a77ced7c4800ab23943e780145"),
    ("function-call.json paid, no key output", "1053a585e7ffd5a3fd434a0a0f7c225f22bdd9a1af2a4abb8e0386f34651cf19"),
    ("vote.json worker, no key output", "848a4a546cfc4f10482210d6caa7950b9886ed1a22be91d4e8b302112c77c6eb"),
    ("vote.json worker, no key evidence 0", "c30668350aa08d2faa2d87314e44d76f6f0369cd64535b4d3d4a6b993873e4cb"),
    ("vote.json paid, no key output", "848a4a546cfc4f10482210d6caa7950b9886ed1a22be91d4e8b302112c77c6eb"),
    ("verified worker output", "51c5f610b104e9f222b8a8cadb393cdff0ba1e36001fc4f7d2ce41561e99844f"),
    ("verified worker evidence 0", "2e81b12f97df548ccff7a0a8aca9698859af0292e3a9344f65a8d82b98a44457"),
    ("verified paid output", "12f71a635cddbbe215028db1735c2dbe7c5311919de9feb5a2e31bf805432fbc"),
    ("no clock worker output", "cb84e7a9d664e0796e66ce4957bc54a080fe49563ba78fa38250ec94d5cf4076"),
    ("no clock worker evidence 0", "cc55b723b309d5570d3a61e25937ce9aebf4b622ed145a10688ec2c10fd5a025"),
    ("unpaid stranger output", "0ccc30f30e2b91ace922fa0d2287a778ff2471730c74f6afbcd3d9141703cae8"),
    ("held output", "6f50c469d880cb8fdd503d947d329a88dd49119e27d61c4775de2896993c8365"),
    ("refused 0 output", "b342023c81806c293f17feec0f590b78dd821f2708917e2ecdc43c71942e2903"),
    ("refused 2 output", "b342023c81806c293f17feec0f590b78dd821f2708917e2ecdc43c71942e2903"),
    ("refused 3 output", "b342023c81806c293f17feec0f590b78dd821f2708917e2ecdc43c71942e2903"),
];

#[test]
fn a_judge_run_with_no_op_prints_byte_for_byte_what_it_did_before() {
    let now: Vec<(String, String)> = judge_runs();
    let then: Vec<(String, String)> = CAPTURE.iter().map(|(n, h)| (n.to_string(), h.to_string())).collect();
    assert_eq!(now, then);
    let (out, _) = judge(&clocked_fixture(), &judge_input("r7thmvr8maey.sputnikv2.testnet", 10, ""), worker_env(Some("testnet")).pay, World::new(), Some((NOW * 1_000_000_000).to_string()), Some(KEY));
    assert_eq!(open(&out).0.ai_status, AiStatus::Verified, "the capture covers a verified answer");
}

/// A mainnet payment of 1 NEAR to an account the DAO never paid, with a payment history and a
/// price, so every part of ProposalInput that a record can carry is filled.
fn proposal() -> ProposalInput {
    ProposalInput {
        network: Network::Mainnet,
        dao: "example.sputnik-dao.near".into(),
        proposal_id: 42,
        description: "Pay a1ice.near 1 NEAR for the logo".into(),
        kind_json: br#"{"Transfer":{"token_id":"","receiver_id":"a1ice.near","amount":"1000000000000000000000000","msg":null}}"#.to_vec(),
        policy_before: None,
        history: Some(History { approved_payments_before: 3, median_payment_usd_before: Some(410.5), recipients_paid_before: vec!["bob.near".into()] }),
        prices: Prices { usd_by_token: [("near".to_string(), (24, 4.81))].into_iter().collect() },
        dao_version: Some("3.2".into()),
        supplied_text: None,
        guard_account: None,
        config_before: None,
        block_timestamp_ns: None,
    }
}

fn eval_input(network: &str, proposal_json: &str) -> String {
    format!(r#"{{"v":1,"op":"eval","network":"{network}","input":{proposal_json}}}"#)
}

fn proposal_json() -> String {
    serde_json::to_string(&proposal()).unwrap()
}

/// One provider that answers `block` with its own block, or fails, and fails every other read.
/// Every call is written down.
#[derive(Clone)]
struct BlockOnly {
    block: Option<BlockView>,
    asked: Rc<RefCell<Vec<String>>>,
}

impl BlockOnly {
    fn new(block: Option<BlockView>) -> BlockOnly {
        BlockOnly { block, asked: Rc::default() }
    }

    fn asked(&self) -> Vec<String> {
        self.asked.borrow().clone()
    }
}

impl Provider for BlockOnly {
    fn call_function(&mut self, account: &str, method: &str, _: &str, at: At) -> Result<ViewResult, ReadFail> {
        self.asked.borrow_mut().push(format!("call_function {account} {method} {at:?}"));
        Err(ReadFail::Status)
    }
    fn view_account(&mut self, account: &str, at: At) -> Result<AccountView, ReadFail> {
        self.asked.borrow_mut().push(format!("view_account {account} {at:?}"));
        Err(ReadFail::Status)
    }
    fn block(&mut self, at: At) -> Result<BlockView, ReadFail> {
        self.asked.borrow_mut().push(format!("block {at:?}"));
        self.block.clone().ok_or(ReadFail::Status)
    }
}

const HEIGHT: u64 = 246_813_579;
const HASH: &str = "ClockBlockHashThatMustNotBePrinted";

/// The final block both providers report, at the test clock.
fn head() -> BlockView {
    BlockView { height: HEIGHT, hash: HASH.into(), timestamp_ns: NOW * 1_000_000_000 }
}

/// Counts every call to the verdict key.
#[derive(Clone, Default)]
struct CountingSigner(Rc<Cell<u32>>);

impl VerdictSigner for CountingSigner {
    fn public_key(&mut self) -> Result<[u8; 32], SignFail> {
        self.0.set(self.0.get() + 1);
        TestSigner::new().public_key()
    }
    fn sign(&mut self, message: &[u8]) -> Result<[u8; 64], SignFail> {
        self.0.set(self.0.get() + 1);
        TestSigner::new().sign(message)
    }
}

/// What an eval run touched besides the AI hosts: chain reads on each provider, signer calls,
/// evidence writes and text-key calls, every one recorded by its test double.
struct Touched {
    host: BlockOnly,
    https: BlockOnly,
    signs: CountingSigner,
    store: Store,
    texts: TestTexts,
    urls: Records,
}

impl Touched {
    fn new() -> Touched {
        Touched::with_blocks(Some(head()), Some(head()))
    }

    fn with_blocks(https: Option<BlockView>, host: Option<BlockView>) -> Touched {
        Touched {
            host: BlockOnly::new(host),
            https: BlockOnly::new(https),
            signs: CountingSigner::default(),
            store: Store::default(),
            texts: TestTexts::new(),
            urls: Records::default(),
        }
    }

    fn connect(&self, ai: impl Http + 'static) -> impl FnOnce(Network, Deadline) -> Connections {
        let (host, https, signs, store, texts, urls) =
            (self.host.clone(), self.https.clone(), self.signs.clone(), self.store.clone(), self.texts.clone(), self.urls.clone());
        move |network, _| {
            assert_eq!(network, Network::Testnet);
            Connections {
                host: Box::new(host),
                https: Box::new(https),
                http: Box::new(Noted(ai, urls)),
                signer: Box::new(signs),
                texts: Box::new(texts),
                nonce: Some(nonce()),
                block_timestamp: Some((NOW * 1_000_000_000).to_string()),
                quote: quote_binding_the_model,
                evidence: Box::new(store),
            }
        }
    }

    /// The final block from the HTTPS provider, the same height from the host, and nothing else.
    fn assert_only_the_block_and_the_ai(&self) {
        assert_eq!(self.https.asked(), ["block Final"], "the HTTPS provider");
        assert_eq!(self.host.asked(), [format!("block Height({HEIGHT})")], "the host");
        self.assert_no_key_and_no_store();
    }

    fn assert_no_key_and_no_store(&self) {
        assert_eq!(self.signs.0.get(), 0, "no signer call");
        assert!(self.store.records.borrow().is_empty(), "no evidence write");
        assert!(self.texts.asked.borrow().is_empty(), "no text key");
    }

    fn urls(&self) -> Vec<String> {
        self.urls.borrow().iter().map(|(url, _)| url.clone()).collect()
    }
}

fn scores(out: &str) -> Value {
    let v: Value = serde_json::from_str(out).unwrap_or_else(|e| panic!("{e}: {out}"));
    let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        [
            "ai_reason", "ai_risk", "ai_status", "completion_tokens", "explanation_sha256", "findings", "finish_reason", "floor", "model_id",
            "prompt_tokens", "reasoning_tokens", "risk", "status", "v"
        ],
        "{out}"
    );
    assert!(out.len() <= MAX_OUTPUT_BYTES);
    v
}

#[test]
fn an_eval_run_reads_only_the_block_and_can_reach_a_verified_answer() {
    let analysis = analyze(&proposal());
    let codes: Vec<Value> = analysis.findings.iter().map(|f| serde_json::to_value(f.code).unwrap()).collect();
    assert!(analysis.findings.iter().any(|f| f.code == FindingCode::NewRecipient), "{codes:?}");
    assert_ne!(analysis.risk_floor, Severity::Critical, "the floor leaves the AI room to raise it");

    let touched = Touched::new();
    let out = run(eval_input("testnet", &proposal_json()).as_bytes(), worker_env(Some("testnet")), Some(KEY), touched.connect(World::new()));
    assert!(!out.contains(KEY), "the NEAR AI key is never printed");
    let v = scores(&out);
    let world_explanation = "The transfer pays a1ice.testnet while the text names alice.testnet.";
    assert_eq!((v["v"].as_u64(), v["status"].as_str()), (Some(1), Some("eval")));
    assert_eq!(v["floor"], serde_json::to_value(analysis.risk_floor).unwrap());
    assert_eq!(v["findings"], Value::Array(codes.clone()));
    assert_eq!((v["ai_status"].as_str(), v["ai_reason"].as_str(), v["ai_risk"].as_str()), (Some("verified"), None, Some("critical")));
    assert_eq!(v["risk"], "critical", "a verified critical answer raises the risk above the floor");
    assert_eq!(v["model_id"], MODEL_ID);
    assert_eq!(v["explanation_sha256"], sha(world_explanation.as_bytes()));
    assert!(!out.contains("a1ice.testnet"), "the explanation itself is not printed");
    for block in [HEIGHT.to_string(), HASH.to_string(), (NOW * 1_000_000_000).to_string()] {
        assert!(!out.contains(&block), "the block is not printed: {block}");
    }
    assert_eq!((v["finish_reason"].as_str(), v["prompt_tokens"].as_u64(), v["completion_tokens"].as_u64(), v["reasoning_tokens"].as_u64()), (Some("stop"), Some(900), Some(120), Some(40)));
    touched.assert_only_the_block_and_the_ai();
    let urls = touched.urls();
    assert!(urls.iter().any(|u| u.starts_with("cloud-api.near.ai/v1/attestation/report?")), "the checks ran: {urls:?}");
    assert!(urls.iter().any(|u| u == "cloud-api.near.ai/v1/chat/completions"), "{urls:?}");

    let touched = Touched::new();
    let v = scores(&run(eval_input("testnet", &proposal_json()).as_bytes(), worker_env(Some("testnet")), None, touched.connect(World::new())));
    assert_eq!((v["ai_status"].as_str(), v["ai_reason"].as_str()), (Some("unavailable"), Some("ai_key_missing")));
    for key in ["ai_risk", "model_id", "explanation_sha256", "finish_reason", "prompt_tokens", "completion_tokens", "reasoning_tokens"] {
        assert!(v[key].is_null(), "{key}");
    }
    assert_eq!(v["risk"], v["floor"]);
    touched.assert_only_the_block_and_the_ai();
    assert!(touched.urls().is_empty(), "no key, no AI host");
}

#[test]
fn without_one_agreed_block_the_answer_is_unverified_and_still_printed() {
    let other = BlockView { hash: "AnotherBlockAtTheSameHeight".into(), ..head() };
    let later = BlockView { timestamp_ns: head().timestamp_ns + 1, ..head() };
    for (name, https, host) in [("another hash", Some(head()), Some(other)), ("another time", Some(head()), Some(later)), ("no https block", None, Some(head()))] {
        let touched = Touched::with_blocks(https, host);
        let out = run(eval_input("testnet", &proposal_json()).as_bytes(), worker_env(Some("testnet")), Some(KEY), touched.connect(World::new()));
        let v = scores(&out);
        assert_eq!((v["status"].as_str(), v["ai_status"].as_str(), v["ai_reason"].as_str(), v["ai_risk"].as_str()), (Some("eval"), Some("unverified"), Some("no_clock"), Some("critical")), "{name}");
        assert_eq!(v["risk"], "high", "{name}: an unverified answer raises the risk to high at most");
        assert_eq!(touched.https.asked(), ["block Final"], "{name}");
        assert!(touched.host.asked().iter().all(|a| a.starts_with("block ")), "{name}: {:?}", touched.host.asked());
        touched.assert_no_key_and_no_store();
        assert!(touched.urls().iter().all(|u| !u.contains("/attestation/")), "{name}: the checks stop at the clock");
    }
}

#[test]
fn a_strangers_unpaid_eval_run_gets_payment_below_price() {
    let raw = eval_input("testnet", &proposal_json());
    for (door, amount) in [("NEAR", "0"), ("NEAR", "9999"), ("HTTPS", "0"), ("HTTPS", "")] {
        let out = run(raw.as_bytes(), RunEnv { network: Some("testnet"), pay: stranger(door, amount) }, Some(KEY), |_, _| panic!("connected for an unpaid run"));
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!((v["status"].as_str(), v["reason"].as_str()), (Some("refused"), Some("payment_below_price")), "{door} {amount:?}");
        assert!(v.get("signature").is_none() && v.get("floor").is_none(), "{out}");
    }
    let touched = Touched::new();
    let out = run(raw.as_bytes(), RunEnv { network: Some("testnet"), pay: stranger("HTTPS", "10000") }, Some(KEY), touched.connect(World::new()));
    assert_eq!(scores(&out)["status"], "eval", "a paying stranger gets the same scores");
    touched.assert_only_the_block_and_the_ai();
}

fn refused_as(raw: &str, run_network: Option<&str>, why: InputError) {
    let out = run(raw.as_bytes(), RunEnv { network: run_network, pay: worker_env(None).pay }, Some(KEY), |_, _| panic!("connected for a refused input"));
    assert_eq!(out, kaap_sealed::output::refused(why.reason()), "{}", &raw[..raw.len().min(160)]);
}

#[test]
fn an_unknown_field_and_an_oversized_input_are_refused() {
    let good = proposal_json();
    let edited = |from: &str, to: &str| {
        assert!(good.contains(from), "{from}");
        eval_input("testnet", &good.replacen(from, to, 1))
    };
    let not_proposal = InputError::NotAProposalInput;
    refused_as(&edited(r#""dao":"#, r#""extra":1,"dao":"#), Some("testnet"), not_proposal);
    refused_as(&edited(r#""approved_payments_before":3"#, r#""approved_payments_before":3,"extra":1"#), Some("testnet"), not_proposal);
    refused_as(&edited(r#","guard_account":null"#, ""), Some("testnet"), not_proposal);
    refused_as(&edited("410.5", "410"), Some("testnet"), not_proposal);
    refused_as(&edited(r#""proposal_id":42"#, r#""proposal_id":"42""#), Some("testnet"), not_proposal);
    refused_as(&eval_input("testnet", "[]"), Some("testnet"), not_proposal);

    let wrapped = |extra: &str| format!(r#"{{"v":1,"op":"eval","network":"testnet","input":{good}{extra}}}"#);
    refused_as(&wrapped(r#","text_ciphertext":"AAAA","reply_key":"00""#), Some("testnet"), InputError::NotTheEvalShape);
    refused_as(&wrapped(r#","guard":"guard.kaap.testnet""#), Some("testnet"), InputError::NotTheEvalShape);
    refused_as(r#"{"v":1,"op":"eval","network":"testnet"}"#, Some("testnet"), InputError::NotTheEvalShape);
    refused_as(&format!(r#"{{"v":1,"op":"eval","op":"eval","network":"testnet","input":{good}}}"#), Some("testnet"), InputError::NotTheEvalShape);
    refused_as(&wrapped("").replace(r#""v":1"#, r#""v":2"#), Some("testnet"), InputError::UnknownVersion);
    refused_as(&wrapped(""), Some("mainnet"), InputError::NetworkNotThisRun);
    refused_as(&wrapped(""), None, InputError::RunNetworkUnset);
    refused_as(&wrapped("").replace(r#""network":"testnet""#, r#""network":"sandbox""#), Some("sandbox"), InputError::UnknownNetwork);

    let room = MAX_INPUT_BYTES - eval_input("testnet", &good).len();
    let padded = |extra: usize| eval_input("testnet", &good.replacen("for the logo", &format!("for the logo{}", " ".repeat(extra)), 1));
    assert_eq!(padded(room).len(), MAX_INPUT_BYTES);
    refused_as(&padded(room + 1), Some("testnet"), InputError::TooLarge);
    let touched = Touched::new();
    assert_eq!(scores(&run(padded(room).as_bytes(), worker_env(Some("testnet")), None, touched.connect(World::new())))["status"], "eval", "exactly at the cap is read");
}

/// Every finding at once, the longest reason, a 32-letter finish reason and token counts of 15
/// digits still fit; counts of 10^15 tokens or more could pass the cap and are refused as failed.
#[test]
fn every_finding_and_the_longest_reason_fit_in_one_output() {
    let analysis = Analysis {
        effects: Vec::new(),
        findings: FindingCode::ALL.iter().map(|&code| Finding { code, severity: Severity::Critical }).collect(),
        risk_floor: Severity::Critical,
        description_check: DescCheck::Contradicts,
        must_veto: true,
        veto_allowed: true,
    };
    let longest = Unverified::ALL.iter().copied().max_by_key(|u| u.code().len()).unwrap();
    let answer = AiAnswer { risk: AiRisk::Critical, explanation: "x".repeat(280) };
    let ai = AiOutcome::Answered { answer, model_id: MODEL_ID, check: Check::Unverified(longest) };
    let counted = |tokens: u64| CompletionRecord {
        chat_id: None,
        finish_reason: Some("z".repeat(32)),
        prompt_tokens: Some(tokens),
        completion_tokens: Some(tokens),
        reasoning_tokens: Some(tokens),
        content_bytes: 0,
    };
    let out = eval_scores(&analysis, &ai, Some(&counted(999_999_999_999_999))).unwrap();
    assert!(out.len() <= MAX_OUTPUT_BYTES, "{} bytes", out.len());
    assert_eq!(scores(&out)["findings"].as_array().unwrap().len(), FindingCode::ALL.len());
    assert_eq!(eval_scores(&analysis, &ai, Some(&counted(u64::MAX))), Err("the eval output does not fit in 900 bytes"));
}
