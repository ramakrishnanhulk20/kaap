# kaap-verdict

The verdict types, the canonical kind and policy hashes, the signed verdict encoding and the fixed severity of each finding: everything the guard and registry contracts compile in, and nothing else.
It is its own crate so that work on Kaap's proposal analysis in `kaap-core` can never change the contracts' wasm, and a judge or auditor who rebuilds the contracts gets the deployed bytes.
`kaap-core` depends on it and re-exports every item at its old path, so code that reads `kaap_core::Verdict` still works.
