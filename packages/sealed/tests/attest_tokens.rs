//! The two signed tokens beside the model's quote (C11): NEAR AI's public Intel Trust Authority
//! token for the gateway (PS384, checked on a real token of 23 Oct 2026 and Intel's real key set)
//! and NVIDIA's NRAS verdict on the model's GPUs (ES384, checked on tokens signed here with a
//! throwaway P-384 key, because a real NRAS token needs the NEAR AI key). Not covered here: a real
//! NRAS token, NVIDIA's key chain (x5c), and how a refusal becomes the AI status.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use kaap_sealed::attest::gpu;
use kaap_sealed::attest::ita;
use kaap_sealed::attest::Unverified;
use p384::ecdsa::signature::Signer;
use serde_json::{json, Value};

const ITA: &str = include_str!("fixtures/ita-token-2026-10-23a.json");
const ITA_NONCE: &str = include_str!("fixtures/ita-token-2026-10-23a.nonce");
const INTEL_KEYS: &str = include_str!("fixtures/intel-ita-keys-2026-10-23.json");
/// Ten seconds after the token was minted.
const ITA_NOW: u64 = 1_792_732_994;

fn ita_nonce() -> [u8; 32] {
    hex::decode(ITA_NONCE.trim()).unwrap().try_into().unwrap()
}

fn with_gateway_token(edit: impl FnOnce(&str) -> String) -> String {
    let mut v: Value = serde_json::from_str(ITA).unwrap();
    let token = v["gateway"]["token"].as_str().unwrap().to_string();
    v["gateway"]["token"] = json!(edit(&token));
    v.to_string()
}

#[test]
fn the_live_gateway_token_passes_as_gateway_evidence() {
    let facts = ita::check(ITA.as_bytes(), INTEL_KEYS.as_bytes(), &ita_nonce(), ITA_NOW).unwrap();
    assert_eq!(facts.tcb_status, "OutOfDate");
    assert_eq!(facts.advisory_ids.len(), 10);
    assert_eq!(hex::encode(facts.signing_address), "40599fb284f43953bb356b09080fd803c960fc10285ad90eca462ca711ad4acb");
    assert_eq!(facts.gpus, Some((8, true)), "Intel's own GPU appraisal from the model token");
    assert_eq!(facts.exp - facts.iat, 300);
}

