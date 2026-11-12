//! The worker's only route to kaap-core. Node instantiates this as plain WebAssembly with no
//! imports, so the worker hashes policies and kinds, decodes verdicts and applies the veto rule
//! with the very code the sealed job and the guard run (C14, standard 2), never a TypeScript copy.
//!
//! Calling convention: Node writes the input into memory from `kaap_alloc`, calls an export with
//! its pointer and length, and gets back one u64 packing the pointer (high 32 bits) and length
//! (low 32 bits) of a JSON answer, `{"ok":<value>}` or `{"err":"<fixed text>"}`, which it then
//! hands back to `kaap_free`. Inputs are never echoed into an error, so an answer can be logged
//! without escaping attacker text.
//!
//! `parse_proposal` and `same_proposal` are ports of the sealed job's `reads.rs` (kaap-sealed
//! cannot be a dependency here: its wasm32 build pulls in OutLayer's WASI bindings). The worker
//! never trusts its port alone: a verdict is acted on only when the hash computed here equals the
//! hash the sealed job signed.

use std::alloc::{alloc, dealloc, Layout};
use std::collections::BTreeSet;
use std::fmt;

use base64::Engine as _;
use borsh::BorshDeserialize;
use kaap_core::severity::min_severity;
use kaap_core::verdict::VERDICT_VERSION;
use kaap_core::{verdict_bytes, verdict_hash, AiStatus, FindingCode, Network, Severity, Verdict};
use serde::de::{self, Deserialize, Deserializer, MapAccess, Visitor};
use serde::Serialize;
use serde_json::value::RawValue;
use serde_json::{json, Value};

/// JavaScript numbers are exact only up to 2^53 - 1, so any larger id, height or time is refused
/// rather than rounded on the Node side.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// A Sputnik proposal has about ten top-level fields (the sealed job's cap).
const MAX_PROPOSAL_FIELDS: usize = 32;

/// The most proposals one `get_proposals` answer may hold. The worker asks for at most 100.
const MAX_PROPOSALS_PER_PAGE: usize = 200;

/// Allocates `len` bytes for an input. Returns null when `len` is zero.
#[no_mangle]
pub extern "C" fn kaap_alloc(len: usize) -> *mut u8 {
    match Layout::array::<u8>(len) {
        Ok(layout) if layout.size() > 0 => unsafe { alloc(layout) },
        _ => std::ptr::null_mut(),
    }
}

/// Frees a buffer from `kaap_alloc` or an answer, given the length it was made with.
///
/// # Safety
/// `ptr` must come from `kaap_alloc(len)` or be the pointer of an answer of length `len`.
#[no_mangle]
pub unsafe extern "C" fn kaap_free(ptr: *mut u8, len: usize) {
    if let (false, Ok(layout)) = (ptr.is_null(), Layout::array::<u8>(len)) {
        if layout.size() > 0 {
            dealloc(ptr, layout);
        }
    }
}

unsafe fn input<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if ptr.is_null() || len == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(ptr, len)
    }
}

fn answer(result: Result<Value, &'static str>) -> u64 {
    let body = match result {
        Ok(value) => json!({ "ok": value }),
        Err(why) => json!({ "err": why }),
    };
    let bytes = serde_json::to_vec(&body)
        .unwrap_or_else(|_| br#"{"err":"the answer could not be written"}"#.to_vec())
        .into_boxed_slice();
    let len = bytes.len() as u64;
    let ptr = Box::into_raw(bytes) as *mut u8 as usize as u64;
    (ptr << 32) | len
}

macro_rules! export {
    ($name:ident, $body:path) => {
        /// # Safety
        /// `ptr` and `len` must describe a buffer from `kaap_alloc`.
        #[no_mangle]
        pub unsafe extern "C" fn $name(ptr: *const u8, len: usize) -> u64 {
            answer($body(input(ptr, len)))
        }
    };
}

export!(kaap_verdict_decode, verdict_decode);
export!(kaap_verdict_encode, verdict_encode);
export!(kaap_kind_hash, kind_hash);
export!(kaap_policy_hash, policy_hash);
export!(kaap_proposal_read, proposal_read);
export!(kaap_proposals_read, proposals_read);
export!(kaap_same_proposal, same_proposal_pair);
export!(kaap_called_accounts, called_accounts_of);
export!(kaap_receivers_hash, receivers_hash_of);
export!(kaap_guard_arming, guard_arming_of);

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    bytes.iter().flat_map(|b| [DIGITS[usize::from(b >> 4)] as char, DIGITS[usize::from(b & 15)] as char]).collect()
}

