// Scores the description check on all 373 answer-key records: the description check, the
// presence of DESC_CONTRADICTS and of PROMPT_INJECTION, and `must_veto` on every record whose
// label holds no hash code (those belong to the hash checker). It prints every record that
// differs with the reasons the check gave, and fails below its bars (93 percent on the
// description check, 97 on each code, every scored `must_veto` but the two in `WORDING_ALONE`).
// A second test runs every real
// record, the private second set included when it is present, and fails if DESC_CONTRADICTS
// fires where the label is not `contradicts`. It does not score effects, other modules' codes or
// `veto_allowed`, and it never judges whether the key or the check is right where they differ;
// docs/answer-key-notes/description-check.md does that.

mod common;

use std::panic::{catch_unwind, AssertUnwindSafe};

use common::{census_prices, input_of, read_jsonl, repo_root, PLANTED, REAL};
use kaap_core::*;
use serde_json::Value;
use FindingCode::*;

/// The private second set (git-ignored). Its records are never written to disk.
const PRIVATE: &str = "reference/eval-nb/labels.jsonl";

const HASH_CODES: [FindingCode; 3] = [HashMismatch, HashTextDangerous, HashUnverified];

/// The 12 real records whose key says `must_veto` (guide v2.3, rulings 22 to 27).
const REAL_MUST_VETO: usize = 12;

/// Planted families n (41 to 43) and o (44 to 47).
const FAMILIES_N_AND_O: [&str; 7] =
    ["planted:41", "planted:42", "planted:43", "planted:44", "planted:45", "planted:46", "planted:47"];

/// The planted attacks whose only critical finding is instruction words, which answer key v2.3
/// floors at critical and Kaap at high, because wording alone never causes a veto (decided 12 Nov
/// 2026; docs/answer-key-notes/engine-stricter-than-key.md). Before: critical, must_veto. After:
/// high, no must_veto, veto_allowed. Label: critical, must_veto. So `must_veto` agrees on 335 of
/// the 337 labels with no hash code.
const WORDING_ALONE: [&str; 2] = ["planted:44", "planted:46"];

struct Row {
    id: String,
    key_desc: String,
    desc: String,
    key_codes: Vec<FindingCode>,
    codes: Vec<FindingCode>,
    key_veto: bool,
    veto: bool,
    key_floor: String,
    floor: String,
    reasons: Vec<&'static str>,
    agreements: Vec<&'static str>,
}

impl Row {
    fn has(&self, code: FindingCode) -> (bool, bool) {
        (self.key_codes.contains(&code), self.codes.contains(&code))
    }

    fn hash_label(&self) -> bool {
        self.key_codes.iter().any(|c| HASH_CODES.contains(c))
    }
}

fn name<T: serde::Serialize>(v: &T) -> String {
    match serde_json::to_value(v) {
        Ok(Value::String(s)) => s,
        other => format!("{other:?}"),
    }
}

fn score(records: &[Value]) -> Vec<Row> {
    let prices = census_prices();
    records
        .iter()
        .map(|record| {
            let id = record["id"].as_str().unwrap().to_string();
            let input = input_of(record, &prices).unwrap();
            let analysis = catch_unwind(AssertUnwindSafe(|| analyze(&input))).unwrap_or_else(|_| panic!("analyze panicked on {id}"));
            let outcome = describe::outcome(&input, &analysis.effects);
            let label = &record["label"];
            Row {
                id,
                key_desc: label["description_check"].as_str().unwrap().to_string(),
                desc: name(&analysis.description_check),
                key_codes: label["findings"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|f| serde_json::from_value(f["code"].clone()).unwrap())
                    .collect(),
                codes: analysis.findings.iter().map(|f| f.code).collect(),
                key_veto: label["must_veto"].as_bool().unwrap(),
                veto: analysis.must_veto,
                key_floor: label["risk_floor"].as_str().unwrap().to_string(),
                floor: name(&analysis.risk_floor),
                reasons: outcome.contradictions,
                agreements: outcome.agreements,
            }
        })
        .collect()
}

fn records(files: &[&str]) -> Vec<Value> {
    files.iter().flat_map(|f| read_jsonl(&repo_root().join(f)).unwrap()).collect()
}

fn percent(part: usize, whole: usize) -> String {
    format!("{:.1}%", 100.0 * part as f64 / whole.max(1) as f64)
}

