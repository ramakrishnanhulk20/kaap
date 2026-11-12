# kaap-core, the rules engine

The plain code that decides what a Sputnik DAO request means. It takes a request, the treasury's rules and, when there is one, the text behind a signed hash, and returns the request's real effects, a list of findings and a risk floor. No network, no clock, no AI.

It compiles three ways from this one source: into the sealed reader on OutLayer (`packages/sealed`), to WebAssembly for the command line and the site (`packages/core-wasm`), and to WebAssembly for the watcher (`packages/worker/bridge`). So every part of Kaap that judges a request runs the same rules.

## Modules

| Module | What it does |
|---|---|
| `decode/` | Turns a request into effects: transfers, contract calls, token moves, calls on `intents.near` |
| `policy/` | Rule changes. `sputnik.rs` is a port of Sputnik DAO's own rules for who may act and how votes are counted; `arming.rs` says whether a guard role can reject every kind |
| `hash/` | Requests that ask the treasury to sign a hash. Recomputes NEP-413 and NEP-461 hashes from a supplied text, reads the intents inside, and checks 1Click quotes |
| `describe/` | Compares the description with the effects: what it claims, what agrees, what contradicts |
| `floor.rs` | The risk floor, and whether the guard must veto |
| `history.rs`, `prices.rs` | Past payments and token prices, as inputs to "new recipient" and "large amount" |

The specification is the labelling guide, `docs/eval/labeling-guide.md`. Fixed severities live in `packages/verdict/src/severity.rs`, which the guard contract shares.

## Tests

```bash
cargo test -p kaap-core
```

Besides unit and property tests, five suites score the engine against the public labelled set in `eval/` and fail if agreement drops: `eval`, `value_eval`, `policy_eval`, `describe_eval` and `hash_eval`. Where the engine and a label disagree on purpose, the record is named in `docs/answer-key-notes/`.

`packages/core-diff` runs the port in `policy/sputnik.rs` and the real Sputnik DAO 3.2 binary on the same inputs in a sandbox and fails on any disagreement.
