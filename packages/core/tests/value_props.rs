// Property test for C2 and standard 4 on 10,000 random FunctionCall kinds from a hand-rolled
// generator with a fixed seed (no new dependency): random receivers, methods, deposits and
// arguments (valid JSON, invalid JSON, empty, huge, duplicate keys, hostile `msg` strings and
// intents). Every kind must run without a panic, never come out low with an `unknown_call`
// effect, and mark every attached deposit above 1 yoctoNEAR as NEAR sent. It does not check that
// each effect is the right one (value_effects.rs), the findings' conditions (value_findings.rs),
// Transfer or policy kinds, or `v1.signer` `sign` actions, which `hash::check` owns.

use std::panic::{catch_unwind, AssertUnwindSafe};

use base64::Engine as _;
use kaap_core::*;
use serde_json::{json, Value};

const SEED: u64 = 0x4b41_4150_0003_0a01;
const KINDS: usize = 10_000;

/// splitmix64: small, fast and fully determined by the seed.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[self.below(items.len())]
    }

    fn one_in(&mut self, n: usize) -> bool {
        self.below(n) == 0
    }

    fn word(&mut self, alphabet: &[u8], len: usize) -> String {
        (0..len).map(|_| alphabet[self.below(alphabet.len())] as char).collect()
    }

    fn word_below(&mut self, alphabet: &[u8], max_len: usize) -> String {
        let len = self.below(max_len);
        self.word(alphabet, len)
    }
}

const RECEIVERS: [&str; 22] = [
    "wrap.near",
    "intents.near",
    "bulkpayment.near",
    "contract.main.burrow.near",
    "v2.ref-finance.near",
    "dclv2.ref-labs.near",
    "astro-stakers.poolv1.near",
    "figment.pool.near",
    "a.b.poolv1.near",
    "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a2",
    "usdt.tether-token.near",
    "usdc",
    "v1.signer",
    "v1.signer-prod.testnet",
    "near",
    "wrap.nearr",
    "omft.near",
    "sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    "v2_1.omni.hot.tg",
    "791396a1dacfb6e3ecb37f0648664d07c08980a9.lockup.near",
    "dao.sputnik-dao.near",
];

const METHODS: [&str; 28] = [
    "ft_transfer",
    "ft_transfer_call",
    "mt_transfer",
    "mt_transfer_call",
    "mt_batch_transfer",
    "ft_withdraw",
    "mt_withdraw",
    "add_public_key",
    "remove_public_key",
    "execute_intents",
    "near_deposit",
    "near_withdraw",
    "storage_deposit",
    "approve_list",
    "deposit",
    "deposit_and_stake",
    "stake",
    "stake_all",
    "unstake",
    "unstake_all",
    "withdraw",
    "withdraw_all",
    "execute",
    "update_asset",
    "sign",
    "upgrade",
    "get_status",
    "",
];

const LOWER: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
const HEX: &[u8] = b"0123456789abcdef";

fn account(rng: &mut Rng) -> String {
    match rng.below(4) {
        0 | 1 => rng.pick(&RECEIVERS).to_string(),
        2 => format!("x{}.near", rng.word_below(LOWER, 12)),
        _ => rng.word(HEX, 64),
    }
}

fn amount_text(rng: &mut Rng) -> String {
    match rng.below(10) {
        0 => "0".into(),
        1 => "1".into(),
        2 => u128::MAX.to_string(),
        3 => "340282366920938463463374607431768211456".into(),
        4 => rng.pick(&["-1", "1.5", "", "1e3", "+5", " 7", "abc", "007"]).into(),
        _ => ((u128::from(rng.next()) << 64 | u128::from(rng.next())) >> rng.below(128)).to_string(),
    }
}

/// A deposit, and whether Sputnik's `U128` could hold it.
fn deposit(rng: &mut Rng) -> (String, Option<u128>) {
    if rng.one_in(60) {
        let bad = rng.pick(&["340282366920938463463374607431768211456", "-1", "1.5", "", "1e3", "+5", "0x10"]);
        return (bad.into(), None);
    }
    let value = match rng.below(6) {
        0 => 0,
        1 => 1,
        2 => 2,
        3 => u128::MAX,
        _ => (u128::from(rng.next()) << 64 | u128::from(rng.next())) >> rng.below(128),
    };
    (value.to_string(), Some(value))
}

