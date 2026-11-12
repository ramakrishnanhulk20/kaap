# kaap, the command line

Checks any Sputnik DAO request with no keys, verifies Kaap's verdicts down to the sealed run that signed them, drafts a treasury's enrolment, and reruns Kaap's evaluation and DAO census. It holds no NEAR key and sends no transaction.

Every rule it applies runs in `kaap-core`, compiled to WebAssembly, so this tool and the sealed reader decide one request the same way. Nothing is ported to TypeScript.

## Run it

Node 24 or newer, from the repository root:

```bash
npm ci -w packages/cli
npm run build:ts -w packages/cli
node packages/cli/dist/src/bin.js help
```

The engine in `wasm/` is committed, so this needs no Rust. `npm run build -w packages/cli` compiles the engine first and needs Rust and `wasm-bindgen-cli` 0.2.129.

## Commands

| Command | What it does |
|---|---|
| `check <dao> [id]` | Reads one request at one final block from two RPC providers and prints its effects, findings, risk floor and whether the guard must veto it. `--json` prints the full report |
| `verify <dao> <id>` | Checks the verdict in Kaap's registry for a request: the contracts' code and keys, the sealed signature, every hash recomputed, the sealed run on chain and OutLayer's attestation of it |
| `enroll <dao>` | Prints the two requests a member files to put a treasury under the guard, and Kaap's own reading of each. Signs nothing |
| `arming <dao>` | Says whether the guard is armed on the treasury's live rules, and any right it holds beyond rejecting |
| `seal-text` | Encrypts the words behind a hash-only request so only the sealed reader can open them, and sends them to Kaap's watcher |
| `subscribe <dao>` | Asks the watcher for a one-time Telegram token for a treasury's alerts |
| `eval` | Runs the engine over the public labelled set in `eval/` and prints the agreement tables. No network |
| `census [--sample N]` | Reruns the DAO census from mainnet, at most five requests a second |

An account ending in `.testnet` is read on testnet and any other on mainnet, unless `--network` says otherwise.

## Tests

```bash
npm test -w packages/cli
```

The tests replay recorded answers from mainnet and testnet (`test/fixtures`), so they need no network. `test/hostile.ts` holds text a dishonest node could send to attack the reader's terminal: escape sequences, control characters and lines that imitate Kaap's own. The tests check that every command prints it inert.

## Limits it works under

`src/caps.ts` holds every limit in one place: answer sizes, timeouts, retries and the request rate. A limit that is reached is a clear refusal or an "unknown", never a silent cut.
