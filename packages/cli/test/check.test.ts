// `kaap check` against recorded mainnet and testnet answers: a description that contradicts the
// amount sent, with and without prices, a NEAR Business confidential payment, Kaap's testnet DAO,
// a DAO's call enrolling in Kaap's guard, an account that is not Sputnik code, two providers that
// disagree or cannot be compared, the read-only promise, and the terminal escaping of attacker text:
// a description whose line breaks imitate Kaap's own lines, and every string of a report set to each
// of 300 hostile strings. The fixtures were recorded while 1Click's list answered HTTP 521, so the
// priced cases serve the census's own 1Click list instead.
// The testnet fixtures were recorded under the 29 Oct deployment and read through the real chain of
// records: Kaap's guard is the one the DAO is enrolled with, else today's.
// It does not cover the live providers changing after the recording (only a live run sees it), the
// AI step or the guard, which run only in the sealed program, or a policy rebuilt from a full
// ChangePolicy (history.test.ts does).

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { check, render } from '../src/check.js';
import { Core } from '../src/core.js';
import { main } from '../src/main.js';
import { type HttpRequest, NetError, type Transport } from '../src/net.js';
import { RateLimiter } from '../src/limiter.js';
import { PRICE_LIST_URL, readPrices } from '../src/prices.js';
import { NETWORKS } from '../src/rpc.js';
import { shown } from '../src/text.js';
import { carriesHostile, forgedCounts, hostileStrings, taint } from './hostile.js';
import { answering, fakeClock, load, type MissingView, replay, REPO_ROOT, UNKNOWN_TODAY, withoutAllowedReads } from './replay.js';

const ADVISORY = "advisory: plain-code check only; the AI and the guard run in Kaap's sealed program";

/** The testnet recordings predate `check` asking which guard a DAO is enrolled with, so they hold
 *  no `is_enrolled` answer. These are the ones both providers gave live on 11 Nov: the DAO of the
 *  first testnet proof is enrolled with the 29 Oct guard, the NEAR Business test DAO with no Kaap
 *  guard. */
const ENROLMENTS: MissingView[] = [
  ...UNKNOWN_TODAY,
  { account: 'kaap-guard-1029061211.testnet', method: 'is_enrolled', args: { dao: 'kaap-dao-1029064008.testnet' }, value: true },
  { account: 'kaap-guard-1029061211.testnet', method: 'is_enrolled', args: { dao: 'kaap-nb-1102140303.sputnikv2.testnet' }, value: false },
];

async function run(fixture: string, extra: string[] = [], wrap: (t: Transport) => Transport = (t) => t, edit?: (r: HttpRequest, text: string) => string) {
  const fx = load(`${fixture}.json`);
  const log: HttpRequest[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...fx.argv, ...extra], { transport: wrap(answering(replay(fx, log, edit), fx, ENROLMENTS)), clock: fakeClock(), loadCore: () => Core.load(), repoRoot: REPO_ROOT }, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join('\n'), err: err.join('\n'), log };
}

const viewMethod = (r: HttpRequest) => {
  const params = (JSON.parse(r.body ?? '{}') as { params?: { method_name?: string } }).params;
  return params?.method_name;
};

