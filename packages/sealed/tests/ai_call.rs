//! The AI call and its Unavailable path (C10, C12, standard 4), run against the stand-in world of
//! `common/world.rs`. Not covered here: the WASI transport and its timers, which exist only inside
//! the wasm component (the testnet runs in `RUNS.md` exercise them), a live NEAR AI answer (the
//! first keyed testnet run gives one), and each "AI verified" check (`attest_*.rs`).

mod common;

use common::world::{trust, World, KEY, LIST};
use kaap_sealed::ai::*;
use kaap_sealed::attest::Unverified;
use kaap_sealed::net::{Deadline, HttpFail, Response};

fn soon() -> Deadline {
    Deadline::after_ms(60_000)
}

fn ask(world: &mut World, key: Option<&str>, facts: Option<&str>, deadline: Deadline) -> AiOutcome {
    consult(world, key, facts, deadline, &trust()).0
}

#[test]
fn a_good_answer_comes_back_verified_and_the_key_goes_only_to_near_ais_keyed_calls() {
    let mut world = World::new();
    let got = ask(&mut world, Some(KEY), Some("FACTS"), soon());
    let AiOutcome::Answered { answer, model_id, check } = got else { panic!("{got:?}") };
    assert_eq!((answer.risk, model_id), (AiRisk::Critical, MODEL_ID));
    assert_eq!(check, Check::Verified { tcb_status: "OutOfDate".into() });

    let first = &world.seen[0];
    assert_eq!(first.0, "cloud-api.near.ai/v1/model/list");
    let chat = world.seen.iter().find(|s| s.0 == "cloud-api.near.ai/v1/chat/completions").unwrap();
    for header in [("x-no-aliasing", "true"), ("accept-encoding", "identity"), ("authorization", &format!("Bearer {KEY}"))] {
        assert!(chat.1.contains(&(header.0.to_string(), header.1.to_string())), "{header:?}");
    }
    for (url, headers, _) in &world.seen {
        let keyed = headers.iter().any(|(k, v)| k == "authorization" && v.contains(KEY));
        let near_ai_keyed = url.starts_with("cloud-api.near.ai/v1/attestation/report")
            || url.starts_with("cloud-api.near.ai/v1/chat/completions")
            || url.starts_with("cloud-api.near.ai/v1/signature/");
        assert_eq!(keyed, near_ai_keyed, "{url}: the key goes to NEAR AI's keyed calls and nowhere else");
    }
}

#[test]
fn no_key_means_no_request_at_all() {
    for key in [None, Some("")] {
        let mut world = World::new();
        assert_eq!(ask(&mut world, key, Some("FACTS"), soon()), AiOutcome::Unavailable(Refusal::AiKeyMissing));
        assert!(world.seen.is_empty());
    }
    let mut world = World::new();
    assert_eq!(ask(&mut world, Some("sk-1\r\nx-evil: 1"), Some("FACTS"), soon()), AiOutcome::Unavailable(Refusal::KeyNotAHeaderValue));
    assert_eq!(ask(&mut world, Some(KEY), None, soon()), AiOutcome::Unavailable(Refusal::FactsTooLarge));
    assert!(world.seen.is_empty());
}

#[test]
fn a_model_the_catalog_does_not_mark_sealed_is_never_sent_the_prompt() {
    let mut world = World::new();
    world.list = LIST.replace("\"modelId\": \"z-ai/glm-5.3-flash\"", "\"modelId\": \"z-ai/glm-5.3-flash-moved\"");
    assert_eq!(ask(&mut world, Some(KEY), Some("FACTS"), soon()), AiOutcome::Unavailable(Refusal::ModelNotListed));
    assert_eq!(world.urls(), ["cloud-api.near.ai/v1/model/list"], "only the catalog was asked");

    let mut world = World::new();
    world.overrides.push(("/v1/model/list", Ok(Response::new(503, vec![]))));
    assert_eq!(ask(&mut world, Some(KEY), Some("FACTS"), soon()), AiOutcome::Unavailable(Refusal::CatalogUnreadable));
    assert_eq!(world.seen.len(), 1);
}

