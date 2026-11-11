// Scores `analyze` against the answer key (eval/real and eval/planted, guide v2.3) field by field
// and prints the agreement table. It asserts only that all 373 records load and run without a
// panic: agreement bars belong to the per-module scoreboards (value_eval.rs, policy_eval.rs,
// describe_eval.rs, hash_eval.rs). It does not compare severities one by one (the risk floor
// carries them), `should_veto`, `is_test` or the notes, and it never judges whether the key or
// the decoder is right where they differ.
//
// KAAP_EVAL_FILTER=<kind or code> scores only the records of that kind (`Transfer`) or with that
// finding code in the label or in the result (`DESC_CONTRADICTS`), and lists each one that
// differs. KAAP_EVAL_EXTRA=<labels.jsonl>, absolute or relative to the repo root, scores one more
// labelled file the same way. Its records are listed only under a filter, and nothing from it is
// written to disk.

mod common;

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;

use common::{census_prices, input_of, read_jsonl, repo_root, PLANTED, REAL};
use kaap_core::*;
use serde::de::DeserializeOwned;
use serde_json::Value;

const FIELDS: [&str; 6] =
    ["effects", "finding_codes", "risk_floor", "description_check", "must_veto", "veto_allowed"];

struct Scored {
    id: String,
    kind: String,
    codes_seen: Vec<String>,
    /// (field index, label, kaap) for every field that differs.
    diffs: Vec<(usize, String, String)>,
}

struct Sheet {
    records: usize,
    unreadable: Vec<String>,
    panics: Vec<String>,
    scored: Vec<Scored>,
}

#[test]
fn eval() {
    let prices = census_prices();
    let filter = std::env::var("KAAP_EVAL_FILTER").ok().filter(|f| !f.is_empty());

    let key = score(&[repo_root().join(REAL), repo_root().join(PLANTED)], &prices);
    report("answer key: eval/real + eval/planted", &key, filter.as_deref(), true);

    let extra = std::env::var("KAAP_EVAL_EXTRA").ok().filter(|p| !p.is_empty()).map(|p| {
        let path = PathBuf::from(&p);
        let path = if path.is_absolute() { path } else { repo_root().join(path) };
        let sheet = score(&[path], &prices);
        report(&format!("extra: {p}"), &sheet, filter.as_deref(), filter.is_some());
        sheet
    });

    assert_eq!(key.records, 373, "the answer key has 300 real and 73 planted records");
    assert!(key.unreadable.is_empty(), "records that did not load: {:?}", key.unreadable);
    assert_eq!(key.scored.len(), 373);
    assert!(key.panics.is_empty(), "analyze panicked on {:?}", key.panics);
    if let Some(extra) = extra {
        assert!(extra.panics.is_empty(), "analyze panicked on {} extra records", extra.panics.len());
    }
}

fn score(files: &[PathBuf], prices: &Prices) -> Sheet {
    let mut sheet = Sheet { records: 0, unreadable: Vec::new(), panics: Vec::new(), scored: Vec::new() };
    for file in files {
        let records = match read_jsonl(file) {
            Ok(records) => records,
            Err(e) => {
                sheet.unreadable.push(e);
                continue;
            }
        };
        for record in records {
            sheet.records += 1;
            let id = record["id"].as_str().unwrap_or("(no id)").to_string();
            let input = match input_of(&record, prices) {
                Ok(input) => input,
                Err(e) => {
                    sheet.unreadable.push(format!("{id}: {e}"));
                    continue;
                }
            };
            match catch_unwind(AssertUnwindSafe(|| analyze(&input))) {
                Ok(analysis) => sheet.scored.push(compare(id, &record, &analysis)),
                Err(_) => sheet.panics.push(id),
            }
        }
    }
    sheet
}

