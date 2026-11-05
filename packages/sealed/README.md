# kaap-sealed

The program that judges a NEAR Sputnik DAO proposal inside OutLayer's sealed hardware (Intel TDX)
and signs the verdict with a key that only this program, run by Kaap's worker account, can use.
Kaap's guard contract votes only on verdicts signed by that key.

## Testnet deployment

| Thing | Value |
| --- | --- |
| OutLayer project | `kaap-worker-1029053612.testnet/kaap-sealed` on `outlayer.testnet`, uuid `p00000000000000a9` |
| Worker account (the only caller) | `kaap-worker-1029053612.testnet` |
| Build (wasm sha256) | `0099d7b75f5f509ee0c84a7b819058c67ba2e9f9099e4dbf51e413a343d6ff49`, 380,792 bytes, wasm32-wasip2 |
| Hosted at | secret gist `5ea40ed7c5610efcd50d69af2ae8abe2`, commit `0ecb03eb`: [raw URL pinned to the commit](https://gist.githubusercontent.com/ramakrishnanhulk20/5ea40ed7c5610efcd50d69af2ae8abe2/raw/0ecb03ebcbd8714164965d2df18edbae7d95875e/kaap-sealed-0099d7b7.wasm) |
| Registered by | [create_project](https://testnet.nearblocks.io/txns/FHy3utGUWWwPtPMGz8ALXh9NLR5G4Mo2h1QTsEDGtuMu) |
| Verdict public key | `ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN` |

Testnet FastFS (`test.fastfs.io`) answered HTTP 502 on the publishing day, so the build is served
from the gist instead; `packages/sealed/testnet.json` records every published version.

The key is bound to the project's uuid and to the account that sends `request_execution` (OutLayer
`bind: "project"`, `caller: "signer"`): every version of this project signs with it when
`kaap-worker-1029053612.testnet` calls, and any other caller gets a different key. That is why
this one account is the worker for every testnet run, and why the guard accepts only this key.

## What the job reads

Input on stdin, nothing else accepted: `{"v":1,"network":"testnet"|"mainnet","guard":<account>,
"dao":<account>,"proposal_id":<u64>,"expires_in_ms":1 to 3600000}`. The network must be the one
OutLayer says the run is on. On testnet only, `"test_corrupt_https":true` corrupts one read on
purpose, to show the job holds.

At one final block, from two providers that must agree (OutLayer's own RPC through the host
`view`, and dRPC over HTTPS):

- the block itself (height, hash, timestamp), the height taken from dRPC's final block;
- `get_proposal({"id":N})` and `get_policy()` on the DAO;
- the code hash of the DAO and of every contract the proposal would call: a FunctionCall's or
  UpgradeRemote's receiver, a token Transfer's token, and its receiver when the transfer carries
  a `msg`.

The kind and the policy are compared in kaap-core's canonical form, because Sputnik's JSON order
for its sets and maps is not fixed; every other proposal field is compared byte for byte. Any
failed read or difference gives `{"v":1,"status":"held","reason":...}` and no signature.

The proposal is then decoded by kaap-core, with the policy just read as the policy before (only
while the proposal is InProgress). There is no price list yet, so every token is unpriced
(UNKNOWN_VALUE, high) and no payment history (not available).

Then, if the run carries a NEAR AI key as the OutLayer secret `NEAR_AI_API_KEY`, one
non-streamed request to `z-ai/glm-5.3-flash`, after `GET /v1/model/list` says that exact id is
NEAR AI's own sealed hardware (`providerType` vllm, `ownedBy` nearai, attestation supported,
verifiable, ready), sent with `x-no-aliasing: true`. Its reasoning is capped at 256 tokens with
`thinking_token_budget` (NEAR AI's docs of 27 Oct 2026: turning it off moves it into the answer).
The model sees a fixed system prompt and the facts as one quoted JSON object with every field
capped (the description at 2,000 bytes). Its answer must be exactly
`{"risk":"low|medium|high|critical","explanation":"<at most 280 bytes of plain ASCII, no links, no
markup>"}`. Anything else, or no key, makes the AI unavailable and the plain-code verdict stands.

The key reaches a run only when the caller names its secret row in `request_execution`
(`secrets_ref: {"profile": "near-ai", "account_id": <the row's owner>}`; the worker sends it when
`KAAP_AI_SECRETS_ACCOUNT` is set). OutLayer starts a run whose row is missing, or whose lock does
not admit this build, without any error, so the job never stays quiet about it: with no key, or an
empty one, the verdict is signed with the AI unavailable and the explanation
`AI unavailable (ai_key_missing): no NEAR AI key reached this run.`, and the worker raises the
`ai_key_missing` health signal when it sees that code.

## When an AI answer counts as verified

An answer is "AI verified" only when every one of these checks passes inside this job, on evidence
it fetched itself with 32 random bytes it drew for this run (the nonce). Any check that fails, or
cannot run, makes the answer "AI unverified" with the reason in the explanation. It is never
shown as verified by default.

Before the question is sent:

1. `GET /v1/attestation/report` (keyed) for `z-ai/glm-5.3-flash`, `signing_algo=ed25519`, this
   run's nonce, `provider=near`. Every model entry in it is checked:
   - its Intel TDX quote, verified here with dcap-qvl 0.7.0 against collateral the job fetched from
     Intel's PCS with four keyless calls; dcap-qvl refuses a debug or revoked machine;
   - Intel's TCB level is UpToDate or OutOfDate, the two levels Ram accepted on 23 Oct 2026, and
     the collateral is in date with Intel's evaluation data number 20 or later;
   - the quote's report data binds the entry's signing key and this run's nonce in NEAR's layout
     (bytes 0 to 31 the key, 32 to 63 the nonce); any other layout is refused;
   - its NVIDIA GPU evidence carries the nonce, is judged by NVIDIA's attestation service (NRAS),
     and NRAS's ES384 token verifies against NVIDIA's published keys with the nonce and an
     overall pass.
2. `GET /v1/attestation/ita-token` (public): Intel's PS384 token for NEAR AI's gateway, verified
   against Intel's key set fetched on this run (Intel's current signing certificate expires on
   2026-11-19, so no key is pinned), with the nonce, no debug, an accepted TCB level, and its report
   data rebuilt in Intel's layout. This proves the gateway only: its "model" token carries the
   gateway's own quote and key, so it is shown as gateway evidence, never as the model's.

