//! kaap-sealed: the job OutLayer runs inside Intel TDX. It reads one Sputnik proposal from two
//! independent RPC providers, decodes it with kaap-core, asks a sealed NEAR AI model for an
//! opinion, and signs a verdict with a key only this project and its caller hold.

pub mod ai;
pub mod attest;
pub mod input;
pub mod job;
pub mod net;
pub mod output;
pub mod prompt;
pub mod proposal;
pub mod reads;
pub mod rpc;
pub mod verdict;

#[cfg(any(feature = "local", not(target_arch = "wasm32")))]
pub mod fixture;
#[cfg(all(target_arch = "wasm32", not(feature = "local")))]
pub mod host;
#[cfg(all(target_arch = "wasm32", feature = "local"))]
pub mod local;
#[cfg(target_arch = "wasm32")]
pub mod wasi_http;
