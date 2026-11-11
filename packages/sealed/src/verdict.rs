//! The verdict: kaap-core's `Verdict`, filled from the agreed read, the analysis and the AI
//! outcome, signed over kaap-core's `verdict_bytes` with the program's own key, and printed in at
//! most `MAX_OUTPUT_BYTES`.

use base64::Engine as _;
use kaap_core::receipt::DECODER_VERSION;
use kaap_core::verdict::{VERDICT_DOMAIN, VERDICT_VERSION};
use kaap_core::{verdict_bytes, AiStatus, Analysis, Severity, Verdict};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::ai::{AiOutcome, AiRisk, Check};
use crate::input::JobInput;
use crate::output::{sorted_json, MAX_OUTPUT_BYTES};
use crate::prompt::cut_at_word;
use crate::reads::ChainRead;
use crate::texts::sealed_room;

/// The key path declared in the manifest. The keystore derives it for this project and the
/// account that sent `request_execution`; the job never sees the secret.
pub const SIGNING_KEY_PATH: &str = "verdict";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignFail {
    PublicKey,
    Signature,
}

pub trait VerdictSigner {
    fn public_key(&mut self) -> Result<[u8; 32], SignFail>;
    fn sign(&mut self, message: &[u8]) -> Result<[u8; 64], SignFail>;
}

/// The order kaap-core's risk floor uses: UNKNOWN counts as high.
pub fn rank(s: Severity) -> u8 {
    match s {
        Severity::Low => 0,
        Severity::Medium => 1,
        Severity::High | Severity::Unknown => 2,
        Severity::Critical => 3,
    }
}

pub fn severity_of(risk: AiRisk) -> Severity {
    match risk {
        AiRisk::Low => Severity::Low,
        AiRisk::Medium => Severity::Medium,
        AiRisk::High => Severity::High,
        AiRisk::Critical => Severity::Critical,
    }
}

/// The verdict's risk (C9): the higher of the plain-code floor and the AI's risk, where an AI
/// answer that is not Verified counts as high at most (decided 23 Oct 2026: only a proven AI
/// answer may lead to a veto). The AI can raise the risk and never lower it. An Unknown floor is
/// reported as High, as kaap-core reports it.
pub fn combine_risk(floor: Severity, ai: Option<(AiRisk, AiStatus)>) -> Severity {
    let floor = if floor == Severity::Unknown { Severity::High } else { floor };
    let Some((risk, status)) = ai else {
        return floor;
    };
    let ai = match status {
        AiStatus::Unavailable => return floor,
        AiStatus::Unverified if risk == AiRisk::Critical => Severity::High,
        AiStatus::Unverified | AiStatus::Verified => severity_of(risk),
    };
    if rank(ai) > rank(floor) {
        ai
    } else {
        floor
    }
}

/// The words in front of the model's explanation. A verified answer states the Intel TCB level the
/// model's hardware reported (decided 23 Oct 2026: every verdict says which); an unverified one
/// says which check failed. Both come before the model's text because `fit` cuts from the end.
pub fn ai_note(check: &Check) -> String {
    match check {
        Check::Verified { tcb_status } => format!("AI verified (Intel TCB: {tcb_status}). "),
        Check::Unverified(why) => format!("AI unverified ({}). ", why.note()),
    }
}

/// What a member reads. A public verdict's notes are sentences of up to 91 bytes, more than the
/// longest output leaves once it is encrypted, so a reason is its short code here, the word the
/// public evidence record stores for it. A verified answer keeps its `ai_note`, which is short and
/// states the Intel TCB level every verdict must state.
pub fn member_explanation(ai: &AiOutcome) -> String {
    let text = match ai {
        AiOutcome::Answered { answer, check: Check::Unverified(why), .. } => format!("AI unverified ({}). {}", why.code(), answer.explanation),
        AiOutcome::Answered { answer, check, .. } => format!("{}{}", ai_note(check), answer.explanation),
        AiOutcome::Unavailable(why) => format!("AI unavailable ({}).", why.code()),
    };
    text.trim_end().to_string()
}

/// Builds the unsigned verdict and the explanation it will carry.
///
/// `ai_status` is Verified or Unverified when the model answered, by its `Check`, and Unavailable
/// otherwise; `model_id` is the model that answered, or empty when none did; the explanation is
/// `ai_note` followed by the model's text, or the job's fixed note saying why there is none. On a
/// run with a sealed text it is `member_explanation` instead.
/// `explanation_hash` is set later, once the explanation has been fitted to the output.
/// `expires_at_ms` is the read block's timestamp plus `expires_in_ms`; an overflow is refused.
pub fn assemble(input: &JobInput, read: &ChainRead, analysis: &Analysis, ai: &AiOutcome) -> Result<(Verdict, String), &'static str> {
    let (ai_status, ai_risk, model_id, explanation) = match ai {
        AiOutcome::Answered { answer, model_id, check } => {
            let status = if matches!(check, Check::Verified { .. }) { AiStatus::Verified } else { AiStatus::Unverified };
            (status, Some(answer.risk), model_id.to_string(), format!("{}{}", ai_note(check), answer.explanation))
        }
        AiOutcome::Unavailable(why) => (AiStatus::Unavailable, None, String::new(), why.note().to_string()),
    };
    let explanation = if input.text.is_some() { member_explanation(ai) } else { explanation };
    let floor = analysis.risk_floor;
    let risk = combine_risk(floor, ai_risk.map(|r| (r, ai_status)));
    let expires_at_ms = (read.block.timestamp_ns / 1_000_000)
        .checked_add(input.expires_in_ms)
        .ok_or("the expiry does not fit in 64 bits")?;
    let verdict = Verdict {
        version: VERDICT_VERSION,
        guard: input.guard.clone(),
        network: input.network,
        dao: input.dao.clone(),
        proposal_id: input.proposal_id,
        kind_hash: read.kind_hash,
        policy_hash: read.policy_hash,
        receivers_hash: read.receivers_hash,
        block_height: read.block.height,
        risk,
        floor,
        findings: analysis.findings.iter().map(|f| f.code).collect(),
        decoder_version: DECODER_VERSION.to_string(),
        model_id,
        ai_status,
        explanation_hash: [0; 32],
        expires_at_ms,
    };
    Ok((verdict, explanation))
}

