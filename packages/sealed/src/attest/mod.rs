//! "AI verified" (C11): the checks that tie one NEAR AI answer to a model running in sealed
//! hardware, run inside the job on evidence it fetched itself with a nonce it chose.
//!
//! The order follows NEAR AI's verification guides. Before the completion: the model's attestation
//! report (its Intel TDX quote checked here with dcap-qvl, its report data bound to the signing key
//! and the nonce, its software record held to that quote by `measure`, its GPUs judged by NVIDIA)
//! and the gateway's public Intel token. After it: the signature over the exact request and
//! response bytes, whose signer must be the one key a verified report named. A check that fails or
//! cannot run gives `Unverified` with the first reason; nothing passes by default (standard 4).
//!
//! Not covered: the software record is proven consistent with the quote and published, never
//! compared with an allowlist, so "verified" means a genuine, non-debug Intel TDX machine with
//! NVIDIA-passed GPUs, whose launcher configuration, system image and deployment log are the ones
//! in the evidence, holds the key that signed this exact answer. It does not mean Kaap has
//! reviewed that software. Physical attacks on that hardware are a non-goal (threat model).

pub mod evidence;
pub mod flow;
pub mod gpu;
pub mod ita;
pub mod jwt;
pub mod measure;
pub mod report;
pub mod signature;
pub mod tdx;

pub use evidence::{Evidence, EvidenceSink};
pub use flow::{bind_answer, preflight, Trust, PREFLIGHT_BUDGET_MS};

/// Why an answer is not "AI verified". Fixed words only, so a reason can be printed and stored
/// without being escaped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unverified {
    NoNonce,
    NoClock,
    ReportUnavailable,
    ReportUnreadable,
    NoModelEvidence,
    NonceMismatch,
    CollateralUnavailable,
    CollateralStale,
    QuoteRejected,
    TcbNotAccepted,
    ReportDataLayout,
    EventLogMissing,
    RtmrReplayMismatch,
    BootRecordMissing,
    ConfigVersionUnknown,
    ComposeMismatch,
    DeployLogMismatch,
    GpuEvidenceMissing,
    GpuUnavailable,
    GpuTokenRejected,
    GpuNotTrusted,
    GatewayUnavailable,
    GatewayTokenRejected,
    GatewayLayout,
    WrongModel,
    AliasResolved,
    Streamed,
    SignatureUnavailable,
    SignatureUnreadable,
    GatewaySigned,
    SignatureInvalid,
    TextMismatch,
    SignerNotAttested,
    EvidenceNotPublished,
    Deadline,
}

impl Unverified {
    pub const ALL: [Unverified; 35] = [
        Unverified::NoNonce,
        Unverified::NoClock,
        Unverified::ReportUnavailable,
        Unverified::ReportUnreadable,
        Unverified::NoModelEvidence,
        Unverified::NonceMismatch,
        Unverified::CollateralUnavailable,
        Unverified::CollateralStale,
        Unverified::QuoteRejected,
        Unverified::TcbNotAccepted,
        Unverified::ReportDataLayout,
        Unverified::EventLogMissing,
        Unverified::RtmrReplayMismatch,
        Unverified::BootRecordMissing,
        Unverified::ConfigVersionUnknown,
        Unverified::ComposeMismatch,
        Unverified::DeployLogMismatch,
        Unverified::GpuEvidenceMissing,
        Unverified::GpuUnavailable,
        Unverified::GpuTokenRejected,
        Unverified::GpuNotTrusted,
        Unverified::GatewayUnavailable,
        Unverified::GatewayTokenRejected,
        Unverified::GatewayLayout,
        Unverified::WrongModel,
        Unverified::AliasResolved,
        Unverified::Streamed,
        Unverified::SignatureUnavailable,
        Unverified::SignatureUnreadable,
        Unverified::GatewaySigned,
        Unverified::SignatureInvalid,
        Unverified::TextMismatch,
        Unverified::SignerNotAttested,
        Unverified::EvidenceNotPublished,
        Unverified::Deadline,
    ];

