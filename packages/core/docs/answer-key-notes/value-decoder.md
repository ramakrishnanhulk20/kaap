# Where the value decoder and the answer key differ

From the final run of `cargo test -p kaap-core --test value_eval -- --nocapture` on 29 Oct 2026,
over the 205 records of `eval/real` and `eval/planted` whose label holds only value-type effects.
Since 12 Nov 2026 five Burrow records also differ, by rule rather than spelling: Kaap reads them
more strictly than the key does (`engine-stricter-than-key.md`), and the counts below are 200,
200, 200 and 142.

| measure | agree | of |
|---|---|---|
| effects multiset, `defi_call` protocol compared in lower case | 205 | 205 |
| effects multiset, protocol case kept | 200 | 205 |
| owned codes | 205 | 205 |
| `must_veto` and `veto_allowed`, labels with no description, prompt or hash code | 147 | 147 |

## Records that differ

All five differ only in the spelling of one field. The guide fixes no spelling for `protocol`, and
the key writes `burrow` on 9 Burrow records and `Burrow` on these 5, so no decoder output can
agree with all 14. The scoreboard compares the field in lower case on both sides for that reason,
and prints the exact count beside it.

| record | field | key | decoder | which is right, and why |
|---|---|---|---|---|
| mainnet:burrow.sputnik-dao.near:1445 | `defi_call.protocol` | `Burrow` | `burrow` | Neither is wrong; the key should use one spelling. Lower case matches the other 9 and the guide's own lower-case names. |
| mainnet:burrow.sputnik-dao.near:1465 | `defi_call.protocol` | `Burrow` | `burrow` | As above. |
| mainnet:burrow.sputnik-dao.near:1499 | `defi_call.protocol` | `Burrow` | `burrow` | As above. |
| mainnet:burrow.sputnik-dao.near:1573 | `defi_call.protocol` | `Burrow` | `burrow` | As above. |
| mainnet:burrow.sputnik-dao.near:1654 | `defi_call.protocol` | `Burrow` | `burrow` | As above. |

## Readings the agreement rests on

These records agree, but each agreement depends on a reading the guide does not spell out. They
are listed so the reading can be ruled on, not only the result.

1. planted:23, 24, 25, 47 and 53 send tokens to `intents.near` with a message of the form
   `{"intents":[{"intent":"ft_withdraw", ..., "chain":"eth"}]}`. That is not the deposit message
   intents.near documents (`{"receiver_id", "execute_intents", "refund_if_fails"}`), so the real
   contract may refund the deposit. The decoder cannot prove a refund, so it reads the intents as
   executed (C2, worst plausible reading) and takes the stated `chain` as the destination chain.
   This is what the key labels.
2. planted:61 carries one `token_diff` intent with only a positive entry. The decoder reads a
   diff that gives nothing away as having no effect, so the deposit is `intents_deposit`, as the
   key says. A diff with a negative entry becomes an `unknown_call`.
3. mainnet:testing-astradao.sputnik-dao.near:588 withdraws a HOT token whose id starts `1117_`.
   The decoder names the chain `ton` from a table of HOT chain ids built from the census token
   list; an id not in it reads as `unknown`, which still fires CROSS_CHAIN_OUT.
4. No record makes a direct call on `v2.ref-finance.near` or `dclv2.ref-labs.near`, so the
   protocol names the decoder writes for them (`ref-finance`, `ref-dcl`) are not checked by the key.
