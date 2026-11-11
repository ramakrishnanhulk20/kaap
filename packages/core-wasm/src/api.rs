//! The functions the bindings export, as plain Rust: JSON or text in, JSON or text out, and a fixed
//! error text out. Each one hands its input to one kaap-core function and adds no rule of its own,
//! so the CLI and the browser decide exactly what the sealed job decides (C14).
//!
//! Three things change shape on the way in, because JavaScript cannot carry them as they are: a
//! proposal kind and a policy arrive as their exact JSON text, a 64-bit time arrives as a decimal
//! string, and 32-byte values arrive as base64 or hex. Nothing an input says is ever copied into an
//! error, so an error can be shown without escaping attacker text.

use std::collections::BTreeSet;
use std::fmt;

use base64::Engine as _;
use kaap_core::hash::sign::to_hex;
use kaap_core::policy::arming::guard_arming as arming;
use kaap_core::policy::sputnik::{can_execute_action, to_policy_label, Action, Policy, RoleKind, LABELS};
use kaap_core::policy::GUARD_ROLE;
use kaap_core::receipt::{receivers_hash as hash_receivers, DECODER_VERSION};
use kaap_core::{
    enrolment,
    analyze as analyze_input, canonical_kind as canon_kind, canonical_policy as canon_policy, describe,
    hash::{nep413_hash as nep413, nep461_hash as nep461},
    kind_hash as hash_kind, policy_hash as hash_policy, verdict_hash as hash_verdict, AiStatus, FindingCode, History,
    Network, Prices, ProposalInput, Severity, SuppliedText, TextStandard, Verdict,
};
use serde::de::{self, Deserializer, MapAccess, Visitor};
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{json, Value};

