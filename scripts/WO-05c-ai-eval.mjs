#!/usr/bin/env node
// Runs every record of an evaluation set through Kaap's sealed job once, in eval mode, and writes
// what came back as it comes: the risk a verdict would carry, the AI's own risk, its status, the
// sha256 of its explanation, the token counts and the transaction. Nothing is tuned to the answer
// key; the numbers are reported as they come (WO-05c).
//
//   node scripts/WO-05c-ai-eval.mjs --dry-run
//     Builds every input and prints how many fit the job's 32,768-byte limit, how many needed the
//     cut price table below, how many are still skipped, and the largest. Sends nothing and calls no
//     network.
//   node scripts/WO-05c-ai-eval.mjs [--max-usd 1.00] [--max-near 5] [--in-flight 4]
//     The live run on OutLayer testnet. Resumes from what an earlier run with the same --out wrote.
//   node scripts/WO-05c-ai-eval.mjs --report
//     Scores what --out holds against the set's own labels. Sends nothing.
//   --set <labels.jsonl> (repeatable) runs another set, such as reference/eval-nb/labels.jsonl.
//   --out <file> defaults to <the set's folder>/ai-runs/<UTC date>.jsonl and must lie inside that
//     folder, so the results of a private set stay beside it and out of every public file.
//
// Each input is built by kaap-core itself: packages/core-wasm's evalInput runs the scoreboards' own
// `input_of` on the record with the census price list (packages/core/tests/fixtures/tokens.json),
// so the AI judges exactly the inputs `kaap eval` and `cargo test -p kaap-core` score. A record whose
// input is over the limit, and only such a record, is sent with the price table cut to the tokens
// its own analysis names (`evalInputTrimmed`), which kaap-core refuses unless its whole analysis is
// the same with both tables; its row says `prices_trimmed: true`. If even that does not fit, the
// record is skipped with its size. The job reads the input strictly, and its only chain read is the
// final block for its clock. Needs packages/core-wasm/pkg, built with `bash packages/core-wasm/build.sh`.
//
// The live run: testnet only, inside WSL with Node 24 and near-api-js 7.4.0 at the repo root, where
// the worker's key lives (~/.near-credentials/testnet, read into memory and never printed). It signs
// as the worker named in packages/sealed/testnet.json, whose runs are free, and names the NEAR AI
// secret through secrets_ref (profile near-ai, owner KAAP_AI_SECRETS_ACCOUNT in .env); the key itself
// never reaches this machine. Each run sends one record first, which must come back as scores with
// the AI key present, then at most --in-flight records run at once, one less after every send error or failed
// run. Every transaction is written to <out>.pending before it is sent, so a record is sent once: a
// resumed run follows a pending transaction by its hash instead of sending the record again.
//
// Spending (C29): the caps default to the CONFIG values below. The script counts what it spent from
// each transaction (gas burnt plus OutLayer's charge, in NEAR) and from each answer's token counts at
// the model's catalog price (in USD), counting a record whose answer reported no counts at its worst
// case. It sends no record whose worst case, added to what is spent and what is still running, would
// pass either cap, and prints the running cost after every record.
//
// What this does not cover: why an answer is not verified beyond the job's own reason word, and
// OutLayer's own refusals and failed runs, which are recorded by status and transaction only. The
// guard's veto is scored as the job would act on it, where only a verified answer can lift a verdict
// above the plain-code floor; the report also counts the AI's own critical calls before that rule.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// CONFIG: the caps a live run stops at unless the command line sets others.
const DEFAULT_MAX_USD = '1.00';
const DEFAULT_MAX_NEAR = '5';
const MAX_IN_FLIGHT = 4;

