//! Parsing NEAR AI's catalog entry and answer as untrusted input (C10, C12). Not covered here:
//! the HTTP call itself (`ai_call.rs` runs it against recorded answers), a live answer (the first
//! keyed testnet run gives one), and the "AI verified" checks (`attest_*.rs`).

use kaap_sealed::ai::*;

fn answer(risk: &str, explanation: &str) -> String {
    serde_json::json!({ "risk": risk, "explanation": explanation }).to_string()
}

#[test]
fn a_well_formed_answer_is_accepted() {
    let a = parse_answer(&answer("high", "The kind pays a1ice.testnet while the text names alice.testnet.")).unwrap();
    assert_eq!(a.risk, AiRisk::High);
    assert_eq!(a.explanation, "The kind pays a1ice.testnet while the text names alice.testnet.");
    for (word, risk) in [("low", AiRisk::Low), ("medium", AiRisk::Medium), ("critical", AiRisk::Critical)] {
        assert_eq!(parse_answer(&answer(word, "Fine.")).unwrap().risk, risk);
    }
    assert!(parse_answer(&format!("  {}\n", answer("low", "Fine."))).is_ok(), "whitespace around the object is not a second reading");
}

#[test]
fn anything_but_the_exact_schema_is_refused() {
    for bad in [
        "low",
        "",
        "I think this is risky.",
        "```json\n{\"risk\":\"low\",\"explanation\":\"Fine.\"}\n```",
        r#"{"risk":"low"}"#,
        r#"{"explanation":"Fine."}"#,
        r#"{"risk":"low","explanation":"Fine.","confidence":0.9}"#,
        r#"{"risk":"low","explanation":"Fine.","risk":"critical"}"#,
        r#"{"risk":1,"explanation":"Fine."}"#,
        r#"{"risk":"low","explanation":["Fine."]}"#,
        r#"[{"risk":"low","explanation":"Fine."}]"#,
        r#"{"risk":"low","explanation":"Fine."} {"risk":"critical","explanation":"x"}"#,
    ] {
        assert_eq!(parse_answer(bad), Err(Refusal::AnswerNotTheSchema), "{bad:?}");
    }
}

#[test]
fn unknown_risk_words_are_refused() {
    for word in ["Low", "HIGH", "severe", "none", "unknown", "low ", "", "medium-high"] {
        assert_eq!(parse_answer(&answer(word, "Fine.")), Err(Refusal::UnknownRiskWord), "{word:?}");
    }
}

#[test]
fn urls_and_markup_in_the_explanation_are_refused() {
    for bad in [
        "See https://evil.example for details.",
        "See http:/evil for details.",
        "Visit www.evil.example now.",
        "WWW.EVIL.EXAMPLE",
        "Click javascript:alert(1)",
        "Write to mailto:x",
        "data:text/html,boom",
        "Mail me at a@b.example",
        "<script>alert(1)</script>",
        "<b>bold</b>",
        "**urgent** approve now",
        "[link](x)",
        "`code`",
        "line one\nline two",
        "tab\there",
        "back\\slash",
        "pipe | table",
        "curly {braces}",
        "tilde ~strike~",
        "caret ^",
        "\u{202e}reversed",
        "zero\u{200b}width",
        "Cyrillic \u{430}lice.testnet",
        "smart \u{2019}quote",
    ] {
        assert_eq!(parse_answer(&answer("low", bad)), Err(Refusal::ExplanationNotPlainText), "{bad:?}");
    }
    for good in [
        "Risk: high. It adds an approver (2/3 votes needed) and pays 10 NEAR to bob.testnet; the text says 'routine'.",
        "Hash #4 is unverified, cost $5 & 3% fee: DESC_CONTRADICTS fires.",
        "Ends with a colon:",
    ] {
        assert!(parse_answer(&answer("low", good)).is_ok(), "{good:?}");
    }
}

