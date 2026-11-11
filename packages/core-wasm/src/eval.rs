//! The answer-key scoreboards behind `kaap eval`, ported from kaap-core's own tests so the CLI
//! prints the numbers `cargo test -p kaap-core` prints: `tests/eval.rs` (every field), and the
//! work-order scoreboards `value_eval.rs`, `policy_eval.rs`, `describe_eval.rs` and `hash_eval.rs`.
//! Each selection, normalisation and count below is copied from those files; a change there must be
//! copied here, and the CLI test that pins today's numbers fails until it is.
//!
//! It reads only the text it is handed. It does not print the records that differ (the Rust
//! scoreboards do), and it does not assert any bar: the numbers are reported as they come out.

use std::collections::BTreeSet;
use std::path::Path;

use base64::Engine as _;
use kaap_core::{analyze, Analysis, DescCheck, Effect, FindingCode, Prices, ProposalInput, Severity, SuppliedText, TextStandard};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use FindingCode::*;

use crate::api::{prices_from_tokens, Error};

/// Every scoreboard over the real and planted labels, as `{records, boards: [{name, title,
/// rows: [{measure, agree, of}]}]}`. `tokens_json` is the census token list the Rust tests price
/// with (`packages/core/tests/fixtures/tokens.json`).
pub fn scoreboards(real_jsonl: &str, planted_jsonl: &str, tokens_json: &str) -> Result<String, Error> {
    let prices = prices_from_tokens(tokens_json)?;
    let real = read_jsonl(real_jsonl)?;
    let planted = read_jsonl(planted_jsonl)?;
    let all: Vec<&Value> = real.iter().chain(&planted).collect();

    let mut runs = Vec::with_capacity(all.len());
    let mut unreadable = 0usize;
    for record in &all {
        match input_of(record, &prices) {
            Ok(input) => {
                let analysis = analyze(&input);
                runs.push(Run { record, analysis });
            }
            Err(_) => unreadable += 1,
        }
    }

    let boards = vec![overall(&runs), value(&runs), policy(&runs), describe(&runs), hash(&runs)];
    serde_json::to_string(&json!({
        "records": { "real": real.len(), "planted": planted.len(), "run": runs.len(), "unreadable": unreadable },
        "boards": boards,
    }))
    .map_err(|_| Error("the scoreboards could not be written"))
}

struct Run<'a> {
    record: &'a Value,
    analysis: Analysis,
}

fn board(name: &str, title: String, rows: Vec<(&str, usize, usize)>) -> Value {
    json!({
        "name": name,
        "title": title,
        "rows": rows.into_iter().map(|(measure, agree, of)| json!({ "measure": measure, "agree": agree, "of": of })).collect::<Vec<_>>(),
    })
}

fn read_jsonl(text: &str) -> Result<Vec<Value>, Error> {
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).map_err(|_| Error("a labels file has a line that is not JSON")))
        .collect()
}

/// One answer-key record as the ProposalInput `scoreboards` judges, priced with the census token
/// list, written by serde: the input of kaap-sealed's eval mode (WO-05c), so the AI run and the
/// scoreboards judge the very same inputs. The error never quotes the record.
pub fn eval_input(record_json: &str, tokens_json: &str) -> Result<String, Error> {
    let prices = prices_from_tokens(tokens_json)?;
    let record: Value = serde_json::from_str(record_json).map_err(|_| Error("the record is not JSON"))?;
    let input = input_of(&record, &prices).map_err(|_| Error("the record is not one kaap-core can read"))?;
    serde_json::to_string(&input).map_err(|_| Error("the input could not be written"))
}

