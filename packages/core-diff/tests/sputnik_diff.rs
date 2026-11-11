// Differential test: kaap-core's port of Sputnik's `can_execute_action` and of the threshold in
// `proposal_status` (kaap_core::policy::sputnik) against the real Sputnik DAO 3.2 binary.
//
// The policies are a fixed list: the policy before of the first 20 distinct DAOs, in record-id
// order, among eval/real/sample.jsonl records with a policy kind. Four planted policies
// are added because no real one has duplicate role names or a reject-only guard: the after policies
// of planted:11, 12 and 13 (two roles of one name) and the planted harness policy. Each policy is
// deployed exactly as written on Sputnik 3.2 (code hash checked) in a fresh sandbox, with every
// member under its real account id plus one outsider. Then, for each of the 17 kinds:
//   1. every account tries to file a proposal of that kind (AddProposal);
//   2. for each Group role that can vote on the kind, every account in it votes one by one on its
//      own fresh proposal (VoteReject where the role holds it, else VoteRemove, else VoteApprove on
//      kinds whose execution changes nothing), and after each vote the status the binary reports is
//      compared with the status the port predicts from `can_execute_action` and `votes_needed`;
//   3. on a decided proposal every account tries every other action, and the binary's answer is
//      compared with `can_execute_action`; RemoveProposal goes last.
//
// What it does NOT cover: token-weighted voting (no staking contract here, and none of the 24
// policies uses TokenWeight or a Member role); approving the six kinds whose execution changes the
// DAO or panics without setup (upgrade_self, upgrade_remote, set_vote_token, add_bounty,
// bounty_done, factory_info_update), which are filed, rejected and removed but never approved;
// a bounty_done proposal actually being decided, since the bounty it names does not exist and the
// deciding vote is checked through the ERR_NO_BOUNTY panic instead; RemoveProposal for more than
// one allowed account per kind; proposal expiry.
//
// One more test uses the same sandbox setup: `guard_arming_agrees_with_the_binary` checks
// `policy::arming` (C16) on the testnet demo DAO's policy and three edits of it, the guard's own
// reject and the other accounts `others_who_reject_alone` lists.
//
// Run inside WSL after `bash scripts/fetch-sputnik-wasm.sh`. NEAR_SANDBOX_BIN_PATH may point at a
// neard sandbox binary already on disk; otherwise near-sandbox downloads one.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, ensure, Result};
use kaap_core::policy::arming::guard_arming;
use kaap_core::policy::sputnik::{can_execute_action, threshold, votes_needed, Action, Policy, RoleKind, WeightKind, LABELS};
use near_api::types::account::ContractState;
use near_api::{Account, AccountId, Contract, CryptoHash, NearGas, NearToken, NetworkConfig, Signer};
use near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY;
use near_sandbox::Sandbox;
use serde_json::{json, Value};
use tokio::sync::{Semaphore, SemaphorePermit};
use tokio::task::JoinSet;

const REPO_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
/// Written by scripts/fetch-sputnik-wasm.sh, which takes the code every 3.2 DAO runs from mainnet.
const SPUTNIK_WASM: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../contracts/tests/wasm/sputnik-dao-3.2.wasm");
const SPUTNIK_CODE_HASH: &str = "DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF";

const POLICY_KINDS: [&str; 7] = [
    "ChangePolicy",
    "AddMemberToRole",
    "RemoveMemberFromRole",
    "ChangePolicyAddOrUpdateRole",
    "ChangePolicyRemoveRole",
    "ChangePolicyUpdateDefaultVotePolicy",
    "ChangePolicyUpdateParameters",
];
const OUTSIDER: &str = "outsider.kaap-diff";
const DAO: &str = "dao.kaap-diff";
const NO_ROLE: &str = "kaap-diff-no-such-role";
const NO_CODE: &str = "11111111111111111111111111111111";

/// Kinds whose execution, once approved, changes nothing in the DAO: an approve run is safe.
const APPROVE_SAFE: [&str; 11] = [
    "config",
    "policy",
    "add_member_to_role",
    "remove_member_from_role",
    "call",
    "transfer",
    "vote",
    "policy_add_or_update_role",
    "policy_remove_role",
    "policy_update_default_vote_policy",
    "policy_update_parameters",
];

/// Each sandbox is a full neard process. One at a time: four at once, beside a build, used up the
/// machine's memory and froze the WSL VM on 29 Oct 2026. Run with `-- --test-threads=1` so the
/// tests in this file never overlap either.
static SANDBOXES: Semaphore = Semaphore::const_new(1);
/// Transactions one account may have in flight. near-api numbers them from one nonce cache, and
/// a small window keeps a late lower nonce from being refused.
const PER_ACCOUNT: usize = 4;

