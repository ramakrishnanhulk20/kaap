// Writes eval/STATS.md from the committed labels (eval/real/labels.jsonl, eval/planted/labels.jsonl)
// and the blind second labels (eval/blind/). Every count in that file comes from here, and the same
// labels always give the same bytes, so the file can be checked rather than trusted.
//
// Usage: node eval/tools/stats.mjs            write eval/STATS.md
//        node eval/tools/stats.mjs --check    exit 0 only when eval/STATS.md is exactly what it would write
//        add --eval <dir> to read and write a copy of the eval/ folder instead
//
// What it does not prove: that the labels are right. That is check.mjs's job, against the guide.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, readJsonl } from "./lib/files.mjs";
import { secondLabels } from "./lib/blind.mjs";
import { POLICY_KINDS, kindOf, policyAfter } from "./lib/policy.mjs";

const { evalDir, flags } = parseArgs(process.argv.slice(2), ["--check"]);
const FLOORS = ["critical", "high", "medium", "low"];
const CHECKS = ["matches", "contradicts", "vague", "empty", "hidden"];
const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const short = (id) => id.replace(/^mainnet:/, "").replace(".sputnik-dao.near:", " #");
const count = (recs, f) => recs.filter(f).length;

// The known gap: a policy change gives the Everyone role new AddProposal rights and no section 4
// code fires. Returns the rights gained, or null.
function everyoneGap(r) {
  const kind = kindOf(r.kind);
  if (!POLICY_KINDS.includes(kind) || !r.context.policy_before || r.label.findings.length) return null;
  const before = r.context.policy_before, after = policyAfter(kind, r.kind[kind], before);
  const gained = [];
  for (const ra of after.roles.filter((x) => x.kind === "Everyone")) {
    const had = new Set(before.roles.filter((x) => x.name === ra.name && x.kind === "Everyone").flatMap((x) => x.permissions || []));
    for (const p of ra.permissions || []) if (/:AddProposal$/.test(p) && !had.has(p)) gained.push(p);
  }
  return gained.length ? gained : null;
}

function tables(recs) {
  const out = ["### Risk floor", "", "| floor | records |", "|---|---|"];
  for (const f of FLOORS) out.push(`| ${f} | ${count(recs, (r) => r.label.risk_floor === f)} |`);
  out.push("", "### Finding codes", "", "| code | severity | records |", "|---|---|---|");
  const codes = new Map();
  for (const r of recs) for (const f of r.label.findings) codes.set(`${f.code}|${f.severity}`, (codes.get(`${f.code}|${f.severity}`) || 0) + 1);
  for (const k of [...codes.keys()].sort()) { const [c, s] = k.split("|"); out.push(`| ${c} | ${s} | ${codes.get(k)} |`); }
  out.push("", "### Description check", "", "| description_check | records |", "|---|---|");
  for (const c of CHECKS) out.push(`| ${c} | ${count(recs, (r) => r.label.description_check === c)} |`);
  out.push("", "### Veto fields", "", "| field | true | false |", "|---|---|---|");
  for (const f of ["must_veto", "veto_allowed", "should_veto"]) out.push(`| ${f} | ${count(recs, (r) => r.label[f])} | ${count(recs, (r) => !r.label[f])} |`);
  return out;
}

function catchSplit(recs) {
  const should = recs.filter((r) => r.label.should_veto);
  return {
    should,
    plain: should.filter((r) => r.label.must_veto),
    ai: should.filter((r) => !r.label.must_veto && r.label.veto_allowed),
    gap: should.filter((r) => !r.label.veto_allowed),
    forcedFalse: recs.filter((r) => !r.label.should_veto && r.label.must_veto),
    allowedFalse: recs.filter((r) => !r.label.should_veto && r.label.veto_allowed),
  };
}
const ids = (a) => (a.length ? a.map((r) => r.id).join(", ") : "none");
const criticalCodes = (r) => r.label.findings.filter((f) => f.severity === "critical").map((f) => f.code).join(", ");

function realCatch(recs) {
  const s = catchSplit(recs);
  const out = ["", "### What the guard can catch", "",
    `Of the ${s.should.length} real record${s.should.length === 1 ? "" : "s"} with should_veto true, ${s.plain.length} can be caught by plain code alone (must_veto true: the floor is critical, so the guard vetoes whatever the AI says), ${s.ai.length} need the AI (a veto is allowed but only an AI verdict of critical triggers it), and ${s.gap.length} are known gaps (should_veto true, veto not allowed). For real proposals should_veto equals must_veto (decided 20 Oct 2026), so every one is a plain-code catch by construction, and on these records the AI is scored on false alarms: ${s.allowedFalse.length} records allow a veto with should_veto false.`,
    "", "| record | status | critical findings |", "|---|---|---|"];
  for (const r of s.should) out.push(`| ${r.id} | ${r.status} | ${criticalCodes(r)} |`);
  return out;
}

