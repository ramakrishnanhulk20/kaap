// Re-reads proposals of eval/real/sample.jsonl from NEAR mainnet and checks that each record's kind,
// description and status are what the chain holds.
//
//   node eval/tools/verify-chain.mjs                         20 records picked by a fixed seed
//   node eval/tools/verify-chain.mjs --n 50                  the first 50 in the same seeded order
//   node eval/tools/verify-chain.mjs --id mainnet:<dao>:<n>  one record
//   node eval/tools/verify-chain.mjs --all                   all 300, slowly
//
// Each proposal is read the way the kaap CLI reads one: the first provider's final block fixes a
// height, both providers are asked at that height, and they must agree on the block and on the
// proposal. A record that equals today's chain is "matched". One that does not is read again from
// an archival node at the last and the first block of the 20 Oct 2026 census. If the chain held the
// record's values then, the DAO has changed or removed the proposal since ("changed since").
// Otherwise the record is "failed".
//
// Reads only: no key, no signature, no transaction. Standard library only.
// Exit codes: 0 every record read and none failed; 1 a record failed; 2 bad arguments;
// 3 a record could not be read, and none failed.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(HERE, "..", "real", "sample.jsonl");

const PRIMARY = "https://near.drpc.org";
const SECONDARY = "https://rpc.mainnet.fastnear.com";
// The CLI's archive order. fastnear's archive answers fast but refuses bursts, so it is paced and
// a refused request moves on to NEAR's own archive, which is slower but steady.
const ARCHIVES = ["https://archival-rpc.mainnet.fastnear.com", "https://archival-rpc.mainnet.near.org"];
// The census read the proposal pages of every DAO between these two blocks on 20 Oct 2026, about
// 30 minutes of chain. A proposal that changed inside the window still equals the record at one end.
const CENSUS_FIRST_BLOCK = 220_762_448;
const CENSUS_LAST_BLOCK = 220_764_228;
const PICK_SEED = "kaap-chain-check-v1";

// The CLI's limits (packages/cli/src/caps.ts).
const TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 4 * 512 * 1024 + 64 * 1024;
const TRIES = 4;
const MAX_RETRY_WAIT_MS = 10_000;
const RATE_LIMIT_WAITS_MS = [2_000, 5_000];
const RATE_LIMIT_REST_MS = 60_000;
const LIVE_GAP_MS = 200;
const ARCHIVE_GAP_MS = 1_000;
// A height no block was produced at holds the same state as the block before it.
const NO_BLOCK_STEPS = 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
// Chain text is written by whoever filed the proposal, so only a short printable run is shown.
const clean = (t) => String(t ?? "").replace(/[^\x20-\x7e]/g, "?").slice(0, 160);

function usage(msg) {
  if (msg) console.error("verify-chain: " + msg);
  console.error("usage: node eval/tools/verify-chain.mjs [--n <1..300>] [--id <record id>] [--all]");
  process.exit(2);
}

function parseArgs(argv) {
  const out = { mode: "n", n: 20, id: null };
  let picked = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") out.mode = "all";
    else if (a === "--n") {
      const v = argv[++i];
      if (!/^[1-9][0-9]{0,2}$/.test(v ?? "")) usage("--n takes a whole number from 1 to 300");
      out.mode = "n";
      out.n = Number(v);
    } else if (a === "--id") {
      const v = argv[++i];
      if (typeof v !== "string" || v === "") usage("--id takes a record id");
      out.mode = "id";
      out.id = v;
    } else usage("unknown argument " + clean(a));
    picked++;
  }
  if (picked > 1) usage("give one of --n, --id or --all");
  return out;
}

// Numbers keep their source text, so a large amount is never rounded before it is compared.
class Num {
  constructor(text) {
    this.text = text;
  }
}
const parseExact = (text) => JSON.parse(text, (_k, v, ctx) => (typeof v === "number" ? new Num(ctx.source) : v));

