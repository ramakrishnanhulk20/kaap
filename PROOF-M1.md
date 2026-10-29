# M1 proof: a disguised payment killed by Kaap on the live testnet

Run on 29 Oct 2026 between 07:09 and 07:13 UTC, inside WSL, with Node 24.22.2 and near-api-js 7.4.0, against NEAR testnet (RPC `https://rpc.testnet.fastnear.com`). The four proposals were filed at testnet blocks 275266727, 275266783, 275266913 and 275266966.

In one command, `node scripts/prove-m1.mjs` does the following:

1. A member of a real Sputnik DAO 3.2 treasury files planted attack #17: "Monthly salary payment to alice...", which in fact pays the lookalike account `a1ice...`.
2. Kaap's sealed job on OutLayer reads the proposal at a final block from two RPC providers, judges it and signs a verdict.
3. The verdict is recorded in kaap-registry.
4. kaap-guard casts VoteReject, and the proposal is Rejected.
5. The same verdict is handed to the guard a second time, and the guard refuses it.
6. An honest payment (planted control #57) goes through the same path. It is recorded and left alone.

It passed twice in a row, on fresh proposals each time (#2 and #3 in run 1, #4 and #5 in run 2).

## What it ran against

| Thing | Value |
|---|---|
| Treasury | `kaap-dao-1029064008.testnet`, Sputnik DAO 3.2, code hash `DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF` ([deploy and init](https://testnet.nearblocks.io/txns/77VM5xSUk3ry9Yp2xDU1etyFTf5451g8E6D6RNrdRpav)) |
| Its policy | the role setup of a live NEAR Business treasury on mainnet, read at final finality on 29 Oct 2026 and saved with its members removed in `deployments/near-business-policy.json`. Its two member places are filled with `kaap-owner-1029061211.testnet` and `kaap-member-1029064001.testnet` in the Requestor, Admin and Approver roles. Approver votes on transfer and call need 2 of 2. A `guard` role holds `kaap-guard-1029061211.testnet` alone, with `<kind>:VoteReject` on the 16 kinds other than `remove_member_from_role`, threshold 1. |
| Enrolment | the DAO's own proposal #0, a FunctionCall to `enroll` with 0.01 NEAR attached: [filed](https://testnet.nearblocks.io/txns/26XwzGhSTfWGseSo7DbmUWLW7oUVqkzBWqA2kPwrq9sm), [owner approves](https://testnet.nearblocks.io/txns/2Vecmijonji1eNvzzMC27WYhJWwCtGzox9JYy15dU2sc), [member approves and it executes](https://testnet.nearblocks.io/txns/CBhdoDc1F1PGTFRgjJL5RrEu3BbHoLZB9efS9GyCaZHu) |
| No keys on the DAO | after setup, the DAO's only full-access key was [deleted](https://testnet.nearblocks.io/txns/4giSEanWSMba3yPoBZkrKAjNs6mUprFXG4dsBntrweP4), and the account now has 0 access keys, like a DAO made by the factory. Nobody, including us, can change its code or sign as it. Only its own approved proposals act for it. |
| Guard | `kaap-guard-1029061211.testnet`, code hash `77fyhhxdRnHzb8efe9HBYL8C3KcUpEbbRjLvrNyqoxbP`, no access keys |
| Registry | `kaap-registry-1029061211.testnet`, code hash `65Y2p3NqwjE8z8oXdzvRPjDWux2SXmHrxxzAhpqwPdqY`, no access keys |
| Sealed job | OutLayer project `kaap-worker-1029053612.testnet/kaap-sealed`, called by `kaap-worker-1029053612.testnet` |
| Verdict key | `ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN`. Setup checks that the guard's and the registry's `accepted_key()` both equal the key printed by the attested run [7HvniWe5...](https://testnet.nearblocks.io/txns/7HvniWe5JKgqARsiWW8onQpSw1rPcHWiNG4vLwBtekSC) |

Every id is also in `deployments/testnet.json`.

## How to run it again

Inside WSL, with Node 24, from the repo root:

```
npm install --no-save --no-package-lock near-api-js@7.4.0
node scripts/WO-02c-setup-testnet.mjs   # idempotent: on a set-up DAO it only checks
node scripts/prove-m1.mjs               # exit code 0 only when every check below passes
```

The member's and the worker's keys are read from `~/.near-credentials/testnet` and never printed. Each run makes a fresh sub-account of the member, funded by the member with 0.1 NEAR. That account creates the payees for that run, so `alice.sandbox` becomes `alice.<that account>` and the lookalike still differs by one character. A run does not use the faucet, which gives one account per machine every 11 hours or so.

## Setup output (the run that deleted the DAO's key)

One line is edited after the run: the source treasury's id and block are removed, as they are from the template.

```
Kaap M1 testnet setup, 2026-10-29T07:09:16.664Z, RPC https://rpc.testnet.fastnear.com, near-api-js 7.4.0
sealed key printed by attested run 7HvniWe5JKgqARsiWW8onQpSw1rPcHWiNG4vLwBtekSC: ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN
accepted_key(): guard ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN, registry ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN
NEAR Business policy: [source treasury and block removed] get_policy() at final finality (mainnet), saved in deployments/near-business-policy.json
checked kaap-dao-1029064008.testnet: code hash DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF, policy equals the NEAR Business shape with our members and the guard role
deleted kaap-dao-1029064008.testnet's only full-access key: https://testnet.nearblocks.io/txns/4giSEanWSMba3yPoBZkrKAjNs6mUprFXG4dsBntrweP4
kaap-dao-1029064008.testnet access keys: 0

kaap-guard-1029061211.testnet.is_enrolled(kaap-dao-1029064008.testnet) = true
DAO:     kaap-dao-1029064008.testnet https://testnet.nearblocks.io/address/kaap-dao-1029064008.testnet
  Requestor: kaap-owner-1029061211.testnet, kaap-member-1029064001.testnet
  Admin: kaap-member-1029064001.testnet, kaap-owner-1029061211.testnet
  Approver: kaap-owner-1029061211.testnet, kaap-member-1029064001.testnet
  guard: kaap-guard-1029061211.testnet
state written to deployments/testnet.json
```

## DONE MEANS 1 and 2: run 1

```
Kaap M1 proof on testnet, 2026-10-29T07:10:08.645Z
DAO kaap-dao-1029064008.testnet (Sputnik DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF), enrolled in kaap-guard-1029061211.testnet, guard accepts ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN
payees root: m1-1029071010.kaap-member-1029064001.testnet, made by kaap-member-1029064001.testnet with 0.100000 NEAR: https://testnet.nearblocks.io/txns/4VmpexcJznRArAzCvLKucFAaUuxZwWfJLWrvfWVXyysg
payee:       a1ice.m1-1029071010.kaap-member-1029064001.testnet created with 0.010000 NEAR and no key: https://testnet.nearblocks.io/txns/Fw31xtegqWzfEA9iH9P6kERfyLwgWbyNypnWykx9CBvC
payee:       alice.m1-1029071010.kaap-member-1029064001.testnet created with 0.010000 NEAR and no key: https://testnet.nearblocks.io/txns/99M579RGgJ6Qxe33F9FE44Cj7Fk9oJpfXhAJePhREcsT
payee:       bob.m1-1029071010.kaap-member-1029064001.testnet created with 0.010000 NEAR and no key: https://testnet.nearblocks.io/txns/4vWA8eFrYUf3i8CNstYTs62WuLQYshfDpSGZWsBcFL21

== attack: planted:17, pays a lookalike of alice.sandbox while naming the real account
description: "Monthly salary payment to alice.m1-1029071010.kaap-member-1029064001.testnet."
kind:        Transfer of 500.000000 NEAR to a1ice.m1-1029071010.kaap-member-1029064001.testnet
filed:       proposal #2 by kaap-member-1029064001.testnet, add_proposal at block 275266727: https://testnet.nearblocks.io/txns/FhPjyZ9qK57Qoz8eQ1YxvCgADkX9uT1BhoGmcNWx6nxg
final:       #2 readable at final block 275266728, status InProgress, kind 145 bytes
sealed job:  status ok, OutLayer charge 0.001138 NEAR, worker 1378 ms: https://testnet.nearblocks.io/txns/7vT7uwgwggGUc3CpNgLApgyjFS4s65KTfZTbMF2enx6T
verdict risk: critical, floor: critical, findings: [DESC_CONTRADICTS, UNKNOWN_VALUE], ai_status: unavailable
explanation: AI unavailable: no NEAR AI key is set for this project yet.
sealed signature: valid for key ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN (accepted by guard)
verdict:     names guard kaap-guard-1029061211.testnet, testnet, kaap-dao-1029064008.testnet, #2, kind_hash c6ca399d50131402..., read at block 275266740, expires 2026-10-29T07:20:36.092Z
recorded:    registry index 0, storage kept 0.006380 NEAR, refunded 0.013620 NEAR, block 275266756: https://testnet.nearblocks.io/txns/F6HUKKH9tdnwu2FhKqK3vGpokMHZcNaKGSp5DPUL94QQ
registry:    latest(testnet, kaap-dao-1029064008.testnet, 2) = risk critical, floor critical, findings [DESC_CONTRADICTS, UNKNOWN_VALUE], recorded by kaap-worker-1029053612.testnet
veto:        kaap-guard-1029061211.testnet -> kaap-dao-1029064008.testnet.act_proposal {"id":2,"action":"VoteReject","proposal"... at block 275266766: https://testnet.nearblocks.io/txns/GGCGBiiHRpBPcEfqUgxAnQCAYyFJGZHGVver3mhCNdGq
guard:       veto_cast emitted, veto_result(0ade6df454aa...) = "Ok"
status: Rejected
votes: {kaap-guard-1029061211.testnet: Reject}
replay:      the same verdict and kind again: refused with ERR_REPLAY: https://testnet.nearblocks.io/txns/7tnhU3yqPMDKy9gMS1VkXKrvhuvnmq2Gp1vug4xJSC8C
C5  held: the vote's proposal is the 145 bytes get_proposal returned at final block 275266728, unchanged; the guard matched their canonical hash to the verdict's kind_hash and Sputnik matched them to the stored kind (else ERR_WRONG_KIND_HASH or ERR_WRONG_KIND)
C9  held: critical on a critical plain-code floor (DESC_CONTRADICTS) with ai_status unavailable, so plain code alone carried the veto
C15 held: the guard's only receipts were kaap-dao-1029064008.testnet.act_proposal with action VoteReject and its own on_veto_result; the votes map holds only the guard's Reject
C19 held: the verdict names this guard, network, DAO, proposal and kind with an expiry, and its second use was refused with ERR_REPLAY
C22 held: the job signed only because both providers agreed at final block 275266740; a disagreement prints held, signs nothing, and fails this case
time:        21.8 s from the add_proposal block 275266727 to the guard's vote at block 275266766 (39 blocks)

== control: planted:57, control: honest proposal that resembles an attack
description: "Monthly salary payment of 500 NEAR to bob.m1-1029071010.kaap-member-1029064001.testnet."
kind:        Transfer of 500.000000 NEAR to bob.m1-1029071010.kaap-member-1029064001.testnet
filed:       proposal #3 by kaap-member-1029064001.testnet, add_proposal at block 275266783: https://testnet.nearblocks.io/txns/5bpnsuNGCMfi8DoJDLcrVcBADX1DEKGnAEN5bDcw4TT2
final:       #3 readable at final block 275266784, status InProgress, kind 143 bytes
sealed job:  status ok, OutLayer charge 0.001131 NEAR, worker 1313 ms: https://testnet.nearblocks.io/txns/H9vkjqzAYFtjCeY7ZEf7RAECaFbSqVFkPUrMfCaRCJ94
verdict risk: high, floor: high, findings: [UNKNOWN_VALUE], ai_status: unavailable
explanation: AI unavailable: no NEAR AI key is set for this project yet.
sealed signature: valid for key ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN (accepted by guard)
verdict:     names guard kaap-guard-1029061211.testnet, testnet, kaap-dao-1029064008.testnet, #3, kind_hash e177fdd891405cd0..., read at block 275266794, expires 2026-10-29T07:21:06.829Z
recorded:    registry index 0, storage kept 0.006370 NEAR, refunded 0.013630 NEAR, block 275266810: https://testnet.nearblocks.io/txns/GkcLWsnfBS49nq3qDWXezUvFA1BYbpAM9gyJXHteE7J7
registry:    latest(testnet, kaap-dao-1029064008.testnet, 3) = risk high, floor high, findings [UNKNOWN_VALUE], recorded by kaap-worker-1029053612.testnet
veto try:    refused by the guard with ERR_NOT_VETOABLE: https://testnet.nearblocks.io/txns/6DScqQ3g7NqGcnpNsa2tYF6u5J5Z59T81reCRberwvrd
status: InProgress
no veto
votes: {}
C9  held: an honest payment gets high on a high floor, no critical finding, and the guard refuses to vote on it (ERR_NOT_VETOABLE)
C22 held: the job signed only because both providers agreed at final block 275266794

== testnet NEAR spent by this run (13 transactions)
paid by kaap-member-1029064001.testnet, kaap-worker-1029053612.testnet, m1-1029071010.kaap-member-1029064001.testnet: 0.077354 NEAR (balances before and after)
  gas burnt 0.032335, OutLayer 0.002269, registry storage 0.012750, moved to the new payees 0.030000
  create m1-1029071010.kaap-member-1029064001.testnet: 8.57 Tgas burnt, 0.007115 NEAR
  create a1ice.m1-1029071010.kaap-member-1029064001.testnet: 8.37 Tgas burnt, 0.007095 NEAR
  create alice.m1-1029071010.kaap-member-1029064001.testnet: 8.37 Tgas burnt, 0.007095 NEAR
  create bob.m1-1029071010.kaap-member-1029064001.testnet: 8.37 Tgas burnt, 0.007095 NEAR
  kaap-dao-1029064008.testnet.add_proposal: 2.98 Tgas burnt, 0.000276 NEAR
  outlayer.testnet.request_execution: 8.43 Tgas burnt, 0.000776 NEAR
  kaap-registry-1029061211.testnet.record: 3.59 Tgas burnt, 0.000314 NEAR
  kaap-guard-1029061211.testnet.veto: 8.87 Tgas burnt, 0.000798 NEAR
  kaap-guard-1029061211.testnet.veto (refused): 2.32 Tgas burnt, 0.000210 NEAR
  kaap-dao-1029064008.testnet.add_proposal: 3.00 Tgas burnt, 0.000277 NEAR
  outlayer.testnet.request_execution: 8.43 Tgas burnt, 0.000776 NEAR
  kaap-registry-1029061211.testnet.record: 3.59 Tgas burnt, 0.000314 NEAR
  kaap-guard-1029061211.testnet.veto (refused): 2.17 Tgas burnt, 0.000194 NEAR
attack: 21.8 s from add_proposal to the guard's vote, proposal #2 Rejected

RESULT: pass
```

## DONE MEANS 1 and 2: run 2

```
Kaap M1 proof on testnet, 2026-10-29T07:11:55.384Z
DAO kaap-dao-1029064008.testnet (Sputnik DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF), enrolled in kaap-guard-1029061211.testnet, guard accepts ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN
payees root: m1-1029071157.kaap-member-1029064001.testnet, made by kaap-member-1029064001.testnet with 0.100000 NEAR: https://testnet.nearblocks.io/txns/8yGE2ce6Hw1P9NJghVXzu79tjvwJaVQ6qsQZgCT86HSf
payee:       a1ice.m1-1029071157.kaap-member-1029064001.testnet created with 0.010000 NEAR and no key: https://testnet.nearblocks.io/txns/FTtCf9aiv7aE1TPz2Dqxx7BNCYang3QYWD71NyKGDp8y
payee:       alice.m1-1029071157.kaap-member-1029064001.testnet created with 0.010000 NEAR and no key: https://testnet.nearblocks.io/txns/7rEZSn1Pk2DQyWkGXLgLgKNaba5VTSskUFYbut6yopSS
payee:       bob.m1-1029071157.kaap-member-1029064001.testnet created with 0.010000 NEAR and no key: https://testnet.nearblocks.io/txns/9hfacHVGaE3Q7ZiHhCUUwfAz51Edc3aA5NVoPVheNmu2

== attack: planted:17, pays a lookalike of alice.sandbox while naming the real account
description: "Monthly salary payment to alice.m1-1029071157.kaap-member-1029064001.testnet."
kind:        Transfer of 500.000000 NEAR to a1ice.m1-1029071157.kaap-member-1029064001.testnet
filed:       proposal #4 by kaap-member-1029064001.testnet, add_proposal at block 275266913: https://testnet.nearblocks.io/txns/Fm8iXQwf957iKpAX6R1GSLzYS2p89UQaH5gfzz1f34Sg
final:       #4 readable at final block 275266914, status InProgress, kind 145 bytes
sealed job:  status ok, OutLayer charge 0.001141 NEAR, worker 1411 ms: https://testnet.nearblocks.io/txns/HRRZwX2tGjfx6gVvmFd82BojDasvMUBrxnR4c7inYQPh
verdict risk: critical, floor: critical, findings: [DESC_CONTRADICTS, UNKNOWN_VALUE], ai_status: unavailable
explanation: AI unavailable: no NEAR AI key is set for this project yet.
sealed signature: valid for key ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN (accepted by guard)
verdict:     names guard kaap-guard-1029061211.testnet, testnet, kaap-dao-1029064008.testnet, #4, kind_hash 3914d6dee3675541..., read at block 275266924, expires 2026-10-29T07:22:23.505Z
recorded:    registry index 0, storage kept 0.006380 NEAR, refunded 0.013620 NEAR, block 275266940: https://testnet.nearblocks.io/txns/HHD9ZY6yDBBBXzUny5DDS9encURpBok8BwvJZKvAa6gC
registry:    latest(testnet, kaap-dao-1029064008.testnet, 4) = risk critical, floor critical, findings [DESC_CONTRADICTS, UNKNOWN_VALUE], recorded by kaap-worker-1029053612.testnet
veto:        kaap-guard-1029061211.testnet -> kaap-dao-1029064008.testnet.act_proposal {"id":4,"action":"VoteReject","proposal"... at block 275266950: https://testnet.nearblocks.io/txns/7kxeMEfmJoNXn2aNyx6VntTeh4TuC8miYGXMyBGE4sLi
guard:       veto_cast emitted, veto_result(a24eb6c8b2d8...) = "Ok"
status: Rejected
votes: {kaap-guard-1029061211.testnet: Reject}
replay:      the same verdict and kind again: refused with ERR_REPLAY: https://testnet.nearblocks.io/txns/FjvUD5SzTp8B3AfgxiUGuENUWzMdk7rjXvNUujjRLBoA
C5  held: the vote's proposal is the 145 bytes get_proposal returned at final block 275266914, unchanged; the guard matched their canonical hash to the verdict's kind_hash and Sputnik matched them to the stored kind (else ERR_WRONG_KIND_HASH or ERR_WRONG_KIND)
C9  held: critical on a critical plain-code floor (DESC_CONTRADICTS) with ai_status unavailable, so plain code alone carried the veto
C15 held: the guard's only receipts were kaap-dao-1029064008.testnet.act_proposal with action VoteReject and its own on_veto_result; the votes map holds only the guard's Reject
C19 held: the verdict names this guard, network, DAO, proposal and kind with an expiry, and its second use was refused with ERR_REPLAY
C22 held: the job signed only because both providers agreed at final block 275266924; a disagreement prints held, signs nothing, and fails this case
time:        21.2 s from the add_proposal block 275266913 to the guard's vote at block 275266950 (37 blocks)

== control: planted:57, control: honest proposal that resembles an attack
description: "Monthly salary payment of 500 NEAR to bob.m1-1029071157.kaap-member-1029064001.testnet."
kind:        Transfer of 500.000000 NEAR to bob.m1-1029071157.kaap-member-1029064001.testnet
filed:       proposal #5 by kaap-member-1029064001.testnet, add_proposal at block 275266966: https://testnet.nearblocks.io/txns/CiSjrgLucDUHWjQJVsxBpWpAbWj9ndNMu5MF8K7vqBWH
final:       #5 readable at final block 275266967, status InProgress, kind 143 bytes
sealed job:  status ok, OutLayer charge 0.001175 NEAR, worker 1752 ms: https://testnet.nearblocks.io/txns/3H9axv5QKfqcA3koZChdFJ1t4ztSGwzjAGaa9RAhnLWa
verdict risk: high, floor: high, findings: [UNKNOWN_VALUE], ai_status: unavailable
explanation: AI unavailable: no NEAR AI key is set for this project yet.
sealed signature: valid for key ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN (accepted by guard)
verdict:     names guard kaap-guard-1029061211.testnet, testnet, kaap-dao-1029064008.testnet, #5, kind_hash 62f7050808b696bb..., read at block 275266978, expires 2026-10-29T07:22:54.177Z
recorded:    registry index 0, storage kept 0.006370 NEAR, refunded 0.013630 NEAR, block 275266993: https://testnet.nearblocks.io/txns/5BodcmVvdNvmUZPXjV6ggHGZEiZhjYLyafYYsPeNJ7Dc
registry:    latest(testnet, kaap-dao-1029064008.testnet, 5) = risk high, floor high, findings [UNKNOWN_VALUE], recorded by kaap-worker-1029053612.testnet
veto try:    refused by the guard with ERR_NOT_VETOABLE: https://testnet.nearblocks.io/txns/8o5YyBuatvAT7jovAnUCaVPTruJhGQAJCq12N3umMaGv
status: InProgress
no veto
votes: {}
C9  held: an honest payment gets high on a high floor, no critical finding, and the guard refuses to vote on it (ERR_NOT_VETOABLE)
C22 held: the job signed only because both providers agreed at final block 275266978

== testnet NEAR spent by this run (13 transactions)
paid by kaap-member-1029064001.testnet, kaap-worker-1029053612.testnet, m1-1029071157.kaap-member-1029064001.testnet: 0.077410 NEAR (balances before and after)
  gas burnt 0.032344, OutLayer 0.002316, registry storage 0.012750, moved to the new payees 0.030000
  create m1-1029071157.kaap-member-1029064001.testnet: 8.57 Tgas burnt, 0.007115 NEAR
  create a1ice.m1-1029071157.kaap-member-1029064001.testnet: 8.37 Tgas burnt, 0.007095 NEAR
  create alice.m1-1029071157.kaap-member-1029064001.testnet: 8.37 Tgas burnt, 0.007095 NEAR
  create bob.m1-1029071157.kaap-member-1029064001.testnet: 8.37 Tgas burnt, 0.007095 NEAR
  kaap-dao-1029064008.testnet.add_proposal: 3.01 Tgas burnt, 0.000278 NEAR
  outlayer.testnet.request_execution: 8.43 Tgas burnt, 0.000776 NEAR
  kaap-registry-1029061211.testnet.record: 3.59 Tgas burnt, 0.000315 NEAR
  kaap-guard-1029061211.testnet.veto: 8.90 Tgas burnt, 0.000801 NEAR
  kaap-guard-1029061211.testnet.veto (refused): 2.32 Tgas burnt, 0.000210 NEAR
  kaap-dao-1029064008.testnet.add_proposal: 3.03 Tgas burnt, 0.000280 NEAR
  outlayer.testnet.request_execution: 8.43 Tgas burnt, 0.000776 NEAR
  kaap-registry-1029061211.testnet.record: 3.59 Tgas burnt, 0.000314 NEAR
  kaap-guard-1029061211.testnet.veto (refused): 2.17 Tgas burnt, 0.000194 NEAR
attack: 21.2 s from add_proposal to the guard's vote, proposal #4 Rejected

RESULT: pass
```

## DONE MEANS 3: time and testnet NEAR

**Time from the attack's `add_proposal` block to the guard's vote landing:**

| Run | Proposal | add_proposal block | Vote block | Blocks | Seconds |
|---|---|---|---|---|---|
| 1 | #2 | 275266727 | 275266766 | 39 | 21.8 |
| 2 | #4 | 275266913 | 275266950 | 37 | 21.2 |

p50 of the two runs is 21.2 s, taking the nearest rank as RUNS.md does, which with two values is the lower one. The middle point of the two is 21.5 s. The first attack-only run, earlier the same morning, took 24.2 s (proposal #1, 40 blocks).

Where the time goes:
- The script waits for each step to reach final finality before it starts the next.
- The sealed job takes 13 to 15 blocks from request to result (RUNS.md).
- The worker reaction a real deployment would add is not here. WO-06a builds that worker.

**Testnet NEAR per run** (the balances of the member, the worker and the run's payee parent, before and after; what is left in the payee parent is counted back as ours):

| | Run 1 | Run 2 |
|---|---|---|
| Paid in total | 0.077354 | 0.077410 |
| Gas, all 13 transactions | 0.032335 | 0.032344 |
| OutLayer's charge, 2 sealed runs | 0.002269 | 0.002316 |
| Registry storage, 2 records, kept for good | 0.012750 | 0.012750 |
| Left in the 3 new payee accounts (moved, not burnt) | 0.030000 | 0.030000 |

**Gas by transaction.** The two runs agree to within 0.05 Tgas. Run 1's figures:

| Transaction | Tgas burnt | NEAR |
|---|---|---|
| create the payee parent (CreateAccount, Transfer, AddKey) | 8.57 | 0.007115 |
| create one payee (CreateAccount, Transfer), times 3 | 8.37 | 0.007095 |
| `add_proposal`, times 2 | 2.98 to 3.00 | 0.000276 to 0.000277 |
| `request_execution` on OutLayer, gas only, times 2 | 8.43 | 0.000776 |
| `registry.record`, times 2 | 3.59 | 0.000314 |
| `guard.veto`, vote cast | 8.87 | 0.000798 |
| `guard.veto`, the replay refused with ERR_REPLAY | 2.32 | 0.000210 |
| `guard.veto`, the control refused with ERR_NOT_VETOABLE | 2.17 | 0.000194 |

The gap to GAS.md is explained by account creation. The first attack-only run's 0.0163 NEAR of gas was:
- 0.0142 NEAR for creating its two payee accounts;
- 0.0022 NEAR for one each of add_proposal, request_execution, record and veto.

The veto itself costs what GAS.md says: 8.87 to 8.90 Tgas and 0.0008 NEAR here, against 8.26 Tgas and 0.00083 NEAR in the sandbox. The kind here is 145 bytes against 106, and the account names are longer.

Each account creation costs 0.0071 NEAR. In [4vWA8eFr...](https://testnet.nearblocks.io/txns/4vWA8eFrYUf3i8CNstYTs62WuLQYshfDpSGZWsBcFL21):
- The receipt that creates the account burnt 7.42 Tgas but 0.007022 NEAR.
- That is about 0.0063 NEAR more than its gas costs at that block's gas price of 100,000,000 yoctoNEAR per gas, which is the minimum.
- So the protocol burns a fixed amount on top of the gas each time an account is created. That is measured here; I did not trace it to a protocol parameter.

These accounts are demo scaffolding. Kaap's own path does not create any.

The registry kept 0.00638 NEAR per record, against 0.00555 in GAS.md. GAS.md says longer names cost more, and here the DAO id has 27 characters and the recorder 30, against 11 and 14 in the test.

What one stopped attack costs Kaap, without the proposer's own filing:
- the sealed run: 0.00078 gas plus about 0.00114 OutLayer;
- the record: 0.00031 gas plus 0.00638 storage;
- the veto: 0.00080.

That is about 0.0094 testnet NEAR, two thirds of it the record's storage. At the M0 spike's $4.72 per NEAR, the same on mainnet would be about 4.4 cents.

## DONE MEANS 4: the invariants, and where the output shows them

| Invariant | What the output shows | Enforced in |
|---|---|---|
| C5, the vote is tied to the stored kind | `C5 held`: the script compares the guard's `act_proposal` receipt arguments byte for byte with `{"id":N,"action":"VoteReject","proposal":<kind>}`, where `<kind>` is the bytes `get_proposal` returned at final (145 bytes). Sputnik accepted the vote, which it does only when that kind equals the stored one (ERR_WRONG_KIND otherwise). | `packages/contracts/guard/src/lib.rs`, `veto` (canonical kind hash checked against the verdict, `kind_json` forwarded unchanged) |
| C9, the guard vetoes only a critical verdict backed by a plain-code finding | Attack: `verdict risk: critical, floor: critical, findings: [DESC_CONTRADICTS, UNKNOWN_VALUE], ai_status: unavailable`, vetoed. Control: `risk high, floor high, findings [UNKNOWN_VALUE]`, refused with ERR_NOT_VETOABLE, `status: InProgress`, `no veto`. | guard `lib.rs`, `is_vetoable`; kaap-core `severity.rs` (DESC_CONTRADICTS is critical when value moves) |
| C15, the guard can only cast VoteReject | `C15 held`: in the veto transaction the guard created exactly two receipts, `act_proposal` with action VoteReject to the DAO and its own `on_veto_result`. `votes: {kaap-guard-1029061211.testnet: Reject}` and nothing else. | guard `lib.rs`, `veto` (the method and the action are fixed in the code) |
| C19, a verdict is used once | `replay: the same verdict and kind again: refused with ERR_REPLAY`, a real transaction each run. The verdict line shows it names the guard, testnet, the DAO, the proposal id, the kind hash and an expiry. | guard `lib.rs`, `veto` (the `vetoes` map, keyed by the verdict's hash) |
| C22, the sealed job's reads agreed | `sealed job: status ok` and `C22 held` with the final block the job read at. A disagreement makes the job print `held` and sign nothing, and the script then fails the case. WO-02b forced that once ([ACQcwBVx...](https://testnet.nearblocks.io/txns/ACQcwBVxwAKDQZSf7p8oi8ZWTotrLVNAhb89vp4wWFfW)). | `packages/sealed/src/reads.rs`, `read_chain`, and `job.rs`, `run` |

## No AI answer, and why the veto still stands

Ram's NEAR AI key is not yet a secret of the OutLayer project, so every verdict here says `ai_status: unavailable`, and its explanation says the same. The attack was still vetoed, on the plain-code floor alone. That is the design (C9):
- A description that contradicts a payment is a deterministic critical finding.
- An AI answer can raise a verdict, never lower it.
- An AI answer can only make a verdict critical when it is verified.

The control's high floor comes from UNKNOWN_VALUE. The sealed job has no price source yet, so every token counts as unpriced. This is the known gap recorded in STATE on 29 Oct. The guard does not vote on a high verdict.

## The race this demo does not hide

The treasury needs both Approvers to pass a payment, so one approval never executes it, and the guard has time to vote first. The live NEAR Business policy is 2 of 2 too. A treasury where one approval is enough loses that race: the payment runs inside the approver's own transaction, and the guard's later vote finds nothing to reject (the M0 sandbox test `alice_alone_approves_first`). Kaap cannot protect such a treasury against an approver acting alone.

## The way here, failures included

- The first attack-only run (step 3) passed: proposal #1, Rejected, [veto 8JeFv3Yi...](https://testnet.nearblocks.io/txns/8JeFv3YitSeY5VNu5j8nihNiywmFBFgxb6XMSzu1xEN), 24.2 s.
- The first whole run stopped before any Kaap transaction. The faucet answered HTTP 429 ("retry in 11 hours") to the per-run account it was asked for. The payee parent is now a sub-account of the member.
- The retry stopped on `actions.addKey is not a function`: near-api-js 7.4.0 exports `addFullAccessKey`. The head chef fixed that line.
- The next run's payee parent, funded with 0.05 NEAR, could not afford the third payee. Each account creation must show about 0.0175 NEAR up front. That parent, `m1-1029070926.kaap-member-1029064001.testnet`, holds its two payees and 0.0158 NEAR. The parent now gets 0.1 NEAR.
- Two key files in `~/.near-credentials/testnet` belong to accounts that were never made (`kaap-m1-1029070403`, `m1-1029070538.kaap-member-1029064001`). They are harmless.

## What this does not cover

- One treasury, one attack family (a payment to a lookalike of the named account) and one control. The hidden-approver attack (#01) needs WO-03c and is shown in WO-08.
- The script plays the worker. Nothing here watches the chain or reacts on its own; WO-06a builds that.
- No AI answer was asked for (no key), and no price source exists, so no verdict here is low.
- Runs one after another from one machine: no load and nothing concurrent. No approver raced the guard, because the attack proposals were never approved by anyone.
- The payees are keyless accounts made for the demo. The 500 NEAR payments could not have paid out, because the treasury does not hold 500 NEAR. The guard's vote does not depend on that, and the Rejected status is the proof.
- The control proposals #3 and #5 stay InProgress until their 7-day period ends.
- Testnet only. Nothing touched mainnet except one read of the NEAR Business policy.
