# kaap-sealed on OutLayer testnet: runs, timing and cost

Measured on 29 Oct 2026 between 05:37 and 05:45 UTC, from WSL on one machine, with
`scripts/WO-02b-run-testnet.sh`. Every run went through `request_execution` on `outlayer.testnet`,
paid in testnet NEAR, with all three resource limits written out (10,000,000,000 instructions,
128 MB, 60 s) and 0.02 NEAR attached (the unused part is refunded in the same transaction).

| Thing | Value |
| --- | --- |
| Project | `kaap-worker-1029053612.testnet/kaap-sealed`, uuid `p00000000000000a9` |
| Caller (the testnet worker account) | `kaap-worker-1029053612.testnet` |
| Version (wasm sha256) | `0099d7b75f5f509ee0c84a7b819058c67ba2e9f9099e4dbf51e413a343d6ff49`, 380,792 bytes |
| Verdict key | `ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN`, the same on all 13 signed runs |
| Proposal judged | `corm1gu.sputnikv2.testnet` #1, a real InProgress Transfer of 10 tokens of `nori4qx.tanssg2.testnet` |
| Input | `{"v":1,"network":"testnet","guard":"kaap-worker-1029053612.testnet","dao":"corm1gu.sputnikv2.testnet","proposal_id":1,"expires_in_ms":600000}` |

## The ten timed runs (DONE MEANS 4)

"Read block" is the final block the job pinned every read to, taken from the verdict. "Wall" is
from just before near-cli starts to near-cli returning the result; "on chain" is from the
request's block to the last receipt's block; "worker" is OutLayer's own `time_ms`.

