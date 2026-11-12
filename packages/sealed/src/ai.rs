//! NEAR AI's opinion, parsed as an untrusted input (C10, C12) and checked for "AI verified" (C11).
//!
//! The model is asked only when the catalog says it runs in NEAR AI's own sealed hardware with
//! attestation support, under its canonical id and with aliasing off. Its answer must be exactly
//! `{"risk":...,"explanation":...}`, alone or inside one code fence, with a known risk word; the
//! explanation is cleaned in form (typographic characters, spacing, length) and must then be plain
//! text. Anything else makes the AI unavailable and the plain-code verdict stands. An answer that
//! passes is Verified only when every check in `attest` passes, and Unverified otherwise.

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

/// The longest public explanation a verdict keeps. The model is told 200 characters, so the cut at
/// a word that a longer one gets is rare.
pub const MAX_EXPLANATION_BYTES: usize = 280;
/// The limit the model is told when only a member reads its explanation, one fixed number so the
/// prompt stays one fixed text. Nothing is cut at it: the output's real room decides, run by run, in
/// `verdict::seal_encrypted`, and that room depends on the names and findings in the verdict.
pub const MAX_MEMBER_EXPLANATION_BYTES: usize = 120;
/// The model's whole message. A valid answer is under 400 bytes.
pub const MAX_ANSWER_BYTES: usize = 2_048;

/// Who may read what a prompt carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Audience {
    /// Public chain facts: a failed attestation only means the answer cannot be Verified.
    Public,
    /// A sealed text, or facts drawn from one, for an explanation only a member reads (C12). The
    /// prompt leaves the enclave only after the attestation checks passed.
    Members,
}

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
    /// True when the reader had to take the answer out of a code fence or change the explanation's
    /// text to accept it. Measured by eval runs only; it is not part of the verdict.
    pub cleaned: bool,
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
    /// The chat call's own wait ran out before the answer was whole, which tells a slow model from
    /// a call that failed.
    CallTimedOut,
    ResponseUnreadable,
    NotOneFinishedChoice,
    AnswerTooLong,
    /// The message, out of its code fence if it had one, is not one JSON value.
    AnswerNotJson,
    /// JSON, but not one object with exactly the string fields `risk` and `explanation`.
    AnswerWrongFields,
    UnknownRiskWord,
    ExplanationEmpty,
    ExplanationHasLink,
    /// Kept as the last gate after cleaning, which leaves nothing it refuses.
    ExplanationNotPlainText,
    Deadline,
    /// A prompt only members may read, and the checks before it did not pass (C12).
    SealedHardwareNotProven,
}

