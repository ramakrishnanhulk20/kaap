// A step that a cap, a failed read or an error stopped is tried again while its proposal is open
// (C21): a capped judgement once the cap has room, a failed one after a wait that starts at 60 s
// and doubles, a held veto on every pass, and an error never strands a row or skips a record. Each
// retry stays inside the same caps as a first try (C29). The signals those stops raise stay true
// (C18): cap_reached holds while a row is still capped, a restart brings back the same signals,
// and a veto lost to a passed proposal is never reported as recovered. Not covered: a flood of
// proposals larger than a day's run cap, which still waits for later days in proposal order, and
// how long a real provider takes to agree again, which only a live run shows.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { Actor } from '../src/act.ts';
import { Alerts } from '../src/alerts.ts';
import { CapGuard } from '../src/caps.ts';
import { Health } from '../src/health.ts';
import { Judge } from '../src/judge.ts';
import type { TxOutcome } from '../src/outcome.ts';
import { Reads } from '../src/reads.ts';
import { RejudgeWatch } from '../src/rejudge.ts';
import { RpcError } from '../src/rpc.ts';
import { Store } from '../src/store.ts';
import { Submitter } from '../src/submit.ts';
import { Subscriptions } from '../src/subscriptions.ts';
import { Worker } from '../src/worker.ts';
import { DAO, FakeChain, FakeTelegram, GUARD, NETWORK, REGISTRY, bothSet, bridge, clock, events, memoryLog, memoryStore, noSleep, okOutcome, proposalText, runOutcome, sealedOutput, testKey, twoProviders, verdictFields } from './helpers.ts';

const DAY = 24 * 3_600_000;
const CHAT = '5550001234';

const recordedOutcome = (): TxOutcome => {
  const o = okOutcome(undefined, ['EVENT_JSON:{"standard":"kaap-registry","version":"1.0.0","event":"verdict_recorded","data":[{"index":0,"storage_cost":"6380000000000000000000"}]}']);
  o.receipts_outcome![0]!.outcome!.executor_id = REGISTRY;
  return o;
};
const castOutcome = (): TxOutcome => okOutcome(undefined, ['EVENT_JSON:{"standard":"kaap-guard","version":"1.0.0","event":"veto_cast","data":[]}']);

/** A worker over one DAO with proposals 1 to 3 open, alerts going to one chat, and a sealed job
 *  that signs a critical, vetoable verdict for each proposal unless `answer` says otherwise. */
async function started(t: TestContext, opts: { runsPerDaoDay?: number; capPerHour?: number; path?: string } = {}) {
  const [a, b] = twoProviders();
  const key = testKey();
  bothSet([a, b], (p) => {
    p.acceptedKey = key.getPublicKey().toString();
    for (const id of [1, 2, 3]) p.proposals.set(id, proposalText(id));
  });
  const c = clock();
  const store = opts.path ? new Store(opts.path, c.now) : memoryStore(c.now);
  store.addDao(NETWORK, DAO, 4);
  const { log, lines } = memoryLog();
  const health = new Health(log, c.now);
  const telegram = new FakeTelegram();
  const alerts = new Alerts({ store, telegram, log, now: c.now, sleep: noSleep }, { network: NETWORK, siteUrl: null, batchMs: 60_000, capPerHour: opts.capPerHour ?? 30 });
  health.on((e) => alerts.health(e));
  const subs = new Subscriptions(store, NETWORK, log);
  subs.redeem(subs.issue(DAO).token, CHAT);
  const chain = new FakeChain();
  const caps = new CapGuard(store, { runsPerDaoDay: opts.runsPerDaoDay ?? 50, textRunsPerDaoDay: 5, recordsPerDaoDay: 50, nearPerDay: 10n ** 24n }, NETWORK);
  const submitter = new Submitter(store, chain, NETWORK, log, { pollMs: 1, sendTries: 2, sleep: noSleep, explorer: (h) => h });
  const reads = new Reads(a, b, bridge, 0, noSleep);
  const accepted = { value: null as string | null };
  const judge = new Judge({ store, submitter, caps, bridge, health, log, acceptedKey: () => accepted.value, now: c.now }, { network: NETWORK, guard: GUARD, outlayer: 'outlayer.testnet', project: 'o.testnet/p', verdictTtlMs: 600_000, windowBlocks: 220 });
  const actor = new Actor({ store, submitter, caps, reads, health, log, now: c.now, sleep: noSleep }, { network: NETWORK, guard: GUARD, registry: REGISTRY, gateTries: 1, gateRetryMs: 0 });
  const enqueue = { to: (_dao: string, _id: number) => {} };
  const rejudge = new RejudgeWatch({ reads, store, bridge, health, log, enqueue: (dao, id) => enqueue.to(dao, id) }, NETWORK);
  const worker = new Worker(
    { store, reads, judge, actor, rejudge, health, log, now: c.now, acceptedKey: accepted, bridge, alerts },
    { network: NETWORK, guard: GUARD, pollMs: 60_000, watchMs: 60_000, enrolledMs: 60_000, holdAlertMs: 30_000, backfillWindow: 100, maxConcurrentRuns: 2, sweepMs: 60_000 },
  );
  enqueue.to = (dao, id) => worker.enqueue(dao, id);
  // Stopped even when an assertion fails first, so its timers never keep the test file running.
  t.after(() => worker.stop());

  /** The sealed job's output for a proposal; null is OutLayer never answering. */
  const job = { answer: (id: number): unknown => sealedOutput(verdictFields(id, { expires_at_ms: c.now() + 600_000 }), key) };
  /** The DAO's veto_result for every vote the guard casts. */
  const dao = { result: 'Ok' };
  chain.respond = (call) => {
    if (call.method === 'request_execution') return runOutcome(job.answer((JSON.parse(String(call.args.input_data)) as { proposal_id: number }).proposal_id));
    if (call.method === 'veto') {
      bothSet([a, b], (p) => p.vetoResults.set(bridge.decodeVerdict(Buffer.from(String(call.args.verdict), 'base64')).verdict_hash, dao.result));
      return castOutcome();
    }
    return recordedOutcome();
  };
  await worker.start();
  await worker.idle();
  const row = (id: number) => store.judged(NETWORK, DAO, id)!;
  const runs = () => chain.calls('request_execution').length;
  /** One watch tick and every judgement it started. */
  const tick = async () => {
    await worker.watchTick();
    await worker.idle();
  };
  return { a, b, c, key, store, health, alerts, telegram, chain, actor, judge, worker, job, dao, row, runs, tick, lines };
}