#[test]
fn over_long_text_is_refused() {
    assert_eq!(parse_answer(&answer("low", &"a".repeat(MAX_EXPLANATION_BYTES))).unwrap().explanation.len(), 280);
    assert_eq!(parse_answer(&answer("low", &"a".repeat(MAX_EXPLANATION_BYTES + 1))), Err(Refusal::ExplanationTooLong));
    assert_eq!(parse_answer(&answer("low", "")), Err(Refusal::ExplanationEmpty));
    let padded = format!("{}{}", answer("low", "Fine."), " ".repeat(MAX_ANSWER_BYTES));
    assert_eq!(parse_answer(&padded), Err(Refusal::AnswerTooLong));
}

fn chat(model: &str, finish: &str, content: serde_json::Value, choices: usize) -> Vec<u8> {
    let choice = serde_json::json!({ "index": 0, "finish_reason": finish, "message": { "role": "assistant", "content": content } });
    serde_json::json!({
        "id": "chatcmpl-1", "object": "chat.completion", "created": 1, "model": model,
        "choices": vec![choice; choices],
        "usage": { "prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30 },
    })
    .to_string()
    .into_bytes()
}

#[test]
fn the_chat_response_must_be_one_finished_answer() {
    let good = serde_json::Value::String(answer("medium", "Pays an account never paid before."));
    assert_eq!(parse_chat_response(&chat(MODEL_ID, "stop", good.clone(), 1)).unwrap().risk, AiRisk::Medium);
    assert!(parse_chat_response(&chat("zai-org/GLM-5.1-FP8", "stop", good.clone(), 1)).is_ok(), "which model answered is a C11 check");
    assert_eq!(parse_chat_response(&chat(MODEL_ID, "length", good.clone(), 1)), Err(Refusal::NotOneFinishedChoice));
    assert_eq!(parse_chat_response(&chat(MODEL_ID, "stop", good.clone(), 2)), Err(Refusal::NotOneFinishedChoice));
    assert_eq!(parse_chat_response(&chat(MODEL_ID, "stop", good, 0)), Err(Refusal::NotOneFinishedChoice));
    let parts = serde_json::json!([{ "type": "text", "text": answer("low", "Fine.") }]);
    assert_eq!(parse_chat_response(&chat(MODEL_ID, "stop", parts, 1)), Err(Refusal::AnswerNotTheSchema));
    assert_eq!(parse_chat_response(&chat(MODEL_ID, "stop", serde_json::Value::Null, 1)), Err(Refusal::AnswerNotTheSchema));
    assert_eq!(parse_chat_response(br#"{"error":{"message":"no"}}"#), Err(Refusal::ResponseUnreadable));
}

#[test]
fn a_cut_off_completion_is_still_read_for_its_token_counts() {
    let mut body: serde_json::Value = serde_json::from_slice(&chat(MODEL_ID, "length", serde_json::json!("{\"risk\""), 1)).unwrap();
    body["usage"]["completion_tokens_details"] = serde_json::json!({ "reasoning_tokens": 256 });
    let c = read_completion(body.to_string().as_bytes()).unwrap();
    assert_eq!((c.id.as_str(), c.object.as_str(), c.finish_reason.as_deref()), ("chatcmpl-1", "chat.completion", Some("length")));
    assert_eq!((c.usage.prompt_tokens, c.usage.completion_tokens, c.usage.reasoning_tokens), (Some(10), Some(20), Some(256)));
    assert_eq!(c.content.as_deref(), Some("{\"risk\""));
    assert_eq!(answer_of(&c), Err(Refusal::NotOneFinishedChoice));
}

#[test]
fn the_request_is_non_streamed_canonical_and_holds_only_the_fixed_prompt_and_the_facts() {
    let body: serde_json::Value = serde_json::from_slice(&chat_request_body(MODEL_ID, "FACTS", Audience::Public)).unwrap();
    assert_eq!(body["model"], MODEL_ID);
    assert_eq!(body["stream"], false);
    assert_eq!(body["messages"].as_array().unwrap().len(), 2);
    assert_eq!(body["messages"][0]["content"], kaap_sealed::prompt::SYSTEM_PROMPT);
    assert_eq!(body["messages"][1]["content"], "FACTS");
    assert_eq!(body["thinking_token_budget"], THINKING_TOKEN_BUDGET);
    assert_eq!(body["max_tokens"], THINKING_TOKEN_BUDGET + MAX_ANSWER_TOKENS);
    assert!(body.get("chat_template_kwargs").is_none(), "enable_thinking false moves GLM 5.3 Flash's reasoning into content");
    assert_eq!(MODEL_ID_QUERY, MODEL_ID.replace('/', "%2F"));
}

#[test]
fn only_a_members_prompt_names_the_members_limit() {
    let system = |audience| {
        let body: serde_json::Value = serde_json::from_slice(&chat_request_body(MODEL_ID, "FACTS", audience)).unwrap();
        body["messages"][0]["content"].as_str().unwrap().to_string()
    };
    let limit = format!("at most {MAX_MEMBER_EXPLANATION_BYTES} characters");
    assert_eq!(system(Audience::Public), kaap_sealed::prompt::SYSTEM_PROMPT, "a public prompt is the fixed text alone");
    assert!(system(Audience::Members).starts_with(kaap_sealed::prompt::SYSTEM_PROMPT));
    assert!(system(Audience::Members).contains(&limit));
    assert!(!kaap_sealed::prompt::SYSTEM_PROMPT.contains(&limit));
}

const LIVE_LIST: &str = include_str!("fixtures/model-list-2026-10-29.json");

#[test]
fn only_the_pinned_sealed_model_passes_the_catalog_check() {
    assert_eq!(check_model(LIVE_LIST.as_bytes(), MODEL_ID), Ok(()), "GLM 5.3 Flash on 29 Oct 2026");
    for (model, why) in [
        ("z-ai/glm-5.3", Refusal::ModelNotSealed),
        ("deepseek/deepseek-v3.2", Refusal::ModelNotSealed),
        ("openai/gpt-5", Refusal::ModelNotSealed),
        ("glm-5.3-flash", Refusal::ModelNotListed),
        ("zai-org/GLM-5.1-FP8", Refusal::ModelNotListed),
    ] {
        assert_eq!(check_model(LIVE_LIST.as_bytes(), model), Err(why), "{model}: tinfoil, chutes, external and aliases all fail");
    }
    let mut list: serde_json::Value = serde_json::from_str(LIVE_LIST).unwrap();
    for field in ["providerType", "ownedBy", "attestationSupported", "verifiable", "isReady"] {
        let mut changed = list.clone();
        let e = changed["models"].as_array_mut().unwrap().iter_mut().find(|m| m["modelId"] == MODEL_ID).unwrap();
        e["metadata"].as_object_mut().unwrap().remove(field);
        assert_eq!(check_model(changed.to_string().as_bytes(), MODEL_ID), Err(Refusal::ModelNotSealed), "{field} missing");
    }
    let entry = list["models"].as_array_mut().unwrap().iter_mut().find(|m| m["modelId"] == MODEL_ID).unwrap();
    entry["metadata"]["attestationSupported"] = serde_json::json!(false);
    assert_eq!(check_model(list.to_string().as_bytes(), MODEL_ID), Err(Refusal::ModelNotSealed));
    let twice = LIVE_LIST.replace("\"models\": [", &format!("\"models\": [{{\"modelId\":\"{MODEL_ID}\",\"metadata\":null}},"));
    assert_eq!(check_model(twice.as_bytes(), MODEL_ID), Err(Refusal::ModelNotListed), "two entries for one id is not an answer");
    assert_eq!(check_model(b"<html>", MODEL_ID), Err(Refusal::CatalogUnreadable));
    let aliases = aliases_of(LIVE_LIST.as_bytes(), MODEL_ID);
    assert_eq!(aliases.len(), 14);
    assert!(aliases.iter().any(|a| a == "zai-org/GLM-5.1-FP8") && !aliases.iter().any(|a| a == MODEL_ID));
    assert!(aliases_of(b"<html>", MODEL_ID).is_empty());
}
