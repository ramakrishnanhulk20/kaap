//! Pins the signed verdict bytes and the severity table to the values kaap-core computed at
//! commit 7148645, before this crate was split out of it, with one decided change since:
//! PROMPT_INJECTION is high, not critical, from 12 Nov 2026. Any other change to a field, a
//! variant order or a fixed severity fails here.
//!
//! Not covered: the canonical form of kinds and policies beyond how one number is written
//! (kaap-core's tests/canonical.rs), the context rule that raises DESC_CONTRADICTS to critical
//! (kaap-core's `severity`), and signature checks (kaap-sealed and the contract tests).

use kaap_verdict::severity::min_severity;
use kaap_verdict::{
    canonical_kind, verdict_bytes, verdict_hash, AiStatus, FindingCode, Network, Severity, Verdict,
};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn a_fixed_verdict_hashes_to_the_value_from_before_the_split() {
    let verdict = Verdict {
        version: 1,
        guard: "guard.kaap.testnet".into(),
        network: Network::Testnet,
        dao: "kaap-demo.sputnik-dao.testnet".into(),
        proposal_id: 7,
        kind_hash: [1; 32],
        policy_hash: [2; 32],
        receivers_hash: [3; 32],
        block_height: 123_456_789,
        risk: Severity::High,
        floor: Severity::Medium,
        findings: vec![FindingCode::UnknownCall, FindingCode::DescContradicts, FindingCode::LargeAmount],
        decoder_version: "kaap-core 0.1.0".into(),
        model_id: "none".into(),
        ai_status: AiStatus::Unverified,
        explanation_hash: [4; 32],
        expires_at_ms: 1_800_000_000_000,
    };
    assert_eq!(verdict_bytes(&verdict).len(), 262);
    assert_eq!(
        hex(&verdict_hash(&verdict)),
        "f5d4e7887d50d8ee39bfd39e5e7d3a9e2e7f41eef58d79c8785f8d2d21e67ad9"
    );
}

/// Pins serde_json's arbitrary_precision feature off, which any crate in the build can turn on.
/// With it on, whole numbers within 64 bits still arrive as integers, but a fraction or a whole
/// number beyond 64 bits reaches the canonical parser as a one-entry map instead of a float, so
/// the parser would take as an object a number it must refuse, and give its kind a hash.
#[test]
fn a_json_number_keeps_its_digits_and_one_beyond_64_bits_is_refused() {
    assert_eq!(canonical_kind(b"1").unwrap(), b"1");
    assert_eq!(canonical_kind(b"18446744073709551615").unwrap(), b"18446744073709551615");
    assert!(canonical_kind(b"18446744073709551616").is_err());
    assert!(canonical_kind(b"1.5").is_err());
}

#[test]
fn every_code_keeps_its_pinned_severity() {
    use FindingCode::*;
    let expected: [(FindingCode, Severity); 24] = [
        (HashMismatch, Severity::Critical),
        (HashTextDangerous, Severity::Critical),
        (PolicyDuplicateRoleNames, Severity::Critical),
        // Wording alone never causes a veto (decided 12 Nov 2026).
        (PromptInjection, Severity::High),
        (DescContradicts, Severity::High),
        (PolicyAddsApprover, Severity::High),
        (PolicyLowersThreshold, Severity::High),
        (PolicyReplacesRole, Severity::High),
        (PolicyRemovesMember, Severity::High),
        (PolicyBeforeUnknown, Severity::High),
        (CodeUpgrade, Severity::High),
        (IntentsKeyChange, Severity::High),
        (GuardWeakened, Severity::High),
        (UnknownCall, Severity::High),
        (ArgsNotJson, Severity::High),
        (UnknownValue, Severity::High),
        (LookalikeToken, Severity::High),
        (OtherRiskyKind, Severity::High),
        (HashUnverified, Severity::Unknown),
        (AttachedDeposit, Severity::Medium),
        (CrossChainOut, Severity::Medium),
        (NewRecipient, Severity::Medium),
        (LargeAmount, Severity::Medium),
        (EmptyDescription, Severity::Low),
    ];
    let listed: Vec<FindingCode> = expected.iter().map(|&(code, _)| code).collect();
    assert_eq!(listed, FindingCode::ALL, "the table above must list every code once, in order");
    for (code, severity) in expected {
        assert_eq!(min_severity(code), severity, "{code:?}");
    }
}