/** A verdict the guard rule does not let Kaap veto, so only the judgement and the record run. */
const calm = (s: Awaited<ReturnType<typeof started>>) => (id: number) => sealedOutput(verdictFields(id, { risk: 'high', floor: 'high', findings: ['UNKNOWN_VALUE'], expires_at_ms: s.c.now() + 600_000 }), s.key);

const retried = (s: Awaited<ReturnType<typeof started>>, step: string) => events(s.lines, 'step_retried').filter((l) => l.step === step);

test("a treasury's run cap is used up, a further proposal is capped, the day changes, and the proposal is judged without anyone calling the judge by hand", async (t) => {
  const s = await started(t, { runsPerDaoDay: 1 });
  s.job.answer = calm(s);
  s.store.queueNew(NETWORK, DAO, 1, 'new');
  s.store.queueNew(NETWORK, DAO, 2, 'new');
  s.worker.enqueue(DAO, 1);
  await s.worker.idle();
  s.worker.enqueue(DAO, 2);
  await s.worker.idle();
  assert.deepEqual([s.row(1).state, s.row(2).state, s.runs()], ['judged', 'capped', 1]);
  assert.equal(s.health.has('cap_reached', DAO), true);

  await s.tick();
  assert.deepEqual([s.row(2).state, s.runs()], ['capped', 1], 'no room the same day, so nothing is tried or logged');
  assert.equal(retried(s, 'judge').length, 0);

  s.c.advance(DAY);
  await s.tick();
  assert.deepEqual([s.row(2).state, s.runs()], ['judged', 2], 'judged on the new day by the watch tick alone');
  assert.deepEqual(retried(s, 'judge').map((l) => [l.proposal_id, l.attempt, l.after]), [[2, 1, 'capped']]);
});

test('a failed judgement is tried again after its wait and succeeds', async (t) => {
  const s = await started(t);
  s.job.answer = () => null;
  s.store.queueNew(NETWORK, DAO, 1, 'new');
  s.worker.enqueue(DAO, 1);
  await s.worker.idle();
  assert.deepEqual([s.row(1).state, s.runs()], ['failed', 2], 'two silent runs, then the judgement is failed');

  s.c.advance(59_000);
  await s.tick();
  assert.equal(s.runs(), 2, 'not before 60 s');
  s.c.advance(1_000);
  await s.tick();
  assert.deepEqual([s.row(1).state, s.runs()], ['failed', 4], 'tried again at 60 s, and still silent');

  s.job.answer = calm(s);
  s.c.advance(60_000);
  await s.tick();
  assert.equal(s.runs(), 4, 'the second wait is 120 s');
  s.c.advance(60_000);
  await s.tick();
  assert.deepEqual([s.row(1).state, s.runs()], ['judged', 5]);
  assert.deepEqual(retried(s, 'judge').map((l) => [l.attempt, l.after]), [[1, 'failed'], [2, 'failed']]);
});

