# Gas and storage for the Kaap contracts

Measured on 29 Oct 2026 (the run in `PROOF-sandbox.txt`, with enrolment and the builds measured again in `PROOF-clean-clone-deploy.txt`) in a local near-sandbox (nearcore 2.13.4, protocol 86, the protocol mainnet runs) against the real Sputnik DAO 3.2 binary (code hash `DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF`). The contracts were built with `cargo near build non-reproducible-wasm` (cargo-near 0.22.0, Rust 1.93.0, near-sdk 5.29.1):

| Contract | Size | sha256 |
|---|---|---|
| kaap-guard | 220,810 bytes | `5adbadb5282e0cf43ab9347d73249ce092be06fd7120aa6294a8bee5797dec76` |
| kaap-registry | 182,731 bytes | `4b73d851018e8e955b1037b4fa397380eb2638698f8eaea734eb1f9fa787539f` |

NEAR amounts use the minimum gas price of 100,000,000 yoctoNEAR per unit of gas, so 1 Tgas costs 0.0001 NEAR. Whoever sends the transaction pays its gas; neither contract pays gas for anyone.

To measure again, inside WSL from the repo root:

```
bash scripts/fetch-sputnik-wasm.sh
cargo test -p kaap-guard --test guard_sandbox gas_report -- --nocapture
cargo test -p kaap-registry --test registry_sandbox gas_report -- --nocapture
```

Each prints one `GAS |` line per receipt. A "total" adds every receipt of the transaction, including turning the transaction into its first receipt and the small refund receipts (0.22 Tgas each). Turning the transaction into a receipt costs about 0.33 Tgas for a small call and grows with the arguments, to about 11 Tgas for a 200 KB kind; it is charged on top of the gas the caller attaches, which is why a 300 Tgas veto can show a total above 300.

The ChangePolicy rows from 200,826 bytes up were measured on 12 Nov 2026, on the guard build that refuses a veto with less than 300 Tgas, in the same sandbox against the same Sputnik binary. In that run every row measured on 29 Oct came out within 0.05 Tgas of the figures below.

## The main actions

| Action | Receipts that do the work | Total burnt | Cost |
|---|---|---|---|
| Veto a Transfer (106-byte kind) | guard `veto` 2.78 Tgas, DAO `act_proposal` 2.42 Tgas, guard `on_veto_result` 1.61 Tgas | 8.26 Tgas | 0.00083 NEAR |
| Record a verdict | registry `record` 2.43 Tgas | 3.43 Tgas | 0.00034 NEAR, plus 0.00555 NEAR of storage |
| Record a verdict of the full 1,024 bytes | registry `record` 2.63 Tgas | 3.68 Tgas | 0.00037 NEAR, plus 0.01361 NEAR of storage |
| Enrol a DAO (its approved FunctionCall proposal) | guard `enroll` 1.88 Tgas with its refund, inside Sputnik's approval 2.94 Tgas and its callback 2.30 Tgas | 9.00 Tgas | 0.00090 NEAR, plus 0.0014 NEAR of storage |

In plain words: stopping a disguised payment costs whoever submits the verdict less than a thousandth of a NEAR. Recording a verdict costs about a third of that in gas, and the caller also leaves about half a hundredth of a NEAR behind to pay for the bytes the record occupies, forever. A DAO's enrolment costs it about what any approved proposal costs, and its proposal attaches 0.01 NEAR, of which the guard keeps the storage cost and sends the rest straight back.

## Veto by size of the kind

The guard canonicalises and hashes the kind it is given, and Sputnik reads, compares and rewrites the stored kind, so both costs grow with the kind. Big policies, many short strings, cost the most per byte; a FunctionCall padded with one long `args` string costs much less.

