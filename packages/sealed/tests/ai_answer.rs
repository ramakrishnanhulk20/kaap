//! Parsing NEAR AI's catalog entry and answer as untrusted input (C10, C12): forgiving in form,
//! never in substance. Not covered here: the HTTP call itself (`ai_call.rs` runs it against
//! recorded answers), a live answer (the first keyed testnet run gives one), and the "AI verified"
//! checks (`attest_*.rs`).

use kaap_sealed::ai::*;

fn answer(risk: &str, explanation: &str) -> String {
    serde_json::json!({ "risk": risk, "explanation": explanation }).to_string()
}

/// The explanation `parse_answer` keeps from `explanation`, or why it refused.
fn read(explanation: &str) -> Result<String, Refusal> {
    parse_answer(&answer("low", explanation)).map(|a| a.explanation)
}

#[test]
fn a_well_formed_answer_is_accepted_as_it_is() {
    let a = parse_answer(&answer("high", "The kind pays a1ice.testnet while the text names alice.testnet.")).unwrap();
    assert_eq!(a.risk, AiRisk::High);
    assert_eq!(a.explanation, "The kind pays a1ice.testnet while the text names alice.testnet.");
    assert!(!a.cleaned);
    for (word, risk) in [("low", AiRisk::Low), ("medium", AiRisk::Medium), ("critical", AiRisk::Critical)] {
        assert_eq!(parse_answer(&answer(word, "Fine.")).unwrap().risk, risk);
    }
    let spaced = parse_answer(&format!("  {}\n", answer("low", "Fine."))).unwrap();
    assert!(!spaced.cleaned, "whitespace around the object is not a second reading");
}

#[test]
fn a_fenced_answer_is_read() {
    let object = answer("medium", "Pays an account never paid before.");
    for fenced in [format!("```json\n{object}\n```"), format!("```\n{object}\n```"), format!("\n ```json\r\n  {object}  \r\n```\n")] {
        let a = parse_answer(&fenced).unwrap_or_else(|why| panic!("{why:?}: {fenced:?}"));
        assert_eq!((a.risk, a.explanation.as_str(), a.cleaned), (AiRisk::Medium, "Pays an account never paid before.", true), "{fenced:?}");
    }
}

#[test]
fn text_around_the_object_is_refused() {
    let object = answer("low", "Fine.");
    for bad in [
        format!("Here it is: {object}"),
        format!("{object} Hope this helps."),
        format!("Sure.\n```json\n{object}\n```"),
        format!("```json\n{object}\n```\nDone."),
        format!("```{object}```"),
        format!("```json\n{object}```"),
        format!("```JSON\n{object}\n```"),
        format!("```json\n```json\n{object}\n```\n```"),
        format!("{object} {}", answer("critical", "x")),
    ] {
        assert_eq!(parse_answer(&bad), Err(Refusal::AnswerNotJson), "{bad:?}");
    }
}

