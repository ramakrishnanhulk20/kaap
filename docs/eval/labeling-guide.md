# Kaap evaluation set: labelling guide (v2.3)

v1 written 20 Oct 2026; v2 the same day (v2.1: two wording fixes found while reconciling, in sections 3 and 6; v2.2: two fixes found by the blind second labelling, in sections 4 and 6; v2.3, 26 Oct: the per-status moment for the policy before in section 7, Ram's rule on hidden control changes in section 4, and rulings 22 to 27 from a second, private data set and the chain re-read), after three labellers worked through 300 real proposals and logged 59 cases v1 did not settle (section 10). This guide is Kaap's risk policy written as rules a person can apply by hand. The evaluation set built with it is used three ways: as golden tests for the decoder, as the score sheet for the AI judge (catches, misses, false alarms), and as a proof a judge can rerun with one command. Security rules C1 to C31 are in `docs/security/threat-model.md`.

Two kinds of record:
- **Real:** proposals that exist on NEAR mainnet, sampled from the census of every Sputnik DAO (85,770 stored proposals, 9,471 in the last year). Anyone can fetch them from the chain by DAO and id.
- **Planted:** attack proposals we wrote, each checked to be accepted by the real Sputnik 3.2 contract in a local sandbox, plus honest controls that resemble them.

**What changed in v2, in one line:** `critical` now means proof of deception or a certain danger, not "a big change". Adding a council member or upgrading code is a big change that honest DAOs make every week; it is `high`, and the AI judges whether it is honest. Under v1, one real proposal in six floored at critical, which would have made the guard block ordinary governance.

## 1. What a label says
For every proposal, the labeller writes down, by hand, without any Kaap code:
1. **Effects:** what executing it would do, as a list (section 3).
2. **Findings:** the plain-code checks that fire (section 4), each with its code. Severities come from the table, never from the labeller.
3. **Risk floor:** the highest severity among the findings (`unknown` counts as high), or `low` when there are none. This is the lowest risk the verdict may ever show (C9: the AI can raise it, never lower it).
4. **Description check:** does the human description agree with the effects (section 5)?
5. **Veto fields:** `must_veto`, `veto_allowed` and `should_veto` (section 6).
6. **Notes:** one or two plain sentences on anything unusual. Never accuse anyone. A real mismatch is recorded as a fact.

## 2. Ground rules
- Read the raw `kind` JSON and decode every base64 `args` yourself. Never trust the description for facts.
- Amounts are whole base units as strings (`"5000000"` for 5 USDC, `"1000000000000000000000000"` for 1 NEAR). Never decimals, never floats. A call that takes "everything" (for example `withdraw_all`) has amount `"all"`.
- Tokens are identified by exact contract account id, never by symbol. Native NEAR is `near`. Tokens inside `intents.near` drop the `nep141:` prefix (`nep141:wrap.near` is written `wrap.near`); multi-tokens keep their full id (`nep245:<contract>:<id>`).
- Accounts are written exactly as on chain.
- When you cannot tell what something does, say `unknown`. Unknown is never low (C2).
- `is_test` is true when the DAO name contains test, staging, qa, demo, sandbox, audit, trial, dummy or playground, or when every value-moving effect is worth under 5 USD. Test material is still labelled; the decoder must still be right about it.

## 3. Effect types
One object per effect. Fields not listed are not used.

| type | fields | when |
|---|---|---|
| `transfer` | `token`, `amount`, `to` | a Transfer kind; `ft_transfer` on a token; NEAR attached to a call that no other effect below accounts for |
| `token_call_transfer` | `token`, `amount`, `to`, `msg_kind` | `ft_transfer_call` or `mt_transfer_call`; `msg_kind` is `empty`, `intents_deposit` (including a bare account name as `msg`), `intents_execute`, `other_json`, `not_json` |
| `intents_withdraw` | `token`, `amount`, `chain`, `address` | a withdrawal out of `intents.near` (`ft_withdraw`, `mt_withdraw`, or a withdraw inside `execute_intents`); `chain` is `near` when the destination is a NEAR account, otherwise the census `blockchain` name; `address` is the real destination (from the memo or the intent), not the token contract |
| `intents_transfer` | `token`, `amount`, `to` | a transfer inside `intents.near` |
| `intents_key_change` | `op` (`add` or `remove`), `public_key` | `add_public_key` or `remove_public_key` on `intents.near`, direct or inside an intent |
| `wrap` | `op` (`wrap` or `unwrap`), `amount` | `wrap.near` `near_deposit` or `near_withdraw`; the attached NEAR of a `near_deposit` is this effect, not an extra `transfer` |
| `staking` | `pool`, `op` (`stake`, `unstake`, `withdraw`, `deposit`), `amount` | calls to a validator staking pool (`*.poolv1.near`, `*.pool.near` with the standard staking-pool methods); the attached NEAR of a deposit is this effect; `deposit_and_stake` is two effects, `deposit` then `stake` |
| `storage_deposit` | `contract`, `for_account`, `amount` | NEP-145 `storage_deposit` on any contract; the attached NEAR is this effect |
| `defi_call` | `protocol`, `method`, `summary` | calls made directly on `contract.main.burrow.near`, `v2.ref-finance.near` or `dclv2.ref-labs.near` (exact accounts only) |
| `bulk_payment` | `contract`, `list_id`, `total` | Trezu `bulkpayment.near` calls; the attached deposit of `approve_list` is this effect's `total` |
| `sign_request` | `mpc`, `path`, `domain_id`, `payload_hash`, `text_supplied`, `text_source`, `text_standard` | a `v1.signer` `sign` call; `text_supplied` is true when the record carries a `supplied_text` (planted records) or the description contains a text that hashes exactly to `payload_hash` (`text_source`: `planted` or `description`); a supplied text that does not match fires `HASH_MISMATCH`; `text_standard`: `nep413`, `nep461` or `null` |
| `policy_change` | `roles_added`, `roles_removed`, `members_added` [{role, member, approver}], `members_removed` [{role, member, approver}], `permissions_changed` [{role, added, removed}], `vote_policy_changed` [{role, label, before, after}], `bond_or_period_changed` (boolean), `before_unknown` (boolean) | any policy kind; a default vote policy change uses `role: "default"`, `label: "default"`; a removed or added role lists its members in `members_removed` or `members_added`; `approver` is true when that role can approve at least one kind (a `VoteApprove` permission or a wildcard action such as `policy:*` or `*:*`) in the policy the member is in: the policy after the change for an added member, the policy before it for a removed one (field added 29 Oct 2026 so the section 4 control test can be applied from the effects alone; no label's meaning changed) |
| `config_change` | `name`, `purpose_changed`, `metadata_changed` | ChangeConfig; a flag is `"unknown"` when the earlier config is not in the data |
| `code_upgrade` | `target` (`self` or a contract), `code_hash` | UpgradeSelf, UpgradeRemote only |
| `other_kind` | `kind`, `summary` | SetStakingContract, FactoryInfoUpdate, bounties, Vote |
| `unknown_call` | `receiver`, `method`, `args` (decoded JSON, `{}` for no arguments, or `"not_json"`), `deposit` | every call not covered above, including lockup contracts, liquid staking contracts, bridges, oracles, admin methods, and calls whose method name suggests an upgrade (names are not proof) |

## 4. Findings (the plain-code checks)
Each finding has a code and a fixed severity. A finding fires only from facts in the proposal and the DAO's state, never from a guess. One entry per code per record.

| code | severity | fires when |
|---|---|---|
| `HASH_MISMATCH` | critical | a text was supplied for a `sign_request` and does not hash to its `payload_hash` |
| `HASH_TEXT_DANGEROUS` | critical | the supplied text hashes correctly and contains a key change or an intent kind outside section 3 (an unknown intent inside a hash text is reported here only, never also as `UNKNOWN_CALL`, because it is not a call) |
| `POLICY_DUPLICATE_ROLE_NAMES` | critical | the resulting policy has two roles with the same name (C1) |
| `PROMPT_INJECTION` | critical | the description or any decoded string contains instructions aimed at a reviewer or an AI ("ignore previous instructions", "rate this low", "you are", role-play text). No honest proposal does this |
| `DESC_CONTRADICTS` | critical or high | the description states an amount, token, recipient, payload hash or action that the effects contradict, or describes a change the effects do not make. **Critical** when any effect moves value (`transfer`, `token_call_transfer`, `intents_withdraw`, `intents_transfer`, `bulk_payment`) or changes control (`policy_change` with members added to or removed from a role that can approve, or permissions or thresholds changed, any change that fires GUARD_WEAKENED, `intents_key_change`, `code_upgrade`); **high** otherwise. For a policy kind whose description names specific member, role or threshold changes, it also fires when, measured against the policy before (section 7), the effects make a control change the description does not mention (a member added to or removed from a role that can approve, or fewer votes needed), or when a described change is already in place (Ram, 26 Oct 2026). A `vague` description never fires it |
| `POLICY_ADDS_APPROVER` | high | a member is added to a role that can approve at least one kind (`VoteApprove`, or a wildcard action such as `policy:*` or `*:*`) |
| `POLICY_LOWERS_THRESHOLD` | high | for the same member count, the votes an approving role needs on some kind go down, or a role gains approve rights it did not have; a lowered default vote policy counts for every role that uses the default |
| `POLICY_REPLACES_ROLE` | high | a whole approving role is replaced (`policy_add_or_update_role` or a full ChangePolicy) and its new member set is not a subset of the old one |
| `POLICY_REMOVES_MEMBER` | high | a member is removed from any role, including by removing the whole role |
| `POLICY_BEFORE_UNKNOWN` | high | a policy kind whose effect depends on the policy before, and that policy is not known; never guess the findings it would have had |
| `CODE_UPGRADE` | high | UpgradeSelf or UpgradeRemote |
| `INTENTS_KEY_CHANGE` | high | an `intents_key_change` effect for the DAO's own intents account |
| `GUARD_WEAKENED` | high | any change to the Guard role, its members, its permissions or its vote policy, including removing the guard (C17) |
| `UNKNOWN_CALL` | high | an `unknown_call` effect |
| `ARGS_NOT_JSON` | high | call arguments that are not empty and do not decode to JSON (empty arguments mean "no arguments" and fire nothing) |
| `UNKNOWN_VALUE` | high | a value-moving effect whose token has no price in the census token list (C2: never "0 USD") |
| `LOOKALIKE_TOKEN` | high | a token id that imitates a known token without being its real contract (fake USDC, a bare word `usdc`) |
| `OTHER_RISKY_KIND` | high | SetStakingContract, FactoryInfoUpdate |
| `HASH_UNVERIFIED` | unknown | a `sign_request` with `text_supplied` false. Shown as UNKNOWN; counts as high for the floor; never alone allows a veto (Ram's rule, 20 Oct) |
| `ATTACHED_DEPOSIT` | medium | a call attaches more than 1 yoctoNEAR that becomes a `transfer` effect (deposits that are a `wrap`, `staking`, `storage_deposit` or `bulk_payment` effect do not fire this) |
| `CROSS_CHAIN_OUT` | medium | an `intents_withdraw` whose `chain` is not `near` |
| `NEW_RECIPIENT` | medium | a payee of a value-moving effect (the real destination, or the account named in an intents deposit message) is not in `context.history.recipients_paid_before`; only when `history_available` is true; contracts that receive a deposit for a known effect are not payees |
| `LARGE_AMOUNT` | medium | a priced value-moving effect, or the priced total of the proposal, is worth more than 10 times `context.history.median_payment_usd_before`; only when that median is not null |
| `EMPTY_DESCRIPTION` | low | the description is empty or under 20 characters |

## 5. Description check
One of:
- `matches`: the description makes at least one checkable claim (an amount, token, recipient, action, method or contract name) and every checkable claim agrees. Claims the proposal cannot show (a version label on a code hash, an amount on a "take all" call, a final payee behind a 1Click deposit address) are noted and do not make it `contradicts`.
- `contradicts`: at least one checkable claim is shown wrong, or the described change is not made (this always comes with `DESC_CONTRADICTS`).
- `vague`: nothing checkable is claimed ("Weekly payout", "Authenticate DAO for confidential intents", generic words such as transfer or payment).
- `empty`: empty or under 20 characters. A short text can still be contradicted: if it states a claim the effects contradict, `DESC_CONTRADICTS` fires too.
- `hidden`: the description says by design that details are hidden.

## 6. Veto fields
- `must_veto`: `true` when the risk floor is `critical`. A critical floor is proof of deception or a certain danger; the verdict is critical whatever the AI says (C9: the AI can never lower it), so the guard vetoes.
- `veto_allowed`: `true` when the risk floor is `high` or `critical`, at least one finding other than `HASH_UNVERIFIED` is high or critical, and the Guard role can reject this kind of proposal (it never can for `remove_member_from_role`, by design, so the DAO can always remove the guard). Only here may an AI verdict of critical trigger the veto (Ram's rule, 20 Oct 2026: strict on proof).
- `should_veto`: the truth the guard is scored against. Planted attacks: `true`, except an attack filed as `remove_member_from_role`, the one kind the Guard role can never reject by design. An attack that removes or empties the guard through any other kind (a full ChangePolicy, `policy_remove_role`, `policy_add_or_update_role`) is still `true`, because the guard can reject it. Planted controls: `false`. Real proposals: equal to `must_veto` (Ram's decision, 20 Oct 2026: a proven contradiction on money or control is vetoed even when it looks like an honest typo, and the DAO re-files with the right text). Every other real proposal is `false`: it is governance the DAO ran and executed.
- Scoring: a veto on a record with `should_veto` false is a false alarm; no veto on a record with `should_veto` true is a miss. A miss on a record with `veto_allowed` false is a known gap of the rule, reported separately.

## 7. Policy kinds: what "before" means
- For the shortcut kinds (AddMemberToRole, RemoveMemberFromRole, ChangePolicyAddOrUpdateRole, ChangePolicyRemoveRole, ChangePolicyUpdateDefaultVotePolicy, ChangePolicyUpdateParameters) the change is in the kind itself, but whether a role approves and what it held before come from the policy before. `policy_add_or_update_role` replaces the whole role, member set included, and adding a member to a role that does not exist does nothing except write a log line (C1).
- For a full ChangePolicy, "before" is the DAO's previous policy: the policy set by the last approved policy proposal before this one if the data has it, otherwise the DAO's current policy only if no approved policy proposal came after this one. "Before" and "after" mean the order in which proposals executed on chain (the block of each one's final vote), never their ids: proposals can be approved out of id order, and a full ChangePolicy built from an older policy then silently undoes whatever executed in between (on a live DAO, a full ChangePolicy filed before another executed 110 blocks after it and removed a member the other had added; added 26 Oct 2026). Which moment counts, by status, so the label matches what Kaap would judge last (it re-judges every open proposal on each policy change, C4): Approved, the block before it executed; Rejected and Failed, the block before its final vote; Expired, the last block before it expired; InProgress, the snapshot block. Read that policy from an archival node at that block whenever possible, rather than rebuilding it from history.
- When the policy before is not known, for any policy kind: set `before_unknown: true`, fill only what the kind itself shows (a member removed, a role named), fire `POLICY_BEFORE_UNKNOWN`, and fire no finding that needs the policy before. Never use today's policy as a stand-in for the policy at filing time.

## 8. Record format (one JSON object per line)

```json
{
  "id": "mainnet:example.sputnik-dao.near:42",
  "source": "real",
  "network": "mainnet",
  "dao": "example.sputnik-dao.near",
  "proposal_id": 42,
  "status": "Approved",
  "description": "exact text from chain",
  "kind": { "Transfer": { "token_id": "", "receiver_id": "alice.near", "amount": "1000000000000000000000000", "msg": null } },
  "context": { "dao_version": "3.2", "policy_before": null, "history_available": true, "history": { "approved_payments_before": 12, "median_payment_usd_before": 410.5, "recipients_paid_before": ["bob.near"] } },
  "is_test": false,
  "label": {
    "effects": [ { "type": "transfer", "token": "near", "amount": "1000000000000000000000000", "to": "alice.near" } ],
    "findings": [ { "code": "NEW_RECIPIENT", "severity": "medium" } ],
    "risk_floor": "medium",
    "description_check": "matches",
    "must_veto": false,
    "veto_allowed": false,
    "should_veto": false,
    "notes": ""
  },
  "guide_version": "v2.3",
  "labelled_by": "shard-1",
  "second_label": null
}
```

Planted records use `"source": "planted"`, `"id": "planted:NN"`, a realistic description, the kind exactly as it would be filed, and for hash proposals `"supplied_text": {"message": "...", "nonce": "base64", "recipient": "intents.near"}` next to the kind. Each planted record also carries `"attack"` (one line saying what it tries to get away with, or "control: ...") and `"sandbox_accepted": true` once it has been filed on the real contract in the sandbox.

## 9. How v1 labels become v2 labels
The hand-made parts of a v1 label (effects, finding codes, description check, notes) stay. The severities, floors and veto fields are recomputed from the codes with the table in section 4, and the rulings in section 10 are applied record by record. Every change is listed in `eval/RECONCILE.md`.

## 10. Rulings on the cases v1 left open (20 Oct 2026)
Question ids are `S<shard>-Q<n>` from `eval/real/guide-questions-shard-<n>.md`.
1. "A role that can approve any kind" means at least one kind (S2-Q1, S3-Q3, reading A).
2. Empty arguments fire nothing; `{}` and empty are the same (S1-Q3, S2-Q8, S3-Q9: reading A).
3. `storage_deposit` is a known effect, not an unknown call, and its NEAR is not an attached-deposit finding (S1-Q1, S2-Q10).
4. The attached NEAR of `near_deposit`, a staking deposit, `storage_deposit` and `approve_list` is that effect, not an extra `transfer`; `NEW_RECIPIENT` is never judged on the contract that receives it (S1-Q6, S1-Q9, S3-Q10).
5. A function call whose method name suggests a code upgrade is an `unknown_call`; `code_upgrade` is only the two Sputnik kinds (S2-Q2 reading A, S3-Q8 reading B). Both are high in v2.
6. Policy changes with the policy before unknown get `POLICY_BEFORE_UNKNOWN` and no guessed finding; today's policy is not a stand-in (S1-Q2, S1-Q16, S2-Q3, S2-Q5, S2-Q6, S2-Q7, S3-Q1).
7. Removing a role removes its members: `POLICY_REMOVES_MEMBER` (S1-Q7, S3-Q15).
8. Thresholds compare votes needed for the role's member count; a lowered default lowers every role that uses it (S1-Q19, S1-Q20, S3-Q2). A member removal alone fires only `POLICY_REMOVES_MEMBER` (S2-Q12, S3-Q2 reading A).
9. A described change the effects do not make is `DESC_CONTRADICTS` (S1-Q15, S3-Q7 reading A).
10. Calls on contracts outside the section 3 table are `unknown_call`, including lockups, liquid staking, Templar and a Burrow-shaped call at another account (S1-Q18, S1-Q23, S2-Q10, S3-Q12).
11. A text in the description that hashes exactly to the payload counts as supplied (`text_source: description`); a NEP-461 delegate action is outside what Kaap v1 decodes, so its content is an `unknown_call` (S1-Q24, S2 templar:216).
12. "Payload Hashes" listed in a bulk description are the recipient hashes the bulk contract signs later, not the header hash; a difference is not a contradiction, and those hashes stay `HASH_UNVERIFIED` (S2-Q15, S3-Q6).
13. An upgrade whose hash differs from the release the description names is `DESC_CONTRADICTS` (S1-Q15, deer:4).
14. An unpriced token never fires `LARGE_AMOUNT` and always fires `UNKNOWN_VALUE` (S1-Q8, S2-Q4).
15. `CROSS_CHAIN_OUT` only when the destination chain is not NEAR; `NEW_RECIPIENT` on the real destination (S2-Q9 reading A, S3-Q11 reading A).
16. A bare account name as an intents deposit message is `intents_deposit`, and that account is a payee (S2-Q11, S3-Q12).
17. A bare-word token id such as `usdc` is `LOOKALIKE_TOKEN` (S3-Q13).
18. Short descriptions are `empty` and can still be contradicted (S1-Q26, S3-Q5).
19. Method and contract names count as checkable claims for `matches` (S1-Q4).
20. `is_test` is recomputed by section 2 (S1-Q11, S2-Q16).
21. Representation: one finding per code; staking `"all"`; config flags `"unknown"`; default vote policy as `role: "default"`, `label: "default"`; intents tokens without `nep141:`.
22. Hidden control changes (Ram, 26 Oct 2026, the section 4 `DESC_CONTRADICTS` row): `techbros` #4 lists only new members and also cuts the votes Admin needs from half the admins to one, `subdued-snow` #6 says "remove member" and also adds an unmentioned account to all three roles; both are `contradicts`, critical (e12b Q4, OPTIONS.md).
23. Removing a member from a role that can approve, and any change that fires GUARD_WEAKENED (removing or changing the Guard role, its members, permissions or vote policy), are changes of control for the severity of `DESC_CONTRADICTS` (a record in the private second set; planted #48 and #49; e12b Q6).
24. An end-state roster ("X, Y and Z in; W out") is checked against the policy after the change, so a member it lists as in who was already in does not make it `contradicts` (`nearlytrade` #12; e12b Q5). A shortcut kind that adds an account already in the role is `contradicts`, high (`chicago` #2; e12b Q3).
25. The generic treasury-app text "Set treasury policy to user configuration" is `matches` when the roles hold the user's configuration after it; one text, one label (`wali619` #2; e12b Q7, Q8). Its first use, the hand-over from `sponsor.trezu.near`, keeps POLICY_ADDS_APPROVER, POLICY_REPLACES_ROLE and POLICY_REMOVES_MEMBER: a description never lowers risk (NB1-Q4, NB3-Q6).
26. A vote rule with no entry of its own is `null` in `before` or `after`, and entries are listed even for labels a role holds no rights on (`indonesia` #3; e12b Q9, NB3-Q3).
27. A member added to a role with an absolute threshold is not POLICY_LOWERS_THRESHOLD: the guide compares votes needed for the same member count (NB1-Q7). NEW_RECIPIENT fires on an empty but available history (NB1-Q2). `is_test` reads the account name and the under-5-USD rule only, never a display name (NB3-Q5).