/// `eval_input` with the price table cut down, for a record whose full input is over the sealed
/// job's 32 KiB (WO-05c). Kept: `near`, and every price whose token id is a string somewhere in the
/// effects kaap-core finds with the full table. Refused unless kaap-core's whole analysis (effects,
/// findings, floor, description check and veto fields) is the same with the cut table as with the
/// full one, so the cut changes the size and nothing that is judged.
pub fn eval_input_trimmed(record_json: &str, tokens_json: &str) -> Result<String, Error> {
    fn strings<'a>(v: &'a Value, out: &mut BTreeSet<&'a str>) {
        match v {
            Value::String(s) => {
                out.insert(s);
            }
            Value::Array(items) => items.iter().for_each(|i| strings(i, out)),
            Value::Object(map) => map.values().for_each(|i| strings(i, out)),
            _ => {}
        }
    }
    let prices = prices_from_tokens(tokens_json)?;
    let record: Value = serde_json::from_str(record_json).map_err(|_| Error("the record is not JSON"))?;
    let full = input_of(&record, &prices).map_err(|_| Error("the record is not one kaap-core can read"))?;
    let analysis = analyze(&full);
    let effects = serde_json::to_value(&analysis.effects).map_err(|_| Error("the effects could not be read"))?;
    let mut named = BTreeSet::from(["near"]);
    strings(&effects, &mut named);
    let usd_by_token = prices.usd_by_token.into_iter().filter(|(token, _)| named.contains(token.as_str())).collect();
    let trimmed = ProposalInput { prices: Prices { usd_by_token }, ..full };
    if analyze(&trimmed) != analysis {
        return Err(Error("the cut price table changes kaap-core's analysis"));
    }
    serde_json::to_string(&trimmed).map_err(|_| Error("the input could not be written"))
}

/// `tests/common::input_of`, unchanged.
pub fn input_of(record: &Value, prices: &Prices) -> Result<ProposalInput, String> {
    let text = |v: &Value, what: &str| v.as_str().map(str::to_string).ok_or_else(|| format!("{what} is not a string"));
    let context = &record["context"];
    let proposal_id = match record.get("proposal_id").and_then(Value::as_u64) {
        Some(id) => id,
        None => text(&record["id"], "id")?.rsplit(':').next().and_then(|n| n.parse().ok()).ok_or("no proposal id")?,
    };
    let history = match (&context["history_available"], &context["history"]) {
        (Value::Bool(true), h @ Value::Object(_)) => Some(serde_json::from_value(h.clone()).map_err(|e| format!("history: {e}"))?),
        _ => None,
    };
    let supplied_text = match record.get("supplied_text") {
        None | Some(Value::Null) => None,
        Some(t) => Some(supplied(t)?),
    };
    Ok(ProposalInput {
        network: serde_json::from_value(record["network"].clone()).map_err(|e| format!("network: {e}"))?,
        dao: text(&record["dao"], "dao")?,
        proposal_id,
        description: text(&record["description"], "description")?,
        kind_json: serde_json::to_vec(&record["kind"]).map_err(|e| e.to_string())?,
        policy_before: match &context["policy_before"] {
            Value::Null => None,
            p => Some(p.clone()),
        },
        history,
        prices: prices.clone(),
        dao_version: context["dao_version"].as_str().map(str::to_string),
        supplied_text,
        guard_account: None,
        config_before: None,
        block_timestamp_ns: None,
    })
}

fn supplied(t: &Value) -> Result<SuppliedText, String> {
    let field = |name: &str| t[name].as_str().ok_or_else(|| format!("supplied_text.{name} missing"));
    let nonce = base64::engine::general_purpose::STANDARD.decode(field("nonce")?).map_err(|e| format!("supplied_text.nonce: {e}"))?;
    Ok(SuppliedText {
        message: field("message")?.to_string(),
        nonce: nonce.try_into().map_err(|_| "supplied_text.nonce is not 32 bytes")?,
        recipient: field("recipient")?.to_string(),
        standard: match t.get("standard") {
            None | Some(Value::Null) => TextStandard::Nep413,
            Some(s) => serde_json::from_value(s.clone()).map_err(|e| format!("standard: {e}"))?,
        },
        quotes: Vec::new(),
    })
}

/// Codes of the description check (WO-03c) and the hash check (WO-04). A label carrying one of
/// them can floor at critical for a reason the value and policy decoders do not own.
const OTHER_MODULES: [FindingCode; 6] = [DescContradicts, EmptyDescription, PromptInjection, HashUnverified, HashMismatch, HashTextDangerous];

