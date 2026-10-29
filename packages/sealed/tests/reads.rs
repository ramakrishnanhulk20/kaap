//! The two-provider read on real testnet answers recorded at one block (C22, C4). Not covered
//! here: the OutLayer host itself (its answers are stood in by FastNEAR's, which its RPC is built
//! on; only the parsing of its answer formats is tested, at the end), live network timing, and
//! two providers lying the same way, which is a named non-goal.

mod common;

use common::*;
use kaap_sealed::reads::{called_accounts, parse_proposal, read_chain, receivers_hash, same_proposal, Held, Item};
use kaap_sealed::net::Deadline;
use kaap_sealed::rpc::{host_view_answer, view_account_answer, block_answer, call_function_answer, ReadFail};
use serde_json::{json, Value};

fn read(fx: &Value) -> Result<kaap_sealed::reads::ChainRead, Held> {
    let (mut host, mut https) = providers(fx);
    let dao = fx["dao"].as_str().unwrap().to_string();
    let id = fx["proposal_id"].as_u64().unwrap();
    read_chain(&mut host, &mut https, &dao, id, Deadline::after_ms(60_000), 0)
}

#[test]
fn agreeing_providers_give_a_read_pinned_to_one_block() {
    for name in ["transfer-ft.json", "function-call.json", "vote.json"] {
        let fx = fixture(name);
        let got = read(&fx).unwrap_or_else(|h| panic!("{name}: {}", h.reason()));
        assert_eq!(got.block.height, fx["block_height"].as_u64().unwrap(), "{name}");
        assert_eq!(got.proposal.id, fx["proposal_id"].as_u64().unwrap());
        assert_eq!(got.proposal.status, "InProgress");

        let proposal_text = view_text(&fx, HTTPS, "get_proposal");
        let kind = String::from_utf8(got.proposal.kind_json.clone()).unwrap();
        assert!(proposal_text.contains(&format!("\"kind\":{kind},")), "{name}: kind bytes are not the exact slice");
        assert_eq!(got.kind_hash, kaap_core::kind_hash(kind.as_bytes()).unwrap());

        let policy_text = view_text(&fx, HTTPS, "get_policy");
        assert_eq!(got.policy_json, policy_text.as_bytes());
        assert_eq!(got.policy_hash, kaap_core::policy_hash(policy_text.as_bytes()).unwrap());

        assert!(got.code_hashes.windows(2).all(|w| w[0].0 < w[1].0), "{name}: pairs are sorted by account");
        assert!(got.code_hashes.iter().any(|(a, _)| a == fx["dao"].as_str().unwrap()));
        assert_eq!(got.receivers_hash, receivers_hash(&got.code_hashes));
    }
}

#[test]
fn the_verdict_pins_every_called_contracts_code() {
    let ft = read(&fixture("transfer-ft.json")).unwrap();
    let accounts: Vec<&str> = ft.code_hashes.iter().map(|(a, _)| a.as_str()).collect();
    assert_eq!(accounts, ["corm1gu.sputnikv2.testnet", "nori4qx.tanssg2.testnet"]);

    let call = read(&fixture("function-call.json")).unwrap();
    let accounts: Vec<&str> = call.code_hashes.iter().map(|(a, _)| a.as_str()).collect();
    assert_eq!(accounts, ["r7thmvr8maey.sputnikv2.testnet", "townhall.r7thmvr8maey-council2.testnet"]);

    let vote = read(&fixture("vote.json")).unwrap();
    assert_eq!(vote.code_hashes.len(), 1);

    // A receiver redeploy changes the hash the verdict carries.
    let mut moved = ft.code_hashes.clone();
    moved[1].1 = "11111111111111111111111111111111".into();
    assert_ne!(receivers_hash(&moved), ft.receivers_hash);
}

