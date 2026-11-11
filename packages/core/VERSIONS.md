# kaap-core dependency versions

Checked on 29 Oct 2026 (04:02 UTC) against the crates.io API (`max_stable_version` for each crate). Every version below is the latest stable release that day, pinned exactly with `=` once, in `[workspace.dependencies]` of the root `Cargo.toml`, and inherited by `packages/core/Cargo.toml`. The toolchain is Rust 1.93.0 (`rust-toolchain.toml`), the one the first sandbox contracts built with, so each crate's declared minimum Rust version was checked against it.

| Crate | Pinned | Published | Minimum Rust | Why we use it |
|---|---|---|---|---|
| borsh | 1.8.1 | 2026-08-26 | 1.77.0 | the verdict encoding (C14); the same crate near-sdk uses on chain |
| serde | 1.0.229 | 2026-07-18 | 1.56 | derives for the guide's JSON shapes |
| serde_json | 1.0.154 | 2026-10-11 | 1.71 | parsing kind and policy JSON |
| sha2 | 0.11.1 | 2026-10-12 | 1.88 | kind, policy and verdict hashes |
| bs58 | 0.5.1 | 2024-03-19 | not declared | code hashes as NEAR writes them |
| base64 | 0.23.1 | 2026-08-04 | 1.71.0 | FunctionCall `args` |
| num-bigint | 0.5.1 | 2026-07-05 | 1.60 | amounts in whole base units |

num-bigint was chosen over uint (0.10.2, 2026-10-02): amounts are attacker-written decimal strings, and an arbitrary-precision integer cannot overflow on one, while uint's fixed 256-bit types can. crates.io lists num-bigint 0.4.8 as the most recently published version; it is a backport to the older line, and 0.5.1 is the newest stable.

The first sandbox tests pinned sha2 0.10.9 and base64 0.22.1 because near-api resolves those; that is a separate test crate and does not bind kaap-core.