fn label_codes(record: &Value) -> BTreeSet<FindingCode> {
    record["label"]["findings"]
        .as_array()
        .map(|fs| fs.iter().filter_map(|f| serde_json::from_value(f["code"].clone()).ok()).collect())
        .unwrap_or_default()
}

fn name<T: serde::Serialize>(v: &T) -> String {
    match serde_json::to_value(v) {
        Ok(Value::String(s)) => s,
        other => format!("{other:?}"),
    }
}

fn names<'a>(codes: impl Iterator<Item = &'a FindingCode>) -> String {
    codes.map(name).collect::<Vec<_>>().join(",")
}

fn label_effects(record: &Value) -> Option<Vec<Effect>> {
    serde_json::from_value(record["label"]["effects"].clone()).ok()
}

fn variant(kind: &Value) -> &str {
    match kind {
        Value::String(s) => s,
        Value::Object(map) if map.len() == 1 => map.keys().next().map(String::as_str).unwrap_or_default(),
        _ => "",
    }
}

/// `tests/eval.rs`: all six fields on every record.
fn overall(runs: &[Run]) -> Value {
    fn effect_key(effect: &Effect) -> String {
        let Ok(mut v) = serde_json::to_value(effect) else { return format!("{effect:?}") };
        if let Some(map) = v.as_object_mut() {
            map.remove("summary");
            if map.get("type").and_then(Value::as_str) == Some("policy_change") {
                for list in map.values_mut() {
                    if let Value::Array(items) = list {
                        items.sort_by_key(sorted_keys);
                    }
                }
            }
        }
        sorted_keys(&v)
    }
    fn read<T: DeserializeOwned>(v: &Value) -> Result<T, ()> {
        serde_json::from_value(v.clone()).map_err(|_| ())
    }
    fn sorted(mut items: Vec<String>) -> Vec<String> {
        items.sort();
        items
    }
    let fields = ["effects", "finding_codes", "risk_floor", "description_check", "must_veto", "veto_allowed"];
    let mut agree = [0usize; 6];
    let mut all_six = 0;
    for run in runs {
        let (label, a) = (&run.record["label"], &run.analysis);
        let label_codes = label["findings"].as_array().ok_or(()).and_then(|fs| {
            fs.iter().map(|f| read::<FindingCode>(&f["code"]).map(|c| name(&c))).collect::<Result<Vec<_>, _>>()
        });
        let pairs: [(Result<String, ()>, String); 6] = [
            (
                read::<Vec<Effect>>(&label["effects"]).map(|es| sorted(es.iter().map(effect_key).collect()).join("; ")),
                sorted(a.effects.iter().map(effect_key).collect()).join("; "),
            ),
            (
                label_codes.map(|mut c| {
                    c.sort();
                    c.dedup();
                    c.join(",")
                }),
                sorted(a.findings.iter().map(|f| name(&f.code)).collect()).join(","),
            ),
            (read::<Severity>(&label["risk_floor"]).map(|s| name(&s)), name(&a.risk_floor)),
            (read::<DescCheck>(&label["description_check"]).map(|d| name(&d)), name(&a.description_check)),
            (read::<bool>(&label["must_veto"]).map(|b| b.to_string()), a.must_veto.to_string()),
            (read::<bool>(&label["veto_allowed"]).map(|b| b.to_string()), a.veto_allowed.to_string()),
        ];
        let mut every = true;
        for (i, (key, kaap)) in pairs.iter().enumerate() {
            if key.as_ref().is_ok_and(|k| k == kaap) {
                agree[i] += 1;
            } else {
                every = false;
            }
        }
        if every {
            all_six += 1;
        }
    }
    let of = runs.len();
    let mut rows: Vec<(&str, usize, usize)> = fields.iter().zip(agree).map(|(f, n)| (*f, n, of)).collect();
    rows.push(("all six fields", all_six, of));
    board("all", format!("Every field, all {of} records"), rows)
}