fn unhex32(text: &str) -> Result<[u8; 32], &'static str> {
    let digit = |c: u8| match c {
        b'0'..=b'9' => Ok(c - b'0'),
        b'a'..=b'f' => Ok(c - b'a' + 10),
        _ => Err("a hash is not 64 lowercase hex characters"),
    };
    let raw = text.as_bytes();
    if raw.len() != 64 {
        return Err("a hash is not 64 lowercase hex characters");
    }
    let mut out = [0u8; 32];
    for (i, pair) in raw.chunks(2).enumerate() {
        out[i] = (digit(pair[0])? << 4) | digit(pair[1])?;
    }
    Ok(out)
}

fn name_of<T: Serialize>(value: T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

fn safe(n: u64) -> Result<u64, &'static str> {
    if n <= MAX_SAFE_INTEGER {
        Ok(n)
    } else {
        Err("a number in the input is above 2^53 - 1")
    }
}

/// The guard's veto rule, line for line from kaap-guard's `is_vetoable`: critical risk, a high or
/// critical floor, at least one finding other than HASH_UNVERIFIED that is high or critical at its
/// `min_severity`, and, when the floor is only high, a Verified AI answer.
fn is_vetoable(verdict: &Verdict) -> bool {
    let floor_high = matches!(verdict.floor, Severity::High | Severity::Critical);
    let backed_by_proof = verdict.findings.iter().any(|&code| {
        code != FindingCode::HashUnverified
            && matches!(min_severity(code), Severity::High | Severity::Critical)
    });
    let raised_by_proven_ai =
        verdict.floor == Severity::Critical || verdict.ai_status == AiStatus::Verified;
    verdict.risk == Severity::Critical && floor_high && backed_by_proof && raised_by_proven_ai
}

/// Decodes the borsh of a `kaap_core::Verdict` (no domain prefix, as the sealed job prints it).
/// Refuses trailing bytes, a version other than 1 and numbers Node cannot hold exactly. Returns
/// every field, the signed bytes (prefix plus borsh) in base64, the verdict hash the guard
/// records, and whether the guard's veto rule accepts it.
fn verdict_decode(bytes: &[u8]) -> Result<Value, &'static str> {
    let verdict = Verdict::try_from_slice(bytes).map_err(|_| "the verdict is not a kaap-core Verdict")?;
    if verdict.version != VERDICT_VERSION {
        return Err("the verdict version is not 1");
    }
    let b64 = base64::engine::general_purpose::STANDARD;
    Ok(json!({
        "version": verdict.version,
        "guard": verdict.guard,
        "network": name_of(verdict.network),
        "dao": verdict.dao,
        "proposal_id": safe(verdict.proposal_id)?,
        "kind_hash": hex(&verdict.kind_hash),
        "policy_hash": hex(&verdict.policy_hash),
        "receivers_hash": hex(&verdict.receivers_hash),
        "block_height": safe(verdict.block_height)?,
        "risk": name_of(verdict.risk),
        "floor": name_of(verdict.floor),
        "findings": verdict.findings.iter().map(|&c| name_of(c)).collect::<Vec<_>>(),
        "decoder_version": verdict.decoder_version,
        "model_id": verdict.model_id,
        "ai_status": name_of(verdict.ai_status),
        "explanation_hash": hex(&verdict.explanation_hash),
        "expires_at_ms": safe(verdict.expires_at_ms)?,
        "verdict_hash": hex(&verdict_hash(&verdict)),
        "signed_b64": b64.encode(verdict_bytes(&verdict)),
        "vetoable": is_vetoable(&verdict),
    }))
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct VerdictFields {
    version: u8,
    guard: String,
    network: Network,
    dao: String,
    proposal_id: u64,
    kind_hash: String,
    policy_hash: String,
    receivers_hash: String,
    block_height: u64,
    risk: Severity,
    floor: Severity,
    findings: Vec<FindingCode>,
    decoder_version: String,
    model_id: String,
    ai_status: AiStatus,
    explanation_hash: String,
    expires_at_ms: u64,
}

