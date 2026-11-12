# The watcher

Kaap's always-on process. It watches every treasury enrolled in the guard, has the sealed reader judge each new request, hands a vetoable verdict to the guard, records every verdict in the registry, and alerts members on Telegram.

**Status: built and tested, not hosted.** No treasury is being watched around the clock today. In the recorded proof (`PROOF.md`) a script, `scripts/prove.mjs`, made the same calls. `HOSTING.md` is the hosting plan.

## What it does, in order

1. Reads each enrolled treasury's request counter about once a second, on two RPC providers. A new request is taken once both show it at a final block.
2. Starts a run of the sealed reader on OutLayer and waits for the signed verdict.
3. Checks the verdict before using it: the key is the guard's accepted key, the signature is valid, and the names and expiry are right.
4. For a vetoable verdict, alerts members at once and sends `veto` to the guard. The veto goes first because it races the approvers.
5. Sends `record` to the registry.
6. Keeps watching open requests, and has one judged again when the treasury's rules or a called contract's code change under it.

It never decides anything itself. The veto rule, the hashes and the verdict's decoding run in `kaap-core`, compiled to wasm (`bridge/`), the same code the guard's checks come from.

## What it holds

- The watcher account's key, in a file only it can read. That account pays for sealed runs, records and vetoes. Its key cannot make the guard do anything a verdict does not allow: the guard checks the sealed signature, not the caller.
- A Telegram bot token.
- A SQLite file: treasuries, judgements, runs, daily spend, subscriptions and alerts.

Daily caps on runs, records and NEAR spent are set in `.env` (see `.env.example` at the repository root).

## HTTP routes

Four, listed with their limits in `ARCHITECTURE.md`, section 6 (b): `GET /status`, `GET /text-key`, `POST /subscribe` and `POST /texts`.

## Tests

Linux or WSL, Node 24, and Rust for the bridge:

```bash
npm ci
npm test -w packages/worker
```

The tests run the watcher against a scripted chain and a scripted OutLayer (`test/helpers.ts`): a veto landing, retries after a send with no outcome, a restart in the middle of a run, provider disagreement, the spend caps and the alert limits.