const DEFAULT_SET = ['eval/real/labels.jsonl', 'eval/planted/labels.jsonl'];
const TOKENS = join(REPO, 'packages', 'core', 'tests', 'fixtures', 'tokens.json');
const WASM_DIR = join(REPO, 'packages', 'core-wasm', 'pkg');
// packages/sealed/src/input.rs MAX_INPUT_BYTES.
const MAX_INPUT_BYTES = 32_768;
const RUN_NETWORK = 'testnet';
// packages/sealed/src/ai.rs MODEL_ID: the model every price below is read for.
const MODEL_ID = 'z-ai/glm-5.3-flash';
const MODEL_LIST = 'https://cloud-api.near.ai/v1/model/list';

// What every run sends and attaches, as Kaap's worker sends them (packages/worker/src/judge.ts).
const OUTLAYER = 'outlayer.testnet';
const TGAS = 10n ** 12n;
const RUN_GAS = 300n * TGAS;
const RUN_DEPOSIT = 20n * 10n ** 21n;
// All three limits written out: an empty resource_limits object is never picked up (OutLayer #31).
const LIMITS = { max_instructions: 10_000_000_000, max_memory_mb: 128, max_execution_seconds: 60 };
// packages/worker/src/near.ts and judge.ts: the protocol's minimum gas price, and the gas each byte
// of a call's method name and arguments costs on top of the attached gas.
const MIN_GAS_PRICE = 100_000_000n;
const ARG_BYTE_GAS = 2n * 2_235_934n;
// A record whose answer reported no token counts is counted as if it used the most it could: every
// byte of the system prompt and the 8 KiB facts cap as a token (packages/sealed/src/prompt.rs,
// rounded up from about 9,600), and the whole max_tokens of 912 (ai.rs, 512 + 400).
const WORST_PROMPT_TOKENS = 12_000n;
const WORST_COMPLETION_TOKENS = 912n;

const SEVERITY = /^(low|medium|high|critical)$/;
const WORD = /^[a-z_]{1,40}$/;

class Stop extends Error {}

function usage(why) {
  throw new Stop(`${why}\nusage: node scripts/WO-05c-ai-eval.mjs [--dry-run | --report] [--set <labels.jsonl>]... [--out <file>] [--max-usd <dollars>] [--max-near <NEAR>] [--in-flight 1-4]`);
}

function options(argv) {
  const o = { mode: 'live', sets: [], out: null, maxUsd: DEFAULT_MAX_USD, maxNear: DEFAULT_MAX_NEAR, inFlight: MAX_IN_FLIGHT };
  for (let i = 0; i < argv.length; i++) {
    const value = () => argv[++i] ?? usage(`${argv[i - 1]} needs a value`);
    switch (argv[i]) {
      case '--dry-run': o.mode = 'dry-run'; break;
      case '--report': o.mode = 'report'; break;
      case '--set': o.sets.push(resolve(REPO, value())); break;
      case '--out': o.out = resolve(REPO, value()); break;
      case '--max-usd': o.maxUsd = value(); break;
      case '--max-near': o.maxNear = value(); break;
      case '--in-flight': o.inFlight = Number(value()); break;
      default: usage(`unknown option ${argv[i]}`);
    }
  }
  if (o.sets.length === 0) o.sets = DEFAULT_SET.map((p) => join(REPO, p));
  if (!Number.isInteger(o.inFlight) || o.inFlight < 1 || o.inFlight > MAX_IN_FLIGHT) usage(`--in-flight must be 1 to ${MAX_IN_FLIGHT}`);
  o.maxUsdNano = decimal(o.maxUsd, 9, '--max-usd');
  o.maxNearYocto = decimal(o.maxNear, 24, '--max-near');
  const home = commonFolder(o.sets);
  o.out ??= join(home, 'ai-runs', `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const inside = relative(home, o.out);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) usage(`--out must lie inside ${shown(home)}, the set's own folder`);
  o.home = home;
  return o;
}

/** A plain decimal as a whole number of 10^-places units, never through a float. */
function decimal(text, places, what) {
  const m = new RegExp(`^(\\d{1,12})(?:\\.(\\d{1,${places}}))?$`).exec(String(text));
  if (!m) usage(`${what} must be a plain decimal with at most ${places} places`);
  return BigInt(m[1]) * 10n ** BigInt(places) + BigInt((m[2] ?? '').padEnd(places, '0') || '0');
}

const shown = (path) => relative(REPO, path).replaceAll('\\', '/') || '.';

function commonFolder(paths) {
  let folder = dirname(paths[0]);
  while (!paths.every((p) => !relative(folder, p).startsWith('..'))) folder = dirname(folder);
  return folder;
}

const format = (units, places, shownPlaces) => {
  const whole = units / 10n ** BigInt(places);
  const part = (units % 10n ** BigInt(places)).toString().padStart(places, '0').slice(0, shownPlaces);
  return `${whole}.${part}`;
};
const near = (yocto) => format(yocto, 24, 6);
const usd = (nano) => format(nano, 9, 6);

/** Every record of the set, in file order, with the exact line kaap-core will read. */
function readSet(paths) {
  const records = [];
  const ids = new Set();
  for (const path of paths) {
    if (!existsSync(path)) throw new Stop(`no set at ${shown(path)}`);
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        throw new Stop(`${shown(path)} has a line that is not JSON`);
      }
      const id = record?.id;
      if (typeof id !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(id)) throw new Stop(`${shown(path)} has a record without a plain id`);
      if (ids.has(id)) throw new Stop(`${shown(path)} repeats id ${id}`);
      ids.add(id);
      records.push({ id, line, label: record.label ?? {} });
    }
  }
  return records;
}

