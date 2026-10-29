//! One run of the job, in order: check the input, read both providers at one block, decode,
//! ask the model, assemble, sign, print. Every way out that is not a signed verdict prints a
//! fixed reason and no signature.

use kaap_core::Network;

use crate::ai::consult;
use crate::input::parse_input;
use crate::net::{Deadline, Http};
use crate::output::{failed, held, refused};
use crate::proposal::judge;
use crate::prompt::user_message;
use crate::reads::{read_chain, HOST_CATCH_UP_MS};
use crate::rpc::{At, AccountView, BlockView, Provider, ReadFail, ViewResult};
use crate::verdict::{assemble, sign_and_render, VerdictSigner};

/// OutLayer stops a run at `max_execution_seconds`, which the run script sets to 60. The reads
/// must be done by 25 s and the model by 50 s, leaving time to sign and print.
pub const READ_BUDGET_MS: u64 = 25_000;
pub const JOB_BUDGET_MS: u64 = 50_000;

/// What a run talks to. The published build connects these to OutLayer's host, dRPC, NEAR AI
/// and the keystore; tests and the local build connect them to recorded answers and a test key.
pub struct Connections {
    pub host: Box<dyn Provider>,
    pub https: Box<dyn Provider>,
    pub ai: Box<dyn Http>,
    pub signer: Box<dyn VerdictSigner>,
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
    let Connections { mut host, https, mut ai, mut signer } = connect(input.network, read_deadline);
    let mut https: Box<dyn Provider> = if input.test_corrupt_https { Box::new(Corrupting(https)) } else { https };

    let read = match read_chain(host.as_mut(), https.as_mut(), &input.dao, input.proposal_id, read_deadline, HOST_CATCH_UP_MS) {
        Ok(read) => read,
        Err(why) => return held(why.reason()),
    };
    let (proposal, analysis) = judge(input.network, &input.dao, input.proposal_id, &read);
    let facts = user_message(&proposal, &analysis);
    let outcome = consult(ai.as_mut(), ai_key, facts.as_deref(), job_deadline);
    let (verdict, explanation) = match assemble(&input, &read, &analysis, &outcome) {
        Ok(parts) => parts,
        Err(why) => return failed(why),
    };
    sign_and_render(verdict, explanation, signer.as_mut()).unwrap_or_else(failed)
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
