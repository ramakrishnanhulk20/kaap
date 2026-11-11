//! Which software the model's machine runs, as NEAR AI's report records it, held to the Intel
//! quote `tdx::check_quote` verified (C11). Pure functions: no network, no clock.
//!
//! Each record is bound to a register the quote signs:
//! - the RTMR3 event log, replayed by NEAR AI's documented rule (docs.near.ai, "Replay the RTMR3
//!   event log") read as strictly as NEAR AI's own gateway reads it (`verify_rtmr3_and_extract`,
//!   cloud-api 476ab3a1): every RTMR3 event is a dstack runtime event, and the system image and
//!   launcher hashes are read only from the boot window;
//! - the launcher configuration `app_compose`, whose SHA-256 MRCONFIGID carries in dstack's
//!   version 1 layout ("Check the configuration measurement"), the only layout that verifies;
//! - the launcher's deployment log, with its own quote, checked as NEAR AI's SDK checks it
//!   (`compose-manager-attestation.ts`, inference-sdk ff591054).
//!
//! A pass means the software record in the evidence is the one the genuine quote commits to. It
//! does not mean the software is approved, reviewed or safe: nothing here is an allowlist, and
//! `os_image_known` is a record, never a gate. Nor does it name the host that answered, because
//! every instance of the model shares one signing key, or show that what the deployment log
//! requested is what runs now: the log records requests.

use serde::Deserialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256, Sha384};

use super::report::{DeploymentLog, SoftwareClaims};
use super::tdx::QuoteFacts;
use super::{hex_array, hex_bytes, Unverified};

/// The event type dstack reserves for runtime events, whose digest is rebuilt from the name and
/// payload rather than taken from the log.
pub const DSTACK_RUNTIME_EVENT_TYPE: u32 = 0x0800_0001;

/// The runtime event dstack emits once boot is done, before any workload starts. Measurements
/// are read only from before it, so a workload that can extend RTMR3 later can neither add one
/// nor hide one.
pub const SYSTEM_READY: &str = "system-ready";

/// The OS vendor's published production image hashes for the image NEAR AI's model fleet runs
/// (Phala, github.com/Dstack-TEE/meta-dstack/releases/tag/v0.5.12, 13 Oct 2026). A record only:
/// an image not listed still verifies and shows `os_image_known: false`.
pub const KNOWN_OS_IMAGES: [(&str, &str); 1] =
    [("dstack-nvidia-0.5.12", "91fd5d69ccee3e5ea4f2aeb8c9b632c4358c4ecfc29ba1aa6fb1e402af209829")];

/// One dstack event log entry as NEAR AI's report sends it.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Event {
    pub imr: u32,
    #[serde(default)]
    pub event_type: u32,
    #[serde(default)]
    pub digest: String,
    #[serde(default)]
    pub event: String,
    #[serde(default)]
    pub event_payload: String,
    /// dstack's newer digest form sets this to 2. Only absent or 1 is the form replayed here.
    #[serde(default)]
    pub version: Option<Value>,
}

/// What the checks proved about the model's machine: each value read from a register the verified
/// quote signs, or from an event the replay bound to one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Software {
    pub compose_hash: [u8; 32],
    pub os_image_hash: [u8; 32],
    pub os_image_known: bool,
    pub app_id: Option<Vec<u8>>,
    pub instance_id: Option<Vec<u8>>,
    /// `None` when the report carried no deployment log; `check` leaves it to `deployment`.
    pub deployment: Option<Deployment>,
}

/// The measurements in the boot window, each from exactly one bound event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Boot {
    pub compose_hash: [u8; 32],
    pub os_image_hash: [u8; 32],
    pub app_id: Option<Vec<u8>>,
    pub instance_id: Option<Vec<u8>>,
}

/// One runtime event's digest in dstack's V1 form: SHA-384 of the event type as 4 little-endian
/// bytes, ":", the name as UTF-8, ":", the payload bytes.
pub fn runtime_digest(name: &str, payload: &[u8]) -> [u8; 48] {
    let mut hash = Sha384::new();
    hash.update(DSTACK_RUNTIME_EVENT_TYPE.to_le_bytes());
    hash.update(b":");
    hash.update(name.as_bytes());
    hash.update(b":");
    hash.update(payload);
    let mut out = [0u8; 48];
    out.copy_from_slice(&hash.finalize());
    out
}

