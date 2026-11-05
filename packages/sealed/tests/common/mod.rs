//! Shared helpers: load a recorded fixture, edit one recorded answer, and build the two
//! providers the job compares from it.

#![allow(dead_code)]

pub mod world;

use std::cell::{Cell, RefCell};
use std::path::{Path, PathBuf};
use std::rc::Rc;

use kaap_sealed::fixture::FixtureHttp;
use kaap_sealed::net::{Deadline, DRPC_TESTNET, HOST_STAND_IN_TESTNET};
use kaap_sealed::rpc::RpcProvider;
use serde_json::Value;

pub const HTTPS: &str = "near-testnet.drpc.org";
pub const HOST: &str = "rpc.testnet.fastnear.com";

pub fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures")
}

pub fn fixture(name: &str) -> Value {
    let text = std::fs::read_to_string(fixtures_dir().join(name)).unwrap();
    serde_json::from_str(&text).unwrap()
}

pub fn providers(fx: &Value) -> (RpcProvider<FixtureHttp>, RpcProvider<FixtureHttp>) {
    let http = || FixtureHttp::from_json(&fx.to_string()).unwrap();
    let deadline = Deadline::after_ms(60_000);
    (RpcProvider::new(http(), HOST_STAND_IN_TESTNET, deadline), RpcProvider::new(http(), DRPC_TESTNET, deadline))
}

/// The recorded exchange from `authority` whose params name `needle` (a method name, an account
/// id or a request type), or the `block` call when `needle` is "block".
pub fn exchange<'a>(fx: &'a mut Value, authority: &str, needle: &str) -> &'a mut Value {
    fx["exchanges"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|e| {
            e["authority"] == authority
                && if needle == "block" {
                    e["method"] == "block"
                } else {
                    e["params"]["method_name"] == needle || e["params"]["account_id"] == needle && e["params"]["request_type"] == "view_account"
                }
        })
        .unwrap_or_else(|| panic!("no {needle} answer from {authority}"))
}

/// Applies `edit` to the parsed JSON-RPC answer of one exchange.
pub fn edit_answer(fx: &mut Value, authority: &str, needle: &str, edit: impl FnOnce(&mut Value)) {
    let e = exchange(fx, authority, needle);
    let mut body: Value = serde_json::from_str(e["body"].as_str().unwrap()).unwrap();
    edit(&mut body);
    e["body"] = Value::String(body.to_string());
}

/// Applies `edit` to the text a view call returned (its `result` bytes).
pub fn edit_view_text(fx: &mut Value, authority: &str, method: &str, edit: impl FnOnce(String) -> String) {
    edit_answer(fx, authority, method, |body| {
        let bytes: Vec<u8> = serde_json::from_value(body["result"]["result"].clone()).unwrap();
        let text = edit(String::from_utf8(bytes).unwrap());
        body["result"]["result"] = serde_json::to_value(text.into_bytes()).unwrap();
    });
}

pub fn view_text(fx: &Value, authority: &str, method: &str) -> String {
    let mut fx = fx.clone();
    let e = exchange(&mut fx, authority, method);
    let body: Value = serde_json::from_str(e["body"].as_str().unwrap()).unwrap();
    let bytes: Vec<u8> = serde_json::from_value(body["result"]["result"].clone()).unwrap();
    String::from_utf8(bytes).unwrap()
}

/// Signs with RFC 8032's first test key, in place of OutLayer's keystore.
pub struct TestSigner(pub ed25519_dalek::SigningKey);

pub const TEST_SECRET: [u8; 32] = [
    0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60, 0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec, 0x2c, 0xc4, 0x44, 0x49, 0xc5, 0x69,
    0x7b, 0x32, 0x69, 0x19, 0x70, 0x3b, 0xac, 0x03, 0x1c, 0xae, 0x7f, 0x60,
];

impl TestSigner {
    pub fn new() -> Self {
        TestSigner(ed25519_dalek::SigningKey::from_bytes(&TEST_SECRET))
    }
}

impl kaap_sealed::verdict::VerdictSigner for TestSigner {
    fn public_key(&mut self) -> Result<[u8; 32], kaap_sealed::verdict::SignFail> {
        Ok(self.0.verifying_key().to_bytes())
    }
    fn sign(&mut self, message: &[u8]) -> Result<[u8; 64], kaap_sealed::verdict::SignFail> {
        use ed25519_dalek::Signer;
        Ok(self.0.sign(message).to_bytes())
    }
}

/// Stands in for OutLayer's keystore and for fresh randomness. `mac` is keyed by `seed`, so another
/// seed is another project or caller; every `random` differs from the last. Shared by clones, so a
/// test can read `asked` after a run has taken one.
#[derive(Clone)]
pub struct TestTexts {
    pub seed: u8,
    pub key_down: bool,
    pub no_random: bool,
    pub asked: Records,
    drawn: Rc<Cell<u8>>,
}

impl TestTexts {
    pub fn new() -> Self {
        TestTexts::keyed(1)
    }

    pub fn keyed(seed: u8) -> Self {
        TestTexts { seed, key_down: false, no_random: false, asked: Rc::default(), drawn: Rc::default() }
    }
}

impl kaap_sealed::texts::TextKeys for TestTexts {
    fn mac(&mut self, path: &str, data: &[u8]) -> Result<[u8; 32], kaap_sealed::texts::TextFail> {
        self.asked.borrow_mut().push((path.to_string(), data.to_vec()));
        if self.key_down {
            return Err(kaap_sealed::texts::TextFail::KeyUnavailable);
        }
        Ok(kaap_sealed::verdict::sha256(&[&[self.seed], data].concat()))
    }

