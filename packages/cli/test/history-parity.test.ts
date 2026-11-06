// Holds the TypeScript payment rule to kaap-core's copy: this file and
// packages/core/tests/history_before.rs load one fixture and must both give its expected value. The
// proposals go through the CLI's own page reader first, as a live check's do. It does not cover
// paging across a DAO's whole history (check.test.ts does), or proposals that do not read.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { History, Prices } from '../src/core.js';
import { historyBefore, page } from '../src/history.js';
import type { Provider } from '../src/rpc.js';
import { REPO_ROOT } from './replay.js';

interface Parity {
  submission_time: string;
  prices: Prices;
  real_pages: { dao: string; proposals: unknown[] }[];
  hand_made: unknown[];
  expected: History;
}

test('the payment history equals the shared fixture, the same answer kaap-core gives', async () => {
  const fx = JSON.parse(readFileSync(`${REPO_ROOT}packages/core/tests/fixtures/history-parity.json`, 'utf8')) as Parity;
  const list = [...fx.real_pages.flatMap((p) => p.proposals), ...fx.hand_made];
  const provider = { name: 'recorded', view: async () => ({ text: JSON.stringify(list) }) } as unknown as Provider;
  const { proposals, gap } = await page(provider, 'dao.near', 0, list.length, 1);
  assert.equal(gap, false, 'every proposal in the fixture reads');
  assert.deepEqual(historyBefore(proposals, fx.submission_time, fx.prices), fx.expected);
});