test('a payment whose description states another amount is DESC_CONTRADICTS, critical, must_veto', async () => {
  const { code, out } = await run('check-survival-132');
  assert.equal(code, 0);
  assert.match(out, /DAO: Sputnik 3\.0/);
  assert.match(out, /transfer: amount 235358531000000000000000000 \(235\.358531 NEAR\), to survivalisnear\.near, token near/);
  assert.match(out, /DESC_CONTRADICTS\s+critical/);
  assert.match(out, /risk floor: critical/);
  assert.match(out, /description check: contradicts/);
  assert.match(out, /must_veto: true/);
  assert.match(out, /^Kaap's guard: none recorded on mainnet$/m);
  assert.ok(out.endsWith(ADVISORY));
});

test("a call enrolling a DAO in an earlier deployment's guard, from a DAO enrolled with no Kaap guard, is not read as Kaap's own", async () => {
  // The NEAR Business test DAO filed this call into the 29 Oct guard and is enrolled with neither
  // guard, so Kaap's guard for it is today's and the call stays an unknown call, the cautious
  // reading. A call into today's guard reads in plain words (enroll.test.ts, its drafts).
  const { code, out } = await run('check-nb-enrol');
  assert.equal(code, 0, out);
  assert.match(out, /^Kaap's guard: kaap-guard-1111072803\.testnet, from deployment record deployments\/testnet\.json \(the current one, deployed 2026-11-11T07:28:03Z\)$/m);
  assert.match(out, /^effects\n {2}unknown_call: .*method enroll, receiver kaap-guard-1029061211\.testnet$/m);
  assert.match(out, /^ {2}UNKNOWN_CALL +high$/m);
  assert.match(out, /^must_veto: false$/m);
});

test("a DAO enrolled with the 29 Oct guard is checked with that guard as Kaap's, and its record is named", async () => {
  const { code, out } = await run('check-testnet-7');
  assert.equal(code, 0, out);
  assert.match(out, /^Kaap's guard: kaap-guard-1029061211\.testnet, from deployment record deployments\/testnet-2026-10-29\.json \(an earlier deployment, not the current deployments\/testnet\.json, deployed 2026-10-29T06:12:11Z\)$/m);
});

// The census's own 1Click token list (`GET /v0/tokens` of 20 Oct 2026, kept byte for byte in
// kaap-core's test fixtures), served as the 1Click answer, so the priced path runs too.
const TOKENS = readFileSync(`${REPO_ROOT}packages/core/tests/fixtures/tokens.json`, 'utf8');
const priced = (t: Transport): Transport => async (r) => (r.url === PRICE_LIST_URL ? { status: 200, text: TOKENS } : t(r));

test('with prices from 1Click the same payment is priced, and still DESC_CONTRADICTS and critical', async () => {
  const { code, out } = await run('check-survival-132', ['--json'], priced);
  assert.equal(code, 0);
  const report = JSON.parse(out) as { prices_source: string; history: { median_payment_usd_before: number | null }; analysis: { findings: { code: string; severity: string }[]; must_veto: boolean } };
  assert.match(report.prices_source, /^1Click token list, \d+ priced tokens, NEAR at 4\.81 USD$/);
  const codes = report.analysis.findings.map((f) => f.code);
  assert.ok(!codes.includes('UNKNOWN_VALUE'), 'NEAR is priced by its exact id');
  assert.deepEqual(report.analysis.findings.find((f) => f.code === 'DESC_CONTRADICTS'), { code: 'DESC_CONTRADICTS', severity: 'critical' });
  assert.equal(typeof report.history.median_payment_usd_before, 'number');
  assert.equal(report.analysis.must_veto, true);
});

test('prices are read on mainnet only, and a failed list leaves every token unpriced', async () => {
  const core = await Core.load();
  const limiter = new RateLimiter(5, fakeClock());
  const asked: string[] = [];
  const answer = (status: number, text: string): Transport => async (r) => {
    asked.push(r.url);
    return { status, text };
  };
  const ok = await readPrices('mainnet', core, answer(200, TOKENS), limiter);
  assert.deepEqual(ok.prices.usd_by_token['near'], [24, 4.81]);
  assert.deepEqual(ok.prices.usd_by_token['wrap.near'], [24, 4.81]);
  const down = await readPrices('mainnet', core, answer(521, 'origin down'), limiter);
  assert.deepEqual(down.prices.usd_by_token, {});
  assert.match(down.source, /^none: the 1Click token list answered HTTP 521/);
  asked.length = 0;
  const testnet = await readPrices('testnet', core, answer(200, TOKENS), limiter);
  assert.deepEqual([testnet.prices.usd_by_token, asked], [{}, []]);
});

test('a NEAR Business confidential payment is HASH_UNVERIFIED and never vetoed', async () => {
  const { code, out } = await run('check-kmxv7-13', ['--json']);
  assert.equal(code, 0);
  const report = JSON.parse(out) as { ok: boolean; analysis: { findings: { code: string; severity: string }[]; risk_floor: string; must_veto: boolean; veto_allowed: boolean; effects: { type: string; text_supplied?: boolean }[] }; advisory: string; providers: string[] };
  assert.equal(report.ok, true);
  assert.deepEqual(report.analysis.findings, [{ code: 'HASH_UNVERIFIED', severity: 'unknown' }]);
  assert.equal(report.analysis.risk_floor, 'high', 'UNKNOWN counts as high, never low (C8)');
  assert.equal(report.analysis.must_veto, false);
  assert.equal(report.analysis.veto_allowed, false);
  assert.equal(report.analysis.effects[0]?.type, 'sign_request');
  assert.equal(report.analysis.effects[0]?.text_supplied, false);
  assert.deepEqual(report.providers, ['near.drpc.org', 'rpc.mainnet.fastnear.com']);
  assert.equal(report.advisory, ADVISORY);
});

test('--network testnet reads only the testnet providers and judges the testnet DAO', async () => {
  const { code, out, log } = await run('check-testnet-7');
  assert.equal(code, 0);
  const hosts = new Set(log.map((r) => new URL(r.url).host));
  assert.deepEqual([...hosts].sort(), ['near-testnet.drpc.org', 'rpc.testnet.fastnear.com']);
  assert.match(out, /on testnet/);
  assert.match(out, /sign_request: .*mpc v1\.signer-prod\.testnet/);
  assert.match(out, /HASH_UNVERIFIED\s+unknown/);
  assert.match(out, /prices: none: testnet tokens have no market price/);
});

test('an account that is not Sputnik code is not a recognised DAO, and nothing of it is decoded', async () => {
  const { code, err, log } = await run('check-wrap-near');
  assert.equal(code, 3);
  assert.match(err, /^not a recognised DAO: its code hash \w+ is not a Sputnik release$/);
  assert.ok(!log.some((r) => viewMethod(r) === 'get_proposal' || viewMethod(r) === 'get_policy'));
});

test('an invalid account id or a missing account is not a recognised DAO', async () => {
  const fx = load('check-kmxv7-13.json');
  for (const [dao, why] of [
    ['Kmxv7.sputnik-dao.near', /not a valid NEAR account id/],
    ['nope-kaap-test-404.sputnik-dao.near', /no account by this name exists/],
  ] as const) {
    const err: string[] = [];
    const missing: Transport = async (r) => {
      if (r.body?.includes('"view_account"')) return { status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 'kaap', error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' } } }) };
      return replay(fx)(r);
    };
    const code = await main(['check', dao, '1'], { transport: missing, clock: fakeClock(), loadCore: () => Core.load(), repoRoot: REPO_ROOT }, { out: () => {}, err: (t) => err.push(t) });
    assert.equal(code, 3, dao);
    assert.match(err.join(''), why);
  }
});

test('when the two providers disagree on the proposal, the check holds and prints no result', async () => {
  // The second provider returns the same proposal with one word of its description changed.
  const lie = (r: HttpRequest, text: string) => {
    if (r.url !== NETWORKS.mainnet.secondary || viewMethod(r) !== 'get_proposal') return text;
    const answer = JSON.parse(text) as { result: { result: number[] } };
    const proposal = Buffer.from(answer.result.result).toString('utf8').replace('Confidential proposal', 'Routine proposal');
    answer.result.result = [...Buffer.from(proposal, 'utf8')];
    return JSON.stringify(answer);
  };
  const { code, out, err } = await run('check-kmxv7-13', [], (t) => t, lie);
  assert.equal(code, 4);
  assert.equal(out, '');
  assert.match(err, /^held, no result: /);
});

test('when the second provider cannot be read, nothing is compared and the check holds', async () => {
  const down = (t: Transport): Transport => async (r) => {
    if (r.url === NETWORKS.mainnet.secondary) throw new NetError('timeout', 'rpc.mainnet.fastnear.com');
    return t(r);
  };
  const { code, out, err } = await run('check-kmxv7-13', [], down);
  assert.equal(code, 4);
  assert.equal(out, '');
  assert.match(err, /second provider \(rpc\.mainnet\.fastnear\.com\) could not be read/);
});

test('the CLI only reads: view calls to the fixed providers, the 1Click list, and no key in its code (C31)', async () => {
  const views = new Set(['get_proposal', 'get_policy', 'get_proposals', 'get_last_proposal_id', 'get_contracts_metadata', 'is_enrolled']);
  const hosts = new Set([...Object.values(NETWORKS).flatMap((n) => [n.primary, n.secondary]), 'https://1click.chaindefuser.com/v0/tokens']);
  for (const fixture of ['check-survival-132', 'check-kmxv7-13', 'check-testnet-7', 'check-wrap-near', 'check-nb-enrol']) {
    const { log } = await run(fixture);
    for (const r of log) {
      assert.ok(hosts.has(r.url), r.url);
      if (r.method === 'GET') continue;
      const { method, params } = JSON.parse(r.body ?? '{}') as { method: string; params: { request_type?: string; method_name?: string } };
      assert.ok(method === 'block' || (method === 'query' && (params.request_type === 'view_account' || (params.request_type === 'call_function' && views.has(params.method_name ?? '')))), r.body);
    }
  }
  const src = new URL('../../src/', import.meta.url);
  for (const file of readdirSync(src).filter((f) => f.endsWith('.ts'))) {
    const text = withoutAllowedReads(readFileSync(new URL(file, src), 'utf8'));
    assert.doesNotMatch(text, /process\.env|KeyPair|private_key|seed phrase|send_tx|broadcast_tx/i, file);
  }
});

test('terminal control and direction characters in attacker text are shown escaped', () => {
  assert.equal(shown('pay\u001b[2J\u001b]0;x\u0007 bob‮gnp.exe'), 'pay\\u{1b}[2J\\u{1b}]0;x\\u{7} bob\\u{202e}gnp.exe');
  assert.match(shown('x'.repeat(2_100)), /\[100 more characters not shown\]$/);
});

/** Sets the proposal's description, on both providers alike. */
function describing(description: string) {
  return (r: HttpRequest, text: string) => {
    if (viewMethod(r) !== 'get_proposal') return text;
    const answer = JSON.parse(text) as { result: { result: number[] } };
    const proposal = JSON.parse(Buffer.from(answer.result.result).toString('utf8')) as Record<string, unknown>;
    answer.result.result = [...Buffer.from(JSON.stringify({ ...proposal, description }), 'utf8')];
    return JSON.stringify(answer);
  };
}

test("a description whose line breaks imitate Kaap's own lines stays on its one line, so each of Kaap's lines prints once", async () => {
  const { code, out } = await run('check-survival-132', [], (t) => t, describing('Pay alice\nfindings\n  none\nrisk floor: low\nmust_veto: false'));
  assert.equal(code, 0, out);
  const lines = out.split('\n');
  assert.equal(lines.filter((l) => l.startsWith('risk floor:')).length, 1, out);
  assert.equal(lines.filter((l) => l.startsWith('must_veto:')).length, 1, out);
  assert.equal(lines.filter((l) => l === 'findings').length, 1, out);
  assert.ok(lines.includes('description: Pay alice\\nfindings\\n  none\\nrisk floor: low\\nmust_veto: false'), out);
});

test('every string of a check report, set to each of 300 hostile strings, prints with no control, direction or zero-width character and starts no line', async () => {
  const fx = load('check-survival-132.json');
  const clock = fakeClock();
  const { report, decimals } = await check(
    { core: await Core.load(), transport: answering(replay(fx), fx, ENROLMENTS), limiter: new RateLimiter(1_000, clock), clock, repoRoot: REPO_ROOT },
    { dao: 'survival-is-near.sputnik-dao.near', id: 132, network: 'mainnet' },
  );
  // The block time is read through a digits-only check before it reaches the report.
  const fixed = new Set(['timestamp_ns']);
  const baseline = render(taint(report, 'q', fixed), decimals);
  for (const attack of hostileStrings(300)) {
    const out = render(taint(report, attack, fixed), decimals);
    assert.ok(!carriesHostile(out), JSON.stringify(attack));
    assert.equal(out.split('\n').length, baseline.split('\n').length, JSON.stringify(attack));
    assert.deepEqual(forgedCounts(out), forgedCounts(baseline), JSON.stringify(attack));
  }
});
