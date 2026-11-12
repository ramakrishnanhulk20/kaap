# The watcher

Kaap's always-on process. It watches every treasury enrolled in the guard, has the sealed reader judge each new request, hands a vetoable verdict to the guard, records every verdict in the registry, and alerts members on Telegram.

**Status: live since 12 Nov 2026, as one container on Railway, watching the demo treasury.** Its status page is https://watcher-production-2350aa2a.up.railway.app/status. No other treasury is enrolled. In the first recorded proof (`PROOF.md`), made before it was hosted, a script, `scripts/prove.mjs`, made the same calls. `HOSTING.md` says how it is hosted and what to check after each deploy.

## What it does, in order

1. Takes up an enrolled account only when both RPC providers list it, its code is a Sputnik DAO release and its rules give the guard a deciding reject. Anyone can enrol an account, so one that is no treasury is never read or paid for.
2. Reads each watched treasury's request counter about once a second, on two RPC providers. A new request is taken once both show it at a final block, at most 50 new ones a pass.
3. Starts a run of the sealed reader on OutLayer and waits for the signed verdict.
4. Checks the verdict before using it: the key is the guard's accepted key, the signature is valid, and the names and expiry are right.
5. For a vetoable verdict, alerts members at once and sends `veto` to the guard. The veto goes first because it races the approvers.
6. Sends `record` to the registry.
7. Keeps watching open requests, and has one judged again when the treasury's rules or a called contract's code change under it. A treasury whose rule change takes the guard out is let go, and its members are told at once.

It never decides anything itself. The veto rule, the hashes and the verdict's decoding run in `kaap-core`, compiled to wasm (`bridge/`), the same code the guard's checks come from.

## What it holds

- The watcher account's key, in a file only it can read. That account pays for sealed runs, records and vetoes. Its key cannot make the guard do anything a verdict does not allow: the guard checks the sealed signature, not the caller.
- A Telegram bot token.
- A SQLite file: treasuries, judgements, runs, daily spend, subscriptions and alerts.

Daily caps on runs, records and NEAR spent are set in `.env` (see `.env.example` at the repository root).

## HTTP routes

Five, listed with their limits in `ARCHITECTURE.md`, section 6 (b): `GET /status`, `GET /text-key`, `POST /subscribe`, `POST /texts` and `GET /proposal`, which shows what the watcher did with one request of a watched treasury: its verdict summary and its transaction ids.

## As a container

`Dockerfile` builds the watcher from source, from the repository root:

```bash
docker build -f packages/worker/Dockerfile -t kaap-watcher .
```

The image holds no key. It expects the key file on a mounted disk, waits for it, and takes every other setting from the environment. `HOSTING.md` has the steps for Railway, and the two RPC providers to use.

## Tests

Linux or WSL, Node 24, and Rust for the bridge:

```bash
npm ci
npm test -w packages/worker
```

The tests run the watcher against a scripted chain and a scripted OutLayer (`test/helpers.ts`): a veto landing, retries after a send with no outcome, a restart in the middle of a run, provider disagreement, the spend caps and the alert limits.
