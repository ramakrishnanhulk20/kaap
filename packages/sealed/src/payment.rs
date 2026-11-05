//! The price of a check. Kaap's own worker runs free; every other run pays, on whichever of
//! OutLayer's two doors it came through. Every fact here comes from a variable OutLayer sets, which
//! neither the input nor a caller's secret can fill (worker `SYSTEM_ENV_VARS`).
//!
//! OutLayer prices only the projects it curates, so this is the one place an underpayment can be
//! refused, and by then the amount has already been taken.

use kaap_core::Network;

/// One cent. OutLayer counts millionths of a dollar. Changing it is a new published version.
pub const PRICE_MICRO_USD: u64 = 10_000;

const TESTNET_RECORD: &[u8] = include_bytes!("../testnet.json");

/// Where the string value of the first `"account"` member starts and ends. A compile error when
/// the file names none, so a build can never ship without its free caller's name.
const fn account_span(json: &[u8]) -> (usize, usize) {
    let key = b"\"account\"";
    let mut at = 0;
    while at + key.len() < json.len() {
        let mut same = 0;
        while same < key.len() && json[at + same] == key[same] {
            same += 1;
        }
        if same == key.len() {
            let mut start = at + key.len();
            while json[start] != b'"' {
                start += 1;
            }
            let mut end = start + 1;
            while json[end] != b'"' {
                end += 1;
            }
            return (start + 1, end);
        }
        at += 1;
    }
    panic!("testnet.json names no account");
}

const fn copied<const N: usize>(from: &[u8], start: usize) -> [u8; N] {
    let mut out = [0; N];
    let mut i = 0;
    while i < N {
        out[i] = from[start + i];
        i += 1;
    }
    out
}

const ACCOUNT_SPAN: (usize, usize) = account_span(TESTNET_RECORD);

// Copied out on purpose. A slice of the record would keep the whole file in the wasm, and the file
// gains a line on every publish, so no published hash could be rebuilt from the commit recording it.
const WORKER_BYTES: [u8; ACCOUNT_SPAN.1 - ACCOUNT_SPAN.0] = copied(TESTNET_RECORD, ACCOUNT_SPAN.0);

/// Kaap's worker on testnet, the account `testnet.json` names and `kaap verify` checks as the caller.
pub const TESTNET_WORKER: &str = match core::str::from_utf8(&WORKER_BYTES) {
    Ok(account) => account,
    Err(_) => panic!("the account in testnet.json is not text"),
};

/// The account whose chain runs are Kaap's own on `network`. `None` where Kaap has no worker yet,
/// which leaves that network with no free caller: every run there pays.
pub fn worker_account(network: Network) -> Option<&'static str> {
    match network {
        Network::Testnet => Some(TESTNET_WORKER),
        Network::Mainnet | Network::Sandbox => None,
    }
}

/// What OutLayer set for this run about who pays, read in `main()` and never from the input.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PayEnv {
    /// `OUTLAYER_EXECUTION_TYPE`: `HTTPS`, or `NEAR` on chain.
    pub execution_type: Option<String>,
    /// `USD_PAYMENT`: the `X-Attached-Deposit` of an HTTPS call. Always "0" on chain.
    pub usd_payment: Option<String>,
    /// `ATTACHED_USD`: the `attached_usd` of a chain run. Always "0" over HTTPS.
    pub attached_usd: Option<String>,
    /// `NEAR_USER_ACCOUNT_ID`: the transaction's signer on chain, the payment key's owner over
    /// HTTPS, and the account the run's keys are bound to. Not `NEAR_SENDER_ID`, which an Agent
    /// Connect binding rewrites to the name the guest acts as (worker `merge_env_vars`).
    pub sender: Option<String>,
}

/// Who a run that passed the gate belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Payer {
    /// Kaap's own worker on chain: free, and signed with the key the guard accepts.
    Kaap,
    /// Anyone else, at the price or above: signed with the payer's own derived key, so the guard
    /// refuses the verdict, and no public evidence is written.
    Paid,
}

/// Why a run was refused before it read anything.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// `paid` is 0 when the amount was missing or was not a plain decimal integer.
    PaymentBelowPrice { paid: u64, price: u64 },
}

