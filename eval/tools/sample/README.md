# The real sample: re-draw it, then re-read it from the chain

`eval/real/sample.jsonl` holds 300 real NEAR DAO proposals. Two scripts let anyone check where they came from, with Node 24 or later and nothing to install.

```
node eval/tools/sample/draw.mjs --check    # the seeded draw picks these same 300 ids
node eval/tools/verify-chain.mjs --n 20    # 20 of them, read again from NEAR mainnet
```

## The draw
`draw.mjs` runs the seeded draw described in `eval/real/SAMPLING.md` (seed `kaap-eval-v1`, one mulberry32 stream per stratum) over `census-index.jsonl` and prints the 300 ids it picks. With `--check` it compares them with the ids in `eval/real/sample.jsonl` and exits 0 only when they are the same 300. Today they are. The draw picks ids only: the record contents were filled from the census afterwards, and on 26 Oct every policy-kind record's `policy_before` was replaced by an archival read, which changed the file's hash but not which 300 ids it holds.

`census-index.jsonl` is 1,446,959 bytes: one line for each of the 9,471 proposals the 20 Oct 2026 census found in the last 365 days, across 608 DAOs. It holds only what the draw reads, all of it public chain data or a rule applied to it. No description text, votes or amounts.

| Field | What it is |
|---|---|
| `dao`, `id` | the DAO account and the proposal id |
| `kind`, `status` | the kind name, and the status at the census read |
| `ver` | the Sputnik version the DAO ran then, from its code hash |
| `receiver`, `methods` | FunctionCall only: the contract called and its distinct method names, in action order |
| `deposit_above_1` | an action attaches more than 1 yoctoNEAR |
| `token` | Transfer only: the token id, empty for NEAR |
| `sign` | calls to `v1.signer` `sign` only, from the description, first rule that fits: `bulk` (contains "Proposal Action: bulk-payment-confidential"), `bulk-auth` (starts "Authenticate bulk-payment subaccount"), `auth` (starts with the word "Auth" or "Authenticate"), `single` (contains "Proposal Action: confidential", or starts "Confidential shield" or "Confidential transfer"), else `other` |
| `variant` | `single` and `other` only: records whose descriptions share their first 40 characters share this number, so the draw spreads across wordings |
| `policy_before_known` | ChangePolicy only: the 20 Oct method could fill the policy before it (SAMPLING.md, "How `context` was filled"), which splits ChangePolicy into two strata |
| `mismatch` | one of the 7 proposals the census found with a description at odds with its kind; all are taken |

What the draw proves: given this index, the 300 were picked by the seed and the written quotas, not by hand. Change one field and `--check` fails; flipping one `policy_before_known` moves 49 of the 300.

What it does not prove: that the census found every proposal, or that each index field is right. `kaap census` reads the DAOs again live, with today's data rather than the 20 Oct snapshot. `ver` and `policy_before_known` come from the census's own reads and are not re-checked by either script. The record contents beyond kind, description and status (`history`, `policy_before`) are not checked here either.

## The chain check
`verify-chain.mjs` reads each chosen proposal with `get_proposal` the way the kaap CLI reads one: at one final block, from `near.drpc.org` and `rpc.mainnet.fastnear.com`, which must agree. It then compares the kind (with a role's members and permissions read as sets), the description and the status with the record.

- `matched`: the chain today holds what the record says.
- `changed since`: it does not, but an archival node shows the record's values at the last or the first block of the census read (220,764,228 or 220,762,448), so the DAO voted on, removed or changed the proposal afterwards.
- `failed`: the record differs from the chain at the census blocks too. This is a wrong record.
- `unread`: a provider did not answer, or the two disagreed. Nothing is said about the record.

Old blocks come from fastnear's archive first. It refuses bursts, so archive reads are paced to one a second, and a refused or failed read moves to `archival-rpc.mainnet.near.org`. `--n <count>` takes that many records in a fixed seeded order (20 by default), `--id <record id>` takes one, and `--all` takes all 300, about 600 requests over a few minutes. Exit codes: 0 when nothing failed or went unread, 1 when a record failed, 2 for bad arguments, 3 when a record went unread. It reads only: no key, no signature, no transaction.
