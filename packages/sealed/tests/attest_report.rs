//! The keyed attestation report and the two report-data layouts (C11): NEAR's for a model quote
//! (signing key, then Kaap's nonce) and Intel's for the gateway's public token (a SHA-512 over
//! Intel's nonce and the runtime JSON). Intel's layout is checked against two real tokens of
//! 23 Oct 2026; NEAR's against the bytes of a real TDX quote, because no keyed NEAR report exists
//! yet. Not covered here: whether the quote itself is genuine (`attest_quote.rs`).

use kaap_sealed::attest::ita::gateway_report_data;
use kaap_sealed::attest::report::*;
use kaap_sealed::attest::Unverified;
use kaap_sealed::net::{Deadline, Http, HttpFail, Request, Response};
use serde_json::{json, Value};

const QUOTE_HEX: &str = include_str!("fixtures/dcap-sample-tdx-quote.hex");

/// Report data sits after the 48-byte quote header and 520 bytes of TD report fields.
fn sample_report_data() -> [u8; 64] {
    hex::decode(QUOTE_HEX).unwrap()[568..632].try_into().unwrap()
}

struct Seen {
    answer: Result<Response, HttpFail>,
    url: String,
    headers: Vec<(String, String)>,
}

impl Http for Seen {
    fn send(&mut self, r: &Request<'_>) -> Result<Response, HttpFail> {
        self.url = format!("{}{}{}", r.endpoint.authority, r.endpoint.path, r.tail);
        self.headers = r.headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        self.answer.clone()
    }
}

fn report(entries: Vec<Value>) -> Vec<u8> {
    json!({ "gateway_attestation": { "signing_address": "x" }, "model_attestations": entries }).to_string().into_bytes()
}

fn entry(address: &[u8], nonce: &[u8; 32]) -> Value {
    json!({
        "intel_quote": QUOTE_HEX, "request_nonce": hex::encode(nonce), "signing_address": hex::encode(address),
        "signing_algo": "ed25519", "nvidia_payload": "{\"nonce\":\"x\"}", "event_log": "[]", "info": {},
    })
}

#[test]
fn the_report_is_asked_for_with_the_key_the_nonce_and_no_aliasing() {
    let nonce = [0xab; 32];
    let mut http = Seen { answer: Ok(Response::new(200, b"{}".to_vec())), url: String::new(), headers: vec![] };
    assert_eq!(fetch(&mut http, "sk-k", &nonce, Deadline::after_ms(60_000)).unwrap(), b"{}");
    assert_eq!(
        http.url,
        format!("cloud-api.near.ai/v1/attestation/report?model=z-ai%2Fglm-5.3-flash&signing_algo=ed25519&nonce={}&provider=near&include_tls_fingerprint=false", "ab".repeat(32))
    );
    assert!(http.headers.contains(&("authorization".into(), "Bearer sk-k".into())));
    assert!(http.headers.contains(&("x-no-aliasing".into(), "true".into())));
    assert!(kaap_sealed::net::is_safe_tail(&report_tail(&nonce)));

    for (answer, want) in [
        (Ok(Response::new(401, vec![])), Unverified::ReportUnavailable),
        (Err(HttpFail::Send), Unverified::ReportUnavailable),
        (Err(HttpFail::Timeout), Unverified::Deadline),
    ] {
        let mut http = Seen { answer, url: String::new(), headers: vec![] };
        assert_eq!(fetch(&mut http, "sk-k", &nonce, Deadline::after_ms(60_000)), Err(want));
    }
}

