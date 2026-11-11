//! Everything the job prints. A refusal or a hold carries a fixed reason written in this crate
//! (the `&'static str` type makes any other text impossible) and never a signature.

use kaap_core::{AiStatus, Analysis, FindingCode, Severity};
use serde::Serialize;
use serde_json::Value;

use crate::ai::{finish_word, AiOutcome, Check};
use crate::attest::evidence::CompletionRecord;
use crate::payment::Refusal;
use crate::verdict::{combine_risk, severity_of, sha256};

/// The documented limit on what `request_execution` returns on chain. Testnet returned 2,000
/// bytes whole on 26 Oct; mainnet is unmeasured, so 900 stays the cap.
pub const MAX_OUTPUT_BYTES: usize = 900;

/// The largest token count an eval output prints; a larger one prints as null. A run sends at most
/// about 12,000 prompt tokens and asks for at most 1,424 completion tokens, so a larger count is not
/// a real one, and the eval script costs a null count at its worst case. Five digits are what keep
/// every eval output under `MAX_OUTPUT_BYTES`.
pub const MAX_PRINTED_TOKENS: u64 = 99_999;

#[derive(Serialize)]
struct Plain {
    v: u8,
    status: &'static str,
    reason: &'static str,
}

/// The input was not accepted. No outside call was made, except for `TEXT_DOES_NOT_MATCH`.
pub fn refused(reason: &'static str) -> String {
    plain("refused", reason)
}

/// Why a run is refused when its sealed text hashes to no payload of the proposal. Anyone can
/// encrypt a text to the job's key, so such a text proves nothing about the proposal and is never
/// judged. It is known only after the chain reads, so unlike the other refusals it comes after
/// them, but before the model is asked: no signature, no AI request, no evidence.
pub const TEXT_DOES_NOT_MATCH: &str = "text_does_not_match";

#[derive(Serialize)]
struct BelowPrice {
    v: u8,
    status: &'static str,
    reason: &'static str,
    detail: String,
}

/// The run's payment was refused. Like a refused input it is a normal answer, never a trap: a
/// trap's fate on OutLayer differs between its two doors, and this one reads the same on both. No
/// outside call was made.
pub fn below_price(why: Refusal) -> String {
    sorted_json(&BelowPrice { v: 1, status: "refused", reason: why.reason(), detail: why.sentence() })
        .unwrap_or_else(|_| refused(why.reason()))
}

/// A read failed or the two providers disagreed. No verdict, no signature (C22).
pub fn held(reason: &'static str) -> String {
    plain("held", reason)
}

/// The reads agreed but no signed verdict could be made (the signer, the expiry, or the size
/// cap). No signature.
pub fn failed(reason: &'static str) -> String {
    plain("failed", reason)
}

#[derive(Serialize)]
struct EvalScores<'a> {
    v: u8,
    status: &'static str,
    floor: Severity,
    risk: Severity,
    findings: Vec<FindingCode>,
    ai_status: AiStatus,
    ai_reason: Option<&'static str>,
    ai_risk: Option<Severity>,
    answer_cleaned: Option<bool>,
    model_id: Option<&'static str>,
    explanation_sha256: Option<String>,
    finish_reason: Option<&'a str>,
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
    reasoning_tokens: Option<u64>,
    thinking_budget: u32,
}

/// What an eval run prints: `{"v":1,"status":"eval",...}` with kaap-core's floor and findings, the
/// risk a verdict would carry (`verdict::combine_risk`, so an answer that is not verified raises it
/// to high at most), the AI's status, the code of why it is not verified or not used, the AI's own
/// risk, whether the reader had to clean the answer to accept it (`AiAnswer::cleaned`), the model
/// that answered, the hex sha256 of the model's explanation, the completion's finish reason
/// (`ai::finish_word`, applied again here) and token counts up to `MAX_PRINTED_TOKENS`, and
/// the reasoning budget the run asked for. Every key is always present, null when it does not apply.
/// Never a signature, verdict bytes, a public key or the explanation itself: the scores carry no
/// mark of Kaap's verdict key, and the text stays out of the chain. Fails when the line would pass
/// `MAX_OUTPUT_BYTES`, which those two limits leave unreachable: every finding at once, the longest
/// reason, a 16-letter finish reason, five-digit counts and the largest budget come to 899 bytes.
pub fn eval_scores(
    analysis: &Analysis,
    ai: &AiOutcome,
    completion: Option<&CompletionRecord>,
    thinking_budget: u32,
) -> Result<String, &'static str> {
    let (ai_status, ai_reason, answer, model_id) = match ai {
        AiOutcome::Answered { answer, model_id, check: Check::Verified { .. } } => (AiStatus::Verified, None, Some(answer), Some(*model_id)),
        AiOutcome::Answered { answer, model_id, check: Check::Unverified(why) } => (AiStatus::Unverified, Some(why.code()), Some(answer), Some(*model_id)),
        AiOutcome::Unavailable(why) => (AiStatus::Unavailable, Some(why.code()), None, None),
    };
    let floor = analysis.risk_floor;
    let scores = EvalScores {
        v: 1,
        status: "eval",
        floor,
        risk: combine_risk(floor, answer.map(|a| (a.risk, ai_status))),
        findings: analysis.findings.iter().map(|f| f.code).collect(),
        ai_status,
        ai_reason,
        ai_risk: answer.map(|a| severity_of(a.risk)),
        answer_cleaned: answer.map(|a| a.cleaned),
        model_id,
        explanation_sha256: answer.map(|a| hex::encode(sha256(a.explanation.as_bytes()))),
        finish_reason: completion.and_then(|c| c.finish_reason.as_deref()).map(finish_word),
        prompt_tokens: printed(completion.and_then(|c| c.prompt_tokens)),
        completion_tokens: printed(completion.and_then(|c| c.completion_tokens)),
        reasoning_tokens: printed(completion.and_then(|c| c.reasoning_tokens)),
        thinking_budget,
    };
    let out = sorted_json(&scores).map_err(|_| "the output could not be written")?;
    if out.len() > MAX_OUTPUT_BYTES {
        return Err("the eval output does not fit in 900 bytes");
    }
    Ok(out)
}

fn printed(tokens: Option<u64>) -> Option<u64> {
    tokens.filter(|&n| n <= MAX_PRINTED_TOKENS)
}

fn plain(status: &'static str, reason: &'static str) -> String {
    sorted_json(&Plain { v: 1, status, reason })
        .unwrap_or_else(|_| String::from(r#"{"reason":"output could not be written","status":"refused","v":1}"#))
}

/// `value` as one line of JSON with every object's keys in order. Everything this job prints or
/// stores goes through here: dcap-qvl turns on serde_json's `preserve_order` for every crate built
/// with this one, so without the sort the job and the CLI would show one object in two orders
/// (decided 2 Nov 2026).
pub fn sorted_json(value: &impl Serialize) -> Result<String, serde_json::Error> {
    let mut value: Value = serde_json::to_value(value)?;
    value.sort_all_objects();
    Ok(value.to_string())
}