// Sputnik keeps a role's Group and its permissions as sets, so their order is not part of the value.
const SET_KEYS = new Set(["Group", "permissions"]);
function canon(v, key) {
  if (v instanceof Num) return v.text;
  if (Array.isArray(v)) {
    const items = v.map((x) => canon(x));
    return "[" + (SET_KEYS.has(key) ? [...new Set(items)].sort() : items).join(",") + "]";
  }
  if (isRecord(v)) return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k], k)).join(",") + "}";
  return JSON.stringify(v);
}

class ReadError extends Error {
  constructor(kind, host, detail) {
    super(`${host}: ${detail}`);
    this.kind = kind;
    this.host = host;
  }
}
// The two providers answered differently, which is a fault or a lie, never the record's fault.
class Disagree extends Error {}

const exchanges = [];
const counts = { sent: 0, retried: 0, refused: 0 };
const refusedAt = new Map();

function pacer(gapMs) {
  let next = 0;
  return async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + gapMs;
    if (at > now) await sleep(at - now);
  };
}
const liveSlot = pacer(LIVE_GAP_MS);
const archiveSlot = pacer(ARCHIVE_GAP_MS);

async function post(url, body, what) {
  const host = new URL(url).host;
  const started = performance.now();
  const done = (out) => {
    exchanges.push({ ms: performance.now() - started, host, what });
    return out;
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const reader = res.body?.getReader();
    const chunks = [];
    let total = 0;
    if (reader) {
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        total += value.byteLength;
        if (total > MAX_BODY_BYTES) {
          await reader.cancel();
          return done({ status: 0, note: "sent more than " + MAX_BODY_BYTES + " bytes" });
        }
        chunks.push(value);
      }
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    return done({ status: res.status, text: new TextDecoder().decode(Buffer.concat(chunks)), retryAfterMs: retryAfter > 0 ? retryAfter * 1000 : undefined });
  } catch (e) {
    return done({ status: 0, note: e && (e.name === "TimeoutError" || e.name === "AbortError") ? "did not answer in time" : "could not be reached" });
  }
}

function answer(host, status, text, missingIsFinal) {
  // fastnear's archive answers HTTP 422 for a height no block was produced at.
  if (status === 422) return missingIsFinal ? new ReadError("no_block", host, "HTTP 422, no block at this height") : new ReadError("unavailable", host, "HTTP 422");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new ReadError(status === 200 ? "shape" : "unavailable", host, `HTTP ${status}, not JSON`);
  }
  if (!isRecord(parsed)) return new ReadError("shape", host, "the answer is not a JSON object");
  const error = parsed.error;
  if (error !== undefined) {
    const cause = isRecord(error) && isRecord(error.cause) ? error.cause.name : undefined;
    if (cause === "UNKNOWN_ACCOUNT") return new ReadError("no_account", host, "no such account");
    if (missingIsFinal && cause === "UNKNOWN_BLOCK") return new ReadError("no_block", host, "no block at this height");
    if (cause === "GARBAGE_COLLECTED_BLOCK") return new ReadError("dropped", host, "the node no longer keeps that block");
    if (cause === "CONTRACT_EXECUTION_ERROR") return new ReadError(JSON.stringify(error).includes("ERR_NO_PROPOSAL") ? "no_proposal" : "refused", host, "the contract refused the view");
    return new ReadError("unavailable", host, clean(cause ?? (isRecord(error) ? error.name : error)));
  }
  const result = parsed.result;
  if (status !== 200 || !isRecord(result)) return new ReadError(status === 200 ? "shape" : "unavailable", host, `HTTP ${status}`);
  return result;
}