fn token_id(rng: &mut Rng) -> String {
    match rng.below(4) {
        0 => format!("nep141:{}", account(rng)),
        1 => format!("nep245:v2_1.omni.hot.tg:{}_{}", rng.pick(&["1117", "56", "8453", "x"]), rng.word(LOWER, 8)),
        2 => account(rng),
        _ => rng.word_below(LOWER, 6),
    }
}

fn intent(rng: &mut Rng) -> Value {
    let kind = rng.pick(&[
        "ft_withdraw",
        "mt_withdraw",
        "transfer",
        "add_public_key",
        "remove_public_key",
        "token_diff",
        "set_auth_by_predecessor_id",
        "auth_call",
        "",
    ]);
    let mut fields = json!({"intent": kind});
    for _ in 0..rng.below(6) {
        let (key, value) = field(rng, 1);
        fields[key] = value;
    }
    for key in ["tokens", "diff"] {
        if rng.one_in(4) {
            let token = token_id(rng);
            let change = if key == "diff" { rng.pick(&["5", "-5", "0", "x"]).to_string() } else { amount_text(rng) };
            let mut entry = serde_json::Map::new();
            entry.insert(token, json!(change));
            fields[key] = Value::Object(entry);
        }
    }
    fields
}

fn msg(rng: &mut Rng, depth: usize) -> String {
    match rng.below(10) {
        0 => String::new(),
        1 => account(rng),
        2 => rng.word(HEX, 64),
        3 if depth == 0 => json!({"intents": (0..rng.below(4)).map(|_| intent(rng)).collect::<Vec<_>>()}).to_string(),
        4 if depth == 0 => json!({"receiver_id": account(rng), "execute_intents": [intent(rng), {"standard": "nep413"}]}).to_string(),
        5 => json!({"receiver_id": account(rng)}).to_string(),
        6 => r#"{"receiver_id":"a.near","receiver_id":"b.near"}"#.into(),
        7 => r#""DepositToReserve""#.into(),
        _ => rng.word_below(b"{}[]\":,abc 0", 20),
    }
}

fn field(rng: &mut Rng, depth: usize) -> (&'static str, Value) {
    let key = rng.pick(&[
        "receiver_id", "amount", "msg", "memo", "token_id", "token", "token_ids", "amounts", "public_key",
        "list_id", "account_id", "signed", "registration_only", "chain",
    ]);
    let value = match key {
        "receiver_id" | "account_id" | "token" => json!(account(rng)),
        "amount" => json!(amount_text(rng)),
        "msg" => json!(msg(rng, depth)),
        "memo" => json!(format!("WITHDRAW_TO:{}", rng.word(LOWER, 10))),
        "token_id" => json!(token_id(rng)),
        "token_ids" => json!((0..rng.below(3)).map(|_| rng.word(LOWER, 5)).collect::<Vec<_>>()),
        "amounts" => json!((0..rng.below(3)).map(|_| amount_text(rng)).collect::<Vec<_>>()),
        "public_key" => json!(format!("ed25519:{}", rng.word(LOWER, 44))),
        "list_id" => json!(rng.word(HEX, 64)),
        "signed" if depth == 0 => json!((0..rng.below(3)).map(|_| intent(rng)).collect::<Vec<_>>()),
        "chain" => json!(rng.pick(&["near", "eth", "NEAR", ""])),
        _ => json!(rng.one_in(3)),
    };
    if rng.one_in(15) {
        return (key, json!(rng.next()));
    }
    (key, value)
}

/// Mostly an amount a `U128` can hold, sometimes any amount text.
fn holdable_amount(rng: &mut Rng) -> String {
    if rng.one_in(5) {
        amount_text(rng)
    } else {
        ((u128::from(rng.next()) << 64 | u128::from(rng.next())) >> rng.below(128)).to_string()
    }
}

