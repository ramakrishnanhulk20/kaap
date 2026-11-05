//! What a run saw while checking the AI, published next to the verdict so a stranger can check the
//! same answer: under OutLayer public storage key `ai-evidence:<hex sha256 of the verdict bytes>`,
//! which only this project's code can write and anyone can read
//! (`GET https://<api>/public/storage/get?project=<project>&key=<key>`).
//!
//! The 900-byte verdict output has no room for it and the worker reads that output with a strict
//! schema, so the evidence lives beside it, tied to it by the verdict's own hash. A record holds
//! ids, hashes, quotes, claims and check results only, each one this crate produced or checked
//! first: hex it decoded, numbers, fixed words and Intel's advisory ids in their known shape
//! (standard 3). It never holds text from the request or the answer, only their hashes, because
//! the evidence is public and a later prompt may carry a text only a DAO's members may read.

use base64::Engine as _;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::gpu::GpuFacts;
use super::ita::GatewayFacts;
use super::signature::SignedAnswer;
use super::tdx::{PckFlags, QuoteFacts};
use super::VerifiedModel;

/// Where a verdict's evidence is published.
pub trait EvidenceSink {
    /// Stores `record` under `key`; false when it could not be stored.
    fn publish(&mut self, key: &str, record: &[u8]) -> bool;
}

pub const KEY_PREFIX: &str = "ai-evidence:";

pub fn key_for(verdict_hash: &[u8; 32]) -> String {
    format!("{KEY_PREFIX}{}", hex::encode(verdict_hash))
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Evidence {
    pub v: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verdict_hash: Option<String>,
    /// `verified`, `unverified` or `unavailable`, as the verdict says.
    pub ai_status: &'static str,
    /// Why the answer is not verified or the AI was not used.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clock_unix: Option<u64>,
    /// The model's own machines: TDX quote checked here, GPUs judged by NVIDIA.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub model_quotes: Vec<ModelRecord>,
    /// NEAR AI's gateway, from its public Intel token. Never evidence about the model.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway: Option<GatewayRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion: Option<CompletionRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<SignatureRecord>,
    /// The same answer on NEAR AI's own verifier. It re-checks the signature and the signer
    /// against fresh evidence, but compares no deployment with an allowlist, so Kaap's own checks
    /// above are the ones that decided the status.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verify_link: Option<String>,
}

impl Evidence {
    pub fn new() -> Evidence {
        Evidence { v: 1, ..Evidence::default() }
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        crate::output::sorted_json(self).map(String::into_bytes).unwrap_or_default()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ModelRecord {
    pub signing_address: String,
    pub tcb_status: String,
    pub advisory_ids: Vec<String>,
    pub tcb_eval_data_number: u32,
    /// The PCK certificate's platform flags, which Kaap accepts without judging them.
    pub pck_flags: PckFlags,
    pub pck_flags_policy: &'static str,
    pub gpus: usize,
    pub nras_passed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nras_issued_at: Option<u64>,
    /// The model's Intel TDX quote as it was verified, in hex, so anyone can run their own DCAP
    /// verifier on it and read the report data that binds `signing_address` and the nonce.
    pub intel_quote: String,
}

impl ModelRecord {
    pub fn new(model: &VerifiedModel, quote: &[u8], facts: &QuoteFacts, gpu: &GpuFacts) -> ModelRecord {
        ModelRecord {
            signing_address: hex::encode(model.signing_address),
            tcb_status: model.tcb_status.clone(),
            advisory_ids: model.advisory_ids.clone(),
            tcb_eval_data_number: facts.eval_number,
            pck_flags: facts.pck_flags.clone(),
            pck_flags_policy: "accepted, not judged: NEAR AI's own verification guide does not judge them",
            gpus: model.gpus,
            nras_passed: gpu.passed,
            nras_issued_at: gpu.iat,
            intel_quote: hex::encode(quote),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct GatewayRecord {
    pub scope: &'static str,
    pub tcb_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tcb_date: Option<String>,
    pub advisory_ids: Vec<String>,
    pub signing_address: String,
    pub intel_kid: String,
    pub issued_at: u64,
    pub expires_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intel_gpu_count: Option<usize>,
}

impl From<&GatewayFacts> for GatewayRecord {
    fn from(f: &GatewayFacts) -> GatewayRecord {
        GatewayRecord {
            scope: "NEAR AI gateway only, not the model",
            tcb_status: f.tcb_status.clone(),
            tcb_date: f.tcb_date.clone(),
            advisory_ids: f.advisory_ids.clone(),
            signing_address: hex::encode(f.signing_address),
            intel_kid: f.kid.clone(),
            issued_at: f.iat,
            expires_at: f.exp,
            intel_gpu_count: f.gpus.map(|(count, _)| count),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct CompletionRecord {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
    /// The length of the model's message, never the message: with the token counts it sizes
    /// `MAX_ANSWER_TOKENS` from a live run.
    pub content_bytes: usize,
}

impl CompletionRecord {
    pub fn new(completion: &crate::ai::Completion) -> CompletionRecord {
        let word = |s: &String| s.len() <= 32 && s.bytes().all(|b| b.is_ascii_lowercase() || b == b'_');
        CompletionRecord {
            chat_id: Some(completion.id.clone()).filter(|id| super::signature::chat_id_ok(id)),
            finish_reason: completion.finish_reason.clone().filter(word),
            prompt_tokens: completion.usage.prompt_tokens,
            completion_tokens: completion.usage.completion_tokens,
            reasoning_tokens: completion.usage.reasoning_tokens,
            content_bytes: completion.content.as_deref().map_or(0, str::len),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SignatureRecord {
    pub kind: &'static str,
    pub algo: &'static str,
    pub signing_address: String,
    pub text: String,
    pub signature: String,
    pub request_sha256: String,
    pub response_sha256: String,
}

impl SignatureRecord {
    pub fn new(signed: &SignedAnswer, request: &[u8], response: &[u8]) -> SignatureRecord {
        SignatureRecord {
            kind: "provider_tee",
            algo: "ed25519",
            signing_address: hex::encode(signed.signing_address),
            text: signed.text.clone(),
            signature: hex::encode(signed.signature),
            request_sha256: hex::encode(Sha256::digest(request)),
            response_sha256: hex::encode(Sha256::digest(response)),
        }
    }
}

/// The receipt NEAR AI's Verification Center reads from the link's fragment (docs.near.ai,
/// "Verification Center", 23 Oct 2026). `verifiedAt` is optional and left out: the page says it
/// does not check it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt<'a> {
    completion_id: &'a str,
    model: &'a str,
    signature_kind: &'a str,
    signing_algo: &'a str,
    signing_address: String,
    signed_text: &'a str,
    signature: String,
}

/// `https://cloud.near.ai/verify?model=<model id, URL-encoded>#receipt=<base64url JSON>` for a
/// signature `check` passed. `chat_id` must already have passed `chat_id_ok`.
pub fn verify_link(model_id: &str, chat_id: &str, signed: &SignedAnswer) -> String {
    let receipt = Receipt {
        completion_id: chat_id,
        model: model_id,
        signature_kind: "provider_tee",
        signing_algo: "ed25519",
        signing_address: hex::encode(signed.signing_address),
        signed_text: &signed.text,
        signature: hex::encode(signed.signature),
    };
    let json = serde_json::to_vec(&receipt).unwrap_or_default();
    format!(
        "https://cloud.near.ai/verify?model={}#receipt={}",
        urlencoding::encode(model_id),
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json)
    )
}
