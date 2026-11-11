//! The model machine's software record (C11, WO-05d DONE MEANS 1): NEAR AI's real report of
//! 11 Nov 2026, both of its quotes checked by dcap-qvl against Intel's collateral of that day, and
//! the event log, launcher configuration and deployment log held to them. Then that report with
//! one piece broken at a time, each of which must give exactly its own reason word. Not covered
//! here: a live report (the keyed testnet run in `RUNS.md`), whether the software is safe (Kaap
//! records it and does not judge it), and which host served a completion (instances share a key).

mod common;

use std::time::{Duration, Instant};

use common::world::{trust, World, COLLATERAL_11_NOV, KEY, NOW_11_NOV, QUOTE_HEX, REPORT_11_NOV, REPORT_11_NOV_NONCE};
use dcap_qvl::QuoteCollateralV3;
use kaap_sealed::ai::{consult, AiOutcome, Audience, Check};
use kaap_sealed::attest::evidence::ModelRecord;
use kaap_sealed::attest::flow::check_software;
use kaap_sealed::attest::gpu::GpuFacts;
use kaap_sealed::attest::measure::Software;
use kaap_sealed::attest::report::{bind, entries, DeploymentClaim, Entry};
use kaap_sealed::attest::tdx::{self, CollateralCache, QuoteCheck, QuoteFacts};
use kaap_sealed::attest::{Unverified, VerifiedModel};
use kaap_sealed::net::Deadline;
use serde_json::{json, Value};
use sha2::{Digest, Sha256, Sha384};

const COMPOSE_HASH: &str = "a0e3c6f4f21a60ea3f5c96bc7ef319b03a184ca2049605399275fbcea74e8c5f";

fn nonce() -> [u8; 32] {
    hex::decode(REPORT_11_NOV_NONCE.trim()).unwrap().try_into().unwrap()
}

/// The 11 Nov report with `edit` applied to its model entry: the body, and the entry as edited.
fn edited(edit: impl FnOnce(&mut Value)) -> (Vec<u8>, Value) {
    let mut report: Value = serde_json::from_str(REPORT_11_NOV).unwrap();
    edit(&mut report["model_attestations"][0]);
    let model = report["model_attestations"][0].clone();
    (report.to_string().into_bytes(), model)
}

fn real_model() -> Value {
    edited(|_| {}).1
}

/// One report's model entry after the checks that come first: its quote verified by dcap-qvl and
/// its report data bound to the key and the nonce, with the collateral cache that served it.
struct Checked {
    entry: Entry,
    quote: QuoteFacts,
    cache: CollateralCache,
}

fn checked(body: &[u8]) -> Checked {
    let entry = entries(body, &nonce()).unwrap().remove(0).unwrap();
    let mut pcs = World::new();
    pcs.collateral = COLLATERAL_11_NOV;
    let mut cache = CollateralCache::default();
    let collateral = cache.get(&mut pcs, &entry.candidate.quote, Deadline::after_ms(60_000)).unwrap();
    let quote = tdx::check_quote(&entry.candidate.quote, collateral, NOW_11_NOV).unwrap();
    bind(&entry.candidate, &quote.report_data, &nonce()).unwrap();
    Checked { entry, quote, cache }
}

fn software_with(c: &Checked, log_quote: QuoteCheck) -> Result<Software, Unverified> {
    check_software(&c.entry.software, &c.quote, log_quote, &nonce(), NOW_11_NOV, &c.cache)
}

fn software(c: &Checked) -> Result<Software, Unverified> {
    software_with(c, tdx::check_quote)
}

/// The reason the report fails with once `edit` is applied.
fn reason(edit: impl FnOnce(&mut Value)) -> Unverified {
    software(&checked(&edited(edit).0)).unwrap_err()
}

