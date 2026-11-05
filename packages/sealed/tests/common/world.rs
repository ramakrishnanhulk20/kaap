//! Every host the AI step talks to, answered in one place so a whole check can run and one piece
//! of evidence at a time can be broken. Real where real data exists: Intel's collateral and key
//! set, and NEAR AI's public Intel token, all of 23 Oct 2026. Signed here where it cannot be:
//! NVIDIA's verdict (a throwaway P-384 key) and the model's answer signature (a throwaway ed25519
//! key that a stand-in quote binds, because no real quote binds a key a test holds).

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use ed25519_dalek::Signer as _;
use kaap_sealed::ai::MODEL_ID;
use kaap_sealed::attest::signature::expected_text;
use kaap_sealed::attest::tdx::QuoteFacts;
use kaap_sealed::attest::{Trust, Unverified};
use kaap_sealed::net::{Http, HttpFail, Request, Response};
use serde_json::{json, Value};

pub const KEY: &str = "sk-kaap-test-0123456789";
pub const LIST: &str = include_str!("../fixtures/model-list-2026-10-29.json");
pub const QUOTE_HEX: &str = include_str!("../fixtures/dcap-sample-tdx-quote.hex");
pub const COLLATERAL: &str = include_str!("../fixtures/intel-collateral-2026-10-23.json");
pub const ITA: &str = include_str!("../fixtures/ita-token-2026-10-23a.json");
pub const ITA_NONCE: &str = include_str!("../fixtures/ita-token-2026-10-23a.nonce");
pub const INTEL_KEYS: &str = include_str!("../fixtures/intel-ita-keys-2026-10-23.json");
/// Inside the public Intel token's five minutes, and inside the Intel collateral's dates.
pub const NOW: u64 = 1_792_733_000;

pub fn nonce() -> [u8; 32] {
    hex::decode(ITA_NONCE.trim()).unwrap().try_into().unwrap()
}

pub fn model_key() -> ed25519_dalek::SigningKey {
    ed25519_dalek::SigningKey::from_bytes(&[7; 32])
}

fn nvidia_key() -> p384::ecdsa::SigningKey {
    p384::ecdsa::SigningKey::from_slice(&[11u8; 48]).unwrap()
}

/// Stands in for dcap-qvl where a real quote cannot bind the test's model key: the quote's report
/// data in NEAR's layout for that key and this run's nonce, at Intel's real OutOfDate level.
pub fn quote_binding_the_model(_: &[u8], _: &dcap_qvl::QuoteCollateralV3, _: u64) -> Result<QuoteFacts, Unverified> {
    Ok(facts(&nonce()))
}

/// The same, but the quote was made for an earlier nonce.
pub fn quote_with_an_old_nonce(_: &[u8], _: &dcap_qvl::QuoteCollateralV3, _: u64) -> Result<QuoteFacts, Unverified> {
    Ok(facts(&[0x55; 32]))
}

fn facts(nonce: &[u8; 32]) -> QuoteFacts {
    let mut report_data = [0u8; 64];
    report_data[..32].copy_from_slice(&model_key().verifying_key().to_bytes());
    report_data[32..].copy_from_slice(nonce);
    QuoteFacts {
        tcb_status: "OutOfDate".into(),
        advisory_ids: vec!["INTEL-SA-01192".into(), "INTEL-SA-01245".into()],
        report_data,
        eval_number: 20,
        pck_flags: kaap_sealed::attest::tdx::PckFlags { smt_enabled: "true", cached_keys: "false", dynamic_platform: "true" },
    }
}

pub fn trust() -> Trust {
    Trust { nonce: Some(nonce()), now: Ok(NOW), quote: quote_binding_the_model }
}

/// One request as sent: its url, headers and overall time limit.
pub type Seen = (String, Vec<(String, String)>, u64);

/// An endpoint path and the answer that replaces its normal one.
pub type Override = (&'static str, Result<Response, HttpFail>);

/// How the signature endpoint answers.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Signing {
    /// The model's key over `<model>:<sha256 request>:<sha256 response>` of the exact bytes.
    Model,
    /// NEAR AI's gateway kind, over the two hashes only.
    Gateway,
    /// The model's key, over a different answer's hash.
    OtherAnswer,
    /// A valid signature over the exact bytes by a key no report named.
    OtherKey,
}