async function loadCore() {
  const glue = join(WASM_DIR, 'kaap_core_wasm.js');
  const wasm = join(WASM_DIR, 'kaap_core_wasm_bg.wasm');
  if (!existsSync(glue) || !existsSync(wasm)) throw new Stop(`no kaap-core wasm in ${shown(WASM_DIR)}: build it with bash packages/core-wasm/build.sh`);
  // The glue is an ES module in a folder with no package.json, which Node warns about whenever it
  // is loaded by path; read as source it loads the same and stays quiet.
  const core = await import(`data:text/javascript;base64,${readFileSync(glue).toString('base64')}`);
  core.initSync({ module: readFileSync(wasm) });
  if (typeof core.evalInput !== 'function') throw new Stop(`the kaap-core wasm in ${shown(WASM_DIR)} has no evalInput: rebuild it with bash packages/core-wasm/build.sh`);
  return core;
}

/** The job's stdin for each record. The ProposalInput is embedded exactly as kaap-core wrote it:
 *  the job refuses one that differs from what serde writes, so it is never parsed and rewritten.
 *  Only a record over the limit gets kaap-core's cut price table (`evalInputTrimmed`, which refuses
 *  the cut unless the whole analysis is the same with both tables); `bytes` stays the full size
 *  when even that does not fit or the cut is refused, and the record is skipped. */
function buildInputs(core, records) {
  const tokens = readFileSync(TOKENS, 'utf8');
  const wrap = (input) => `{"v":1,"op":"eval","network":"${RUN_NETWORK}","input":${input}}`;
  for (const r of records) {
    r.trimmed = false;
    try {
      r.raw = wrap(core.evalInput(r.line, tokens));
      r.bytes = Buffer.byteLength(r.raw);
    } catch {
      r.raw = null;
      r.bytes = null;
      continue;
    }
    if (r.bytes <= MAX_INPUT_BYTES) continue;
    r.fullBytes = r.bytes;
    let cut = null;
    try {
      cut = wrap(core.evalInputTrimmed(r.line, tokens));
    } catch {
      continue;
    }
    if (Buffer.byteLength(cut) <= MAX_INPUT_BYTES) {
      r.raw = cut;
      r.bytes = Buffer.byteLength(cut);
      r.trimmed = true;
    }
  }
}

