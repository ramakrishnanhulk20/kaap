//! Every fixed word and phrase list the description check reads, in one place. Each is a list on
//! purpose: a description is free text, and no single predicate says what a sentence claims. The
//! lists only ever add a claim the code can then check against the effects; a phrase a list
//! misses leaves the text `vague`, which the AI judges, and the risk floor still applies (C9).
//! Every entry is lower case and is compared only after `text::fold`, the same normalisation the
//! description gets (standard 2).

/// Phrases addressed to a reviewer or a model rather than to the DAO's members (PROMPT_INJECTION).
/// It is a signal, not the defence: the AI sees every text as quoted data (C10), and the floor
/// stands whatever the AI says (C9). It misses paraphrases ("disregard what you were told",
/// "score this as fine") and other languages; the AI is the second line for those.
pub(super) const INJECTION_PHRASES: &[&str] = &[
    "ignore previous",
    "ignore all",
    "ignore the above",
    "ignore any previous",
    "disregard previous",
    "disregard all",
    "disregard the above",
    "forget previous",
    "forget all previous",
    "new instructions",
    "you are",
    "you're a",
    "as an ai",
    "as a language model",
    "rate this",
    "rate it",
    "mark this",
    "mark it",
    "classify this",
    "system prompt",
    "do not flag",
    "don't flag",
    "dont flag",
    "do not report",
    "pretend to be",
    "act as",
    "roleplay",
    "role-play",
    "<|",
    "|>",
    "[inst]",
    "[/inst]",
    "<<sys>>",
    "### system",
    "### instruction",
    "system:",
    "assistant:",
];

/// Texts that say by design that details are hidden (guide section 5, `hidden`). It misses a
/// confidential text worded another way, which then reads as `vague`.
pub(super) const HIDDEN_PHRASES: &[&str] =
    &["hidden for privacy", "details hidden", "details are hidden", "details kept hidden"];

/// The generic text a treasury app files for its own policy setup (ruling 25). It names no
/// member or number, so it is never a contradiction, and it is `matches` beside a policy change.
pub(super) const POLICY_TEMPLATES: &[&str] = &["set treasury policy to user configuration"];

/// Leading verbs that say a payment is made. Generic on their own (guide section 5: "transfer" or
/// "payment" alone is `vague`), so they never make a text `matches`; they count only when the
/// proposal makes no payment at all (ruling 28).
pub(super) const PAY_VERBS: &[&str] = &[
    "pay", "pays", "paying", "paid", "send", "sends", "sending", "sent", "transfer", "transfers",
    "transferring", "transferred", "refund", "refunds", "refunding", "refunded",
];

/// Payment words anywhere in the text (ruling 28). It misses other payment nouns ("salary",
/// "stipend", "bounty") and every other language; those texts stay `vague`.
pub(super) const PAYMENT_WORDS: &[&str] =
    &["payroll", "payout", "payouts", "reimburse", "reimburses", "reimbursement", "invoice", "invoices"];

/// Texts that say no value moves (ruling 28). It misses "free of charge", "zero cost" and the
/// like, and any number written as words.
pub(super) const NO_VALUE_PHRASES: &[&str] = &[
    "read-only",
    "read only",
    "view-only",
    "view only",
    "no funds",
    "no fund",
    "no value moves",
    "no tokens move",
    "gas only",
    "only gas",
    "no deposit",
];

/// Leading verbs that put funds into a venue the DAO keeps (ruling 28), and the noun that says
/// the same anywhere. It misses "allocate", "park", "top up" and others.
pub(super) const VENUE_VERBS: &[&str] = &["deposit", "deposits", "depositing", "move", "moves", "moving"];
pub(super) const VENUE_WORDS: &[&str] = &["rebalance", "rebalances", "rebalancing"];

/// Words that say one token is traded for another, so a second ticker in the text names what
/// comes back, not what is sent. It misses "buy", "sell" and "trade".
pub(super) const SWAP_WORDS: &[&str] =
    &["swap", "swaps", "swapping", "exchange", "exchanges", "convert", "converts", "converting"];

