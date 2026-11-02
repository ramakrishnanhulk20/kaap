# WO-04b honest NEAR Business texts: where the code, the order and the sources differ

Built on 2 Nov 2026. Trezu was read one file at a time through `gh api` at `NEAR-DevHub/trezu` main 7b063dd (30 Oct 2026). The verifier was read at `near/intents` main d340060 (21 Oct 2026). Mainnet was read with views only.

## 1. Where each text comes from (DONE MEANS 1)

Trezu builds only its two login texts itself. Every money text (payment, swap, bulk leg) comes from 1Click's `/v0/generate-intent`, which Trezu passes through and hashes (`nt-be/src/handlers/intents/confidential/generate_intent.rs` 90-108, `bulk_payment_prepare.rs` 239-255). As ruled, those texts are built from the 1Click and NEAR Intents docs instead. All are in `tests/fixtures-trezu/texts.json`, each with its source, and `tests/hash_trezu.rs` reads each one.

| text | source | Kaap reads it as |
|---|---|---|
| swap | 1Click swap_transfer example, `reference/tech/intents/docs/integration__distribution-channels__1click-api__quickstart__signed-intent-execution.md` 68-75 | `intents_swap`, no finding |
| NEAR withdrawal | `NativeWithdraw`, near/intents `contracts/defuse/core/src/intents/tokens.rs` 436-439; docs `integration__verifier-contract__intent-types-and-execution.md` 270 | `intents_withdraw` near, near, receiver |
| storage registration | docs `integration__verifier-contract__intent-types-and-execution.md` 315-345 | `storage_deposit`, no finding |
| bulk-payment login | Trezu `nt-be/src/handlers/intents/confidential/prepare_auth.rs` 92-202, signer from `nt-be/src/handlers/treasury/confidential_setup.rs` 266-294 and `nt-be/src/utils/env.rs` 126-129 | `sign_request` alone, no finding |
| DAO login | Trezu `prepare_auth.rs` 92-187 | `sign_request` alone, no finding (read before this order too) |
| Trezu's own samples | `nt-be/examples/fixtures/signed_confidential_intent.json` 3-8 (signed for real), `nt-fe/e2e/fixtures/confidential-intent.json` 4-8, `sandbox/sandbox-init/src/mock_server.rs` 129-160 | `intents_transfer` to the deposit address, no finding (read before this order too) |

## 2. What the sources do not settle

- **A two-token `token_diff` is documented, not observed.** 1Click's docs show generate-intent swap_transfer returning a `token_diff`. Every Trezu sample is a same-token wNEAR `transfer` to a deposit address. NEAR Intents issue #383 (open since 18 Oct, `reference/tech/intents/repo.md`) reports that confidential cross-token swaps fail on every route. So no text exists yet that proves 1Click's shape for a Trezu swap.
- **The bulk sub-account is `<prefix>.bulkpayment.near`, not `.bulk-payment.near`.** Trezu derives `<prefix>.<BULK_PAYMENT_CONTRACT_ID>`, and that setting defaults to `bulkpayment.near`. Mainnet confirms it: `kmxv7.bulkpayment.near` `get_bootstrap_status` is Ready at block 222705041. `bulk-payment.near` does not exist at block 222705043, and `kmxv7.bulk-payment.near` does not exist at block 222705039. The hyphenated name comes only from a doc comment (`confidential_setup.rs` 300). `.bulk-payment.near` is an attack case in `hash_trezu.rs`.
- **Trezu's mock signer.** The mock 1Click copies the request's `signerId` into `signer_id`, and Trezu sends that as `near:<dao>` (`generate_intent.rs` 21, 49-51). A text built exactly as the mock builds it is SignerNotTheDao, so HASH_TEXT_DANGEROUS, and the verifier could not run it either. The fixture uses the bare DAO, which is what 1Click writes in the signed sample.

## 3. Choices made in the code

- **An empty `msg` counts.** A withdrawal with any `msg`, the empty string included, adds the `unknown_call` on the receiver. The order said "non-empty", but the verifier runs `ft_transfer_call` whenever `msg` is present (`is_call` is `msg.is_some()`, `tokens.rs` 177-181; `nep141/withdraw.rs` 141-149; `nep245/withdraw.rs` 185-203). The rule applies to both paths, because the hash path reads withdrawals through `decode::intents`.
- **The direct withdraw methods pay no storage deposit.** The `ft_withdraw` and `mt_withdraw` methods set `storage_deposit: None` (`nep141/withdraw.rs` 27-50, `nep245/withdraw.rs` 32-58). So the `storage_deposit` field is read only on an intent (signed, or inside `execute_intents` or a deposit message). On a direct method call it is ignored.
- **`token_diff` shape.** Kaap reads exactly `intent`, `diff`, an optional string `memo` and an optional account `referral`. Neither of the last two moves anything (`token_diff.rs` 30-39, 42-104). Kaap refuses an empty diff, a zero entry (the verifier refuses both, 52-62), a sign other than one leading `-`, and more than 127 bits.
- **`storage_deposit` shape.** The account field may be `deposit_for_account_id` or its alias `account_id` (`tokens.rs` 480-488), but not both at once.
- **`native_withdraw` shape.** Exactly `receiver_id` (an account) and `amount`.
- **Swap value.** The tokens a swap gives are valued by the same `decode::value` reading as the rest of the text: each is read as a deposit back into intents.near with no payee. They give UNKNOWN_VALUE, count toward LARGE_AMOUNT and LOOKALIKE_TOKEN, and never give NEW_RECIPIENT. The tokens a swap receives are named but not priced. A token is named by decode's own reader (`hash::intents::guide_name`).
- **One reading of the whole text.** The text is decoded once, and that reading must equal what each intent gave when read alone. Anything else makes the text HASH_TEXT_DANGEROUS, a text that gives more than 99 tokens in its swaps included.
- **The 0.1 NEAR allowance has one home.** It lives in `hash::intents::STORAGE_ALLOWANCE_YOCTO` and `storage_excess`, because `decode::intents` is a private module. `decode/intents.rs` imports it from there. The excess is a `transfer` of `near` to the contract.
- **`intents_swap` moves value** (`severity::moves_value`), so DESC_CONTRADICTS on a swap is critical. `describe::compare::touched` names a swap's tokens and `intents.near`.

