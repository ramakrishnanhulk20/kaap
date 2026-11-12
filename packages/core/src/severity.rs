//! The severity of every finding in context, from the table in guide v2.3 section 4. The fixed
//! part of the table is `kaap_verdict::severity::min_severity`, which the guard reads too, so the
//! guard and the analysis can never disagree on it.

use crate::types::{Effect, FindingCode, Severity};

pub use kaap_verdict::severity::min_severity;

/// The findings that measure a change of control on the two policies themselves. They count as
/// control whatever the effect fields show: a role name new in the policy, or a token or Everyone
/// role, gains or widens approving power without any listed member or permission change.
const CONTROL_FINDINGS: [FindingCode; 4] = [
    FindingCode::PolicyAddsApprover,
    FindingCode::PolicyLowersThreshold,
    FindingCode::PolicyReplacesRole,
    FindingCode::GuardWeakened,
];

/// Returns the severity guide section 4 fixes for `code`.
///
/// Every code has one severity, `min_severity`, except DESC_CONTRADICTS, which is critical when
/// any effect moves value or changes control and high otherwise. `codes` is every code found for
/// the same proposal. Control is read two ways and either one is enough: from the effect fields
/// (`changes_control`), and from the findings in `CONTROL_FINDINGS`, which are measured on the
/// policy before and after and so also see the grants no effect field records.
pub fn severity(code: FindingCode, effects: &[Effect], codes: &[FindingCode]) -> Severity {
    if code == FindingCode::DescContradicts
        && (effects.iter().any(|e| moves_value(e) || changes_control(e))
            || codes.iter().any(|c| CONTROL_FINDINGS.contains(c)))
    {
        return Severity::Critical;
    }
    min_severity(code)
}

/// The value-moving effects named in the DESC_CONTRADICTS row, and a swap, whose `gives` leave
/// the DAO. Wrap, staking, storage deposits and DeFi calls keep the funds with the DAO, so the
/// guide leaves them out.
pub fn moves_value(effect: &Effect) -> bool {
    matches!(
        effect,
        Effect::Transfer { .. }
            | Effect::TokenCallTransfer { .. }
            | Effect::IntentsWithdraw { .. }
            | Effect::IntentsTransfer { .. }
            | Effect::IntentsSwap { .. }
            | Effect::BulkPayment { .. }
    )
}

/// The control changes named in the DESC_CONTRADICTS row that the effect itself shows. The
/// changes only the measured findings show are not visible here; `severity` reads them from the
/// codes.
pub fn changes_control(effect: &Effect) -> bool {
    match effect {
        Effect::PolicyChange {
            members_added,
            members_removed,
            permissions_changed,
            vote_policy_changed,
            ..
        } => {
            members_added.iter().any(|m| m.approver)
                || members_removed.iter().any(|m| m.approver)
                || !permissions_changed.is_empty()
                || !vote_policy_changed.is_empty()
        }
        Effect::IntentsKeyChange { .. } | Effect::CodeUpgrade { .. } => true,
        _ => false,
    }
}