#[test]
fn each_wrong_shape_gives_its_word() {
    for bad in ["low", "", "   ", "I think this is risky.", "{risk: low}", "{\"risk\":\"low\",}"] {
        assert_eq!(parse_answer(bad), Err(Refusal::AnswerNotJson), "{bad:?}");
    }
    for bad in [
        r#"{"risk":"low"}"#,
        r#"{"explanation":"Fine."}"#,
        r#"{"risk":"low","explanation":"Fine.","confidence":0.9}"#,
        r#"{"risk":"low","explanation":"Fine.","risk":"critical"}"#,
        r#"{"risk":1,"explanation":"Fine."}"#,
        r#"{"risk":"low","explanation":["Fine."]}"#,
        r#"{"risk":"low","explanation":null}"#,
        r#"[{"risk":"low","explanation":"Fine."}]"#,
        r#"["critical","Fine."]"#,
        r#""low""#,
        "null",
        "{}",
    ] {
        assert_eq!(parse_answer(bad), Err(Refusal::AnswerWrongFields), "{bad:?}");
    }
    let words = [Refusal::AnswerNotJson.code(), Refusal::AnswerWrongFields.code(), Refusal::ExplanationHasLink.code()];
    assert_eq!(words, ["answer_not_json", "answer_wrong_fields", "explanation_has_link"]);
    for word in words {
        assert!(word.len() <= 22 && word.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'), "{word}");
    }
}

#[test]
fn unknown_risk_words_are_refused_never_repaired() {
    for word in ["Low", "HIGH", "severe", "none", "unknown", "low ", " low", "", "medium-high", "\u{201c}low\u{201d}"] {
        assert_eq!(parse_answer(&answer(word, "Fine.")), Err(Refusal::UnknownRiskWord), "{word:?}");
    }
}

#[test]
fn curly_quotes_dashes_an_ellipsis_a_line_break_and_a_tab_are_mapped() {
    let typed = "It\u{2019}s \u{201c}routine\u{201d}, says \u{2018}ops\u{2019}\u{2014}pays 5\u{2013}6 NEAR, net \u{2212}3\u{2026}\nnext\tline\r\nend\u{a0}here";
    assert_eq!(read(typed).as_deref(), Ok("It's \"routine\", says 'ops'-pays 5-6 NEAR, net -3... next line end here"));
}

#[test]
fn a_bracket_an_asterisk_and_an_at_sign_become_spaces_and_a_non_ascii_letter_a_question_mark() {
    for (typed, kept) in [
        ("Bracket [x] here", "Bracket x here"),
        ("An *asterisk* here", "An asterisk here"),
        ("Mail a@b.example", "Mail a b.example"),
        ("<b>bold</b> `code` {x} | ~y~ ^ back\\slash", "b bold /b code x y back slash"),
        ("Caf\u{e9} owner", "Caf? owner"),
        ("Cyrillic \u{430}lice.testnet", "Cyrillic ?lice.testnet"),
        ("zero\u{200b}width \u{202e}reversed", "zero?width ?reversed"),
        ("\u{2603}\u{1f600}\u{430}\u{200b}", "????"),
        ("snow\u{2603}\u{2603} man\u{2003}x:\u{e9}", "snow?? man?x: ?"),
    ] {
        assert_eq!(read(typed).as_deref(), Ok(kept), "{typed:?}");
    }
}

#[test]
fn a_colon_followed_by_a_non_space_gets_a_space() {
    for (typed, kept) in [
        ("transfer:VoteApprove", "transfer: VoteApprove"),
        ("Click javascript:alert(1)", "Click javascript: alert(1)"),
        ("See http:/evil for details.", "See http: /evil for details."),
        ("a::b", "a: : b"),
        ("Ends with a colon:", "Ends with a colon:"),
        ("Risk: high.", "Risk: high."),
    ] {
        assert_eq!(read(typed).as_deref(), Ok(kept), "{typed:?}");
    }
}

#[test]
fn a_link_is_refused_before_anything_is_dropped() {
    for bad in ["https://x.y", "HTTP://X", "www.x.y", "See WwW.example now.", "Go to www\u{2026}", "h\u{200b}ttps://x", "data:text/html,a://b"] {
        assert_eq!(read(bad), Err(Refusal::ExplanationHasLink), "{bad:?}");
    }
}

#[test]
fn a_long_explanation_is_cut_at_a_word_never_refused() {
    let long = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima ".repeat(8)[..400].to_string();
    let a = parse_answer(&answer("high", &long)).unwrap();
    assert!(a.explanation.len() <= MAX_EXPLANATION_BYTES && a.explanation.len() > MAX_EXPLANATION_BYTES - 12, "{}", a.explanation.len());
    assert!(long.starts_with(&a.explanation) && long[a.explanation.len()..].starts_with(' '), "{:?}", a.explanation);
    assert!(a.cleaned);
    let whole = long[..MAX_EXPLANATION_BYTES].trim_end().to_string();
    assert_eq!(read(&whole).as_deref(), Ok(whole.as_str()), "at the limit nothing is cut");
    let padded = format!("{}{}", answer("low", "Fine."), " ".repeat(MAX_ANSWER_BYTES));
    assert_eq!(parse_answer(&padded), Err(Refusal::AnswerTooLong));
}

#[test]
fn an_explanation_with_nothing_left_after_cleaning_is_refused_as_empty() {
    let one_long_word = "a".repeat(MAX_EXPLANATION_BYTES + 1);
    for bad in ["", "   ", "***@@@<>`|{}[]~^\\", "\n\t\r\u{a0}", "* \n @ \u{a0} `", &one_long_word] {
        assert_eq!(read(bad), Err(Refusal::ExplanationEmpty), "{bad:?}");
    }
}

#[test]
fn cleaned_is_false_only_for_an_answer_that_needed_nothing() {
    let cleaned = |content: &str| parse_answer(content).unwrap().cleaned;
    assert!(!cleaned(&answer("low", "Pays bob.testnet 5 NEAR: 2/3 votes; cost $5 & 3% fee.")));
    assert!(!cleaned(&format!("\n{}\n", answer("low", "Fine."))));
    assert!(cleaned(&format!("```json\n{}\n```", answer("low", "Fine."))));
    let long = "word ".repeat(70);
    for typed in ["It\u{2019}s fine.", "two  spaces", " leading", "trailing ", "line\nbreak", "x*y", "a:b", &long] {
        assert!(cleaned(&answer("low", typed)), "{typed:?}");
    }
}

/// SplitMix64, so the generated strings are the same on every run without a new dependency.
struct SplitMix(u64);

impl SplitMix {
    fn below(&mut self, n: usize) -> usize {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        ((z ^ (z >> 31)) % n as u64) as usize
    }
}

/// 500 strings from a fixed seed: one in four is 330 to 400 allowed characters, so it must be cut;
/// the rest mix allowed characters, refused ones (markup, controls, typographic and lookalike
/// letters, emoji) and, rarely, a piece of a link. A string too short to be cut must keep one `?`
/// for each `?` it had and each non-ASCII character that has no ASCII form.
#[test]
fn every_accepted_explanation_is_plain_text_within_the_limit() {
    let allowed: Vec<char> = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,;:'\"()-!?%/&+=$#_".chars().collect();
    let refused: Vec<char> =
        "*@<>`[]{}|\\~^\n\t\r\u{0}\u{7f}\u{a0}\u{2018}\u{2019}\u{201c}\u{201d}\u{2013}\u{2014}\u{2212}\u{2026}\u{200b}\u{202e}\u{e9}\u{430}\u{1f600}".chars().collect();
    let links = ["://", "www.", "WWW.", "http:", ":/"];
    let mut rng = SplitMix(0x6b61_6170_0005_000b);
    let mapped = ['\u{2018}', '\u{2019}', '\u{201c}', '\u{201d}', '\u{2013}', '\u{2014}', '\u{2212}', '\u{2026}', '\u{a0}'];
    let marks = |s: &str| s.chars().filter(|&c| c == '?' || (!c.is_ascii() && !mapped.contains(&c))).count();
    let (mut accepted, mut cut, mut traced, mut has_link, mut empty) = (0, 0, 0, 0, 0);
    for i in 0..500 {
        let long = i % 4 == 0;
        let picks = if long { 330 + rng.below(71) } else { rng.below(341) };
        let mut s = String::new();
        for _ in 0..picks {
            let roll = rng.below(1000);
            if long || roll < 700 {
                s.push(allowed[rng.below(allowed.len())]);
            } else if roll < 999 {
                s.push(refused[rng.below(refused.len())]);
            } else {
                s.push_str(links[rng.below(links.len())]);
            }
        }
        match parse_answer(&answer("low", &s)) {
            Ok(a) => {
                assert!(is_plain_text(&a.explanation), "{:?} from {s:?}", a.explanation);
                assert!(!a.explanation.is_empty() && a.explanation.len() <= MAX_EXPLANATION_BYTES, "{} bytes from {s:?}", a.explanation.len());
                assert_eq!(a.cleaned, a.explanation != s, "{s:?}");
                accepted += 1;
                cut += usize::from(long);
                // Cleaning at most triples a character (an ellipsis), so under a third of the limit is never cut.
                if s.chars().count() * 3 < MAX_EXPLANATION_BYTES {
                    assert_eq!(a.explanation.matches('?').count(), marks(&s), "{:?} from {s:?}", a.explanation);
                    traced += usize::from(marks(&s) > s.matches('?').count());
                }
            }
            Err(Refusal::ExplanationHasLink) => has_link += 1,
            Err(Refusal::ExplanationEmpty) => empty += 1,
            Err(other) => panic!("{other:?} from {s:?}: only a link or nothing left may refuse a cleaned explanation"),
        }
    }
    println!("accepted {accepted}, of them cut {cut}, traced {traced}, link {has_link}, empty {empty}");
    assert!(accepted >= 350 && cut >= 100 && traced >= 30 && has_link >= 10, "accepted {accepted}, cut {cut}, traced {traced}, link {has_link}, empty {empty}");
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
    assert_eq!(parse_chat_response(&chat(MODEL_ID, "stop", parts, 1)), Err(Refusal::AnswerNotJson));
    assert_eq!(parse_chat_response(&chat(MODEL_ID, "stop", serde_json::Value::Null, 1)), Err(Refusal::AnswerNotJson));
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
fn the_finish_reason_is_kept_only_as_a_short_word() {
    for kept in ["stop", "length", "tool_calls", "content_filter", "abcdefghijklmnop"] {
        assert_eq!(finish_word(kept), kept);
    }
    for other in ["", "abcdefghijklmnopq", "Stop", "stop ", "stop\n", "end-turn", "stop\u{202e}", "<b>stop</b>", &"z".repeat(32)] {
        assert_eq!(finish_word(other), "other", "{other:?}");
    }
    let read = |finish: &str| {
        let c = read_completion(&chat(MODEL_ID, finish, serde_json::json!("x"), 1)).unwrap();
        let record = kaap_sealed::attest::evidence::CompletionRecord::new(&c);
        (c.finish_reason, record.finish_reason)
    };
    assert_eq!(read("stop"), (Some("stop".to_string()), Some("stop".to_string())));
    let other = Some("other".to_string());
    assert_eq!(read(&"z".repeat(32)), (other.clone(), other.clone()), "what the evidence record stores too");
    assert_eq!(read("STOP"), (other.clone(), other));
}

#[test]
fn the_request_is_non_streamed_canonical_and_holds_only_the_fixed_prompt_and_the_facts() {
    let body: serde_json::Value = serde_json::from_slice(&chat_request_body(MODEL_ID, "FACTS", Audience::Public, THINKING_TOKEN_BUDGET)).unwrap();
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
        let body: serde_json::Value = serde_json::from_slice(&chat_request_body(MODEL_ID, "FACTS", audience, THINKING_TOKEN_BUDGET)).unwrap();
        body["messages"][0]["content"].as_str().unwrap().to_string()
    };
    let limit = format!("at most {MAX_MEMBER_EXPLANATION_BYTES} characters");
    assert_eq!(system(Audience::Public), kaap_sealed::prompt::SYSTEM_PROMPT, "a public prompt is the fixed text alone");
    assert!(system(Audience::Members).starts_with(kaap_sealed::prompt::SYSTEM_PROMPT));
    assert!(system(Audience::Members).contains(&limit));
    assert!(!kaap_sealed::prompt::SYSTEM_PROMPT.contains(&limit));
    let public = kaap_sealed::prompt::SYSTEM_PROMPT.split("of at most ").nth(1).and_then(|rest| rest.split(' ').next()).unwrap();
    assert_eq!(public, "200");
    assert!(system(Audience::Members).ends_with(&format!("that limit replaces the {public} above.")), "the members' prompt names the public limit it replaces");
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