/// The reverse of `verdict_decode` for the fields it returns, hashes as hex, giving the borsh in
/// base64. The worker never makes verdicts; its tests use this to build ones it can sign.
fn verdict_encode(bytes: &[u8]) -> Result<Value, &'static str> {
    let f: VerdictFields = serde_json::from_slice(bytes).map_err(|_| "not the verdict fields")?;
    let verdict = Verdict {
        version: f.version,
        guard: f.guard,
        network: f.network,
        dao: f.dao,
        proposal_id: f.proposal_id,
        kind_hash: unhex32(&f.kind_hash)?,
        policy_hash: unhex32(&f.policy_hash)?,
        receivers_hash: unhex32(&f.receivers_hash)?,
        block_height: f.block_height,
        risk: f.risk,
        floor: f.floor,
        findings: f.findings,
        decoder_version: f.decoder_version,
        model_id: f.model_id,
        ai_status: f.ai_status,
        explanation_hash: unhex32(&f.explanation_hash)?,
        expires_at_ms: f.expires_at_ms,
    };
    let borsh = borsh::to_vec(&verdict).map_err(|_| "the verdict could not be encoded")?;
    Ok(json!(base64::engine::general_purpose::STANDARD.encode(borsh)))
}

/// sha256 of kaap-core's canonical kind, in hex: the `kind_hash` a verdict carries.
fn kind_hash(bytes: &[u8]) -> Result<Value, &'static str> {
    kaap_core::kind_hash(bytes).map(|h| json!(hex(&h))).map_err(|_| "the kind cannot be canonicalised")
}

/// sha256 of kaap-core's canonical policy, in hex: the `policy_hash` a verdict carries. Two
/// policies that differ only in the order of Sputnik's sets and maps give the same hash.
fn policy_hash(bytes: &[u8]) -> Result<Value, &'static str> {
    kaap_core::policy_hash(bytes).map(|h| json!(hex(&h))).map_err(|_| "the policy cannot be canonicalised")
}

/// One proposal from a `get_proposal` answer: id, status, `submission_time` (nanoseconds, as
/// Sputnik writes it) and the kind as its exact text, the bytes the guard must forward (C5).
fn proposal_read(bytes: &[u8]) -> Result<Value, &'static str> {
    let p = parse_proposal(bytes)?;
    Ok(p.to_json())
}

/// Every proposal of a `get_proposals` answer, each read like `proposal_read`.
fn proposals_read(bytes: &[u8]) -> Result<Value, &'static str> {
    let items: Vec<Box<RawValue>> =
        serde_json::from_slice(bytes).map_err(|_| "the answer is not a list of proposals")?;
    if items.len() > MAX_PROPOSALS_PER_PAGE {
        return Err("the answer holds more proposals than asked for");
    }
    let read: Result<Vec<Value>, _> = items.iter().map(|raw| parse_proposal(raw.get().as_bytes()).map(|p| p.to_json())).collect();
    Ok(Value::Array(read?))
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Pair {
    a: String,
    b: String,
}

/// Whether two `get_proposal` answers hold the same proposal: the kind equal in canonical form,
/// every other field equal byte for byte (the sealed job's `same_proposal`). Input
/// `{"a":"<answer text>","b":"<answer text>"}`.
fn same_proposal_pair(bytes: &[u8]) -> Result<Value, &'static str> {
    let pair: Pair = serde_json::from_slice(bytes).map_err(|_| "not {a,b}")?;
    Ok(json!(same_proposal(pair.a.as_bytes(), pair.b.as_bytes())))
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct CalledInput {
    dao: String,
    kind: String,
}

/// kaap-core's `receipt::called_accounts`: the DAO and every contract whose code runs when the
/// kind executes. Input `{"dao":"<account>","kind":"<kind text>"}`.
fn called_accounts_of(bytes: &[u8]) -> Result<Value, &'static str> {
    let input: CalledInput = serde_json::from_slice(bytes).map_err(|_| "not {dao,kind}")?;
    let accounts = kaap_core::receipt::called_accounts(&input.dao, input.kind.as_bytes());
    accounts.map(|a| json!(a)).ok_or("the kind names an invalid account id")
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ArmingInput {
    policy: String,
    guard: String,
}