#[tokio::test(flavor = "multi_thread")]
async fn sputnik_rules_agree_with_the_binary() -> Result<()> {
    let code = sputnik_wasm()?;
    let mut cases = twenty_real_policies()?;
    cases.extend(planted_policies()?);
    let mut runs = JoinSet::new();
    for (name, policy) in cases {
        let code = code.clone();
        runs.spawn(async move { check_policy(name, policy, code).await });
    }
    let mut reports = Vec::new();
    while let Some(report) = runs.join_next().await {
        reports.push(report??);
    }
    reports.sort_by(|a, b| a.name.cmp(&b.name));

    println!("\n{:<52} {:<34} {:>6} {:>6} {:>8}", "policy", "roles", "checks", "votes", "disagree");
    let (mut checks, mut votes, mut disagreements) = (0, 0, Vec::new());
    for r in &reports {
        println!("{:<52} {:<34} {:>6} {:>6} {:>8}", r.name, r.roles, r.checks, r.votes, r.disagreements.len());
        checks += r.checks;
        votes += r.votes;
        disagreements.extend(r.disagreements.iter().cloned());
    }
    println!("{} policies, {checks} checks, {votes} of them votes, {} disagreements", reports.len(), disagreements.len());
    for d in &disagreements {
        println!("  DISAGREE {d}");
    }
    for r in &reports {
        for note in &r.notes {
            println!("  note {}: {note}", r.name);
        }
    }
    ensure!(reports.len() == 24, "expected 20 real and 4 planted policies, ran {}", reports.len());
    ensure!(reports.iter().all(|r| r.checks > 0), "a policy ran no checks");
    ensure!(disagreements.is_empty(), "{} disagreements with the binary", disagreements.len());
    Ok(())
}

fn sputnik_wasm() -> Result<Vec<u8>> {
    let code = std::fs::read(SPUTNIK_WASM)
        .map_err(|e| anyhow::anyhow!("cannot read {SPUTNIK_WASM} ({e}); run `bash scripts/fetch-sputnik-wasm.sh` first"))?;
    let hash = CryptoHash::hash(&code).to_string();
    ensure!(hash == SPUTNIK_CODE_HASH, "{SPUTNIK_WASM} hashes to {hash}, not Sputnik 3.2");
    Ok(code)
}

fn read_jsonl(file: &str) -> Result<Vec<Value>> {
    let text = std::fs::read_to_string(Path::new(REPO_ROOT).join(file))?;
    Ok(text.lines().filter(|l| !l.trim().is_empty()).map(serde_json::from_str).collect::<Result<_, _>>()?)
}

fn variant(kind: &Value) -> Option<&str> {
    match kind {
        Value::String(s) => Some(s),
        Value::Object(map) if map.len() == 1 => map.keys().next().map(String::as_str),
        _ => None,
    }
}

fn twenty_real_policies() -> Result<Vec<(String, Value)>> {
    let mut records = read_jsonl("eval/real/sample.jsonl")?;
    records.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    let (mut seen, mut out) = (BTreeSet::new(), Vec::new());
    for r in records {
        if !variant(&r["kind"]).is_some_and(|v| POLICY_KINDS.contains(&v)) {
            continue;
        }
        let dao = r["dao"].as_str().unwrap_or_default().to_string();
        if !seen.insert(dao) {
            continue;
        }
        let id = r["id"].as_str().unwrap_or_default().to_string();
        let policy = r["context"]["policy_before"].clone();
        ensure!(!policy.is_null(), "{id} has no policy before");
        out.push((id, policy));
        if out.len() == 20 {
            break;
        }
    }
    ensure!(out.len() == 20, "sample.jsonl has {} DAOs with a policy record", out.len());
    Ok(out)
}

fn planted_policies() -> Result<Vec<(String, Value)>> {
    let records = read_jsonl("eval/planted/labels.jsonl")?;
    let find = |id: &str| records.iter().find(|r| r["id"] == id).cloned().ok_or_else(|| anyhow::anyhow!("{id} missing"));
    let mut out = vec![("planted harness policy".to_string(), find("planted:01")?["context"]["policy_before"].clone())];
    for id in ["planted:11", "planted:12", "planted:13"] {
        out.push((format!("{id} after"), find(id)?["kind"]["ChangePolicy"]["policy"].clone()));
    }
    Ok(out)
}

struct Report {
    name: String,
    roles: String,
    checks: usize,
    votes: usize,
    disagreements: Vec<String>,
    notes: Vec<String>,
}

#[derive(Default)]
struct LabelReport {
    checks: usize,
    votes: usize,
    disagreements: Vec<String>,
    notes: Vec<String>,
}

impl LabelReport {
    fn compare(&mut self, what: String, expected: &Expect, actual: &Actual) {
        self.checks += 1;
        if !expected.accepts(actual) {
            self.disagreements.push(format!("{what}: port {expected:?}, binary {actual:?}"));
        }
    }
}

/// One deployed DAO in its own sandbox.
struct Dao {
    _slot: SemaphorePermit<'static>,
    _sandbox: Sandbox,
    network: NetworkConfig,
    signer: Arc<Signer>,
    id: AccountId,
    name: String,
    policy_json: Value,
    policy: Policy,
    bond: u128,
    /// Every Group member, sorted, then the outsider.
    accounts: Vec<String>,
    lanes: BTreeMap<String, Arc<Semaphore>>,
}

