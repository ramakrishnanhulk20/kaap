// Prints how far the blind second labels (eval/blind/) agree with the answer key, field by field,
// and lists every blind record where the two differ. The second labeller never saw the answer key.
//
// Usage: node eval/tools/compare-blind.mjs [--eval <dir>]
//
// What it does not prove: that either label is right where they agree. Two labellers can share a
// mistake; agreement only bounds how often a single labeller's reading of the guide is the odd one out.
// The second labels were written under earlier guide versions (v2.1, and v2.2 for the four done
// again), so a difference can be a rule that changed since, not a slip.
import { parseArgs } from "./lib/files.mjs";
import { answerKey, secondLabels } from "./lib/blind.mjs";

const { evalDir } = parseArgs(process.argv.slice(2));
const key = answerKey(evalDir);
const { records: blind, relabelled } = secondLabels(evalDir);
const short = (id) => id.replace(/^mainnet:/, "").replace(".sputnik-dao.near:", " #");

const FIELDS = ["risk_floor", "must_veto", "veto_allowed", "description_check"];
const tally = Object.fromEntries([...FIELDS, "finding codes, exact set", "should_veto, planted only"].map((f) => [f, { agree: 0, of: 0 }]));
const rows = [];
let overlap = 0;
for (const b of blind) {
  const k = key.get(b.id);
  if (!k) throw new Error(`blind record ${b.id} is not in the answer key`);
  const K = k.label, B = b.label;
  for (const f of FIELDS) { tally[f].of++; if (K[f] === B[f]) tally[f].agree++; }
  const kc = new Set(K.findings.map((x) => x.code)), bc = new Set(B.findings.map((x) => x.code));
  const both = [...kc].filter((c) => bc.has(c)).length, either = new Set([...kc, ...bc]).size;
  overlap += either ? both / either : 1;
  tally["finding codes, exact set"].of++; if (both === either) tally["finding codes, exact set"].agree++;
  if (b.source === "planted") { tally["should_veto, planted only"].of++; if (K.should_veto === B.should_veto) tally["should_veto, planted only"].agree++; }
  const onlyKey = [...kc].filter((c) => !bc.has(c)), onlyBlind = [...bc].filter((c) => !kc.has(c));
  if (FIELDS.some((f) => K[f] !== B[f]) || onlyKey.length || onlyBlind.length) {
    rows.push(`  ${b.id}: floor ${K.risk_floor}/${B.risk_floor}, must_veto ${K.must_veto}/${B.must_veto}, veto_allowed ${K.veto_allowed}/${B.veto_allowed}, description ${K.description_check}/${B.description_check}, codes only in the key: ${onlyKey.join(", ") || "none"}, only in the blind label: ${onlyBlind.join(", ") || "none"}`);
  }
}

const real = blind.filter((b) => b.source === "real").length;
console.log(`blind records: ${blind.length} (${real} real, ${blind.length - real} planted)`);
console.log(`second labels: ${blind.length - relabelled.length} from eval/blind/second-labels.jsonl (20 Oct 2026), ${relabelled.length} from eval/blind/second-labels-e12.jsonl (26 Oct 2026, policy before read from the chain): ${relabelled.map(short).join(", ")}`);
console.log("agreement with the v2.3 answer key:");
const width = Math.max(...Object.keys(tally).map((f) => f.length));
for (const [f, { agree, of }] of Object.entries(tally)) console.log(`  ${f.padEnd(width)}  ${agree} of ${of} (${Math.round((100 * agree) / of)}%)`);
console.log(`  ${"mean finding-code overlap".padEnd(width)}  ${(overlap / blind.length).toFixed(2)} (shared codes over all codes, per record)`);
console.log(`records that differ on any field above: ${rows.length} of ${blind.length} (each line reads key/blind)`);
if (rows.length) console.log(rows.join("\n"));
