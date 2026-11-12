//! One run of the job, in order: check the input, settle the payment, open a sealed text if there
//! is one, read both providers at one block, on mainnet read prices and payment history, decode,
//! refuse a sealed text that verified none of the proposal's payloads, ask the model, assemble,
//! sign, print. Every way out that is not a signed verdict prints a fixed reason and no signature.
//! An eval run takes the proposal from its input instead, reads only the final block for its
//! clock, and prints its scores unsigned.

use kaap_core::history::history_before;
use kaap_core::{analyze, verdict_hash, AiStatus, Analysis, Effect, FindingCode, Network, TextSource, Verdict};

use crate::ai::{consult, consult_with_budget, AiOutcome, Audience, Check, THINKING_TOKEN_BUDGET};
use crate::attest::evidence::key_for;
use crate::attest::tdx::QuoteCheck;
use crate::attest::{trusted_now, Evidence, EvidenceSink, Trust, Unverified};
use crate::history::read_proposals;
use crate::input::{parse_request, EvalInput, JobInput, Request};
use crate::net::{Deadline, Http};
use crate::output::{below_price, eval_scores, failed, held, refused, TEXT_DOES_NOT_MATCH};
use crate::payment::{gate, worker_account, PayEnv, Payer};
use crate::prices::read_prices;
use crate::proposal::{judge, Past};
use crate::prompt::user_message;
use crate::reads::{read_chain, ChainRead, HOST_CATCH_UP_MS};
use crate::rpc::{At, AccountView, BlockView, Provider, ReadFail, ViewResult};
use crate::texts::{open_text, render_text_key, seal_explanation, TextFail, TextKeys};
use crate::verdict::{assemble, public_key_text, seal, seal_encrypted, sign_sealed, VerdictSigner};

/// OutLayer stops a run at `max_execution_seconds`, which the run script sets to 60. The reads
/// must be done by 25 s and the model by 50 s, leaving time to sign and print.
pub const READ_BUDGET_MS: u64 = 25_000;
pub const JOB_BUDGET_MS: u64 = 50_000;

/// How long the price list and the payment history may take together, cut to the read deadline. It
/// binds the price list's GET whole, and the history between its calls, as `read_chain`'s deadline
/// does. The same number is the room the read deadline must still have before either starts.
pub const PAST_BUDGET_MS: u64 = 8_000;

/// What a run talks to. The published build connects these to OutLayer's host, dRPC, 1Click, NEAR
/// AI, Intel, NVIDIA, the keystore and public storage; tests and the local build connect them to
/// recorded answers, a test key and a stand-in store.
pub struct Connections {
    pub host: Box<dyn Provider>,
    pub https: Box<dyn Provider>,
    /// The job's plain HTTP client, for every outside call that is not a chain read: 1Click's price
    /// list, and NEAR AI, Intel and NVIDIA in the AI step.
    pub http: Box<dyn Http>,
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

/// Runs the job on the raw stdin bytes and returns what it prints.
///
/// `env` is what OutLayer set for the run and `ai_key` the `NEAR_AI_API_KEY` secret. A judge run
/// and an eval run pass `gate` right after their input is parsed, so Kaap's worker runs either free
/// on chain and every other run pays; asking for the text key is free. `connect` is called only for
/// an input that passed every check and a payment that was accepted, with the network and the read
/// deadline, so a refused input or payment makes no outside call at all.
pub fn run(raw: &[u8], env: RunEnv<'_>, ai_key: Option<&str>, connect: impl FnOnce(Network, Deadline) -> Connections) -> String {
    let RunEnv { network, pay } = env;
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
        Request::Eval(input) => match gate(&pay, worker_account(input.network).unwrap_or("")) {
            Ok(_) => eval_run(*input, ai_key, connect),
            Err(why) => below_price(why),
        },
    }
}

/// Scores a proposal handed in whole, for a payer `gate` has already settled, and prints
/// `output::eval_scores`.
///
/// Everything judged comes from the input: kaap-core analyses `input.proposal` as given and the
/// model is asked about those facts, as a public prompt (there is no text channel). The one chain
/// read is the final block's time for the clock (`agreed_head`), which is not printed. Of the rest
/// of what `connect` hands over, only the AI client, the nonce and the quote check are used: no
/// other read, no signature, no text key and no evidence write, so nothing an eval prints or leaves
/// behind carries Kaap's verdict key or sits in Kaap's public storage, whoever pays.
///
/// The clock is a judge run's: `NEAR_BLOCK_TIMESTAMP`, taken as a time only beside a final block
/// both providers agree on (`attest::trusted_now`). With no such block the answer is unverified
/// (`no_clock`) and the scores are still printed. `ai_status` reports what the checks reached. The
/// model reasons within the input's `thinking_budget`, or `THINKING_TOKEN_BUDGET` without one, and
/// the scores print the budget used.
pub fn eval_run(input: EvalInput, ai_key: Option<&str>, connect: impl FnOnce(Network, Deadline) -> Connections) -> String {
    let read_deadline = Deadline::after_ms(READ_BUDGET_MS);
    let job_deadline = Deadline::after_ms(JOB_BUDGET_MS);
    let Connections { mut host, mut https, mut http, nonce, block_timestamp, quote, .. } = connect(input.network, read_deadline);
    let now = match agreed_head(host.as_mut(), https.as_mut(), read_deadline) {
        Some(head) => trusted_now(block_timestamp.as_deref(), head.timestamp_ns),
        None => Err(Unverified::NoClock),
    };
    let analysis = analyze(&input.proposal);
    let facts = user_message(&input.proposal, &analysis);
    let trust = Trust { nonce, now, quote };
    let thinking_budget = input.thinking_budget.unwrap_or(THINKING_TOKEN_BUDGET);
    let (outcome, record) =
        consult_with_budget(http.as_mut(), ai_key, facts.as_deref(), Audience::Public, thinking_budget, job_deadline, &trust);
    eval_scores(&analysis, &outcome, record.completion.as_ref(), thinking_budget).unwrap_or_else(failed)
}