async fn check_policy(name: String, policy_json: Value, code: Vec<u8>) -> Result<Report> {
    let dao = deploy(&name, policy_json, code).await?;
    let roles = dao
        .policy
        .roles
        .iter()
        .map(|r| match &r.kind {
            RoleKind::Group(g) => format!("{}[{}]", r.name, g.len()),
            RoleKind::Everyone => format!("{}[all]", r.name),
            RoleKind::Member(_) => format!("{}[tokens]", r.name),
        })
        .collect::<Vec<_>>()
        .join(" ");
    let mut labels = JoinSet::new();
    for label in LABELS {
        let dao = dao.clone();
        labels.spawn(async move { check_label(dao, label).await });
    }
    let mut report = Report { name, roles, checks: 0, votes: 0, disagreements: Vec::new(), notes: Vec::new() };
    while let Some(r) = labels.join_next().await {
        let r = r??;
        report.checks += r.checks;
        report.votes += r.votes;
        report.disagreements.extend(r.disagreements);
        report.notes.extend(r.notes);
    }
    println!("done {}: {} checks, {} disagreements", report.name, report.checks, report.disagreements.len());
    Ok(report)
}

/// Deploys Sputnik 3.2 with `policy_json` in a fresh sandbox, every Group member and the outsider
/// as funded accounts, and checks the code hash after deploy.
async fn deploy(name: &str, policy_json: Value, code: Vec<u8>) -> Result<Arc<Dao>> {
    let policy = Policy::from_json(&policy_json).ok_or_else(|| anyhow::anyhow!("{name}: the port cannot read this policy"))?;
    let slot = SANDBOXES.acquire().await?;
    let sandbox = Sandbox::start_sandbox().await?;
    let network = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    // Accounts made by the sandbox share the genesis test key, which is public by design.
    let signer = Signer::from_secret_key(DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;

    let mut members = BTreeSet::new();
    for role in &policy.roles {
        if let Some(group) = role.members() {
            members.extend(group.iter().cloned());
        }
    }
    let mut accounts: Vec<String> = members.into_iter().collect();
    accounts.push(OUTSIDER.to_string());
    for account in &accounts {
        sandbox.create_account(account.parse()?).initial_balance(NearToken::from_near(1000)).send().await?;
    }
    let id: AccountId = DAO.parse()?;
    sandbox.create_account(id.clone()).initial_balance(NearToken::from_near(100)).send().await?;
    let mut last = String::new();
    for attempt in 1..=3u64 {
        let sent = Contract::deploy(id.clone())
            .use_code(code.clone())
            .with_init_call("new", json!({ "config": config(), "policy": policy_json }))?
            .max_gas()
            .with_signer(signer.clone())
            .send_to(&network)
            .await;
        match sent {
            Ok(outcome) => {
                outcome.into_result()?;
                last.clear();
                break;
            }
            // A timed-out answer (the sandbox RPC's 408) does not say whether the deploy landed,
            // so look for the initialised DAO before sending it again.
            Err(e) => {
                last = e.to_string();
                tokio::time::sleep(Duration::from_secs(2 * attempt)).await;
                let live = Contract(id.clone()).call_function("get_policy", json!({})).read_only::<Value>().fetch_from(&network).await;
                if live.is_ok() {
                    last.clear();
                    break;
                }
            }
        }
    }
    ensure!(last.is_empty(), "{name}: the deploy never reached the sandbox: {last}");
    let deployed = Account(id.clone()).view().fetch_from(&network).await?.data;
    ensure!(deployed.contract_state == ContractState::LocalHash(SPUTNIK_CODE_HASH.parse()?), "{name}: not Sputnik 3.2 after deploy");

    let lanes = accounts.iter().map(|a| (a.clone(), Arc::new(Semaphore::new(PER_ACCOUNT)))).collect();
    Ok(Arc::new(Dao {
        _slot: slot,
        _sandbox: sandbox,
        network,
        signer,
        id,
        name: name.to_string(),
        bond: policy.proposal_bond,
        policy_json,
        policy,
        accounts,
        lanes,
    }))
}

fn config() -> Value {
    json!({ "name": "kaap-diff", "purpose": "kaap differential test", "metadata": "" })
}

impl Dao {
    /// A proposal of each kind whose execution is harmless or never reached (see APPROVE_SAFE).
    fn kind_for(&self, label: &str) -> Value {
        let p = &self.policy_json;
        match label {
            "config" => json!({ "ChangeConfig": { "config": config() } }),
            "policy" => json!({ "ChangePolicy": { "policy": p } }),
            "add_member_to_role" => json!({ "AddMemberToRole": { "member_id": OUTSIDER, "role": NO_ROLE } }),
            "remove_member_from_role" => json!({ "RemoveMemberFromRole": { "member_id": OUTSIDER, "role": NO_ROLE } }),
            "call" => json!({ "FunctionCall": { "receiver_id": DAO, "actions": [
                { "method_name": "get_config", "args": "e30=", "deposit": "0", "gas": "10000000000000" }
            ] } }),
            "upgrade_self" => json!({ "UpgradeSelf": { "hash": NO_CODE } }),
            "upgrade_remote" => json!({ "UpgradeRemote": { "receiver_id": OUTSIDER, "method_name": "upgrade", "hash": NO_CODE } }),
            "transfer" => json!({ "Transfer": { "token_id": "", "receiver_id": OUTSIDER, "amount": "1", "msg": null } }),
            "set_vote_token" => json!({ "SetStakingContract": { "staking_id": "staking.kaap-diff" } }),
            "add_bounty" => json!({ "AddBounty": { "bounty": {
                "description": "kaap diff", "token": "", "amount": "1", "times": 1, "max_deadline": "86400000000000"
            } } }),
            "bounty_done" => json!({ "BountyDone": { "bounty_id": 0, "receiver_id": OUTSIDER } }),
            "vote" => json!("Vote"),
            "factory_info_update" => json!({ "FactoryInfoUpdate": { "factory_info": { "factory_id": "sputnik-dao.near", "auto_update": false } } }),
            "policy_add_or_update_role" => json!({ "ChangePolicyAddOrUpdateRole": { "role": p["roles"][0] } }),
            "policy_remove_role" => json!({ "ChangePolicyRemoveRole": { "role": NO_ROLE } }),
            "policy_update_default_vote_policy" => {
                json!({ "ChangePolicyUpdateDefaultVotePolicy": { "vote_policy": p["default_vote_policy"] } })
            }
            "policy_update_parameters" => json!({ "ChangePolicyUpdateParameters": { "parameters": {
                "proposal_bond": null, "proposal_period": null, "bounty_bond": null, "bounty_forgiveness_period": null
            } } }),
            _ => Value::Null,
        }
    }

    /// One function call from `caller`, as the contract answered it: the JSON result, or the
    /// panic text. Only a failure to reach the sandbox is an error.
    async fn send(&self, caller: &str, method: &str, args: Value, deposit: u128) -> Result<Actual> {
        let lane = self.lanes.get(caller).ok_or_else(|| anyhow::anyhow!("no lane for {caller}"))?.clone();
        let _turn = lane.acquire().await?;
        let caller_id: AccountId = caller.parse()?;
        let mut last = String::new();
        for attempt in 1..=3u64 {
            let sent = Contract(self.id.clone())
                .call_function(method, args.clone())
                .transaction()
                .deposit(NearToken::from_yoctonear(deposit))
                .gas(NearGas::from_tgas(200))
                .with_signer(caller_id.clone(), self.signer.clone())
                .send_to(&self.network)
                .await;
            match sent {
                Ok(outcome) => {
                    return Ok(match outcome.into_result() {
                        Ok(success) => Actual::Done(success.json::<Value>().unwrap_or(Value::Null)),
                        Err(failure) => Actual::Refused(panic_text(&failure.to_string())),
                    })
                }
                Err(e) => {
                    last = e.to_string();
                    tokio::time::sleep(Duration::from_millis(300 * attempt)).await;
                }
            }
        }
        bail!("{}: {caller} {method} never reached the sandbox: {last}", self.name)
    }

    async fn file(&self, caller: &str, kind: &Value) -> Result<Actual> {
        self.send(caller, "add_proposal", json!({ "proposal": { "description": "kaap diff", "kind": kind } }), self.bond).await
    }

    async fn act(&self, caller: &str, id: u64, action: Action, kind: &Value) -> Result<Actual> {
        self.send(caller, "act_proposal", json!({ "id": id, "action": action.to_policy_label(), "proposal": kind }), 0).await
    }

    /// The proposal's status, or "Removed" once Sputnik has deleted it.
    async fn status(&self, id: u64) -> Result<String> {
        let read = Contract(self.id.clone())
            .call_function("get_proposal", json!({ "id": id }))
            .read_only::<Value>()
            .fetch_from(&self.network)
            .await;
        match read {
            Ok(r) => r.data["status"].as_str().map(str::to_string).ok_or_else(|| anyhow::anyhow!("proposal {id} has no status")),
            Err(e) if format!("{e:?}").contains("ERR_NO_PROPOSAL") => Ok("Removed".to_string()),
            Err(e) => Err(e.into()),
        }
    }
}

/// The text after "Smart contract panicked: ", or the whole failure when there is none.
fn panic_text(failure: &str) -> String {
    match failure.split_once("Smart contract panicked: ") {
        Some((_, rest)) => rest.split(['"', ')']).next().unwrap_or(rest).to_string(),
        None => failure.chars().take(200).collect(),
    }
}

#[derive(Debug)]
enum Actual {
    Done(Value),
    Refused(String),
}

/// What the port says the binary will answer.
#[derive(Debug)]
enum Expect {
    Allowed,
    Refused(&'static str),
    /// The vote goes through and leaves the proposal in one of these statuses. More than one
    /// only when two of the voter's roles would decide differently, where Sputnik's hash-map
    /// order picks.
    Status(BTreeSet<String>),
}

impl Expect {
    fn accepts(&self, actual: &Actual) -> bool {
        match (self, actual) {
            (Expect::Allowed, Actual::Done(_)) => true,
            (Expect::Refused(text), Actual::Refused(got)) => got.contains(text),
            (Expect::Status(_), Actual::Done(_)) => true,
            _ => false,
        }
    }
}

const DENIED: &str = "ERR_PERMISSION_DENIED";
const NO_BOUNTY: &str = "ERR_NO_BOUNTY";

/// The threshold the port gives `role` on `label` in this sandbox: `votes_needed` for a role that
/// counts heads, Sputnik's token formula with no delegation (the sandbox has none) otherwise, and
/// `None` for an Everyone role, which `proposal_status` skips.
fn role_threshold(policy: &Policy, role: &str, label: &str) -> Option<u128> {
    let first = policy.first_role(role)?;
    match &first.kind {
        RoleKind::Everyone => None,
        RoleKind::Group(_) if policy.vote_policy_for(first, label).weight_kind == WeightKind::RoleWeight => {
            Some(votes_needed(policy, role, label))
        }
        _ => threshold(policy, role, label, 0),
    }
}

/// Sputnik's `proposal_status` loop (policy.rs 397-433) over `roles` with these vote counts: the
/// set of statuses the first deciding role could give, or InProgress when none decides.
fn decide(policy: &Policy, counts: &BTreeMap<String, [u128; 3]>, roles: &[String], label: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for role in roles {
        let Some(t) = role_threshold(policy, role, label) else { continue };
        let c = counts.get(role).copied().unwrap_or([0; 3]);
        let status = if c[0] >= t {
            "Approved"
        } else if c[1] >= t {
            "Rejected"
        } else if c[2] >= t {
            "Removed"
        } else {
            continue;
        };
        out.insert(status.to_string());
    }
    if out.is_empty() {
        out.insert("InProgress".to_string());
    }
    out
}

/// Sputnik's `update_votes` (proposals.rs 256-283) for one vote, then `decide`. Every voter here
/// has no delegated tokens, so a token-weighted role counts the vote as zero.
fn predict_vote(policy: &Policy, counts: &mut BTreeMap<String, [u128; 3]>, voter: &str, label: &str, action: Action) -> Expect {
    let (roles, allowed) = can_execute_action(policy, voter, label, action);
    if !allowed {
        return Expect::Refused(DENIED);
    }
    let slot = match action {
        Action::VoteApprove => 0,
        Action::VoteReject => 1,
        _ => 2,
    };
    for role in &roles {
        let token_weighted = policy
            .first_role(role)
            .is_some_and(|r| policy.vote_policy_for(r, label).weight_kind == WeightKind::TokenWeight);
        counts.entry(role.clone()).or_insert([0; 3])[slot] += u128::from(!token_weighted);
    }
    let status = decide(policy, counts, &roles, label);
    // A BountyDone that a vote rejects or removes hands the bounty back through the payout
    // (proposals.rs 644-652 and 501-520), and the bounty this harness names does not exist, so the
    // binary panics with ERR_NO_BOUNTY on exactly the vote that decides the proposal.
    if label == "bounty_done" && !status.contains("InProgress") {
        return Expect::Refused(NO_BOUNTY);
    }
    Expect::Status(status)
}

async fn check_label(dao: Arc<Dao>, label: &'static str) -> Result<LabelReport> {
    let mut report = LabelReport::default();
    let kind = dao.kind_for(label);
    let policy = &dao.policy;

    let mut filings = JoinSet::new();
    for account in dao.accounts.clone() {
        let (dao, kind) = (dao.clone(), kind.clone());
        filings.spawn(async move { dao.file(&account, &kind).await.map(|a| (account, a)) });
    }
    let mut filed: Vec<(String, u64)> = Vec::new();
    while let Some(r) = filings.join_next().await {
        let (account, actual) = r??;
        let expected = match can_execute_action(policy, &account, label, Action::AddProposal).1 {
            true => Expect::Allowed,
            false => Expect::Refused(DENIED),
        };
        report.compare(format!("{} {label} {account} AddProposal (add_proposal)", dao.name), &expected, &actual);
        if let Actual::Done(id) = &actual {
            filed.push((account, id.as_u64().ok_or_else(|| anyhow::anyhow!("add_proposal returned {id}"))?));
        }
    }
    filed.sort();
    let Some(filer) = filed.first().map(|(a, _)| a.clone()) else {
        report.notes.push(format!("nobody may file {label}, so only filing was compared"));
        return Ok(report);
    };

    // One run per role name that counts heads or tokens and holds a vote right on this kind.
    let mut runs: Vec<(String, Action, Vec<String>)> = Vec::new();
    let mut seen = BTreeSet::new();
    for role in &policy.roles {
        if !seen.insert(role.name.clone()) || matches!(policy.first_role(&role.name).map(|r| &r.kind), Some(RoleKind::Everyone)) {
            continue;
        }
        let same: Vec<_> = policy.roles.iter().filter(|r| r.name == role.name).collect();
        let mut preference = vec![Action::VoteReject, Action::VoteRemove];
        if APPROVE_SAFE.contains(&label) {
            preference.push(Action::VoteApprove);
        }
        let Some(action) = preference.into_iter().find(|a| same.iter().any(|r| r.allows(label, *a))) else { continue };
        let voters: BTreeSet<String> = same.iter().filter_map(|r| r.members()).flatten().cloned().collect();
        if !voters.is_empty() {
            runs.push((role.name.clone(), action, voters.into_iter().collect()));
        }
    }
    let mut ids: Vec<u64> = filed.iter().map(|(_, id)| *id).collect();
    while ids.len() < runs.len() + 1 {
        match dao.file(&filer, &kind).await? {
            Actual::Done(id) => ids.push(id.as_u64().ok_or_else(|| anyhow::anyhow!("add_proposal returned {id}"))?),
            Actual::Refused(why) => bail!("{} {label}: {filer} could file once but not again: {why}", dao.name),
        }
    }
    let spare = ids[runs.len()];

    let mut vote_runs = JoinSet::new();
    for (i, (role, action, voters)) in runs.into_iter().enumerate() {
        let (dao, kind, id) = (dao.clone(), kind.clone(), ids[i]);
        vote_runs.spawn(async move {
            let mut part = LabelReport::default();
            let mut counts = BTreeMap::new();
            let mut status = "InProgress".to_string();
            for voter in &voters {
                let expected = predict_vote(&dao.policy, &mut counts, voter, label, action);
                let actual = dao.act(voter, id, action, &kind).await?;
                part.votes += 1;
                let what = format!("{} {label} run {role} {action:?} by {voter} (proposal {id})", dao.name);
                let before = part.disagreements.len();
                part.compare(what.clone(), &expected, &actual);
                // The panic reverts the deciding vote, so the proposal stays open in the binary
                // while the port has already counted it: the run ends here.
                if part.disagreements.len() > before || matches!(expected, Expect::Refused(NO_BOUNTY)) {
                    break;
                }
                if let (Expect::Status(allowed), Actual::Done(_)) = (&expected, &actual) {
                    status = dao.status(id).await?;
                    part.checks += 1;
                    if !allowed.contains(&status) {
                        part.disagreements.push(format!("{what}: port says the status becomes {allowed:?}, binary {status}"));
                        break;
                    }
                }
                if status != "InProgress" {
                    break;
                }
            }
            anyhow::Ok((part, id, action, status))
        });
    }
    let mut decided: Vec<(u64, Action, String)> = Vec::new();
    while let Some(r) = vote_runs.join_next().await {
        let (part, id, action, status) = r??;
        report.checks += part.checks;
        report.votes += part.votes;
        report.disagreements.extend(part.disagreements);
        decided.push((id, action, status));
    }
    decided.sort();
    let pick = decided
        .iter()
        .find(|(_, a, s)| *a == Action::VoteReject && s == "Rejected")
        .or_else(|| decided.iter().find(|(_, _, s)| s == "Rejected" || s == "Approved"))
        .map(|(id, _, s)| (*id, s.clone()));
    let (matrix, matrix_status) = match pick {
        Some(p) => p,
        None => (spare, dao.status(spare).await?),
    };
    let decided_matrix = matrix_status != "InProgress";
    if !decided_matrix {
        report.notes.push(format!("{label}: no vote decided a proposal, so allowed votes were only compared in the runs"));
    }

    let mut cells = JoinSet::new();
    for account in dao.accounts.clone() {
        for action in [Action::AddProposal, Action::VoteApprove, Action::VoteReject, Action::VoteRemove, Action::Finalize, Action::MoveToHub] {
            let allowed = can_execute_action(policy, &account, label, action).1;
            let expected = match (allowed, action) {
                (false, _) => Expect::Refused(DENIED),
                (true, Action::AddProposal) => Expect::Refused("ERR_WRONG_ACTION"),
                (true, Action::MoveToHub) => Expect::Allowed,
                (true, Action::Finalize) if decided_matrix => Expect::Refused("ERR_PROPOSAL_NOT_IN_PROGRESS"),
                (true, Action::Finalize) => {
                    let all: Vec<String> = policy.roles.iter().map(|r| r.name.clone()).collect();
                    if decide(policy, &BTreeMap::new(), &all, label).contains("InProgress") {
                        Expect::Refused("ERR_PROPOSAL_NOT_EXPIRED_OR_FAILED")
                    } else {
                        report.notes.push(format!("{label}: Finalize by {account} would decide an open proposal; not sent"));
                        continue;
                    }
                }
                (true, _) if decided_matrix => Expect::Refused("ERR_PROPOSAL_NOT_READY_FOR_VOTE"),
                (true, _) => continue,
            };
            let (dao, kind, account, matrix_status) = (dao.clone(), kind.clone(), account.clone(), matrix_status.clone());
            cells.spawn(async move {
                let actual = dao.act(&account, matrix, action, &kind).await?;
                anyhow::Ok((format!("{} {label} {account} {action:?} (proposal {matrix}, {matrix_status})", dao.name), expected, actual))
            });
        }
    }
    while let Some(r) = cells.join_next().await {
        let (what, expected, actual) = r??;
        report.compare(what, &expected, &actual);
    }

    // RemoveProposal deletes the proposal, so every refusal is checked first and one allowed
    // account goes last.
    let (deniers, removers): (Vec<String>, Vec<String>) = dao
        .accounts
        .iter()
        .cloned()
        .partition(|a| !can_execute_action(policy, a, label, Action::RemoveProposal).1);
    for account in &deniers {
        let actual = dao.act(account, matrix, Action::RemoveProposal, &kind).await?;
        report.compare(format!("{} {label} {account} RemoveProposal", dao.name), &Expect::Refused(DENIED), &actual);
    }
    if let Some(account) = removers.first() {
        let actual = dao.act(account, matrix, Action::RemoveProposal, &kind).await?;
        report.compare(format!("{} {label} {account} RemoveProposal", dao.name), &Expect::Allowed, &actual);
        let after = dao.status(matrix).await?;
        report.checks += 1;
        if after != "Removed" {
            report.disagreements.push(format!("{} {label} {account} RemoveProposal: the proposal is still there ({after})", dao.name));
        }
    }
    Ok(report)
}

/// The testnet demo DAO's policy as scripts/setup-demo-dao.mjs `demoPolicy` builds it: the
/// saved NEAR Business template with the owner and the demo member in its places, plus a `guard`
/// role holding the guard alone, VoteReject on every label but remove_member_from_role, threshold
/// "1" on each. Returns the policy and the guard account.
fn m1_policy() -> Result<(Value, String)> {
    let read = |file: &str| -> Result<Value> {
        Ok(serde_json::from_str(&std::fs::read_to_string(Path::new(REPO_ROOT).join(file))?)?)
    };
    let (template, state) = (read("deployments/near-business-policy.json")?, read("deployments/testnet.json")?);
    let (owner, member) = (state["owner"]["account_id"].clone(), state["dao"]["member"]["account_id"].clone());
    let guard = state["guard"]["account_id"].as_str().ok_or_else(|| anyhow::anyhow!("no guard in testnet.json"))?.to_string();
    let mut policy = template["policy"].clone();
    for role in policy["roles"].as_array_mut().into_iter().flatten() {
        for place in role["kind"]["Group"].as_array_mut().into_iter().flatten() {
            *place = if *place == "<member 1>" { owner.clone() } else { member.clone() };
        }
    }
    let labels: Vec<&str> = LABELS.iter().copied().filter(|l| *l != "remove_member_from_role").collect();
    let rule = json!({ "weight_kind": "RoleWeight", "quorum": "0", "threshold": "1" });
    let guard_role = json!({
        "name": "guard",
        "kind": { "Group": [guard] },
        "permissions": labels.iter().map(|l| format!("{l}:VoteReject")).collect::<Vec<_>>(),
        "vote_policy": labels.iter().map(|l| (l.to_string(), rule.clone())).collect::<serde_json::Map<_, _>>(),
    });
    policy["roles"].as_array_mut().ok_or_else(|| anyhow::anyhow!("template has no roles"))?.push(guard_role);
    Ok((policy, guard))
}

fn harness_policy() -> Result<Value> {
    Ok(planted_policies()?.remove(0).1)
}

fn push_role(policy: &mut Value, role: Value) {
    if let Some(roles) = policy["roles"].as_array_mut() {
        roles.push(role);
    }
}

fn add_to_guard_role(policy: &mut Value, account: &str) {
    for role in policy["roles"].as_array_mut().into_iter().flatten().filter(|r| r["name"] == "guard") {
        if let Some(group) = role["kind"]["Group"].as_array_mut() {
            group.push(json!(account));
        }
    }
}

/// C16 against the binary. For the testnet demo DAO's policy and three edits of it, the guard
/// tries to file one proposal of every kind, then casts one VoteReject on a proposal of that kind,
/// and the binary's answer is compared with `guard_arming`: the filing with `extra_rights`, the
/// reject with `rejects_alone`. Then every account `others_who_reject_alone` lists for the kind
/// casts one VoteReject on its own fresh proposal, which must come out Rejected. It prints one line
/// per check. It does NOT cover approval races, a guard with delegated tokens, kinds nobody in the
/// policy may file (listed as notes), or accounts left off `others_who_reject_alone`.
#[tokio::test(flavor = "multi_thread")]
async fn guard_arming_agrees_with_the_binary() -> Result<()> {
    let code = sputnik_wasm()?;
    let (m1, guard) = m1_policy()?;
    let mut second = m1.clone();
    add_to_guard_role(&mut second, "second-guard.kaap-diff");
    let mut everyone = m1.clone();
    push_role(&mut everyone, json!({ "name": "all", "kind": "Everyone", "permissions": ["*:AddProposal"], "vote_policy": {} }));
    let mut harness = harness_policy()?;
    add_to_guard_role(&mut harness, "second-guard.sandbox");
    let cases = [
        ("demo DAO testnet policy", m1, guard.clone()),
        ("demo DAO, a second guard member", second, guard.clone()),
        ("demo DAO, Everyone may file", everyone, guard),
        ("harness, a second guard member", harness, "guard.sandbox".to_string()),
    ];
    let mut runs = JoinSet::new();
    for (name, policy, guard) in cases {
        let code = code.clone();
        runs.spawn(async move { check_arming(name, policy, guard, code).await });
    }
    let mut outcomes = Vec::new();
    while let Some(run) = runs.join_next().await {
        outcomes.push(run??);
    }
    outcomes.sort();
    let mut disagreements = 0;
    for (name, lines) in &outcomes {
        println!("\n{name}");
        for (line, agrees) in lines {
            disagreements += usize::from(!agrees);
            println!("  {}{line}", if *agrees { "" } else { "DISAGREE " });
        }
    }
    println!("\n{} policies, {disagreements} disagreements", outcomes.len());
    ensure!(disagreements == 0, "{disagreements} disagreements between guard_arming and the binary");
    Ok(())
}

async fn check_arming(name: &'static str, policy_json: Value, guard: String, code: Vec<u8>) -> Result<(String, Vec<(String, bool)>)> {
    let arming = guard_arming(&policy_json, &guard);
    let dao = deploy(name, policy_json, code).await?;
    let mut lines = Vec::new();
    for label in LABELS {
        let kind = dao.kind_for(label);
        let may_file = arming.extra_rights.contains(&format!("{label}:AddProposal"));
        let filed = dao.file(&guard, &kind).await?;
        let filed_ok = matches!(filed, Actual::Done(_));
        lines.push((format!("{label:<34} guard files: guard_arming {may_file:<5}, binary {filed:?}"), may_file == filed_ok));
        let id = match filed {
            Actual::Done(id) => id.as_u64(),
            Actual::Refused(_) => {
                let filer = dao.accounts.iter().find(|a| *a != &guard && can_execute_action(&dao.policy, a, label, Action::AddProposal).1);
                match filer {
                    Some(filer) => match dao.file(filer, &kind).await? {
                        Actual::Done(id) => id.as_u64(),
                        Actual::Refused(why) => bail!("{name} {label}: {filer} may file but was refused: {why}"),
                    },
                    None => {
                        lines.push((format!("{label:<34} note: nobody in this policy may file it, so the reject was not tried"), true));
                        continue;
                    }
                }
            }
        };
        let id = id.ok_or_else(|| anyhow::anyhow!("{name} {label}: add_proposal returned no id"))?;
        let says = arming.rejects_alone.iter().any(|l| l == label);
        let binary = match dao.act(&guard, id, Action::VoteReject, &kind).await? {
            Actual::Done(_) => dao.status(id).await?,
            Actual::Refused(why) => why,
        };
        // A deciding reject on bounty_done panics in the payout of a bounty that does not exist.
        let rejected = binary == "Rejected" || (label == "bounty_done" && binary.contains(NO_BOUNTY));
        let verdict = if says { "rejects alone" } else { "cannot reject" };
        lines.push((format!("{label:<34} one guard reject: guard_arming {verdict}, binary {binary}"), says == rejected));
        // Each other account listed gets its own fresh proposal, so the guard's vote is not in it.
        for other in arming.others_who_reject_alone.get(label).into_iter().flatten() {
            let filer = dao.accounts.iter().find(|a| can_execute_action(&dao.policy, a, label, Action::AddProposal).1);
            let Some(filer) = filer else { bail!("{name} {label}: a proposal was filed, yet nobody may file one") };
            let id = match dao.file(filer, &kind).await? {
                Actual::Done(id) => id.as_u64().ok_or_else(|| anyhow::anyhow!("{name} {label}: add_proposal returned {id}"))?,
                Actual::Refused(why) => bail!("{name} {label}: {filer} may file but was refused: {why}"),
            };
            let binary = match dao.act(other, id, Action::VoteReject, &kind).await? {
                Actual::Done(_) => dao.status(id).await?,
                Actual::Refused(why) => why,
            };
            let rejected = binary == "Rejected" || (label == "bounty_done" && binary.contains(NO_BOUNTY));
            lines.push((format!("{label:<34} one reject by {other}: others_who_reject_alone lists it, binary {binary}"), rejected));
        }
    }
    Ok((name.to_string(), lines))
}

#[cfg(feature = "private-tests")] include!("private/cases.rs");
