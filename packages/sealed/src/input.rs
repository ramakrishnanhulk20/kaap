//! The one input the job accepts, read from stdin, and every check on it. Anything else is
//! refused before a single outside call is made (standard 4).

use base64::Engine as _;
use kaap_core::Network;
use near_account_id::AccountIdRef;
use serde::Deserialize;

use crate::texts::is_usable_key;

/// A public input is about 200 bytes. A sealed text takes the rest: 32 KiB is what OutLayer stores
/// for a request without charging for it (`INPUT_DATA_FREE_BYTES`), and base64 leaves about 24 KiB
/// of it for the text, where Trezu's longest, a 25-recipient bulk header, is a few kilobytes.
pub const MAX_INPUT_BYTES: usize = 32 * 1024;

/// One hour. A verdict lives only as long as the guard needs to cast its vote after the read.
pub const MAX_EXPIRES_IN_MS: u64 = 3_600_000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawInput {
    v: u8,
    network: String,
    guard: String,
    dao: String,
    proposal_id: u64,
    expires_in_ms: u64,
    /// Testnet only: corrupt the HTTPS read so the two providers disagree (DONE MEANS 3).
    #[serde(default)]
    test_corrupt_https: bool,
    /// Base64 of a text encrypted to the job's public key (`texts`). Comes with `reply_key`.
    #[serde(default)]
    text_ciphertext: Option<String>,
    /// Hex of the submitter's X25519 public key, which the explanation is encrypted to.
    #[serde(default)]
    reply_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawOp {
    v: u8,
    op: String,
}

/// What a run is asked to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Request {
    Judge(JobInput),
    /// `{"v":1,"op":"pubkey"}` on this network: print the job's text key, signed.
    TextKey(Network),
}

/// A text as it arrived: ciphertext only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SealedText {
    pub ciphertext: Vec<u8>,
    pub reply_key: [u8; 32],
}

/// The input after every check. Later steps only ever see these values.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JobInput {
    pub network: Network,
    pub guard: String,
    pub dao: String,
    pub proposal_id: u64,
    pub expires_in_ms: u64,
    pub test_corrupt_https: bool,
    pub text: Option<SealedText>,
}

/// Why an input was refused. Each reason is fixed text written here, never a fragment of the
/// input or of a parser message, so a refusal can be passed on without being escaped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputError {
    TooLarge,
    NotTheInputShape,
    UnknownVersion,
    UnknownNetwork,
    NetworkNotThisRun,
    RunNetworkUnset,
    BadGuard,
    BadDao,
    ExpiryOutOfRange,
    TestFlagOffTestnet,
    UnknownOp,
    TextFieldsNotPaired,
    BadTextCiphertext,
    BadReplyKey,
}

impl InputError {
    pub fn reason(self) -> &'static str {
        match self {
            InputError::TooLarge => "input is over 32768 bytes",
            InputError::NotTheInputShape => "input is not {v,network,guard,dao,proposal_id,expires_in_ms}",
            InputError::UnknownVersion => "input v must be 1",
            InputError::UnknownNetwork => "network must be testnet or mainnet",
            InputError::NetworkNotThisRun => "network is not the network this run is on",
            InputError::RunNetworkUnset => "the run's network is not set",
            InputError::BadGuard => "guard is not a valid NEAR account id",
            InputError::BadDao => "dao is not a valid NEAR account id",
            InputError::ExpiryOutOfRange => "expires_in_ms must be 1 to 3600000",
            InputError::TestFlagOffTestnet => "test_corrupt_https is allowed on testnet only",
            InputError::UnknownOp => "op must be pubkey",
            InputError::TextFieldsNotPaired => "text_ciphertext and reply_key come together or not at all",
            InputError::BadTextCiphertext => "text_ciphertext is not base64",
            InputError::BadReplyKey => "reply_key is not 32 bytes of hex holding a usable X25519 public key",
        }
    }
}

