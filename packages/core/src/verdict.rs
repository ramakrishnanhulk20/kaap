//! The one encoding of a verdict that anyone signs or checks (C14): the sealed job signs these
//! bytes, the guard verifies the signature over them, and the CLI and the browser recompute them.

use borsh::BorshSerialize;

use crate::canonical::sha256;
use crate::types::Verdict;

/// Prepended to every encoded verdict so a signature over a verdict can never be passed off as
/// a signature over some other borsh value that happens to share its bytes.
pub const VERDICT_DOMAIN: &[u8] = b"kaap-verdict-v1\n";

/// The `Verdict::version` this layout encodes.
pub const VERDICT_VERSION: u8 = 1;

/// Returns `VERDICT_DOMAIN` followed by the borsh encoding of `v`, the exact bytes to sign.
///
/// Never panics in practice: borsh fails only on a string or list longer than `u32::MAX`, which
/// no verdict can hold inside wasm's 4 GiB of memory.
pub fn verdict_bytes(v: &Verdict) -> Vec<u8> {
    let mut out = VERDICT_DOMAIN.to_vec();
    v.serialize(&mut out)
        .expect("a verdict field is longer than borsh's u32 length limit");
    out
}

/// sha256 of `verdict_bytes(v)`: the id the guard records to refuse a second use.
pub fn verdict_hash(v: &Verdict) -> [u8; 32] {
    sha256(&verdict_bytes(v))
}
