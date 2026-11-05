//! NEAR AI's opinion, parsed as an untrusted input (C10, C12) and checked for "AI verified" (C11).
//!
//! The model is asked only when the catalog says it runs in NEAR AI's own sealed hardware with
//! attestation support, under its canonical id and with aliasing off. Its answer must be exactly
//! `{"risk":...,"explanation":...}` with a known risk word and a short plain-text explanation;
//! anything else makes the AI unavailable and the plain-code verdict stands. An answer that passes
//! is Verified only when every check in `attest` passes, and Unverified otherwise.

use serde::Deserialize;

use crate::attest::{self, Evidence, Trust, Unverified, PREFLIGHT_BUDGET_MS};
use crate::net::{Deadline, Http, HttpFail, Limits, Method, Request, NEAR_AI_CHAT, NEAR_AI_MODEL_LIST};

/// The model Kaap asks: GLM 5.3 Flash, listed by NEAR AI as a Private TEE model (NEAR AI's own
/// hardware) on near.ai/pricing and as `providerType` vllm, `ownedBy` nearai, attestation
/// supported, in `GET /v1/model/list`, both read on 29 Oct 2026.
pub const MODEL_ID: &str = "z-ai/glm-5.3-flash";
/// `MODEL_ID` as a URL query value (`/` is `%2F`), written out so no encoder runs on it.
pub const MODEL_ID_QUERY: &str = "z-ai%2Fglm-5.3-flash";

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
    /// `NEAR_AI_API_KEY` was absent or empty. OutLayer starts a run whose secret row is missing
    /// without any error, so this note carries its code (`ai_key_missing`) in the signed
    /// explanation, where the worker reads it and raises a health signal instead of staying silent.
    AiKeyMissing,
    KeyNotAHeaderValue,
    FactsTooLarge,
    CatalogUnreadable,
    ModelNotListed,
    ModelNotSealed,
    CallFailed,
    ResponseUnreadable,
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
            AiKeyMissing => "AI unavailable (ai_key_missing): no NEAR AI key reached this run.",
            KeyNotAHeaderValue => "AI unavailable: the NEAR AI key is not usable.",
            FactsTooLarge => "AI unavailable: the facts are too large to send.",
            CatalogUnreadable => "AI unavailable: the NEAR AI model list could not be read.",
            ModelNotListed => "AI unavailable: the pinned model is not in the NEAR AI model list.",
            ModelNotSealed => "AI unavailable: the model list no longer marks the pinned model as sealed with attestation.",
            CallFailed => "AI unavailable: the request to NEAR AI failed.",
            ResponseUnreadable => "AI unavailable: the NEAR AI response could not be read.",
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

    /// The reason as the evidence record stores it.
    pub fn code(self) -> &'static str {
        use Refusal::*;
        match self {
            AiKeyMissing => "ai_key_missing",
            KeyNotAHeaderValue => "key_not_a_header_value",
            FactsTooLarge => "facts_too_large",
            CatalogUnreadable => "catalog_unreadable",
            ModelNotListed => "model_not_listed",
            ModelNotSealed => "model_not_sealed",
            CallFailed => "call_failed",
            ResponseUnreadable => "response_unreadable",
            NotOneFinishedChoice => "not_one_finished_choice",
            AnswerTooLong => "answer_too_long",
            AnswerNotTheSchema => "answer_not_the_schema",
            UnknownRiskWord => "unknown_risk_word",
            ExplanationEmpty => "explanation_empty",
            ExplanationTooLong => "explanation_too_long",
            ExplanationNotPlainText => "explanation_not_plain_text",
            Deadline => "deadline",
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
    aliases: Option<Vec<String>>,
}