// One JSON-RPC call to one host. A refusal, a timeout or a node-side error is asked again after 1,
// 2 and 4 seconds, or after the host's Retry-After up to 10 seconds. With rateLimitWaits, an HTTP
// 429 that names no wait is waited out for 2 s, then 5 s, and then the call gives up on this host.
async function call(url, method, params, { slot, missingIsFinal = false, rateLimitWaits = null, what }) {
  const host = new URL(url).host;
  const body = JSON.stringify({ jsonrpc: "2.0", id: "kaap", method, params });
  let last = new ReadError("unavailable", host, "no answer");
  let refusals = 0;
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    if (attempt > 1) counts.retried++;
    await slot();
    counts.sent++;
    let waitMs = 1000 * 2 ** (attempt - 1);
    const r = await post(url, body, what);
    if (r.status === 429 || r.status === 503) {
      last = new ReadError("unavailable", host, "HTTP " + r.status);
      if (r.status === 429) {
        counts.refused++;
        refusedAt.set(host, Date.now());
      }
      if (r.retryAfterMs !== undefined) waitMs = Math.min(r.retryAfterMs, MAX_RETRY_WAIT_MS);
      else if (r.status === 429 && rateLimitWaits) {
        const next = rateLimitWaits[refusals++];
        if (next === undefined) break;
        waitMs = next;
      }
    } else if (r.status === 0) {
      last = new ReadError("unavailable", host, r.note);
    } else {
      const out = answer(host, r.status, r.text, missingIsFinal);
      if (!(out instanceof ReadError)) return out;
      if (out.kind !== "unavailable") throw out;
      last = out;
    }
    if (attempt < TRIES) await sleep(waitMs);
  }
  throw last;
}

function header(result, host) {
  const h = result.header;
  if (!isRecord(h) || !Number.isSafeInteger(h.height) || typeof h.hash !== "string") throw new ReadError("shape", host, "the block header is not readable");
  return { height: h.height, hash: h.hash };
}

async function viewProposal(url, dao, id, blockId, opts) {
  const host = new URL(url).host;
  const r = await call(url, "query", { request_type: "call_function", block_id: blockId, account_id: dao, method_name: "get_proposal", args_base64: Buffer.from(JSON.stringify({ id })).toString("base64") }, opts);
  if (r.error !== undefined) {
    const t = String(r.error);
    throw new ReadError(t.includes("ERR_NO_PROPOSAL") ? "no_proposal" : "refused", host, "get_proposal failed: " + clean(t));
  }
  const bytes = r.result;
  if (!Array.isArray(bytes) || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) throw new ReadError("shape", host, "get_proposal result is not bytes");
  if (!Number.isSafeInteger(r.block_height) || typeof r.block_hash !== "string") throw new ReadError("shape", host, "the answer names no block");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    throw new ReadError("shape", host, "get_proposal result is not UTF-8");
  }
  let p;
  try {
    p = parseExact(text);
  } catch {
    throw new ReadError("shape", host, "get_proposal result is not JSON");
  }
  if (!isRecord(p) || !(p.id instanceof Num) || typeof p.description !== "string" || typeof p.status !== "string" || p.kind === undefined) {
    throw new ReadError("shape", host, "get_proposal has no id, description, status or kind");
  }
  return {
    host,
    blockHeight: r.block_height,
    blockHash: r.block_hash,
    proposal: { id: Number(p.id.text), description: p.description, status: p.status, kind: canon(p.kind), proposer: canon(p.proposer), submitted: canon(p.submission_time) },
  };
}

// A proposal, or the reason the DAO no longer answers for it.
const GONE = new Set(["no_proposal", "no_account", "refused"]);

async function liveOne(url, dao, id, head) {
  try {
    const v = await viewProposal(url, dao, id, head.height, { slot: liveSlot, what: `get_proposal ${dao} #${id}` });
    if (v.blockHeight !== head.height || v.blockHash !== head.hash) throw new Disagree(`${v.host} did not answer at block ${head.height}`);
    if (v.proposal.id !== id) throw new Disagree(`${v.host} answered with proposal ${v.proposal.id} when asked for ${id}`);
    return { proposal: v.proposal };
  } catch (e) {
    if (e instanceof ReadError && GONE.has(e.kind)) return { gone: e.kind };
    throw e;
  }
}

