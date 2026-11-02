# WO-03b2: the guard account, other accounts that reject alone, and the earlier config

## The scoreboard did not move

`cargo test -p kaap-core --test policy_eval -- --nocapture`, run on 2 Nov 2026 after every change
in this order:

| measure | agree | of |
|---|---|---|
| owned codes | 129 | 129 |
| risk floor, labels with no description, prompt or hash code | 97 | 97 |
| `must_veto`, same records | 97 | 97 |
| `veto_allowed`, same records | 97 | 97 |
| effects multiset (not held to a bar) | 118 | 129 |

The eleven records that differ are the same eleven, for the same reasons, as in
DISAGREEMENTS-WO-03b.md. The evaluation runner fills neither new input (`tests/common/mod.rs` sets
both to `None`), so this is the "not known" path, which behaves exactly as before.

mainnet:hh.sputnik-dao.near:4 and planted:65 still show both config flags as `"unknown"` on the
scoreboard, because the key holds no earlier config. With an earlier config supplied, both records
give exactly the key's effects (`config_flags_compare_with_the_config_before`):

| record | earlier config used | flags |
|---|---|---|
| mainnet:hh.sputnik-dao.near:4 | rebuilt from the label's note: the same name and purpose, metadata with primaryColor #3B82F6 where the new one has #000000 | purpose false, metadata true, as the key |
| planted:65 | name "Kaap", purpose "A test DAO", metadata empty | purpose true, metadata false, as the key |

## Readings the new code rests on

1. GUARD_WEAKENED with the guard account known fires when, on some label, the account's one
   VoteReject decided a fresh proposal before and no longer does, or the account could cast a
   VoteReject before and holds that right through no role after. "A label it could reject before"
   in the second part is read as "could cast a VoteReject on", since "could reject alone" would
   make it a repeat of the first part. Both sides use `arming`'s own rules (`one_reject_decides`
   and `may_reject`), so these two conditions and `guard_arming` never disagree about one policy.
2. With the account known, the guide's "any change to the Guard role" still holds (head chef
   ruling, 2 Nov 2026). "The Guard role" is every role that names the guard account as a Group
   member, before or after the change, matched by name. GUARD_WEAKENED fires when the roles of any
   such name differ at all: members, permissions, own vote rules, kind, or a role of the name added
   or removed. So rules of their own at "1" on the harness guard role fire it although every reject
   stays the same, and a second member in a guard role on a fixed "1" fires it although the guard
   still decides alone (both tested). The two reject conditions of reading 1 still apply on top. A
   role called `guard` that does not hold the account is an ordinary role: editing it does not fire
   (tested), where the role-name rule would.
3. A Member role is taken to match the guard account before and after the change (any delegated
   balance), as `guard_arming` takes it. A guard whose reject also counts through a Member role or
   a token-weighted rule never decides alone, so it cannot lose that, and its plain VoteReject
   right through the Member role counts as kept.
4. With no policy before, the roles holding the account are not known. The role-name rule still
   applies, and a RemoveMemberFromRole that names the guard account also fires GUARD_WEAKENED.
5. `others_who_reject_alone` takes its candidates from the Group roles only. An account outside
   every Group role votes only through an Everyone role, which Sputnik never lets decide (policy.rs
   405), or through a Member role, where the outcome depends on balances no policy holds. An
   account whose reject also counts through a token-weighted rule or a Member role is not listed
   either. Only labels in `rejects_alone` are reported.
6. The config before is read by the same strict reader as the new config: an object with exactly
   `name`, `purpose` and `metadata`. Anything else leaves both flags `"unknown"`. Each flag is then
   worked out on its own: `purpose` compared as text, `metadata` compared as the bytes its standard
   padded base64 stands for (near-sdk's `Base64VecU8`), and a field that does not read on either
   side leaves only that flag `"unknown"`. `purpose` reads only as a string, `metadata` only as a
   base64 string. Tested on the config before with a number, null, list and object in `purpose` and
   those plus a boolean in `metadata`, and on the new config with a number in `purpose` and null or
   text that is not base64 in `metadata`.

## What the Sputnik binary showed

`cargo test -p kaap-core-diff guard_arming -- --nocapture --test-threads=1` inside WSL, with no
neard running first, on Sputnik 3.2 (code hash DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF):
"4 policies, 0 disagreements", 1 passed in 169 s.

On M1 with a second member in the guard role, `others_who_reject_alone` lists
second-guard.kaap-diff on all 16 labels the guard rejects. Its one VoteReject, on a fresh
proposal of its own, gave Rejected on 14 of them, and on bounty_done the deciding vote panicked
with ERR_NO_BOUNTY, the harness's sign of a decided bounty_done. That is every label someone may
file; nobody on M1 may file a Vote kind, so `vote` is checked by the formula only. On the other
three policies the list is empty, so nothing more was sent.
