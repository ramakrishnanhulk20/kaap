// Scores `analyze` on the answer-key records whose kind is a policy or governance kind (the WO-03b
// scoreboard): the set of codes `policy::decode` owns, and, on the records whose label carries no
// description, prompt or hash code, the risk floor and the veto fields. It prints the table and
// every record that differs, then fails below the work order's bars. The effects multiset is
// printed but not held to a bar. It does not score the codes of other modules, and it never
// judges whether the key or the decoder is right where they differ; DISAGREEMENTS-WO-03b.md does.
// A second test pins a known gap of GUARD_WEAKENED: a guard role under another name.

mod common;

use std::collections::BTreeSet;
use std::panic::{catch_unwind, AssertUnwindSafe};

use common::{census_prices, codes as codes_of, input_of, read_jsonl, record, repo_root, PLANTED, REAL};
use kaap_core::*;
use serde_json::Value;
use FindingCode::*;

/// Sputnik's kinds other than Transfer and FunctionCall, which `policy::decode` owns.
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

const OWNED: [FindingCode; 9] = [
    PolicyAddsApprover,
    PolicyLowersThreshold,
    PolicyReplacesRole,
    PolicyRemovesMember,
    PolicyBeforeUnknown,
    PolicyDuplicateRoleNames,
    GuardWeakened,
    CodeUpgrade,
    OtherRiskyKind,
];

/// Codes of the description check (WO-03c) and the hash check (WO-04). A label carrying one of
/// them can floor at critical for a reason this decoder does not own.
const OTHER_MODULES: [FindingCode; 6] =
    [DescContradicts, EmptyDescription, PromptInjection, HashUnverified, HashMismatch, HashTextDangerous];

/// 129 of the 373 records, counted on 29 Oct 2026. A different count means the key or the filter
/// changed, and the bars below would silently measure something else.
const POLICY_RECORDS: usize = 129;

struct Row {
    id: String,
    kind: String,
    effects: Option<(String, String)>,
    codes: Option<(String, String)>,
    floor: Option<(String, String)>,
    must_veto: Option<(bool, bool)>,
    veto_allowed: Option<(bool, bool)>,
    veto_scored: bool,
}

#[test]
fn policy_eval() {
    let prices = census_prices();
    let mut records = Vec::new();
    for file in [REAL, PLANTED] {
        records.extend(read_jsonl(&repo_root().join(file)).unwrap());
    }
    let chosen: Vec<&Value> = records.iter().filter(|r| POLICY_KINDS.contains(&variant(&r["kind"]))).collect();
    assert_eq!(chosen.len(), POLICY_RECORDS, "records whose kind is a policy or governance kind");

    let mut rows = Vec::new();
    let mut panics = Vec::new();
    for record in &chosen {
        let id = record["id"].as_str().unwrap().to_string();
        let input = input_of(record, &prices).unwrap();
        match catch_unwind(AssertUnwindSafe(|| analyze(&input))) {
            Ok(analysis) => rows.push(score(id, record, &analysis)),
            Err(_) => panics.push(id),
        }
    }
    assert!(panics.is_empty(), "analyze panicked on {panics:?}");

    let of = rows.len();
    let agree = |f: &dyn Fn(&Row) -> bool| rows.iter().filter(|r| f(r)).count();
    let effects = agree(&|r| r.effects.is_none());
    let codes = agree(&|r| r.codes.is_none());
    let veto_of = agree(&|r| r.veto_scored);
    let floor = agree(&|r| r.veto_scored && r.floor.is_none());
    let must_veto = agree(&|r| r.veto_scored && r.must_veto.is_none());
    let veto_allowed = agree(&|r| r.veto_scored && r.veto_allowed.is_none());

    println!();
    println!("== WO-03b policy and governance records: {of} of 373, {veto_of} with no desc/hash code");
    println!("{:<44} {:>6} {:>6} {:>8}", "measure", "agree", "of", "percent");
    println!("{:<44} {codes:>6} {of:>6} {:>8}", "owned codes", percent(codes, of));
    println!("{:<44} {floor:>6} {veto_of:>6} {:>8}", "risk floor (no desc/hash code)", percent(floor, veto_of));
    println!("{:<44} {must_veto:>6} {veto_of:>6} {:>8}", "must_veto (no desc/hash code)", percent(must_veto, veto_of));
    println!("{:<44} {veto_allowed:>6} {veto_of:>6} {:>8}", "veto_allowed (no desc/hash code)", percent(veto_allowed, veto_of));
    println!("{:<44} {effects:>6} {of:>6} {:>8}", "effects multiset (not held to a bar)", percent(effects, of));
    for row in &rows {
        let scored = |diff: &Option<(String, String)>| diff.clone();
        let flags = |diff: Option<(bool, bool)>| diff.map(|(k, a)| (k.to_string(), a.to_string()));
        let diffs = [
            ("owned codes", scored(&row.codes)),
            ("risk floor", scored(&row.floor)),
            ("must_veto", flags(row.must_veto)),
            ("veto_allowed", flags(row.veto_allowed)),
            ("effects", scored(&row.effects)),
        ];
        if diffs.iter().all(|(_, d)| d.is_none()) {
            continue;
        }
        println!("- {} [{}]", row.id, row.kind);
        for (what, diff) in diffs {
            if let Some((key, kaap)) = diff {
                println!("    {what:<12} key:  {key}");
                println!("    {:<12} kaap: {kaap}", "");
            }
        }
    }

    assert!(codes * 100 >= of * 97, "owned codes agree on {codes} of {of}, under 97 percent");
    assert!(floor * 100 >= veto_of * 98, "risk floor agrees on {floor} of {veto_of}, under 98 percent");
    assert_eq!(must_veto, veto_of, "must_veto differs where the label has no description or hash code");
}