/// What a DAO's policy gives `guard`, by kaap-core's `policy::arming::guard_arming` (C16): the
/// kinds of proposal its one reject decides, and the policy's `proposal_period` in nanoseconds
/// as Sputnik writes it, null when the policy states none that reads as a whole number. The
/// worker watches a DAO only while the first list is not empty. Input
/// `{"policy":"<get_policy text>","guard":"<account>"}`.
fn guard_arming_of(bytes: &[u8]) -> Result<Value, &'static str> {
    let input: ArmingInput = serde_json::from_slice(bytes).map_err(|_| "not {policy,guard}")?;
    let canonical =
        kaap_core::canonical_policy(input.policy.as_bytes()).map_err(|_| "the policy cannot be canonicalised")?;
    let policy: Value = serde_json::from_slice(&canonical).map_err(|_| "the policy cannot be read")?;
    let arming = kaap_core::policy::arming::guard_arming(&policy, &input.guard);
    let period = policy
        .get("proposal_period")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty() && p.len() <= 20 && p.bytes().all(|b| b.is_ascii_digit()));
    Ok(json!({ "rejects_alone": arming.rejects_alone, "proposal_period_ns": period }))
}

/// kaap-core's `receipt::receivers_hash`: the `receivers_hash` a verdict carries. Input
/// `[["<account>","<code hash>"],...]` in any order.
fn receivers_hash_of(bytes: &[u8]) -> Result<Value, &'static str> {
    let pairs: Vec<(String, String)> = serde_json::from_slice(bytes).map_err(|_| "not a list of pairs")?;
    Ok(json!(hex(&kaap_core::receipt::receivers_hash(&pairs))))
}

struct Proposal {
    id: u64,
    status: String,
    kind: String,
    submission_time: Option<String>,
}

impl Proposal {
    fn to_json(&self) -> Value {
        json!({ "id": self.id, "status": self.status, "kind": self.kind, "submission_time": self.submission_time })
    }
}

fn parse_proposal(bytes: &[u8]) -> Result<Proposal, &'static str> {
    const NOT: &str = "the answer is not a proposal object";
    let fields = top_level(bytes).ok_or(NOT)?;
    let raw = |key: &str| fields.0.iter().find(|(k, _)| k == key).map(|(_, v)| v.get());
    let id = raw("id").and_then(|v| serde_json::from_str::<u64>(v).ok()).ok_or(NOT)?;
    raw("description").and_then(|v| serde_json::from_str::<String>(v).ok()).ok_or(NOT)?;
    let kind = raw("kind").ok_or(NOT)?.to_string();
    let status = raw("status").and_then(|v| serde_json::from_str::<String>(v).ok()).unwrap_or_default();
    let submission_time = raw("submission_time").and_then(|v| serde_json::from_str::<String>(v).ok());
    Ok(Proposal { id: safe(id)?, status, kind, submission_time })
}

fn same_proposal(a: &[u8], b: &[u8]) -> bool {
    let (Some(a), Some(b)) = (top_level(a), top_level(b)) else {
        return false;
    };
    a.0.len() == b.0.len()
        && a.0.iter().all(|(key, value)| {
            let Some((_, other)) = b.0.iter().find(|(k, _)| k == key) else {
                return false;
            };
            if key == "kind" {
                match (kaap_core::canonical_kind(value.get().as_bytes()), kaap_core::canonical_kind(other.get().as_bytes())) {
                    (Ok(x), Ok(y)) => x == y,
                    _ => value.get() == other.get(),
                }
            } else {
                value.get() == other.get()
            }
        })
}

/// A JSON object's top-level fields with each value's exact text. Duplicate keys are refused, so
/// two readers can never take one answer two ways (standard 2).
struct Fields(Vec<(String, Box<RawValue>)>);

fn top_level(bytes: &[u8]) -> Option<Fields> {
    serde_json::from_slice(bytes).ok()
}

impl<'de> Deserialize<'de> for Fields {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct FieldsVisitor;
        impl<'de> Visitor<'de> for FieldsVisitor {
            type Value = Fields;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a JSON object with unique keys")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Fields, A::Error> {
                let mut seen = BTreeSet::new();
                let mut fields = Vec::new();
                while let Some(key) = map.next_key::<String>()? {
                    if !seen.insert(key.clone()) {
                        return Err(de::Error::custom("duplicate key"));
                    }
                    if fields.len() == MAX_PROPOSAL_FIELDS {
                        return Err(de::Error::custom("too many fields"));
                    }
                    fields.push((key, map.next_value::<Box<RawValue>>()?));
                }
                Ok(Fields(fields))
            }
        }
        d.deserialize_map(FieldsVisitor)
    }
}