After the answer:

3. The answer came back as one JSON completion (not streamed) from `z-ai/glm-5.3-flash` itself,
   not through one of its aliases.
4. `GET /v1/signature/{chat_id}` (keyed): kind `provider_tee` (the model's own key, not the
   gateway's), ed25519, a valid signature over `<model id>:<sha256 of the exact request
   bytes>:<sha256 of the exact response bytes>` as rebuilt here, by a key that exactly one entry
   checked in step 1 named.

The clock for every expiry is `NEAR_BLOCK_TIMESTAMP`, the time of the block that requested the
run, taken as nanoseconds only when it lies within ten minutes of the final block the job read.
A run started over HTTPS has no such clock, so its answers are never verified.

An answer that is not verified can raise a verdict to high at most (threat model C9). On 23 Oct
2026 NEAR AI's hardware reported OutOfDate with 10 Intel advisories; a verified verdict's
explanation starts with the level it saw, for example `AI verified (Intel TCB: OutOfDate).`, and
the verify page must state it too.

What "verified" does not mean: that the machine runs a build Kaap has reviewed. The model's
measured configuration (RTMR3 event log, MRCONFIGID) is not compared with an allowlist, so
verified means a genuine, non-debug Intel TDX machine whose GPUs NVIDIA passed holds the key that
signed this exact answer. NEAR AI's instances of one model share that key, so it does not prove
which instance answered.

## Where the evidence is

Every signed verdict's evidence is published in OutLayer public storage under the key
`ai-evidence:<hex sha256 of "kaap-verdict-v1\n" plus the verdict's borsh bytes>`. Only this
project's code can write there; anyone can read it:

```
GET https://testnet-api.outlayer.ai/public/storage/get?project=<project id>&key=ai-evidence:<hash>
```

It holds ids, hashes, quotes, claims and check results only: the nonce, the clock, each model's
Intel TDX quote in hex with its TCB level, advisories, signing key and NRAS result, the PCK
platform flags Kaap accepts without judging (SMT, cached keys, dynamic platform; as ruled on
2 Nov 2026, NEAR AI's own guide does not judge them), the gateway's Intel claims, the
completion's id, finish reason, token counts and length, the signature with the two hashes it
covers, and a link to the same answer on NEAR AI's own verifier,
`https://cloud.near.ai/verify?model=z-ai%2Fglm-5.3-flash#receipt=<base64url JSON>`. NEAR AI's page
re-checks the signature and its signer against fresh evidence, but it does not compare a
deployment with an allowlist, so this job's checks are the ones that decide "verified". No text
from the prompt or the answer is ever stored, only their hashes: the evidence is public, and a
prompt may one day carry a text only a DAO's members may read. A verified verdict whose evidence
could not be stored is signed as unverified instead.

## Outside calls

The job calls no host outside its manifest: `cloud-api.near.ai`, `near.drpc.org`,
`near-testnet.drpc.org`, `api.trustedservices.intel.com`, `certificates.trustedservices.intel.com`,
`portal.trustauthority.intel.com` and `nras.attestation.nvidia.com`. OutLayer enforces that list
only for its curated connectors, not for an ordinary project like this one, so it is the code's
own rule, held by a test that checks the list both ways, not something OutLayer guarantees.

| Outside call | Connect | First byte | Between bytes | Whole call | Size cap |
| --- | --- | --- | --- | --- | --- |
| dRPC JSON-RPC | 5 s | 10 s | 5 s | 15 s | 2.1 MiB body, 512 KiB result |
| OutLayer host RPC | set by the worker: 10 s | | | 30 s (worker) | 512 KiB result |
| NEAR AI model list | 5 s | 10 s | 5 s | 10 s | 512 KiB |
| NEAR AI attestation report | 5 s | 15 s | 5 s | 20 s | 2 MiB |
| Intel PCS, each of 4 | 5 s | 8 s | 5 s | 10 s | 256 KiB, 16 KiB per header |
| NVIDIA NRAS | 5 s | 15 s | 5 s | 20 s | 1 MiB |
| NVIDIA key set | 5 s | 10 s | 5 s | 15 s | 2 MiB (530 KB today) |
| NEAR AI public Intel token | 5 s | 10 s | 5 s | 15 s | 512 KiB |
| Intel key set | 5 s | 8 s | 5 s | 10 s | 256 KiB |
| NEAR AI chat | 5 s | 25 s | 10 s | 30 s | 64 KiB, 656 tokens |
| NEAR AI signature, up to 4 tries 750 ms apart | 5 s | 8 s | 5 s | 8 s | 64 KiB |

All reads must finish within 25 s, the checks before the question within 25 s of their start, and
the whole job within 50 s of the start; a run is given 60 s.

## What it signs

`kaap_core::Verdict`, version 1: guard, network, DAO, proposal id, `kind_hash` (sha256 of the
canonical kind), `policy_hash` (sha256 of the canonical policy read), `receivers_hash` (sha256 of
the borsh encoding of the sorted list of (account, code hash) pairs, the DAO included), the block
height read, risk, floor, finding codes, decoder version, model id (empty when no model answered),
AI status, `explanation_hash` (sha256 of the printed explanation) and `expires_at_ms` (the read
block's timestamp plus `expires_in_ms`).

The risk is the higher of the plain-code floor and the model's risk, and a model answer that is
not verified counts as high at most, so the AI can raise a verdict but never lower it, and only a
verified answer can make it critical.

The signature is ed25519 over `kaap-verdict-v1\n` followed by the verdict's borsh bytes
(kaap-core `verdict_bytes`). The output, at most 900 bytes:

```
{"v":1,"status":"ok","verdict":"<base64 borsh, no prefix>","signature":"<base64, 64 bytes>","public_key":"ed25519:...","explanation":"..."}
```

## How a stranger checks the key belongs to this project and caller

No OutLayer call returns a project's signing key. The route is the attestation of a run that
printed it:

1. Take a run transaction from `RUNS.md`, for example
   `7HvniWe5JKgqARsiWW8onQpSw1rPcHWiNG4vLwBtekSC`, and fetch
   `https://testnet-api.outlayer.ai/attestations/by-tx/<tx>`.
2. Check that it names `project_id` `kaap-worker-1029053612.testnet/kaap-sealed`,
   `caller_account_id` `kaap-worker-1029053612.testnet`, and `wasm_hash` equal to
   `executed_wasm_sha256` equal to the build hash above; that its `input_hash` is the sha256 of
   the transaction's `input_data`; and that its `output_hash` is the sha256 of the transaction's
   return value, which holds the public key. Then check its Intel TDX quote.
3. Rebuild the wasm from this source (below) and confirm the hash, because the attestation proves
   which program ran, not that the program printed the host's key honestly.
4. Check a signature: `node packages/sealed/tools/check-output.mjs <output.json>` verifies it with
   Node's crypto and decodes the verdict.

The attestation names the project by owner and name, while the key belongs to its uuid: a project
deleted and created again under the same name would have other keys. The uuid above is the one
these keys belong to.

## Build it yourself

Inside Linux or WSL with the toolchain pinned in `rust-toolchain.toml` (Rust 1.93.0, target
`wasm32-wasip2`) and the repo's `Cargo.lock`:

```
bash packages/sealed/build.sh
```

It remaps local paths out of the binary (`--remap-path-prefix`), strips symbols, refuses to finish
if a home or checkout path is still inside, and prints the sha256. Two builds in separate target
directories gave `0099d7b7...ff49` on 29 Oct 2026.

## Run it

- Tests, natively, on recorded testnet answers: `cargo test -p kaap-sealed`.
- The local build under plain wasmtime, with recorded answers and a public test key (never
  published): `bash packages/sealed/run-local.sh`.
- Publish a version: `bash scripts/WO-02b-publish-testnet.sh fastfs` or
  `bash scripts/WO-02b-publish-testnet.sh https://<host>/<file>.wasm`. It checks the served sha256
  before registering anything.
- Run on testnet: `bash scripts/WO-02b-run-testnet.sh <dao> <proposal id> [--runs N] [--corrupt]`.

## What this does not defend against

Both RPC providers lying the same way; anything that changes after the block read (the verdict
pins the block, the policy, the kind and every called contract's code, so a change is visible to
whoever re-checks); a kind or policy over kaap-core's 256 KiB limit, which always holds rather than
being judged; what an unknown receiver contract does; a NEAR AI model machine running a build
nobody reviewed (no measurement allowlist, above); whether the model's judgement is right; and
attacks on the TDX hardware, NVIDIA's GPUs or OutLayer's dstack stack, which this program trusts.
