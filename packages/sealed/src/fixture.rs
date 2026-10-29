//! Recorded answers in place of the network, for the native tests and the local wasmtime build.
//! A fixture file is what `tools/record-fixture.mjs` writes: real JSON-RPC answers from two
//! providers at one block, plus any plain HTTPS answers a test adds (`path` instead of `method`).

use serde::Deserialize;
use serde_json::Value;

use crate::net::{Http, HttpFail, Request, Response};

#[derive(Deserialize)]
struct File {
    exchanges: Vec<Exchange>,
}

#[derive(Clone, Deserialize)]
pub struct Exchange {
    pub authority: String,
    /// A JSON-RPC answer matches on `method` and `params`.
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub params: Option<Value>,
    /// A plain HTTPS answer matches on `path`.
    #[serde(default)]
    pub path: Option<String>,
    pub status: u16,
    pub body: String,
}

pub struct FixtureHttp {
    exchanges: Vec<Exchange>,
    /// Every request made, as (authority, path), so a test can see where the job connected.
    pub sent: Vec<(String, String)>,
}

impl FixtureHttp {
    pub fn from_json(text: &str) -> Result<FixtureHttp, String> {
        let file: File = serde_json::from_str(text).map_err(|e| format!("fixture: {e}"))?;
        Ok(FixtureHttp { exchanges: file.exchanges, sent: Vec::new() })
    }

    pub fn new(exchanges: Vec<Exchange>) -> FixtureHttp {
        FixtureHttp { exchanges, sent: Vec::new() }
    }
}

impl Http for FixtureHttp {
    fn send(&mut self, request: &Request<'_>) -> Result<Response, HttpFail> {
        let authority = request.endpoint.authority;
        self.sent.push((authority.to_string(), request.endpoint.path.to_string()));
        let rpc = request
            .body
            .and_then(|b| serde_json::from_slice::<Value>(b).ok())
            .filter(|v| v.get("jsonrpc").is_some());
        let found = self.exchanges.iter().find(|e| {
            e.authority == authority
                && match (&rpc, &e.method) {
                    (Some(call), Some(method)) => {
                        call.get("method").and_then(Value::as_str) == Some(method.as_str())
                            && call.get("params") == e.params.as_ref()
                    }
                    (None, None) => e.path.as_deref() == Some(request.endpoint.path),
                    _ => false,
                }
        });
        let exchange = found.ok_or(HttpFail::NoAnswerRecorded)?;
        if exchange.body.len() > request.limits.max_body_bytes {
            return Err(HttpFail::TooLarge);
        }
        Ok(Response { status: exchange.status, body: exchange.body.as_bytes().to_vec() })
    }
}
