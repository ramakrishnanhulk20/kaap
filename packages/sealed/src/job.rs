//! One run of the job, in order: check the input, settle the payment, open a sealed text if there
//! is one, read both providers at one block, decode, ask the model, assemble, sign, print. Every
//! way out that is not a signed verdict prints a fixed reason and no signature.

use kaap_core::{verdict_hash, AiStatus, Analysis, Network, Verdict};

use crate::ai::{consult, AiOutcome, Audience, Check};
use crate::attest::evidence::key_for;
use crate::attest::tdx::QuoteCheck;
use crate::attest::{trusted_now, Evidence, EvidenceSink, Trust, Unverified};
use crate::input::{parse_request, JobInput, Request};
use crate::net::{Deadline, Http};
use crate::output::{below_price, failed, held, refused};
use crate::payment::{gate, worker_account, PayEnv, Payer};
use crate::proposal::judge;
use crate::prompt::user_message;
use crate::reads::{read_chain, ChainRead, HOST_CATCH_UP_MS};
use crate::rpc::{At, AccountView, BlockView, Provider, ReadFail, ViewResult};
use crate::texts::{open_text, render_text_key, seal_explanation, TextFail, TextKeys};
use crate::verdict::{assemble, public_key_text, seal, seal_encrypted, sign_sealed, VerdictSigner};

/// OutLayer stops a run at `max_execution_seconds`, which the run script sets to 60. The reads
/// must be done by 25 s and the model by 50 s, leaving time to sign and print.
pub const READ_BUDGET_MS: u64 = 25_000;
pub const JOB_BUDGET_MS: u64 = 50_000;

/// What a run talks to. The published build connects these to OutLayer's host, dRPC, NEAR AI,
/// Intel, NVIDIA, the keystore and public storage; tests and the local build connect them to
/// recorded answers, a test key and a stand-in store.
pub struct Connections {
    pub host: Box<dyn Provider>,
    pub https: Box<dyn Provider>,
    /// Every outside call of the AI step: NEAR AI, Intel and NVIDIA.
    pub ai: Box<dyn Http>,
    pub signer: Box<dyn VerdictSigner>,
    /// The keystore's `texts` key and fresh randomness. Used only by a run that carries a sealed
    /// text or asks for the text key, so a public run never touches it.
    pub texts: Box<dyn TextKeys>,
    /// 32 fresh random bytes for this run, or `None` when none could be drawn.
    pub nonce: Option<[u8; 32]>,
    /// OutLayer's `NEAR_BLOCK_TIMESTAMP`, the requesting block's time, as set for the run.
    pub block_timestamp: Option<String>,
    /// `attest::tdx::check_quote` in every published build.
    pub quote: QuoteCheck,
    pub evidence: Box<dyn EvidenceSink>,
}

/// What OutLayer set for this run, read in `main()`. Nothing here comes from the input.
pub struct RunEnv<'a> {
    /// `NEAR_NETWORK_ID`.
    pub network: Option<&'a str>,
    pub pay: PayEnv,
}

/// Native builds only ever run tests, and a test that names no payer is Kaap's worker on chain. This
/// is not in the wasm, so `main()` cannot reach a free run by leaving the payment facts out.
#[cfg(not(target_arch = "wasm32"))]
impl<'a> From<Option<&'a str>> for RunEnv<'a> {
    fn from(network: Option<&'a str>) -> Self {
        let pay = PayEnv {
            execution_type: Some("NEAR".to_string()),
            usd_payment: Some("0".to_string()),
            attached_usd: Some("0".to_string()),
            sender: Some(crate::payment::TESTNET_WORKER.to_string()),
        };
        RunEnv { network, pay }
    }
}

