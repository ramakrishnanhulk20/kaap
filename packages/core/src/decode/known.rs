//! The exact accounts guide section 3 gives a known meaning to (C3). A method name means
//! something only on the exact account read from chain: a Burrow-shaped call on any other
//! account is an unknown call (ruling 10).

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
    fn staking_pool_needs_pattern_and_method() {
        assert_eq!(classify("astro-stakers.poolv1.near", "deposit_and_stake"), Known::StakingPool);
        assert_eq!(classify("figment.pool.near", "withdraw_all"), Known::StakingPool);
        assert_eq!(classify("figment.pool.near", "upgrade"), Known::Other);
        assert_eq!(classify(".poolv1.near", "stake"), Known::Other);
        assert_eq!(classify("a.b.poolv1.near", "stake"), Known::Other);
        assert_eq!(classify("poolv1.near", "stake"), Known::Other);
    }
}