/// The other names the catalog lists for `model_id` (its own entry's `aliases`), so an answer
/// that comes back under one of them can be told apart from another model's. An unreadable list
/// gives none.
pub fn aliases_of(list_body: &[u8], model_id: &str) -> Vec<String> {
    let Ok(list) = serde_json::from_slice::<ModelList>(list_body) else {
        return Vec::new();
    };
    list.models
        .into_iter()
        .filter(|m| m.model_id == model_id)
        .filter_map(|m| m.metadata.and_then(|d| d.aliases))
        .flatten()
        .collect()
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

/// GLM 5.3 Flash reasons before it answers. NEAR AI's docs (27 Oct 2026) say turning reasoning off
/// through `chat_template_kwargs` only moves it into `content`, which would break the exact-JSON
/// answer, so the reasoning is kept short with a budget instead.
pub const THINKING_TOKEN_BUDGET: u32 = 256;
/// The answer itself, about 100 tokens. Provisional: the first live run stores the real token
/// counts in its evidence (`completion`), and this is sized from them.
pub const MAX_ANSWER_TOKENS: u32 = 400;

/// The one chat request: non-streamed (a streamed answer is signed by the gateway, not the
/// model), temperature 0, reasoning capped at `THINKING_TOKEN_BUDGET`, room for the reasoning
/// plus `MAX_ANSWER_TOKENS`, JSON mode. These are the exact bytes sent and hashed.
pub fn chat_request_body(model_id: &str, user_message: &str) -> Vec<u8> {
    serde_json::json!({
        "model": model_id,
        "messages": [
            { "role": "system", "content": crate::prompt::SYSTEM_PROMPT },
            { "role": "user", "content": user_message },
        ],
        "stream": false,
        "temperature": 0,
        "max_tokens": THINKING_TOKEN_BUDGET + MAX_ANSWER_TOKENS,
        "thinking_token_budget": THINKING_TOKEN_BUDGET,
        "response_format": { "type": "json_object" },
    })
    .to_string()
    .into_bytes()
}

#[derive(Deserialize)]
struct ChatResponse {
    id: String,
    object: String,
    model: String,
    choices: Vec<ChatChoice>,
    usage: Option<serde_json::Value>,
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

/// Token counts as the completion reported them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Usage {
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
}

/// A non-streamed completion, read but not yet judged.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Completion {
    pub id: String,
    pub object: String,
    pub model: String,
    pub finish_reason: Option<String>,
    /// The message text, when it was a single string.
    pub content: Option<String>,
    pub usage: Usage,
}

/// Reads a chat completion. Refuses a body that is not the documented response shape
/// (`ResponseUnreadable`) and anything but exactly one choice from the `assistant` role
/// (`NotOneFinishedChoice`). Which model answered and whether it streamed are judged by
/// `attest::bind_answer`, not here.
pub fn read_completion(body: &[u8]) -> Result<Completion, Refusal> {
    let response: ChatResponse = serde_json::from_slice(body).map_err(|_| Refusal::ResponseUnreadable)?;
    let [choice] = response.choices.as_slice() else {
        return Err(Refusal::NotOneFinishedChoice);
    };
    if choice.message.role != "assistant" {
        return Err(Refusal::NotOneFinishedChoice);
    }
    let usage = response.usage.unwrap_or_default();
    let count = |path: &[&str]| path.iter().try_fold(&usage, |v, k| v.get(k)).and_then(serde_json::Value::as_u64);
    Ok(Completion {
        id: response.id,
        object: response.object,
        model: response.model,
        finish_reason: choice.finish_reason.clone(),
        content: match &choice.message.content {
            Some(serde_json::Value::String(text)) => Some(text.clone()),
            _ => None,
        },
        usage: Usage {
            prompt_tokens: count(&["prompt_tokens"]),
            completion_tokens: count(&["completion_tokens"]),
            reasoning_tokens: count(&["completion_tokens_details", "reasoning_tokens"]).or(count(&["reasoning_tokens"])),
        },
    })
}

/// The answer in a completion: it finished with `stop` (`NotOneFinishedChoice` when cut off),
/// its content is a single string (`AnswerNotTheSchema`), and `parse_answer` accepts it.
pub fn answer_of(completion: &Completion) -> Result<AiAnswer, Refusal> {
    if completion.finish_reason.as_deref() != Some("stop") {
        return Err(Refusal::NotOneFinishedChoice);
    }
    parse_answer(completion.content.as_deref().ok_or(Refusal::AnswerNotTheSchema)?)
}

