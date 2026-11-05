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
pub const NEAR_AI_REPORT: Endpoint = Endpoint { authority: "cloud-api.near.ai", path: "/v1/attestation/report" };
/// The chat id and the query follow in the request's `tail`.
pub const NEAR_AI_SIGNATURE: Endpoint = Endpoint { authority: "cloud-api.near.ai", path: "/v1/signature/" };
pub const NEAR_AI_ITA: Endpoint = Endpoint { authority: "cloud-api.near.ai", path: "/v1/attestation/ita-token" };

/// Intel's Provisioning Certification Service: the keyless calls that make up the collateral for
/// a TDX quote (scratchpad/m0d-nearai/RESULTS.md Q9). The root CA's CRL lives on its own host,
/// the one named in Intel's root certificate.
pub const INTEL_PCK_CRL: Endpoint = Endpoint { authority: "api.trustedservices.intel.com", path: "/sgx/certification/v4/pckcrl" };
pub const INTEL_TCB_INFO: Endpoint = Endpoint { authority: "api.trustedservices.intel.com", path: "/tdx/certification/v4/tcb" };
pub const INTEL_QE_IDENTITY: Endpoint =
    Endpoint { authority: "api.trustedservices.intel.com", path: "/tdx/certification/v4/qe/identity" };
pub const INTEL_ROOT_CRL: Endpoint = Endpoint { authority: "certificates.trustedservices.intel.com", path: "/IntelSGXRootCA.der" };
/// Intel Trust Authority's signing keys, fetched on every run: the current certificate expires on
/// 2026-11-19, so a pinned key would stop working that day.
pub const INTEL_ITA_KEYS: Endpoint = Endpoint { authority: "portal.trustauthority.intel.com", path: "/certs" };

pub const NVIDIA_NRAS: Endpoint = Endpoint { authority: "nras.attestation.nvidia.com", path: "/v3/attest/gpu" };
pub const NVIDIA_KEYS: Endpoint = Endpoint { authority: "nras.attestation.nvidia.com", path: "/.well-known/jwks.json" };

/// OutLayer's host RPC is FastNEAR-powered; tests and the local build stand FastNEAR's public RPC
/// in for it. Not in `PUBLISHED_ENDPOINTS`: a published build never calls these.
pub const HOST_STAND_IN_MAINNET: Endpoint = Endpoint { authority: "rpc.mainnet.fastnear.com", path: "/" };
pub const HOST_STAND_IN_TESTNET: Endpoint = Endpoint { authority: "rpc.testnet.fastnear.com", path: "/" };

/// Every endpoint a published build can call.
pub const PUBLISHED_ENDPOINTS: [Endpoint; 14] = [
    DRPC_MAINNET,
    DRPC_TESTNET,
    NEAR_AI_MODEL_LIST,
    NEAR_AI_CHAT,
    NEAR_AI_REPORT,
    NEAR_AI_SIGNATURE,
    NEAR_AI_ITA,
    INTEL_PCK_CRL,
    INTEL_TCB_INFO,
    INTEL_QE_IDENTITY,
    INTEL_ROOT_CRL,
    INTEL_ITA_KEYS,
    NVIDIA_NRAS,
    NVIDIA_KEYS,
];

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
    /// Appended to the endpoint's path: an id and a query string, built in this crate only from
    /// values it checked first. The transport refuses any tail `is_safe_tail` refuses.
    pub tail: &'a str,
    pub headers: &'a [(&'a str, &'a str)],
    pub body: Option<&'a [u8]>,
    /// Response headers to keep, by lowercase name. Every other header is dropped unread.
    pub keep_headers: &'a [&'a str],
    pub limits: Limits,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
    /// Only the headers the request asked to keep, names lowercase, each value at most
    /// `MAX_HEADER_BYTES`.
    pub headers: Vec<(String, String)>,
}

impl Response {
    pub fn new(status: u16, body: Vec<u8>) -> Response {
        Response { status, body, headers: Vec::new() }
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

/// Intel's certificate chains travel in headers, URL-encoded, about 2.5 KiB each.
pub const MAX_HEADER_BYTES: usize = 16 * 1024;

/// True when `tail` holds only unreserved URL characters plus the few a path segment and a query
/// need (`/ ? & = %`). It is the last check between a value and the request line, so a space, a
/// line break, a `#` or an `@` that slipped past a field's own check still never reaches it.
pub fn is_safe_tail(tail: &str) -> bool {
    tail.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._~/?&=%".contains(&b))
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

    /// Waits before a retry. Recorded answers and test stand-ins answer at once and do not wait.
    fn pause(&mut self, _ms: u64) {}
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

    /// This deadline, or `ms` from now if that comes first.
    pub fn earlier(self, ms: u64) -> Deadline {
        Deadline { end: self.end.min(Instant::now() + Duration::from_millis(ms)) }
    }
}
