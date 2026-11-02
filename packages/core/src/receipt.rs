//! Two fields of a verdict that are not about the proposal's bytes: which decoder judged it, and
//! the code of every contract executing it would run. Moved from the sealed job
//! (packages/sealed/src/verdict.rs line 18, and reads.rs lines 191 to 219), so the sealed job, the
//! CLI and the worker compute both from this one place and can check each other.

use sha2::{Digest, Sha256};

/// kaap-core's version. kaap-core and kaap-sealed both take the workspace version, so this is the
/// same text the sealed job has written into every verdict so far.
pub const DECODER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// sha256 of the borsh encoding of the (account, code hash) pairs sorted by account, then by code
/// hash: the DAO and every contract the kind calls, each with the code hash `view_account` gave at
/// the verdict's block. Borsh writes each string with its length, so no two lists share an
/// encoding. The pairs are sorted here, so a caller holding them in another order still gets the
/// hash the verdict carries.
pub fn receivers_hash(pairs: &[(String, String)]) -> [u8; 32] {
    let mut sorted = pairs.to_vec();
    sorted.sort();
    let bytes = borsh::to_vec(&sorted).expect("a pair list is far below borsh's length limit");
    let mut out = [0u8; 32];
    out.copy_from_slice(&Sha256::digest(&bytes));
    out
}
