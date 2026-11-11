//! The model's own Intel TDX quote, checked inside the job with Phala's dcap-qvl 0.7.1 against
//! collateral the job fetched from Intel's PCS with four keyless calls (tried live on 23 Oct 2026).
//!
//! The collateral may come from anywhere: dcap-qvl checks Intel's signatures on it up to the Intel
//! root CA compiled into the crate, so a fetcher can never forge it. It can only hand over an
//! older genuine set, which `MIN_TCB_EVAL_DATA_NUMBER` and the expiry check refuse.

use core::time::Duration;

use chrono::DateTime;
use dcap_qvl::quote::Quote;
use dcap_qvl::verify::QuoteVerifier;
use dcap_qvl::{PckCertFlag, Policy, QuoteCollateralV3, QuotePolicy, TcbStatus};
use serde::Deserialize;
use serde_json::value::RawValue;

use super::{tcb_accepted, Unverified, CLOCK_LEEWAY_SECS};
use crate::net::{
    Deadline, Http, HttpFail, Limits, Method, Request, Response, INTEL_PCK_CRL, INTEL_QE_IDENTITY, INTEL_ROOT_CRL, INTEL_TCB_INFO,
};

/// Intel's TCB evaluation data number on 23 Oct and 2 Nov 2026 (TCB Info and QE Identity alike).
/// A set below it is genuine but older than one Kaap has seen, and may rate a platform better
/// than Intel does today.
pub const MIN_TCB_EVAL_DATA_NUMBER: u32 = 20;

/// Each PCS answer is under 6 KB of body plus a 2 KB certificate chain in a header.
pub const PCS_LIMITS: Limits = Limits {
    connect_ms: 5_000,
    first_byte_ms: 8_000,
    between_bytes_ms: 5_000,
    overall_ms: 10_000,
    max_body_bytes: 256 * 1024,
};

/// What a verified quote showed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuoteFacts {
    /// dcap-qvl's merged platform and QE status, for example `OutOfDate`.
    pub tcb_status: String,
    pub advisory_ids: Vec<String>,
    pub report_data: [u8; 64],
    pub eval_number: u32,
    /// The flags `policy` accepts without judging, as the PCK certificate states them.
    pub pck_flags: PckFlags,
    /// The TD's own measurements, read from the verified report: the firmware (MRTD), the
    /// launcher configuration hash dstack puts in MRCONFIGID, and the four runtime registers.
    pub mr_td: [u8; 48],
    pub mr_config_id: [u8; 48],
    pub rt_mr0: [u8; 48],
    pub rt_mr1: [u8; 48],
    pub rt_mr2: [u8; 48],
    pub rt_mr3: [u8; 48],
}

/// The PCK certificate's platform flags: `true`, `false`, or `absent` (a Processor CA
/// certificate carries none of them).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct PckFlags {
    pub smt_enabled: &'static str,
    pub cached_keys: &'static str,
    pub dynamic_platform: &'static str,
}

impl PckFlags {
    pub fn from_claims(pck: &dcap_qvl::PckIdentity) -> PckFlags {
        let word = |flag: PckCertFlag| match flag {
            PckCertFlag::True => "true",
            PckCertFlag::False => "false",
            PckCertFlag::Undefined => "absent",
        };
        PckFlags { smt_enabled: word(pck.smt_enabled), cached_keys: word(pck.cached_keys), dynamic_platform: word(pck.dynamic_platform) }
    }
}

/// How the job checks a quote: `check_quote` in every published build. Tests put a stand-in here
/// only where a real quote that binds a key they hold cannot exist.
pub type QuoteCheck = fn(&[u8], &QuoteCollateralV3, u64) -> Result<QuoteFacts, Unverified>;

/// The policy beyond Intel's signatures: the two TCB levels Kaap accepts with no time limit on
/// OutOfDate, and no set older than `MIN_TCB_EVAL_DATA_NUMBER`. dcap-qvl refuses a debug TD and a
/// revoked platform on its own. The PCK flags for SMT, cached keys and dynamic platforms are
/// allowed, as ruled on 2 Nov 2026: NEAR AI's own verification guide does not judge them. Each
/// run names them in its evidence (`QuoteFacts::pck_flags`).
pub fn policy(now: u64) -> QuotePolicy {
    let forever = Duration::from_secs(u64::MAX);
    QuotePolicy::strict(now)
        .allow_status(TcbStatus::OutOfDate)
        .platform_grace_period(forever)
        .qe_grace_period(forever)
        .min_tcb_eval_data_number(MIN_TCB_EVAL_DATA_NUMBER)
        .allow_dynamic_platform(true)
        .allow_cached_keys(true)
        .allow_smt(true)
}