test('a held veto is sent once the providers agree again', async (t) => {
  const s = await started(t);
  s.b.proposals.set(1, proposalText(1, { receiver: 'mallory.testnet' }));
  s.store.queueNew(NETWORK, DAO, 1, 'new');
  s.worker.enqueue(DAO, 1);
  await s.worker.idle();
  assert.deepEqual([s.row(1).veto_state, s.row(1).record_state, s.chain.calls('veto').length], ['held', 'recorded', 0]);
  assert.equal(s.health.has('veto_held', DAO), true);

  await s.tick();
  assert.equal(s.row(1).veto_state, 'held', 'looked at again, and still held while they disagree');
  s.b.proposals.set(1, proposalText(1));
  await s.tick();
  assert.deepEqual([s.row(1).veto_state, s.chain.calls('veto').length], ['cast', 1]);
  assert.equal(s.health.has('veto_held', DAO), false);
  assert.deepEqual(retried(s, 'veto').map((l) => [l.attempt, l.after]), [[1, 'held'], [2, 'held']]);
});

test('an error thrown while signing leaves a row that the next pass retries', async (t) => {
  const s = await started(t);
  const sign = s.chain.sign.bind(s.chain);
  const failing = new Set(['veto', 'request_execution']);
  s.chain.sign = async (receiver, method, args, gas, deposit) => {
    if (failing.has(method)) throw new RpcError('primary.test', 'shape', 'view_access_key has no nonce');
    return sign(receiver, method, args, gas, deposit);
  };

  // A sealed run that cannot be signed: the judgement ends failed, never stuck in judging.
  s.store.queueNew(NETWORK, DAO, 2, 'new');
  s.worker.enqueue(DAO, 2);
  await s.worker.idle();
  assert.equal(s.row(2).state, 'failed');
  assert.deepEqual(s.store.db.prepare('SELECT state FROM runs WHERE proposal_id = 2 ORDER BY attempt').all(), [{ state: 'failed' }, { state: 'failed' }]);
  failing.delete('request_execution');

  // A veto that cannot be signed: held, the verdict still recorded, and sent on the next pass.
  s.store.queueNew(NETWORK, DAO, 1, 'new');
  s.worker.enqueue(DAO, 1);
  await s.worker.idle();
  assert.deepEqual([s.row(1).veto_state, s.row(1).record_state], ['held', 'recorded']);
  assert.equal(s.health.has('veto_held', DAO), true);
  failing.delete('veto');
  await s.tick();
  assert.equal(s.row(1).veto_state, 'cast');

  s.c.advance(60_000);
  await s.tick();
  assert.deepEqual([s.row(2).state, s.row(2).veto_state], ['judged', 'cast'], 'the failed judgement is judged on the pass after its wait');
});

test('a veto that throws still records its verdict', async (t) => {
  const s = await started(t);
  const veto = s.actor.veto.bind(s.actor);
  s.actor.veto = async () => {
    throw new Error('the store was busy');
  };
  s.store.queueNew(NETWORK, DAO, 1, 'new');
  s.worker.enqueue(DAO, 1);
  await s.worker.idle();
  assert.deepEqual([s.row(1).state, s.row(1).record_state, s.chain.calls('record').length], ['judged', 'recorded', 1]);
  assert.equal(s.row(1).veto_state, 'held', 'left for the next pass, not stranded');
  assert.equal(events(s.lines, 'veto_failed')[0]?.proposal_id, 1);

  s.actor.veto = veto;
  await s.tick();
  assert.equal(s.row(1).veto_state, 'cast');
});

test('cap_reached stays raised past midnight while a row of the treasury is still capped, and clears once none is', async (t) => {
  const s = await started(t, { runsPerDaoDay: 1 });
  s.job.answer = calm(s);
  s.store.queueNew(NETWORK, DAO, 1, 'new');
  s.store.queueNew(NETWORK, DAO, 2, 'new');
  s.worker.enqueue(DAO, 1);
  await s.worker.idle();
  s.worker.enqueue(DAO, 2);
  await s.worker.idle();
  assert.equal(s.row(2).state, 'capped');

  s.c.advance(DAY);
  s.worker.sweep();
  assert.equal(s.health.has('cap_reached', DAO), true, 'proposal 2 still waits on the cap');
  await s.tick();
  s.worker.sweep();
  assert.equal(s.row(2).state, 'judged');
  assert.equal(s.health.has('cap_reached', DAO), false, 'no row of the treasury is capped any more');
});