/// The final block both providers agree on, by `reads::read_chain`'s own block rule: the HTTPS
/// provider's final block, then the host's block at that height, asked once more after
/// `HOST_CATCH_UP_MS` when the host is behind, and the two must be the same block (height, hash
/// and time). `None` on a failed read, a disagreement or the read deadline.
fn agreed_head(host: &mut dyn Provider, https: &mut dyn Provider, deadline: Deadline) -> Option<BlockView> {
    if deadline.passed() {
        return None;
    }
    let head = https.block(At::Final).ok()?;
    let at = At::Height(head.height);
    if deadline.passed() {
        return None;
    }
    let host_head = match host.block(at) {
        Ok(block) => block,
        Err(_) => {
            std::thread::sleep(std::time::Duration::from_millis(HOST_CATCH_UP_MS.min(deadline.remaining_ms())));
            if deadline.passed() {
                return None;
            }
            host.block(at).ok()?
        }
    };
    (host_head == head).then_some(head)
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
/// and writes no public evidence. A sealed text that verified none of the proposal's own `sign`
/// payloads, a proposal with none included, ends either run with `TEXT_DOES_NOT_MATCH` after the
/// reads, before the model is asked.
pub fn judge_run(input: JobInput, ai_key: Option<&str>, payer: Payer, connect: impl FnOnce(Network, Deadline) -> Connections) -> String {
    let read_deadline = Deadline::after_ms(READ_BUDGET_MS);
    let job_deadline = Deadline::after_ms(JOB_BUDGET_MS);
    let Connections { mut host, https, mut http, mut signer, mut texts, nonce, block_timestamp, quote, evidence } =
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
    let past = read_past(http.as_mut(), host.as_mut(), https.as_mut(), &input, &read, read_deadline);
    let (proposal, analysis) = judge(&input, text, &read, past);
    if input.text.is_some() && !supplied_text_verified_a_payload(&analysis) {
        return refused(TEXT_DOES_NOT_MATCH);
    }
    let facts = user_message(&proposal, &analysis);
    let trust = Trust { nonce, now: trusted_now(block_timestamp.as_deref(), read.block.timestamp_ns), quote };
    let (outcome, record) = consult(http.as_mut(), ai_key, facts.as_deref(), audience, job_deadline, &trust);
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

/// True when kaap-core found that the run's sealed text hashes to one of this proposal's own `sign`
/// payloads: a `sign_request` effect whose text came from the supplied text (`TextSource::Planted`),
/// and no HASH_MISMATCH, which kaap-core gives every such effect when the text matched none.
///
/// Through this channel the sender is anyone with the job's public key, so a text that verified no
/// payload proves nothing about the proposal, and nothing kaap-core reads from it may reach a
/// verdict (C6, C8). That covers a proposal with no `sign` payload at all and one whose text is
/// already in its description, where kaap-core reports no mismatch but still reads the supplied
/// text: words in it addressed to a model are PROMPT_INJECTION, a high finding that would alarm
/// members. A text that matched but whose deadline has passed still counts here, because it is the
/// proposal's own text; kaap-core reads it as one that can never execute.
fn supplied_text_verified_a_payload(analysis: &Analysis) -> bool {
    let from_the_text = analysis.effects.iter().any(|e| matches!(e, Effect::SignRequest { text_source: Some(TextSource::Planted), .. }));
    from_the_text && !analysis.findings.iter().any(|f| f.code == FindingCode::HashMismatch)
}

/// The prices and payment history this run judges with, both or neither. Testnet reads neither: its
/// tokens have no market price. On mainnet `None`, the safe reading of UNKNOWN_VALUE at high, follows
/// a failed read of either, a proposal whose submission time does not read, or under
/// `PAST_BUDGET_MS` left of the read deadline before the price list or before the history, so that
/// a slow chain read does not stack up. A DAO with no past payments has an empty history, which is
/// still a complete one. Never holds the job.
pub fn read_past(
    http: &mut dyn Http,
    host: &mut dyn Provider,
    https: &mut dyn Provider,
    input: &JobInput,
    read: &ChainRead,
    read_deadline: Deadline,
) -> Option<Past> {
    if input.network != Network::Mainnet {
        return None;
    }
    let submitted = read.proposal.submission_time_ns?;
    let has_room = || read_deadline.remaining_ms() >= PAST_BUDGET_MS;
    if !has_room() {
        return None;
    }
    let budget = read_deadline.earlier(PAST_BUDGET_MS);
    let prices = read_prices(http, budget)?;
    if !has_room() {
        return None;
    }
    let proposals = read_proposals(host, https, &input.dao, &read.block, budget)?;
    let history = history_before(&proposals, submitted, &prices);
    Some(Past { prices, history })
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
/// member's reply key each time it is sealed, with fresh randomness from `texts`, and the record
/// is `Evidence::confidential`: it shows the checks on the model's hardware and nothing the prompt
/// or the answer decides (C12, C26).
pub fn seal_and_publish(
    parts: &Unsigned<'_>,
    outcome: AiOutcome,
    record: Evidence,
    sink: &mut dyn EvidenceSink,
    texts: &mut dyn TextKeys,
) -> Result<(Verdict, String), &'static str> {
    let mut record = if parts.input.text.is_some() { record.confidential() } else { record };
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
/// its description, so the two providers disagree and the job must hold (RUNS.md shows it live).
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