/// JavaScript numbers are exact only up to 2^53 - 1, so any larger id is refused rather than
/// handed back rounded.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// A Sputnik proposal has about ten top-level fields (the sealed job's cap).
const MAX_PROPOSAL_FIELDS: usize = 32;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AnalyzeInput {
    network: Network,
    dao: String,
    proposal_id: u64,
    description: String,
    /// The exact text of `get_proposal(id).kind`.
    kind_json: String,
    /// The exact text of the policy before, read through kaap-core's canonical parser exactly as
    /// the sealed job reads it (standard 2). Absent or null means not known.
    #[serde(default)]
    policy_before_json: Option<String>,
    #[serde(default)]
    history: Option<History>,
    #[serde(default)]
    prices: Prices,
    #[serde(default)]
    dao_version: Option<String>,
    #[serde(default)]
    supplied_text: Option<TextInput>,
    #[serde(default)]
    guard_account: Option<String>,
    #[serde(default)]
    config_before: Option<Value>,
    /// Nanoseconds since 1970 as a decimal string.
    #[serde(default)]
    block_timestamp_ns: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TextInput {
    message: String,
    /// Base64 of the 32-byte nonce.
    nonce: String,
    recipient: String,
    standard: TextStandard,
    #[serde(default)]
    quotes: Vec<String>,
}

/// Runs `kaap_core::analyze` and returns `{analysis, kind_label, description}`, where
/// `description` holds the reasons the description check gave (`describe::outcome`) so a reader
/// can see why it agreed or contradicted. Errors on an input that does not read as the shape
/// above, a policy kaap-core cannot canonicalise, a nonce that is not 32 bytes of base64, or a
/// time that is not a whole number.
pub fn analyze(input_json: &str) -> Result<String, Error> {
    let input: AnalyzeInput = serde_json::from_str(input_json).map_err(|_| Error("the analyze input is not the expected shape"))?;
    let policy_before = match input.policy_before_json {
        None => None,
        Some(text) => Some(canonical_value(&text).ok_or(Error("policy_before_json is not a policy kaap-core can read"))?),
    };
    let supplied_text = match input.supplied_text {
        None => None,
        Some(t) => Some(SuppliedText {
            message: t.message,
            nonce: base64::engine::general_purpose::STANDARD
                .decode(&t.nonce)
                .ok()
                .and_then(|n| <[u8; 32]>::try_from(n).ok())
                .ok_or(Error("supplied_text.nonce is not 32 bytes of base64"))?,
            recipient: t.recipient,
            standard: t.standard,
            quotes: t.quotes,
        }),
    };
    let block_timestamp_ns = match input.block_timestamp_ns {
        None => None,
        Some(text) => Some(text.parse::<u64>().map_err(|_| Error("block_timestamp_ns is not a whole number"))?),
    };
    let input = ProposalInput {
        network: input.network,
        dao: input.dao,
        proposal_id: input.proposal_id,
        description: input.description,
        kind_json: input.kind_json.into_bytes(),
        policy_before,
        history: input.history,
        prices: input.prices,
        dao_version: input.dao_version,
        supplied_text,
        guard_account: input.guard_account,
        config_before: input.config_before,
        block_timestamp_ns,
    };
    let analysis = analyze_input(&input);
    let outcome = describe::outcome(&input, &analysis.effects);
    to_json(&json!({
        "analysis": analysis,
        "kind_label": to_policy_label(&input.kind_json),
        "description": {
            "agreements": outcome.agreements,
            "contradictions": outcome.contradictions,
            "injection": outcome.injection,
        },
    }))
}

/// Reads a `get_proposal` answer the way the sealed job does (`reads::parse_proposal`): one JSON
/// object with unique keys and at most 32 fields, a whole-number `id`, a string `description` and
/// a `kind`. Returns `{id, proposer, description, kind_json, status, submission_time}` with
/// `kind_json` the exact text of the kind, never re-encoded (C5); `proposer`, `status` and
/// `submission_time` are empty when absent.
pub fn read_proposal(answer: &str) -> Result<String, Error> {
    let fields: Fields = serde_json::from_str(answer).map_err(|_| Error("the answer is not a proposal object"))?;
    let raw = |key: &str| fields.0.iter().find(|(k, _)| k == key).map(|(_, v)| v.get());
    let text = |key: &str| raw(key).and_then(|v| serde_json::from_str::<String>(v).ok());
    let id = raw("id")
        .and_then(|v| serde_json::from_str::<u64>(v).ok())
        .filter(|id| *id <= MAX_SAFE_INTEGER)
        .ok_or(Error("the answer has no whole-number id"))?;
    let description = text("description").ok_or(Error("the answer has no description"))?;
    let kind_json = raw("kind").ok_or(Error("the answer has no kind"))?;
    to_json(&json!({
        "id": id,
        "proposer": text("proposer").unwrap_or_default(),
        "description": description,
        "kind_json": kind_json,
        "status": text("status").unwrap_or_default(),
        "submission_time": text("submission_time").unwrap_or_default(),
    }))
}

/// kaap-core's NEAR account id rule (`decode::account::is_account_id`): syntax only.
pub fn is_account_id(id: &str) -> bool {
    kaap_core::decode::account::is_account_id(id)
}

pub fn canonical_kind(kind_json: &str) -> Result<String, Error> {
    canon_kind(kind_json.as_bytes()).map_err(|_| Error("the kind cannot be canonicalised")).and_then(utf8)
}

pub fn canonical_policy(policy_json: &str) -> Result<String, Error> {
    canon_policy(policy_json.as_bytes()).map_err(|_| Error("the policy cannot be canonicalised")).and_then(utf8)
}

/// Hex of `kaap_core::kind_hash`, the `kind_hash` a verdict carries.
pub fn kind_hash(kind_json: &str) -> Result<String, Error> {
    hash_kind(kind_json.as_bytes()).map(|h| to_hex(&h)).map_err(|_| Error("the kind cannot be canonicalised"))
}

/// Hex of `kaap_core::policy_hash`, the `policy_hash` a verdict carries.
pub fn policy_hash(policy_json: &str) -> Result<String, Error> {
    hash_policy(policy_json.as_bytes()).map(|h| to_hex(&h)).map_err(|_| Error("the policy cannot be canonicalised"))
}

/// Hex of the NEP-413 hash of a message, a base64 32-byte nonce, a recipient and an optional
/// callback URL. The message is hashed exactly as given.
pub fn nep413_hash(message: &str, nonce_b64: &str, recipient: &str, callback_url: Option<String>) -> Result<String, Error> {
    let nonce = base64::engine::general_purpose::STANDARD
        .decode(nonce_b64)
        .ok()
        .and_then(|n| <[u8; 32]>::try_from(n).ok())
        .ok_or(Error("the nonce is not 32 bytes of base64"))?;
    Ok(to_hex(&nep413(message, &nonce, recipient, callback_url.as_deref())))
}

/// Hex of the NEP-461 hash of a borsh delegate action given as base64.
pub fn nep461_hash(delegate_b64: &str) -> Result<String, Error> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(delegate_b64)
        .map_err(|_| Error("the delegate action is not base64"))?;
    Ok(to_hex(&nep461(&bytes)))
}

