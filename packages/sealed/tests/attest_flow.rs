//! "AI verified" end to end (C11, WO-05a DONE MEANS 1): one answer through every check, then the
//! same answer with exactly one piece of evidence broken, each of which must come out Unverified,
//! never Verified and never a silent pass. The stand-in world (`common/world.rs`) serves Intel's
//! real collateral and key set and NEAR AI's real public Intel token; the model's quote is a
//! stand-in except where a real dcap-qvl check is the thing under test. Not covered here: real
//! NEAR AI, NVIDIA and model evidence (the first keyed testnet run, `RUNS.md`).

mod common;

use common::world::{nonce, trust, World, Signing, KEY, NOW, QUOTE_HEX};
use common::*;
use kaap_core::{AiStatus, Severity};
use kaap_sealed::ai::{consult, AiOutcome, Check, MODEL_ID};
use kaap_sealed::attest::{tdx, Trust, Unverified};
use kaap_sealed::net::Deadline;
use serde_json::{json, Value};

fn run(world: &mut World, trust: &Trust) -> (AiOutcome, kaap_sealed::attest::Evidence) {
    consult(world, Some(KEY), Some("FACTS"), Deadline::after_ms(60_000), trust)
}

fn check_of(world: &mut World, trust: &Trust) -> Check {
    match run(world, trust).0 {
        AiOutcome::Answered { check, .. } => check,
        other => panic!("the model's answer was not used: {other:?}"),
    }
}

fn unverified(edit: impl FnOnce(&mut World), trust: Trust) -> Unverified {
    let mut world = World::new();
    edit(&mut world);
    match check_of(&mut world, &trust) {
        Check::Unverified(why) => why,
        Check::Verified { .. } => panic!("verified with broken evidence"),
    }
}

#[test]
fn every_check_passing_gives_verified_with_evidence_a_stranger_can_follow() {
    let mut world = World::new();
    let (outcome, evidence) = run(&mut world, &trust());
    let AiOutcome::Answered { check, .. } = outcome else { panic!() };
    assert_eq!(check, Check::Verified { tcb_status: "OutOfDate".into() });
    let hosts: Vec<String> = world.urls().iter().map(|u| u.split('/').next().unwrap().to_string()).collect();
    for host in ["cloud-api.near.ai", "api.trustedservices.intel.com", "certificates.trustedservices.intel.com",
        "nras.attestation.nvidia.com", "portal.trustauthority.intel.com"] {
        assert!(hosts.iter().any(|h| h == host), "{host} was asked");
    }
    let chat_at = world.urls().iter().position(|u| u.ends_with("/chat/completions")).unwrap();
    let report_at = world.urls().iter().position(|u| u.contains("/attestation/report")).unwrap();
    let ita_at = world.urls().iter().position(|u| u.contains("/attestation/ita-token")).unwrap();
    assert!(report_at < chat_at && ita_at < chat_at, "evidence is checked before the question, never after");

    let record: Value = serde_json::from_slice(&evidence.to_bytes()).unwrap();
    assert_eq!(record["nonce"], hex::encode(nonce()));
    assert_eq!(record["model_quotes"][0]["tcb_status"], "OutOfDate");
    assert_eq!(record["model_quotes"][0]["gpus"], 8);
    assert_eq!(record["model_quotes"][0]["nras_passed"], true);
    assert_eq!(record["gateway"]["scope"], "NEAR AI gateway only, not the model");
    assert_eq!(record["gateway"]["signing_address"], "40599fb284f43953bb356b09080fd803c960fc10285ad90eca462ca711ad4acb");
    assert_ne!(record["gateway"]["signing_address"], record["model_quotes"][0]["signing_address"], "never shown as the model's key");
    assert_eq!(record["completion"]["chat_id"], "chatcmpl-kaap0001");
    assert_eq!(record["completion"]["reasoning_tokens"], 40);
    assert_eq!(record["signature"]["kind"], "provider_tee");
    assert!(record["signature"]["text"].as_str().unwrap().starts_with("z-ai/glm-5.3-flash:"));

    let link = record["verify_link"].as_str().unwrap();
    let (page, receipt) = link.split_once("#receipt=").unwrap();
    assert_eq!(page, "https://cloud.near.ai/verify?model=z-ai%2Fglm-5.3-flash");
    use base64::Engine as _;
    let receipt: Value = serde_json::from_slice(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(receipt).unwrap()).unwrap();
    assert_eq!(receipt["completionId"], "chatcmpl-kaap0001");
    assert_eq!(receipt["model"], MODEL_ID);
    assert_eq!(receipt["signatureKind"], "provider_tee");
    assert_eq!(receipt["signedText"], record["signature"]["text"]);
    assert_eq!(receipt["signingAddress"], record["model_quotes"][0]["signing_address"]);

    let quote = &record["model_quotes"][0];
    assert_eq!(quote["intel_quote"], QUOTE_HEX.trim(), "the quote itself, for anyone's own DCAP verifier");
    assert_eq!(quote["pck_flags"], json!({ "smt_enabled": "true", "cached_keys": "false", "dynamic_platform": "true" }));
    assert!(quote["pck_flags_policy"].as_str().unwrap().starts_with("accepted, not judged"));
}