| Kind | Bytes | Guard `veto` | DAO `act_proposal` | Callback | Total | Outcome |
|---|---|---|---|---|---|---|
| Transfer | 106 | 2.78 | 2.42 | 1.61 | 8.26 | Rejected |
| ChangePolicy, 4 roles of 10 | 3,940 | 4.84 | 4.58 | 1.62 | 12.69 | Rejected |
| ChangePolicy, 20 roles of 30 | 22,746 | 15.55 | 17.28 | 1.62 | 37.09 | Rejected |
| ChangePolicy, 40 roles of 60 | 64,986 | 40.68 | 48.92 | 1.62 | 96.10 | Rejected |
| ChangePolicy, 60 roles of 80 | 117,526 | 72.50 | 89.85 | 1.62 | 171.65 | Rejected |
| ChangePolicy, 80 roles of 110 | 197,966 | 122.72 | 155.06 | 1.62 | 291.34 | Rejected |
| ChangePolicy, 80 roles of 112 | 200,826 | 124.41 | 157.60 | 1.62 | 295.73 | Rejected |
| ChangePolicy, 80 roles of 113 | 202,256 | 125.30 | 158.53 | 1.62 | 297.62 | Rejected |
| ChangePolicy, 80 roles of 114 | 203,686 | 126.39 | 159.79 | 1.62 | 300.05 | Rejected |
| ChangePolicy, 80 roles of 115 | 205,116 | 127.18 | 161.01 | 1.62 | 302.13 | Rejected, the largest that landed |
| ChangePolicy, 80 roles of 116 | 206,546 | 128.17 | 162.18, out of gas | 1.62 | 303.91 | still InProgress, `veto_result` "Failed" |
| ChangePolicy, 80 roles of 117 | 207,976 | 129.19 | 161.11, out of gas | 1.62 | 303.94 | still InProgress, "Failed" |
| ChangePolicy, 80 roles of 118 | 209,406 | 130.05 | 160.25, out of gas | 1.62 | 304.02 | still InProgress, "Failed" |
| ChangePolicy, 80 roles of 120 | 212,266 | 132.02 | 158.28, out of gas | 1.62 | 304.17 | still InProgress, "Failed" |
| ChangePolicy, 80 roles of 130 | 226,566 | 141.78 | 148.56, out of gas | 1.62 | 304.97 | still InProgress, "Failed" |
| ChangePolicy, 80 roles of 154 | 260,886 | 164.95 | 125.47, out of gas | 1.62 | 306.88 | still InProgress, "Failed" |
| FunctionCall, 48 KiB of args | 65,663 | 15.85 | 13.21 | 1.62 | 35.26 | Rejected |
| FunctionCall, 96 KiB of args | 131,199 | 28.88 | 23.93 | 1.62 | 62.14 | Rejected |
| FunctionCall, 144 KiB of args | 196,735 | 41.92 | 34.66 | 1.62 | 89.02 | Rejected |

All gas figures are in Tgas. Every veto here attached 300 Tgas, the least the guard accepts and the amount the worker sends.

With 300 Tgas attached, the largest policy kind whose vote landed was 205,116 bytes. Above it the guard still has room to send the vote, but what is left for the DAO's call falls short of what the DAO needs, and the gap widens with every byte: the guard's share grows by about 0.65 Tgas per 1,000 bytes and the DAO's need by about 0.8. The limit holds for policies shaped like these, 80 roles of many short member names; a shape that costs more per byte stops sooner.

Refusals cost less. A vote the DAO refuses (ERR_WRONG_KIND on a Transfer) burnt 7.31 Tgas in total: the guard 2.78, the DAO 1.91 before it refused, the callback 1.62. A verdict the guard itself refuses (ERR_NOT_VETOABLE) burnt 2.16 Tgas and stops in the guard's receipt. A veto sent with too little gas (ERR_NOT_ENOUGH_GAS) also stops in the guard's receipt: 12.5 Tgas there for the 197,966-byte kind with 240 Tgas attached, nearly all of it spent reading the arguments.

## How the constants were set

- `ACT_PROPOSAL_GAS` in kaap-guard is 100 Tgas: twice the 48.9 Tgas the DAO burnt on the 65 KB ChangePolicy, and almost six times the 17.3 Tgas of the 22.7 KB one, which is about the size of a big real DAO's policy. The DAO call also receives every unit the caller attached beyond the guard's own needs, which is how the 198 KB policy veto landed with 155 Tgas.
- `ON_VETO_RESULT_GAS` is 10 Tgas: the callback burnt 1.61 to 1.62 Tgas whatever the kind's size.
- `MIN_VETO_GAS` is 300 Tgas, the amount the worker attaches. `veto` refuses any call with less (`ERR_NOT_ENOUGH_GAS`) before it reads the verdict, because a verdict is spent once the guard's receipt succeeds and a signed verdict is public before it is used. Before this check, a stranger could send the verdict for the 197,966-byte policy with 240 Tgas: the guard burnt 122.7 Tgas and passed the rest on, the DAO's call got 107.9 of the 155 Tgas it needed and ran out, the guard recorded "Failed", and the worker's 300 Tgas call would then have met `ERR_REPLAY`. The sandbox test `a_veto_with_too_little_gas_for_the_vote_fails_whole_and_leaves_the_verdict_usable` showed that on the old code and now shows the call refused, the verdict unused, and the same verdict landing with 300 Tgas. Every accepted call carries at least the gas of the worker's own. What is not burnt comes back.