/// A verdict as the worker writes it: the four 32-byte fields in lower-case hex.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VerdictInput {
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

/// Hex of `kaap_core::verdict_hash`, the id the guard records against a second use.
pub fn verdict_hash(verdict_json: &str) -> Result<String, Error> {
    let v: VerdictInput = serde_json::from_str(verdict_json).map_err(|_| Error("the verdict is not the expected shape"))?;
    let verdict = Verdict {
        version: v.version,
        guard: v.guard,
        network: v.network,
        dao: v.dao,
        proposal_id: v.proposal_id,
        kind_hash: hex32(&v.kind_hash)?,
        policy_hash: hex32(&v.policy_hash)?,
        receivers_hash: hex32(&v.receivers_hash)?,
        block_height: v.block_height,
        risk: v.risk,
        floor: v.floor,
        findings: v.findings,
        decoder_version: v.decoder_version,
        model_id: v.model_id,
        ai_status: v.ai_status,
        explanation_hash: hex32(&v.explanation_hash)?,
        expires_at_ms: v.expires_at_ms,
    };
    Ok(to_hex(&hash_verdict(&verdict)))
}

/// `kaap_core::policy::arming::guard_arming` for `guard` under the policy text, read through the
/// canonical parser. Vote counts are decimal strings, and "none" where nothing can pass a kind.
pub fn guard_arming(policy_json: &str, guard: &str) -> Result<String, Error> {
    let policy = canonical_value(policy_json).ok_or(Error("the policy cannot be read"))?;
    let a = arming(&policy, guard);
    let needed: serde_json::Map<String, Value> = a
        .approval_votes_needed
        .iter()
        .map(|(label, n)| (label.clone(), json!(if *n == u128::MAX { "none".to_string() } else { n.to_string() })))
        .collect();
    to_json(&json!({
        "rejects_alone": a.rejects_alone,
        "cannot_reject": a.cannot_reject,
        "extra_rights": a.extra_rights,
        "others_who_reject_alone": a.others_who_reject_alone,
        "approval_votes_needed": needed,
        "race_note": a.race_note,
    }))
}

/// Who may file, and who may approve, a proposal whose policy label is `label`, by Sputnik's own
/// `can_execute_action` (`kaap_core::policy::sputnik`). Every account a Group role names is asked
/// one by one, so a role name used twice is read the way Sputnik reads it (C1). `anyone` holds the
/// roles through which an account in no Group role may act (an Everyone role, or a token role that
/// asks for no tokens), and `token_roles` the roles that let holders of the DAO's token act, whose
/// members no policy lists. Errors on a policy the strict parser refuses, or a label that is not
/// one of Sputnik's 17.
pub fn who_acts(policy_json: &str, label: &str) -> Result<String, Error> {
    let value = canonical_value(policy_json).ok_or(Error("the policy cannot be read"))?;
    let policy = Policy::from_json(&value).ok_or(Error("the policy cannot be read"))?;
    if !LABELS.contains(&label) {
        return Err(Error("not a Sputnik policy label"));
    }
    let named: BTreeSet<&str> = policy.roles.iter().filter_map(|r| r.members()).flatten().map(String::as_str).collect();
    let side = |action: Action| {
        let accounts: Vec<Value> = named
            .iter()
            .filter_map(|account| {
                let (roles, allowed) = can_execute_action(&policy, account, label, action);
                allowed.then(|| json!({ "account": account, "roles": roles }))
            })
            .collect();
        // No Group role holds the empty name, since Sputnik stores only valid account ids, so this
        // asks for an account outside every Group with no delegated tokens.
        let (anyone, allowed) = can_execute_action(&policy, "", label, action);
        let token_roles: Vec<&str> = policy
            .roles
            .iter()
            .filter(|r| matches!(r.kind, RoleKind::Member(_)) && r.allows(label, action))
            .map(|r| r.name.as_str())
            .collect();
        json!({ "accounts": accounts, "anyone": if allowed { anyone } else { Vec::new() }, "token_roles": token_roles })
    };
    to_json(&json!({ "add_proposal": side(Action::AddProposal), "vote_approve": side(Action::VoteApprove) }))
}

