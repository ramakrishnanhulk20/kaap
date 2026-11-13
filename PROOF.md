# Testnet proof: a disguised payment killed by Kaap on the live testnet

Run on 13 Nov 2026 between 04:54 and 04:57 UTC, inside WSL, with Node 24.22.2 and near-api-js 7.4.0, against NEAR testnet (RPC `https://rpc.testnet.fastnear.com`) and the deployment made the same morning from commit `5f1cf75`: the guard with strict mode and the 24-hour key delay, a new registry, and the sealed program published under its own owner account.

In one command, `node scripts/prove.mjs` does the following:

1. A member of a real Sputnik DAO 3.2 treasury files planted attack #17: "Monthly salary payment to alice...", which in fact pays the lookalike account `a1ice...`.
2. Kaap's sealed job on OutLayer reads the proposal at a final block from two RPC providers, judges it and signs a verdict.
3. The verdict is recorded in kaap-registry.
4. kaap-guard casts VoteReject, and the proposal is Rejected.
5. The same verdict is handed to the guard a second time, and the guard refuses it.
6. An honest payment (planted control #57) goes through the same path. It is recorded and left alone.

It passed twice in a row, on fresh proposals each time (#1 and #2 in run 1, #3 and #4 in run 2). The rest of this file is what else was shown on this deployment the same day: the sealed program's owner attacked by the watcher's key, the hosted watcher rejecting a theft by itself, the watcher's own limits attacked, and a request that shows only a hash read once its words were handed over sealed.

The scripts sign with Kaap's own testnet keys, so in another clone they stop with "no key". Anyone can check every run here from the chain with no key: see "Checked with no key" below.

The two earlier deployments are still on chain. Their proof is in [PROOF-2026-11-11.md](PROOF-2026-11-11.md).

## What it ran against

| Thing | Value |
|---|---|
| Treasury | `kaap-dao-1113045321.testnet`, Sputnik DAO 3.2, code hash `DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF`, purpose `Kaap demo treasury` ([deploy and init](https://testnet.nearblocks.io/txns/CiRhao89G9q6Lc7fTBc1Ds7jErck6c7hFVmskAJAJ1v7)), with no access key ([deleted](https://testnet.nearblocks.io/txns/94xyNPcEhRvuNdAcMfrA9g66yDt1TCTZwVhtZpXQg8FK)) |
| Its policy | the role setup of a live NEAR Business treasury on mainnet, read at final finality on 29 Oct 2026 and saved with its members removed in `deployments/near-business-policy.json`. Two Approvers, both needed, so one approval never executes a request |
| Enrolment | the DAO's own proposal #0, a FunctionCall to `enroll` with 0.01 NEAR attached: [filed](https://testnet.nearblocks.io/txns/G676id7GgsyzPiQ66HXDbNwEietppbVqkF7dEisddop7), [owner approves](https://testnet.nearblocks.io/txns/HuJZk6TWWBhGNd8ZEDujynnd3htUMDKDxie1kkFbXYo3), [member approves and it executes](https://testnet.nearblocks.io/txns/AYwDyFQr69g1342aKUQhByY3cy8SwFTUVyCV7YbqDmgZ). Default mode: a request Kaap cannot read alerts the members and is not rejected |
| Guard | `kaap-guard-1113045147.testnet`, code hash `BfYf34n3cN85SpkSWRAJYqDghRHxLJkR4SgYaeXbWBt6` (sha256 `9e74bbbadcfa6820390e21cb415ae83542f5de6257da4ad651caf950801c5d23`), owner `kaap-owner-1029061211.testnet`, [deploy and init](https://testnet.nearblocks.io/txns/6zSjJ4FnExBBWx9eR1hcfErbRM83e1x1ob9QwzApTHvT), [key deleted](https://testnet.nearblocks.io/txns/DeCTsm76k8RH6HES5uqh4p4SrzZksKF7uQNL7gYPLxtV) |
| Registry | `kaap-registry-1113045147.testnet`, code hash `3Kro1EgWDYAawFx8RHUwVGTKmJvp9bAUeRL65cwGAoZz` (sha256 `228c21366ffdaf58f31a6e3550fd9898bc9ae65d1182f7a9e84d2df3c07fb2c9`, the same code as the registry before it), [deploy and init](https://testnet.nearblocks.io/txns/J38sabffhH3HGd9SvFL18rnkMjZeHh2UrMjAFe1oxMyJ), [key deleted](https://testnet.nearblocks.io/txns/6T53QkSLhsN1HnbZgPGdHEzpgwCKg1vB3bFBJNcgLaxv) |
| Built from | commit `5f1cf75`, with `cargo near build non-reproducible-wasm --locked` (cargo-near 0.22.0, Rust 1.93.0) as `scripts/deploy-contracts-testnet.sh` runs it. Built again in an empty target folder: both builds gave the two sha256 above, and each code hash on chain is that sha256 |
| Sealed job | OutLayer project `kaap-sealed-owner-1113041743.testnet/kaap-sealed` (uuid `p0000000000000171`), [published](https://testnet.nearblocks.io/txns/E1Za5hoQtyMqgufqQwgjoWvsNF8B2pijKSB8WYqGUHe3) by its owner `kaap-sealed-owner-1113041743.testnet`, called by `kaap-worker-1029053612.testnet`, build `d14e29279146e6b0998e687c8ab3cd4739ea4b16dbfe2ae0184ea97e0af131cf`, built twice with the same sha256 |
| Verdict key | `ed25519:8eiUXYidw2x7WWfVVmYkDcewi3aBzxKomMefsPPhaecF`: the key OutLayer gives the watcher's account on that project. Setup checks that the guard's and the registry's `accepted_key()` both equal the key an attested run printed |
| Text key | `40cc0043...2757`, signed by the verdict key (`node scripts/sealed-keys.mjs`, output below) |

Every id is also in `deployments/testnet.json`.

## Run 1

```
Kaap end-to-end proof on testnet, 2026-11-13T04:54:00.651Z
DAO kaap-dao-1113045321.testnet (Sputnik DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF), enrolled in kaap-guard-1113045147.testnet, guard accepts ed25519:8eiUXYidw2x7WWfVVmYkDcewi3aBzxKomMefsPPhaecF
payees root: pay-1113045402.kaap-member-1029064001.testnet, made by kaap-member-1029064001.testnet with 0.100000 NEAR: https://testnet.nearblocks.io/txns/9BpmeVthNdFDDs6mA2Pjf1nHcuLUWXvrRHoUpHgu9Pka
payee:       a1ice.pay-1113045402.kaap-member-1029064001.testnet created with 0.010000 NEAR and no key: https://testnet.nearblocks.io/txns/CJt4nJGHmM8yHUgJNQmrE2B1aLEU1joKaU3xsWFUAuMp
payee:       alice.pay-1113045402.kaap-member-1029064001.testnet created with 0.010000 NEAR and no key: https://testnet.nearblocks.io/txns/5zrAiagnrTt7gyZ1bTG4PXVgHad7DrdUXAFjbW8Fs1Lq
payee:       bob.pay-1113045402.kaap-member-1029064001.testnet created with 0.010000 NEAR and no key: https://testnet.nearblocks.io/txns/FpaUCikKPyYNALz14FsWWq5DuxoyuZfrWViJL2g5zcCG

== attack: planted:17, pays a lookalike of alice.sandbox while naming the real account
description: "Monthly salary payment to alice.pay-1113045402.kaap-member-1029064001.testnet."
kind:        Transfer of 500.000000 NEAR to a1ice.pay-1113045402.kaap-member-1029064001.testnet
filed:       proposal #1 by kaap-member-1029064001.testnet, add_proposal at block 277463926: https://testnet.nearblocks.io/txns/583jbKshP4USdjmBRnX9wrRjFYg9NvTURdBuWqAo1q5a
final:       #1 readable at final block 277463927, status InProgress, kind 146 bytes
sealed job:  status ok, OutLayer charge 0.001463 NEAR, worker 4629 ms: https://testnet.nearblocks.io/txns/6Lm1adNQeQrm75QBoWcEmAaG1dskrajEUCQCisatU12L
verdict risk: critical, floor: critical, findings: [DESC_CONTRADICTS, UNKNOWN_VALUE], ai_status: unavailable
explanation: AI unavailable (ai_key_missing): no NEAR AI key reached this run.
sealed signature: valid for key ed25519:8eiUXYidw2x7WWfVVmYkDcewi3aBzxKomMefsPPhaecF (accepted by guard)
verdict:     names guard kaap-guard-1113045147.testnet, testnet, kaap-dao-1113045321.testnet, #1, kind_hash e4827e529457a888..., read at block 277463941, expires 2026-11-13T05:04:30.740Z
recorded:    registry index 0, storage kept 0.006380 NEAR, refunded 0.013620 NEAR, block 277463958: https://testnet.nearblocks.io/txns/CNqvoFb8Ly3txbrYMuXyRWwPM6Enp1PYr6oGUcVjcS83
registry:    latest(testnet, kaap-dao-1113045321.testnet, 1) = risk critical, floor critical, findings [DESC_CONTRADICTS, UNKNOWN_VALUE], recorded by kaap-worker-1029053612.testnet
veto:        kaap-guard-1113045147.testnet -> kaap-dao-1113045321.testnet.act_proposal {"id":1,"action":"VoteReject","proposal"... at block 277463968: https://testnet.nearblocks.io/txns/66WDukXKMVFbeyZ6aAbsTMgZDwCAwXFNSSagM9MkQagz
guard:       veto_cast emitted, veto_result(ca26d724b08d...) = "Ok"
status: Rejected
votes: {kaap-guard-1113045147.testnet: Reject}
replay:      the same verdict and kind again: refused with ERR_REPLAY: https://testnet.nearblocks.io/txns/47987Zcd2dGHKgx6WS9LyA21hGDcU3GhqP2RszMC7nNz
C5  held: the vote's proposal is the 146 bytes get_proposal returned at final block 277463927, unchanged; the guard matched their canonical hash to the verdict's kind_hash and Sputnik matched them to the stored kind (else ERR_WRONG_KIND_HASH or ERR_WRONG_KIND)
C9  held: critical on a critical plain-code floor (DESC_CONTRADICTS) with ai_status unavailable, so plain code alone carried the veto
C15 held: the guard's only receipts were kaap-dao-1113045321.testnet.act_proposal with action VoteReject and its own on_veto_result; the votes map holds only the guard's Reject
C19 held: the verdict names this guard, network, DAO, proposal and kind with an expiry, and its second use was refused with ERR_REPLAY
C22 held: the job signed only because both providers agreed at final block 277463941; a disagreement prints held, signs nothing, and fails this case
time:        25.5 s from the add_proposal block 277463926 to the guard's vote at block 277463968 (42 blocks)

== control: planted:57, control: honest proposal that resembles an attack
description: "Monthly salary payment of 500 NEAR to bob.pay-1113045402.kaap-member-1029064001.testnet."
kind:        Transfer of 500.000000 NEAR to bob.pay-1113045402.kaap-member-1029064001.testnet
filed:       proposal #2 by kaap-member-1029064001.testnet, add_proposal at block 277463985: https://testnet.nearblocks.io/txns/B6P3xcM2SoBhzpzCFmUEKKiKHcG6qpcsim4j5EB3r3F5
final:       #2 readable at final block 277463987, status InProgress, kind 144 bytes
sealed job:  status ok, OutLayer charge 0.001417 NEAR, worker 4169 ms: https://testnet.nearblocks.io/txns/CRVqVJw7NfTgiH8zPaxxJH9LZMnztw3qeBg9t72XLZum
verdict risk: high, floor: high, findings: [UNKNOWN_VALUE], ai_status: unavailable
explanation: AI unavailable (ai_key_missing): no NEAR AI key reached this run.
sealed signature: valid for key ed25519:8eiUXYidw2x7WWfVVmYkDcewi3aBzxKomMefsPPhaecF (accepted by guard)
verdict:     names guard kaap-guard-1113045147.testnet, testnet, kaap-dao-1113045321.testnet, #2, kind_hash 3cb3b345708100c4..., read at block 277463999, expires 2026-11-13T05:05:05.899Z
recorded:    registry index 0, storage kept 0.006370 NEAR, refunded 0.013630 NEAR, block 277464016: https://testnet.nearblocks.io/txns/8kZ2dogvgsJ74yuHn8XTjiPG3CaP8AiyYUQtaQG2ryu6
registry:    latest(testnet, kaap-dao-1113045321.testnet, 2) = risk high, floor high, findings [UNKNOWN_VALUE], recorded by kaap-worker-1029053612.testnet
veto try:    refused by the guard with ERR_NOT_VETOABLE: https://testnet.nearblocks.io/txns/8ZCUQEk47KskApGHLzmjYy2dMNVLgZs3jdoZDVsmBmbp
status: InProgress
no veto
votes: {}
C9  held: an honest payment gets high on a high floor, no critical finding, and the guard refuses to vote on it (ERR_NOT_VETOABLE)
C22 held: the job signed only because both providers agreed at final block 277463999

== testnet NEAR spent by this run (13 transactions)
paid by kaap-member-1029064001.testnet, kaap-worker-1029053612.testnet, pay-1113045402.kaap-member-1029064001.testnet: 0.078013 NEAR (balances before and after)
  gas burnt 0.032383, OutLayer 0.002880, registry storage 0.012750, moved to the new payees 0.030000
  create pay-1113045402.kaap-member-1029064001.testnet: 8.57 Tgas burnt, 0.007115 NEAR
  create a1ice.pay-1113045402.kaap-member-1029064001.testnet: 8.37 Tgas burnt, 0.007095 NEAR
  create alice.pay-1113045402.kaap-member-1029064001.testnet: 8.37 Tgas burnt, 0.007095 NEAR
  create bob.pay-1113045402.kaap-member-1029064001.testnet: 8.37 Tgas burnt, 0.007095 NEAR
  kaap-dao-1113045321.testnet.add_proposal: 2.98 Tgas burnt, 0.000275 NEAR
  outlayer.testnet.request_execution: 8.61 Tgas burnt, 0.000794 NEAR
  kaap-registry-1113045147.testnet.record: 3.58 Tgas burnt, 0.000314 NEAR
  kaap-guard-1113045147.testnet.veto: 8.92 Tgas burnt, 0.000803 NEAR
  kaap-guard-1113045147.testnet.veto (refused): 2.35 Tgas burnt, 0.000213 NEAR
  kaap-dao-1113045321.testnet.add_proposal: 3.00 Tgas burnt, 0.000277 NEAR
  outlayer.testnet.request_execution: 8.62 Tgas burnt, 0.000795 NEAR
  kaap-registry-1113045147.testnet.record: 3.60 Tgas burnt, 0.000316 NEAR
  kaap-guard-1113045147.testnet.veto (refused): 2.19 Tgas burnt, 0.000197 NEAR
attack: 25.5 s from add_proposal to the guard's vote, proposal #1 Rejected

RESULT: pass
```

## Run 2

The second run, on fresh proposals #3 and #4. Its main lines:

```
== attack: planted:17, pays a lookalike of alice.sandbox while naming the real account
filed:       proposal #3 by kaap-member-1029064001.testnet, add_proposal at block 277464076: https://testnet.nearblocks.io/txns/8JHJkbNJ8zTvRnXeeizZ61cPGfMYCkQoaBkk7hsysgHB
sealed job:  status ok, OutLayer charge 0.001437 NEAR, worker 4374 ms: https://testnet.nearblocks.io/txns/Gz82ABJkynZqhM7DSq2YHWdJKJUyYCpEtJUranUE2wpW
verdict risk: critical, floor: critical, findings: [DESC_CONTRADICTS, UNKNOWN_VALUE], ai_status: unavailable
recorded:    registry index 0, storage kept 0.006380 NEAR, refunded 0.013620 NEAR, block 277464112: https://testnet.nearblocks.io/txns/5y4CDGfVQUhaaDnXkVxXgxmXoZHKy8eogvrfN9XQp4MQ
veto:        kaap-guard-1113045147.testnet -> kaap-dao-1113045321.testnet.act_proposal {"id":3,"action":"VoteReject","proposal"... at block 277464121: https://testnet.nearblocks.io/txns/HVzizHJHLAZotGp5LR7UTmjtunMJHKwD7C2LvkbXWrpU
status: Rejected
votes: {kaap-guard-1113045147.testnet: Reject}
replay:      the same verdict and kind again: refused with ERR_REPLAY: https://testnet.nearblocks.io/txns/CH4UdDC3QoQXPaAxA7bgM4rgXaLbh1RuqrxhiipkXUFz
time:        27.3 s from the add_proposal block 277464076 to the guard's vote at block 277464121 (45 blocks)
== control: planted:57, control: honest proposal that resembles an attack
filed:       proposal #4 by kaap-member-1029064001.testnet, add_proposal at block 277464138: https://testnet.nearblocks.io/txns/AUEqGGgp9uky7QxopjdGmPvUcKhcwvRc2McRqTgeAPWs
sealed job:  status ok, OutLayer charge 0.001347 NEAR, worker 3466 ms: https://testnet.nearblocks.io/txns/6uUnLFGNK7gG77iEdtYVFcV13qnMSkfg5QbAgjkWswun
verdict risk: high, floor: high, findings: [UNKNOWN_VALUE], ai_status: unavailable
recorded:    registry index 0, storage kept 0.006370 NEAR, refunded 0.013630 NEAR, block 277464178: https://testnet.nearblocks.io/txns/2vsuggX1FXR4TLdHN6hRhEVgFp5ZUhmpzFsLDYJhWJpL
veto try:    refused by the guard with ERR_NOT_VETOABLE: https://testnet.nearblocks.io/txns/BP2ugze5Z1sAZkmswNQgZrJMB1gfxzD59rW4qtLcnZSF
status: InProgress
votes: {}
== testnet NEAR spent by this run (13 transactions)
attack: 27.3 s from add_proposal to the guard's vote, proposal #3 Rejected
RESULT: pass
```

## Checked with no key

From any clone, with Node 24 and nothing else:

```bash
npm ci -w packages/cli
npm run build:ts -w packages/cli
node packages/cli/dist/src/bin.js verify kaap-dao-1113045321.testnet 1
```

```
kaap verify kaap-dao-1113045321.testnet #1 on testnet
read at final block 277466305 (2026-11-13 05:17 UTC): agreed by near-testnet.drpc.org and rpc.testnet.fastnear.com; the verdict's own block (the policy and the called contracts' code) and the sealed runs from one node per read, never compared: a live provider while it still holds them, else an archival node, named on each line
DAO: Sputnik 3.2 (code hash DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF)
Kaap on testnet: deployment record deployments/testnet.json (the current one, deployed 2026-11-13T04:51:47Z): guard kaap-guard-1113045147.testnet, registry kaap-registry-1113045147.testnet, sealed program kaap-sealed-owner-1113041743.testnet/kaap-sealed, its builds published by kaap-sealed-owner-1113041743.testnet, called by kaap-worker-1029053612.testnet
verdict: record 0 in kaap-registry-1113045147.testnet, recorded by kaap-worker-1029053612.testnet at block 277463958
  risk critical, floor critical, findings DESC_CONTRADICTS, UNKNOWN_VALUE, AI unavailable
  read at block 277463941, expires 2026-11-13T05:04:30.740Z, decoder 0.1.0

checks
  pass  guard code: kaap-guard-1113045147.testnet runs the recorded build, sha256 9e74bbba...5d23 (two providers, block 277466305)
  pass  guard keys: kaap-guard-1113045147.testnet has no access key, so no one can sign for it (two providers, block 277466305)
  pass  registry code: kaap-registry-1113045147.testnet runs the recorded build, sha256 228c2136...b2c9 (two providers, block 277466305)
  pass  registry keys: kaap-registry-1113045147.testnet has no access key, so no one can sign for it (two providers, block 277466305)
  pass  format: a version 1 verdict, and kaap-verdict encodes its fields back to exactly the signed bytes (hash ca26d724...0e22)
  pass  names this network, DAO and proposal, and Kaap's guard kaap-guard-1113045147.testnet
  pass  the registry's summary (hash, risk, floor, findings, AI, block, expiry) is what the signed bytes say
  pass  sealed signature: valid for the guard's accepted key ed25519:8eiUXYidw2x7WWfVVmYkDcewi3aBzxKomMefsPPhaecF, checked here with ed25519
  pass  the registry accepts the same key as the guard
  pass  kind hash: kaap-core recomputes e4827e52...cd36 from proposal 1 as stored
  pass  policy hash: kaap-core recomputes bcc348c4...2c92 from the DAO's policy at block 277463941 (read from near-testnet.drpc.org, one node, not compared)
  pass  receivers hash: kaap-core recomputes ede4abc9...1281 from the code of kaap-dao-1113045321.testnet at block 277463941 (read from near-testnet.drpc.org, one node per read, not compared)
  pass  receivers now: the code of kaap-dao-1113045321.testnet at block 277466305 is unchanged since the verdict (two providers)
  pass  decoder: the verdict names kaap-core 0.1.0, the decoder this CLI runs
  pass  sealed run: transaction 6Lm1adNQeQrm75QBoWcEmAaG1dskrajEUCQCisatU12L returned exactly this verdict and signature (found in 13 blocks, chain read from near-testnet.drpc.org, one node per read, not compared)
  pass  the run: outlayer.testnet recorded the request from kaap-worker-1029053612.testnet for project kaap-sealed-owner-1113041743.testnet/kaap-sealed (uuid p0000000000000171), build d14e2927...31cf, a published build (chain read from near-testnet.drpc.org, one node per read, not compared)
  pass  the run: OutLayer's attestation names the same project, caller kaap-worker-1029053612.testnet and wasm d14e2927...31cf, the build that ran (attestation from OutLayer's API alone; chain read from near-testnet.drpc.org, one node per read, not compared)
  pass  the run: the attested input and output hashes are the sha256 of the transaction's input and output (attestation from OutLayer's API alone; chain read from near-testnet.drpc.org, one node per read, not compared)
  pass  the run: OutLayer's record is the one its TDX quote commits to (task hash e888f5c8...371a, V1); Intel's signature on the quote is not checked here (attestation from OutLayer's API alone; chain read from near-testnet.drpc.org, one node per read, not compared)
  pass  the key's run 6Lm1adNQ...: outlayer.testnet recorded the request from kaap-worker-1029053612.testnet for project kaap-sealed-owner-1113041743.testnet/kaap-sealed (uuid p0000000000000171), build d14e2927...31cf, a published build (chain read from near-testnet.drpc.org, one node per read, not compared)
  pass  the key's run 6Lm1adNQ...: OutLayer's attestation names the same project, caller kaap-worker-1029053612.testnet and wasm d14e2927...31cf, the build that ran (attestation from OutLayer's API alone; chain read from near-testnet.drpc.org, one node per read, not compared)
  pass  the key's run 6Lm1adNQ...: the attested input and output hashes are the sha256 of the transaction's input and output (attestation from OutLayer's API alone; chain read from near-testnet.drpc.org, one node per read, not compared)
  pass  the key's run 6Lm1adNQ...: OutLayer's record is the one its TDX quote commits to (task hash e888f5c8...371a, V1); Intel's signature on the quote is not checked here (attestation from OutLayer's API alone; chain read from near-testnet.drpc.org, one node per read, not compared)
  pass  the key's run 6Lm1adNQ...: its attested output prints the guard's accepted key (chain read from near-testnet.drpc.org, one node per read, not compared)

not checked here
  Intel's signature on the TDX quote and OutLayer's approval of its measurements (OutLayer's own tool: outlayer-verify tx 6Lm1adNQeQrm75QBoWcEmAaG1dskrajEUCQCisatU12L --network testnet --api https://testnet-api.outlayer.ai); record: https://testnet-api.outlayer.ai/attestations/by-tx/6Lm1adNQeQrm75QBoWcEmAaG1dskrajEUCQCisatU12L

proposal 1 is Rejected at block 277466305
AI evidence: none. This verdict carries no AI answer (AI unavailable), so there is nothing for https://cloud.near.ai/verify to check
the guard voted to reject with this verdict, and the DAO took the vote

result: all 24 checks pass; 12 of the passes rest on one node or on OutLayer's API alone, as their lines say
```

The same command passes all 24 checks for #3 (run 2), #5 (the hosted watcher's own verdict) and #6 (the verdict made from sealed words). `kaap arming` reads the treasury's mode from the guard itself:

```
kaap arming kaap-dao-1113045321.testnet on testnet
guard: kaap-guard-1113045147.testnet; enrolled in the guard: yes
mode in the guard: default: a request whose signed hash Kaap has not read alerts the members and is not rejected
armed: yes. The guard's one reject decides every kind except remove_member_from_role, which Kaap leaves out on purpose so the DAO can always remove Kaap.
```

## The sealed reader under its own owner, attacked by the watcher's key

Until 13 Nov the account that runs the watcher also owned the sealed program on OutLayer, and its key sits on the watcher's host. A thief of that key could have published a different program that signed with the key the guard accepts. Since 13 Nov the program belongs to an owner account that does nothing else, whose key is on no host, and the watcher's account only calls it (rule C37 in `docs/security/threat-model.md`).

`node scripts/attack-sealed-owner.mjs` tries, as the watcher, every call OutLayer gives a project's owner:

```
Kaap sealed owner attack, 2026-11-13T05:09:43.842Z: project kaap-sealed-owner-1113041743.testnet/kaap-sealed on outlayer.testnet, attacked by its caller kaap-worker-1029053612.testnet
1. OutLayer names kaap-sealed-owner-1113041743.testnet as the owner; active build d14e29279146e6b0998e687c8ab3cd4739ea4b16dbfe2ae0184ea97e0af131cf, 1 build(s), uuid p0000000000000171
   keys: kaap-sealed-owner-1113041743.testnet has 1, kaap-worker-1029053612.testnet has 1, in common 0
2. kaap-worker-1029053612.testnet tries the owner's calls on kaap-sealed-owner-1113041743.testnet/kaap-sealed:
   refused: publish a build and make it active (add_version): Project not found: https://testnet.nearblocks.io/txns/NR4mguWLrwmU81gKDXZTs9f76rB6WizC1Khie2R372z
   refused: choose the active build (set_active_version): Project not found: https://testnet.nearblocks.io/txns/2d2PkGYFJBw2vKvjWs25udqj6Pz6ZNZ5e8UVWwKEbyNN
   refused: remove a build (remove_version): Project not found: https://testnet.nearblocks.io/txns/21uzQt2ecnGz79ZftRpt4FmpSu69XZdz4gDWbfsv2uhC
   refused: hand the project to itself (transfer_project): 'kaap-worker-1029053612.testnet' has not accepted project kaap-worker-1029053612.testnet/kaap-sealed-owner-1113041743.testnet/kaap-sealed: it calls accept_proje: https://testnet.nearblocks.io/txns/55Jkn5SSV8Za3rpMgqHvG7e7XBmzgReg7Wvf8CYPtyDo
   refused: delete the project (delete_project): Project not found: https://testnet.nearblocks.io/txns/3wbNMeCbNmxAXkVn8kRj6KmJp7PBepHU59AFe4kH6LEu
3. the project now: owner kaap-sealed-owner-1113041743.testnet, active build d14e29279146e6b0998e687c8ab3cd4739ea4b16dbfe2ae0184ea97e0af131cf, 1 build(s): unchanged
RESULT: pass, 5 of 5 tries refused on chain and the project is unchanged
```

OutLayer looks a project up under the account that calls, so the watcher cannot even name the owner's project: four tries end in "Project not found", and the fifth, handing the project over, needs the owner to start it. The script never sends these calls with the project's short name, which under the watcher's account is its own first project from before the split.

The watcher's keys on the new project, asked for twice:

```
Kaap sealed keys, 2026-11-13T04:49:44.880Z: kaap-worker-1029053612.testnet asks kaap-sealed-owner-1113041743.testnet/kaap-sealed (build d14e29279146e6b0998e687c8ab3cd4739ea4b16dbfe2ae0184ea97e0af131cf) for its keys, 2 time(s)
  run 1: https://testnet.nearblocks.io/txns/GauQQEjVA7YVDk3pMZbAEUvaKBTuWMGQHPDxySL7KRUA: verdict key ed25519:8eiUXYidw2x7WWfVVmYkDcewi3aBzxKomMefsPPhaecF, text key 40cc00435ddbcdb638ac967f7f592e69d290712d578010e47f4b9d16fcd62757
  run 2: https://testnet.nearblocks.io/txns/BAQVCxNdnQcdbdjUD8VsfLnBGjvzywHAwrLiJbcr7Hq1: verdict key ed25519:8eiUXYidw2x7WWfVVmYkDcewi3aBzxKomMefsPPhaecF, text key 40cc00435ddbcdb638ac967f7f592e69d290712d578010e47f4b9d16fcd62757
  every run printed the same two keys: true; the verdict key signed the text key: true
{
  "signing_key": "ed25519:8eiUXYidw2x7WWfVVmYkDcewi3aBzxKomMefsPPhaecF",
  "attested_run_tx": "GauQQEjVA7YVDk3pMZbAEUvaKBTuWMGQHPDxySL7KRUA",
  "text_key": {
    "key": "40cc00435ddbcdb638ac967f7f592e69d290712d578010e47f4b9d16fcd62757",
    "signature": "XmtL3LWyUNYPjvuY473XXw74C7WpZM1OlygidJwJs9nCgD2rqIBlBSzMCZz5aj+iqDBkiJPmzq8XToKwO2t+Cg==",
    "public_key": "ed25519:8eiUXYidw2x7WWfVVmYkDcewi3aBzxKomMefsPPhaecF",
    "run_tx": "GauQQEjVA7YVDk3pMZbAEUvaKBTuWMGQHPDxySL7KRUA",
    "build": "d14e29279146e6b0998e687c8ab3cd4739ea4b16dbfe2ae0184ea97e0af131cf"
  }
}
RESULT: pass
```

## The hosted watcher on this deployment

The watcher on Railway was pointed at the new guard, registry and project at 05:05 UTC and redeployed from commit `e5857e4`. `node scripts/check-demo-filer.mjs` then pressed the site's try-it key by hand: five things the key must not be able to do, then the one thing it can, filing the fake theft:

```
Kaap demo filer check, 2026-11-13T05:05:42.034Z: key ed25519:6bCYiH3unY424THRo1qqruVVqNEuwYWteQv5zS8zE5xz of kaap-member-1029064001.testnet
PASS  refused before it ran: vote to approve request #2 on the treasury (sending 94BudGG83S5SbEetC1hbQRKdoLyj8zEmkfoGUc8sfUTD failed: Access key does not allow method act_proposal)
PASS  refused before it ran: send 1 yoctoNEAR out of the member account (sending EV3H9SA2opdP476xq6NBDVVQCYt6sfCXvh7aDMWKUfPP failed: Access key requires full access)
PASS  refused before it ran: call add_proposal on a different contract (sending 6A7Ng59BNuuQ2c6pt2KxY6NRtA85qjV2522eyewgJSQZ failed: Access key receiver kaap-dao-1113045321.testnet does not match transaction receiver kaap-guard-1113)
PASS  refused before it ran: call add_proposal with a deposit attached (sending 3H2iwk9pPmqTRz4ASnNruXMN4Vgs2eREPgW8bppQzsym failed: Deposit is not allowed with function call)
PASS  refused before it ran: add another key to the member account (sending HaUPGSE9EvDJBQ3LQyWyPVWX7mLVWYWSCmE44Q37APYY failed: Access key requires full access)
PASS  the one allowed call: filed request #5 at block 277465063 (2026-11-13T05:05:46.850Z): https://testnet.nearblocks.io/txns/FEPWrAFJY9tn8CrWCrMn1pRuyU5BXFBrhvpDHhzC6Eu1
RESULT: pass, 5 of 5 attacks refused
```

Nobody ran anything after that. The watcher saw request #5, had the sealed program judge it ([run](https://testnet.nearblocks.io/txns/4agZcKBqaNqzs67Yp8kEGvjfJpGVighj4Ufb2x2WC2pw)), sent the guard's vote with 1,000 Tgas attached ([veto](https://testnet.nearblocks.io/txns/9wHZmJWuRhaD8mdLURqJeSABnsro4KXDDQRu1ySCJno7)) and recorded the verdict ([record](https://testnet.nearblocks.io/txns/Bcv8hv3qoyMCnN14cLpwr5sRP3GZwy9c5oFX81ehs7Nz)). Request #5 ended Rejected with the guard's vote alone, about 110 seconds after it was filed. That is slower than the 25 seconds of the runs above: the watcher names a NEAR AI key for the run, the key was not yet stored for the new project that morning, and OutLayer took about 95 seconds to say so before the program ran without it.

The watcher's limit on callers, attacked from outside (`node scripts/attack-caller-limit.mjs`):

```
watcher: https://watcher-production-2350aa2a.up.railway.app
answers to 12 asks, each under another made-up address: 404 404 404 404 404 404 404 404 404 404 429 429
RESULT: pass, the limit bit after 10 asks: the made-up addresses changed nothing
```

An account that is no treasury, enrolled in the guard to see what the watcher makes of it (`bash scripts/attack-fake-enrolment.sh`):

```
Kaap fake-enrolment attack, 2026-11-13T05:08:23Z: kaap-member-1029064001.testnet into kaap-guard-1113045147.testnet, watcher https://watcher-production-2350aa2a.up.railway.app
before: the watcher watches {"watching":1,"daos":["kaap-dao-1113045321.testnet"]}
enrolling kaap-member-1029064001.testnet, which is no Sputnik DAO:
Transaction ID: DwgeCJc1GoVxQXDR8oCwrW7F83CXbohwxSRssZo2rTo6
the watcher's status page lists it as: [{"dao":"kaap-member-1029064001.testnet","reason":"not_a_sputnik_dao"}]
during: the watcher watches {"watching":1,"daos":["kaap-dao-1113045321.testnet"]}
unenrolling kaap-member-1029064001.testnet:
Transaction ID: 5LEusp5p7d4mM688oTzVJ5d71V6K9ZjDg67V7rtCdyHS
after: listed no more: yes; the watcher watches {"watching":1,"daos":["kaap-dao-1113045321.testnet"]}
RESULT: pass, the account was turned away as not_a_sputnik_dao, the watched treasuries did not change, and the watcher account signed nothing in that time
```

## The words behind a hash, handed over sealed

A request that shows only a hash cannot be read, so Kaap flags it and, for a treasury in the default mode, the guard does not vote. A member who knows the words behind the hash can hand them to Kaap with `kaap seal-text`: they are encrypted on the member's machine so that only the sealed reader can open them. `node scripts/sealed-text-live.mjs` runs all of it through the hosted watcher:

```
Kaap sealed text, live, 2026-11-13T05:10:10.854Z: kaap-member-1029064001.testnet files a hash-only request on kaap-dao-1113045321.testnet; watcher https://watcher-production-2350aa2a.up.railway.app
1. filed request #6: "Authenticate DAO for confidential intents", showing only the hash 17d2ca5e26625bf8ff53b885ff9bf1a7efe59da9e2fcb08d02aaa9b4df3b655a: https://testnet.nearblocks.io/txns/6e5dG6JwgLNFfpqz8SdZ1rcMDfGWcwFtUdge4dJskHb5
2. the watcher judged it with no words: risk high, findings HASH_UNVERIFIED, vote not_needed; the request is InProgress
3. handing the words to the watcher, sealed: kaap seal-text --dao kaap-dao-1113045321.testnet --id 6 --file <text.json> --worker https://watcher-production-2350aa2a.up.railway.app
   | kaap seal-text kaap-dao-1113045321.testnet #6 on testnet
   | read at final block 277465642 (2026-11-13 05:11 UTC): the guard's key and the proposal, agreed by near-testnet.drpc.org and rpc.testnet.fastnear.com
   | Kaap on testnet: deployment record deployments/testnet.json (the current one, deployed 2026-11-13T04:51:47Z): guard kaap-guard-1113045147.testnet, registry kaap-registry-1113045147.testnet
   | contracts
   |   pass  guard code: kaap-guard-1113045147.testnet runs the recorded build, sha256 9e74bbba...5d23 (two providers, block 277465642)
   |   pass  guard keys: kaap-guard-1113045147.testnet has no access key, so no one can sign for it (two providers, block 277465642)
   |   pass  registry code: kaap-registry-1113045147.testnet runs the recorded build, sha256 228c2136...b2c9 (two providers, block 277465642)
   |   pass  registry keys: kaap-registry-1113045147.testnet has no access key, so no one can sign for it (two providers, block 277465642)
   | text key: 40cc00435ddbcdb638ac967f7f592e69d290712d578010e47f4b9d16fcd62757 from run GauQQEjVA7YVDk3pMZbAEUvaKBTuWMGQHPDxySL7KRUA, signed by the guard's accepted key ed25519:8eiUXYidw2x7WWfVVmYkDcewi3aBzxKomMefsPPhaecF (checked here with ed25519)
   | text: NEP-413, hashes to 17d2ca5e26625bf8ff53b885ff9bf1a7efe59da9e2fcb08d02aaa9b4df3b655a, the payload proposal 6 asks to sign
   | sent to https://watcher-production-2350aa2a.up.railway.app/texts: 384 bytes of ciphertext only Kaap's sealed program can open, and a reply key made for this request
   |
   | what the worker at https://watcher-production-2350aa2a.up.railway.app reported, not yet checked against the chain
   |   risk: critical
   |   floor: critical
   |   findings: HASH_TEXT_DANGEROUS, INTENTS_KEY_CHANGE
   |   AI: unavailable, no model answered
   |   veto: started (the guard's vote to reject lands on chain on its own, after this answer)
   |   sealed run: https://testnet.nearblocks.io/txns/BBN8r7v8tv9zyMTHdHySwY79Y4ruXMNJdSV7orBeqA9U
   |
   | explanation in the worker's answer, opened here with the reply key made for this request
   |   AI unavailable (ai_key_missing).
   |
   | confirm it from the chain: kaap verify kaap-dao-1113045321.testnet 6 --network testnet
   | The AI part of a verdict can differ between runs.
4. request #6 is Rejected, seen 124.7 s after the words were sent and 194.3 s after the filing block; votes: {kaap-guard-1113045147.testnet: Reject}
   the watcher now holds: risk critical, findings HASH_TEXT_DANGEROUS, INTENTS_KEY_CHANGE, vote cast, verdict 49e8cbec1d5554b6833b19ed2bc20229836b794cfd5540ea217c4613aeefd882
RESULT: pass, unreadable and left alone without the words, read and rejected by the guard alone with them
```

Requests #7 and #8 are the same kind of request, filed with `--leave-open` and never explained, so they stay open as examples of what a treasury sees. The site offers the words behind #8 on its check page (`deployments/demo-hash-text.json`). The words behind #7 were lost when the machine's temporary folder was emptied, which is why the script now keeps them in a durable folder; #7 stays open and unread.

## No AI answer in these runs, and why the veto still stands

Every verdict above says `ai_status: unavailable`. `scripts/prove.mjs` names no NEAR AI key, and the watcher's runs that morning found none stored for the new project. The verdicts are critical on a critical plain-code floor (`DESC_CONTRADICTS`, `HASH_TEXT_DANGEROUS`), which the guard's rule accepts with no AI answer at all: no veto here rests on a model. How the AI part performs is in `packages/sealed/AI-EVAL.md`.

## What this does not cover

- Strict mode on testnet. The guard has it and the demo treasury has not turned it on, so no request was vetoed for being unreadable. The guard's sandbox tests against the real Sputnik DAO binary and the watcher's tests cover it.
- A key change. No change of the guard's key was announced, so the 24-hour wait and the watcher's alert are shown by tests only.
- A race against approvers. The treasury needs two approvals, and nobody approved anything while Kaap worked. A treasury where one approval executes a request can pay before any veto lands, and `kaap arming` says so for such a policy.
- OutLayer's pace. A verdict needs OutLayer to answer, and that morning one run in three took over a minute and a half. Nothing in Kaap can speed that up.
- Mainnet. Everything here is NEAR testnet.