/// Runs the job on the raw stdin bytes and returns what it prints.
///
/// `env` is what OutLayer set for the run and `ai_key` the `NEAR_AI_API_KEY` secret. A judge run
/// passes `gate` right after its input is parsed; asking for the text key is free. `connect` is
/// called only for an input that passed every check and a payment that was accepted, with the
/// network and the read deadline, so a refused run makes no outside call at all.
pub fn run<'a>(
    raw: &[u8],
    env: impl Into<RunEnv<'a>>,
    ai_key: Option<&str>,
    connect: impl FnOnce(Network, Deadline) -> Connections,
) -> String {
    let RunEnv { network, pay } = env.into();
    let request = match parse_request(raw, network) {
        Ok(request) => request,
        Err(why) => return refused(why.reason()),
    };
    match request {
        Request::TextKey(network) => text_key(network, connect),
        Request::Judge(input) => match gate(&pay, worker_account(input.network).unwrap_or("")) {
            Ok(payer) => judge_run(input, ai_key, payer, connect),
            Err(why) => below_price(why),
        },
    }
}

fn text_key(network: Network, connect: impl FnOnce(Network, Deadline) -> Connections) -> String {
    let Connections { mut texts, mut signer, .. } = connect(network, Deadline::after_ms(READ_BUDGET_MS));
    render_text_key(texts.as_mut(), signer.as_mut()).unwrap_or_else(failed)
}

fn text_failure(why: TextFail) -> String {
    if why.is_the_input() {
        refused(why.reason())
    } else {
        failed(why.reason())
    }
}

/// Where a paid run's evidence goes: nowhere. Public storage is Kaap's, so a paying stranger must
/// not be able to grow it. It answers "not published", which keeps `seal_and_publish`'s rule that
/// every Verified verdict has evidence a stranger can read.
struct NoEvidence;

impl EvidenceSink for NoEvidence {
    fn publish(&mut self, _key: &str, _record: &[u8]) -> bool {
        false
    }
}

/// Judges an input for a payer `gate` has already settled. A `Payer::Paid` run is the same check
/// and writes no public evidence.
pub fn judge_run(input: JobInput, ai_key: Option<&str>, payer: Payer, connect: impl FnOnce(Network, Deadline) -> Connections) -> String {
    let read_deadline = Deadline::after_ms(READ_BUDGET_MS);
    let job_deadline = Deadline::after_ms(JOB_BUDGET_MS);
    let Connections { mut host, https, mut ai, mut signer, mut texts, nonce, block_timestamp, quote, evidence } =
        connect(input.network, read_deadline);
    let mut evidence: Box<dyn EvidenceSink> = match payer {
        Payer::Kaap => evidence,
        Payer::Paid => Box::new(NoEvidence),
    };
    // Before any read, so a text that does not open costs no outside call.
    let text = match input.text.as_ref().map(|sealed| open_text(texts.as_mut(), &input, sealed)).transpose() {
        Ok(text) => text,
        Err(why) => return text_failure(why),
    };
    let mut https: Box<dyn Provider> = if input.test_corrupt_https { Box::new(Corrupting(https)) } else { https };

    let read = match read_chain(host.as_mut(), https.as_mut(), &input.dao, input.proposal_id, read_deadline, HOST_CATCH_UP_MS) {
        Ok(read) => read,
        Err(why) => return held(why.reason()),
    };
    let audience = if text.is_some() { Audience::Members } else { Audience::Public };
    let (proposal, analysis) = judge(&input, text, &read);
    let facts = user_message(&proposal, &analysis);
    let trust = Trust { nonce, now: trusted_now(block_timestamp.as_deref(), read.block.timestamp_ns), quote };
    let (outcome, record) = consult(ai.as_mut(), ai_key, facts.as_deref(), audience, job_deadline, &trust);
    let public_key = match public_key_text(signer.as_mut()) {
        Ok(key) => key,
        Err(why) => return failed(why),
    };
    let verdict = Unsigned { input: &input, read: &read, analysis: &analysis, public_key: &public_key };
    let (verdict, explanation) = match seal_and_publish(&verdict, outcome, record, evidence.as_mut(), texts.as_mut()) {
        Ok(parts) => parts,
        Err(why) => return failed(why),
    };
    sign_sealed(&verdict, &explanation, &public_key, signer.as_mut()).unwrap_or_else(failed)
}

