//! A DAO's stored proposals, the raw material of its payment history (`kaap_core::history`). Read at
//! the run's pinned block from both providers, which must return the same bytes for the counter and
//! for every page (C22), so the history is held to the same rule as the proposal it judges. The CLI
//! reads these pages from one provider.
//!
//! The job has seconds to spare, so this is stricter than the CLI's reader: it covers 300 ids where
//! the CLI covers 5,000, and a page that fails is a failed read, never split into smaller ones.
//! Every read goes through `Provider`, so a page's byte cap is the provider's own, 512 KiB of result
//! and 2.1 MiB of JSON-RPC body, tighter than the CLI's `MAX_PAGE_BODY_BYTES`. A larger page is a
//! failed read.
//!
//! What this does not cover: both providers lying the same way, and a contract that is not Sputnik.
//! The deadline is checked between calls as in `read_chain`, so it cannot cut one call short: dRPC's
//! own limit and the host's 30 s bound that.

use serde_json::Value;

use crate::net::Deadline;
use crate::reads::pinned;
use crate::rpc::{At, BlockView, Provider};

pub const MAX_HISTORY_PAGES: u64 = 3;
pub const PAGE_SIZE: u64 = 100;

/// Every stored proposal of `dao` at `block`, in page order, or `None` for a failed read: more than
/// `MAX_HISTORY_PAGES` pages of ids, a read refused or over the cap, an HTTPS answer not at `block`,
/// a counter or page that does not parse, a page longer than asked for, the two providers' bytes
/// differing anywhere, or `deadline` passing. Never holds the job.
pub fn read_proposals(
    host: &mut dyn Provider,
    https: &mut dyn Provider,
    dao: &str,
    block: &BlockView,
    deadline: Deadline,
) -> Option<Vec<Value>> {
    let mut agreed = |method: &str, args: &str| -> Option<Vec<u8>> {
        let at = At::Height(block.height);
        if deadline.passed() {
            return None;
        }
        let answer = https.call_function(dao, method, args, at).ok()?;
        pinned(&answer, block).ok()?;
        if deadline.passed() {
            return None;
        }
        let other = host.call_function(dao, method, args, at).ok()?;
        (other.bytes == answer.bytes).then_some(answer.bytes)
    };

    let ids: u64 = serde_json::from_slice(&agreed("get_last_proposal_id", "{}")?).ok()?;
    let pages = ids.div_ceil(PAGE_SIZE);
    if pages > MAX_HISTORY_PAGES {
        return None;
    }
    let mut proposals = Vec::new();
    for page in 0..pages {
        let args = format!("{{\"from_index\":{},\"limit\":{PAGE_SIZE}}}", page * PAGE_SIZE);
        let list: Vec<Value> = serde_json::from_slice(&agreed("get_proposals", &args)?).ok()?;
        if u64::try_from(list.len()).ok()? > PAGE_SIZE {
            return None;
        }
        proposals.extend(list);
    }
    Some(proposals)
}

