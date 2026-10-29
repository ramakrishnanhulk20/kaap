# Guide questions from shard 1

Cases where `docs/eval/labeling-guide.md` does not settle the answer, found while labelling the 100 records of shard 1. Each entry gives the two readings and the one used. Where a reading changes the risk, the higher one was used, as the work order says. Record ids drop the `mainnet:` prefix. Entries Q1 to Q3, Q6, Q7, Q15, Q16, Q18 to Q20, Q23 and Q24 move a risk floor or a finding; the rest only change a field or a note.

## Rulings that move the risk (head chef to confirm or flip)

### Q1. storage_deposit on a token contract
Reading A: the attached NEAR is a `transfer` effect ("NEAR attached to a call") and `ATTACHED_DEPOSIT` (medium) is the only finding, so a payment batch that registers new receivers floors at medium.
Reading B (used): section 3 has no row for `storage_deposit` and `unknown_call` is "any call not covered above", so each `storage_deposit` is an `unknown_call` effect (`UNKNOWN_CALL`, high), and its attached NEAR is also a `transfer` effect with `ATTACHED_DEPOSIT`. Floor high, `veto_allowed` true.
Why it matters: Trezu and other apps put a `storage_deposit` before every payment to a new receiver. If A is chosen, drop the `unknown_call` effects and `UNKNOWN_CALL`, and recompute the floor.
Records: aaapeter.sputnik-dao.near:2

### Q3. Empty call arguments
Reading A: a call with 0 bytes of arguments has nothing to decode, so nothing is "not JSON".
Reading B (used): 0 bytes do not decode to JSON (the card itself says "empty (0 bytes), not JSON"), so `ARGS_NOT_JSON` (high) fires; on an `unknown_call` the `args` field shows `"not_json"`.
Why it matters: staking-pool `withdraw_all` and `unstake_all` are normally sent with empty arguments, so every one of them floors at high under B.
Records: braindao-treasury.sputnik-dao.near:83, jasnah-treasury.sputnik-dao.near:157, n1-staking.sputnik-dao.near:128, n1-treasury.sputnik-dao.near:240

### Q2. Full ChangePolicy where the previous policy is unknown
Reading A (used): section 7 says label only what the new policy alone proves. Duplicate role names are the only finding that can be proven that way, so with none the floor is `low`. The `policy_change` effect carries `before_unknown: true` and `null` for every diff field; the resulting roles are in `notes`.
Reading B: the effect is not fully known, so unknown should not be low (C2). There is no finding code for "policy change with unknown before", and the floor is defined as the highest finding severity, so B cannot be written in this format.
Records: blockz.sputnik-dao.near:3, my-new-confff.sputnik-dao.near:3, myy-bizz.sputnik-dao.near:4, nfendowment03.sputnik-dao.near:2, qa-stage.sputnik-dao.near:114, roma6.sputnik-dao.near:2

### Q16. policy_add_or_update_role when the previous policy is unknown
Section 7 gives the unknown-before rule only for a full ChangePolicy. For a shortcut kind it says the change is in the kind itself, but `POLICY_REPLACES_ROLE` needs the old member set. Reading A: label only what the new role proves, so no finding. Reading B (used): an approving role is replaced as a whole and "new set is a subset of the old set" cannot be shown, so `POLICY_REPLACES_ROLE` (critical) fires. `POLICY_REMOVES_MEMBER` and `POLICY_ADDS_APPROVER` are not fired, because no single removal or addition can be shown from the kind alone.
Records: nearlytrade.sputnik-dao.near:6

### Q6. wrap.near near_deposit and its attached NEAR
Reading A: the attached NEAR is the wrapped amount, so the `wrap` effect already says it and no separate `transfer` effect or `ATTACHED_DEPOSIT` is needed.
Reading B (used): the guide says a function call that attaches more than 1 yoctoNEAR gets `ATTACHED_DEPOSIT` and a `transfer` effect, so a `near_deposit` gets the `wrap` effect, a `transfer` of the same NEAR to wrap.near, and `ATTACHED_DEPOSIT` (medium).
Records: burrow.sputnik-dao.near:1528, houseofstake.sputnik-dao.near:39, mic.sputnik-dao.near:20, webassemblymusic-treasury.sputnik-dao.near:78

### Q7. Removing a whole role (ChangePolicyRemoveRole)
Reading A: no finding, because `POLICY_REMOVES_MEMBER` is written for member edits and the guide names role removal only for the Guard (`GUARD_WEAKENED`).
Reading B (used): the members of the removed role lose their seat, so each is listed in `members_removed` and `POLICY_REMOVES_MEMBER` (high) fires.
Records: burrow.sputnik-dao.near:1714

