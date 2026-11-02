//! The severity of every finding in context, from the table in guide v2.3 section 4. The fixed
//! part of the table is `kaap_verdict::severity::min_severity`, which the guard reads too, so the
//! guard and the analysis can never disagree on it.

use crate::types::{Effect, FindingCode, Severity};

pub use kaap_verdict::severity::min_severity;

/// Returns the severity guide section 4 fixes for `code`.
///
/// Every code has one severity, `min_severity`, except DESC_CONTRADICTS, which is critical when
/// any effect moves value or changes control and high otherwise. `codes` is every code found for
/// the same proposal: a GUARD_WEAKENED change counts as control, and that fact is a finding, not
/// an effect field.
pub fn severity(code: FindingCode, effects: &[Effect], codes: &[FindingCode]) -> Severity {
    if code == FindingCode::DescContradicts
        && (effects.iter().any(|e| moves_value(e) || changes_control(e))
            || codes.contains(&FindingCode::GuardWeakened))
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
/// GUARD_WEAKENED case is not visible here; `severity` reads it from the codes.
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
