// What the worker does with the guard's two newer rules (C8, C19): a treasury's own strict setting,
// under which a request Kaap cannot read is vetoed, read on both providers and never turned on by
// one of them alone; a key change the guard's owner has announced, told to members at once and
// once; the gas a veto carries; and a proposal too large to veto at all. Not covered: the guard's
// own side of each rule, which its unit and sandbox tests show against the real Sputnik binary; a
// `mode_changed` event, which the worker does not listen for (it reads the setting again on every
// refresh of the enrolled list); and a guard whose minimum gas rises above what one transaction
// can carry, which no build of the worker could meet.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { Actor, VETO_GAS, decide, vetoes } from '../src/act.ts';
import { Alerts } from '../src/alerts.ts';
import { CapGuard } from '../src/caps.ts';
import { loadConfig, ConfigError } from '../src/config.ts';
import { ALL, Health, SAYS } from '../src/health.ts';
import { Judge } from '../src/judge.ts';
import { TGAS, worstCase } from '../src/near.ts';
import { Reads, type LiveProposal } from '../src/reads.ts';
import { RejudgeWatch } from '../src/rejudge.ts';
import { Submitter } from '../src/submit.ts';
import { Subscriptions } from '../src/subscriptions.ts';
import { Worker } from '../src/worker.ts';
import { DAO, FakeChain, FakeTelegram, GUARD, NETWORK, POLICY, REGISTRY, T0, bothSet, bridge, clock, failedOutcome, memoryLog, memoryStore, noSleep, okOutcome, proposalText, runOutcome, sealedOutput, testKey, twoProviders, verdictFields } from './helpers.ts';

const CHAT = '5550001234';
const NEW_KEY = 'ed25519:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
/** A request that shows only a hash: Kaap could not read it, and nothing else is wrong with it. */
const UNREADABLE: Parameters<typeof verdictFields>[1] = { risk: 'high', floor: 'unknown', findings: ['HASH_UNVERIFIED'], ai_status: 'unavailable' };
const decoded = (over: Parameters<typeof verdictFields>[1]) => bridge.decodeVerdict(Buffer.from(bridge.encodeVerdict(verdictFields(2, over)), 'base64'));

test("the mirror of the guard's strict rule: an unreadable hash vetoes whatever its risk, and nothing else changes", () => {
  // Each row is a case from the guard's own tests (packages/contracts/guard/src/tests.rs): the
  // answer in the default mode, then in strict mode.
  const cases: Array<[string, Parameters<typeof verdictFields>[1], boolean, boolean]> = [
    ['an unexplained hash alone, critical', { risk: 'critical', floor: 'high', findings: ['HASH_UNVERIFIED'], ai_status: 'verified' }, false, true],
    ['an unexplained hash alone, high on an unknown floor', UNREADABLE, false, true],
    ['an unexplained hash alone, low', { risk: 'low', floor: 'low', findings: ['HASH_UNVERIFIED'], ai_status: 'unavailable' }, false, true],
    ['an unexplained hash beside a medium code', { risk: 'critical', floor: 'high', findings: ['HASH_UNVERIFIED', 'NEW_RECIPIENT'], ai_status: 'verified' }, false, true],
    ['an unexplained hash beside a new approver', { risk: 'critical', floor: 'high', findings: ['HASH_UNVERIFIED', 'POLICY_ADDS_APPROVER'], ai_status: 'verified' }, true, true],
    ['an honest payment: high on a high floor', { risk: 'high', floor: 'high', findings: ['UNKNOWN_VALUE'], ai_status: 'unavailable' }, false, false],
    ['an AI-only critical on a medium floor', { risk: 'critical', floor: 'medium', findings: ['NEW_RECIPIENT'], ai_status: 'verified' }, false, false],
    ['a description that contradicts a payment', { risk: 'critical', floor: 'critical', findings: ['DESC_CONTRADICTS', 'UNKNOWN_VALUE'], ai_status: 'unavailable' }, true, true],
    ['a text that was read and is dangerous', { risk: 'critical', floor: 'critical', findings: ['HASH_TEXT_DANGEROUS'], ai_status: 'unavailable' }, true, true],
  ];
  for (const [name, over, byDefault, strict] of cases) {
    const v = decoded(over);
    assert.deepEqual([v.vetoable, v.vetoable_strict], [byDefault, strict], name);
    assert.deepEqual([vetoes(v, false), vetoes(v, true)], [byDefault, strict], name);
  }
  const v = decoded(UNREADABLE);
  const live: LiveProposal = { kind: 'live', height: 5_000, status: 'InProgress', kindText: '{}', kindHash: v.kind_hash, submissionTime: null, policyHash: v.policy_hash, receivers: [], receiversHash: v.receivers_hash };
  assert.deepEqual(decide(v, live, T0), { act: 'none', why: 'not_vetoable' });
  assert.deepEqual(decide(v, live, T0, true), { act: 'veto' });
});

