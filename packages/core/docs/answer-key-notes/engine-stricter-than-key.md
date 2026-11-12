# Where Kaap now rates records differently from the answer key

From 12 Nov 2026 Kaap's rules engine rates some records more strictly than answer key v2.3 does,
and two planted attacks less strictly, on purpose. The key and the labelling guide stay as they
are: the scoreboards keep measuring against them, and every record that moved is named here and
beside the pinned counts in `tests/value_eval.rs`, `tests/describe_eval.rs` and
kaap-core-wasm's `tests/api.rs`.

Measured with `cargo test -p kaap-core -p kaap-core-wasm` over the 373 records of `eval/real` and
`eval/planted`, before and after the change. Nine records moved; none of the 299 records of the
private second set moved.

## Records that moved

| record | before | after | label |
|---|---|---|---|
| mainnet:burrow.sputnik-dao.near:1395 | `defi_call`, no finding, low | `unknown_call`, UNKNOWN_CALL, high, `veto_allowed` | `defi_call`, no finding, low |
| mainnet:burrow.sputnik-dao.near:1399 | as above | as above | as above |
| mainnet:burrow.sputnik-dao.near:1465 | as above | as above | as above |
| mainnet:burrow.sputnik-dao.near:1499 | as above | as above | as above |
| mainnet:burrow.sputnik-dao.near:1634 | as above | as above | as above |
| planted:44 | PROMPT_INJECTION critical, floor critical, `must_veto` | PROMPT_INJECTION high, floor high, no `must_veto`, `veto_allowed` | critical, `must_veto` |
| planted:46 | PROMPT_INJECTION critical beside POLICY_LOWERS_THRESHOLD, floor critical, `must_veto` | PROMPT_INJECTION high, floor high, no `must_veto`, `veto_allowed` | critical, `must_veto` |
| planted:45 | PROMPT_INJECTION critical, floor critical, `must_veto` | PROMPT_INJECTION high; floor critical and `must_veto` from DESC_CONTRADICTS | critical, `must_veto` |
| planted:47 | as planted:45 | as planted:45 | as planted:45 |

All nine now differ from the label somewhere: the five Burrow records in their effect, finding,
floor and `veto_allowed`; planted 44 and 46 in their floor and `must_veto`; planted 45 and 47 only
in the severity of PROMPT_INJECTION, which the scoreboards do not compare one by one. Counts after
the change: value effects 200 of 205, value codes 200 of 205, value veto fields 142 of 147, and
`must_veto` on labels with no hash code 335 of 337.

## Why, change by change

**A hidden grant of approval power.** A description that names one change and hides a new
approving role, or a token role opened to all, used to be a contradiction at high only, because
no effect field records such a grant. Kaap now also counts the findings measured on the policy
before and after (POLICY_ADDS_APPROVER, POLICY_LOWERS_THRESHOLD, POLICY_REPLACES_ROLE,
GUARD_WEAKENED) as control, so the contradiction is critical, and a replaced approving role is one
more change a text that names specific changes must mention. No record of the key or of the
private set moved.

**A bounty payout.** BountyDone pays its receiver a token and an amount held in the DAO's state,
not in the proposal, so Kaap cannot size it. It now carries UNKNOWN_VALUE, high, like any payment
Kaap cannot price; the guide's table fires nothing on bounties. The key holds no BountyDone.

**Calls to the three DeFi accounts.** Every method on Burrow, Ref and Ref DCL used to be a DeFi
call with no finding. Now only calls whose own contract code shows they pay nobody but the DAO are,
read in Burrow's published source: limits and capacity flags, an asset update that names no
beneficiary, and `execute` with only withdrawals to the caller. `add_asset_farm_reward` hands
reserved tokens to a farm that pays other accounts, and an `update_asset` that names a beneficiary
gives that account a share of the interest Burrow reserves, so the five Burrow records above are
unknown calls, high. Ref and Ref DCL publish no source at a commit Kaap can pin, so every call on
them is an unknown call; the key has none.

**A quote's second payee.** A verified 1Click quote also names who is refunded when the swap
fails. When that is not the DAO, it is judged as a payee, with NEW_RECIPIENT when it was never paid
before. The key carries no quotes.

**Prices with no payment history.** A price clears UNKNOWN_VALUE while NEW_RECIPIENT and
LARGE_AMOUNT need the history, so prices alone let a payment of any size to a stranger read low.
The rule sits at the door every caller outside the sealed job uses, kaap-core-wasm's `analyze`,
which drops prices given with no history; the sealed job already reads both or neither. The
scoreboards judge through kaap-core directly, so they do not move; through the door, planted 57,
58, 61, 67, 68, 72 and 73 would read high.

**A supplied text that verifies nothing.** The instruction-words check used to read a supplied
text even when it hashed to none of the proposal's payloads, so anyone's text could add a critical
finding. It is now read only when it verifies a payload of this proposal; HASH_MISMATCH still
reports an unmatched text. The key's supplied texts all match, and none moved.

**Instruction words alone.** PROMPT_INJECTION is now high, not critical: wording alone never
causes a veto. Words addressed to a model still alert every member and allow a veto on a verified
AI answer, and a proposal they appear in still floors at critical when another finding proves a
deception, as planted 45 and 47 do. The four records above are the planted instruction-words
family, all attacks; no honest record in either set was ever critical because of instruction
words alone, and the engine fires PROMPT_INJECTION on no real record.
