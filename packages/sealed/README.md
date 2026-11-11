# kaap-sealed

The program that judges a NEAR Sputnik DAO proposal inside OutLayer's sealed hardware (Intel TDX)
and signs the verdict with a key that only this program, run by Kaap's worker account, can use.
Kaap's guard contract votes only on verdicts signed by that key.

## Testnet deployment

| Thing | Value |
| --- | --- |
| OutLayer project | `kaap-worker-1029053612.testnet/kaap-sealed` on `outlayer.testnet`, uuid `p00000000000000a9` |
| Worker account (the only free caller) | `kaap-worker-1029053612.testnet` |
| Build (wasm sha256) | `da2c285350551e2367594121856e29cdfe6bc134f56f7c3ce4372584c7a4c666`, 1,675,100 bytes, wasm32-wasip2, active since 11 Nov 2026. The two builds before it, `bf7bb4f8...4f58` and `e1192b28...0527`, are still listed |
| Hosted at | secret gist `5ea40ed7c5610efcd50d69af2ae8abe2`, commit `320a36d3`: [raw URL pinned to the commit](https://gist.githubusercontent.com/ramakrishnanhulk20/5ea40ed7c5610efcd50d69af2ae8abe2/raw/320a36d3ae941b60731a83a77ffa2b1b474d90c2/kaap-sealed-da2c2853.wasm) |
| Registered by | [add_version](https://testnet.nearblocks.io/txns/Cvo1WSGy3T4RPProXexUee5budUS5rvcB2d51A2SFKhg), in the project from [create_project](https://testnet.nearblocks.io/txns/FHy3utGUWWwPtPMGz8ALXh9NLR5G4Mo2h1QTsEDGtuMu) |
| Verdict public key | `ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN` |

Testnet FastFS (`test.fastfs.io`) answered HTTP 502 on the publishing day, so the build is served
from the gist instead; `packages/sealed/testnet.json` records every published version.

The key is bound to the project's uuid and to the account that sends `request_execution` (OutLayer
`bind: "project"`, `caller: "signer"`): every version of this project signs with it when
`kaap-worker-1029053612.testnet` calls, and any other caller gets a different key. That is why
this one account is the worker for every testnet run, and why the guard accepts only this key.

## Who can run it, and what it costs

Kaap's own worker runs the job free on chain. Anyone else pays one cent per check, which is 10,000
in OutLayer's unit of millionths of a dollar (`PRICE_MICRO_USD` in `src/payment.rs`). OutLayer lets
only the projects it curates set a price, so this program enforces it, from variables OutLayer sets
and no input can fill. There are two ways to pay:

- Over HTTPS, with an OutLayer payment key: `POST /call/<project id>` with the header
  `X-Attached-Deposit: 10000`. The program reads it as `USD_PAYMENT`.
- On chain, from a stablecoin balance held at `outlayer.testnet` (`ft_transfer_call` with the
  message `{"action":"deposit_balance"}`): `request_execution` with `attached_usd` set to `"10000"`
  in its `params`. The program reads it as `ATTACHED_USD`.

A run is free only on chain, and only when `NEAR_USER_ACCOUNT_ID` is exactly the account named in
`packages/sealed/testnet.json`, compiled in at build time. That variable is the transaction's
signer and the account the run's keys are bound to. `NEAR_SENDER_ID` is not used, because an Agent
Connect binding can rewrite it. An HTTPS call always pays, even with the worker's own payment key.
Kaap has no mainnet worker yet, so every mainnet run pays until one is named.

An amount that is missing, empty, not a plain decimal integer, or below the price gets a normal
answer before anything is read or signed:

```
{"detail":"A check costs 10000 millionths of a dollar. This run carried 9999. An underpayment is not refunded.","reason":"payment_below_price","status":"refused","v":1}
```

OutLayer counts that as a successful run, so the amount is kept: an underpayment is not refunded,
and neither is a payment on a run whose input is refused. More than the price is accepted, and no
change is given. Asking for the text key with `{"v":1,"op":"pubkey"}` is free.

A paid run is the same check with two differences a payer should know before buying:

- Its verdict is signed by a key derived for the payer, not by Kaap's. The guard accepts only
  Kaap's key, so a paid verdict is advice the payer can prove. It cannot veto anything.
- It writes no public evidence. Every Verified verdict must have evidence a stranger can read, so a
  paid run is never "AI verified".

Kaap's NEAR AI key does not reach a paid run, because the secret's rule is judged against the
payer's account. Without a key of the payer's own the verdict is the plain-code one, with
`ai_key_missing`. A sealed text works as usual, encrypted to the text key this payer gets from
`{"v":1,"op":"pubkey"}`.

HTTPS payments collect in OutLayer's own database, and its earnings page still says "Withdraw
(Coming Soon)", so Kaap cannot take them out until OutLayer ships that. Chain payments go to the
project owner's balance on `outlayer.testnet`, which `withdraw_developer_earnings` pays out today.

Builds published before this gate have no price check, and a caller can name one with `version_key`
until it is removed.

## What the job reads

Input on stdin, nothing else accepted: `{"v":1,"network":"testnet"|"mainnet","guard":<account>,
"dao":<account>,"proposal_id":<u64>,"expires_in_ms":1 to 3600000}`. The network must be the one
OutLayer says the run is on. On testnet only, `"test_corrupt_https":true` corrupts one read on
purpose, to show the job holds. A member adds `text_ciphertext` and `reply_key` together to hand in
the text behind a hash (see "The sealed text channel"). The other input is `{"v":1,"op":"pubkey"}`,
which prints the job's text key.

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

On mainnet the job then reads what `kaap check` and the evaluation judge with. Testnet tokens have
no market price, so a testnet run reads neither of these:

- 1Click's public price list, `GET https://1click.chaindefuser.com/v0/tokens`, keyed by exact
  contract id;
- `get_last_proposal_id` and up to 3 pages of `get_proposals`, 100 ids each, at the same block from
  the same two providers, which must return the same bytes for every read.

kaap-core builds the payment history from those pages by the rule the CLI uses: the DAO's approved
payments submitted before this proposal, with USD at today's prices.

This helps DAOs that pay through ordinary Transfer proposals or token calls: a usual payment to a
known recipient stays quiet, a new recipient gets NEW_RECIPIENT, and more than ten times the median
earlier payment gets LARGE_AMOUNT, both warnings at medium. It does not touch a payment made as a
signed hash, which is how NEAR Business treasuries usually pay.

- It is both reads or neither: if either fails, every token stays unpriced (UNKNOWN_VALUE, high),
  there is no payment history (not available), and the verdict is still signed.
- A DAO with more than 300 proposal ids keeps that unpriced reading.
- A DAO with no past payments has an empty history, which is still a complete one, so it reads every
  public payment as a new recipient, a warning.
- A large payment with an honest description gets a warning, not a veto.

The proposal is then decoded by kaap-core, with the policy just read as the policy before (only
while the proposal is InProgress) and the input's `guard` as the guard account, so Kaap's own
enrol call reads as `guard_enrol` here as it does in the CLI.

Then, if the run carries a NEAR AI key as the OutLayer secret `NEAR_AI_API_KEY`, one
non-streamed request to `z-ai/glm-5.3-flash`, after `GET /v1/model/list` says that exact id is
NEAR AI's own sealed hardware (`providerType` vllm, `ownedBy` nearai, attestation supported,
verifiable, ready), sent with `x-no-aliasing: true`. Its reasoning is capped at 512 tokens with
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
   - its Intel TDX quote, verified here with dcap-qvl 0.7.1 against collateral the job fetched from
     Intel's PCS with four keyless calls; dcap-qvl refuses a debug or revoked machine;
   - Intel's TCB level is UpToDate or OutOfDate, the two levels Kaap accepts (decided 23 Oct
     2026), and the collateral is in date with Intel's evaluation data number 20 or later;
   - the quote's report data binds the entry's signing key and this run's nonce in NEAR's layout
     (bytes 0 to 31 the key, 32 to 63 the nonce); any other layout is refused;
   - its software record is held to that quote, with no network call. The event log replays to
     the quote's RTMR3, and every RTMR3 event must be a dstack runtime event. The system image and
     launcher hashes are read only from boot events before `system-ready`, once each. MRCONFIGID
     must be `01`, then the SHA-256 of `app_compose`'s exact text, then 15 zero bytes, and the boot
     launcher hash must be that same SHA-256. Every value the report states beside these must be
     the measured one. When the report carries the launcher's deployment log, the log's own quote
     passes the same Intel check, carries this run's nonce and the SHA-256 of the logged actions,
     has the model quote's MRCONFIGID, and its event log replays to its own RTMR3. That quote is
     checked only with the Intel collateral the job already holds for the model's platform: the
     launcher and the model must be one machine, so a quote from any other platform is
     `deploy_log_mismatch`.
     A failure here gives one of `event_log_missing`, `rtmr_replay_mismatch`,
     `boot_record_missing`, `config_version_unknown`, `compose_mismatch` or `deploy_log_mismatch`;
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