#[test]
fn each_candidate_is_read_on_its_own_and_the_list_must_be_real() {
    let rd = sample_report_data();
    let nonce: [u8; 32] = rd[32..].try_into().unwrap();
    let good = entry(&rd[..32], &nonce);
    let got = candidates(&report(vec![good.clone()]), &nonce).unwrap();
    let c = got[0].as_ref().unwrap();
    assert_eq!(c.signing_address[..], rd[..32]);
    assert_eq!(c.quote, hex::decode(QUOTE_HEX).unwrap());
    assert_eq!(c.nvidia_payload.as_deref(), Some("{\"nonce\":\"x\"}"));

    let with = |field: &str, value: Value| {
        let mut e = good.clone();
        e[field] = value;
        candidates(&report(vec![e]), &nonce).unwrap().remove(0)
    };
    assert_eq!(with("signing_algo", json!("ecdsa")), Err(Unverified::ReportDataLayout));
    assert_eq!(with("signing_address", json!("0x1234")), Err(Unverified::ReportDataLayout));
    assert_eq!(with("tls_cert_fingerprint", json!("aa".repeat(32))), Err(Unverified::ReportDataLayout));
    assert_eq!(with("request_nonce", json!("00".repeat(32))), Err(Unverified::NonceMismatch));
    assert_eq!(with("intel_quote", json!("zz")), Err(Unverified::ReportUnreadable));
    assert!(with("tls_cert_fingerprint", Value::Null).is_ok());
    assert!(with("request_nonce", json!(hex::encode(nonce).to_uppercase())).is_ok(), "one hex decoder for both sides");

    let mixed = candidates(&report(vec![good.clone(), json!({ "intel_quote": "00" })]), &nonce);
    assert_eq!(mixed, Err(Unverified::ReportUnreadable), "a candidate missing its fields is not a report");
    assert_eq!(candidates(&report(vec![]), &nonce), Err(Unverified::NoModelEvidence));
    assert_eq!(candidates(&report(vec![good.clone(); MAX_CANDIDATES + 1]), &nonce), Err(Unverified::NoModelEvidence));
    assert_eq!(candidates(br#"{"gateway_attestation":{}}"#, &nonce), Err(Unverified::NoModelEvidence));
    assert_eq!(candidates(b"<html>", &nonce), Err(Unverified::ReportUnreadable));
}

#[test]
fn the_quote_must_bind_the_signing_key_then_the_nonce_in_near_layout() {
    let rd = sample_report_data();
    let (address, nonce): ([u8; 32], [u8; 32]) = (rd[..32].try_into().unwrap(), rd[32..].try_into().unwrap());
    let candidate = Candidate { quote: vec![], signing_address: address, nvidia_payload: None, report_data: None };
    assert_eq!(bind(&candidate, &rd, &nonce), Ok(()));
    assert_eq!(bind(&candidate, &rd, &[0; 32]), Err(Unverified::NonceMismatch), "an old report carries an old nonce");

    let other_key = Candidate { signing_address: [1; 32], ..candidate.clone() };
    assert_eq!(bind(&other_key, &rd, &nonce), Err(Unverified::ReportDataLayout));
    let mut swapped = [0u8; 64];
    swapped[..32].copy_from_slice(&rd[32..]);
    swapped[32..].copy_from_slice(&rd[..32]);
    assert_eq!(bind(&candidate, &swapped, &nonce), Err(Unverified::NonceMismatch), "nonce first is not NEAR's layout");

    let claimed = Candidate { report_data: Some([0; 64]), ..candidate.clone() };
    assert_eq!(bind(&claimed, &rd, &nonce), Err(Unverified::ReportDataLayout), "the report's own claim must match the quote");
    let honest = Candidate { report_data: Some(rd), ..candidate };
    assert_eq!(bind(&honest, &rd, &nonce), Ok(()));
}

fn gateway_claims(file: &str) -> Value {
    let response: Value = serde_json::from_str(file).unwrap();
    let payload = response["gateway"]["token"].as_str().unwrap().split('.').nth(1).unwrap();
    use base64::Engine as _;
    serde_json::from_slice(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap()
}

#[test]
fn intels_layout_explains_both_live_gateway_tokens() {
    for (file, nonce) in [
        (include_str!("fixtures/ita-token-2026-10-23a.json"), include_str!("fixtures/ita-token-2026-10-23a.nonce")),
        (include_str!("fixtures/ita-token-2026-10-23b.json"), include_str!("fixtures/ita-token-2026-10-23b.nonce")),
    ] {
        let tdx = &gateway_claims(file)["tdx"];
        let runtime = &tdx["attester_runtime_data"];
        assert_eq!(runtime["caller_nonce"], nonce.trim());
        let rebuilt = gateway_report_data(
            tdx["verifier_nonce"]["val"].as_str().unwrap(),
            tdx["verifier_nonce"]["iat"].as_str().unwrap(),
            runtime["signing_algo"].as_str().unwrap(),
            runtime["signing_address"].as_str().unwrap(),
            runtime["caller_nonce"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(hex::encode(rebuilt), tdx["tdx_report_data"].as_str().unwrap());

        let other_nonce = gateway_report_data(
            tdx["verifier_nonce"]["val"].as_str().unwrap(),
            tdx["verifier_nonce"]["iat"].as_str().unwrap(),
            "ed25519",
            runtime["signing_address"].as_str().unwrap(),
            &"00".repeat(32),
        );
        assert_ne!(other_nonce, Some(rebuilt), "a different nonce is a different report");
    }
}

#[test]
fn a_runtime_value_that_would_need_escaping_is_refused_not_rebuilt() {
    let ok = gateway_report_data("AAAA", "AAAA", "ed25519", &"ab".repeat(32), &"cd".repeat(32));
    assert!(ok.is_some());
    for (algo, address, nonce) in [
        ("ecdsa", "ab".repeat(32), "cd".repeat(32)),
        ("ed25519", format!("{}\"", "ab".repeat(31)), "cd".repeat(32)),
        ("ed25519", "ab".repeat(20), "cd".repeat(32)),
        ("ed25519", "ab".repeat(32), "cd".repeat(33)),
    ] {
        assert_eq!(gateway_report_data("AAAA", "AAAA", algo, &address, &nonce), None, "{algo} {address} {nonce}");
    }
    assert_eq!(gateway_report_data("not base64!", "AAAA", "ed25519", &"ab".repeat(32), &"cd".repeat(32)), None);
}