/// Parses and checks the raw stdin bytes as either thing a run can do. `{"v":1,"op":...}` is the
/// key request, on the network OutLayer says this run is on; anything else is a judge input, read
/// by `parse_input`.
pub fn parse_request(raw: &[u8], run_network: Option<&str>) -> Result<Request, InputError> {
    if raw.len() > MAX_INPUT_BYTES {
        return Err(InputError::TooLarge);
    }
    let Ok(op) = serde_json::from_slice::<RawOp>(raw) else {
        return parse_input(raw, run_network).map(Request::Judge);
    };
    if op.v != 1 {
        return Err(InputError::UnknownVersion);
    }
    if op.op != "pubkey" {
        return Err(InputError::UnknownOp);
    }
    match run_network {
        None => Err(InputError::RunNetworkUnset),
        Some("testnet") => Ok(Request::TextKey(Network::Testnet)),
        Some("mainnet") => Ok(Request::TextKey(Network::Mainnet)),
        Some(_) => Err(InputError::UnknownNetwork),
    }
}

/// Parses and checks the raw stdin bytes.
///
/// `run_network` is the network OutLayer says this run is on (`NEAR_NETWORK_ID`). The input's
/// network must equal it, so a caller can never make the job sign a verdict for a network it did
/// not read (C20). Refuses: over `MAX_INPUT_BYTES`; anything but one JSON object with exactly the
/// six fields (plus the optional testnet flag and the optional text pair), including duplicate
/// keys and fractional or negative numbers; `v` other than 1; a network other than testnet or
/// mainnet; account ids nearcore would refuse; `expires_in_ms` of 0 or over `MAX_EXPIRES_IN_MS`;
/// one of `text_ciphertext` and `reply_key` without the other; a ciphertext that is not base64; a
/// reply key that is not 32 bytes of hex, or is a low-order point anyone could read replies to.
/// Whether the ciphertext opens is decided later, by `texts::open_text`, which needs the keystore.
pub fn parse_input(raw: &[u8], run_network: Option<&str>) -> Result<JobInput, InputError> {
    if raw.len() > MAX_INPUT_BYTES {
        return Err(InputError::TooLarge);
    }
    let input: RawInput = serde_json::from_slice(raw).map_err(|_| InputError::NotTheInputShape)?;
    if input.v != 1 {
        return Err(InputError::UnknownVersion);
    }
    let network = match input.network.as_str() {
        "testnet" => Network::Testnet,
        "mainnet" => Network::Mainnet,
        _ => return Err(InputError::UnknownNetwork),
    };
    match run_network {
        None => return Err(InputError::RunNetworkUnset),
        Some(run) if run != input.network => return Err(InputError::NetworkNotThisRun),
        Some(_) => {}
    }
    AccountIdRef::new(&input.guard).map_err(|_| InputError::BadGuard)?;
    AccountIdRef::new(&input.dao).map_err(|_| InputError::BadDao)?;
    if input.expires_in_ms == 0 || input.expires_in_ms > MAX_EXPIRES_IN_MS {
        return Err(InputError::ExpiryOutOfRange);
    }
    if input.test_corrupt_https && network != Network::Testnet {
        return Err(InputError::TestFlagOffTestnet);
    }
    let text = sealed_text(input.text_ciphertext, input.reply_key)?;
    Ok(JobInput {
        network,
        guard: input.guard,
        dao: input.dao,
        proposal_id: input.proposal_id,
        expires_in_ms: input.expires_in_ms,
        test_corrupt_https: input.test_corrupt_https,
        text,
    })
}

fn sealed_text(ciphertext: Option<String>, reply_key: Option<String>) -> Result<Option<SealedText>, InputError> {
    let (ciphertext, reply_key) = match (ciphertext, reply_key) {
        (None, None) => return Ok(None),
        (Some(ciphertext), Some(reply_key)) => (ciphertext, reply_key),
        _ => return Err(InputError::TextFieldsNotPaired),
    };
    let ciphertext = base64::engine::general_purpose::STANDARD.decode(ciphertext).map_err(|_| InputError::BadTextCiphertext)?;
    let reply_key = hex::decode(reply_key).ok().and_then(|k| <[u8; 32]>::try_from(k).ok()).ok_or(InputError::BadReplyKey)?;
    if !is_usable_key(&reply_key) {
        return Err(InputError::BadReplyKey);
    }
    Ok(Some(SealedText { ciphertext, reply_key }))
}
