//! The sealed text channel (C12, C26): a member hands Kaap the text behind a payment hash so that
//! only this program can read it, and gets the explanation back so that only they can read it.
//!
//! The job's X25519 key pair is never stored. Its secret is the `mac` of a fixed label under the
//! project's declared encryption key `texts`, the route OutLayer's SDK 0.2.1 offers, because the
//! SDK hands out no key (testnet runs, 23 to 26 Oct 2026): the same 32 bytes in every run with
//! the same project and caller, across versions, and no other program or caller can compute them.
//!
//! The encryption is the construction OutLayer's own secrets use, an ephemeral X25519 exchange,
//! HKDF-SHA256 and ChaCha20-Poly1305 (secrets page, "Security Model"), in the same bytes as its
//! dashboard's `eciesEncrypt`: `0x01 | ephemeral public key (32) | nonce (12) | ciphertext | tag
//! (16)`, under Kaap's own HKDF label. One thing is added: every ciphertext is bound through the
//! AEAD's associated data to the network, the DAO, the proposal and the member's reply key. Without
//! that, whoever holds a member's ciphertext, the worker included, could resubmit it with their own
//! reply key and read the explanation.
//!
//! What this does not cover: who the submitter is (anyone may encrypt to the public key, and a
//! text counts only when its hash equals the proposal's payload), and the checks behind the signed
//! public key, which say that the key the guard accepts vouches for it, not that the build is
//! honest: that rests on the run's attestation.

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, KeyInit, Nonce};
use hkdf::Hkdf;
use kaap_core::{Network, SuppliedText, TextStandard};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use x25519_dalek::{PublicKey, SharedSecret, StaticSecret};

use crate::input::{JobInput, SealedText};
use crate::output::sorted_json;
use crate::verdict::{public_key_text, VerdictSigner};

/// The encryption key declared in `manifest.json`.
pub const TEXTS_KEY_PATH: &str = "texts";
/// What the job's X25519 secret is the `mac` of. Changing it changes the job's key for good.
pub const X25519_LABEL: &[u8] = b"kaap-x25519-v1";
const HKDF_INFO: &[u8] = b"kaap-texts-v1";

/// In front of the job's X25519 public key in what the verdict key signs, so that signature can
/// never be read as a verdict's, whose bytes start with `kaap-verdict-v1\n`.
pub const TEXT_KEY_DOMAIN: &[u8] = b"kaap-text-key-v1\n";
const TEXT_DOMAIN: &str = "kaap-text-v1";
const EXPLANATION_DOMAIN: &str = "kaap-explanation-v1";

const FORMAT: u8 = 0x01;
const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;
/// How much longer a ciphertext is than its plaintext.
pub const ECIES_OVERHEAD: usize = 1 + 32 + NONCE_BYTES + TAG_BYTES;

/// In front of the base64 of a sealed explanation in the output. A public explanation always
/// starts `AI `, so a reader can tell the two apart.
pub const SEALED_PREFIX: &str = "sealed:";

/// Why the channel could not be used. Fixed words only, as every reason in this crate, and one
/// word for every way a ciphertext can fail to open, so a refusal says nothing about which it was.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextFail {
    KeyUnavailable,
    NoRandom,
    NotOpened,
    NotTheShape,
}

impl TextFail {
    pub fn reason(self) -> &'static str {
        match self {
            TextFail::KeyUnavailable => "the texts key is unavailable",
            TextFail::NoRandom => "no fresh random bytes for the encryption",
            TextFail::NotOpened => "text_ciphertext could not be opened",
            TextFail::NotTheShape => "the opened text is not {message,nonce,recipient,standard,quotes}",
        }
    }

    /// True when the caller's input is at fault, as opposed to this run.
    pub fn is_the_input(self) -> bool {
        matches!(self, TextFail::NotOpened | TextFail::NotTheShape)
    }
}

/// What the channel needs from a run: OutLayer's keystore and fresh randomness in a published
/// build, a stand-in in tests and the local build.
pub trait TextKeys {
    /// HMAC-SHA256 of `data` under the declared encryption key at `path`. Deterministic.
    fn mac(&mut self, path: &str, data: &[u8]) -> Result<[u8; 32], TextFail>;
    /// 32 fresh random bytes, or `None` when none could be drawn.
    fn random(&mut self) -> Option<[u8; 32]>;
}

