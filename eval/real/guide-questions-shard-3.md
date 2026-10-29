# Shard 3: cases the labelling guide does not fully settle

Labeller: shard-3. Labels are in `eval/real/labels-shard-3.jsonl`. Each entry gives the record ids, the two readings and the one used. Where the guide's text settles a case but a reader might differ, the entry says so. Reading A is the one written into the labels unless stated.

How to read the effect of each entry: "floor change" says what the risk floor would become under the other reading. Findings that sit next to a finding of the same or higher severity change nothing about the floor or the veto fields.

## Q1. Policy changes whose previous policy is unknown (section 7)
Nine shard-3 records have `before_unknown: true`:
mainnet:bootstrap-org.sputnik-dao.near:1, mainnet:defuse-ops.sputnik-dao.near:0, mainnet:jhptc.sputnik-dao.near:3, mainnet:lesyk.sputnik-dao.near:4, mainnet:nearlytrade.sputnik-dao.near:13, mainnet:ref-labs.sputnik-dao.near:232, mainnet:rhea-airdrop.sputnik-dao.near:12, mainnet:roundvest5367.sputnik-dao.near:0, mainnet:zeus.sputnik-dao.near:3.
- Reading A (used): section 7 says to label only what the new policy alone proves, and section 4 says a finding never fires from a guess. For a full ChangePolicy the diff fields of the `policy_change` effect are `null` (unknown) and the resulting roles are listed in `notes`. For a shortcut kind (AddMemberToRole, RemoveMemberFromRole, AddOrUpdateRole) the effect carries what the kind itself says. No approver finding fires because nobody can show the role could approve, or that a member is new. POLICY_REMOVES_MEMBER does fire on rhea-airdrop:12, because the kind itself removes a member.
- Reading B (higher risk): assume the usual meaning. Floor change if chosen: ref-labs:232 to critical (POLICY_ADDS_APPROVER, if council can approve); nearlytrade:13 to critical (POLICY_REPLACES_ROLE, an approving role is rewritten and nothing shows its members are a subset); bootstrap-org:1, lesyk:4 and roundvest5367:0 to critical (the description says a member is added to Admin, which approves policy and member kinds at threshold 1). jhptc:3, zeus:3 and defuse-ops:0 would stay low (no member change is claimed, and the defuse-ops role has no vote rights).
- This is the largest single judgement in the shard: 5 records would move from low to critical.

## Q2. Member removal and "threshold goes down"; threshold forms that differ
- Records: mainnet:auroralabs.sputnik-dao.near:59 (council 4 to 3 members; on the kinds that use the default ratio 1/2 the votes needed go from 3 to 2).
- Reading A (used): POLICY_LOWERS_THRESHOLD looks at the configured threshold and quorum, not at votes needed. A removal leaves them unchanged, so only POLICY_REMOVES_MEMBER (high) fires.
- Reading B: count votes needed (floor(members x n / d) + 1, as the contract does). auroralabs:59 would gain POLICY_LOWERS_THRESHOLD, floor critical.
- When the two threshold forms differ I compared votes needed for the role's member count. mainnet:phala-team.sputnik-dao.near:8 moves five Admin kinds from the absolute threshold 1 to the default ratio 1/2 with 3 members: 1 vote needed becomes 2, so it goes up. Reading B' (compare the numbers 1 and 0.5): it would read as lower and the floor would be critical.
- mainnet:warpdrive.sputnik-dao.near:44 is lower under both readings (ratio 1/2 to 49/100, 3 votes of 4 to 2 of 4), so it is critical either way.

## Q3. "Approving role" in POLICY_ADDS_APPROVER (section 4: "a role that can approve any kind")
- Records: mainnet:houseofstake.sputnik-dao.near:13, mainnet:lesyk-business.sputnik-dao.near:20, mainnet:yurtur-treasury.sputnik-dao.near:79 (the Approver role approves only transfer and call). mainnet:sodax.sputnik-dao.near:8 has `*:*` and fires either way.
- Reading A (used): "any kind" means at least one kind, so Approver counts.
- Reading B: the role must be able to approve every kind. The first three records would lose POLICY_ADDS_APPROVER and POLICY_REPLACES_ROLE and fall to low (members added to a role that approves only some kinds).

## Q4. POLICY_REPLACES_ROLE on a full ChangePolicy
- Records: houseofstake:13, lesyk-business:20, yurtur-treasury:79.
- Reading A (used): the guide lists a full ChangePolicy as a way to replace a role, and the new member set of an approving role is not a subset of the old one, so POLICY_REPLACES_ROLE fires next to POLICY_ADDS_APPROVER.
- Reading B: only a rewrite of one named role counts, so only POLICY_ADDS_APPROVER fires. The floor is critical either way.
- A full ChangePolicy that only removes members or reorders them does not fire it (subset holds): atlas-operation:3, chabak:12.