/// RTMR3 rebuilt from `events`: only the events with `imr` 3, in log order, each a dstack runtime
/// event with no `version` but 1 and a hex payload, its digest rebuilt from its name and payload
/// and equal to its stored digest when it has one. The register starts at 48 zero bytes and each
/// digest extends it as SHA-384(register, digest). Returns the register and those events, whose
/// names and payloads it now binds. Anything else in RTMR3 gives `RtmrReplayMismatch`; a log with
/// no RTMR3 event gives `EventLogMissing`. The loop is bounded by the report's size cap.
pub fn replay_rtmr3(events: &[Event]) -> Result<([u8; 48], Vec<&Event>), Unverified> {
    let mut register = [0u8; 48];
    let mut bound = Vec::new();
    for event in events.iter().filter(|e| e.imr == 3) {
        let v1 = event.version.as_ref().is_none_or(|v| v.as_u64() == Some(1));
        if event.event_type != DSTACK_RUNTIME_EVENT_TYPE || !v1 {
            return Err(Unverified::RtmrReplayMismatch);
        }
        let payload = hex_bytes(&event.event_payload).ok_or(Unverified::RtmrReplayMismatch)?;
        let digest = runtime_digest(&event.event, &payload);
        if !event.digest.is_empty() && hex_array::<48>(&event.digest) != Some(digest) {
            return Err(Unverified::RtmrReplayMismatch);
        }
        let mut hash = Sha384::new();
        hash.update(register);
        hash.update(digest);
        register.copy_from_slice(&hash.finalize());
        bound.push(event);
    }
    if bound.is_empty() {
        return Err(Unverified::EventLogMissing);
    }
    Ok((register, bound))
}

/// The boot measurements, read from the bound events before the first `system-ready`:
/// `compose-hash` and `os-image-hash` exactly once each, 32 bytes each; `app-id` and
/// `instance-id` at most once. No `system-ready`, a missing or repeated measurement, or a payload
/// of the wrong size gives `BootRecordMissing`. Same-named events after `system-ready` are
/// never read.
pub fn boot_window(bound: &[&Event]) -> Result<Boot, Unverified> {
    let missing = Unverified::BootRecordMissing;
    let ready = bound.iter().position(|e| e.event == SYSTEM_READY).ok_or(missing)?;
    let window = &bound[..ready];
    let once = |name: &str| -> Result<Option<Vec<u8>>, Unverified> {
        let mut named = window.iter().filter(|e| e.event == name);
        let first = named.next();
        if named.next().is_some() {
            return Err(missing);
        }
        first.map(|e| hex_bytes(&e.event_payload).ok_or(missing)).transpose()
    };
    let hash = |bytes: Option<Vec<u8>>| bytes.and_then(|b| <[u8; 32]>::try_from(b).ok()).ok_or(missing);
    Ok(Boot {
        compose_hash: hash(once("compose-hash")?)?,
        os_image_hash: hash(once("os-image-hash")?)?,
        app_id: once("app-id")?,
        instance_id: once("instance-id")?,
    })
}

/// MRCONFIGID in dstack's version 1 layout binds the launcher configuration: byte 0 is 1, bytes 1
/// to 32 are SHA-256 of `app_compose`'s exact UTF-8 bytes (never parsed or re-serialised), the last
/// 15 are zero. Any other first byte gives `ConfigVersionUnknown`: dstack's versions 2 and 3
/// bind other things. A missing `app_compose`, a hash or tail that differs, or a boot
/// `compose-hash` that is not the same 32 bytes gives `ComposeMismatch`.
pub fn compose_binding(mr_config_id: &[u8; 48], app_compose: Option<&str>, boot_compose_hash: &[u8; 32]) -> Result<(), Unverified> {
    if mr_config_id[0] != 0x01 {
        return Err(Unverified::ConfigVersionUnknown);
    }
    let app_compose = app_compose.ok_or(Unverified::ComposeMismatch)?;
    let hash = Sha256::digest(app_compose.as_bytes());
    if mr_config_id[1..33] != hash[..] || mr_config_id[33..].iter().any(|&b| b != 0) {
        return Err(Unverified::ComposeMismatch);
    }
    if boot_compose_hash[..] != hash[..] {
        return Err(Unverified::ComposeMismatch);
    }
    Ok(())
}

