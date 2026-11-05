//! NEAR AI's response signature, checked against the exact bytes (C11). Each way a signature can
//! fail is refused with its own reason. Not covered here: a signature NEAR AI really made (that
//! needs the key; the first keyed testnet run in packages/sealed/RUNS.md covers it) and how the
//! reasons become the verdict's AI status (`attest_flow.rs`).

mod common;

use common::Scripted;
use ed25519_dalek::{Signer, SigningKey};
use kaap_sealed::attest::signature::*;
use kaap_sealed::attest::{Unverified, VerifiedModel};
use kaap_sealed::net::{Deadline, Response};

const MODEL: &str = "z-ai/glm-5.3-flash";
const REQUEST: &[u8] = br#"{"model":"z-ai/glm-5.3-flash","stream":false}"#;
const RESPONSE: &[u8] = br#"{"id":"chatcmpl-1","object":"chat.completion"}"#;

fn model_key() -> SigningKey {
    SigningKey::from_bytes(&[7; 32])
}

fn signed(key: &SigningKey, text: &str, kind: &str, algo: &str) -> Vec<u8> {
    serde_json::json!({
        "text": text,
        "signature": hex::encode(key.sign(text.as_bytes()).to_bytes()),
        "signing_address": hex::encode(key.verifying_key().to_bytes()),
        "signing_algo": algo,
        "signature_kind": kind,
    })
    .to_string()
    .into_bytes()
}

fn verified(key: &SigningKey) -> VerifiedModel {
    VerifiedModel { signing_address: key.verifying_key().to_bytes(), tcb_status: "OutOfDate".into(), advisory_ids: vec![], gpus: 8 }
}

#[test]
fn the_text_is_the_model_and_the_hashes_of_the_exact_bytes() {
    let text = expected_text(MODEL, REQUEST, RESPONSE);
    let parts: Vec<&str> = text.split(':').collect();
    assert_eq!(parts[0], MODEL);
    assert_eq!(parts[1], hex::encode(<sha2::Sha256 as sha2::Digest>::digest(REQUEST)));
    assert!(parts[1..].iter().all(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))));
    let spaced = [REQUEST, b" "].concat();
    assert_ne!(expected_text(MODEL, &spaced, RESPONSE), text, "one byte of whitespace is a different request");
}

#[test]
fn a_model_signature_over_the_exact_bytes_passes() {
    let key = model_key();
    let text = expected_text(MODEL, REQUEST, RESPONSE);
    let got = check(&signed(&key, &text, "provider_tee", "ed25519"), &text).unwrap();
    assert_eq!(got.text, text);
    assert_eq!(got.signing_address, key.verifying_key().to_bytes());
    assert_eq!(match_signer(&got.signing_address, &[verified(&key)]).unwrap().tcb_status, "OutOfDate");

    let upper = String::from_utf8(signed(&key, &text, "provider_tee", "ed25519")).unwrap();
    let address = hex::encode(key.verifying_key().to_bytes());
    let prefixed = upper.replace(&address, &format!("0x{}", address.to_uppercase()));
    assert!(check(prefixed.as_bytes(), &text).is_ok(), "the key goes through the one hex decoder");
}

#[test]
fn a_gateway_signature_is_refused() {
    let key = model_key();
    let text = expected_text(MODEL, REQUEST, RESPONSE);
    let hashes = text.split_once(':').unwrap().1;
    assert_eq!(check(&signed(&key, hashes, "gateway", "ed25519"), &text), Err(Unverified::GatewaySigned));
    assert_eq!(check(&signed(&key, &text, "gateway", "ed25519"), &text), Err(Unverified::GatewaySigned));
}

#[test]
fn an_unknown_kind_or_algorithm_is_unreadable_not_guessed() {
    let key = model_key();
    let text = expected_text(MODEL, REQUEST, RESPONSE);
    for (kind, algo) in [("", "ed25519"), ("tee", "ed25519"), ("provider_tee", "ecdsa"), ("provider_tee", "ED25519")] {
        assert_eq!(check(&signed(&key, &text, kind, algo), &text), Err(Unverified::SignatureUnreadable), "{kind} {algo}");
    }
    let mut no_kind: serde_json::Value = serde_json::from_slice(&signed(&key, &text, "provider_tee", "ed25519")).unwrap();
    no_kind.as_object_mut().unwrap().remove("signature_kind");
    assert_eq!(check(no_kind.to_string().as_bytes(), &text), Err(Unverified::SignatureUnreadable));
    assert_eq!(check(b"<html>", &text), Err(Unverified::SignatureUnreadable));
}

