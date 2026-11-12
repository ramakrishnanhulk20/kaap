# Where to check each judging point

One page for a judge, human or machine. Each row names what to look at: a file, a test or command, and a transaction on NEAR testnet where there is one. The commands need Node 24 and no key; the README's "Try it in two minutes" shows their output.

Short names used below:

- `check` is `node packages/cli/dist/src/bin.js check kaap-dao-1111072928.testnet 1`
- `verify` is `node packages/cli/dist/src/bin.js verify kaap-dao-1111072928.testnet 1`
- `eval` is `node packages/cli/dist/src/bin.js eval`

## Track fit and NEAR tools

| Track | Why Kaap fits | File | Test or command | Transaction |
|---|---|---|---|---|
| `social`, Social Money | Kaap is something a treasury does with Sputnik DAO, not a new multisig: a member of a reject-only role, added by the treasury's own vote | `packages/contracts/guard/src/lib.rs`, `packages/core/src/policy/sputnik.rs` | `cargo test -p kaap-guard --test guard_sandbox`, against the real Sputnik DAO 3.2 binary | [the guard's reject vote](https://testnet.nearblocks.io/txns/AWWzynnmDdCYaKeSJA66Kr3h7DxW6ni9Sh6uHtH6v4M9) |
| `security`, AI Security and Defense | A policy engine that reads what a request does, and an AI that is given no key: it can raise a risk, and only plain code can justify a veto | `packages/core/src/floor.rs`, `packages/verdict/src/severity.rs`, `packages/sealed/src/verdict.rs` | `check`, and `cargo test -p kaap-core` | [the sealed run that judged request #1](https://testnet.nearblocks.io/txns/az5yNU7xixz2Qwrt8g4pNhygJTpceRqHJTK2zv7NF3J) |
| `privacy`, Privacy and Private AI | The reader runs in Intel TDX on OutLayer, asks a model on NEAR AI Cloud and checks its attestation, and opens a member's sealed text that nobody else can read | `packages/sealed/src/attest/`, `packages/sealed/src/texts.rs` | `verify`, and `cargo test -p kaap-sealed` | [the attested run that printed the text key](https://testnet.nearblocks.io/txns/DWRwVAcwpoVo5yfMHVVmWRw4S9QGNNj9XVioMDjobXBW) |
| `open`, Open Innovation | A guard that can stop a theft and cannot make one is a new shape for an AI with authority over money | `README.md`, "What Kaap does" | `verify` | the four transactions under "A theft stopped" in the README |

The README's "NEAR tools used" table lists each NEAR tool with the files that use it.

## Technical quality

| What to check | File | Test or command | Transaction |
|---|---|---|---|
| The guard can cast one vote, reject, and nothing else | `packages/contracts/guard/src/lib.rs` | `cargo test -p kaap-guard` | [reject cast](https://testnet.nearblocks.io/txns/AWWzynnmDdCYaKeSJA66Kr3h7DxW6ni9Sh6uHtH6v4M9) |
| A verdict works once | the same | `PROOF.md`, step 5: the same verdict handed in again is refused | linked in `PROOF.md` |
| The contracts are locked | `scripts/deploy-contracts-testnet.sh` | `verify`, lines "guard keys" and "registry keys" | [guard key deleted](https://testnet.nearblocks.io/txns/6qEFvNiz5Guw1w2XaA6cS36kkRVhAJbPTtijgPEcTssM), [registry key deleted](https://testnet.nearblocks.io/txns/GxMNoCaecyMRfF5k1dqtsxB4uCydKz8fUpzBkMm9gUF1) |
| The rule port matches Sputnik's own code | `packages/core/src/policy/sputnik.rs` | `cargo test -p kaap-core-diff`, which runs both against the same inputs in a sandbox | |
| The verdict's bytes cannot drift | `packages/verdict/src/verdict.rs` | `cargo test -p kaap-verdict --test pinned` | |
| The whole path works on a live network | `scripts/prove.mjs` | `PROOF.md`, the record of two runs | [filed](https://testnet.nearblocks.io/txns/GaQuPteeaiPAqjow7ezLC7f2HqxbBHv53erE1N4C7g9A), [judged](https://testnet.nearblocks.io/txns/az5yNU7xixz2Qwrt8g4pNhygJTpceRqHJTK2zv7NF3J), [recorded](https://testnet.nearblocks.io/txns/2T8fbLoy9gkFkbLThTMPsbRCf4RckfZVMVBvwvfqePmy), [rejected](https://testnet.nearblocks.io/txns/AWWzynnmDdCYaKeSJA66Kr3h7DxW6ni9Sh6uHtH6v4M9) |
| Test counts | | README, "Test results" | |

## Design and user experience

| What to check | File | How |
|---|---|---|
| The first screen says what Kaap is and shows a real request, with no wallet | `packages/web/components/landing/Hero.tsx` | open the site |
| A hash turns into what it really does | `packages/web/components/check/CheckTool.tsx` | on `/check`, press "Read the demo treasury's hash-only request", then "Use the words saved for this demo request" |
| Every number on the site comes from the chain or from a record in this repo | `packages/web/data/`, written by `packages/web/scripts/proof-data.mjs` and `capture-hash-proposal.mjs` | read the scripts |
| The site says what is not live | `packages/web/components/landing/Proof.tsx`, `packages/web/content/docs/trust/limits.mdx` | the table "What is live" on the home page, and the Limits page in the docs |

## Impact on NEAR, and open source

| What to check | File | Test or command |
|---|---|---|
| It works on any Sputnik DAO with no contract change | `packages/core/src/policy/arming.rs`, `packages/cli/src/enroll.ts` | `node packages/cli/dist/src/bin.js enroll <any Sputnik DAO>` prints the two requests a treasury files, and signs nothing |
| It reads any mainnet treasury today | `packages/cli/src/check.ts` | `node packages/cli/dist/src/bin.js check <any DAO ending in .sputnik-dao.near>` |
| NEAR-wide numbers anyone can rerun | `packages/cli/src/census.ts` | `node packages/cli/dist/src/bin.js census --sample 200` |
| MIT licence | `LICENSE` | |

## Originality

| What is new | File | Test or command |
|---|---|---|
| A member that can only reject, built from Sputnik's own permissions with no new treasury contract | `packages/contracts/guard/src/lib.rs`, `packages/core/src/policy/arming.rs` | `node packages/cli/dist/src/bin.js arming kaap-dao-1111072928.testnet` |
| The description is checked against the effect | `packages/core/src/describe/` | `check`: "contradicts: the named recipient is not paid" |
| A hash-only request is read once its words are supplied, with proof they match the hash | `packages/core/src/hash/` | the site's `/check` on request #7; `cargo test -p kaap-core --test hash_vectors` |
| Verdicts are signed inside sealed hardware, and anyone can check the run | `packages/sealed/src/job.rs`, `packages/cli/src/verify.ts` | `verify` |

## Sustainability

| What to check | File | Evidence |
|---|---|---|
| A paid check: one cent a call through an OutLayer payment key, live on testnet | `packages/sealed/src/payment.rs`, `scripts/paid-check.mjs` | `packages/sealed/RUNS.md`, "Paid calls from a stranger": [a paid run on chain](https://testnet.nearblocks.io/txns/7UatZZiYH43zZzrcx4ghiydYVBJZHovf1dkrbTv2NAC), and an underpaid one [refused](https://testnet.nearblocks.io/txns/9s9UMFuen5shte55JSMpuJjxQJ8L9ivSzBLjCSsoZifp) |
| What a veto costs to run | `packages/contracts/GAS.md` | under a thousandth of a NEAR a veto |
| What is not there yet | `packages/web/content/docs/trust/limits.mdx` | no treasury other than the demo one is enrolled, the watcher is not hosted, and nothing is on mainnet |

## Honesty of the numbers

| What to check | File | Test or command |
|---|---|---|
| How often Kaap is right, misses included | `packages/sealed/AI-EVAL.md` | `eval` reruns the plain-code part with no network |
| How the test set was sampled and labelled | `eval/README.md`, `eval/real/SAMPLING.md`, `docs/eval/labeling-guide.md` | |
| What `verify` does not check | | the "not checked here" lines of its own output |
| What Kaap does not do | `packages/web/content/docs/trust/limits.mdx` | |