pub struct World {
    pub list: String,
    pub report: Value,
    pub nras_claims: Value,
    /// Sign NVIDIA's verdict with a key that is not in NVIDIA's set (same kid).
    pub nras_forged: bool,
    pub ita: String,
    pub chat: Value,
    pub chat_type: &'static str,
    pub signing: Signing,
    /// Answers that replace the normal one for an endpoint path, used once each.
    pub overrides: Vec<Override>,
    /// Every request, in order.
    pub seen: Vec<Seen>,
    /// Every request body, in order.
    pub bodies: Vec<Vec<u8>>,
    sent_chat: Vec<u8>,
    served_chat: Vec<u8>,
}

impl World {
    pub fn new() -> World {
        let nonce = nonce();
        let payload = json!({ "nonce": hex::encode(nonce), "arch": "HOPPER", "evidence_list": vec![json!({}); 8] }).to_string();
        World {
            list: LIST.to_string(),
            report: json!({
                "gateway_attestation": { "signing_address": "gateway" },
                "model_attestations": [{
                    "intel_quote": QUOTE_HEX.trim(),
                    "request_nonce": hex::encode(nonce),
                    "signing_address": hex::encode(model_key().verifying_key().to_bytes()),
                    "signing_algo": "ed25519",
                    "nvidia_payload": payload,
                    "event_log": "[]",
                    "info": { "tcb_info": "{}" },
                }],
            }),
            nras_claims: json!({ "iss": "https://nras.attestation.nvidia.com", "iat": NOW, "nbf": NOW, "exp": NOW + 3600,
                "eat_nonce": hex::encode(nonce), "x-nvidia-overall-att-result": true }),
            nras_forged: false,
            ita: ITA.to_string(),
            chat: json!({
                "id": "chatcmpl-kaap0001", "object": "chat.completion", "created": 1, "model": MODEL_ID,
                "choices": [{ "index": 0, "finish_reason": "stop", "message": { "role": "assistant",
                    "content": "{\"risk\":\"critical\",\"explanation\":\"The transfer pays a1ice.testnet while the text names alice.testnet.\"}",
                    "reasoning_content": "Compare the payee with the text." } }],
                "usage": { "prompt_tokens": 900, "completion_tokens": 120, "total_tokens": 1020,
                    "completion_tokens_details": { "reasoning_tokens": 40 } },
            }),
            chat_type: "application/json",
            signing: Signing::Model,
            overrides: Vec::new(),
            seen: Vec::new(),
            bodies: Vec::new(),
            sent_chat: Vec::new(),
            served_chat: Vec::new(),
        }
    }

    pub fn urls(&self) -> Vec<&str> {
        self.seen.iter().map(|(u, _, _)| u.as_str()).collect()
    }

    fn signature(&self) -> Vec<u8> {
        let exact = expected_text(MODEL_ID, &self.sent_chat, &self.served_chat);
        let (key, text, kind) = match self.signing {
            Signing::Model => (model_key(), exact, "provider_tee"),
            Signing::Gateway => (model_key(), exact.split_once(':').unwrap().1.to_string(), "gateway"),
            Signing::OtherAnswer => (model_key(), expected_text(MODEL_ID, &self.sent_chat, b"{}"), "provider_tee"),
            Signing::OtherKey => (ed25519_dalek::SigningKey::from_bytes(&[9; 32]), exact, "provider_tee"),
        };
        json!({ "text": text, "signature": hex::encode(key.sign(text.as_bytes()).to_bytes()),
            "signing_address": hex::encode(key.verifying_key().to_bytes()), "signing_algo": "ed25519", "signature_kind": kind })
        .to_string()
        .into_bytes()
    }