#[test]
fn a_signature_over_other_bytes_is_a_text_mismatch() {
    let key = model_key();
    let text = expected_text(MODEL, REQUEST, RESPONSE);
    let other_answer = expected_text(MODEL, REQUEST, br#"{"id":"chatcmpl-1","object":"chat.completion","x":1}"#);
    assert_eq!(check(&signed(&key, &other_answer, "provider_tee", "ed25519"), &text), Err(Unverified::TextMismatch));
    let other_model = expected_text("z-ai/glm-5.3", REQUEST, RESPONSE);
    assert_eq!(check(&signed(&key, &other_model, "provider_tee", "ed25519"), &text), Err(Unverified::TextMismatch));
}

#[test]
fn a_changed_or_borrowed_signature_does_not_verify() {
    let key = model_key();
    let text = expected_text(MODEL, REQUEST, RESPONSE);
    let mut body: serde_json::Value = serde_json::from_slice(&signed(&key, &text, "provider_tee", "ed25519")).unwrap();
    let mut sig = hex::decode(body["signature"].as_str().unwrap()).unwrap();
    sig[0] ^= 1;
    body["signature"] = serde_json::json!(hex::encode(&sig));
    assert_eq!(check(body.to_string().as_bytes(), &text), Err(Unverified::SignatureInvalid));

    let thief = SigningKey::from_bytes(&[9; 32]);
    let mut borrowed: serde_json::Value = serde_json::from_slice(&signed(&thief, &text, "provider_tee", "ed25519")).unwrap();
    borrowed["signing_address"] = serde_json::json!(hex::encode(key.verifying_key().to_bytes()));
    assert_eq!(check(borrowed.to_string().as_bytes(), &text), Err(Unverified::SignatureInvalid));
}

#[test]
fn the_signer_must_be_exactly_one_verified_model() {
    let key = model_key();
    let other = SigningKey::from_bytes(&[8; 32]);
    let signer = key.verifying_key().to_bytes();
    assert_eq!(match_signer(&signer, &[verified(&other)]), Err(Unverified::SignerNotAttested));
    assert_eq!(match_signer(&signer, &[]), Err(Unverified::SignerNotAttested));
    assert_eq!(match_signer(&signer, &[verified(&key), verified(&key)]), Err(Unverified::SignerNotAttested), "ambiguous");
    assert!(match_signer(&signer, &[verified(&other), verified(&key)]).is_ok());
}

#[test]
fn the_lookup_retries_a_signature_not_yet_recorded_then_gives_up() {
    let soon = Deadline::after_ms(60_000);
    let pending = Response::new(200, br#"{"error_code":"not_found","message":"not yet"}"#.to_vec());
    let good = Response::new(200, b"{\"text\":\"t\"}".to_vec());
    let mut http = Scripted(vec![Response::new(404, vec![]), pending.clone(), good.clone()], Vec::new());
    assert_eq!(fetch(&mut http, "sk-1", "chatcmpl-abc_1", soon).unwrap(), good.body);
    assert_eq!(http.1, vec!["cloud-api.near.ai/v1/signature/chatcmpl-abc_1?signing_algo=ed25519"; 3]);

    let mut http = Scripted(vec![Response::new(404, vec![]); 6], Vec::new());
    assert_eq!(fetch(&mut http, "sk-1", "chatcmpl-1", soon), Err(Unverified::SignatureUnavailable));
    assert_eq!(http.1.len(), SIGNATURE_ATTEMPTS as usize);

    let mut http = Scripted(vec![Response::new(500, vec![])], Vec::new());
    assert_eq!(fetch(&mut http, "sk-1", "chatcmpl-1", soon), Err(Unverified::SignatureUnavailable));
    assert_eq!(http.1.len(), 1, "a server error is not retried");
}

#[test]
fn a_chat_id_that_could_change_the_url_is_never_sent() {
    for id in ["", "../model/list", "chatcmpl-1?x=1", "chatcmpl 1", "chatcmpl-1#", "a@b", &"a".repeat(129)] {
        assert!(!chat_id_ok(id), "{id:?}");
        let mut http = Scripted(vec![], Vec::new());
        assert_eq!(fetch(&mut http, "sk-1", id, Deadline::after_ms(60_000)), Err(Unverified::SignatureUnavailable));
        assert!(http.1.is_empty());
    }
    assert!(chat_id_ok("chatcmpl-9f86d081884c7d659a2feaa0c55ad015"));
}
