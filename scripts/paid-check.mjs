#!/usr/bin/env node
// Pays for Kaap's sealed check the way a stranger would, through both of OutLayer's doors, and
// prints what each payment bought. Over HTTPS with a payment key: one cent gets a verdict, half a
// cent and nothing get `payment_below_price`. On chain from the payer's own account: the stablecoin
// is deposited, one cent is attached to request_execution and Kaap's on-chain earnings must rise by
// exactly that, and a run with nothing attached is refused. Every verdict is checked by
// packages/sealed/tools/check-output.mjs and must be signed by a key that is not the one Kaap's
// guard accepts. Exit code 0 only when every call answered as above.
//
//   node scripts/paid-check.mjs
//   node scripts/paid-check.mjs --version-key <sha256>
//     One HTTPS call pinned to that build with nothing attached, printing OutLayer's answer. Once a
//     build is removed from the project this must be refused by OutLayer, exit 0; exit 1 if it ran.
//
// Testnet only, inside WSL, where the payer's key lives (~/.near-credentials/testnet). Needs
// KAAP_TEST_PAYMENT_KEY in .env (owner:nonce:secret; never printed) for a key holding at least
// 25000 micro-USD, and the payer holding 10000 micro-USD of usdc.fakes.testnet for the chain call.
// That token's own `mint` is open on testnet. One run spends about 0.019 dollars from the key, 0.01
// of the payer's stablecoin and 0.05 testnet NEAR. The HTTPS requests and responses are saved to
// KAAP_PAID_OUT (default ~/kaap-sealed-testnet/paid/<time>), because OutLayer keeps only their
// hashes and outlayer-verify needs the bytes.
//
// What this does not cover: that a paid run writes no public evidence (packages/sealed/tests only);
// withdrawing HTTPS earnings, which OutLayer has not shipped, so only its public view is read; and
// anything beyond one payer and one proposal, one call after another.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const { REPO, TGAS, MILLI_NEAR, accountFor, burnt, call, events, refusal, returned, sleep, txLink, viewFinal } = await import('./setup-demo-dao.mjs');

const API = 'https://testnet-api.outlayer.ai';
const OUTLAYER = 'outlayer.testnet';
const TOKEN = 'usdc.fakes.testnet';
// packages/sealed/src/payment.rs PRICE_MICRO_USD.
const PRICE = 10_000n;
const HTTPS_AMOUNTS = [10_000n, 5_000n, 0n];
// The three attached amounts plus room for each call's compute reservation (X-Compute-Limit 10000).
const KEY_NEEDS = 25_000n;
// The M1 proposal and the expiry Kaap's worker sends (packages/worker/src/judge.ts `input`).
const PROPOSAL = 9;
const EXPIRES_IN_MS = 600_000;
// All three limits written out: an empty resource_limits object is never picked up (OutLayer #31).
const LIMITS = { max_instructions: 10_000_000_000, max_memory_mb: 128, max_execution_seconds: 60 };
const CHECK_OUTPUT = join(REPO, 'packages', 'sealed', 'tools', 'check-output.mjs');

const builds = JSON.parse(readFileSync(join(REPO, 'packages', 'sealed', 'testnet.json'), 'utf8'));
const deployment = JSON.parse(readFileSync(join(REPO, 'deployments', 'testnet.json'), 'utf8'));
const [owner, projectName] = builds.project_id.split('/');
const kaapKey = deployment.accepted_key;
const input = { v: 1, network: 'testnet', guard: deployment.guard.account_id, dao: deployment.dao.account_id, proposal_id: PROPOSAL, expires_in_ms: EXPIRES_IN_MS };

const failures = [];
const expect = (holds, what) => {
  if (!holds) failures.push(what);
  console.log(`    ${holds ? 'ok' : 'FAIL'}: ${what}`);
};

const near = (yocto) => (Number(yocto) / 1e24).toFixed(7);
const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** The key from .env, checked for shape. Only its owner and nonce are ever shown. */
function paymentKey() {
  const value = process.env.KAAP_TEST_PAYMENT_KEY ?? '';
  const m = /^([a-z0-9._-]+\.testnet):(\d+):[0-9a-f]{64}$/.exec(value);
  if (!m) throw new Error('KAAP_TEST_PAYMENT_KEY in .env is missing or is not <account>.testnet:<nonce>:<64 hex characters>');
  return { value, payer: m[1], nonce: Number(m[2]) };
}

