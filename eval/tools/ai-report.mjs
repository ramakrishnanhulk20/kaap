// Writes packages/sealed/AI-EVAL.md from the AI evaluation's rows and journals in eval/ai-runs/ and
// the labels (eval/real/labels.jsonl, eval/planted/labels.jsonl). Every count, rate, time and cost in
// that file comes from here, and the same rows always give the same bytes, so the file can be checked
// rather than trusted.
//
// Usage: node eval/tools/ai-report.mjs                        write packages/sealed/AI-EVAL.md
//        node eval/tools/ai-report.mjs --check                exit 0 only when the file is exactly what it would write
//        node eval/tools/ai-report.mjs --check --file <path>  the same check on another copy of the file
//
// It refuses rows it cannot vouch for: split files that do not follow the split rule, a row outside
// its split or repeated, a field a public row may not hold (an answer's text never is one), a model
// other than the priced one, a thinking budget other than its pass's, a cost the listed token price
// does not give, or a stop in stops.jsonl that its pass's rows do not bear out. Node 24 or later, no
// install, no network.
//
// What it does not prove: that a row is what OutLayer returned. Every row carries its testnet
// transaction id, so any one of them can be looked up on the explorer. The few facts below that are
// not in any row (the build, the price source, two readings of NEAR AI's status page) are named
// constants, each with where it was read.
import fs from "node:fs";
import path from "node:path";
import { EVAL_DIR, readJsonl } from "./lib/files.mjs";

const RUNS = "ai-runs";
const TARGET = path.join(EVAL_DIR, "..", "packages", "sealed", "AI-EVAL.md");
// What every run printed as it started: the active build of the sealed job on OutLayer testnet,
// and NEAR AI's catalog price for the pinned model, in nano-USD per token.
const BUILD = "d8453d6e674d15b1c8acd7796e4219f9388e5704cd8996b7f6642370574e9083";
const PROJECT = "kaap-worker-1029053612.testnet/kaap-sealed";
const MODEL = "z-ai/glm-5.3-flash";
const PRICE = { input: 80n, output: 500n };
const PRICE_SOURCE = "https://cloud-api.near.ai/v1/model/list";
// scripts/ai-eval.mjs counts an answer with no token counts at its worst case: 12,000 prompt tokens
// and the whole max_tokens, the budget plus 400 answer tokens.
const WORST = { prompt: 12_000n, answer: 400n };
// Read by hand from https://status.near.ai on 11 Nov 2026, before the first run and when the test
// pass stopped: both times its Chat API showed "Major outage".
const STATUS_READS = ["11:59", "14:28"];
const BUDGETS = [256, 512, 1024];
// The budget judge mode ships with (packages/sealed/src/ai.rs THINKING_TOKEN_BUDGET).
const SHIPPED = 512;
const SEVERITY = ["low", "medium", "high", "critical"];
// A record whose AI part failed because a service did not answer, or whose answer could not be
// checked because a fetch failed. Everything else that is not a usable answer is the answer itself.
const PLATFORM_WORDS = ["call_failed", "deadline", "response_unreadable", "catalog_unreadable", "gateway_unavailable", "report_unavailable", "collateral_unavailable", "gpu_unavailable", "signature_unavailable", "no_clock"];
const PLATFORM_STATUS = ["run_failed", "tx_failed", "unreadable_output"];
const ROW_KEYS = new Set(["id", "input_bytes", "prices_trimmed", "thinking_budget", "answer_cleaned", "tx", "near_yocto", "wall_ms", "worker_ms", "status", "ai_reason", "ai_risk", "ai_status", "completion_tokens", "explanation_sha256", "findings", "finish_reason", "floor", "model_id", "prompt_tokens", "reasoning_tokens", "risk", "usd_nano", "at", "reason", "try"]);
// What the label says should happen, in the order the headline table shows it.
const GROUPS = [
  ["plain", "Should be vetoed, plain code alone vetoes"],
  ["need", "Should be vetoed, only the AI could justify it"],
  ["gap", "Should be vetoed, no veto allowed (known gap)"],
  ["exposure", "Should not be vetoed, a veto is allowed"],
  ["quiet", "Should not be vetoed, no veto allowed"],
];

const args = process.argv.slice(2);
let check = false;
let target = TARGET;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--check") check = true;
  else if (args[i] === "--file" && i + 1 < args.length) target = path.resolve(args[++i]);
  else throw new Error(`unknown argument ${args[i]}; usage: [--check [--file <path>]]`);
}
if (target !== TARGET && !check) throw new Error("--file only goes with --check; the report is only ever written to packages/sealed/AI-EVAL.md");

const exists = (rel) => fs.existsSync(path.join(EVAL_DIR, rel));
const rowsOf = (rel) => (exists(rel) ? readJsonl(EVAL_DIR, rel) : []);
const idsOf = (rel) => fs.readFileSync(path.join(EVAL_DIR, rel), "utf8").split("\n").map((l) => l.trim()).filter(Boolean);