#[test]
fn the_public_evidence_never_holds_answer_or_prompt_text() {
    for edit in [|_: &mut World| {}, |w: &mut World| w.signing = Signing::Gateway] {
        let mut world = World::new();
        edit(&mut world);
        let content = world.chat["choices"][0]["message"]["content"].as_str().unwrap().to_string();
        let reasoning = world.chat["choices"][0]["message"]["reasoning_content"].as_str().unwrap().to_string();
        let (outcome, evidence) = consult(&mut world, Some(KEY), Some("FACTS: alice.testnet asks for 10 NEAR"), Deadline::after_ms(60_000), &trust());
        let AiOutcome::Answered { answer, .. } = outcome else { panic!() };
        let text = String::from_utf8(evidence.to_bytes()).unwrap();
        for secret in [content.as_str(), reasoning.as_str(), answer.explanation.as_str(), "a1ice.testnet", "alice.testnet", "10 NEAR", "FACTS", KEY] {
            assert!(!text.contains(secret), "{secret:?} is in the public evidence");
        }
        let record: Value = serde_json::from_str(&text).unwrap();
        assert!(record["completion"].get("content_preview").is_none());
        assert_eq!(record["completion"]["content_bytes"], content.len());
    }
}

#[test]
fn another_model_answering_is_unverified() {
    assert_eq!(unverified(|w| w.chat["model"] = json!("z-ai/glm-5.3"), trust()), Unverified::WrongModel);
}

#[test]
fn an_answer_through_an_alias_is_unverified() {
    assert_eq!(unverified(|w| w.chat["model"] = json!("zai-org/GLM-5.1-FP8"), trust()), Unverified::AliasResolved);
}

#[test]
fn a_streamed_answer_is_unverified() {
    assert_eq!(unverified(|w| w.chat_type = "text/event-stream", trust()), Unverified::Streamed);
    assert_eq!(unverified(|w| w.chat["object"] = json!("chat.completion.chunk"), trust()), Unverified::Streamed);
}

#[test]
fn a_gateway_signature_is_unverified() {
    assert_eq!(unverified(|w| w.signing = Signing::Gateway, trust()), Unverified::GatewaySigned);
}

#[test]
fn a_signature_over_other_bytes_is_unverified() {
    assert_eq!(unverified(|w| w.signing = Signing::OtherAnswer, trust()), Unverified::TextMismatch);
}

#[test]
fn a_signer_the_report_did_not_name_is_unverified() {
    assert_eq!(unverified(|w| w.signing = Signing::OtherKey, trust()), Unverified::SignerNotAttested);
}

#[test]
fn a_stale_nonce_is_unverified() {
    let old = hex::encode([0x55; 32]);
    assert_eq!(unverified(|w| w.report["model_attestations"][0]["request_nonce"] = json!(old), trust()), Unverified::NonceMismatch);
    let replayed_quote = Trust { quote: common::world::quote_with_an_old_nonce, ..trust() };
    assert_eq!(unverified(|_| {}, replayed_quote), Unverified::NonceMismatch);
    let old_gpu_payload = json!({ "nonce": old, "evidence_list": [] }).to_string();
    assert_eq!(unverified(|w| w.report["model_attestations"][0]["nvidia_payload"] = json!(old_gpu_payload), trust()), Unverified::NonceMismatch);
    assert_eq!(unverified(|w| w.nras_claims["eat_nonce"] = json!(old), trust()), Unverified::NonceMismatch);
}

fn real_quote_check() -> Trust {
    Trust { quote: tdx::check_quote, ..trust() }
}

#[test]
fn a_bad_model_quote_is_unverified() {
    let collateral: dcap_qvl::QuoteCollateralV3 = serde_json::from_str(common::world::COLLATERAL).unwrap();
    let quote = hex::decode(QUOTE_HEX.trim()).unwrap();
    assert!(tdx::check_quote(&quote, &collateral, NOW).is_ok(), "the unchanged quote verifies at this time");
    let mut flipped = quote.clone();
    flipped[600] ^= 1;
    let flipped = hex::encode(flipped);
    assert_eq!(unverified(|w| w.report["model_attestations"][0]["intel_quote"] = json!(flipped), real_quote_check()), Unverified::QuoteRejected);
}

#[test]
fn stale_collateral_is_unverified() {
    let month_later = Trust { now: Ok(NOW + 31 * 86_400), ..real_quote_check() };
    assert_eq!(unverified(|_| {}, month_later), Unverified::CollateralStale);
}

#[test]
fn a_bad_intel_token_is_unverified() {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine as _;
    let edit = |w: &mut World| {
        let mut ita: Value = serde_json::from_str(&w.ita).unwrap();
        let token = ita["gateway"]["token"].as_str().unwrap().to_string();
        let (signed, sig) = token.rsplit_once('.').unwrap();
        let mut sig = URL_SAFE_NO_PAD.decode(sig).unwrap();
        sig[40] ^= 1;
        ita["gateway"]["token"] = json!(format!("{signed}.{}", URL_SAFE_NO_PAD.encode(sig)));
        w.ita = ita.to_string();
    };
    assert_eq!(unverified(edit, trust()), Unverified::GatewayTokenRejected);
}

