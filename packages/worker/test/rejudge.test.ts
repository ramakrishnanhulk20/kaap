// Re-judging (C4): a policy change, a code-hash change on a called contract, or an open proposal
// moving to Failed re-runs the judge for every open proposal of the DAO; a policy that only
// reorders its sets does not; and a stale verdict is never vetoed, re-judged once and then held.
// Not covered: how fast a real change reaches the providers, which is bounded by the watch period.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Actor } from '../src/act.ts';
import { CapGuard } from '../src/caps.ts';
import { Health } from '../src/health.ts';
import { Judge } from '../src/judge.ts';
import { Reads } from '../src/reads.ts';
import { RejudgeWatch } from '../src/rejudge.ts';
import { Submitter } from '../src/submit.ts';
import { Worker } from '../src/worker.ts';
import { DAO, FakeChain, GUARD, NETWORK, POLICY, REGISTRY, T0, bothSet, bridge, events, memoryLog, memoryStore, noSleep, proposalText, runOutcome, sealedOutput, testKey, twoProviders, verdictFields } from './helpers.ts';

function setup() {
  const [a, b] = twoProviders();
  bothSet([a, b], (p) => {
    p.proposals.set(3, proposalText(3));
    p.proposals.set(4, proposalText(4, { status: 'Rejected' }));
    p.proposals.set(5, proposalText(5));
  });
  const store = memoryStore();
  store.addDao(NETWORK, DAO, 6);
  for (const id of [3, 5]) {
    store.queueNew(NETWORK, DAO, id, 'new', 'InProgress');
    const v = bridge.decodeVerdict(Buffer.from(bridge.encodeVerdict(verdictFields(id, { risk: 'high', floor: 'high', findings: ['UNKNOWN_VALUE'] })), 'base64'));
    store.setVerdict(NETWORK, DAO, id, { verdict_b64: '', signature_b64: '', verdict_hash: v.verdict_hash, risk: v.risk, floor: v.floor, findings: '', ai_status: v.ai_status, kind_hash: v.kind_hash, policy_hash: v.policy_hash, receivers_hash: v.receivers_hash, block_height: v.block_height, expires_at_ms: v.expires_at_ms, vetoable: 0 });
  }
  const { log, lines } = memoryLog();
  const health = new Health(log);
  const queued: number[] = [];
  const watch = new RejudgeWatch({ reads: new Reads(a, b, bridge, 0, noSleep), store, bridge, health, log, enqueue: (_dao, id) => queued.push(id) }, NETWORK);
  return { a, b, store, health, watch, queued, lines: () => lines };
}

const policyWith = (edit: (p: Record<string, unknown> & { roles: Array<{ permissions: string[]; kind: { Group?: string[] } }> }) => void) => {
  const p = JSON.parse(POLICY);
  edit(p);
  return JSON.stringify(p);
};

test('a first pass over an unchanged DAO only learns its state', async () => {
  const s = setup();
  assert.deepEqual(await s.watch.pass(DAO), []);
  assert.deepEqual(s.queued, []);
  assert.equal(s.store.dao(NETWORK, DAO)?.policy_hash, bridge.policyHash(new TextEncoder().encode(POLICY)));
  assert.equal(s.store.codeHashes(NETWORK, DAO).size, 1);
});

test('a policy change re-judges every open proposal of the DAO, under a new generation', async () => {
  const s = setup();
  await s.watch.pass(DAO);
  const changed = policyWith((p) => (p.proposal_bond = '1'));
  bothSet([s.a, s.b], (p) => (p.policy = changed));
  assert.deepEqual(await s.watch.pass(DAO), ['policy']);
  assert.deepEqual(s.queued, [3, 5]);
  for (const id of [3, 5]) {
    const row = s.store.judged(NETWORK, DAO, id);
    assert.deepEqual([row?.state, row?.generation, row?.reason], ['queued', 2, 'rejudge:policy']);
  }
});

test('a policy that lists the same sets in another order is not a change', async () => {
  const s = setup();
  await s.watch.pass(DAO);
  const reordered = policyWith((p) => {
    for (const role of p.roles) {
      role.permissions.reverse();
      role.kind.Group?.reverse();
    }
    p.roles.reverse();
    p.roles.reverse();
  });
  assert.notEqual(reordered, POLICY, 'the bytes differ');
  bothSet([s.a, s.b], (p) => (p.policy = reordered));
  assert.deepEqual(await s.watch.pass(DAO), []);
  assert.deepEqual(s.queued, []);
});

