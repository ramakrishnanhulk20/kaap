//! The AI call and its Unavailable path (C10, C12, standard 4), run against the stand-in world of
//! `common/world.rs`. Not covered here: the WASI transport and its timers, which exist only inside
//! the wasm component (the testnet runs in `RUNS.md` exercise them), a live NEAR AI answer (the
//! first keyed testnet run gives one), and each "AI verified" check (`attest_*.rs`).

mod common;

use common::world::{trust, World, KEY, LIST};
use kaap_sealed::ai::*;
use kaap_sealed::attest::{Trust, Unverified};
use kaap_sealed::net::{Deadline, HttpFail, Response};

fn soon() -> Deadline {
    Deadline::after_ms(60_000)
}

fn ask(world: &mut World, key: Option<&str>, facts: Option<&str>, deadline: Deadline) -> AiOutcome {
    consult(world, key, facts, Audience::Public, deadline, &trust()).0
}

const SEALED_FACTS: &str = "FACTS drawn from a text only members may read";

/// A Members prompt through `world` under `trust`.
fn ask_for_members(world: &mut World, trust: &Trust) -> AiOutcome {
    consult(world, Some(KEY), Some(SEALED_FACTS), Audience::Members, soon(), trust).0
}

fn never_sent(world: &World) {
    assert!(!world.urls().contains(&"cloud-api.near.ai/v1/chat/completions"), "the question was asked");
    assert!(!world.bodies.iter().any(|b| b.windows(SEALED_FACTS.len()).any(|w| w == SEALED_FACTS.as_bytes())), "the facts left the job");
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
fn a_failed_preflight_never_sends_a_members_prompt() {
    let not_proven = AiOutcome::Unavailable(Refusal::SealedHardwareNotProven);
    let mut world = World::new();
    world.overrides.push(("/v1/attestation/report", Ok(Response::new(503, vec![]))));
    assert_eq!(ask_for_members(&mut world, &trust()), not_proven);
    never_sent(&world);

    // The model's checks all pass and only the gateway's token fails, the last check of the preflight.
    let mut world = World::new();
    world.ita = "{}".to_string();
    assert_eq!(ask_for_members(&mut world, &trust()), not_proven);
    never_sent(&world);
    assert!(world.urls().iter().any(|u| u.contains("/v1/attestation/ita-token")), "the preflight ran to its end");

    let mut world = World::new();
    assert_eq!(ask_for_members(&mut world, &Trust { nonce: None, ..trust() }), not_proven);
    never_sent(&world);
    let mut world = World::new();
    assert_eq!(ask_for_members(&mut world, &Trust { now: Err(Unverified::NoClock), ..trust() }), not_proven);
    never_sent(&world);
}

#[test]
fn a_passed_preflight_sends_a_members_prompt_to_the_chat_alone() {
    let mut world = World::new();
    let got = ask_for_members(&mut world, &trust());
    assert!(matches!(got, AiOutcome::Answered { check: Check::Verified { .. }, .. }), "{got:?}");
    let carrying: Vec<_> = world.bodies.iter().filter(|b| b.windows(SEALED_FACTS.len()).any(|w| w == SEALED_FACTS.as_bytes())).collect();
    assert_eq!(carrying.len(), 1, "exactly one request carried the facts");
    let last_preflight_call = world.urls().iter().rposition(|u| u.contains("/v1/attestation/ita-token")).unwrap();
    let chat = world.urls().iter().position(|u| u.ends_with("/v1/chat/completions")).unwrap();
    assert!(last_preflight_call < chat, "the facts go out only after the last preflight check");
}

#[test]
fn nothing_is_cut_at_the_limit_the_model_is_told() {
    let text: String = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima ".repeat(4)[..MAX_EXPLANATION_BYTES].to_string();
    let world = || {
        let mut w = World::new();
        w.chat["choices"][0]["message"]["content"] = serde_json::json!(format!(r#"{{"risk":"high","explanation":"{text}"}}"#));
        w
    };
    let AiOutcome::Answered { answer, .. } = ask_for_members(&mut world(), &trust()) else { panic!("refused") };
    assert_eq!(answer.explanation, text, "a run's real room decides, when the verdict is sealed");

    let AiOutcome::Answered { answer, .. } = ask(&mut world(), Some(KEY), Some("FACTS"), soon()) else { panic!("refused") };
    assert_eq!(answer.explanation, text, "a public answer keeps its 280 bytes");

    let mut over = World::new();
    over.chat["choices"][0]["message"]["content"] = serde_json::json!(format!(r#"{{"risk":"high","explanation":"{text}x"}}"#));
    assert_eq!(ask_for_members(&mut over, &trust()), AiOutcome::Unavailable(Refusal::ExplanationTooLong), "280 still holds");
}

#[test]
fn cutting_at_a_word_never_leaves_part_of_one() {
    use kaap_sealed::prompt::cut_at_word;
    assert_eq!(cut_at_word("one two three", 13), "one two three");
    assert_eq!(cut_at_word("one two three", 12), "one two");
    assert_eq!(cut_at_word("one two three", 7), "one two", "the cut lands exactly on a space");
    assert_eq!(cut_at_word("one two three", 8), "one two");
    assert_eq!(cut_at_word("one  two", 4), "one", "no space is left at the end");
    assert_eq!(cut_at_word("averylongfirstword two", 5), "", "half a word is never kept");
    assert_eq!(cut_at_word("one t\u{e9}", 6), "one", "and no character is split");
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
    for r in Refusal::ALL {
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
