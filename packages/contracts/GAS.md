# Gas and storage for the Kaap contracts

Measured in a local near-sandbox (nearcore 2.13.4, protocol 86) against the real Sputnik DAO 3.2 binary (code hash `DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF`). The guard figures are from 12 Nov 2026, on the build that adds the size limit, the 900 Tgas minimum, strict mode and the 24-hour key delay. The registry figures are from 29 Oct 2026 (the run in `PROOF-sandbox.txt`, with the builds measured again in `PROOF-clean-clone-deploy.txt`). The contracts were built with `cargo near build non-reproducible-wasm --locked` (cargo-near 0.22.0, Rust 1.93.0, near-sdk 5.29.1):

| Contract | Size | sha256 |
|---|---|---|
| kaap-guard, this build | 231,213 bytes | `9e74bbbadcfa6820390e21cb415ae83542f5de6257da4ad651caf950801c5d23` |
| kaap-registry | 182,731 bytes | `4b73d851018e8e955b1037b4fa397380eb2638698f8eaea734eb1f9fa787539f` |

NEAR amounts use the minimum gas price of 100,000,000 yoctoNEAR per unit of gas, so 1 Tgas costs 0.0001 NEAR. Whoever sends the transaction pays its gas; neither contract pays gas for anyone. The sender is charged for all the gas it attaches when the call starts and gets back what is not burnt, so a veto, which must attach 900 Tgas, needs about 0.09 NEAR on hand while it runs.

To measure again, inside WSL from the repo root:

```
bash scripts/fetch-sputnik-wasm.sh
cargo test -p kaap-guard --test guard_sandbox gas_report -- --nocapture
cargo test -p kaap-guard --test guard_sandbox a_kind_at_the_size_limit -- --nocapture
cargo test -p kaap-registry --test registry_sandbox gas_report -- --nocapture
```

Each prints one `GAS |` or `LIMIT |` line per receipt or per call. A "total" adds every receipt of the transaction, including turning the transaction into its first receipt and the small refund receipts (0.22 Tgas each). Turning the transaction into a receipt costs about 0.33 Tgas for a small call and grows with the arguments, to about 14.5 Tgas for a 222 KB kind; it is charged on top of the gas the caller attaches.

## The main actions

| Action | Receipts that do the work | Total burnt | Cost |
|---|---|---|---|
| Veto a Transfer (106-byte kind) | guard `veto` 2.81 Tgas, DAO `act_proposal` 2.42 Tgas, guard `on_veto_result` 1.63 Tgas | 8.31 Tgas | 0.00083 NEAR |
| Record a verdict | registry `record` 2.43 Tgas | 3.43 Tgas | 0.00034 NEAR, plus 0.00555 NEAR of storage |
| Record a verdict of the full 1,024 bytes | registry `record` 2.63 Tgas | 3.68 Tgas | 0.00037 NEAR, plus 0.01361 NEAR of storage |
| Enrol a DAO with `{}` (its approved FunctionCall proposal) | guard `enroll` 1.91 Tgas with its refund, inside Sputnik's approval 2.94 Tgas and its callback 2.30 Tgas | 9.03 Tgas | 0.00090 NEAR, plus 0.0014 NEAR of storage |
| Enrol a DAO with `{"veto_unreadable":true}` | guard `enroll` 1.92 Tgas, approval 2.96, callback 2.31 | 9.07 Tgas | 0.00091 NEAR, plus the same storage |
| Change a DAO's mode (its approved proposal to `set_veto_unreadable`) | guard 1.60 Tgas, approval 2.97, callback 2.33 | 8.34 Tgas | 0.00083 NEAR, no storage |
| Announce a key change (`set_accepted_key`, owner) | guard 1.54 Tgas | 2.07 Tgas | 0.00021 NEAR; the guard holds 64 bytes until the change is applied or cancelled |
| Cancel it (`cancel_key_change`, owner) | guard 1.42 Tgas | 1.95 Tgas | 0.00019 NEAR |
| Apply it a day later (`apply_key_change`, anyone) | guard 1.50 Tgas | 2.03 Tgas | 0.00020 NEAR |

In plain words: stopping a disguised payment costs whoever submits the verdict less than a thousandth of a NEAR, though the call must carry 900 Tgas for the moment it runs. Recording a verdict costs about a third of that in gas, and the caller also leaves about half a hundredth of a NEAR behind to pay for the bytes the record occupies, forever. A DAO's enrolment costs it about what any approved proposal costs in either mode, and its proposal attaches 0.01 NEAR, of which the guard keeps the storage cost and sends the rest straight back. Changing the mode later costs the same as any other proposal and nothing more. Each step of a key change costs the caller about two ten-thousandths of a NEAR.