test('a veto carries 1,000 Tgas, above the 900 the guard asks for, and the caps reserve 0.1 NEAR for it', () => {
  assert.equal(VETO_GAS, 1_000n * TGAS);
  assert.ok(VETO_GAS >= 900n * TGAS);
  assert.equal(worstCase(VETO_GAS, 0n), 10n ** 23n);
});

test('a proposal whose status is not text is refused as unreadable, never read as closed', () => {
  const text = (status: string) => proposalText(4).replace('"status":"InProgress"', `"status":${status}`);
  const read = (answer: string) => bridge.readProposal(new TextEncoder().encode(answer));
  assert.equal(read(text('"InProgress"')).status, 'InProgress');
  for (const status of ['7', 'null', '{"InProgress":{}}', '["InProgress"]']) assert.throws(() => read(text(status)), status);
  assert.throws(() => read(proposalText(4).replace('"status":"InProgress",', '')), 'no status at all');
});

const complete = {
  KAAP_NETWORK: 'testnet',
  KAAP_WORKER_ACCOUNT: 'kaap-worker-1029053612.testnet',
  KAAP_WORKER_CREDENTIALS_FILE: '/home/worker/.near-credentials/testnet/kaap-worker-1029053612.testnet.json',
  KAAP_GUARD: 'kaap-guard-1029061211.testnet',
  KAAP_REGISTRY: 'kaap-registry-1029061211.testnet',
  KAAP_OUTLAYER: 'outlayer.testnet',
  KAAP_SEALED_PROJECT: 'kaap-sealed-owner-1.testnet/kaap-sealed',
  KAAP_RPC_PRIMARY: 'https://rpc.testnet.fastnear.com',
  KAAP_RPC_SECONDARY: 'https://near-testnet.drpc.org/',
  KAAP_WORKER_DB: '/home/worker/kaap-worker/testnet.sqlite',
  KAAP_CAP_RUNS_PER_DAO_DAY: '60',
  KAAP_CAP_RECORDS_PER_DAO_DAY: '60',
  KAAP_CAP_NEAR_PER_DAY: '1',
  TELEGRAM_BOT_TOKEN: '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-Ms',
};

test('an expiry above 900,000 ms, the longest the sealed program signs, stops the worker at start and says so', () => {
  const problems = (env: Record<string, string>) => {
    try {
      loadConfig(env);
    } catch (e) {
      assert.ok(e instanceof ConfigError);
      return e.problems;
    }
    return [];
  };
  assert.equal(loadConfig(complete).KAAP_VERDICT_TTL_MS, 600_000);
  assert.equal(loadConfig({ ...complete, KAAP_VERDICT_TTL_MS: '900000' }).KAAP_VERDICT_TTL_MS, 900_000);
  for (const over of ['900001', '3600000']) {
    assert.deepEqual(problems({ ...complete, KAAP_VERDICT_TTL_MS: over }), ['KAAP_VERDICT_TTL_MS: at most 900000, the longest expiry the sealed program signs'], over);
  }
});

interface Options {
  /** The treasury's strict setting on each provider at start. */
  strict?: [boolean, boolean];
  open?: number[];
  counter?: number;
  /** What the guard answers a veto with; `null` is a veto that goes through. */
  refuseVeto?: string | null;
  /** A guard built before strict mode and the key delay: it has neither view. */
  olderGuard?: boolean;
  /** The providers, clock and store of a worker that ran before: this one is its restart. */
  after?: { a: ReturnType<typeof twoProviders>[0]; b: ReturnType<typeof twoProviders>[1]; c: ReturnType<typeof clock>; store: ReturnType<typeof memoryStore>; key: ReturnType<typeof testKey> };
}

