//! Turns the codes every module found into the final plain-code result: one finding per code,
//! the risk floor, and the veto fields of guide v2.3 sections 1 and 6.

use crate::severity::severity;
use crate::types::{Analysis, DescCheck, Effect, Finding, FindingCode, Severity};

/// Sputnik's policy label for RemoveMemberFromRole (`to_policy_label`, proposals.rs 130). The
/// Guard role is never given VoteReject on it, by design, so a DAO can always remove the guard.
pub const REMOVE_MEMBER_FROM_ROLE: &str = "remove_member_from_role";

/// Builds the `Analysis` for one proposal.
///
/// `codes` may hold duplicates and arrive in any order; the result has one finding per code in
/// the order of the guide's table, so the same facts always give the same findings list.
/// `kind_label` is the proposal's Sputnik policy label. The risk floor is the highest severity,
/// with UNKNOWN counted and reported as high, or low when nothing fired. `must_veto` is a
/// critical floor. `veto_allowed` needs a high or critical floor, a high or critical finding
/// other than HASH_UNVERIFIED (Ram's rule, 20 Oct 2026: an unverifiable hash alone never vetoes),
/// and a kind the Guard role can reject.
pub fn finish(
    effects: Vec<Effect>,
    mut codes: Vec<FindingCode>,
    desc: DescCheck,
    kind_label: &str,
) -> Analysis {
    codes.sort_unstable();
    codes.dedup();
    let findings: Vec<Finding> = codes
        .iter()
        .map(|&code| Finding { code, severity: severity(code, &effects, &codes) })
        .collect();

    let risk_floor = findings
        .iter()
        .map(|f| floor_rank(f.severity))
        .max()
        .map(severity_of_rank)
        .unwrap_or(Severity::Low);
    let must_veto = risk_floor == Severity::Critical;
    let backed_by_proof = findings.iter().any(|f| {
        f.code != FindingCode::HashUnverified
            && matches!(f.severity, Severity::High | Severity::Critical)
    });
    let veto_allowed = matches!(risk_floor, Severity::High | Severity::Critical)
        && backed_by_proof
        && kind_label != REMOVE_MEMBER_FROM_ROLE;

    Analysis { effects, findings, risk_floor, description_check: desc, must_veto, veto_allowed }
}

fn floor_rank(s: Severity) -> u8 {
    match s {
        Severity::Low => 0,
        Severity::Medium => 1,
        Severity::High | Severity::Unknown => 2,
        Severity::Critical => 3,
    }
}

fn severity_of_rank(rank: u8) -> Severity {
    match rank {
        0 => Severity::Low,
        1 => Severity::Medium,
        2 => Severity::High,
        _ => Severity::Critical,
    }
}
