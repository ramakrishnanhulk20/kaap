// Which enrolled accounts the worker watches (C16, C22, C23, C29, C30): only one that both providers
// list as enrolled in the guard, whose code is a Sputnik release and whose policy arms the guard,
// up to the watch limit. Anything else is never judged and costs nothing, and a policy change that
// takes the guard out is told to members at once. And what one treasury can make the worker take up
// in its first backfill (C21): the newest ids only, the rest said. Not covered: a Sputnik release
// newer than the worker's list of code hashes, which counts as not Sputnik's until the list gains
// it, and both providers lying the same way (a named non-goal of the threat model).

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { Actor } from '../src/act.ts';
import { Alerts } from '../src/alerts.ts';
import { CapGuard } from '../src/caps.ts';
import { ALL, Health, SAYS } from '../src/health.ts';
import { Judge } from '../src/judge.ts';
import { Reads } from '../src/reads.ts';
import { RejudgeWatch } from '../src/rejudge.ts';
import { statusReport } from '../src/status.ts';
import { Submitter } from '../src/submit.ts';
import { Subscriptions } from '../src/subscriptions.ts';
import { Worker } from '../src/worker.ts';
import { DAO, DAO_CODE, FakeChain, FakeTelegram, GUARD, NETWORK, POLICY, REGISTRY, UNARMED_POLICY, bothSet, bridge, clock, events, memoryLog, memoryStore, noSleep, okOutcome, proposalText, runOutcome, sealedOutput, testKey, twoProviders, verdictFields } from './helpers.ts';

const FAKE = 'fake-dao.testnet';
const SECOND = 'second.sputnik.testnet';
const CHAT = '5550001234';
const WEEK = 7 * 24 * 3_600_000;

interface Options {
  enrolled?: string[];
  policy?: string;
  /** The fake DAO's proposal counter; proposals 0 to counter - 1 exist. */
  counter?: number;
  open?: number[];
  backfillWindow?: number;
  maxWatchedDaos?: number;
}

/** A started worker whose providers list `enrolled` (the fake DAO by default) in the guard. Every
 *  account answers with the fake DAO's proposals, open where `open` says (proposal 2 by default),
 *  and the sealed job signs a verdict that asks for no veto. */
async function started(t: TestContext, o: Options = {}) {
  const [a, b] = twoProviders();
  const key = testKey();
  const counter = o.counter ?? 3;
  const open = new Set(o.open ?? [2]);
  bothSet([a, b], (p) => {
    p.acceptedKey = key.getPublicKey().toString();
    p.enrolled = o.enrolled ?? [DAO];
    p.codeHashes.set(FAKE, '9'.repeat(44));
    p.codeHashes.set(SECOND, DAO_CODE);
    p.policy = o.policy ?? POLICY;
    p.optimistic = counter;
    p.final = counter;
    for (let id = 0; id < counter; id++) p.proposals.set(id, proposalText(id, { status: open.has(id) ? 'InProgress' : 'Approved' }));
  });
  const c = clock();
  const store = memoryStore(c.now);
  const { log, lines } = memoryLog();
  const health = new Health(log, c.now);
  const telegram = new FakeTelegram();
  const alerts = new Alerts({ store, telegram, log, now: c.now, sleep: noSleep }, { network: NETWORK, siteUrl: null, batchMs: 60_000, capPerHour: 30 });
  health.on((e) => alerts.health(e));
  const subs = new Subscriptions(store, NETWORK, log);
  subs.redeem(subs.issue(DAO).token, CHAT);
  const chain = new FakeChain();
  chain.respond = (call) => {
    if (call.method !== 'request_execution') return okOutcome();
    const id = (JSON.parse(String(call.args.input_data)) as { proposal_id: number }).proposal_id;
    return runOutcome(sealedOutput(verdictFields(id, { risk: 'high', floor: 'high', findings: ['UNKNOWN_VALUE'], expires_at_ms: c.now() + 600_000 }), key));
  };
  const caps = new CapGuard(store, { runsPerDaoDay: 50, textRunsPerDaoDay: 5, recordsPerDaoDay: 50, nearPerDay: 10n ** 24n }, NETWORK);
  const submitter = new Submitter(store, chain, NETWORK, log, { pollMs: 1, sendTries: 2, sleep: noSleep, explorer: (h) => h });
  const reads = new Reads(a, b, bridge, 0, noSleep);
  const accepted = { value: null as string | null };
  const judge = new Judge({ store, submitter, caps, bridge, health, log, acceptedKey: () => accepted.value, now: c.now }, { network: NETWORK, guard: GUARD, outlayer: 'outlayer.testnet', project: 'o.testnet/p', verdictTtlMs: 600_000, windowBlocks: 220 });
  const actor = new Actor({ store, submitter, caps, reads, health, log, now: c.now, sleep: noSleep }, { network: NETWORK, guard: GUARD, registry: REGISTRY, gateTries: 1, gateRetryMs: 0 });
  const enqueue = { to: (_dao: string, _id: number) => {} };
  const rejudge = new RejudgeWatch({ reads, store, bridge, health, log, enqueue: (dao, id) => enqueue.to(dao, id) }, NETWORK);
  const worker = new Worker(
    { store, reads, judge, actor, rejudge, health, log, now: c.now, acceptedKey: accepted, bridge, alerts },
    { network: NETWORK, guard: GUARD, pollMs: 60_000, watchMs: 60_000, enrolledMs: 60_000, holdAlertMs: 30_000, backfillWindow: o.backfillWindow ?? 50, maxConcurrentRuns: 2, sweepMs: 60_000, ...(o.maxWatchedDaos === undefined ? {} : { maxWatchedDaos: o.maxWatchedDaos }) },
  );
  enqueue.to = (dao, id) => worker.enqueue(dao, id);
  t.after(() => worker.stop());
  await worker.start();
  await worker.idle();
  const runs = () => chain.calls('request_execution').length;
  const callsOf = (method: string) => [...a.calls, ...b.calls].filter((x) => x.method === method).length;
  const report = () => statusReport(health, worker.watching(), { network: NETWORK, guard: GUARD }, c.now(), worker.notWatched());
  return { a, b, c, store, health, alerts, telegram, chain, worker, runs, callsOf, report, lines };
}