impl Refusal {
    pub const ALL: [Refusal; 19] = [
        Refusal::AiKeyMissing,
        Refusal::KeyNotAHeaderValue,
        Refusal::FactsTooLarge,
        Refusal::CatalogUnreadable,
        Refusal::ModelNotListed,
        Refusal::ModelNotSealed,
        Refusal::CallFailed,
        Refusal::CallTimedOut,
        Refusal::ResponseUnreadable,
        Refusal::NotOneFinishedChoice,
        Refusal::AnswerTooLong,
        Refusal::AnswerNotJson,
        Refusal::AnswerWrongFields,
        Refusal::UnknownRiskWord,
        Refusal::ExplanationEmpty,
        Refusal::ExplanationHasLink,
        Refusal::ExplanationNotPlainText,
        Refusal::Deadline,
        Refusal::SealedHardwareNotProven,
    ];

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
            CallTimedOut => "AI unavailable: the request to NEAR AI timed out.",
            ResponseUnreadable => "AI unavailable: the NEAR AI response could not be read.",
            NotOneFinishedChoice => "AI unavailable: the answer was cut off or not a single choice.",
            AnswerTooLong => "AI unavailable: the answer was too long.",
            AnswerNotJson => "AI unavailable: the answer was not JSON.",
            AnswerWrongFields => "AI unavailable: the answer was not exactly a risk and an explanation.",
            UnknownRiskWord => "AI unavailable: the answer used an unknown risk word.",
            ExplanationEmpty => "AI unavailable: the answer had no explanation.",
            ExplanationHasLink => "AI unavailable: the explanation held a link.",
            ExplanationNotPlainText => "AI unavailable: the explanation was not plain text.",
            Deadline => "AI unavailable: NEAR AI did not answer in time.",
            SealedHardwareNotProven => "AI unavailable: the model's sealed hardware was not proven, so the text was not sent.",
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
            CallTimedOut => "call_timed_out",
            ResponseUnreadable => "response_unreadable",
            NotOneFinishedChoice => "not_one_finished_choice",
            AnswerTooLong => "answer_too_long",
            AnswerNotJson => "answer_not_json",
            AnswerWrongFields => "answer_wrong_fields",
            UnknownRiskWord => "unknown_risk_word",
            ExplanationEmpty => "explanation_empty",
            ExplanationHasLink => "explanation_has_link",
            ExplanationNotPlainText => "explanation_not_plain_text",
            Deadline => "deadline",
            SealedHardwareNotProven => "sealed_hardware_not_proven",
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawAnswer {
    risk: String,
    explanation: String,
}

/// Parses the model's message content into an answer, forgiving in form and never in substance.
///
/// Refuses content over `MAX_ANSWER_BYTES` (`AnswerTooLong`). Whitespace around the content is
/// ignored, and so is one code fence around the whole of it (a first line of three backticks,
/// optionally followed by `json`, and a last line of three backticks); any other text before or
/// after the object stays. What is left must be one JSON value (`AnswerNotJson`), and that value
/// one object with exactly the string fields `risk` and `explanation`, nothing extra, missing or
/// repeated (`AnswerWrongFields`). The risk must be `low`, `medium`, `high` or `critical` exactly
/// (`UnknownRiskWord`): it is never guessed or repaired. The explanation is cleaned by
/// `clean_explanation` (`ExplanationHasLink` when it holds a link), cut at its last word boundary
/// within `MAX_EXPLANATION_BYTES`, refused when nothing is left (`ExplanationEmpty`), and must then
/// pass `is_plain_text` (`ExplanationNotPlainText`, which the cleaning leaves unreachable).
/// `cleaned` says whether the fence or the explanation's text had to change.
pub fn parse_answer(content: &str) -> Result<AiAnswer, Refusal> {
    if content.len() > MAX_ANSWER_BYTES {
        return Err(Refusal::AnswerTooLong);
    }
    let trimmed = content.trim();
    let fenced = unfenced(trimmed);
    let raw = read_fields(fenced.unwrap_or(trimmed))?;
    let risk = match raw.risk.as_str() {
        "low" => AiRisk::Low,
        "medium" => AiRisk::Medium,
        "high" => AiRisk::High,
        "critical" => AiRisk::Critical,
        _ => return Err(Refusal::UnknownRiskWord),
    };
    let explanation = crate::prompt::cut_at_word(&clean_explanation(&raw.explanation)?, MAX_EXPLANATION_BYTES);
    if explanation.is_empty() {
        return Err(Refusal::ExplanationEmpty);
    }
    if !is_plain_text(&explanation) {
        return Err(Refusal::ExplanationNotPlainText);
    }
    let cleaned = fenced.is_some() || explanation != raw.explanation;
    Ok(AiAnswer { risk, explanation, cleaned })
}

/// The inside of one code fence that wraps the whole of `text`, trimmed, or `None` when `text` is
/// not exactly that. Only the two fence lines are taken away, so text outside them stays and is
/// refused with the rest.
fn unfenced(text: &str) -> Option<&str> {
    let (open, rest) = text.split_once('\n')?;
    let (inside, close) = rest.rsplit_once('\n')?;
    (matches!(open.trim_end(), "```" | "```json") && close.trim() == "```").then(|| inside.trim())
}

/// The two fields, telling text that is not JSON apart from JSON of another shape. serde's derived
/// reader refuses extra and repeated keys, which a generic JSON value would take silently, but it
/// also reads a two-item array as the struct, so the value must open as an object.
fn read_fields(text: &str) -> Result<RawAnswer, Refusal> {
    match serde_json::from_str::<RawAnswer>(text) {
        Ok(raw) if text.trim_start().starts_with('{') => Ok(raw),
        _ => match serde_json::from_str::<serde::de::IgnoredAny>(text) {
            Ok(_) => Err(Refusal::AnswerWrongFields),
            Err(_) => Err(Refusal::AnswerNotJson),
        },
    }
}

/// The ASCII a model means by a typographic character it often writes, or `None` for any other
/// character. Line breaks and tabs are spacing too.
fn ascii_form(c: char) -> Option<&'static str> {
    Some(match c {
        '\u{2018}' | '\u{2019}' => "'",
        '\u{201c}' | '\u{201d}' => "\"",
        '\u{2013}' | '\u{2014}' | '\u{2212}' => "-",
        '\u{2026}' => "...",
        '\u{a0}' | '\t' | '\r' | '\n' => " ",
        _ => return None,
    })
}