/** A started worker watching the fake DAO, whose sealed job says of every proposal that it shows
 *  only a hash Kaap could not read. Proposal 2 is open unless `open` says otherwise. */
async function started(t: TestContext, o: Options = {}) {
  const [a, b] = o.after ? [o.after.a, o.after.b] : twoProviders();
  // The sealed program keeps its key across a restart of the worker.
  const key = o.after?.key ?? testKey();
  const counter = o.counter ?? 3;
  const open = new Set(o.open ?? [2]);
  if (!o.after) bothSet([a, b], (p) => {
    p.acceptedKey = key.getPublicKey().toString();
    p.enrolled = [DAO];
    p.policy = POLICY;
    p.optimistic = counter;
    p.final = counter;
    for (let id = 0; id < counter; id++) p.proposals.set(id, proposalText(id, { status: open.has(id) ? 'InProgress' : 'Approved' }));
  });
  if (!o.after) {
    a.strict.set(DAO, o.strict?.[0] ?? false);
    b.strict.set(DAO, o.strict?.[1] ?? false);
  }
  if (o.olderGuard) {
    for (const p of [a, b]) {
      const view = p.callFunction.bind(p);
      p.callFunction = async (account, method, args, at) => {
        if (method === 'veto_unreadable' || method === 'pending_key') throw new Error(`${p.name}: rpc: view failed: wasm execution failed with error: MethodResolveError(MethodNotFound)`);
        return view(account, method, args, at);
      };
    }
  }
  const c = o.after?.c ?? clock();
  const store = o.after?.store ?? memoryStore(c.now);
  const { log, lines } = memoryLog();
  const health = new Health(log, c.now);
  const telegram = new FakeTelegram();
  const alerts = new Alerts({ store, telegram, log, now: c.now, sleep: noSleep }, { network: NETWORK, siteUrl: null, batchMs: 60_000, capPerHour: 30 });
  health.on((e) => alerts.health(e));
  const subs = new Subscriptions(store, NETWORK, log);
  if (!o.after) subs.redeem(subs.issue(DAO).token, CHAT);
  const chain = new FakeChain();
  chain.respond = (call) => {
    if (call.method === 'request_execution') {
      const id = (JSON.parse(String(call.args.input_data)) as { proposal_id: number }).proposal_id;
      return runOutcome(sealedOutput(verdictFields(id, { ...UNREADABLE, expires_at_ms: c.now() + 600_000 }), key));
    }
    if (call.method === 'veto') {
      if (o.refuseVeto) return failedOutcome(o.refuseVeto);
      bothSet([a, b], (p) => p.vetoResults.set(bridge.decodeVerdict(Buffer.from(String(call.args.verdict), 'base64')).verdict_hash, 'Ok'));
    }
    return okOutcome();
  };
  const caps = new CapGuard(store, { runsPerDaoDay: 50, textRunsPerDaoDay: 5, recordsPerDaoDay: 50, nearPerDay: 10n ** 25n }, NETWORK);
  const submitter = new Submitter(store, chain, NETWORK, log, { pollMs: 1, sendTries: 2, sleep: noSleep, explorer: (h) => h });
  const reads = new Reads(a, b, bridge, 0, noSleep);
  const accepted = { value: null as string | null };
  const judge = new Judge({ store, submitter, caps, bridge, health, log, acceptedKey: () => accepted.value, now: c.now }, { network: NETWORK, guard: GUARD, outlayer: 'outlayer.testnet', project: 'o.testnet/p', verdictTtlMs: 600_000, windowBlocks: 220 });
  const actor = new Actor({ store, submitter, caps, reads, health, log, now: c.now, sleep: noSleep }, { network: NETWORK, guard: GUARD, registry: REGISTRY, gateTries: 1, gateRetryMs: 0 });
  const enqueue = { to: (_dao: string, _id: number) => {} };
  const rejudge = new RejudgeWatch({ reads, store, bridge, health, log, enqueue: (dao, id) => enqueue.to(dao, id) }, NETWORK);
  const worker = new Worker(
    { store, reads, judge, actor, rejudge, health, log, now: c.now, acceptedKey: accepted, bridge, alerts },
    { network: NETWORK, guard: GUARD, pollMs: 60_000, watchMs: 60_000, enrolledMs: 60_000, holdAlertMs: 30_000, backfillWindow: 50, maxConcurrentRuns: 2, sweepMs: 60_000 },
  );
  enqueue.to = (dao, id) => worker.enqueue(dao, id);
  t.after(() => worker.stop());
  await worker.start();
  await worker.idle();
  const vetoes = () => chain.calls('veto');
  const row = (id: number) => store.judged(NETWORK, DAO, id)!;
  const raised = (signal: string) => health.current().filter((r) => r.signal === signal);
  /** One watch tick and everything it started, then every alert that is due. */
  const tick = async () => {
    await worker.watchTick();
    await worker.idle();
    await alerts.flush();
  };
  /** Files one more open proposal and lets the worker see and judge it. */
  const file = async (id: number) => {
    bothSet([a, b], (p) => {
      p.proposals.set(id, proposalText(id));
      p.optimistic = id + 1;
      p.final = id + 1;
    });
    await worker.pollTick();
    await worker.idle();
    await alerts.flush();
  };
  return { a, b, c, store, key, health, alerts, telegram, chain, worker, vetoes, row, raised, tick, file, lines };
}

