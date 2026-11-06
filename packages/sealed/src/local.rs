//! The `local` build, for plain wasmtime, which has no OutLayer host. The host's RPC is stood in
//! by FastNEAR's public RPC (OutLayer's own is FastNEAR-powered), or by a recorded fixture file
//! named in `KAAP_FIXTURES`, and the verdict is signed with RFC 8032's first test key. Never
//! published: a verdict from this build is signed by a key everyone knows.

use ed25519_dalek::{Signer, SigningKey};
use kaap_core::Network;

use crate::attest::EvidenceSink;
use crate::fixture::FixtureHttp;
use crate::job::Connections;
use crate::net::{
    Deadline, Endpoint, Http, HttpFail, Request, Response, DRPC_MAINNET, DRPC_TESTNET, HOST_STAND_IN_MAINNET, HOST_STAND_IN_TESTNET,
};
use crate::rpc::RpcProvider;
use crate::texts::{TextFail, TextKeys};
use crate::verdict::{SignFail, VerdictSigner};
use crate::wasi_http::WasiHttp;

/// RFC 8032 section 7.1, test 1. Its public key is
/// d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a.
const TEST_SECRET: [u8; 32] = [
    0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60, 0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec, 0x2c, 0xc4, 0x44, 0x49, 0xc5, 0x69,
    0x7b, 0x32, 0x69, 0x19, 0x70, 0x3b, 0xac, 0x03, 0x1c, 0xae, 0x7f, 0x60,
];

pub struct TestKeySigner(SigningKey);

impl VerdictSigner for TestKeySigner {
    fn public_key(&mut self) -> Result<[u8; 32], SignFail> {
        Ok(self.0.verifying_key().to_bytes())
    }

    fn sign(&mut self, message: &[u8]) -> Result<[u8; 64], SignFail> {
        Ok(self.0.sign(message).to_bytes())
    }
}

/// RFC 7748 section 6.1, Alice's private key, in place of the keystore's `mac`. Its public key is
/// 8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a.
const TEST_TEXT_SECRET: [u8; 32] = [
    0x77, 0x07, 0x6d, 0x0a, 0x73, 0x18, 0xa5, 0x7d, 0x3c, 0x16, 0xc1, 0x72, 0x51, 0xb2, 0x66, 0x45, 0xdf, 0x4c, 0x2f, 0x87,
    0xeb, 0xc0, 0x99, 0x2a, 0xb1, 0x77, 0xfb, 0xa5, 0x1d, 0xb9, 0x2c, 0x2a,
];

struct TestTextKeys;

impl TextKeys for TestTextKeys {
    fn mac(&mut self, _path: &str, _data: &[u8]) -> Result<[u8; 32], TextFail> {
        Ok(TEST_TEXT_SECRET)
    }

    fn random(&mut self) -> Option<[u8; 32]> {
        wasi::random::random::get_random_bytes(32).try_into().ok()
    }
}

fn endpoints(network: Network) -> (Endpoint, Endpoint) {
    match network {
        Network::Mainnet => (HOST_STAND_IN_MAINNET, DRPC_MAINNET),
        Network::Testnet | Network::Sandbox => (HOST_STAND_IN_TESTNET, DRPC_TESTNET),
    }
}

/// Prints each request's endpoint and outcome to stderr, so a local run shows where it went.
struct Traced<H>(H);

impl<H: Http> Http for Traced<H> {
    fn send(&mut self, request: &Request<'_>) -> Result<Response, HttpFail> {
        let started = std::time::Instant::now();
        let result = self.0.send(request);
        let outcome = match &result {
            Ok(r) => format!("status {} body {} bytes", r.status, r.body.len()),
            Err(fail) => format!("failed {fail:?}"),
        };
        let sent = request.body.map_or(0, <[u8]>::len);
        eprintln!(
            "local: {}{}{} sent {sent} bytes, {outcome}, {} ms",
            request.endpoint.authority,
            request.endpoint.path,
            request.tail,
            started.elapsed().as_millis()
        );
        result
    }

    fn pause(&mut self, ms: u64) {
        self.0.pause(ms);
    }
}

/// Plain wasmtime has no OutLayer storage, so the evidence a published build would store is
/// printed to stderr instead.
struct PrintedEvidence;

impl EvidenceSink for PrintedEvidence {
    fn publish(&mut self, key: &str, record: &[u8]) -> bool {
        eprintln!("local: evidence {key} {}", String::from_utf8_lossy(record));
        true
    }
}

pub fn connections(network: Network, deadline: Deadline) -> Connections {
    let (host, https) = endpoints(network);
    let signer = Box::new(TestKeySigner(SigningKey::from_bytes(&TEST_SECRET)));
    let (nonce, block_timestamp) = (wasi::random::random::get_random_bytes(32).try_into().ok(), std::env::var("NEAR_BLOCK_TIMESTAMP").ok());
    let (quote, evidence): (crate::attest::tdx::QuoteCheck, Box<dyn EvidenceSink>) =
        (crate::attest::tdx::check_quote, Box::new(PrintedEvidence));
    match std::env::var("KAAP_FIXTURES") {
        Ok(path) => {
            let load = || {
                std::fs::read_to_string(&path)
                    .map_err(|e| e.to_string())
                    .and_then(|text| FixtureHttp::from_json(&text))
                    .unwrap_or_else(|why| {
                        eprintln!("local build: {why}");
                        FixtureHttp::new(Vec::new())
                    })
            };
            Connections {
                host: Box::new(RpcProvider::new(load(), host, deadline)),
                https: Box::new(RpcProvider::new(load(), https, deadline)),
                http: Box::new(load()),
                signer,
                texts: Box::new(TestTextKeys),
                nonce,
                block_timestamp,
                quote,
                evidence,
            }
        }
        Err(_) => Connections {
            host: Box::new(RpcProvider::new(Traced(WasiHttp), host, deadline)),
            https: Box::new(RpcProvider::new(Traced(WasiHttp), https, deadline)),
            http: Box::new(Traced(WasiHttp)),
            signer,
            texts: Box::new(TestTextKeys),
            nonce,
            block_timestamp,
            quote,
            evidence,
        },
    }
}