    fn nras(&self) -> Vec<u8> {
        let head = URL_SAFE_NO_PAD.encode(r#"{"alg":"ES384","kid":"nv-eat-kid-test","typ":"JWT"}"#);
        let body = URL_SAFE_NO_PAD.encode(self.nras_claims.to_string());
        let key = if self.nras_forged { p384::ecdsa::SigningKey::from_slice(&[12u8; 48]).unwrap() } else { nvidia_key() };
        let sig: p384::ecdsa::Signature = key.sign(format!("{head}.{body}").as_bytes());
        json!([["JWT", format!("{head}.{body}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()))], { "GPU-0": "detached" }])
            .to_string()
            .into_bytes()
    }

    fn nvidia_keys() -> Vec<u8> {
        let point = nvidia_key().verifying_key().to_sec1_point(false);
        json!({ "keys": [{ "kty": "EC", "crv": "P-384", "kid": "nv-eat-kid-test",
            "x": URL_SAFE_NO_PAD.encode(point.x().unwrap()), "y": URL_SAFE_NO_PAD.encode(point.y().unwrap()) }] })
        .to_string()
        .into_bytes()
    }
}

impl Http for World {
    fn send(&mut self, r: &Request<'_>) -> Result<Response, HttpFail> {
        let url = format!("{}{}{}", r.endpoint.authority, r.endpoint.path, r.tail);
        self.seen.push((url, r.headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), r.limits.overall_ms));
        self.bodies.extend(r.body.map(<[u8]>::to_vec));
        if let Some(at) = self.overrides.iter().position(|(path, _)| *path == r.endpoint.path) {
            return self.overrides.remove(at).1;
        }
        assert!(kaap_sealed::net::is_safe_tail(r.tail), "{}", r.tail);
        let c: dcap_qvl::QuoteCollateralV3 = serde_json::from_str(COLLATERAL).unwrap();
        let chain = |name: &str, pem: &str| vec![(name.to_string(), urlencoding::encode(pem).into_owned())];
        let (body, headers) = match (r.endpoint.authority, r.endpoint.path) {
            ("cloud-api.near.ai", "/v1/model/list") => (self.list.clone().into_bytes(), vec![]),
            ("cloud-api.near.ai", "/v1/attestation/report") => (self.report.to_string().into_bytes(), vec![]),
            ("cloud-api.near.ai", "/v1/attestation/ita-token") => (self.ita.clone().into_bytes(), vec![]),
            ("cloud-api.near.ai", "/v1/chat/completions") => {
                self.sent_chat = r.body.unwrap().to_vec();
                self.served_chat = self.chat.to_string().into_bytes();
                (self.served_chat.clone(), vec![("content-type".to_string(), self.chat_type.to_string())])
            }
            ("cloud-api.near.ai", "/v1/signature/") => (self.signature(), vec![]),
            ("api.trustedservices.intel.com", "/sgx/certification/v4/pckcrl") => {
                (c.pck_crl.clone(), chain("sgx-pck-crl-issuer-chain", &c.pck_crl_issuer_chain))
            }
            ("api.trustedservices.intel.com", "/tdx/certification/v4/tcb") => (
                format!(r#"{{"tcbInfo":{},"signature":"{}"}}"#, c.tcb_info, hex::encode(&c.tcb_info_signature)).into_bytes(),
                chain("tcb-info-issuer-chain", &c.tcb_info_issuer_chain),
            ),
            ("api.trustedservices.intel.com", "/tdx/certification/v4/qe/identity") => (
                format!(r#"{{"enclaveIdentity":{},"signature":"{}"}}"#, c.qe_identity, hex::encode(&c.qe_identity_signature)).into_bytes(),
                chain("sgx-enclave-identity-issuer-chain", &c.qe_identity_issuer_chain),
            ),
            ("certificates.trustedservices.intel.com", "/IntelSGXRootCA.der") => (c.root_ca_crl.clone(), vec![]),
            ("portal.trustauthority.intel.com", "/certs") => (INTEL_KEYS.as_bytes().to_vec(), vec![]),
            ("nras.attestation.nvidia.com", "/v3/attest/gpu") => (self.nras(), vec![]),
            ("nras.attestation.nvidia.com", "/.well-known/jwks.json") => (World::nvidia_keys(), vec![]),
            _ => return Err(HttpFail::NoAnswerRecorded),
        };
        let headers = headers.into_iter().filter(|(name, _)| r.keep_headers.contains(&name.as_str())).collect();
        Ok(Response { status: 200, body, headers })
    }
}
