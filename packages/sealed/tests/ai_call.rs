//! The AI call and its Unavailable path, against recorded answers (C10, C12, standard 4). Not
//! covered here: the WASI transport and its timers, which exist only inside the wasm component
//! (the local wasmtime run in `RUNS.md` and the testnet runs exercise them), a live NEAR AI answer
//! (no key yet), and the signature and attestation checks of WO-05.

use kaap_sealed::ai::*;
use kaap_sealed::net::{Deadline, Http, HttpFail, Method, Request, Response};

/// One request as sent: method, endpoint, headers, body, limits.
type Seen = (Method, String, Vec<(String, String)>, Option<Vec<u8>>, kaap_sealed::net::Limits);

/// Answers from a script and keeps every request it was sent, headers and body included.
struct Scripted {
    answers: Vec<Result<Response, HttpFail>>,
    seen: Vec<Seen>,
}

impl Scripted {
    fn new(answers: Vec<Result<Response, HttpFail>>) -> Self {
        Scripted { answers, seen: Vec::new() }
    }
}

impl Http for Scripted {
    fn send(&mut self, r: &Request<'_>) -> Result<Response, HttpFail> {
        self.seen.push((
            r.method,
            format!("{}{}", r.endpoint.authority, r.endpoint.path),
            r.headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            r.body.map(<[u8]>::to_vec),
            r.limits,
        ));
        if self.answers.is_empty() {
            return Err(HttpFail::NoAnswerRecorded);
        }
        self.answers.remove(0)
    }
}

const LIVE_LIST: &str = include_str!("fixtures/model-list-2026-10-29.json");
const KEY: &str = "sk-test-0000";

fn ok(body: &[u8]) -> Result<Response, HttpFail> {
    Ok(Response { status: 200, body: body.to_vec() })
}

