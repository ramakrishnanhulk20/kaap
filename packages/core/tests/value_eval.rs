// Scores `analyze` on the answer-key records whose label holds only value-type effects: the
// effects multiset, the set of codes `decode::value` owns, and the veto fields on the records
// whose label carries no description, prompt or hash code. It prints the table and every record
// that differs, then fails below its bars (98 percent on effects, 97 on owned codes, every scored
// veto field). It does not score the codes of other modules, the risk floor or the description
// check, and it never judges whether the key or the decoder is right where they differ;
// docs/answer-key-notes/value-decoder.md does that.

mod common;

use std::collections::BTreeSet;
use std::panic::{catch_unwind, AssertUnwindSafe};

use common::{census_prices, input_of, read_jsonl, repo_root, PLANTED, REAL};
use kaap_core::*;
use serde_json::Value;
use FindingCode::*;

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

const OWNED: [FindingCode; 9] = [
    AttachedDeposit,
    NewRecipient,
    LargeAmount,
    UnknownValue,
    CrossChainOut,
    LookalikeToken,
    UnknownCall,
    ArgsNotJson,
    IntentsKeyChange,
];

/// Codes of the description check (`describe`) and the hash check (`hash`). A label carrying one of
/// them can floor at critical for a reason this decoder does not own.
const OTHER_MODULES: [FindingCode; 6] =
    [DescContradicts, EmptyDescription, PromptInjection, HashUnverified, HashMismatch, HashTextDangerous];

/// 205 of the 373 records, counted on 29 Oct 2026. A different count means the key or the filter
/// changed, and the bars below would silently measure something else.
const VALUE_RECORDS: usize = 205;

struct Row {
    id: String,
    effects: Option<(String, String)>,
    effects_exact: bool,
    codes: Option<(String, String)>,
    veto: Option<(String, String)>,
    veto_scored: bool,
}

#[test]
fn value_eval() {
    let prices = census_prices();
    let mut records = Vec::new();
    for file in [REAL, PLANTED] {
        records.extend(read_jsonl(&repo_root().join(file)).unwrap());
    }
    let chosen: Vec<&Value> = records.iter().filter(|r| value_only(r)).collect();
    assert_eq!(chosen.len(), VALUE_RECORDS, "records whose label holds only value-type effects");

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
    let effects = rows.iter().filter(|r| r.effects.is_none()).count();
    let effects_exact = rows.iter().filter(|r| r.effects_exact).count();
    let codes = rows.iter().filter(|r| r.codes.is_none()).count();
    let veto_of = rows.iter().filter(|r| r.veto_scored).count();
    let veto = rows.iter().filter(|r| r.veto_scored && r.veto.is_none()).count();

    println!();
    println!("== value records: {of} of 373");
    println!("{:<44} {:>6} {:>6} {:>8}", "measure", "agree", "of", "percent");
    println!("{:<44} {effects:>6} {of:>6} {:>8}", "effects multiset", percent(effects, of));
    println!("{:<44} {effects_exact:>6} {of:>6} {:>8}", "effects multiset, protocol case kept", percent(effects_exact, of));
    println!("{:<44} {codes:>6} {of:>6} {:>8}", "owned codes", percent(codes, of));
    println!("{:<44} {veto:>6} {veto_of:>6} {:>8}", "must_veto and veto_allowed (no desc/hash code)", percent(veto, veto_of));
    for row in rows.iter().filter(|r| r.effects.is_some() || !r.effects_exact || r.codes.is_some() || r.veto.is_some()) {
        println!("- {}", row.id);
        if !row.effects_exact && row.effects.is_none() {
            println!("    effects differ only in the case of defi_call protocol");
        }
        for (what, diff) in [("effects", &row.effects), ("owned codes", &row.codes), ("veto", &row.veto)] {
            if let Some((key, kaap)) = diff {
                println!("    {what:<12} key:  {key}");
                println!("    {:<12} kaap: {kaap}", "");
            }
        }
    }

    assert!(effects * 100 >= of * 98, "effects agree on {effects} of {of}, under 98 percent");
    assert!(codes * 100 >= of * 97, "owned codes agree on {codes} of {of}, under 97 percent");
    assert_eq!(veto, veto_of, "must_veto or veto_allowed differ where the label has no description or hash code");
}

fn value_only(record: &Value) -> bool {
    record["label"]["effects"]
        .as_array()
        .is_some_and(|effects| effects.iter().all(|e| e["type"].as_str().is_some_and(|t| VALUE_TYPES.contains(&t))))
}

fn score(id: String, record: &Value, a: &Analysis) -> Row {
    let label = &record["label"];
    let theirs: Vec<Effect> = serde_json::from_value(label["effects"].clone()).unwrap();
    let effects_of = |effects: &[Effect], fold: bool| {
        let mut keys: Vec<String> = effects.iter().map(|e| effect_key(e, fold)).collect();
        keys.sort();
        keys.join("; ")
    };
    let (key_effects, kaap_effects) = (effects_of(&theirs, true), effects_of(&a.effects, true));
    let effects_exact = effects_of(&theirs, false) == effects_of(&a.effects, false);

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
    let key_veto = format!("must_veto {} veto_allowed {}", label["must_veto"], label["veto_allowed"]);
    let kaap_veto = format!("must_veto {} veto_allowed {}", a.must_veto, a.veto_allowed);

    Row {
        id,
        effects: (key_effects != kaap_effects).then_some((key_effects, kaap_effects)),
        effects_exact,
        codes: (key_owned != kaap_owned).then_some((key_owned, kaap_owned)),
        veto: (veto_scored && key_veto != kaap_veto).then_some((key_veto, kaap_veto)),
        veto_scored,
    }
}

/// One effect as the text the multiset compares: every field but the free-text `summary`, as in
/// `tests/eval.rs`. With `fold`, the `protocol` name of a `defi_call` is compared in lower case:
/// the guide fixes no spelling for it and the key writes Burrow both ways. Label and result go
/// through this same function, so both sides are normalised alike (standard 2).
fn effect_key(effect: &Effect, fold: bool) -> String {
    let mut v = serde_json::to_value(effect).unwrap();
    let map = v.as_object_mut().unwrap();
    map.remove("summary");
    if fold {
        if let Some(Value::String(protocol)) = map.get_mut("protocol") {
            *protocol = protocol.to_lowercase();
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
