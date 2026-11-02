//! The Sputnik releases the `sputnik-dao.near` factory publishes, each version label with its
//! code hash (ruling 29). Read with the view call `get_contracts_metadata` on `sputnik-dao.near`,
//! mainnet block 222693606 (hash 7zNaw9wW5qRejCHNeB3x8AkVw6JMntPPeQAjLCv2Yiat), on 2 Nov 2026
//! through rpc.mainnet.fastnear.com; near.drpc.org returned the same list at block 222693608.
//! The factory marks 2.1's commit as `UNOFFICIAL_SCRIPT_DATA`; it is kept because the factory
//! itself publishes it. A label not in this table is a note the proposal cannot show, never a
//! contradiction.

const SPUTNIK_RELEASES: [(&str, &str); 5] = [
    ("2.0", "8RMeZ5cXDap6TENxaJKtigRYf3n139iHmTRe8ZUNey6N"),
    ("2.1", "8jmhwSkNeAWCRqsr2KoD7d8BzDYorEz3a3iHuM9Gykrg"),
    ("3.0", "2Zof1Tyy4pMeJM48mDSi5ww2QQhTz97b9S8h6W6r4HnK"),
    ("3.1", "4zSoHkLjJWZm34Psd4Eq2WUXHELt6LxtKmUXpsZWAECp"),
    ("3.2", "DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF"),
];

/// The code hash the factory publishes for `label`, as its 32 bytes.
pub(super) fn code_hash(label: &str) -> Option<Vec<u8>> {
    let (_, hash) = SPUTNIK_RELEASES.iter().find(|(l, _)| *l == label)?;
    bs58::decode(hash).into_vec().ok()
}

/// A base58 code hash as its 32 bytes, through the same decoder as the table, or `None` when it
/// is not exactly 32 bytes of base58 (standard 2).
pub(super) fn hash_bytes(code_hash: &str) -> Option<Vec<u8>> {
    bs58::decode(code_hash).into_vec().ok().filter(|b| b.len() == 32)
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_published_hash_is_32_bytes() {
        for (label, hash) in super::SPUTNIK_RELEASES {
            assert_eq!(super::hash_bytes(hash).map(|b| b.len()), Some(32), "{label}");
        }
    }
}