function plantedCatch(recs) {
  const s = catchSplit(recs);
  const row = (r) => `| ${r.id} | ${r.attack} |`;
  return ["", "### What the guard can catch", "",
    `Of the ${s.should.length} planted records with should_veto true, ${s.plain.length} can be caught by plain code alone (must_veto true), ${s.ai.length} need the AI (veto allowed, not forced: only an AI verdict of critical triggers it), and ${s.gap.length} are known gaps (should_veto true and veto_allowed false).`,
    "",
    `Records with should_veto false and must_veto true: ${ids(s.forcedFalse)}. The floor is critical, but the attack is filed as remove_member_from_role, which the Guard role can never reject by design, so no veto can happen; scored by section 6, a veto here would count as a false alarm. Records with should_veto false that still allow a veto: ${ids(s.allowedFalse)}.`,
    "", "#### Caught by plain code alone (must_veto true and should_veto true)", "", "| id | attack |", "|---|---|", ...s.plain.map(row),
    "", "#### Need the AI (should_veto true, must_veto false, veto_allowed true)", "", "| id | attack |", "|---|---|", ...s.ai.map(row),
    "", "#### Known gaps (should_veto true and veto_allowed false)", "", "| id | attack |", "|---|---|", ...(s.gap.length ? s.gap.map(row) : ["| none | |"])];
}

function gapSection(all) {
  const hits = all.map((r) => [r, everyoneGap(r)]).filter(([, g]) => g);
  const out = ["", "## Known gap: opening AddProposal to Everyone has no plain-code finding", "",
    "When a policy change gives the Everyone role the right to file proposals, no section 4 code fires: no member is added to a role that can approve, no threshold is lowered and the Guard role is untouched. The floor is low and the veto fields are false, so only the AI can raise it. Records with this pattern and no finding:", "",
    "| record | set | status | AddProposal rights gained by Everyone |", "|---|---|---|---|"];
  for (const [r, g] of hits) out.push(`| ${r.id} | ${r.source} | ${r.status ?? "-"} | ${g.join(", ")} |`);
  if (!hits.length) out.push("| none | | | |");
  return out;
}

// Agreement between the answer key and the blind second labels, on the fields eval/STATS.md states.
function blindAgreement(key) {
  const { records: blind, relabelled } = secondLabels(evalDir);
  const keyOf = (b) => { const k = key.get(b.id); if (!k) throw new Error(`blind record ${b.id} is not in the answer key`); return k.label; };
  const agree = (f) => count(blind, (b) => keyOf(b)[f] === b.label[f]);
  const codes = count(blind, (b) => { const k = new Set(keyOf(b).findings.map((x) => x.code)), l = new Set(b.label.findings.map((x) => x.code)); return k.size === l.size && [...k].every((c) => l.has(c)); });
  return { n: blind.length, real: count(blind, (b) => b.source === "real"), planted: count(blind, (b) => b.source === "planted"), floor: agree("risk_floor"), must: agree("must_veto"), allowed: agree("veto_allowed"), check: agree("description_check"), codes, relabelled };
}

function render() {
  const real = readJsonl(evalDir, "real/labels.jsonl"), planted = readJsonl(evalDir, "planted/labels.jsonl");
  for (const r of [...real, ...planted]) if (r.guide_version !== "v2.3") throw new Error(`${r.id} is not labelled under guide v2.3`);
  const b = blindAgreement(new Map([...real, ...planted].map((r) => [r.id, r])));
  const again = WORDS[b.relabelled.length] ?? String(b.relabelled.length);
  const attacks = count(planted, (r) => !/^control:/.test(r.attack));
  return ["# Evaluation set v2.3: statistics", "",
    "Generated by `node eval/tools/stats.mjs` from `eval/real/labels.jsonl` and `eval/planted/labels.jsonl`; every count below is its output. Labelling guide v2.3 (`docs/eval/labeling-guide.md`); every record carries guide_version v2.3.",
    "", "## How the labels were made", "",
    `The labels are AI-made. Each one was written by an AI labeller from the guide and the raw proposal, without any Kaap code, and a separate checker script, also free of Kaap code, re-derives every rule from the raw kind and context. They were cross-checked blind: a second AI labeller that never saw the answer key labelled ${b.n} records (${b.real} real, ${b.planted} planted) on its own, and labelled ${again} of them again on 26 Oct 2026 (${b.relabelled.map(short).join(", ")}) with the policy before read from the chain. Against the v2.3 answer key the two agree on the risk floor for ${b.floor} of ${b.n}, must_veto ${b.must} of ${b.n}, veto_allowed ${b.allowed} of ${b.n}, the description check ${b.check} of ${b.n} and the exact finding codes ${b.codes} of ${b.n}. A comparison script listed every record that differs.`,
    "", `## Real (${real.length} records)`, "", ...tables(real), ...realCatch(real),
    "", `## Planted: ${attacks} attacks and ${planted.length - attacks} controls (${planted.length} records)`, "", ...tables(planted), ...plantedCatch(planted),
    ...gapSection([...real, ...planted]), ""].join("\n");
}

const target = path.join(evalDir, "STATS.md");
const text = render();
if (flags.has("--check")) {
  const onDisk = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
  if (onDisk === text) {
    console.log(`${path.relative(process.cwd(), target) || target} is exactly what the labels produce (${text.split("\n").length - 1} lines)`);
  } else {
    const a = (onDisk ?? "").split("\n"), w = text.split("\n");
    let i = 0;
    while (i < Math.max(a.length, w.length) && a[i] === w[i]) i++;
    console.log(onDisk === null ? `${target} does not exist` : `${target} differs from what the labels produce, first at line ${i + 1}`);
    if (onDisk !== null) console.log(`  on disk: ${(a[i] ?? "(end of file)").slice(0, 160)}\n  expected: ${(w[i] ?? "(end of file)").slice(0, 160)}`);
    console.log("  run node eval/tools/stats.mjs to write it");
    process.exitCode = 1;
  }
} else {
  fs.writeFileSync(target, text);
  console.log(`wrote ${target}`);
}