/// Everything a verdict is built from except the AI outcome.
pub struct Unsigned<'a> {
    pub input: &'a JobInput,
    pub read: &'a ChainRead,
    pub analysis: &'a Analysis,
    /// The signer's key as printed, which decides how much room the explanation has.
    pub public_key: &'a str,
}

/// Seals the verdict and publishes its evidence under the verdict's hash. A Verified verdict whose
/// evidence could not be published is sealed again as Unverified (`EvidenceNotPublished`), so
/// every Verified verdict has evidence a stranger can read; for any other verdict a failed
/// publication changes nothing. On a run with a sealed text the explanation is encrypted to the
/// member's reply key each time it is sealed, with fresh randomness from `texts`.
pub fn seal_and_publish(
    parts: &Unsigned<'_>,
    outcome: AiOutcome,
    mut record: Evidence,
    sink: &mut dyn EvidenceSink,
    texts: &mut dyn TextKeys,
) -> Result<(Verdict, String), &'static str> {
    let (verdict, explanation) = seal_with(parts, &outcome, &mut record, texts)?;
    let published = sink.publish(&key_for(&verdict_hash(&verdict)), &record.to_bytes());
    if published || verdict.ai_status != AiStatus::Verified {
        return Ok((verdict, explanation));
    }
    let outcome = outcome.unverified(Unverified::EvidenceNotPublished);
    let (verdict, explanation) = seal_with(parts, &outcome, &mut record, texts)?;
    sink.publish(&key_for(&verdict_hash(&verdict)), &record.to_bytes());
    Ok((verdict, explanation))
}

fn seal_with(
    parts: &Unsigned<'_>,
    outcome: &AiOutcome,
    record: &mut Evidence,
    texts: &mut dyn TextKeys,
) -> Result<(Verdict, String), &'static str> {
    let (verdict, explanation) = assemble(parts.input, parts.read, parts.analysis, outcome)?;
    let (verdict, explanation) = match &parts.input.text {
        None => seal(verdict, &explanation, parts.public_key)?,
        Some(sealed) => seal_encrypted(verdict, &explanation, parts.public_key, |plain| {
            seal_explanation(texts, parts.input, &sealed.reply_key, plain).map_err(TextFail::reason)
        })?,
    };
    record.verdict_hash = Some(hex::encode(verdict_hash(&verdict)));
    (record.ai_status, record.reason) = match outcome {
        AiOutcome::Answered { check: Check::Verified { .. }, .. } => ("verified", None),
        AiOutcome::Answered { check: Check::Unverified(why), .. } => ("unverified", Some(why.code())),
        AiOutcome::Unavailable(why) => ("unavailable", Some(why.code())),
    };
    Ok((verdict, explanation))
}

/// The testnet-only test flag: the HTTPS provider's `get_proposal` answer gains one character in
/// its description, so the two providers disagree and the job must hold (DONE MEANS 3).
struct Corrupting(Box<dyn Provider>);

impl Provider for Corrupting {
    fn call_function(&mut self, account: &str, method: &str, args_json: &str, at: At) -> Result<ViewResult, ReadFail> {
        let mut view = self.0.call_function(account, method, args_json, at)?;
        if method == "get_proposal" {
            let marker = b"\"description\":\"";
            match view.bytes.windows(marker.len()).position(|w| w == marker) {
                Some(at) => view.bytes.insert(at + marker.len(), b'~'),
                None => view.bytes.push(b'~'),
            }
        }
        Ok(view)
    }

    fn view_account(&mut self, account: &str, at: At) -> Result<AccountView, ReadFail> {
        self.0.view_account(account, at)
    }

    fn block(&mut self, at: At) -> Result<BlockView, ReadFail> {
        self.0.block(at)
    }
}