function dryRun(o, records) {
  const built = records.filter((r) => r.raw !== null);
  const untouched = built.filter((r) => !r.trimmed && r.bytes <= MAX_INPUT_BYTES);
  const trimmed = built.filter((r) => r.trimmed);
  const over = built.filter((r) => r.bytes > MAX_INPUT_BYTES);
  const largest = (list) => list.reduce((a, b) => ((b.fullBytes ?? b.bytes) > (a.fullBytes ?? a.bytes) ? b : a), list[0] ?? { id: 'none', bytes: 0 });
  const big = largest(built);
  const sent = built.filter((r) => r.bytes <= MAX_INPUT_BYTES).reduce((a, b) => (b.bytes > a.bytes ? b : a), { id: 'none', bytes: 0 });
  console.log(`WO-05c eval dry run, ${new Date().toISOString()}: nothing is sent`);
  console.log(`set: ${o.sets.map(shown).join(', ')}; results would go to ${shown(o.out)}`);
  console.log(`records: ${records.length}; inputs built: ${built.length}; refused by kaap-core: ${records.length - built.length}${records.length > built.length ? ` (${records.filter((r) => r.raw === null).map((r) => r.id).join(', ')})` : ''}`);
  console.log(`fit the ${MAX_INPUT_BYTES}-byte input limit as built, sent untouched: ${untouched.length} of ${records.length}`);
  console.log(`over it, sent with the price table cut to what their analysis names (analysis proven the same): ${trimmed.length}`);
  for (const r of trimmed) console.log(`  trimmed: ${r.id} ${r.fullBytes} -> ${r.bytes} bytes`);
  console.log(`still over the limit, would be skipped: ${over.length}`);
  for (const r of over) console.log(`  skipped: ${r.id} ${r.bytes} bytes`);
  console.log(`largest input as built: ${big.fullBytes ?? big.bytes} bytes (${big.id}); largest input sent: ${sent.bytes} bytes (${sent.id})`);
}

/** Lines already in `file`, by id. */
function readLines(file) {
  const lines = new Map();
  if (!existsSync(file)) return lines;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (typeof row?.id === 'string') lines.set(row.id, row);
  }
  return lines;
}

const count = (v) => v === null || (Number.isSafeInteger(v) && v >= 0);
const maybe = (re) => (v) => v === null || (typeof v === 'string' && re.test(v));

/** The job's printed line, checked like any input before a field of it is kept: eval scores with
 *  exactly their keys and shapes, or a fixed refusal. Anything else is `null`. */
function readOutput(text) {
  let out;
  try {
    out = JSON.parse(text);
    if (typeof out === 'string') out = JSON.parse(out);
  } catch {
    return null;
  }
  if (out === null || typeof out !== 'object' || out.v !== 1) return null;
  if (out.status === 'eval') {
    const keys = ['ai_reason', 'ai_risk', 'ai_status', 'completion_tokens', 'explanation_sha256', 'findings', 'finish_reason', 'floor', 'model_id', 'prompt_tokens', 'reasoning_tokens', 'risk', 'status', 'v'];
    const ok =
      Object.keys(out).sort().join() === keys.join() &&
      SEVERITY.test(out.floor) && SEVERITY.test(out.risk) && maybe(SEVERITY)(out.ai_risk) &&
      Array.isArray(out.findings) && out.findings.length <= 32 && out.findings.every((c) => typeof c === 'string' && /^[A-Z_]{3,40}$/.test(c)) &&
      /^(verified|unverified|unavailable)$/.test(out.ai_status) && maybe(WORD)(out.ai_reason) && maybe(WORD)(out.finish_reason) &&
      maybe(/^[a-z0-9./-]{1,64}$/)(out.model_id) && maybe(/^[0-9a-f]{64}$/)(out.explanation_sha256) &&
      count(out.prompt_tokens) && count(out.completion_tokens) && count(out.reasoning_tokens);
    return ok ? out : null;
  }
  if (/^(refused|held|failed)$/.test(out.status) && typeof out.reason === 'string' && /^[\x20-\x7e]{1,200}$/.test(out.reason)) {
    return { status: out.status, reason: out.reason };
  }
  return null;
}

