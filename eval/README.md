# Evaluation set: the answer key

373 labelled NEAR DAO proposals that Kaap is scored against:

- `real/`: 300 real Sputnik DAO proposals sampled from mainnet (`real/SAMPLING.md` says how). Anyone can fetch each one from the chain by DAO and id.
- `planted/`: 73 proposals written for the test, 56 attacks and 17 honest controls that resemble them. Each one was filed on the real Sputnik 3.2 contract in a local sandbox and accepted (`planted/PLANTED.md`).

Every label follows the labelling guide, `docs/eval/labeling-guide.md` (v2.3): what the proposal would do, the plain-code findings, the risk floor, whether the description agrees, and whether the guard must, may or should veto. `STATS.md` has the counts.

## How it was labelled

- AI labelling passes, following the guide and working from the raw proposal, with no Kaap code: three passes for the real set, one shard each, and one pass for the planted set.
- A blind second AI pass on 45 records (30 real, 15 planted) that never saw the answer key, four of them labelled again once the policy before had been read from the chain (`blind/`).
- Every case the guide did not settle was decided by a ruling written into the guide (section 10), and the labels were redone to match. `RECONCILE.md` records how the labels changed from v1 to v2.3, and why.

## Check it yourself

Node 24 or later, from the repository root. No install, no network, no Kaap code.

`node eval/tools/check.mjs`
- Proves: every label obeys the guide's rules, re-derived from the raw proposal and its context, each problem printed with the record id and the guide section it breaks. It also proves each real record matches its sampled proposal (`real/sample.jsonl`) and each planted record the one that was filed (`planted/planted.jsonl`). Exit 0 only when all 373 pass.
- Does not prove: that the effects listed for a non-policy proposal are complete, or that their amounts and payees match the proposal. Nine findings are not re-derived, only checked for severity and for what they imply: NEW_RECIPIENT, LARGE_AMOUNT, LOOKALIKE_TOKEN, PROMPT_INJECTION, INTENTS_KEY_CHANGE, OTHER_RISKY_KIND, HASH_UNVERIFIED, HASH_TEXT_DANGEROUS and UNKNOWN_CALL. Nor is the choice between `matches`, `vague` and `hidden`. Prices come from the token list of 20 Oct 2026, carried in `tools/lib/prices.json`.
- `--eval <dir>` runs it on a copy of this folder, for example one where you broke a label on purpose.

`node eval/tools/stats.mjs --check`
- Proves: `STATS.md` is byte for byte what the committed labels produce. Without `--check` it writes the file.
- Does not prove: that the labels are right. That is the job of `check.mjs`.

`node eval/tools/compare-blind.mjs`
- Proves: how often the blind second labels agree with the answer key, per field with counts, and which records differ. The numbers are the ones `STATS.md` states.
- Does not prove: that a label is right where the two agree, since two labellers can share a mistake. The blind labels were written under guide v2.1 (v2.2 for the four done again), so a difference can be a rule that changed since.

`kaap eval`, from the CLI in `packages/cli` (`node packages/cli/dist/src/bin.js eval` once it is built), runs Kaap's rules engine over the same 373 records and prints its scoreboards: how often the engine's output equals the labels, field by field. It scores the engine against this key; the three commands above check the key itself.

## Kaap's AI second opinion on this key

`packages/sealed/AI-EVAL.md` reports what Kaap's AI second opinion caught, missed and wrongly flagged on these records when they were run through the sealed job on OutLayer testnet, and how often the AI answered at all. Its rows are in `ai-runs/`: ids, risks, statuses, reason words, token counts, times and transaction ids, never an answer's text.

`node eval/tools/ai-report.mjs --check`
- Proves: `AI-EVAL.md` is byte for byte what the rows in `ai-runs/` and the labels here produce, the split files follow the split rule, and every row's cost matches the listed token price.
- Does not prove: that a row is what OutLayer returned. Each row carries its testnet transaction id, so any one can be looked up on the explorer.

## What cannot be rerun

- The labelling passes themselves. They were AI labellers working from the guide; their output is the label files here, and running them again would not give the same bytes.
- The history of label versions, v1 to v2.3. The scripts that rebuilt each version read working files that are not in this repository. `RECONCILE.md` records that history as a narrative: every change, its cause and the counts before and after. Only the final v2.3 labels can be checked, and the three commands above do that.
