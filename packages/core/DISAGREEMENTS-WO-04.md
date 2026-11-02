# WO-04 hash checker: where the code and the answer key differ

Run on 2 Nov 2026 with `cargo test -p kaap-core --test hash_eval -- --nocapture` over the 42 records a `sign` call or a hash text decides: the 32 real records whose kind calls `sign` on `v1.signer`, planted families i, j and k (26 to 34), and the auth control #62.

| field | agree | of |
|---|---|---|
| finding codes | 42 | 42 |
| risk floor | 42 | 42 |
| must_veto | 42 | 42 |
| veto_allowed | 42 | 42 |
| effects | 42 | 42 |
| description check | 40 | 42 |

No record differs on a finding code, the floor or a veto field. The notes below are for the head chef to rule on. None of them is a change to the key made by the cook.

## 1. The planted texts' deadline form (Q3 ruling, 2 Nov 2026)

Every planted hash text (29 to 34 and 62) writes `"deadline":{"timestamp":1790000000}`. The NEAR Intents verifier reads only an RFC 3339 string (`reference/tech/intents/docs/integration__verifier-contract__signing-intents.md` lines 42 to 52, `intent-types-and-execution.md` line 55), so it would refuse these texts. As ruled, `hash::text::deadline_ns` reads that form second, after the RFC 3339 string. It can only keep a text in the analysis, never lower a finding, and `hash_attacks.rs` `the_planted_deadline_form_is_read_and_judged` pins it. 1790000000 is 21 Sep 2026 14:13:20 UTC, a month before the records were filed. The eval has no block time, so the deadline is not judged there. Against any real block from 20 Oct on, all seven texts would count as passed. The head chef logs regenerating them with ISO deadlines as a separate item.

## 2. Description check on two planted records (owned by `describe`, WO-03c)

- `planted:30` "Confidential request from external dApp.": key `hidden`, Kaap `vague`. The text does not say details are hidden, so `describe` does not read it as `hidden`.
- `planted:62` "Authenticate DAO for confidential intents.": key `matches`, Kaap `vague`. Guide section 5 names this exact text as `vague`, and the key labels it `vague` on `planted:32` and on 7 real records. One text has two labels in the key.

Neither changes a code or the floor. This order does not touch `describe`.

## 3. Texts the key does not hold, decided by the rules, for the head chef to know

- Trezu's bulk sub-account auth text (sign path `""`, `signer_id` `<prefix>.bulk-payment.near`) is HASH_TEXT_DANGEROUS if a member ever supplies it. C6 requires the path and the signer to be the DAO. Without a text it stays HASH_UNVERIFIED, as the key has it for the 7 real records of that kind.
- `token_diff`, `native_withdraw`, `storage_deposit`, `auth_call`, `set_auth_by_predecessor_id` and every other intent kind outside guide section 3 are HASH_TEXT_DANGEROUS inside a hash text, with an `unknown_call` on the verifier and no UNKNOWN_CALL (guide section 4). An honest swap signed as a `token_diff` would come out critical.
- Recipients modelled: `intents.near` and `intents.far` (the confidential shard NEAR Business and Trezu sign for). Any other recipient, `staging-intents.near` included, is a refusal.
