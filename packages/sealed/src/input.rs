//! The one input the job accepts, read from stdin, and every check on it. Anything else is
//! refused before a single outside call is made (standard 4).

use base64::Engine as _;
use kaap_core::{Network, ProposalInput};
use near_account_id::AccountIdRef;
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::Value;

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
    /// Testnet only: corrupt the HTTPS read so the two providers disagree, to show the job holds.
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawEval<'a> {
    v: u8,
    op: String,
    network: String,
    #[serde(borrow)]
    input: &'a RawValue,
}

/// What a run is asked to do.
#[derive(Clone, Debug, PartialEq)]
pub enum Request {
    Judge(JobInput),
    /// `{"v":1,"op":"pubkey"}` on this network: print the job's text key, signed.
    TextKey(Network),
    /// `{"v":1,"op":"eval","network":...,"input":...}`: score a proposal handed in whole. Boxed,
    /// because a whole proposal is far larger than the other two.
    Eval(Box<EvalInput>),
}

/// An eval request after every check: the run's network, and the proposal exactly as kaap-core
/// will judge it. Nothing in it was read from the chain.
#[derive(Clone, Debug, PartialEq)]
pub struct EvalInput {
    pub network: Network,
    pub proposal: ProposalInput,
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
    NotTheEvalShape,
    NotAProposalInput,
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
            InputError::UnknownOp => "op must be pubkey or eval",
            InputError::TextFieldsNotPaired => "text_ciphertext and reply_key come together or not at all",
            InputError::BadTextCiphertext => "text_ciphertext is not base64",
            InputError::BadReplyKey => "reply_key is not 32 bytes of hex holding a usable X25519 public key",
            InputError::NotTheEvalShape => "an eval input is not {v,op,network,input}",
            InputError::NotAProposalInput => "input is not a kaap-core ProposalInput as serde writes it",
        }
    }
}

/// Parses and checks the raw stdin bytes as one of the things a run can do. An object whose `op`
/// is `eval` is an eval request, read by `parse_eval`. `{"v":1,"op":...}` is the key request, on
/// the network OutLayer says this run is on. Anything else is a judge input, read by `parse_input`
/// exactly as before eval mode existed.
pub fn parse_request(raw: &[u8], run_network: Option<&str>) -> Result<Request, InputError> {
    if raw.len() > MAX_INPUT_BYTES {
        return Err(InputError::TooLarge);
    }
    if names_eval(raw) {
        return parse_eval(raw, run_network).map(|input| Request::Eval(Box::new(input)));
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

/// True only for a JSON object whose `op` is the string `eval`. An input without that member,
/// arrays included, never reaches `parse_eval`, so every judge input reads as it always has.
fn names_eval(raw: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Map<String, Value>>(raw).is_ok_and(|object| object.get("op").and_then(Value::as_str) == Some("eval"))
}

/// Parses and checks an eval request: `{"v":1,"op":"eval","network":<the run's network>,"input":
/// <a kaap-core ProposalInput as serde writes it>}`.
///
/// The proposal is read by one reader, serde into `ProposalInput`, and the job writes no record
/// reader of its own. Strict on top of that: the input's JSON must equal the JSON serde writes for
/// what it read, compared as values by the same parser, so an unknown or missing field at any
/// depth, or a value read as something else, is refused (standard 2). Refuses as `parse_input`
/// does for the size, the version and the run's network. Only the run's network is checked here;
/// the proposal's own network is a fact kaap-core judges, as the answer key's mainnet and sandbox
/// records carry it. There is no text channel: the wrapper has no field for one.
pub fn parse_eval(raw: &[u8], run_network: Option<&str>) -> Result<EvalInput, InputError> {
    if raw.len() > MAX_INPUT_BYTES {
        return Err(InputError::TooLarge);
    }
    let wrapper: RawEval<'_> = serde_json::from_slice(raw).map_err(|_| InputError::NotTheEvalShape)?;
    if wrapper.v != 1 {
        return Err(InputError::UnknownVersion);
    }
    if wrapper.op != "eval" {
        return Err(InputError::UnknownOp);
    }
    let network = match wrapper.network.as_str() {
        "testnet" => Network::Testnet,
        "mainnet" => Network::Mainnet,
        _ => return Err(InputError::UnknownNetwork),
    };
    match run_network {
        None => return Err(InputError::RunNetworkUnset),
        Some(run) if run != wrapper.network => return Err(InputError::NetworkNotThisRun),
        Some(_) => {}
    }
    let text = wrapper.input.get();
    let proposal: ProposalInput = serde_json::from_str(text).map_err(|_| InputError::NotAProposalInput)?;
    let as_sent: Value = serde_json::from_str(text).map_err(|_| InputError::NotAProposalInput)?;
    let as_read = serde_json::to_value(&proposal).map_err(|_| InputError::NotAProposalInput)?;
    if as_sent != as_read {
        return Err(InputError::NotAProposalInput);
    }
    Ok(EvalInput { network, proposal })
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
