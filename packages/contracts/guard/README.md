# kaap-guard

The NEAR contract that sits alone in a Sputnik DAO's Guard role and can cast exactly one thing: a reject vote. It casts it only when handed a fresh verdict signed by Kaap's sealed program that names this guard, this network, an enrolled DAO, the proposal and its exact kind, and that meets the veto rule. Anyone may hand it the verdict; the signature is the authority, and the caller only pays the gas.

## What makes it vote

`veto(verdict, signature, kind_json)` checks, in this order, and refuses with the error named:

1. The verdict decodes and is version 1 (`ERR_BAD_VERDICT`).
2. The accepted key signed it (`ERR_BAD_SIGNATURE`).
3. It names this contract and this network (`ERR_WRONG_GUARD`).
4. Its DAO enrolled itself (`ERR_NOT_ENROLLED`).
5. It is critical, its plain-code floor is high or critical, it has a plain-code finding other than HASH_UNVERIFIED, and when the floor is only high, the AI answer that raised it is proven by its attestation (`ERR_NOT_VETOABLE`).
6. It has not expired (`ERR_EXPIRED`).
7. `kind_json` hashes, through kaap-core's canonical form, to the kind the verdict reviewed (`ERR_WRONG_KIND_HASH`), and is JSON (`ERR_BAD_KIND`).
8. It was never used before (`ERR_REPLAY`).

Then it records the verdict as used and calls the DAO's `act_proposal` with `VoteReject` and `kind_json` exactly as given. Sputnik compares that kind with the stored one by value, so the vote can only land on the proposal that was reviewed. A callback records the DAO's answer: `veto_result` reads `"Ok"` or `"Failed"`, and the events `veto_cast` and `veto_refused` say the same, so a refused vote is never silent.

No other method creates a promise, and nothing in the code builds any action but `VoteReject`. Even with the signing key, nobody can make the guard approve, remove or finalise a proposal.

## Who holds the owner key

The owner is Ram. On testnet the owner account is `kaap-owner-1029054356.testnet`, made by the deploy script, with its key kept only on Ram's machine. On mainnet the owner will be Ram's own NEAR account.

The owner can do two things and nothing else: replace the accepted key with `set_accepted_key` (every change emits `key_changed` with the old and the new key, public on chain, so Kaap's worker can alert every enrolled DAO's members, C18), and hand ownership to another account in two steps, `propose_owner` then `accept_owner` by the new owner. Both need exactly one yoctoNEAR attached, so only a full-access key can call them. The owner cannot make the guard vote, cannot enrol or remove a DAO, and cannot change the code.

## Immutable on purpose

There is no upgrade method, and the deploy script deletes the account's only full-access key right after `new`. Anyone can check that the account has no keys and that its code hash matches this build:

```
near account list-keys kaap-guard-1029054356.testnet network-config testnet now
```

A new version is a new contract. A DAO moves to it with one ordinary proposal that changes its Guard role.

## Testnet deployment

| | |
|---|---|
| Account | `kaap-guard-1029054356.testnet` |
| Code hash | `BKLwJNq7QyJjfJa7hnU3wZ9fhGaqi8ZXr1s8DW1BUUxr` (sha256 `9947dda2716f128a222630e3e72c2c77a3979bca9c883af0326f2f5f34cfea8b`) |
| Accepted key | `ed25519:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB`, a public test key, until the sealed program's key replaces it |
| Explorer | https://testnet.nearblocks.io/address/kaap-guard-1029054356.testnet |

Deploy again with `bash scripts/WO-02a-deploy-testnet.sh`.

## Enrolling a DAO

The DAO files a FunctionCall proposal to `enroll` on the guard, with no deposit and 10 Tgas (it burns 1.64), and approves it like any other proposal. `unenroll` works the same way. The DAO's policy must also give the guard a Guard role holding `<kind>:VoteReject` for every kind except `remove_member_from_role`, so the DAO can always remove Kaap.

## Methods

| Method | Who | What |
|---|---|---|
| `new(owner, accepted_key, network)` | the account itself, at deploy | sets the owner, the key and the network |
| `enroll()`, `unenroll()` | the DAO | adds or removes the caller; events `enrolled`, `unenrolled` |
| `veto(verdict, signature, kind_json)` | anyone | the checks above, then the vote; events `veto_sent`, then `veto_cast` or `veto_refused` |
| `set_accepted_key(key)` | owner, 1 yoctoNEAR | event `key_changed` |
| `propose_owner(new_owner)`, `accept_owner()` | owner, then the new owner, 1 yoctoNEAR each | events `owner_proposed`, `owner_accepted` |
| `accepted_key()`, `network()`, `owner()` | view | |
| `is_enrolled(dao)`, `enrolled_daos(from_index, limit)` | view | pages of at most 100 |
| `was_used(verdict_hash_hex)`, `veto_result(verdict_hash_hex)` | view | `veto_result` is `"Ok"`, `"Failed"` or null |

Gas: a veto of a Transfer burns 8.3 Tgas in all, about 0.0008 NEAR. Attach 300 Tgas; what is not burnt comes back. Every figure is in `../GAS.md`.

## Known limits

- A policy-shaped kind much above 200 KB cannot be vetoed inside the 300 Tgas one transaction may carry, and a kind over 256 KiB cannot be canonicalised at all (`ERR_BAD_KIND`). See `../GAS.md`.
- The guard stores 141 bytes for each enrolled DAO and 74 bytes for each used verdict, paid from its own balance.
