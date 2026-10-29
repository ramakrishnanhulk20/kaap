//! The fixed severity of every finding, from the table in guide v2.3 section 4.

use crate::types::{Effect, FindingCode, Severity};

/// Returns the severity guide section 4 fixes for `code`.
///
/// Every code has one severity except DESC_CONTRADICTS, which is critical when any effect moves
/// value or changes control and high otherwise. `codes` is every code found for the same
/// proposal: a GUARD_WEAKENED change counts as control, and that fact is a finding, not an
/// effect field. The match has no wildcard arm, so adding a code will not compile until its
/// severity is decided here.
pub fn severity(code: FindingCode, effects: &[Effect], codes: &[FindingCode]) -> Severity {
    use FindingCode::*;
    match code {
        HashMismatch | HashTextDangerous | PolicyDuplicateRoleNames | PromptInjection => {
            Severity::Critical
        }
        DescContradicts => {
            if effects.iter().any(|e| moves_value(e) || changes_control(e))
                || codes.contains(&GuardWeakened)
            {
                Severity::Critical
            } else {
                Severity::High
            }
        }
        PolicyAddsApprover | PolicyLowersThreshold | PolicyReplacesRole | PolicyRemovesMember
        | PolicyBeforeUnknown | CodeUpgrade | IntentsKeyChange | GuardWeakened | UnknownCall
        | ArgsNotJson | UnknownValue | LookalikeToken | OtherRiskyKind => Severity::High,
        HashUnverified => Severity::Unknown,
        AttachedDeposit | CrossChainOut | NewRecipient | LargeAmount => Severity::Medium,
        EmptyDescription => Severity::Low,
    }
}

/// The lowest severity `code` can have on any proposal: its fixed severity, and High for
/// DESC_CONTRADICTS, which only rises to critical beside an effect that moves value or changes
/// control. A signed verdict carries codes but no effects, so this is what the guard can know
/// about a finding, and it never rates one above what `severity` gives it in context.
pub fn min_severity(code: FindingCode) -> Severity {
    severity(code, &[], &[])
}

/// The value-moving effects named in the DESC_CONTRADICTS row. Wrap, staking, storage deposits
/// and DeFi calls keep the funds with the DAO, so the guide leaves them out.
pub fn moves_value(effect: &Effect) -> bool {
    matches!(
        effect,
        Effect::Transfer { .. }
            | Effect::TokenCallTransfer { .. }
            | Effect::IntentsWithdraw { .. }
            | Effect::IntentsTransfer { .. }
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
