// Claim extraction (`describe::extract`) on descriptions taken from named answer-key records.
// It checks what is read from the text only, never the comparison with effects, which
// describe_golden.rs and describe_eval.rs cover. It does not cover every wording the lists
// recognise, only one record per claim type.

use kaap_core::describe::{extract, Phrase, Verb};

const USDC: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

#[test]
fn amounts_with_a_known_ticker_in_base_units() {
    // planted:41, multiagency #31, burrow #1528, open-web-academy #789, planted:42.
    let c = extract("Transfer 1 NEAR to vendor.sandbox for the monthly subscription.");
    assert_eq!(c.amounts.len(), 1);
    assert_eq!((c.amounts[0].token.as_str(), c.amounts[0].amount.as_str()), ("near", "1000000000000000000000000"));
    let c = extract("Reviewed and accepted by Sky\n120 NEAR");
    assert_eq!(c.amounts[0].amount, "120000000000000000000000000");
    assert_eq!(extract("wrap 555 near to wnear as a test").amounts[0].amount, "555000000000000000000000000");
    let c = extract("Pago restante (53 usdt) primera semana enero");
    assert_eq!((c.amounts[0].token.as_str(), c.amounts[0].amount.as_str()), ("usdt.tether-token.near", "53000000"));
    assert_eq!(extract("Send 5 USDC reimbursement to the contributor.").amounts[0].token, USDC);
}

#[test]
fn numbers_that_are_not_amounts() {
    // burrow #1482 "83K usdt", hot-dao #176 "68380.90831261 GNK", a thousands separator, a version.
    assert!(extract("Transfer 83K usdt for liquidity management").amounts.is_empty());
    assert!(extract("all omni tokens of hot-dao (13 tokens: 68380.90831261 GNK)").amounts.is_empty());
    assert!(extract("Pay 1,000 NEAR to the team").amounts.is_empty());
    assert!(extract("Upgrade to v1.5 NEAR edition").amounts.is_empty());
    assert!(extract("Transfer 10 LiNEAR").amounts.is_empty());
}

#[test]
fn fullwidth_reads_as_ascii_and_invisible_characters_are_dropped() {
    let c = extract("Transfer \u{FF11} \u{FF2E}\u{FF25}\u{FF21}\u{FF32} to bob.near");
    assert_eq!(c.amounts[0].amount, "1000000000000000000000000");
    let c = extract("Transfer 1\u{200B}0 NEAR to bob.near");
    assert_eq!(c.amounts[0].amount, "10000000000000000000000000");
}

#[test]
fn a_bidirectional_control_makes_the_whole_text_unreadable() {
    let c = extract("Transfer 1 NEAR to \u{202E}raen.bob");
    assert!(!c.readable);
    assert!(c.amounts.is_empty() && c.recipients.is_empty() && c.verbs.is_empty());
}

#[test]
fn tickers_alone_and_not_inside_a_contract_id() {
    // planted:22 and burrow #1657 (USDC.e is a different token).
    assert_eq!(extract("USDC payout of 2500 to the auditor.").tokens, vec![USDC.to_string()]);
    assert!(extract("Withdraw 150K usdc.e from the market").tokens.is_empty());
    assert!(extract("Pay 10 to usdc.fakemint.near").tokens.is_empty());
}

#[test]
fn recipients_after_to() {
    // planted:17, planted:18, sudostake-dao #1 ("to recipient" names no account).
    assert_eq!(extract("Monthly salary payment to alice.sandbox.").recipients, ["alice.sandbox"]);
    assert_eq!(extract("Refund 200 NEAR to the treasurer bob.sandbox.").recipients, ["bob.sandbox"]);
    assert!(extract("Transfer 1 NEAR from sudostake-dao.sputnik-dao.near to recipient").recipients.is_empty());
    assert!(extract("Upgrade Sputnik-DAO Contract to 3.2 release").recipients.is_empty());
}

#[test]
fn accounts_must_be_valid_and_named_or_implicit() {
    let c = extract("Add 0sb973bee6080e83ad166079535ab0c1fcbf67fe18 to \"Requestor\", not Alice.near or e.g. 2.5");
    assert_eq!(c.accounts, ["0sb973bee6080e83ad166079535ab0c1fcbf67fe18"]);
}

#[test]
fn hashes_skip_a_bulk_payload_list() {
    // routr #4 (base58 code hash), sdasd #12 ("Payload Hashes" list, ruling 12).
    let c = extract("routr: apply upgrade 81SqTvHwPzwQ4EpWzF2D4igGjVbu8zXS3RgDrkTWAsB5 (staged)");
    assert_eq!(c.hashes.len(), 1);
    let c = extract(
        "* Proposal Action: confidential <br>* Payload Hashes: 734077ae14b9e93ef506e0cca38070a8d0adaec83af79ffc1c50b7e3b47de417 <br>* Notes: Confidential proposal. Details are hidden for privacy.",
    );
    assert!(c.hashes.is_empty());
    assert!(c.hidden);
}

