//! OutLayer's host functions behind this crate's traits. Published build only: plain wasmtime has
//! no such host, which is what the `local` build is for.

use outlayer::raw::rpc as host_rpc;

use crate::attest::EvidenceSink;
use crate::rpc::{
    block_answer, host_view_answer, view_account_answer, AccountView, At, BlockView, Provider, ReadFail, ViewResult,
    MAX_VIEW_BYTES,
};
use crate::verdict::{SignFail, VerdictSigner, SIGNING_KEY_PATH};

/// The worker's RPC proxy, a FastNEAR-powered node OutLayer runs. The guest cannot set a timeout
/// on these calls; the proxy's own client gives up after 30 s (worker `host_functions_sync.rs`)
/// and OutLayer stops the whole run at `max_execution_seconds`.
pub struct HostProvider;

fn finality_or_block(at: At) -> String {
    match at {
        At::Final => "final".to_string(),
        At::Height(h) => h.to_string(),
    }
}

/// The host returns `view_account` and `block` as the JSON-RPC envelope it received, re-encoded.
fn envelope(result: String, error: String) -> Result<String, ReadFail> {
    if !error.is_empty() {
        return Err(ReadFail::RpcError);
    }
    if result.len() > MAX_VIEW_BYTES {
        return Err(ReadFail::TooLarge);
    }
    Ok(result)
}

impl Provider for HostProvider {
    fn call_function(&mut self, account: &str, method: &str, args_json: &str, at: At) -> Result<ViewResult, ReadFail> {
        let (result, error) = host_rpc::view(account, method, args_json, &finality_or_block(at));
        host_view_answer(result, &error)
    }

    fn view_account(&mut self, account: &str, at: At) -> Result<AccountView, ReadFail> {
        let (result, error) = host_rpc::view_account(account, &finality_or_block(at));
        view_account_answer(envelope(result, error)?.as_bytes())
    }

    fn block(&mut self, at: At) -> Result<BlockView, ReadFail> {
        let (result, error) = host_rpc::block(&finality_or_block(at));
        block_answer(envelope(result, error)?.as_bytes())
    }
}

/// The `verdict` key the keystore holds for this project and the transaction signer.
pub struct HostSigner;

impl VerdictSigner for HostSigner {
    fn public_key(&mut self) -> Result<[u8; 32], SignFail> {
        let key = outlayer::signing_keys::public_key(SIGNING_KEY_PATH, None).map_err(|_| SignFail::PublicKey)?;
        <[u8; 32]>::try_from(key.as_slice()).map_err(|_| SignFail::PublicKey)
    }

    fn sign(&mut self, message: &[u8]) -> Result<[u8; 64], SignFail> {
        let signature = outlayer::signing_keys::sign(SIGNING_KEY_PATH, None, message).map_err(|_| SignFail::Signature)?;
        <[u8; 64]>::try_from(signature.as_slice()).map_err(|_| SignFail::Signature)
    }
}

/// This run's attestation nonce from WASI random, which gave fresh bytes on every testnet run of
/// the 26 Oct spike. `None` if the host ever returned another length.
pub fn fresh_nonce() -> Option<[u8; 32]> {
    wasi::random::random::get_random_bytes(32).try_into().ok()
}

/// The project's public worker storage: only this project's code can write it, anyone can read it
/// over OutLayer's `/public/storage/get`. Unencrypted on purpose, and so it holds only what
/// `attest::evidence` allows.
pub struct PublicEvidence;

impl EvidenceSink for PublicEvidence {
    fn publish(&mut self, key: &str, record: &[u8]) -> bool {
        outlayer::storage::set_worker_with_options(key, record, Some(false)).is_ok()
    }
}