/// Arguments shaped the way `method` expects, with random values, so the known-effect branches
/// are reached as often as the refusals.
fn well_formed(rng: &mut Rng, method: &str) -> Value {
    let to = |rng: &mut Rng| if rng.one_in(2) { rng.pick(&["intents.near", "bulkpayment.near"]).to_string() } else { account(rng) };
    match method {
        "ft_transfer" => json!({"receiver_id": account(rng), "amount": holdable_amount(rng)}),
        "ft_transfer_call" | "mt_transfer_call" => {
            json!({"receiver_id": to(rng), "token_id": token_id(rng), "amount": holdable_amount(rng), "msg": msg(rng, 0)})
        }
        "mt_transfer" => json!({"receiver_id": account(rng), "token_id": token_id(rng), "amount": holdable_amount(rng)}),
        "ft_withdraw" => {
            let token = account(rng);
            let receiver = if rng.one_in(2) { token.clone() } else { account(rng) };
            json!({"token": token, "receiver_id": receiver, "amount": holdable_amount(rng), "memo": format!("WITHDRAW_TO:{}", rng.word(LOWER, 9))})
        }
        "mt_withdraw" => json!({
            "token": "v2_1.omni.hot.tg",
            "receiver_id": "v2_1.omni.hot.tg",
            "token_ids": [format!("{}_{}", rng.pick(&["1117", "56", "999"]), rng.word(LOWER, 6))],
            "amounts": [holdable_amount(rng)],
            "memo": "WITHDRAW_TO:EQabc",
        }),
        "add_public_key" | "remove_public_key" => json!({"public_key": format!("ed25519:{}", rng.word(LOWER, 44))}),
        "execute_intents" => json!({"signed": (0..rng.below(3)).map(|_| intent(rng)).collect::<Vec<_>>()}),
        "near_withdraw" | "stake" | "unstake" | "withdraw" => json!({"amount": holdable_amount(rng)}),
        "storage_deposit" => if rng.one_in(2) { json!({"account_id": account(rng), "registration_only": true}) } else { json!({}) },
        "approve_list" => json!({"list_id": rng.word(HEX, 64)}),
        _ => json!({}),
    }
}

fn args(rng: &mut Rng, method: &str) -> Vec<u8> {
    if rng.one_in(2) {
        return well_formed(rng, method).to_string().into_bytes();
    }
    match rng.below(12) {
        0 => Vec::new(),
        1 => (0..1 + rng.below(32)).map(|_| rng.next() as u8).collect(),
        2 => format!(r#"{{"amount":"1","receiver_id":"{}","amount":"2"}}"#, account(rng)).into_bytes(),
        3 if rng.one_in(10) => json!({"receiver_id": account(rng), "pad": "x".repeat(60 * 1024)}).to_string().into_bytes(),
        3 => rng.pick(&["5", "[]", "\"x\"", "null", "{}", "[{\"a\":1}]"]).as_bytes().to_vec(),
        _ => {
            let mut fields = json!({});
            for _ in 0..rng.below(6) {
                let (key, value) = field(rng, 0);
                fields[key] = value;
            }
            fields.to_string().into_bytes()
        }
    }
}

struct Generated {
    kind: Vec<u8>,
    /// (receiver, deposit) for every action whose attached NEAR must show up as sent.
    marks: Vec<(String, u128)>,
    holdable: bool,
}

/// A method the receiver really has, so whole kinds of known effects are generated too.
fn fitting(rng: &mut Rng, receiver: &str) -> &'static str {
    match receiver {
        "wrap.near" => rng.pick(&["near_deposit", "near_withdraw", "ft_transfer", "ft_transfer_call", "storage_deposit"]),
        "intents.near" => rng.pick(&[
            "mt_transfer", "mt_transfer_call", "ft_withdraw", "mt_withdraw", "add_public_key", "remove_public_key",
            "execute_intents", "storage_deposit",
        ]),
        "astro-stakers.poolv1.near" | "figment.pool.near" => rng.pick(&[
            "deposit", "deposit_and_stake", "stake", "stake_all", "unstake", "unstake_all", "withdraw", "withdraw_all",
        ]),
        "bulkpayment.near" => "approve_list",
        "contract.main.burrow.near" | "v2.ref-finance.near" | "dclv2.ref-labs.near" => rng.pick(&["execute", "update_asset"]),
        "v1.signer" | "v1.signer-prod.testnet" => "sign",
        _ => rng.pick(&["ft_transfer", "ft_transfer_call", "storage_deposit"]),
    }
}

fn kind(rng: &mut Rng) -> Generated {
    let receiver = account(rng);
    let mut marks = Vec::new();
    let mut holdable = true;
    let actions: Vec<Value> = (0..1 + rng.below(4))
        .map(|_| {
            let method = match rng.below(8) {
                0 => rng.word_below(LOWER, 10),
                1..=4 => fitting(rng, &receiver).to_string(),
                _ => rng.pick(&METHODS).to_string(),
            };
            let (deposit, value) = deposit(rng);
            let signs = method == "sign" && receiver.starts_with("v1.signer");
            match value {
                Some(d) if d > 1 && !signs => marks.push((receiver.clone(), d)),
                Some(_) => {}
                None => holdable = false,
            }
            json!({
                "method_name": method,
                "args": base64::engine::general_purpose::STANDARD.encode(args(rng, &method)),
                "deposit": deposit,
                "gas": "30000000000000",
            })
        })
        .collect();
    let kind = serde_json::to_vec(&json!({"FunctionCall": {"receiver_id": receiver, "actions": actions}})).unwrap();
    Generated { kind, marks, holdable }
}

