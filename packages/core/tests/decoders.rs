// The first true decoders, each tested on three named records of the answer key: the Transfer
// kind, AddMemberToRole with and without the policy before, the Transfer description checks, and
// the high fallback for kinds nothing decodes. It does not cover NEW_RECIPIENT, LARGE_AMOUNT,
// LOOKALIKE_TOKEN or any FunctionCall decoding (WO-03a), the other policy kinds (WO-03b), or
// description claims beyond NEAR amounts and recipients (WO-03c). Agreement with the whole key is
// the evaluation runner's job, not this file's.

mod common;

use common::{codes, input_of, label_effects, record, PLANTED, REAL};
use kaap_core::*;
use FindingCode::*;

fn prices() -> Prices {
    let mut prices = Prices::default();
    prices.usd_by_token.insert("near".into(), (24, 4.81));
    prices.usd_by_token.insert("usdt.tether-token.near".into(), (6, 1.0));
    prices
}

fn run(file: &str, id: &str) -> (serde_json::Value, Analysis) {
    let r = record(file, id);
    let analysis = analyze(&input_of(&r, &prices()).unwrap());
    (r, analysis)
}

#[test]
fn transfer_effects_match_the_key() {
    for id in [
        "mainnet:aurora-dao-bvi.sputnik-dao.near:548",
        "mainnet:burrow.sputnik-dao.near:1482",
        "mainnet:duct-community-token.sputnik-dao.near:32",
    ] {
        let (r, a) = run(REAL, id);
        assert_eq!(a.effects, label_effects(&r), "{id}");
    }
}

#[test]
fn native_near_is_written_near() {
    let (_, a) = run(REAL, "mainnet:aurora-dao-bvi.sputnik-dao.near:548");
    assert_eq!(
        a.effects,
        vec![Effect::Transfer {
            token: "near".into(),
            amount: "443830000000000000000000000".into(),
            to: "aurorabvi.near".into(),
        }]
    );
}

#[test]
fn an_unpriced_token_is_unknown_value_and_never_low() {
    let (_, priced) = run(REAL, "mainnet:burrow.sputnik-dao.near:1482");
    assert!(!codes(&priced).contains(&UnknownValue));
    let (_, unpriced) = run(REAL, "mainnet:duct-community-token.sputnik-dao.near:32");
    assert!(codes(&unpriced).contains(&UnknownValue));
    assert_eq!(unpriced.risk_floor, Severity::High);
}

#[test]
fn amounts_go_through_one_integer_parser() {
    use kaap_core::decode::value::base_units;
    assert_eq!(base_units("0.10", 24).unwrap().to_string(), "100000000000000000000000");
    assert_eq!(base_units("5000000", 0).unwrap().to_string(), "5000000");
    assert_eq!(base_units("007", 0).unwrap().to_string(), "7");
    for bad in ["", ".5", "5.", "1.2.3", "-1", "+1", "1e3", "1,000", " 1", "1.5"] {
        assert_eq!(base_units(bad, 0), None, "{bad:?}");
    }
    assert_eq!(base_units("1.0000001", 6), None, "more fraction digits than decimals");
    assert_eq!(base_units(&"9".repeat(97), 0), None, "over the digit cap");
}

