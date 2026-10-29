//! The only hosts the job talks to, and the limits on every request (standard 4).
//!
//! Requests name a fixed `Endpoint`, never a URL built from input, so no value from a caller or
//! an upstream answer can steer where the job connects. A test checks that every published
//! endpoint is in the manifest's network list, because OutLayer enforces that list only for its
//! curated connectors: this code is what keeps the job to it.

use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Endpoint {
    pub authority: &'static str,
    pub path: &'static str,
}

pub const DRPC_MAINNET: Endpoint = Endpoint { authority: "near.drpc.org", path: "/" };
pub const DRPC_TESTNET: Endpoint = Endpoint { authority: "near-testnet.drpc.org", path: "/" };
pub const NEAR_AI_MODEL_LIST: Endpoint = Endpoint { authority: "cloud-api.near.ai", path: "/v1/model/list" };
pub const NEAR_AI_CHAT: Endpoint = Endpoint { authority: "cloud-api.near.ai", path: "/v1/chat/completions" };

/// OutLayer's host RPC is FastNEAR-powered; tests and the local build stand FastNEAR's public RPC
/// in for it. Not in `PUBLISHED_ENDPOINTS`: a published build never calls these.
pub const HOST_STAND_IN_MAINNET: Endpoint = Endpoint { authority: "rpc.mainnet.fastnear.com", path: "/" };
pub const HOST_STAND_IN_TESTNET: Endpoint = Endpoint { authority: "rpc.testnet.fastnear.com", path: "/" };

/// Every endpoint a published build can call.
pub const PUBLISHED_ENDPOINTS: [Endpoint; 4] = [DRPC_MAINNET, DRPC_TESTNET, NEAR_AI_MODEL_LIST, NEAR_AI_CHAT];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

/// Per-request limits. `overall_ms` bounds the whole exchange, from connect to the last body
/// byte, and is further cut to whatever is left of the job's own deadline.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub connect_ms: u64,
    pub first_byte_ms: u64,
    pub between_bytes_ms: u64,
    pub overall_ms: u64,
    pub max_body_bytes: usize,
}

impl Limits {
    /// The same limits with `overall_ms` cut to what is left before `deadline`.
    pub fn within(self, deadline: Deadline) -> Limits {
        Limits { overall_ms: self.overall_ms.min(deadline.remaining_ms()), ..self }
    }
}

pub struct Request<'a> {
    pub method: Method,
    pub endpoint: Endpoint,
    pub headers: &'a [(&'a str, &'a str)],
    pub body: Option<&'a [u8]>,
    pub limits: Limits,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

/// Why a request produced no response. No upstream text is kept: these are counted, never shown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HttpFail {
    Setup,
    Send,
    Timeout,
    TooLarge,
    Read,
    NoAnswerRecorded,
}

pub trait Http {
    fn send(&mut self, request: &Request<'_>) -> Result<Response, HttpFail>;
}

/// A point in time the job must finish a phase by, on the monotonic clock.
#[derive(Clone, Copy, Debug)]
pub struct Deadline {
    end: Instant,
}

impl Deadline {
    pub fn after_ms(ms: u64) -> Deadline {
        Deadline { end: Instant::now() + Duration::from_millis(ms) }
    }

    pub fn remaining_ms(self) -> u64 {
        let left = self.end.saturating_duration_since(Instant::now()).as_millis();
        u64::try_from(left).unwrap_or(u64::MAX)
    }

    pub fn passed(self) -> bool {
        self.remaining_ms() == 0
    }
}
