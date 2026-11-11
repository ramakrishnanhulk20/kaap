// Scores `analyze` on the answer-key records whose kind is a policy or governance kind: the set of
// codes `policy::decode` owns, and, on the records whose label carries no description, prompt or
// hash code, the risk floor and the veto fields. It prints the table and every record that
// differs, then fails below its bars (97 percent on owned codes, 98 on the floor, every scored
// `must_veto`). The effects multiset is printed but not held to a bar. It does not score the codes
// of other modules, and it never judges whether the key or the decoder is right where they
// differ; docs/answer-key-notes/policy-engine.md does.
// The other tests cover the two optional inputs: GUARD_WEAKENED with and without the guard account
// (pinning the gap of a guard role under another name when it is not known), and the ChangeConfig
// flags with and without the config before. They do not read either input from chain.

mod common;

use std::collections::BTreeSet;
use std::panic::{catch_unwind, AssertUnwindSafe};

use base64::Engine as _;
use common::{census_prices, codes as codes_of, input_of, label_effects, read_jsonl, record, repo_root, PLANTED, REAL};
use kaap_core::*;
use serde_json::{json, Value};
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

/// Codes of the description check (`describe`) and the hash check (`hash`). A label carrying one of
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
    println!("== policy and governance records: {of} of 373, {veto_of} with no desc/hash code");
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
    // With no guard account in the input, the guard role is recognised only by the enrolment
    // template's name, `guard`, so the same removal from the same role under another name is only
    // POLICY_REMOVES_MEMBER. With the account set, the finding follows the account instead.
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

    let mut known = renamed.clone();
    known.guard_account = Some("guard.sandbox".into());
    let codes = codes_of(&analyze(&known));
    assert!(codes.contains(&GuardWeakened) && codes.contains(&PolicyRemovesMember), "{codes:?}");
}

const GUARD: Option<&str> = Some("guard.sandbox");

/// The codes `analyze` gives `kind` against `policy`, with the guard account `guard`, on planted:48.
fn guard_codes(kind: Value, policy: Option<Value>, guard: Option<&str>) -> Vec<FindingCode> {
    let mut input = input_of(&record(PLANTED, "planted:48"), &census_prices()).unwrap();
    input.kind_json = serde_json::to_vec(&kind).unwrap();
    input.policy_before = policy;
    input.guard_account = guard.map(str::to_string);
    codes_of(&analyze(&input))
}

/// The planted harness policy, with its guard role renamed `kaap` and holding rules of its own at
/// "1", so a second member leaves the guard's one reject deciding (to_weight is min(1, size)).
fn harness_with_a_kaap_role() -> Value {
    let mut policy = record(PLANTED, "planted:48")["context"]["policy_before"].clone();
    let one = json!({ "weight_kind": "RoleWeight", "quorum": "0", "threshold": "1" });
    for role in policy["roles"].as_array_mut().unwrap().iter_mut().filter(|r| r["name"] == "guard") {
        role["name"] = json!("kaap");
        role["vote_policy"] = policy::sputnik::LABELS.iter().map(|l| (l.to_string(), one.clone())).collect::<serde_json::Map<_, _>>().into();
    }
    policy
}

#[test]
fn with_the_guard_account_known_a_second_member_in_its_role_fires() {
    let add = json!({ "AddMemberToRole": { "member_id": "second.sandbox", "role": "kaap" } });
    assert!(guard_codes(add.clone(), Some(harness_with_a_kaap_role()), GUARD).contains(&GuardWeakened));
    assert!(!guard_codes(add, Some(harness_with_a_kaap_role()), None).contains(&GuardWeakened), "the role-name rule misses it");
}