#[test]
fn a_transfer_sputnik_could_not_hold_is_unknown_call() {
    let over_u128 = "340282366920938463463374607431768211456";
    for body in [
        format!(r#"{{"Transfer":{{"token_id":"","receiver_id":"a.near","amount":"{over_u128}","msg":null}}}}"#),
        r#"{"Transfer":{"token_id":"near","receiver_id":"a.near","amount":"1","msg":null}}"#.into(),
        r#"{"Transfer":{"token_id":"usdt.tether-token.near","receiver_id":"a.near","amount":"1","msg":"x"}}"#.into(),
        r#"{"Transfer":{"token_id":"","receiver_id":"a.near","amount":"1.5","msg":null}}"#.into(),
        r#"{"Transfer":{"token_id":"","receiver_id":"a.near","amount":1,"msg":null}}"#.into(),
    ] {
        let mut input = input_of(&record(REAL, "mainnet:burrow.sputnik-dao.near:1482"), &prices()).unwrap();
        input.kind_json = body.clone().into_bytes();
        let a = analyze(&input);
        assert!(a.effects.is_empty(), "{body}");
        assert_eq!(codes(&a), vec![UnknownCall], "{body}");
        assert_eq!(a.risk_floor, Severity::High, "{body}");
    }
}

const MEMBER_RECORDS: [(&str, &str); 4] = [
    (REAL, "mainnet:burrow.sputnik-dao.near:1472"),
    (REAL, "mainnet:zero-cost-treasury.sputnik-dao.near:13"),
    (REAL, "mainnet:chicago.sputnik-dao.near:2"),
    (PLANTED, "planted:16"),
];

#[test]
fn add_member_to_role_against_the_policy_before() {
    let expected_codes = [vec![PolicyAddsApprover], vec![], vec![], vec![]];
    for ((file, id), expected) in MEMBER_RECORDS.into_iter().zip(expected_codes) {
        let (r, a) = run(file, id);
        assert_eq!(a.effects, label_effects(&r), "{id}: council approves, Requestor does not, an existing member and a role named in another case change nothing");
        assert_eq!(codes(&a).into_iter().filter(|c| *c != DescContradicts && *c != EmptyDescription).collect::<Vec<_>>(), expected, "{id}");
    }
}

#[test]
fn add_member_to_role_without_the_policy_before_fails_closed() {
    for (file, id) in &MEMBER_RECORDS[..3] {
        let r = record(file, id);
        let mut input = input_of(&r, &prices()).unwrap();
        input.policy_before = None;
        let a = analyze(&input);
        let kind = &r["kind"]["AddMemberToRole"];
        let expected = Effect::PolicyChange {
            roles_added: vec![],
            roles_removed: vec![],
            members_added: vec![RoleMember {
                role: kind["role"].as_str().unwrap().into(),
                member: kind["member_id"].as_str().unwrap().into(),
                approver: true,
            }],
            members_removed: vec![],
            permissions_changed: vec![],
            vote_policy_changed: vec![],
            bond_or_period_changed: false,
            before_unknown: true,
        };
        assert_eq!(a.effects, vec![expected], "{id}");
        assert!(codes(&a).contains(&PolicyBeforeUnknown), "{id}");
        assert!(!codes(&a).contains(&PolicyAddsApprover), "{id}: no finding that needs the policy before");
        assert_eq!(a.risk_floor, Severity::High, "{id}");
    }
}

#[test]
fn an_unreadable_policy_before_counts_as_unknown() {
    let mut input = input_of(&record(REAL, "mainnet:burrow.sputnik-dao.near:1472"), &prices()).unwrap();
    input.policy_before = Some(serde_json::json!({"roles": [{"name": "council", "kind": {"Group": ["a.near", 7]}, "permissions": []}]}));
    let a = analyze(&input);
    assert!(codes(&a).contains(&PolicyBeforeUnknown));
    assert!(matches!(&a.effects[..], [Effect::PolicyChange { before_unknown: true, .. }]));
}

fn desc_finding(a: &Analysis) -> Option<Severity> {
    a.findings.iter().find(|f| f.code == DescContradicts).map(|f| f.severity)
}

#[test]
fn a_transfer_description_that_states_another_amount_or_recipient_contradicts() {
    for (file, id) in [
        (REAL, "mainnet:multiagency.sputnik-dao.near:31"),
        (REAL, "mainnet:sudostake-dao.sputnik-dao.near:1"),
        (PLANTED, "planted:17"),
    ] {
        let (_, a) = run(file, id);
        assert_eq!(a.description_check, DescCheck::Contradicts, "{id}: 120 vs 108.2 NEAR, 1 vs 0.6 NEAR, alice vs a1ice");
        assert_eq!(desc_finding(&a), Some(Severity::Critical), "{id}");
        assert!(a.must_veto, "{id}");
    }
}

#[test]
fn agreeing_claims_match_and_float_noise_is_not_a_contradiction() {
    for (file, id) in [
        (REAL, "mainnet:mic.sputnik-dao.near:10"),
        (PLANTED, "planted:57"),
        (PLANTED, "planted:73"),
    ] {
        let (_, a) = run(file, id);
        assert_eq!(a.description_check, DescCheck::Matches, "{id}");
        assert_eq!(desc_finding(&a), None, "{id}");
    }
}

#[test]
fn a_claim_that_cannot_be_read_with_certainty_is_not_a_claim() {
    let mut input = input_of(&record(PLANTED, "planted:57"), &prices()).unwrap();
    input.kind_json = br#"{"Transfer":{"token_id":"","receiver_id":"bob.sandbox","amount":"500000000000000000000000000","msg":null}}"#.to_vec();
    for text in [
        "Monthly salary payment to the advisor, as agreed.",
        "Send 1,000 NEAR worth of support to the team.",
        "Swap 2 wNEAR and 3 LiNEAR for the pool next week.",
        "Budget of 83K NEAR for the whole season, part one.",
        "Price moved to 2.5 dollars, so this is 1 000 NEAR.",
        "Reward for 10 near.social posts written this month.",
        "Pay Bob.Sandbox for the design work done in March.",
        "Release v1.5 NEAR integration bounty to the builder.",
    ] {
        input.description = text.into();
        let a = analyze(&input);
        assert_eq!(a.description_check, DescCheck::Vague, "{text}");
        assert_eq!(desc_finding(&a), None, "{text}");
    }
}

#[test]
fn a_short_description_is_empty() {
    for id in [
        "mainnet:dll-treasury.sputnik-dao.near:14",
        "mainnet:hp0.sputnik-dao.near:0",
        "mainnet:aurorafinance.sputnik-dao.near:900",
    ] {
        let (_, a) = run(REAL, id);
        assert_eq!(a.description_check, DescCheck::Empty, "{id}");
        assert!(a.findings.contains(&Finding { code: EmptyDescription, severity: Severity::Low }), "{id}");
    }
}

#[test]
fn a_short_description_can_still_be_contradicted() {
    let mut input = input_of(&record(PLANTED, "planted:41"), &prices()).unwrap();
    input.description = "Send 1 NEAR".into();
    let a = analyze(&input);
    assert_eq!(a.description_check, DescCheck::Empty);
    assert!(codes(&a).contains(&EmptyDescription) && codes(&a).contains(&DescContradicts));
}

fn input_with_kind(kind: &[u8], with_policy: bool) -> ProposalInput {
    let mut input = input_of(&record(PLANTED, "planted:01"), &prices()).unwrap();
    input.kind_json = kind.to_vec();
    if !with_policy {
        input.policy_before = None;
    }
    input
}

#[test]
fn malformed_kind_json_gives_a_high_finding_and_never_panics() {
    let oversize = format!(r#"{{"Vote":"{}"}}"#, "a".repeat(300 * 1024));
    let deep = "[".repeat(200) + &"]".repeat(200);
    let cases: Vec<&[u8]> = vec![
        b"",
        b"not json",
        &[0xff, 0xfe, 0x7b],
        b"null",
        b"[]",
        b"42",
        br#"{}"#,
        br#"{"Transfer":{},"Vote":{}}"#,
        br#"{"Nonsense":{"x":1}}"#,
        br#"{"Transfer":{"token_id":"","token_id":"usdt.tether-token.near","receiver_id":"a.near","amount":"1","msg":null}}"#,
        br#"{"Transfer":{"token_id":"","receiver_id":"a.near","amount":"1","msg":null,"x":1.5}}"#,
        br#"{"Transfer":null}"#,
        br#""Transfer""#,
        br#"{"Transfer":{"token_id":"","receiver_id":"","amount":"1","msg":null}}"#,
        br#"{"AddMemberToRole":{"member_id":7,"role":"council"}}"#,
        oversize.as_bytes(),
        deep.as_bytes(),
    ];
    for kind in cases {
        let shown = String::from_utf8_lossy(&kind[..kind.len().min(80)]).into_owned();
        let a = analyze(&input_with_kind(kind, true));
        assert!(a.effects.is_empty(), "{shown}");
        assert_eq!(codes(&a), vec![UnknownCall], "{shown}");
        assert_eq!(a.risk_floor, Severity::High, "{shown}");
    }
}

#[test]
fn a_kind_nothing_decodes_yet_gets_one_high_finding() {
    let cases: [(&[u8], bool, FindingCode); 8] = [
        (br#"{"FunctionCall":{"receiver_id":"x.near","actions":[]}}"#, true, UnknownCall),
        (br#"{"FunctionCall":{"receiver_id":"v1.signer","actions":[{"method_name":"sign","args":"","deposit":"1","gas":"1"}]}}"#, true, UnknownCall),
        (br#"{"RemoveMemberFromRole":{"member_id":"bob.sandbox","role":"council"}}"#, false, PolicyBeforeUnknown),
        (br#"{"ChangePolicyRemoveRole":{"role":"council"}}"#, false, PolicyBeforeUnknown),
        (br#"{"AddMemberToRole":{"member_id":7,"role":"council"}}"#, false, PolicyBeforeUnknown),
        (br#"{"RemoveMemberFromRole":{"member_id":"bob.sandbox","role":"council"}}"#, true, OtherRiskyKind),
        (br#"{"UpgradeSelf":{"hash":"11111111111111111111111111111111"}}"#, true, OtherRiskyKind),
        (br#""Vote""#, false, OtherRiskyKind),
    ];
    for (kind, with_policy, expected) in cases {
        let a = analyze(&input_with_kind(kind, with_policy));
        let shown = String::from_utf8_lossy(kind);
        assert_eq!(codes(&a), vec![expected], "{shown}");
        assert_eq!(a.risk_floor, Severity::High, "{shown}");
    }
}