/// `tests/value_eval.rs`: records whose label holds only value-type effects.
fn value(runs: &[Run]) -> Value {
    const VALUE_TYPES: [&str; 11] = [
        "transfer",
        "token_call_transfer",
        "intents_withdraw",
        "intents_transfer",
        "intents_key_change",
        "wrap",
        "staking",
        "storage_deposit",
        "defi_call",
        "bulk_payment",
        "unknown_call",
    ];
    const OWNED: [FindingCode; 9] = [AttachedDeposit, NewRecipient, LargeAmount, UnknownValue, CrossChainOut, LookalikeToken, UnknownCall, ArgsNotJson, IntentsKeyChange];
    fn effect_key(effect: &Effect, fold: bool) -> String {
        let mut v = serde_json::to_value(effect).unwrap_or(Value::Null);
        if let Some(map) = v.as_object_mut() {
            map.remove("summary");
            if fold {
                if let Some(Value::String(protocol)) = map.get_mut("protocol") {
                    *protocol = protocol.to_lowercase();
                }
            }
        }
        sorted_keys(&v)
    }
    let effects_of = |effects: &[Effect], fold: bool| {
        let mut keys: Vec<String> = effects.iter().map(|e| effect_key(e, fold)).collect();
        keys.sort();
        keys.join("; ")
    };
    let value_only = |record: &Value| {
        record["label"]["effects"]
            .as_array()
            .is_some_and(|effects| effects.iter().all(|e| e["type"].as_str().is_some_and(|t| VALUE_TYPES.contains(&t))))
    };
    let (mut of, mut effects, mut exact, mut codes, mut veto_of, mut veto) = (0, 0, 0, 0, 0, 0);
    for run in runs.iter().filter(|r| value_only(r.record)) {
        of += 1;
        let (label, a) = (&run.record["label"], &run.analysis);
        let theirs = label_effects(run.record).unwrap_or_default();
        effects += usize::from(effects_of(&theirs, true) == effects_of(&a.effects, true));
        exact += usize::from(effects_of(&theirs, false) == effects_of(&a.effects, false));
        let label_codes = label_codes(run.record);
        let kaap_codes: BTreeSet<FindingCode> = a.findings.iter().map(|f| f.code).collect();
        let owned = |c: &BTreeSet<FindingCode>| names(c.iter().filter(|c| OWNED.contains(c)));
        codes += usize::from(owned(&label_codes) == owned(&kaap_codes));
        if !label_codes.iter().any(|c| OTHER_MODULES.contains(c)) {
            veto_of += 1;
            let key = format!("must_veto {} veto_allowed {}", label["must_veto"], label["veto_allowed"]);
            veto += usize::from(key == format!("must_veto {} veto_allowed {}", a.must_veto, a.veto_allowed));
        }
    }
    board(
        "value",
        format!("Value moves: {of} records whose label holds only value effects"),
        vec![
            ("effects multiset", effects, of),
            ("effects multiset, protocol case kept", exact, of),
            ("owned codes", codes, of),
            ("must_veto and veto_allowed (no desc/hash code)", veto, veto_of),
        ],
    )
}