test('a treasury in the default mode gets no veto on a request Kaap cannot read', async (t) => {
  const s = await started(t);
  await s.tick();
  assert.equal(s.vetoes().length, 0);
  assert.deepEqual([s.row(2).veto_state, s.row(2).vetoable], ['not_needed', 0]);
});

test('a treasury that chose strict mode gets the veto, with all the gas, and its members are told why in fixed words', async (t) => {
  const s = await started(t, { strict: [true, true], open: [] });
  await s.file(3);
  assert.equal(s.vetoes().length, 1);
  assert.equal(s.vetoes()[0]!.gas, 1_000n * TGAS);
  assert.deepEqual([s.row(3).veto_state, s.row(3).vetoable], ['cast', 1]);
  const told = s.telegram.to(CHAT).join('\n');
  assert.match(told, /asks the treasury to sign a hash, and Kaap could not read what it signs\./);
  assert.match(told, /This treasury chose to have such requests rejected, so Kaap is sending its veto now\./);
});

test('a treasury that turns strict mode on is owed a veto on what was already judged unreadable and is still open', async (t) => {
  const s = await started(t);
  await s.tick();
  assert.equal(s.vetoes().length, 0);
  bothSet([s.a, s.b], (p) => p.strict.set(DAO, true));
  await s.worker.refreshEnrolled();
  assert.deepEqual([s.row(2).veto_state, s.row(2).vetoable], ['held', 1]);
  await s.tick();
  assert.equal(s.vetoes().length, 1);
  assert.equal(s.row(2).veto_state, 'cast');
  // Off again: nothing more is owed, and a new unreadable request is left alone.
  bothSet([s.a, s.b], (p) => p.strict.set(DAO, false));
  await s.worker.refreshEnrolled();
  await s.file(3);
  await s.tick();
  assert.equal(s.vetoes().length, 1);
  assert.equal(s.row(3).veto_state, 'not_needed');
});

test('one provider alone never turns strict mode on, and the worker says the setting is unread', async (t) => {
  const s = await started(t, { strict: [true, false] });
  await s.tick();
  assert.equal(s.vetoes().length, 0, 'a yes from one provider is no yes');
  assert.equal(s.raised('guard_mode_unread').length, 1);
  assert.equal(s.raised('guard_mode_unread')[0]!.dao, DAO);
  s.b.strict.set(DAO, true);
  await s.worker.refreshEnrolled();
  assert.equal(s.raised('guard_mode_unread').length, 0);
  await s.tick();
  assert.equal(s.vetoes().length, 1, 'both agree now');
});