#[test]
fn a_sputnik_release_label() {
    // deer #0 and #4, burrow #1686 (not Sputnik).
    assert_eq!(extract("Upgrade Sputnik-DAO Contract to 3.2 release").release.as_deref(), Some("3.2"));
    assert_eq!(extract("Upgrade Sputnik-DAO Contract to 3.2 release two").release.as_deref(), Some("3.2"));
    assert_eq!(extract("Upgrade burrowland to version 0.16.1").release, None);
}

#[test]
fn leading_verbs_not_nouns() {
    // n1-staking #120, planted:37, bob #3 ("for transferring tokens" is not a leading verb).
    assert_eq!(extract("* Proposal Action: unstake").verbs, [Verb::Unstake]);
    assert!(extract("Scheduled maintenance upgrade, no behaviour change.").verbs.is_empty());
    assert!(!extract("* Notes: Must be executed before noon for transferring tokens to 1Click's deposit address").verbs.contains(&Verb::Pay));
    assert_eq!(extract("PRODUCTION: Upgrade voting contract to `1.0.2`").verbs, [Verb::Upgrade]);
}

#[test]
fn ruling_26_phrases() {
    let has = |text: &str, p: Phrase| extract(text).phrases.contains(&p);
    assert!(has("Payroll run for October: 500 USDC to the contributor pool.", Phrase::Payment));
    assert!(has("Reimburse conference travel for the operations team.", Phrase::Payment));
    assert!(has("Read-only status check on the integration contract.", Phrase::NoValue));
    assert!(has("Claim staking rewards, gas only.", Phrase::NoValue));
    assert!(has("Rebalance the treasury across pools.", Phrase::Rebalance));
    assert!(has("Register storage on Intents for the treasury.", Phrase::Storage));
    assert!(has("Routine key rotation for the treasury wallet.", Phrase::Rotation));
    assert!(has("Clean up inactive signer accounts.", Phrase::Cleanup));
    assert!(!has("Enable confidential payments for the DAO.", Phrase::Payment));
}

#[test]
fn policy_claims_from_the_treasury_app_and_free_text() {
    // techbros #4, defuse-labs #6 shape, sweat-multisig #0, chicago #2, ref-labs #231.
    let c = extract("* Summary:  requested to:\n- add \"frol.near\" to [\"Requestor\", \"Approver\", \"Admin\"]\n- add \"as.near\" to [\"Admin\"]");
    assert_eq!(c.policy.adds.len(), 2);
    assert_eq!(c.policy.adds[0].roles, ["Requestor", "Approver", "Admin"]);
    assert!(c.policy.adds[0].exact);
    let c = extract("* Summary: - edit \"f7e23b5d988c35bd9a598671dcdb231e9763b47ac5105eb5d0c9e1427040d6c6\": added to [\"Requestor\", \"Approver\"]");
    assert_eq!(c.policy.adds[0].roles, ["Requestor", "Approver"]);
    let c = extract("Add alice.near to \"governance_proposers\"");
    assert_eq!((c.policy.adds[0].member.as_str(), c.policy.adds[0].exact), ("alice.near", true));
    let c = extract("Add work.efiz.near to the treasury (Admin)");
    assert_eq!((c.policy.adds[0].member.as_str(), c.policy.adds[0].exact), ("work.efiz.near", false));
    assert_eq!(extract("remove inactive member: sunhao.near").policy.removes[0].member, "sunhao.near");
}

#[test]
fn rosters_and_thresholds() {
    // nearlytrade #12, testyonder #6, sodax #12.
    let c = extract("council: protocolfee.near, protocolfee2.near, haenko.near, rhymetaylor.near (NEAR Legion signers in, nearlyops.near and nearlyburn.near out), still 3 of 4");
    assert_eq!(c.policy.rosters.len(), 1);
    assert_eq!(c.policy.rosters[0].role, "council");
    assert_eq!(c.policy.rosters[0].members.len(), 4);
    assert_eq!(c.policy.rosters[0].out, ["nearlyops.near", "nearlyburn.near"]);
    let c = extract("* Title: Update policy - Voting Thresholds <br>* Summary: x.near requested to change voting threshold from 1 to 2.");
    assert_eq!(c.policy.threshold.as_deref(), Some("2"));
    assert_eq!(extract("change threshold to 49%").policy.threshold.as_deref(), Some("49%"));
}