/// The checks on the edited report, on a machine whose RTMR3 really is the edited log's: one that
/// extended RTMR3 itself, which software inside the machine can do after boot.
fn when_rtmr3_agrees(edit: impl FnOnce(&mut Value)) -> Result<Software, Unverified> {
    let (body, model) = edited(edit);
    let mut c = checked(&body);
    c.quote.rt_mr3 = rtmr3_of(model["event_log"].as_array().unwrap());
    software(&c)
}

/// RTMR3 by NEAR AI's documented rule, written here apart from the crate's own replay.
fn rtmr3_of(events: &[Value]) -> [u8; 48] {
    let mut register = [0u8; 48];
    for e in events.iter().filter(|e| e["imr"] == 3) {
        let mut digest = Sha384::new();
        digest.update(0x0800_0001u32.to_le_bytes());
        digest.update(b":");
        digest.update(e["event"].as_str().unwrap());
        digest.update(b":");
        digest.update(hex::decode(e["event_payload"].as_str().unwrap()).unwrap());
        let mut next = Sha384::new();
        next.update(register);
        next.update(digest.finalize());
        register.copy_from_slice(&next.finalize());
    }
    register
}

fn runtime_event(name: &str, payload: &[u8]) -> Value {
    json!({ "imr": 3, "event_type": 0x0800_0001u32, "digest": "", "event": name, "event_payload": hex::encode(payload) })
}

/// The index of the first event named `name` in the model's event log.
fn at(model: &Value, name: &str) -> usize {
    model["event_log"].as_array().unwrap().iter().position(|e| e["event"] == name).unwrap()
}

fn as_text(value: &Value) -> Value {
    json!(value.to_string())
}

fn model_record(c: &Checked, software: &Software) -> ModelRecord {
    let model = VerifiedModel { signing_address: c.entry.candidate.signing_address, tcb_status: c.quote.tcb_status.clone(), advisory_ids: vec![], gpus: 8 };
    let gpu = GpuFacts { passed: true, iat: Some(NOW_11_NOV), exp: NOW_11_NOV + 3600 };
    ModelRecord::new(&model, &c.entry.candidate.quote, &c.quote, &gpu, software)
}

fn average(times: u32, run: impl Fn()) -> Duration {
    let started = Instant::now();
    for _ in 0..times {
        run();
    }
    started.elapsed() / times
}

