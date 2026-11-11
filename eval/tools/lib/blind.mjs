import { readJsonl } from "./files.mjs";

/**
 * The blind second labels, one per blind record. The second labeller labelled 45 records on
 * 20 Oct 2026 (`blind/second-labels.jsonl`) and four of them again on 26 Oct 2026 with the policy
 * before read from the chain (`blind/second-labels-e12.jsonl`); the later label counts for those
 * four. Stops if the later file names a record that is not one of the 45, or names one twice.
 */
export function secondLabels(evalDir) {
  const first = readJsonl(evalDir, "blind/second-labels.jsonl");
  const later = readJsonl(evalDir, "blind/second-labels-e12.jsonl");
  const byId = new Map();
  for (const b of later) {
    if (byId.has(b.id)) throw new Error(`${b.id} is listed twice in blind/second-labels-e12.jsonl`);
    if (!first.some((x) => x.id === b.id)) throw new Error(`${b.id} is not one of the blind records`);
    byId.set(b.id, b);
  }
  if (new Set(first.map((b) => b.id)).size !== first.length) throw new Error("blind/second-labels.jsonl lists a record twice");
  return { records: first.map((b) => byId.get(b.id) || b), relabelled: later.map((b) => b.id) };
}

/** The answer key for the blind comparison: real plus planted, by id. */
export function answerKey(evalDir) {
  const key = new Map();
  for (const r of [...readJsonl(evalDir, "real/labels.jsonl"), ...readJsonl(evalDir, "planted/labels.jsonl")]) key.set(r.id, r);
  return key;
}
