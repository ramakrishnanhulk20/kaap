//! The model's Intel TDX quote, checked locally with dcap-qvl against collateral fetched from
//! Intel's PCS (C11). Runs on dcap-qvl's own sample TDX quote, whose platform (FMSPC
//! B0C06F000000) is the one NEAR AI's hardware reports, and on collateral Intel served on
//! 23 Oct 2026. Not covered here: a NEAR quote (it needs the key; the first keyed testnet run
//! checks one) and how a refusal becomes the verdict's AI status (`attest_flow.rs`).

use kaap_sealed::attest::tdx::*;
use kaap_sealed::attest::Unverified;
use kaap_sealed::net::{Deadline, Http, HttpFail, Request, Response};
use serde_json::Value;

const QUOTE_HEX: &str = include_str!("fixtures/dcap-sample-tdx-quote.hex");
const COLLATERAL: &str = include_str!("fixtures/intel-collateral-2026-10-23.json");
/// When that collateral was fetched; every part of it was in date then.
const FETCHED_AT: u64 = 1_792_734_516;

fn quote() -> Vec<u8> {
    hex::decode(QUOTE_HEX).unwrap()
}

fn collateral() -> dcap_qvl::QuoteCollateralV3 {
    serde_json::from_str(COLLATERAL).unwrap()
}

#[test]
fn the_sample_quote_verifies_as_out_of_date_with_its_report_data() {
    let facts = check_quote(&quote(), &collateral(), FETCHED_AT).unwrap();
    assert_eq!(facts.tcb_status, "OutOfDate");
    assert_eq!(facts.eval_number, MIN_TCB_EVAL_DATA_NUMBER);
    assert!(facts.advisory_ids.iter().all(|a| a.starts_with("INTEL-SA-")) && !facts.advisory_ids.is_empty());
    assert_eq!(facts.report_data[..], quote()[568..632]);
    let flags = [facts.pck_flags.smt_enabled, facts.pck_flags.cached_keys, facts.pck_flags.dynamic_platform];
    println!("PCK flags of the sample platform (smt, cached keys, dynamic): {flags:?}");
    assert!(flags.iter().all(|f| ["true", "false", "absent"].contains(f)), "accepted, and named as read");
}

#[test]
fn a_changed_quote_byte_is_refused() {
    let mut q = quote();
    q[568] ^= 1;
    assert_eq!(check_quote(&q, &collateral(), FETCHED_AT), Err(Unverified::QuoteRejected));
    assert_eq!(check_quote(&q[..100], &collateral(), FETCHED_AT), Err(Unverified::QuoteRejected));
}

#[test]
fn collateral_past_its_next_update_is_stale() {
    let month_later = FETCHED_AT + 31 * 86_400;
    assert_eq!(check_quote(&quote(), &collateral(), month_later), Err(Unverified::CollateralStale));
    assert_eq!(collateral_fresh(&collateral(), month_later), Err(Unverified::CollateralStale));
    assert_eq!(collateral_fresh(&collateral(), FETCHED_AT), Ok(()));
}

#[test]
fn an_older_genuine_set_is_refused_and_a_forged_one_never_verifies() {
    let mut older = collateral();
    older.tcb_info = older.tcb_info.replace("\"tcbEvaluationDataNumber\":20", "\"tcbEvaluationDataNumber\":19");
    assert_ne!(older.tcb_info, collateral().tcb_info, "the fixture holds number 20");
    assert_eq!(check_quote(&quote(), &older, FETCHED_AT), Err(Unverified::CollateralStale));

    let mut forged = collateral();
    forged.tcb_info = forged.tcb_info.replace("\"OutOfDate\"", "\"UpToDate\"");
    assert_eq!(check_quote(&quote(), &forged, FETCHED_AT), Err(Unverified::QuoteRejected), "Intel's signature covers the status");
}

#[test]
fn the_policy_accepts_only_the_two_levels_kaap_chose() {
    use dcap_qvl::TcbStatus::*;
    let p = policy(FETCHED_AT);
    for (status, accepted) in [
        (UpToDate, true),
        (OutOfDate, true),
        (SWHardeningNeeded, false),
        (ConfigurationNeeded, false),
        (OutOfDateConfigurationNeeded, false),
        (Revoked, false),
    ] {
        assert_eq!(p.is_status_acceptable(status), accepted, "{status:?}");
        assert_eq!(kaap_sealed::attest::tcb_accepted(&status.to_string()), accepted, "{status:?}");
    }
}

#[test]
fn the_platform_comes_from_the_quotes_own_pck_certificate() {
    assert_eq!(platform(&quote()).unwrap(), ([0xB0, 0xC0, 0x6F, 0, 0, 0], "platform"));
    assert_eq!(platform(b"not a quote"), Err(Unverified::QuoteRejected));
}