#[test]
fn the_real_report_verifies_and_names_its_software() {
    let c = checked(REPORT_11_NOV.as_bytes());
    let software = software(&c).unwrap();
    let model = real_model();
    let tcb = &model["info"]["tcb_info"];
    assert_eq!(rtmr3_of(model["event_log"].as_array().unwrap()), c.quote.rt_mr3, "this file's own replay agrees with the quote");

    let real = model_record(&c, &software);
    let r = serde_json::to_value(&real).unwrap();
    for (field, want) in [("mr_td", &tcb["mrtd"]), ("rtmr0", &tcb["rtmr0"]), ("rtmr1", &tcb["rtmr1"]), ("rtmr2", &tcb["rtmr2"]), ("rtmr3", &tcb["rtmr3"])] {
        assert_eq!(&r[field], want, "{field} from the verified quote is the one the report states");
    }
    assert_eq!(r["mr_config_id"], format!("01{COMPOSE_HASH}{}", "00".repeat(15)));
    assert_eq!(r["compose_hash"], hex::encode(Sha256::digest(tcb["app_compose"].as_str().unwrap().as_bytes())));
    assert_eq!(r["compose_hash"], COMPOSE_HASH);
    assert_eq!(r["os_image_hash"], "91fd5d69ccee3e5ea4f2aeb8c9b632c4358c4ecfc29ba1aa6fb1e402af209829");
    assert_eq!(r["os_image_known"], true);
    assert_eq!((&r["app_id"], &r["instance_id"]), (&model["info"]["app_id"], &model["info"]["instance_id"]));
    let log_quote_hex = model["compose_manager_attestation"]["quote"].as_str().unwrap();
    assert_eq!(
        r["deployment"],
        json!({
            "actions": 262,
            "actions_hash": "a6b508e3ddd3ae0da1c2ecb6f1a5d0f85881e330d374797492e9ed09f6780ffb",
            "quote_sha256": hex::encode(Sha256::digest(hex::decode(log_quote_hex).unwrap())),
            "newest_compose_up": {
                "tag": "v0.0.554",
                "commit": "fe7493ee3a0b3d36c1079c095de554e7b218da5c",
                "file": "prod/GLM-5.3-Flash-SGL-TP2x4-W4AFP8-V12Q8.yaml",
                "file_sha256": "e88b040e8ecdb7869ac855880719f6d184c035f0199753bef64ed338f8622922",
            },
        })
    );
    let text = r.to_string();
    assert!(!text.contains(log_quote_hex), "the launcher's quote is named by its hash, not carried");
    assert!(!text.contains("docker_compose_file") && !text.contains("services"), "no launcher text and no action text beyond four plain words");

    // The whole public record: a verified run's, with this real model record in place of the
    // stand-in's.
    let model_bytes = serde_json::to_vec(&real).unwrap().len();
    let (_, mut evidence) = consult(&mut World::new(), Some(KEY), Some("FACTS"), Audience::Public, Deadline::after_ms(60_000), &trust());
    evidence.model_quotes[0] = real;
    let whole = evidence.to_bytes().len();
    println!("fixture model record: {model_bytes} bytes; whole evidence record: {whole} bytes");
    assert!(whole < 16 * 1024, "{whole} bytes");

    let collateral: QuoteCollateralV3 = serde_json::from_str(COLLATERAL_11_NOV).unwrap();
    let model_quote = average(5, || drop(tdx::check_quote(&c.entry.candidate.quote, &collateral, NOW_11_NOV).unwrap()));
    let with_log = average(5, || drop(software_with(&c, tdx::check_quote).unwrap()));
    let mut without = checked(REPORT_11_NOV.as_bytes());
    without.entry.software.deployment = DeploymentClaim::Absent;
    let without_log = average(5, || drop(software_with(&without, tdx::check_quote).unwrap()));
    println!("native debug build, mean of 5: model quote check {model_quote:?}; software checks with the deployment log {with_log:?}, without it {without_log:?}");
}

#[test]
fn a_changed_or_added_event_breaks_the_replay() {
    let mismatch = Unverified::RtmrReplayMismatch;
    let one_byte = |m: &mut Value| {
        let i = at(m, "compose-hash");
        let payload = m["event_log"][i]["event_payload"].as_str().unwrap().replacen('a', "b", 1);
        m["event_log"][i]["event_payload"] = json!(payload);
    };
    assert_eq!(reason(one_byte), mismatch, "one byte of the compose-hash payload");
    assert_eq!(reason(|m| m["event_log"].as_array_mut().unwrap().push(runtime_event("nearai-replica-report-key-v1", b"{}"))), mismatch);
    assert_eq!(reason(|m| m["event_log"].as_array_mut().unwrap().swap(21, 23)), mismatch, "two events swapped");
}

#[test]
fn a_missing_or_unreadable_event_log_is_unverified() {
    let missing = Unverified::EventLogMissing;
    assert_eq!(reason(|m| { m.as_object_mut().unwrap().remove("event_log"); }), missing);
    assert_eq!(reason(|m| m["event_log"] = json!("[{\"imr\":")), missing);
    assert_eq!(reason(|m| m["event_log"] = json!([])), missing);
}