fn input(kind: Vec<u8>) -> ProposalInput {
    let mut prices = Prices::default();
    prices.usd_by_token.insert("near".into(), (24, 4.81));
    prices.usd_by_token.insert("wrap.near".into(), (24, 4.81));
    prices.usd_by_token.insert("usdt.tether-token.near".into(), (6, 1.0));
    ProposalInput {
        network: Network::Mainnet,
        dao: "dao.sputnik-dao.near".into(),
        proposal_id: 1,
        description: "A generated proposal with a description long enough to be read.".into(),
        kind_json: kind,
        policy_before: None,
        history: Some(History {
            approved_payments_before: 3,
            median_payment_usd_before: Some(10.0),
            recipients_paid_before: vec!["alice.near".into()],
        }),
        prices,
        dao_version: Some("3.2".into()),
        supplied_text: None,
        guard_account: None,
        config_before: None,
        block_timestamp_ns: None,
    }
}

/// Where attached NEAR can show up: a transfer of NEAR to the receiver, or the receiver's own
/// effect for that NEAR (a wrap, a staking deposit, a storage deposit, a bulk list's total).
fn sent_near(effects: &[Effect]) -> Vec<(String, String)> {
    effects
        .iter()
        .filter_map(|e| match e {
            Effect::Transfer { token, amount, to } if token == "near" => Some((to.clone(), amount.clone())),
            Effect::Wrap { op: WrapOp::Wrap, amount } => Some(("wrap.near".into(), amount.clone())),
            Effect::Staking { pool, op: StakingOp::Deposit, amount } => Some((pool.clone(), amount.clone())),
            Effect::StorageDeposit { contract, amount, .. } => Some((contract.clone(), amount.clone())),
            Effect::BulkPayment { contract, total, .. } => Some((contract.clone(), total.clone())),
            _ => None,
        })
        .collect()
}

#[test]
fn random_function_calls_fail_closed() {
    let mut rng = Rng(SEED);
    let (mut unknown_calls, mut known_only, mut marked, mut refused) = (0, 0, 0, 0);
    for n in 0..KINDS {
        let generated = kind(&mut rng);
        let shown = String::from_utf8_lossy(&generated.kind[..generated.kind.len().min(300)]).into_owned();
        let input = input(generated.kind.clone());
        let a = catch_unwind(AssertUnwindSafe(|| analyze(&input))).unwrap_or_else(|_| panic!("kind {n} panicked: {shown}"));

        if a.effects.iter().any(|e| matches!(e, Effect::UnknownCall { .. })) {
            unknown_calls += 1;
            assert!(matches!(a.risk_floor, Severity::High | Severity::Critical), "kind {n} is {:?} with an unknown call: {shown}", a.risk_floor);
        }

        let readable = generated.holdable && decode::value::read_kind(&generated.kind).is_some();
        if !readable {
            refused += 1;
            assert!(a.effects.is_empty(), "kind {n}: {shown}");
            assert!(a.findings.iter().any(|f| f.code == FindingCode::UnknownCall), "kind {n}: {shown}");
            assert_eq!(a.risk_floor, Severity::High, "kind {n}: {shown}");
            continue;
        }
        if !a.effects.is_empty() && !a.effects.iter().any(|e| matches!(e, Effect::UnknownCall { .. })) {
            known_only += 1;
        }
        let mut sent = sent_near(&a.effects);
        for (receiver, deposit) in &generated.marks {
            let wanted = (receiver.clone(), deposit.to_string());
            let at = sent.iter().position(|s| *s == wanted);
            assert!(at.is_some(), "kind {n}: {deposit} yocto attached on {receiver} is not marked as sent: {shown}\n{:?}", a.effects);
            sent.swap_remove(at.unwrap());
            marked += 1;
        }
    }
    println!("{KINDS} kinds: {unknown_calls} with an unknown call, {known_only} with known effects only, {marked} attached deposits marked, {refused} refused as unreadable");
    assert!(unknown_calls > 1_000 && known_only > 1_000 && marked > 1_000 && refused > 50, "the generator must reach every branch it checks");
}
