# kaap-registry

The public, append-only record of Kaap verdicts on NEAR. Anyone can read what Kaap's sealed program said about any proposal of any DAO, and check the signature themselves.

## Who can write

Anyone may call `record(verdict, signature)`, but a verdict is stored only when the sealed program's key signed it. The registry trusts that key, not a publisher account. That is stronger than a publisher key (threat model C13): a stolen publisher account could write whatever it liked, while here a stolen worker account can only resubmit what the sealed program really signed.

The key is fixed at `new` and can never change. A new key means a new registry, on purpose: the code is immutable, with no upgrade method, and the deploy script deletes the account's only full-access key right after `new`.

## What it keeps

- Every verdict for a (network, DAO, proposal) is stored next to the earlier ones, never over them. Each record says which earlier record it supersedes. The same verdict twice is refused (`ERR_DUPLICATE`), so an old verdict cannot be pushed back on top.
- A verdict holds only ids, hashes, risk levels, finding codes, the model id and an expiry. No confidential text, no explanation of one and no contact detail ever reaches it; the explanation is a hash.
- Verdicts over 1,024 bytes are refused (`ERR_TOO_LARGE`). The sealed program's whole output is capped below that.
- The caller pays for the storage a record takes, measured as it is written, and gets the rest of its deposit back in the same transaction (`ERR_NOT_ENOUGH_DEPOSIT` if it does not cover it). The registry's own balance never pays. Attach 0.02 NEAR; a typical record keeps 0.0056 NEAR of it.

Other refusals: `ERR_BAD_VERDICT` (not a version 1 verdict), `ERR_BAD_SIGNATURE`, `ERR_WRONG_NETWORK`.

## Methods

| Method | Who | What |
|---|---|---|
| `new(accepted_key, network)` | the account itself, at deploy | fixes the key and the network |
| `record(verdict, signature)` | anyone, with a deposit | stores the verdict, returns its index; event `verdict_recorded` with the storage cost and the refund |
| `latest(network, dao, proposal_id)` | view | the newest record, or null |
| `history(network, dao, proposal_id, from, limit)` | view | oldest first, pages of at most 50 |

Each record comes back with the signed bytes and the signature, so a reader can verify it against the key in the deploy transaction, plus the decoded risk, floor, findings, AI status, model id, the block the proposal was read at, the expiry, who recorded it and when.

## Testnet deployment

| | |
|---|---|
| Account | `kaap-registry-1029054356.testnet` |
| Code hash | `B7MktDsBNBPqCf5vHaEFXsTe3xEaAawsKBsjSXJvj26Q` (sha256 `9635d2dd25bacbd37ce00487e5926ca51dbb51176b2f62902fb8d888c444b4dd`) |
| Accepted key | `ed25519:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB`, a public test key; the registry for the sealed program's key is a fresh deploy |
| Explorer | https://testnet.nearblocks.io/address/kaap-registry-1029054356.testnet |

Deploy a registry alone with `KAAP_DEPLOY=registry KAAP_ACCEPTED_KEY=ed25519:<key> bash scripts/WO-02a-deploy-testnet.sh`.

Gas: a record burns about 3.4 Tgas in all, about 0.0003 NEAR. Every figure is in `../GAS.md`.
