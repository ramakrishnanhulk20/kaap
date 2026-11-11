// `kaap census` against a recorded mainnet run of --sample 5: the six headline lines, the request
// rate, and what it never reads. It does not prove the numbers of a full scan (only a live run
// does, and a full run takes about a quarter of an hour), and it does not re-derive each number by
// a second method.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sampleOf } from '../src/census.js';
import { Core } from '../src/core.js';
import { RateLimiter } from '../src/limiter.js';
import { main } from '../src/main.js';
import type { HttpRequest } from '../src/net.js';
import { REQUESTS_PER_SECOND } from '../src/caps.js';
import { fakeClock, load, replay, REPO_ROOT } from './replay.js';

async function run() {
  const fx = load('census-sample-5.json');
  const log: HttpRequest[] = [];
  const out: string[] = [];
  const clock = fakeClock();
  const limiter = new RateLimiter(REQUESTS_PER_SECOND, clock);
  const code = await main(fx.argv, { transport: replay(fx, log), clock, limiter, loadCore: () => Core.load(), repoRoot: REPO_ROOT }, { out: (t) => out.push(t), err: (t) => out.push(t) });
  return { code, out: out.join('\n'), log, granted: limiter.granted };
}

test('census --sample 5 prints the six headline numbers in the README wording', async () => {
  const { code, out } = await run();
  assert.equal(code, 0, out);
  assert.match(out, /^kaap census: Sputnik DAOs on NEAR mainnet, read live$/m);
  assert.match(out, /^scope: a sample of 5 of the [\d,]+ DAOs made by sputnik-dao\.near: the first 5 by the sha256 of their names, the same sample on every run$/m);
  assert.match(out, /^1\. [\d,]+ DAOs exist\. Of the 5 scanned, \d ever got a proposal, \d were active in the last year and \d in the last 90 days\.$/m);
  assert.match(out, /^2\. [\d,]+ proposals in the last year: (\d+%|n\/a) contract calls, (\d+%|n\/a) plain transfers, (\d+%|n\/a) policy changes\.$/m);
  assert.match(out, /^3\. [\d,]+ of the contract calls \((\d+%|n\/a)\) ask the DAO to sign a hash through Chain Signatures/m);
  assert.match(out, /^4\. [\d,]+ of those hash-only proposals were approved, [\d,]+ of them by a single voter\.$/m);
  assert.match(out, /^5\. (\d+%|n\/a) of approved proposals \([\d,]+ of [\d,]+\) carry exactly one vote\.$/m);
  assert.match(out, /^6\. [\d,]+ of the \d+ DAOs active in the last year \((\d+%|n\/a)\) run Sputnik code older than 3\.2/m);
});

test('census never asks for more than 5 requests in any second', async () => {
  assert.equal(REQUESTS_PER_SECOND, 5);
  const { log, granted } = await run();
  assert.equal(granted.length, log.length, 'every request waited for a slot');
  assert.ok(granted.length > 10);
  for (let i = 5; i < granted.length; i++) {
    assert.ok((granted[i] as number) - (granted[i - 5] as number) >= 1000, `requests ${i - 5} to ${i} fell inside one second`);
  }
});

test('census reads no policy and no votes-needed figure, only the factory, counters, proposals and accounts', async () => {
  const { log, out } = await run();
  const methods = new Set(
    log
      .filter((r) => r.method === 'POST')
      .map((r) => (JSON.parse(r.body ?? '{}') as { params?: { method_name?: string; request_type?: string } }).params)
      .map((p) => p?.method_name ?? p?.request_type ?? 'block'),
  );
  const allowed = new Set(['block', 'get_contracts_metadata', 'get_dao_list', 'get_last_proposal_id', 'get_proposals', 'view_account']);
  for (const m of methods) assert.ok(allowed.has(m), m);
  assert.ok(!methods.has('get_policy'));
  assert.doesNotMatch(out, /threshold|quorum|votes? (are )?needed|approvals? needed/i);
});

test('the sample is the same on every run, whatever order the factory lists DAOs in', () => {
  const daos = ['a.sputnik-dao.near', 'b.sputnik-dao.near', 'c.sputnik-dao.near', 'd.sputnik-dao.near', 'e.sputnik-dao.near'];
  const once = sampleOf(daos, 2);
  assert.deepEqual(sampleOf([...daos].reverse(), 2), once);
  assert.equal(once.length, 2);
  assert.deepEqual(sampleOf(daos, null), daos);
});