#[test]
fn describe_eval() {
    let rows = score(&records(&[REAL, PLANTED]));
    assert_eq!(rows.len(), 373);
    let of = rows.len();
    let desc = rows.iter().filter(|r| r.key_desc == r.desc).count();
    let dc = rows.iter().filter(|r| r.has(DescContradicts).0 == r.has(DescContradicts).1).count();
    let pi = rows.iter().filter(|r| r.has(PromptInjection).0 == r.has(PromptInjection).1).count();
    let veto_rows: Vec<&Row> = rows.iter().filter(|r| !r.hash_label()).collect();
    let veto = veto_rows.iter().filter(|r| r.key_veto == r.veto).count();

    println!();
    println!("== description check: {of} records");
    println!("{:<40} {:>6} {:>6} {:>8}", "measure", "agree", "of", "percent");
    println!("{:<40} {desc:>6} {of:>6} {:>8}", "description_check", percent(desc, of));
    println!("{:<40} {dc:>6} {of:>6} {:>8}", "DESC_CONTRADICTS present", percent(dc, of));
    println!("{:<40} {pi:>6} {of:>6} {:>8}", "PROMPT_INJECTION present", percent(pi, of));
    println!("{:<40} {veto:>6} {:>6} {:>8}", "must_veto, labels with no hash code", veto_rows.len(), percent(veto, veto_rows.len()));
    for r in rows.iter().filter(|r| {
        r.key_desc != r.desc || r.has(DescContradicts).0 != r.has(DescContradicts).1 || r.has(PromptInjection).0 != r.has(PromptInjection).1
            || (!r.hash_label() && r.key_veto != r.veto)
    }) {
        println!("- {}  desc key {} kaap {}  must_veto key {} kaap {}", r.id, r.key_desc, r.desc, r.key_veto, r.veto);
        if !r.reasons.is_empty() {
            println!("    contradicts: {}", r.reasons.join("; "));
        }
        if !r.agreements.is_empty() {
            println!("    agrees: {}", r.agreements.join("; "));
        }
    }

    let golden: Vec<&Row> = rows
        .iter()
        .filter(|r| (r.id.starts_with("mainnet:") && r.key_veto) || FAMILIES_N_AND_O.contains(&r.id.as_str()))
        .collect();
    assert_eq!(golden.iter().filter(|r| r.id.starts_with("mainnet:")).count(), REAL_MUST_VETO);
    for r in &golden {
        let expected = if WORDING_ALONE.contains(&r.id.as_str()) { (false, "high") } else { (r.key_veto, r.key_floor.as_str()) };
        assert_eq!((r.veto, r.floor.as_str()), expected, "{}: must_veto and floor", r.id);
        assert_eq!(r.desc, r.key_desc, "{}: description check", r.id);
        assert_eq!(r.has(DescContradicts), (r.has(DescContradicts).0, r.has(DescContradicts).0), "{}", r.id);
        assert_eq!(r.has(PromptInjection), (r.has(PromptInjection).0, r.has(PromptInjection).0), "{}", r.id);
    }

    assert!(desc * 100 >= of * 93, "description_check agrees on {desc} of {of}, under 93 percent");
    assert!(dc * 100 >= of * 97, "DESC_CONTRADICTS agrees on {dc} of {of}, under 97 percent");
    assert!(pi * 100 >= of * 97, "PROMPT_INJECTION agrees on {pi} of {of}, under 97 percent");
    let veto_differs: Vec<&str> = veto_rows.iter().filter(|r| r.key_veto != r.veto).map(|r| r.id.as_str()).collect();
    assert_eq!(veto_differs, WORDING_ALONE, "must_veto differs on a record with no hash code: {veto} of {} agree", veto_rows.len());
}

#[test]
fn no_contradiction_on_a_real_record_the_key_does_not_call_contradicts() {
    let mut files = vec![REAL];
    let private = repo_root().join(PRIVATE).exists();
    if private {
        files.push(PRIVATE);
    } else {
        println!("private second set not present: scoring eval/real only");
    }
    let rows = score(&records(&files));
    let false_fires: Vec<&Row> = rows.iter().filter(|r| r.has(DescContradicts).1 && r.key_desc != "contradicts").collect();
    let real_injection: Vec<&Row> = rows.iter().filter(|r| r.has(PromptInjection).1).collect();
    println!();
    println!("== real records: {} ({})", rows.len(), if private { "eval/real and the private set" } else { "eval/real" });
    println!("DESC_CONTRADICTS where the key is not contradicts: {}", false_fires.len());
    println!("PROMPT_INJECTION on a real record: {}", real_injection.len());
    for r in false_fires.iter().chain(&real_injection) {
        println!("- {}  key {}  contradicts: {}", r.id, r.key_desc, r.reasons.join("; "));
    }
    assert!(false_fires.is_empty(), "DESC_CONTRADICTS fired on {} real records the key does not call contradicts", false_fires.len());
    assert!(real_injection.is_empty(), "PROMPT_INJECTION fired on {} real records", real_injection.len());
}
