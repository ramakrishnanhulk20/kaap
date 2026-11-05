//! Verdict assembly, the risk rule (C9), signing and the 900-byte cap. Not covered here: the
//! guard's own checks on a verdict (WO-02a), the OutLayer keystore (the test key stands in for
//! it; the testnet runs in `RUNS.md` use the real one), and NEAR AI verification (WO-05).

mod common;

use common::*;
use kaap_core::{AiStatus, Severity};
use kaap_sealed::ai::AiRisk;
use kaap_sealed::verdict::{combine_risk, fit, rank, sign_and_render, SignFail, VerdictSigner};

const FLOORS: [Severity; 5] = [Severity::Low, Severity::Medium, Severity::High, Severity::Critical, Severity::Unknown];
const RISKS: [AiRisk; 4] = [AiRisk::Low, AiRisk::Medium, AiRisk::High, AiRisk::Critical];
const STATUSES: [AiStatus; 3] = [AiStatus::Verified, AiStatus::Unverified, AiStatus::Unavailable];

#[test]
fn the_ai_never_pushes_risk_below_the_floor() {
    for floor in FLOORS {
        assert_eq!(rank(combine_risk(floor, None)), rank(floor));
        for risk in RISKS {
            for status in STATUSES {
                let got = combine_risk(floor, Some((risk, status)));
                assert!(rank(got) >= rank(floor), "{floor:?} {risk:?} {status:?} gave {got:?}");
                assert_ne!(got, Severity::Unknown, "a verdict risk is always one of the four levels");
            }
        }
    }
}

#[test]
fn only_a_verified_answer_can_make_a_verdict_critical() {
    for floor in [Severity::Low, Severity::Medium, Severity::High, Severity::Unknown] {
        assert_eq!(combine_risk(floor, Some((AiRisk::Critical, AiStatus::Unverified))), Severity::High);
        assert_eq!(combine_risk(floor, Some((AiRisk::Critical, AiStatus::Unavailable))), if floor == Severity::Unknown { Severity::High } else { floor });
        assert_eq!(combine_risk(floor, Some((AiRisk::Critical, AiStatus::Verified))), Severity::Critical);
    }
    assert_eq!(combine_risk(Severity::Critical, Some((AiRisk::Low, AiStatus::Verified))), Severity::Critical);
    assert_eq!(combine_risk(Severity::Low, Some((AiRisk::Medium, AiStatus::Unverified))), Severity::Medium);
    assert_eq!(combine_risk(Severity::Medium, Some((AiRisk::High, AiStatus::Unavailable))), Severity::Medium);
}

#[test]
fn the_explanation_is_fitted_before_it_is_hashed_and_signed() {
    let long_name = format!("{}.testnet", "g".repeat(56));
    let quoted = format!("\"{}\"", "Quoted words, and more words. ".repeat(10));
    let quoted = &quoted[..280];
    let out = sign_and_render(verdict(&long_name, &long_name.replace('g', "d"), kaap_sealed::ai::MODEL_ID), quoted.to_string(), &mut TestSigner::new()).unwrap();
    let (v, json) = open(&out);
    let shown = json["explanation"].as_str().unwrap();
    assert!(shown.len() < quoted.len(), "the biggest verdict leaves less than 280 bytes");
    assert!(quoted.starts_with(shown));
    assert_eq!(v.guard, long_name);
    assert!(out.len() <= 900 && out.len() >= 890, "{} bytes: the cut uses the room there is", out.len());

    let short = sign_and_render(verdict("g.testnet", "d.testnet", ""), "Fine.".into(), &mut TestSigner::new()).unwrap();
    assert_eq!(open(&short).1["explanation"], "Fine.");
}

#[test]
fn a_verdict_too_big_for_the_output_is_not_signed() {
    struct Counting(TestSigner, usize);
    impl VerdictSigner for Counting {
        fn public_key(&mut self) -> Result<[u8; 32], SignFail> {
            self.0.public_key()
        }
        fn sign(&mut self, m: &[u8]) -> Result<[u8; 64], SignFail> {
            self.1 += 1;
            self.0.sign(m)
        }
    }
    let mut signer = Counting(TestSigner::new(), 0);
    let huge = verdict("g.testnet", "d.testnet", &"m".repeat(600));
    assert_eq!(sign_and_render(huge, "x".into(), &mut signer), Err("the verdict does not fit in 900 bytes"));
    assert_eq!(signer.1, 0, "nothing was signed");

    struct Broken;
    impl VerdictSigner for Broken {
        fn public_key(&mut self) -> Result<[u8; 32], SignFail> {
            Err(SignFail::PublicKey)
        }
        fn sign(&mut self, _: &[u8]) -> Result<[u8; 64], SignFail> {
            Err(SignFail::Signature)
        }
    }
    assert!(sign_and_render(verdict("g.testnet", "d.testnet", ""), "x".into(), &mut Broken).is_err());
}

#[test]
fn fitting_counts_json_escapes_and_never_splits_a_character() {
    assert_eq!(fit("abc", 3), "abc");
    assert_eq!(fit("abc", 2), "ab");
    assert_eq!(fit("a\"b", 3), "a\"", "a quote costs two bytes once escaped");
    assert_eq!(fit("a\"b", 2), "a");
    assert_eq!(fit("a\u{e9}", 2), "a");
    assert_eq!(fit("abc", 0), "");
}