## Q5. Description claims that the proposal cannot confirm, and how `description_check` was set
Rule used. Only claims of amount, token, recipient or a specific action count. `contradicts` if one of them is shown wrong; `matches` if at least one is checkable and all checkable ones agree (an amount the call does not carry, a version label on a code hash, and a purpose are ignored); `vague` if nothing checkable is claimed (generic words such as transfer, payment, payout, sign do not count); `empty` for under 20 characters; `hidden` only when the description says the details are hidden.
- mainnet:burrow.sputnik-dao.near:1654, mainnet:n1-treasury.sputnik-dao.near:214, mainnet:near-prime.sputnik-dao.near:234, mainnet:shitzu.sputnik-dao.near:412: the description names an amount, but the call (Burrow Withdraw, or withdraw_all with empty arguments) carries none. Used `matches` because the action and token agree. Reading B: `contradicts` with DESC_CONTRADICTS (high), not used because the call takes whatever is available, so the claim is not shown to be wrong.
- Upgrade records whose description names a version (deer:3, mark_treasury:64, hos-root:21, rainbowbridge:315) are `matches` on the action; the version cannot be checked from a hash. The two "3.2 release" upgrades use different hashes (deer:3 DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXu, mark_treasury:64 DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF); both decode to 32 bytes.
- Sign requests whose description does not say details are hidden are `vague` (agentic:10, fsdfsdfsdfsd:1, honolulu:2, krate27:1, terz:2). The five that say "Details are hidden for privacy" are `hidden` (payouts:82, sdasd:12, stable:34, tarun-business-treasury:6, tobi:18).
- Short descriptions that state an action are still `empty` because the guide sets the cut at 20 characters: "Add pause manager" (rainbowbridge:226), "Upgrade contract" (shitzu:465), "add member" (sodax:8), "Test USDC payment" (my-testing-treasury2:9), "* Title: test near" (o_lskik2:53), "* Title: test" (ariz-treasury:6).
- Not contradictions: aurorafinance:838 ("for bridge-ops" names a purpose, not a recipient) and aurora-dao-bvi:548 ("Aurora burn") are `vague`.

## Q6. A payload hash in the description that differs from the signed hash
- Record: mainnet:sdasd.sputnik-dao.near:12. The description lists "Payload Hashes: 734077ae...e417"; the sign request carries 712e8b41...2992. How the two relate is not stated.
- Reading A (used): `hidden` (the description says details are hidden), no DESC_CONTRADICTS, because the finding is defined for an amount, token, recipient or action and a hash is none of them. The difference is stated as a fact in `notes`.
- Reading B: `contradicts` with DESC_CONTRADICTS (high). The floor stays high; `veto_allowed` would become true.

## Q7. sodax:12 rewrites a role with identical content
- Record: mainnet:sodax.sputnik-dao.near:12. The role written has the same members, `*:*` permission and 60/100 vote policy on twelve kinds as the council in the policy before, so nothing changes. The description says "change threshold to 49%".
- Reading A (used): `contradicts` with DESC_CONTRADICTS (high); the council thresholds stay at 60/100.
- Reading B: `matches` or `vague`, since 49/100 is already the default in the policy. Floor would be low.

## Q8. A function call that deploys code
- Record: mainnet:rainbowbridge.sputnik-dao.near:315 (omni.bridge.near `up_deploy_code` with a code hash).
- Reading A (used, higher risk): a `code_upgrade` effect and CODE_UPGRADE (critical, must veto), because the method name says it deploys code.
- Reading B: the guide ties CODE_UPGRADE to UpgradeSelf and UpgradeRemote only, so this is an `unknown_call` with UNKNOWN_CALL (high); floor high, no must_veto.
- sweat-multisig:14 (`up_stage_code`) is an UpgradeRemote kind, so CODE_UPGRADE applies without any question.

## Q9. Empty call arguments and ARGS_NOT_JSON
- Records: mainnet:n1-treasury.sputnik-dao.near:214, mainnet:near-prime.sputnik-dao.near:234, mainnet:shitzu.sputnik-dao.near:412 (staking pool `withdraw_all` with zero-byte arguments).
- Reading A (used, higher risk): zero bytes do not decode to JSON, so ARGS_NOT_JSON (high) fires and `veto_allowed` is true.
- Reading B: a method that takes no arguments has no arguments to decode; no finding, floor low, no veto allowed. Each of the three would move from high to low.
- The `staking` effect for `withdraw_all` has `amount: null` because no amount is on chain.