### Q15. A described change that the effects do not make
Reading A: the end state is what counts, so the check is `matches` or `vague` and no finding fires. Reading B (used): the description names an action or a "from" value the effects contradict, so `DESC_CONTRADICTS` (high) fires and the check is `contradicts`.
In mic.sputnik-dao.near:67 the member is added to a role named council that does not exist in the policy (section 7: only a log line). In testyonder.sputnik-dao.near:6 the policy before already has the threshold 2 that the description says it changes "from 1" to 2, because proposal 5 had set it 1.2 seconds earlier. The `policy_change` effect is written with empty lists in both.
Records: mic.sputnik-dao.near:67, testyonder.sputnik-dao.near:6

### Q18. A Burrow-shaped call at an account that is not contract.main.burrow.near
Reading A: method and arguments match the Burrow farm call, so it is a `defi_call`. Reading B (used): the guide's known contracts are named accounts and this receiver is not one, so it is an `unknown_call` (`UNKNOWN_CALL`, high).
Records: ref-labs.sputnik-dao.near:226 (br.private-mainnet.ref-dev-team.near)

### Q19. Lowering the default vote policy
Reading A: `POLICY_LOWERS_THRESHOLD` is about an approving role's own vote policy, and the default policy is a separate item with no finding. Reading B (used): a role with no entry for a label uses the default, so lowering it lowers that role's threshold on those labels; the council role in this DAO (2 members, all permissions) lists 12 labels and uses the default for any it does not list. A raise (sodax:10, 48 to 49 percent) fires nothing.
Records: sodax.sputnik-dao.near:9 (50 to 48 percent), sodax.sputnik-dao.near:13 (49 to 40 percent)

### Q20. Threshold changed from a ratio to a vote count
techbros.sputnik-dao.near:4 changes Admin thresholds from [50,100] (50 percent) to "1" (one vote) on every label, while adding five members to the role. Reading A: the two forms cannot be compared, so no `POLICY_LOWERS_THRESHOLD`. Reading B (used): with 6 members, 50 percent needs 4 votes and the new rule needs 1, so the threshold went down. The floor is critical either way, because `POLICY_ADDS_APPROVER` also fires.
Records: techbros.sputnik-dao.near:4

### Q23. Calls that move funds but are not a section 3 type
Reading A: a `transfer` or `staking` effect, which has no finding. Reading B (used): `unknown_call` (`UNKNOWN_CALL`, high), because the receiver is not the contract type the row names.
- Lockup `transfer` of 6.54 NEAR to the DAO itself (lesik_o.sputnik-dao.near:20).
- Lockup `withdraw_all_from_staking_pool` (braindao-treasury.sputnik-dao.near:83).
- NearX `manager_deposit_and_stake` (stader-nearx.sputnik-dao.near:113), a liquid staking contract, not a staking pool.
- Other calls with no section 3 row: claim.sweat `burn` (sweat-multisig.sputnik-dao.near:21), xtoken.rhealab.near `set_fee_distribution_config` (ref-finance.sputnik-dao.near:877), omft.near `ft_deposit` (int-mnt-dao.sputnik-dao.near:20), btc-connector.bridge.near `acl_grant_role` (rainbowbridge.sputnik-dao.near:227), outlayer-admin `w_execute_extension` (defuse-ops.sputnik-dao.near:3), launchpad.justhoot.near `allow_quote_tokens` (justhoot.sputnik-dao.near:11).

### Q24. A sign request whose description carries text that hashes to the payload
templar.sputnik-dao.near:206 has a NEAR delegate action in its description, and sha256 of the NEP-461 prefix plus those bytes equals the signed payload (one DeleteKey action, as the description says). Reading A: that is text supplied, so `HASH_UNVERIFIED` should not fire and the floor would be low. Reading B (used): the guide says every real sign request has no text supplied, so `HASH_UNVERIFIED` fires (floor high, `veto_allowed` false). The note records what was found.
Records: templar.sputnik-dao.near:206

## Rulings that change a field or a note only

### Q8. Payment in a token with no census price
The size check needs a dollar value. A token that is not in the census token list has no price here, so `LARGE_AMOUNT` is not evaluated and does not fire. Firing it would mean guessing a price, which the guide forbids.
Records: chatgpt.sputnik-dao.near:17, linear-gov.sputnik-dao.near:6 (both linear-protocol.near, 24 decimals)

### Q9. NEW_RECIPIENT on NEAR attached to a call
The guide lists attached NEAR as a `transfer` effect, and `NEW_RECIPIENT` is judged on "this account". Reading A: only real payees count, not the contract being called. Reading B (used): every `transfer` effect counts, so the called contract is checked against `recipients_paid_before`. The floor does not change, because `ATTACHED_DEPOSIT` is also medium; only the findings list differs.
Records where this is the only reason: burrow.sputnik-dao.near:1528, ergo-public.sputnik-dao.near:1, int-mnt-dao.sputnik-dao.near:20, justhoot.sputnik-dao.near:11, mic.sputnik-dao.near:20, stader-nearx.sputnik-dao.near:113