/// `tests/policy_eval.rs`: records whose kind is a policy or governance kind.
fn policy(runs: &[Run]) -> Value {
    const POLICY_KINDS: [&str; 15] = [
        "ChangeConfig",
        "ChangePolicy",
        "AddMemberToRole",
        "RemoveMemberFromRole",
        "UpgradeSelf",
        "UpgradeRemote",
        "SetStakingContract",
        "AddBounty",
        "BountyDone",
        "Vote",
        "FactoryInfoUpdate",
        "ChangePolicyAddOrUpdateRole",
        "ChangePolicyRemoveRole",
        "ChangePolicyUpdateDefaultVotePolicy",
        "ChangePolicyUpdateParameters",
    ];
    const OWNED: [FindingCode; 9] =
        [PolicyAddsApprover, PolicyLowersThreshold, PolicyReplacesRole, PolicyRemovesMember, PolicyBeforeUnknown, PolicyDuplicateRoleNames, GuardWeakened, CodeUpgrade, OtherRiskyKind];
    fn effect_key(effect: &Effect) -> String {
        fn sort(items: &mut [Value]) {
            items.sort_by_key(sorted_keys);
        }
        let mut v = serde_json::to_value(effect).unwrap_or(Value::Null);
        if let Some(map) = v.as_object_mut() {
            map.remove("summary");
            if map.get("type").and_then(Value::as_str) == Some("policy_change") {
                for list in map.values_mut().filter_map(Value::as_array_mut) {
                    for item in list.iter_mut().filter_map(Value::as_object_mut) {
                        for name in ["added", "removed"] {
                            if let Some(Value::Array(inner)) = item.get_mut(name) {
                                sort(inner);
                            }
                        }
                    }
                    sort(list);
                }
            }
        }
        sorted_keys(&v)
    }
    let effects_of = |effects: &[Effect]| {
        let mut keys: Vec<String> = effects.iter().map(effect_key).collect();
        keys.sort();
        keys.join("; ")
    };
    let (mut of, mut effects, mut codes, mut veto_of, mut floor, mut must, mut allowed) = (0, 0, 0, 0, 0, 0, 0);
    for run in runs.iter().filter(|r| POLICY_KINDS.contains(&variant(&r.record["kind"]))) {
        of += 1;
        let (label, a) = (&run.record["label"], &run.analysis);
        let theirs = label_effects(run.record).unwrap_or_default();
        effects += usize::from(effects_of(&theirs) == effects_of(&a.effects));
        let label_codes = label_codes(run.record);
        let kaap_codes: BTreeSet<FindingCode> = a.findings.iter().map(|f| f.code).collect();
        let owned = |c: &BTreeSet<FindingCode>| names(c.iter().filter(|c| OWNED.contains(c)));
        codes += usize::from(owned(&label_codes) == owned(&kaap_codes));
        if !label_codes.iter().any(|c| OTHER_MODULES.contains(c)) {
            veto_of += 1;
            floor += usize::from(label["risk_floor"].as_str() == Some(name(&a.risk_floor).as_str()));
            must += usize::from(label["must_veto"].as_bool() == Some(a.must_veto));
            allowed += usize::from(label["veto_allowed"].as_bool() == Some(a.veto_allowed));
        }
    }
    board(
        "policy",
        format!("Policy and governance: {of} records whose kind is a policy or governance kind"),
        vec![
            ("owned codes", codes, of),
            ("risk floor (no desc/hash code)", floor, veto_of),
            ("must_veto (no desc/hash code)", must, veto_of),
            ("veto_allowed (no desc/hash code)", allowed, veto_of),
            ("effects multiset (not held to a bar)", effects, of),
        ],
    )
}

/// `tests/describe_eval.rs`: the description check on every record.
fn describe(runs: &[Run]) -> Value {
    const HASH_CODES: [FindingCode; 3] = [HashMismatch, HashTextDangerous, HashUnverified];
    let (mut desc, mut dc, mut pi, mut veto_of, mut veto) = (0, 0, 0, 0, 0);
    for run in runs {
        let (label, a) = (&run.record["label"], &run.analysis);
        let key_codes: Vec<FindingCode> = label["findings"]
            .as_array()
            .map(|fs| fs.iter().filter_map(|f| serde_json::from_value(f["code"].clone()).ok()).collect())
            .unwrap_or_default();
        let codes: Vec<FindingCode> = a.findings.iter().map(|f| f.code).collect();
        let has = |code: FindingCode| key_codes.contains(&code) == codes.contains(&code);
        desc += usize::from(label["description_check"].as_str() == Some(name(&a.description_check).as_str()));
        dc += usize::from(has(DescContradicts));
        pi += usize::from(has(PromptInjection));
        if !key_codes.iter().any(|c| HASH_CODES.contains(c)) {
            veto_of += 1;
            veto += usize::from(label["must_veto"].as_bool() == Some(a.must_veto));
        }
    }
    let of = runs.len();
    board(
        "describe",
        format!("Description check: {of} records"),
        vec![
            ("description_check", desc, of),
            ("DESC_CONTRADICTS present", dc, of),
            ("PROMPT_INJECTION present", pi, of),
            ("must_veto, labels with no hash code", veto, veto_of),
        ],
    )
}

