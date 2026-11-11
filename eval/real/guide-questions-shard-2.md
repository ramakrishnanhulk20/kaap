# Shard 2: cases the labelling guide does not fully settle

Labeller: the AI labelling pass for shard 2. Each entry gives the record ids, the two readings, and the one I used. Where the guide gave no answer I took the reading with the higher risk, as the labelling instructions say. Counts for the whole shard: 100 labels, risk floors critical 20, high 32, medium 17, low 31.

## Conventions I applied everywhere (representation, not risk)
- One finding entry per code per record, even when several effects trigger it.
- Attached deposit above 1 yoctoNEAR: one `transfer` effect (token `near`, to the called contract) plus `ATTACHED_DEPOSIT`, as section 4 says. A `near_deposit` call also gets its `wrap` effect, so its amount appears twice (as wrap and as transfer).
- `NEW_RECIPIENT` and `LARGE_AMOUNT` are judged on every effect that sends value to another account: `transfer` (including an attached deposit), `token_call_transfer`, `intents_transfer`, `intents_withdraw`. Wrap, staking and unwrap are not treated as payments. For an `ft_transfer_call` into intents.near whose message is an account name, the account in the message counts as a payee too.
- When an `ft_transfer_call` or `mt_transfer_call` lands on a known protocol (Trezu bulk payment contract, Burrow, the Rhea DCL exchange), the record gets the `token_call_transfer` effect and the protocol effect (`bulk_payment` or `defi_call`).
- `description_check` is `matches` when the description makes at least one checkable claim (method, contract, token, amount, recipient) and every checkable claim agrees; claims the proposal cannot show (a release number, a swap result, a recipient count) are noted and do not make it `contradicts`. It is `vague` when nothing in it can be checked, and `hidden` only when the text says the details are hidden by design.
- Policy effects list changes only. `bond_or_period_changed` is a boolean; the old and new values go in `notes`. A default vote policy change is written in `vote_policy_changed` with `role` set to `default` and `label` set to `default_vote_policy`. When the old value is not in the record, `before` is the string `unknown`. A label that has no rule before or after is `null`. When the policy before is unknown I add `before_unknown: true` to the label and leave the change lists empty for full policies.
- `staking` effects use `amount: "all"` for `withdraw_all`. `config_change` fields that cannot be known without the old config are the string `unknown`.
- Token ids inside intents.near are written as in the args (`nep141:...`); for a multi-token id from a Hot omni contract I use the census asset id form `nep245:<contract>:<token id>`. `chain` in `intents_withdraw` is `near` for `ft_withdraw` and the census blockchain name otherwise.
- I did not change `is_test` or any other input field. Notes are kept to two sentences and carry no status words, since status is in the record.
- Facts used that are not in the record itself, all public chain data already on disk: the DAO's current policy for chicago:2 and sweat-multisig:0 (Q3), and a hash computed from the delegate action text printed in templar:216 (it matches the payload hash and is noted in that record).

## Cases

### Q1. What "a role that can approve any kind" means (every policy record)
- Reading A: the role holds at least one permission that lets it approve some kind (`VoteApprove`, or `*` as the action, for example `policy:*`).
- Reading B: the role can approve every kind (`*:*`).
- Used: A, the higher-risk reading. Admin roles with `policy:*` and similar wildcards count as approving, as do Approver roles with `call:VoteApprove`.

### Q2. A function call that upgrades code: aurora-dao-bvi:535, rainbowbridge:239
`aurora.pool.near` method `upgrade` with a code hash, and `btc-connector.bridge.near` method `up_deploy_code` with a hash.
- Reading A: `unknown_call` and `UNKNOWN_CALL` (high). The table limits `code_upgrade` and `CODE_UPGRADE` to the UpgradeSelf and UpgradeRemote kinds.
- Reading B: `code_upgrade` and `CODE_UPGRADE` (critical), because in substance the call asks a contract to switch to new code.
- Used: A, because the guide names the two kinds. If you want B, both records move from high to critical and must_veto becomes true. rainbowbridge:239 also has EMPTY_DESCRIPTION (17 characters).

### Q3. AddMemberToRole with the policy before unknown: chicago:2, sweat-multisig:0
Both add an account to a role (`Admin`, `governance_voters`) whose rights are not in the record.
- Reading A: the rights are not known, so no `POLICY_ADDS_APPROVER`.
- Reading B: the role is taken as approving, so `POLICY_ADDS_APPROVER` fires.
- Used: B. The DAO's current policy (from the census) shows both roles hold approving rights today, but that is the present state, not the state at filing.

### Q4. A token with no price: duct-community-token:32
`duct-1078.meme-cooking.near` is not in the census token list and the DAO's median is 52.91 USD.
- Reading A: the value cannot be computed, so `LARGE_AMOUNT` does not fire.
- Reading B: the worst plausible size applies (C2 treats an unknown price as at least high), so it fires.
- Used: B, at the guide's medium severity. The guide has no code for "unpriced token". test-publicailab-dao:2 has the same kind of token but its median is null, so no size test applies there.