async function liveRead(dao, id, head) {
  const a = await liveOne(PRIMARY, dao, id, head);
  const b = await liveOne(SECONDARY, dao, id, head);
  const same = a.gone !== undefined
    ? a.gone === b.gone
    : b.proposal !== undefined && ["id", "kind", "description", "status", "proposer", "submitted"].every((f) => a.proposal[f] === b.proposal[f]);
  if (!same) throw new Disagree(`the two providers disagree on proposal ${id} at block ${head.height}`);
  return a;
}

async function archiveView(dao, id, height) {
  const now = Date.now();
  const resting = (url) => now - (refusedAt.get(new URL(url).host) ?? -Infinity) < RATE_LIMIT_REST_MS;
  const order = [...ARCHIVES.filter((u) => !resting(u)), ...ARCHIVES.filter(resting)];
  const failures = [];
  for (const url of order) {
    try {
      const v = await viewProposal(url, dao, id, height, { slot: archiveSlot, missingIsFinal: true, rateLimitWaits: RATE_LIMIT_WAITS_MS, what: `archive get_proposal ${dao} #${id} at ${height}` });
      if (v.blockHeight !== height) throw new ReadError("shape", v.host, `answered for block ${v.blockHeight}, not ${height}`);
      return v;
    } catch (e) {
      if (!(e instanceof ReadError)) throw e;
      if (e.kind === "unavailable" || e.kind === "shape" || e.kind === "dropped") {
        failures.push(e.message);
        continue;
      }
      throw e;
    }
  }
  throw new ReadError("unavailable", "archive", failures.join("; "));
}

async function archiveRead(dao, id, height) {
  for (let h = height; h > height - NO_BLOCK_STEPS; h--) {
    try {
      const v = await archiveView(dao, id, h);
      if (v.proposal.id !== id) throw new ReadError("shape", v.host, `answered with proposal ${v.proposal.id} when asked for ${id}`);
      return { proposal: v.proposal, height: h, host: v.host };
    } catch (e) {
      if (!(e instanceof ReadError)) throw e;
      if (e.kind === "no_block") continue;
      if (GONE.has(e.kind)) return { gone: e.kind, height: h, host: e.host };
      throw e;
    }
  }
  throw new ReadError("unavailable", "archive", `no block in the ${NO_BLOCK_STEPS} heights up to ${height}`);
}

const differences = (rec, chain) => ["kind", "description", "status"].filter((f) => rec[f] !== chain[f]);

const GONE_TEXT = {
  no_proposal: "the DAO holds no such proposal",
  no_account: "the DAO account does not exist",
  refused: "the DAO contract refused get_proposal",
};

function changeSince(rec, live) {
  if (live.gone) return GONE_TEXT[live.gone] + " now";
  return differences(rec, live.proposal)
    .map((f) => (f === "status" ? `status ${rec.status} then, ${live.proposal.status} now` : `${f} changed`))
    .join(", ");
}

function failure(rec, old) {
  if (old.gone) return `${GONE_TEXT[old.gone]} at census block ${old.height}`;
  return differences(rec, old.proposal)
    .map((f) => {
      if (f === "status") return `status: record ${clean(rec.status)}, chain ${clean(old.proposal.status)} at block ${old.height}`;
      if (f === "description") {
        const a = rec.description, b = old.proposal.description;
        let i = 0;
        while (i < a.length && i < b.length && a[i] === b[i]) i++;
        return `description: record ${a.length} characters, chain ${b.length} at block ${old.height}, first difference at character ${i + 1}`;
      }
      return `kind: record and chain differ at block ${old.height}`;
    })
    .join("; ");
}

async function checkRecord(rec, head) {
  let live;
  try {
    live = await liveRead(rec.dao, rec.proposal_id, head);
  } catch (e) {
    if (e instanceof Disagree || e instanceof ReadError) return { verdict: "unread", detail: e.message };
    throw e;
  }
  if (live.proposal && differences(rec, live.proposal).length === 0) return { verdict: "matched", detail: rec.status };
  const reads = [];
  try {
    for (const h of [CENSUS_LAST_BLOCK, CENSUS_FIRST_BLOCK]) {
      const old = await archiveRead(rec.dao, rec.proposal_id, h);
      reads.push(old);
      if (old.proposal && differences(rec, old.proposal).length === 0) {
        return { verdict: "changed", detail: `${changeSince(rec, live)}; equal to the record at census block ${old.height} (${old.host})` };
      }
    }
  } catch (e) {
    if (e instanceof ReadError) return { verdict: "unread", detail: `today: ${changeSince(rec, live)}; the census block could not be read: ${e.message}` };
    throw e;
  }
  return { verdict: "failed", detail: failure(rec, reads[0]) };
}

