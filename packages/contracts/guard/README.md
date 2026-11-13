# kaap-guard

The NEAR contract that sits alone in a Sputnik DAO's Guard role and can cast exactly one thing: a reject vote. It casts it only when handed a fresh verdict signed by Kaap's sealed program that names this guard, this network, an enrolled DAO, the proposal and its exact kind, and that meets the veto rule. Anyone may hand it the verdict; the signature is the authority, and the caller only pays the gas.

## What makes it vote

`veto(verdict, signature, kind_json)` checks, in this order, and refuses with the error named:

1. The call attached at least 900 Tgas, `MIN_VETO_GAS` (`ERR_NOT_ENOUGH_GAS`). This comes first because a verdict is spent once the guard's receipt succeeds, and a signed verdict is public before it is used: a call too short to carry the DAO's vote fails whole and leaves the verdict unused.
2. `kind_json` is at most 217 KiB, `MAX_VETO_KIND_BYTES` (`ERR_KIND_TOO_LARGE`). With the first check, this is what makes every accepted call able to carry the vote: 900 Tgas lands the costliest kind measured at that size with 20 percent to spare (see Limits).
3. The verdict decodes and is version 1 (`ERR_BAD_VERDICT`).
4. The accepted key signed it (`ERR_BAD_SIGNATURE`). A key that is announced but not yet applied never counts.
5. It names this contract and this network (`ERR_WRONG_GUARD`).
6. Its DAO enrolled itself (`ERR_NOT_ENROLLED`).
7. It is critical, its plain-code floor is high or critical, it has a plain-code finding other than HASH_UNVERIFIED, and when the floor is only high, the AI answer that raised it is proven by its attestation (`ERR_NOT_VETOABLE`). For a DAO in strict mode, a verdict whose findings include HASH_UNVERIFIED also passes, whatever its risk.
8. It has not expired (`ERR_EXPIRED`).
9. `kind_json` is exactly as long as its canonical form in kaap-verdict (the one kaap-core re-exports), which no padded or escaped spelling is (`ERR_BAD_KIND`); that form hashes to the kind the verdict reviewed (`ERR_WRONG_KIND_HASH`); and it is JSON (`ERR_BAD_KIND`). Together these let through only the kind that was reviewed, with its keys and sets in any order.
10. It was never used before (`ERR_REPLAY`).

Then it records the verdict as used and calls the DAO's `act_proposal` with `VoteReject` and `kind_json` exactly as given. Sputnik compares that kind with the stored one by value, so the vote can only land on the proposal that was reviewed. A callback records the DAO's answer: `veto_result` reads `"Ok"` or `"Failed"`, and the events `veto_cast` and `veto_refused` say the same, so a refused vote is never silent.

`veto` is the only method that calls another contract. The only other promises are plain transfers back to the caller: `enroll` returns the part of its deposit the storage did not need, and `unenroll` returns the storage it frees. Nothing in the code builds any other action. Even with the signing key, nobody can make the guard approve, remove or finalise a proposal.

## Strict mode

A proposal that asks the treasury to sign a hash, where Kaap has not verified the text behind that hash, carries the finding HASH_UNVERIFIED. By default that alerts members and the guard does not vote on it. Each DAO decides for itself whether the guard should reject such a request instead (C8):

- Enrol with the arguments `{"veto_unreadable":true}` to start in strict mode; `{}` enrols exactly as before strict mode existed.
- Change it later with `set_veto_unreadable` and `{"on":true}` or `{"on":false}`, called by the DAO itself through an ordinary FunctionCall proposal, with no deposit. Any other caller is refused with `ERR_NOT_ENROLLED`.
- `veto_unreadable(dao)` reads the setting, false for an account that is not enrolled. The `enrolled` event carries it, and every change emits `mode_changed`.

The setting changes one thing: for a strict DAO, a verdict whose findings include HASH_UNVERIFIED passes the veto rule whatever its risk. Every other check applies unchanged and in the same order. The setting is stored with the enrolment and paid for by its deposit, and `unenroll` removes it, so enrolling again starts from the arguments given then.

## Who holds the owner key

The owner is Kaap's founder. On testnet the owner account is `kaap-owner-1029061211.testnet`, made by the deploy script, with its key kept only on the founder's machine. On mainnet the owner will be the founder's own NEAR account.

The owner can do two things and nothing else:

- Change the accepted key, in two steps at least 24 hours apart (`KEY_CHANGE_DELAY_MS`, C19). `set_accepted_key` announces the new key and emits `key_change_announced` with the current key, the new one and `effective_at_ms`, the block time a day later. Until then the current key stays the only one `veto` obeys, Kaap's worker can alert every enrolled DAO's members from the public event (C18), and the owner can withdraw it with `cancel_key_change`, which emits `key_change_cancelled`. From `effective_at_ms` on, anyone may call `apply_key_change`, which makes it the accepted key and emits `key_changed`; verdicts signed by the old key are refused from then on. A second announcement replaces the first and restarts the wait. `pending_key()` shows the announced key and its time.
- Hand ownership to another account in two steps, `propose_owner` then `accept_owner` by the new owner. A new owner faces the same 24-hour wait for a key change.