/// Checks `quote` against `collateral` at `now` (Unix seconds).
///
/// In order: the collateral is current and recent enough (`collateral_fresh`, `CollateralStale`);
/// dcap-qvl verifies the quote, its PCK chain, both CRLs and Intel's signatures on the
/// collateral, and refuses a debug or service TD (`QuoteRejected`); the merged TCB status is
/// UpToDate or OutOfDate (`TcbNotAccepted`); `policy` holds (`CollateralStale`); and the report
/// is a TDX one. Returns the status, Intel's advisory ids, the 64 bytes of report data and the
/// TD's measurements.
pub fn check_quote(quote: &[u8], collateral: &QuoteCollateralV3, now: u64) -> Result<QuoteFacts, Unverified> {
    collateral_fresh(collateral, now)?;
    let claims = QuoteVerifier::new_prod()
        .verify_with_policy(quote, collateral, now, &QuotePolicy::claims_only(now))
        .map_err(|_| Unverified::QuoteRejected)?;
    let tcb_status = claims.tcb.status.to_string();
    if !tcb_accepted(&tcb_status) {
        return Err(Unverified::TcbNotAccepted);
    }
    policy(now).validate(&claims).map_err(|_| Unverified::CollateralStale)?;
    let report = claims.report.as_td10().ok_or(Unverified::QuoteRejected)?;
    Ok(QuoteFacts {
        tcb_status,
        advisory_ids: advisories(&claims.tcb.advisory_ids),
        report_data: report.report_data,
        eval_number: claims.tcb.eval_data_number,
        pck_flags: PckFlags::from_claims(&claims.platform.pck),
        mr_td: report.mr_td,
        mr_config_id: report.mr_config_id,
        rt_mr0: report.rt_mr0,
        rt_mr1: report.rt_mr1,
        rt_mr2: report.rt_mr2,
        rt_mr3: report.rt_mr3,
    })
}

/// Intel's advisory ids as `INTEL-SA-` and digits, at most 64 of them; anything else is dropped,
/// because these are printed and stored downstream (standard 3).
pub fn advisories(ids: &[String]) -> Vec<String> {
    let well_formed = |id: &&String| {
        id.strip_prefix("INTEL-SA-").is_some_and(|n| (1..=8).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_digit()))
    };
    ids.iter().filter(well_formed).take(64).cloned().collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Dates {
    issue_date: String,
    next_update: String,
    tcb_evaluation_data_number: u32,
}

/// The TCB Info and QE Identity are both in date at `now` and both at least
/// `MIN_TCB_EVAL_DATA_NUMBER`; otherwise `CollateralStale`. dcap-qvl refuses an expired set too,
/// with an error that does not say why; this check names it.
pub fn collateral_fresh(collateral: &QuoteCollateralV3, now: u64) -> Result<(), Unverified> {
    for signed in [&collateral.tcb_info, &collateral.qe_identity] {
        let dates: Dates = serde_json::from_str(signed).map_err(|_| Unverified::QuoteRejected)?;
        let seconds = |t: &str| DateTime::parse_from_rfc3339(t).ok().and_then(|d| u64::try_from(d.timestamp()).ok());
        let (Some(issued), Some(next)) = (seconds(&dates.issue_date), seconds(&dates.next_update)) else {
            return Err(Unverified::QuoteRejected);
        };
        if next <= now || issued > now.saturating_add(CLOCK_LEEWAY_SECS) || dates.tcb_evaluation_data_number < MIN_TCB_EVAL_DATA_NUMBER {
            return Err(Unverified::CollateralStale);
        }
    }
    Ok(())
}

/// The platform a quote's PCK certificate names: its FMSPC and its issuing CA (`platform` or
/// `processor`), which pick Intel's TCB Info and CRL. Unreadable gives `QuoteRejected`.
pub fn platform(quote: &[u8]) -> Result<([u8; 6], &'static str), Unverified> {
    let parsed = Quote::parse(quote).map_err(|_| Unverified::QuoteRejected)?;
    let fmspc = dcap_qvl::intel::quote_fmspc(&parsed).map_err(|_| Unverified::QuoteRejected)?;
    let ca = dcap_qvl::intel::quote_ca(&parsed).map_err(|_| Unverified::QuoteRejected)?;
    Ok((fmspc, ca.as_id_str()))
}

#[derive(Deserialize)]
struct TcbInfoBody {
    #[serde(rename = "tcbInfo")]
    signed: Box<RawValue>,
    signature: String,
}

#[derive(Deserialize)]
struct QeIdentityBody {
    #[serde(rename = "enclaveIdentity")]
    signed: Box<RawValue>,
    signature: String,
}