## Views and their page caps

Measured by calling each view as a transaction, which charges the same execution a view does:

| View | Measured | Per item | Full page |
|---|---|---|---|
| guard `enrolled_daos` | 1.30 Tgas for 1 entry, 2.14 Tgas for 12 | about 0.08 Tgas | 100 entries, about 9 Tgas |
| registry `history` | 1.47 Tgas for 1 record, 3.33 Tgas for 10 | about 0.21 Tgas | 50 records, about 12 Tgas |

Both full pages stay far inside the gas an RPC node lets a view burn.

## Storage

| What | Bytes | NEAR | Paid by |
|---|---|---|---|
| A typical verdict in the registry, with its index entries | 555 | 0.00555 | the caller, from the deposit it attaches; the rest is refunded |
| The largest verdict the registry accepts (1,024 bytes of borsh) | 1,361 | 0.01361 | the caller, the same way |
| One enrolled DAO in the guard (a 15-character id; a 64-character id takes about 239) | 141 | 0.00141 | the DAO, from the deposit on `enroll`; refunded in full by `unenroll` |
| One used verdict in the guard, vote cast | 74 | 0.00074 | the guard's own balance |
| One used verdict in the guard, vote refused (the entry holds "Failed") | 84 | 0.00084 | the guard's own balance |
| kaap-guard's code | 220,810 | about 2.2 | the guard account, once, at deploy |
| kaap-registry's code | 182,731 | about 1.8 | the registry account, once, at deploy |

## The guard's own budget

The guard pays for exactly one thing: the 74 to 84 bytes each used verdict leaves in its storage, at most 0.00084 NEAR a veto. Only a verdict the accepted key signed can create one, so nobody else can spend it. Gas is always the caller's. At the worst case of 84 bytes:

| Vetoes | Storage the guard pays |
|---|---|
| 100 | 0.084 NEAR |
| 1,000 | 0.84 NEAR |
| 10,000 | 8.4 NEAR |

The free balance is the account balance minus 0.00001 NEAR for every byte the account stores. A faucet-funded guard starts with about 7.8 NEAR free after its code is paid for, enough for about 9,000 vetoes. For C18, the worker should raise "guard balance low" when the free balance drops below 0.1 NEAR, which is about 119 vetoes left.

Enrolments never touch this budget: the DAO pays for its own entry, and `unenroll` hands back exactly what it paid.

Attaching 0.02 NEAR to `record` always covers the storage: the largest record allowed took 0.0136 NEAR here, and the longest possible DAO and caller names (64 characters each, against 11 and 14 in the test) add at most about 0.0016 NEAR more.

## Limits these numbers show

- With the 300 Tgas every veto attaches, a policy-shaped kind above 205,116 bytes cannot be vetoed: from 206,546 bytes up the DAO's call ran out of gas, the guard recorded "Failed", and the verdict was spent.
- kaap-verdict refuses to canonicalise anything over 256 KiB, so the guard answers ERR_BAD_KIND for such a kind and cannot veto it at any gas. A FunctionCall padded past that size is cheap to file: the 196,735-byte one above was filed and vetoed without trouble.
- Both are stated in the Limits section of `guard/README.md`. Neither the sealed program nor the rules engine holds a proposal back for its size below 256 KiB, so a verdict can be signed for a policy kind between the two limits; a veto tried on one fails in the DAO's call and is reported by `veto_refused` and `veto_result`.
- The 300 Tgas is the guard's and the worker's limit, not the chain's. NEAR has let one transaction carry up to 1,000 Tgas since protocol 83 (the sandbox runs protocol 86), and a 226,566-byte ChangePolicy veto sent with 1,000 Tgas landed in the sandbox on 12 Nov 2026: the guard burnt 141.8 Tgas and the DAO 180.2.