/** The split rule, fixed on 11 Nov 2026 before any full run: lines 1, 6, 11, ... of each file. */
function splitByRule() {
  const dev = [], test = [];
  for (const rel of ["real/sample.jsonl", "planted/planted.jsonl"]) readJsonl(EVAL_DIR, rel).forEach((r, i) => (i % 5 === 0 ? dev : test).push(r.id));
  for (const [name, want] of [["split-development.txt", dev], ["split-test.txt", test]]) {
    const have = idsOf(`${RUNS}/${name}`);
    if (have.join("\n") !== want.join("\n")) throw new Error(`${RUNS}/${name} does not follow the split rule`);
  }
  return { dev, test };
}

function checkRows(rel, rows, split, budget) {
  const inSplit = new Set(split);
  const seen = new Set();
  for (const r of rows) {
    const extra = Object.keys(r).filter((k) => !ROW_KEYS.has(k));
    if (extra.length) throw new Error(`${rel}: ${r.id} holds ${extra.join(", ")}, which a public row may not`);
    if (!inSplit.has(r.id)) throw new Error(`${rel}: ${r.id} is not in its split`);
    if (seen.has(r.id) && !rel.endsWith(".retried.jsonl")) throw new Error(`${rel}: ${r.id} appears twice`);
    seen.add(r.id);
    if (r.status !== "eval") continue;
    if (r.thinking_budget !== budget) throw new Error(`${rel}: ${r.id} ran at budget ${r.thinking_budget}, not ${budget}`);
    if (r.model_id !== null && r.model_id !== MODEL) throw new Error(`${rel}: ${r.id} was answered by ${r.model_id}`);
    if ((r.ai_risk !== null) !== (r.ai_status !== "unavailable")) throw new Error(`${rel}: ${r.id} has ai_status ${r.ai_status} with ai_risk ${r.ai_risk}`);
    const counted = r.prompt_tokens !== null && r.completion_tokens !== null;
    const usd = counted ? (BigInt(r.prompt_tokens) * PRICE.input + BigInt(r.completion_tokens) * PRICE.output).toString() : null;
    if (r.usd_nano !== usd) throw new Error(`${rel}: ${r.id} costs ${r.usd_nano} nano-USD, but its tokens at the listed price give ${usd}`);
  }
}

/** A stop in stops.jsonl must be what the pass's rows show: that many rows written by then, that
 *  many of them call_failed, and nothing written between the stop and the resume. */
function checkStop(s, rows) {
  const before = rows.filter((r) => r.at <= s.stopped);
  const gapRows = rows.filter((r) => r.at > s.stopped && r.at < s.resumed);
  const failed = before.filter((r) => r.status === "eval" && r.ai_reason === "call_failed").length;
  if (before.length !== s.rows || failed !== s.call_failed || gapRows.length || !(s.limit < s.call_failed) || !(s.stopped < s.resumed)) {
    throw new Error(`${RUNS}/stops.jsonl: the ${s.pass} stop at ${s.stopped} does not match its rows (${before.length} rows, ${failed} call_failed by then)`);
  }
}

const platform = (r) => PLATFORM_STATUS.includes(r.status) || (r.status === "eval" && PLATFORM_WORDS.includes(r.ai_reason));
const sent = (r) => typeof r.tx === "string";
const outcome = (r) => (r.status !== "eval" ? r.status : r.ai_status !== "unavailable" ? "usable" : r.ai_reason);
const groupOf = (l) => (l.should_veto === true ? (l.veto_allowed !== true ? "gap" : l.must_veto === true ? "plain" : "need") : l.veto_allowed === true ? "exposure" : "quiet");
const median = (xs) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
};
const sum = (xs) => xs.filter(Number.isFinite).reduce((a, b) => a + b, 0);
const span = (xs) => {
  const v = xs.filter(Number.isFinite);
  return v.length ? `${sec(Math.min(...v))} to ${sec(Math.max(...v))}` : "none";
};
const big = (xs) => xs.reduce((a, b) => a + BigInt(b ?? "0"), 0n);

