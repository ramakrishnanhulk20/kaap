# Where the description check and the answer key differ

From `cargo test -p kaap-core --test describe_eval -- --nocapture` and
`cargo test -p kaap-core --test eval -- --nocapture` on 2 Nov 2026, over the 373 records of
`eval/real` and `eval/planted` (guide v2.3 with rulings 28 and 29 of 2 Nov). Since 12 Nov 2026
PROMPT_INJECTION is high, so planted 44 and 46, whose only critical was that finding, floor at
high without `must_veto`, where the key says critical: `must_veto` agrees on 335 of the 337 labels
with no hash code (`engine-stricter-than-key.md`).

| measure | agree | of | bar |
|---|---|---|---|
| description_check | 353 | 373 (94.6%) | 93% |
| DESC_CONTRADICTS present or absent as the key says | 373 | 373 | 97% |
| PROMPT_INJECTION present or absent as the key says | 373 | 373 | 97% |
| `must_veto`, labels with no hash code | 337 | 337 | all |
| `must_veto`, all records (eval runner) | 367 | 373 | |
| real records where DESC_CONTRADICTS fires and the key is not `contradicts` | 0 | 599 | 0 |

The 599 real records are the 300 of `eval/real` and the 299 of the private second set. The 12 real
must-veto records and planted families n and o come out as the key says on `must_veto`, the risk
floor, the description check, DESC_CONTRADICTS and PROMPT_INJECTION. The six `must_veto`
differences on all records are planted 29 to 34, whose criticals are HASH_MISMATCH and
HASH_TEXT_DANGEROUS; `hash::check` was still a stub at this run (its own results are in
hash-checker.md).

## Records whose description check differs (20)

No record differs on DESC_CONTRADICTS or PROMPT_INJECTION. Nineteen of the twenty are `matches` in
the key and `vague` here: the key read a claim the plain code does not read with certainty, which
is left to the AI by design.

| record | key | check | which is right, and why |
|---|---|---|---|
| mainnet:builder-ops.sputnik-dao.near:14 | matches | vague | Both, by their own rules. "NEARN payment to Aaron Luhning" names a person; reading it as `aaron.near` is a guess the code does not make. |
| mainnet:linear.sputnik-dao.near:200 | matches | vague | As above: "Funds to deploy HOS airdrop contract" names the payee `linear-hos-airdrop.near` only in words. |
| mainnet:npro-admin.sputnik-dao.near:3 | matches | vague | As above: "Fund NPRO Liquidity DAO" for `npro-liquidity.sputnik-dao.near`. |
| mainnet:burrow.sputnik-dao.near:1499 | matches | vague | "adjust wNEAR interest to 0" on Burrow `update_asset`: no word of the text is a distinctive part of the method name, and the asset sits inside the arguments the DeFi effect does not carry. |
| mainnet:burrow.sputnik-dao.near:1573 | matches | vague | As burrow 1499 ("adjust delisted woo APY to 0"). |
| mainnet:burrow.sputnik-dao.near:1575 | matches | vague | As burrow 1499 ("adjust delisted lp_token APY to 0"). |
| mainnet:burrow.sputnik-dao.near:1634 | matches | vague | As burrow 1499 ("restore rnear APY to 12, 250"). |
| mainnet:hh.sputnik-dao.near:4 | matches | vague | The title is Ukrainian; the word lists are English only. |
| mainnet:ref-finance.sputnik-dao.near:839 | matches | vague | "PURGE-18 427002.836046378742904569" is exactly the amount at 18 decimals, but PURGE has no entry in the census token list, so Kaap does not know its decimals and does not read the number. |
| mainnet:sweat-multisig.sputnik-dao.near:14 | matches | vague | "Ship a stored blob as code for another contract": no list word for an upgrade. |
| mainnet:sweat-multisig.sputnik-dao.near:4 | matches | vague | "Change the fallback vote policy": "vote policy" is not read as a threshold claim, because planted 06 and 07 use the same words and the key calls them `vague`. |
| mainnet:templar.sputnik-dao.near:198 | matches | vague | The text names `ixlmdejaaa-ixlmusdc-2`, part of the receiver's name, not the account. |
| mainnet:templar.sputnik-dao.near:206 | matches | vague | The key's agreeing effect is a `sign_request` and a delegate-action `unknown_call`, which `hash::check` did not yet produce at this run, so there was no effect to agree with. |
| mainnet:templar.sputnik-dao.near:216 | matches | vague | As templar 206. |
| mainnet:petersalomonsendev.sputnik-dao.near:69 | matches | vague | "via v1.signer" agrees with a `sign_request` effect, which the hash check produces and did not yet at this run. |
| planted:62 | matches | vague | A `sign_request` with a supplied text; a hash check record (hash-checker.md). |
| planted:30 | hidden | vague | "Confidential request from external dApp." says nothing is hidden; the key reads it as hidden by design. A hash check record (hash-checker.md). |
| planted:05 | matches | vague | "Enable community participation in voting.": no list word ties it to the role it adds. |
| planted:64 | matches | vague | "Monthly bulk payroll to 25 contributors via the bulk payment contract" over an unknown `run_payout` call; "payroll" is generic (guide section 5). |
| planted:12 | vague | matches | "Add a redundant guard for resilience." leads with "add" and a member is added. The key calls the same shape `matches` in planted:09 ("Add a backup approver for continuity."); the check treats both alike. |

## Narrowed during the run

The first full run fired DESC_CONTRADICTS on 16 real records the key calls `matches` (testing-1212
#2 under two rules). Each rule was narrowed at its cause, not per record, and the final run fired
on none of the 599.

- 10 records, "a deposit is described and value leaves the DAO": the treasury app's 1Click
  exchange and payment texts carry a "* Deposit Address:" field, read as the verb "deposit", and
  pay that address; `mic` #10 pays a gas top-up to an account it names. Now value sent to a payee
  the text names counts as described (bob #3, houseofstake #39, lesik-o #11 and #18, mic #10,
  nearn-staging #160, staging-qa #172, testing-1212 #2, webassemblymusic-treasury #78,
  yurtur-treasury #43).
- 4 records, "the leading verb is not what the proposal does": `nep141:wrap.near` and a clause
  starting with `wrap.near` were read as the verb "wrap". Now a `:` starts a clause only before a
  space, and a clause that starts with a dotted or hyphenated name leads with no word (ergo-public
  #2 and #3, staging-qa #290, testing-1212 #2).
- 3 records, "the named recipient is not paid": int-mnt-dao #18, #20 and #33 name the account a
  bridge mint credits, which sits in a JSON `msg` inside the call's arguments. Now the strings of
  JSON nested in arguments count as accounts the proposal touches, read with `decode::json`.

## Two earlier tests, and one that ruling 28 changes

`tests/decoders.rs`, the first decoder tests, caught two errors in the first version, both fixed
here: a policy change measured without the policy before fed the control rules (guide section 7
says fire nothing that needs it), and a swap text's amounts were compared, though a swap names
amounts on both sides. One test there then failed by design:
`a_kind_the_policy_engine_decodes_gets_its_own_code` builds its input from planted:01, so a
RemoveMemberFromRole on an approver carries the text "Payroll run for October: 500 USDC to the
contributor pool.", which ruling 28 makes a contradiction. The fixture, not the rule, needed to
change; a later change gave `input_with_kind` a neutral description.

## Notes for guide v2.4

- Section 10 had numbered the 2 Nov rulings 26 and 27 a second time; they are now 28 and 29.
- Planted 09 and 12 give one text shape two labels (above).
