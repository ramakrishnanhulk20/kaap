//! The verdict: kaap-core's `Verdict`, filled from the agreed read, the analysis and the AI
//! outcome, signed over kaap-core's `verdict_bytes` with the program's own key, and printed in at
//! most `MAX_OUTPUT_BYTES`.

use base64::Engine as _;
use kaap_core::verdict::{VERDICT_DOMAIN, VERDICT_VERSION};
use kaap_core::{verdict_bytes, AiStatus, Analysis, Severity, Verdict};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::ai::{AiOutcome, AiRisk};
use crate::input::JobInput;
use crate::output::MAX_OUTPUT_BYTES;
use crate::reads::ChainRead;

/// kaap-core shares the workspace version with this crate, and kaap-core exports no version of
/// its own, so this is the decoder's version too.
pub const DECODER_VERSION: &str = env!("CARGO_PKG_VERSION");

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
/// answer that is not Verified counts as high at most (Ram, 23 Oct 2026: only a proven AI answer
/// may lead to a veto). The AI can raise the risk and never lower it. An Unknown floor is
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

/// Builds the unsigned verdict and the explanation it will carry.
///
/// `ai_status` is Unverified when the model answered (its signature and attestation are checked
/// only from WO-05) and Unavailable otherwise; `model_id` is the model that answered, or empty
/// when none did; the explanation is the model's, or the job's fixed note saying why there is
/// none. `explanation_hash` is set later, once the explanation has been fitted to the output.
/// `expires_at_ms` is the read block's timestamp plus `expires_in_ms`; an overflow is refused.
pub fn assemble(input: &JobInput, read: &ChainRead, analysis: &Analysis, ai: &AiOutcome) -> Result<(Verdict, String), &'static str> {
    let (ai_status, ai_risk, model_id, explanation) = match ai {
        AiOutcome::Answered { answer, model_id } => {
            (AiStatus::Unverified, Some(answer.risk), model_id.to_string(), answer.explanation.clone())
        }
        AiOutcome::Unavailable(why) => (AiStatus::Unavailable, None, String::new(), why.note().to_string()),
    };
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
/// "explanation"}`, where `verdict` is the base64 of the borsh encoding without the domain prefix
/// (what the guard's `veto` takes) and `signature` the base64 of the 64-byte ed25519 signature.
///
/// The explanation is cut from the end, before hashing, so the hash always covers exactly the text
/// printed. Fails, with no signature, when the key or the signature cannot be had, or when the
/// output would exceed `MAX_OUTPUT_BYTES` even with an empty explanation.
pub fn sign_and_render(mut verdict: Verdict, explanation: String, signer: &mut dyn VerdictSigner) -> Result<String, &'static str> {
    let public_key = signer.public_key().map_err(|_| "the signing key is unavailable")?;
    let public_key = format!("ed25519:{}", bs58::encode(public_key).into_string());
    let b64 = base64::engine::general_purpose::STANDARD;

    let unsigned_borsh = &verdict_bytes(&verdict)[VERDICT_DOMAIN.len()..];
    let frame = render(&b64.encode(unsigned_borsh), &b64.encode([0u8; 64]), &public_key, "")?;
    let budget = MAX_OUTPUT_BYTES.checked_sub(frame.len()).ok_or("the verdict does not fit in 900 bytes")?;
    let explanation = fit(&explanation, budget);

    verdict.explanation_hash = sha256(explanation.as_bytes());
    let message = verdict_bytes(&verdict);
    let signature = signer.sign(&message).map_err(|_| "the signature could not be made")?;
    let out = render(&b64.encode(&message[VERDICT_DOMAIN.len()..]), &b64.encode(signature), &public_key, &explanation)?;
    if out.len() > MAX_OUTPUT_BYTES {
        return Err("the verdict does not fit in 900 bytes");
    }
    Ok(out)
}

fn render(verdict: &str, signature: &str, public_key: &str, explanation: &str) -> Result<String, &'static str> {
    serde_json::to_string(&Signed {
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