/// The explanation cleaned in form, in this order: `ascii_form` for each character; refused as
/// `ExplanationHasLink` when the result holds `://` or `www.` in any case, checked before anything
/// is dropped so that dropping can never hide one; a space after every colon that is followed by
/// something else; every other non-ASCII character becomes `?`, so that a dropped letter leaves a
/// mark and a lookalike name never reads as a different real one; every ASCII character
/// `is_plain_text` would refuse on its own becomes a space; runs of spaces become one; trimmed.
/// What comes out is made only of characters `is_plain_text` allows, and every colon in it is
/// followed by a space or ends it, so `is_plain_text` accepts it.
fn clean_explanation(text: &str) -> Result<String, Refusal> {
    let mut mapped = String::with_capacity(text.len());
    for c in text.chars() {
        match ascii_form(c) {
            Some(ascii) => mapped.push_str(ascii),
            None => mapped.push(c),
        }
    }
    let lower = mapped.to_ascii_lowercase();
    if lower.contains("://") || lower.contains("www.") {
        return Err(Refusal::ExplanationHasLink);
    }
    let mut spaced = String::with_capacity(mapped.len());
    let mut chars = mapped.chars().peekable();
    while let Some(c) = chars.next() {
        spaced.push(c);
        if c == ':' && chars.peek().is_some_and(|&next| next != ' ') {
            spaced.push(' ');
        }
    }
    let kept = spaced.chars().map(|c| match c {
        c if !c.is_ascii() => '?',
        c if is_plain_text(c.encode_utf8(&mut [0; 4])) => c,
        _ => ' ',
    });
    let mut collapsed = String::with_capacity(spaced.len());
    for c in kept {
        if !(c == ' ' && collapsed.ends_with(' ')) {
            collapsed.push(c);
        }
    }
    Ok(collapsed.trim().to_string())
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
/// answer, so the reasoning is kept short with a budget instead. The first live run (5 Nov 2026,
/// one proposal) reasoned for 257 tokens against a budget of 256 and finished with `stop` in 15.7 s
/// of the run's 60 s, so 512 leaves harder proposals room. scripts/ai-eval.mjs measures it.
pub const THINKING_TOKEN_BUDGET: u32 = 512;
/// The answer itself. The same run's answer took about 66 of these 400 tokens, and one run is thin,
/// so scripts/ai-eval.mjs measures this too.
pub const MAX_ANSWER_TOKENS: u32 = 400;
/// The reasoning budgets an eval run may ask for in place of `THINKING_TOKEN_BUDGET`, so the answer
/// key can show what the budget does to the answers. A judge run always uses the constant.
pub const MIN_EVAL_THINKING_BUDGET: u32 = 64;
pub const MAX_EVAL_THINKING_BUDGET: u32 = 1_024;

/// The one chat request: non-streamed (a streamed answer is signed by the gateway, not the
/// model), temperature 0, reasoning capped at `thinking_budget` (`THINKING_TOKEN_BUDGET` on every
/// judge run), room for the reasoning plus `MAX_ANSWER_TOKENS`, JSON mode. A Members prompt alone
/// adds `MAX_MEMBER_EXPLANATION_BYTES` to the system prompt. These are the exact bytes sent and
/// hashed.
pub fn chat_request_body(model_id: &str, user_message: &str, audience: Audience, thinking_budget: u32) -> Vec<u8> {
    let system = match audience {
        Audience::Public => crate::prompt::SYSTEM_PROMPT.to_string(),
        Audience::Members => crate::prompt::member_system_prompt(),
    };
    serde_json::json!({
        "model": model_id,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user_message },
        ],
        "stream": false,
        "temperature": 0,
        "max_tokens": thinking_budget + MAX_ANSWER_TOKENS,
        "thinking_token_budget": thinking_budget,
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
    /// Passed through `finish_word`, so it is never more than a short fixed-alphabet word.
    pub finish_reason: Option<String>,
    /// The message text, when it was a single string.
    pub content: Option<String>,
    pub usage: Usage,
}

/// `reason` when it is 1 to 16 characters of `a-z` and `_`, as the OpenAI-style finish reasons
/// (`stop`, `length`, `tool_calls`, `content_filter`) all are, and `other` for anything else, so
/// text from outside the job never reaches an output or an evidence record through this field.
pub fn finish_word(reason: &str) -> &str {
    let word = (1..=16).contains(&reason.len()) && reason.bytes().all(|b| b.is_ascii_lowercase() || b == b'_');
    if word {
        reason
    } else {
        "other"
    }
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
        finish_reason: choice.finish_reason.as_deref().map(|r| finish_word(r).to_string()),
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
/// its content is a single string (`AnswerNotJson` when it is none, or a list of parts), and
/// `parse_answer` accepts it.
pub fn answer_of(completion: &Completion) -> Result<AiAnswer, Refusal> {
    if completion.finish_reason.as_deref() != Some("stop") {
        return Err(Refusal::NotOneFinishedChoice);
    }
    parse_answer(completion.content.as_deref().ok_or(Refusal::AnswerNotJson)?)
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
/// reason. Before the question, `attest::preflight` checks the model's attestation. For a Public
/// prompt its failure does not stop the question, it only means the answer cannot be Verified. For
/// a Members prompt it stops the question: nothing carrying the text leaves the job, and the
/// outcome is `Unavailable(SealedHardwareNotProven)`, so the plain-code verdict stands (C12). Each
/// request runs under its own limits, cut to `deadline`; the preflight gets at most
/// `PREFLIGHT_BUDGET_MS`.
pub fn consult(
    http: &mut dyn Http,
    key: Option<&str>,
    facts: Option<&str>,
    audience: Audience,
    deadline: Deadline,
    trust: &Trust,
) -> (AiOutcome, Evidence) {
    consult_with_budget(http, key, facts, audience, THINKING_TOKEN_BUDGET, deadline, trust)
}

/// `consult` with the model's reasoning capped at `thinking_budget` instead of
/// `THINKING_TOKEN_BUDGET`. Only an eval run passes another budget, one `input::parse_eval` held
/// to `MIN_EVAL_THINKING_BUDGET..=MAX_EVAL_THINKING_BUDGET`.
pub fn consult_with_budget(
    http: &mut dyn Http,
    key: Option<&str>,
    facts: Option<&str>,
    audience: Audience,
    thinking_budget: u32,
    deadline: Deadline,
    trust: &Trust,
) -> (AiOutcome, Evidence) {
    let mut evidence = Evidence::new();
    let outcome = match ask(http, key, facts, audience, thinking_budget, deadline, trust, &mut evidence) {
        Ok((answer, check)) => AiOutcome::Answered { answer, model_id: MODEL_ID, check },
        Err(why) => AiOutcome::Unavailable(why),
    };
    (outcome, evidence)
}

#[allow(clippy::too_many_arguments)]
fn ask(
    http: &mut dyn Http,
    key: Option<&str>,
    facts: Option<&str>,
    audience: Audience,
    thinking_budget: u32,
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
    if audience == Audience::Members && verified.is_err() {
        return Err(Refusal::SealedHardwareNotProven);
    }

    if deadline.passed() {
        return Err(Refusal::Deadline);
    }
    let authorization = format!("Bearer {key}");
    let body = chat_request_body(MODEL_ID, facts, audience, thinking_budget);
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
        .map_err(|fail| if fail == HttpFail::Timeout { Refusal::CallTimedOut } else { Refusal::CallFailed })?;
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