/// `tests/hash_eval.rs`: every real record that calls `sign` on v1.signer, planted families i, j
/// and k, and the auth control #62.
fn hash(runs: &[Run]) -> Value {
    const PLANTED_HASH: [&str; 10] =
        ["planted:26", "planted:27", "planted:28", "planted:29", "planted:30", "planted:31", "planted:32", "planted:33", "planted:34", "planted:62"];
    fn calls_sign(record: &Value) -> bool {
        let call = &record["kind"]["FunctionCall"];
        call["receiver_id"] == "v1.signer" && call["actions"].as_array().is_some_and(|actions| actions.iter().any(|a| a["method_name"] == "sign"))
    }
    fn sorted(mut items: Vec<String>) -> Vec<String> {
        items.sort();
        items.dedup();
        items
    }
    let is_real = |r: &Value| r["id"].as_str().is_some_and(|id| !id.starts_with("planted:"));
    let chosen: Vec<&Run> = runs
        .iter()
        .filter(|r| is_real(r.record) && calls_sign(r.record))
        .chain(runs.iter().filter(|r| PLANTED_HASH.contains(&r.record["id"].as_str().unwrap_or(""))))
        .collect();
    let real = chosen.iter().filter(|r| is_real(r.record)).count();
    let fields = ["finding_codes", "risk_floor", "must_veto", "veto_allowed", "effects", "description_check"];
    let mut agree = [0usize; 6];
    for run in &chosen {
        let (label, a) = (&run.record["label"], &run.analysis);
        let key_effects = label_effects(run.record).unwrap_or_default();
        let effect_keys =
            |effects: &[Effect]| sorted(effects.iter().map(|e| serde_json::to_value(e).map(|v| sorted_keys(&v)).unwrap_or_default()).collect());
        let pairs = [
            (
                sorted(label["findings"].as_array().map(|fs| fs.iter().filter_map(|f| f["code"].as_str().map(str::to_string)).collect()).unwrap_or_default()).join(","),
                sorted(a.findings.iter().map(|f| name(&f.code)).collect()).join(","),
            ),
            (label["risk_floor"].as_str().unwrap_or_default().to_string(), name(&a.risk_floor)),
            (label["must_veto"].to_string(), a.must_veto.to_string()),
            (label["veto_allowed"].to_string(), a.veto_allowed.to_string()),
            (effect_keys(&key_effects).join("; "), effect_keys(&a.effects).join("; ")),
            (label["description_check"].as_str().unwrap_or_default().to_string(), name(&a.description_check)),
        ];
        for (i, (key, kaap)) in pairs.iter().enumerate() {
            agree[i] += usize::from(key == kaap);
        }
    }
    let of = chosen.len();
    board(
        "hash",
        format!("Hash check: {real} real sign requests and {} planted hash records", of - real),
        fields.iter().zip(agree).map(|(f, n)| (*f, n, of)).collect(),
    )
}

/// JSON text with every object's keys in byte order at every depth, as `tests/hash_eval.rs` writes
/// it. serde_json keeps insertion order when its `preserve_order` feature is on, which a build that
/// includes kaap-sealed turns on, so plain `to_string` would make two equal effects differ by key
/// order alone.
fn sorted_keys(v: &Value) -> String {
    match v {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let fields: Vec<String> = keys.iter().map(|k| format!("{}:{}", Value::from(k.as_str()), sorted_keys(&map[*k]))).collect();
            format!("{{{}}}", fields.join(","))
        }
        Value::Array(items) => format!("[{}]", items.iter().map(sorted_keys).collect::<Vec<_>>().join(",")),
        other => other.to_string(),
    }
}

/// Reads the two labels files and the token list under `repo` and runs `scoreboards`, for the
/// native test that pins the wrapper to kaap-core.
pub fn scoreboards_from(repo: &Path) -> Result<String, Error> {
    let read = |p: &str| std::fs::read_to_string(repo.join(p)).map_err(|_| Error("a labels file could not be read"));
    scoreboards(&read("eval/real/labels.jsonl")?, &read("eval/planted/labels.jsonl")?, &read("packages/core/tests/fixtures/tokens.json")?)
}
