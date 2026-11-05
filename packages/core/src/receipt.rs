//! What a verdict says beyond the proposal's own bytes: which decoder judged it, which contracts
//! executing it would run, and the code of each. Moved from the sealed job
//! (packages/sealed/src/verdict.rs line 18, and reads.rs lines 191 to 219), so the sealed job, the
//! CLI and the worker compute them from this one place and can check each other. The CLI's
//! `calledAccounts` is a TypeScript port of `called_accounts`, which a hash covering every account
//! by name keeps honest.

use std::collections::BTreeSet;

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::decode::account::is_account_id;
use crate::decode::value::read_kind;

/// kaap-core's version. kaap-core and kaap-sealed both take the workspace version, so this is the
/// same text the sealed job has written into every verdict so far.
pub const DECODER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// sha256 of the borsh encoding of the (account, code hash) pairs sorted by account, then by code
/// hash: the DAO and every contract the kind calls, each with the code hash `view_account` gave at
/// the verdict's block. Borsh writes each string with its length, so no two lists share an
/// encoding. The pairs are sorted here, so a caller holding them in another order still gets the
/// hash the verdict carries.
pub fn receivers_hash(pairs: &[(String, String)]) -> [u8; 32] {
    let mut sorted = pairs.to_vec();
    sorted.sort();
    let bytes = borsh::to_vec(&sorted).expect("a pair list is far below borsh's length limit");
    let mut out = [0u8; 32];
    out.copy_from_slice(&Sha256::digest(&bytes));
    out
}

/// The DAO itself, then every contract whose code runs when the kind executes, as Sputnik runs
/// it: the receiver of a FunctionCall or an UpgradeRemote, the token of a non-NEAR Transfer, and
/// the receiver of a Transfer with a `msg` (ft_transfer_call calls its ft_on_transfer). A native
/// NEAR Transfer runs no receiver code, so its receiver is not read, which also means a payment
/// to a new implicit account never holds the job. A kind the strict reader refuses adds nothing
/// here; `analyze` gives it a high finding. Each account appears once.
///
/// `None` when one of them is not a valid account id: no verdict can pin that account's code, and
/// each caller refuses in its own words.
pub fn called_accounts(dao: &str, kind_json: &[u8]) -> Option<Vec<String>> {
    let mut accounts = vec![dao.to_string()];
    if let Some((variant, body)) = read_kind(kind_json) {
        let field = |name: &str| body.get(name).and_then(Value::as_str);
        match variant.as_str() {
            "FunctionCall" | "UpgradeRemote" => accounts.extend(field("receiver_id").map(str::to_string)),
            "Transfer" => {
                if let Some(token) = field("token_id").filter(|t| !t.is_empty()) {
                    accounts.push(token.to_string());
                    if body.get("msg").is_some_and(Value::is_string) {
                        accounts.extend(field("receiver_id").map(str::to_string));
                    }
                }
            }
            _ => {}
        }
    }
    let mut seen = BTreeSet::new();
    accounts.retain(|a| seen.insert(a.clone()));
    accounts.iter().all(|a| is_account_id(a)).then_some(accounts)
}

#[cfg(test)]
mod tests {
    use super::called_accounts;

    #[test]
    fn called_accounts_follow_what_sputnik_executes() {
        let dao = "d.sputnikv2.testnet";
        let cases: [(&str, &[&str]); 7] = [
            (r#"{"Transfer":{"token_id":"","receiver_id":"new.testnet","amount":"1","msg":null}}"#, &[dao]),
            (r#"{"Transfer":{"token_id":"usdc.testnet","receiver_id":"a.testnet","amount":"1","msg":null}}"#, &[dao, "usdc.testnet"]),
            (r#"{"Transfer":{"token_id":"usdc.testnet","receiver_id":"a.testnet","amount":"1","msg":"x"}}"#, &[dao, "usdc.testnet", "a.testnet"]),
            (r#"{"FunctionCall":{"receiver_id":"app.testnet","actions":[]}}"#, &[dao, "app.testnet"]),
            (r#"{"UpgradeRemote":{"receiver_id":"app.testnet","method_name":"up","hash":"x"}}"#, &[dao, "app.testnet"]),
            (r#"{"FunctionCall":{"receiver_id":"d.sputnikv2.testnet","actions":[]}}"#, &[dao]),
            (r#""Vote""#, &[dao]),
        ];
        for (kind, want) in cases {
            assert_eq!(called_accounts(dao, kind.as_bytes()).unwrap(), want, "{kind}");
        }
    }

    #[test]
    fn an_invalid_account_id_gives_none() {
        let bad = r#"{"FunctionCall":{"receiver_id":"Not An Account","actions":[]}}"#;
        assert_eq!(called_accounts("d.sputnikv2.testnet", bad.as_bytes()), None);
        assert_eq!(called_accounts("Not A DAO", br#""Vote""#), None);
    }
}
