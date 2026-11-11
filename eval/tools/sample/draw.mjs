// Re-runs the seeded draw that chose the 300 real proposals in eval/real/sample.jsonl.
//
//   node eval/tools/sample/draw.mjs           prints the 300 chosen ids, one per line
//   node eval/tools/sample/draw.mjs --check   exits 0 only when they are the ids in eval/real/sample.jsonl
//
// Input: census-index.jsonl next to this file, one line per proposal of the 20 Oct 2026 census
// (9,471 proposals, 608 DAOs). Standard library only, no network, no clock, no Math.random.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(HERE, "census-index.jsonl");
const SAMPLE = path.join(HERE, "..", "..", "real", "sample.jsonl");
const SEED = "kaap-eval-v1";
const TARGET = 300;

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== "--check");
if (unknown.length) {
  console.error("usage: node eval/tools/sample/draw.mjs [--check]");
  process.exit(2);
}
const checkMode = args.includes("--check");

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// One stream per stratum, so changing one stratum never moves the draw of another.
function streamFor(name) {
  const h = crypto.createHash("sha256").update(SEED + "|" + name).digest();
  return mulberry32(h.readUInt32BE(0));
}
function shuffled(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The census rule for a DAO whose name says it is a test.
const TEST_RE = /test|staging|qa-|-qa|^qa|demo|sandbox|audit|trial|dummy|playground/i;
const isTestName = (dao) => TEST_RE.test(dao.replace(/\.sputnik-dao\.near$/, ""));
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDT = "usdt.tether-token.near";
const tokenGroup = (t) => (t === "" ? "NEAR" : t === USDC ? "USDC" : t === USDT ? "USDT" : "other");

const indexBytes = fs.readFileSync(INDEX);
const population = indexBytes
  .toString("utf8")
  .split("\n")
  .filter((l) => l !== "")
  .map((line, i) => {
    let r;
    try { r = JSON.parse(line); } catch { throw new Error(`census-index.jsonl line ${i + 1} is not JSON`); }
    if (typeof r.dao !== "string" || !Number.isSafeInteger(r.id) || typeof r.kind !== "string" || typeof r.status !== "string" || typeof r.ver !== "string") {
      throw new Error(`census-index.jsonl line ${i + 1} lacks dao, id, kind, status or ver`);
    }
    const fc = r.kind === "FunctionCall";
    return {
      id: `mainnet:${r.dao}:${r.id}`,
      dao: r.dao,
      pid: r.id,
      k: r.kind,
      status: r.status,
      test: isTestName(r.dao),
      ver: r.ver,
      pairs: fc ? (r.methods || []).map((m) => r.receiver + "::" + m) : [],
      receiver: fc ? r.receiver : null,
      deposit1: r.deposit_above_1 === true,
      tgroup: r.kind === "Transfer" ? tokenGroup(r.token) : null,
      ttoken: r.kind === "Transfer" ? r.token : null,
      sign: r.sign ?? null,
      variant: r.variant ?? null,
      policyKnown: r.policy_before_known === true,
      mismatch: r.mismatch === true,
    };
  })
  .sort((a, b) => cmpStr(a.dao, b.dao) || a.pid - b.pid);

const sel = new Map();
const add = (x, stratum) => {
  if (!sel.has(x.id)) sel.set(x.id, { x, strata: [] });
  sel.get(x.id).strata.push(stratum);
};

// Round-robin over groups so a draw spreads across DAOs, receivers or tokens before it repeats one.
function spreadOrder(list, rng, keyFn) {
  const groups = new Map();
  for (const x of shuffled(list, rng)) {
    const k = keyFn(x);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  }
  const lists = [...groups.values()];
  const out = [];
  for (let r = 0; out.length < list.length; r++) for (const g of lists) if (r < g.length) out.push(g[r]);
  return out;
}

// Test-named DAOs fill at most 20 percent of a stratum of 5 or more, and none of a smaller one,
// unless nothing else is left.
function take(stratum, pool, n, opts = {}) {
  if (n <= 0) return [];
  const avail = pool.filter((x) => !sel.has(x.id));
  const rng = streamFor(stratum);
  const order = opts.key ? spreadOrder(avail, rng, opts.key) : shuffled(avail, rng);
  const cap = opts.testCap ?? (n >= 5 ? Math.floor(n * 0.2) : 0);
  const out = [];
  let tests = 0;
  for (const x of order) {
    if (out.length >= n) break;
    if (x.test) { if (tests >= cap) continue; tests++; }
    out.push(x);
  }
  if (out.length < n) {
    const have = new Set(out.map((x) => x.id));
    for (const x of order) { if (out.length >= n) break; if (!have.has(x.id)) out.push(x); }
  }
  for (const x of out) add(x, stratum);
  return out;
}

const inSel = (pool) => pool.filter((x) => sel.has(x.id));

// Draws per status so a kind covers every outcome; a shortfall is filled from the rest of the pool.
function takePlan(stratum, pool, plan, opts = {}) {
  let want = 0;
  for (const [st, n] of Object.entries(plan)) {
    want += n;
    const have = inSel(pool).filter((x) => x.status === st).length;
    take(stratum + ":" + st, pool.filter((x) => x.status === st), n - have, opts);
  }
  const extra = want - inSel(pool).length;
  if (extra > 0) take(stratum + ":rest", pool, extra, opts);
}

// At least `min` chosen records satisfy pred; records chosen by earlier strata count.
function ensure(stratum, pool, pred, min, opts = {}) {
  const inPool = new Set(pool.map((x) => x.id));
  const have = [...sel.values()].filter((e) => inPool.has(e.x.id) && pred(e.x)).length;
  take(stratum, pool.filter(pred), min - have, opts);
}

const ofKind = (k) => population.filter((x) => x.k === k);
const FC = ofKind("FunctionCall");

// Records the census found with a description at odds with their kind are all taken.
const forced = population.filter((x) => x.mismatch);
for (const x of forced) add(x, "mismatch");

for (const k of ["ChangePolicyAddOrUpdateRole", "ChangePolicyRemoveRole", "ChangePolicyUpdateDefaultVotePolicy", "FactoryInfoUpdate", "Vote"]) {
  for (const x of ofKind(k)) add(x, "all:" + k);
}

const cpAll = ofKind("ChangePolicy");
takePlan("ChangePolicy:known", cpAll.filter((x) => x.policyKnown), { Approved: 12, Rejected: 5, InProgress: 3 }, { key: (x) => x.dao });
takePlan("ChangePolicy:unknown", cpAll.filter((x) => !x.policyKnown), { Approved: 7, Rejected: 2, InProgress: 1 }, { key: (x) => x.dao });
takePlan("ChangePolicyUpdateParameters", ofKind("ChangePolicyUpdateParameters"), { Approved: 4, Rejected: 2, InProgress: 2 }, { key: (x) => x.dao });
takePlan("AddMemberToRole", ofKind("AddMemberToRole"), { Approved: 6, Rejected: 2, InProgress: 1, Expired: 1 }, { key: (x) => x.dao });
takePlan("RemoveMemberFromRole", ofKind("RemoveMemberFromRole"), { Approved: 6, Expired: 1, InProgress: 1 }, { key: (x) => x.dao });
takePlan("ChangeConfig", ofKind("ChangeConfig"), { Approved: 5, Rejected: 2, InProgress: 1 }, { key: (x) => x.dao });
takePlan("UpgradeSelf", ofKind("UpgradeSelf"), { Approved: 5, InProgress: 1 }, { key: (x) => x.dao });
takePlan("UpgradeRemote", ofKind("UpgradeRemote"), { Approved: 6, InProgress: 1, Expired: 1 }, { key: (x) => x.receiver || x.dao });

const TR = ofKind("Transfer");
const TRANSFER_PLAN = {
  NEAR: { Approved: 11, Rejected: 3, Failed: 1, InProgress: 3 },
  USDC: { Approved: 6, Rejected: 1, Failed: 2, InProgress: 1 },
  USDT: { Approved: 5, Failed: 1, InProgress: 2 },
  other: { Approved: 8, Rejected: 2, Failed: 2, InProgress: 2 },
};
for (const [g, plan] of Object.entries(TRANSFER_PLAN)) {
  takePlan("Transfer:" + g, TR.filter((x) => x.tgroup === g), plan, { key: g === "other" ? (x) => x.ttoken : (x) => x.dao });
}

const pairCount = {};
for (const x of FC) for (const pr of x.pairs) pairCount[pr] = (pairCount[pr] || 0) + 1;
const top20 = Object.entries(pairCount).sort((a, b) => b[1] - a[1] || cmpStr(a[0], b[0])).slice(0, 20).map((e) => e[0]);
// The 20 most common receiver and method pairs the census reported. A different list means the
// index is not the census the sample was drawn from.
const EXPECTED_TOP20 = [
  "v1.signer::sign", "intents.near::mt_transfer", "intents.near::add_public_key", "wrap.near::near_deposit", "wrap.near::ft_transfer",
  "intents.near::ft_withdraw", USDC + "::ft_transfer", "bulkpayment.near::approve_list", USDC + "::ft_transfer_call", "wrap.near::ft_transfer_call",
  "contract.main.burrow.near::add_asset_farm_reward", "contract.main.burrow.near::update_asset_limit", "contract.main.burrow.near::update_asset",
  "intents.near::mt_transfer_call", "contract.main.burrow.near::execute", "omft.near::ft_deposit", "nearone.pool.near::withdraw_all",
  "nearone.pool.near::unstake", "near-prime-public.poolv1.near::unstake", "near-prime-public.poolv1.near::withdraw_all",
];
if (JSON.stringify([...top20].sort()) !== JSON.stringify([...EXPECTED_TOP20].sort())) throw new Error("the top 20 receiver and method pairs differ from the census");

const SIGNER = "v1.signer::sign";
const signAll = FC.filter((x) => x.pairs.includes(SIGNER));
const signBy = (c) => signAll.filter((x) => x.sign === c);
const variant = (x) => x.variant;
take("sign:auth", signBy("auth"), 5, { key: (x) => x.dao });
take("sign:bulk", signBy("bulk"), 1);
take("sign:bulk-auth", signBy("bulk-auth"), 5, { key: (x) => x.dao });
takePlan("sign:single", signBy("single"), { Approved: 3, Rejected: 1, InProgress: 1, Failed: 1 }, { key: variant });
take("sign:other", signBy("other"), 3, { key: variant });

for (const pair of top20) {
  if (pair === SIGNER) continue;
  ensure("pair:" + pair, FC, (x) => x.pairs.includes(pair), 3, { key: (x) => x.dao });
}
const top20Receivers = new Set(top20.map((p) => p.split("::")[0]));
const outside = FC.filter((x) => !top20Receivers.has(x.receiver));
const outsideSet = new Set(outside.map((x) => x.id));
ensure("outside-top20", outside, (x) => outsideSet.has(x.id), 15, { key: (x) => x.receiver, testCap: 3 });
ensure("deposit-above-1-yocto", FC, (x) => x.deposit1, 10, { key: (x) => x.pairs[0] });

for (const [st, min] of [["Rejected", 8], ["Failed", 8], ["InProgress", 8], ["Expired", 1]]) {
  ensure("FunctionCall:status:" + st, FC, (x) => x.status === st, min, { key: (x) => x.dao });
}
take("FunctionCall:fill", FC, 120 - inSel(FC).length, { key: (x) => x.dao });

ensure("dao-version-before-3.2", population, (x) => x.ver !== "3.2", 10, { key: (x) => x.dao });

const need = TARGET - sel.size;
if (need < 0) throw new Error("the quotas already exceed the target: " + sel.size);
take("topup", population, need, { testCap: Math.floor(need * 0.2) });

const final = [...sel.values()].map((e) => e.x).sort((a, b) => cmpStr(a.id, b.id));
const fail = [];
const expect = (ok, msg) => { if (!ok) fail.push(msg); };
expect(final.length === TARGET, "size " + final.length);
expect(new Set(final.map((x) => x.id)).size === final.length, "duplicate ids");
const kindsInSample = new Set(final.map((x) => x.k));
for (const k of new Set(population.map((x) => x.k))) expect(kindsInSample.has(k), "kind missing " + k);
expect(final.filter((x) => !x.test).length >= 0.75 * final.length, "non-test share below 75 percent");
expect(final.filter((x) => x.pairs.includes(SIGNER)).length >= 20, "signer under 20");
for (const pair of top20) expect(final.filter((x) => x.pairs.includes(pair)).length >= 3, "pair under 3: " + pair);
expect(final.filter((x) => outsideSet.has(x.id)).length >= 15, "outside top 20 under 15");
expect(final.filter((x) => x.deposit1).length >= 10, "deposit above 1 under 10");
expect(final.filter((x) => x.ver !== "3.2").length >= 10, "pre-3.2 under 10");
for (const x of forced) expect(sel.has(x.id), "mismatch record missing " + x.id);
const quotaFloor = { Transfer: 50, FunctionCall: 120, ChangePolicy: 30, ChangePolicyUpdateParameters: 8, AddMemberToRole: 10, RemoveMemberFromRole: 8, ChangeConfig: 8, UpgradeSelf: 6, UpgradeRemote: 8 };
for (const [k, n] of Object.entries(quotaFloor)) expect(final.filter((x) => x.k === k).length >= n, "kind quota " + k);
if (fail.length) {
  console.error("draw: the quotas are not met: " + fail.join("; "));
  process.exit(1);
}

const drawn = final.map((x) => x.id);
if (!checkMode) {
  process.stdout.write(drawn.join("\n") + "\n");
  process.exit(0);
}

const published = fs
  .readFileSync(SAMPLE, "utf8")
  .split("\n")
  .filter((l) => l !== "")
  .map((l) => JSON.parse(l).id)
  .sort(cmpStr);
const pub = new Set(published);
const mine = new Set(drawn);
const onlyDrawn = drawn.filter((i) => !pub.has(i));
const onlyPublished = published.filter((i) => !mine.has(i));
const indexHash = crypto.createHash("sha256").update(indexBytes).digest("hex");
console.log(`index: ${population.length} proposals in ${new Set(population.map((x) => x.dao)).size} DAOs, ${indexBytes.length} bytes, sha256 ${indexHash}`);
if (onlyDrawn.length === 0 && onlyPublished.length === 0 && published.length === drawn.length) {
  console.log(`draw: the ${drawn.length} ids drawn with seed ${SEED} are the ${published.length} ids in eval/real/sample.jsonl`);
  process.exit(0);
}
console.log(`draw: ${drawn.length} drawn, ${published.length} published, ${onlyDrawn.length} only drawn, ${onlyPublished.length} only published`);
for (const i of onlyDrawn) console.log("  only drawn:     " + i);
for (const i of onlyPublished) console.log("  only published: " + i);
process.exit(1);