test("the bridge reads what a policy gives the guard with kaap-core: the account in the guard role decides, any other does not, and the proposal period comes with it", () => {
  const armed = bridge.guardArming(POLICY, GUARD);
  assert.ok(armed.rejectsAlone.includes('transfer') && armed.rejectsAlone.includes('call'), armed.rejectsAlone.join(','));
  assert.equal(armed.proposalPeriodMs, WEEK);
  assert.deepEqual(bridge.guardArming(UNARMED_POLICY, GUARD).rejectsAlone, []);
  assert.deepEqual(bridge.guardArming(POLICY, 'someone-else.testnet').rejectsAlone, []);
  assert.throws(() => bridge.guardArming('{"roles":', GUARD), /the policy cannot be canonicalised/);
});

test('an enrolled account whose code is not a Sputnik release is never judged, costs nothing and shows on /status as not_a_sputnik_dao', async (t) => {
  const s = await started(t, { enrolled: [FAKE] });
  await s.worker.refreshEnrolled();
  await s.worker.pollTick();
  await s.worker.watchTick();
  await s.worker.idle();
  assert.deepEqual(s.worker.watching(), []);
  assert.equal(s.store.dao(NETWORK, FAKE), undefined, 'never taken up');
  assert.equal(s.chain.signed.length, 0, 'no sealed run, veto or record');
  assert.equal(s.callsOf('get_last_proposal_id') + s.callsOf('get_proposals') + s.callsOf('get_policy'), 0, 'not one of its views is read');
  assert.equal(events(s.lines, 'not_a_sputnik_dao').length, 1, 'logged once over two refreshes');
  const r = s.report();
  assert.deepEqual(r.not_watched, [{ dao: FAKE, reason: 'not_a_sputnik_dao' }]);
  assert.deepEqual([r.status, r.watching, r.daos], ['healthy', 0, []], "a stranger's account changes nothing about the worker's own status");

  // Read again on every refresh: the same account once it runs a Sputnik release is a DAO.
  bothSet([s.a, s.b], (p) => p.codeHashes.set(FAKE, DAO_CODE));
  await s.worker.refreshEnrolled();
  assert.deepEqual([s.worker.watching(), s.report().not_watched], [[FAKE], []]);
});

