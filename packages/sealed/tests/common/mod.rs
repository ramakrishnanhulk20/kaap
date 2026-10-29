//! Shared helpers: load a recorded fixture, edit one recorded answer, and build the two
//! providers the job compares from it.

#![allow(dead_code)]

use std::path::{Path, PathBuf};

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

/// An `Http` that answers from a list, in order, and refuses once the list is used up.
pub struct Scripted(pub Vec<kaap_sealed::net::Response>, pub Vec<String>);

impl kaap_sealed::net::Http for Scripted {
    fn send(&mut self, r: &kaap_sealed::net::Request<'_>) -> Result<kaap_sealed::net::Response, kaap_sealed::net::HttpFail> {
        self.1.push(format!("{}{}", r.endpoint.authority, r.endpoint.path));
        if self.0.is_empty() {
            Err(kaap_sealed::net::HttpFail::NoAnswerRecorded)
        } else {
            Ok(self.0.remove(0))
        }
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