fn chat(content: &str) -> Vec<u8> {
    serde_json::json!({
        "id": "c", "object": "chat.completion", "created": 1, "model": MODEL_ID,
        "choices": [{ "index": 0, "finish_reason": "stop", "message": { "role": "assistant", "content": content } }],
        "usage": { "prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2 },
    })
    .to_string()
    .into_bytes()
}

fn soon() -> Deadline {
    Deadline::after_ms(60_000)
}

#[test]
fn a_good_answer_comes_back_from_the_pinned_model_over_two_requests() {
    let content = r#"{"risk":"high","explanation":"Pays a lookalike account."}"#;
    let mut http = Scripted::new(vec![ok(LIVE_LIST.as_bytes()), ok(&chat(content))]);
    let got = consult(&mut http, Some(KEY), Some("FACTS"), soon());
    assert_eq!(
        got,
        AiOutcome::Answered {
            answer: AiAnswer { risk: AiRisk::High, explanation: "Pays a lookalike account.".into() },
            model_id: MODEL_ID
        }
    );
    let (m1, url1, h1, b1, l1) = &http.seen[0];
    assert_eq!((*m1, url1.as_str()), (Method::Get, "cloud-api.near.ai/v1/model/list"));
    assert!(h1.iter().all(|(k, _)| k != "authorization"), "the key never goes to the catalog");
    assert!(b1.is_none());
    assert_eq!(l1.max_body_bytes, MODEL_LIST_LIMITS.max_body_bytes);

    let (m2, url2, h2, b2, l2) = &http.seen[1];
    assert_eq!((*m2, url2.as_str()), (Method::Post, "cloud-api.near.ai/v1/chat/completions"));
    assert!(h2.contains(&("authorization".into(), format!("Bearer {KEY}"))));
    assert!(h2.contains(&("x-no-aliasing".into(), "true".into())));
    let body: serde_json::Value = serde_json::from_slice(b2.as_ref().unwrap()).unwrap();
    assert_eq!(body["model"], MODEL_ID);
    assert_eq!(body["stream"], false);
    assert_eq!(body["messages"][1]["content"], "FACTS");
    assert_eq!((l2.connect_ms, l2.first_byte_ms, l2.between_bytes_ms), (5_000, 25_000, 10_000));
    assert!(l2.overall_ms <= CHAT_LIMITS.overall_ms);
}

#[test]
fn no_key_means_no_request_at_all() {
    for key in [None, Some("")] {
        let mut http = Scripted::new(vec![]);
        assert_eq!(consult(&mut http, key, Some("FACTS"), soon()), AiOutcome::Unavailable(Refusal::NoKey));
        assert!(http.seen.is_empty());
    }
    let mut http = Scripted::new(vec![]);
    assert_eq!(consult(&mut http, Some("sk-1\r\nx-evil: 1"), Some("FACTS"), soon()), AiOutcome::Unavailable(Refusal::KeyNotAHeaderValue));
    assert_eq!(consult(&mut http, Some(KEY), None, soon()), AiOutcome::Unavailable(Refusal::FactsTooLarge));
    assert!(http.seen.is_empty());
}

#[test]
fn a_model_the_catalog_does_not_mark_sealed_is_never_sent_the_prompt() {
    let tinfoil = LIVE_LIST.replace("\"modelId\": \"z-ai/glm-5.3-flash\"", "\"modelId\": \"z-ai/glm-5.3-flash-moved\"");
    let mut http = Scripted::new(vec![ok(tinfoil.as_bytes()), ok(&chat("{}"))]);
    assert_eq!(consult(&mut http, Some(KEY), Some("FACTS"), soon()), AiOutcome::Unavailable(Refusal::ModelNotListed));
    assert_eq!(http.seen.len(), 1, "only the catalog was asked");

    let mut http = Scripted::new(vec![Ok(Response { status: 503, body: vec![] })]);
    assert_eq!(consult(&mut http, Some(KEY), Some("FACTS"), soon()), AiOutcome::Unavailable(Refusal::CatalogUnreadable));
    assert_eq!(http.seen.len(), 1);
}

#[test]
fn failures_and_refused_answers_are_unavailable() {
    let cases: Vec<(Result<Response, HttpFail>, Refusal)> = vec![
        (Err(HttpFail::Timeout), Refusal::Deadline),
        (Err(HttpFail::TooLarge), Refusal::CallFailed),
        (Err(HttpFail::Send), Refusal::CallFailed),
        (Ok(Response { status: 401, body: br#"{"error":{"message":"bad key"}}"#.to_vec() }), Refusal::CallFailed),
        (ok(&chat("not json")), Refusal::AnswerNotTheSchema),
        (ok(&chat(r#"{"risk":"none","explanation":"x"}"#)), Refusal::UnknownRiskWord),
        (ok(&chat(r#"{"risk":"low","explanation":"see https://x.example"}"#)), Refusal::ExplanationNotPlainText),
        (ok(b"<html>gateway error</html>"), Refusal::ResponseUnreadable),
    ];
    for (answer, want) in cases {
        let mut http = Scripted::new(vec![ok(LIVE_LIST.as_bytes()), answer]);
        assert_eq!(consult(&mut http, Some(KEY), Some("FACTS"), soon()), AiOutcome::Unavailable(want));
    }
    let mut http = Scripted::new(vec![Err(HttpFail::Timeout)]);
    assert_eq!(consult(&mut http, Some(KEY), Some("FACTS"), soon()), AiOutcome::Unavailable(Refusal::Deadline));
}

#[test]
fn a_passed_deadline_sends_nothing_and_a_short_one_cuts_every_limit() {
    let mut http = Scripted::new(vec![]);
    assert_eq!(consult(&mut http, Some(KEY), Some("FACTS"), Deadline::after_ms(0)), AiOutcome::Unavailable(Refusal::Deadline));
    assert!(http.seen.is_empty());

    let mut http = Scripted::new(vec![ok(LIVE_LIST.as_bytes()), ok(&chat(r#"{"risk":"low","explanation":"Fine."}"#))]);
    let _ = consult(&mut http, Some(KEY), Some("FACTS"), Deadline::after_ms(3_000));
    assert!(http.seen.iter().all(|s| s.4.overall_ms <= 3_000), "no request may outlive the job's deadline");
}

#[test]
fn the_refusal_notes_never_carry_the_key_or_answer_text() {
    let notes = [
        Refusal::NoKey, Refusal::KeyNotAHeaderValue, Refusal::FactsTooLarge, Refusal::CatalogUnreadable,
        Refusal::ModelNotListed, Refusal::ModelNotSealed, Refusal::CallFailed, Refusal::ResponseUnreadable,
        Refusal::OtherModelAnswered, Refusal::NotOneFinishedChoice, Refusal::AnswerTooLong,
        Refusal::AnswerNotTheSchema, Refusal::UnknownRiskWord, Refusal::ExplanationEmpty,
        Refusal::ExplanationTooLong, Refusal::ExplanationNotPlainText, Refusal::Deadline,
    ];
    for r in notes {
        let note = r.note();
        assert!(note.starts_with("AI unavailable: "));
        assert!(is_plain_text(note) && note.len() <= MAX_EXPLANATION_BYTES, "{note}");
    }
}
