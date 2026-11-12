// The counter watch (C21, C22): new ids are taken up only once both providers show them at final,
// disagreement holds them and alerts after the hold window, and every id in a gap is judged, up to
// the newest 50 in one pass with the rest said. A counter no DAO could give queues nothing. Not
// covered: real provider latency and refusals, which only a live testnet run meets.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Health } from '../src/health.ts';
import { Reads } from '../src/reads.ts';
import { CounterWatch } from '../src/watcher.ts';
import { DAO, NETWORK, bothSet, bridge, clock, events, memoryLog, memoryStore, noSleep, twoProviders } from './helpers.ts';

function setup(nextId: number) {
  const [a, b] = twoProviders();
  bothSet([a, b], (p) => {
    p.optimistic = nextId;
    p.final = nextId;
  });
  const c = clock();
  const store = memoryStore(c.now);
  store.addDao(NETWORK, DAO, nextId);
  const { log, lines } = memoryLog();
  const health = new Health(log, c.now);
  const queued: number[] = [];
  const watch = new CounterWatch(DAO, new Reads(a, b, bridge, 0, noSleep), store, health, log, { network: NETWORK, holdAlertMs: 30_000, now: c.now }, (id) => queued.push(id));
  return { a, b, c, store, health, lines: () => lines, queued, watch };
}

test('an id seen only at optimistic finality is not judged until both providers show it at final', async () => {
  const s = setup(6);
  s.a.optimistic = 7;
  await s.watch.tick();
  assert.deepEqual(s.queued, [], 'optimistic alone never takes an id');
  assert.ok(s.a.calls.some((c) => 'finality' in c.at && c.at.finality === 'final'), 'a new optimistic id makes the watch look at final');

  bothSet([s.a, s.b], (p) => (p.final = 7));
  await s.watch.tick();
  assert.deepEqual(s.queued, [6]);
  assert.equal(s.store.dao(NETWORK, DAO)?.next_id, 7);
  assert.equal(s.store.judged(NETWORK, DAO, 6)?.reason, 'new');
});

test('while the providers disagree at final the extra id is held, and the hold alerts after its window', async () => {
  const s = setup(6);
  bothSet([s.a, s.b], (p) => (p.optimistic = 7));
  s.a.final = 7;
  await s.watch.tick();
  assert.deepEqual(s.queued, [], 'one provider alone never takes an id (C22)');
  assert.equal(s.store.dao(NETWORK, DAO)?.next_id, 6);
  assert.equal(s.health.has('providers_disagree', DAO), false, 'a short lag is not yet an alert');

  s.c.advance(31_000);
  await s.watch.tick();
  assert.deepEqual(s.queued, []);
  assert.equal(s.health.has('providers_disagree', DAO), true);
  assert.equal(events(s.lines(), 'guard_degraded').length, 1);

  s.b.final = 7;
  await s.watch.tick();
  assert.deepEqual(s.queued, [6]);
  assert.equal(s.health.has('providers_disagree', DAO), false, 'agreement clears the alert');
});

test('a provider that is down holds new ids rather than letting the other one decide', async () => {
  const s = setup(3);
  s.b.down = true;
  s.a.optimistic = 4;
  s.a.final = 4;
  await s.watch.tick();
  s.c.advance(30_000);
  await s.watch.tick();
  assert.deepEqual(s.queued, []);
  assert.equal(s.health.has('provider_unavailable', DAO), true);
});

test('a jump in the counter judges every id in the gap and logs the gap (C21)', async () => {
  const s = setup(2);
  bothSet([s.a, s.b], (p) => {
    p.optimistic = 7;
    p.final = 7;
  });
  await s.watch.tick();
  assert.deepEqual(s.queued, [2, 3, 4, 5, 6]);
  assert.equal(s.store.dao(NETWORK, DAO)?.next_id, 7);
  for (const id of [2, 3, 4, 5, 6]) assert.equal(s.store.judged(NETWORK, DAO, id)?.reason, 'backfill');
  const gap = events(s.lines(), 'counter_gap')[0];
  assert.deepEqual([gap?.from_id, gap?.to_id, gap?.count], [2, 6, 5]);
  // An alert for members, not a lasting state: the gap is already being judged.
  assert.equal(events(s.lines(), 'notice').filter((l) => l.notice === 'counter_gap').length, 1);
});

test('a jump of more new ids than one pass takes up queues the newest 50 and raises proposals_skipped naming the rest', async () => {
  const s = setup(2);
  bothSet([s.a, s.b], (p) => {
    p.optimistic = 202;
    p.final = 202;
  });
  await s.watch.tick();
  assert.deepEqual(s.queued, Array.from({ length: 50 }, (_, i) => 152 + i));
  assert.equal(s.store.dao(NETWORK, DAO)?.next_id, 202);
  assert.equal(s.store.judged(NETWORK, DAO, 151), undefined);
  assert.equal(s.health.has('proposals_skipped', DAO), true);
  assert.deepEqual(events(s.lines(), 'proposals_skipped').map((l) => [l.from_id, l.to_id, l.count]), [[2, 151, 150]]);
});

test("the review's counter of 9007199254740991 queues nothing, returns within one tick and raises counter_implausible", async () => {
  // The largest whole number JavaScript holds exactly, then the first one it cannot.
  for (const counter of [9_007_199_254_740_991, 2 ** 53]) {
    const s = setup(6);
    bothSet([s.a, s.b], (p) => {
      p.optimistic = counter;
      p.final = counter;
    });
    const began = Date.now();
    await s.watch.tick();
    assert.ok(Date.now() - began < 1_000, `${counter}: one tick, not a loop over the ids`);
    assert.deepEqual(s.queued, [], String(counter));
    assert.equal(s.store.dao(NETWORK, DAO)?.next_id, 6);
    assert.equal(s.health.has('counter_implausible', DAO), true, String(counter));

    // The counter reads as a DAO's again: the next id is taken up and the signal clears.
    bothSet([s.a, s.b], (p) => {
      p.optimistic = 7;
      p.final = 7;
    });
    await s.watch.tick();
    assert.deepEqual(s.queued, [6], String(counter));
    assert.equal(s.health.has('counter_implausible', DAO), false, String(counter));
  }
});

test('a counter that tracks the block height, jumping by thousands, queues nothing and raises counter_implausible', async () => {
  const s = setup(6);
  for (const height of [223_000_000, 223_003_000, 223_006_000]) {
    bothSet([s.a, s.b], (p) => {
      p.optimistic = height;
      p.final = height;
    });
    await s.watch.tick();
  }
  assert.deepEqual(s.queued, []);
  assert.equal(s.store.dao(NETWORK, DAO)?.next_id, 6);
  assert.equal(s.health.has('counter_implausible', DAO), true);
});

test('a provider whose counter goes backwards never makes the worker take ids again', async () => {
  const s = setup(5);
  bothSet([s.a, s.b], (p) => {
    p.optimistic = 6;
    p.final = 6;
  });
  await s.watch.tick();
  bothSet([s.a, s.b], (p) => {
    p.optimistic = 3;
    p.final = 3;
  });
  await s.watch.tick();
  assert.deepEqual(s.queued, [5]);
  assert.equal(s.store.dao(NETWORK, DAO)?.next_id, 6);
});