test('a code change on a contract an open proposal calls re-judges every open proposal', async () => {
  const s = setup();
  await s.watch.pass(DAO);
  bothSet([s.a, s.b], (p) => p.codeHashes.set(DAO, '8'.repeat(44)));
  assert.deepEqual(await s.watch.pass(DAO), ['code']);
  assert.deepEqual(s.queued, [3, 5]);
});

test('an open proposal moving to Failed re-judges the proposals still open', async () => {
  const s = setup();
  await s.watch.pass(DAO);
  bothSet([s.a, s.b], (p) => p.proposals.set(3, proposalText(3, { status: 'Failed' })));
  assert.deepEqual(await s.watch.pass(DAO), ['failed']);
  assert.deepEqual(s.queued, [5]);
  assert.equal(s.store.judged(NETWORK, DAO, 3)?.proposal_status, 'Failed');
});

test('a change made while the worker was down is caught from the verdicts it pinned', async () => {
  const s = setup();
  bothSet([s.a, s.b], (p) => (p.policy = policyWith((x) => (x.proposal_bond = '2'))));
  assert.deepEqual(await s.watch.pass(DAO), ['policy']);
  assert.deepEqual(s.queued, [3, 5]);
});

test('one provider showing another policy is held and raised, not acted on', async () => {
  const s = setup();
  await s.watch.pass(DAO);
  s.b.policy = policyWith((p) => (p.proposal_bond = '3'));
  assert.deepEqual(await s.watch.pass(DAO), []);
  assert.deepEqual(s.queued, []);
  assert.equal(s.health.has('providers_disagree', DAO), true);
});

test('a stale critical verdict is never vetoed: judged again once, then held and raised', async () => {
  const [a, b] = twoProviders();
  bothSet([a, b], (p) => p.proposals.set(7, proposalText(7)));
  const chain = new FakeChain();
  const store = memoryStore();
  store.addDao(NETWORK, DAO, 8);
  store.queueNew(NETWORK, DAO, 7, 'new');
  const { log, lines } = memoryLog();
  const health = new Health(log);
  const caps = new CapGuard(store, { runsPerDaoDay: 50, textRunsPerDaoDay: 5, recordsPerDaoDay: 50, nearPerDay: 10n ** 24n }, NETWORK);
  const submitter = new Submitter(store, chain, NETWORK, log, { pollMs: 1, sendTries: 3, sleep: noSleep, explorer: (h) => h });
  const reads = new Reads(a, b, bridge, 0, noSleep);
  const key = testKey();
  const accepted = { value: key.getPublicKey().toString() };
  const judge = new Judge({ store, submitter, caps, bridge, health, log, acceptedKey: () => accepted.value, now: () => T0 }, { network: NETWORK, guard: GUARD, outlayer: 'outlayer.testnet', project: 'o.testnet/p', verdictTtlMs: 600_000, windowBlocks: 220 });
  const actor = new Actor({ store, submitter, caps, reads, health, log, now: () => T0, sleep: noSleep }, { network: NETWORK, guard: GUARD, registry: REGISTRY, gateTries: 1, gateRetryMs: 0 });
  // The sealed job keeps signing a verdict pinned to a policy the DAO no longer has.
  const stale = sealedOutput(verdictFields(7, { policy_hash: 'a'.repeat(64) }), key);
  chain.respond = (call) => (call.method === 'request_execution' ? runOutcome(stale) : runOutcome(null));
  const rejudge = new RejudgeWatch({ reads, store, bridge, health, log, enqueue: () => {} }, NETWORK);
  const worker = new Worker({ store, reads, judge, actor, rejudge, health, log, now: () => T0, acceptedKey: accepted }, { network: NETWORK, guard: GUARD, pollMs: 1_000, watchMs: 15_000, enrolledMs: 60_000, holdAlertMs: 30_000, backfillWindow: 100, maxConcurrentRuns: 2 });

  worker.enqueue(DAO, 7);
  await worker.idle();
  assert.equal(chain.calls('request_execution').length, 2, 'judged, then judged again once');
  assert.equal(chain.calls('veto').length, 0, 'never vetoed on a stale verdict');
  // The fake job signs the identical verdict twice, so its record shares one idempotency key and
  // is sent once; a real re-judge reads a later block and so signs a different verdict.
  assert.equal(chain.calls('record').length, 1, 'the signed verdict is still recorded, once');
  const row = store.judged(NETWORK, DAO, 7);
  assert.deepEqual([row?.generation, row?.reason, row?.veto_state], [2, 'rejudge:stale:stale_policy', 'held']);
  assert.equal(health.has('veto_held', DAO), true);
  // Each of the two verdicts is refused as stale, then the worker refuses to judge a third time.
  assert.equal(events(lines, 'refused').filter((l) => l.what === 'veto').length, 3);
});