/// Phrases that say the final payee sits behind a 1Click deposit address, which the proposal
/// cannot show (guide section 5), so a named recipient is a note there, not a claim.
pub(super) const DEPOSIT_ADDRESS_PHRASES: &[&str] = &["deposit address", "1click"];

/// Texts that say only storage is registered (ruling 28). It misses "pay for storage" and other
/// wordings.
pub(super) const STORAGE_PHRASES: &[&str] =
    &["register storage", "registers storage", "storage registration", "storage register"];

/// Words that describe a rotation, one out and one in (ruling 28). It misses "swap out",
/// "change the signer" and other wordings.
pub(super) const ROTATION_WORDS: &[&str] =
    &["rotate", "rotates", "rotating", "rotation", "replace", "replaces", "replacing", "replacement"];

/// Words that call what is removed idle (ruling 28). Kaap's guard is active by construction, so
/// they contradict any change that fires GUARD_WEAKENED. It misses "dormant", "old", "stale".
pub(super) const CLEANUP_WORDS: &[&str] = &["inactive", "unused"];

/// Leading verbs with a narrow meaning, each tied to the effect types that can carry it. A verb
/// whose effect is there makes the text `matches`; a verb whose effect is absent beside a
/// different value or control effect is a contradiction. Synonyms outside the lists are missed.
pub(super) const ADD_VERBS: &[&str] = &["add", "adds", "adding"];
pub(super) const GRANT_VERBS: &[&str] = &["grant", "grants", "granting", "promote", "promotes", "promoting"];
pub(super) const REMOVE_VERBS: &[&str] = &["remove", "removes", "removing"];
pub(super) const UPGRADE_VERBS: &[&str] = &["upgrade", "upgrades", "upgrading"];
pub(super) const SWAP_VERBS: &[&str] = &["swap", "swaps", "swapping"];
pub(super) const STAKE_VERBS: &[&str] = &["stake", "stakes", "staking"];
pub(super) const UNSTAKE_VERBS: &[&str] = &["unstake", "unstakes", "unstaking"];
pub(super) const WITHDRAW_VERBS: &[&str] = &["withdraw", "withdraws", "withdrawing", "withdrawal"];
pub(super) const WRAP_VERBS: &[&str] = &["wrap", "wraps", "wrapping", "unwrap", "unwraps", "unwrapping"];

/// Words that name what a governance kind changes, each beside the effect that shows it.
pub(super) const CONFIG_WORDS: &[&str] = &["config", "configuration", "purpose", "logo", "theme"];
pub(super) const BOND_WORDS: &[&str] = &["bond", "duration", "period"];
pub(super) const THRESHOLD_WORDS: &[&str] = &["threshold", "thresholds"];
pub(super) const FACTORY_WORDS: &[&str] = &["auto_update", "auto-update", "autoupdate"];
pub(super) const VOTE_WORDS: &[&str] = &["signal", "signaling", "signalling"];

/// Method-name parts too general to show which call a text means.
pub(super) const GENERIC_METHOD_PARTS: &[&str] =
    &["add", "set", "get", "update", "new", "call", "execute", "run", "do", "asset", "the", "and", "for"];

/// The ticker a person writes, the exact contract it names (the tokens `decode::known` measures
/// lookalikes against), and its decimals. `near` is native NEAR. A ticker not here is not a
/// claim: "10 LiNEAR" or "5 REF" is read as nothing.
pub(super) const TOKENS: &[(&str, &str, u32)] = &[
    ("near", "near", 24),
    ("wnear", "wrap.near", 24),
    ("usdc", "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", 6),
    ("usdt", "usdt.tether-token.near", 6),
];

/// Native NEAR and wrapped NEAR are one asset one to one; a text that says NEAR for a wNEAR
/// payment, or the reverse, is not shown wrong.
pub(super) const NEAR_FAMILY: &[&str] = &["near", "wrap.near"];