`set_accepted_key`, `cancel_key_change`, `propose_owner` and `accept_owner` need exactly one yoctoNEAR attached, so only a full-access key can call them. The owner cannot make the guard vote, cannot enrol or remove a DAO, cannot change a DAO's mode, and cannot change the code.

## Immutable on purpose

There is no upgrade method, and the deploy script deletes the account's only full-access key right after `new`. Anyone can check that the account has no keys and that its code hash matches this build:

```
near account list-keys kaap-guard-1113045147.testnet network-config testnet now
```

Anyone can run it with near-cli-rs 0.30.1, and it reads only. `near account view-account-summary kaap-guard-1113045147.testnet network-config testnet now` shows both facts at once: "Account is locked (no access keys)" and the code's sha256. To rebuild and compare, check out the commit the table below names and, with cargo-near 0.22.0 and the toolchain in `rust-toolchain.toml`, run `cargo near build non-reproducible-wasm --locked --out-dir <folder>` in `packages/contracts/guard`, then `sha256sum <folder>/kaap_guard.wasm`, and compare with the sha256 below. Two builds on one machine matched it; a build on another machine has not been tried. Neither signs.

A new version is a new contract. A DAO moves to it with one ordinary proposal that changes its Guard role.

## Testnet deployment

| | |
|---|---|
| Account | `kaap-guard-1113045147.testnet`, deployed 13 Nov 2026 |
| Code hash | `BfYf34n3cN85SpkSWRAJYqDghRHxLJkR4SgYaeXbWBt6` (sha256 `9e74bbbadcfa6820390e21cb415ae83542f5de6257da4ad651caf950801c5d23`) |
| Built from | commit `5f1cf75`, by the deploy script's `cargo near build non-reproducible-wasm --locked`; a second build in an empty target folder gave the same sha256 |
| Owner | `kaap-owner-1029061211.testnet` |
| Accepted key | `ed25519:8eiUXYidw2x7WWfVVmYkDcewi3aBzxKomMefsPPhaecF`, the key the watcher's account has on the sealed program (project `kaap-sealed-owner-1113041743.testnet/kaap-sealed`; attested run https://testnet-api.outlayer.ai/attestations/by-tx/6Lm1adNQeQrm75QBoWcEmAaG1dskrajEUCQCisatU12L) |
| Deploy and init | https://testnet.nearblocks.io/txns/6zSjJ4FnExBBWx9eR1hcfErbRM83e1x1ob9QwzApTHvT |
| Key deleted | https://testnet.nearblocks.io/txns/DeCTsm76k8RH6HES5uqh4p4SrzZksKF7uQNL7gYPLxtV, 0 access keys left |
| Explorer | https://testnet.nearblocks.io/address/kaap-guard-1113045147.testnet |

This guard has the gas and size checks, strict mode and the key delay described here. The two guards before it, of 29 Oct and 11 Nov 2026, are still on chain and have none of them.

Every id and hash is also in `deployments/testnet.json`. Deploy again with `KAAP_ACCEPTED_KEY=ed25519:<key> KAAP_GUARD_OWNER=<owner> bash scripts/deploy-contracts-testnet.sh`.

Anyone can run it, inside Linux or WSL. It makes a new guard on fresh accounts the testnet faucet pays for and signs only as those (the deploy with `new`, then the key delete), never as Kaap's accounts. `KAAP_GUARD_OWNER` may name any testnet account, a stranger's own included, because the script never signs as the owner; left out, it makes a fresh owner account too. It needs cargo-near 0.22.0, near-cli-rs 0.30.1, python3, curl, sha256sum and the toolchain in `rust-toolchain.toml`.

The first guard, `kaap-guard-1029061211.testnet` (code hash `77fyhhxdRnHzb8efe9HBYL8C3KcUpEbbRjLvrNyqoxbP`), was deployed on 29 Oct 2026 from commit `8818af0`, before the verdict format moved into `packages/verdict`. It is still on chain with no keys, and its record is kept in `deployments/testnet-2026-10-29.json`.

## Enrolling a DAO

The DAO files a FunctionCall proposal to `enroll` on the guard with the arguments `{}`, or `{"veto_unreadable":true}` for strict mode, attaching 0.01 NEAR and 10 Tgas (it burns 1.9), and approves it like any other proposal. The arguments must be a JSON object, as above. The guard keeps only the storage its entry and setting take, 0.0014 NEAR for a short name and at most about 0.0019 NEAR, and sends the rest back in the same call (`ERR_NOT_ENOUGH_DEPOSIT` if the deposit is short). `unenroll` works the same way with no deposit, and refunds exactly what the enrolment kept. The DAO's policy must also give the guard a Guard role holding `<kind>:VoteReject` for every kind except `remove_member_from_role`, so the DAO can always remove Kaap.

## Methods

