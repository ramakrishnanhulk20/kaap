//! One run of the job, in order: check the input, read both providers at one block, decode,
//! ask the model, assemble, sign, print. Every way out that is not a signed verdict prints a
//! fixed reason and no signature.

use kaap_core::{verdict_hash, AiStatus, Analysis, Network, Verdict};

use crate::ai::{consult, AiOutcome, Check};
use crate::attest::evidence::key_for;
use crate::attest::tdx::QuoteCheck;
use crate::attest::{trusted_now, Evidence, EvidenceSink, Trust, Unverified};
use crate::input::{parse_input, JobInput};
use crate::net::{Deadline, Http};
use crate::output::{failed, held, refused};
use crate::proposal::judge;
use crate::prompt::user_message;
use crate::reads::{read_chain, ChainRead, HOST_CATCH_UP_MS};
use crate::rpc::{At, AccountView, BlockView, Provider, ReadFail, ViewResult};
use crate::verdict::{assemble, public_key_text, seal, sign_sealed, VerdictSigner};

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
    /// 32 fresh random bytes for this run, or `None` when none could be drawn.
    pub nonce: Option<[u8; 32]>,
    /// OutLayer's `NEAR_BLOCK_TIMESTAMP`, the requesting block's time, as set for the run.
    pub block_timestamp: Option<String>,
    /// `attest::tdx::check_quote` in every published build.
    pub quote: QuoteCheck,
    pub evidence: Box<dyn EvidenceSink>,
}

/// Runs the job on the raw stdin bytes and returns what it prints.
///
/// `run_network` is `NEAR_NETWORK_ID` and `ai_key` the `NEAR_AI_API_KEY` secret, both as OutLayer
/// sets them. `connect` is called only for an input that passed every check, with the network and
/// the read deadline, so a refused input makes no outside call at all.
pub fn run(
    raw: &[u8],
    run_network: Option<&str>,
    ai_key: Option<&str>,
    connect: impl FnOnce(Network, Deadline) -> Connections,
) -> String {
    let input = match parse_input(raw, run_network) {
        Ok(input) => input,
        Err(why) => return refused(why.reason()),
    };
    let read_deadline = Deadline::after_ms(READ_BUDGET_MS);
    let job_deadline = Deadline::after_ms(JOB_BUDGET_MS);
    let Connections { mut host, https, mut ai, mut signer, nonce, block_timestamp, quote, mut evidence } =
        connect(input.network, read_deadline);
    let mut https: Box<dyn Provider> = if input.test_corrupt_https { Box::new(Corrupting(https)) } else { https };

    let read = match read_chain(host.as_mut(), https.as_mut(), &input.dao, input.proposal_id, read_deadline, HOST_CATCH_UP_MS) {
        Ok(read) => read,
        Err(why) => return held(why.reason()),
    };
    let (proposal, analysis) = judge(input.network, &input.dao, input.proposal_id, &read);
    let facts = user_message(&proposal, &analysis);
    let trust = Trust { nonce, now: trusted_now(block_timestamp.as_deref(), read.block.timestamp_ns), quote };
    let (outcome, record) = consult(ai.as_mut(), ai_key, facts.as_deref(), job_deadline, &trust);
    let public_key = match public_key_text(signer.as_mut()) {
        Ok(key) => key,
        Err(why) => return failed(why),
    };
    let verdict = Unsigned { input: &input, read: &read, analysis: &analysis, public_key: &public_key };
    let (verdict, explanation) = match seal_and_publish(&verdict, outcome, record, evidence.as_mut()) {
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
/// publication changes nothing.
pub fn seal_and_publish(
    parts: &Unsigned<'_>,
    outcome: AiOutcome,
    mut record: Evidence,
    sink: &mut dyn EvidenceSink,
) -> Result<(Verdict, String), &'static str> {
    let (verdict, explanation) = seal_with(parts, &outcome, &mut record)?;
    let published = sink.publish(&key_for(&verdict_hash(&verdict)), &record.to_bytes());
    if published || verdict.ai_status != AiStatus::Verified {
        return Ok((verdict, explanation));
    }
    let outcome = outcome.unverified(Unverified::EvidenceNotPublished);
    let (verdict, explanation) = seal_with(parts, &outcome, &mut record)?;
    sink.publish(&key_for(&verdict_hash(&verdict)), &record.to_bytes());
    Ok((verdict, explanation))
}

fn seal_with(parts: &Unsigned<'_>, outcome: &AiOutcome, record: &mut Evidence) -> Result<(Verdict, String), &'static str> {
    let (verdict, explanation) = assemble(parts.input, parts.read, parts.analysis, outcome)?;
    let (verdict, explanation) = seal(verdict, &explanation, parts.public_key)?;
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