/// True when the report did not state a value, or stated exactly the measured bytes.
fn as_measured(stated: Option<&str>, measured: Option<&[u8]>) -> bool {
    match stated.filter(|s| !s.is_empty()) {
        None => true,
        Some(text) => matches!((hex_bytes(text), measured), (Some(said), Some(m)) if said == m),
    }
}

pub fn os_image_known(hash: &[u8; 32]) -> bool {
    KNOWN_OS_IMAGES.iter().any(|(_, known)| hex_array::<32>(known).as_ref() == Some(hash))
}

/// Every check on the model machine's own record, for a candidate whose `quote` passed
/// `tdx::check_quote` and `report::bind`, in this order: an event log was sent
/// (`EventLogMissing`); it replays to the quote's RTMR3 (`replay_rtmr3`, `RtmrReplayMismatch`);
/// its boot window names the image and the launcher (`boot_window`); MRCONFIGID binds
/// `app_compose` and the boot `compose-hash` (`compose_binding`); and each value the report states
/// beside them is the measured one (`ComposeMismatch` for the compose hash,
/// `BootRecordMissing` for the others). The deployment log is checked apart from this.
pub fn check(claims: &SoftwareClaims, quote: &QuoteFacts) -> Result<Software, Unverified> {
    let events = claims.event_log.as_deref().ok_or(Unverified::EventLogMissing)?;
    let (register, bound) = replay_rtmr3(events)?;
    if register != quote.rt_mr3 {
        return Err(Unverified::RtmrReplayMismatch);
    }
    let boot = boot_window(&bound)?;
    compose_binding(&quote.mr_config_id, claims.app_compose.as_deref(), &boot.compose_hash)?;
    if !as_measured(claims.compose_hash.as_deref(), Some(&boot.compose_hash)) {
        return Err(Unverified::ComposeMismatch);
    }
    let stated = [
        (&claims.os_image_hash, Some(&boot.os_image_hash[..])),
        (&claims.app_id, boot.app_id.as_deref()),
        (&claims.instance_id, boot.instance_id.as_deref()),
    ];
    if !stated.iter().all(|(said, measured)| as_measured(said.as_deref(), *measured)) {
        return Err(Unverified::BootRecordMissing);
    }
    Ok(Software {
        compose_hash: boot.compose_hash,
        os_image_hash: boot.os_image_hash,
        os_image_known: os_image_known(&boot.os_image_hash),
        app_id: boot.app_id,
        instance_id: boot.instance_id,
        deployment: None,
    })
}

/// What a deployment log that passed `deployment` shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Deployment {
    pub actions: usize,
    pub actions_hash: [u8; 32],
    /// SHA-256 of the launcher's own quote, which the evidence names but does not carry.
    pub quote_sha256: [u8; 32],
    pub newest_compose_up: Option<ComposeUp>,
}

/// The newest `compose_up` action: which manifest file, at which commit, the launcher was last
/// asked to start. `tag`, `commit` and `file` are text from the report, kept only when
/// `plain_word` holds, because the evidence is public and other tools read it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComposeUp {
    pub tag: Option<String>,
    pub commit: Option<String>,
    pub file: Option<String>,
    pub file_sha256: Option<[u8; 32]>,
}

/// SHA-256 of the actions as NEAR AI's launcher hashes them: a JSON array of objects, each with
/// its keys sorted by their bytes and no spaces, every value a string or a list of strings,
/// written with serde_json's escaping, which for strings is the SDK's `JSON.stringify`. As in the
/// SDK, each action carries a string `action` and `timestamp`. `None` for anything else.
pub fn actions_hash(actions: &[Map<String, Value>]) -> Option<[u8; 32]> {
    let mut hash = Sha256::new();
    hash.update(b"[");
    for (i, action) in actions.iter().enumerate() {
        if !["action", "timestamp"].iter().all(|k| action.get(*k).is_some_and(Value::is_string)) {
            return None;
        }
        if i > 0 {
            hash.update(b",");
        }
        let mut fields: Vec<(&String, &Value)> = action.iter().collect();
        fields.sort_unstable_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
        hash.update(b"{");
        for (j, (key, value)) in fields.into_iter().enumerate() {
            let plain = match value {
                Value::String(_) => true,
                Value::Array(items) => items.iter().all(Value::is_string),
                _ => false,
            };
            if !plain {
                return None;
            }
            if j > 0 {
                hash.update(b",");
            }
            hash.update(serde_json::to_string(key).ok()?);
            hash.update(b":");
            hash.update(serde_json::to_string(value).ok()?);
        }
        hash.update(b"}");
    }
    hash.update(b"]");
    let mut out = [0u8; 32];
    out.copy_from_slice(&hash.finalize());
    Some(out)
}