### Q10. ChangeConfig where the previous config is not in the data
`config_change` has `purpose_changed` and `metadata_changed`. When the DAO has an earlier approved ChangeConfig in its stored history the flags are computed against it (hh.sputnik-dao.near:4 against its proposal 3: only the colour changes). When the proposal is the first one of the DAO the creation config is not in the data, so both flags are the string `"unknown"`.
Records: itera.sputnik-dao.near:0, web3stick.sputnik-dao.near:0

### Q11. is_test left as given
`is_test` is copied from sample.jsonl, as the order says. Two records move under 5 USD but have `is_test` false, because the census payment rule does not count `near_deposit` or `approve_list` as payments: burrow.sputnik-dao.near:1528 (555 yoctoNEAR) and ergo-public.sputnik-dao.near:1 (0.01 NEAR).

### Q4. Description that only lists method names
"Proposal from external dApp: storage_deposit, ft_transfer ... on <contract>" names actions and a contract but no amount or recipient. Reading A: `vague`. Reading B (used): `matches`, because the named actions and contract are checkable and agree. Same for o_lskik2.sputnik-dao.near:74.
Records: aaapeter.sputnik-dao.near:2, o_lskik2.sputnik-dao.near:74

### Q5 and Q12. Claims the proposal cannot confirm
A description can state an amount or a version that the call cannot confirm: an amount on `withdraw_all` (no amount argument), a version for a code hash, a final payee behind a 1Click deposit address, a "from" value when the policy before is unknown. Used `matches` when nothing is contradicted and the checkable parts agree, and said in notes what could not be checked.
Records: braindao-treasury.sputnik-dao.near:83, jasnah-treasury.sputnik-dao.near:157, n1-staking.sputnik-dao.near:128, n1-treasury.sputnik-dao.near:240, hos-root.sputnik-dao.near:23, ref-finance.sputnik-dao.near:776, houseofstake.sputnik-dao.near:39, lesik-o.sputnik-dao.near:11, o_lskik2.sputnik-dao.near:114, staging-qa.sputnik-dao.near:230 and :290, tobi.sputnik-dao.near:92

### Q13. Sign requests: matches, vague or hidden
A sign request whose description names a purpose ("Authenticate DAO for confidential intents") that cannot be checked against a bare hash is `vague`. `hidden` is used only when the description itself says the details are hidden.
Records: dasdass.sputnik-dao.near:1, petersalomonsendev.sputnik-dao.near:54, roma-stage.sputnik-dao.near:2, test-confidential-bulk.sputnik-dao.near:6, vjvkk.sputnik-dao.near:1

### Q14. One call, two effects
`mt_transfer_call` into bulkpayment.near with the list id in `msg` is listed as a `token_call_transfer` (`msg_kind` `not_json`) and as a `bulk_payment` (total = the amount sent). For `approve_list` the `bulk_payment.total` is the attached deposit, because the recipients are in an off-chain list. No effect on findings.
Records: fgl2.sputnik-dao.near:3, ergo-public.sputnik-dao.near:1

### Q17. Token id inside intents.near
Tokens held inside intents.near are named `nep141:<contract>` in the call. The `token` field uses the underlying contract id with the `nep141:` prefix removed, to follow "tokens are identified by exact contract account id".

### Q21. asset-exchange proposals and LARGE_AMOUNT
The census history leaves asset-exchange proposals out of its payment list, but the proposal still sends 230 NEAR (about 1106 USD) to a third-party deposit address, so `LARGE_AMOUNT` was judged on the effect.
Records: webassemblymusic-treasury.sputnik-dao.near:78

### Q22. Fields the policy_change effect does not have
Section 3 has no field for the default vote policy, so a change to it is written as `vote_policy_changed` with `role` `default_vote_policy` and `label` `default`. A removed or added per-label entry has `null` for the missing side. For a role removal or a new role, the members of that role are also listed in `members_removed` or `members_added`.

### Q25. Amount for staking withdraw_all
The call has no amount, so the `staking` effect shows `amount` `"all"`.

### Q26. Description under 20 characters that still makes a claim
Section 5 says `empty` for under 20 characters, and `EMPTY_DESCRIPTION` fires, even when the short text names an amount ("Transfer 10 LiNEAR", "Withdraw 150K usdce"). Used `empty` and checked the claim in notes.
Records: linear-gov.sputnik-dao.near:6, burrow.sputnik-dao.near:1657

### Q27. LARGE_AMOUNT is judged per proposal
The census median is built from the dollar total of each earlier proposal, so the test compares each priced transfer effect, and the proposal total of priced transfers, with 10 times the median.

## Things the check script cannot confirm
- Token decimals for tokens outside the census list (LiNEAR 24, SWEAT 18, Burrow internal units 18 for a 6-decimal token) come from the DAO's own earlier proposals or common knowledge, not from the chain.
- The v3.2 hash `DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF` comes from `reference/dao-census/raw/wasmcheck.json`.
- hh.sputnik-dao.near:4 and sweat-multisig.sputnik-dao.near:21 were read against the DAO's stored proposal history in `scratchpad/dao-census/proposals/`, which is not on the cards.