### Q5. Full ChangePolicy with the policy before unknown: fast-auth-maintainer:4, wali619:2
- Reading A (section 7): label only what the new policy alone proves. Nothing is provable here, so no findings and a `low` floor.
- Reading B: the subset test in `POLICY_REPLACES_ROLE` cannot be passed when the old members are unknown, so it fires (critical).
- Used: A, because section 7 says so in words. A gives a full policy replacement a `low` floor, which sits badly with C2. Both records would move to critical under B.

### Q6. ChangePolicyAddOrUpdateRole with the policy before unknown: nearlytrade:12
- Reading A: nothing provable, so no findings (section 7's exception extended to shortcut kinds).
- Reading B: the subset test cannot be shown, so `POLICY_REPLACES_ROLE` fires (critical).
- Used: B, because the section 7 exception names a full ChangePolicy only. The DAO's own earlier proposal #6 shows new members in this role, which agrees with B, but I did not use it.

### Q7. UpdateDefaultVotePolicy with the policy before unknown: sweat-multisig:4
- Reading A: a lower threshold is not provable, so no finding and a `low` floor.
- Reading B: a lower threshold cannot be ruled out, so `POLICY_LOWERS_THRESHOLD` fires (critical).
- Used: B (tie rule). This is the least certain label in the shard; the new value is 59/100 and nothing in the record says what it replaced.

### Q8. Empty call arguments: jasnah-treasury:137, n1-staking:110, n1-treasury:254, near-prime:130
All four are `withdraw_all` on a staking pool with 0 bytes of arguments.
- Reading A: empty arguments mean no arguments, so `ARGS_NOT_JSON` does not fire.
- Reading B: 0 bytes do not decode to JSON, so it fires (high).
- Used: B. A call with `{}` as arguments (linear-stake-wars:159) is JSON and gets no finding, so two identical withdrawals get different floors.

### Q9. Withdrawal to a NEAR account counted as cross-chain: o_lskik2:34
`ft_withdraw` from intents.near to olskik.near.
- Reading A: the destination is NEAR, not another chain, so no `CROSS_CHAIN_OUT`.
- Reading B: every `intents_withdraw` leaves intents.near, so it fires (medium).
- Used: B, with `chain: near`. testing-astradao:588 is a real cross-chain withdrawal (to TON) and is not in doubt.

### Q10. Calls that are not in the guide's table
Read as `unknown_call` and `UNKNOWN_CALL` by both readings, listed so the count is visible: `storage_deposit` on a token (o_lskik2:76), `ft_deposit` on omft.near (int-mnt-dao:33), `mt_batch_transfer_call` (hot-dao:176), `unstake` and `transfer` on lockup contracts (mgoyal:7, onlyjoe:58), and admin calls on the oracle, the bridge and multica contracts (aggregate-oracle:21, rainbowbridge:186, ref-labs:281). The one reading I weighed is whether `storage_deposit` should count as part of a token transfer (lower); I used the table as written.

### Q11. A bare account name as the message of an intents deposit: mic:35
Five `ft_transfer_call` deposits into intents.near with `msg` such as `proofoffinger.near`.
- Reading A: the message is not JSON, so `msg_kind` is `not_json`.
- Reading B: intents.near accepts a plain account name as a deposit target, so `msg_kind` is `intents_deposit`.
- Used: B. The five beneficiaries are also counted for `NEW_RECIPIENT`.

### Q12. Removing a member lowers the votes needed: stader-nearx:94, sodax:11, subdued-snow:6
Removing a member changes the number of votes a ratio threshold asks for (3 of 5 becomes 2 of 4; 2 of 2 becomes 1 of 1; fallback rules in subdued-snow:6 also drop by one).
- Reading A: the threshold and quorum fields are unchanged, so `POLICY_LOWERS_THRESHOLD` does not fire; the removal is `POLICY_REMOVES_MEMBER`.
- Reading B: the effective threshold went down, so it fires (critical).
- Used: A, because the guide gives removals their own code at high.

### Q13. Description wording that is only partly right: indonesia:3
"Change voting threshold from 1 to 3": the new policy gives Admin 3 on twelve kinds, but five kinds lose their own rule and fall back to the default 1/2, which is 2 of 3 members.
- Reading A: `matches`, because the description names no kinds.
- Reading B: `contradicts` and `DESC_CONTRADICTS`, because five kinds do not reach 3.
- Used: A.

### Q14. A heading that looks like a token claim: shitzu:456
The description is a long list of links under the heading "ZEC:" and the transfer is 107000 SHITZU.
- Reading A: the heading is a campaign topic, so the description is `vague`.
- Reading B: it claims ZEC, which the SHITZU transfer contradicts.
- Used: A.

### Q15. A payload hash in the description that differs from the call: sssaazxczx:10
The description lists "Payload Hashes: fa5683..." while the sign call carries `52c9e6...`. These may be different digests of the same intent. A hash is not an amount, token, recipient or action, so no `DESC_CONTRADICTS`; the fact is in the notes and the check is `hidden`.

### Q16. Inputs I did not change: is_test
By section 2 these five look like test material (a name containing `qa`, or a payment under 5 USD) but carry `is_test: false`: bob:3 (about 2.4 USD), bulkaqa:7 (name contains `qa`), ergo-public:2 (about 0.22 USD), int-mnt-dao:33 (about 0.006 USD attached), o_lskik2:76 (about 0.006 USD attached). The sampler used a narrower rule, so I left them.