fn secret(keys: &mut dyn TextKeys) -> Result<StaticSecret, TextFail> {
    keys.mac(TEXTS_KEY_PATH, X25519_LABEL).map(StaticSecret::from)
}

/// The job's X25519 public key.
pub fn text_public_key(keys: &mut dyn TextKeys) -> Result<[u8; 32], TextFail> {
    Ok(PublicKey::from(&secret(keys)?).to_bytes())
}

/// True when `key` is a public key an exchange can trust: not one of X25519's low-order points,
/// which force the shared secret to zero whatever the other side holds, so anyone could read what
/// is encrypted to them.
pub fn is_usable_key(key: &[u8; 32]) -> bool {
    StaticSecret::from([1u8; 32]).diffie_hellman(&PublicKey::from(*key)).was_contributory()
}

fn cipher_from(shared: &SharedSecret) -> Result<ChaCha20Poly1305, TextFail> {
    if !shared.was_contributory() {
        return Err(TextFail::NotOpened);
    }
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(None, shared.as_bytes()).expand(HKDF_INFO, &mut key).map_err(|_| TextFail::NotOpened)?;
    Ok(ChaCha20Poly1305::new(&Key::from(key)))
}

/// Encrypts `plaintext` to `recipient`, bound to `aad`, with a fresh ephemeral key and nonce.
pub fn ecies_encrypt(keys: &mut dyn TextKeys, recipient: &[u8; 32], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, TextFail> {
    let ephemeral = StaticSecret::from(keys.random().ok_or(TextFail::NoRandom)?);
    let nonce_bytes = keys.random().ok_or(TextFail::NoRandom)?;
    let nonce = Nonce::try_from(&nonce_bytes[..NONCE_BYTES]).map_err(|_| TextFail::NoRandom)?;
    let cipher = cipher_from(&ephemeral.diffie_hellman(&PublicKey::from(*recipient)))?;
    let sealed = cipher.encrypt(&nonce, Payload { msg: plaintext, aad }).map_err(|_| TextFail::NotOpened)?;
    let mut out = Vec::with_capacity(ECIES_OVERHEAD + plaintext.len());
    out.push(FORMAT);
    out.extend_from_slice(PublicKey::from(&ephemeral).as_bytes());
    out.extend_from_slice(&nonce_bytes[..NONCE_BYTES]);
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// Opens what `ecies_encrypt` produced for `secret`'s public key under the same `aad`. Every
/// failure is `NotOpened`: an unknown format, a short blob, a low-order ephemeral key, a changed
/// byte, another key, another `aad`.
pub fn ecies_decrypt(secret: &StaticSecret, blob: &[u8], aad: &[u8]) -> Result<Vec<u8>, TextFail> {
    if blob.len() < ECIES_OVERHEAD || blob[0] != FORMAT {
        return Err(TextFail::NotOpened);
    }
    let (ephemeral, rest) = blob[1..].split_at(32);
    let ephemeral = <[u8; 32]>::try_from(ephemeral).map_err(|_| TextFail::NotOpened)?;
    let (nonce, sealed) = rest.split_at(NONCE_BYTES);
    let nonce = Nonce::try_from(nonce).map_err(|_| TextFail::NotOpened)?;
    let cipher = cipher_from(&secret.diffie_hellman(&PublicKey::from(ephemeral)))?;
    cipher.decrypt(&nonce, Payload { msg: sealed, aad }).map_err(|_| TextFail::NotOpened)
}

fn network_word(network: Network) -> &'static str {
    match network {
        Network::Mainnet => "mainnet",
        Network::Testnet => "testnet",
        Network::Sandbox => "sandbox",
    }
}

fn bound_to(domain: &str, network: Network, dao: &str, proposal_id: u64, reply_key: &[u8; 32]) -> Vec<u8> {
    // Account ids and hex hold no line break, so no two contexts share these bytes. The reply key
    // comes from the decoded bytes, so an upper-case hex input cannot make the two sides differ.
    format!("{domain}\n{}\n{dao}\n{proposal_id}\n{}", network_word(network), hex::encode(reply_key)).into_bytes()
}

/// The associated data of a text sent to the job.
pub fn text_context(network: Network, dao: &str, proposal_id: u64, reply_key: &[u8; 32]) -> Vec<u8> {
    bound_to(TEXT_DOMAIN, network, dao, proposal_id, reply_key)
}

/// The associated data of an explanation sent back.
pub fn explanation_context(network: Network, dao: &str, proposal_id: u64, reply_key: &[u8; 32]) -> Vec<u8> {
    bound_to(EXPLANATION_DOMAIN, network, dao, proposal_id, reply_key)
}

/// The text inside a ciphertext. The fields and the base64 nonce are kaap-core-wasm's `TextInput`,
/// so a member sends the same object the CLI takes. For a NEP-461 text `message` is the base64 of
/// the delegate action, and `nonce` and `recipient` are read but unused.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawText {
    message: String,
    nonce: String,
    recipient: String,
    standard: TextStandard,
    #[serde(default)]
    quotes: Vec<String>,
}

