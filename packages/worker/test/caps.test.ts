// The daily ceilings (C29): sealed runs and registry writes per DAO, and NEAR for the whole
// worker, counted from the store so a restart never resets them, with transactions still in flight
// counted at their worst case. Not covered: a second worker process sharing one key, which the
// deployment never runs.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Actor } from '../src/act.ts';
import { CapGuard } from '../src/caps.ts';
import { Health } from '../src/health.ts';
import { Judge } from '../src/judge.ts';
import { worstCase, TGAS } from '../src/near.ts';
import { Reads } from '../src/reads.ts';
import { Store } from '../src/store.ts';
import { Submitter } from '../src/submit.ts';
import { DAO, FakeChain, GUARD, NETWORK, REGISTRY, T0, bridge, clock, memoryLog, noSleep, runOutcome, sealedOutput, testKey, twoProviders, verdictFields } from './helpers.ts';

const NEAR = 10n ** 24n;

function setup(store: Store, caps: { runsPerDaoDay: number; recordsPerDaoDay: number; nearPerDay: bigint }, now: () => number) {
  const chain = new FakeChain();
  const { log, lines } = memoryLog();
  const health = new Health(log);
  const guard = new CapGuard(store, caps, NETWORK);
  const submitter = new Submitter(store, chain, NETWORK, log, { pollMs: 1, sendTries: 2, sleep: noSleep, explorer: (h) => h });
  const key = testKey();
  const judge = new Judge({ store, submitter, caps: guard, bridge, health, log, acceptedKey: () => key.getPublicKey().toString(), now }, { network: NETWORK, guard: GUARD, outlayer: 'outlayer.testnet', project: 'o.testnet/p', verdictTtlMs: 600_000, windowBlocks: 220 });
  chain.respond = (call) => {
    if (call.method !== 'request_execution') return runOutcome(null);
    const input = JSON.parse(String(call.args.input_data)) as { dao: string; proposal_id: number };
    return runOutcome(sealedOutput(verdictFields(input.proposal_id, { dao: input.dao, expires_at_ms: now() + 600_000 }), key));
  };
  const [a, b] = twoProviders();
  const actor = new Actor({ store, submitter, caps: guard, reads: new Reads(a, b, bridge, 0, noSleep), health, log, now, sleep: noSleep }, { network: NETWORK, guard: GUARD, registry: REGISTRY, gateTries: 1, gateRetryMs: 0 });
  return { chain, guard, judge, actor, health, key, lines: () => lines };
}

test('the per-DAO run cap refuses the next sealed run, loudly, and other DAOs are unaffected', async () => {
  const c = clock();
  const store = new Store(':memory:', c.now);
  const s = setup(store, { runsPerDaoDay: 2, recordsPerDaoDay: 10, nearPerDay: 10n * NEAR }, c.now);
  assert.equal((await s.judge.judge(DAO, 1, 1)).kind, 'verdict');
  assert.equal((await s.judge.judge(DAO, 2, 1)).kind, 'verdict');
  const third = await s.judge.judge(DAO, 3, 1);
  assert.equal(third.kind, 'capped');
  assert.equal(s.chain.calls('request_execution').length, 2, 'the refused run is never signed');
  assert.equal(s.health.has('cap_reached', DAO), true);
  assert.equal(s.lines().find((l) => l.event === 'refused')?.reason, 'cap');
  assert.equal((await s.judge.judge('other.sputnik.testnet', 1, 1)).kind, 'verdict');
  c.advance(24 * 3600 * 1000);
  assert.equal((await s.judge.judge(DAO, 3, 1)).kind, 'verdict', 'a new UTC day starts a new count');
});

test('the per-DAO record cap refuses the next registry write', async () => {
  const store = new Store(':memory:', () => T0);
  const s = setup(store, { runsPerDaoDay: 10, recordsPerDaoDay: 1, nearPerDay: 10n * NEAR }, () => T0);
  const out = sealedOutput(verdictFields(1), s.key);
  const signed = { verdict: bridge.decodeVerdict(Buffer.from(out.verdict, 'base64')), verdictB64: out.verdict, signatureB64: out.signature };
  assert.equal(await s.actor.record(DAO, 1, signed), 'recorded');
  assert.equal(await s.actor.record(DAO, 2, signed), 'capped');
  assert.equal(s.chain.calls('record').length, 1);
});

test('the global NEAR cap counts worst cases in flight and refuses what would cross it', () => {
  const store = new Store(':memory:', () => T0);
  const guard = new CapGuard(store, { runsPerDaoDay: 100, recordsPerDaoDay: 100, nearPerDay: NEAR / 10n }, NETWORK);
  const run = worstCase(300n * TGAS, 20n * 10n ** 21n);
  assert.equal(run, 5n * 10n ** 22n, 'a run reserves 0.05 NEAR: 300 Tgas at the minimum price plus 0.02 attached');
  store.addSpend({ idempotency_key: 'run:a', kind: 'run', network: NETWORK, dao: DAO, proposal_id: 1, tx_hash: 'h1', signed_b64: 'x', nonce: '1', reserved_yocto: run.toString() });
  assert.equal(guard.near(run), null, '0.05 in flight plus 0.05 more is exactly the 0.1 cap');
  store.addSpend({ idempotency_key: 'run:b', kind: 'run', network: NETWORK, dao: DAO, proposal_id: 2, tx_hash: 'h2', signed_b64: 'x', nonce: '2', reserved_yocto: run.toString() });
  assert.equal(guard.near(1n)?.cap, 'near_per_day');
  // Once final, a transaction counts at what it really cost.
  store.markFinal('run:a', 'ok', 2n * 10n ** 21n, null);
  store.markFinal('run:b', 'ok', 2n * 10n ** 21n, null);
  assert.equal(store.spentOn('2026-11-02'), 4n * 10n ** 21n);
  assert.equal(guard.near(run), null);
  // A transaction the chain refused outright never cost anything.
  store.addSpend({ idempotency_key: 'veto:c', kind: 'veto', network: NETWORK, dao: DAO, proposal_id: 3, tx_hash: 'h3', signed_b64: 'x', nonce: '3', reserved_yocto: run.toString() });
  store.markRejected('veto:c', 'InvalidNonce');
  assert.equal(store.spentOn('2026-11-02'), 4n * 10n ** 21n);
});

test('the counts live in the SQLite file, so a restart does not reset them', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'kaap-worker-caps-')), 'worker.sqlite');
  const first = new Store(path, () => T0);
  const s1 = setup(first, { runsPerDaoDay: 1, recordsPerDaoDay: 10, nearPerDay: 10n * NEAR }, () => T0);
  assert.equal((await s1.judge.judge(DAO, 1, 1)).kind, 'verdict');
  first.close();
  const second = new Store(path, () => T0);
  const s2 = setup(second, { runsPerDaoDay: 1, recordsPerDaoDay: 10, nearPerDay: 10n * NEAR }, () => T0);
  assert.equal((await s2.judge.judge(DAO, 2, 1)).kind, 'capped');
  assert.equal(second.runsOn(NETWORK, DAO, '2026-11-02'), 1);
  second.close();
});