## Veto by size of the kind

The guard canonicalises and hashes the kind it is given, and Sputnik reads, compares and rewrites the stored kind, so both costs grow with the kind. Big policies, many short strings in sets, cost the most per byte; a FunctionCall padded with one long `args` string costs much less.

| Kind | Bytes | Guard `veto` | DAO `act_proposal` | Callback | Total | Outcome |
|---|---|---|---|---|---|---|
| Transfer | 106 | 2.81 | 2.42 | 1.63 | 8.31 | Rejected |
| ChangePolicy, 4 roles of 10 | 3,940 | 4.66 | 4.58 | 1.63 | 12.53 | Rejected |
| ChangePolicy, 20 roles of 30 | 22,746 | 14.32 | 17.28 | 1.63 | 35.88 | Rejected |
| ChangePolicy, 40 roles of 60 | 64,986 | 37.12 | 48.92 | 1.63 | 92.56 | Rejected |
| ChangePolicy, 80 roles, half the size limit | 111,104 | 60.23 | 79.63 | 1.63 | 148.80 | Rejected |
| ChangePolicy, 80 roles, at the size limit | 222,208 | 125.73 | 174.91 | 1.63 | 315.49 | Rejected |
| ChangePolicy, 2 long lists, half the size limit | 111,104 | 150.81 | 210.87 | 1.63 | 371.84 | Rejected |
| ChangePolicy, 2 long lists, at the size limit | 222,208 | 304.90 | 422.85 | 1.63 | 744.97 | Rejected |
| ChangePolicy, 2 long lists, one byte over | 222,209 | 33.00, refused `ERR_KIND_TOO_LARGE` | | | 47.70 | still InProgress, verdict unused |
| FunctionCall, 48 KiB of args | 65,663 | 12.28 | 13.21 | 1.63 | 31.70 | Rejected |
| FunctionCall, 96 KiB of args | 131,199 | 21.72 | 23.93 | 1.63 | 54.98 | Rejected |
| FunctionCall, 144 KiB of args | 196,735 | 31.16 | 34.66 | 1.63 | 78.28 | Rejected |

All gas figures are in Tgas. Every veto here attached 900 Tgas, the least the guard accepts.

The two policy shapes are built by the tests to an exact size. "80 roles" is 80 Group roles of about 125 members each, named like `m3-41.sandbox`, about 17 bytes a member. "2 long lists" is two Group roles of about 18,500 members each, named with the shortest account ids NEAR allows (`00`, `01` and on to `zz`, then three characters), about 6 bytes a member, so each byte carries as many members as it can. The second costs about 2.4 times as much per byte as the first, in the guard, which sorts every member list, and in Sputnik, which hashes every member into a set. The last role's name is padded so each kind is exactly the size in the table.

Refusals cost less. A vote the DAO refuses (ERR_WRONG_KIND on a Transfer) burnt 7.36 Tgas in total: the guard 2.82, the DAO 1.91 before it refused, the callback 1.63. A verdict the guard itself refuses (ERR_NOT_VETOABLE) burnt 2.18 Tgas and stops in the guard's receipt. A kind one byte over the size limit stops there too, after 33.0 Tgas, nearly all of it spent reading the arguments, and so does a veto with too little gas (ERR_NOT_ENOUGH_GAS): 12.5 Tgas for the 197,966-byte kind with 240 Tgas attached.

## The size limit and the least veto gas

A verdict is spent once the guard's receipt succeeds, whatever the DAO answers, and a signed verdict is public before it is used. So every call the guard accepts must carry the vote on the costliest kind it accepts, or a stranger could send the verdict first with too little gas and waste it. Two facts set the numbers: NEAR lets one transaction carry up to 1,000 Tgas (protocol 88 on testnet and mainnet on 12 Nov 2026; the sandbox's protocol 86 allows the same), and a padded spelling of a kind hashes like the kind but costs the guard more to read.

These rows were measured on 12 Nov 2026 on the build before the size limit (commit `6d96ae7`, which refused less than 300 Tgas), in the same sandbox. That build accepted any size up to kaap-verdict's 256 KiB, which is what let the largest landing kind be found; the build here refuses those calls, so they cannot be measured on it again.