/// Opens the input's text inside the enclave and reads it. Refuses what does not open and what
/// opens as anything but the one shape above, including a duplicate or unknown field. The text
/// returned goes to kaap-core and nowhere else.
pub fn open_text(keys: &mut dyn TextKeys, input: &JobInput, sealed: &SealedText) -> Result<SuppliedText, TextFail> {
    let aad = text_context(input.network, &input.dao, input.proposal_id, &sealed.reply_key);
    let opened = ecies_decrypt(&secret(keys)?, &sealed.ciphertext, &aad)?;
    let raw: RawText = serde_json::from_slice(&opened).map_err(|_| TextFail::NotTheShape)?;
    let nonce = STANDARD.decode(&raw.nonce).ok().and_then(|n| <[u8; 32]>::try_from(n).ok()).ok_or(TextFail::NotTheShape)?;
    Ok(SuppliedText { message: raw.message, nonce, recipient: raw.recipient, standard: raw.standard, quotes: raw.quotes })
}

/// How many bytes of plain explanation fit when `budget` bytes of output are free for its sealed
/// form: the prefix, then base64, which writes 3 bytes as 4 characters.
pub fn sealed_room(budget: usize) -> usize {
    (budget.saturating_sub(SEALED_PREFIX.len()) / 4 * 3).saturating_sub(ECIES_OVERHEAD)
}

/// `explanation` as the output prints it for a member: `sealed:<base64>`, encrypted to their reply
/// key and bound to this proposal.
pub fn seal_explanation(keys: &mut dyn TextKeys, input: &JobInput, reply_key: &[u8; 32], explanation: &str) -> Result<String, TextFail> {
    let aad = explanation_context(input.network, &input.dao, input.proposal_id, reply_key);
    let blob = ecies_encrypt(keys, reply_key, explanation.as_bytes(), &aad)?;
    Ok(format!("{SEALED_PREFIX}{}", STANDARD.encode(blob)))
}

#[derive(Serialize)]
struct PublishedKey<'a> {
    v: u8,
    status: &'static str,
    text_key: String,
    signature: String,
    public_key: &'a str,
}

/// The answer to `{"v":1,"op":"pubkey"}`: `{"v":1,"status":"ok","text_key":<hex>,"signature":<base64>,
/// "public_key":"ed25519:<base58>"}`, where `signature` is the verdict key's over `TEXT_KEY_DOMAIN`
/// followed by the 32 key bytes. A submitter checks it against the key the guard accepts, so a relay
/// cannot swap in a key of its own. Fails, with no signature, when either key cannot be had.
pub fn render_text_key(keys: &mut dyn TextKeys, signer: &mut dyn VerdictSigner) -> Result<String, &'static str> {
    let key = text_public_key(keys).map_err(TextFail::reason)?;
    let public_key = public_key_text(signer)?;
    let mut message = TEXT_KEY_DOMAIN.to_vec();
    message.extend_from_slice(&key);
    let signature = signer.sign(&message).map_err(|_| "the signature could not be made")?;
    sorted_json(&PublishedKey {
        v: 1,
        status: "ok",
        text_key: hex::encode(key),
        signature: STANDARD.encode(signature),
        public_key: &public_key,
    })
    .map_err(|_| "the output could not be written")
}
