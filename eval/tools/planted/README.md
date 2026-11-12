# Planted set: the generator and the sandbox harness

The 73 planted records in `eval/planted/planted.jsonl` (56 attacks, 17 honest controls) come from
`generate.py` in this folder. The harness in `harness/` files every one of them on the real Sputnik
DAO 3.2 contract in a local sandbox. One command each.

## What you need

- Python 3, standard library only, for the generator.
- For the harness: Linux, or WSL on Windows (the sandbox crate has no Windows build of the node),
  and the Rust toolchain the repo pins in `rust-toolchain.toml` (1.93.0), which rustup picks up
  when you run cargo from the repo root.
- Network access on the first harness run: the `near-sandbox` crate downloads NEAR's sandbox node
  (nearcore 2.13.4, about 94 MB unpacked) into the cargo target folder and reuses it after that.
- The Sputnik DAO 3.2 contract, which is not in git. `bash scripts/fetch-sputnik-wasm.sh` fetches it
  from NEAR mainnet by its code hash and checks its sha256. Without it the harness stops and names
  that script. Anyone can run the script; it needs curl, python3 and sha256sum, and reads only,
  with no key.

## 1. Regenerate the records

Anyone can run it, with Python 3 alone: no network, no key.

```
python3 -I eval/tools/planted/generate.py
```

With no option this is a check. It builds the 73 records and the harness policy in memory, compares
them byte for byte with `eval/planted/planted.jsonl` and `harness/harness_policy.json`, prints the
sha256 of each pair, and exits 0 only when both are identical. It writes nothing. It runs from any
folder.

- `--out FILE` writes the records to FILE, `--policy-out FILE` writes the policy. Each writes only
  that file.
- `--compare-records FILE` and `--compare-policy FILE` point the check at another copy, for
  example one with a byte changed on purpose, to see the check fail.

What it proves: the records come from a script anyone can read, where each record and its label is
written out by hand, and that script reproduces the published file byte for byte. The nonces of the
hash records come from a fixed seed text in the script, so their hashes reproduce too.

## 2. File every record on the real contract

Anyone can run both, with the tools under "What you need". The fetch reads mainnet and signs
nothing; the tests sign only inside the local sandbox, never on a public network.

From the repo root, inside Linux or WSL:

```
bash scripts/fetch-sputnik-wasm.sh
cargo test --manifest-path eval/tools/planted/harness/Cargo.toml -- --nocapture --test-threads=1
```

The crate is a workspace of its own with its own `Cargo.lock`, so it never touches the repo's root
lock file. The first build takes a few minutes; the tests then take about a minute. Two tests:

- `files_every_planted_record` deploys Sputnik DAO 3.2 (code hash
  `DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF`, checked before the deploy) with the harness
  policy, files each record with `add_proposal` and the bond the policy asks for, and reads the
  stored kind back. It must equal the filed kind. Sputnik returns role permissions and group
  members in its own order, so those string arrays are sorted on both sides first.
- `hashes_match_intended_outcome` recomputes the NEP-413 hash of the 7 records that carry a hash
  text. It must match the on-chain `payload_v2` for the three HASH_TEXT_DANGEROUS records and the
  auth control, and must not match for the three HASH_MISMATCH records.

What it proves: the real Sputnik DAO 3.2 contract accepts each record as a proposal under the
harness policy, and each hash-carrying record hashes as intended. The last run is in `RUN.txt`:
2 tests passed, 73 records filed, 56 attacks and 17 controls.

## What neither proves

- That the labels are right. The labels the evaluation scores against are in
  `eval/planted/labels.jsonl`; `node eval/tools/check.mjs` checks them against the labelling guide,
  `docs/eval/labeling-guide.md`. Anyone can run it with Node 24; it reads only, with no network.
- That a live treasury with another policy behaves the same. Every record is filed on a throwaway
  sandbox DAO running `harness/harness_policy.json`, and nothing is voted on or executed.
- That the contracts named inside the planted texts would accept them. The harness files proposals
  on Sputnik only. Seven hash texts write their deadline as `{"timestamp":1790000000}`, a form the
  NEAR Intents verifier would refuse, as `packages/core/docs/answer-key-notes/hash-checker.md`
  section 1 records.
