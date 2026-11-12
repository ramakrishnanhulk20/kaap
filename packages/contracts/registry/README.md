# kaap-registry

The public, append-only record of Kaap verdicts on NEAR. Anyone can read what Kaap's sealed program said about any proposal of any DAO, and check the signature themselves.

## Who can write

Anyone may call `record(verdict, signature)`, but a verdict is stored only when the sealed program's key signed it. The registry trusts that key, not a publisher account. That is stronger than a publisher key (threat model C13): a stolen publisher account could write whatever it liked, while here a stolen worker account can only resubmit what the sealed program really signed.

The key is fixed at `new` and can never change. A new key means a new registry, on purpose: the code is immutable, with no upgrade method, and the deploy script deletes the account's only full-access key right after `new`.

## What it keeps

- Every verdict for a (network, DAO, proposal) is stored next to the earlier ones, never over them. `latest` is the verdict read at the highest block, the later record winning a tie, so a verdict read at an older block and recorded afterwards stays in the history but never becomes latest. Each record that became latest says which record it superseded. The same verdict twice is refused (`ERR_DUPLICATE`).
- A verdict holds only ids, hashes, risk levels, finding codes, the model id and an expiry. No confidential text, no explanation of one and no contact detail ever reaches it; the explanation is a hash.
- Verdicts over 1,024 bytes are refused (`ERR_TOO_LARGE`). The sealed program's whole output is capped below that.
- The caller pays for the storage a record takes, measured as it is written, and gets the rest of its deposit back in the same transaction (`ERR_NOT_ENOUGH_DEPOSIT` if it does not cover it). The registry's own balance never pays. Attach 0.02 NEAR; a typical record keeps 0.0056 NEAR of it.

Other refusals: `ERR_BAD_VERDICT` (not a version 1 verdict), `ERR_BAD_SIGNATURE`, `ERR_WRONG_NETWORK`.

## Methods

| Method | Who | What |
|---|---|---|
| `new(accepted_key, network)` | the account itself, at deploy | fixes the key and the network |
| `record(verdict, signature)` | anyone, with a deposit | stores the verdict, returns its index; event `verdict_recorded` with the storage cost and the refund |
| `latest(network, dao, proposal_id)` | view | the record read at the highest block, or null |
| `history(network, dao, proposal_id, from, limit)` | view | in the order recorded, pages of at most 50 |
| `accepted_key()`, `network()` | view | the key and network fixed at `new` |

Each record comes back with the signed bytes and the signature, so a reader can verify it against `accepted_key()`, plus the decoded risk, floor, findings, AI status, model id, the block the proposal was read at, the expiry, who recorded it and when.

## Testnet deployment

| | |
|---|---|
| Account | `kaap-registry-1111072803.testnet`, deployed 11 Nov 2026 |
| Code hash | `3Kro1EgWDYAawFx8RHUwVGTKmJvp9bAUeRL65cwGAoZz` (sha256 `228c21366ffdaf58f31a6e3550fd9898bc9ae65d1182f7a9e84d2df3c07fb2c9`) |
| Built from | commit `413a74aa91256a8c8603d1f84df33fde64abbcd3`, by the deploy script's `cargo near build non-reproducible-wasm --locked`; a second build in another target folder gave the same sha256 |
| Accepted key | `ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN`, the sealed program's key (details in `deployments/testnet.json`) |
| Deploy and init | https://testnet.nearblocks.io/txns/53xJksmZUhokY6rVNzXNcnadxAUEaN1RWPkdhJwMwiT7 |
| Key deleted | https://testnet.nearblocks.io/txns/GxMNoCaecyMRfF5k1dqtsxB4uCydKz8fUpzBkMm9gUF1, 0 access keys left |
| Explorer | https://testnet.nearblocks.io/address/kaap-registry-1111072803.testnet |

Anyone can check this deployment with near-cli-rs 0.30.1, reading only:

```
near account view-account-summary kaap-registry-1111072803.testnet network-config testnet now
near contract call-function as-read-only kaap-registry-1111072803.testnet latest json-args '{"network":"testnet","dao":"kaap-dao-1111072928.testnet","proposal_id":1}' network-config testnet now
```

The first shows "Account is locked (no access keys)" and the code's sha256; the second returns the record of the attack the demo treasury's guard vetoed. To rebuild and compare, check out the commit the table names and, with cargo-near 0.22.0 and the toolchain in `rust-toolchain.toml`, run `cargo near build non-reproducible-wasm --locked --out-dir <folder>` in `packages/contracts/registry`, then `sha256sum <folder>/kaap_registry.wasm`. It signs nothing.

The first registry, `kaap-registry-1029061211.testnet` (code hash `65Y2p3NqwjE8z8oXdzvRPjDWux2SXmHrxxzAhpqwPdqY`), was deployed on 29 Oct 2026 from commit `8818af0`. It is still on chain with no keys and its verdicts stay readable. Every id from that deployment is kept in `deployments/testnet-2026-10-29.json`.

Deploy a registry alone with `KAAP_DEPLOY=registry KAAP_ACCEPTED_KEY=ed25519:<key> bash scripts/deploy-contracts-testnet.sh`.

Anyone can run it, inside Linux or WSL. It deploys to a fresh account the testnet faucet pays for and signs only as that account (the deploy with `new`, then the key delete), never as Kaap's. It needs cargo-near 0.22.0, near-cli-rs 0.30.1, python3, curl, sha256sum and the toolchain in `rust-toolchain.toml`.

Gas: a record burns about 3.4 Tgas in all, about 0.0003 NEAR. Every figure is in `../GAS.md`.
