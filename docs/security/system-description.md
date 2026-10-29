# Kaap: system description (functional)

Written 20 Oct 2026 as input to the threat model pass. It says what the system does, not how it is defended.

## Purpose
For a NEAR Sputnik DAO that opts in, Kaap reads each new proposal as it lands, works out what executing it would do, writes a verdict with a risk level, publishes the verdict, tells the members, and, for DAOs that have added Kaap to a "Guard" role, casts a reject vote when the verdict is critical. Anyone can also paste any DAO or proposal to get a verdict without opting in.

## Actors
- DAO members: proposers (may file proposals) and approvers (may vote), using their own NEAR wallets.
- DAO admins: enrol the DAO and file the proposals that add Kaap's account to a Guard role.
- The public and hackathon judges: read verdicts, run the proof commands.
- The Kaap operator: deploys the contracts and services, holds the service keys.

## Components
1. **Watcher.** Follows NEAR blocks (mainnet and testnet) through a public block-streaming service or by polling RPC, and picks up `add_proposal` calls to enrolled DAOs. For each new proposal it reads `get_proposal(id)`, `get_policy()`, and the DAO's earlier proposals through `get_proposals(from_index, limit)`.
2. **Decoder.** Deterministic code that turns a proposal into a list of effects.
   - Transfer: token, amount, receiver.
   - FunctionCall: for each action, the receiver, method, arguments decoded from base64 to JSON, attached deposit and gas. Known methods are mapped to effects: NEP-141 `ft_transfer` and `ft_transfer_call` (including a `msg` to `intents.near` that carries intents or a withdrawal to another chain), NEP-245 `mt_transfer`, wrapping, staking pool calls, lending and exchange calls, and `v1.signer` `sign` with a `payload_v2` hash.
   - Policy and membership kinds: the difference between the current policy and the policy after execution (roles, members, permissions, thresholds).
   - Context facts: USD value from the 1Click token price list, whether the DAO has paid this receiver before, how the amount compares with the DAO's history.
3. **Hash checker.** For a `v1.signer` `sign` proposal, accepts the message text, the 32-byte nonce and the recipient behind the hash, sent by the proposer's client or by a member. It recomputes the NEP-413 hash, compares it with `payload_v2`, parses the intents inside the message (transfer, token_diff, add_public_key, withdrawals and the rest), checks `signer_id` and the deadline, and for a transfer to a 1Click deposit address checks the 1Click quote signature that maps that address to the final payee and amount. The submitted text is stored so that members can read the full explanation; the public sees only the result and the risk level.
4. **Judge.** Sends the effect list, the proposal description and a summary of the DAO's history to an AI model on NEAR AI Cloud (a model that runs inside NEAR AI's sealed hardware) through its OpenAI-compatible API. It asks whether the description matches the effects, what is unusual, a risk level (low, medium, high, critical) and a plain-English explanation. It then fetches the response signature (`GET /v1/signature/{chat_id}`) and the attestation report for that model.
5. **Verdict publisher.** Writes each verdict to a Kaap registry contract on NEAR: DAO, proposal id, a hash of the decoded effects, the risk level, the explanation or its hash, the AI response signature and a reference to the attestation.
6. **Guard.** For DAOs that added Kaap's account to a Guard role (permission VoteReject on every proposal kind except `remove_member_from_role`, threshold one), the guard account calls `act_proposal {id, action: "VoteReject", proposal: <kind>}` when a verdict is critical. The guard account's key is a function call key for that DAO contract and the `act_proposal` method only.
7. **Notifier.** Sends members the verdict and a link by Telegram bot and by email.
8. **Web app.**
   - Public pages: a DAO overview, its proposals with verdicts, and a "verify this verdict" button that checks the AI signature and the attestation (in the browser, or through a server proxy for the Intel and NVIDIA lookups).
   - A paste box that checks any DAO or proposal without enrolling.
   - An enrolment flow that drafts the Sputnik proposals that add the Guard role, which members sign with their own wallet.
   - A member view that shows the full explanation of a checked hash, after the member signs a NEP-413 login message that proves membership.
9. **Proof commands.** A CLI that scans every Sputnik DAO on mainnet read-only and reproduces the published numbers, and a CLI that runs a labelled test set of real and planted proposals through the decoder and the judge and prints catches, misses and false alarms.
10. **Data stores.** Verdicts on chain. An off-chain database for enrolled DAOs, notification subscriptions (Telegram chat ids, email addresses), submitted hash texts, cached DAO history, and payment records.
11. **Payments.** DAOs pay a monthly fee through NEAR Intents (a 1Click deposit to Kaap's account in any token), or per review as a job on NEAR's Agent Market.

## External calls
NEAR RPC (FastNEAR, drpc), a block-streaming service, NEAR AI Cloud (API key), Intel Trust Authority and NVIDIA NRAS (attestation checks), the 1Click API (token prices, quote signature check, partner key), the Trezu public API (proposal metadata), the Telegram Bot API, an email provider, the Agent Market API.

## On-chain reads and writes
- Reads: any DAO's proposals and policy, token metadata, account states, `v1.signer` views.
- Writes: verdicts to the Kaap registry contract; `act_proposal` VoteReject on enrolled DAOs; enrolment proposals filed by DAO members through their own wallets.

## Where the work runs (three candidate designs, chosen at the architecture gate)
- Design A: the watcher, decoder, hash checker, judge client, publisher and guard key run on an ordinary server we operate.
- Design B: the decoder, hash checker and verdict logic run as WebAssembly inside OutLayer's sealed hardware (Intel TDX), whose proof covers the code hash, the input and the output, and the guard key is held inside OutLayer.
- Design C: the guard is a NEAR smart contract account in the Guard role. It casts VoteReject only when handed a verdict signed by a key it has been told to accept, and it checks that signature on chain.
