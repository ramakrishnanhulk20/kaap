# Testnet proof: a disguised payment killed by Kaap on the live testnet

Run on 11 Nov 2026 between 07:30 and 07:34 UTC, inside WSL, with Node 22.23.2 and near-api-js 7.4.0, against NEAR testnet (RPC `https://rpc.testnet.fastnear.com`) and the deployment made the same morning from commit `413a74a`. The four proposals were filed at testnet blocks 277184659, 277184718, 277184814 and 277184874.

In one command, `node scripts/prove.mjs` does the following:

1. A member of a real Sputnik DAO 3.2 treasury files planted attack #17: "Monthly salary payment to alice...", which in fact pays the lookalike account `a1ice...`.
2. Kaap's sealed job on OutLayer reads the proposal at a final block from two RPC providers, judges it and signs a verdict.
3. The verdict is recorded in kaap-registry.
4. kaap-guard casts VoteReject, and the proposal is Rejected.
5. The same verdict is handed to the guard a second time, and the guard refuses it.
6. An honest payment (planted control #57) goes through the same path. It is recorded and left alone.

It passed twice in a row, on fresh proposals each time (#1 and #2 in run 1, #3 and #4 in run 2).

The script signs with Kaap's own testnet keys. "How to run it again" below says who can run what, and how anyone can check these runs from the chain with no key.

## What it ran against

| Thing | Value |
|---|---|
| Treasury | `kaap-dao-1111072928.testnet`, Sputnik DAO 3.2, code hash `DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF`, purpose `Kaap demo treasury` ([deploy and init](https://testnet.nearblocks.io/txns/GJDgwXkEEFqrRR4p24ruZrjdvtcM3Hrp9r1RboWx3ePz)) |
| Its policy | the role setup of a live NEAR Business treasury on mainnet, read at final finality on 29 Oct 2026 and saved with its members removed in `deployments/near-business-policy.json`. Its two member places are filled with `kaap-owner-1029061211.testnet` and `kaap-member-1029064001.testnet` in the Requestor, Admin and Approver roles. Approver votes on transfer and call need 2 of 2. A `guard` role holds `kaap-guard-1111072803.testnet` alone, with `<kind>:VoteReject` on the 16 kinds other than `remove_member_from_role`, threshold 1. |
| Enrolment | the DAO's own proposal #0, a FunctionCall to `enroll` with 0.01 NEAR attached: [filed](https://testnet.nearblocks.io/txns/FW7cfYjbeZiv66SDV7teXkmGMRDxqi8HXnczrS4ZNhLF), [owner approves](https://testnet.nearblocks.io/txns/Gj6Ne1u5hcKTvyqsTV68M5bVFKKWkoR8gS4UHqi4nh4P), [member approves and it executes](https://testnet.nearblocks.io/txns/3rYQZ6qqtWaXUrk64yd8Jkp5rRB7xspwmCzXPV9Tdd2x) |
| No keys on the DAO | after setup, the DAO's only full-access key was [deleted](https://testnet.nearblocks.io/txns/GWAwWeDcpid7d2snZx2xY1t1qXvrFerztKgaZ7gJY2hZ), and the account now has 0 access keys, like a DAO made by the factory. Nobody, including us, can change its code or sign as it. Only its own approved proposals act for it. |
| Guard | `kaap-guard-1111072803.testnet`, code hash `DrjaN1zVz4cxvvxbxhM6rVZsqy8SrBunmMbyeqbsr4R4` (sha256 `bf09d7bbb48f312eb4043bd7b585f3b02bbe9d8b7d5bc0bf31fec9319c663767`), owner `kaap-owner-1029061211.testnet`, [deploy and init](https://testnet.nearblocks.io/txns/DEta1bNNm4gRYLqhZJ2HfwDnVtz294dgyEyLfiQVzsK1), [key deleted](https://testnet.nearblocks.io/txns/6qEFvNiz5Guw1w2XaA6cS36kkRVhAJbPTtijgPEcTssM), no access keys |
| Registry | `kaap-registry-1111072803.testnet`, code hash `3Kro1EgWDYAawFx8RHUwVGTKmJvp9bAUeRL65cwGAoZz` (sha256 `228c21366ffdaf58f31a6e3550fd9898bc9ae65d1182f7a9e84d2df3c07fb2c9`), [deploy and init](https://testnet.nearblocks.io/txns/53xJksmZUhokY6rVNzXNcnadxAUEaN1RWPkdhJwMwiT7), [key deleted](https://testnet.nearblocks.io/txns/GxMNoCaecyMRfF5k1dqtsxB4uCydKz8fUpzBkMm9gUF1), no access keys |
| Built from | commit `413a74aa91256a8c8603d1f84df33fde64abbcd3`, with `cargo near build non-reproducible-wasm --locked` (cargo-near 0.22.0, Rust 1.93.0) as `scripts/deploy-contracts-testnet.sh` runs it. Built twice, in two separate target folders: both builds gave the two sha256 above, and each code hash on chain is that sha256 in base58. |
| Sealed job | OutLayer project `kaap-worker-1029053612.testnet/kaap-sealed`, called by `kaap-worker-1029053612.testnet`, live build `bf7bb4f86fe7b1531946d8e5b5b7bab39d3e98a3a97ecab00dd9f0e4c4d34f58` |
| Verdict key | `ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN`. Setup checks that the guard's and the registry's `accepted_key()` both equal the key printed by the attested run [7HvniWe5...](https://testnet.nearblocks.io/txns/7HvniWe5JKgqARsiWW8onQpSw1rPcHWiNG4vLwBtekSC) |
| Text key | `09bc21bb...2f6a`, printed again by the live build in [DWRwVAcw...](https://testnet.nearblocks.io/txns/DWRwVAcwpoVo5yfMHVVmWRw4S9QGNNj9XVioMDjobXBW) and signed by the verdict key; its attestation names build `bf7bb4f8...4f58` |

Every id is also in `deployments/testnet.json`. The first deployment, of 29 Oct 2026, is still on chain and kept in `deployments/testnet-2026-10-29.json`; its proof is summed up at the end of this file.

## How to run it again

The `npm install` line below is for anyone and signs nothing. The other two need keys only Kaap holds, so in another clone they stop with "no key". Both need Node 24 and near-api-js 7.4.0 at the repo root.

- `setup-demo-dao.mjs` needs the guard owner's key, `kaap-owner-1029061211.testnet`, one of the two Approvers, on every run. On the set-up DAO it then signs nothing: it checks, and rewrites `deployments/testnet.json`. A fresh setup also signs as the member and as the new DAO account, and fetches Sputnik's code with curl and python3.
- `prove.mjs` signs as the member `kaap-member-1029064001.testnet`, the worker `kaap-worker-1029053612.testnet` (the only caller whose verdicts the guard accepts) and the run's fresh sub-account of the member.

Anyone can check the runs without these keys, as "Checking it with no key" below shows.

Inside WSL, with Node 24, from the repo root:

```
npm install --no-save --no-package-lock near-api-js@7.4.0
node scripts/setup-demo-dao.mjs   # idempotent: on a set-up DAO it only checks
node scripts/prove.mjs            # exit code 0 only when every check below passes
```

The member's and the worker's keys are read from `~/.near-credentials/testnet` and never printed. Each run makes a fresh sub-account of the member, funded by the member with 0.1 NEAR. That account creates the payees for that run, so `alice.sandbox` becomes `alice.<that account>` and the lookalike still differs by one character. A run does not use the faucet, which gives one account per machine every 11 hours or so.

### Checking it with no key

Anyone can check what the two runs left on chain, reading only. With near-cli-rs 0.30.1:

```
near contract call-function as-read-only kaap-dao-1111072928.testnet get_proposal json-args '{"id":1}' network-config testnet now
near account view-account-summary kaap-dao-1111072928.testnet network-config testnet now
```

The first shows proposal #1 Rejected, with the guard's vote alone. The second shows the DAO locked, with no access keys, running Sputnik 3.2. With Node 24 and the built CLI:

```
node packages/cli/dist/src/bin.js verify kaap-dao-1111072928.testnet 1 --network testnet
node packages/cli/dist/src/bin.js arming kaap-dao-1111072928.testnet --network testnet
```

`verify` takes any of the four proposals, #1 to #4. Build the CLI once with `npm install` at the repo root, then `npm run build` in `packages/cli`; that compiles kaap-core to wasm, so it needs the toolchain in `rust-toolchain.toml` and wasm-bindgen-cli 0.2.129. The contracts can be rebuilt and compared as `packages/contracts/guard/README.md` and `packages/contracts/registry/README.md` describe. The two planted records come from `eval/planted/planted.jsonl`: `python3 -I eval/tools/planted/generate.py` (Python 3) rebuilds that file and compares it byte for byte, and `node eval/tools/check.mjs` (Node 24) checks its labels. Neither needs a network.

## Setup output

Unedited.

```
Kaap M1 testnet setup, 2026-11-11T07:29:26.883Z, RPC https://rpc.testnet.fastnear.com, near-api-js 7.4.0
sealed key printed by attested run 7HvniWe5JKgqARsiWW8onQpSw1rPcHWiNG4vLwBtekSC: ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN
accepted_key(): guard ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN, registry ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN
NEAR Business template: the role setup of a live NEAR Business treasury on mainnet, read 29 Oct 2026, members removed; in deployments/near-business-policy.json
created kaap-dao-1111072928.testnet (faucet)
deployed Sputnik 3.2 to kaap-dao-1111072928.testnet and ran new: https://testnet.nearblocks.io/txns/GJDgwXkEEFqrRR4p24ruZrjdvtcM3Hrp9r1RboWx3ePz
checked kaap-dao-1111072928.testnet: code hash DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF, purpose "Kaap demo treasury", policy equals the NEAR Business shape with our members and the guard role
filed enrolment proposal #0 as kaap-member-1029064001.testnet: https://testnet.nearblocks.io/txns/FW7cfYjbeZiv66SDV7teXkmGMRDxqi8HXnczrS4ZNhLF
kaap-owner-1029061211.testnet approved #0: https://testnet.nearblocks.io/txns/Gj6Ne1u5hcKTvyqsTV68M5bVFKKWkoR8gS4UHqi4nh4P
kaap-member-1029064001.testnet approved #0: https://testnet.nearblocks.io/txns/3rYQZ6qqtWaXUrk64yd8Jkp5rRB7xspwmCzXPV9Tdd2x
deleted kaap-dao-1111072928.testnet's only full-access key: https://testnet.nearblocks.io/txns/GWAwWeDcpid7d2snZx2xY1t1qXvrFerztKgaZ7gJY2hZ
kaap-dao-1111072928.testnet access keys: 0

kaap-guard-1111072803.testnet.is_enrolled(kaap-dao-1111072928.testnet) = true
DAO:     kaap-dao-1111072928.testnet https://testnet.nearblocks.io/address/kaap-dao-1111072928.testnet
  Requestor: kaap-owner-1029061211.testnet, kaap-member-1029064001.testnet
  Admin: kaap-member-1029064001.testnet, kaap-owner-1029061211.testnet
  Approver: kaap-owner-1029061211.testnet, kaap-member-1029064001.testnet
  guard: kaap-guard-1111072803.testnet
state written to deployments/testnet.json
```

## Run 1

```
Kaap M1 proof on testnet, 2026-11-11T07:30:47.956Z
DAO kaap-dao-1111072928.testnet (Sputnik DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF), enrolled in kaap-guard-1111072803.testnet, guard accepts ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN
payees root: m1-1111073049.kaap-member-1029064001.testnet, made by kaap-member-1029064001.testnet with 0.100000 NEAR: https://testnet.nearblocks.io/txns/DvTNFHHdvytG65zhv7W1DSZbQNFFHH1fhFYkFYtcqeFt
payee:       a1ice.m1-1111073049.kaap-member-1029064001.testnet created with 0.010000 NEAR and no key: https://testnet.nearblocks.io/txns/F72vtpLxWGALzoDFVaR7tJX1HgbjR8vxTdkmWQgdnqJN
payee:       alice.m1-1111073049.kaap-member-1029064001.testnet created with 0.010000 NEAR and no key: https://testnet.nearblocks.io/txns/gy7W1s9BDBdnNGqiAoSfioCNMJhv8UB9Wqu2AANhBmM
payee:       bob.m1-1111073049.kaap-member-1029064001.testnet created with 0.010000 NEAR and no key: https://testnet.nearblocks.io/txns/2mreAekYNv9zGkoqGkJ79rhDNzFsA2mH1FxSqceVCdev

== attack: planted:17, pays a lookalike of alice.sandbox while naming the real account
description: "Monthly salary payment to alice.m1-1111073049.kaap-member-1029064001.testnet."
kind:        Transfer of 500.000000 NEAR to a1ice.m1-1111073049.kaap-member-1029064001.testnet
filed:       proposal #1 by kaap-member-1029064001.testnet, add_proposal at block 277184659: https://testnet.nearblocks.io/txns/GaQuPteeaiPAqjow7ezLC7f2HqxbBHv53erE1N4C7g9A
final:       #1 readable at final block 277184660, status InProgress, kind 145 bytes
sealed job:  status ok, OutLayer charge 0.001419 NEAR, worker 4194 ms: https://testnet.nearblocks.io/txns/az5yNU7xixz2Qwrt8g4pNhygJTpceRqHJTK2zv7NF3J
verdict risk: critical, floor: critical, findings: [DESC_CONTRADICTS, UNKNOWN_VALUE], ai_status: unavailable
explanation: AI unavailable (ai_key_missing): no NEAR AI key reached this run.
sealed signature: valid for key ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN (accepted by guard)
verdict:     names guard kaap-guard-1111072803.testnet, testnet, kaap-dao-1111072928.testnet, #1, kind_hash 78c6ae3211b13118..., read at block 277184673, expires 2026-11-11T07:41:17.194Z
recorded:    registry index 0, storage kept 0.006380 NEAR, refunded 0.013620 NEAR, block 277184692: https://testnet.nearblocks.io/txns/2T8fbLoy9gkFkbLThTMPsbRCf4RckfZVMVBvwvfqePmy
registry:    latest(testnet, kaap-dao-1111072928.testnet, 1) = risk critical, floor critical, findings [DESC_CONTRADICTS, UNKNOWN_VALUE], recorded by kaap-worker-1029053612.testnet
veto:        kaap-guard-1111072803.testnet -> kaap-dao-1111072928.testnet.act_proposal {"id":1,"action":"VoteReject","proposal"... at block 277184702: https://testnet.nearblocks.io/txns/AWWzynnmDdCYaKeSJA66Kr3h7DxW6ni9Sh6uHtH6v4M9
guard:       veto_cast emitted, veto_result(59fbf0cfc8d7...) = "Ok"
status: Rejected
votes: {kaap-guard-1111072803.testnet: Reject}
replay:      the same verdict and kind again: refused with ERR_REPLAY: https://testnet.nearblocks.io/txns/5RJA3n4kkwofrfAvnQdA74tt13QCjDGcRCn6moMmBtW9
C5  held: the vote's proposal is the 145 bytes get_proposal returned at final block 277184660, unchanged; the guard matched their canonical hash to the verdict's kind_hash and Sputnik matched them to the stored kind (else ERR_WRONG_KIND_HASH or ERR_WRONG_KIND)
C9  held: critical on a critical plain-code floor (DESC_CONTRADICTS) with ai_status unavailable, so plain code alone carried the veto
C15 held: the guard's only receipts were kaap-dao-1111072928.testnet.act_proposal with action VoteReject and its own on_veto_result; the votes map holds only the guard's Reject
C19 held: the verdict names this guard, network, DAO, proposal and kind with an expiry, and its second use was refused with ERR_REPLAY
C22 held: the job signed only because both providers agreed at final block 277184673; a disagreement prints held, signs nothing, and fails this case
time:        24.1 s from the add_proposal block 277184659 to the guard's vote at block 277184702 (43 blocks)

== control: planted:57, control: honest proposal that resembles an attack
description: "Monthly salary payment of 500 NEAR to bob.m1-1111073049.kaap-member-1029064001.testnet."
kind:        Transfer of 500.000000 NEAR to bob.m1-1111073049.kaap-member-1029064001.testnet
filed:       proposal #2 by kaap-member-1029064001.testnet, add_proposal at block 277184718: https://testnet.nearblocks.io/txns/5crWMpTHppoT6LywUxBdS42UiwzSk2QvUfPsCELAkpuo
final:       #2 readable at final block 277184719, status InProgress, kind 143 bytes
sealed job:  status ok, OutLayer charge 0.001515 NEAR, worker 5152 ms: https://testnet.nearblocks.io/txns/7w8vHh8t1tSDwzW5jMVvCnSaNDfLSYKgji7ccd4Pxvmq
verdict risk: high, floor: high, findings: [UNKNOWN_VALUE], ai_status: unavailable
explanation: AI unavailable (ai_key_missing): no NEAR AI key reached this run.
sealed signature: valid for key ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN (accepted by guard)
verdict:     names guard kaap-guard-1111072803.testnet, testnet, kaap-dao-1111072928.testnet, #2, kind_hash b48652b9a5cba528..., read at block 277184733, expires 2026-11-11T07:41:51.995Z
recorded:    registry index 0, storage kept 0.006370 NEAR, refunded 0.013630 NEAR, block 277184751: https://testnet.nearblocks.io/txns/5qB4XroBPaqeA7PsbHo5C2j9x7GoCPTZGeEmiCt92Nt8
registry:    latest(testnet, kaap-dao-1111072928.testnet, 2) = risk high, floor high, findings [UNKNOWN_VALUE], recorded by kaap-worker-1029053612.testnet
veto try:    refused by the guard with ERR_NOT_VETOABLE: https://testnet.nearblocks.io/txns/6MjKL1nPym9LVjkPRt6eAVpjzevXjsLcj34DUEkpL2rJ
status: InProgress
no veto
votes: {}
C9  held: an honest payment gets high on a high floor, no critical finding, and the guard refuses to vote on it (ERR_NOT_VETOABLE)
C22 held: the job signed only because both providers agreed at final block 277184733

== testnet NEAR spent by this run (13 transactions)
paid by kaap-member-1029064001.testnet, kaap-worker-1029053612.testnet, m1-1111073049.kaap-member-1029064001.testnet: 0.078043 NEAR (balances before and after)
  gas burnt 0.032359, OutLayer 0.002935, registry storage 0.012750, moved to the new payees 0.030000
  create m1-1111073049.kaap-member-1029064001.testnet: 8.57 Tgas burnt, 0.007115 NEAR
  create a1ice.m1-1111073049.kaap-member-1029064001.testnet: 8.37 Tgas burnt, 0.007095 NEAR
  create alice.m1-1111073049.kaap-member-1029064001.testnet: 8.37 Tgas burnt, 0.007095 NEAR
  create bob.m1-1111073049.kaap-member-1029064001.testnet: 8.37 Tgas burnt, 0.007095 NEAR
  kaap-dao-1111072928.testnet.add_proposal: 2.97 Tgas burnt, 0.000274 NEAR
  outlayer.testnet.request_execution: 8.56 Tgas burnt, 0.000789 NEAR
  kaap-registry-1111072803.testnet.record: 3.56 Tgas burnt, 0.000312 NEAR
  kaap-guard-1111072803.testnet.veto: 8.85 Tgas burnt, 0.000796 NEAR
  kaap-guard-1111072803.testnet.veto (refused): 2.32 Tgas burnt, 0.000210 NEAR
  kaap-dao-1111072928.testnet.add_proposal: 2.99 Tgas burnt, 0.000276 NEAR
  outlayer.testnet.request_execution: 8.61 Tgas burnt, 0.000794 NEAR
  kaap-registry-1111072803.testnet.record: 3.59 Tgas burnt, 0.000314 NEAR
  kaap-guard-1111072803.testnet.veto (refused): 2.17 Tgas burnt, 0.000194 NEAR
attack: 24.1 s from add_proposal to the guard's vote, proposal #1 Rejected

RESULT: pass
```

## Run 2

```
Kaap M1 proof on testnet, 2026-11-11T07:32:18.740Z
DAO kaap-dao-1111072928.testnet (Sputnik DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF), enrolled in kaap-guard-1111072803.testnet, guard accepts ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN
payees root: m1-1111073220.kaap-member-1029064001.testnet, made by kaap-member-1029064001.testnet with 0.100000 NEAR: https://testnet.nearblocks.io/txns/C1JU4RoCPwimxUT6VJsBRo1tTAS8UAgcmXzHC3Yq8RPD
payee:       a1ice.m1-1111073220.kaap-member-1029064001.testnet created with 0.010000 NEAR and no key: https://testnet.nearblocks.io/txns/6mv3Dz56QqNkQC75fsWEPosUe6crB9EQWKHTApWGGWZm
payee:       alice.m1-1111073220.kaap-member-1029064001.testnet created with 0.010000 NEAR and no key: https://testnet.nearblocks.io/txns/4xmTNguDJmoqTpdbpFY61jwLLL8cDcpGTuxjzfAYjc2m
payee:       bob.m1-1111073220.kaap-member-1029064001.testnet created with 0.010000 NEAR and no key: https://testnet.nearblocks.io/txns/C4Apf9E6WpmDcYfxsJBhBoNrXrFjE8Uiy4cZPoQtXaGs

== attack: planted:17, pays a lookalike of alice.sandbox while naming the real account
description: "Monthly salary payment to alice.m1-1111073220.kaap-member-1029064001.testnet."
kind:        Transfer of 500.000000 NEAR to a1ice.m1-1111073220.kaap-member-1029064001.testnet
filed:       proposal #3 by kaap-member-1029064001.testnet, add_proposal at block 277184814: https://testnet.nearblocks.io/txns/Fa9vfxzQbB7agRsutPmUS2b3p4FRYmDhp8Dqygjw3Yeb
final:       #3 readable at final block 277184815, status InProgress, kind 145 bytes
sealed job:  status ok, OutLayer charge 0.001346 NEAR, worker 3462 ms: https://testnet.nearblocks.io/txns/4TxRqqMeQJCC1QFzhhzcozBZn1w3ZcDyLX4qXNJH4DSy
verdict risk: critical, floor: critical, findings: [DESC_CONTRADICTS, UNKNOWN_VALUE], ai_status: unavailable
explanation: AI unavailable (ai_key_missing): no NEAR AI key reached this run.
sealed signature: valid for key ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN (accepted by guard)
verdict:     names guard kaap-guard-1111072803.testnet, testnet, kaap-dao-1111072928.testnet, #3, kind_hash 218ffeb8d5354639..., read at block 277184829, expires 2026-11-11T07:42:48.772Z
recorded:    registry index 0, storage kept 0.006380 NEAR, refunded 0.013620 NEAR, block 277184847: https://testnet.nearblocks.io/txns/dojYJ2CGQPeuDSdDHj9E8aEBpyBSgN92nLJKLjoSH6r
registry:    latest(testnet, kaap-dao-1111072928.testnet, 3) = risk critical, floor critical, findings [DESC_CONTRADICTS, UNKNOWN_VALUE], recorded by kaap-worker-1029053612.testnet
veto:        kaap-guard-1111072803.testnet -> kaap-dao-1111072928.testnet.act_proposal {"id":3,"action":"VoteReject","proposal"... at block 277184857: https://testnet.nearblocks.io/txns/FmT4ZtmprVsLBNS1E6kAvfXyCqzTG1HtoR1gXRyfkDdm
guard:       veto_cast emitted, veto_result(0f3fc7efed33...) = "Ok"
status: Rejected
votes: {kaap-guard-1111072803.testnet: Reject}
replay:      the same verdict and kind again: refused with ERR_REPLAY: https://testnet.nearblocks.io/txns/HQGEyPEV2fnvN7fomYadzoSP2ZE2qWQQLeAWeHVs4D2X
C5  held: the vote's proposal is the 145 bytes get_proposal returned at final block 277184815, unchanged; the guard matched their canonical hash to the verdict's kind_hash and Sputnik matched them to the stored kind (else ERR_WRONG_KIND_HASH or ERR_WRONG_KIND)
C9  held: critical on a critical plain-code floor (DESC_CONTRADICTS) with ai_status unavailable, so plain code alone carried the veto
C15 held: the guard's only receipts were kaap-dao-1111072928.testnet.act_proposal with action VoteReject and its own on_veto_result; the votes map holds only the guard's Reject
C19 held: the verdict names this guard, network, DAO, proposal and kind with an expiry, and its second use was refused with ERR_REPLAY
C22 held: the job signed only because both providers agreed at final block 277184829; a disagreement prints held, signs nothing, and fails this case
time:        24.7 s from the add_proposal block 277184814 to the guard's vote at block 277184857 (43 blocks)

== control: planted:57, control: honest proposal that resembles an attack
description: "Monthly salary payment of 500 NEAR to bob.m1-1111073220.kaap-member-1029064001.testnet."
kind:        Transfer of 500.000000 NEAR to bob.m1-1111073220.kaap-member-1029064001.testnet
filed:       proposal #4 by kaap-member-1029064001.testnet, add_proposal at block 277184874: https://testnet.nearblocks.io/txns/HCYFqKhrbL9MzSBKqhozwfY2i7fUaiXJeJ7F99ZydFwp
final:       #4 readable at final block 277184875, status InProgress, kind 143 bytes
sealed job:  status ok, OutLayer charge 0.001325 NEAR, worker 3254 ms: https://testnet.nearblocks.io/txns/6UjsRehkndVTq5EyZmWMLFaSFghay2zXGd5mgNjP6p5X
verdict risk: high, floor: high, findings: [UNKNOWN_VALUE], ai_status: unavailable
explanation: AI unavailable (ai_key_missing): no NEAR AI key reached this run.
sealed signature: valid for key ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN (accepted by guard)
verdict:     names guard kaap-guard-1111072803.testnet, testnet, kaap-dao-1111072928.testnet, #4, kind_hash 5990d80c2c9008a2..., read at block 277184888, expires 2026-11-11T07:43:22.360Z
recorded:    registry index 0, storage kept 0.006370 NEAR, refunded 0.013630 NEAR, block 277184906: https://testnet.nearblocks.io/txns/8AVD5LtycLcAMH43DgWuxHPchyZJqx8qRkZ48SVSZHFA
registry:    latest(testnet, kaap-dao-1111072928.testnet, 4) = risk high, floor high, findings [UNKNOWN_VALUE], recorded by kaap-worker-1029053612.testnet
veto try:    refused by the guard with ERR_NOT_VETOABLE: https://testnet.nearblocks.io/txns/E529qeuLKEpydCujBGnD5DCqgjXgrjfJFmfS9S1my12A
status: InProgress
no veto
votes: {}
C9  held: an honest payment gets high on a high floor, no critical finding, and the guard refuses to vote on it (ERR_NOT_VETOABLE)
C22 held: the job signed only because both providers agreed at final block 277184888

== testnet NEAR spent by this run (13 transactions)
paid by kaap-member-1029064001.testnet, kaap-worker-1029053612.testnet, m1-1111073220.kaap-member-1029064001.testnet: 0.077798 NEAR (balances before and after)
  gas burnt 0.032377, OutLayer 0.002672, registry storage 0.012750, moved to the new payees 0.030000
  create m1-1111073220.kaap-member-1029064001.testnet: 8.57 Tgas burnt, 0.007115 NEAR
  create a1ice.m1-1111073220.kaap-member-1029064001.testnet: 8.37 Tgas burnt, 0.007095 NEAR
  create alice.m1-1111073220.kaap-member-1029064001.testnet: 8.37 Tgas burnt, 0.007095 NEAR
  create bob.m1-1111073220.kaap-member-1029064001.testnet: 8.37 Tgas burnt, 0.007095 NEAR
  kaap-dao-1111072928.testnet.add_proposal: 3.00 Tgas burnt, 0.000277 NEAR
  outlayer.testnet.request_execution: 8.62 Tgas burnt, 0.000795 NEAR
  kaap-registry-1111072803.testnet.record: 3.59 Tgas burnt, 0.000315 NEAR
  kaap-guard-1111072803.testnet.veto: 8.89 Tgas burnt, 0.000799 NEAR
  kaap-guard-1111072803.testnet.veto (refused): 2.32 Tgas burnt, 0.000210 NEAR
  kaap-dao-1111072928.testnet.add_proposal: 3.02 Tgas burnt, 0.000279 NEAR
  outlayer.testnet.request_execution: 8.61 Tgas burnt, 0.000794 NEAR
  kaap-registry-1111072803.testnet.record: 3.59 Tgas burnt, 0.000314 NEAR
  kaap-guard-1111072803.testnet.veto (refused): 2.17 Tgas burnt, 0.000194 NEAR
attack: 24.7 s from add_proposal to the guard's vote, proposal #3 Rejected

RESULT: pass
```

## Checked afterwards with the CLI

Anyone can run both commands below: they read only and hold no key. They need Node 24 and the built CLI (see "Checking it with no key").

The same deployment, read by `kaap` from a clone of this repo (Node 26.7.0), at 07:33 and 08:38 UTC:

```
$ node packages/cli/dist/src/bin.js arming kaap-dao-1111072928.testnet --network testnet
guard: kaap-guard-1111072803.testnet; enrolled in the guard: yes
armed: yes. The guard's one reject decides every kind except remove_member_from_role, which Kaap leaves out on purpose so the DAO can always remove Kaap.

$ node packages/cli/dist/src/bin.js verify kaap-dao-1111072928.testnet 3
Kaap on testnet: deployment record deployments/testnet.json (the current one, deployed 2026-11-11T07:28:03Z): guard kaap-guard-1111072803.testnet, registry kaap-registry-1111072803.testnet, ...
proposal 3 is Rejected at block 277191611
the guard voted to reject with this verdict, and the DAO took the vote
result: all 20 checks pass
```

`verify` checks the attack's verdict down to the sealed run that signed it (build `bf7bb4f8...4f58`) and the attested run that printed the guard's key. It does not check Intel's signature on the TDX quotes; it says so and names OutLayer's own tool for that.

## Time and testnet NEAR

**Time from the attack's `add_proposal` block to the guard's vote landing:**

| Run | Proposal | add_proposal block | Vote block | Blocks | Seconds |
|---|---|---|---|---|---|
| 1 | #1 | 277184659 | 277184702 | 43 | 24.1 |
| 2 | #3 | 277184814 | 277184857 | 43 | 24.7 |

p50 of the two runs is 24.1 s, taking the nearest rank as RUNS.md does, which with two values is the lower one. The middle point of the two is 24.4 s. On 29 Oct the same proof took 21.8 s and 21.2 s (39 and 37 blocks).

Where the time goes:
- The script waits for each step to reach final finality before it starts the next.
- The sealed job takes 13 to 15 blocks from request to result (RUNS.md).
- The sealed job's worker time on the attacks was 4.2 s and 3.5 s here, against 1.4 s on 29 Oct, when the live build was `0099d7b7` (381 KB) rather than `bf7bb4f8` (1.58 MB). The 4 to 6 extra blocks line up with that; I did not trace it further.
- The worker reaction a real deployment would add is not here.

**Testnet NEAR per run** (the balances of the member, the worker and the run's payee parent, before and after; what is left in the payee parent is counted back as ours):

| | Run 1 | Run 2 |
|---|---|---|
| Paid in total | 0.078043 | 0.077798 |
| Gas, all 13 transactions | 0.032359 | 0.032377 |
| OutLayer's charge, 2 sealed runs | 0.002935 | 0.002672 |
| Registry storage, 2 records, kept for good | 0.012750 | 0.012750 |
| Left in the 3 new payee accounts (moved, not burnt) | 0.030000 | 0.030000 |

**Gas by transaction.** The two runs agree to within 0.06 Tgas. Run 1's figures:

| Transaction | Tgas burnt | NEAR |
|---|---|---|
| create the payee parent (CreateAccount, Transfer, AddKey) | 8.57 | 0.007115 |
| create one payee (CreateAccount, Transfer), times 3 | 8.37 | 0.007095 |
| `add_proposal`, times 2 | 2.97 to 2.99 | 0.000274 to 0.000276 |
| `request_execution` on OutLayer, gas only, times 2 | 8.56 to 8.61 | 0.000789 to 0.000794 |
| `registry.record`, times 2 | 3.56 to 3.59 | 0.000312 to 0.000314 |
| `guard.veto`, vote cast | 8.85 | 0.000796 |
| `guard.veto`, the replay refused with ERR_REPLAY | 2.32 | 0.000210 |
| `guard.veto`, the control refused with ERR_NOT_VETOABLE | 2.17 | 0.000194 |

The gap to GAS.md is explained by account creation. Of run 1's 0.0324 NEAR of gas:
- 0.0284 NEAR went on creating the payee parent and its three payees;
- 0.0040 NEAR went on the two filings and Kaap's seven transactions.

The veto itself costs what GAS.md says: 8.85 to 8.89 Tgas and 0.0008 NEAR here, against 8.26 Tgas and 0.00083 NEAR in the sandbox. The kind here is 145 bytes against 106, and the account names are longer.

Each account creation costs 0.0071 NEAR, the same to the last digit as on 29 Oct. Measured then in [4vWA8eFr...](https://testnet.nearblocks.io/txns/4vWA8eFrYUf3i8CNstYTs62WuLQYshfDpSGZWsBcFL21):
- The receipt that creates the account burnt 7.42 Tgas but 0.007022 NEAR.
- That is about 0.0063 NEAR more than its gas costs at that block's gas price of 100,000,000 yoctoNEAR per gas, which is the minimum.
- So the protocol burns a fixed amount on top of the gas each time an account is created. That is measured; I did not trace it to a protocol parameter.

These accounts are demo scaffolding. Kaap's own path does not create any.

The registry kept 0.00638 NEAR per attack record, against 0.00555 in GAS.md. GAS.md says longer names cost more, and here the DAO id has 27 characters and the recorder 30, against 11 and 14 in the test.

What one stopped attack costs Kaap, without the proposer's own filing (run 2):
- the sealed run: 0.00080 gas plus 0.00135 OutLayer;
- the record: 0.00032 gas plus 0.00638 storage;
- the veto: 0.00080.

That is about 0.0096 testnet NEAR, two thirds of it the record's storage. At the early OutLayer trial's $4.72 per NEAR, the same on mainnet would be about 4.5 cents.

## The invariants, and where the output shows them

| Invariant | What the output shows | Enforced in |
|---|---|---|
| C5, the vote is tied to the stored kind | `C5 held`: the script compares the guard's `act_proposal` receipt arguments byte for byte with `{"id":N,"action":"VoteReject","proposal":<kind>}`, where `<kind>` is the bytes `get_proposal` returned at final (145 bytes). Sputnik accepted the vote, which it does only when that kind equals the stored one (ERR_WRONG_KIND otherwise). | `packages/contracts/guard/src/lib.rs`, `veto` (canonical kind hash checked against the verdict, `kind_json` forwarded unchanged) |
| C9, the guard vetoes only a critical verdict backed by a plain-code finding | Attack: `verdict risk: critical, floor: critical, findings: [DESC_CONTRADICTS, UNKNOWN_VALUE], ai_status: unavailable`, vetoed. Control: `risk high, floor high, findings [UNKNOWN_VALUE]`, refused with ERR_NOT_VETOABLE, `status: InProgress`, `no veto`. | guard `lib.rs`, `is_vetoable`; kaap-core `severity.rs` (DESC_CONTRADICTS is critical when value moves) |
| C15, the guard can only cast VoteReject | `C15 held`: in the veto transaction the guard created exactly two receipts, `act_proposal` with action VoteReject to the DAO and its own `on_veto_result`. `votes: {kaap-guard-1111072803.testnet: Reject}` and nothing else. | guard `lib.rs`, `veto` (the method and the action are fixed in the code) |
| C19, a verdict is used once | `replay: the same verdict and kind again: refused with ERR_REPLAY`, a real transaction each run. The verdict line shows it names the guard, testnet, the DAO, the proposal id, the kind hash and an expiry. | guard `lib.rs`, `veto` (the `vetoes` map, keyed by the verdict's hash) |
| C22, the sealed job's reads agreed | `sealed job: status ok` and `C22 held` with the final block the job read at. A disagreement makes the job print `held` and sign nothing, and the script then fails the case. The sealed job's first testnet trial forced that once ([ACQcwBVx...](https://testnet.nearblocks.io/txns/ACQcwBVxwAKDQZSf7p8oi8ZWTotrLVNAhb89vp4wWFfW)). | `packages/sealed/src/reads.rs`, `read_chain`, and `job.rs`, `run` |

## No AI answer, and why the veto still stands

No NEAR AI key reached these runs, so every verdict here says `ai_status: unavailable`, and its explanation says `ai_key_missing`. The attack was still vetoed, on the plain-code floor alone. That is the design (C9):
- A description that contradicts a payment is a deterministic critical finding.
- An AI answer can raise a verdict, never lower it.
- An AI answer can only make a verdict critical when it is verified.

The control's high floor comes from UNKNOWN_VALUE. The sealed job has no price source yet, so every token counts as unpriced. This gap has been known since 29 Oct 2026. The guard does not vote on a high verdict.

## The race this demo does not hide

The treasury needs both Approvers to pass a payment, so one approval never executes it, and the guard has time to vote first. The live NEAR Business policy is 2 of 2 too. A treasury where one approval is enough loses that race: the payment runs inside the approver's own transaction, and the guard's later vote finds nothing to reject (shown before the build by a sandbox test on the real Sputnik 3.2 binary, `alice_alone_approves_first`). Kaap cannot protect such a treasury against an approver acting alone.

## Why it was deployed again on 11 Nov

The contracts deployed on 29 Oct were built at commit `8818af0`, before the verdict format moved into its own crate (`packages/verdict`), so their code no longer matched the source. The 11 Nov deployment is built from the source as it stands, so what an auditor reads is what runs. The setup, the deploy and both proof runs went through on the first try. The first `kaap verify` of #3 could not read the sealed run: the one archive node the CLI used answered HTTP 429. The CLI now fails over between archive hosts and reads less from them, and the same command passes all 20 checks.

## What this does not cover

- One treasury, one attack family (a payment to a lookalike of the named account) and one control. The hidden-approver attack (#01) depends on the plain-code description checks and is left to the attack suite.
- The script plays the worker. Nothing here watches the chain or reacts on its own; that is the worker's job (`packages/worker`).
- No AI answer was asked for (no key reached the runs), and no price source exists, so no verdict here is low.
- Runs one after another from one machine: no load and nothing concurrent. No approver raced the guard, because the attack proposals were never approved by anyone.
- The payees are keyless accounts made for the demo. The 500 NEAR payments could not have paid out, because the treasury does not hold 500 NEAR. The guard's vote does not depend on that, and the Rejected status is the proof.
- The control proposals #2 and #4 stay InProgress until their 7-day period ends.
- The contracts are cargo-near's non-reproducible builds. Two builds on one machine, in separate target folders, gave the same bytes; a build on another machine was not tried.
- Testnet only. The only mainnet read was the one on 29 Oct that saved the NEAR Business policy.

## The first deployment, 29 Oct 2026

The first testnet proof ran against contracts built at commit `8818af0`. They are still on chain, their records stay valid, and recorded test fixtures still point at them. Every id is kept in `deployments/testnet-2026-10-29.json`, whose ids are never changed.

| Thing | Value |
|---|---|
| Treasury | `kaap-dao-1029064008.testnet`, Sputnik DAO 3.2, the same policy shape, its key [deleted](https://testnet.nearblocks.io/txns/4giSEanWSMba3yPoBZkrKAjNs6mUprFXG4dsBntrweP4) |
| Guard | `kaap-guard-1029061211.testnet`, code hash `77fyhhxdRnHzb8efe9HBYL8C3KcUpEbbRjLvrNyqoxbP`, no access keys |
| Registry | `kaap-registry-1029061211.testnet`, code hash `65Y2p3NqwjE8z8oXdzvRPjDWux2SXmHrxxzAhpqwPdqY`, no access keys |

On 29 Oct the proof passed twice in a row, at 07:10 and 07:12 UTC. Attack #2 was Rejected in 21.8 s ([veto GGCGBiiH...](https://testnet.nearblocks.io/txns/GGCGBiiHRpBPcEfqUgxAnQCAYyFJGZHGVver3mhCNdGq), [replay refused](https://testnet.nearblocks.io/txns/7tnhU3yqPMDKy9gMS1VkXKrvhuvnmq2Gp1vug4xJSC8C)) and attack #4 in 21.2 s ([veto 7kxeMEfm...](https://testnet.nearblocks.io/txns/7kxeMEfmJoNXn2aNyx6VntTeh4TuC8miYGXMyBGE4sLi), [replay refused](https://testnet.nearblocks.io/txns/FjvUD5SzTp8B3AfgxiUGuENUWzMdk7rjXvNUujjRLBoA)). Controls #3 and #5 were refused with ERR_NOT_VETOABLE and left InProgress. The full output of those runs is in this file as of commit `cec15a0`.

What went wrong on the way that day:
- The first attack-only run passed: proposal #1, Rejected, [veto 8JeFv3Yi...](https://testnet.nearblocks.io/txns/8JeFv3YitSeY5VNu5j8nihNiywmFBFgxb6XMSzu1xEN), 24.2 s.
- The first whole run stopped before any Kaap transaction. The faucet answered HTTP 429 ("retry in 11 hours") to the per-run account it was asked for. The payee parent is now a sub-account of the member.
- The retry stopped on `actions.addKey is not a function`: near-api-js 7.4.0 exports `addFullAccessKey`. That line was fixed.
- The next run's payee parent, funded with 0.05 NEAR, could not afford the third payee. Each account creation must show about 0.0175 NEAR up front. That parent, `m1-1029070926.kaap-member-1029064001.testnet`, holds its two payees and 0.0158 NEAR. The parent now gets 0.1 NEAR.
- Two key files in `~/.near-credentials/testnet` belong to accounts that were never made (`kaap-m1-1029070403`, `m1-1029070538.kaap-member-1029064001`). They are harmless.

## 12 Nov 2026: the watcher by itself, and the try-it key

The runs above had a script play the watcher. On 12 Nov 2026 the watcher itself ran on one machine (`bash scripts/run-worker-local.sh`) against the same deployment, and four fake thefts were filed while it ran. Nothing but the watcher sent a transaction after each filing.

| Request | Filed by | Seconds to the guard's reject | AI answer | Sealed run | Guard's vote | Record |
|---|---|---|---|---|---|---|
| #8 | `scripts/file-attack.mjs`, the member's key | 61.6 | did not answer in time | [De7LAV9c...](https://testnet.nearblocks.io/txns/De7LAV9ctgVifL4xXRRskHwhLtBTYDzvPTZfhEQZoKbQ) | [2qsVGxvx...](https://testnet.nearblocks.io/txns/2qsVGxvxG7YwnXy7PUoubmJEnpX9F36XkvphmsW4y6PE) | [AA1z4eyi...](https://testnet.nearblocks.io/txns/AA1z4eyiPEZ8MZdEKDpNsnHrK6WKHzxbeGYr3NpaE4v2) |
| #9 | `scripts/check-demo-filer.mjs`, the filing-only key | 40.1 | verified | [6ZpRoT8C...](https://testnet.nearblocks.io/txns/6ZpRoT8Cvu2aj5QvWt7VkT5QYY9iNCjZcu3ZFjsZWMEL) | [G1WRfaAc...](https://testnet.nearblocks.io/txns/G1WRfaAc8tS1jVemCntMivnovBiBEJq7S5Cptfcqxufc) | [w56wsMGK...](https://testnet.nearblocks.io/txns/w56wsMGKfog8XV6J9Mhc9SfVJBcwFD8SeYSKfgUnCPX) |
| #10 | the site's button | 462, held | verified | [FeqrFYwP...](https://testnet.nearblocks.io/txns/FeqrFYwPeBDbjdYZ2HxoKrbPbBwuVtyV69iRTx25fyJ7) | [5fNFrszf...](https://testnet.nearblocks.io/txns/5fNFrszf5kVVLbVnJmNvibAhgVk5x4eqVwfKm981aZ3K) | [3hYb18SB...](https://testnet.nearblocks.io/txns/3hYb18SBYSpxvt7dKoFJpY69ZC1djwg3bKNTJ7VbzYtQ) |
| #11 | the site's button | about 44 | verified | [FgFUZqma...](https://testnet.nearblocks.io/txns/FgFUZqmaZ9ujWSq24RXo9ssBsyedNcPQpxiJ63Q8bGjc) | [Byx1V6XQ...](https://testnet.nearblocks.io/txns/Byx1V6XQQVzqaa1W7w7PioyhrFkRNJJ8EkBATq6J28ca) | [aLyiv1uQ...](https://testnet.nearblocks.io/txns/aLyiv1uQn6eXD9PiR4vx3peAuDvAPz3SiSW84L1zCKH) |

Every verdict was critical, with the findings DESC_CONTRADICTS and UNKNOWN_VALUE, and every request ended Rejected by the guard's vote alone. On its first start the watcher also read the five requests already open on the treasury (#2, #4, #5, #6, #7), rated each high with a verified AI answer, recorded each verdict and voted on none, as it should: two are honest payments and three ask for a signature over a hash nobody has explained.

### The vote that was held

Request #10 is the one to read closely. The watcher never acts on one RPC provider alone, and that day its second provider, fastnear's free testnet endpoint, had begun refusing its requests seven minutes after it started. The verdict for #10 was signed and recorded 54 seconds after the filing, but the vote was held: `veto_held` on the status page, "live state not agreed" in the log, retried every 15 seconds. The watcher was then restarted on two other free providers, dRPC and Intear, and the vote landed about 40 seconds later, inside the verdict's ten-minute life. Request #11, on those providers, took about 44 seconds.

Two things this shows. A provider that will not answer delays a vote and never causes a wrong one. And a guard that depends on free providers can be late: had the verdict expired first, the watcher would have needed a fresh sealed run. `packages/worker/HOSTING.md` now names dRPC and Intear, and says what to watch for.

### The try-it key, attacked

The site's button files with an access key of the demo member that NEAR limits to one method on one contract. `node scripts/check-demo-filer.mjs --wait` tries five other uses, then the one allowed use:

```
Kaap demo filer check, 2026-11-12T11:47:20.005Z: key ed25519:9q7PNx97fjXi1wBbXtvgNdPwy4WtcixW6rfSAFc96X51 of kaap-member-1029064001.testnet
PASS  refused before it ran: vote to approve request #2 on the treasury (sending Bpgqx8WfGX1sxDG6q37cJAhdPaSqPEHCzxmvbNp5pbFe failed: Access key does not allow method act_proposal)
PASS  refused before it ran: send 1 yoctoNEAR out of the member account (sending Ap2c8rL6txfdRMdQM77TKpysGCUKpe7gVSP5MuQ9Vxdk failed: Access key requires full access)
PASS  refused before it ran: call add_proposal on a different contract (sending 3vttdWVaGxeU2gMh8QcFGsKq3gzjHb8V6AZjVnGyHSYm failed: Access key receiver kaap-dao-1111072928.testnet does not match transaction receiver kaap-guard-1111)
PASS  refused before it ran: call add_proposal with a deposit attached (sending 7xEMffZ9Kx7WieF6rvBJB4A4uDwZFiiHEw7j7APHV8qU failed: Deposit is not allowed with function call)
PASS  refused before it ran: add another key to the member account (sending DbXeeUofuX6p7PsKskdSP7WGGpWQBg9qXZfviZFZY9BX failed: Access key requires full access)
PASS  the one allowed call: filed request #9 at block 277358632 (2026-11-12T11:47:24.201Z): https://testnet.nearblocks.io/txns/2BKYGWpiH6J6vjEcrWuymvNY68W8iWEabrj9MVscAjaM
now waiting for the watcher; this script sends nothing more
status: Rejected, seen at final 40.1 s after the filing block; votes: {kaap-guard-1111072803.testnet: Reject}
RESULT: pass, 5 of 5 attacks refused, and the guard alone rejected the filed request
```

Each refusal comes from the network, before the transaction runs, so none of them is a promise made by Kaap's code.

### What this does not cover

These runs were on one machine, for about half an hour. They do not show the watcher staying up for days, restarting by itself after a crash on a host, or holding its limits behind a hosting platform's proxy.

## 12 Nov 2026: the watcher on its host

Later the same day the watcher moved to a host: one container on Railway, built from `packages/worker/Dockerfile`, with its key file on a mounted disk (`packages/worker/HOSTING.md`). The one on the machine was stopped first, since two watchers must never share an account. Its status page is public: https://watcher-production-2350aa2a.up.railway.app/status.

Its database was new, so on its first start it read the five requests still open on the treasury (#2, #4, #5, #6, #7) again. It rated each high, recorded each verdict and voted on none, as before. Four AI answers were verified and one, on #4, was not, which changes nothing: no veto rests on the AI.

Then one more fake theft was filed from the site's button, with nothing else running:

| Request | Filed by | Seconds to the guard's reject | AI answer | Filing | Sealed run | Guard's vote | Record |
|---|---|---|---|---|---|---|---|
| #12 | the site's button | about 44 | answered, could not be verified, so not relied on | [26PbW5r5...](https://testnet.nearblocks.io/txns/26PbW5r5YmvgN54eXcnt4QXAPWTw9uG5zfHo8k3YY8pq) | [62P4EqAV...](https://testnet.nearblocks.io/txns/62P4EqAVJHrvk6eFFNdq6589547JJGuEFbBdLbtvs2PB) | [35eKdZrh...](https://testnet.nearblocks.io/txns/35eKdZrh5ps18kGCHo5Fa9LZLaceYjZ8LpTFPFgjgAJY) | [Avn8ja4n...](https://testnet.nearblocks.io/txns/Avn8ja4nScK76VWahAQKxYwvTafJaRqd58oAwkbEtC7d) |

The verdict was critical, with the findings DESC_CONTRADICTS and UNKNOWN_VALUE. `node packages/cli/dist/src/bin.js verify kaap-dao-1111072928.testnet 12` passes all 24 of its checks.

### The caller limit, attacked on the live host

The watcher gives each caller ten subscription tokens an hour and a few sealed texts, counted by address. Behind a host's proxy that address comes from a header, and which header the proxy overwrites is the host's behaviour, so the limit was attacked where it runs. `node scripts/attack-caller-limit.mjs` asks twelve times, each time claiming another address in both `X-Forwarded-For` and `X-Real-IP`.

Against the first hosted build:

```
watcher: https://watcher-production-2350aa2a.up.railway.app
answers to 12 asks, each under another made-up address: 404 404 404 404 404 404 404 404 404 404 404 404
RESULT: FAIL, 12 asks were counted separately: the watcher believed a made-up address
```

That build read the last entry of `X-Forwarded-For`. That is right behind a proxy that adds its own entry, and wrong behind Railway's, which hands a caller's own header through untouched and writes the caller's address into `X-Real-IP` instead. Behind a host's proxy the watcher now reads only `X-Real-IP` (`KAAP_HTTP_PROXY=x-real-ip`), and a missing, doubled or unreadable value counts against the proxy itself. Against the build with that fix, deployed about ten minutes after the first one began answering:

```
watcher: https://watcher-production-2350aa2a.up.railway.app
answers to 12 asks, each under another made-up address: 404 404 404 404 404 404 404 404 404 404 429 429
RESULT: pass, the limit bit after 10 asks: the made-up addresses changed nothing
```

The watcher's log line for the refusal names the address it counted. It was the public address of the machine that ran the attack, so Railway had written over the made-up `X-Real-IP`.

What the hole allowed while it was open: asking for more tokens than the limit, and sending more sealed texts than the limit, each of which starts a paid sealed run, until the treasury's daily cap of 60 runs stopped them. It never put a vote, a payment or a verdict within reach. The site's own routes read `X-Forwarded-For` in the same way, and now follow the same rule (`packages/web/lib/caller.ts`).

### What this does not cover

One press and one attack, on the host's first day. Not shown: the watcher staying up for days or coming back by itself after a crash, a caller on IPv6 (the attack ran over IPv4), and the site's limits behind its own host, where it is not deployed yet. The watcher still runs on free RPC providers.
