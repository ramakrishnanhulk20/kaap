//! kaap-core for JavaScript: the CLI loads this as WebAssembly, and so will the browser, so a
//! judge's laptop runs the same rules as the sealed job and the guard (C14). `api` holds the plain
//! Rust behind every export and `eval` the answer-key scoreboards; this file only binds them.
//!
//! Every export takes and returns strings. Structured answers are JSON text, and a failure is
//! thrown as a JavaScript Error carrying a fixed message, never a fragment of the input.

pub mod api;
pub mod eval;

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
mod bindings {
    use wasm_bindgen::prelude::*;

    use crate::api::{self, Error};

    fn thrown(e: Error) -> JsError {
        JsError::new(e.0)
    }

    #[wasm_bindgen]
    pub fn analyze(input_json: &str) -> Result<String, JsError> {
        api::analyze(input_json).map_err(thrown)
    }

    #[wasm_bindgen(js_name = readProposal)]
    pub fn read_proposal(answer: &str) -> Result<String, JsError> {
        api::read_proposal(answer).map_err(thrown)
    }

    #[wasm_bindgen(js_name = isAccountId)]
    pub fn is_account_id(id: &str) -> bool {
        api::is_account_id(id)
    }

    #[wasm_bindgen(js_name = canonicalKind)]
    pub fn canonical_kind(kind_json: &str) -> Result<String, JsError> {
        api::canonical_kind(kind_json).map_err(thrown)
    }

    #[wasm_bindgen(js_name = canonicalPolicy)]
    pub fn canonical_policy(policy_json: &str) -> Result<String, JsError> {
        api::canonical_policy(policy_json).map_err(thrown)
    }

    #[wasm_bindgen(js_name = kindHash)]
    pub fn kind_hash(kind_json: &str) -> Result<String, JsError> {
        api::kind_hash(kind_json).map_err(thrown)
    }

    #[wasm_bindgen(js_name = policyHash)]
    pub fn policy_hash(policy_json: &str) -> Result<String, JsError> {
        api::policy_hash(policy_json).map_err(thrown)
    }

    #[wasm_bindgen(js_name = nep413Hash)]
    pub fn nep413_hash(message: &str, nonce_b64: &str, recipient: &str, callback_url: Option<String>) -> Result<String, JsError> {
        api::nep413_hash(message, nonce_b64, recipient, callback_url).map_err(thrown)
    }

    #[wasm_bindgen(js_name = nep461Hash)]
    pub fn nep461_hash(delegate_b64: &str) -> Result<String, JsError> {
        api::nep461_hash(delegate_b64).map_err(thrown)
    }

    #[wasm_bindgen(js_name = verdictHash)]
    pub fn verdict_hash(verdict_json: &str) -> Result<String, JsError> {
        api::verdict_hash(verdict_json).map_err(thrown)
    }

    #[wasm_bindgen(js_name = guardArming)]
    pub fn guard_arming(policy_json: &str, guard: &str) -> Result<String, JsError> {
        api::guard_arming(policy_json, guard).map_err(thrown)
    }

    #[wasm_bindgen(js_name = whoActs)]
    pub fn who_acts(policy_json: &str, label: &str) -> Result<String, JsError> {
        api::who_acts(policy_json, label).map_err(thrown)
    }

    #[wasm_bindgen(js_name = enrolmentDrafts)]
    pub fn enrolment_drafts(guard: &str) -> Result<String, JsError> {
        api::enrolment_drafts(guard).map_err(thrown)
    }

    #[wasm_bindgen(js_name = decoderVersion)]
    pub fn decoder_version() -> String {
        api::decoder_version()
    }

    #[wasm_bindgen(js_name = receiversHash)]
    pub fn receivers_hash(pairs_json: &str) -> Result<String, JsError> {
        api::receivers_hash(pairs_json).map_err(thrown)
    }

    #[wasm_bindgen(js_name = pricesFromTokens)]
    pub fn prices_from_tokens(tokens_json: &str) -> Result<String, JsError> {
        api::prices_json(tokens_json).map_err(thrown)
    }

    #[wasm_bindgen(js_name = evalScoreboards)]
    pub fn eval_scoreboards(real_jsonl: &str, planted_jsonl: &str, tokens_json: &str) -> Result<String, JsError> {
        crate::eval::scoreboards(real_jsonl, planted_jsonl, tokens_json).map_err(thrown)
    }
}