/// At most 128 bytes of `A-Z a-z 0-9 . _ / -`, so it prints and stores with no escaping.
pub fn plain_word(text: &str) -> bool {
    !text.is_empty() && text.len() <= 128 && text.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'/' | b'-'))
}

/// The last `compose_up` in log order, as NEAR AI's SDK picks it.
fn newest_compose_up(actions: &[Map<String, Value>]) -> Option<ComposeUp> {
    let up = actions.iter().rev().find(|a| a.get("action").and_then(Value::as_str) == Some("compose_up"))?;
    let text = |key: &str| up.get(key).and_then(Value::as_str);
    let word = |key: &str| text(key).filter(|t| plain_word(t)).map(str::to_owned);
    Some(ComposeUp { tag: word("tag"), commit: word("commit"), file: word("file"), file_sha256: text("file_sha256").and_then(hex_array::<32>) })
}

/// The launcher's deployment log, for a log whose own quote `log_quote` passed
/// `tdx::check_quote`, checked as NEAR AI's SDK checks it: its `nonce` and its quote's report data
/// both carry this run's nonce; a returned `report_data` is the quote's; `actions_hash` is
/// `actions_hash` of the actions and is the first half of that report data; its MRCONFIGID is the
/// model quote's, so it ran under the same launcher configuration; and its own event log replays
/// to its own RTMR3. Any failure gives `DeployLogMismatch`. A pass shows what the
/// launcher was asked to deploy, never that it runs now.
pub fn deployment(log: &DeploymentLog, log_quote: &QuoteFacts, model_quote: &QuoteFacts, nonce: &[u8; 32]) -> Result<Deployment, Unverified> {
    let inconsistent = Err(Unverified::DeployLogMismatch);
    if hex_array::<32>(&log.nonce) != Some(*nonce) || log_quote.report_data[32..] != nonce[..] {
        return inconsistent;
    }
    if log.report_data.as_deref().is_some_and(|rd| hex_array::<64>(rd) != Some(log_quote.report_data)) {
        return inconsistent;
    }
    let Some(hash) = actions_hash(&log.actions) else { return inconsistent };
    if hex_array::<32>(&log.actions_hash) != Some(hash) || log_quote.report_data[..32] != hash[..] {
        return inconsistent;
    }
    if log_quote.mr_config_id != model_quote.mr_config_id {
        return inconsistent;
    }
    match replay_rtmr3(&log.event_log) {
        Ok((register, _)) if register == log_quote.rt_mr3 => {}
        _ => return inconsistent,
    }
    Ok(Deployment {
        actions: log.actions.len(),
        actions_hash: hash,
        quote_sha256: crate::verdict::sha256(&log.quote),
        newest_compose_up: newest_compose_up(&log.actions),
    })
}