## 4. Scoreboards

Before any change (2 Nov, WSL, `CARGO_TARGET_DIR=~/kaap-target-03b`): hash_eval 42/42 on finding codes, floor and must_veto; policy_eval 129/129 and 97/97; describe_eval 356/373, 373, 373, 337/337, with 0 false fires in 599; value_eval 205/205 and 147/147. These are the order's numbers.

After the change, `cargo test -j 2 -p kaap-core -p kaap-sealed --no-fail-fast -- --nocapture` passed: 248 tests in 36 binaries, 0 failed, 0 warnings, `hash_trezu` 14 and `value_withdraw_fields` 5 included. Every scoreboard is the same as before: hash_eval 42/42 on finding codes, floor, must_veto, veto_allowed and effects; policy_eval 129/129 and 97/97; describe_eval 356/373, 373, 373, 337/337, with 0 false fires in 599; value_eval 205/205 and 147/147. `cargo tree` for kaap-guard and kaap-registry shows kaap-verdict and no kaap-core. No record moved.

This matches a scan of every record in `eval/real` and `eval/planted` (a one-off script, run 2 Nov). It found no withdrawal with `msg` or `storage_deposit`, and no `native_withdraw` or `storage_deposit` intent. The only two `token_diff`s are planted:31 (a hash mismatch) and planted:61 (a direct deposit message, read by `decode`, which this order did not change).

## 5. Guide lines to add, one per new reading

1. Section 3, new effect: "`intents_swap` {gives: [{token, amount}], receives: [{token, amount}]}: a `token_diff` the DAO signs in a hash text with at least one negative entry (gives) and one positive entry (receives), amounts as whole base units without a sign, tokens written as for `intents_transfer`. A `token_diff` with no positive entry is HASH_TEXT_DANGEROUS."
2. Section 3, `intents_withdraw`: "A `native_withdraw` in a hash text is an `intents_withdraw` with token `near`, chain `near` and the stated `receiver_id` as address."
3. Section 3, `storage_deposit`: "A `storage_deposit` intent in a hash text (`contract_id`, `account_id` or `deposit_for_account_id`, `amount`) is a `storage_deposit` for that contract and account. When `amount` is above 0.1 NEAR, the part above 0.1 NEAR is also a `transfer` of `near` to the contract."
4. Section 3, `storage_deposit`: "A withdrawal intent's own `storage_deposit` field (`ft_withdraw`, `mt_withdraw`) adds a `storage_deposit` on the token contract for the receiver, with the same 0.1 NEAR rule. The `ft_withdraw` and `mt_withdraw` methods called directly pay no storage deposit, so the field is ignored there."
5. Section 3, `unknown_call`: "A withdrawal (`ft_withdraw` or `mt_withdraw`, called directly or as an intent) that carries a `msg`, the empty string included, also has an `unknown_call` on its receiver: method `ft_on_transfer` or `mt_on_transfer`, args `{"msg": <msg>}`, deposit `0`."
6. Section 4, UNKNOWN_VALUE, LARGE_AMOUNT and LOOKALIKE_TOKEN rows: "The `gives` of an `intents_swap` count as value leaving the DAO with no payee, so NEW_RECIPIENT never fires on them."
7. Section 4, DESC_CONTRADICTS row: "`intents_swap` moves value."
8. Section 4, HASH_TEXT_DANGEROUS row: "In a hash text, the kinds with an effect are `transfer`, `ft_withdraw`, `mt_withdraw`, `native_withdraw`, `storage_deposit`, `token_diff` read as a swap, and `add_public_key` and `remove_public_key`, which are still HASH_TEXT_DANGEROUS. Every other kind, `auth_call` and `set_auth_by_predecessor_id` included, and any field outside the documented shape of `native_withdraw`, `storage_deposit` or `token_diff`, is HASH_TEXT_DANGEROUS."
9. Section 4, HASH_TEXT_DANGEROUS row: "A text signed with the empty path reads only as Trezu's bulk-payment login. That means signer `<prefix>.bulkpayment.near` for a DAO `<prefix>.sputnik-dao.near` whose prefix is one label, recipient `intents.near`, a string deadline, empty `intents`, and `external_app_data` holding exactly one auth config. It is then a `sign_request` with no other effect and no finding. Any other text with the empty path is HASH_TEXT_DANGEROUS."