#[test]
fn a_changed_intel_token_is_refused() {
    let flip_signature = with_gateway_token(|t| {
        let (head, sig) = t.rsplit_once('.').unwrap();
        let mut bytes = URL_SAFE_NO_PAD.decode(sig).unwrap();
        bytes[5] ^= 1;
        format!("{head}.{}", URL_SAFE_NO_PAD.encode(bytes))
    });
    let flip_claims = with_gateway_token(|t| {
        let parts: Vec<&str> = t.split('.').collect();
        let claims = String::from_utf8(URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap().replace("OutOfDate", "UpToDate");
        format!("{}.{}.{}", parts[0], URL_SAFE_NO_PAD.encode(claims), parts[2])
    });
    let other_jku = with_gateway_token(|t| {
        let parts: Vec<&str> = t.split('.').collect();
        let head = String::from_utf8(URL_SAFE_NO_PAD.decode(parts[0]).unwrap()).unwrap().replace("/certs", "/certs/");
        format!("{}.{}.{}", URL_SAFE_NO_PAD.encode(head), parts[1], parts[2])
    });
    for bad in [flip_signature, flip_claims, other_jku] {
        assert_eq!(ita::check(bad.as_bytes(), INTEL_KEYS.as_bytes(), &ita_nonce(), ITA_NOW), Err(Unverified::GatewayTokenRejected));
    }
    let no_keys = r#"{"keys":[]}"#;
    assert_eq!(ita::check(ITA.as_bytes(), no_keys.as_bytes(), &ita_nonce(), ITA_NOW), Err(Unverified::GatewayTokenRejected));
}

#[test]
fn an_old_or_foreign_intel_token_is_refused() {
    assert_eq!(ita::check(ITA.as_bytes(), INTEL_KEYS.as_bytes(), &[0; 32], ITA_NOW), Err(Unverified::NonceMismatch));
    assert_eq!(ita::check(ITA.as_bytes(), INTEL_KEYS.as_bytes(), &ita_nonce(), ITA_NOW + 300), Err(Unverified::GatewayTokenRejected));
    let mut other_model: Value = serde_json::from_str(ITA).unwrap();
    other_model["models"][0]["model"] = json!("z-ai/glm-5.3");
    let other_model = other_model.to_string();
    assert_eq!(ita::check(other_model.as_bytes(), INTEL_KEYS.as_bytes(), &ita_nonce(), ITA_NOW), Err(Unverified::GatewayTokenRejected));
}

fn nvidia_key() -> p384::ecdsa::SigningKey {
    p384::ecdsa::SigningKey::from_slice(&[7u8; 48]).unwrap()
}

fn nvidia_keys(kid: &str) -> Value {
    let point = nvidia_key().verifying_key().to_sec1_point(false);
    json!({ "keys": [{ "kty": "EC", "crv": "P-384", "kid": kid,
        "x": URL_SAFE_NO_PAD.encode(point.x().unwrap()), "y": URL_SAFE_NO_PAD.encode(point.y().unwrap()) }] })
}

const NOW: u64 = 1_800_000_000;

fn nras_token(claims: Value) -> String {
    let head = URL_SAFE_NO_PAD.encode(r#"{"alg":"ES384","kid":"nv-eat-kid-test","typ":"JWT"}"#);
    let body = URL_SAFE_NO_PAD.encode(claims.to_string());
    let sig: p384::ecdsa::Signature = nvidia_key().sign(format!("{head}.{body}").as_bytes());
    format!("{head}.{body}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()))
}

fn wrap(token: &str) -> Vec<u8> {
    json!([["JWT", token], { "GPU-0": "detached" }]).to_string().into_bytes()
}

fn nras_answer(claims: Value) -> Vec<u8> {
    wrap(&nras_token(claims))
}

fn good_claims(nonce: &[u8; 32]) -> Value {
    json!({ "iss": gpu::NRAS_ISSUER, "iat": NOW, "nbf": NOW, "exp": NOW + 3600,
        "eat_nonce": hex::encode(nonce), "x-nvidia-overall-att-result": true })
}

#[test]
fn an_nras_verdict_signed_by_nvidias_key_passes() {
    let nonce = [3; 32];
    let facts = gpu::check(&nras_answer(good_claims(&nonce)), &nvidia_keys("nv-eat-kid-test"), &nonce, NOW + 5).unwrap();
    assert!(facts.passed);
    assert_eq!(facts.exp, NOW + 3600);
}

#[test]
fn a_bad_nvidia_token_is_refused() {
    let nonce = [3; 32];
    let keys = nvidia_keys("nv-eat-kid-test");
    let token = nras_token(good_claims(&nonce));
    let (signed, sig) = token.rsplit_once('.').unwrap();
    let mut sig = URL_SAFE_NO_PAD.decode(sig).unwrap();
    sig[10] ^= 1;
    let flipped = wrap(&format!("{signed}.{}", URL_SAFE_NO_PAD.encode(sig)));
    let mut wrong_issuer = good_claims(&nonce);
    wrong_issuer["iss"] = json!("https://nras.attestation.nvidia.com.evil.example");
    let mut expired = good_claims(&nonce);
    expired["exp"] = json!(NOW);
    for (answer, keys) in [
        (flipped, keys.clone()),
        (nras_answer(good_claims(&nonce)), nvidia_keys("another-kid")),
        (nras_answer(wrong_issuer), keys.clone()),
        (nras_answer(expired), keys.clone()),
        (br#"[["JWS","x"]]"#.to_vec(), keys.clone()),
        (br#"{"token":"x"}"#.to_vec(), keys.clone()),
    ] {
        assert_eq!(gpu::check(&answer, &keys, &nonce, NOW + 5), Err(Unverified::GpuTokenRejected));
    }
}

#[test]
fn nvidia_must_carry_the_nonce_and_pass_the_gpus() {
    let nonce = [3; 32];
    let keys = nvidia_keys("nv-eat-kid-test");
    assert_eq!(gpu::check(&nras_answer(good_claims(&[4; 32])), &keys, &nonce, NOW + 5), Err(Unverified::NonceMismatch));
    let mut failed = good_claims(&nonce);
    failed["x-nvidia-overall-att-result"] = json!(false);
    assert_eq!(gpu::check(&nras_answer(failed), &keys, &nonce, NOW + 5), Err(Unverified::GpuNotTrusted));
    let mut text = good_claims(&nonce);
    text["x-nvidia-overall-att-result"] = json!("true");
    assert_eq!(gpu::check(&nras_answer(text), &keys, &nonce, NOW + 5), Err(Unverified::GpuNotTrusted), "only boolean true passes");
}

#[test]
fn the_gpu_payload_must_carry_the_nonce_before_it_is_sent() {
    let nonce = [3; 32];
    let payload = json!({ "nonce": hex::encode(nonce), "arch": "HOPPER", "evidence_list": [{}, {}] }).to_string();
    assert_eq!(gpu::payload(Some(&payload), &nonce), Ok((payload.as_str(), 2)));
    assert_eq!(gpu::payload(Some(&payload), &[4; 32]), Err(Unverified::NonceMismatch));
    for missing in [None, Some(""), Some("[1]"), Some("not json")] {
        assert_eq!(gpu::payload(missing, &nonce), Err(Unverified::GpuEvidenceMissing), "{missing:?}");
    }
}