#[derive(Serialize)]
struct Signed<'a> {
    v: u8,
    status: &'static str,
    verdict: String,
    signature: String,
    public_key: &'a str,
    explanation: &'a str,
}

/// Fits the explanation into what is left of `MAX_OUTPUT_BYTES`, hashes it into the verdict,
/// signs `verdict_bytes` and prints `{"v":1,"status":"ok","verdict","signature","public_key",
/// "explanation"}` with its keys sorted, where `verdict` is the base64 of the borsh encoding without the domain prefix
/// (what the guard's `veto` takes) and `signature` the base64 of the 64-byte ed25519 signature.
///
/// The explanation is cut from the end, before hashing, so the hash always covers exactly the text
/// printed. Fails, with no signature, when the key or the signature cannot be had, or when the
/// output would exceed `MAX_OUTPUT_BYTES` even with an empty explanation.
pub fn sign_and_render(verdict: Verdict, explanation: String, signer: &mut dyn VerdictSigner) -> Result<String, &'static str> {
    let public_key = public_key_text(signer)?;
    let (verdict, explanation) = seal(verdict, &explanation, &public_key)?;
    sign_sealed(&verdict, &explanation, &public_key, signer)
}

/// The signer's key as the output prints it, `ed25519:<base58>`.
pub fn public_key_text(signer: &mut dyn VerdictSigner) -> Result<String, &'static str> {
    let key = signer.public_key().map_err(|_| "the signing key is unavailable")?;
    Ok(format!("ed25519:{}", bs58::encode(key).into_string()))
}

/// The verdict exactly as it will be signed: the explanation fitted into what is left of
/// `MAX_OUTPUT_BYTES` next to `public_key`, and its hash set. From here on the verdict's bytes,
/// and so its hash, are final.
pub fn seal(mut verdict: Verdict, explanation: &str, public_key: &str) -> Result<(Verdict, String), &'static str> {
    let explanation = fit(explanation, explanation_budget(&verdict, public_key)?);
    verdict.explanation_hash = sha256(explanation.as_bytes());
    Ok((verdict, explanation))
}

/// `seal` for a verdict whose explanation only one member may read: `explanation` is cut only if it
/// does not fit this run's room once encrypted, and then at its last word boundary. `encrypt` turns
/// it into the text the output prints, and the hash covers that printed ciphertext. The hash stays what it always was, the hash of the printed field, and
/// no hash of the plain explanation reaches the chain (C13).
pub fn seal_encrypted(
    mut verdict: Verdict,
    explanation: &str,
    public_key: &str,
    encrypt: impl FnOnce(&str) -> Result<String, &'static str>,
) -> Result<(Verdict, String), &'static str> {
    let room = sealed_room(explanation_budget(&verdict, public_key)?);
    let printed = encrypt(&cut_at_word(explanation, room))?;
    verdict.explanation_hash = sha256(printed.as_bytes());
    Ok((verdict, printed))
}

fn explanation_budget(verdict: &Verdict, public_key: &str) -> Result<usize, &'static str> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let unsigned_borsh = &verdict_bytes(verdict)[VERDICT_DOMAIN.len()..];
    let frame = render(&b64.encode(unsigned_borsh), &b64.encode([0u8; 64]), public_key, "")?;
    MAX_OUTPUT_BYTES.checked_sub(frame.len()).ok_or("the verdict does not fit in 900 bytes")
}

/// Signs a sealed verdict and prints it. Fails, with no signature, when the signature cannot be
/// made or the output would exceed `MAX_OUTPUT_BYTES`.
pub fn sign_sealed(verdict: &Verdict, explanation: &str, public_key: &str, signer: &mut dyn VerdictSigner) -> Result<String, &'static str> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let message = verdict_bytes(verdict);
    let signature = signer.sign(&message).map_err(|_| "the signature could not be made")?;
    let out = render(&b64.encode(&message[VERDICT_DOMAIN.len()..]), &b64.encode(signature), public_key, explanation)?;
    if out.len() > MAX_OUTPUT_BYTES {
        return Err("the verdict does not fit in 900 bytes");
    }
    Ok(out)
}

fn render(verdict: &str, signature: &str, public_key: &str, explanation: &str) -> Result<String, &'static str> {
    sorted_json(&Signed {
        v: 1,
        status: "ok",
        verdict: verdict.to_string(),
        signature: signature.to_string(),
        public_key,
        explanation,
    })
    .map_err(|_| "the output could not be written")
}

/// The longest prefix of `text`, cut at a character boundary, whose JSON string form fits in
/// `budget` bytes once quoted and escaped.
pub fn fit(text: &str, budget: usize) -> String {
    let escaped = |s: &str| serde_json::to_string(s).map(|q| q.len() - 2).unwrap_or(usize::MAX);
    let mut end = text.len();
    while end > 0 && escaped(&text[..end]) > budget {
        end -= 1;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
    }
    text[..end].to_string()
}

pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(&Sha256::digest(bytes));
    out
}