// Each rule on hand-built logs, against digests computed apart from this file (Python hashlib).
// The real report is in tests/attest_measure.rs.
#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const SYSTEM_READY_DIGEST: &str = "1a76b2a80a0be71eae59f80945d876351a7a3fb8e9fd1ff1cede5734aa84ea11fd72b4edfbb6f04e5a85edd114c751bd";
    /// RTMR3 after `compose-hash` with 32 bytes of 0xab, then `system-ready`.
    const TWO_EVENTS: &str = "8b02b094639f968a6a1f7d74409a34e9362f688612fa3b7e37c36c501fb7810991e478e8110f43017090887a0b4457a3";
    /// The same two events in the other order.
    const SWAPPED: &str = "49a4b22362f73937d117185e358feeefae1443803dba8c9d2d5d7e93c004a50c913ac57d875403f1162715203289fc75";

    fn runtime(name: &str, payload: &[u8]) -> Event {
        Event {
            imr: 3,
            event_type: DSTACK_RUNTIME_EVENT_TYPE,
            digest: String::new(),
            event: name.into(),
            event_payload: hex::encode(payload),
            version: None,
        }
    }

    fn boot_event() -> Event {
        Event { imr: 0, event_type: 0x8000_0001, digest: "zz".into(), event: String::new(), event_payload: String::new(), version: None }
    }

    #[test]
    fn a_runtime_digest_is_dstacks_v1_form() {
        assert_eq!(hex::encode(runtime_digest("system-ready", b"")), SYSTEM_READY_DIGEST);
    }

    #[test]
    fn the_replay_reads_only_rtmr3_runtime_events_in_order() {
        let log = vec![boot_event(), runtime("compose-hash", &[0xab; 32]), boot_event(), runtime("system-ready", b"")];
        let (register, bound) = replay_rtmr3(&log).unwrap();
        assert_eq!(hex::encode(register), TWO_EVENTS, "events outside RTMR3 are not chained, and not even read");
        assert_eq!(bound.len(), 2);
        let swapped = vec![log[3].clone(), log[1].clone()];
        assert_eq!(hex::encode(replay_rtmr3(&swapped).unwrap().0), SWAPPED, "order is part of the register");

        let mut stored = log.clone();
        stored[3].digest = SYSTEM_READY_DIGEST.to_uppercase();
        assert_eq!(replay_rtmr3(&stored).unwrap().0, register, "a stored digest that matches is accepted");
        stored[3].digest = SYSTEM_READY_DIGEST.replace("1a76", "1a77");
        assert_eq!(replay_rtmr3(&stored), Err(Unverified::RtmrReplayMismatch), "a stored digest is never trusted over the payload");

        let edit = |change: fn(&mut Event)| {
            let mut log = log.clone();
            change(&mut log[1]);
            replay_rtmr3(&log).map(|r| r.0)
        };
        assert_eq!(edit(|e| e.event_type = 0x0800_0002), Err(Unverified::RtmrReplayMismatch), "a non-runtime event in RTMR3");
        assert_eq!(edit(|e| e.version = Some(json!(2))), Err(Unverified::RtmrReplayMismatch), "dstack's newer digest form");
        assert_eq!(edit(|e| e.version = Some(json!("1"))), Err(Unverified::RtmrReplayMismatch));
        assert_eq!(edit(|e| e.version = Some(json!(1))), Ok(register));
        assert_eq!(edit(|e| e.event_payload.push('a')), Err(Unverified::RtmrReplayMismatch), "a payload that is not hex");
        assert_eq!(replay_rtmr3(&[boot_event()]), Err(Unverified::EventLogMissing));
        assert_eq!(replay_rtmr3(&[]), Err(Unverified::EventLogMissing));
    }

    fn window(log: &[Event]) -> Result<Boot, Unverified> {
        boot_window(&log.iter().collect::<Vec<_>>())
    }

    fn good_boot() -> Vec<Event> {
        vec![
            runtime("app-id", &[1; 20]),
            runtime("compose-hash", &[2; 32]),
            runtime("instance-id", &[3; 20]),
            runtime("os-image-hash", &[4; 32]),
            runtime("system-ready", b""),
            runtime("nearai-replica-report-key-v1", b"{}"),
        ]
    }

    #[test]
    fn the_boot_window_takes_each_measurement_once_before_system_ready() {
        let boot = window(&good_boot()).unwrap();
        assert_eq!((boot.compose_hash, boot.os_image_hash), ([2; 32], [4; 32]));
        assert_eq!((boot.app_id, boot.instance_id), (Some(vec![1; 20]), Some(vec![3; 20])));

        let mut later = good_boot();
        later.push(runtime("compose-hash", &[9; 32]));
        later.push(runtime("os-image-hash", &[9; 32]));
        assert_eq!(window(&later).unwrap().compose_hash, [2; 32], "a workload's later event is never read");

        let refused = |edit: fn(&mut Vec<Event>)| {
            let mut log = good_boot();
            edit(&mut log);
            window(&log)
        };
        let missing = Err(Unverified::BootRecordMissing);
        assert_eq!(refused(|l| l.insert(2, runtime("compose-hash", &[2; 32]))), missing, "a repeat, even of the same value");
        assert_eq!(refused(|l| l.insert(2, runtime("os-image-hash", &[4; 32]))), missing);
        assert_eq!(refused(|l| l.insert(0, runtime("app-id", &[1; 20]))), missing);
        assert_eq!(refused(|l| { l.remove(1); }), missing, "no compose-hash");
        assert_eq!(refused(|l| { l.remove(3); }), missing, "no os-image-hash");
        assert_eq!(refused(|l| { l.remove(4); }), missing, "no system-ready");
        assert_eq!(refused(|l| l[1] = runtime("compose-hash", &[2; 31])), missing);
        let moved = refused(|l| {
            let compose = l.remove(1);
            l.push(compose);
        });
        assert_eq!(moved, missing, "a compose-hash only after boot is no boot measurement");
        assert!(refused(|l| { l.remove(0); }).is_ok_and(|b| b.app_id.is_none()), "app-id is optional");
    }

    fn mr_config(version: u8, text: &str) -> [u8; 48] {
        let mut id = [0u8; 48];
        id[0] = version;
        id[1..33].copy_from_slice(&Sha256::digest(text.as_bytes()));
        id
    }

    #[test]
    fn mrconfigid_binds_the_exact_app_compose_text() {
        let text = "{\"name\":\"kaap\"}";
        let hash: [u8; 32] = hex_array("9dd8f073291987c47d2f5066ecaaf9d3be528267cd7c43ac72079c915c4896de").unwrap();
        assert_eq!(compose_binding(&mr_config(1, text), Some(text), &hash), Ok(()));
        assert_eq!(compose_binding(&mr_config(2, text), Some(text), &hash), Err(Unverified::ConfigVersionUnknown));
        assert_eq!(compose_binding(&mr_config(0, text), None, &hash), Err(Unverified::ConfigVersionUnknown));
        let mismatch = Err(Unverified::ComposeMismatch);
        assert_eq!(compose_binding(&mr_config(1, text), Some("{\"name\": \"kaap\"}"), &hash), mismatch, "re-serialised");
        assert_eq!(compose_binding(&mr_config(1, text), Some("{\"name\":\"kaap\"}\n"), &hash), mismatch, "a trailing newline");
        assert_eq!(compose_binding(&mr_config(1, text), None, &hash), mismatch);
        assert_eq!(compose_binding(&mr_config(1, text), Some(text), &[0; 32]), mismatch, "the boot compose-hash differs");
        assert_eq!(compose_binding(&mr_config(1, "{}"), Some(text), &hash), mismatch, "text and boot log agree, MRCONFIGID does not");
        let mut tail = mr_config(1, text);
        tail[47] = 1;
        assert_eq!(compose_binding(&tail, Some(text), &hash), mismatch, "the 15 reserved bytes are zero");
    }

    fn actions(list: Value) -> Vec<serde_json::Map<String, Value>> {
        serde_json::from_value(list).unwrap()
    }

    #[test]
    fn the_actions_hash_is_sorted_key_compact_json_of_strings_only() {
        let two = json!([
            { "timestamp": "t1", "action": "compose_up", "services": ["b", "a"], "Zed": "\u{e9}" },
            { "action": "x", "timestamp": "t2", "file": "f\"q\n" },
        ]);
        let hash = actions_hash(&actions(two)).map(hex::encode);
        assert_eq!(hash.as_deref(), Some("7eb34094919f3dc44f3437982a938b42acd788547e900c9694191904e7202a61"), "keys by their bytes, JSON escapes");
        assert_eq!(actions_hash(&[]).map(hex::encode).as_deref(), Some("4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"));
        for bad in [
            json!([{ "action": "x", "timestamp": "t", "n": 1 }]),
            json!([{ "action": "x", "timestamp": "t", "services": ["a", 1] }]),
            json!([{ "action": "x", "timestamp": "t", "o": {} }]),
            json!([{ "action": "x" }]),
            json!([{ "action": 1, "timestamp": "t" }]),
        ] {
            assert_eq!(actions_hash(&actions(bad.clone())), None, "{bad}");
        }
        assert!(plain_word("prod/GLM-5.3_x.yaml") && plain_word(&"a".repeat(128)));
        assert!(!plain_word("") && !plain_word(&"a".repeat(129)) && !plain_word("a b") && !plain_word("a\"b") && !plain_word("\u{e9}"));
    }

    #[test]
    fn a_stated_value_must_be_the_measured_one() {
        assert!(as_measured(None, None) && as_measured(Some(""), Some(&[1])));
        assert!(as_measured(Some("0x0A0b"), Some(&[10, 11])), "one hex rule for both sides");
        assert!(!as_measured(Some("0a0c"), Some(&[10, 11])));
        assert!(!as_measured(Some("0a0b"), None), "a value the boot log never measured");
        assert!(!as_measured(Some("zz"), None));
        assert!(os_image_known(&hex_array(KNOWN_OS_IMAGES[0].1).unwrap()) && !os_image_known(&[0; 32]));
    }
}
