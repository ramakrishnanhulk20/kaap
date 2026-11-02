// Pins `receipt::receivers_hash` and `receipt::DECODER_VERSION` to what the sealed job writes into
// a verdict today (packages/sealed/src/reads.rs lines 191 to 219, verdict.rs line 18). The pinned
// list is the one the sealed job read for proposal 1 of corm1gu.sputnikv2.testnet at block
// 275253925 (its transfer-ft.json fixture): the DAO and the token it calls, with their code hashes.
// The expected hash was printed by `kaap_sealed::reads::receivers_hash` on that sorted list, the
// value packages/sealed/tests/job.rs checks the verdict carries. It does NOT cover reading the code
// hashes from chain, or which accounts a kind calls (`kaap_sealed::reads::called_accounts`).

use kaap_core::hash::sign::to_hex;
use kaap_core::receipt::{receivers_hash, DECODER_VERSION};

fn pairs() -> Vec<(String, String)> {
    [
        ("corm1gu.sputnikv2.testnet", "AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH"),
        ("nori4qx.tanssg2.testnet", "12AiGxHGtiSBJenkwsqqrV5Z1XJB1GhWkJRivrQB3m6Y"),
    ]
    .iter()
    .map(|(account, code)| (account.to_string(), code.to_string()))
    .collect()
}

#[test]
fn receivers_hash_equals_the_sealed_jobs_on_the_pinned_list() {
    assert_eq!(to_hex(&receivers_hash(&pairs())), "3e45bc50874d22357a5da82e3a5721c951a8d36dd0b8f16d0f6946978c9ccefb");
}

#[test]
fn the_order_the_pairs_arrive_in_does_not_change_the_hash() {
    let mut reversed = pairs();
    reversed.reverse();
    assert_eq!(receivers_hash(&reversed), receivers_hash(&pairs()));
    let mut other_code = pairs();
    other_code[1].1 = "11111111111111111111111111111111".into();
    assert_ne!(receivers_hash(&other_code), receivers_hash(&pairs()), "a changed code hash changes the hash");
}

#[test]
fn the_decoder_version_is_the_one_the_sealed_job_writes() {
    assert_eq!(DECODER_VERSION, "0.1.0");
}