#[test]
fn a_bad_nvidia_token_is_unverified() {
    assert_eq!(unverified(|w| w.nras_forged = true, trust()), Unverified::GpuTokenRejected);
    assert_eq!(unverified(|w| w.nras_claims["x-nvidia-overall-att-result"] = json!(false), trust()), Unverified::GpuNotTrusted);
}

#[test]
fn a_tcb_level_ram_did_not_accept_or_no_clock_is_unverified() {
    fn revoked(_: &[u8], _: &dcap_qvl::QuoteCollateralV3, _: u64) -> Result<tdx::QuoteFacts, Unverified> {
        Err(Unverified::TcbNotAccepted)
    }
    assert_eq!(unverified(|_| {}, Trust { quote: revoked, ..trust() }), Unverified::TcbNotAccepted);
    assert_eq!(unverified(|_| {}, Trust { now: Err(Unverified::NoClock), ..trust() }), Unverified::NoClock);
    assert_eq!(unverified(|_| {}, Trust { nonce: None, ..trust() }), Unverified::NoNonce);
    assert_eq!(unverified(|w| w.report["model_attestations"] = json!([]), trust()), Unverified::NoModelEvidence);
}

#[test]
fn the_clock_is_the_requesting_blocks_nanoseconds_and_nothing_else() {
    use kaap_sealed::attest::trusted_now;
    let read_ns = 1_792_733_000_000_000_000u64;
    assert_eq!(trusted_now(Some("1792732990123456789"), read_ns), Ok(1_792_732_990));
    for bad in [None, Some(""), Some("1792732990123"), Some("1792732990"), Some("-1"), Some("1792732990123456789 "), Some("99999999999999999999")] {
        assert_eq!(trusted_now(bad, read_ns), Err(Unverified::NoClock), "{bad:?}");
    }
    assert_eq!(trusted_now(Some(&(read_ns + 601_000_000_000).to_string()), read_ns), Err(Unverified::NoClock));
}

fn sealed_parts(fx: &Value) -> (kaap_sealed::input::JobInput, kaap_sealed::reads::ChainRead) {
    let (mut host, mut https) = providers(fx);
    let input = kaap_sealed::input::parse_input(
        br#"{"v":1,"network":"testnet","guard":"guard.kaap.testnet","dao":"r7thmvr8maey.sputnikv2.testnet","proposal_id":10,"expires_in_ms":600000}"#,
        Some("testnet"),
    )
    .unwrap();
    let read = kaap_sealed::reads::read_chain(&mut host, &mut https, &input.dao, input.proposal_id, Deadline::after_ms(60_000), 0).unwrap();
    (input, read)
}

#[test]
fn a_verified_answer_whose_evidence_cannot_be_published_is_signed_unverified() {
    let fx = fixture("function-call.json");
    let (input, read) = sealed_parts(&fx);
    let (_, analysis) = kaap_sealed::proposal::judge(input.network, &input.dao, input.proposal_id, &read);
    assert_eq!(analysis.risk_floor, Severity::High);
    let public_key = kaap_sealed::verdict::public_key_text(&mut TestSigner::new()).unwrap();
    let parts = kaap_sealed::job::Unsigned { input: &input, read: &read, analysis: &analysis, public_key: &public_key };

    let store = Store::default();
    let (outcome, evidence) = run(&mut World::new(), &trust());
    let (verdict, explanation) = kaap_sealed::job::seal_and_publish(&parts, outcome, evidence, &mut store.clone()).unwrap();
    assert_eq!((verdict.ai_status, verdict.risk), (AiStatus::Verified, Severity::Critical), "only a verified answer may make it critical");
    assert!(explanation.starts_with("AI verified (Intel TCB: OutOfDate). The transfer pays a1ice.testnet"), "{explanation}");
    let records = store.records.borrow();
    assert_eq!(records[0].0, kaap_sealed::attest::evidence::key_for(&kaap_core::verdict_hash(&verdict)));
    let record: Value = serde_json::from_slice(&records[0].1).unwrap();
    assert_eq!((record["ai_status"].as_str(), record["verdict_hash"].as_str()), (Some("verified"), Some(hex::encode(kaap_core::verdict_hash(&verdict)).as_str())));

    let refusing = Store { refuse: true, ..Store::default() };
    let (outcome, evidence) = run(&mut World::new(), &trust());
    let (verdict, explanation) = kaap_sealed::job::seal_and_publish(&parts, outcome, evidence, &mut refusing.clone()).unwrap();
    assert_eq!((verdict.ai_status, verdict.risk), (AiStatus::Unverified, Severity::High));
    assert!(explanation.starts_with("AI unverified (the evidence could not be published). "), "{explanation}");
}
