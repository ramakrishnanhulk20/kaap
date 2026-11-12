# kaap-guard

The NEAR contract that sits alone in a Sputnik DAO's Guard role and can cast exactly one thing: a reject vote. It casts it only when handed a fresh verdict signed by Kaap's sealed program that names this guard, this network, an enrolled DAO, the proposal and its exact kind, and that meets the veto rule. Anyone may hand it the verdict; the signature is the authority, and the caller only pays the gas.

## What makes it vote

`veto(verdict, signature, kind_json)` checks, in this order, and refuses with the error named:

1. The call attached at least 300 Tgas (`ERR_NOT_ENOUGH_GAS`). This comes first because a verdict is spent once the guard's receipt succeeds, and a signed verdict is public before it is used: a call too short to carry the DAO's vote on a big kind fails whole and leaves the verdict unused.
2. The verdict decodes and is version 1 (`ERR_BAD_VERDICT`).
3. The accepted key signed it (`ERR_BAD_SIGNATURE`).
4. It names this contract and this network (`ERR_WRONG_GUARD`).
5. Its DAO enrolled itself (`ERR_NOT_ENROLLED`).
6. It is critical, its plain-code floor is high or critical, it has a plain-code finding other than HASH_UNVERIFIED, and when the floor is only high, the AI answer that raised it is proven by its attestation (`ERR_NOT_VETOABLE`).
7. It has not expired (`ERR_EXPIRED`).
8. `kind_json` hashes, through kaap-verdict's canonical form (the one kaap-core re-exports), to the kind the verdict reviewed (`ERR_WRONG_KIND_HASH`), and is JSON (`ERR_BAD_KIND`).
9. It was never used before (`ERR_REPLAY`).

Then it records the verdict as used and calls the DAO's `act_proposal` with `VoteReject` and `kind_json` exactly as given. Sputnik compares that kind with the stored one by value, so the vote can only land on the proposal that was reviewed. A callback records the DAO's answer: `veto_result` reads `"Ok"` or `"Failed"`, and the events `veto_cast` and `veto_refused` say the same, so a refused vote is never silent.

`veto` is the only method that calls another contract. The only other promises are plain transfers back to the caller: `enroll` returns the part of its deposit the storage did not need, and `unenroll` returns the storage it frees. Nothing in the code builds any other action. Even with the signing key, nobody can make the guard approve, remove or finalise a proposal.

## Who holds the owner key

The owner is Kaap's founder. On testnet the owner account is `kaap-owner-1029061211.testnet`, made by the deploy script, with its key kept only on the founder's machine. On mainnet the owner will be the founder's own NEAR account.

The owner can do two things and nothing else: replace the accepted key with `set_accepted_key` (every change emits `key_changed` with the old and the new key, public on chain, so Kaap's worker can alert every enrolled DAO's members, C18), and hand ownership to another account in two steps, `propose_owner` then `accept_owner` by the new owner. Both need exactly one yoctoNEAR attached, so only a full-access key can call them. The owner cannot make the guard vote, cannot enrol or remove a DAO, and cannot change the code.

## Immutable on purpose

There is no upgrade method, and the deploy script deletes the account's only full-access key right after `new`. Anyone can check that the account has no keys and that its code hash matches this build:

```
near account list-keys kaap-guard-1111072803.testnet network-config testnet now
```

Anyone can run it with near-cli-rs 0.30.1, and it reads only. `near account view-account-summary kaap-guard-1111072803.testnet network-config testnet now` shows both facts at once: "Account is locked (no access keys)" and the code's sha256. To rebuild and compare, check out the commit the table below names and, with cargo-near 0.22.0 and the toolchain in `rust-toolchain.toml`, run `cargo near build non-reproducible-wasm --locked --out-dir <folder>` in `packages/contracts/guard`, then `sha256sum <folder>/kaap_guard.wasm`, and compare with the sha256 below. Two builds on one machine matched it; a build on another machine has not been tried. Neither signs.

A new version is a new contract. A DAO moves to it with one ordinary proposal that changes its Guard role.

## Testnet deployment

| | |
|---|---|
| Account | `kaap-guard-1111072803.testnet`, deployed 11 Nov 2026 |
| Code hash | `DrjaN1zVz4cxvvxbxhM6rVZsqy8SrBunmMbyeqbsr4R4` (sha256 `bf09d7bbb48f312eb4043bd7b585f3b02bbe9d8b7d5bc0bf31fec9319c663767`) |
| Built from | commit `413a74aa91256a8c8603d1f84df33fde64abbcd3`, by the deploy script's `cargo near build non-reproducible-wasm --locked`; a second build in another target folder gave the same sha256 |
| Owner | `kaap-owner-1029061211.testnet` |
| Accepted key | `ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN`, the sealed program's key (project `kaap-worker-1029053612.testnet/kaap-sealed`; attested run https://testnet-api.outlayer.ai/attestations/by-tx/7HvniWe5JKgqARsiWW8onQpSw1rPcHWiNG4vLwBtekSC) |
| Deploy and init | https://testnet.nearblocks.io/txns/DEta1bNNm4gRYLqhZJ2HfwDnVtz294dgyEyLfiQVzsK1 |
| Key deleted | https://testnet.nearblocks.io/txns/6qEFvNiz5Guw1w2XaA6cS36kkRVhAJbPTtijgPEcTssM, 0 access keys left |
| Explorer | https://testnet.nearblocks.io/address/kaap-guard-1111072803.testnet |

