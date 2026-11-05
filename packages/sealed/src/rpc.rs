//! Reading NEAR state through one provider. `RpcProvider` speaks NEAR JSON-RPC over HTTPS; the
//! OutLayer host's own RPC is wrapped in the same `Provider` trait (`host.rs`), so the two-provider
//! comparison in `reads.rs` treats both alike.
//!
//! Answers are parsed into fixed structs, so a duplicate key, a byte value over 255 or a missing
//! field is a failed read rather than a guess (standard 4). Upstream error text is dropped.

use base64::Engine as _;
use serde::de::{DeserializeOwned, IgnoredAny};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::net::{Deadline, Endpoint, Http, HttpFail, Limits, Method, Request};

/// The largest view result read. A real Sputnik proposal or policy is a few tens of KiB;
/// kaap-core refuses a kind or policy over 256 KiB anyway.
pub const MAX_VIEW_BYTES: usize = 512 * 1024;

/// JSON-RPC writes each result byte as up to four characters ("255,"), so the body cap is four
/// times the result cap plus room for the envelope.
pub const RPC_LIMITS: Limits = Limits {
    connect_ms: 5_000,
    first_byte_ms: 10_000,
    between_bytes_ms: 5_000,
    overall_ms: 15_000,
    max_body_bytes: 4 * MAX_VIEW_BYTES + 64 * 1024,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum At {
    Final,
    Height(u64),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ViewResult {
    pub bytes: Vec<u8>,
    /// `None` from the OutLayer host, whose `view` returns only the result bytes.
    pub block_height: Option<u64>,
    pub block_hash: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountView {
    /// Base58 of the 32-byte sha256 of the account's contract, as NEAR writes it.
    pub code_hash: String,
    pub block_height: u64,
    pub block_hash: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlockView {
    pub height: u64,
    pub hash: String,
    pub timestamp_ns: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadFail {
    Transport(HttpFail),
    Status,
    NotJson,
    RpcError,
    Shape,
    TooLarge,
}

pub trait Provider {
    /// A view call. `args_json` is the exact JSON the contract receives.
    fn call_function(&mut self, account: &str, method: &str, args_json: &str, at: At) -> Result<ViewResult, ReadFail>;
    fn view_account(&mut self, account: &str, at: At) -> Result<AccountView, ReadFail>;
    fn block(&mut self, at: At) -> Result<BlockView, ReadFail>;
}

/// NEAR JSON-RPC over the `Http` it is given, to one fixed endpoint.
pub struct RpcProvider<H> {
    http: H,
    endpoint: Endpoint,
    deadline: Deadline,
}

impl<H: Http> RpcProvider<H> {
    pub fn new(http: H, endpoint: Endpoint, deadline: Deadline) -> Self {
        RpcProvider { http, endpoint, deadline }
    }

    fn post(&mut self, method: &str, params: Value) -> Result<Vec<u8>, ReadFail> {
        if self.deadline.passed() {
            return Err(ReadFail::Transport(HttpFail::Timeout));
        }
        let body = json!({ "jsonrpc": "2.0", "id": "kaap", "method": method, "params": params }).to_string();
        let request = Request {
            method: Method::Post,
            endpoint: self.endpoint,
            tail: "",
            headers: &[("content-type", "application/json"), ("accept", "application/json")],
            body: Some(body.as_bytes()),
            keep_headers: &[],
            limits: RPC_LIMITS.within(self.deadline),
        };
        let response = self.http.send(&request).map_err(ReadFail::Transport)?;
        if response.status != 200 {
            return Err(ReadFail::Status);
        }
        Ok(response.body)
    }
}

impl<H: Http> Provider for RpcProvider<H> {
    fn call_function(&mut self, account: &str, method: &str, args_json: &str, at: At) -> Result<ViewResult, ReadFail> {
        let mut params = json!({
            "request_type": "call_function",
            "account_id": account,
            "method_name": method,
            "args_base64": base64::engine::general_purpose::STANDARD.encode(args_json.as_bytes()),
        });
        pin(&mut params, at);
        call_function_answer(&self.post("query", params)?)
    }

    fn view_account(&mut self, account: &str, at: At) -> Result<AccountView, ReadFail> {
        let mut params = json!({ "request_type": "view_account", "account_id": account });
        pin(&mut params, at);
        view_account_answer(&self.post("query", params)?)
    }

    fn block(&mut self, at: At) -> Result<BlockView, ReadFail> {
        let mut params = json!({});
        pin(&mut params, at);
        block_answer(&self.post("block", params)?)
    }
}

fn pin(params: &mut Value, at: At) {
    if let Value::Object(map) = params {
        match at {
            At::Final => map.insert("finality".into(), json!("final")),
            At::Height(h) => map.insert("block_id".into(), json!(h)),
        };
    }
}

#[derive(Deserialize)]
struct Envelope<T> {
    result: Option<T>,
    error: Option<IgnoredAny>,
}

#[derive(Deserialize)]
struct CallFunctionResult {
    result: Option<Vec<u8>>,
    error: Option<IgnoredAny>,
    block_height: u64,
    block_hash: String,
}

#[derive(Deserialize)]
struct ViewAccountResult {
    code_hash: Option<String>,
    error: Option<IgnoredAny>,
    block_height: u64,
    block_hash: String,
}

#[derive(Deserialize)]
struct BlockResult {
    header: BlockHeader,
}

#[derive(Deserialize)]
struct BlockHeader {
    height: u64,
    hash: String,
    timestamp: u64,
}

fn envelope<T: DeserializeOwned>(body: &[u8]) -> Result<T, ReadFail> {
    let envelope: Envelope<T> = serde_json::from_slice(body).map_err(|e| {
        if e.is_syntax() || e.is_eof() {
            ReadFail::NotJson
        } else {
            ReadFail::Shape
        }
    })?;
    match envelope {
        Envelope { error: Some(_), .. } => Err(ReadFail::RpcError),
        Envelope { result: Some(result), .. } => Ok(result),
        Envelope { result: None, .. } => Err(ReadFail::Shape),
    }
}

/// Parses a JSON-RPC `call_function` answer: the result bytes, the block height and the block
/// hash. A contract error, a missing result, or more than `MAX_VIEW_BYTES` is a failed read.
pub fn call_function_answer(body: &[u8]) -> Result<ViewResult, ReadFail> {
    let result: CallFunctionResult = envelope(body)?;
    if result.error.is_some() {
        return Err(ReadFail::RpcError);
    }
    let bytes = result.result.ok_or(ReadFail::Shape)?;
    if bytes.len() > MAX_VIEW_BYTES {
        return Err(ReadFail::TooLarge);
    }
    Ok(ViewResult { bytes, block_height: Some(result.block_height), block_hash: Some(result.block_hash) })
}

/// Parses a `view_account` answer. The OutLayer host returns this same JSON-RPC envelope as a
/// string, so both providers go through this one parser (standard 2).
pub fn view_account_answer(body: &[u8]) -> Result<AccountView, ReadFail> {
    let result: ViewAccountResult = envelope(body)?;
    if result.error.is_some() {
        return Err(ReadFail::RpcError);
    }
    let code_hash = result.code_hash.ok_or(ReadFail::Shape)?;
    let decoded = bs58::decode(&code_hash).into_vec().map_err(|_| ReadFail::Shape)?;
    if decoded.len() != 32 {
        return Err(ReadFail::Shape);
    }
    Ok(AccountView { code_hash, block_height: result.block_height, block_hash: result.block_hash })
}

/// Parses a `block` answer down to its height, hash and timestamp. Also the host's format.
pub fn block_answer(body: &[u8]) -> Result<BlockView, ReadFail> {
    let result: BlockResult = envelope(body)?;
    Ok(BlockView { height: result.header.height, hash: result.header.hash, timestamp_ns: result.header.timestamp })
}

/// Turns what the OutLayer host's `view` returned into a result.
///
/// The host decodes the result bytes lossily into a string and returns them; when the RPC call
/// failed it returns the whole JSON-RPC envelope instead, with no error set (worker source
/// `host_functions_sync.rs`, `fn view`). An object carrying a `jsonrpc` key is therefore a failed
/// read: no Sputnik view returns one.
pub fn host_view_answer(result: String, error: &str) -> Result<ViewResult, ReadFail> {
    if !error.is_empty() {
        return Err(ReadFail::RpcError);
    }
    if result.len() > MAX_VIEW_BYTES {
        return Err(ReadFail::TooLarge);
    }
    #[derive(Deserialize)]
    struct Probe {
        jsonrpc: Option<IgnoredAny>,
    }
    if let Ok(Probe { jsonrpc: Some(_) }) = serde_json::from_str::<Probe>(&result) {
        return Err(ReadFail::RpcError);
    }
    Ok(ViewResult { bytes: result.into_bytes(), block_height: None, block_hash: None })
}