#[test]
fn with_the_guard_account_known_an_edit_of_a_role_without_it_does_not_fire() {
    let add = json!({ "AddMemberToRole": { "member_id": "dave.sandbox", "role": "contributors" } });
    assert!(!guard_codes(add, Some(harness_with_a_kaap_role()), GUARD).contains(&GuardWeakened));

    // A role called `guard` that does not hold the guard account is an ordinary role.
    let mut policy = harness_with_a_kaap_role();
    policy["roles"].as_array_mut().unwrap().push(json!({
        "name": "guard", "kind": { "Group": ["eve.sandbox"] }, "permissions": ["*:AddProposal"], "vote_policy": {}
    }));
    let add = json!({ "AddMemberToRole": { "member_id": "frank.sandbox", "role": "guard" } });
    assert!(!guard_codes(add.clone(), Some(policy.clone()), GUARD).contains(&GuardWeakened));
    assert!(guard_codes(add, Some(policy), None).contains(&GuardWeakened), "the role-name rule fires on the name");
}

#[test]
fn with_the_guard_account_known_guard_weakened_follows_its_reject() {
    let harness = record(PLANTED, "planted:48")["context"]["policy_before"].clone();
    let guard_role = harness["roles"].as_array().unwrap().iter().find(|r| r["name"] == "guard").unwrap().clone();
    let codes = guard_codes;
    let g = GUARD;

    // A second member on the harness's 1/2 guard role: the guard's one reject stops deciding.
    let add = json!({ "AddMemberToRole": { "member_id": "second.sandbox", "role": "guard" } });
    assert!(codes(add, Some(harness.clone()), g).contains(&GuardWeakened));

    // Where the guard already needs a second reject, removing it still takes its reject right away.
    let mut two_guards = harness.clone();
    for role in two_guards["roles"].as_array_mut().unwrap().iter_mut().filter(|r| r["name"] == "guard") {
        role["kind"]["Group"].as_array_mut().unwrap().push(json!("second.sandbox"));
    }
    let remove = json!({ "RemoveMemberFromRole": { "member_id": "guard.sandbox", "role": "guard" } });
    assert!(codes(remove, Some(two_guards), g).contains(&GuardWeakened));

    // Rules of its own at "1" on the guard role leave every reject as it was, but they change the
    // guard's role, so both rules fire.
    let mut ones = guard_role.clone();
    let one = json!({ "weight_kind": "RoleWeight", "quorum": "0", "threshold": "1" });
    ones["vote_policy"] = policy::sputnik::LABELS.iter().map(|l| (l.to_string(), one.clone())).collect::<serde_json::Map<_, _>>().into();
    let update = json!({ "ChangePolicyAddOrUpdateRole": { "role": ones } });
    assert!(codes(update.clone(), Some(harness.clone()), g).contains(&GuardWeakened));
    assert!(codes(update, Some(harness), None).contains(&GuardWeakened));

    // With no policy before, a removal that names the guard account still fires.
    let remove_renamed = json!({ "RemoveMemberFromRole": { "member_id": "guard.sandbox", "role": "kaap" } });
    assert!(codes(remove_renamed.clone(), None, g).contains(&GuardWeakened));
    assert!(!codes(remove_renamed, None, None).contains(&GuardWeakened));
}

#[test]
fn config_flags_compare_with_the_config_before() {
    let config_change = |record: &Value, before: Option<Value>| {
        let mut input = input_of(record, &census_prices()).unwrap();
        input.config_before = before;
        analyze(&input).effects
    };
    let b64 = |text: &str| base64::engine::general_purpose::STANDARD.encode(text);

    // hh 4 recolours the theme. The config before is rebuilt from the label's note: proposal 3 had
    // the same name and purpose and primaryColor #3B82F6. Purpose false, metadata true.
    let hh = record(REAL, "mainnet:hh.sputnik-dao.near:4");
    let new = hh["kind"]["ChangeConfig"]["config"].clone();
    let shown = String::from_utf8(base64::engine::general_purpose::STANDARD.decode(new["metadata"].as_str().unwrap()).unwrap()).unwrap();
    let mut before = new.clone();
    before["metadata"] = json!(b64(&shown.replace("#000000", "#3B82F6")));
    assert_eq!(config_change(&hh, Some(before)), label_effects(&hh));

    // planted 65 renames the DAO and rewrites its purpose; the metadata stays empty. Purpose true,
    // metadata false.
    let planted = record(PLANTED, "planted:65");
    let before = json!({ "name": "Kaap", "purpose": "A test DAO", "metadata": "" });
    assert_eq!(config_change(&planted, Some(before)), label_effects(&planted));

    // An unchanged config gives false on both.
    let same = planted["kind"]["ChangeConfig"]["config"].clone();
    let unchanged = Effect::ConfigChange { name: "Kaap Treasury".into(), purpose_changed: ChangeFlag::Unchanged, metadata_changed: ChangeFlag::Unchanged };
    assert_eq!(config_change(&planted, Some(same)), [unchanged]);
}

