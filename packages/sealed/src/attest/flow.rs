//! The checks in the order NEAR AI's guides set: `preflight` before the completion is sent,
//! `bind_answer` after it. Each stops at its first failed check and names it.

use serde_json::Value;

use super::evidence::{verify_link, Evidence, GatewayRecord, ModelRecord, SignatureRecord};
use super::report::{DeploymentClaim, SoftwareClaims};
use super::{gpu, ita, measure, report, signature, tdx, Unverified, VerifiedModel};
use crate::net::{Deadline, Http, Response};

/// What the job brings to the checks from outside the network.
pub struct Trust {
    /// 32 random bytes this run drew from WASI random, sent to every attestation service; `None`
    /// when none could be drawn.
    pub nonce: Option<[u8; 32]>,
    /// `trusted_now`'s answer for this run.
    pub now: Result<u64, Unverified>,
    /// The local Intel TDX quote check: `tdx::check_quote` in every published build.
    pub quote: tdx::QuoteCheck,
}

/// The longest the checks before the completion may take, so the question itself always has time
/// left within the job's budget.
pub const PREFLIGHT_BUDGET_MS: u64 = 25_000;

/// Everything NEAR AI's guides require before a completion is sent: the keyed attestation report
/// fetched with this run's nonce; every model candidate in it checked (collateral, quote, TCB
/// level, report data, software record, GPUs), keeping those that pass; and the gateway's public
/// Intel token checked. Returns the verified model keys, or the first reason there are none.
/// Records what it saw in `evidence`.
pub fn preflight(
    http: &mut dyn Http,
    key: &str,
    trust: &Trust,
    deadline: Deadline,
    evidence: &mut Evidence,
) -> Result<Vec<VerifiedModel>, Unverified> {
    let nonce = trust.nonce.ok_or(Unverified::NoNonce)?;
    let now = trust.now?;
    evidence.clock_unix = Some(now);
    let body = report::fetch(http, key, &nonce, deadline)?;
    let entries = report::entries(&body, &nonce)?;

    let mut collateral = tdx::CollateralCache::default();
    let mut nvidia_keys = None;
    let mut verified = Vec::new();
    let mut first_failure = None;
    for entry in entries {
        let mut checked = |e: report::Entry| {
            check_candidate(http, &e, trust.quote, &nonce, now, deadline, &mut collateral, &mut nvidia_keys, evidence)
        };
        match entry.and_then(&mut checked) {
            Ok(model) => verified.push(model),
            Err(why) => {
                first_failure.get_or_insert(why);
            }
        }
    }
    if verified.is_empty() {
        return Err(first_failure.unwrap_or(Unverified::NoModelEvidence));
    }

    let (response, keys) = ita::fetch(http, &nonce, deadline)?;
    let gateway = ita::check(&response, &keys, &nonce, now)?;
    evidence.gateway = Some(GatewayRecord::from(&gateway));
    Ok(verified)
}

#[allow(clippy::too_many_arguments)]
fn check_candidate(
    http: &mut dyn Http,
    entry: &report::Entry,
    quote_check: tdx::QuoteCheck,
    nonce: &[u8; 32],
    now: u64,
    deadline: Deadline,
    collateral: &mut tdx::CollateralCache,
    nvidia_keys: &mut Option<Value>,
    evidence: &mut Evidence,
) -> Result<VerifiedModel, Unverified> {
    let candidate = &entry.candidate;
    let quote = quote_check(&candidate.quote, collateral.get(http, &candidate.quote, deadline)?, now)?;
    report::bind(candidate, &quote.report_data, nonce)?;
    let software = check_software(&entry.software, &quote, quote_check, nonce, now, collateral)?;

    let (payload, gpus) = gpu::payload(candidate.nvidia_payload.as_deref(), nonce)?;
    let answer = gpu::attest(http, payload, deadline)?;
    let keys = match nvidia_keys {
        Some(keys) => keys,
        None => nvidia_keys.insert(gpu::fetch_keys(http, deadline)?),
    };
    let facts = gpu::check(&answer, keys, nonce, now)?;

    let model = VerifiedModel {
        signing_address: candidate.signing_address,
        tcb_status: quote.tcb_status.clone(),
        advisory_ids: quote.advisory_ids.clone(),
        gpus,
    };
    evidence.model_quotes.push(ModelRecord::new(&model, &candidate.quote, &quote, &facts, &software));
    Ok(model)
}

/// The software checks for one candidate whose `quote` already passed `quote_check` and
/// `report::bind`: `measure::check` on the model machine's own record, then, when the report
/// carries the launcher's deployment log, that log's own quote through `quote_check` with the
/// collateral this run already holds for its platform, and `measure::deployment`. It makes no
/// network call. A log that is unreadable, from a platform this run has not seen, or whose quote
/// fails gives `DeployLogMismatch`; an absent log is recorded as absent and nothing else
/// changes.
pub fn check_software(
    claims: &SoftwareClaims,
    quote: &tdx::QuoteFacts,
    quote_check: tdx::QuoteCheck,
    nonce: &[u8; 32],
    now: u64,
    collateral: &tdx::CollateralCache,
) -> Result<measure::Software, Unverified> {
    let mut software = measure::check(claims, quote)?;
    software.deployment = match &claims.deployment {
        DeploymentClaim::Absent => None,
        DeploymentClaim::Unreadable => return Err(Unverified::DeployLogMismatch),
        DeploymentClaim::Stated(log) => {
            let collateral = collateral.cached(&log.quote).ok_or(Unverified::DeployLogMismatch)?;
            let log_quote = quote_check(&log.quote, collateral, now).map_err(|_| Unverified::DeployLogMismatch)?;
            Some(measure::deployment(log, &log_quote, quote, nonce)?)
        }
    };
    Ok(software)
}

/// The checks after the completion: the answer came back as one JSON completion, not streamed
/// (`Streamed`); from the canonical model (`AliasResolved` when another of its names answered,
/// `WrongModel` otherwise); its signature is the model's own over the exact bytes sent and
/// received (`signature::check`); and its signer is exactly one of `verified`
/// (`SignerNotAttested`). Runs even when the preflight failed (`verified` is `None`), so the
/// evidence still carries the signature and NEAR AI's own verify link; the preflight's reason then
/// wins. A run with a sealed text publishes neither, as both are functions of its prompt
/// (`Evidence::confidential`). `aliases` are the canonical model's other names in NEAR AI's catalog.
#[allow(clippy::too_many_arguments)]
pub fn bind_answer(
    http: &mut dyn Http,
    key: &str,
    verified: Option<&[VerifiedModel]>,
    model_id: &'static str,
    aliases: &[String],
    sent: &[u8],
    received: &Response,
    completion: &crate::ai::Completion,
    deadline: Deadline,
    evidence: &mut Evidence,
) -> Result<VerifiedModel, Unverified> {
    let json = received.header("content-type").is_some_and(|t| t.trim_start().starts_with("application/json"));
    if !json || completion.object != "chat.completion" {
        return Err(Unverified::Streamed);
    }
    if completion.model != model_id {
        return Err(if aliases.contains(&completion.model) { Unverified::AliasResolved } else { Unverified::WrongModel });
    }
    let body = signature::fetch(http, key, &completion.id, deadline)?;
    let signed = signature::check(&body, &signature::expected_text(model_id, sent, &received.body))?;
    evidence.signature = Some(SignatureRecord::new(&signed, sent, &received.body));
    evidence.verify_link = Some(verify_link(model_id, &completion.id, &signed));
    let verified = verified.ok_or(Unverified::SignerNotAttested)?;
    signature::match_signer(&signed.signing_address, verified).cloned()
}