    fn random(&mut self) -> Option<[u8; 32]> {
        self.drawn.set(self.drawn.get() + 1);
        (!self.no_random).then(|| kaap_sealed::verdict::sha256(&[self.seed, self.drawn.get()]))
    }
}

/// A verdict with every variable field at `guard`, `dao` and `model_id`, every finding and the
/// largest numbers. Borsh writes numbers at a fixed width, so only the three names change its size.
pub fn verdict(guard: &str, dao: &str, model_id: &str) -> kaap_core::Verdict {
    kaap_core::Verdict {
        version: 1,
        guard: guard.into(),
        network: kaap_core::Network::Testnet,
        dao: dao.into(),
        proposal_id: u64::MAX,
        kind_hash: [1; 32],
        policy_hash: [2; 32],
        receivers_hash: [3; 32],
        block_height: u64::MAX,
        risk: kaap_core::Severity::High,
        floor: kaap_core::Severity::High,
        findings: kaap_core::FindingCode::ALL.to_vec(),
        decoder_version: "0.1.0".into(),
        model_id: model_id.into(),
        ai_status: kaap_core::AiStatus::Unverified,
        explanation_hash: [0; 32],
        expires_at_ms: u64::MAX,
    }
}

/// The longest verdict a run could ever sign: two 64-byte accounts, every finding, the pinned model.
pub fn longest_verdict() -> kaap_core::Verdict {
    let guard = format!("{}.testnet", "g".repeat(56));
    let dao = guard.replace('g', "d");
    verdict(&guard, &dao, kaap_sealed::ai::MODEL_ID)
}

/// An `Http` that answers from a list, in order, and refuses once the list is used up.
pub struct Scripted(pub Vec<kaap_sealed::net::Response>, pub Vec<String>);

impl kaap_sealed::net::Http for Scripted {
    fn send(&mut self, r: &kaap_sealed::net::Request<'_>) -> Result<kaap_sealed::net::Response, kaap_sealed::net::HttpFail> {
        self.1.push(format!("{}{}{}", r.endpoint.authority, r.endpoint.path, r.tail));
        if self.0.is_empty() {
            Err(kaap_sealed::net::HttpFail::NoAnswerRecorded)
        } else {
            Ok(self.0.remove(0))
        }
    }
}

/// An `Http` that keeps every request's address and body in a list the test holds, and answers
/// from `.0`.
pub struct Noted<H>(pub H, pub Records);

impl<H: kaap_sealed::net::Http> kaap_sealed::net::Http for Noted<H> {
    fn send(&mut self, r: &kaap_sealed::net::Request<'_>) -> Result<kaap_sealed::net::Response, kaap_sealed::net::HttpFail> {
        let url = format!("{}{}{}", r.endpoint.authority, r.endpoint.path, r.tail);
        self.1.borrow_mut().push((url, r.body.map(<[u8]>::to_vec).unwrap_or_default()));
        self.0.send(r)
    }
}

/// The parts of a signed output, checked: the signature verifies over kaap-core's
/// `verdict_bytes` under the printed key, and the explanation hash matches the printed text.
pub fn open(out: &str) -> (kaap_core::Verdict, Value) {
    use base64::Engine as _;
    let v: Value = serde_json::from_str(out).unwrap_or_else(|e| panic!("{e}: {out}"));
    assert_eq!(v["status"], "ok", "{out}");
    let b64 = base64::engine::general_purpose::STANDARD;
    let borsh_bytes = b64.decode(v["verdict"].as_str().unwrap()).unwrap();
    let verdict: kaap_core::Verdict = borsh::from_slice(&borsh_bytes).unwrap();
    let message = kaap_core::verdict_bytes(&verdict);
    assert_eq!(&message[kaap_core::verdict::VERDICT_DOMAIN.len()..], borsh_bytes.as_slice());
    let signature: [u8; 64] = b64.decode(v["signature"].as_str().unwrap()).unwrap().try_into().unwrap();
    let key_text = v["public_key"].as_str().unwrap().strip_prefix("ed25519:").unwrap();
    let key: [u8; 32] = bs58::decode(key_text).into_vec().unwrap().try_into().unwrap();
    let key = ed25519_dalek::VerifyingKey::from_bytes(&key).unwrap();
    key.verify_strict(&message, &ed25519_dalek::Signature::from_bytes(&signature)).expect("the signature verifies");
    let explanation = v["explanation"].as_str().unwrap();
    assert_eq!(verdict.explanation_hash, kaap_sealed::verdict::sha256(explanation.as_bytes()));
    assert!(out.len() <= kaap_sealed::output::MAX_OUTPUT_BYTES, "{} bytes", out.len());
    (verdict, v)
}

/// What a `Store` was given: (key, record) in order.
pub type Records = Rc<RefCell<Vec<(String, Vec<u8>)>>>;

/// A stand-in for OutLayer's public storage that keeps what was published, or refuses every
/// write when `refuse` is set.
#[derive(Clone, Default)]
pub struct Store {
    pub records: Records,
    pub refuse: bool,
}

impl kaap_sealed::attest::EvidenceSink for Store {
    fn publish(&mut self, key: &str, record: &[u8]) -> bool {
        if self.refuse {
            return false;
        }
        self.records.borrow_mut().push((key.to_string(), record.to_vec()));
        true
    }
}