function loadRecords() {
  const out = [];
  const lines = fs.readFileSync(SAMPLE, "utf8").split("\n").filter((l) => l !== "");
  for (const [i, line] of lines.entries()) {
    const plain = JSON.parse(line);
    const exact = parseExact(line);
    if (typeof plain.id !== "string" || typeof plain.dao !== "string" || !Number.isSafeInteger(plain.proposal_id) || typeof plain.description !== "string" || typeof plain.status !== "string" || exact.kind === undefined) {
      throw new Error(`eval/real/sample.jsonl line ${i + 1} lacks id, dao, proposal_id, description, status or kind`);
    }
    out.push({ id: plain.id, dao: plain.dao, proposal_id: plain.proposal_id, description: plain.description, status: plain.status, kind: canon(exact.kind) });
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
const records = loadRecords();
let chosen;
if (opts.mode === "id") {
  chosen = records.filter((r) => r.id === opts.id);
  if (!chosen.length) usage("no record " + clean(opts.id) + " in eval/real/sample.jsonl");
} else {
  const key = (id) => crypto.createHash("sha256").update(PICK_SEED + "|" + id).digest("hex");
  const ordered = records.map((r) => [key(r.id), r]).sort((a, b) => cmpStr(a[0], b[0])).map((e) => e[1]);
  if (opts.mode === "n" && opts.n > ordered.length) usage(`--n is at most ${ordered.length}`);
  chosen = opts.mode === "all" ? ordered : ordered.slice(0, opts.n);
}

let head;
try {
  const first = header(await call(PRIMARY, "block", { finality: "final" }, { slot: liveSlot, what: "final block" }), new URL(PRIMARY).host);
  const second = header(await call(SECONDARY, "block", { block_id: first.height }, { slot: liveSlot, what: `block ${first.height}` }), new URL(SECONDARY).host);
  if (second.hash !== first.hash) throw new Disagree(`the two providers disagree on block ${first.height}`);
  head = first;
} catch (e) {
  if (!(e instanceof ReadError || e instanceof Disagree)) throw e;
  console.error("verify-chain: no final block both providers agree on: " + e.message);
  process.exit(3);
}

console.log(`reading ${chosen.length} of ${records.length} records at block ${head.height}, from ${new URL(PRIMARY).host} and ${new URL(SECONDARY).host}`);
const tally = { matched: 0, changed: 0, failed: 0, unread: 0 };
const LABEL = { matched: "matched", changed: "changed since", failed: "FAILED", unread: "unread" };
for (const rec of chosen) {
  const res = await checkRecord(rec, head);
  tally[res.verdict]++;
  console.log(`${LABEL[res.verdict].padEnd(13)} ${rec.id}  ${res.detail}`);
}

const slow = exchanges.slice().sort((a, b) => b.ms - a.ms).slice(0, 2);
console.log(`verify-chain: ${chosen.length} record${chosen.length === 1 ? "" : "s"} at block ${head.height}: ${tally.matched} matched, ${tally.changed} changed since, ${tally.failed} failed, ${tally.unread} unread`);
console.log(`slowest reads: ${slow.map((x) => `${(x.ms / 1000).toFixed(2)} s (${x.what}, ${x.host})`).join("; ")}`);
console.log(`requests: ${counts.sent} sent, ${counts.retried} asked again, ${counts.refused} refused with HTTP 429`);
process.exit(tally.failed > 0 ? 1 : tally.unread > 0 ? 3 : 0);
