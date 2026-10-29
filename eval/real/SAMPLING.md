# Real proposals sample: how it was drawn

300 real NEAR DAO proposals, drawn from the census of the last 365 days (9,471 proposals, 608 DAOs). The records are unlabelled. Three labellers work from the cards in `eval/real/cards/`, one shard each. Built 20 Oct 2026 from the census files only. No network call was made: 0 RPC requests, no transaction, no login.

## Seed and method
- Seed string: `kaap-eval-v1`.
- Random numbers: mulberry32. Every stratum has its own stream, started from the first 4 bytes of sha256(`kaap-eval-v1|<stratum name>`), so changing one stratum never moves another. No `Math.random`, no clock.
- Every candidate list is sorted by DAO and proposal id before it is shuffled. A draw spreads across DAOs (or receivers, or tokens) one at a time before it repeats one.
- Test-named DAOs (the census rule: test, staging, qa-, demo, sandbox, audit, trial, dummy, playground in the DAO name) are capped at 20 percent of a stratum of 5 or more, and at none in a smaller stratum, unless the stratum has no other candidates.
- A record that meets two quotas counts for both. Quotas that were already met by earlier draws drew 0 extra records.
- sample.jsonl is sorted by the `id` string in plain character order. That puts `...:1528` before `...:208`.