test('a held veto whose proposal is then Approved raises veto_lost urgently and nothing says recovered', async (t) => {
  const s = await started(t);
  s.b.proposals.set(1, proposalText(1, { receiver: 'mallory.testnet' }));
  s.store.queueNew(NETWORK, DAO, 1, 'new');
  s.worker.enqueue(DAO, 1);
  await s.worker.idle();
  assert.equal(s.row(1).veto_state, 'held');

  bothSet([s.a, s.b], (p) => p.proposals.set(1, proposalText(1, { status: 'Approved' })));
  await s.tick();
  await s.alerts.flush();
  assert.deepEqual(events(s.lines, 'veto_lost').map((l) => [l.level, l.proposal_id, l.was]), [['error', 1, 'held']]);
  assert.match(s.telegram.to(CHAT).find((m) => m.startsWith('Kaap: veto lost on proposal 1 ')) ?? '', /Kaap held its veto and the proposal has now passed\. Check the treasury now\./, 'sent at once, before any batch window');

  s.c.advance(60_000);
  await s.alerts.flush();
  assert.ok(!s.telegram.sent.some((m) => /Recovered/.test(m.text)), 'no message says recovered');
  assert.equal(events(s.lines, 'guard_recovered').filter((l) => l.signal === 'veto_held').length, 0, 'nor does the log');
  assert.deepEqual([s.health.has('veto_held', DAO), s.row(1).veto_state, s.chain.calls('veto').length], [false, 'not_open', 0]);
});

test('after a restart on the same store the signals are the same', async (t) => {
  const path = join(mkdtempSync(join(tmpdir(), 'kaap-worker-signals-')), 'worker.sqlite');
  const s = await started(t, { path });
  // Proposal 1: its veto held. Proposal 2: no answer from the sealed judge. Proposal 3: its veto refused.
  s.b.proposals.set(1, proposalText(1, { receiver: 'mallory.testnet' }));
  s.job.answer = (id) => (id === 2 ? null : sealedOutput(verdictFields(id, { expires_at_ms: s.c.now() + 600_000 }), s.key));
  s.dao.result = 'Failed';
  for (const id of [1, 2, 3]) {
    s.store.queueNew(NETWORK, DAO, id, 'new');
    s.worker.enqueue(DAO, id);
    await s.worker.idle();
    s.c.advance(1_000);
  }
  const shown = (r: { signal: string; dao: string; proposal: number | null; since: number }) => `${r.signal} ${r.dao} ${r.proposal} ${r.since}`;
  const before = s.health.current().map(shown).sort();
  assert.deepEqual(s.health.current().map((r) => `${r.signal} ${r.proposal}`).sort(), ['run_no_answer 2', 'run_without_verdict 2', 'veto_held 1', 'veto_refused 3']);
  await s.worker.stop();
  s.store.close();

  const r = await started(t, { path });
  assert.deepEqual(r.health.current().map(shown).sort(), before);
  assert.equal(r.health.levelFor(DAO), 'degraded');
  // The batch the earlier process queued about them, and had not sent yet, still goes, once.
  r.alerts.dropStale();
  r.c.advance(60_000);
  await r.alerts.flush();
  const updates = r.telegram.to(CHAT).filter((m) => m.startsWith('Kaap guard update for'));
  assert.deepEqual(updates.map((m) => m.match(/^Degraded: /gm)?.length), [4]);
});

test('a refused veto on a critical proposal sends an urgent alert even when the chat has used its hourly allowance, and a second raise of the same cause sends nothing', async (t) => {
  const s = await started(t, { capPerHour: 1 });
  // One batched message uses up the chat's hourly allowance.
  s.alerts.verdict(DAO, 9, { risk: 'high', findings: ['UNKNOWN_VALUE'], vetoable: false, verdict_hash: 'f'.repeat(64) }, 'alice.testnet');
  s.c.advance(60_000);
  await s.alerts.flush();
  assert.equal(s.telegram.to(CHAT).length, 1);

  s.dao.result = 'Failed';
  s.store.queueNew(NETWORK, DAO, 1, 'new');
  s.worker.enqueue(DAO, 1);
  await s.worker.idle();
  await s.alerts.flush();
  assert.equal(s.row(1).veto_state, 'refused');
  const texts = s.telegram.to(CHAT);
  assert.match(texts[1]!, /^Kaap: CRITICAL risk on proposal 1 /);
  assert.match(texts[2]!, /^Kaap: could not veto proposal 1 of treasury\[\.\]sputnik\[\.\]testnet\. The guard or the DAO refused its vote\.\nIf you agree it is an attack, vote to reject it yourself\./, 'sent past the hourly cap, at once');

  // A second judgement signs the same verdict, and its veto is refused the same way.
  s.store.queueAgain(NETWORK, DAO, 1, 'rejudge:policy');
  s.worker.enqueue(DAO, 1);
  await s.worker.idle();
  s.c.advance(60_000);
  await s.alerts.flush();
  assert.equal(s.chain.calls('request_execution').length, 2);
  assert.equal(s.row(1).veto_state, 'refused');
  assert.equal(s.telegram.to(CHAT).length, 3, 'one cause, one urgent alert');
});