/// The collateral for one platform from Intel's PCS: the PCK CRL, the TDX TCB Info and QE
/// Identity (each with Intel's signature and certificate chain), and the root CA's CRL. The
/// signed JSON is kept as the exact bytes Intel sent, never re-serialised, because Intel's
/// signature covers those bytes. The PCK chain stays in the quote, where dcap-qvl reads it. Any
/// failed call, status other than 200, missing chain or unreadable body gives
/// `CollateralUnavailable`.
pub fn fetch_collateral(http: &mut dyn Http, fmspc: &[u8; 6], ca: &str, deadline: Deadline) -> Result<QuoteCollateralV3, Unverified> {
    if !matches!(ca, "platform" | "processor") {
        return Err(Unverified::CollateralUnavailable);
    }
    let pck = get(http, Pcs::PckCrl(ca), deadline)?;
    let tcb = get(http, Pcs::TcbInfo(fmspc), deadline)?;
    let qe = get(http, Pcs::QeIdentity, deadline)?;
    let root = get(http, Pcs::RootCrl, deadline)?;

    let tcb_body: TcbInfoBody = serde_json::from_slice(&tcb.body).map_err(|_| Unverified::CollateralUnavailable)?;
    let qe_body: QeIdentityBody = serde_json::from_slice(&qe.body).map_err(|_| Unverified::CollateralUnavailable)?;
    let signature = |hex_text: &str| hex::decode(hex_text).map_err(|_| Unverified::CollateralUnavailable);
    Ok(QuoteCollateralV3 {
        pck_crl_issuer_chain: chain(&pck, &["sgx-pck-crl-issuer-chain"])?,
        root_ca_crl: root.body,
        pck_crl: pck.body,
        tcb_info_issuer_chain: chain(&tcb, &["tcb-info-issuer-chain", "sgx-tcb-info-issuer-chain"])?,
        tcb_info: tcb_body.signed.get().to_string(),
        tcb_info_signature: signature(&tcb_body.signature)?,
        qe_identity_issuer_chain: chain(&qe, &["sgx-enclave-identity-issuer-chain"])?,
        qe_identity: qe_body.signed.get().to_string(),
        qe_identity_signature: signature(&qe_body.signature)?,
        pck_certificate_chain: None,
    })
}

enum Pcs<'a> {
    PckCrl(&'a str),
    TcbInfo(&'a [u8; 6]),
    QeIdentity,
    RootCrl,
}

/// Intel's header names for the certificate chains, as the PCS v4 API sends them.
const CHAIN_HEADERS: [&str; 4] =
    ["sgx-pck-crl-issuer-chain", "tcb-info-issuer-chain", "sgx-tcb-info-issuer-chain", "sgx-enclave-identity-issuer-chain"];

fn get(http: &mut dyn Http, which: Pcs<'_>, deadline: Deadline) -> Result<Response, Unverified> {
    if deadline.passed() {
        return Err(Unverified::Deadline);
    }
    let (endpoint, tail) = match which {
        Pcs::PckCrl(ca) => (INTEL_PCK_CRL, format!("?ca={ca}&encoding=der")),
        Pcs::TcbInfo(fmspc) => (INTEL_TCB_INFO, format!("?fmspc={}&update=standard", hex::encode_upper(fmspc))),
        Pcs::QeIdentity => (INTEL_QE_IDENTITY, "?update=standard".to_string()),
        Pcs::RootCrl => (INTEL_ROOT_CRL, String::new()),
    };
    let response = http
        .send(&Request {
            method: Method::Get,
            endpoint,
            tail: &tail,
            headers: &[],
            body: None,
            keep_headers: &CHAIN_HEADERS,
            limits: PCS_LIMITS.within(deadline),
        })
        .map_err(|fail| if fail == HttpFail::Timeout { Unverified::Deadline } else { Unverified::CollateralUnavailable })?;
    if response.status != 200 {
        return Err(Unverified::CollateralUnavailable);
    }
    Ok(response)
}

/// The first of `names` the response carried, URL-decoded into the PEM chain dcap-qvl reads.
fn chain(response: &Response, names: &[&str]) -> Result<String, Unverified> {
    let encoded = names.iter().find_map(|n| response.header(n)).ok_or(Unverified::CollateralUnavailable)?;
    urlencoding::decode(encoded).map(|c| c.into_owned()).map_err(|_| Unverified::CollateralUnavailable)
}

/// Collateral fetched once per platform per run.
#[derive(Default)]
pub struct CollateralCache {
    entries: Vec<(([u8; 6], &'static str), QuoteCollateralV3)>,
}

impl CollateralCache {
    /// The collateral for `quote`'s platform, fetched on first use.
    pub fn get(&mut self, http: &mut dyn Http, quote: &[u8], deadline: Deadline) -> Result<&QuoteCollateralV3, Unverified> {
        let platform = platform(quote)?;
        let at = match self.entries.iter().position(|(p, _)| *p == platform) {
            Some(at) => at,
            None => {
                let collateral = fetch_collateral(http, &platform.0, platform.1, deadline)?;
                self.entries.push((platform, collateral));
                self.entries.len() - 1
            }
        };
        Ok(&self.entries[at].1)
    }

    /// The collateral this run already fetched for `quote`'s platform, and never a new fetch:
    /// `None` when the platform is unreadable or not yet seen.
    pub fn cached(&self, quote: &[u8]) -> Option<&QuoteCollateralV3> {
        let platform = platform(quote).ok()?;
        self.entries.iter().find(|(p, _)| *p == platform).map(|(_, c)| c)
    }
}