#[test]
fn a_second_compose_hash_in_the_boot_window_is_refused_even_when_rtmr3_agrees() {
    let twice = |m: &mut Value| {
        let i = at(m, "compose-hash");
        let copy = m["event_log"][i].clone();
        m["event_log"].as_array_mut().unwrap().insert(i + 1, copy);
    };
    assert_eq!(reason(twice), Unverified::RtmrReplayMismatch, "the real quote never saw it");
    assert_eq!(when_rtmr3_agrees(twice), Err(Unverified::BootRecordMissing));
    let no_image = |m: &mut Value| {
        let i = at(m, "os-image-hash");
        m["event_log"].as_array_mut().unwrap().remove(i);
        m["info"]["tcb_info"].as_object_mut().unwrap().remove("os_image_hash");
    };
    assert_eq!(when_rtmr3_agrees(no_image), Err(Unverified::BootRecordMissing), "no system image measurement");
}

#[test]
fn a_compose_hash_after_system_ready_is_never_read() {
    let later = |m: &mut Value| m["event_log"].as_array_mut().unwrap().push(runtime_event("compose-hash", &[0x66; 32]));
    assert_eq!(reason(later), Unverified::RtmrReplayMismatch, "the log changed, so the replay fails");
    assert_eq!(hex::encode(when_rtmr3_agrees(later).unwrap().compose_hash), COMPOSE_HASH, "and extraction is unaffected");
}

#[test]
fn the_launcher_text_must_be_the_one_mrconfigid_binds() {
    let mismatch = Unverified::ComposeMismatch;
    let reserialised = |m: &mut Value| {
        let text = m["info"]["tcb_info"]["app_compose"].as_str().unwrap();
        let again = serde_json::to_string(&serde_json::from_str::<Value>(text).unwrap()).unwrap();
        m["info"]["tcb_info"]["app_compose"] = json!(again);
    };
    assert_eq!(reason(reserialised), mismatch);
    assert_eq!(reason(|m| { m["info"]["tcb_info"].as_object_mut().unwrap().remove("app_compose"); }), mismatch);
    let other_launcher = |m: &mut Value| {
        let i = at(m, "compose-hash");
        m["event_log"][i]["event_payload"] = json!(hex::encode([0x66; 32]));
        m["info"]["tcb_info"].as_object_mut().unwrap().remove("compose_hash");
    };
    assert_eq!(when_rtmr3_agrees(other_launcher), Err(mismatch), "a boot compose-hash that is not MRCONFIGID's");
    assert_eq!(reason(|m| m["info"]["tcb_info"]["compose_hash"] = json!("00".repeat(32))), mismatch, "the report's own field");
}

#[test]
fn mrconfigid_must_bind_this_launcher_in_layout_1() {
    let mut c = checked(REPORT_11_NOV.as_bytes());
    c.quote.mr_config_id[0] = 2;
    assert_eq!(software(&c), Err(Unverified::ConfigVersionUnknown));
    let mut c = checked(&edited(|m| m["compose_manager_attestation"] = Value::Null).0);
    c.quote.mr_config_id[5] ^= 1;
    assert_eq!(software(&c), Err(Unverified::ComposeMismatch), "text and boot log agree, MRCONFIGID does not");
}

#[test]
fn a_value_the_report_states_must_be_the_measured_one() {
    let missing = Unverified::BootRecordMissing;
    assert_eq!(reason(|m| m["info"]["app_id"] = json!("00".repeat(20))), missing);
    assert_eq!(reason(|m| m["info"]["instance_id"] = json!("00".repeat(20))), missing);
    assert_eq!(reason(|m| m["info"]["tcb_info"]["os_image_hash"] = json!("00".repeat(32))), missing);
}

#[test]
fn an_unknown_system_image_still_verifies_and_says_so() {
    let other_image = |m: &mut Value| {
        let i = at(m, "os-image-hash");
        m["event_log"][i]["event_payload"] = json!(hex::encode([0x77; 32]));
        m["info"]["tcb_info"]["os_image_hash"] = json!(hex::encode([0x77; 32]));
    };
    let software = when_rtmr3_agrees(other_image).unwrap();
    assert_eq!((software.os_image_hash, software.os_image_known), ([0x77; 32], false));
    assert!(software.deployment.is_some(), "an unknown image downgrades nothing");
}