test('a failed read keeps the last setting both providers agreed on', async (t) => {
  const s = await started(t, { strict: [true, true], open: [] });
  s.a.failing.add('veto_unreadable');
  await s.worker.refreshEnrolled();
  assert.equal(s.raised('guard_mode_unread').length, 1);
  await s.file(3);
  assert.equal(s.vetoes().length, 1, 'still strict: the guard reads its own copy when the veto arrives');
});

test('a guard built before strict mode has no such setting: nothing is strict and nothing is raised', async (t) => {
  const s = await started(t, { strict: [true, true], olderGuard: true });
  bothSet([s.a, s.b], (p) => (p.pendingKey = { key: NEW_KEY, effective_at_ms: T0 + 86_400_000 }));
  await s.worker.refreshEnrolled();
  await s.worker.refreshGuard();
  await s.file(3);
  await s.tick();
  assert.equal(s.row(3).veto_state, 'not_needed');
  assert.equal(s.raised('guard_mode_unread').length + s.raised('accepted_key_change_pending').length, 0);
});

test('a key change the guard has pending is told to members at once, once, and again only when it is announced again', async (t) => {
  const s = await started(t);
  const at = T0 + 86_400_000;
  bothSet([s.a, s.b], (p) => (p.pendingKey = { key: NEW_KEY, effective_at_ms: at }));
  await s.worker.refreshGuard();
  await s.alerts.flush();
  assert.equal(s.raised('accepted_key_change_pending').length, 1);
  assert.equal(s.raised('accepted_key_change_pending')[0]!.dao, ALL);
  const told = () => s.telegram.to(CHAT).filter((m) => m.includes(SAYS.accepted_key_change_pending)).length;
  assert.equal(told(), 1, 'sent at once, not held for the batch window');
  assert.ok(s.lines.some((l) => l.event === 'accepted_key_change_pending' && l.new_key === NEW_KEY && l.effective_at_ms === at));
  await s.worker.refreshGuard();
  await s.alerts.flush();
  assert.equal(told(), 1, 'the same announcement is one alert');
  // One provider alone showing none, or another key, changes nothing.
  s.a.pendingKey = null;
  await s.worker.refreshGuard();
  assert.equal(s.raised('accepted_key_change_pending').length, 1);
  // Announced again: the clock restarted, so it is news again.
  bothSet([s.a, s.b], (p) => (p.pendingKey = { key: NEW_KEY, effective_at_ms: at + 3_600_000 }));
  await s.worker.refreshGuard();
  await s.alerts.flush();
  assert.equal(told(), 2);
  // And never a recovery: once the batch window has passed, no message says the change is over.
  s.c.advance(60_001);
  await s.alerts.flush();
  assert.ok(!s.telegram.to(CHAT).some((m) => m.includes(`Recovered, no longer true: ${SAYS.accepted_key_change_pending}`)), s.telegram.to(CHAT).join('\n---\n'));
  // Cancelled or applied: the signal goes.
  bothSet([s.a, s.b], (p) => (p.pendingKey = null));
  await s.worker.refreshGuard();
  assert.equal(s.raised('accepted_key_change_pending').length, 0);
});

test('a pending key that is not a key and a time is not believed', async (t) => {
  const s = await started(t);
  for (const bad of [{ key: 'ed25519:short', effective_at_ms: T0 }, { key: NEW_KEY, effective_at_ms: '1' }, { key: NEW_KEY }, 'soon', 7]) {
    bothSet([s.a, s.b], (p) => (p.pendingKey = bad));
    await s.worker.refreshGuard();
    assert.equal(s.raised('accepted_key_change_pending').length, 0, JSON.stringify(bad));
  }
});

test('a proposal too large for one transaction is never sent a second veto, and its members are told to judge it themselves', async (t) => {
  const s = await started(t, { strict: [true, true], open: [], refuseVeto: 'ERR_KIND_TOO_LARGE' });
  await s.file(3);
  assert.equal(s.vetoes().length, 1);
  assert.equal(s.row(3).veto_state, 'refused');
  assert.equal(s.raised('veto_refused').length, 1);
  const told = s.telegram.to(CHAT).join('\n');
  assert.match(told, /could not veto proposal 3 of .*too large for one transaction to carry, so Kaap cannot veto it at all/);
  await s.tick();
  await s.tick();
  assert.equal(s.vetoes().length, 1, 'no later pass tries again');
});