## Q10. Attached NEAR: the extra `transfer` effect and NEW_RECIPIENT on it
- Records with a deposit above 1 yocto: mainnet:int-mnt-dao.sputnik-dao.near:18, mainnet:mic.sputnik-dao.near:38, mainnet:nearn-staging.sputnik-dao.near:160, mainnet:testing-astradao.sputnik-dao.near:614, mainnet:treasury-npnd.sputnik-dao.near:67, mainnet:yurtur-treasury.sputnik-dao.near:43.
- Reading A (used): every call action with a deposit above 1 yocto gets a `transfer` effect to the called contract plus ATTACHED_DEPOSIT, also when a `wrap`, `staking` or `bulk_payment` effect already shows the same NEAR. NEW_RECIPIENT is judged on that `transfer` too (wrap.near, the pool, bulkpayment.near and omft.near are not in the payee lists).
- Reading B: attached NEAR is not a payment and the census payee lists never include such contracts, so NEW_RECIPIENT should not fire on it. Floors do not change: ATTACHED_DEPOSIT is medium and sits in each record already (int-mnt-dao:18 is high because of UNKNOWN_CALL). Only the finding lists change: NEW_RECIPIENT would drop from int-mnt-dao:18, mic:38, testing-astradao:614 and treasury-npnd:67, where the attached transfer is its only source.

## Q11. NEW_RECIPIENT on `ft_withdraw` out of intents.near
- Records: mainnet:lesik_o.sputnik-dao.near:57, mainnet:memdexdao001.sputnik-dao.near:5. The call's `receiver_id` is the token contract (already in the payee list because the census records that field); the real destination is in the memo.
- Reading A (used, higher risk): judge the destination address, which is not in the list, so NEW_RECIPIENT fires.
- Reading B: judge `receiver_id`, which is in the list. Floors stay medium because CROSS_CHAIN_OUT fires.
- mainnet:o_lskik2.sputnik-dao.near:53 withdraws to a NEAR account (no memo): chain `near`, no CROSS_CHAIN_OUT because the destination is not another chain. Reading B would fire it; the floor is medium either way through NEW_RECIPIENT.
- Chain names in `intents_withdraw` follow the `blockchain` field of the census token list (`sol`, `eth`, `near`). Tokens inside intents.near are written as the bare contract id with the `nep141:` prefix removed.

## Q12. ft_transfer_call into a DeFi or intents contract
- mainnet:dalang-safe.sputnik-dao.near:11 (wrap.near to v2.ref-finance.near with a swap message): one `token_call_transfer` effect, `msg_kind` other_json, and the swap described in `notes`. `defi_call` is used only for calls made directly on Burrow. Reading B: add a `defi_call` effect. No floor change.
- mainnet:mic.sputnik-dao.near:38 sends wNEAR to intents.near with a plain account id as the message: `msg_kind` is `intents_deposit`. Reading B: `not_json`. No floor change.
- mainnet:templar.sputnik-dao.near:198 (24 calls on a Templar proxy governance contract) is `unknown_call` ×24, because Templar is not among the contracts the guide names. Reading B: treat as a lending protocol and use `defi_call`; floor would be low.

## Q13. LOOKALIKE_TOKEN for a bare-word token id
- Record: mainnet:webassemblymusic-treasury.sputnik-dao.near:58 (`token_id` is the word `usdc`, not the native USDC contract; decimals unknown).
- Reading A (used, higher risk): the id imitates the symbol without being the real contract, so LOOKALIKE_TOKEN (high) fires.
- Reading B: nothing in the proposal states that it means USDC, so no finding and floor low.

## Q14. ChangeConfig has no previous config
- Records: mainnet:lesik-o.sputnik-dao.near:5, mainnet:olskik-confidential.sputnik-dao.near:10, mainnet:romakqatesting.sputnik-dao.near:184, mainnet:yurtur-empty-treasury.sputnik-dao.near:11. `purpose_changed` and `metadata_changed` are `null` (unknown); the new values are in `notes`. Reading B: `true` for any non-empty field. No finding applies to a config change, so the floor is low either way.

## Q15. Policy effect value conventions
- `bond_or_period_changed` is a boolean. `vote_policy_changed` entries show the vote policy that applies, so the default is written out where a kind has no entry of its own. When a role is removed, its members are listed in `members_removed` and POLICY_REMOVES_MEMBER fires (ref-finance:934). Reading B: a whole-role removal is not a member removal; floor would be low.
- `deposit_and_stake` is written as two `staking` effects, `deposit` then `stake` (testing-astradao:614).

## Q16. Descriptions scanned for PROMPT_INJECTION
All 100 descriptions and every decoded string were scanned. Nothing addresses a reviewer or an AI. The line "Must be executed before <time>" in the 1Click asset-exchange descriptions (ergo-public:3, nearn-staging:160, staging-qa:172, testing-1212:2, yurtur-treasury:43) is a deadline note for signers. "NEAR AI" in multiagency:31 is a product name.