#[test]
fn any_difference_in_what_is_judged_holds_the_job() {
    type Edit = Box<dyn Fn(&mut Value)>;
    let base = fixture("transfer-ft.json");
    let cases: Vec<(&str, Edit, Held)> = vec![
        (
            "host description differs by one byte",
            Box::new(|fx| edit_view_text(fx, HOST, "get_proposal", |t| t.replacen("subscription", "subscriptioN", 1))),
            Held::Disagree(Item::Proposal),
        ),
        (
            "https description differs",
            Box::new(|fx| edit_view_text(fx, HTTPS, "get_proposal", |t| t.replacen("transfer 10", "transfer 11", 1))),
            Held::Disagree(Item::Proposal),
        ),
        (
            "host kind pays someone else",
            Box::new(|fx| edit_view_text(fx, HOST, "get_proposal", |t| t.replacen("cormudq", "cormudz", 1))),
            Held::Disagree(Item::Proposal),
        ),
        (
            "host votes differ",
            Box::new(|fx| edit_view_text(fx, HOST, "get_proposal", |t| t.replacen("\"Approve\"", "\"Reject\"", 1))),
            Held::Disagree(Item::Proposal),
        ),
        (
            "host policy has another council member",
            Box::new(|fx| edit_view_text(fx, HOST, "get_policy", |t| t.replacen("tanssg2.testnet", "tanssg3.testnet", 1))),
            Held::Disagree(Item::Policy),
        ),
        (
            "host code hash of the token differs",
            Box::new(|fx| edit_answer(fx, HOST, "nori4qx.tanssg2.testnet", |b| b["result"]["code_hash"] = json!("11111111111111111111111111111111"))),
            Held::Disagree(Item::CodeHash),
        ),
        (
            "host block timestamp differs",
            Box::new(|fx| edit_answer(fx, HOST, "block", |b| b["result"]["header"]["timestamp"] = json!(1u64))),
            Held::Disagree(Item::Block),
        ),
        (
            "https proposal read at another block",
            Box::new(|fx| edit_answer(fx, HTTPS, "get_proposal", |b| b["result"]["block_height"] = json!(1u64))),
            Held::WrongBlock,
        ),
        (
            "https token account read at another block",
            Box::new(|fx| edit_answer(fx, HTTPS, "nori4qx.tanssg2.testnet", |b| b["result"]["block_hash"] = json!("x"))),
            Held::WrongBlock,
        ),
        (
            "host answers a contract error",
            Box::new(|fx| edit_answer(fx, HOST, "get_policy", |b| *b = json!({"jsonrpc":"2.0","id":"kaap","error":{"name":"HANDLER_ERROR"}}))),
            Held::HostFailed(Item::Policy),
        ),
        (
            "https answers a contract error inside the result",
            Box::new(|fx| edit_answer(fx, HTTPS, "get_proposal", |b| {
                b["result"].as_object_mut().unwrap().remove("result");
                b["result"]["error"] = json!("wasm execution failed");
            })),
            Held::HttpsFailed(Item::Proposal),
        ),
        (
            "https answers another proposal",
            Box::new(|fx| {
                edit_view_text(fx, HTTPS, "get_proposal", |t| t.replacen("{\"id\":1,", "{\"id\":2,", 1));
                edit_view_text(fx, HOST, "get_proposal", |t| t.replacen("{\"id\":1,", "{\"id\":2,", 1));
            }),
            Held::NotTheProposal,
        ),
        (
            "the proposal carries a duplicate key",
            Box::new(|fx| edit_view_text(fx, HTTPS, "get_proposal", |t| t.replacen("{\"id\":1,", "{\"id\":1,\"id\":1,", 1))),
            Held::NotAProposal,
        ),
        (
            "a result byte over 255",
            Box::new(|fx| edit_answer(fx, HTTPS, "get_policy", |b| b["result"]["result"][0] = json!(379))),
            Held::HttpsFailed(Item::Policy),
        ),
    ];
    for (what, edit, want) in cases {
        let mut fx = base.clone();
        edit(&mut fx);
        assert_eq!(read(&fx).map(|_| ()), Err(want), "{what}");
    }
}