/// Intel's PCS, answered from the saved collateral the way Intel serves it: CRLs as DER bodies,
/// signed JSON as `{"tcbInfo"|"enclaveIdentity": .., "signature": hex}`, chains URL-encoded in
/// headers.
struct Pcs {
    seen: Vec<String>,
    drop_header: bool,
}

impl Http for Pcs {
    fn send(&mut self, r: &Request<'_>) -> Result<Response, HttpFail> {
        let c = collateral();
        let url = format!("{}{}{}", r.endpoint.authority, r.endpoint.path, r.tail);
        self.seen.push(url.clone());
        let enc = |chain: &str| urlencoding::encode(chain).into_owned();
        let (body, header): (Vec<u8>, Option<(&str, String)>) = match r.endpoint.path {
            "/sgx/certification/v4/pckcrl" => (c.pck_crl.clone(), Some(("sgx-pck-crl-issuer-chain", enc(&c.pck_crl_issuer_chain)))),
            "/tdx/certification/v4/tcb" => (
                format!(r#"{{"tcbInfo":{},"signature":"{}"}}"#, c.tcb_info, hex::encode(&c.tcb_info_signature)).into_bytes(),
                Some(("tcb-info-issuer-chain", enc(&c.tcb_info_issuer_chain))),
            ),
            "/tdx/certification/v4/qe/identity" => (
                format!(r#"{{"enclaveIdentity":{},"signature":"{}"}}"#, c.qe_identity, hex::encode(&c.qe_identity_signature)).into_bytes(),
                Some(("sgx-enclave-identity-issuer-chain", enc(&c.qe_identity_issuer_chain))),
            ),
            "/IntelSGXRootCA.der" => (c.root_ca_crl.clone(), None),
            _ => return Err(HttpFail::NoAnswerRecorded),
        };
        let mut response = Response::new(200, body);
        if let Some((name, value)) = header.filter(|_| !self.drop_header) {
            assert!(r.keep_headers.contains(&name), "{name} is asked for");
            response.headers.push((name.to_string(), value));
        }
        Ok(response)
    }
}

#[test]
fn the_four_keyless_pcs_calls_rebuild_collateral_that_verifies() {
    let mut pcs = Pcs { seen: vec![], drop_header: false };
    let (fmspc, ca) = platform(&quote()).unwrap();
    let fetched = fetch_collateral(&mut pcs, &fmspc, ca, Deadline::after_ms(60_000)).unwrap();
    assert_eq!(
        pcs.seen,
        [
            "api.trustedservices.intel.com/sgx/certification/v4/pckcrl?ca=platform&encoding=der",
            "api.trustedservices.intel.com/tdx/certification/v4/tcb?fmspc=B0C06F000000&update=standard",
            "api.trustedservices.intel.com/tdx/certification/v4/qe/identity?update=standard",
            "certificates.trustedservices.intel.com/IntelSGXRootCA.der",
        ]
    );
    let saved = collateral();
    assert_eq!(fetched.tcb_info, saved.tcb_info, "the signed JSON is Intel's exact bytes");
    assert_eq!(fetched.qe_identity_issuer_chain, saved.qe_identity_issuer_chain);
    assert_eq!(check_quote(&quote(), &fetched, FETCHED_AT).unwrap().tcb_status, "OutOfDate");

    let mut cache = CollateralCache::default();
    let mut pcs = Pcs { seen: vec![], drop_header: false };
    cache.get(&mut pcs, &quote(), Deadline::after_ms(60_000)).unwrap();
    cache.get(&mut pcs, &quote(), Deadline::after_ms(60_000)).unwrap();
    assert_eq!(pcs.seen.len(), 4, "one platform is fetched once per run");
}

#[test]
fn a_missing_chain_or_a_refused_call_means_no_collateral() {
    let (fmspc, ca) = platform(&quote()).unwrap();
    let mut pcs = Pcs { seen: vec![], drop_header: true };
    assert_eq!(fetch_collateral(&mut pcs, &fmspc, ca, Deadline::after_ms(60_000)), Err(Unverified::CollateralUnavailable));
    let mut pcs = Pcs { seen: vec![], drop_header: false };
    assert_eq!(fetch_collateral(&mut pcs, &fmspc, "other", Deadline::after_ms(60_000)), Err(Unverified::CollateralUnavailable));
    assert!(pcs.seen.is_empty(), "an unknown CA is never put into a URL");

    struct Down;
    impl Http for Down {
        fn send(&mut self, _: &Request<'_>) -> Result<Response, HttpFail> {
            Ok(Response::new(503, vec![]))
        }
    }
    assert_eq!(fetch_collateral(&mut Down, &fmspc, ca, Deadline::after_ms(60_000)), Err(Unverified::CollateralUnavailable));
    let v: Value = serde_json::from_str(COLLATERAL).unwrap();
    assert!(v["tcb_info"].as_str().unwrap().contains("\"tcbEvaluationDataNumber\":20"));
}
