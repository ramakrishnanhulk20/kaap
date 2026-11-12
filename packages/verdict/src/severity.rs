//! The lowest severity of every finding, from the table in guide v2.3 section 4. kaap-core's
//! `severity::severity` adds the one rule that depends on the proposal and reads every other
//! code from here, so the guard and the analysis share one table.

use crate::types::{FindingCode, Severity};

/// The lowest severity `code` can have on any proposal: its fixed severity, and High for
/// DESC_CONTRADICTS, which only rises to critical beside an effect that moves value or changes
/// control. A signed verdict carries codes but no effects, so this is what the guard can know
/// about a finding, and it never rates one above what `severity` gives it in context. The match
/// has no wildcard arm, so adding a code will not compile until its severity is decided here.
///
/// PROMPT_INJECTION is high, not critical (decided 12 Nov 2026): words addressed to a model are
/// found by a fixed list that honest text can trip, and wording alone must never cause a veto. A
/// proposal carrying them still alerts every member, and still vetoes when another finding proves
/// a deception.
pub fn min_severity(code: FindingCode) -> Severity {
    use FindingCode::*;
    match code {
        HashMismatch | HashTextDangerous | PolicyDuplicateRoleNames => Severity::Critical,
        PromptInjection | DescContradicts | PolicyAddsApprover | PolicyLowersThreshold
        | PolicyReplacesRole | PolicyRemovesMember | PolicyBeforeUnknown | CodeUpgrade
        | IntentsKeyChange | GuardWeakened | UnknownCall | ArgsNotJson | UnknownValue
        | LookalikeToken | OtherRiskyKind => Severity::High,
        HashUnverified => Severity::Unknown,
        AttachedDeposit | CrossChainOut | NewRecipient | LargeAmount => Severity::Medium,
        EmptyDescription => Severity::Low,
    }
}
