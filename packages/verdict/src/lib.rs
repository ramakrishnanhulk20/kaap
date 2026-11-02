//! kaap-verdict: the part of Kaap the guard and registry contracts are built from. It holds the
//! verdict types, the one canonical form of a kind and a policy, the verdict encoding and the
//! lowest severity of each finding, and nothing of the proposal analysis, so work on the analysis
//! never changes the contracts' wasm. kaap-core depends on this crate and re-exports every item
//! at its old path.

pub mod canonical;
pub mod severity;
pub mod types;
pub mod verdict;

pub use canonical::{canonical_kind, canonical_policy, kind_hash, policy_hash, CanonError};
pub use types::*;
pub use verdict::{verdict_bytes, verdict_hash};