pub use kaap_core::enrolment::OWN_REMOVAL;

/// Kaap's enrolment template (`kaap_core::enrolment`, C30) for the guard contract `guard`: the two
/// proposal kinds a DAO files, with their titles and descriptions. The first adds
/// `enrolment::role`, the guard's reject-only role on every label but `OWN_REMOVAL`; the second
/// calls `enroll` on the guard with no arguments and the template's deposit and gas. Both come
/// from the same items `analyze` reads Kaap's own enrolment back from, so the drafts always read
/// as what they are. Errors when `guard` is not a valid account id.
pub fn enrolment_drafts(guard: &str) -> Result<String, Error> {
    if !is_account_id(guard) {
        return Err(Error("the guard is not a valid account id"));
    }
    let add_role = json!({
        "title": "add Kaap's reject-only guard role",
        "kind_label": "policy_add_or_update_role",
        "description": format!(
            "Add Kaap's guard role \"{GUARD_ROLE}\" with one member, the guard contract {guard}. It may only vote to reject, \
             on every kind of proposal except removing a member from a role, so this DAO can always remove Kaap. One reject \
             from it decides. It cannot approve, remove or finalise anything."
        ),
        "kind": { "ChangePolicyAddOrUpdateRole": { "role": enrolment::role(guard) } },
    });
    let enrol = json!({
        "title": "enrol the DAO in Kaap's guard",
        "kind_label": "call",
        "description": format!(
            "Enrol this treasury in Kaap's guard {guard}. It attaches 0.01 NEAR for the guard's storage; the guard keeps \
             what its entry costs and refunds the rest."
        ),
        "kind": { "FunctionCall": { "receiver_id": guard, "actions": [{
            "method_name": enrolment::METHOD, "args": "e30=",
            "deposit": enrolment::DEPOSIT_YOCTO.to_string(), "gas": enrolment::GAS.to_string(),
        }] } },
    });
    let labels = enrolment::labels();
    to_json(&json!({ "role_name": GUARD_ROLE, "labels": labels, "left_out": [OWN_REMOVAL], "drafts": [add_role, enrol] }))
}

/// `kaap_core::receipt::DECODER_VERSION`, the `decoder_version` a verdict carries.
pub fn decoder_version() -> String {
    DECODER_VERSION.to_string()
}

/// Hex of `kaap_core::receipt::receivers_hash`, the `receivers_hash` a verdict carries, over
/// `[["<account>","<code hash>"],...]` in any order. Errors on anything else.
pub fn receivers_hash(pairs_json: &str) -> Result<String, Error> {
    let pairs: Vec<(String, String)> =
        serde_json::from_str(pairs_json).map_err(|_| Error("the pairs are not a list of [account, code hash]"))?;
    Ok(to_hex(&hash_receivers(&pairs)))
}

/// `kaap_core::prices::prices_from_tokens`. Errors when the text is not a JSON list.
pub fn prices_from_tokens(tokens_json: &str) -> Result<Prices, Error> {
    kaap_core::prices::prices_from_tokens(tokens_json).ok_or(Error("the token list is not a JSON list"))
}

pub fn prices_json(tokens_json: &str) -> Result<String, Error> {
    to_json(&prices_from_tokens(tokens_json)?)
}

/// A fixed error text. Never built from input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Error(pub &'static str);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

fn canonical_value(policy_json: &str) -> Option<Value> {
    canon_policy(policy_json.as_bytes()).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

fn utf8(bytes: Vec<u8>) -> Result<String, Error> {
    String::from_utf8(bytes).map_err(|_| Error("the canonical form is not UTF-8"))
}

fn to_json<T: serde::Serialize>(value: &T) -> Result<String, Error> {
    serde_json::to_string(value).map_err(|_| Error("the answer could not be written"))
}

fn hex32(text: &str) -> Result<[u8; 32], Error> {
    let bytes = text.as_bytes();
    if bytes.len() != 64 {
        return Err(Error("a hash field is not 64 hex characters"));
    }
    let nibble = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    };
    let mut out = [0u8; 32];
    for (i, pair) in bytes.chunks(2).enumerate() {
        match (nibble(pair[0]), nibble(pair[1])) {
            (Some(hi), Some(lo)) => out[i] = hi << 4 | lo,
            _ => return Err(Error("a hash field is not lower-case hex")),
        }
    }
    Ok(out)
}