async function getJson(path, key) {
  const res = await fetch(`${API}${path}`, { headers: key ? { 'x-payment-key': key.value } : {}, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  return { http: res.status, text, body: parse(text) };
}

/** A call that outlived the synchronous window, or a 500 that left it queued, may still run and be
 *  charged. Following it by id is the only way to learn its answer without paying twice. */
async function follow(key, callId) {
  for (let i = 0; i < 60; i++) {
    await sleep(3_000);
    const r = await getJson(`/calls/${callId}`, key);
    if (r.http === 200 && r.body?.status && r.body.status !== 'pending') return r;
  }
  throw new Error(`call ${callId} was still pending after 180 s`);
}

async function httpsCall(key, attached, extra = {}) {
  const started = Date.now();
  const res = await fetch(`${API}/call/${owner}/${projectName}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-payment-key': key.value, 'x-attached-deposit': attached.toString() },
    body: JSON.stringify({ input, ...extra }),
    signal: AbortSignal.timeout(200_000),
  });
  let text = await res.text();
  let http = res.status;
  let body = parse(text);
  if ((http === 408 || http >= 500) && typeof body?.call_id === 'string') {
    console.log(`    HTTP ${http} for call ${body.call_id}; following it by id, never sending it again`);
    ({ http, text, body } = await follow(key, body.call_id));
  }
  return { http, text, body, wallMs: Date.now() - started };
}

/** OutLayer may hand the job's line back parsed or as a string (BRIEF C4). */
function jobOf(output) {
  if (output === undefined || output === null) return { shape: String(output), text: null, job: null };
  if (typeof output === 'string') return { shape: 'string', text: output, job: parse(output) };
  return { shape: 'object', text: JSON.stringify(output), job: output };
}

/** A verdict passes check-output.mjs and is signed by the payer's own key, never Kaap's; a refusal
 *  is `payment_below_price` with no signature. Returns the words for the call's line. */
function judge(job, file, wantVerdict) {
  if (wantVerdict) {
    const run = spawnSync(process.execPath, [CHECK_OUTPUT, file, '--dao', input.dao, '--id', String(PROPOSAL), '--network', 'testnet', '--guard', input.guard], { encoding: 'utf8' });
    const r = parse(run.stdout) ?? { check: 'failed', why: (run.stderr || run.stdout || '').slice(0, 200) };
    expect(r.check === 'passed', `the verdict decodes and its signature verifies under the printed key${r.why ? ` (${r.why})` : ''}`);
    expect(typeof r.public_key === 'string' && r.public_key !== kaapKey, `it is signed by ${r.public_key}, not Kaap's ${kaapKey}`);
    expect(r.verdict?.ai_status === 'unavailable', `ai_status is ${r.verdict?.ai_status}: a paid run gets no AI key`);
    return { words: `verdict risk ${r.verdict?.risk} floor ${r.verdict?.floor} findings [${(r.verdict?.findings ?? []).join(', ')}] ai ${r.verdict?.ai_status}`, publicKey: r.public_key, verdict: r.verdict };
  }
  expect(job?.status === 'refused' && job?.reason === 'payment_below_price', `refused with ${job?.reason}`);
  expect(job !== null && job.signature === undefined && job.verdict === undefined, 'no signature and no verdict');
  return { words: `refused ${job?.reason}: ${job?.detail}` };
}

async function chainRun(from, params) {
  const args = {
    source: { Project: { project_id: builds.project_id, version_key: null } },
    input_data: JSON.stringify(input),
    response_format: 'Json',
    resource_limits: LIMITS,
    ...(params ? { params } : {}),
  };
  const started = Date.now();
  const { hash, outcome, failure } = await call(from, OUTLAYER, 'request_execution', args, 300n * TGAS, 20n * MILLI_NEAR);
  const value = outcome.status?.SuccessValue;
  return {
    hash,
    failure,
    wallMs: Date.now() - started,
    text: value === undefined ? null : Buffer.from(value, 'base64').toString('utf8'),
    completed: events(outcome).find((e) => e.event === 'execution_completed')?.data?.[0] ?? null,
    gas: burnt(outcome),
  };
}

const earningsOnChain = async () => BigInt(await viewFinal(OUTLAYER, 'get_developer_earnings', { account_id: owner }));

async function paidRun(key) {
  const out = process.env.KAAP_PAID_OUT || join(homedir(), 'kaap-sealed-testnet', 'paid', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(out, { recursive: true });
  console.log(`WO-05e paid calls, ${new Date().toISOString()}, OutLayer testnet`);
  console.log(`project ${builds.project_id}, active build ${builds.active_version}`);
  console.log(`payer ${key.payer}, payment key nonce ${key.nonce}, price ${PRICE} micro-USD`);
  console.log(`input ${JSON.stringify(input)}`);
  console.log(`saved payloads: ${out}`);

  const keyBefore = await getJson(`/public/payment-keys/${key.payer}/${key.nonce}/balance`);
  const available = BigInt(keyBefore.body?.available ?? '0');
  console.log(`payment key before: ${keyBefore.text}`);
  if (available < KEY_NEEDS) throw new Error(`the payment key holds ${available} micro-USD; top it up to at least ${KEY_NEEDS} first`);
  const httpsEarnedBefore = await getJson(`/public/project-earnings/${owner}`);
  console.log(`HTTPS earnings before: ${httpsEarnedBefore.text}`);

  const record = { at: new Date().toISOString(), payer: key.payer, nonce: key.nonce, input, calls: [] };
  let n = 0;
  for (const amount of HTTPS_AMOUNTS) {
    n += 1;
    const r = await httpsCall(key, amount);
    const { shape, text, job } = jobOf(r.body?.output);
    const name = `https-${amount}`;
    writeFileSync(join(out, `${name}.input.json`), JSON.stringify(input));
    writeFileSync(join(out, `${name}.response.json`), r.text);
    writeFileSync(join(out, `${name}.output.json`), JSON.stringify(r.body?.output ?? null));
    if (text !== null) writeFileSync(join(out, `${name}.job.json`), text);
    console.log(`[${n}] https  X-Attached-Deposit ${amount}  call ${r.body?.call_id}  HTTP ${r.http} ${r.body?.status}  compute_cost ${r.body?.compute_cost} micro-USD  instructions ${r.body?.instructions}  worker ${r.body?.time_ms} ms, wall ${r.wallMs} ms  output as ${shape}`);
    expect(r.http === 200 && r.body?.status === 'completed', `HTTP 200 and status completed${r.body?.error ? ` (error: ${r.body.error})` : ''}`);
    const verdict = amount >= PRICE;
    const j = job ? judge(job, join(out, `${name}.job.json`), verdict) : (expect(false, 'the response carries the job\'s output'), { words: 'no output' });
    console.log(`    ${j.words}`);
    record.calls.push({ path: 'https', amount: amount.toString(), call_id: r.body?.call_id, http: r.http, status: r.body?.status, compute_cost: r.body?.compute_cost, instructions: r.body?.instructions, time_ms: r.body?.time_ms, wall_ms: r.wallMs, output_shape: shape, attestation_url: r.body?.attestation_url, result: j.words, public_key: j.publicKey });
  }

  let httpsEarnedAfter = httpsEarnedBefore;
  for (let i = 0; i < 12 && httpsEarnedAfter.text === httpsEarnedBefore.text; i++) {
    await sleep(5_000);
    httpsEarnedAfter = await getJson(`/public/project-earnings/${owner}`);
  }
  const httpsHistory = await getJson(`/public/project-earnings/${owner}/history?limit=10`);
  const earnedDelta = BigInt(httpsEarnedAfter.body?.total_earned ?? '0') - BigInt(httpsEarnedBefore.body?.total_earned ?? '0');
  console.log(`HTTPS earnings after: ${httpsEarnedAfter.text}`);
  console.log(`HTTPS earnings history: ${httpsHistory.text.slice(0, 1500)}`);
  console.log(`HTTPS total_earned changed by ${earnedDelta} micro-USD (attached over the three calls: ${HTTPS_AMOUNTS.reduce((a, b) => a + b, 0n)})`);
  record.https_earnings = { before: httpsEarnedBefore.body, after: httpsEarnedAfter.body, history: httpsHistory.body, total_earned_delta: earnedDelta.toString() };

  const from = accountFor(key.payer);
  const deposited = BigInt(await viewFinal(OUTLAYER, 'get_user_stablecoin_balance', { account_id: key.payer }));
  if (deposited < PRICE) {
    const short = PRICE - deposited;
    const d = await call(from, TOKEN, 'ft_transfer_call', { receiver_id: OUTLAYER, amount: short.toString(), msg: JSON.stringify({ action: 'deposit_balance' }) }, 100n * TGAS, 1n);
    if (d.failure) throw new Error(`the stablecoin deposit failed in ${d.hash}: ${refusal(d.failure)}`);
    console.log(`deposited ${short} micro-USD with OutLayer for the chain call: ${txLink(d.hash)} (token kept ${JSON.stringify(returned(d.outcome))})`);
    record.deposit_tx = d.hash;
  }
  const balanceBefore = BigInt(await viewFinal(OUTLAYER, 'get_user_stablecoin_balance', { account_id: key.payer }));
  console.log(`payer's stablecoin balance with OutLayer: ${balanceBefore}`);

  for (const attached of [PRICE, null]) {
    n += 1;
    const earnedBefore = await earningsOnChain();
    const c = await chainRun(from, attached === null ? null : { attached_usd: attached.toString() });
    const earnedAfter = await earningsOnChain();
    const name = `chain-${attached ?? 'none'}`;
    if (c.text !== null) writeFileSync(join(out, `${name}.job.json`), c.text);
    writeFileSync(join(out, `${name}.tx.txt`), `${c.hash}\n`);
    const status = c.failure ? `transaction failed: ${refusal(c.failure)}` : c.completed?.success ? 'completed' : `run failed: ${c.completed?.error_message}`;
    console.log(`[${n}] chain  attached_usd ${attached ?? 'none'}  tx ${c.hash}  ${status}  OutLayer charge ${near(c.completed?.payment_charged ?? 0)} NEAR, gas ${near(c.gas)} NEAR  instructions ${c.completed?.resources_used?.instructions}  worker ${c.completed?.resources_used?.time_ms} ms, wall ${c.wallMs} ms`);
    console.log(`    ${txLink(c.hash)}`);
    expect(!c.failure && c.completed?.success === true && c.text !== null, 'the transaction and the run both succeeded');
    const j = c.text !== null ? judge(parse(c.text), join(out, `${name}.job.json`), attached !== null) : { words: 'no output' };
    console.log(`    ${j.words}`);
    const want = attached ?? 0n;
    console.log(`    developer_earnings of ${owner}: ${earnedBefore} before, ${earnedAfter} after`);
    expect(earnedAfter - earnedBefore === want, `Kaap's on-chain earnings rose by exactly ${want}`);
    record.calls.push({ path: 'chain', amount: attached === null ? 'none' : attached.toString(), tx: c.hash, status, outlayer_charge_yocto: c.completed?.payment_charged, gas_yocto: c.gas.toString(), instructions: c.completed?.resources_used?.instructions, time_ms: c.completed?.resources_used?.time_ms, wall_ms: c.wallMs, result: j.words, public_key: j.publicKey, developer_earnings: { before: earnedBefore.toString(), after: earnedAfter.toString() } });
  }
  const balanceAfter = BigInt(await viewFinal(OUTLAYER, 'get_user_stablecoin_balance', { account_id: key.payer }));
  console.log(`payer's stablecoin balance with OutLayer: ${balanceBefore} before the chain calls, ${balanceAfter} after`);

  const keyAfter = await getJson(`/public/payment-keys/${key.payer}/${key.nonce}/balance`);
  console.log(`payment key after: ${keyAfter.text}`);
  record.key = { before: keyBefore.body, after: keyAfter.body };
  const paidKeys = [...new Set(record.calls.map((c) => c.public_key).filter(Boolean))];
  console.log(`verdict keys on the paid runs: ${paidKeys.join(', ')}`);
  writeFileSync(join(out, 'record.json'), JSON.stringify(record, null, 1) + '\n');
  console.log(failures.length === 0 ? 'RESULT: pass' : `RESULT: FAIL, ${failures.length} check(s): ${failures.join('; ')}`);
  return failures.length === 0;
}

async function pinnedRun(key, sha) {
  if (!/^[0-9a-f]{64}$/.test(sha ?? '')) throw new Error('usage: node scripts/paid-check.mjs --version-key <64 hex characters>');
  const listed = (await viewFinal(OUTLAYER, 'list_versions', { project_id: builds.project_id })).map((v) => `${v.wasm_hash.slice(0, 8)}${v.is_active ? ' (active)' : ''}`);
  console.log(`WO-05e pinned call, ${new Date().toISOString()}: version_key ${sha}`);
  console.log(`versions listed on ${OUTLAYER}: ${listed.join(', ')}`);
  const r = await httpsCall(key, 0n, { version_key: sha });
  console.log(`HTTP ${r.http}: ${r.text.slice(0, 800)}`);
  // The spec names a 400 `invalid_version_key`. Testnet answered a removed build with HTTP 200,
  // status failed, no output and nothing run (11 Nov), so both count; any output or work does not.
  const ran = r.body?.status === 'completed' || (r.body?.output ?? null) !== null || Number(r.body?.instructions ?? 0) > 0;
  const refused = (r.http >= 400 && r.http < 500) || (r.http === 200 && r.body?.status === 'failed' && !ran);
  console.log(refused ? 'RESULT: refused by OutLayer' : 'RESULT: FAIL, OutLayer did not refuse the pinned build');
  return refused;
}

try {
  const key = paymentKey();
  const pinned = process.argv[2] === '--version-key';
  process.exit((pinned ? await pinnedRun(key, process.argv[3]) : await paidRun(key)) ? 0 : 1);
} catch (e) {
  console.log(`RESULT: FAIL: ${e?.message ?? e}`);
  process.exit(1);
}
