//! The one input the job accepts, read from stdin, and every check on it. Anything else is
//! refused before a single outside call is made (standard 4).

use kaap_core::Network;
use near_account_id::AccountIdRef;
use serde::Deserialize;

/// The real input is about 200 bytes; a NEAR account id is at most 64.
pub const MAX_INPUT_BYTES: usize = 1024;

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
}

impl InputError {
    pub fn reason(self) -> &'static str {
        match self {
            InputError::TooLarge => "input is over 1024 bytes",
            InputError::NotTheInputShape => "input is not {v,network,guard,dao,proposal_id,expires_in_ms}",
            InputError::UnknownVersion => "input v must be 1",
            InputError::UnknownNetwork => "network must be testnet or mainnet",
            InputError::NetworkNotThisRun => "network is not the network this run is on",
            InputError::RunNetworkUnset => "the run's network is not set",
            InputError::BadGuard => "guard is not a valid NEAR account id",
            InputError::BadDao => "dao is not a valid NEAR account id",
            InputError::ExpiryOutOfRange => "expires_in_ms must be 1 to 3600000",
            InputError::TestFlagOffTestnet => "test_corrupt_https is allowed on testnet only",
        }
    }
}

/// Parses and checks the raw stdin bytes.
///
/// `run_network` is the network OutLayer says this run is on (`NEAR_NETWORK_ID`). The input's
/// network must equal it, so a caller can never make the job sign a verdict for a network it did
/// not read (C20). Refuses: over `MAX_INPUT_BYTES`; anything but one JSON object with exactly the
/// six fields (plus the optional testnet flag), including duplicate keys and fractional or
/// negative numbers; `v` other than 1; a network other than testnet or mainnet; account ids
/// nearcore would refuse; `expires_in_ms` of 0 or over `MAX_EXPIRES_IN_MS`.
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
    Ok(JobInput {
        network,
        guard: input.guard,
        dao: input.dao,
        proposal_id: input.proposal_id,
        expires_in_ms: input.expires_in_ms,
        test_corrupt_https: input.test_corrupt_https,
    })
}