/// A JSON object's top-level fields with each value's exact text. A duplicate key is refused, so
/// two readers can never take one answer two ways (standard 2).
struct Fields(Vec<(String, Box<RawValue>)>);

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

// The drafts `enrolment_drafts` prints, handed to `analyze` the way the CLI hands them over (the
// kind as text, the policy before as text, the guard account set) on the testnet demo DAO's policy
// before enrolment: the role draft gives no GUARD_WEAKENED, and the enroll draft one guard_enrol
// effect with no UNKNOWN_CALL or UNKNOWN_VALUE, with no prices given. It does NOT run the wasm
// build, and it does not cover a DAO whose policy already lets the guard reject (that still fires
// GUARD_WEAKENED, kaap-core's enrol_guard_role.rs).
#[cfg(test)]
mod tests {
    use super::*;

    fn deployment(file: &str) -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../deployments").join(file);
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    /// The NEAR Business role setup with the demo DAO's owner and member in its places, as
    /// scripts/setup-demo-dao.mjs filed it before the guard role was added.
    fn m1_before(state: &Value) -> Value {
        let mut policy = deployment("near-business-policy.json")["policy"].clone();
        for role in policy["roles"].as_array_mut().unwrap() {
            for place in role["kind"]["Group"].as_array_mut().unwrap().iter_mut() {
                let who = if *place == "<member 1>" { &state["owner"] } else { &state["dao"]["member"] };
                *place = who["account_id"].clone();
            }
        }
        policy
    }

    #[test]
    fn the_printed_drafts_read_back_as_what_they_are() {
        let state = deployment("testnet.json");
        let (dao, guard) = (state["dao"]["account_id"].as_str().unwrap(), state["guard"]["account_id"].as_str().unwrap());
        let template: Value = serde_json::from_str(&enrolment_drafts(guard).unwrap()).unwrap();
        let read = |draft: &Value| -> Value {
            let input = json!({
                "network": "testnet",
                "dao": dao,
                "proposal_id": 1,
                "description": draft["description"],
                "kind_json": draft["kind"].to_string(),
                "policy_before_json": m1_before(&state).to_string(),
                "guard_account": guard,
            });
            serde_json::from_str::<Value>(&analyze(&input.to_string()).unwrap()).unwrap()["analysis"].clone()
        };
        let codes = |analysis: &Value| -> Vec<String> {
            analysis["findings"].as_array().unwrap().iter().map(|f| f["code"].as_str().unwrap().to_string()).collect()
        };

        let role = read(&template["drafts"][0]);
        assert!(!codes(&role).contains(&"GUARD_WEAKENED".to_string()), "{:?}", codes(&role));
        assert!(codes(&role).is_empty() && role["risk_floor"] == "low", "nothing to warn about: {role}");

        let enrol = read(&template["drafts"][1]);
        assert_eq!(
            enrol["effects"],
            json!([{ "type": "guard_enrol", "guard": guard, "deposit": enrolment::DEPOSIT_YOCTO.to_string() }])
        );
        for code in ["UNKNOWN_CALL", "UNKNOWN_VALUE"] {
            assert!(!codes(&enrol).iter().any(|c| c == code), "{:?}", codes(&enrol));
        }
        assert!(codes(&enrol).is_empty() && enrol["risk_floor"] == "low", "nothing to warn about: {enrol}");
    }

    #[test]
    fn decoder_version_and_receivers_hash_are_kaap_cores() {
        assert_eq!(decoder_version(), "0.1.0");
        let pairs = r#"[["nori4qx.tanssg2.testnet","12AiGxHGtiSBJenkwsqqrV5Z1XJB1GhWkJRivrQB3m6Y"],
                        ["corm1gu.sputnikv2.testnet","AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH"]]"#;
        assert_eq!(receivers_hash(pairs).unwrap(), "3e45bc50874d22357a5da82e3a5721c951a8d36dd0b8f16d0f6946978c9ccefb");
        assert!(receivers_hash(r#"[["only one"]]"#).is_err());
    }
}