test('a veto the guard refuses for too little gas is a refused veto, said on the status page, and is not sent again with the same gas', async (t) => {
  const s = await started(t, { strict: [true, true], open: [], refuseVeto: 'ERR_NOT_ENOUGH_GAS' });
  await s.file(3);
  assert.equal(s.row(3).veto_state, 'refused');
  assert.equal(s.raised('veto_refused').length, 1);
  await s.tick();
  assert.equal(s.vetoes().length, 1);
});

test('a restart during a bad read keeps the strict setting both providers had agreed on', async (t) => {
  const first = await started(t, { strict: [true, true], open: [] });
  await first.worker.stop();
  first.a.failing.add('veto_unreadable');
  const s = await started(t, { open: [], after: first });
  assert.equal(s.raised('guard_mode_unread').length, 1);
  await s.file(3);
  assert.equal(s.vetoes().length, 1, 'still strict after the restart');
  assert.equal(s.row(3).veto_state, 'cast');
});

test('a key change that cannot be read on both providers is said, and the accepted key failing to read does not hide a pending one', async (t) => {
  const s = await started(t);
  bothSet([s.a, s.b], (p) => (p.pendingKey = { key: NEW_KEY, effective_at_ms: T0 + 86_400_000 }));
  s.a.failing.add('pending_key');
  await s.worker.refreshGuard();
  assert.deepEqual([s.raised('pending_key_unread').length, s.raised('accepted_key_change_pending').length], [1, 0]);
  s.a.failing.delete('pending_key');
  s.a.failing.add('accepted_key');
  await s.worker.refreshGuard();
  assert.deepEqual([s.raised('pending_key_unread').length, s.raised('accepted_key_change_pending').length], [0, 1]);
});

test('a request that closed before the treasury chose strict mode is owed nothing, and is never reported as a lost veto', async (t) => {
  const s = await started(t);
  await s.tick();
  assert.equal(s.row(2).veto_state, 'not_needed');
  // Members approve it; the worker has not seen that yet when the treasury turns strict mode on.
  bothSet([s.a, s.b], (p) => {
    p.proposals.set(2, proposalText(2, { status: 'Approved' }));
    p.strict.set(DAO, true);
  });
  await s.worker.refreshEnrolled();
  assert.equal(s.row(2).veto_state, 'not_needed');
  await s.tick();
  await s.tick();
  assert.equal(s.vetoes().length, 0);
  assert.ok(!s.telegram.to(CHAT).some((m) => /lost|could not veto/i.test(m)), s.telegram.to(CHAT).join('\n---\n'));
});

test('an owed veto waits for a read of the open requests, and is marked once they can be read', async (t) => {
  const s = await started(t);
  await s.tick();
  bothSet([s.a, s.b], (p) => p.strict.set(DAO, true));
  s.b.failing.add('get_proposals');
  await s.worker.refreshEnrolled();
  assert.equal(s.row(2).veto_state, 'not_needed', 'nothing is marked on a read that failed');
  s.b.failing.delete('get_proposals');
  await s.worker.refreshEnrolled();
  assert.equal(s.row(2).veto_state, 'held');
  await s.tick();
  assert.equal(s.vetoes().length, 1);
});

test("a guard's list of enrolled accounts longer than the worker reads is a list not read", async () => {
  const [a, b] = twoProviders();
  for (const p of [a, b]) {
    const view = p.callFunction.bind(p);
    p.callFunction = async (account, method, args, at) => {
      if (method !== 'enrolled_daos') return view(account, method, args, at);
      const { from_index: from, limit } = args as { from_index: number; limit: number };
      p.enrolled = Array.from({ length: limit }, (_, i) => `dao-${from + i}.testnet`);
      const page = await view(account, method, { from_index: 0, limit }, at);
      return page;
    };
  }
  const reads = new Reads(a, b, bridge, 0, noSleep);
  const cut = await reads.enrolled(GUARD, 2, 2);
  assert.deepEqual([cut.both, cut.problems.length], [[], 2]);
  assert.match(cut.problems[0]!.kind === 'failed' ? cut.problems[0]!.detail : '', /more than 4 enrolled accounts/);
});