## Inputs (read only)
- `reference/dao-census/raw/proposals-365d.json`: the population. Every one of the 300 records was compared field by field with it (description, kind, status): 300 of 300 identical.
- `scratchpad/dao-census/proposals/<dao>.json`: each DAO's full stored history (85,770 proposals), for the `history` and `policy_before` context. Its 365-day part is identical to the file above.
- `scratchpad/dao-census/daoinfo.json` (contract version), `scratchpad/dao-census/active-daos.json` (each DAO's current policy, already cached, so no `get_policy` call was needed), `reference/dao-census/raw/tokens.json` (token decimals), `reference/dao-census/mismatches.json`.
- Node v26.7.0 (the scripts use `JSON.rawJSON` so no large number is rounded).

## Quotas, and what was drawn
The quotas add up to 262 records. The other 38 are a uniform random top-up from every proposal not yet chosen (test-named share capped at 20 percent): FunctionCall 22, Transfer 9, ChangePolicy 5, UpgradeSelf 1, ChangePolicyUpdateParameters 1.

| Stratum | Quota | Drawn by the stratum | Detail |
|---|---|---|---|
| Mismatch records inside the 365-day file | all | 7 | 3 more are out of window, see below |
| Transfer | 50 | 50 | 4 are mismatch records. NEAR 18 (Approved 11, Rejected 3, Failed 1, InProgress 3), USDC 10 (6, 1, 2, 1), USDT 8 (5, 0, 1, 2), other tokens 14 (8, 2, 2, 2) |
| FunctionCall | 120 | 120 | 2 are mismatch records. Details in the next rows |
| of which `v1.signer` `sign` | at least 20 | 20 drawn, 32 in the final sample | auth 5, bulk-subaccount auth 5, bulk-payment-confidential 1, single confidential 6, other 3. Final mix: single 13, auth 7, bulk-auth 7, other 4, bulk 1 |
| of which each other top-20 pair | at least 3 each | 53 drawn | all 19 pairs have 3 or more in the final sample |
| of which receivers outside the top 20 | at least 15 | 15 drawn, 29 in the final sample | 25 distinct receivers. "Outside" means the receiver is none of the 9 receivers named in the top-20 pairs. 33 records have no top-20 pair at all |
| of which deposit above 1 yoctoNEAR | at least 10 | 0 extra, 20 in the final sample | already met by other draws |
| FunctionCall status floors | (my addition) | 0 extra | final: Approved 109, Rejected 12, Failed 10, InProgress 10, Expired 1 |
| FunctionCall random fill | to reach 120 | 30 | spread across DAOs |
| ChangePolicy | 30 | 30 | policy before known 20 (Approved 12, Rejected 5, InProgress 3), unknown 10 (7, 2, 1) |
| ChangePolicyUpdateParameters | 8 | 8 | Approved 4, Rejected 2, InProgress 2 |
| AddMemberToRole | 10 | 10 | 1 is a mismatch record. Approved 6, Rejected 2, InProgress 1, Expired 1 |
| RemoveMemberFromRole | 8 | 8 | Approved 6, InProgress 1, Expired 1 |
| ChangeConfig | 8 | 8 | Approved 5, Rejected 2, InProgress 1 |
| UpgradeSelf | 6 | 6 | Approved 5, InProgress 1 |
| UpgradeRemote | 8 | 8 | Approved 6, InProgress 1, Expired 1 |
| ChangePolicyAddOrUpdateRole | all | 5 | every one in the data |
| ChangePolicyRemoveRole | all | 2 | every one |
| ChangePolicyUpdateDefaultVotePolicy | all | 4 | every one |
| FactoryInfoUpdate | all | 2 | every one |
| Vote | all | 1 | the only one |
| DAOs on contract versions before 3.2 | at least 10 | 0 extra, 175 in the final sample | 3.1: 123, 3.0: 38, 2.0: 14 |
| Test-named DAOs | at most 25 percent | 25 of 300 (8.3 percent) | 275 records (91.7 percent) are from DAOs that are not test-named |
| Random top-up | to reach 300 | 38 | |

Final sample, 300 records from 154 DAOs.
- By kind: FunctionCall 142, Transfer 59, ChangePolicy 35, AddMemberToRole 10, ChangePolicyUpdateParameters 9, ChangeConfig 8, RemoveMemberFromRole 8, UpgradeRemote 8, UpgradeSelf 7, ChangePolicyAddOrUpdateRole 5, ChangePolicyUpdateDefaultVotePolicy 4, ChangePolicyRemoveRole 2, FactoryInfoUpdate 2, Vote 1. All 14 kinds in the data are present.
- By status: Approved 216, InProgress 32, Rejected 32, Failed 16, Expired 4.
- `is_test` is true on 56 records: 25 from test-named DAOs and 31 more where the priced payment is under 5 USD.
- Three records have an em-dash in their description. In sample.jsonl it is written as the JSON escape for U+2014 (a backslash, then u2014). In the cards it is shown as a hyphen with a space each side.

Top 20 receiver and method pairs (from BRIEF.md, recomputed from the data and matched): proposals in the 365-day file, then in the sample.

| Pair | In data | In sample |
|---|---|---|
| v1.signer::sign | 2101 | 32 |
| intents.near::mt_transfer | 627 | 10 |
| intents.near::add_public_key | 356 | 5 |
| wrap.near::near_deposit | 271 | 9 |
| wrap.near::ft_transfer | 242 | 6 |
| intents.near::ft_withdraw | 125 | 4 |
| native USDC (17208628...33a1)::ft_transfer | 117 | 5 |
| bulkpayment.near::approve_list | 66 | 3 |
| native USDC::ft_transfer_call | 64 | 3 |
| wrap.near::ft_transfer_call | 61 | 6 |
| contract.main.burrow.near::add_asset_farm_reward | 53 | 3 |
| contract.main.burrow.near::update_asset_limit | 50 | 3 |
| contract.main.burrow.near::update_asset | 45 | 4 |
| intents.near::mt_transfer_call | 43 | 3 |
| contract.main.burrow.near::execute | 40 | 3 |
| omft.near::ft_deposit | 40 | 3 |
| nearone.pool.near::withdraw_all | 39 | 5 |
| nearone.pool.near::unstake | 37 | 3 |
| near-prime-public.poolv1.near::unstake | 35 | 4 |
| near-prime-public.poolv1.near::withdraw_all | 32 | 3 |

## Mismatch records out of window
These three of the ten in `mismatches.json` are older than the 365-day file. Nothing was fetched for them.
- rhea-airdrop.sputnik-dao.near #7 (2025-09-23, Approved)
- creativesdao.sputnik-dao.near #172 (2023-08-30, Approved)
- burrow.sputnik-dao.near #208 (2022-06-09, Expired)

The seven in the file are in the sample: survival-is-near #132, sweat-multisig #0, sudostake-dao #1, multiagency #31, burrow #1528, burrow #1654, open-web-academy #789. BRIEF.md also counts sudostake-dao #0 and #2 as real mismatches, but `mismatches.json` does not list them, so they were not forced and are not in the sample.

## How `context` was filled
- `dao_version`: `ver` from `daoinfo.json`, the contract version the DAO runs today (scan of 20 Oct 2026), not necessarily the version when the proposal was filed.
- `policy_before` is set for the seven policy kinds (ChangePolicy, ChangePolicyAddOrUpdateRole, ChangePolicyRemoveRole, ChangePolicyUpdateDefaultVotePolicy, ChangePolicyUpdateParameters, AddMemberToRole, RemoveMemberFromRole). It is null for every other kind, with no `before_unknown`. This bullet is the 20 Oct method. On 26 Oct every one of the 73 policy-kind records was read again from the chain at the moment its status names, which replaced this method (next section). For the seven kinds the 20 Oct order of tries was:
  1. Rebuilt from the last approved full ChangePolicy with a lower proposal id, plus every approved policy edit after it and before this record, applied the way the contract applies them. Used only for DAOs where the same replay over the whole history ends on exactly the DAO's current policy. That held for 459 of 461 DAOs with a ChangePolicy base. The two that did not (bootstrap-org, qa-stage) go to try 2. Records: 44.
  2. The DAO's current policy, when this proposal is not Approved and no approved policy proposal has an id at or after this one. Records: 4. This is stricter than the order's wording ("no approved policy proposal came after this one"). If this proposal is itself the approved one, the current policy already contains its effect, so it would show the policy after as the policy before.
  3. Otherwise `policy_before` is null and `before_unknown` is true. Records: 25.
- Limits of try 1: proposals are replayed in id order, not in the order they were approved. Proposals the contract has deleted are invisible. The 459 of 461 match is the measure of how much that matters.
- `history_available` is true on all 300 (no DAO in the sample had a failed page fetch). `history` counts the DAO's approved payments with a `submission_time` strictly earlier than the record. Payment means what the census analysis means: Transfer proposals, and function calls that send tokens (ft_transfer, ft_transfer_call, mt_transfer, mt_transfer_call, near_withdraw, and the moving calls on intents.near), minus Trezu asset-exchange and public-to-confidential proposals. USD uses today's prices as the census does (1 NEAR = 4.81 USD). `median_payment_usd_before` is over priced payments only and is rounded to cents. `recipients_paid_before` lists every receiver found in those payments, sorted, unwrap calls excluded.
- Two things to know about `history`: it covers all earlier payments with no 365-day cut, while the guide's LARGE_AMOUNT says "over the year". For 98 of the 300 records the DAO has an earlier approved payment more than a year older than the record, so the two medians can differ. Switching to a one-year window is one constant (`HISTORY_WINDOW_NS` in `scratchpad/eval-e1/load.mjs`) and a rerun. 115 records have no earlier approved payment. 5 have earlier payments but none with a price, so the median is null.
- `is_test`: true when the DAO name matches the census test rule, or when the record is a priced payment under 5 USD.

## The policy before, per status (26 Oct 2026)
Since 26 Oct the `policy_before` of every policy-kind record is the DAO's policy read from an archival node (`https://archival-rpc.mainnet.fastnear.com`, `get_policy`) at the moment labelling guide v2.3 section 7 names for its status, so the label matches what Kaap would judge last. "Before" follows the order in which proposals executed on chain, never their ids.
- Approved: the block before it executed. The execution block is the last `last_actions_log` entry on contract 3.2; on 3.0, 3.1 and 2.0 (no log) it is the first block at which `get_proposal` returns Approved, found by bisection.
- Rejected and Failed: the block before the final vote, the first block with status Rejected (or the last log entry on 3.2). No record has status Failed.
- Expired: the last block before it expired. Expiry is `submission_time` plus the `proposal_period` in force at filing, and the block is the largest one whose timestamp is before that instant, found by bisection.
- InProgress: the snapshot block, which for each DAO is the highest block among its `get_proposals` pages in the census cache (about 220.76M).
- A height with no block (the node answers 422) is read at the last block before it, which holds the same state.

Result for the 73 policy-kind records (ChangePolicy 35, AddMemberToRole 10, ChangePolicyUpdateParameters 9, RemoveMemberFromRole 8, ChangePolicyAddOrUpdateRole 5, ChangePolicyUpdateDefaultVotePolicy 4, ChangePolicyRemoveRole 2): the node answered at the named block for all 73, so `before_unknown` is on none. 44 already held the policy the chain gives (compared with object keys, Group members and permissions sorted) and their lines are byte-for-byte as before. 29 changed: 25 that had `before_unknown` now have a `policy_before`, and 4 InProgress records (shapeshifttokenomics #11, stader-nearx #94, subdued-snow #6, testing-astradao #580) now carry the policy at the snapshot block instead of the one rebuilt for their filing day. The 29 cards were rebuilt to match. Every read block, per record, is in `scratchpad/eval-e12a/CHANGED.md` and `moments.json`, and the originals are kept in `scratchpad/eval-e12a/before/`. The sha256 of `eval/real/sample.jsonl` after the re-read is `16c6a926d6f7972406353d80c2acf15e5d1bca96e6d737fc769e576b7b30b796`; the hashes under "Reproduce it, byte for byte" are those of the 20 Oct build.

## Cards
- `eval/real/cards/shard-1.md`, `shard-2.md`, `shard-3.md`: 100 cards each. Shard 1 holds records 1, 4, 7 of the sorted list, shard 2 holds 2, 5, 8, shard 3 holds 3, 6, 9. Every shard holds the ten larger kinds (FunctionCall, Transfer, ChangePolicy, AddMemberToRole, RemoveMemberFromRole, UpgradeSelf, UpgradeRemote, ChangeConfig, ChangePolicyUpdateParameters, ChangePolicyAddOrUpdateRole). The small ones are spread: Vote in shard 2, FactoryInfoUpdate in shards 2 and 3, ChangePolicyRemoveRole in shards 1 and 3, ChangePolicyUpdateDefaultVotePolicy in shards 1 and 2.
- Each card shows: id, status, kind, DAO and contract version, `is_test`, the description as stored, the kind as pretty JSON, every base64 `args` decoded (JSON pretty-printed, or "not JSON" with the first 200 bytes in hex), JSON found inside string fields, a table of amounts in base units and whole tokens, the `context` block, and a line saying how `policy_before` was obtained.
- Token decimals come from the census token list (NEAR 24, USDC and USDT 6, the rest by exact id) or the card says "decimals unknown". Nothing was looked up on chain.
- Cards carry no labels, risk words or opinions. The decoded amounts assume the field is in the token's own base units; the card file header says so.
- A string longer than 3000 characters would be cut in the display, with its full length given. No record in this sample has one, so every card shows every string whole.

## Reproduce it, byte for byte
From `D:/Projects/Near Hackathan`:

```
node scratchpad/eval-e1/sample.mjs && node scratchpad/eval-e1/cards.mjs
sha256sum eval/real/sample.jsonl eval/real/cards/shard-1.md eval/real/cards/shard-2.md eval/real/cards/shard-3.md
node scratchpad/eval-e1/verify.mjs
```

The script ran twice with identical output. sha256:
- sample.jsonl: `0dd2770b913729f8e0a4f3a97161d1585bc49e7ea9d17182a44b8f4d2f4c3cce`
- shard-1.md: `1f1dc6c6fc17d709a1db4b9a1b2ce6627a367c46a8f3f2d574a29d7fb9504705`
- shard-2.md: `211141b432242bbedf2f98202d05ab7eaf56f30ad812725da36e76675fef3482`
- shard-3.md: `3a3e26f0a0cbc2941f3e0a924dc69454f0e61950a0867b5f74b00cee9e62f819`

`verify.mjs` reads the outputs and the raw census again and checks: 300 lines of valid JSON, no duplicates, sorted, label fields null, each record equal to the raw proposal, every kind present, the seven in-window mismatches present, `history` recomputed by separate code for 80 records (all matched), `policy_before` equal to its base ChangePolicy for 28 records and to the current policy for 4, and the cards covering every record once in the every-third order.

## Not met, or worth knowing
- Nothing in the quotas fell short. USDT has no Rejected transfer in the data, so that cell is 0.
- Test-named DAOs are only 8 percent of the sample, against 29 percent of the census, because the small strata take none. Test material is still present through the 31 payments under 5 USD.
- On 20 Oct, 25 of the 73 policy records had `before_unknown`. Since the 26 Oct chain re-read none has (see "The policy before, per status").
- The census prices are today's, so `median_payment_usd_before` and the under-5-USD part of `is_test` carry the same price error the census notes.
- Extra rules I added beyond the order: status floors inside FunctionCall, status splits inside each rare kind, and spreading draws across DAOs. They only change which records are drawn, not the quotas.