Every id and hash is also in `deployments/testnet.json`. Deploy again with `KAAP_ACCEPTED_KEY=ed25519:<key> KAAP_GUARD_OWNER=<owner> bash scripts/deploy-contracts-testnet.sh`.

Anyone can run it, inside Linux or WSL. It makes a new guard on fresh accounts the testnet faucet pays for and signs only as those (the deploy with `new`, then the key delete), never as Kaap's accounts. `KAAP_GUARD_OWNER` may name any testnet account, a stranger's own included, because the script never signs as the owner; left out, it makes a fresh owner account too. It needs cargo-near 0.22.0, near-cli-rs 0.30.1, python3, curl, sha256sum and the toolchain in `rust-toolchain.toml`.

The first guard, `kaap-guard-1029061211.testnet` (code hash `77fyhhxdRnHzb8efe9HBYL8C3KcUpEbbRjLvrNyqoxbP`), was deployed on 29 Oct 2026 from commit `8818af0`, before the verdict format moved into `packages/verdict`. It is still on chain with no keys, and its record is kept in `deployments/testnet-2026-10-29.json`.

## Enrolling a DAO

The DAO files a FunctionCall proposal to `enroll` on the guard, attaching 0.01 NEAR and 10 Tgas (it burns 1.88), and approves it like any other proposal. The guard keeps only the storage its entry takes, 0.0014 NEAR for a short name and at most about 0.0024 NEAR, and sends the rest back in the same call (`ERR_NOT_ENOUGH_DEPOSIT` if the deposit is short). `unenroll` works the same way with no deposit, and refunds exactly what the enrolment kept. The DAO's policy must also give the guard a Guard role holding `<kind>:VoteReject` for every kind except `remove_member_from_role`, so the DAO can always remove Kaap.

## Methods

| Method | Who | What |
|---|---|---|
| `new(owner, accepted_key, network)` | the account itself, at deploy | sets the owner, the key and the network |
| `enroll()`, `unenroll()` | the DAO; `enroll` with a storage deposit | adds or removes the caller and settles its storage; events `enrolled`, `unenrolled` |
| `veto(verdict, signature, kind_json)` | anyone | the checks above, then the vote; events `veto_sent`, then `veto_cast` or `veto_refused` |
| `set_accepted_key(key)` | owner, 1 yoctoNEAR | event `key_changed` |
| `propose_owner(new_owner)`, `accept_owner()` | owner, then the new owner, 1 yoctoNEAR each | events `owner_proposed`, `owner_accepted` |
| `accepted_key()`, `network()`, `owner()` | view | |
| `is_enrolled(dao)`, `enrolled_daos(from_index, limit)` | view | pages of at most 100 |
| `was_used(verdict_hash_hex)`, `veto_result(verdict_hash_hex)` | view | `veto_result` is `"Ok"`, `"Failed"` or null |

Gas: a veto of a Transfer burns 8.3 Tgas in all, about 0.0008 NEAR. Every veto must attach at least 300 Tgas, or it is refused with `ERR_NOT_ENOUGH_GAS` before the verdict is read; what is not burnt comes back. Every figure is in `../GAS.md`.

## Limits

These proposals cannot be vetoed, whatever the verdict says:

- A kind kaap-verdict cannot canonicalise: anything over 256 KiB, or text that is not strict JSON. The guard answers `ERR_BAD_KIND` at any gas. Size, not cost, is the barrier here: padding a FunctionCall's args is cheap, and a 196,735-byte padded FunctionCall was filed and vetoed for 89.0 Tgas in the sandbox.
- A kind whose vote does not fit in 300 Tgas, the gas every veto must attach and the amount Kaap's worker sends. Big policies cost the most per byte. With 300 Tgas, the largest ChangePolicy whose vote landed in the sandbox was 205,116 bytes (guard 127.2 Tgas, DAO 161.0); from 206,546 bytes up, the DAO's call ran out of gas. The limit is for policies shaped like the measured ones, 80 roles of many short member names; a shape that costs more per byte stops sooner.
- A RemoveMemberFromRole proposal, by design: the Guard role never holds VoteReject on it, so a DAO can always remove Kaap. The DAO refuses the vote and the guard records the refusal.

Neither the sealed program nor the rules engine holds a proposal back for its size; their only size limit is kaap-verdict's 256 KiB. So a verdict can be signed for a policy kind above the 300 Tgas limit, and a veto tried on one fails and is reported: the guard sends the vote, the DAO's call runs out of gas, `veto_result` reads `"Failed"`, `veto_refused` says so, and the verdict is spent. The 300 Tgas limit is the guard's and the worker's, not the chain's: NEAR has let one transaction carry up to 1,000 Tgas since protocol 83, and a 226,566-byte ChangePolicy veto sent with 1,000 Tgas landed in the sandbox. Every measurement is in `../GAS.md`.

The guard pays for one thing itself: each used verdict takes 74 bytes of its storage (84 when the DAO refused the vote), about 0.0008 NEAR. Only a verdict the accepted key signed can create one. Enrolments are paid by the DAO.