#[test]
fn reordered_sets_are_the_same_policy() {
    let mut fx = fixture("transfer-ft.json");
    let policy: Value = serde_json::from_str(&view_text(&fx, HOST, "get_policy")).unwrap();
    let mut reordered = policy.clone();
    let mut changed = false;
    for role in reordered["roles"].as_array_mut().unwrap() {
        if let Some(perms) = role["permissions"].as_array_mut() {
            if perms.len() > 1 {
                perms.reverse();
                changed = true;
            }
        }
    }
    assert!(changed, "the fixture policy needs a role with two permissions");
    edit_view_text(&mut fx, HOST, "get_policy", |_| reordered.to_string());
    assert!(read(&fx).is_ok(), "set order is not a disagreement");

    let mut swapped_roles = policy.clone();
    swapped_roles["roles"].as_array_mut().unwrap().reverse();
    edit_view_text(&mut fx, HOST, "get_policy", |_| swapped_roles.to_string());
    assert_eq!(read(&fx).map(|_| ()), Err(Held::Disagree(Item::Policy)), "role order is meaning");
}

#[test]
fn a_missing_answer_is_a_failed_read_on_that_side() {
    for (authority, needle, want) in [
        (HTTPS, "block", Held::HttpsFailed(Item::Block)),
        (HTTPS, "get_policy", Held::HttpsFailed(Item::Policy)),
        (HTTPS, "nori4qx.tanssg2.testnet", Held::HttpsFailed(Item::CodeHash)),
        (HOST, "block", Held::HostFailed(Item::Block)),
        (HOST, "get_proposal", Held::HostFailed(Item::Proposal)),
        (HOST, "corm1gu.sputnikv2.testnet", Held::HostFailed(Item::CodeHash)),
    ] {
        let mut fx = fixture("transfer-ft.json");
        exchange(&mut fx, authority, needle)["authority"] = json!("nobody");
        assert_eq!(read(&fx).map(|_| ()), Err(want), "{authority} {needle}");
    }
}

#[test]
fn the_deadline_holds_the_job() {
    let fx = fixture("vote.json");
    let (mut host, mut https) = providers(&fx);
    let got = read_chain(&mut host, &mut https, "r7thmvr8maey.sputnikv2.testnet", 11, Deadline::after_ms(0), 0);
    assert_eq!(got.map(|_| ()), Err(Held::Deadline));
}