Verified means a genuine, non-debug Intel TDX machine whose GPUs NVIDIA passed holds the key that
signed this exact answer, and that the launcher configuration, the system image hash and the
deployment log in the evidence are the ones that machine's Intel quote commits to.

What "verified" does not mean. It does not mean that software is approved, reviewed or safe: Kaap
records it and compares it with no allowlist. `os_image_known` only says whether the image hash is
one the OS vendor published for production, and it never decides anything. It does not prove which
instance answered: NEAR AI's instances of one model share one key, and the report names only the
host the gateway picked for that call. And it does not prove that what the deployment log requested
is what runs now, because the log records requests. NEAR AI put the limit plainly in its report of
9 Nov 2026 (https://near.ai/blog/security-incident-report-sglang-vulnerability): "Confidential
computing protects data from the operator and the host. It does not protect against a
vulnerability in the software running inside the environment."

## Where the evidence is

The evidence of every verdict from Kaap's own worker is published in OutLayer public storage under
the key `ai-evidence:<hex sha256 of "kaap-verdict-v1\n" plus the verdict's borsh bytes>`. Only this
project's code can write there; anyone can read it:

```
GET https://testnet-api.outlayer.ai/public/storage/get?project=<project id>&key=ai-evidence:<hash>
```

It holds ids, hashes, quotes, claims and check results only: the nonce, the clock, each model's
Intel TDX quote in hex with its TCB level, advisories, signing key and NRAS result, its registers
(MRTD, MRCONFIGID, RTMR0 to RTMR3) and software record (the launcher hash, the system image hash
and whether the vendor published it, the app and instance ids, and the deployment log's action
count, actions hash, launcher quote hash and newest `compose_up` tag, commit, file and file hash,
or `absent`; never the launcher text or the launcher's quote itself), the PCK
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

## The sealed text channel

NEAR Business and Trezu keep the text behind each payment hash on their own server. Until they
share it, a member who has it can hand it to Kaap so that only this program can ever read it. The
worker and its database only ever hold ciphertext.

1. `{"v":1,"op":"pubkey"}` prints `{"public_key":"ed25519:...","signature":"<base64>","status":"ok",
   "text_key":"<hex>","v":1}`. `text_key` is the job's X25519 public key. Its secret is
   `outlayer::encryption_keys::mac("texts", None, b"kaap-x25519-v1")`, the route SDK 0.2.1 offers:
   the same key in every run with this project and this caller, and another key for anyone else.
   `signature` is the verdict key's over `kaap-text-key-v1\n` followed by the 32 key bytes. Check it
   against the key the guard accepts, so no relay can swap in a key of its own.
2. The member encrypts this object to `text_key`, the same object the CLI takes: `{"message":...,
   "nonce":<base64 of 32 bytes>,"recipient":...,"standard":"nep413"|"nep461","quotes":[...]}`
   (`quotes` is optional). The construction is the one OutLayer's own secrets use: a fresh X25519
   key, HKDF-SHA256 with no salt and the info `kaap-texts-v1`, ChaCha20-Poly1305, written as
   `0x01 | ephemeral public key (32) | nonce (12) | ciphertext | tag (16)`. The associated data is
   `kaap-text-v1\n<network>\n<dao>\n<proposal id>\n<reply key hex>`.
3. The judge input adds `text_ciphertext` (base64) and `reply_key` (hex of the member's own X25519
   public key). The whole input is at most 32 KiB, which leaves about 24 KiB for the text.
4. The job opens the text inside the enclave and hands it to kaap-core. A ciphertext that does not
   open, for any reason, gives `{"reason":"text_ciphertext could not be opened","status":"refused",
   "v":1}` before any outside call. Because the reply key is bound in, nobody who holds a member's
   ciphertext, the worker included, can resubmit it with their own key to read the answer. A text
   that does not match the proposal's hash is refused, never judged, because anyone can send one:
   `{"reason":"text_does_not_match","status":"refused","v":1}`, with no signature.
5. The verdict's `explanation` field is `sealed:<base64>`: the explanation encrypted to `reply_key`
   in the same layout, under `kaap-explanation-v1\n<network>\n<dao>\n<proposal id>\n<reply key
   hex>`. `explanation_hash` is the hash of that printed field, as for any verdict, so no hash of
   the plain explanation reaches the chain. The 900-byte output leaves it less room than a public
   explanation: about 180 bytes of plain text on the demo DAO's verdicts, about 85 on the longest
   verdict the tests build. So the model is told a limit of 120 characters
   (`MAX_MEMBER_EXPLANATION_BYTES`), the note in front is a short code, such as `AI unverified
   (no_clock).`, where a public verdict has a sentence, and nothing is cut at that limit: an answer,
   up to the usual 280, is cut only when it does not fit this run's room, at its last word boundary.
   A public prompt and a public explanation are not changed by any of this.

A prompt built from a sealed text leaves the job only after every check before the question has
passed, unlike a public one, where a failed check only means the answer cannot be Verified (C12).
On a failed check nothing about the text is sent, the AI status is Unavailable with the code
`sealed_hardware_not_proven`, and the plain-code verdict stands. A run over HTTPS has no trusted
clock, so it never asks the model about a text.

The finding codes, the risk and the verdict's other fields stay public, as on any verdict, because
the guard reads them. So does the evidence record, which holds hashes and sizes, never text.

`node scripts/text-roundtrip.mjs` runs the whole trip and three attacks on testnet, and
`--local <wasm>` runs it against the local build.

## Eval mode

Live since build `da2c2853` (11 Nov 2026). A third input scores a proposal handed in
whole, so the AI can be measured on the answer key without a DAO on chain:

```
{"v":1,"op":"eval","network":"testnet","input":<a kaap-core ProposalInput, exactly as serde writes it>}
```

`network` is the run's own network. The proposal is read by serde into `ProposalInput`, the one
reader, and must be exactly what serde writes for what it read, so an unknown or missing field at
any depth is refused (`input is not a kaap-core ProposalInput as serde writes it`). The whole input
is at most 32 KiB. The payment gate is the judge run's: the worker is free and anyone else pays.

Every fact judged comes from the input. The one chain read is the final block, from both providers
by the judge run's rule, for the clock; it is not printed. kaap-core analyses the input, and the
model is asked about it exactly as for a public verdict. Then it prints, keys sorted, every key always
present and null when it does not apply:

```
{"ai_reason":"no_clock","ai_risk":"critical","ai_status":"unverified","completion_tokens":120,"explanation_sha256":"<hex>","findings":["NEW_RECIPIENT"],"finish_reason":"stop","floor":"medium","model_id":"z-ai/glm-5.3-flash","prompt_tokens":900,"reasoning_tokens":40,"risk":"high","status":"eval","v":1}
```

`risk` is what a verdict would carry: the higher of the floor and the AI's own `ai_risk`, an answer
that is not verified counting as high at most. `explanation_sha256` is the sha256 of the model's own
explanation, which is not printed. There is no signature, no verdict and no public key, nothing is
written to public storage and the text key is never touched, so an eval leaves no mark under Kaap's
verdict key, whoever paid for it. The clock is a judge run's: `NEAR_BLOCK_TIMESTAMP` beside a final
block both providers agree on. Without one, the answer is unverified (`no_clock`) and the scores are
still printed.

`node scripts/ai-eval.mjs --dry-run` builds the input of every answer-key record through
kaap-core (`evalInput` in packages/core-wasm, the scoreboards' own `input_of`, with the census price
list) and prints how many fit. A record over 32 KiB gets its price table cut to the tokens its own
analysis names (`evalInputTrimmed`), and only when kaap-core's whole analysis is the same with both
tables; its row says `prices_trimmed: true`. Without `--dry-run` the script runs them on testnet once
each, with spending caps, and `--report` scores the results.

## Outside calls

The job calls no host outside its manifest: `cloud-api.near.ai`, `near.drpc.org`,
`near-testnet.drpc.org`, `api.trustedservices.intel.com`, `certificates.trustedservices.intel.com`,
`portal.trustauthority.intel.com`, `nras.attestation.nvidia.com` and `1click.chaindefuser.com`.
OutLayer enforces that list
only for its curated connectors, not for an ordinary project like this one, so it is the code's
own rule, held by a test that checks the list both ways, not something OutLayer guarantees.

| Outside call | Connect | First byte | Between bytes | Whole call | Size cap |
| --- | --- | --- | --- | --- | --- |
| dRPC JSON-RPC | 5 s | 10 s | 5 s | 15 s | 2.1 MiB body, 512 KiB result |
| OutLayer host RPC | set by the worker: 10 s | | | 30 s (worker) | 512 KiB result |
| 1Click price list, mainnet only | 5 s | 8 s | 5 s | 8 s, cut to the time left below | 1 MiB |
| One `get_proposals` page, mainnet only | as dRPC and the host above | | | as above, cut to the read deadline for dRPC | As above, tighter than the CLI's 4 MiB: a larger page is a failed read, never split |
| Prices and history together, mainnet only | | | | 8 s, cut to the read deadline: whole for the 1Click call, checked between calls for the history. Skipped, with the safe reading, when under 8 s of the read deadline is left before either starts. Worst case, one hung history call: to 25 s on dRPC, to 55 s on the host | 3 pages, 300 ids |
| NEAR AI model list | 5 s | 10 s | 5 s | 10 s | 512 KiB |
| NEAR AI attestation report | 5 s | 15 s | 5 s | 20 s | 2 MiB |
| Intel PCS, each of 4 | 5 s | 8 s | 5 s | 10 s | 256 KiB, 16 KiB per header |
| NVIDIA NRAS | 5 s | 15 s | 5 s | 20 s | 1 MiB |
| NVIDIA key set | 5 s | 10 s | 5 s | 15 s | 2 MiB (530 KB today) |
| NEAR AI public Intel token | 5 s | 10 s | 5 s | 15 s | 512 KiB |
| Intel key set | 5 s | 8 s | 5 s | 10 s | 256 KiB |
| NEAR AI chat | 5 s | 25 s | 10 s | 30 s | 64 KiB, 912 tokens |
| NEAR AI signature, up to 4 tries 750 ms apart | 5 s | 8 s | 5 s | 8 s | 64 KiB |

All reads must finish within 25 s, the checks before the question within 25 s of their start, and
the whole job within 50 s of the start; a run is given 60 s.

The 8 s cannot cut one history call short. The worst case is a call that hangs just before its
limit: dRPC stops at the 25 s read deadline, and a host call, which the job cannot time, stops at
55 s (25 s plus the worker's 30 s). The history then counts as failed, the AI step finds its 50 s
gone, and the plain-code verdict is signed in the 5 s left.

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
(kaap-core `verdict_bytes`). The output, at most 900 bytes, with its keys sorted like everything
else the job prints or stores, so it and the CLI show one object the same way:

```
{"explanation":"...","public_key":"ed25519:...","signature":"<base64, 64 bytes>","status":"ok","v":1,"verdict":"<base64 borsh, no prefix>"}
```

## How a stranger checks the key belongs to this project and caller

No OutLayer call returns a project's signing key. The route is the attestation of a run that
printed it:

1. Take a run transaction from `RUNS.md`, for example
   `Edzq3KEDgXQBeLEEZ62mqRT97mAJMpVbZVcB3dxbh6sW`, and fetch
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
directories gave `da2c2853...c666` on 11 Nov 2026.

## Run it

- Tests, natively, on recorded answers: `cargo test -p kaap-sealed`.
- The local build under plain wasmtime, with recorded answers and a public test key (never
  published): `bash packages/sealed/run-local.sh`. It runs as the worker unless
  `NEAR_USER_ACCOUNT_ID` is set.
- Publish a version: `bash scripts/publish-sealed-testnet.sh fastfs` or
  `bash scripts/publish-sealed-testnet.sh https://<host>/<file>.wasm`. It checks the served sha256
  before registering anything.
- Run on testnet: `bash scripts/run-sealed-testnet.sh <dao> <proposal id> [--runs N] [--corrupt]`.

## What this does not defend against

Both RPC providers lying the same way; a wrong price on 1Click's list, the only source the job has;
anything that changes after the block read (the verdict pins the block, the policy, the kind and
every called contract's code, so a change is visible to whoever re-checks, but no verdict pins the
price list); a kind or policy over kaap-core's 256 KiB limit, which always holds rather than
being judged; what an unknown receiver contract does; a NEAR AI model machine running a build
nobody reviewed (no measurement allowlist, above); whether the model's judgement is right; and
attacks on the TDX hardware, NVIDIA's GPUs or OutLayer's dstack stack, which this program trusts.