test('a Sputnik DAO whose policy does not arm the guard is not judged and shows guard_not_armed, and is judged once the guard is armed', async (t) => {
  const s = await started(t, { policy: UNARMED_POLICY });
  assert.deepEqual(s.worker.watching(), []);
  assert.equal(s.runs(), 0);
  assert.equal(s.health.has('guard_not_armed', DAO), true);
  const shown = s.report().daos.find((d) => d.dao === DAO);
  assert.deepEqual([shown?.status, shown?.signals.map((x) => x.signal)], ['degraded', ['guard_not_armed']]);

  bothSet([s.a, s.b], (p) => (p.policy = POLICY));
  await s.worker.refreshEnrolled();
  await s.worker.idle();
  assert.deepEqual(s.worker.watching(), [DAO]);
  assert.equal(s.health.has('guard_not_armed', DAO), false);
  assert.equal(s.store.judged(NETWORK, DAO, 2)?.state, 'judged');
  assert.equal(s.runs(), 1);
});

test("a watched treasury whose policy change takes the guard's deciding reject away raises guard_not_armed urgently to its members and is judged no more", async (t) => {
  const s = await started(t);
  assert.equal(s.runs(), 1, 'its open proposal was judged');
  // The first pass learns the policy; the second sees it change.
  await s.worker.watchTick();
  bothSet([s.a, s.b], (p) => (p.policy = UNARMED_POLICY));
  await s.worker.watchTick();
  await s.worker.idle();
  await s.alerts.flush();
  assert.deepEqual(s.worker.watching(), []);
  assert.equal(s.health.has('guard_not_armed', DAO), true);
  assert.equal(s.telegram.to(CHAT).length, 1, 'sent at once, not held for the batch window');
  assert.ok(s.telegram.to(CHAT)[0]!.includes(SAYS.guard_not_armed));
  assert.equal(s.runs(), 1, 'the re-judge the policy change asked for waits until the guard is armed again');
  assert.equal(s.store.judged(NETWORK, DAO, 2)?.state, 'queued');
});

test('an account only one provider lists as enrolled is not watched, and a watched one stays watched until neither lists it', async (t) => {
  const s = await started(t, { enrolled: [] });
  s.a.enrolled = [DAO];
  await s.worker.refreshEnrolled();
  assert.deepEqual(s.worker.watching(), [], 'the primary alone');
  s.a.enrolled = [];
  s.b.enrolled = [DAO];
  await s.worker.refreshEnrolled();
  assert.deepEqual(s.worker.watching(), [], 'the secondary alone');
  s.a.enrolled = [DAO];
  await s.worker.refreshEnrolled();
  assert.deepEqual(s.worker.watching(), [DAO], 'both');
  s.b.enrolled = [];
  await s.worker.refreshEnrolled();
  assert.deepEqual(s.worker.watching(), [DAO], 'one provider leaving it out cannot end its protection');
  s.a.enrolled = [];
  await s.worker.refreshEnrolled();
  assert.deepEqual(s.worker.watching(), [], 'gone from both');
});

test('beyond KAAP_MAX_WATCHED_DAOS further enrolled treasuries are not watched, and watch_limit_reached stays raised until there is room', async (t) => {
  const s = await started(t, { enrolled: [DAO, SECOND], maxWatchedDaos: 1, open: [] });
  assert.deepEqual(s.worker.watching(), [DAO]);
  assert.equal(s.health.has('watch_limit_reached', ALL), true);
  bothSet([s.a, s.b], (p) => (p.enrolled = [SECOND]));
  await s.worker.refreshEnrolled();
  assert.deepEqual(s.worker.watching(), [SECOND]);
  assert.equal(s.health.has('watch_limit_reached', ALL), false);
});

test('600 new proposals with a backfill of 50 judge the newest 50, the open one at 550 among them, and raise proposals_skipped until no skipped one can pass', async (t) => {
  const s = await started(t, { counter: 600, open: [3, 550], backfillWindow: 50 });
  assert.equal(s.store.judged(NETWORK, DAO, 550)?.state, 'judged');
  assert.equal(s.store.judged(NETWORK, DAO, 3), undefined, 'older than the newest 50');
  assert.deepEqual([s.runs(), s.store.dao(NETWORK, DAO)?.next_id], [1, 600]);
  assert.equal(s.health.has('proposals_skipped', DAO), true);
  assert.deepEqual(events(s.lines, 'proposals_skipped').map((l) => [l.from_id, l.to_id, l.count]), [[0, 549, 550]]);

  // The DAO's policy gives a proposal 7 days; once they are over no skipped proposal can pass.
  s.c.advance(WEEK - 1);
  s.worker.sweep();
  assert.equal(s.health.has('proposals_skipped', DAO), true);
  s.c.advance(1);
  s.worker.sweep();
  assert.equal(s.health.has('proposals_skipped', DAO), false);
});