/// `read_completion` and `answer_of` together.
pub fn parse_chat_response(body: &[u8]) -> Result<AiAnswer, Refusal> {
    answer_of(&read_completion(body)?)
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

/// Whether an answer that passed C10 is also "AI verified" (C11).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Check {
    /// Every check passed. `tcb_status` is the Intel TCB level the model's quote reported.
    Verified { tcb_status: String },
    Unverified(Unverified),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AiOutcome {
    /// The model answered and the answer passed C10; `check` says whether it is verified.
    Answered { answer: AiAnswer, model_id: &'static str, check: Check },
    Unavailable(Refusal),
}

impl AiOutcome {
    /// The same outcome, no longer verified for `why`. Anything not Verified stays as it is.
    pub fn unverified(self, why: Unverified) -> AiOutcome {
        match self {
            AiOutcome::Answered { answer, model_id, check: Check::Verified { .. } } => {
                AiOutcome::Answered { answer, model_id, check: Check::Unverified(why) }
            }
            other => other,
        }
    }
}

/// Asks the pinned model once and checks the answer, or says why not; also returns what the
/// checks saw, for publication beside the verdict.
///
/// `key` is the NEAR AI key from the OutLayer secret; it goes only into the `authorization`
/// header of the keyed NEAR AI calls (the attestation report, the chat, the signature), never to
/// the catalog, Intel, NVIDIA or the public token, and never into any output. No key, a key that
/// is not a plain header value, facts that did not fit (`None`), a catalog that does not mark the
/// model as sealed, a failed or late call, and any refused answer each give `Unavailable` with the
/// reason. Before the question, `attest::preflight` checks the model's attestation; its failure
/// does not stop the question, it only means the answer cannot be Verified. Each request runs
/// under its own limits, cut to `deadline`; the preflight gets at most `PREFLIGHT_BUDGET_MS`.
pub fn consult(
    http: &mut dyn Http,
    key: Option<&str>,
    facts: Option<&str>,
    deadline: Deadline,
    trust: &Trust,
) -> (AiOutcome, Evidence) {
    let mut evidence = Evidence::new();
    let outcome = match ask(http, key, facts, deadline, trust, &mut evidence) {
        Ok((answer, check)) => AiOutcome::Answered { answer, model_id: MODEL_ID, check },
        Err(why) => AiOutcome::Unavailable(why),
    };
    (outcome, evidence)
}

fn ask(
    http: &mut dyn Http,
    key: Option<&str>,
    facts: Option<&str>,
    deadline: Deadline,
    trust: &Trust,
    evidence: &mut Evidence,
) -> Result<(AiAnswer, Check), Refusal> {
    let key = key.filter(|k| !k.is_empty()).ok_or(Refusal::AiKeyMissing)?;
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
            tail: "",
            headers: &[("accept", "application/json")],
            body: None,
            keep_headers: &[],
            limits: MODEL_LIST_LIMITS.within(deadline),
        })
        .map_err(late)?;
    if list.status != 200 {
        return Err(Refusal::CatalogUnreadable);
    }
    check_model(&list.body, MODEL_ID)?;
    let aliases = aliases_of(&list.body, MODEL_ID);

    evidence.model_id = Some(MODEL_ID);
    evidence.nonce = trust.nonce.map(hex::encode);
    let verified = attest::preflight(http, key, trust, deadline.earlier(PREFLIGHT_BUDGET_MS), evidence);

    if deadline.passed() {
        return Err(Refusal::Deadline);
    }
    let authorization = format!("Bearer {key}");
    let body = chat_request_body(MODEL_ID, facts);
    let chat = http
        .send(&Request {
            method: Method::Post,
            endpoint: NEAR_AI_CHAT,
            tail: "",
            headers: &[
                ("authorization", authorization.as_str()),
                ("content-type", "application/json"),
                ("accept", "application/json"),
                ("accept-encoding", "identity"),
                ("x-no-aliasing", "true"),
            ],
            body: Some(&body),
            keep_headers: &["content-type"],
            limits: CHAT_LIMITS.within(deadline),
        })
        .map_err(late)?;
    if chat.status != 200 {
        return Err(Refusal::CallFailed);
    }
    let completion = read_completion(&chat.body)?;
    evidence.completion = Some(attest::evidence::CompletionRecord::new(&completion));
    let answer = answer_of(&completion)?;

    let pre = verified.as_ref().ok().map(Vec::as_slice);
    let bound = attest::bind_answer(http, key, pre, MODEL_ID, &aliases, &body, &chat, &completion, deadline, evidence);
    let check = match (verified, bound) {
        (Err(why), _) | (Ok(_), Err(why)) => Check::Unverified(why),
        (Ok(_), Ok(model)) => Check::Verified { tcb_status: model.tcb_status },
    };
    Ok((answer, check))
}