/** NEAR AI's catalog price for MODEL_ID, in nano-USD per token, rounded up. */
async function tokenPrices() {
  const res = await fetch(MODEL_LIST, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (res.status !== 200) throw new Stop(`NEAR AI's model list answered HTTP ${res.status}`);
  const entry = (await res.json())?.models?.find((m) => m?.modelId === MODEL_ID);
  const nano = (cost, what) => {
    if (cost?.currency !== 'USD' || !Number.isSafeInteger(cost?.amount) || !Number.isSafeInteger(cost?.scale) || cost.amount < 0 || cost.scale < 0) {
      throw new Stop(`the model list gives no USD ${what} price for ${MODEL_ID}`);
    }
    const amount = BigInt(cost.amount);
    const scale = BigInt(cost.scale);
    return scale <= 9n ? amount * 10n ** (9n - scale) : (amount + 10n ** (scale - 9n) - 1n) / 10n ** (scale - 9n);
  };
  return { input: nano(entry?.inputCostPerToken, 'input'), output: nano(entry?.outputCostPerToken, 'output') };
}

/** Kaap's guard vetoes a verdict that is critical where the key allows a veto (guide section 6). */
function report(o, records, lines) {
  const n = { lines: 0, eval: 0, other: {}, notRun: 0, verified: 0, unverified: 0, unavailable: 0, answered: 0 };
  const s = { veto: 0, plain: 0, plainCaught: 0, needAi: 0, needAiCaught: 0, gap: 0, exposure: 0, falseAlarms: 0, aiCritical: 0, aiCriticalExposed: 0 };
  let nearYocto = 0n;
  let usdNano = 0n;
  let uncounted = 0;
  const models = new Set();
  for (const r of records) {
    const row = lines.get(r.id);
    if (!row) {
      n.notRun++;
      continue;
    }
    n.lines++;
    nearYocto += BigInt(row.near_yocto ?? '0');
    if (row.usd_nano === null && row.status === 'eval') uncounted++;
    usdNano += BigInt(row.usd_nano ?? '0');
    if (row.status !== 'eval') {
      n.other[row.status] = (n.other[row.status] ?? 0) + 1;
      continue;
    }
    n.eval++;
    n[row.ai_status]++;
    if (row.ai_risk !== null) n.answered++;
    if (row.model_id) models.add(row.model_id);
    const vetoed = row.risk === 'critical' && r.label.veto_allowed === true;
    const aiCritical = row.ai_risk === 'critical';
    if (r.label.should_veto === true) {
      s.veto++;
      if (r.label.veto_allowed !== true) s.gap++;
      else if (r.label.must_veto === true) {
        s.plain++;
        if (vetoed) s.plainCaught++;
      } else {
        s.needAi++;
        if (vetoed) s.needAiCaught++;
        if (aiCritical) s.aiCritical++;
      }
    } else if (r.label.veto_allowed === true) {
      s.exposure++;
      if (vetoed) s.falseAlarms++;
      if (aiCritical) s.aiCriticalExposed++;
    }
  }
  const others = Object.entries(n.other).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  console.log(`\nScores for ${shown(o.out)} against ${o.sets.map(shown).join(', ')}`);
  console.log(`records ${records.length}: scored ${n.eval}, other outcomes ${others}, not run ${n.notRun}`);
  console.log(`AI status: verified ${n.verified}, unverified ${n.unverified}, unavailable ${n.unavailable}; an AI answer on ${n.answered} of ${n.eval}; verified rate ${n.answered ? ((100 * n.verified) / n.answered).toFixed(1) : '0.0'} percent`);
  console.log(`model: ${[...models].join(', ') || 'none answered'}`);
  console.log(`should be vetoed: ${s.veto}. Caught by plain code ${s.plainCaught} of ${s.plain}; caught where only the AI could ${s.needAiCaught} of ${s.needAi}; misses ${s.plain - s.plainCaught + s.needAi - s.needAiCaught}; known gaps (no veto allowed) ${s.gap}`);
  console.log(`false alarms: ${s.falseAlarms} of ${s.exposure} records where a veto is allowed and should not happen`);
  console.log(`the AI's own critical calls, before the verified rule: ${s.aiCritical} of ${s.needAi} that needed it, ${s.aiCriticalExposed} of ${s.exposure} that should not be vetoed`);
  console.log(`cost: ${near(nearYocto)} testnet NEAR spent; ${usd(usdNano)} USD of AI tokens counted; ${uncounted} scored record(s) reported no token counts`);
}

async function live(o, records) {
  const chain = await import('./WO-02c-setup-testnet.mjs');
  const builds = JSON.parse(readFileSync(join(REPO, 'packages', 'sealed', 'testnet.json'), 'utf8'));
  if (builds.network !== RUN_NETWORK) throw new Stop('packages/sealed/testnet.json is not a testnet record');
  const owner = process.env.KAAP_AI_SECRETS_ACCOUNT ?? '';
  if (!/^[a-z0-9._-]{2,64}$/.test(owner)) throw new Stop('KAAP_AI_SECRETS_ACCOUNT in .env is missing or is not an account id: an eval run needs the AI key');
  const worker = chain.accountFor(builds.account);
  const prices = await tokenPrices();
  const current = BigInt((await chain.provider.viewGasPrice(null))?.gas_price ?? '0');
  const price = current > MIN_GAS_PRICE ? current : MIN_GAS_PRICE;
  const pendingFile = `${o.out}.pending`;
  mkdirSync(dirname(o.out), { recursive: true });
  const done = readLines(o.out);
  const pending = readLines(pendingFile);

  const worstUsd = () => WORST_PROMPT_TOKENS * prices.input + WORST_COMPLETION_TOKENS * prices.output;
  const costOf = (row) => ({ nearYocto: BigInt(row.near_yocto ?? '0'), usdNano: row.usd_nano === null ? (row.status === 'eval' ? worstUsd() : 0n) : BigInt(row.usd_nano) });
  let spentNear = 0n;
  let spentUsd = 0n;
  for (const row of done.values()) {
    const c = costOf(row);
    spentNear += c.nearYocto;
    spentUsd += c.usdNano;
  }
  const args = (raw) => ({
    source: { Project: { project_id: builds.project_id, version_key: null } },
    input_data: raw,
    response_format: 'Json',
    resource_limits: LIMITS,
    secrets_ref: { profile: 'near-ai', account_id: owner },
  });
  const worstNear = (raw) => (RUN_GAS + BigInt(Buffer.byteLength('request_execution') + Buffer.byteLength(JSON.stringify(args(raw)))) * ARG_BYTE_GAS) * price + RUN_DEPOSIT;

  console.log(`WO-05c eval run, ${new Date().toISOString()}, OutLayer testnet`);
  console.log(`project ${builds.project_id}, active build ${builds.active_version}, caller ${builds.account}, secret near-ai of ${owner}`);
  console.log(`set ${o.sets.map(shown).join(', ')} (${records.length} records); results ${shown(o.out)}; journal ${shown(pendingFile)}`);
  console.log(`caps ${o.maxUsd} USD and ${o.maxNear} NEAR; ${MODEL_ID} at ${prices.input} and ${prices.output} nano-USD per input and output token; gas price ${price}`);
  console.log(`already done ${done.size}, already spent ${near(spentNear)} NEAR and ${usd(spentUsd)} USD`);

  const write = (row) => {
    appendFileSync(o.out, `${JSON.stringify({ ...row, at: new Date().toISOString() })}\n`);
    done.set(row.id, row);
  };

  /** One finished transaction as the line it writes. */
  function settle(r, hash, outcome, wallMs) {
    const completed = chain.events(outcome).find((e) => e.event === 'execution_completed')?.data?.[0] ?? null;
    const charged = /^\d+$/.test(String(completed?.payment_charged ?? '')) ? BigInt(completed.payment_charged) : 0n;
    const nearYocto = chain.burnt(outcome) + charged;
    const base = { id: r.id, input_bytes: r.bytes, prices_trimmed: r.trimmed, tx: hash, near_yocto: nearYocto.toString(), wall_ms: wallMs };
    if (outcome.status?.Failure) return { ...base, status: 'tx_failed', usd_nano: null };
    const value = outcome.status?.SuccessValue;
    const out = value === undefined ? null : readOutput(Buffer.from(value, 'base64').toString('utf8'));
    if (completed?.success === false || value === undefined) return { ...base, status: 'run_failed', usd_nano: null };
    if (out === null) return { ...base, status: 'unreadable_output', usd_nano: null };
    if (out.status !== 'eval') return { ...base, status: out.status, reason: out.reason, usd_nano: null };
    if (out.model_id !== null && out.model_id !== MODEL_ID) throw new Stop(`${r.id} was answered by ${out.model_id}, not ${MODEL_ID}, whose price this run counts`);
    const counted = out.prompt_tokens !== null && out.completion_tokens !== null;
    const usdNano = counted ? BigInt(out.prompt_tokens) * prices.input + BigInt(out.completion_tokens) * prices.output : null;
    const { v, status, ...scores } = out;
    return { ...base, status, ...scores, usd_nano: usdNano === null ? null : usdNano.toString() };
  }

  for (const [id, row] of pending) {
    if (done.has(id)) continue;
    const r = records.find((x) => x.id === id);
    if (!r) continue;
    try {
      const outcome = await chain.finalOutcome(row.tx, worker.account.accountId, 60_000);
      const line = settle(r, row.tx, outcome, null);
      write(line);
      const c = costOf(line);
      spentNear += c.nearYocto;
      spentUsd += c.usdNano;
      console.log(`followed ${id} from an earlier run: ${line.status} ${chain.txLink(row.tx)}`);
    } catch (e) {
      if (e instanceof Stop) throw e;
      console.log(`still pending, not sent again: ${id} ${row.tx} (delete its line in ${shown(pendingFile)} only once that transaction can no longer land)`);
    }
  }

  const todo = records.filter((r) => !done.has(r.id) && !pending.has(r.id));
  for (const r of todo.filter((r) => r.raw === null || r.bytes > MAX_INPUT_BYTES)) {
    write({ id: r.id, status: r.raw === null ? 'unreadable_record' : 'skipped', input_bytes: r.bytes, usd_nano: null, near_yocto: '0' });
    console.log(`skipped ${r.id}: ${r.raw === null ? 'kaap-core could not read the record' : `${r.bytes} bytes, over the ${MAX_INPUT_BYTES}-byte limit`}`);
  }
  const queue = todo.filter((r) => r.raw !== null && r.bytes <= MAX_INPUT_BYTES);

  let inFlight = o.inFlight;
  let running = 0;
  let reservedNear = 0n;
  let reservedUsd = 0n;
  let capped = null;
  let finished = 0;
  let submitting = Promise.resolve();
  const lower = (why) => {
    if (inFlight > 1) {
      inFlight -= 1;
      console.log(`  pushed back (${why}): at most ${inFlight} in flight from now on`);
    }
  };

  async function runOne(r) {
    const reserve = { near: worstNear(r.raw), usd: worstUsd() };
    reservedNear += reserve.near;
    reservedUsd += reserve.usd;
    running += 1;
    const started = Date.now();
    try {
      const sent = (submitting = submitting.catch(() => {}).then(async () => {
        const tx = await worker.account.createTransaction({
          receiverId: OUTLAYER,
          actions: [chain.actions.functionCall('request_execution', args(r.raw), RUN_GAS, RUN_DEPOSIT)],
          publicKey: await worker.signer.getPublicKey(),
        });
        const { txHash, signedTransaction } = await worker.signer.signTransaction(tx);
        const hash = chain.baseEncode(txHash);
        appendFileSync(pendingFile, `${JSON.stringify({ id: r.id, tx: hash })}\n`);
        try {
          await chain.provider.sendTransactionUntil(signedTransaction, 'INCLUDED');
        } catch (e) {
          if (e?.constructor?.name !== 'TransactionTimeoutError') lower(`sending ${hash}: ${String(e?.message ?? e).slice(0, 120)}`);
        }
        return hash;
      }));
      const hash = await sent;
      let outcome;
      try {
        outcome = await chain.finalOutcome(hash, worker.account.accountId);
      } catch {
        console.log(`  ${r.id}: ${hash} has no final outcome yet; it stays in the journal and is followed on the next run`);
        lower('no outcome');
        return null;
      }
      const line = settle(r, hash, outcome, Date.now() - started);
      write(line);
      const c = costOf(line);
      spentNear += c.nearYocto;
      spentUsd += c.usdNano;
      if (line.status === 'tx_failed' || line.status === 'run_failed') lower(line.status);
      finished += 1;
      const ai = line.status === 'eval' ? `risk ${line.risk} floor ${line.floor} ai ${line.ai_status}${line.ai_reason ? ` (${line.ai_reason})` : ''} said ${line.ai_risk ?? 'nothing'} tokens ${line.prompt_tokens ?? '-'}/${line.completion_tokens ?? '-'}/${line.reasoning_tokens ?? '-'}` : (line.reason ?? '');
      console.log(`[${done.size}/${records.length}] ${r.id} ${line.status} ${ai} ${(line.wall_ms / 1000).toFixed(1)} s | spent ${near(spentNear)} NEAR, ${usd(spentUsd)} USD | ${running} in flight`);
      return line;
    } finally {
      running -= 1;
      reservedNear -= reserve.near;
      reservedUsd -= reserve.usd;
    }
  }

  const fitsCaps = (r) => spentNear + reservedNear + worstNear(r.raw) <= o.maxNearYocto && spentUsd + reservedUsd + worstUsd() <= o.maxUsdNano;

  if (queue.length > 0) {
    const first = queue.shift();
    if (!fitsCaps(first)) throw new Stop(`the first record's worst case is already over a cap`);
    const line = await runOne(first);
    if (line?.status !== 'eval' || line.ai_reason === 'ai_key_missing') {
      throw new Stop(`the first record came back ${line?.status ?? 'without an outcome'}${line?.ai_reason ? ` (${line.ai_reason})` : ''}: check that the AI key's build lock names the active build, then run again`);
    }
  }

  const active = new Set();
  for (const r of queue) {
    while (active.size >= inFlight) await Promise.race(active);
    if (!fitsCaps(r)) {
      capped = r.id;
      break;
    }
    const p = runOne(r).finally(() => active.delete(p));
    active.add(p);
  }
  await Promise.all(active);
  console.log(`\nsent ${finished} record(s) this run; spent in all ${near(spentNear)} testnet NEAR and ${usd(spentUsd)} USD (records without token counts at their worst case)`);
  if (capped) console.log(`STOPPED at a cap before ${capped}: run again with a higher --max-usd or --max-near to go on`);
  report(o, records, readLines(o.out));
  return capped ? 3 : 0;
}

try {
  const o = options(process.argv.slice(2));
  const records = readSet(o.sets);
  if (o.mode === 'report') {
    report(o, records, readLines(o.out));
    process.exit(0);
  }
  const core = await loadCore();
  buildInputs(core, records);
  if (o.mode === 'dry-run') {
    dryRun(o, records);
    process.exit(0);
  }
  process.exit(await live(o, records));
} catch (e) {
  console.log(`STOPPED: ${e instanceof Stop ? e.message : String(e?.stack ?? e)}`);
  process.exit(1);
}