| Method | Who | What |
|---|---|---|
| `new(owner, accepted_key, network)` | the account itself, at deploy | sets the owner, the key and the network |
| `enroll(veto_unreadable)`, `unenroll()` | the DAO; `enroll` with a storage deposit | adds the caller with its strict-mode setting (absent or null means false), or removes both, and settles its storage; events `enrolled` with `{dao, veto_unreadable}`, `unenrolled` |
| `set_veto_unreadable(on)` | an enrolled DAO, for itself, no deposit | turns its strict mode on or off; event `mode_changed` with `{dao, veto_unreadable}` |
| `veto(verdict, signature, kind_json)` | anyone, with at least 900 Tgas | the checks above, then the vote; events `veto_sent`, then `veto_cast` or `veto_refused` |
| `set_accepted_key(key)` | owner, 1 yoctoNEAR | announces a key change; event `key_change_announced` with `{old_key, new_key, effective_at_ms}` |
| `cancel_key_change()` | owner, 1 yoctoNEAR | withdraws the announced change; event `key_change_cancelled` with `{key}` |
| `apply_key_change()` | anyone, no deposit, from `effective_at_ms` | makes the announced key the accepted key; event `key_changed` with `{old_key, new_key}` |
| `propose_owner(new_owner)`, `accept_owner()` | owner, then the new owner, 1 yoctoNEAR each | events `owner_proposed`, `owner_accepted` |
| `accepted_key()`, `pending_key()`, `network()`, `owner()` | view | `pending_key` is `{key, effective_at_ms}` or null |
| `is_enrolled(dao)`, `veto_unreadable(dao)`, `enrolled_daos(from_index, limit)` | view | `veto_unreadable` is false for an account that is not enrolled; pages of at most 100 |
| `was_used(verdict_hash_hex)`, `veto_result(verdict_hash_hex)` | view | `veto_result` is `"Ok"`, `"Failed"` or null |

| Constant | Value | What it sets |
|---|---|---|
| `MIN_VETO_GAS` | 900 Tgas | the least gas `veto` accepts (`ERR_NOT_ENOUGH_GAS`) |
| `MAX_VETO_KIND_BYTES` | 222,208 bytes, 217 KiB | the longest `kind_json` `veto` accepts (`ERR_KIND_TOO_LARGE`) |
| `KEY_CHANGE_DELAY_MS` | 86,400,000 ms, 24 hours | how long after `set_accepted_key` the change may apply (`ERR_TOO_EARLY` before then) |

`cancel_key_change` and `apply_key_change` answer `ERR_NO_PENDING_KEY` when no change is announced. Every error is a panic with exactly its name as the text.

Gas: a veto of a Transfer burns 8.3 Tgas in all, about 0.0008 NEAR. Every veto must attach at least 900 Tgas, or it is refused with `ERR_NOT_ENOUGH_GAS` before the verdict is read; what is not burnt comes back, but the sender needs about 0.09 NEAR on hand while the call runs. Enrolling burns 9.0 Tgas in all in either mode, changing the mode 8.3 Tgas, and announcing, cancelling or applying a key change about 2 Tgas each. Every figure is in `../GAS.md`.

## Limits

What the guard accepts, and why: a `kind_json` of at most 217 KiB, exactly as long as its canonical form, from a call that attaches at least 900 Tgas. In the sandbox, against Sputnik 3.2, the costliest kind measured at that size, a ChangePolicy of two roles with very long lists of the shortest account ids, needed 750 Tgas for its vote to land, and 900 is that plus 20 percent; on this build that veto burns 745 Tgas in all, the guard 304.9 and the DAO 422.9. Any spelling of a kind longer than its canonical form, padded with spaces or with escaped characters, hashes the same but costs more to read, so it is refused before anything is marked. Every kind recorded from testnet and mainnet in this repository, and every planted evaluation kind filed on Sputnik and read back, has its canonical length, so no honest kind is refused.

These proposals cannot be vetoed, whatever the verdict says:

- A kind over 217 KiB. The guard refuses it with `ERR_KIND_TOO_LARGE` before it reads the verdict, so the verdict is not spent. A big real DAO's whole policy is about 23 KB.
- A kind kaap-verdict cannot canonicalise: text that is not strict JSON (`ERR_BAD_KIND`).
- A RemoveMemberFromRole proposal, by design: the Guard role never holds VoteReject on it, so a DAO can always remove Kaap. The DAO refuses the vote and the guard records the refusal.

Neither the sealed program nor the rules engine holds a proposal back for its size below kaap-verdict's 256 KiB, so a verdict can be signed for a kind between 217 and 256 KiB. The guard refuses it with `ERR_KIND_TOO_LARGE` and the verdict stays unused.

The 900 Tgas does not cover two things, named here so nobody assumes it does: a kind shape that costs more per byte than the two measured, and a DAO whose own current policy is large, because Sputnik reads that policy on every vote. The margin over the measured 750 Tgas is 150 Tgas. Every measurement is in `../GAS.md`.

The guard pays for two things itself: each used verdict takes 74 bytes of its storage (84 when the DAO refused the vote), about 0.0008 NEAR, and an announced key change takes 64 bytes until it is applied or cancelled. Only a verdict the accepted key signed can create the first, and only the owner the second. Enrolments, setting included, are paid by the DAO.