#[test]
fn failures_and_refused_answers_are_unavailable() {
    let chat = |content: &str| {
        let mut w = World::new();
        w.chat["choices"][0]["message"]["content"] = serde_json::json!(content);
        w
    };
    let failed = |answer: Result<Response, HttpFail>| {
        let mut w = World::new();
        w.overrides.push(("/v1/chat/completions", answer));
        w
    };
    let cases: Vec<(World, Refusal)> = vec![
        (failed(Err(HttpFail::Timeout)), Refusal::Deadline),
        (failed(Err(HttpFail::TooLarge)), Refusal::CallFailed),
        (failed(Ok(Response::new(401, br#"{"error":{"message":"bad key"}}"#.to_vec()))), Refusal::CallFailed),
        (failed(Ok(Response::new(200, b"<html>gateway error</html>".to_vec()))), Refusal::ResponseUnreadable),
        (chat("not json"), Refusal::AnswerNotTheSchema),
        (chat(r#"{"risk":"none","explanation":"x"}"#), Refusal::UnknownRiskWord),
        (chat(r#"{"risk":"low","explanation":"see https://x.example"}"#), Refusal::ExplanationNotPlainText),
    ];
    for (mut world, want) in cases {
        assert_eq!(ask(&mut world, Some(KEY), Some("FACTS"), soon()), AiOutcome::Unavailable(want));
    }
}

#[test]
fn a_failed_preflight_still_asks_but_never_verifies() {
    let mut world = World::new();
    world.overrides.push(("/v1/attestation/report", Ok(Response::new(503, vec![]))));
    let got = ask(&mut world, Some(KEY), Some("FACTS"), soon());
    assert!(matches!(got, AiOutcome::Answered { check: Check::Unverified(Unverified::ReportUnavailable), .. }), "{got:?}");
    assert!(world.urls().contains(&"cloud-api.near.ai/v1/chat/completions"));
    assert!(!world.urls().iter().any(|u| u.starts_with("nras.") || u.starts_with("api.trustedservices")), "a failed check stops the rest");
}

#[test]
fn a_passed_deadline_sends_nothing_and_a_short_one_cuts_every_limit() {
    let mut world = World::new();
    assert_eq!(ask(&mut world, Some(KEY), Some("FACTS"), Deadline::after_ms(0)), AiOutcome::Unavailable(Refusal::Deadline));
    assert!(world.seen.is_empty());

    let mut world = World::new();
    let _ = ask(&mut world, Some(KEY), Some("FACTS"), Deadline::after_ms(3_000));
    assert!(world.seen.iter().all(|s| s.2 <= 3_000), "no request may outlive the job's deadline");
    let mut world = World::new();
    let _ = ask(&mut world, Some(KEY), Some("FACTS"), soon());
    let preflight: Vec<_> = world.seen.iter().take_while(|s| !s.0.contains("/chat/")).collect();
    assert!(preflight.iter().all(|s| s.2 <= kaap_sealed::attest::PREFLIGHT_BUDGET_MS), "the question always keeps time");
}

#[test]
fn the_refusal_notes_never_carry_the_key_or_answer_text() {
    let notes = [
        Refusal::AiKeyMissing, Refusal::KeyNotAHeaderValue, Refusal::FactsTooLarge, Refusal::CatalogUnreadable,
        Refusal::ModelNotListed, Refusal::ModelNotSealed, Refusal::CallFailed, Refusal::ResponseUnreadable,
        Refusal::NotOneFinishedChoice, Refusal::AnswerTooLong, Refusal::AnswerNotTheSchema, Refusal::UnknownRiskWord,
        Refusal::ExplanationEmpty, Refusal::ExplanationTooLong, Refusal::ExplanationNotPlainText, Refusal::Deadline,
    ];
    for r in notes {
        let note = r.note();
        assert!(note.starts_with("AI unavailable"), "{note}");
        assert!(is_plain_text(note) && note.len() <= MAX_EXPLANATION_BYTES, "{note}");
        assert!(r.code().bytes().all(|b| b.is_ascii_lowercase() || b == b'_'));
    }
    for why in Unverified::ALL {
        assert!(is_plain_text(why.note()) && why.note().len() <= 80, "{}", why.note());
        assert!(why.code().bytes().all(|b| b.is_ascii_lowercase() || b == b'_'));
    }
}