impl Refusal {
    pub fn reason(self) -> &'static str {
        match self {
            Refusal::PaymentBelowPrice { .. } => "payment_below_price",
        }
    }

    /// Built from two numbers, so nothing from the run's environment reaches the output as text.
    pub fn sentence(self) -> String {
        match self {
            Refusal::PaymentBelowPrice { paid, price } => {
                format!("A check costs {price} millionths of a dollar. This run carried {paid}. An underpayment is not refunded.")
            }
        }
    }
}

/// A plain decimal integer, or nothing. `str::parse` alone would also take a leading `+`. A number
/// too long for u128 is still a number above the price, so it saturates instead of failing.
fn micro_usd(text: &str) -> Option<u128> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(text.parse().unwrap_or(u128::MAX))
}

/// Settles who pays for this run.
///
/// An `HTTPS` run pays with `usd_payment`, whoever owns the key. Any other run whose sender is
/// exactly `worker` is `Payer::Kaap`. Any other run pays with `attached_usd`. `worker` is empty on
/// a network with no worker yet, and an empty sender does not match it.
///
/// Refuses an amount that is missing, empty, not a plain decimal integer, or below
/// `PRICE_MICRO_USD`. More than the price is accepted, because no change can be given over HTTPS.
pub fn gate(env: &PayEnv, worker: &str) -> Result<Payer, Refusal> {
    let https = env.execution_type.as_deref() == Some("HTTPS");
    if !https && !worker.is_empty() && env.sender.as_deref() == Some(worker) {
        return Ok(Payer::Kaap);
    }
    let amount = if https { &env.usd_payment } else { &env.attached_usd };
    let paid = amount.as_deref().and_then(micro_usd).unwrap_or(0);
    match u64::try_from(paid) {
        Ok(paid) if paid < PRICE_MICRO_USD => Err(Refusal::PaymentBelowPrice { paid, price: PRICE_MICRO_USD }),
        _ => Ok(Payer::Paid),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORKER: &str = "worker.kaap.testnet";

    fn https(amount: Option<&str>) -> PayEnv {
        PayEnv { execution_type: Some("HTTPS".into()), usd_payment: amount.map(Into::into), attached_usd: Some("0".into()), sender: Some("payer.testnet".into()) }
    }

    fn chain(sender: Option<&str>, amount: Option<&str>) -> PayEnv {
        PayEnv { execution_type: Some("NEAR".into()), usd_payment: Some("0".into()), attached_usd: amount.map(Into::into), sender: sender.map(Into::into) }
    }

    fn below(paid: u64) -> Result<Payer, Refusal> {
        Err(Refusal::PaymentBelowPrice { paid, price: PRICE_MICRO_USD })
    }

    #[test]
    fn a_payment_passes_exactly_from_the_price_up_on_both_doors() {
        for paid in 0..=2 * PRICE_MICRO_USD {
            let text = paid.to_string();
            let want = if paid < PRICE_MICRO_USD { below(paid) } else { Ok(Payer::Paid) };
            assert_eq!(gate(&https(Some(&text)), WORKER), want);
            assert_eq!(gate(&chain(Some("payer.testnet"), Some(&text)), WORKER), want);
        }
    }

    #[test]
    fn anything_but_a_plain_decimal_integer_counts_as_nothing_paid() {
        for text in ["", " ", "abc", "+10000", "-10000", " 10000", "10000 ", "1e4", "10000.0", "0x2710", "1_0000", "10,000", "\u{0661}\u{0660}\u{0660}\u{0660}\u{0660}"] {
            assert_eq!(gate(&https(Some(text)), WORKER), below(0), "{text:?}");
            assert_eq!(gate(&chain(Some("payer.testnet"), Some(text)), WORKER), below(0), "{text:?}");
        }
        assert_eq!(gate(&https(None), WORKER), below(0));
        assert_eq!(gate(&chain(Some("payer.testnet"), None), WORKER), below(0));
    }

    #[test]
    fn an_amount_too_long_for_a_number_is_still_above_the_price() {
        for text in ["18446744073709551616", "340282366920938463463374607431768211456", &"9".repeat(400)] {
            assert_eq!(gate(&https(Some(text)), WORKER), Ok(Payer::Paid), "{text}");
        }
        let padded = |amount: &str| format!("{}{amount}", "0".repeat(60));
        assert_eq!(gate(&https(Some(&padded("10000"))), WORKER), Ok(Payer::Paid));
        assert_eq!(gate(&https(Some(&padded("9999"))), WORKER), below(9999));
    }

    #[test]
    fn each_door_reads_only_its_own_amount() {
        let wrong_door = PayEnv { attached_usd: Some("10000".into()), ..https(Some("0")) };
        assert_eq!(gate(&wrong_door, WORKER), below(0));
        let wrong_door = PayEnv { usd_payment: Some("10000".into()), ..chain(Some("payer.testnet"), Some("0")) };
        assert_eq!(gate(&wrong_door, WORKER), below(0));
    }

    #[test]
    fn the_worker_is_free_only_on_chain() {
        for amount in [Some("0"), None] {
            assert_eq!(gate(&chain(Some(WORKER), amount), WORKER), Ok(Payer::Kaap));
        }
        let over_https = PayEnv { sender: Some(WORKER.into()), ..https(Some("0")) };
        assert_eq!(gate(&over_https, WORKER), below(0));
        let paying = PayEnv { sender: Some(WORKER.into()), ..https(Some("10000")) };
        assert_eq!(gate(&paying, WORKER), Ok(Payer::Paid));
    }

    #[test]
    fn only_the_exact_account_is_the_worker() {
        for sender in [None, Some(""), Some("WORKER.kaap.testnet"), Some(" worker.kaap.testnet"), Some("worker.kaap.testnet "), Some("a.worker.kaap.testnet"), Some("worker.kaap.testnet.evil.testnet"), Some("worker.kaap")] {
            assert_eq!(gate(&chain(sender, Some("0")), WORKER), below(0), "{sender:?}");
        }
    }

    #[test]
    fn a_network_with_no_worker_has_no_free_caller() {
        assert_eq!(worker_account(Network::Mainnet), None);
        assert_eq!(worker_account(Network::Sandbox), None);
        for sender in [None, Some(""), Some(TESTNET_WORKER)] {
            assert_eq!(gate(&chain(sender, Some("0")), ""), below(0), "{sender:?}");
            assert_eq!(gate(&chain(sender, Some("10000")), ""), Ok(Payer::Paid), "{sender:?}");
        }
    }

    #[test]
    fn only_the_exact_type_is_the_https_door() {
        for kind in [None, Some("NEAR"), Some("https"), Some("HTTPS "), Some("")] {
            let run = |sender: &str, attached: &str| PayEnv { execution_type: kind.map(Into::into), usd_payment: Some("10000".into()), attached_usd: Some(attached.into()), sender: Some(sender.into()) };
            assert_eq!(gate(&run(WORKER, "0"), WORKER), Ok(Payer::Kaap), "{kind:?}");
            assert_eq!(gate(&run("payer.testnet", "0"), WORKER), below(0), "{kind:?}");
            assert_eq!(gate(&run("payer.testnet", "10000"), WORKER), Ok(Payer::Paid), "{kind:?}");
        }
    }

    #[test]
    fn the_compiled_worker_is_the_account_testnet_json_names() {
        let record: serde_json::Value = serde_json::from_slice(TESTNET_RECORD).unwrap();
        assert_eq!(record["account"], TESTNET_WORKER);
        assert_eq!(worker_account(Network::Testnet), Some(TESTNET_WORKER));
        near_account_id::AccountIdRef::new(TESTNET_WORKER).unwrap();
        assert_eq!(record["project_id"].as_str().unwrap().split('/').next(), Some(TESTNET_WORKER), "the project owner");
    }

    #[test]
    fn a_refusal_names_the_price_and_the_amount_received() {
        let why = Refusal::PaymentBelowPrice { paid: 9999, price: PRICE_MICRO_USD };
        assert_eq!(why.reason(), "payment_below_price");
        assert_eq!(why.sentence(), "A check costs 10000 millionths of a dollar. This run carried 9999. An underpayment is not refunded.");
    }
}
