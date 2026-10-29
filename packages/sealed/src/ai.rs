//! NEAR AI's opinion, parsed as an untrusted input (C10, C12).
//!
//! The model is asked only when the catalog says it runs in NEAR AI's own sealed hardware with
//! attestation support, under its canonical id and with aliasing off. Its answer must be exactly
//! `{"risk":...,"explanation":...}` with a known risk word and a short plain-text explanation;
//! anything else makes the AI unavailable and the plain-code verdict stands.

use serde::Deserialize;

use crate::net::{Deadline, Http, HttpFail, Limits, Method, Request, NEAR_AI_CHAT, NEAR_AI_MODEL_LIST};

/// The model Kaap asks: GLM 5.3 Flash, listed by NEAR AI as a Private TEE model (NEAR AI's own
/// hardware) on near.ai/pricing and as `providerType` vllm, `ownedBy` nearai, attestation
/// supported, in `GET /v1/model/list`, both read on 29 Oct 2026.
pub const MODEL_ID: &str = "z-ai/glm-5.3-flash";

/// What the catalog must say about `MODEL_ID` on the day of the run. `vllm` with owner `nearai`
/// is how the list marks NEAR AI's own sealed hardware; partner enclaves are `chutes` or
/// `tinfoil` with owner `attested 3p`, and models outside any enclave are `external`.
pub const PROVIDER_TYPE: &str = "vllm";
pub const OWNER: &str = "nearai";

pub const MAX_EXPLANATION_BYTES: usize = 280;
/// The model's whole message. A valid answer is under 400 bytes.
pub const MAX_ANSWER_BYTES: usize = 2_048;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum AiRisk {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AiAnswer {
    pub risk: AiRisk,
    pub explanation: String,
}

/// Why an answer, a catalog entry or a call was not used. Fixed words only, for the same reason
/// as every other reason in this crate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    NoKey,
    KeyNotAHeaderValue,
    FactsTooLarge,
    CatalogUnreadable,
    ModelNotListed,
    ModelNotSealed,
    CallFailed,
    ResponseUnreadable,
    OtherModelAnswered,
    NotOneFinishedChoice,
    AnswerTooLong,
    AnswerNotTheSchema,
    UnknownRiskWord,
    ExplanationEmpty,
    ExplanationTooLong,
    ExplanationNotPlainText,
    Deadline,
}

