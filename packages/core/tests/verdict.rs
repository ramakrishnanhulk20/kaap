// Checks the verdict encoding: the domain prefix, a borsh round trip, a byte layout built by hand
// so a reordered field or variant fails, and that every field changes the hash. It does not check
// signatures (the sealed job and the guard do) or that a contract decodes the same bytes
// (packages/contracts/tests/guard.rs does).

use borsh::BorshDeserialize;
use kaap_core::verdict::{verdict_bytes, verdict_hash, VERDICT_DOMAIN, VERDICT_VERSION};
use kaap_core::*;
use sha2::{Digest, Sha256};

fn sample() -> Verdict {
    Verdict {
        version: VERDICT_VERSION,
        guard: "guard.kaap.testnet".into(),
        network: Network::Testnet,
        dao: "demo.sputnik-dao.testnet".into(),
        proposal_id: 42,
        kind_hash: [1; 32],
        policy_hash: [2; 32],
        receivers_hash: [3; 32],
        block_height: 220_773_592,
        risk: Severity::Critical,
        floor: Severity::Critical,
        findings: vec![FindingCode::DescContradicts, FindingCode::PolicyAddsApprover],
        decoder_version: "0.1.0".into(),
        model_id: "deepseek-ai/DeepSeek-V3.1".into(),
        ai_status: AiStatus::Verified,
        explanation_hash: [4; 32],
        expires_at_ms: 1_793_000_000_000,
    }
}

#[test]
fn bytes_start_with_the_domain_prefix() {
    assert_eq!(VERDICT_DOMAIN, b"kaap-verdict-v1\n");
    assert!(verdict_bytes(&sample()).starts_with(b"kaap-verdict-v1\n"));
}

#[test]
fn encoding_round_trips() {
    let v = sample();
    let bytes = verdict_bytes(&v);
    let back = Verdict::try_from_slice(&bytes[VERDICT_DOMAIN.len()..]).unwrap();
    assert_eq!(back, v);
}

#[test]
fn byte_layout_is_pinned() {
    fn string(out: &mut Vec<u8>, s: &str) {
        out.extend_from_slice(&(s.len() as u32).to_le_bytes());
        out.extend_from_slice(s.as_bytes());
    }
    let mut want = b"kaap-verdict-v1\n".to_vec();
    want.push(1);
    string(&mut want, "guard.kaap.testnet");
    want.push(1); // Network::Testnet
    string(&mut want, "demo.sputnik-dao.testnet");
    want.extend_from_slice(&42u64.to_le_bytes());
    want.extend_from_slice(&[1; 32]);
    want.extend_from_slice(&[2; 32]);
    want.extend_from_slice(&[3; 32]);
    want.extend_from_slice(&220_773_592u64.to_le_bytes());
    want.push(3); // risk: Severity::Critical
    want.push(3); // floor: Severity::Critical
    want.extend_from_slice(&2u32.to_le_bytes());
    want.push(4); // FindingCode::DescContradicts
    want.push(5); // FindingCode::PolicyAddsApprover
    string(&mut want, "0.1.0");
    string(&mut want, "deepseek-ai/DeepSeek-V3.1");
    want.push(0); // AiStatus::Verified
    want.extend_from_slice(&[4; 32]);
    want.extend_from_slice(&1_793_000_000_000u64.to_le_bytes());
    assert_eq!(verdict_bytes(&sample()), want);
}

#[test]
fn enum_indexes_follow_declaration_order() {
    let one = |code: FindingCode| {
        let mut v = sample();
        v.findings = vec![code];
        let bytes = verdict_bytes(&v);
        let at = VERDICT_DOMAIN.len() + 1 + 4 + 18 + 1 + 4 + 24 + 8 + 96 + 8 + 2 + 4;
        bytes[at]
    };
    for (i, code) in FindingCode::ALL.into_iter().enumerate() {
        assert_eq!(one(code) as usize, i, "{code:?}");
    }
}

#[test]
fn hash_is_sha256_of_the_bytes_and_every_field_counts() {
    let base = sample();
    let digest = Sha256::digest(verdict_bytes(&base));
    assert_eq!(verdict_hash(&base).as_slice(), digest.as_slice());

    let edits: Vec<fn(&mut Verdict)> = vec![
        |v| v.version = 2,
        |v| v.guard.push('x'),
        |v| v.network = Network::Mainnet,
        |v| v.dao.push('x'),
        |v| v.proposal_id += 1,
        |v| v.kind_hash[0] ^= 1,
        |v| v.policy_hash[0] ^= 1,
        |v| v.receivers_hash[0] ^= 1,
        |v| v.block_height += 1,
        |v| v.risk = Severity::High,
        |v| v.floor = Severity::High,
        |v| {
            v.findings.pop();
        },
        |v| v.decoder_version.push('x'),
        |v| v.model_id.push('x'),
        |v| v.ai_status = AiStatus::Unverified,
        |v| v.explanation_hash[0] ^= 1,
        |v| v.expires_at_ms += 1,
    ];
    assert_eq!(edits.len(), 17, "one edit per Verdict field");
    for (i, edit) in edits.into_iter().enumerate() {
        let mut v = base.clone();
        edit(&mut v);
        assert_ne!(verdict_hash(&v), verdict_hash(&base), "field {i}");
    }
}