#[test]
fn known_gap_a_guard_role_under_another_name_gets_no_guard_weakened() {
    // ProposalInput carries no guard account, so the guard role is recognised only by the
    // enrolment template's name, `guard`. The same removal from the same role under another name
    // is only POLICY_REMOVES_MEMBER. Closing this needs the guard account in the input (WO-03c).
    let named = input_of(&record(PLANTED, "planted:48"), &census_prices()).unwrap();
    assert!(codes_of(&analyze(&named)).contains(&GuardWeakened), "control: the role named guard");

    let mut renamed = named.clone();
    for role in renamed.policy_before.as_mut().unwrap()["roles"].as_array_mut().unwrap() {
        if role["name"] == policy::GUARD_ROLE {
            role["name"] = "kaap".into();
        }
    }
    renamed.kind_json = br#"{"RemoveMemberFromRole":{"member_id":"guard.sandbox","role":"kaap"}}"#.to_vec();
    let codes = codes_of(&analyze(&renamed));
    assert!(codes.contains(&PolicyRemovesMember), "{codes:?}");
    assert!(!codes.contains(&GuardWeakened), "the gap is closed; update this test and the guide");
}

fn variant(kind: &Value) -> &str {
    match kind {
        Value::String(s) => s,
        Value::Object(map) if map.len() == 1 => map.keys().next().map(String::as_str).unwrap_or_default(),
        _ => "",
    }
}

fn score(id: String, record: &Value, a: &Analysis) -> Row {
    let label = &record["label"];
    let theirs: Vec<Effect> = serde_json::from_value(label["effects"].clone()).unwrap();
    let effects_of = |effects: &[Effect]| {
        let mut keys: Vec<String> = effects.iter().map(effect_key).collect();
        keys.sort();
        keys.join("; ")
    };
    let (key_effects, kaap_effects) = (effects_of(&theirs), effects_of(&a.effects));

    let label_codes: BTreeSet<FindingCode> = label["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| serde_json::from_value(f["code"].clone()).unwrap())
        .collect();
    let kaap_codes: BTreeSet<FindingCode> = a.findings.iter().map(|f| f.code).collect();
    let owned = |codes: &BTreeSet<FindingCode>| names(codes.iter().filter(|c| OWNED.contains(c)));
    let (key_owned, kaap_owned) = (owned(&label_codes), owned(&kaap_codes));

    let veto_scored = !label_codes.iter().any(|c| OTHER_MODULES.contains(c));
    let key_floor = label["risk_floor"].as_str().unwrap().to_string();
    let kaap_floor = serde_json::to_value(a.risk_floor).unwrap().as_str().unwrap().to_string();
    let (key_must, key_allowed) = (label["must_veto"].as_bool().unwrap(), label["veto_allowed"].as_bool().unwrap());

    Row {
        id,
        kind: variant(&record["kind"]).to_string(),
        effects: (key_effects != kaap_effects).then_some((key_effects, kaap_effects)),
        codes: (key_owned != kaap_owned).then_some((key_owned, kaap_owned)),
        floor: (veto_scored && key_floor != kaap_floor).then_some((key_floor, kaap_floor)),
        must_veto: (veto_scored && key_must != a.must_veto).then_some((key_must, a.must_veto)),
        veto_allowed: (veto_scored && key_allowed != a.veto_allowed).then_some((key_allowed, a.veto_allowed)),
        veto_scored,
    }
}

/// One effect as the text the multiset compares: every field but the free-text `summary`, with
/// the lists of a `policy_change` and the `added` and `removed` lists inside them sorted, since
/// they are sets (a threshold ratio is left as it is). Label and result go through this same
/// function, so both sides are normalised alike (standard 2).
fn effect_key(effect: &Effect) -> String {
    fn sort(items: &mut [Value]) {
        items.sort_by_key(|item| item.to_string());
    }
    let mut v = serde_json::to_value(effect).unwrap();
    let map = v.as_object_mut().unwrap();
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
    v.to_string()
}

fn names<'a>(codes: impl Iterator<Item = &'a FindingCode>) -> String {
    codes
        .map(|c| match serde_json::to_value(c) {
            Ok(Value::String(s)) => s,
            other => format!("{other:?}"),
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn percent(part: usize, whole: usize) -> String {
    if whole == 0 {
        "-".into()
    } else {
        format!("{:.1}%", 100.0 * part as f64 / whole as f64)
    }
}