| Shape | Bytes | Gas attached | Vote | Guard gas | Treasury gas |
|---|---|---|---|---|---|
| 80 roles | 131,072 | 1,000 Tgas | landed | 79.00 | 96.92 |
| 80 roles | 196,608 | 1,000 Tgas | landed | 121.62 | 153.73 |
| 80 roles | 229,376 | 1,000 Tgas | landed | 143.10 | 181.57 |
| 80 roles | 262,144 | 1,000 Tgas | landed | 165.14 | 211.08 |
| 2 long lists | 131,072 | 1,000 Tgas | landed | 185.57 | 248.39 |
| 2 long lists | 196,608 | 1,000 Tgas | landed | 280.22 | 374.63 |
| 2 long lists | 229,376 | 1,000 Tgas | landed | 326.81 | 437.34 |
| 2 long lists | 262,144 | 1,000 Tgas | landed | 374.14 | 498.65 |
| 80 roles | 222,208 | 322 Tgas | not landed, the DAO ran out of gas | 137.89 | 174.44 |
| 80 roles | 222,208 | 323 Tgas | landed | 137.89 | 174.90 |
| 2 long lists | 222,208 | 749 Tgas | not landed, the DAO ran out of gas | 317.06 | 422.38 |
| 2 long lists | 222,208 | 750 Tgas | landed | 317.06 | 422.74 |

On this build, from `a_kind_at_the_size_limit_lands_with_exactly_the_least_gas_and_nothing_less`:

| Shape | Bytes | Gas attached | Vote | Guard gas | Treasury gas |
|---|---|---|---|---|---|
| 80 roles | 222,208 | 899,999,999,999,999 gas | refused `ERR_NOT_ENOUGH_GAS`, verdict unused | | |
| 80 roles | 222,208 | 900 Tgas | landed | 125.72 | 174.79 |
| 2 long lists | 222,208 | 899,999,999,999,999 gas | refused `ERR_NOT_ENOUGH_GAS`, verdict unused | | |
| 2 long lists | 222,208 | 900 Tgas | landed | 304.89 | 422.75 |
| 2 long lists | 222,209 | 900 Tgas | refused `ERR_KIND_TOO_LARGE`, verdict unused | | |

Both shapes landed at every size up to 262,144 bytes, kaap-verdict's limit, above which no kind can be canonicalised at all. The least gas that landed a 222,208-byte kind was 323 Tgas for 80 roles and 750 Tgas for two long lists. On this build the guard burns 12.2 Tgas less on that kind (304.9 against 317.1), because it canonicalises the kind once and hashes it with NEAR's own sha256 instead of doing both again through kaap-verdict's `kind_hash`. The least landing gas is about the guard's gas plus the DAO's plus the callback's 10 Tgas: that sum is 749.8 for the earlier build, against the 750 measured, and 737.6 for this one, so 900 Tgas is 22 percent above what this build needs.

A padded spelling cannot get past these checks. A 197,966-byte kind followed by 60,000 spaces hashes like the kind but is 257,966 bytes, and is refused with ERR_KIND_TOO_LARGE; padded only up to 222,208 bytes it is refused with ERR_BAD_KIND; the verdict stays unused both times, and the kind as the DAO returned it then lands (`a_padded_spelling_of_a_large_kind_is_refused_and_the_compact_one_then_lands`). No honest kind is refused by the length rule: the 14 `get_proposal` answers and the 281 proposals inside `get_proposals` answers recorded from testnet and mainnet in `packages/cli/test/fixtures`, and the 73 planted evaluation records filed on Sputnik 3.2 and read back, each have exactly the length of their canonical form (`every_recorded_kind_is_as_long_as_its_canonical_form`, `every_planted_kind_reads_back_from_sputnik_at_its_canonical_length`).

## How the constants were set

- `MAX_VETO_KIND_BYTES` in kaap-guard is 222,208 bytes, 217 KiB: the smaller of the two shapes' largest landing sizes at 1,000 Tgas, 262,144 bytes for both, less 15 percent (222,822), rounded down to whole KiB.
- `MIN_VETO_GAS` is 900 Tgas: the 750 Tgas that landed a kind of `MAX_VETO_KIND_BYTES` in the heavier shape, plus 20 percent, which is already a whole 50 Tgas and 100 Tgas under the chain's 1,000. `veto` refuses any call with less (`ERR_NOT_ENOUGH_GAS`) before it reads anything. The sandbox test `a_veto_with_too_little_gas_for_the_vote_fails_whole_and_leaves_the_verdict_usable` shows a 240 Tgas call refused, the verdict unused, and the same verdict landing with 900 Tgas. What is not burnt comes back.
- `ACT_PROPOSAL_GAS` is 100 Tgas: twice the 48.9 Tgas the DAO burnt on the 65 KB ChangePolicy, and almost six times the 17.3 Tgas of the 22.7 KB one, which is about the size of a big real DAO's policy. The DAO call also receives every unit the caller attached beyond the guard's own needs, which is how the vote on the costliest kind gets its 423 Tgas.
- `ON_VETO_RESULT_GAS` is 10 Tgas: the callback burnt 1.61 to 1.63 Tgas whatever the kind's size.
- `KEY_CHANGE_DELAY_MS` is 86,400,000, 24 hours. It is a decision, not a measurement (12 Nov 2026): long enough for members to be alerted and for the owner to cancel a change made with a stolen key.

