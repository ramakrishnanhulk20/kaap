//! The NEAR account id rule, as nearcore's `AccountId` applies it, used wherever the decoder must
//! tell an account from other text. It covers syntax only. It does not say an account exists, and
//! it does not catch lookalike names; those surface through NEW_RECIPIENT (C3).

/// True when `id` is 2 to 64 characters of `a-z`, `0-9` and the separators `.`, `-`, `_`, with
/// no separator at either end and never two separators in a row. Implicit accounts (64 hex
/// characters, or `0x` and 40 hex characters) pass because they follow the same rule.
pub fn is_account_id(id: &str) -> bool {
    let b = id.as_bytes();
    let separator = |c: u8| matches!(c, b'.' | b'-' | b'_');
    (2..=64).contains(&b.len())
        && b.iter().all(|&c| c.is_ascii_lowercase() || c.is_ascii_digit() || separator(c))
        && !separator(b[0])
        && !separator(b[b.len() - 1])
        && !b.windows(2).any(|w| separator(w[0]) && separator(w[1]))
}

#[cfg(test)]
mod tests {
    use super::is_account_id;

    #[test]
    fn nearcore_syntax() {
        for good in [
            "proofoffinger.near",
            "11",
            "a.b-c_d.near",
            "0x82bafb7ac512c62160c218bf184a3823af60e9ad",
            "723c0032035062c2687e3ce07b82b5e17b9cd783ba027868c2d3f3f6bf26c794",
        ] {
            assert!(is_account_id(good), "{good}");
        }
        for bad in ["", "a", "Alice.near", "a..b", "a.-b", ".a", "a.", "a b", "émile.near", &"a".repeat(65)] {
            assert!(!is_account_id(bad), "{bad}");
        }
    }
}
