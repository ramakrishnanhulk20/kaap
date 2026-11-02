//! The exact accounts guide section 3 gives a known meaning to (C3), and the exact token
//! contracts LOOKALIKE_TOKEN compares against. A method name means something only on the exact
//! account read from chain: a Burrow-shaped call on any other account is an unknown call (ruling
//! 10). Anything not in these tables is `Other`, which the decoder turns into an unknown call
//! unless the call is a standard token method on the token itself (standard 1: a missing entry
//! produces an alert, not a pass).

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Known {
    Intents,
    Wrap,
    Signer,
    BulkPayment,
    Defi(DefiProtocol),
    StakingPool,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DefiProtocol {
    Burrow,
    RefV2,
    RefDcl,
}

impl DefiProtocol {
    /// The `protocol` name a `defi_call` effect carries.
    pub fn name(self) -> &'static str {
        match self {
            DefiProtocol::Burrow => "burrow",
            DefiProtocol::RefV2 => "ref-finance",
            DefiProtocol::RefDcl => "ref-dcl",
        }
    }
}

/// The token contracts an imitation is measured against (guide section 4, LOOKALIKE_TOKEN), each
/// with the ticker a person would write for it: native USDC, native USDT and wrapped NEAR.
const KNOWN_TOKENS: [(&str, &str); 3] = [
    ("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "usdc"),
    ("usdt.tether-token.near", "usdt"),
    ("wrap.near", "wnear"),
];

/// Two single-character edits catch a changed, dropped or added character, and a swap of two
/// neighbours, in a 64-character id.
const LOOKALIKE_EDITS: usize = 2;

/// True when `token` (an id as the guide writes it) imitates a known token without being its
/// real contract: one of its `.`-separated labels is a known ticker in any case (`usdc`,
/// `usdc.fakemint.near`, `usdt.tether-near.near`), or it is within two single-character edits of
/// a known token's id (native USDC with its last hex digit changed).
///
/// It does not catch a ticker inside a longer label (`myusdc.near`), imitations of tokens outside
/// `KNOWN_TOKENS`, or the testnet stablecoins, which read as lookalikes on testnet.
pub fn is_lookalike(token: &str) -> bool {
    if KNOWN_TOKENS.iter().any(|(id, _)| *id == token) {
        return false;
    }
    let ticker_label = token
        .split('.')
        .any(|label| KNOWN_TOKENS.iter().any(|(_, ticker)| label.eq_ignore_ascii_case(ticker)));
    ticker_label || KNOWN_TOKENS.iter().any(|(id, _)| within_edits(token.as_bytes(), id.as_bytes(), LOOKALIKE_EDITS))
}

/// Levenshtein distance at most `max`, in O(len) memory. Lengths further apart than `max` cannot
/// be within it, which also bounds the work on long attacker-written ids.
fn within_edits(a: &[u8], b: &[u8], max: usize) -> bool {
    if a.len().abs_diff(b.len()) > max {
        return false;
    }
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    for (i, &ca) in a.iter().enumerate() {
        let mut current = Vec::with_capacity(b.len() + 1);
        current.push(i + 1);
        for (j, &cb) in b.iter().enumerate() {
            let substitute = previous[j] + usize::from(ca != cb);
            current.push(substitute.min(previous[j + 1] + 1).min(current[j] + 1));
        }
        previous = current;
    }
    previous[b.len()] <= max
}

/// The one table of exact accounts. `v1.signer-prod.testnet` is the testnet Chain Signatures
/// contract the M1 slice signs against.
const EXACT_ACCOUNTS: [(&str, Known); 8] = [
    ("intents.near", Known::Intents),
    ("wrap.near", Known::Wrap),
    ("v1.signer", Known::Signer),
    ("v1.signer-prod.testnet", Known::Signer),
    ("bulkpayment.near", Known::BulkPayment),
    ("contract.main.burrow.near", Known::Defi(DefiProtocol::Burrow)),
    ("v2.ref-finance.near", Known::Defi(DefiProtocol::RefV2)),
    ("dclv2.ref-labs.near", Known::Defi(DefiProtocol::RefDcl)),
];

/// Pool accounts are made by the `poolv1.near` and `pool.near` factories as direct children,
/// so exactly one label in front of the suffix.
const POOL_SUFFIXES: [&str; 2] = [".poolv1.near", ".pool.near"];

/// The staking-pool contract's methods that map to the guide's four staking ops (stake,
/// unstake, withdraw, deposit). Owner methods such as `upgrade` on a pool stay `Other`, so they
/// surface as unknown calls.
const STAKING_POOL_METHODS: [&str; 8] = [
    "deposit",
    "deposit_and_stake",
    "stake",
    "stake_all",
    "unstake",
    "unstake_all",
    "withdraw",
    "withdraw_all",
];

/// Classifies a FunctionCall receiver. Exact accounts are matched byte for byte and their
/// meaning does not depend on `method`; the decoder that handles each one checks the method.
/// `StakingPool` needs both a pool account and a standard staking-pool method. Anything else is
/// `Other`.
pub fn classify(receiver: &str, method: &str) -> Known {
    if let Some((_, known)) = EXACT_ACCOUNTS.iter().find(|(account, _)| *account == receiver) {
        return *known;
    }
    let is_pool = POOL_SUFFIXES.iter().any(|suffix| {
        receiver
            .strip_suffix(suffix)
            .is_some_and(|name| !name.is_empty() && !name.contains('.'))
    });
    if is_pool && STAKING_POOL_METHODS.contains(&method) {
        Known::StakingPool
    } else {
        Known::Other
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_accounts_only() {
        assert_eq!(classify("wrap.near", "near_deposit"), Known::Wrap);
        assert_eq!(classify("v1.signer-prod.testnet", "sign"), Known::Signer);
        assert_eq!(classify("contract.main.burrow.near", "execute"), Known::Defi(DefiProtocol::Burrow));
        assert_eq!(classify("burrow.near", "execute"), Known::Other);
        assert_eq!(classify("fake.wrap.near", "near_deposit"), Known::Other);
        assert_eq!(classify("WRAP.near", "near_deposit"), Known::Other);
    }

    #[test]
    fn lookalikes_of_the_known_tokens() {
        for fake in [
            "usdc",
            "USDC.near",
            "usdc.fakemint.near",
            "usdt.tether-near.near",
            "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a2",
            "wrap.nearr",
            "wnear.near",
        ] {
            assert!(is_lookalike(fake), "{fake}");
        }
        for real in [
            "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
            "usdt.tether-token.near",
            "wrap.near",
            "lsd-usdt.rhealab.near",
            "eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
            "near",
        ] {
            assert!(!is_lookalike(real), "{real}");
        }
    }

    #[test]
    fn staking_pool_needs_pattern_and_method() {
        assert_eq!(classify("astro-stakers.poolv1.near", "deposit_and_stake"), Known::StakingPool);
        assert_eq!(classify("figment.pool.near", "withdraw_all"), Known::StakingPool);
        assert_eq!(classify("figment.pool.near", "upgrade"), Known::Other);
        assert_eq!(classify(".poolv1.near", "stake"), Known::Other);
        assert_eq!(classify("a.b.poolv1.near", "stake"), Known::Other);
        assert_eq!(classify("poolv1.near", "stake"), Known::Other);
    }
}