## Views and their page caps

Measured by calling each view as a transaction, which charges the same execution a view does:

| View | Measured | Per item | Full page |
|---|---|---|---|
| guard `enrolled_daos` | 1.32 Tgas for 1 entry, 2.15 Tgas for 12 | about 0.08 Tgas | 100 entries, about 9 Tgas |
| registry `history` | 1.47 Tgas for 1 record, 3.33 Tgas for 10 | about 0.21 Tgas | 50 records, about 12 Tgas |

Both full pages stay far inside the gas an RPC node lets a view burn.

## Storage

| What | Bytes | NEAR | Paid by |
|---|---|---|---|
| A typical verdict in the registry, with its index entries | 555 | 0.00555 | the caller, from the deposit it attaches; the rest is refunded |
| The largest verdict the registry accepts (1,024 bytes of borsh) | 1,361 | 0.01361 | the caller, the same way |
| One enrolled DAO in the guard, its mode included (a 15-character id; each character more adds a byte, so a 64-character id takes 191) | 142 | 0.00142 | the DAO, from the deposit on `enroll`; refunded in full by `unenroll`; changing the mode adds nothing |
| One used verdict in the guard, vote cast | 74 | 0.00074 | the guard's own balance |
| One used verdict in the guard, vote refused (the entry holds "Failed") | 84 | 0.00084 | the guard's own balance |
| An announced key change, until it is applied or cancelled | 64 | 0.00064 | the guard's own balance; freed when it is applied or cancelled |
| kaap-guard's code | 231,213 | about 2.3 | the guard account, once, at deploy |
| kaap-registry's code | 182,731 | about 1.8 | the registry account, once, at deploy |

## The guard's own budget

The guard pays for two things: the 74 to 84 bytes each used verdict leaves in its storage, at most 0.00084 NEAR a veto, and the 64 bytes of an announced key change while it waits. Only a verdict the accepted key signed can create the first and only the owner the second, so nobody else can spend it. Gas is always the caller's. At the worst case of 84 bytes a veto:

| Vetoes | Storage the guard pays |
|---|---|
| 100 | 0.084 NEAR |
| 1,000 | 0.84 NEAR |
| 10,000 | 8.4 NEAR |

The free balance is the account balance minus 0.00001 NEAR for every byte the account stores. A faucet-funded guard starts with about 7.7 NEAR free after its code is paid for, enough for about 9,000 vetoes. For C18, the worker should raise "guard balance low" when the free balance drops below 0.1 NEAR, which is about 119 vetoes left.

Enrolments never touch this budget: the DAO pays for its own entry and its setting, and `unenroll` hands back exactly what it paid.

Attaching 0.02 NEAR to `record` always covers the storage: the largest record allowed took 0.0136 NEAR here, and the longest possible DAO and caller names (64 characters each, against 11 and 14 in the test) add at most about 0.0016 NEAR more.

## Limits these numbers show

- The guard accepts a kind of at most 217 KiB, exactly as long as its canonical form, from a call that attaches at least 900 Tgas, and every such call measured here landed its vote. A kind above 217 KiB is refused with ERR_KIND_TOO_LARGE before the verdict is read, so the verdict is never spent on it.
- kaap-verdict refuses to canonicalise anything over 256 KiB, so no kind above that could be vetoed at any gas. The 217 KiB limit is below it; the sealed program and the rules engine do not hold back a kind between the two, so a verdict can be signed for one, and the guard refuses it and leaves the verdict unused.
- The 900 Tgas covers the two measured shapes with a 150 Tgas margin over the 750 the heavier needed. It is not measured against a shape that costs more per byte than both, or against a DAO whose own current policy is large: Sputnik reads that policy on every vote, and the test DAO's has two roles.
- 1,000 Tgas is the chain's limit for one transaction, and 900 leaves 100 below it.