impl Refusal {
    /// The explanation a verdict carries when the AI was not used, so the output says why.
    pub fn note(self) -> &'static str {
        use Refusal::*;
        match self {
            NoKey => "AI unavailable: no NEAR AI key is set for this project yet.",
            KeyNotAHeaderValue => "AI unavailable: the NEAR AI key is not usable.",
            FactsTooLarge => "AI unavailable: the facts are too large to send.",
            CatalogUnreadable => "AI unavailable: the NEAR AI model list could not be read.",
            ModelNotListed => "AI unavailable: the pinned model is not in the NEAR AI model list.",
            ModelNotSealed => "AI unavailable: the model list no longer marks the pinned model as sealed with attestation.",
            CallFailed => "AI unavailable: the request to NEAR AI failed.",
            ResponseUnreadable => "AI unavailable: the NEAR AI response could not be read.",
            OtherModelAnswered => "AI unavailable: another model answered.",
            NotOneFinishedChoice => "AI unavailable: the answer was cut off or not a single choice.",
            AnswerTooLong => "AI unavailable: the answer was too long.",
            AnswerNotTheSchema => "AI unavailable: the answer was not the required JSON.",
            UnknownRiskWord => "AI unavailable: the answer used an unknown risk word.",
            ExplanationEmpty => "AI unavailable: the answer had no explanation.",
            ExplanationTooLong => "AI unavailable: the explanation was over 280 bytes.",
            ExplanationNotPlainText => "AI unavailable: the explanation was not plain text.",
            Deadline => "AI unavailable: NEAR AI did not answer in time.",
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawAnswer {
    risk: String,
    explanation: String,
}

/// Parses the model's message content into an answer.
///
/// Refuses: content over `MAX_ANSWER_BYTES`; anything but one JSON object with exactly the keys
/// `risk` and `explanation` as strings (a code fence, extra or duplicate keys, other types); a
/// risk other than `low`, `medium`, `high` or `critical` exactly; an empty explanation, one over
/// `MAX_EXPLANATION_BYTES`, or one `is_plain_text` refuses.
pub fn parse_answer(content: &str) -> Result<AiAnswer, Refusal> {
    if content.len() > MAX_ANSWER_BYTES {
        return Err(Refusal::AnswerTooLong);
    }
    let raw: RawAnswer = serde_json::from_str(content).map_err(|_| Refusal::AnswerNotTheSchema)?;
    let risk = match raw.risk.as_str() {
        "low" => AiRisk::Low,
        "medium" => AiRisk::Medium,
        "high" => AiRisk::High,
        "critical" => AiRisk::Critical,
        _ => return Err(Refusal::UnknownRiskWord),
    };
    if raw.explanation.is_empty() {
        return Err(Refusal::ExplanationEmpty);
    }
    if raw.explanation.len() > MAX_EXPLANATION_BYTES {
        return Err(Refusal::ExplanationTooLong);
    }
    if !is_plain_text(&raw.explanation) {
        return Err(Refusal::ExplanationNotPlainText);
    }
    Ok(AiAnswer { risk, explanation: raw.explanation })
}

/// True when `text` is plain prose that a web page, a Telegram message or an email can show as
/// it is: only ASCII letters, digits, spaces and the punctuation `. , ; : ' " ( ) - ! ? % / & + = $ # _`.
///
/// The character set is a list of what is allowed, so a character nobody thought of is refused
/// rather than passed (standard 4). It rules out every HTML or Markdown control character, line
/// breaks and all other control characters, invisible and direction-changing Unicode, lookalike
/// letters from other scripts, and `@` (mail addresses). Links are refused as `://`, as `www.`,
/// and as any colon followed by something other than a space, which is how every URI scheme
/// (`http:`, `mailto:`, `javascript:`, `data:`) is written. Not covered: a bare domain such as
/// `example.com`, which would also forbid every NEAR account id the model might name, so whoever
/// shows the text must not turn it into a link (C24).
pub fn is_plain_text(text: &str) -> bool {
    const PUNCTUATION: &[u8] = b".,;:'\"()-!?%/&+=$#_";
    let bytes = text.as_bytes();
    let allowed = bytes.iter().all(|&b| b.is_ascii_alphanumeric() || b == b' ' || PUNCTUATION.contains(&b));
    let lower = text.to_ascii_lowercase();
    let scheme = bytes.windows(2).any(|w| w[0] == b':' && w[1] != b' ');
    allowed && !lower.contains("www.") && !lower.contains("://") && !scheme
}

#[derive(Deserialize)]
struct ModelList {
    models: Vec<CatalogEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogEntry {
    model_id: String,
    metadata: Option<CatalogMetadata>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogMetadata {
    provider_type: Option<String>,
    owned_by: Option<String>,
    attestation_supported: Option<bool>,
    verifiable: Option<bool>,
    is_ready: Option<bool>,
}

/// Checks `GET /v1/model/list` for the pinned model before any prompt leaves the job (C12).
///
/// Passes only when exactly one entry has `model_id` as its own id (an alias does not count) and
/// that entry says: provider `vllm`, owner `nearai`, attestation supported, verifiable and ready.
/// A missing field counts as no.
pub fn check_model(list_body: &[u8], model_id: &str) -> Result<(), Refusal> {
    let list: ModelList = serde_json::from_slice(list_body).map_err(|_| Refusal::CatalogUnreadable)?;
    let mut entries = list.models.iter().filter(|m| m.model_id == model_id);
    let (Some(entry), None) = (entries.next(), entries.next()) else {
        return Err(Refusal::ModelNotListed);
    };
    let sealed = entry.metadata.as_ref().is_some_and(|m| {
        m.provider_type.as_deref() == Some(PROVIDER_TYPE)
            && m.owned_by.as_deref() == Some(OWNER)
            && m.attestation_supported == Some(true)
            && m.verifiable == Some(true)
            && m.is_ready == Some(true)
    });
    if sealed {
        Ok(())
    } else {
        Err(Refusal::ModelNotSealed)
    }
}

/// The largest answer the model may write, in tokens. A valid answer is about 100.
pub const MAX_ANSWER_TOKENS: u32 = 400;

/// The one chat request: non-streamed (a streamed answer is signed by the gateway, not the
/// model), temperature 0, reasoning off so the whole token budget goes to the answer, JSON mode.
pub fn chat_request_body(model_id: &str, user_message: &str) -> Vec<u8> {
    serde_json::json!({
        "model": model_id,
        "messages": [
            { "role": "system", "content": crate::prompt::SYSTEM_PROMPT },
            { "role": "user", "content": user_message },
        ],
        "stream": false,
        "temperature": 0,
        "max_tokens": MAX_ANSWER_TOKENS,
        "response_format": { "type": "json_object" },
        "chat_template_kwargs": { "enable_thinking": false },
    })
    .to_string()
    .into_bytes()
}

#[derive(Deserialize)]
struct ChatResponse {
    model: String,
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatMessage,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct ChatMessage {
    role: String,
    content: Option<serde_json::Value>,
}

/// Parses a non-streamed chat completion into the model's answer.
///
/// Refuses a body that is not the documented response shape, a `model` other than the one asked
/// for (an alias or a fallback answered), anything but exactly one choice that finished with
/// `stop` from the `assistant` role, content that is not a single string, and any answer
/// `parse_answer` refuses.
pub fn parse_chat_response(body: &[u8], model_id: &str) -> Result<AiAnswer, Refusal> {
    let response: ChatResponse = serde_json::from_slice(body).map_err(|_| Refusal::ResponseUnreadable)?;
    if response.model != model_id {
        return Err(Refusal::OtherModelAnswered);
    }
    let [choice] = response.choices.as_slice() else {
        return Err(Refusal::NotOneFinishedChoice);
    };
    if choice.finish_reason.as_deref() != Some("stop") || choice.message.role != "assistant" {
        return Err(Refusal::NotOneFinishedChoice);
    }
    match &choice.message.content {
        Some(serde_json::Value::String(content)) => parse_answer(content),
        _ => Err(Refusal::AnswerNotTheSchema),
    }
}

/// The public catalog is about 76 KB today.
pub const MODEL_LIST_LIMITS: Limits = Limits {
    connect_ms: 5_000,
    first_byte_ms: 10_000,
    between_bytes_ms: 5_000,
    overall_ms: 10_000,
    max_body_bytes: 512 * 1024,
};

/// A model can take several seconds before its first byte; the answer itself is a few KB.
pub const CHAT_LIMITS: Limits = Limits {
    connect_ms: 5_000,
    first_byte_ms: 25_000,
    between_bytes_ms: 10_000,
    overall_ms: 30_000,
    max_body_bytes: 64 * 1024,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AiOutcome {
    /// The model answered and the answer passed every check. Not yet "verified": the signature
    /// and attestation checks are WO-05.
    Answered { answer: AiAnswer, model_id: &'static str },
    Unavailable(Refusal),
}

/// Asks the pinned model once, or says why not.
///
/// `key` is the NEAR AI key from the OutLayer secret; it goes only into the `authorization`
/// header of the chat request, never to the catalog request and never into any output. No key,
/// a key that is not a plain header value, facts that did not fit (`None`), a catalog that does
/// not mark the model as sealed, a failed or late call, and any refused answer each give
/// `Unavailable` with the reason. Each request runs under its own limits, cut to `deadline`.
pub fn consult(http: &mut dyn Http, key: Option<&str>, facts: Option<&str>, deadline: Deadline) -> AiOutcome {
    match ask(http, key, facts, deadline) {
        Ok(answer) => AiOutcome::Answered { answer, model_id: MODEL_ID },
        Err(why) => AiOutcome::Unavailable(why),
    }
}

fn ask(http: &mut dyn Http, key: Option<&str>, facts: Option<&str>, deadline: Deadline) -> Result<AiAnswer, Refusal> {
    let key = key.filter(|k| !k.is_empty()).ok_or(Refusal::NoKey)?;
    if !key.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(Refusal::KeyNotAHeaderValue);
    }
    let facts = facts.ok_or(Refusal::FactsTooLarge)?;
    let late = |fail: HttpFail| if fail == HttpFail::Timeout { Refusal::Deadline } else { Refusal::CallFailed };

    if deadline.passed() {
        return Err(Refusal::Deadline);
    }
    let list = http
        .send(&Request {
            method: Method::Get,
            endpoint: NEAR_AI_MODEL_LIST,
            headers: &[("accept", "application/json")],
            body: None,
            limits: MODEL_LIST_LIMITS.within(deadline),
        })
        .map_err(late)?;
    if list.status != 200 {
        return Err(Refusal::CatalogUnreadable);
    }
    check_model(&list.body, MODEL_ID)?;

    if deadline.passed() {
        return Err(Refusal::Deadline);
    }
    let authorization = format!("Bearer {key}");
    let body = chat_request_body(MODEL_ID, facts);
    let chat = http
        .send(&Request {
            method: Method::Post,
            endpoint: NEAR_AI_CHAT,
            headers: &[
                ("authorization", authorization.as_str()),
                ("content-type", "application/json"),
                ("accept", "application/json"),
                ("x-no-aliasing", "true"),
            ],
            body: Some(&body),
            limits: CHAT_LIMITS.within(deadline),
        })
        .map_err(late)?;
    if chat.status != 200 {
        return Err(Refusal::CallFailed);
    }
    parse_chat_response(&chat.body, MODEL_ID)
}