#[test]
fn tcb_info_and_event_logs_are_read_as_text_or_as_json() {
    assert!(REPORT_11_NOV.contains("\"event_log\":[{"), "the model's log is an array in the real report");
    let baseline = software(&checked(REPORT_11_NOV.as_bytes())).unwrap();
    let edits: [fn(&mut Value); 4] = [
        |m| {
            let text = as_text(&m["info"]["tcb_info"]);
            m["info"]["tcb_info"] = text;
        },
        |m| {
            let text = as_text(&m["event_log"]);
            m["event_log"] = text;
        },
        |m| {
            let log: Value = serde_json::from_str(m["compose_manager_attestation"]["event_log"].as_str().unwrap()).unwrap();
            m["compose_manager_attestation"]["event_log"] = log;
        },
        |m| {
            let (tcb, log) = (as_text(&m["info"]["tcb_info"]), as_text(&m["event_log"]));
            m["info"]["tcb_info"] = tcb;
            m["event_log"] = log;
        },
    ];
    for edit in edits {
        assert_eq!(software(&checked(&edited(edit).0)).as_ref(), Ok(&baseline));
    }
}

#[test]
fn a_tampered_or_stale_deployment_log_is_unverified() {
    let inconsistent = Unverified::DeployLogMismatch;
    assert_eq!(reason(|m| m["compose_manager_attestation"]["actions"][100]["file"] = json!("prod/other.yaml")), inconsistent, "one action changed");
    assert_eq!(reason(|m| { m["compose_manager_attestation"]["actions"].as_array_mut().unwrap().pop(); }), inconsistent, "one action dropped");
    assert_eq!(reason(|m| m["compose_manager_attestation"]["nonce"] = json!("55".repeat(32))), inconsistent, "another run's nonce");
    assert_eq!(reason(|m| m["compose_manager_attestation"]["actions_hash"] = json!("00".repeat(32))), inconsistent);
    assert_eq!(reason(|m| m["compose_manager_attestation"]["report_data"] = json!("00".repeat(64))), inconsistent);
    let own_log_extended = |m: &mut Value| {
        let mut log: Vec<Value> = serde_json::from_str(m["compose_manager_attestation"]["event_log"].as_str().unwrap()).unwrap();
        log.push(runtime_event("compose-hash", &[0x66; 32]));
        m["compose_manager_attestation"]["event_log"] = json!(serde_json::to_string(&log).unwrap());
    };
    assert_eq!(reason(own_log_extended), inconsistent, "its own log no longer replays to its own quote");

    let mut flipped = hex::decode(real_model()["compose_manager_attestation"]["quote"].as_str().unwrap()).unwrap();
    flipped[70] ^= 1;
    let flipped = hex::encode(flipped);
    assert_eq!(reason(|m| m["compose_manager_attestation"]["quote"] = json!(flipped)), inconsistent, "a byte of MRSEAM: its quote fails dcap-qvl");
    assert_eq!(reason(|m| m["compose_manager_attestation"]["quote"] = json!(QUOTE_HEX.trim())), inconsistent, "a platform this run never fetched");
    assert_eq!(reason(|m| m["compose_manager_attestation"]["quote"] = json!("zz")), inconsistent, "unreadable");
    assert_eq!(reason(|m| m["compose_manager_attestation"] = json!({ "actions": [] })), inconsistent, "unreadable");

    // With and without the log's own `report_data` copy, so the quote's report data is checked
    // on its own and not only through that copy.
    let with_copy = checked(REPORT_11_NOV.as_bytes());
    let without_copy = checked(&edited(|m| { m["compose_manager_attestation"].as_object_mut().unwrap().remove("report_data"); }).0);
    assert!(software(&without_copy).is_ok(), "the copy is optional");
    for c in [&with_copy, &without_copy] {
        for log_quote in [log_quote_for_another_nonce as QuoteCheck, log_quote_over_other_actions, log_quote_of_another_launcher] {
            assert_eq!(software_with(c, log_quote), Err(inconsistent));
        }
    }
}