#[test]
fn called_accounts_follow_what_sputnik_executes() {
    let dao = "d.sputnikv2.testnet";
    let cases: [(&str, &[&str]); 7] = [
        (r#"{"Transfer":{"token_id":"","receiver_id":"new.testnet","amount":"1","msg":null}}"#, &[dao]),
        (r#"{"Transfer":{"token_id":"usdc.testnet","receiver_id":"a.testnet","amount":"1","msg":null}}"#, &[dao, "usdc.testnet"]),
        (r#"{"Transfer":{"token_id":"usdc.testnet","receiver_id":"a.testnet","amount":"1","msg":"x"}}"#, &[dao, "usdc.testnet", "a.testnet"]),
        (r#"{"FunctionCall":{"receiver_id":"app.testnet","actions":[]}}"#, &[dao, "app.testnet"]),
        (r#"{"UpgradeRemote":{"receiver_id":"app.testnet","method_name":"up","hash":"x"}}"#, &[dao, "app.testnet"]),
        (r#"{"FunctionCall":{"receiver_id":"d.sputnikv2.testnet","actions":[]}}"#, &[dao]),
        (r#""Vote""#, &[dao]),
    ];
    for (kind, want) in cases {
        assert_eq!(called_accounts(dao, kind.as_bytes()).unwrap(), want, "{kind}");
    }
    let bad = r#"{"FunctionCall":{"receiver_id":"Not An Account","actions":[]}}"#;
    assert_eq!(called_accounts(dao, bad.as_bytes()), Err(Held::BadReceiver));
}

#[test]
fn proposal_fields_come_from_one_strict_reading() {
    let text = r#"{"id":3,"proposer":"p.testnet","description":"pay","kind":{"Transfer":{"token_id":"","receiver_id":"a.testnet","amount":"1","msg":null}},"status":"InProgress"}"#;
    let p = parse_proposal(text.as_bytes()).unwrap();
    assert_eq!((p.id, p.description.as_str(), p.status.as_str()), (3, "pay", "InProgress"));
    assert_eq!(p.kind_json, br#"{"Transfer":{"token_id":"","receiver_id":"a.testnet","amount":"1","msg":null}}"#);
    for bad in [
        r#"{"id":3,"id":3,"description":"pay","kind":"Vote"}"#,
        r#"{"id":-3,"description":"pay","kind":"Vote"}"#,
        r#"{"id":3,"description":1,"kind":"Vote"}"#,
        r#"{"id":3,"description":"pay"}"#,
        r#"[1]"#,
        "",
    ] {
        assert_eq!(parse_proposal(bad.as_bytes()), Err(Held::NotAProposal), "{bad}");
    }
    let wide: String = format!("{{\"id\":3,\"description\":\"p\",\"kind\":\"Vote\",{}}}", (0..40).map(|i| format!("\"k{i}\":0")).collect::<Vec<_>>().join(","));
    assert_eq!(parse_proposal(wide.as_bytes()), Err(Held::NotAProposal), "too many fields");

    let reordered_kind = r#"{"id":3,"description":"pay","kind":{"ChangePolicyAddOrUpdateRole":{"role":{"name":"r","kind":{"Group":["b.testnet","a.testnet"]},"permissions":["*:Finalize"],"vote_policy":{}}}}}"#;
    let original = r#"{"id":3,"description":"pay","kind":{"ChangePolicyAddOrUpdateRole":{"role":{"name":"r","kind":{"Group":["a.testnet","b.testnet"]},"permissions":["*:Finalize"],"vote_policy":{}}}}}"#;
    assert!(same_proposal(reordered_kind.as_bytes(), original.as_bytes()), "member order inside a kind is a set");
    assert!(!same_proposal(original.as_bytes(), original.replace("pay", "Pay").as_bytes()));
}

#[test]
fn host_answer_formats_parse_like_the_https_ones() {
    let fx = fixture("transfer-ft.json");
    // The host re-serialises the RPC answer it got (serde_json, keys sorted) and hands it over as a
    // string for view_account and block, and as decoded text for view.
    let mut f = fx.clone();
    let raw = exchange(&mut f, HOST, "corm1gu.sputnikv2.testnet")["body"].as_str().unwrap().to_string();
    let resorted = serde_json::from_str::<Value>(&raw).unwrap().to_string();
    assert_eq!(view_account_answer(resorted.as_bytes()).unwrap(), view_account_answer(raw.as_bytes()).unwrap());
    let raw_block = exchange(&mut f, HOST, "block")["body"].as_str().unwrap().to_string();
    assert_eq!(block_answer(raw_block.as_bytes()).unwrap().height, fx["block_height"].as_u64().unwrap());

    let text = view_text(&fx, HOST, "get_proposal");
    assert_eq!(host_view_answer(text.clone(), "").unwrap().bytes, text.as_bytes());
    let envelope = r#"{"id":"proxy","jsonrpc":"2.0","result":{"block_hash":"h","block_height":1,"error":"wasm execution failed","logs":[]}}"#;
    assert_eq!(host_view_answer(envelope.into(), ""), Err(ReadFail::RpcError));
    assert_eq!(host_view_answer(text, "rate limit"), Err(ReadFail::RpcError));
    assert_eq!(host_view_answer("x".repeat(512 * 1024 + 1), ""), Err(ReadFail::TooLarge));

    assert_eq!(call_function_answer(b"not json"), Err(ReadFail::NotJson));
    assert_eq!(call_function_answer(br#"{"jsonrpc":"2.0","result":{"block_hash":"h","block_height":1,"result":[1,2]},"result":{}}"#), Err(ReadFail::Shape));
    let short_hash = r#"{"jsonrpc":"2.0","result":{"code_hash":"1111","block_hash":"h","block_height":1}}"#;
    assert_eq!(view_account_answer(short_hash.as_bytes()), Err(ReadFail::Shape));
}