fn compare(id: String, record: &Value, a: &Analysis) -> Scored {
    let label = &record["label"];
    let kind = match &record["kind"] {
        Value::String(s) => s.clone(),
        Value::Object(map) => map.keys().next().cloned().unwrap_or_default(),
        _ => String::new(),
    };
    let ours_effects = sorted(a.effects.iter().map(effect_key).collect());
    let ours_codes = sorted(a.findings.iter().map(|f| name(&f.code)).collect());

    let label_effects = read::<Vec<Effect>>(&label["effects"]).map(|es| sorted(es.iter().map(effect_key).collect()));
    let label_codes = label["findings"]
        .as_array()
        .ok_or_else(|| "findings is not a list".to_string())
        .and_then(|fs| fs.iter().map(|f| read::<FindingCode>(&f["code"]).map(|c| name(&c))).collect())
        .map(|mut codes: Vec<String>| {
            codes.sort();
            codes.dedup();
            codes
        });

    let mut codes_seen = ours_codes.clone();
    if let Ok(codes) = &label_codes {
        codes_seen.extend(codes.iter().cloned());
    }

    let fields: [(Result<String, String>, String); 6] = [
        (label_effects.map(|k| k.join("; ")), ours_effects.join("; ")),
        (label_codes.map(|c| c.join(",")), ours_codes.join(",")),
        (read::<Severity>(&label["risk_floor"]).map(|s| name(&s)), name(&a.risk_floor)),
        (read::<DescCheck>(&label["description_check"]).map(|d| name(&d)), name(&a.description_check)),
        (read::<bool>(&label["must_veto"]).map(|b| b.to_string()), a.must_veto.to_string()),
        (read::<bool>(&label["veto_allowed"]).map(|b| b.to_string()), a.veto_allowed.to_string()),
    ];
    let diffs = fields
        .into_iter()
        .enumerate()
        .filter_map(|(i, (theirs, ours))| match theirs {
            Ok(theirs) if theirs == ours => None,
            Ok(theirs) => Some((i, theirs, ours)),
            Err(e) => Some((i, format!("unreadable ({e})"), ours)),
        })
        .collect();
    Scored { id, kind, codes_seen, diffs }
}

/// One effect as the text the multiset compares: every field but the free-text `summary`, with
/// the lists inside a `policy_change` sorted, since they are sets. Label and result go through
/// this same function, so they are compared after the same normalisation.
fn effect_key(effect: &Effect) -> String {
    let Ok(mut v) = serde_json::to_value(effect) else {
        return format!("{effect:?}");
    };
    if let Some(map) = v.as_object_mut() {
        map.remove("summary");
        if map.get("type").and_then(Value::as_str) == Some("policy_change") {
            for list in map.values_mut() {
                if let Value::Array(items) = list {
                    items.sort_by_key(|item| item.to_string());
                }
            }
        }
    }
    v.to_string()
}

fn read<T: DeserializeOwned>(v: &Value) -> Result<T, String> {
    serde_json::from_value(v.clone()).map_err(|e| e.to_string())
}

fn name<T: serde::Serialize>(v: &T) -> String {
    match serde_json::to_value(v) {
        Ok(Value::String(s)) => s,
        other => format!("{other:?}"),
    }
}

fn sorted(mut items: Vec<String>) -> Vec<String> {
    items.sort();
    items
}

fn report(title: &str, sheet: &Sheet, filter: Option<&str>, show_records: bool) {
    let chosen: Vec<&Scored> = sheet
        .scored
        .iter()
        .filter(|s| filter.is_none_or(|f| s.kind == f || s.codes_seen.iter().any(|c| c == f)))
        .collect();
    println!();
    println!("== {title}");
    println!(
        "records {}, run {}, unreadable {}, panics {}",
        sheet.records,
        sheet.scored.len(),
        sheet.unreadable.len(),
        sheet.panics.len()
    );
    if show_records {
        for problem in sheet.unreadable.iter().chain(&sheet.panics) {
            println!("  not scored: {problem}");
        }
    }
    if let Some(f) = filter {
        println!("filter {f}: {} of {} records", chosen.len(), sheet.scored.len());
    }
    println!("{:<20} {:>6} {:>6} {:>8}", "field", "agree", "of", "percent");
    let of = chosen.len();
    for (i, field) in FIELDS.iter().enumerate() {
        let agree = chosen.iter().filter(|s| s.diffs.iter().all(|d| d.0 != i)).count();
        println!("{field:<20} {agree:>6} {of:>6} {:>8}", percent(agree, of));
    }
    let all = chosen.iter().filter(|s| s.diffs.is_empty()).count();
    println!("{:<20} {all:>6} {of:>6} {:>8}", "all six fields", percent(all, of));

    if filter.is_some() && show_records {
        let differing: Vec<&&Scored> = chosen.iter().filter(|s| !s.diffs.is_empty()).collect();
        println!("{} differ:", differing.len());
        for s in differing {
            println!("- {} [{}]", s.id, s.kind);
            for (i, theirs, ours) in &s.diffs {
                println!("    {:<18} key:  {theirs}", FIELDS[*i]);
                println!("    {:<18} kaap: {ours}", "");
            }
        }
    }
}

fn percent(part: usize, whole: usize) -> String {
    if whole == 0 {
        "-".into()
    } else {
        format!("{:.1}%", 100.0 * part as f64 / whole as f64)
    }
}
