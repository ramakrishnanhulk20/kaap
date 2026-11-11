# Where the policy engine and the answer key differ

From the final run of `cargo test -p kaap-core --test policy_eval -- --nocapture` on 29 Oct 2026,
over the 129 records of `eval/real` and `eval/planted` whose kind is a policy or governance kind
(every Sputnik kind except Transfer and FunctionCall). 97 of them carry no description, prompt or
hash code.

| measure | agree | of |
|---|---|---|
| owned codes | 129 | 129 |
| risk floor, labels with no description, prompt or hash code | 97 | 97 |
| `must_veto`, same records | 97 | 97 |
| `veto_allowed`, same records | 97 | 97 |
| effects multiset (not held to a bar) | 118 | 129 |

## Records that differ

All eleven differ in effects only. No code, floor or veto field differs.

| record | field | key | engine | which is right, and why |
|---|---|---|---|---|
| mainnet:hh.sputnik-dao.near:4 | `config_change` flags | `purpose_changed: false`, `metadata_changed: true` | both `"unknown"` | The key is right about the chain: the labeller compared with the DAO's proposal 3. The config before is not part of `ProposalInput`, so the engine cannot know either flag and writes `"unknown"` (guide section 3, ruling 21). Agreement needs the earlier config in the input. |
| planted:65 | `config_change` flags | `purpose_changed: true`, `metadata_changed: false` | both `"unknown"` | As above; the record has no earlier config at all. |
| planted:04 | `vote_policy_changed` | before `"1/2 of group"`, after `"1/100 (one vote)"` | before `null`, after the full rule as JSON | The engine. The key writes shorthand text, and the council had no transfer rule of its own before (it used the default), which ruling 26 writes as `null`. |
| planted:60 | `vote_policy_changed` | before `"1/2"`, after `"3/4"` | before `null`, after the full rule as JSON | As planted:04. |
| planted:06 | `vote_policy_changed` | `"1/2"` to `"1/100"` | the two default rules as JSON | Same change; the key writes shorthand text, the engine writes the rule the way `get_policy` returns it. |
| planted:07 | `vote_policy_changed` | `"1/2"` to `"1/100"` | the two default rules as JSON | As planted:06. |
| planted:46 | `vote_policy_changed` | `"1/2"` to `"1/100"` | the two default rules as JSON | As planted:06. |
| planted:08 | `permissions_changed` | none | council: `*:*` added; `*:AddProposal`, `*:Finalize`, `*:VoteApprove`, `*:VoteReject`, `*:VoteRemove` removed | The engine. The replacement role holds `*:*`, which also grants RemoveProposal and MoveToHub, rights the old council did not have. |
| planted:09 | `permissions_changed` | none | as planted:08 | As planted:08. |
| planted:10 | `permissions_changed` | none | as planted:08 | As planted:08. |
| planted:11 | `permissions_changed` | none | council: `*:*` added | A reading. The engine lists every permission held under a role name across its duplicates; the second council role holds `*:*`, and Sputnik gives each account the permissions of the last council role it matches. |

## Readings the agreement rests on

These records agree, but each agreement depends on a reading the guide does not spell out.

1. A role name counts every role of that name. Holders, permissions and `approver` are taken over
   all of them, and vote rules from the first, as Sputnik reads them (policy.rs 374-376). An extra
   role of a name is written in `roles_added` as `<name> (duplicate)`, as the key writes planted:11
   to 13.
2. `approver` and "an approving role" mean a permission whose action part is `VoteApprove` or `*`
   (ruling 1), counting a permission Sputnik would ignore, so it errs toward naming an approver.
   POLICY_LOWERS_THRESHOLD's "gains approve rights" uses Sputnik's exact four patterns instead.
3. POLICY_LOWERS_THRESHOLD compares both rules at the member count after the change (Q20,
   techbros:4: 6 members, 4 votes before, 1 after). A new role name that can approve counts as
   gaining rights. A rule that counts tokens is compared rule against rule and errs toward
   "lowered"; no record in the key uses tokens, so that branch is not checked by the key.
4. POLICY_REPLACES_ROLE fires for a full ChangePolicy or `policy_add_or_update_role` when a role
   name that can approve, before or after, ends up covering anyone it did not cover. A Group turned
   into Everyone or a token role counts as a replacement.
5. GUARD_WEAKENED is keyed on the role name `guard` (the enrolment template's name), since the
   input carries no guard account. A known gap, pinned by the test
   `known_gap_a_guard_role_under_another_name_gets_no_guard_weakened`; the guard account input,
   when supplied, closes it (guard-account-and-config.md). A change of the default vote policy
   fires it only when the guard then needs more votes on a label it can reject, which is why
   planted:06, 07 and 46 (default lowered to 1/100) agree with the key.
6. `bond_or_period_changed` is true only when one of the four values really differs.

## What the Sputnik binary showed

Run with `cargo test -p kaap-core-diff -- --nocapture --test-threads=1` in a local sandbox on
Sputnik 3.2 (code hash DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF).

1. On the testnet demo DAO's policy one guard reject gives Rejected on every label someone may
   file except remove_member_from_role, where the binary refuses the vote (ERR_PERMISSION_DENIED).
   That is 15 of the guard's 16 labels: nobody on the demo DAO may file a Vote kind, so `vote` is
   checked by the formula only.
2. A second member in the demo DAO's guard role leaves the guard armed. Its rule is the fixed
   weight "1", and Sputnik's threshold is min(1, 2) = 1, so one reject still gives Rejected on all
   15 labels someone may file (nobody may file a Vote kind there). A second member in a guard role
   on the default 1/2 ratio disarms it: one reject leaves every proposal InProgress.
   `guard_arming` agrees on all 4 policies tried, 0 disagreements.