    /// The reason as stored in the evidence record.
    pub fn code(self) -> &'static str {
        self.words().0
    }

    /// The reason as the verdict's explanation states it.
    pub fn note(self) -> &'static str {
        self.words().1
    }

    fn words(self) -> (&'static str, &'static str) {
        use Unverified::*;
        match self {
            NoNonce => ("no_nonce", "the run could not draw a fresh nonce"),
            NoClock => ("no_clock", "the run had no trusted clock"),
            ReportUnavailable => ("report_unavailable", "NEAR AI's attestation report could not be fetched"),
            ReportUnreadable => ("report_unreadable", "the attestation report was not readable"),
            NoModelEvidence => ("no_model_evidence", "the attestation report held no model evidence"),
            NonceMismatch => ("nonce_mismatch", "the evidence did not carry Kaap's fresh nonce"),
            CollateralUnavailable => ("collateral_unavailable", "Intel's collateral could not be fetched"),
            CollateralStale => ("collateral_stale", "Intel's collateral was expired or older than accepted"),
            QuoteRejected => ("quote_rejected", "the model's Intel TDX quote did not verify"),
            TcbNotAccepted => ("tcb_not_accepted", "the hardware's Intel TCB level is not one Kaap accepts"),
            ReportDataLayout => ("report_data_layout", "the model's quote did not bind its signing key"),
            EventLogMissing => ("event_log_missing", "the attestation report held no readable event log for the model"),
            RtmrReplayMismatch => ("rtmr_replay_mismatch", "the model's event log did not replay to its quote's RTMR3"),
            BootRecordMissing => ("boot_record_missing", "the model's boot measurements were missing, repeated or not as reported"),
            ConfigVersionUnknown => ("config_version_unknown", "the model's quote binds its launcher in a layout Kaap does not read"),
            ComposeMismatch => ("compose_mismatch", "the model's launcher configuration is not the one its quote binds"),
            DeployLogMismatch => ("deploy_log_mismatch", "the model's deployment log did not match its own quote"),
            GpuEvidenceMissing => ("gpu_evidence_missing", "the attestation report held no NVIDIA GPU evidence"),
            GpuUnavailable => ("gpu_unavailable", "NVIDIA's attestation service could not be used"),
            GpuTokenRejected => ("gpu_token_rejected", "NVIDIA's GPU token did not verify"),
            GpuNotTrusted => ("gpu_not_trusted", "NVIDIA did not pass the GPUs"),
            GatewayUnavailable => ("gateway_unavailable", "the gateway's Intel token could not be fetched"),
            GatewayTokenRejected => ("gateway_token_rejected", "the gateway's Intel token did not verify"),
            GatewayLayout => ("gateway_layout", "the gateway's Intel token did not bind its key and Kaap's nonce"),
            WrongModel => ("wrong_model", "another model answered"),
            AliasResolved => ("alias_resolved", "the answer came through a model alias"),
            Streamed => ("streamed", "the answer came back streamed"),
            SignatureUnavailable => ("signature_unavailable", "the answer's signature could not be fetched"),
            SignatureUnreadable => ("signature_unreadable", "the answer's signature was not readable"),
            GatewaySigned => ("gateway_signed", "the answer was signed by NEAR AI's gateway, not the model"),
            SignatureInvalid => ("signature_invalid", "the answer's signature did not verify"),
            TextMismatch => ("text_mismatch", "the signature covers other request or answer bytes"),
            SignerNotAttested => ("signer_not_attested", "the signer is not the one key a verified report named"),
            EvidenceNotPublished => ("evidence_not_published", "the evidence could not be published"),
            Deadline => ("deadline", "the checks ran out of time"),
        }
    }
}

/// The Intel TCB levels Kaap accepts (decided 23 Oct 2026, threat model C11). That day NEAR AI's
/// hardware reported OutOfDate with 10 Intel advisories; every verdict states which level it saw.
pub const ACCEPTED_TCB: [&str; 2] = ["UpToDate", "OutOfDate"];

pub fn tcb_accepted(status: &str) -> bool {
    ACCEPTED_TCB.contains(&status)
}

/// Tokens are minted during the run, after the request's block, so their `nbf` and `iat` may be up
/// to this far ahead of the clock. Freshness itself comes from the nonce, which every token must
/// carry; `exp` is the second line.
pub const CLOCK_LEEWAY_SECS: u64 = 180;

/// How far `NEAR_BLOCK_TIMESTAMP` may sit from the final block the job read. The request's block
/// is a few blocks from it either way.
const CLOCK_AGREEMENT_NS: u64 = 600 * 1_000_000_000;

/// The time every expiry is judged against, in Unix seconds.
///
/// `block_timestamp` is OutLayer's `NEAR_BLOCK_TIMESTAMP`, the time of the block that requested
/// the run, never a value from the input. Its unit is not documented, so it is taken as
/// nanoseconds only when it lands within ten minutes of `read_block_ns`, the final block the job
/// read from two agreeing providers: nanoseconds do, milliseconds and seconds never can. Missing
/// (an HTTPS-triggered run), not whole digits, or out of that window gives `NoClock`.
pub fn trusted_now(block_timestamp: Option<&str>, read_block_ns: u64) -> Result<u64, Unverified> {
    let text = block_timestamp.unwrap_or("");
    if text.is_empty() || text.len() > 20 || !text.bytes().all(|b| b.is_ascii_digit()) {
        return Err(Unverified::NoClock);
    }
    let ns: u64 = text.parse().map_err(|_| Unverified::NoClock)?;
    if ns.abs_diff(read_block_ns) > CLOCK_AGREEMENT_NS {
        return Err(Unverified::NoClock);
    }
    Ok(ns / 1_000_000_000)
}

/// The one decoder for every fixed-length hex value from upstream: an optional `0x`, either case,
/// exactly `N` bytes. Both sides of every comparison go through it (standard 2).
pub fn hex_array<const N: usize>(text: &str) -> Option<[u8; N]> {
    let digits = text.strip_prefix("0x").unwrap_or(text);
    let mut out = [0u8; N];
    hex::decode_to_slice(digits, &mut out).ok()?;
    Some(out)
}

/// `hex_array`'s rule for a value of any length, so both decoders read the same text alike.
pub fn hex_bytes(text: &str) -> Option<Vec<u8>> {
    hex::decode(text.strip_prefix("0x").unwrap_or(text)).ok()
}

/// A model key whose attestation passed every check before the completion was sent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedModel {
    pub signing_address: [u8; 32],
    pub tcb_status: String,
    pub advisory_ids: Vec<String>,
    pub gpus: usize,
}

