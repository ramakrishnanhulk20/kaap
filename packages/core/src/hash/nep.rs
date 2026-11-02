//! The two hashes a `v1.signer` payload can be checked against: a NEP-413 signed message and a
//! NEP-461 delegate action. Each is sha256 of a borsh `u32` tag followed by the borsh payload. The
//! tags keep the two kinds of signed bytes apart, so a message signed under one standard can never
//! be replayed as the other (NEP-461).

use borsh::BorshSerialize;
use sha2::{Digest, Sha256};

/// NEP-461's tag for off-chain messages, `2^31 + 413`.
pub const NEP413_TAG: u32 = (1u32 << 31) + 413;

/// NEP-461's tag for on-chain actions, `2^30 + 366` (NEP-366 delegate actions).
pub const NEP461_TAG: u32 = (1u32 << 30) + 366;

/// The NEP-413 payload in borsh field order.
#[derive(BorshSerialize)]
struct Nep413Payload<'a> {
    message: &'a str,
    nonce: &'a [u8; 32],
    recipient: &'a str,
    callback_url: Option<&'a str>,
}

/// sha256 of `borsh(NEP413_TAG) ++ borsh({message, nonce, recipient, callback_url})`, the bytes a
/// NEAR wallet signs for a NEP-413 message and the hash Trezu puts in `payload_v2`. `message` is
/// hashed exactly as given, so the caller must parse these same bytes (standard 2).
pub fn nep413_hash(message: &str, nonce: &[u8; 32], recipient: &str, callback_url: Option<&str>) -> [u8; 32] {
    let payload = Nep413Payload { message, nonce, recipient, callback_url };
    let mut bytes = NEP413_TAG.to_le_bytes().to_vec();
    payload
        .serialize(&mut bytes)
        .expect("borsh writes into a Vec without error");
    sha256(&bytes)
}

/// sha256 of `borsh(NEP461_TAG) ++ delegate_action`, where `delegate_action` is the borsh
/// `DelegateAction` exactly as received. The caller parses the same bytes (standard 2).
pub fn nep461_hash(delegate_action: &[u8]) -> [u8; 32] {
    let mut bytes = NEP461_TAG.to_le_bytes().to_vec();
    bytes.extend_from_slice(delegate_action);
    sha256(&bytes)
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(&Sha256::digest(bytes));
    out
}