// The reader against a stand-in provider. Whole runs with it are in tests/prices.rs.
#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::rpc::{AccountView, ReadFail, ViewResult};

    type Edit = fn(&str, Vec<u8>) -> Result<Vec<u8>, ReadFail>;

    fn block() -> BlockView {
        BlockView { height: 77, hash: "hash".into(), timestamp_ns: 1 }
    }

    /// One provider of one DAO with `ids` proposals, or whatever `edit` turns a call's bytes into.
    struct Chain {
        https: bool,
        ids: u64,
        edit: Edit,
        calls: Vec<String>,
    }

    impl Chain {
        fn new(https: bool, ids: u64) -> Chain {
            Chain { https, ids, edit: |_, bytes| Ok(bytes), calls: Vec::new() }
        }
    }

    impl Provider for Chain {
        fn call_function(&mut self, account: &str, method: &str, args_json: &str, at: At) -> Result<ViewResult, ReadFail> {
            assert_eq!((account, at), ("dao.near", At::Height(77)));
            self.calls.push(format!("{method} {args_json}"));
            let bytes = if method == "get_last_proposal_id" {
                self.ids.to_string().into_bytes()
            } else {
                let args: Value = serde_json::from_str(args_json).unwrap();
                let from = args["from_index"].as_u64().unwrap();
                assert_eq!(args["limit"], 100);
                let list: Vec<Value> = (from..self.ids.min(from + 100)).map(|id| json!({ "id": id })).collect();
                serde_json::to_vec(&list).unwrap()
            };
            let bytes = (self.edit)(args_json, bytes)?;
            let (block_height, block_hash) = if self.https { (Some(77), Some("hash".to_string())) } else { (None, None) };
            Ok(ViewResult { bytes, block_height, block_hash })
        }

        fn view_account(&mut self, _: &str, _: At) -> Result<AccountView, ReadFail> {
            panic!("no account is read here")
        }

        fn block(&mut self, _: At) -> Result<BlockView, ReadFail> {
            panic!("no block is read here")
        }
    }

    fn read(host: &mut Chain, https: &mut Chain) -> Option<Vec<Value>> {
        read_proposals(host, https, "dao.near", &block(), Deadline::after_ms(1_000))
    }

    fn pair(ids: u64) -> (Chain, Chain) {
        (Chain::new(false, ids), Chain::new(true, ids))
    }

    #[test]
    fn it_reads_every_page_from_both_providers_and_joins_them_in_order() {
        let (mut host, mut https) = pair(250);
        let got = read(&mut host, &mut https).unwrap();
        assert_eq!(got.len(), 250);
        assert_eq!((got[0]["id"].as_u64(), got[249]["id"].as_u64()), (Some(0), Some(249)));
        let want = [
            r#"get_last_proposal_id {}"#,
            r#"get_proposals {"from_index":0,"limit":100}"#,
            r#"get_proposals {"from_index":100,"limit":100}"#,
            r#"get_proposals {"from_index":200,"limit":100}"#,
        ];
        assert_eq!(https.calls, want);
        assert_eq!(host.calls, want);
    }

    #[test]
    fn three_hundred_ids_are_read_and_three_hundred_and_one_are_not() {
        let (mut host, mut https) = pair(300);
        assert_eq!(read(&mut host, &mut https).unwrap().len(), 300);
        let (mut host, mut https) = pair(301);
        assert_eq!(read(&mut host, &mut https), None);
        assert_eq!(https.calls, ["get_last_proposal_id {}"], "no page is read past the limit");
    }

    #[test]
    fn a_dao_with_no_ids_has_an_empty_complete_read() {
        let (mut host, mut https) = pair(0);
        assert_eq!(read(&mut host, &mut https), Some(Vec::new()));
        assert_eq!(https.calls.len(), 1);
    }

    #[test]
    fn a_refused_second_page_is_a_failed_read_and_never_split() {
        let (mut host, mut https) = pair(150);
        host.edit = |args, bytes| if args.contains(":100,") { Err(ReadFail::TooLarge) } else { Ok(bytes) };
        assert_eq!(read(&mut host, &mut https), None);
        assert_eq!(host.calls.len(), 3, "the page was not asked for again: {:?}", host.calls);

        let (mut host, mut https) = pair(150);
        https.edit = |args, bytes| if args.contains(":100,") { Err(ReadFail::RpcError) } else { Ok(bytes) };
        assert_eq!(read(&mut host, &mut https), None);
        assert_eq!(https.calls.len(), 3);
    }

    #[test]
    fn one_byte_of_difference_on_any_read_is_a_failed_read() {
        let (mut host, mut https) = pair(150);
        host.edit = |args, mut bytes| {
            if args.contains(":100,") {
                bytes.push(b' ');
            }
            Ok(bytes)
        };
        assert_eq!(read(&mut host, &mut https), None);

        let (mut host, mut https) = pair(150);
        host.edit = |_, _| Ok(b"151".to_vec());
        assert_eq!(read(&mut host, &mut https), None);
        assert_eq!(host.calls.len(), 1, "the counter already disagrees");
    }

    #[test]
    fn an_answer_that_is_not_what_was_asked_for_is_a_failed_read() {
        let not_a_list: Edit = |args, bytes| if args == "{}" { Ok(bytes) } else { Ok(br#"{"id":1}"#.to_vec()) };
        let too_long: Edit = |args, bytes| if args == "{}" { Ok(bytes) } else { Ok(serde_json::to_vec(&vec![0; 101]).unwrap()) };
        let no_counter: Edit = |_, _| Ok(b"-1".to_vec());
        for edit in [not_a_list, too_long, no_counter] {
            let (mut host, mut https) = pair(5);
            (host.edit, https.edit) = (edit, edit);
            assert_eq!(read(&mut host, &mut https), None);
        }
    }

    #[test]
    fn an_https_answer_at_another_block_is_a_failed_read() {
        struct Stale(Chain);
        impl Provider for Stale {
            fn call_function(&mut self, a: &str, m: &str, j: &str, at: At) -> Result<ViewResult, ReadFail> {
                Ok(ViewResult { block_height: Some(76), ..self.0.call_function(a, m, j, at)? })
            }
            fn view_account(&mut self, a: &str, at: At) -> Result<AccountView, ReadFail> {
                self.0.view_account(a, at)
            }
            fn block(&mut self, at: At) -> Result<BlockView, ReadFail> {
                self.0.block(at)
            }
        }
        let (mut host, https) = pair(5);
        let got = read_proposals(&mut host, &mut Stale(https), "dao.near", &block(), Deadline::after_ms(1_000));
        assert_eq!(got, None);
        assert!(host.calls.is_empty(), "the host is not asked after a bad https answer");
    }

    #[test]
    fn a_passed_deadline_stops_before_any_call() {
        let (mut host, mut https) = pair(5);
        assert_eq!(read_proposals(&mut host, &mut https, "dao.near", &block(), Deadline::after_ms(0)), None);
        assert!(host.calls.is_empty() && https.calls.is_empty());
    }
}