/// The launcher's genuine quote, as if it bound another nonce.
fn log_quote_for_another_nonce(quote: &[u8], collateral: &QuoteCollateralV3, now: u64) -> Result<QuoteFacts, Unverified> {
    let mut facts = tdx::check_quote(quote, collateral, now)?;
    facts.report_data[63] ^= 1;
    Ok(facts)
}

/// As if it bound other actions.
fn log_quote_over_other_actions(quote: &[u8], collateral: &QuoteCollateralV3, now: u64) -> Result<QuoteFacts, Unverified> {
    let mut facts = tdx::check_quote(quote, collateral, now)?;
    facts.report_data[0] ^= 1;
    Ok(facts)
}

/// As if it ran under another launcher configuration.
fn log_quote_of_another_launcher(quote: &[u8], collateral: &QuoteCollateralV3, now: u64) -> Result<QuoteFacts, Unverified> {
    let mut facts = tdx::check_quote(quote, collateral, now)?;
    facts.mr_config_id[5] ^= 1;
    Ok(facts)
}

#[test]
fn an_absent_deployment_log_is_recorded_absent_and_downgrades_nothing() {
    let edits: [fn(&mut Value); 2] = [
        |m| m["compose_manager_attestation"] = Value::Null,
        |m| {
            m.as_object_mut().unwrap().remove("compose_manager_attestation");
        },
    ];
    for edit in edits {
        let c = checked(&edited(edit).0);
        let software = software(&c).unwrap();
        assert_eq!(software.deployment, None);
        assert_eq!(serde_json::to_value(model_record(&c, &software)).unwrap()["deployment"], "absent");
        assert_eq!(hex::encode(software.compose_hash), COMPOSE_HASH);
    }
}

/// The checks run inside the preflight: a whole answer through the stand-in world, whose model
/// entry carries the 11 Nov software record, verifies and records it; the same answer with that
/// record broken comes back Unverified with the reason, never Verified.
#[test]
fn a_broken_software_record_makes_the_whole_answer_unverified() {
    let run = |edit: fn(&mut Value)| {
        let mut world = World::new();
        edit(&mut world.report["model_attestations"][0]);
        let (outcome, evidence) = consult(&mut world, Some(KEY), Some("FACTS"), Audience::Public, Deadline::after_ms(60_000), &trust());
        let AiOutcome::Answered { check, .. } = outcome else { panic!("{outcome:?}") };
        (check, evidence)
    };
    let (check, evidence) = run(|_| {});
    assert_eq!(check, Check::Verified { tcb_status: "OutOfDate".into() });
    let r: Value = serde_json::from_slice(&evidence.to_bytes()).unwrap();
    assert_eq!(r["model_quotes"][0]["compose_hash"], COMPOSE_HASH);
    assert_eq!(r["model_quotes"][0]["deployment"], "absent");

    let cases: [(fn(&mut Value), Unverified); 4] = [
        (|m| m["event_log"] = json!("[]"), Unverified::EventLogMissing),
        (|m| m["event_log"].as_array_mut().unwrap().push(runtime_event("compose-hash", &[0x66; 32])), Unverified::RtmrReplayMismatch),
        (|m| m["info"]["tcb_info"]["app_compose"] = json!("{}"), Unverified::ComposeMismatch),
        (|m| m["compose_manager_attestation"] = json!({ "nonce": "x" }), Unverified::DeployLogMismatch),
    ];
    for (edit, want) in cases {
        let (check, evidence) = run(edit);
        assert_eq!(check, Check::Unverified(want));
        assert!(evidence.model_quotes.is_empty(), "a candidate that failed is never recorded as checked");
    }
}