#[test]
fn a_config_before_that_does_not_read_leaves_the_flags_unknown() {
    let planted = record(PLANTED, "planted:65");
    let unknown = [Effect::ConfigChange { name: "Kaap Treasury".into(), purpose_changed: ChangeFlag::Unknown, metadata_changed: ChangeFlag::Unknown }];
    for before in [
        None,
        Some(json!(null)),
        Some(json!({ "name": "Kaap", "purpose": "A test DAO" })),
        Some(json!({ "name": "Kaap", "purpose": "A test DAO", "metadata": "", "extra": 1 })),
    ] {
        let mut input = input_of(&planted, &census_prices()).unwrap();
        input.config_before = before.clone();
        assert_eq!(analyze(&input).effects, unknown, "{before:?}");
    }
    // A metadata that is not base64 makes only that flag unknown.
    let mut input = input_of(&planted, &census_prices()).unwrap();
    input.config_before = Some(json!({ "name": "Kaap", "purpose": "Guarded DAO treasury", "metadata": "not base64!" }));
    let flags = [Effect::ConfigChange { name: "Kaap Treasury".into(), purpose_changed: ChangeFlag::Unchanged, metadata_changed: ChangeFlag::Unknown }];
    assert_eq!(analyze(&input).effects, flags);
}

#[test]
fn a_config_field_of_the_wrong_type_leaves_only_its_flag_unknown() {
    let planted = record(PLANTED, "planted:65");
    let flags = |before: Value, kind: Option<Value>| {
        let mut input = input_of(&planted, &census_prices()).unwrap();
        input.config_before = Some(before);
        if let Some(kind) = kind {
            input.kind_json = serde_json::to_vec(&kind).unwrap();
        }
        match analyze(&input).effects.as_slice() {
            [Effect::ConfigChange { purpose_changed, metadata_changed, .. }] => (*purpose_changed, *metadata_changed),
            other => panic!("{other:?}"),
        }
    };
    use ChangeFlag::{Changed, Unchanged, Unknown};
    let same_purpose = "Guarded DAO treasury";

    // On the config before.
    for purpose in [json!(5), json!(null), json!(["Guarded DAO treasury"]), json!({ "text": same_purpose })] {
        assert_eq!(flags(json!({ "name": "Kaap", "purpose": purpose, "metadata": "" }), None), (Unknown, Unchanged), "{purpose}");
    }
    for metadata in [json!(0), json!(null), json!([]), json!({}), json!(true)] {
        assert_eq!(flags(json!({ "name": "Kaap", "purpose": same_purpose, "metadata": metadata }), None), (Unchanged, Unknown), "{metadata}");
    }

    // On the new config, with a config before that reads.
    let before = json!({ "name": "Kaap", "purpose": "A test DAO", "metadata": "" });
    let kind = |purpose: Value, metadata: Value| json!({ "ChangeConfig": { "config": { "name": "Kaap Treasury", "purpose": purpose, "metadata": metadata } } });
    assert_eq!(flags(before.clone(), Some(kind(json!(7), json!("")))), (Unknown, Unchanged));
    assert_eq!(flags(before.clone(), Some(kind(json!(same_purpose), json!(null)))), (Changed, Unknown));
    assert_eq!(flags(before, Some(kind(json!(same_purpose), json!("%%%")))), (Changed, Unknown));
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