| Run | Transaction | Request block | Read block | Result block | Blocks | Wall ms | On chain ms | Worker ms | Paid, NEAR |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | [7HvniWe5...](https://testnet.nearblocks.io/txns/7HvniWe5JKgqARsiWW8onQpSw1rPcHWiNG4vLwBtekSC) | 275257058 | 275257062 | 275257072 | 14 | 12,223 | 8,459 | 1,427 | 0.0019189 |
| 2 | [HX83h4x9...](https://testnet.nearblocks.io/txns/HX83h4x9PKLk4rSMMkuPfGkSkVWB4ixWqdtiVM4uZZdd) | 275257083 | 275257086 | 275257096 | 13 | 11,791 | 7,839 | 1,446 | 0.0019208 |
| 3 | [5o5s7iKj...](https://testnet.nearblocks.io/txns/5o5s7iKj4u6uoJHaJuQ8QwH6aqoGnv1pa1dQDFQsDCR8) | 275257106 | 275257111 | 275257121 | 15 | 11,286 | 7,978 | 1,653 | 0.0019412 |
| 4 | [9YF1YgD7...](https://testnet.nearblocks.io/txns/9YF1YgD7eEk8Zqs6XoH7aviBvx6q6KGVV8Gf96JQAyrZ) | 275257132 | 275257135 | 275257146 | 14 | 10,358 | 7,249 | 1,388 | 0.0019150 |
| 5 | [ApuJRnv7...](https://testnet.nearblocks.io/txns/ApuJRnv7RtzEWMDsy2NT3aeK8ZL6umnqAsx2VnCV7Vxi) | 275257157 | 275257160 | 275257170 | 13 | 10,892 | 6,859 | 1,386 | 0.0019146 |
| 6 | [BrvAbHNg...](https://testnet.nearblocks.io/txns/BrvAbHNg3PdmYHpWtEAzpQP11c1h1pXbTnocvAMy9q2G) | 275257181 | 275257185 | 275257195 | 14 | 11,805 | 8,488 | 1,398 | 0.0019161 |
| 7 | [HovxWifA...](https://testnet.nearblocks.io/txns/HovxWifAJoi8kq7dJECTanyg6cF95v1YYneyr1UManFN) | 275257206 | 275257210 | 275257219 | 13 | 12,104 | 7,890 | 1,394 | 0.0019155 |
| 8 | [F4q36d95...](https://testnet.nearblocks.io/txns/F4q36d95vojse9wDC8DzNVh6tviezkAkqtfxKFCZKfiR) | 275257229 | 275257233 | 275257242 | 13 | 11,746 | 7,922 | 1,465 | 0.0019227 |
| 9 | [9yk571Hy...](https://testnet.nearblocks.io/txns/9yk571HyNZJsa2FWvibtA9pi6kNig71RvaHtfZWSw3sw) | 275257254 | 275257258 | 275257268 | 14 | 11,900 | 7,786 | 1,337 | 0.0019100 |
| 10 | [ZBn3sJk7...](https://testnet.nearblocks.io/txns/ZBn3sJk7zo6n87r8GstFXqMUW7Zhf12SScMcADkLnup) | 275257279 | 275257283 | 275257294 | 15 | 11,064 | 7,446 | 1,375 | 0.0019139 |

| Over the 10 runs | p50 | p90 | max |
| --- | --- | --- | --- |
| Wall clock, trigger to result | 11,746 ms | 12,104 ms | 12,223 ms |
| On chain, request block to result block | 7,839 ms | 8,459 ms | 8,488 ms |
| Blocks, request to result | 14 | 15 | 15 |
| Worker run time (`time_ms`) | 1,394 ms | 1,465 ms | 1,653 ms |

p50 and p90 are the 5th and 9th of the ten values in order. Paid per run: mean 0.0019189 testnet
NEAR (range 0.0019100 to 0.0019412), of which OutLayer's charge is 0.0011427 and transaction gas
0.0007762. Testnet NEAR has no price; at the M0 spike's $4.72 per NEAR the same run on mainnet
would be about $0.009.

Where the time goes: the job itself takes about 1.4 s inside the worker (ten chain reads, five
from each provider, about 0.1 to 0.5 s each). The rest of the on-chain time is OutLayer picking up
the request and resolving it, the same 13 to 15 blocks the M0 spike measured. Every run here
was a cached one: the first run of this version (run 1 of DONE MEANS 2 below) was "Freshly
compiled" and took 18 blocks (10.6 s on chain, 14.8 s wall clock).

## DONE MEANS 2: three runs, one key

| Run | Transaction | Read block | Status | Signature (Node crypto) | Key |
| --- | --- | --- | --- | --- | --- |
| 1 | [FY4uhBHU...](https://testnet.nearblocks.io/txns/FY4uhBHUGHMioXvtkvjNLnohfp6PtVPBHXH6qs4xbAfm) | 275256934 | ok | valid | `ed25519:4gaYx4kP...uonuN` |
| 2 | [J3mAVr2b...](https://testnet.nearblocks.io/txns/J3mAVr2bjbQ3Szm2rHhR7S9VRjCTtM8etuGYQzJKKjAe) | 275256960 | ok | valid | the same |
| 3 | [8ytVrRxf...](https://testnet.nearblocks.io/txns/8ytVrRxfnqXDSJ7Uu5GFZtwkoe13G2Cxyh9n3EiMXgrP) | 275256985 | ok | valid | the same |

Each verdict decoded to `guard kaap-worker-1029053612.testnet, network testnet, dao
corm1gu.sputnikv2.testnet, proposal 1`, risk high, floor high, findings `[UNKNOWN_VALUE]`,
ai_status unavailable, expiry the read block's timestamp plus 600,000 ms; the explanation hash
matched the printed explanation, and a one-bit change to the signed bytes failed to verify. The
ten runs above passed the same checks under the same key.

The high floor is expected for this honest Transfer: the job has no price list yet, so every token
is unpriced, and an unpriced token is UNKNOWN_VALUE (high), never zero (C2). The AI part is
Unavailable on every run because Ram's NEAR AI key is not yet an OutLayer secret of this project;
the explanation says so.

## DONE MEANS 3: the providers forced to disagree

| Transaction | Input | Output |
| --- | --- | --- |
| [ACQcwBVx...](https://testnet.nearblocks.io/txns/ACQcwBVxwAKDQZSf7p8oi8ZWTotrLVNAhb89vp4wWFfW) | as above plus `"test_corrupt_https":true` | `{"reason":"providers disagree: get_proposal","status":"held","v":1}`, no signature |

## What the transaction returns, and the attestation

With `response_format` Json the contract returns the job's JSON with its keys sorted: 601 bytes on
every signed run (67 for the hold), under the 900-byte cap. The attestation of timed run 1
(`GET https://testnet-api.outlayer.ai/attestations/by-tx/7HvniWe5JKgqARsiWW8onQpSw1rPcHWiNG4vLwBtekSC`,
HTTP 200) names `project_id kaap-worker-1029053612.testnet/kaap-sealed`, `caller_account_id
kaap-worker-1029053612.testnet`, `wasm_hash` and `executed_wasm_sha256` both `0099d7b7...ff49`,
request 5833, and an Intel TDX quote; its `input_hash` is the sha256 of the exact input above and
its `output_hash` the sha256 of the returned output, both checked.

## Testnet NEAR spent

The worker account came from the faucet with 10 NEAR and held 9.965044 NEAR after everything
here: 0.034956 NEAR in all. The 14 runs (3, 1 and 10 above) account for 0.026979 by their
receipts; the remaining 0.007977 is `create_project`, mostly its storage deposit, which the
contract holds and refunds if the project is deleted.

## The first run that asked the model

Run once on 5 Nov 2026 at 14:23 UTC, from WSL, after the NEAR AI key became an OutLayer secret of
this project. The numbers above are from 29 Oct and an earlier build; this section is on its own.

| Thing | Value |
| --- | --- |
| Transaction | [5VFpn1vQ...](https://testnet.nearblocks.io/txns/5VFpn1vQKnDJ5fYBvSivMRJqghBPLjD6u7DrRyZGLK8G), signed by `kaap-worker-1029053612.testnet` |
| Proposal judged | `kaap-dao-1029064008.testnet` #9, guard `kaap-guard-1029061211.testnet` |
| Version (wasm sha256) | `73409203d24cbda98e98511bb97d1a2065b72702140138f85a198bff347cae87` |
| Verdict | risk critical, floor critical, findings `[DESC_CONTRADICTS, UNKNOWN_VALUE]`, `ai_status` verified |
| Model | `z-ai/glm-5.3-flash`, chat `8c0a5fbf538542b99aaf2406585ae48d` |
| Worker time | 15,683 ms against the 60 s limit |
| Instructions | 418,502,717 of the 10,000,000,000 allowed |
| Request to result | 38 blocks, 23,026 ms on chain, 27,171 ms wall clock |
| Paid | 0.00335 testnet NEAR: OutLayer's charge 0.00257, transaction gas 0.00078 |

The critical floor and both findings are Kaap's own rules, worked out before the model was asked.
The model can only raise a risk, never lower it, so this verdict would have been critical with no
model at all. The AI added the explanation and the second opinion.

To see what Kaap checked before it wrote `verified`, with node and curl, no account and no key:

```
bash scripts/WO-05a-evidence.sh 5VFpn1vQKnDJ5fYBvSivMRJqghBPLjD6u7DrRyZGLK8G
```

It reads the transaction's output from an archival RPC, hashes `kaap-verdict-v1\n` followed by the
verdict's borsh bytes (the output leaves that prefix off), and fetches the record stored under
`ai-evidence:<hash>`. It refuses, exit 1, when no record is stored there or the record names a
different verdict. It shows what the run recorded and does not repeat the checks itself.

| What the record says | Value |
| --- | --- |
| Model's Intel quote | TCB UpToDate, no advisories, TCB evaluation data number 20, 5,006 bytes |
| PCK flags | `smt_enabled`, `cached_keys` and `dynamic_platform` all true: accepted, not judged |
| GPUs | 8, passed by NVIDIA's NRAS |
| Gateway's Intel token | TCB UpToDate, no advisories. About NEAR AI's gateway only, not the model |
| Signature | ed25519 by `5a0210f2...caff`, the key the model's quote named, over the request and response hashes |
| Completion | finish reason `stop`, 452 prompt tokens, 323 completion tokens, of which 257 reasoning |

The record holds hashes and never the answer text. OutLayer's own verifier
(`outlayer-verify tx 5VFpn1vQKnDJ5fYBvSivMRJqghBPLjD6u7DrRyZGLK8G --network testnet`) said PROVEN:
this input produced this output inside genuine Intel TDX hardware, running code approved on chain.
That is about OutLayer's worker. The model's machine is covered by the record above.

## The combined build

Run on 6 Nov 2026 between 04:07 and 04:09 UTC, from WSL, on one machine. This section is on its
own: the numbers above are from earlier builds.

| Thing | Value |
| --- | --- |
| Version (wasm sha256) | `e1192b2806dd088541a87794808949fbe35ee5b3422405f07c224f4c02130527`, 1,582,424 bytes |
| Registered by | [add_version A6SXB84X...](https://testnet.nearblocks.io/txns/A6SXB84XCupvTXWLecteauyHqQzBYZTNC4cG5H7kGR9K) at 04:06:51 UTC, set active |
| Caller, all six runs | `kaap-worker-1029053612.testnet`, no `attached_usd` |
| Attestations, all six runs | `wasm_hash` and `executed_wasm_sha256` both the hash above, `caller_account_id` the worker. Those fields were read; the Intel quotes were not checked here |

No run named `secrets_ref`, so no NEAR AI key reached any of them and `ai_status` is unavailable
on purpose. The key's lock still names build `73409203...`, so this build has not asked the model.

### The worker runs free

This build charges every caller but the worker, and the job knows the worker only through
`NEAR_USER_ACCOUNT_ID`. This run carried no payment and got a signed verdict, not
`payment_below_price`, which is the first live proof that OutLayer sets that variable as its source
says.

| Thing | Value |
| --- | --- |
| Transaction | [BnsQmjvx...](https://testnet.nearblocks.io/txns/BnsQmjvxxmkLWDcPvs7Vqd8YL73GjVVXZMSujPxpdxLs) |
| Proposal judged | `kaap-dao-1029064008.testnet` #9, guard `kaap-guard-1029061211.testnet` |
| Verdict | status ok, risk critical, floor critical, findings `[DESC_CONTRADICTS, UNKNOWN_VALUE]`, `ai_status` unavailable |
| Verdict key | `ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN` |
| Worker time | 3,683 ms, the first run of this build ("Freshly compiled", 867 ms compile) |
| Instructions | 16,803,451 of the 10,000,000,000 allowed |
| Request to result | 22 blocks, 13,263 ms on chain, 18,291 ms wall clock |
| Paid | 0.00223 testnet NEAR: OutLayer's charge 0.00146, transaction gas 0.00078 |

### The sealed text channel

`node scripts/WO-05b-text-roundtrip.mjs` under Node 24: exit 0, `RESULT: pass`. This is the first
live use of `outlayer:encryption-keys`. The demo member filed proposal #10 on
`kaap-dao-1029064008.testnet`
([EgtdYXJZ...](https://testnet.nearblocks.io/txns/EgtdYXJZF44dVrJGGkrP5hiwa5cE291T16th1XFcKGxz)),
a sign request whose hash points to a text made up for the run.

| Step | Transaction | Output bytes | Blocks | On chain ms | Worker ms | Paid, NEAR |
| --- | --- | --- | --- | --- | --- | --- |
| Ask for the key | [JBtGvrRV...](https://testnet.nearblocks.io/txns/JBtGvrRVzFihc6Q4qfCzdHPynbhaV68s8ALxrb2mmM7H) | 270 | 17 | 9,867 | 2,617 | 0.0020210 |
| Judge with the sealed text | [GNvcy195...](https://testnet.nearblocks.io/txns/GNvcy195fqyRg9RAa3pQjEMgVJANF13Ku8yHiypFV623) | 673 | 16 | 9,978 | 3,107 | 0.0021202 |
| Attack: tampered ciphertext | [9BnN3oBy...](https://testnet.nearblocks.io/txns/9BnN3oByXqzZQ14xmDGaxpxzche2fT1mr6oVdpzrPKxz) | 73 | 15 | 9,008 | 2,621 | 0.0020669 |
| Attack: a thief's reply key | [14RVcgb7...](https://testnet.nearblocks.io/txns/14RVcgb7xw6XqysB8vbmaBXdgU15TcDUf3te45gZ8m4G) | 73 | 15 | 8,526 | 2,673 | 0.0020724 |
| Attack: a ciphertext for another key | [D33K6XX3...](https://testnet.nearblocks.io/txns/D33K6XX3ersrE53fsQU94FaApyvrCADGZvsWK2Yy5NJd) | 73 | 15 | 9,332 | 2,627 | 0.0020675 |

Paid over the five runs: 0.0103481 testnet NEAR, of which OutLayer's charge is 0.0063645 and
transaction gas 0.0039836. The filing is not counted.

- The job printed text key `09bc21bb...2f6a`, signed by the key the guard's `accepted_key` names.
- The request held ciphertext only: no part of the text in clear, plain or as base64.
- A later run opened a text sealed to that key, so the key from OutLayer's keystore held from one
  run to the next.
- The verdict came back risk critical, floor critical, findings `[HASH_TEXT_DANGEROUS]`, `ai_status`
  unavailable, with its signature and explanation hash checked by `check-output.mjs`.
- The printed explanation was `sealed:...`. It opened with the member's key to
  `AI unavailable (ai_key_missing).` and stayed shut for another key.
- Each attack got `{"reason":"text_ciphertext could not be opened","status":"refused","v":1}`, with
  no signature.

## Paid calls from a stranger

Run on 11 Nov 2026 from 05:23 UTC, from WSL, with `node scripts/WO-05e-paid-call.mjs`, against the
active build `e1192b28...`. This section is on its own. Testnet money only: testnet NEAR from the
faucet and `usdc.fakes.testnet`, whose own `mint` any testnet account may call once it has paid
the token's storage deposit.

| Thing | Value |
| --- | --- |
| Payer | `kaap-payer-1794374313.testnet`, a fresh faucet account, given 200,000 micro-USD by [mint 5En3HnaM...](https://testnet.nearblocks.io/txns/5En3HnaMZxiydZcL55F1KJFSvjC4J95rFZHCVgBoUfj7) |
| Payment key | nonce 1, made by [store_secrets 2j9QXaGL...](https://testnet.nearblocks.io/txns/2j9QXaGLqCfJS5aHzDhtGRXfx8pS6TDDSXn2AnhtqBfW) and topped up with 100,000 micro-USD by [ft_transfer_call CZocCBHb...](https://testnet.nearblocks.io/txns/CZocCBHbezz3u2QJvQfHePj44e1DciJzw7AbNDmmyJgB); limited to this project and 50,000 micro-USD a call |
| Input, every call | `{"v":1,"network":"testnet","guard":"kaap-guard-1029061211.testnet","dao":"kaap-dao-1029064008.testnet","proposal_id":9,"expires_in_ms":600000}`, the worker's six fields |
| Price | 10,000 micro-USD, one cent |

| # | Door | Paid, micro-USD | Call or transaction | Answer | Instructions | Worker ms | Wall ms | Compute cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | HTTPS | 10,000 | call `a97c82db-ecce-4ab1-adb5-8d4ff7de0c5a` | verdict | 16,804,680 | 2,817 | 4,120 | 1,018 micro-USD |
| 2 | HTTPS | 5,000 | call `ab14d0b3-a491-4e8d-873e-42ad744c12a9` | `payment_below_price` | 96,545 | 2,683 | 4,333 | 1,002 micro-USD |
| 3 | HTTPS | 0 | call `f79f5196-e698-4e4f-8044-bbf637e96afb` | `payment_below_price` | 97,783 | 2,703 | 3,843 | 1,002 micro-USD |
| 4 | chain | 10,000 `attached_usd` | [7UatZZiY...](https://testnet.nearblocks.io/txns/7UatZZiYH43zZzrcx4ghiydYVBJZHovf1dkrbTv2NAC) | verdict | 16,801,317 | 3,095 | 11,991 | 0.0013095 NEAR, plus 0.0008622 gas |
| 5 | chain | none | [9s9UMFue...](https://testnet.nearblocks.io/txns/9s9UMFuen5shte55JSMpuJjxQJ8L9ivSzBLjCSsoZifp) | `payment_below_price` | 96,431 | 3,378 | 17,047 | 0.0013378 NEAR, plus 0.0007911 gas |

- Both verdicts: risk critical, floor critical, findings `[DESC_CONTRADICTS, UNKNOWN_VALUE]`,
  `ai_status` unavailable, the same fields as the worker's run of 6 Nov. Each passed
  `check-output.mjs`. Both are signed by `ed25519:Hay4A8hpt81f4YbjHYFWR2LMwwKUYGVratcHoDE3PHaE`, the
  payer's own key and the same on both doors, not Kaap's `ed25519:4gaYx4kP...uonuN`, so the guard
  would refuse either one.
- Each refusal was `{"detail":"A check costs 10000 millionths of a dollar. This run carried <n>. An
  underpayment is not refunded.","reason":"payment_below_price","status":"refused","v":1}`, with no
  signature. A refused run reads nothing: about 97,000 instructions against 16.8 million for a check.
- Over HTTPS, `output` came back as a parsed JSON object, not a string.
- The key held 100,000 micro-USD before and 81,978 after: 15,000 attached and 3,022 compute.
- Call 4 was paid from 10,000 micro-USD the payer first deposited with OutLayer
  ([ft_transfer_call fCEzuZgp...](https://testnet.nearblocks.io/txns/fCEzuZgpwuCSbosTszKFf7gPo6Pgw4KbxioLEptvMQ9),
  `deposit_balance`). Its balance there was 0 after call 4.

### Kaap's earnings

| Reading | Before | After | Change |
| --- | --- | --- | --- |
| `get_developer_earnings("kaap-worker-1029053612.testnet")` on `outlayer.testnet`: the chain door, withdrawable with `withdraw_developer_earnings` | 0 | 10000 after call 4, still 10000 after call 5 | +10,000 |
| `GET https://testnet-api.outlayer.ai/public/project-earnings/kaap-worker-1029053612.testnet`: the HTTPS door, in OutLayer's database | `"balance":"0","total_earned":"0"` | `"balance":"15000","total_earned":"15000"` | +15,000 |

The `history` view lists three entries: `source` https, `amount` 10000, call `a97c82db...`; https,
5000, call `ab14d0b3...`; and blockchain, 10000, transaction `7UatZZiY...`, request 19911. So the
5,000 underpayment was kept, as OutLayer's docs say, and the call that carried nothing added
nothing. The public `balance` counts the HTTPS entries only. OutLayer has no withdrawal for HTTPS
earnings yet, so that 15,000 cannot be taken out today.

### OutLayer's own verifier

`outlayer-verify tx 7UatZZiYH43zZzrcx4ghiydYVBJZHovf1dkrbTv2NAC --network testnet --api
https://testnet-api.outlayer.ai` and `outlayer-verify call a97c82db-ecce-4ab1-adb5-8d4ff7de0c5a
--network testnet --api https://testnet-api.outlayer.ai --input <request> --output <response>` both
said PROVEN, exit 0: Intel TCB UpToDate, the enclave measurement listed as approved by
`worker.outlayer.testnet`, wasm `e1192b28...`, caller `kaap-payer-1794374313.testnet`, and
`attached payment 10000` inside what the quote commits to. The HTTPS proof needs the request and
response, which OutLayer keeps only as hashes; the script saves both. Evidence bundles of both
proofs were saved for re-checking offline.

### The builds without the price gate, removed

| Build | Removed by |
| --- | --- |
| `0099d7b7...ff49` | [remove_version 7ZCfunbc...](https://testnet.nearblocks.io/txns/7ZCfunbc3RheoREXJuiER7uxj7hokPuqm5JNMSZBeQpD) |
| `73409203...ae87` | [remove_version 8DPDYdqR...](https://testnet.nearblocks.io/txns/8DPDYdqRjjHsmG8Aezo9M7mrkTVyDYYNhaMVTwM1ysxu) |

Both signed by the project owner with `bash scripts/WO-05e-retire-versions.sh <sha256>`. Afterwards
`list_versions` names `e1192b28...` alone. Both stay in `testnet.json` with `retired: true`.

- An HTTPS call naming either removed build in `version_key` answered HTTP 200 with
  `{"status":"failed","error":"Failed to resolve project: Failed to parse version view","compute_cost":"0","instructions":0,"time_ms":0}`:
  nothing ran and nothing was charged. The same call naming `e1192b28...` ran and got
  `payment_below_price`.
- The worker's free run afterwards,
  [2tLDTczE...](https://testnet.nearblocks.io/txns/2tLDTczEgz5vNk46ULurV532eAJVeHUs9dktriug5Zxn),
  gave the same proposal 9 verdict under Kaap's key: 16,793,507 instructions, 4,330 ms in the
  worker, 0.00223 testnet NEAR.
- `kaap verify kaap-dao-1029064008.testnet 2` and `9` passed all 20 checks after the removals,
  though their runs, and the run that printed Kaap's key, ran on the removed builds. Past runs live in
  OutLayer's attestation records, not in the version list.

## The checked build

Run on 11 Nov 2026 between 06:25 and 06:28 UTC, from WSL, on one machine, under Node 24.22.2. This
section is on its own: the numbers above are from earlier builds.

| Thing | Value |
| --- | --- |
| Version (wasm sha256) | `bf7bb4f86fe7b1531946d8e5b5b7bab39d3e98a3a97ecab00dd9f0e4c4d34f58`, 1,583,153 bytes |
| Hosted at | the secret gist, commit `9f0c5cc2`. The publish script built the wasm again and checked that the served bytes had the same sha256 before it registered anything |
| Registered by | [add_version 8CdP5kjL...](https://testnet.nearblocks.io/txns/8CdP5kjLhvxDSwWJFiWPzUgiiuzEDvud8rXMg7xSGrr3) at 06:25:14 UTC, set active |
| Still listed | `e1192b28...`, no longer active. `list_versions` names both builds |
| Caller, all seven runs | `kaap-worker-1029053612.testnet`, no `attached_usd` |

No run named `secrets_ref`, because the NEAR AI key's lock still names build `e1192b28...`. So no
key reached any of them and `ai_status` is unavailable on purpose.

### The worker runs free

| Thing | Value |
| --- | --- |
| Transaction | [Edzq3KED...](https://testnet.nearblocks.io/txns/Edzq3KEDgXQBeLEEZ62mqRT97mAJMpVbZVcB3dxbh6sW) at 06:25:47 UTC |
| Proposal judged | `kaap-dao-1029064008.testnet` #9, guard `kaap-guard-1029061211.testnet`, read at block 277178025 |
| Verdict | status ok, risk critical, floor critical, findings `[DESC_CONTRADICTS, UNKNOWN_VALUE]`, `ai_status` unavailable, passed `check-output.mjs` |
| Verdict key | `ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN`, the same key as on every earlier build |
| Worker time | 4,330 ms, the first run of this build ("Freshly compiled", 1,184 ms compile) |
| Instructions | 16,804,882 of the 10,000,000,000 allowed |
| Request to result | 21 blocks, 12,439 ms on chain, 17,108 ms wall clock |
| Paid | 0.00234 testnet NEAR: OutLayer's charge 0.00155, transaction gas 0.00079 |

`outlayer-verify tx Edzq3KEDgXQBeLEEZ62mqRT97mAJMpVbZVcB3dxbh6sW --network testnet --api
https://testnet-api.outlayer.ai` said PROVEN, exit 0: Intel TCB UpToDate, the enclave measurement
listed as approved by `worker.outlayer.testnet`, wasm `bf7bb4f8...`, caller the worker, attached
payment 0. Its evidence bundle was saved for re-checking offline.

### The sealed text channel

`node scripts/WO-05b-text-roundtrip.mjs`: exit 0, `RESULT: pass`. The demo member filed proposal
#13 on `kaap-dao-1029064008.testnet`
([2MJB3m8A...](https://testnet.nearblocks.io/txns/2MJB3m8AHMx6pE5e6G7ZjJ7mbYQx4dwyQR8HDK3Kp4vH)),
a sign request whose hash points to a text made up for the run. It is left open.

| Step | Transaction | Output bytes | Blocks | On chain ms | Worker ms | Paid, NEAR |
| --- | --- | --- | --- | --- | --- | --- |
| Ask for the key | [Eg1XNnPf...](https://testnet.nearblocks.io/txns/Eg1XNnPfYyDQ2MgjchXNq3KRCUL6MqZ5R3AS7MBv8ZGA) | 270 | 17 | 8,879 | 2,740 | 0.0020543 |
| Judge with the sealed text | [6WmzAzw4...](https://testnet.nearblocks.io/txns/6WmzAzw4oWpWJrikdxhNgigQ4AcofGVuSMbajjBb8iAa) | 673 | 17 | 10,227 | 3,775 | 0.0022040 |
| Attack: tampered ciphertext | [HTENzUSE...](https://testnet.nearblocks.io/txns/HTENzUSEpoBwAL9dKRoiAc78vcxD8dsmvqahuhiZQrZ) | 73 | 15 | 8,645 | 2,730 | 0.0020944 |
| Attack: a thief's reply key | [5ZC6C3f5...](https://testnet.nearblocks.io/txns/5ZC6C3f5dojgC2iEm664ZpGwdJHg9g5ZLiKWT3RzbNKU) | 73 | 16 | 8,492 | 2,695 | 0.0020909 |
| Attack: a ciphertext for another key | [2ZAWpmCk...](https://testnet.nearblocks.io/txns/2ZAWpmCkESq4DFpXmS53H9V841XGpakmAsaWPsAwqrAT) | 73 | 18 | 10,956 | 2,696 | 0.0020914 |
| Attack: a text that matches no payload | [7UsmD7Ke...](https://testnet.nearblocks.io/txns/7UsmD7KeHfcYACf31vesFPygG78ckq4W2mMciycy7ySr) | 57 | 16 | 9,608 | 3,265 | 0.0021426 |

Paid over the six runs: 0.0126776 testnet NEAR, of which OutLayer's charge is 0.0077901 and
transaction gas 0.0048875. The filing, 0.0002925 NEAR of gas, is not counted.

- The job printed text key `09bc21bb...2f6a`, the same key `deployments/testnet.json` recorded from
  build `e1192b28...`: a new version of the project keeps its text key, as it keeps its verdict key.
- The verdict came back risk critical, floor critical, findings `[HASH_TEXT_DANGEROUS]`, `ai_status`
  unavailable, checked by `check-output.mjs`. Its sealed explanation opened with the member's key to
  `AI unavailable (ai_key_missing).` and stayed shut for another key.
- The three attacks first run on 6 Nov each got this again, with no signature:
  `{"reason":"text_ciphertext could not be opened","status":"refused","v":1}`.
- The new attack, a text sealed the right way to the job's key whose hash is not the proposal's
  payload, got exactly `{"reason":"text_does_not_match","status":"refused","v":1}`, with no
  signature. It took 31,005,118 instructions against about 7,600,000 for a ciphertext that does not
  open, because the job reads the proposal before it can compare the text's hash with it.

## What these runs do not cover

- One proposal, one location, one 8-minute window, runs one after another. No load, nothing
  concurrent, nothing on mainnet.
- The NEAR AI call inside OutLayer: one keyed run only, on one proposal, signed through the test
  script and not yet through the worker's own path. Every other run here had no key and never
  asked the model. A refused chat call was exercised only in the local wasmtime build.
- Three checks WO-05d owes: replaying RTMR3 from its event log, comparing MRCONFIGID against
  `app_compose`, and an allowlist of approved model builds. Until then "verified" means a genuine,
  non-debug Intel TDX machine whose GPUs NVIDIA passed holds the key that signed this exact answer,
  not that it runs a build Kaap has reviewed.
- The host's lag: the host read at the HTTPS provider's final block every time, so the one-retry
  path for a host that is a block behind never ran.
- OutLayer's own quote: this script checks the named fields and the two hashes only. Intel's
  signature and the worker's measurements are checked by OutLayer's `outlayer-verify`, which said
  PROVEN on the keyed run above.
- Prices and payment history on a live mainnet read. The job refuses an input whose network differs
  from the run's (`parse_input` in `src/input.rs`, kept on purpose) and this project runs on
  testnet, so a mainnet read cannot be proven from here. Prices and history stay proven on recorded
  real pages until a mainnet project exists.
- The combined build and the checked build asking the model. Their runs had no key, so the AI step,
  the checks around it and a sealed text reaching the model have not run live on either build.
- Paid runs: one payer, one proposal, five calls one after another. That a paid run writes no
  public evidence is proven by the tests only. No withdrawal was tried on either door.
- Why OutLayer refuses a removed build: its answer is the error text above, not the
  `invalid_version_key` refusal its API spec names, and the code behind it is closed.
- The leak check on the live round trip reads the job's output. OutLayer's logs are not open to the
  script, so the logged half of that check ran only on the local build.