function tally(xs) {
  const t = new Map();
  for (const x of xs) t.set(x, (t.get(x) ?? 0) + 1);
  return new Map([...t].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** One pass's numbers, over every record of its split. `side` holds the rows of tries that were
 *  sent again after a pause. A record with no scores (its run did not complete) has no verdict:
 *  the guard cannot act on it, with the AI on or off. */
function measure(rows, side, labels, split, budget) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const g = Object.fromEntries(GROUPS.map(([k]) => [k, { records: 0, scored: 0, usable: 0, verified: 0, critical: 0, criticalVerified: 0, on: 0, off: 0, noVerdict: 0, noVerdictIds: [] }]));
  const m = { records: split.length, rows: rows.length, notRun: split.filter((id) => !byId.has(id)).length, added: 0, below: 0, equal: 0, above: 0 };
  for (const id of split) {
    const l = labels.get(id);
    if (!l) throw new Error(`no label for ${id}`);
    const r = byId.get(id);
    const x = g[groupOf(l)];
    x.records++;
    if (!r || r.status !== "eval") {
      x.noVerdict++;
      continue;
    }
    x.scored++;
    const verified = r.ai_status === "verified";
    if (r.ai_status !== "unavailable") x.usable++;
    if (verified) x.verified++;
    if (r.ai_risk === "critical") {
      x.critical++;
      if (verified) x.criticalVerified++;
    }
    const on = r.risk === "critical" && l.veto_allowed === true;
    const off = r.floor === "critical" && l.veto_allowed === true;
    if (on) x.on++;
    if (off) x.off++;
    if (on && !off) m.added++;
    if (r.ai_risk !== null) {
      const d = SEVERITY.indexOf(r.ai_risk) - SEVERITY.indexOf(r.floor);
      m[d < 0 ? "below" : d === 0 ? "equal" : "above"]++;
    }
  }
  const total = (k) => GROUPS.reduce((n, [name]) => n + g[name][k], 0);
  const ev = rows.filter((r) => r.status === "eval");
  const calls = [...rows, ...side].filter(sent);
  Object.assign(m, {
    g, scored: total("scored"), usable: total("usable"), verified: total("verified"), noVerdict: total("noVerdict"),
    unverified: ev.filter((r) => r.ai_status === "unverified").length,
    unavailable: ev.filter((r) => r.ai_status === "unavailable").length,
    reasons: tally(ev.filter((r) => r.ai_status !== "verified").map((r) => `${r.ai_status} ${r.ai_reason}`)),
    other: tally(rows.filter((r) => r.status !== "eval").map((r) => r.status)),
    cleaned: ev.filter((r) => r.answer_cleaned === true).length,
    worker: { min: Math.min(...rows.map((r) => r.worker_ms).filter(Number.isFinite)), median: median(rows.map((r) => r.worker_ms)), max: Math.max(...rows.map((r) => r.worker_ms).filter(Number.isFinite)) },
    tokens: { prompt: sum(ev.map((r) => r.prompt_tokens)), completion: sum(ev.map((r) => r.completion_tokens)), reasoning: sum(ev.map((r) => r.reasoning_tokens)), reasoningMedian: median(ev.map((r) => r.reasoning_tokens)) },
    near: big(calls.map((r) => r.near_yocto)), usdCounted: big(calls.map((r) => r.usd_nano)),
    uncounted: calls.filter((r) => r.usd_nano === null).length, uncountedWords: tally(calls.filter((r) => r.usd_nano === null).map(outcome)),
    worstEach: WORST.prompt * PRICE.input + (BigInt(budget) + WORST.answer) * PRICE.output,
    calls: calls.length, callOutcomes: tally(calls.map(outcome)),
    platform: rows.filter(platform).length, platformWords: tally(rows.filter(platform).map(outcome)),
    sideTries: side.length, sideIds: new Set(side.map((r) => r.id)),
    times: [...rows, ...side].map((r) => r.at).filter(Boolean).sort(),
    failedWorker: span(rows.filter((r) => r.status === "eval" && r.ai_reason === "call_failed").map((r) => r.worker_ms)),
    answeredWorker: span(rows.filter((r) => r.status === "eval" && r.ai_risk !== null).map((r) => r.worker_ms)),
    unreadableWall: span(rows.filter((r) => r.status === "unreadable_output").map((r) => r.wall_ms)),
  });
  m.veto = g.plain.records + g.need.records + g.gap.records;
  m.notVeto = g.exposure.records + g.quiet.records;
  m.onCaught = g.plain.on + g.need.on + g.gap.on;
  m.offCaught = g.plain.off + g.need.off + g.gap.off;
  m.onWrong = g.exposure.on + g.quiet.on;
  m.offWrong = g.exposure.off + g.quiet.off;
  m.plain = g.plain.records;
  m.plainAi = g.plain.critical;
  m.need = g.need.records;
  m.catches = g.need.criticalVerified;
  m.exposure = g.exposure.records;
  m.falseAlarms = g.exposure.criticalVerified;
  m.missedNoVerdict = g.plain.noVerdict + g.need.noVerdict + g.gap.noVerdict;
  return m;
}

/** The choice rule, fixed before step A: 512 unless another budget has at least 3 more usable
 *  answers, or at least 2 more AI catches with no more false alarms; of two that beat 512, the smaller. */
function choose(dev) {
  const base = dev.get(SHIPPED);
  const beats = BUDGETS.filter((b) => b !== SHIPPED && dev.has(b)).filter((b) => {
    const m = dev.get(b);
    return m.usable - base.usable >= 3 || (m.catches - base.catches >= 2 && m.falseAlarms <= base.falseAlarms);
  });
  return beats.length ? Math.min(...beats) : SHIPPED;
}

const near = (yocto) => `${yocto / 10n ** 24n}.${(yocto % 10n ** 24n).toString().padStart(24, "0").slice(0, 6)}`;
const usd = (nano) => `${nano / 10n ** 9n}.${(nano % 10n ** 9n).toString().padStart(9, "0").slice(0, 6)}`;
const sec = (ms) => (ms === null || !Number.isFinite(ms) ? "none" : (ms / 1000).toFixed(1));
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : "none");
const of = (n, d) => `${n} of ${d}`;
const minutes = (ms) => Math.round(ms / 60_000);
const hm = (iso) => iso.slice(11, 16);
const utc = (iso) => `${iso.slice(0, 10)} ${hm(iso)} UTC`;
const signed = (n) => `${n >= 0 ? "+" : ""}${n}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function render() {
  const labels = new Map([...readJsonl(EVAL_DIR, "real/labels.jsonl"), ...readJsonl(EVAL_DIR, "planted/labels.jsonl")].map((r) => [r.id, r.label]));
  const { dev, test } = splitByRule();
  const pauses = rowsOf(`${RUNS}/pauses.jsonl`);
  const stops = rowsOf(`${RUNS}/stops.jsonl`);
  const load = (name, pass, split, budget) => {
    const rows = rowsOf(`${RUNS}/${name}.jsonl`);
    const side = rowsOf(`${RUNS}/${name}.retried.jsonl`);
    checkRows(`${RUNS}/${name}.jsonl`, rows, split, budget);
    checkRows(`${RUNS}/${name}.retried.jsonl`, side, split, budget);
    const own = { pauses: pauses.filter((p) => p.pass === pass), stops: stops.filter((s) => s.pass === pass) };
    for (const s of own.stops) checkStop(s, rows);
    return { name, pass, budget, rows, side, ...own, m: measure(rows, side, labels, split, budget) };
  };
  const passes = new Map(BUDGETS.map((b) => [b, load(`development-b${b}`, `dev-b${b}`, dev, b)]));
  const chosen = choose(new Map([...passes].map(([b, p]) => [b, p.m])));
  const headline = load(`test-b${chosen}`, `test-b${chosen}`, test, chosen);
  const gate = load("gate-b512", "gate", [dev[0]], SHIPPED);
  const known = new Set([gate, ...passes.values(), headline].map((p) => p.pass));
  for (const x of [...pauses, ...stops]) if (!known.has(x.pass)) throw new Error(`${RUNS}: a pause or stop names ${x.pass}, which is no pass here`);
  const all = [gate, ...passes.values(), headline];
  const times = all.flatMap((p) => p.m.times).sort();
  const h = headline.m;
  const d = [...passes.values()].map((p) => p.m);
  const row = (label, f) => `| ${label} | ${d.map(f).join(" | ")} |`;
  const base = passes.get(SHIPPED).m;
  const largest = passes.get(BUDGETS.at(-1)).m;
  const failedAt = (m) => m.callOutcomes.get("call_failed") ?? 0;
  const lines = [];
  const add = (...xs) => lines.push(...xs);

  add("# Kaap's AI second opinion, measured on the answer key", "",
    "Generated by `node eval/tools/ai-report.mjs` from the rows in `eval/ai-runs/` and the labels in `eval/real/labels.jsonl` and `eval/planted/labels.jsonl`; every count below is its output, and `--check` proves the file is exactly what the rows give.", "",
    "## What was run", "",
    `Kaap's sealed job, build \`${BUILD}\`, on OutLayer testnet (project \`${PROJECT}\`), in eval mode: the job takes a labelled proposal as its input, runs the same plain-code analysis and the same NEAR AI call as a judge run, and prints the scores unsigned. The model is \`${MODEL}\`, the one the job pins. Runs went from ${utc(times[0])} to ${utc(times.at(-1))}. Each pass sent every record of its split as the job would see it, and sent a record again only after a run of failed calls (see the availability section). Nothing was tuned to the labels: no prompt, no rule and no setting changed between passes except the reasoning budget.`, "",
    "The AI is a second opinion, never the only proof. Only a verified answer may raise a verdict, and the guard vetoes only a critical verdict on a proposal where a veto is allowed, which needs a plain-code finding of high or critical (labelling guide, section 6).", "",
    "## Why there is a split", "",
    `A setting chosen by looking at the same records that then measure it would flatter the result. So the ${dev.length + test.length} records were split by a rule fixed before any full run: the development split is lines 1, 6, 11, ... (every fifth, counting from 1) of \`eval/real/sample.jsonl\` and of \`eval/planted/planted.jsonl\`, ${dev.length} records; the test split is the other ${test.length}. The ${dev.length} development records carry the three reasoning-budget passes and the choice between them; the test split ran once, at the chosen budget, and gives the headline numbers. The split files are \`eval/ai-runs/split-development.txt\` and \`split-test.txt\`, and this tool refuses them unless they follow the rule. An earlier probe, on the build before this one, sent only records that are now in the development split, so no test record had been sent before its pass.`, "");

  add(`## Headline: the test split (${h.records} records, reasoning budget ${chosen})`, "",
    `The test pass ran while NEAR AI's status page reported a major outage of its chat service, and many calls failed (see the availability section). So the split is shown three ways side by side: how often the AI answered; what it said on the records it answered; and what the guard would have done on all ${h.records} records with the AI on and with it off, where a failed call counts as the AI being unavailable, which is what a treasury would have seen that day.`, "",
    "| Records, by what the label says | Records | AI answered: usable / verified | Where it answered: AI said critical (verified) | Guard vetoed, AI on | Guard vetoed, AI off | No verdict |",
    "|---|---|---|---|---|---|---|",
    ...GROUPS.map(([k, label]) => { const x = h.g[k]; return `| ${label} | ${x.records} | ${x.usable} / ${x.verified} | ${x.critical} (${x.criticalVerified}) | ${x.on} | ${x.off} | ${x.noVerdict} |`; }),
    `| All | ${h.records} | ${h.usable} / ${h.verified} | ${GROUPS.reduce((n, [k]) => n + h.g[k].critical, 0)} (${GROUPS.reduce((n, [k]) => n + h.g[k].criticalVerified, 0)}) | ${h.onCaught + h.onWrong} | ${h.offCaught + h.offWrong} | ${h.noVerdict} |`, "",
    "| As the guard would act, on every test record | AI on | AI off (plain code only) |", "|---|---|---|",
    `| Should be vetoed: caught | ${of(h.onCaught, h.veto)} | ${of(h.offCaught, h.veto)} |`,
    `| Should be vetoed: missed | ${of(h.veto - h.onCaught, h.veto)} | ${of(h.veto - h.offCaught, h.veto)} |`,
    `| Should not be vetoed: wrongly vetoed | ${of(h.onWrong, h.notVeto)} | ${of(h.offWrong, h.notVeto)} |`, "",
    `How often it answered: a usable answer on ${of(h.usable, h.records)} records (${pct(h.usable, h.records)}), ${h.verified} of them verified. The other ${h.records - h.usable}: ${[...h.reasons].filter(([w]) => w.startsWith("unavailable")).map(([w, n]) => `${n} \`${w.split(" ")[1]}\``).concat([...h.other].map(([s, n]) => `${n} \`${s}\``)).join(", ")}.`, "",
    `What it said where it answered: on the ${plural(h.g.plain.usable, "answered record", "answered records")} that plain code alone already vetoes (of ${h.plain}), it said critical on ${h.g.plain.critical}. On the ${plural(h.g.need.usable, "answered record", "answered records")} where only the AI could justify a veto (of ${h.need}), it said critical and verified on ${h.catches}. On the ${plural(h.g.exposure.usable, "answered record", "answered records")} where a veto is allowed but should not happen (of ${h.exposure}), it raised ${plural(h.falseAlarms, "false alarm", "false alarms")}. Its risk was below the plain-code floor on ${h.below}, equal to it on ${h.equal} and above it on ${h.above} of its ${h.usable} answers.`, "",
    `What the guard would have done: ${h.noVerdict} records got no verdict at all, because their OutLayer run never completed (\`unreadable_output\`, see the availability section). The guard cannot act without a verdict, so they count as not vetoed with the AI on and with it off; ${h.missedNoVerdict} of them should have been vetoed. ${h.g.gap.records} test records should be vetoed but are of the one kind the guard can never reject.`, "",
    h.added === 0
      ? `The AI added no veto that plain code did not already make: there are ${h.need} test records where only the AI could have justified a veto, it gave a usable answer on ${h.g.need.usable} of them, and it vetoed none. ${h.onWrong === h.offWrong ? "It added no wrong veto either." : `It added ${plural(h.onWrong - h.offWrong, "wrong veto", "wrong vetoes")}.`}`
      : `The AI added ${plural(h.added, "veto", "vetoes")} that plain code did not make, on the ${h.need} test records where only the AI could have justified one. ${h.onWrong === h.offWrong ? "It added no wrong veto." : `It added ${plural(h.onWrong - h.offWrong, "wrong veto", "wrong vetoes")}.`}`, "",
    `The likely direction of bias: a chat call that fails is likely one whose answer took longest, so the records the AI answered may be the easier ones, and the second view (what it said where it answered) may read better than the AI would do on every record. On the test split the \`call_failed\` rows took ${h.failedWorker} s of worker time and the usable answers ${h.answeredWorker} s.`, "");

  const cut = BUDGETS.at(-1);
  add(`## Development split: three reasoning budgets (${base.records} records each)`, "",
    `| | ${BUDGETS.map((b) => `budget ${b}`).join(" | ")} |`, `|---|${BUDGETS.map(() => "---").join("|")}|`,
    row("Scored", (m) => of(m.scored, m.records)),
    row("Usable answers (verified + unverified)", (m) => m.usable),
    row("Verified", (m) => m.verified),
    row("Unverified", (m) => m.unverified),
    row("Unavailable", (m) => m.unavailable),
    row("No verdict (run never completed)", (m) => m.noVerdict),
    row("Answers the reader had to clean (`answer_cleaned`)", (m) => m.cleaned),
    row("Worker time, min / median / max (s)", (m) => `${sec(m.worker.min)} / ${sec(m.worker.median)} / ${sec(m.worker.max)}`),
    row("Tokens: prompt / completion / reasoning, total", (m) => `${m.tokens.prompt} / ${m.tokens.completion} / ${m.tokens.reasoning}`),
    row("Reasoning tokens, median", (m) => m.tokens.reasoningMedian ?? "none"),
    row("Cost: testnet NEAR / USD counted", (m) => `${near(m.near)} / ${usd(m.usdCounted)}`),
    row("Plain code vetoes: AI also critical", (m) => of(m.plainAi, m.plain)),
    row("Only the AI could veto: catches / misses", (m) => `${m.catches} / ${m.need - m.catches} of ${m.need}`),
    row("Veto allowed, should not happen: AI false alarms", (m) => of(m.falseAlarms, m.exposure)),
    row("Guard, AI on: caught / missed / wrongly vetoed", (m) => `${m.onCaught} / ${m.veto - m.onCaught} / ${m.onWrong}`),
    row("Guard, AI off: caught / missed / wrongly vetoed", (m) => `${m.offCaught} / ${m.veto - m.offCaught} / ${m.offWrong}`),
    row("AI risk below / equal / above the floor", (m) => `${m.below} / ${m.equal} / ${m.above}`), "",
    `The choice rule, fixed before these passes: take ${SHIPPED}, the budget judge mode ships with, unless another budget has at least 3 more usable answers on the development split, or at least 2 more AI catches with no more false alarms; if two budgets both beat ${SHIPPED}, take the smaller. ${BUDGETS.filter((b) => b !== SHIPPED).map((b) => { const m = passes.get(b).m; return `Budget ${b}: ${signed(m.usable - base.usable)} usable answers, ${signed(m.catches - base.catches)} catches, ${signed(m.falseAlarms - base.falseAlarms)} false alarms against ${SHIPPED}.`; }).join(" ")} The rule picks ${chosen}.`, "",
    `Why budget ${cut} lost answers: ${of(failedAt(largest), largest.calls)} of its calls ended \`call_failed\`, against ${BUDGETS.slice(0, -1).map((b) => failedAt(passes.get(b).m)).join(" and ")} at ${BUDGETS.slice(0, -1).join(" and ")}. The likely cause, not a proven one: the job waits at most 25 s for the first byte of the chat answer (\`CHAT_LIMITS\` in \`packages/sealed/src/ai.rs\`), the request is not streamed, so nothing arrives until the model has finished thinking, and with more thinking the answer more often arrives later than that. A wait that runs out is reported as \`call_failed\`, the same word as a call the service refused, so the rows alone cannot tell the two apart. The worker times are the evidence there is: at budget ${cut} the \`call_failed\` rows took ${largest.failedWorker} s and the usable answers ${largest.answeredWorker} s. The pass also ran later in the day than the other two, during the same reported outage.`, "");

  const words = [...new Set(all.slice(1).flatMap((p) => [...p.m.reasons.keys()]))].sort();
  const cols = [...passes.values(), headline];
  const head = (label, list = cols) => [`| ${label} | ${list.map((p) => p.name).join(" | ")} |`, `|---|${list.map(() => "---").join("|")}|`];
  add("## Usable and verified answers", "",
    "Per record, as its pass ended. A usable answer is one with a risk word the job accepted, verified or not. Verified means the answer's signature and the model's sealed hardware checked out within the run; only a verified answer may raise a verdict.", "",
    ...head("Answer"),
    `| Records | ${cols.map((p) => p.m.records).join(" | ")} |`,
    `| Scored | ${cols.map((p) => p.m.scored).join(" | ")} |`,
    `| Usable | ${cols.map((p) => `${p.m.usable} (${pct(p.m.usable, p.m.records)})`).join(" | ")} |`,
    `| Verified | ${cols.map((p) => `${p.m.verified} (${pct(p.m.verified, p.m.records)})`).join(" | ")} |`,
    ...words.map((w) => `| ${w.replace(" ", ": ")} | ${cols.map((p) => p.m.reasons.get(w) ?? 0).join(" | ")} |`),
    `| no scores: unreadable_output | ${cols.map((p) => p.m.other.get("unreadable_output") ?? 0).join(" | ")} |`, "",
    "Every reason word that came back is listed. `unverified` words name the check that could not be completed; `unavailable` words name why there was no usable answer; `unreadable_output` is a run that returned no scores at all. Rates are out of every record of the split.", "");

  add("## AI risk against the plain-code floor", "",
    ...head("AI risk"),
    ...["below", "equal", "above"].map((k) => `| ${k} the floor | ${cols.map((p) => p.m[k]).join(" | ")} |`), "",
    "The floor is the highest severity among the plain-code findings, the lowest risk a verdict may show. An AI risk below it is never used to lower the verdict.", "");

  const callWords = [...new Set(all.flatMap((p) => [...p.m.callOutcomes.keys()]))].filter((w) => w !== "usable").sort();
  const tag = (w) => (PLATFORM_WORDS.includes(w) || PLATFORM_STATUS.includes(w) ? "platform" : "answer refused");
  const stopText = (p) => (p.stops.length ? p.stops.map((s) => `stopped at ${hm(s.stopped)} after ${s.rows} rows, ${s.call_failed} of them \`call_failed\`, over its limit of ${s.limit}; resumed at ${hm(s.resumed)} with that stop lifted`).join("; ") : "none");
  const pauseText = (p) => (p.pauses.length ? p.pauses.map((x) => `${hm(x.started)} to ${hm(x.ended)}`).join(", ") : "none");
  const testStop = headline.stops[0];
  const resent = [...h.sideIds].map((id) => headline.rows.find((r) => r.id === id));
  const resentLater = tally(resent.map(outcome));
  const unreadable = all.reduce((n, p) => n + (p.m.other.get("unreadable_output") ?? 0), 0);
  add("## Availability during the run", "",
    `NEAR AI's status page (status.near.ai) reported a major outage of its chat service (its Chat API) at ${STATUS_READS[0]} UTC on 11 Nov 2026, before the first run, and still at ${STATUS_READS[1]} UTC. So one record was sent first as a check, at budget ${SHIPPED}, to be resent every 15 minutes while it failed with \`call_failed\` or \`gateway_unavailable\`; it answered on ${gate.m.calls === 1 ? "the first try" : `try ${gate.m.calls}`}. During a pass, records went out in batches of up to 16; when a batch ended with five or more records in a row failing that way, the pass paused for 15 minutes and then sent those records again, and a record that failed three times stayed failed. That is the only resend rule: no record was sent again for any other reason, and nothing was re-run to get a cleaner number.`, "",
    "| Pass | Ran (UTC, 11 Nov 2026) | Calls sent | Stops | Pauses (UTC) | Minutes paused |", "|---|---|---|---|---|---|",
    ...all.map((p) => `| ${p.name} | ${hm(p.m.times[0])} to ${hm(p.m.times.at(-1))} | ${p.m.calls} | ${stopText(p)} | ${pauseText(p)} | ${minutes(sum(p.pauses.map((x) => Date.parse(x.ended) - Date.parse(x.started))))} |`), "",
    "Every call sent, by what came back (tries sent again after a pause included):", "",
    ...head("Call outcome", all),
    `| Calls sent | ${all.map((p) => p.m.calls).join(" | ")} |`,
    `| Usable answer | ${all.map((p) => p.m.callOutcomes.get("usable") ?? 0).join(" | ")} |`,
    ...callWords.map((w) => `| ${w} (${tag(w)}) | ${all.map((p) => p.m.callOutcomes.get(w) ?? 0).join(" | ")} |`), "",
    `A platform failure is a call with no usable AI answer because a call did not complete or a check could not fetch what it needed (${PLATFORM_WORDS.map((w) => `\`${w}\``).join(", ")}), or because the OutLayer run or its transaction failed or returned nothing readable (${PLATFORM_STATUS.map((w) => `\`${w}\``).join(", ")}). An answer refused is one the model gave that the job's reader would not accept. Both count as no answer, and both are part of the result.`, "",
    `Every \`unreadable_output\` row in these passes (${unreadable} in all) is a request whose OutLayer run never completed: its transaction logs no completion event, returns \`null\` and refunds the deposit, which can be read on the explorer from the row's \`tx\`. Such a row has no worker time, and each took ${headline.m.unreadableWall} s to settle in the test pass. It is a failure of OutLayer's run, not an answer from the job.`, "",
    `The test pass made ${plural(headline.pauses.length, "pause", "pauses")}, ${headline.pauses.map((x) => `from ${hm(x.started)} to ${hm(x.ended)} UTC after ${x.rows_in_a_row} records in a row ended \`call_failed\``).join(", and ")}. ${h.sideIds.size} records were sent again under the rule, ${h.sideTries} tries in all; as the pass ended, ${[...resentLater].map(([w, n]) => `${n} ${w === "usable" ? "had a usable answer" : `were \`${w}\``}`).join(", ")}.`, "",
    `The bar fixed before the run for the test pass was at most 2 percent of its records failing for a platform reason. It was not met. The pass stopped under that rule at ${hm(testStop.stopped)} UTC, after ${testStop.rows} rows, ${testStop.call_failed} of them \`call_failed\` (${pct(testStop.call_failed, testStop.rows)}). It was then completed from ${hm(testStop.resumed)} UTC with that stop lifted and everything else as before: the same resend rule, the same budget, no setting changed. As it ended, ${of(h.platform, h.records)} test records (${pct(h.platform, h.records)}) had failed for a platform reason: ${[...h.platformWords].map(([w, n]) => `${n} \`${w}\``).join(", ")}.`, "",
    "A further pass, over a private set of records kept outside this repository, ran after the test pass at the same budget and under the same rules; its results are not published here. It was interrupted once, when the machine running it stopped, and was resumed from its rows: records already sent were read back from their transactions, not sent again.", "");

  const total = all.reduce((t, p) => ({ near: t.near + p.m.near, usd: t.usd + p.m.usdCounted, uncounted: t.uncounted + p.m.uncounted, worst: t.worst + BigInt(p.m.uncounted) * p.m.worstEach }), { near: 0n, usd: 0n, uncounted: 0, worst: 0n });
  const uncountedWords = tally(all.flatMap((p) => [...p.m.uncountedWords].flatMap(([w, n]) => Array(n).fill(w))));
  const thousands = (n) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  add("## Time and cost", "",
    "| Pass | Calls sent | Worker time, min / median / max (s) | Testnet NEAR | USD counted | Calls with no token counts |", "|---|---|---|---|---|---|",
    ...all.map((p) => `| ${p.name} | ${p.m.calls} | ${sec(p.m.worker.min)} / ${sec(p.m.worker.median)} / ${sec(p.m.worker.max)} | ${near(p.m.near)} | ${usd(p.m.usdCounted)} | ${p.m.uncounted} |`),
    `| All | ${all.reduce((n, p) => n + p.m.calls, 0)} | | ${near(total.near)} | ${usd(total.usd)} | ${total.uncounted} |`, "",
    `Calls sent counts every transaction, tries sent again after a pause included. Worker time is OutLayer's own measure of each run, out of the 60 s limit, for the rows each pass kept. NEAR is the gas each transaction burnt plus OutLayer's charge, read from the transaction. USD is each answer's token counts at NEAR AI's catalog price for \`${MODEL}\`, ${PRICE.input} and ${PRICE.output} nano-USD per input and output token, read by every run from ${PRICE_SOURCE}; this tool checks every row's cost against that price. ${total.uncounted} calls reported no token counts (${[...uncountedWords].map(([w, n]) => `${n} \`${w}\``).join(", ")}) and are not in the USD counted; whether NEAR AI billed any of them is not known. At the most each could have used (${thousands(WORST.prompt)} prompt tokens and the whole answer allowance) they would add at most ${usd(total.worst)} USD.`, "");

  add("## Definitions", "",
    "- Plain code vetoes: the label says `should_veto` and `must_veto`, so the floor is critical and the guard vetoes whatever the AI says. Counted: how many the AI also called critical.",
    "- Only the AI could veto: `should_veto` is true, `must_veto` is false and `veto_allowed` is true. A catch is an answer that said critical and was verified; every other record here is a miss.",
    "- False alarm: `veto_allowed` is true and `should_veto` is false, and the AI said critical and was verified.",
    "- As the guard would act: a veto is a final risk of critical on a record where `veto_allowed` is true. With the AI on, the final risk is the job's own `risk`, which falls back to the plain-code floor when the AI gave no usable verified answer; with the AI off it is the plain-code `floor`. Caught and missed are out of the records that should be vetoed, wrongly vetoed out of those that should not. A record with no verdict, because its run never completed, is not vetoed either way.",
    "- Known gap: `should_veto` is true but `veto_allowed` is false, the one kind the Guard role can never reject. A miss either way.",
    "- AI risk against the floor: every usable answer's risk word compared with the job's floor.", "");

  add("## What this does not show", "",
    `- One model, \`${MODEL}\`, on one day, under a reported outage of NEAR AI's chat service and with some OutLayer runs never completing. On another day the same records may get more answers.`,
    `- ${test.length} test records. A difference of a few records between AI on and off is within what another sample could change.`,
    "- The records the AI answered may be the easier ones (see the headline), so its numbers where it answered may not hold on every record.",
    "- The labels were made by AI labelling passes following the guide, and cross-checked on a sample by a blind second pass (`eval/README.md`). A wrong label moves a number here.",
    "- No adversary adapted to Kaap's prompt. The planted attacks are fixed records; an attacker who can try descriptions against the same model may do better.",
    "- Eval mode prints unsigned scores. A judge run adds the signature and the evidence record, which this run does not measure.", "",
    "## Rebuild", "",
    "`node eval/tools/ai-report.mjs --check` (Node 24 or later, no network) rebuilds every table from the rows and exits 0 only when this file matches.", "");
  return lines.join("\n");
}

const text = render();
if (check) {
  const onDisk = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
  const shown = path.relative(process.cwd(), target) || target;
  if (onDisk === text) {
    console.log(`${shown} is exactly what the rows produce (${text.split("\n").length - 1} lines)`);
  } else {
    const a = (onDisk ?? "").split("\n"), w = text.split("\n");
    let i = 0;
    while (i < Math.max(a.length, w.length) && a[i] === w[i]) i++;
    console.log(onDisk === null ? `${shown} does not exist` : `${shown} differs from what the rows produce, first at line ${i + 1}`);
    if (onDisk !== null) console.log(`  on disk: ${(a[i] ?? "(end of file)").slice(0, 160)}\n  expected: ${(w[i] ?? "(end of file)").slice(0, 160)}`);
    console.log("  run node eval/tools/ai-report.mjs to write it");
    process.exitCode = 1;
  }
} else {
  fs.writeFileSync(TARGET, text);
  console.log(`wrote ${TARGET}`);
}
