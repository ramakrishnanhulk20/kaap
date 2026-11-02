//! Holds no code. The crate exists for its test, `tests/sputnik_diff.rs`, which runs kaap-core's
//! port of Sputnik's permission and threshold rules side by side with the real Sputnik DAO 3.2
//! binary in a local sandbox. It is a separate crate so kaap-core itself never depends on the
//! sandbox stack, and keeps building for wasm.
